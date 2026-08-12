import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  QuestionAnswer,
} from "@coord/agent-protocol";
import {
  CodeIntelligenceService,
  groundPlan,
  type RepositoryIndex,
} from "@coord/code-intelligence";
import { IntegrationService } from "@coord/integration-service";
import type { CoordinationStore } from "@coord/persistence";
import {
  agentCommitIdentity,
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  assertAgentPlan,
  createId,
  mergePlanScope,
  normalizeRepositoryPath,
  planGroundingConfidence,
  readsAsReportRequest,
  summariseChangedFiles,
  uniqueStrings,
  type AgentPlan,
  type ApprovalKind,
  type AuditEvent,
  type AuditEventType,
  type CanonicalVersion,
  type ChangeSet,
  type IntegrationResult,
  type ConflictAssessment,
  type CoordinationRunResult,
  type CoordinatorDecision,
  type FilePatchStatus,
  type ReplanRequest,
  type ScopeChangeDecision,
  type ScopeChangeRequest,
  type TaskDefinition,
  type TaskExecutionResult,
  planAdmissionApproved,
} from "@coord/shared-types";
import {
  GitWorktreeWorkspaceManager,
  type TaskWorkspace,
  type WorkspaceManager,
} from "@coord/workspace-manager";

import {
  ApprovalPolicy,
  StoreApprovalController,
  type ApprovalController,
} from "./approval-service.js";
import { InMemoryAuditLog } from "./audit-log.js";
import { ConflictDetector, relatedObjectives } from "./conflict-detector.js";
import { seedContextForTask } from "./handoff-store.js";
import { OwnershipService } from "./ownership-service.js";
import {
  approvedSchemaResources,
  structuralConflict,
} from "./plan-admission.js";
import { RunRecorder } from "./run-recorder.js";
import { assertChangeSetWithinPlan } from "./scope-validator.js";

export interface CoordinatedTask {
  task: TaskDefinition;
  adapter: AgentAdapter;
}

export interface CoordinatorRunInput {
  repository: CanonicalRepository;
  workspaceRoot: string;
  integrationRoot: string;
  tasks: CoordinatedTask[];
  scenario?: string;
  organizationId?: string;
  projectId?: string;
}

interface PlannedTask extends CoordinatedTask {
  session: AgentSession;
  plan: AgentPlan;
  planRevision: number;
  plannedVersion: CanonicalVersion;
  decision: CoordinatorDecision;
}

interface PreparedTask extends PlannedTask {
  workspace: TaskWorkspace;
  changeSet: ChangeSet;
}

function errorMessage(
  error: unknown,
  seen: Set<unknown> = new Set(),
): string {
  if (typeof error === "object" && error !== null) {
    if (seen.has(error)) {
      return "[circular error]";
    }
    seen.add(error);
  }

  const summary = error instanceof Error ? error.message : String(error);
  if (!(error instanceof AggregateError)) {
    return summary;
  }

  const messages = [
    summary,
    ...Array.from(error.errors, (nested) => errorMessage(nested, seen)),
  ].filter((message, index, all) => message.length > 0 && all.indexOf(message) === index);
  return messages.join("; ");
}

function pairKey(taskIds: readonly [string, string]): string {
  return [...taskIds].sort().join("\0");
}

function conflictFingerprint(assessment: ConflictAssessment): string {
  return JSON.stringify({
    taskIds: [...assessment.taskIds].sort(),
    score: assessment.score,
    disposition: assessment.disposition,
    evidence: assessment.evidence,
  });
}

export interface CoordinatorDependencies {
  repositories?: RepositoryService;
  workspaces?: WorkspaceManager;
  integrations?: IntegrationService;
  conflicts?: ConflictDetector;
  ownership?: OwnershipService;
  intelligence?: CodeIntelligenceService;
  approvalPolicy?: ApprovalPolicy;
  approvals?: ApprovalController;
  audit?: InMemoryAuditLog;
  store?: CoordinationStore;
  /**
   * Ask the agent that produced a result to redo the part that collided,
   * rather than ending its session and paying for a fresh one to rediscover
   * the whole task. On by default; set false to restore the previous
   * behaviour, in which any collision cost a full replan.
   */
  repairConflicts?: boolean;
  /**
   * How often the worktree is read while an agent edits, to report what it
   * has touched (see `watchWorkingChanges`).
   *
   * Each tick is two read-only git calls against one worktree. Ten seconds
   * is responsive enough that a thread looks alive without making the poll
   * itself a noticeable share of a run's work; a test that wants determinism
   * sets its own.
   */
  workingChangePollMs?: number;
  /**
   * Who puts an agent's question to a person, and brings back what they said.
   *
   * Absent on a deployment with nobody to ask — a CLI run, a benchmark — in
   * which case a question is cancelled immediately rather than waiting out a
   * deadline for an answer that was never going to come.
   */
  questions?: QuestionController;
  /** How long a person has, before the task is cancelled. See `answerAgentQuestion`. */
  questionDeadlineMs?: number;
}

/**
 * Somewhere to put a question, and somewhere for the answer to come back.
 *
 * An interface rather than a channel client, for the same reason the store
 * is: the coordinator knows a question needs answering and nothing about
 * where people are. Returning `undefined` — or resolving with no choice — is
 * how "nobody answered" is said.
 */
export interface QuestionController {
  awaitAnswer(input: {
    requestId: string;
    taskId: string;
    repositoryId: string;
    projectId?: string;
    question: string;
    options: string[];
    deadlineMs: number;
  }): Promise<{ chosen?: number } | undefined>;
}

/**
 * Fifteen minutes.
 *
 * Long enough that somebody at lunch can still answer, short enough that the
 * leases an unanswered question is holding are not held for the hour the
 * execution timeout would otherwise allow.
 */
const DEFAULT_QUESTION_DEADLINE_MS = 15 * 60 * 1000;

/** See {@link CoordinatorDependencies.workingChangePollMs}. */
const DEFAULT_WORKING_CHANGE_POLL_MS = 10_000;

export class Coordinator {
  private readonly repositories: RepositoryService;
  private readonly workspaces: WorkspaceManager;
  private readonly integrations: IntegrationService;
  private readonly conflicts: ConflictDetector;
  private readonly ownership: OwnershipService;
  private readonly intelligence: CodeIntelligenceService;
  private readonly approvalPolicy: ApprovalPolicy;
  private readonly approvals: ApprovalController | undefined;
  private readonly audit: InMemoryAuditLog;
  private readonly store: CoordinationStore | undefined;
  private readonly repairConflicts: boolean;
  private readonly workingChangePollMs: number;
  private readonly questions: QuestionController | undefined;
  private readonly questionDeadlineMs: number;

  public constructor(dependencies: CoordinatorDependencies = {}) {
    this.repositories = dependencies.repositories ?? new RepositoryService();
    this.workspaces =
      dependencies.workspaces ??
      new GitWorktreeWorkspaceManager(this.repositories.getGitClient());
    this.integrations =
      dependencies.integrations ??
      new IntegrationService(this.repositories, this.workspaces);
    this.conflicts = dependencies.conflicts ?? new ConflictDetector();
    this.ownership = dependencies.ownership ?? new OwnershipService();
    this.intelligence =
      dependencies.intelligence ??
      new CodeIntelligenceService(this.repositories);
    this.approvalPolicy = dependencies.approvalPolicy ?? new ApprovalPolicy();
    this.repairConflicts = dependencies.repairConflicts ?? true;
    this.workingChangePollMs =
      dependencies.workingChangePollMs ?? DEFAULT_WORKING_CHANGE_POLL_MS;
    this.questions = dependencies.questions;
    this.questionDeadlineMs =
      dependencies.questionDeadlineMs ?? DEFAULT_QUESTION_DEADLINE_MS;
    this.store = dependencies.store;
    this.approvals =
      dependencies.approvals ??
      (this.store === undefined
        ? undefined
        : new StoreApprovalController(
            this.store,
            this.approvalPolicy.timeoutMs,
          ));
    this.audit = dependencies.audit ?? new InMemoryAuditLog();
  }

