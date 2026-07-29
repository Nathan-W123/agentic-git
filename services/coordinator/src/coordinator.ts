import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
} from "@coord/agent-protocol";
import {
  CodeIntelligenceService,
  groundPlan,
  type RepositoryIndex,
} from "@coord/code-intelligence";
import { IntegrationService } from "@coord/integration-service";
import type { CoordinationStore } from "@coord/persistence";
import {
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  assertAgentPlan,
  createId,
  mergePlanScope,
  normalizeRepositoryPath,
  planGroundingConfidence,
  uniqueStrings,
  type AgentPlan,
  type ApprovalKind,
  type AuditEvent,
  type AuditEventType,
  type CanonicalVersion,
  type ChangeSet,
  type ConflictAssessment,
  type CoordinationRunResult,
  type CoordinatorDecision,
  type ReplanRequest,
  type ScopeChangeDecision,
  type ScopeChangeRequest,
  type TaskDefinition,
  type TaskExecutionResult,
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
import { ConflictDetector } from "./conflict-detector.js";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
}

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
      await recorder?.finish("completed", result.canonicalVersion);
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
          session = await entry.adapter.startTask({
            task: entry.task,
            canonicalVersion: version,
            repositoryId: input.repository.id,
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
    // An unverifiable plan is never proven disjoint from anything, because
    // nothing it declares exists to compare. It still runs — in a wave of its
    // own: behind every verifiable task, and behind every earlier
    // unverifiable one. Edges all point one way, so no cycle is possible.
    for (const entry of pending) {
      if (planGroundingConfidence(entry.plan) !== "ungrounded") {
        continue;
      }
      for (const other of pending) {
        if (other === entry) {
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
      await entry.adapter.sendContext(entry.session.id, {
        decision: entry.decision,
        canonicalVersion: waveVersion,
        workspacePath: workspace.path,
        planRevision: entry.planRevision,
      });
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
        },
      );

      const reviewReasons = this.approvalPolicy.changesetReasons(
        entry.plan,
        changeSet,
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

  private async integrateTask(
    input: CoordinatorRunInput,
    result: PreparedTask,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<TaskExecutionResult> {
    let taskResult: TaskExecutionResult;
    try {
      await recorder?.status(result.task.id, "validating");
      const integration = await this.integrations.integrate({
        repository: input.repository,
        integrationRoot: input.integrationRoot,
        changeSet: result.changeSet,
        validationCommands: result.task.validationCommands,
        commitMessage: `coord(${result.task.id}): ${result.task.objective}`,
      });
      await recorder?.integration(integration);
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
          },
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
        integration.status === "integrated" ? "integrated" : "failed";
      await recorder?.status(result.task.id, status, integration.explanation);
      taskResult = {
        task: result.task,
        plan: result.plan,
        decision: result.decision,
        integration,
        status,
        explanation: integration.explanation,
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