  public async run(input: CoordinatorRunInput): Promise<CoordinationRunResult> {
    const runAudit: AuditEvent[] = [];
    const initialVersion = await this.repositories.getCanonicalVersion(
      input.repository,
    );
    const recorder =
      this.store === undefined
        ? undefined
        : await RunRecorder.begin(this.store, {
            repository: input.repository,
            ...(input.projectId === undefined
              ? {}
              : { projectId: input.projectId }),
            mode: "coordinated",
            baseVersion: initialVersion,
            ...(input.scenario === undefined ? {} : { scenario: input.scenario }),
          });
    const ownershipHeartbeat = setInterval(() => {
      this.ownership.renewActive();
    }, this.ownership.renewalIntervalMs);

    try {
      const result = await this.execute(
        input,
        initialVersion,
        recorder,
        runAudit,
      );
      const runStatus = result.tasks.every(
        (taskResult) => taskResult.status === "integrated",
      )
        ? "completed"
        : "failed";
      await recorder?.finish(runStatus, result.canonicalVersion);
      return result;
    } catch (error) {
      try {
        await recorder?.finish("failed");
      } catch (finishError) {
        throw new AggregateError(
          [error, finishError],
          "Coordination failed and the durable run could not be finalized",
        );
      }
      throw error;
    } finally {
      clearInterval(ownershipHeartbeat);
    }
  }

  private async execute(
    input: CoordinatorRunInput,
    initialVersion: CanonicalVersion,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<CoordinationRunResult> {
    for (const entry of input.tasks) {
      await recorder?.task(entry.task);
      await this.trace(recorder, runAudit, "task_submitted", entry.task.id, {
        objective: entry.task.objective,
        agentId: entry.task.agentId,
      });
    }

    // A run with one task has nothing to arbitrate: no pair to assess, no
    // wave to order. Enrichment and grounding exist to make plans comparable
    // with each other, so a solo run skips the repository index they need —
    // scope enforcement and exact-base integration hold the task to its
    // declarations and its base revision either way.
    const initialIndex =
      input.tasks.length === 1
        ? undefined
        : await this.intelligence.index(
            input.repository,
            initialVersion.revision,
          );
    const planned = await this.planTasks(
      input,
      initialVersion,
      initialIndex,
      recorder,
      runAudit,
    );
    const pending = [...planned];
    const taskResults: TaskExecutionResult[] = [];
    const latestAssessments = new Map<string, ConflictAssessment>();
    const recordedConflictFingerprints = new Set<string>();

    try {
      while (pending.length > 0) {
        const waveVersion = await this.repositories.getCanonicalVersion(
          input.repository,
        );
        const needsReplan = pending.filter(
          (entry) => entry.plannedVersion.revision !== waveVersion.revision,
        );
        // The index inside the wave loop exists for replanning, and a wave
        // with nothing to replan — always the first, and every wave of a
        // solo run — can skip building it: reading every source file out of
        // git is the single most expensive control-plane step, and a task
        // with nobody to be replanned against should not pay it.
        const index =
          needsReplan.length === 0
            ? undefined
            : await this.intelligence.index(
                input.repository,
                waveVersion.revision,
              );
        // Every task still queued has to see the canonical state the previous
        // wave produced, and each of those replans is a full round trip to an
        // agent. Issued one at a time they dominate a real run: a fully
        // sequenced set of n tasks performs n(n-1)/2 of them, so eight tasks
        // means twenty-eight agent calls back to back.
        //
        // They are independent. A replan reads canonical and the shared index,
        // both immutable at this point in the wave, and writes only to its own
        // entry and its own agent session. Audit appends are already made
        // concurrently by the parallel execution below and are serialised by
        // the store, so the chain stays intact; only the interleaving of events
        // between tasks changes. Initial planning is parallel for the same
        // reasons, and this makes replanning agree with it.
        await Promise.all(
          needsReplan.map(async (entry) => {
            if (index === undefined) {
              throw new Error("Coordinator lost the index it built to replan");
            }
            await this.replanTask(
              input,
              entry,
              waveVersion,
              index,
              recorder,
              runAudit,
            );
          }),
        );

        const assessments = this.conflicts.assessAll(
          pending.map((entry) => entry.plan),
        );
        const newlyRecorded = assessments.filter((assessment) => {
          latestAssessments.set(pairKey(assessment.taskIds), assessment);
          const fingerprint = conflictFingerprint(assessment);
          if (recordedConflictFingerprints.has(fingerprint)) {
            return false;
          }
          recordedConflictFingerprints.add(fingerprint);
          return true;
        });
        if (newlyRecorded.length > 0) {
          await recorder?.conflicts(newlyRecorded);
          for (const assessment of newlyRecorded) {
            await this.trace(
              recorder,
              runAudit,
              "conflict_detected",
              undefined,
              {
                taskIds: assessment.taskIds,
                score: assessment.score,
                disposition: assessment.disposition,
                evidence: assessment.evidence,
                // For whoever narrates this to a room. The channel watcher can
                // reach a repository's channel only if the event says which
                // repository — the same stamp `canonical_promoted` carries for
                // the same reason — and the explanation is the sentence the
                // detector already wrote about *why* these two collide.
                repositoryId: input.repository.id,
                ...(input.projectId === undefined
                  ? {}
                  : { projectId: input.projectId }),
                explanation: assessment.explanation,
              },
            );
          }
        }

        const blockers = this.buildBlockers(pending, assessments);
        let wave = pending.filter(
          (entry) => (blockers.get(entry.task.id)?.size ?? 0) === 0,
        );
        let cycleOverride = false;
        if (wave.length === 0) {
          const first = pending[0];
          if (first === undefined) {
            throw new Error("Coordinator lost its pending task state");
          }
          wave = [first];
          cycleOverride = true;
        }

        for (const entry of pending) {
          const blockedBy = [...(blockers.get(entry.task.id) ?? [])];
          const isReady = wave.includes(entry);
          const blockingConflicts = assessments.filter(
            (assessment) =>
              assessment.disposition === "block" &&
              assessment.taskIds.includes(entry.task.id),
          );
          const constraints = [
            ...(blockedBy.length > 0
              ? ["Start from canonical state after blocking tasks integrate"]
              : []),
            ...blockingConflicts.map(
              (assessment) =>
                `Human approval required for conflict score ${assessment.score} with ` +
                assessment.taskIds.find((id) => id !== entry.task.id),
            ),
            ...(cycleOverride && isReady
              ? [
                  "Human approval required to break a cyclic dependency; validation must prove compatibility",
                ]
              : []),
          ];
          entry.decision = {
            decision: isReady ? "approved" : "queued",
            taskId: entry.task.id,
            planRevision: entry.planRevision,
            ownershipGrants: entry.decision.ownershipGrants,
            constraints,
            blockedBy,
            explanation: isReady
              ? "Approved for the next non-conflicting execution wave"
              : `Queued behind ${blockedBy.join(", ")} due to structural ownership or dependency evidence`,
          };
          await recorder?.decision(entry.decision);
          await recorder?.status(
            entry.task.id,
            isReady ? "approved" : "queued",
            entry.decision.explanation,
          );
        }

        for (const selected of wave) {
          pending.splice(pending.indexOf(selected), 1);
        }

        const prepared = await Promise.all(
          wave.map(async (entry) =>
            await this.prepareTask(
              input,
              entry,
              wave,
              waveVersion,
              recorder,
              runAudit,
            ),
          ),
        );

        const failedProducers: PlannedTask[] = [];
        for (const result of prepared) {
          if (!("changeSet" in result)) {
            taskResults.push(result);
            if (result.status !== "integrated") {
              const plannedTask = wave.find(
                (entry) => entry.task.id === result.task.id,
              );
              if (plannedTask !== undefined) {
                failedProducers.push(plannedTask);
              }
            }
            continue;
          }
          const taskResult = await this.integrateTask(
            input,
            result,
            recorder,
            runAudit,
          );
          taskResults.push(taskResult);
          if (taskResult.status !== "integrated") {
            failedProducers.push(result);
          }
        }
        if (failedProducers.length > 0) {
          await this.cancelFailedDependents(
            pending,
            failedProducers,
            taskResults,
            recorder,
            runAudit,
          );
        }
      }
    } catch (error) {
      const cleanup = await Promise.allSettled(
        pending.map((entry) => entry.adapter.cancel(entry.session.id)),
      );
      const failures = cleanup
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(
          [error, ...failures],
          "Coordination and pending-session cleanup both failed",
        );
      }
      throw error;
    }

    const canonicalVersion = await this.repositories.getCanonicalVersion(
      input.repository,
    );
    return {
      canonicalVersion,
      conflicts: [...latestAssessments.values()],
      tasks: input.tasks.map((entry) => {
        const result = taskResults.find(
          (candidate) => candidate.task.id === entry.task.id,
        );
        if (result === undefined) {
          throw new Error(`Missing result for task ${entry.task.id}`);
        }
        return result;
      }),
      audit: runAudit,
      ...(recorder === undefined ? {} : { runId: recorder.runId }),
    };
  }

  private async planTasks(
    input: CoordinatorRunInput,
    version: CanonicalVersion,
    /** Absent on a solo run, where plans are never compared with anything. */
    index: RepositoryIndex | undefined,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<PlannedTask[]> {
    const results = await Promise.allSettled(
      input.tasks.map(async (entry): Promise<PlannedTask> => {
        let session: AgentSession | undefined;
        try {
          const capabilities = await entry.adapter.getCapabilities();
          if (!capabilities.canPlan || !capabilities.canEditFiles) {
            throw new Error(
              `Agent ${entry.task.agentId} cannot satisfy the coordination protocol`,
            );
          }
          // What earlier tasks in this repository worked out, from the
          // handoffs they left. Every run starts with an empty context
          // window, so without this each one rediscovers the repository from
          // nothing — including whatever the last agent learned the hard way
          // and wrote down. The handoffs have been recorded at every task
          // boundary all along; this is the first thing to read them back.
          //
          // Never allowed to stop a run: seeding is an advantage, and a task
          // that cannot read old notes should still do the work.
          const seeded =
            this.store === undefined
              ? ""
              : await seedContextForTask(this.store, {
                  repositoryId: input.repository.id,
                  ...(input.projectId === undefined
                    ? {}
                    : { projectId: input.projectId }),
                }).catch(() => "");
          // The conversation this request was asked inside, ahead of what
          // earlier tasks left behind. Both are background rather than fact,
          // but they are not equally close to the work: the thread is about
          // *this* request — it is where "now do the same for the other file"
          // gets its meaning — while a handoff is about the repository in
          // general. Nearest first, so the thing being asked for survives any
          // truncation the model does at the far end.
          // What other in-flight tasks already hold, told to the agent
          // *before* it plans. Admission would trim or defer a plan that
          // reaches into leased files anyway — this makes the agent route
          // around them from the start, so the common outcome is a plan that
          // admits cleanly rather than one that gets cut down after the fact.
          // Advisory wording on purpose: the lease may clear before this plan
          // arrives, and admission stays the authority either way.
          const leased =
            this.store === undefined
              ? []
              : await this.store
                  .listWorkLeases({
                    status: "active",
                    repositoryId: input.repository.id,
                  })
                  .then((leases) => [
                    ...new Set(
                      leases
                        .filter(
                          (lease) =>
                            lease.taskId !== entry.task.id &&
                            lease.plan !== undefined &&
                            planAdmissionApproved(lease.plan.admission),
                        )
                        .flatMap((lease) => lease.plan?.plan.expectedFiles ?? []),
                    ),
                  ])
                  .catch(() => []);
          const leaseNote =
            leased.length === 0
              ? ""
              : "Files other tasks in this repository are editing right now — " +
                "plan around them where the objective allows; work that " +
                "touches them will be deferred until those tasks land:\n" +
                leased
                  .slice(0, 20)
                  .map((file) => `- ${file}`)
                  .join("\n");
          const priorContext = [
            entry.task.context?.trim() ?? "",
            leaseNote,
            seeded,
          ]
            .filter((part) => part !== "")
            .join("\n\n");
          session = await entry.adapter.startTask({
            task: entry.task,
            canonicalVersion: version,
            repositoryId: input.repository.id,
            ...(priorContext === "" ? {} : { priorContext }),
          });
          await recorder?.session(session);
          const submitted = await entry.adapter.requestPlan(session.id);
          assertAgentPlan(submitted);
          if (submitted.taskId !== entry.task.id) {
            throw new Error(
              `Agent plan task ${submitted.taskId} does not match ${entry.task.id}`,
            );
          }
          // Grounded before it is enriched: verification judges what the
          // agent declared, not what the index projected onto it.
          const plan =
            index === undefined
              ? submitted
              : this.intelligence.enrichPlan(
                  groundPlan(submitted, index),
                  index,
                );
          assertAgentPlan(plan);
          await recorder?.plan(entry.task.id, plan);
          await recorder?.planRevision(entry.task.id, {
            revision: 1,
            reason: "initial",
            canonicalRevision: version.revision,
            plan,
          });
          await this.trace(
            recorder,
            runAudit,
            "plan_received",
            entry.task.id,
            {
              revision: 1,
              expectedFiles: plan.expectedFiles,
              expectedSymbols: plan.expectedSymbols,
              riskLevel: plan.riskLevel,
              grounding: plan.grounding,
            },
          );
          return {
            ...entry,
            session,
            plan,
            planRevision: 1,
            plannedVersion: version,
            decision: {
              decision: "approved",
              taskId: entry.task.id,
              planRevision: 1,
              ownershipGrants: [],
              constraints: [],
              blockedBy: [],
              explanation: "Awaiting conflict analysis",
            },
          };
        } catch (error) {
          const errors = [error];
          if (session !== undefined) {
            try {
              await entry.adapter.cancel(session.id);
            } catch (cancelError) {
              errors.push(cancelError);
            }
          }
          const failure =
            errors.length === 1
              ? error
              : new AggregateError(
                  errors,
                  `Planning and cleanup failed for task ${entry.task.id}`,
                );
          await recorder?.status(
            entry.task.id,
            "failed",
            errorMessage(failure),
          );
          await this.trace(
            recorder,
            runAudit,
            "task_failed",
            entry.task.id,
            { stage: "planning", error: errorMessage(failure) },
          );
          throw failure;
        }
      }),
    );

    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      const cleanupFailures: unknown[] = [];
      for (const result of results) {
        if (result.status !== "fulfilled") {
          continue;
        }
        try {
          await result.value.adapter.cancel(result.value.session.id);
          await recorder?.status(
            result.value.task.id,
            "cancelled",
            "Cancelled because another task failed during planning",
          );
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      throw new AggregateError(
        [...failures.map((result) => result.reason), ...cleanupFailures],
        "One or more tasks failed during planning",
      );
    }
    return results.map((result) => {
      if (result.status !== "fulfilled") {
        throw new Error("Unreachable rejected planning result");
      }
      return result.value;
    });
  }

  private async replanTask(
    input: CoordinatorRunInput,
    entry: PlannedTask,
    version: CanonicalVersion,
    index: RepositoryIndex,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<void> {
    const changedFiles = await this.repositories.listChangedFiles(
      input.repository,
      entry.plannedVersion.revision,
      version.revision,
    );
    const previousIndex = await this.intelligence.index(
      input.repository,
      entry.plannedVersion.revision,
    );
    const previousResources = this.intelligence.changedResources(
      changedFiles,
      previousIndex,
    );
    const currentResources = this.intelligence.changedResources(
      changedFiles,
      index,
    );
    const notice = {
      previousVersion: entry.plannedVersion,
      canonicalVersion: version,
      changedFiles,
      changedSymbols: uniqueStrings([
        ...previousResources.symbols,
        ...currentResources.symbols,
      ]),
      changedApis: uniqueStrings([
        ...previousResources.apis,
        ...currentResources.apis,
      ]),
      changedSchemas: uniqueStrings([
        ...previousResources.schemas,
        ...currentResources.schemas,
      ]),
      changedConfigKeys: uniqueStrings([
        ...previousResources.configKeys,
        ...currentResources.configKeys,
      ]),
      changedTests: uniqueStrings([
        ...previousResources.tests,
        ...currentResources.tests,
      ]),
      changedServices: uniqueStrings([
        ...previousResources.services,
        ...currentResources.services,
      ]),
      reason: "Blocking work changed canonical state before this task started",
    };
    const request: ReplanRequest = {
      taskId: entry.task.id,
      previousPlan: entry.plan,
      canonicalChange: notice,
      constraints: [...entry.decision.constraints],
    };
    await recorder?.status(entry.task.id, "replanning", notice.reason);
    await this.trace(recorder, runAudit, "canonical_changed", entry.task.id, {
      previousRevision: entry.plannedVersion.revision,
      revision: version.revision,
      changedFiles,
      changedSymbols: notice.changedSymbols,
      changedApis: notice.changedApis,
      changedSchemas: notice.changedSchemas,
      changedConfigKeys: notice.changedConfigKeys,
      changedTests: notice.changedTests,
      changedServices: notice.changedServices,
    });
    await this.trace(recorder, runAudit, "replan_requested", entry.task.id, {
      previousPlanRevision: entry.planRevision,
      canonicalRevision: version.revision,
      changedFiles,
    });

    const submitted = await entry.adapter.requestReplan(entry.session.id, request);
    assertAgentPlan(submitted);
    if (submitted.taskId !== entry.task.id) {
      throw new Error(
        `Agent replan task ${submitted.taskId} does not match ${entry.task.id}`,
      );
    }
    entry.plan = this.intelligence.enrichPlan(
      groundPlan(submitted, index),
      index,
    );
    entry.planRevision += 1;
    entry.plannedVersion = version;
    entry.decision.planRevision = entry.planRevision;
    await recorder?.planRevision(entry.task.id, {
      revision: entry.planRevision,
      reason: "canonical_change",
      canonicalRevision: version.revision,
      plan: entry.plan,
    });
    await this.trace(recorder, runAudit, "plan_revised", entry.task.id, {
      revision: entry.planRevision,
      reason: "canonical_change",
      expectedFiles: entry.plan.expectedFiles,
      // The symbols matter as much as the files for reading a replan back:
      // most of what an agent invents about this repository is a function
      // name, and without them the record only shows half the declaration.
      expectedSymbols: entry.plan.expectedSymbols,
      grounding: entry.plan.grounding,
    });
  }

  private buildBlockers(
    pending: readonly PlannedTask[],
    assessments: readonly ConflictAssessment[],
  ): Map<string, Set<string>> {
    const blockers = new Map(
      pending.map((entry) => [entry.task.id, new Set<string>()]),
    );
    const byId = new Map(pending.map((entry) => [entry.task.id, entry]));
    // An unverifiable plan is never proven disjoint from *related* work: its
    // declarations connect to nothing that exists, so overlap scoring against
    // it is comparing fiction with fact. When another pending task talks
    // about the same objective, the unverifiable plan waits — behind the
    // verifiable one, or behind the earlier-submitted one when both are
    // unverifiable. Work about something else entirely keeps its concurrency:
    // a plan that only creates new files is held to those declarations by
    // scope enforcement either way. Edges all point one way, so no cycle is
    // possible.
    for (const entry of pending) {
      if (planGroundingConfidence(entry.plan) !== "ungrounded") {
        continue;
      }
      for (const other of pending) {
        if (other === entry || !relatedObjectives(entry.plan, other.plan)) {
          continue;
        }
        const otherUngrounded =
          planGroundingConfidence(other.plan) === "ungrounded";
        if (
          !otherUngrounded ||
          pending.indexOf(other) < pending.indexOf(entry)
        ) {
          blockers.get(entry.task.id)?.add(other.task.id);
        }
      }
    }
    for (const assessment of assessments) {
      if (!structuralConflict(assessment)) {
        continue;
      }
      const first = byId.get(assessment.taskIds[0]);
      const second = byId.get(assessment.taskIds[1]);
      if (first === undefined || second === undefined) {
        continue;
      }
      const preferred = this.conflicts.preferredOrder(first.plan, second.plan);
      let blocker: PlannedTask;
      let blocked: PlannedTask;
      if (preferred !== undefined) {
        blocker = byId.get(preferred[0]) ?? first;
        blocked = byId.get(preferred[1]) ?? second;
      } else if (pending.indexOf(first) < pending.indexOf(second)) {
        blocker = first;
        blocked = second;
      } else {
        blocker = second;
        blocked = first;
      }
      blockers.get(blocked.task.id)?.add(blocker.task.id);
    }
    return blockers;
  }

  private async cancelFailedDependents(
    pending: PlannedTask[],
    failed: readonly PlannedTask[],
    taskResults: TaskExecutionResult[],
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<void> {
    const unavailable = [...failed];
    while (true) {
      const dependent = pending.find((candidate) =>
        unavailable.some((producer) => {
          const order = this.conflicts.preferredOrder(
            producer.plan,
            candidate.plan,
          );
          return (
            order?.[0] === producer.task.id &&
            order[1] === candidate.task.id
          );
        }),
      );
      if (dependent === undefined) {
        return;
      }
      const producer = unavailable.find((candidate) => {
        const order = this.conflicts.preferredOrder(
          candidate.plan,
          dependent.plan,
        );
        return (
          order?.[0] === candidate.task.id &&
          order[1] === dependent.task.id
        );
      });
      if (producer === undefined) {
        throw new Error("Coordinator lost a failed dependency relationship");
      }
      pending.splice(pending.indexOf(dependent), 1);
      let explanation =
        `Cancelled because required producer ${producer.task.id} did not integrate`;
      try {
        await dependent.adapter.cancel(dependent.session.id);
      } catch (error) {
        explanation += `; agent cancellation also failed: ${errorMessage(error)}`;
      }
      await recorder?.status(dependent.task.id, "cancelled", explanation);
      await this.trace(
        recorder,
        runAudit,
        "task_cancelled",
        dependent.task.id,
        {
          stage: "dependency_propagation",
          blockedBy: producer.task.id,
          explanation,
        },
      );
      taskResults.push({
        task: dependent.task,
        plan: dependent.plan,
        decision: {
          ...dependent.decision,
          decision: "queued",
          blockedBy: uniqueStrings([
            ...dependent.decision.blockedBy,
            producer.task.id,
          ]),
          explanation,
        },
        status: "cancelled",
        explanation,
      });
      unavailable.push(dependent);
    }
  }

  private async prepareTask(
    input: CoordinatorRunInput,
    entry: PlannedTask,
    wave: readonly PlannedTask[],
    waveVersion: CanonicalVersion,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<PreparedTask | TaskExecutionResult> {
    let workspace: TaskWorkspace | undefined;
    try {
      const planReasons = [
        ...this.approvalPolicy.planReasons(entry.plan),
        ...entry.decision.constraints.filter((constraint) =>
          constraint.startsWith("Human approval required"),
        ),
      ];
      if (planReasons.length > 0) {
        await recorder?.status(
          entry.task.id,
          "awaiting_approval",
          planReasons.join("; "),
        );
        await this.requireApproval(
          input,
          entry,
          "policy_override",
          planReasons,
          recorder,
          runAudit,
        );
      }

      const leases = this.ownership.acquire(
        entry.plan,
        entry.task.agentId,
        waveVersion.sequence,
        {
          approvedResources: approvedSchemaResources(entry.plan),
        },
      );
      entry.decision.ownershipGrants.push(...leases);
      await recorder?.leases(leases);
      await this.trace(
        recorder,
        runAudit,
        "ownership_granted",
        entry.task.id,
        { leases },
      );

      workspace = await this.workspaces.create({
        taskId: entry.task.id,
        rootPath: input.workspaceRoot,
        repository: input.repository,
        baseVersion: waveVersion,
      });
      entry.decision.workspaceId = workspace.id;
      await recorder?.decision(entry.decision);
      await recorder?.workspace({
        id: workspace.id,
        taskId: entry.task.id,
        path: workspace.path,
        isolation: workspace.isolation,
        baseRevision: workspace.baseVersion.revision,
        createdAt: workspace.createdAt,
      });
      await recorder?.status(entry.task.id, "running");
      await this.trace(recorder, runAudit, "task_started", entry.task.id, {
        workspaceId: workspace.id,
        baseRevision: waveVersion.revision,
        planRevision: entry.planRevision,
      });

      const eventErrors: unknown[] = [];
      let eventChain = Promise.resolve();
      await entry.adapter.streamEvents(entry.session.id, (event) => {
        eventChain = eventChain
          .then(
            async () =>
              await this.handleAgentEvent(
                input,
                entry,
                wave,
                waveVersion,
                event,
                recorder,
                runAudit,
              ),
          )
          .catch(async (error: unknown) => {
            eventErrors.push(error);
            try {
              await entry.adapter.cancel(entry.session.id);
            } catch (cancelError) {
              eventErrors.push(cancelError);
            }
          });
      });
      // The one stretch of a run that says nothing.
      //
      // Everything either side of this reports: planning, admission,
      // collection, validation. `sendContext` is a single await around the
      // agent's whole edit phase — up to an hour — and the adapters emit
      // nothing inside it, so a thread went quiet after "execution started"
      // and stayed quiet until the run ended. There was no way to tell work
      // from a hang.
      //
      // Read from the worktree rather than from the agent: it is what is
      // actually true on disk, it needs no cooperation from any vendor CLI,
      // and it works the same for every adapter.
      const watching = this.watchWorkingChanges(
        workspace,
        entry.task.id,
        recorder,
        runAudit,
      );
      try {
        await entry.adapter.sendContext(entry.session.id, {
          decision: entry.decision,
          canonicalVersion: waveVersion,
          workspacePath: workspace.path,
          planRevision: entry.planRevision,
        });
      } finally {
        await watching.stop();
      }
      await eventChain;
      if (eventErrors.length > 0) {
        throw new AggregateError(
          eventErrors,
          `Agent events failed for task ${entry.task.id}`,
        );
      }

      const changeSet = await entry.adapter.collectChanges(entry.session.id);
      if (
        changeSet.taskId !== entry.task.id ||
        changeSet.baseRevision !== waveVersion.revision ||
        changeSet.baseVersion !== waveVersion.sequence
      ) {
        throw new Error(
          `Agent ${entry.task.agentId} returned a changeset for an unexpected task or base`,
        );
      }
      assertChangeSetWithinPlan(entry.plan, changeSet);
      await recorder?.changeSet(changeSet);
      await this.trace(
        recorder,
        runAudit,
        "changeset_collected",
        entry.task.id,
        {
          changeSetId: changeSet.id,
          files: changeSet.patches.map((patch) => patch.path),
          // The same list with what happened to each file, and how much of it.
          // `files` stays as it is because the narration reads it; this is the
          // authoritative final set for the summary that hangs off the thread,
          // which the live poll can only approximate — it stops when the agent
          // does, and the last edits land between its final tick and this.
          //
          // The counts were missing here while the worker path counted the
          // same patches inline, so whether a thread showed "+12 −3" or bare
          // paths came down to which executor had run the task. Shared now, so
          // the four emitters of this event cannot disagree again.
          changedFiles: summariseChangedFiles(changeSet.patches),
        },
      );

      const reviewReasons = this.approvalPolicy.changesetReasons(
        entry.plan,
        changeSet,
        { planWasReviewed: true },
      );
      if (reviewReasons.length > 0) {
        await recorder?.status(
          entry.task.id,
          "awaiting_approval",
          reviewReasons.join("; "),
        );
        await this.requireApproval(
          input,
          entry,
          "changeset",
          reviewReasons,
          recorder,
          runAudit,
          { changeSetId: changeSet.id },
        );
      }
      return { ...entry, workspace, changeSet };
    } catch (error) {
      const failures = [errorMessage(error)];
      try {
        await entry.adapter.cancel(entry.session.id);
      } catch (cancelError) {
        failures.push(`Agent cleanup failed: ${errorMessage(cancelError)}`);
      }
      const cleanupFailure = await this.cleanupTask(
        workspace,
        entry.task.id,
        recorder,
        runAudit,
      );
      if (cleanupFailure !== undefined) {
        failures.push(cleanupFailure);
      }
      const explanation = failures.join("; ");
      await recorder?.status(entry.task.id, "failed", explanation);
      await this.trace(recorder, runAudit, "task_failed", entry.task.id, {
        stage: "execution",
        error: explanation,
      });
      return {
        task: entry.task,
        plan: entry.plan,
        decision: entry.decision,
        status: "failed",
        explanation,
      };
    }
  }

  /**
   * Puts an agent's question to whoever is watching, and bounds the wait.
   *
   * The deadline is the whole design. A question costs more than a message:
   * the agent holds its workspace and its ownership leases while it waits, so
   * every task that needs one of those files queues behind an unanswered
   * question. Waiting as long as the run is allowed to live would turn a
   * question nobody saw into an hour of nothing, ending in a timeout that
   * says nothing about why.
   *
   * Silence cancels rather than defaults. The agent asked because the choice
   * was not its to make, and nobody answering does not hand it back — a
   * default would be the platform deciding on the operator's behalf and
   * calling it consent. Cancelling is recoverable: the question is on the
   * record, and asking again costs one run.
   */
  private async answerAgentQuestion(
    input: CoordinatorRunInput,
    entry: PlannedTask,
    event: Extract<AgentEvent, { event: "question_asked" }>,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<void> {
    const requestId = event.requestId ?? createId("question");
    await this.trace(recorder, runAudit, "question_asked", entry.task.id, {
      requestId,
      question: event.question,
      options: event.options,
      // So a reader knows how long they have, rather than discovering the
      // deadline by missing it.
      deadlineMs: this.questionDeadlineMs,
    });
    const answered = await this.questions
      ?.awaitAnswer({
        requestId,
        taskId: entry.task.id,
        repositoryId: input.repository.id,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        question: event.question,
        options: [...event.options],
        deadlineMs: this.questionDeadlineMs,
      })
      .catch(() => undefined);
    const answer: QuestionAnswer =
      answered === undefined || answered.chosen === undefined
        ? { requestId, status: "cancelled" }
        : { requestId, status: "answered", chosen: answered.chosen };
    await this.trace(
      recorder,
      runAudit,
      answer.status === "answered" ? "question_answered" : "question_cancelled",
      entry.task.id,
      {
        requestId,
        ...(answer.chosen === undefined
          ? {}
          : { chose: event.options[answer.chosen] ?? "" }),
      },
    );
    // Handed back either way. The adapter is blocked on this call, and a
    // resolver that threw would leave it waiting on a promise nothing will
    // ever settle — the run would then die on the execution timeout instead
    // of the deadline that was actually missed.
    await entry.adapter.resolveQuestion?.(entry.session.id, answer);
  }

  private async handleAgentEvent(
    input: CoordinatorRunInput,
    entry: PlannedTask,
    wave: readonly PlannedTask[],
    waveVersion: CanonicalVersion,
    event: AgentEvent,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<void> {
    if (event.event === "progress") {
      await this.trace(recorder, runAudit, "agent_progress", entry.task.id, {
        message: event.message,
        occurredAt: event.occurredAt,
      });
      return;
    }
    if (event.event === "question_asked") {
      await this.answerAgentQuestion(input, entry, event, recorder, runAudit);
      return;
    }
    if (event.event === "completed") {
      return;
    }

    const request: ScopeChangeRequest = {
      id: event.requestId?.trim() || createId("scope"),
      taskId: entry.task.id,
      additionalFiles: event.additionalFiles.map(normalizeRepositoryPath),
      additionalSymbols: uniqueStrings(event.additionalSymbols ?? []),
      additionalApis: uniqueStrings(event.additionalApis ?? []),
      additionalSchemas: uniqueStrings(event.additionalSchemas ?? []),
      additionalConfigKeys: uniqueStrings(event.additionalConfigKeys ?? []),
      additionalTests: uniqueStrings(event.additionalTests ?? []),
      additionalServices: uniqueStrings(event.additionalServices ?? []),
      reason: event.reason.trim(),
      occurredAt: event.occurredAt,
    };
    await recorder?.scopeChange(request);
    await this.trace(
      recorder,
      runAudit,
      "scope_change_requested",
      entry.task.id,
      { request },
    );

    let decision: ScopeChangeDecision;
    try {
      const resourceCount =
        request.additionalFiles.length +
        request.additionalSymbols.length +
        request.additionalApis.length +
        request.additionalSchemas.length +
        request.additionalConfigKeys.length +
        request.additionalTests.length +
        request.additionalServices.length;
      if (resourceCount === 0 || request.reason.length === 0) {
        throw new Error(
          "Scope expansion must name at least one resource and explain why",
        );
      }
      // A scope expansion is a new set of declarations, and mid-run is when
      // an agent is most likely to name what it merely believes exists — so
      // the revised plan is verified the same way the original was.
      const revisedPlan = groundPlan(
        mergePlanScope(entry.plan, request),
        await this.intelligence.index(input.repository, waveVersion.revision),
      );
      const activeConflict = wave
        .filter((candidate) => candidate.task.id !== entry.task.id)
        .map((candidate) => this.conflicts.assess(revisedPlan, candidate.plan))
        .find(
          (assessment) =>
            assessment !== undefined && structuralConflict(assessment),
        );
      if (activeConflict !== undefined) {
        throw new Error(
          `Scope expansion conflicts with active task ` +
            activeConflict.taskIds.find((id) => id !== entry.task.id) +
            `: ${activeConflict.explanation}`,
        );
      }

      const reasons = this.approvalPolicy.scopeReasons(revisedPlan, request);
      if (reasons.length > 0) {
        await this.requireApproval(
          input,
          entry,
          "scope_change",
          reasons,
          recorder,
          runAudit,
          { scopeChangeId: request.id },
        );
      }
      const leases = this.ownership.acquire(
        revisedPlan,
        entry.task.agentId,
        waveVersion.sequence,
        { approvedResources: approvedSchemaResources(revisedPlan) },
      );
      entry.plan = revisedPlan;
      entry.planRevision += 1;
      entry.decision.planRevision = entry.planRevision;
      entry.decision.ownershipGrants.push(...leases);
      await recorder?.leases(leases);
      await recorder?.planRevision(entry.task.id, {
        revision: entry.planRevision,
        reason: "scope_change",
        canonicalRevision: waveVersion.revision,
        plan: revisedPlan,
      });
      await recorder?.decision(entry.decision);
      decision = {
        requestId: request.id,
        taskId: entry.task.id,
        decision: reasons.length > 0
          ? "approved_with_constraints"
          : "approved",
        revisedPlan,
        constraints:
          reasons.length > 0
            ? ["Scope expansion received required human approval"]
            : [],
        ownershipGrants: leases,
        explanation: "Scope expansion is conflict-free and ownership was granted",
        decidedAt: new Date().toISOString(),
      };
    } catch (error) {
      decision = {
        requestId: request.id,
        taskId: entry.task.id,
        decision: "rejected",
        revisedPlan: entry.plan,
        constraints: ["Continue within the previously approved plan"],
        ownershipGrants: [],
        explanation: errorMessage(error),
        decidedAt: new Date().toISOString(),
      };
    }

    await recorder?.scopeDecision(decision);
    await this.trace(
      recorder,
      runAudit,
      "scope_change_decided",
      entry.task.id,
      { decision },
    );
    await entry.adapter.resolveScopeChange(entry.session.id, decision);
  }

  private async requireApproval(
    input: CoordinatorRunInput,
    entry: PlannedTask,
    kind: ApprovalKind,
    reasons: string[],
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
    references: { changeSetId?: string; scopeChangeId?: string } = {},
  ): Promise<void> {
    if (reasons.length === 0) {
      return;
    }
    if (recorder === undefined || this.approvals === undefined) {
      throw new Error(
        `Human approval is required but no durable approval controller is configured: ${reasons.join("; ")}`,
      );
    }
    const review = await this.approvals.review({
      ...(input.organizationId === undefined
        ? {}
        : { organizationId: input.organizationId }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      repositoryId: input.repository.id,
      runId: recorder.runId,
      taskId: entry.task.id,
      kind,
      requestedBy: entry.task.agentId,
      reasons,
      ...(references.changeSetId === undefined
        ? {}
        : { changeSetId: references.changeSetId }),
      ...(references.scopeChangeId === undefined
        ? {}
        : { scopeChangeId: references.scopeChangeId }),
      onRequested: async (request) => {
        await this.trace(
          recorder,
          runAudit,
          "approval_requested",
          entry.task.id,
          {
            approvalId: request.id,
            kind: request.kind,
            reasons: request.reasons,
            expiresAt: request.expiresAt,
          },
        );
      },
    });
    await this.trace(
      recorder,
      runAudit,
      "approval_decided",
      entry.task.id,
      {
        approvalId: review.request.id,
        status: review.request.status,
        decidedBy: review.request.decidedBy,
        explanation: review.explanation,
      },
    );
    if (!review.approved) {
      throw new Error(
        `Human approval ${review.request.id} was not granted: ${review.explanation}`,
      );
    }
  }

  /**
   * The files a result still owes after integration answered.
   *
   * Two shapes reach here. Salvage kept most of a changeset and handed back
   * the contested remainder; or nothing could be kept at all and the whole
   * changeset is outstanding. Both are the same question to an agent that is
   * still holding the task: which files do you need to do again?
   */
  private contestedPaths(
    integration: IntegrationResult,
    changeSet: ChangeSet,
  ): string[] {
    if (integration.status === "conflict") {
      return [...new Set(changeSet.patches.map((patch) => patch.path))].sort();
    }
    return [
      ...new Set(
        (integration.salvagedDeferred ?? []).map((patch) => patch.path),
      ),
    ].sort();
  }

  /**
   * Asks the agent that just did the work to redo only what collided.
   *
   * The alternative this replaces is the expensive one: end the session, and
   * have a fresh agent rediscover the entire task from nothing — sixteen to
   * twenty-six times a run in the A/B series, at roughly 145k tokens each.
   * This session is still open and still has the task in context, and after
   * salvage the collision is usually a couple of lines, so what it is asked
   * costs a fraction of that.
   *
   * The contested files are reset to what canonical holds now before the
   * agent is asked. That matters: an agent shown its own losing copy has no
   * way to see what it is supposed to reconcile with, and would simply write
   * the same thing again.
   *
   * Exactly one attempt. A second collision means the file is genuinely
   * contended rather than merely overtaken, and the existing requeue is the
   * right answer for that — it is also what stops two agents trading repairs
   * for as long as they both keep losing.
   */
  private async repairChangeSet(
    input: CoordinatorRunInput,
    result: PreparedTask,
    contested: readonly string[],
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<ChangeSet | undefined> {
    const canonical = await this.repositories.getCanonicalVersion(
      input.repository,
    );
    // Show the agent the change it lost to, not its own copy of the file.
    for (const repositoryPath of contested) {
      const target = path.join(result.workspace.path, repositoryPath);
      try {
        const current = await this.repositories.readFile(
          input.repository,
          canonical.revision,
          repositoryPath,
        );
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, current, "utf8");
      } catch {
        // Absent from canonical means the other change deleted it. Leaving
        // the agent's copy in place is the honest state to reason from.
      }
    }

    await this.trace(recorder, runAudit, "replan_requested", result.task.id, {
      stage: "conflict_repair",
      files: [...contested],
      canonicalRevision: canonical.revision,
    });
    await recorder?.status(
      result.task.id,
      "running",
      `Reconciling ${contested.length} file(s) that changed underneath this work`,
    );

    await result.adapter.sendContext(result.session.id, {
      decision: result.decision,
      canonicalVersion: canonical,
      workspacePath: result.workspace.path,
      repair: {
        files: [...contested],
        reason:
          "These files changed in canonical while you were working, so your " +
          "edits to them were not kept. They have been reset to the current " +
          "canonical content. Re-apply only your intended change to them, on " +
          "top of what is now there. Everything else you did has already " +
          "been integrated — do not redo it.",
      },
    });

    const repaired = await result.adapter.collectChanges(result.session.id);
    assertChangeSetWithinPlan(result.plan, repaired);
    if (repaired.patches.length === 0) {
      return undefined;
    }
    await recorder?.changeSet(repaired);
    await this.trace(
      recorder,
      runAudit,
      "changeset_collected",
      result.task.id,
      {
        changeSetId: repaired.id,
        files: repaired.patches.map((patch) => patch.path),
        repairOf: result.changeSet.id,
      },
    );
    return repaired;
  }

  private async integrateTask(
    input: CoordinatorRunInput,
    result: PreparedTask,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<TaskExecutionResult> {
    let taskResult: TaskExecutionResult;
    try {
      await recorder?.status(result.task.id, "validating");
      let integration = await this.integrations.integrate({
        repository: input.repository,
        integrationRoot: input.integrationRoot,
        changeSet: result.changeSet,
        validationCommands: result.task.validationCommands,
        commitMessage: `coord(${result.task.id}): ${result.task.objective}`,
        author: agentCommitIdentity(result.task.agentId),
        trailers: [{ key: "Agent", value: result.task.agentId }],
        // Safe here in a way it is not everywhere: the agent is still open
        // below, so the half salvage cannot take is asked for rather than
        // dropped. A caller with nowhere to put the remainder must not set
        // this.
        salvageConflicts: this.repairConflicts,
      });

      const contested = this.repairConflicts
        ? this.contestedPaths(integration, result.changeSet)
        : [];
      if (contested.length > 0) {
        // A repair that cannot be attempted — an agent with no way to
        // reconcile, a cancelled session, a model that answers badly — must
        // not cost the work that already landed. Whatever salvage promoted is
        // in canonical, and the first answer stands.
        let repaired: ChangeSet | undefined;
        try {
          repaired = await this.repairChangeSet(
            input,
            result,
            contested,
            recorder,
            runAudit,
          );
        } catch (error) {
          await this.trace(recorder, runAudit, "task_failed", result.task.id, {
            stage: "conflict_repair",
            files: [...contested],
            error: errorMessage(error),
          });
        }
        if (repaired !== undefined) {
          // The repair is not privileged: same validation, same policy gate,
          // same compare-and-swap. A changeset a person had to approve the
          // first time is approved again here, because what it contains now
          // is not what they approved.
          const reviewReasons = this.approvalPolicy.changesetReasons(
            result.plan,
            repaired,
            { planWasReviewed: true },
          );
          if (reviewReasons.length > 0) {
            await recorder?.status(
              result.task.id,
              "awaiting_approval",
              reviewReasons.join("; "),
            );
            await this.requireApproval(
              input,
              result,
              "changeset",
              reviewReasons,
              recorder,
              runAudit,
              { changeSetId: repaired.id },
            );
          }
          const second = await this.integrations.integrate({
            repository: input.repository,
            integrationRoot: input.integrationRoot,
            changeSet: repaired,
            validationCommands: result.task.validationCommands,
            commitMessage: `coord(${result.task.id}): ${result.task.objective}`,
            author: agentCommitIdentity(result.task.agentId),
            trailers: [
              { key: "Agent", value: result.task.agentId },
              { key: "Conflict-Repair", value: contested.join(" ") },
            ],
            // One attempt. A second collision means genuine contention, and
            // the requeue that already exists is the right answer to that.
            salvageConflicts: false,
          });
          await recorder?.integration(second);
          await this.trace(
            recorder,
            runAudit,
            "validation_completed",
            result.task.id,
            {
              stage: "conflict_repair",
              status: second.status,
              files: [...contested],
            },
          );
          // A repair that fails leaves the first answer standing: whatever
          // salvage promoted is in canonical either way, and a failed second
          // pass must not present itself as the outcome of the task.
          if (second.status === "integrated") {
            integration = second;
          }
        }
      }
      await recorder?.integration(integration);
      // Asked to look, not to change — and it looked. Decided here rather
      // than at the status line below because the narration in between reads
      // differently for a report: see the two uses.
      //
      // "Changed no files" is failure for "fix the retry loop" and success
      // for "audit the codebase". Only the remote-worker path could express
      // the second, and every task the control plane runs in process comes
      // through here — so an audit, a review or a summary asked for in a
      // channel was done, carried all the way to this method, and then
      // recorded as failed with the integration service's "produced no
      // repository changes" in place of the findings the agent had written.
      //
      // Judged against the request rather than by relaxing `empty` generally,
      // because an empty changeset from a task that *was* meant to write is
      // the exact symptom a sandbox silently refusing every edit produces.
      // Reading the objective keeps that alarm intact and lets the report
      // through. Same reading the adapters and the worker path use, so no two
      // layers can disagree about what one empty changeset meant.
      const reported =
        integration.status === "empty" &&
        readsAsReportRequest(result.task.objective);
      // Nothing was validated because nothing was changed, and there is no
      // gate here to have passed or failed. Saying "validation came back
      // empty" in front of a finished report is the same false alarm this
      // whole branch exists to remove, one line earlier.
      if (!reported) {
        await this.trace(
          recorder,
          runAudit,
          "validation_completed",
          result.task.id,
          {
            status: integration.status,
            commands: integration.validation.map((entry) => ({
              label: entry.command.label,
              exitCode: entry.exitCode,
            })),
          },
        );
      }
      if ((integration.cleanupWarnings?.length ?? 0) > 0) {
        await this.trace(
          recorder,
          runAudit,
          "cleanup_failed",
          result.task.id,
          {
            stage: "integration",
            failures: integration.cleanupWarnings,
          },
        );
      }
      const explanation = reported
        ? // The agent's own words are the deliverable here — there is no diff
          // to read instead, and the generic line says nothing a reader can
          // use.
          result.changeSet.agentExplanation.trim().length > 0
          ? result.changeSet.agentExplanation.trim()
          : "Reported without changing any files."
        : integration.explanation;
      if (integration.status === "integrated") {
        await this.trace(
          recorder,
          runAudit,
          "canonical_promoted",
          result.task.id,
          {
            previousRevision: integration.previousVersion.revision,
            revision: integration.canonicalVersion.revision,
            changeSetId: integration.changeSetId,
            // What the agent says it did, carried so the ending can say it.
            // The account was written at `collectChanges` and travelled this
            // far unread: every successful task in the system ended with one
            // fixed sentence about canonical, which is true of all of them
            // and says nothing about any of them. The files are here for the
            // same reason — an ending that names them is worth more than one
            // that names a revision nobody will look up.
            //
            // The reader decides what to do with an empty or useless one; it
            // is reported as it stands rather than dressed up here.
            agentExplanation: result.changeSet.agentExplanation,
            files: result.changeSet.patches.map((patch) => patch.path),
          },
        );
      } else if (reported) {
        await this.trace(
          recorder,
          runAudit,
          "task_reported",
          result.task.id,
          { explanation },
        );
      } else {
        await this.trace(
          recorder,
          runAudit,
          "task_failed",
          result.task.id,
          {
            status: integration.status,
            explanation: integration.explanation,
          },
        );
      }
      const status =
        integration.status === "integrated" || reported
          ? "integrated"
          : "failed";
      await recorder?.status(result.task.id, status, explanation);
      taskResult = {
        task: result.task,
        plan: result.plan,
        decision: result.decision,
        integration,
        status,
        explanation,
      };
    } catch (error) {
      await recorder?.status(result.task.id, "failed", errorMessage(error));
      await this.trace(recorder, runAudit, "task_failed", result.task.id, {
        stage: "integration",
        error: errorMessage(error),
      });
      taskResult = {
        task: result.task,
        plan: result.plan,
        decision: result.decision,
        status: "failed",
        explanation: errorMessage(error),
      };
    }

    const cleanupFailure = await this.cleanupTask(
      result.workspace,
      result.task.id,
      recorder,
      runAudit,
    );
    if (cleanupFailure !== undefined) {
      taskResult.explanation += `; ${cleanupFailure}`;
      await recorder?.status(
        result.task.id,
        taskResult.status,
        taskResult.explanation,
      );
    }
    return taskResult;
  }

  /**
   * Reports what the agent is touching, on a timer, while it edits.
   *
   * Only differences are written. A run that spends twenty minutes reading
   * before its first edit would otherwise post the same empty list a hundred
   * times, and a thread of identical lines is no more informative than
   * silence — it is just louder. The first tick with anything in it reports
   * everything; each one after that reports only what is new or has changed
   * status.
   *
   * Never allowed to disturb the run. A workspace that cannot be read (a
   * manager with no cheap answer, a git call that fails under load, a
   * worktree already destroyed) simply skips that tick: this exists to
   * describe the work, and describing it must not be able to stop it.
   */
  private watchWorkingChanges(
    workspace: TaskWorkspace,
    taskId: string,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): { stop: () => Promise<void> } {
    const list = this.workspaces.listWorkingChanges?.bind(this.workspaces);
    if (list === undefined) {
      return { stop: async () => undefined };
    }
    const reported = new Map<string, FilePatchStatus>();
    let inFlight: Promise<void> = Promise.resolve();
    let stopped = false;

    const tick = async (): Promise<void> => {
      if (stopped) {
        return;
      }
      let changes: Array<{ path: string; status: FilePatchStatus }>;
      try {
        changes = await list(workspace);
      } catch {
        return;
      }
      const fresh = changes.filter(
        (change) => reported.get(change.path) !== change.status,
      );
      if (fresh.length === 0) {
        return;
      }
      for (const change of fresh) {
        reported.set(change.path, change.status);
      }
      // The whole set, not just what moved: a reader arriving late, and the
      // channel summary this feeds, both want the current state of the work
      // rather than a diff they would have to accumulate themselves.
      await this.trace(recorder, runAudit, "workspace_changed", taskId, {
        files: changes.map((change) => ({
          path: change.path,
          status: change.status,
        })),
        changed: fresh.map((change) => change.path),
      }).catch(() => undefined);
    };

    const timer = setInterval(() => {
      inFlight = inFlight.then(tick);
    }, this.workingChangePollMs);
    timer.unref?.();

    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        // Whatever the last tick was mid-way through, so a stop cannot leave
        // a trace being written into a run that has already moved on.
        await inFlight.catch(() => undefined);
      },
    };
  }

  private async trace(
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
    type: AuditEventType,
    taskId: string | undefined,
    data: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    runAudit.push(this.audit.record(type, taskId, data));
    await recorder?.audit(type, taskId, data);
  }

  private async cleanupTask(
    workspace: TaskWorkspace | undefined,
    taskId: string,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<string | undefined> {
    const failures: string[] = [];
    if (workspace !== undefined) {
      try {
        await this.workspaces.destroy(workspace);
      } catch (error) {
        failures.push(`workspace: ${errorMessage(error)}`);
      }
    }

    let released: ReturnType<OwnershipService["releaseTask"]> = [];
    try {
      released = this.ownership.releaseTask(taskId);
    } catch (error) {
      failures.push(`ownership: ${errorMessage(error)}`);
    }
    try {
      await recorder?.releaseLeases(taskId);
    } catch (error) {
      failures.push(`lease record: ${errorMessage(error)}`);
    }
    try {
      await this.trace(
        recorder,
        runAudit,
        "ownership_released",
        taskId,
        { leaseIds: released.map((lease) => lease.leaseId) },
      );
    } catch (error) {
      failures.push(`release audit: ${errorMessage(error)}`);
    }
    if (failures.length === 0) {
      return undefined;
    }
    const explanation = `Cleanup failed (${failures.join("; ")})`;
    try {
      await this.trace(recorder, runAudit, "cleanup_failed", taskId, {
        failures,
      });
    } catch (error) {
      return `${explanation}; cleanup audit: ${errorMessage(error)}`;
    }
    return explanation;
  }
}
