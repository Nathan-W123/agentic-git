import { mkdir } from "node:fs/promises";
import path from "node:path";

import { CodeIntelligenceService, groundPlan } from "@coord/code-intelligence";
import {
  DEFAULT_PLAN_RETRY_MS,
  OwnershipService,
  PlanAdmissionController,
  BLOCKED_ADMISSION_LIFETIME_CAP,
  BLOCKED_ATTEMPTS_BEFORE_SEQUENCING,
  ScopeExpansionError,
  StoreApprovalController,
  approvalPolicyForProject,
  approvedSchemaResources,
  assertChangeSetWithinPlan,
  deferredScopeObjective,
  isDeferredScopeFollowUp,
  assessReplay,
  buildTaskHandoff,
  recordTaskHandoff,
  splitChangeSet,
  withheldPatchRecord,
  type ActivePlan,
  type CanonicalAdvance,
  type ChangeSetSplit,
} from "@coord/coordinator";
import { IntegrationService } from "@coord/integration-service";
import type {
  CoordinationStore,
  SubmittedTask,
  WorkLease,
} from "@coord/persistence";
import {
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  assertAgentPlan,
  assertChangeSet,
  createId,
  deferredFilePaths,
  mergePlanScope,
  normalizeRepositoryPath,
  planAdmissionApproved,
  planAdmissionPartial,
  projectBudgets,
  reducePlanScope,
  uniqueRepositoryPaths,
  uniqueStrings,
  type AgentPlan,
  type CanonicalVersion,
  type ChangeSet,
  type CoordinatorDecision,
  type DeferredResource,
  type IntegrationResult,
  type PlanAdmission,
  type ResourceType,
  type ScopeChangeDecision,
  type ScopeChangeRequest,
  type TaskDefinition,
  type TaskId,
} from "@coord/shared-types";
import {
  DockerWorkspaceManager,
  GitWorktreeWorkspaceManager,
  type WorkspaceManager,
} from "@coord/workspace-manager";

import type { CoordinatorProject } from "./project.js";

/**
 * Restores the admission loop as it behaved before it was bounded.
 *
 * Both halves of the fix go away together: refusals stop being counted, so a
 * plan is told to narrow however many times it collides, and tasks known to be
 * waiting stop being deprioritised, so a worker is handed its own dead end
 * again. That is the exact prior behaviour on an identical build, which is
 * what a control arm has to be — the same shape as COORD_COLD_REPLAN and
 * COORD_UNGROUNDED_REPLAN, and the rollback if the bound misbehaves.
 */
function legacyAdmissionLoop(): boolean {
  return process.env["COORD_LEGACY_ADMISSION_LOOP"] === "1";
}

/** A worker holds a task for this long before it must heartbeat again. */
export const WORK_LEASE_TTL_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

/**
 * How many remote workers may hold leases in one repository at once.
 *
 * Concurrency is optimistic: a result integrates from the base it was leased
 * at, or — when canonical moved on without touching anything the result
 * depends on — is replayed onto the newer revision. Anything else is requeued
 * to replan, so this bound trades duplicate agent effort against wall-clock
 * throughput without touching correctness. Operators tune it with
 * COORD_REPOSITORY_PARALLELISM; workers cannot choose it for themselves.
 */
export const DEFAULT_REPOSITORY_PARALLELISM = 4;

function configuredRepositoryParallelism(explicit?: number): number {
  if (explicit !== undefined) {
    return explicit;
  }
  const raw = process.env["COORD_REPOSITORY_PARALLELISM"]?.trim() ?? "";
  if (raw.length === 0) {
    return DEFAULT_REPOSITORY_PARALLELISM;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      "COORD_REPOSITORY_PARALLELISM must be a positive integer",
    );
  }
  return value;
}

/**
 * Wire version of the remote worker protocol.
 *
 * 1 planned and executed in one shot and posted a result.
 * 2 submits the plan for admission first and only executes once the control
 *   plane grants ownership, so a conflict costs a planning round trip instead
 *   of a discarded execution.
 */
export const WORKER_PROTOCOL_VERSION = 2;

export interface WorkAssignment {
  lease: WorkLease;
  task: SubmittedTask;
  repository: { id: string; branch: string };
  canonicalVersion: CanonicalVersion;
  bundleUrl: string;
  bundleRef: string;
  heartbeatIntervalMs: number;
  /** Worker-side check that the control plane expects a plan first. */
  protocolVersion: number;
  /** Submit the agent's plan here before executing anything. */
  planUrl: string;
}

export interface WorkResultInput {
  leaseId: string;
  status: "completed" | "failed";
  actorId: string;
  plan: unknown;
  changeSet: unknown;
  detail?: string;
}

export interface WorkResultAcceptance {
  accepted: boolean;
  reason?: string;
  runId?: string;
  integrationStatus?: IntegrationResult["status"];
  requeued?: boolean;
}

/**
 * How many times a result that lost an integration race may be re-graded
 * against the advance that beat it before it gives up and replans.
 *
 * One. A single re-assessment covers losing one race, which is what actually
 * happens when two tasks finish together; a result that loses twice is in a
 * repository advancing faster than it can integrate, and there the replan is
 * both the cheaper answer and the more likely correct one. Each attempt costs
 * a full validation run, so this trades a bounded, known cost against an
 * unbounded agent replan — but only a bounded one.
 */
export const STALE_REASSESSMENT_BUDGET = 1;

interface WorkResultServices {
  repositories?: RepositoryService;
  integrations?: IntegrationService;
  /** Reads what a canonical advance changed, to decide whether it matters. */
  intelligence?: CodeIntelligenceService;
  integrationRoot?: string;
}

/**
 * What one canonical advance changed, in resource terms.
 *
 * The file list comes from Git and is exact. The resources come from indexing
 * the revision that was advanced *to*, because that is the state a replay
 * would land on. A file the advance deleted is absent from that index, which
 * costs nothing: a deleted file this result also touched is already caught by
 * the file list.
 */
async function canonicalAdvance(
  repositories: RepositoryService,
  intelligence: CodeIntelligenceService,
  repository: CanonicalRepository,
  from: CanonicalVersion,
  to: CanonicalVersion,
): Promise<CanonicalAdvance> {
  const changedFiles = await repositories.listChangedFiles(
    repository,
    from.revision,
    to.revision,
  );
  const index = await intelligence.index(repository, to.revision);
  const changed = intelligence.changedResources(changedFiles, index);
  return {
    changedFiles,
    changedSymbols: changed.symbols,
    changedApis: changed.apis,
    changedSchemas: changed.schemas,
    changedConfigKeys: changed.configKeys,
    changedTests: changed.tests,
    changedServices: changed.services,
  };
}

/** Derived from the lease so concurrent bundle requests cannot collide. */
export function bundleRefFor(leaseId: string): string {
  return `coord-lease/${leaseId.replaceAll(/[^A-Za-z0-9_-]/gu, "")}`;
}

function canonical(repository: {
  id: string;
  path: string;
  branch: string;
}): CanonicalRepository {
  return {
    id: repository.id,
    path: repository.path,
    branch: repository.branch,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function submittedTask(
  store: CoordinationStore,
  lease: WorkLease,
): Promise<SubmittedTask | undefined> {
  return (
    await store.listSubmittedTasks({
      repositoryId: lease.repositoryId,
      ...(lease.projectId === undefined ? {} : { projectId: lease.projectId }),
    })
  ).find((task) => task.id === lease.taskId);
}

async function failClaimedTask(
  store: CoordinationStore,
  taskId: string,
  runId?: string,
): Promise<void> {
  const current = (await store.listSubmittedTasks()).find(
    (task) => task.id === taskId,
  );
  if (current?.status === "claimed") {
    await store.completeSubmittedTask(taskId, "failed", runId);
  }
}

async function trace(
  store: CoordinationStore,
  runId: string | undefined,
  type: Parameters<CoordinationStore["appendAudit"]>[1]["type"],
  taskId: string,
  data: Readonly<Record<string, unknown>>,
): Promise<void> {
  await store.appendAudit(runId, { type, taskId, data });
}

function adapterName(
  project: CoordinatorProject | undefined,
  task: SubmittedTask,
): string | undefined {
  if (project === undefined) {
    return undefined;
  }
  const [, agent] = project.requireAgent(task.agentId);
  return agent.adapter ?? "generic-cli";
}

/**
 * Atomically leases the next compatible task in one authorized project.
 *
 * A repository admits a bounded number of concurrent leases
 * ({@link DEFAULT_REPOSITORY_PARALLELISM}). Each lease pins the exact
 * canonical revision it was issued at; result acceptance integrates from that
 * exact base or requeues the task to replan, so concurrent workers can never
 * corrupt canonical — a losing worker only wastes its own effort.
 */
export async function leaseWork(
  store: CoordinationStore,
  input: {
    workerId: string;
    projectId: string;
    repositoryId?: string;
    /** Test override; deployments configure COORD_REPOSITORY_PARALLELISM. */
    repositoryParallelism?: number;
  },
  repositories = new RepositoryService(),
  project?: CoordinatorProject,
): Promise<WorkAssignment | undefined> {
  const worker = await store.getWorker(input.workerId);
  if (worker === undefined) {
    throw new Error(`Unknown worker: ${input.workerId}`);
  }
  const repositoryParallelism = configuredRepositoryParallelism(
    input.repositoryParallelism,
  );

  // Cost control: an exhausted project stops receiving workers until usage
  // rolls out of the 24-hour window. Tasks stay queued rather than failing —
  // the budget throttles spend, it does not discard work.
  const projectRecord = await store.getProject(input.projectId);
  const budgets = projectBudgets(projectRecord?.policy);
  const budget = budgets.maxProjectRuntimeMsPerDay;
  // The same throttle applied to spend rather than to time. A task can be
  // quick and expensive, so this is a separate limit rather than a proxy for
  // the runtime one, and it is checked the same way: sum what has been
  // reported inside the window and stop handing out work when it is used up.
  if (budgets.maxProjectTokensPerDay !== undefined) {
    const windowStart = new Date(
      Date.now() - 24 * 60 * 60 * 1000,
    ).toISOString();
    const spent = (
      await store.listTokenUsage({
        projectId: input.projectId,
        recordedAfter: windowStart,
      })
    ).reduce((sum, entry) => sum + entry.totalTokens, 0);
    if (spent >= budgets.maxProjectTokensPerDay) {
      return undefined;
    }
  }
  if (budget !== undefined) {
    const now = Date.now();
    const windowStart = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    // Leases that began before the window under-count slightly; budgets are
    // throttles, and the error is bounded by one task's runtime.
    const leases = await store.listWorkLeases({
      projectId: input.projectId,
      issuedAfter: windowStart,
    });
    const usedMs = leases.reduce((sum, lease) => {
      const started = new Date(lease.issuedAt).getTime();
      const ended =
        lease.finishedAt !== undefined
          ? new Date(lease.finishedAt).getTime()
          : lease.status === "active"
            ? now
            : started;
      return sum + Math.max(0, ended - started);
    }, 0);
    if (usedMs >= budget) {
      return undefined;
    }
  }

  const pending = await store.listSubmittedTasks({
    projectId: input.projectId,
    status: "submitted",
    ...(input.repositoryId === undefined
      ? {}
      : { repositoryId: input.repositoryId }),
  });

  // Tasks known to be waiting on someone else go to the back of the queue.
  //
  // Planning is the expensive half of a lease and it happens before the
  // coordinator is ever consulted, so leasing a task whose last answer was
  // "wait for task X, which is still running" buys a full planning round to be
  // told the same thing again. In the ten-task live run 74% of planning calls
  // ended in a deferral at ~23,000 tokens each — the single largest line in
  // the bill, and almost all of it spent re-deriving plans that were already
  // known to be unschedulable.
  //
  // This is an ordering preference, never an exclusion: if everything is
  // waiting, the loop below still takes the first candidate. A task cannot be
  // starved by it, only postponed behind work that can actually run.
  const waiting = legacyAdmissionLoop()
    ? new Set<TaskId>()
    : await tasksWaitingOnActiveWork(store, pending);
  const ordered = [
    ...pending.filter((task) => !waiting.has(task.id)),
    ...pending.filter((task) => waiting.has(task.id)),
  ];

  // Try every compatible candidate rather than only the first: another
  // worker polling at the same moment may have claimed it, or its
  // repository may be at its parallelism cap while a later task's is not.
  for (const next of ordered) {
    const required = adapterName(project, next);
    if (required !== undefined && !worker.adapters.includes(required)) {
      continue;
    }
    const stored = await store.getRepository(next.repositoryId);
    if (stored === undefined) {
      throw new Error(`Unknown repository: ${next.repositoryId}`);
    }
    const repository = canonical(stored);
    const version = await repositories.getCanonicalVersion(repository);
    const leased = await store.leaseNextTask({
      workerId: input.workerId,
      taskId: next.id,
      projectId: input.projectId,
      repositoryId: next.repositoryId,
      baseRevision: version.revision,
      ttlMs: WORK_LEASE_TTL_MS,
      repositoryParallelism,
    });
    if (leased === undefined) {
      continue;
    }
    await trace(store, undefined, "task_started", leased.task.id, {
      projectId: leased.task.projectId,
      repositoryId: leased.task.repositoryId,
      workerId: leased.lease.workerId,
      leaseId: leased.lease.id,
      baseRevision: leased.lease.baseRevision,
      remote: true,
    });
    return {
      lease: leased.lease,
      task: leased.task,
      repository: {
        id: stored.id,
        branch: stored.branch,
      },
      canonicalVersion: version,
      bundleUrl: `/api/v1/workers/leases/${leased.lease.id}/bundle`,
      bundleRef: bundleRefFor(leased.lease.id),
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      protocolVersion: WORKER_PROTOCOL_VERSION,
      planUrl: `/api/v1/workers/leases/${leased.lease.id}/plan`,
    };
  }
  return undefined;
}

/**
 * Packages the leased snapshot. The bundle includes ancestors reachable from
 * that commit, but no newer canonical revision or unrelated branch ref.
 */
export async function leaseBundle(
  store: CoordinationStore,
  leaseId: string,
  repositories = new RepositoryService(),
): Promise<Buffer | undefined> {
  const now = new Date().toISOString();
  await store.expireWorkLeases(now);
  const lease = await store.getWorkLease(leaseId);
  if (lease === undefined || lease.status !== "active") {
    return undefined;
  }
  const repository = await store.getRepository(lease.repositoryId);
  if (repository === undefined) {
    return undefined;
  }
  return await repositories.createBundle(
    canonical(repository),
    lease.baseRevision,
    bundleRefFor(lease.id),
  );
}

/**
 * Fails a lease whose worker sent something the control plane cannot use.
 *
 * Failing rather than releasing is deliberate at both the plan and the result
 * stage: a malformed submission would be malformed again on the next attempt,
 * so requeueing would loop forever.
 */
async function failLease(
  store: CoordinationStore,
  lease: WorkLease,
  reason: string,
  stage: string,
): Promise<void> {
  const now = new Date().toISOString();
  const settled = await store.finishWorkLease(
    lease.id,
    "failed",
    now,
    reason.slice(0, 2_000),
  );
  if (!settled) {
    await store.expireWorkLeases(now);
    return;
  }
  await failClaimedTask(store, lease.taskId);
  await trace(store, undefined, "task_failed", lease.taskId, {
    projectId: lease.projectId,
    repositoryId: lease.repositoryId,
    workerId: lease.workerId,
    leaseId: lease.id,
    stage,
    error: reason,
  });
}

async function rejectWorkerResult(
  store: CoordinationStore,
  lease: WorkLease,
  reason: string,
): Promise<WorkResultAcceptance> {
  const now = new Date().toISOString();
  const settled = await store.finishWorkLease(
    lease.id,
    "failed",
    now,
    reason.slice(0, 2_000),
  );
  if (!settled) {
    await store.expireWorkLeases(now);
    return { accepted: false, reason: "lease was lost before result rejection" };
  }
  await failClaimedTask(store, lease.taskId);
  await trace(store, undefined, "task_failed", lease.taskId, {
    projectId: lease.projectId,
    repositoryId: lease.repositoryId,
    workerId: lease.workerId,
    leaseId: lease.id,
    stage: "remote_result_validation",
    error: reason,
  });
  return { accepted: false, reason };
}

async function requeueForCanonicalChange(
  store: CoordinationStore,
  repositories: RepositoryService,
  lease: WorkLease,
  previousVersion: CanonicalVersion,
  canonicalVersion: CanonicalVersion,
  runId?: string,
): Promise<WorkResultAcceptance> {
  const repository = await store.getRepository(lease.repositoryId);
  const changedFiles =
    repository === undefined
      ? []
      : await repositories.listChangedFiles(
          canonical(repository),
          previousVersion.revision,
          canonicalVersion.revision,
        );
  const now = new Date().toISOString();
  if (runId === undefined) {
    const released = await store.finishWorkLease(
      lease.id,
      "released",
      now,
      "canonical changed; remote task must replan",
    );
    if (!released) {
      await store.expireWorkLeases(now);
      return { accepted: false, reason: "lease was lost before replanning" };
    }
  } else {
    const currentLease = await store.getWorkLease(lease.id);
    if (currentLease?.status === "active") {
      const released = await store.finishWorkLease(
        lease.id,
        "released",
        now,
        "canonical changed; remote task must replan",
      );
      if (!released) {
        await store.expireWorkLeases(now);
      }
    } else {
      const currentTask = (await store.listSubmittedTasks()).find(
        (task) => task.id === lease.taskId,
      );
      if (currentTask?.status === "claimed") {
        await store.retrySubmittedTask(lease.taskId);
      }
    }
    await store.saveTaskStatus(
      runId,
      lease.taskId,
      "cancelled",
      "Canonical changed; task was returned to the remote queue for replanning",
    );
    await store.finishRun(runId, "completed", canonicalVersion);
  }
  const data = {
    projectId: lease.projectId,
    repositoryId: lease.repositoryId,
    previousRevision: previousVersion.revision,
    revision: canonicalVersion.revision,
    changedFiles,
    workerId: lease.workerId,
    leaseId: lease.id,
  };
  await trace(store, runId, "canonical_changed", lease.taskId, data);
  await trace(store, runId, "replan_requested", lease.taskId, data);
  return {
    accepted: false,
    reason: "Canonical changed while the task was remote; it was requeued to replan",
    ...(runId === undefined ? {} : { runId }),
    requeued: true,
  };
}

/**
 * Hands back a task whose agent only edited the resources it was not granted.
 *
 * This is the degenerate partial admission: the deferral covered the work the
 * agent actually did, so there is nothing to promote. Releasing the lease
 * returns the task to the queue at its full original scope, where it will be
 * arbitrated again — by then the contested resource may well be free, and the
 * whole task can run at once.
 */
async function requeueForDeferredScope(
  store: CoordinationStore,
  lease: WorkLease,
  task: SubmittedTask,
  split: { deferred: readonly { path: string }[] },
): Promise<WorkResultAcceptance> {
  const paths = split.deferred.map((patch) => patch.path).sort();
  const reason =
    "Every change the agent made was to a deferred resource " +
    `(${paths.join(", ")}); the task was requeued at full scope`;
  const now = new Date().toISOString();
  const released = await store.finishWorkLease(
    lease.id,
    "released",
    now,
    reason,
  );
  if (!released) {
    await store.expireWorkLeases(now);
    return { accepted: false, reason: "lease was lost before requeueing" };
  }
  await trace(store, undefined, "replan_requested", task.id, {
    projectId: task.projectId,
    repositoryId: task.repositoryId,
    workerId: lease.workerId,
    leaseId: lease.id,
    deferredFiles: paths,
    reason,
  });
  return { accepted: false, reason, requeued: true };
}

/**
 * Queues the remainder of a partially admitted task.
 *
 * This is what makes partial admission a division of labour rather than a
 * quiet loss of scope. The granted files are in canonical; the deferred ones
 * are still owned by someone else, so they become a small task of their own
 * that will be leased, planned, and arbitrated like any other — against
 * whatever canonical looks like once the current holder is done with them.
 *
 * The agent's own patches for the deferred files are deliberately not carried
 * forward. They were written against a revision of a file that another task is
 * in the middle of rewriting, so replaying them later would be applying a diff
 * to a base that no longer exists. Their paths are recorded; their content is
 * not resurrected.
 */
async function queueDeferredScope(
  store: CoordinationStore,
  runId: string,
  task: SubmittedTask,
  admission: PlanAdmission,
  split: ChangeSetSplit,
  reported: ChangeSet,
): Promise<string | undefined> {
  const deferred = admission.deferredResources ?? [];
  if (deferred.length === 0) {
    return undefined;
  }
  const followUp = await store.submitTask({
    repositoryId: task.repositoryId,
    ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
    objective: deferredScopeObjective(
      task.objective,
      deferred,
      // A granted file whose patch was held back for reaching into a withheld
      // symbol lost its other edits with it. The follow-up covers it, or that
      // work is quietly gone.
      Object.keys(split.withheldSymbols).sort(),
    ),
    agentId: task.agentId,
    validationCommands: task.validationCommands,
    ...(task.submittedBy === undefined ? {} : { submittedBy: task.submittedBy }),
  });
  await trace(store, runId, "task_submitted", followUp.id, {
    projectId: task.projectId,
    repositoryId: task.repositoryId,
    objective: followUp.objective,
    deferredFrom: task.id,
    deferredResources: deferred,
    discardedPatches: split.deferred.map((patch) => patch.path).sort(),
    ...(Object.keys(split.withheldSymbols).length === 0
      ? {}
      : { droppedForWithheldSymbols: split.withheldSymbols }),
  });

  // The work itself, kept rather than thrown away. It is not replayed later —
  // it was written against a file another task is rewriting — but the agent
  // that picks the follow-up up starts from what was already worked out
  // instead of from nothing.
  if (split.deferred.length > 0) {
    const record = withheldPatchRecord(split.deferred);
    await trace(store, runId, "changeset_withheld", followUp.id, {
      projectId: task.projectId,
      repositoryId: task.repositoryId,
      deferredFrom: task.id,
      reportedChangeSetId: reported.id,
      baseRevision: reported.baseRevision,
      baseVersion: reported.baseVersion,
      patches: record.patches,
      truncated: record.truncated,
      bytes: record.bytes,
      explanation:
        "Patches a partial admission held back. Kept as context for the " +
        "follow-up task; never applied, because the base they were written " +
        "against is being rewritten by whoever holds the deferred resource",
    });
  }
  return followUp.id;
}

/**
 * The human gate in front of a remote plan.
 *
 * `pending` is not a failure and not a refusal: the reviewer has not answered
 * yet. The worker keeps its lease, keeps heartbeating, and resubmits, because
 * what it is waiting for is a person rather than another worker's lease.
 */
type PlanGate =
  | { outcome: "approved"; runId: string }
  | { outcome: "pending"; admission: PlanAdmission }
  | { outcome: "refused"; reason: string };

/** Short enough that an approval is picked up promptly, long enough to idle. */
const APPROVAL_POLL_RETRY_MS = 5_000;

/**
 * Asks a reviewer about a remote plan before any agent time is spent on it.
 *
 * The local coordinator has always gated a risky plan between `requestPlan`
 * and `sendContext`. Remotely the only gate was at the changeset, which is
 * after the agent has run — the review could reject work that had already
 * been paid for, and could not prevent a high-risk plan from executing at
 * all. This closes that asymmetry, using the same reasons the local gate
 * uses and the same durable approval record, so one queue serves both.
 *
 * It is judged on the plan the worker submitted rather than on the enriched
 * one, deliberately: what a reviewer is being asked to sanction is what the
 * agent said it would do, not what the index later inferred from it.
 *
 * An approval needs a run to belong to, so a gated plan opens its run early
 * and the result path reuses it. That has a second benefit — a plan waiting
 * on a reviewer is visible in run history while it waits, instead of
 * appearing only once the work is finished.
 */
async function gateRemotePlan(
  store: CoordinationStore,
  lease: WorkLease,
  task: SubmittedTask,
  repository: { id: string; path: string; branch: string },
  baseVersion: CanonicalVersion,
  plan: AgentPlan,
  reasons: readonly string[],
  organizationId: string | undefined,
  timeoutMs: number,
): Promise<PlanGate> {
  const now = new Date().toISOString();
  const previous = lease.plan?.admission;
  let runId = previous?.runId;

  const pendingAdmission = (
    approvalId: string,
    openRunId: string,
  ): PlanAdmission => ({
    status: "sequenced",
    taskId: task.id,
    planRevision: 1,
    baseRevision: baseVersion.revision,
    ownershipGrants: [],
    constraints: [
      "Hold this plan until a reviewer decides; do not start editing",
    ],
    blockedBy: [],
    conflicts: [],
    explanation: `Plan is waiting for human approval: ${reasons.join("; ")}`,
    retryAfterMs: APPROVAL_POLL_RETRY_MS,
    awaitingApproval: true,
    approvalId,
    runId: openRunId,
    decidedAt: new Date().toISOString(),
  });

  if (previous?.approvalId !== undefined && runId !== undefined) {
    await store.expireApprovals(now);
    const current = await store.getApproval(previous.approvalId);
    if (current !== undefined) {
      if (current.status === "approved") {
        await trace(store, runId, "approval_decided", task.id, {
          projectId: task.projectId,
          approvalId: current.id,
          status: current.status,
          decidedBy: current.decidedBy,
          stage: "remote_plan_admission",
        });
        return { outcome: "approved", runId };
      }
      if (current.status === "pending") {
        return {
          outcome: "pending",
          admission: pendingAdmission(current.id, runId),
        };
      }
      const reason =
        `Remote plan was not approved: approval ${current.id} is ` +
        `${current.status}${
          current.decisionComment === undefined
            ? ""
            : ` (${current.decisionComment})`
        }`;
      await trace(store, runId, "approval_decided", task.id, {
        projectId: task.projectId,
        approvalId: current.id,
        status: current.status,
        decidedBy: current.decidedBy,
        stage: "remote_plan_admission",
      });
      await store
        .saveTaskStatus(runId, task.id, "failed", reason)
        .catch(() => undefined);
      await store.finishRun(runId, "failed").catch(() => undefined);
      return { outcome: "refused", reason };
    }
  }

  if (runId === undefined) {
    const run = await store.createRun({
      repository,
      ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
      mode: "coordinated",
      scenario: "remote-worker",
      baseVersion,
    });
    runId = run.id;
    await store.saveTask(runId, {
      id: task.id,
      objective: task.objective,
      agentId: task.agentId,
      validationCommands: task.validationCommands,
      ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
    });
    await store.savePlan(runId, task.id, plan);
  }
  await store.saveTaskStatus(
    runId,
    task.id,
    "awaiting_approval",
    reasons.join("; "),
  );
  const request = await store.createApproval({
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
    repositoryId: task.repositoryId,
    runId,
    taskId: task.id,
    kind: "policy_override",
    requestedBy: task.agentId,
    requiredRole: "reviewer",
    reasons: [...reasons],
    expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
  });
  await trace(store, runId, "approval_requested", task.id, {
    projectId: task.projectId,
    repositoryId: task.repositoryId,
    workerId: lease.workerId,
    leaseId: lease.id,
    approvalId: request.id,
    kind: request.kind,
    reasons: request.reasons,
    expiresAt: request.expiresAt,
    stage: "remote_plan_admission",
  });
  return { outcome: "pending", admission: pendingAdmission(request.id, runId) };
}

export interface WorkPlanInput {
  leaseId: string;
  actorId: string;
  plan: unknown;
}

export type WorkPlanOutcome =
  /** The coordinator answered; `admission.status` says whether to execute. */
  | { outcome: "admitted"; admission: PlanAdmission }
  /** The submission was unusable; the lease and task are failed. */
  | { outcome: "rejected"; reason: string }
  /** The lease lapsed or was settled; stop work and re-lease. */
  | { outcome: "lease_lost"; reason: string };

interface WorkPlanServices {
  repositories?: RepositoryService;
  intelligence?: CodeIntelligenceService;
  admissions?: PlanAdmissionController;
}

/** How many times admission is recomputed when a rival admission lands first. */
const MAX_ADMISSION_ATTEMPTS = 4;

/**
 * Tasks whose most recent admission sequenced them behind work that is still
 * executing.
 *
 * The blocker has to be checked, not just remembered: a task sequenced behind
 * something that has since integrated is ready now, and treating it as waiting
 * would postpone it forever. So the answer is recomputed from the live lease
 * table every time, and a task only counts as waiting while at least one of
 * the tasks named in its last refusal still holds an active lease.
 */
async function tasksWaitingOnActiveWork(
  store: CoordinationStore,
  pending: readonly SubmittedTask[],
): Promise<Set<TaskId>> {
  if (pending.length === 0) {
    return new Set();
  }
  const active = new Set(
    (await store.listWorkLeases({ status: "active" })).map(
      (lease) => lease.taskId,
    ),
  );
  if (active.size === 0) {
    return new Set();
  }
  const waiting = new Set<TaskId>();
  for (const task of pending) {
    const events = await store.listAuditEvents({
      taskId: task.id,
      types: ["plan_admitted"],
    });
    const last = events.at(-1);
    if (last === undefined) {
      continue;
    }
    const status = last.event.data["status"];
    if (status !== "sequenced" && status !== "blocked") {
      continue;
    }
    const blockedBy = last.event.data["blockedBy"];
    if (!Array.isArray(blockedBy) || blockedBy.length === 0) {
      continue;
    }
    if (blockedBy.map(String).some((id) => active.has(id as TaskId))) {
      waiting.add(task.id);
    }
  }
  return waiting;
}

/**
 * How often running this task has been refused outright: in an unbroken run
 * ending at the most recent admission, and over the task's whole life.
 *
 * Deliberately blind to *which* task did the blocking. An earlier version
 * counted only while the blocking set stayed identical, on the reasoning that
 * a task refused by two different holders is making progress through a queue.
 * That reasoning is wrong in exactly the case this mechanism exists for: three
 * tasks contending for one function block each other in a rotating order, so
 * the blocking set changes every turn, the run resets every turn, and the
 * escalation is never reached. The loop survives the fix meant to break it.
 *
 * Escalating on a genuine queue costs nothing anyway, which is what makes the
 * blunter rule safe. Sequencing behind whoever currently holds the resource is
 * the correct answer whether that holder is the same one as last time or not —
 * it grants no permission to execute either way.
 *
 * `total` is the backstop. A task that alternates between refusals and other
 * non-approving answers never builds a consecutive run, so the unbroken count
 * alone still has a hole; the lifetime count has none, because it only ever
 * rises.
 *
 * The admission record is the source because the count has to outlive the
 * lease. The loop this exists to break releases its lease on every turn, and
 * the next turn may be a different worker entirely, so anything held in memory
 * would reset exactly when it mattered.
 */
export async function blockedAdmissionHistory(
  store: CoordinationStore,
  taskId: TaskId,
): Promise<{ consecutive: number; total: number }> {
  const events = await store.listAuditEvents({
    taskId,
    types: ["plan_admitted"],
  });
  let consecutive = 0;
  let counting = true;
  let total = 0;
  for (const entry of [...events].reverse()) {
    if (entry.event.data["status"] === "blocked") {
      total += 1;
      if (counting) {
        consecutive += 1;
      }
      continue;
    }
    counting = false;
  }
  return { consecutive, total };
}

/**
 * The plans currently executing in one repository, and the exact set of
 * leases that view was read from.
 *
 * The ids travel back into {@link CoordinationStore.saveWorkLeasePlan} so the
 * store can refuse a write whose view has since changed.
 */
async function executingPlans(
  store: CoordinationStore,
  lease: WorkLease,
): Promise<{ active: ActivePlan[]; approvedLeaseIds: string[] }> {
  const leases = await store.listWorkLeases({
    status: "active",
    repositoryId: lease.repositoryId,
  });
  const admitted = leases.filter(
    (candidate) =>
      candidate.id !== lease.id &&
      candidate.plan !== undefined &&
      planAdmissionApproved(candidate.plan.admission),
  );
  const tasks = await store.listSubmittedTasks({
    repositoryId: lease.repositoryId,
  });
  const agentFor = new Map(tasks.map((task) => [task.id, task.agentId]));
  return {
    active: admitted.map((candidate): ActivePlan => ({
      taskId: candidate.taskId,
      agentId: agentFor.get(candidate.taskId) ?? candidate.workerId,
      // Guarded by the filter above.
      plan: (candidate.plan as { plan: AgentPlan }).plan,
    })),
    approvedLeaseIds: admitted.map((candidate) => candidate.id).sort(),
  };
}

/**
 * Arbitrates a remote worker's plan before it edits anything.
 *
 * This is the remote half of what the local coordinator does between
 * `requestPlan` and `sendContext`: the plan is checked against every plan
 * currently executing in the repository, ownership is granted or withheld, and
 * only an approved answer lets the worker spend agent time. A conflict now
 * costs one planning round trip rather than a full execution that
 * exact-base integration would later throw away.
 *
 * That backstop is untouched. Admission reduces waste; it is not what makes
 * remote results safe.
 */
export async function admitWorkPlan(
  store: CoordinationStore,
  input: WorkPlanInput,
  services: WorkPlanServices = {},
): Promise<WorkPlanOutcome> {
  const repositories = services.repositories ?? new RepositoryService();
  const intelligence =
    services.intelligence ?? new CodeIntelligenceService(repositories);
  const admissions = services.admissions ?? new PlanAdmissionController();

  const now = new Date().toISOString();
  await store.expireWorkLeases(now);
  const lease = await store.getWorkLease(input.leaseId);
  if (lease === undefined) {
    throw new Error(`Unknown lease: ${input.leaseId}`);
  }
  if (lease.status !== "active" || lease.expiresAt <= now) {
    return { outcome: "lease_lost", reason: `lease is ${lease.status}` };
  }
  const task = await submittedTask(store, lease);
  if (task === undefined || task.status !== "claimed") {
    const reason = "The leased task is no longer claimed";
    await failLease(store, lease, reason, "remote_plan_validation");
    return { outcome: "rejected", reason };
  }
  if (
    lease.plan !== undefined &&
    planAdmissionApproved(lease.plan.admission)
  ) {
    // An approved admission is the execution contract. Retrying the endpoint
    // is idempotent, but no later request may widen or replace that contract.
    return { outcome: "admitted", admission: lease.plan.admission };
  }

  let submitted: AgentPlan;
  try {
    const value = structuredClone(input.plan);
    assertAgentPlan(value);
    if (value.taskId !== task.id) {
      throw new Error("Plan is for a different task");
    }
    if (value.objective.trim() !== task.objective.trim()) {
      // Strict on purpose: the objective is the task's identity, and this
      // equality is what binds a submitted plan to the leased task. A
      // conforming worker echoes the assigned objective verbatim and carries
      // the model's own phrasing in `intent`; a mismatch here means the
      // submitter is not doing that, or is submitting another task's plan.
      throw new Error(
        "Plan objective does not match the leased task. Workers must echo " +
          "the assigned objective verbatim and put the agent's own wording " +
          "in the plan's intent field",
      );
    }
    submitted = value;
  } catch (error) {
    const reason = `Invalid remote plan: ${errorMessage(error)}`;
    await failLease(store, lease, reason, "remote_plan_validation");
    return { outcome: "rejected", reason };
  }

  const storedRepository = await store.getRepository(lease.repositoryId);
  if (storedRepository === undefined) {
    const reason = `Unknown repository: ${lease.repositoryId}`;
    await failLease(store, lease, reason, "remote_plan_validation");
    return { outcome: "rejected", reason };
  }
  const repository = canonical(storedRepository);
  let baseVersion: CanonicalVersion;
  let current: CanonicalVersion;
  try {
    baseVersion = await repositories.getVersionAtRevision(
      repository,
      lease.baseRevision,
    );
    current = await repositories.getCanonicalVersion(repository);
  } catch (error) {
    // The revision this lease pinned is unreadable, so nothing can be decided
    // about a plan written against it.
    const reason = `Leased base revision is unusable: ${errorMessage(error)}`;
    await failLease(store, lease, reason, "remote_plan_validation");
    return { outcome: "rejected", reason };
  }

  // Canonical moving under a plan is the cheapest possible moment to notice:
  // the worker has planned but not edited, so requeueing costs one plan.
  if (current.revision !== baseVersion.revision) {
    await requeueForCanonicalChange(
      store,
      repositories,
      lease,
      baseVersion,
      current,
    );
    return {
      outcome: "admitted",
      admission: {
        status: "blocked",
        taskId: task.id,
        planRevision: 1,
        baseRevision: lease.baseRevision,
        ownershipGrants: [],
        constraints: ["Plan again from the current canonical revision"],
        blockedBy: [],
        conflicts: [],
        explanation:
          "Canonical advanced before this plan was submitted; the task was " +
          "requeued to replan",
        requeue: true,
        decidedAt: new Date().toISOString(),
      },
    };
  }

  // The human gate, when the project asked for one. It sits ahead of every
  // arbitration path below — including the solo fast path — because its
  // question is not "does this collide" but "should this run at all", and
  // that answer does not change with how busy the repository is.
  const gateProject =
    task.projectId === undefined
      ? undefined
      : await store.getProject(task.projectId);
  const gatePolicy = approvalPolicyForProject(gateProject?.policy);
  const gateReasons = gatePolicy.remotePlanReasons(submitted);
  let gatedRunId: string | undefined;
  if (gateReasons.length > 0) {
    const gate = await gateRemotePlan(
      store,
      lease,
      task,
      storedRepository,
      baseVersion,
      submitted,
      gateReasons,
      gateProject?.organizationId,
      gatePolicy.timeoutMs,
    );
    if (gate.outcome === "refused") {
      await failLease(store, lease, gate.reason, "remote_plan_approval");
      return { outcome: "rejected", reason: gate.reason };
    }
    if (gate.outcome === "pending") {
      const saved = await store.saveWorkLeasePlan({
        leaseId: lease.id,
        submission: { plan: submitted, admission: gate.admission },
        observedApprovedLeaseIds: (await executingPlans(store, lease))
          .approvedLeaseIds,
      });
      if (saved.outcome === "lease_lost") {
        return {
          outcome: "lease_lost",
          reason: "lease was lost while its plan awaited approval",
        };
      }
      // A "stale" write only means another lease was admitted meanwhile. The
      // approval is durable either way, and the next resubmission finds it
      // through the lease record it did manage to write, or opens a fresh
      // one. Returning the pending answer keeps the worker waiting rather
      // than sending it back to plan a task a reviewer is already looking at.
      return { outcome: "admitted", admission: gate.admission };
    }
    gatedRunId = gate.runId;
  }

  // Solo fast path: with nothing else executing in this repository there is
  // nothing to arbitrate against, and every millisecond spent indexing,
  // enriching and scoring would be spent comparing a plan with an empty set.
  // The candidate is approved on the spot. This skips the wait, not the
  // safety: the store write below is compare-and-swap on the set of admitted
  // leases, so two workers going solo at once collide there and the loser
  // falls through to full arbitration — and exact-base integration still
  // gates every result at promotion time exactly as it always has.
  {
    const solo = await executingPlans(store, lease);
    if (solo.active.length === 0) {
      // Ownership is still issued — the leases are the durable statement of
      // what this task holds, and the next arrival's arbitration reads them.
      // With no other work in the repository nothing can contest them, and a
      // plan's own declared schemas are self-approved by the same rule the
      // full path applies, so this cannot refuse a plan the full path would
      // have admitted.
      const grants = new OwnershipService().acquire(
        submitted,
        task.agentId,
        baseVersion.sequence,
        { approvedResources: approvedSchemaResources(submitted) },
      );
      const admission: PlanAdmission = {
        status: "approved",
        taskId: task.id,
        planRevision: 1,
        baseRevision: baseVersion.revision,
        ownershipGrants: grants,
        constraints: [],
        blockedBy: [],
        conflicts: [],
        explanation:
          "Approved without arbitration: no other task is executing in " +
          "this repository. Exact-base integration remains in force.",
        ...(gatedRunId === undefined ? {} : { runId: gatedRunId }),
        decidedAt: new Date().toISOString(),
      };
      const saved = await store.saveWorkLeasePlan({
        leaseId: lease.id,
        submission: { plan: submitted, admission },
        observedApprovedLeaseIds: solo.approvedLeaseIds,
      });
      if (saved.outcome === "lease_lost") {
        return {
          outcome: "lease_lost",
          reason: "lease was lost while its plan was being admitted",
        };
      }
      if (saved.outcome === "already_admitted") {
        return {
          outcome: "admitted",
          admission: saved.lease.plan!.admission,
        };
      }
      if (saved.outcome === "saved") {
        await trace(store, undefined, "plan_received", task.id, {
          projectId: task.projectId,
          repositoryId: task.repositoryId,
          workerId: lease.workerId,
          leaseId: lease.id,
          expectedFiles: submitted.expectedFiles,
          expectedSymbols: submitted.expectedSymbols,
          riskLevel: submitted.riskLevel,
          remote: true,
          solo: true,
        });
        await trace(store, undefined, "plan_admitted", task.id, {
          projectId: task.projectId,
          repositoryId: task.repositoryId,
          workerId: lease.workerId,
          leaseId: lease.id,
          status: admission.status,
          blockedBy: [],
          constraints: [],
          explanation: admission.explanation,
          solo: true,
        });
        if (grants.length > 0) {
          await trace(store, undefined, "ownership_granted", task.id, {
            projectId: task.projectId,
            repositoryId: task.repositoryId,
            leaseId: lease.id,
            leases: grants,
          });
        }
        return { outcome: "admitted", admission };
      }
      // "stale": another admission landed between the read and the write.
      // The repository is no longer solo; decide the ordinary way.
    }
  }

  const index = await intelligence.index(repository, baseVersion.revision);
  // Grounded before it is enriched: verification judges what the worker's
  // agent declared, not what the index projected onto it — and it overwrites
  // any grounding the remote side sent, because a verdict about an agent's
  // declarations is never the agent's to supply.
  const plan = intelligence.enrichPlan(groundPlan(submitted, index), index);
  assertAgentPlan(plan);
  await trace(store, undefined, "plan_received", task.id, {
    projectId: task.projectId,
    repositoryId: task.repositoryId,
    workerId: lease.workerId,
    leaseId: lease.id,
    expectedFiles: plan.expectedFiles,
    expectedSymbols: plan.expectedSymbols,
    riskLevel: plan.riskLevel,
    grounding: plan.grounding,
    remote: true,
  });

  // How often this task has already been sent away to narrow a plan it cannot
  // narrow. Read from the admission record rather than tracked in memory: the
  // count has to survive the lease being released and the task being picked up
  // by a different worker, which is precisely the path the loop takes.
  const refusals = legacyAdmissionLoop()
    ? { consecutive: 0, total: 0 }
    : await blockedAdmissionHistory(store, task.id);
  const blockedAttempts = Math.max(
    refusals.consecutive,
    // The lifetime count is scaled so it only overrides the consecutive one
    // when refusals have accumulated well past the point where narrowing was
    // ever going to work, which is the alternating case the unbroken run
    // cannot see.
    refusals.total >= BLOCKED_ADMISSION_LIFETIME_CAP
      ? BLOCKED_ATTEMPTS_BEFORE_SEQUENCING
      : 0,
  );

  for (let attempt = 1; attempt <= MAX_ADMISSION_ATTEMPTS; attempt += 1) {
    const executing = await executingPlans(store, lease);
    // A plan admitted through the solo fast path was stored as declared —
    // nothing existed to arbitrate it against, so nothing enriched it. This
    // candidate is that something. Enrichment and grounding are deterministic
    // functions of plan and index, so computing them now yields exactly what
    // full admission would have stored, and the comparison loses nothing to
    // the fast path having skipped it.
    const active = executing.active.map((entry) =>
      entry.plan.grounding === undefined
        ? {
            ...entry,
            plan: intelligence.enrichPlan(
              groundPlan(entry.plan, index),
              index,
            ),
          }
        : entry,
    );
    const decided = admissions.admit({
      plan,
      agentId: task.agentId,
      baseRevision: baseVersion.revision,
      baseVersion: baseVersion.sequence,
      active,
      // A task that already exists because an earlier admission was partial is
      // decided whole. One split per lineage is what stops a task from shedding
      // scope round after round, each round paying for another agent run.
      partialAdmission: !isDeferredScopeFollowUp(task.objective),
      // The same index that enriched this plan is what can say which of the
      // enriched claims came from which file, so a withheld file takes its own
      // symbols with it instead of leaving them to block the remainder.
      resourcesInFile: (file) => intelligence.resourcesInFile(index, file),
      // And where those symbols live, so one can be withheld while the file
      // holding it is granted — the index is built at the base revision, which
      // is the coordinate system a diff hunk's old side is measured in.
      symbolRangesInFile: (file) =>
        intelligence.symbolRangesInFile(index, file),
      blockedAttempts,
    });
    // A gated plan already opened its run to hang the approval off. Carrying
    // that id forward is what keeps the result path from opening a second one
    // and splitting one task's history across two records.
    const admission: PlanAdmission =
      gatedRunId === undefined ? decided : { ...decided, runId: gatedRunId };
    // What is recorded against the lease is what was actually granted. On a
    // partial admission that is the reduced plan, and recording the whole one
    // would be a lie with consequences: this record is the view every later
    // admission arbitrates against, so it would hold resources for this task
    // that this task was refused.
    const admittedPlan = planAdmissionPartial(admission)
      ? reducePlanScope(plan, admission.deferredResources ?? [])
      : plan;
    const saved = await store.saveWorkLeasePlan({
      leaseId: lease.id,
      submission: { plan: admittedPlan, admission },
      observedApprovedLeaseIds: executing.approvedLeaseIds,
    });
    if (saved.outcome === "lease_lost") {
      return {
        outcome: "lease_lost",
        reason: "lease was lost while its plan was being admitted",
      };
    }
    if (saved.outcome === "stale") {
      // Another worker was admitted between the read and the write. Its plan
      // is now part of the executing set, so decide again against it.
      continue;
    }
    if (saved.outcome === "already_admitted") {
      // A concurrent request for this lease committed first. Return the
      // durable contract rather than the answer computed from a stale view.
      return {
        outcome: "admitted",
        admission: saved.lease.plan!.admission,
      };
    }

    for (const assessment of admission.conflicts) {
      await trace(store, undefined, "conflict_detected", task.id, {
        projectId: task.projectId,
        repositoryId: task.repositoryId,
        taskIds: assessment.taskIds,
        score: assessment.score,
        disposition: assessment.disposition,
        evidence: assessment.evidence,
        stage: "remote_plan_admission",
      });
    }
    await trace(store, undefined, "plan_admitted", task.id, {
      projectId: task.projectId,
      repositoryId: task.repositoryId,
      workerId: lease.workerId,
      leaseId: lease.id,
      status: admission.status,
      blockedBy: admission.blockedBy,
      constraints: admission.constraints,
      explanation: admission.explanation,
      ...(planAdmissionPartial(admission)
        ? {
            partial: true,
            grantedFiles: admittedPlan.expectedFiles,
            deferredResources: admission.deferredResources,
          }
        : {}),
    });
    if (admission.ownershipGrants.length > 0) {
      await trace(store, undefined, "ownership_granted", task.id, {
        projectId: task.projectId,
        repositoryId: task.repositoryId,
        leaseId: lease.id,
        leases: admission.ownershipGrants,
      });
    }
    return { outcome: "admitted", admission };
  }

  // Repeated contention is not an error, it is a busy repository. Tell the
  // worker to wait rather than failing a task that is perfectly valid.
  return {
    outcome: "admitted",
    admission: {
      status: "sequenced",
      taskId: task.id,
      planRevision: 1,
      baseRevision: baseVersion.revision,
      ownershipGrants: [],
      constraints: ["Resubmit the same plan after the retry interval"],
      blockedBy: [],
      conflicts: [],
      explanation:
        "Plan admission is contended in this repository; resubmit shortly",
      retryAfterMs: DEFAULT_PLAN_RETRY_MS,
      decidedAt: new Date().toISOString(),
    },
  };
}

export interface WorkScopeInput {
  leaseId: string;
  actorId: string;
  request: unknown;
}

export type WorkScopeOutcome =
  /** The coordinator answered; `decision.decision` says what the agent may do. */
  | { outcome: "decided"; decision: ScopeChangeDecision }
  /** The submission was unusable; the lease and task are failed. */
  | { outcome: "rejected"; reason: string }
  /** The lease lapsed or was settled; stop work and re-lease. */
  | { outcome: "lease_lost"; reason: string };

/** Reads one string array off an untrusted request body. */
function scopeList(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value as string[];
}

function parseScopeRequest(
  value: unknown,
  taskId: string,
): ScopeChangeRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Scope change request must be an object");
  }
  const body = value as Record<string, unknown>;
  const reason =
    typeof body["reason"] === "string" ? body["reason"].trim() : "";
  const request: ScopeChangeRequest = {
    id:
      typeof body["id"] === "string" && body["id"].trim().length > 0
        ? body["id"].trim().slice(0, 200)
        : createId("scope"),
    taskId,
    additionalFiles: uniqueRepositoryPaths(
      scopeList(body["additionalFiles"], "additionalFiles").map(
        normalizeRepositoryPath,
      ),
    ),
    additionalSymbols: uniqueStrings(
      scopeList(body["additionalSymbols"], "additionalSymbols"),
    ),
    additionalApis: uniqueStrings(
      scopeList(body["additionalApis"], "additionalApis"),
    ),
    additionalSchemas: uniqueStrings(
      scopeList(body["additionalSchemas"], "additionalSchemas"),
    ),
    additionalConfigKeys: uniqueStrings(
      scopeList(body["additionalConfigKeys"], "additionalConfigKeys"),
    ),
    additionalTests: uniqueStrings(
      scopeList(body["additionalTests"], "additionalTests"),
    ),
    additionalServices: uniqueStrings(
      scopeList(body["additionalServices"], "additionalServices"),
    ),
    reason,
    occurredAt:
      typeof body["occurredAt"] === "string"
        ? body["occurredAt"]
        : new Date().toISOString(),
  };
  const named =
    request.additionalFiles.length +
    request.additionalSymbols.length +
    request.additionalApis.length +
    request.additionalSchemas.length +
    request.additionalConfigKeys.length +
    request.additionalTests.length +
    request.additionalServices.length;
  if (named === 0 || reason.length === 0) {
    throw new Error(
      "Scope expansion must name at least one resource and explain why",
    );
  }
  return request;
}

/**
 * Arbitrates a scope expansion an agent asked for while it was already running.
 *
 * The local coordinator has always answered this question properly: it merges
 * the request into the plan, verifies the result against the repository,
 * assesses it against everything else in the wave, and grants ownership when
 * nothing collides. Remotely the answer was a flat refusal, for a defensible
 * but temporary reason — the expanded scope had never been admitted and no
 * other holder had been given a chance to object.
 *
 * This gives the remote path the same answer through the same machinery. The
 * revised plan goes through the same {@link PlanAdmissionController} an
 * initial admission uses, against the plans on every other active lease, so a
 * grant means the widened scope was arbitrated exactly as the original was.
 * Three outcomes are possible instead of one:
 *
 * - **granted** when nothing else holds the resources. The admitted contract
 *   on the lease is replaced with the revised plan, which is what lets the
 *   result carry patches on the new files without being refused as a scope
 *   escape.
 * - **deferred** when another executing task holds them. Nothing is refused
 *   permanently: the holder is named, a retry interval is returned, and the
 *   agent carries on inside its current scope in the meantime.
 * - **refused** when ordering cannot separate the two, or when a reviewer
 *   said no to a request the project's policy gated.
 *
 * Nothing about result enforcement is relaxed. A grant widens the contract
 * *before* the edits arrive, so the changeset is still split and checked
 * against a contract the control plane issued, and a patch outside it is
 * still refused.
 */
export async function arbitrateScopeChange(
  store: CoordinationStore,
  input: WorkScopeInput,
  services: WorkPlanServices = {},
): Promise<WorkScopeOutcome> {
  const repositories = services.repositories ?? new RepositoryService();
  const intelligence =
    services.intelligence ?? new CodeIntelligenceService(repositories);
  const admissions = services.admissions ?? new PlanAdmissionController();

  const now = new Date().toISOString();
  await store.expireWorkLeases(now);
  const lease = await store.getWorkLease(input.leaseId);
  if (lease === undefined) {
    throw new Error(`Unknown lease: ${input.leaseId}`);
  }
  if (lease.status !== "active" || lease.expiresAt <= now) {
    return { outcome: "lease_lost", reason: `lease is ${lease.status}` };
  }
  const task = await submittedTask(store, lease);
  if (task === undefined || task.status !== "claimed") {
    const reason = "The leased task is no longer claimed";
    await failLease(store, lease, reason, "remote_scope_validation");
    return { outcome: "rejected", reason };
  }
  const admitted = lease.plan;
  if (admitted === undefined || !planAdmissionApproved(admitted.admission)) {
    // Nothing to widen. An agent that has not been admitted is not executing,
    // so a scope request from it is a protocol error rather than a decision.
    const reason =
      "Scope expansion requires an approved admission; submit and get a plan " +
      "admitted before asking to widen it";
    await failLease(store, lease, reason, "remote_scope_validation");
    return { outcome: "rejected", reason };
  }

  let request: ScopeChangeRequest;
  try {
    request = parseScopeRequest(input.request, task.id);
  } catch (error) {
    // Not fatal to the lease: the agent is mid-run and doing useful work
    // inside a scope it already owns. A malformed ask is refused, and the
    // run continues.
    return {
      outcome: "decided",
      decision: {
        requestId: createId("scope"),
        taskId: task.id,
        decision: "rejected",
        revisedPlan: admitted.plan,
        constraints: ["Continue within the admitted plan"],
        ownershipGrants: [],
        explanation: errorMessage(error),
        decidedAt: new Date().toISOString(),
      },
    };
  }

  const storedRepository = await store.getRepository(lease.repositoryId);
  if (storedRepository === undefined) {
    const reason = `Unknown repository: ${lease.repositoryId}`;
    await failLease(store, lease, reason, "remote_scope_validation");
    return { outcome: "rejected", reason };
  }
  const repository = canonical(storedRepository);
  let baseVersion: CanonicalVersion;
  try {
    baseVersion = await repositories.getVersionAtRevision(
      repository,
      lease.baseRevision,
    );
  } catch (error) {
    const reason = `Leased base revision is unusable: ${errorMessage(error)}`;
    await failLease(store, lease, reason, "remote_scope_validation");
    return { outcome: "rejected", reason };
  }

  const runId = admitted.admission.runId;
  await trace(store, runId, "scope_change_requested", task.id, {
    projectId: task.projectId,
    repositoryId: task.repositoryId,
    workerId: lease.workerId,
    leaseId: lease.id,
    request,
    remote: true,
  });
  if (runId !== undefined) {
    await store.saveScopeChange(runId, request).catch(() => undefined);
  }

  const refuse = (
    explanation: string,
    blockedBy: readonly string[] = [],
  ): ScopeChangeDecision => ({
    requestId: request.id,
    taskId: task.id,
    decision: "rejected",
    revisedPlan: admitted.plan,
    constraints: ["Continue within the admitted plan"],
    ownershipGrants: [],
    ...(blockedBy.length === 0 ? {} : { blockedBy: [...blockedBy] }),
    explanation,
    decidedAt: new Date().toISOString(),
  });

  const record = async (
    decision: ScopeChangeDecision,
  ): Promise<WorkScopeOutcome> => {
    if (runId !== undefined) {
      await store
        .saveScopeChangeDecision(runId, decision)
        .catch(() => undefined);
    }
    await trace(store, runId, "scope_change_decided", task.id, {
      projectId: task.projectId,
      repositoryId: task.repositoryId,
      workerId: lease.workerId,
      leaseId: lease.id,
      decision,
      remote: true,
    });
    return { outcome: "decided", decision };
  };

  // A mid-run expansion is where an agent is most likely to name what it
  // merely believes exists, so the revised plan is verified against the
  // repository exactly as the original was. Enrichment then gives it the
  // derived claims arbitration compares on.
  const index = await intelligence.index(repository, baseVersion.revision);
  const revisedPlan = intelligence.enrichPlan(
    groundPlan(mergePlanScope(admitted.plan, request), index),
    index,
  );

  const executing = await executingPlans(store, lease);
  const active = executing.active.map((entry) =>
    entry.plan.grounding === undefined
      ? {
          ...entry,
          plan: intelligence.enrichPlan(groundPlan(entry.plan, index), index),
        }
      : entry,
  );
  const admission = admissions.admit({
    plan: revisedPlan,
    agentId: task.agentId,
    baseRevision: baseVersion.revision,
    baseVersion: baseVersion.sequence,
    active,
    // All or nothing. A partial answer here would tell an agent already
    // mid-edit that it has some of what it asked for, and the reason partial
    // admission is safe — it happens before any editing, where a reduced
    // scope can still shape the whole run — does not hold at this point.
    partialAdmission: false,
  });

  if (!planAdmissionApproved(admission)) {
    if (admission.status === "sequenced") {
      return await record({
        requestId: request.id,
        taskId: task.id,
        decision: "deferred",
        revisedPlan: admitted.plan,
        constraints: [
          "Keep working inside the admitted plan; ask again after the retry " +
            "interval if the expansion is still needed",
        ],
        ownershipGrants: [],
        blockedBy: [...admission.blockedBy],
        retryAfterMs: admission.retryAfterMs ?? DEFAULT_PLAN_RETRY_MS,
        explanation: `Scope expansion is held by executing work: ${admission.explanation}`,
        decidedAt: new Date().toISOString(),
      });
    }
    return await record(
      refuse(
        `Scope expansion cannot be granted: ${admission.explanation}`,
        admission.blockedBy,
      ),
    );
  }

  // Ownership says yes; the project's policy may still want a person. This
  // blocks the request the same way the changeset gate blocks a result, and
  // the worker's client allows for that.
  const project =
    task.projectId === undefined
      ? undefined
      : await store.getProject(task.projectId);
  const approvalPolicy = approvalPolicyForProject(project?.policy);
  const reasons = approvalPolicy.scopeReasons(revisedPlan, request);
  if (reasons.length > 0) {
    if (runId === undefined) {
      // An approval has to belong to a run, and an ungated task has none
      // until its result arrives. Refusing is the conservative answer: the
      // expansion needed a reviewer and could not get one.
      return await record(
        refuse(
          "Scope expansion requires human approval, but this task has no run " +
            "to record the request against. Enable requireRemotePlanReview " +
            `for this project to gate it: ${reasons.join("; ")}`,
        ),
      );
    }
    const review = await new StoreApprovalController(
      store,
      approvalPolicy.timeoutMs,
    ).review({
      ...(project === undefined
        ? {}
        : { organizationId: project.organizationId }),
      ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
      repositoryId: task.repositoryId,
      runId,
      taskId: task.id,
      kind: "scope_change",
      requestedBy: task.agentId,
      reasons,
      scopeChangeId: request.id,
      onRequested: async (created) => {
        await trace(store, runId, "approval_requested", task.id, {
          projectId: task.projectId,
          approvalId: created.id,
          kind: created.kind,
          reasons: created.reasons,
          expiresAt: created.expiresAt,
          stage: "remote_scope_change",
        });
      },
    });
    await trace(store, runId, "approval_decided", task.id, {
      projectId: task.projectId,
      approvalId: review.request.id,
      status: review.request.status,
      decidedBy: review.request.decidedBy,
      stage: "remote_scope_change",
    });
    if (!review.approved) {
      return await record(
        refuse(
          `Scope expansion was not approved: ${review.explanation}`,
        ),
      );
    }
  }

  // The widened contract replaces the narrower one. This is the only write
  // that may do so, and it carries the same staleness check every admission
  // does, so a rival admitted between the read and the write invalidates it.
  const widened: PlanAdmission = {
    ...admission,
    ...(runId === undefined ? {} : { runId }),
  };
  const saved = await store.saveWorkLeasePlan({
    leaseId: lease.id,
    submission: { plan: revisedPlan, admission: widened },
    observedApprovedLeaseIds: executing.approvedLeaseIds,
    replaceApproved: true,
  });
  if (saved.outcome === "lease_lost") {
    return {
      outcome: "lease_lost",
      reason: "lease was lost while the expansion was being decided",
    };
  }
  if (saved.outcome !== "saved") {
    // Another lease was admitted while this was being decided, so the answer
    // was computed against a view that no longer holds. Deferring rather than
    // refusing is right: asking again re-decides against the new view.
    return await record({
      requestId: request.id,
      taskId: task.id,
      decision: "deferred",
      revisedPlan: admitted.plan,
      constraints: ["Ask again; another plan was admitted while deciding"],
      ownershipGrants: [],
      retryAfterMs: DEFAULT_PLAN_RETRY_MS,
      explanation:
        "Another plan was admitted in this repository while the expansion " +
        "was being arbitrated, so the decision was made against a stale view",
      decidedAt: new Date().toISOString(),
    });
  }

  if (admission.ownershipGrants.length > 0) {
    await trace(store, runId, "ownership_granted", task.id, {
      projectId: task.projectId,
      repositoryId: task.repositoryId,
      leaseId: lease.id,
      leases: admission.ownershipGrants,
      stage: "remote_scope_change",
    });
  }
  return await record({
    requestId: request.id,
    taskId: task.id,
    decision:
      admission.status === "approved" && reasons.length === 0
        ? "approved"
        : "approved_with_constraints",
    revisedPlan,
    constraints: [
      ...admission.constraints,
      ...(reasons.length === 0
        ? []
        : ["Scope expansion received required human approval"]),
    ],
    ownershipGrants: admission.ownershipGrants,
    explanation:
      "Scope expansion was arbitrated against executing work and granted; " +
      "the admitted plan now covers it",
    decidedAt: new Date().toISOString(),
  });
}

/**
 * Resources a result claims that its admitted plan never covered.
 *
 * The admitted plan is the contract ownership was granted against, so a
 * result that widened its own scope is refused rather than re-arbitrated:
 * by then the edits already exist and no other holder had a chance to object.
 *
 * A deferred resource is not a widening. The worker reports the plan it
 * submitted, and under a partial admission that plan legitimately names more
 * than was granted — the coordinator is the one that narrowed it. Declaring a
 * deferred file is allowed; the changeset touching it is a separate question,
 * answered by {@link splitChangeSet}, which never lets it reach canonical.
 */
function planScopeEscapes(
  admitted: AgentPlan,
  reported: AgentPlan,
  deferred: readonly DeferredResource[] = [],
): string[] {
  const withheld = (type: ResourceType): string[] =>
    deferred
      .filter((resource) => resource.resourceType === type)
      .map((resource) => resource.resourceId);
  const escapes: string[] = [];
  const compare = (
    kind: ResourceType,
    allowedValues: readonly string[],
    reportedValues: readonly string[] | undefined,
    normalize: (value: string) => string = (value) => value,
  ): void => {
    const allowed = new Set(
      [...allowedValues, ...withheld(kind)].map((value) =>
        normalize(value).toLowerCase(),
      ),
    );
    for (const value of reportedValues ?? []) {
      if (!allowed.has(normalize(value).toLowerCase())) {
        escapes.push(`${kind}:${value}`);
      }
    }
  };
  compare(
    "file",
    admitted.expectedFiles,
    reported.expectedFiles,
    normalizeRepositoryPath,
  );
  compare("symbol", admitted.expectedSymbols, reported.expectedSymbols);
  compare("api", admitted.expectedApis ?? [], reported.expectedApis);
  compare("schema", admitted.expectedSchemas ?? [], reported.expectedSchemas);
  compare(
    "configuration",
    admitted.expectedConfigKeys ?? [],
    reported.expectedConfigKeys,
  );
  compare("test", admitted.expectedTests ?? [], reported.expectedTests);
  compare("service", admitted.expectedServices ?? [], reported.expectedServices);
  if (reported.riskLevel !== admitted.riskLevel) {
    escapes.push(`riskLevel:${reported.riskLevel}`);
  }
  return escapes;
}

/**
 * Validates and transactionally integrates a remote worker result.
 *
 * The lease is settled before Git promotion, making duplicate result posts
 * harmless. Exact-base integration and stale requeueing provide the remote
 * equivalent of dynamic replanning when canonical advances.
 */
export async function acceptWorkResult(
  store: CoordinationStore,
  input: WorkResultInput,
  services: WorkResultServices = {},
): Promise<WorkResultAcceptance> {
  const repositories = services.repositories ?? new RepositoryService();
  const integrations =
    services.integrations ?? new IntegrationService(repositories);
  const intelligence =
    services.intelligence ?? new CodeIntelligenceService(repositories);
  const leaseAtStart = await store.getWorkLease(input.leaseId);
  if (leaseAtStart === undefined) {
    throw new Error(`Unknown lease: ${input.leaseId}`);
  }
  if (leaseAtStart.status === "failed") {
    return input.status === "failed"
      ? { accepted: true }
      : { accepted: false, reason: "lease is failed" };
  }
  if (leaseAtStart.status === "completed") {
    const completedTask = await submittedTask(store, leaseAtStart);
    if (completedTask?.status === "integrated") {
      return {
        accepted: true,
        ...(completedTask.runId === undefined
          ? {}
          : { runId: completedTask.runId }),
        integrationStatus: "integrated",
      };
    }
    if (completedTask?.status === "failed") {
      const detail =
        completedTask.runId === undefined
          ? undefined
          : await store.getRun(completedTask.runId);
      const integration = detail?.integrations.at(-1);
      return {
        accepted: false,
        reason: integration?.explanation ?? "Remote integration failed",
        ...(completedTask.runId === undefined
          ? {}
          : { runId: completedTask.runId }),
        ...(integration === undefined
          ? {}
          : { integrationStatus: integration.status }),
      };
    }
    if (completedTask?.status === "submitted") {
      return {
        accepted: false,
        reason: "Canonical changed; the task was requeued to replan",
        requeued: true,
      };
    }
    return {
      accepted: false,
      reason: "Remote result is still being integrated",
    };
  }
  const now = new Date().toISOString();
  if (
    leaseAtStart.status !== "active" ||
    leaseAtStart.expiresAt <= now
  ) {
    await store.expireWorkLeases(now);
    const current = await store.getWorkLease(input.leaseId);
    return {
      accepted: false,
      reason: `lease is ${current?.status ?? leaseAtStart.status}`,
    };
  }
  const task = await submittedTask(store, leaseAtStart);
  if (task === undefined || task.status !== "claimed") {
    return await rejectWorkerResult(
      store,
      leaseAtStart,
      "The leased task is no longer claimed",
    );
  }

  if (input.status === "failed") {
    const settled = await store.finishWorkLease(
      input.leaseId,
      "failed",
      now,
      input.detail ?? "worker reported failure",
    );
    if (!settled) {
      await store.expireWorkLeases(now);
      return { accepted: false, reason: "lease was lost before failure report" };
    }
    await store.completeSubmittedTask(task.id, "failed");
    await trace(store, undefined, "task_failed", task.id, {
      projectId: task.projectId,
      repositoryId: task.repositoryId,
      workerId: leaseAtStart.workerId,
      leaseId: leaseAtStart.id,
      detail: input.detail ?? "worker reported failure",
    });
    return { accepted: true };
  }

  // Plan-first: a result is only meaningful against a plan this control plane
  // admitted. Without one, no other holder ever had the chance to object to
  // this worker's scope, which is the whole point of admission.
  const admitted = leaseAtStart.plan;
  if (admitted === undefined || !planAdmissionApproved(admitted.admission)) {
    return await rejectWorkerResult(
      store,
      leaseAtStart,
      admitted === undefined
        ? "Remote results require an admitted plan; submit the plan to the " +
          "lease's plan endpoint before executing"
        : `Remote plan was ${admitted.admission.status}, not approved for execution`,
    );
  }

  let rawPlan: AgentPlan;
  let changeSet: ChangeSet;
  try {
    const planValue = structuredClone(input.plan);
    const changeSetValue = structuredClone(input.changeSet);
    assertAgentPlan(planValue);
    assertChangeSet(changeSetValue);
    rawPlan = planValue;
    changeSet = changeSetValue;
  } catch (error) {
    return await rejectWorkerResult(
      store,
      leaseAtStart,
      `Invalid remote result: ${errorMessage(error)}`,
    );
  }

  const storedRepository = await store.getRepository(task.repositoryId);
  if (storedRepository === undefined) {
    return await rejectWorkerResult(
      store,
      leaseAtStart,
      `Unknown repository: ${task.repositoryId}`,
    );
  }
  const repository = canonical(storedRepository);
  let baseVersion: CanonicalVersion;
  // The enriched plan the coordinator admitted, not the one the worker chose
  // to report: ownership was granted against the former, so that is what the
  // changeset is held to. Under a partial admission this is already the
  // reduced plan, which is exactly the point — the contract is what was
  // granted, not what was asked for.
  const plan = admitted.plan;
  const deferred = deferredFilePaths(admitted.admission);
  // Only needed when the admission withheld something finer than a file, and
  // then it must be the *base* revision's index: a hunk's old side is measured
  // against the revision the agent started from, not the one it is landing on.
  const withheldSymbols = (admitted.admission.deferredResources ?? []).some(
    (resource) => resource.resourceType === "symbol",
  );
  const baseIndex = withheldSymbols
    ? await intelligence.index(repository, leaseAtStart.baseRevision)
    : undefined;
  let split: ReturnType<typeof splitChangeSet>;
  try {
    baseVersion = await repositories.getVersionAtRevision(
      repository,
      leaseAtStart.baseRevision,
    );
    if (
      rawPlan.taskId !== task.id ||
      rawPlan.objective.trim() !== task.objective.trim() ||
      changeSet.taskId !== task.id
    ) {
      throw new Error("Plan or changeset is for a different task");
    }
    const escapes = planScopeEscapes(
      plan,
      rawPlan,
      admitted.admission.deferredResources ?? [],
    );
    if (escapes.length > 0) {
      throw new Error(
        `Reported plan claims resources the admitted plan did not cover: ${escapes.join(", ")}`,
      );
    }
    if (
      changeSet.baseRevision !== leaseAtStart.baseRevision ||
      changeSet.baseVersion !== baseVersion.sequence
    ) {
      throw new Error(
        "Changeset base does not match the canonical version assigned by the lease",
      );
    }
    if (changeSet.riskAssessment.level !== plan.riskLevel) {
      throw new Error("Plan and changeset disagree about risk level");
    }
    split = splitChangeSet(
      plan,
      admitted.admission,
      changeSet,
      baseIndex === undefined
        ? undefined
        : (file) => intelligence.symbolRangesInFile(baseIndex, file),
    );
    // A file in neither bucket was never arbitrated at all, which is the
    // scope escape the validator has always refused.
    if (split.escaped.length > 0) {
      throw new ScopeExpansionError(split.escaped);
    }
    assertChangeSetWithinPlan(plan, split.granted);
  } catch (error) {
    return await rejectWorkerResult(
      store,
      leaseAtStart,
      `Remote result failed coordination policy: ${errorMessage(error)}`,
    );
  }

  // The agent spent its whole run inside the part it did not own. Nothing can
  // be promoted, but nothing is wrong with the task either, so it goes back to
  // the queue rather than being failed — the same treatment a stale base gets.
  if (split.granted.patches.length === 0 && split.deferred.length > 0) {
    return await requeueForDeferredScope(store, leaseAtStart, task, split);
  }

  const promoted = split.granted;

  // Canonical moving under a finished result used to end it. It still does
  // when the advance touched anything this result depends on; when it did not,
  // the result is replayed onto the newer revision instead of a whole agent
  // run being spent again to rediscover the same change.
  const replay = async (current: CanonicalVersion) =>
    assessReplay(
      plan,
      promoted,
      await canonicalAdvance(
        repositories,
        intelligence,
        repository,
        baseVersion,
        current,
      ),
    );

  // Semantic blockers end the replay question: the advance invalidated what
  // this result knows, and only a replan refreshes that. Purely textual
  // blockers — both sides wrote the same file, nothing finer contested — go
  // through to integration, whose three-way apply merges disjoint hunks for
  // free and reports a real conflict otherwise. The paid replan becomes the
  // fallback instead of the default.
  const currentBeforeRun = await repositories.getCanonicalVersion(repository);
  if (
    currentBeforeRun.revision !== baseVersion.revision &&
    (await replay(currentBeforeRun)).semantic.length > 0
  ) {
    return await requeueForCanonicalChange(
      store,
      repositories,
      leaseAtStart,
      baseVersion,
      currentBeforeRun,
    );
  }

  const taskDefinition: TaskDefinition = {
    id: task.id,
    objective: task.objective,
    agentId: task.agentId,
    validationCommands: task.validationCommands,
    ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
  };
  // A plan gated at admission time already has a run: the approval it waited
  // on had to belong to one. Reusing it keeps the reviewer's decision and the
  // integration it authorised in the same history.
  const run =
    admitted.admission.runId === undefined
      ? await store.createRun({
          repository: storedRepository,
          ...(task.projectId === undefined
            ? {}
            : { projectId: task.projectId }),
          mode: "coordinated",
          scenario: "remote-worker",
          baseVersion,
        })
      : { id: admitted.admission.runId };
  let runFinished = false;
  let followUp: string | undefined;
  try {
    await store.saveTask(run.id, taskDefinition);
    await store.saveTaskStatus(run.id, task.id, "planning");
    await store.savePlan(run.id, task.id, plan);
    await store.savePlanRevision(run.id, task.id, {
      revision: admitted.admission.planRevision,
      reason: "initial",
      canonicalRevision: baseVersion.revision,
      plan,
    });
    // The grants the plan was admitted under belong in the run record, so the
    // history shows what this task was allowed to own, not just what it wrote.
    await store.saveLeases(run.id, admitted.admission.ownershipGrants);
    // The promoted changeset is the granted half. Recording the agent's whole
    // output here would put patches in the run history that this run never
    // applied, which is the kind of record that misleads exactly when someone
    // is trying to work out what happened.
    await store.saveChangeSet(run.id, promoted);
    await trace(store, run.id, "plan_received", task.id, {
      projectId: task.projectId,
      repositoryId: task.repositoryId,
      workerId: leaseAtStart.workerId,
      leaseId: leaseAtStart.id,
      expectedFiles: plan.expectedFiles,
      riskLevel: plan.riskLevel,
    });
    await trace(store, run.id, "changeset_collected", task.id, {
      projectId: task.projectId,
      repositoryId: task.repositoryId,
      workerId: leaseAtStart.workerId,
      leaseId: leaseAtStart.id,
      changeSetId: promoted.id,
      files: promoted.patches.map((patch) => patch.path),
      ...(split.deferred.length === 0
        ? {}
        : {
            reportedChangeSetId: changeSet.id,
            withheldFiles: split.deferred.map((patch) => patch.path).sort(),
            withheldReason:
              "patches on resources this task was not granted; the work is " +
              "requeued as a follow-up task rather than applied",
            ...(Object.keys(split.withheldSymbols).length === 0
              ? {}
              : { withheldSymbols: split.withheldSymbols }),
            // Recorded separately from the withheld list because it is the
            // opposite fact: these files were *not* lost whole, and the run
            // record should say how much of each survived.
            ...(split.divided.length === 0
              ? {}
              : { dividedPatches: split.divided }),
          }),
    });

    // The task's project decides how strict review is; a project without a
    // stored policy uses the built-in defaults.
    const project =
      task.projectId === undefined
        ? undefined
        : await store.getProject(task.projectId);
    const approvalPolicy = approvalPolicyForProject(project?.policy);
    const reviewReasons = approvalPolicy.changesetReasons(plan, promoted);
    const decision: CoordinatorDecision = {
      decision:
        reviewReasons.length === 0 && admitted.admission.constraints.length === 0
          ? "approved"
          : "approved_with_constraints",
      taskId: task.id,
      planRevision: admitted.admission.planRevision,
      ownershipGrants: admitted.admission.ownershipGrants,
      constraints: [
        ...admitted.admission.constraints,
        ...(reviewReasons.length === 0
          ? ["Remote changeset must pass exact-base control-plane validation"]
          : ["Remote changeset received required human approval"]),
      ],
      blockedBy: [],
      explanation:
        "Plan was admitted before execution; task identity, base revision, " +
        "and file scope were verified against it",
    };
    if (reviewReasons.length > 0) {
      await store.saveTaskStatus(
        run.id,
        task.id,
        "awaiting_approval",
        reviewReasons.join("; "),
      );
      const review = await new StoreApprovalController(
        store,
        approvalPolicy.timeoutMs,
      ).review({
        ...(project === undefined
          ? {}
          : { organizationId: project.organizationId }),
        ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
        repositoryId: task.repositoryId,
        runId: run.id,
        taskId: task.id,
        kind: "changeset",
        requestedBy: task.agentId,
        reasons: reviewReasons,
        changeSetId: promoted.id,
        onRequested: async (request) => {
          await trace(store, run.id, "approval_requested", task.id, {
            projectId: task.projectId,
            approvalId: request.id,
            reasons: request.reasons,
            expiresAt: request.expiresAt,
          });
        },
      });
      await trace(store, run.id, "approval_decided", task.id, {
        projectId: task.projectId,
        approvalId: review.request.id,
        status: review.request.status,
        decidedBy: review.request.decidedBy,
        explanation: review.explanation,
      });
      if (!review.approved) {
        throw new Error(
          `Human approval ${review.request.id} was not granted: ${review.explanation}`,
        );
      }
    }
    await store.saveDecision(run.id, decision);
    await store.saveTaskStatus(run.id, task.id, "approved");

    const currentBeforeIntegration =
      await repositories.getCanonicalVersion(repository);
    // The newest advance this result has been graded against. Every revision
    // the result is allowed to land on has passed through `pinReplayOnto`.
    let assessedAgainst = currentBeforeIntegration;
    let replayableOnto: string | undefined;
    let textualMergeAttempt = false;
    /**
     * Grade one canonical advance and, if it clears, permit landing on it.
     *
     * The whole replay decision lives here so that it cannot drift between the
     * two moments it is asked: once before integrating, and again if the
     * integration lost a race to an advance that completed in between. Same
     * function, same grading, same conservative default — a semantic blocker
     * answers false and the caller pays for a replan.
     */
    const pinReplayOnto = async (
      current: CanonicalVersion,
      /** True when the advance beat this result to canonical rather than
       * preceding it, which changes only what the audit trail says. */
      afterLosingRace: boolean,
    ): Promise<boolean> => {
      const blockers = await replay(current);
      if (blockers.semantic.length > 0) {
        return false;
      }
      // Pinned to this exact revision. If canonical moves once more before the
      // integration reads it, the permission no longer matches and the result
      // is refused as stale, exactly as it was before replay existed.
      assessedAgainst = current;
      replayableOnto = current.revision;
      textualMergeAttempt = blockers.textual.length > 0;
      await trace(store, run.id, "canonical_changed", task.id, {
        projectId: task.projectId,
        repositoryId: task.repositoryId,
        previousRevision: baseVersion.revision,
        revision: current.revision,
        workerId: leaseAtStart.workerId,
        leaseId: leaseAtStart.id,
        replayed: true,
        ...(afterLosingRace ? { afterLosingRace: true } : {}),
        ...(textualMergeAttempt
          ? { textualBlockers: blockers.textual }
          : {}),
        explanation: textualMergeAttempt
          ? "Canonical advanced into files this result also writes, but " +
            "nothing it depends on; attempting a free three-way merge before " +
            "paying for a replan"
          : "Canonical advanced without touching anything this result depends " +
            "on, so the result was replayed rather than requeued",
      });
      return true;
    };
    if (currentBeforeIntegration.revision !== baseVersion.revision) {
      if (!(await pinReplayOnto(currentBeforeIntegration, false))) {
        return await requeueForCanonicalChange(
          store,
          repositories,
          leaseAtStart,
          baseVersion,
          currentBeforeIntegration,
          run.id,
        );
      }
    }
    const settled = await store.finishWorkLease(
      input.leaseId,
      "completed",
      new Date().toISOString(),
      input.detail ?? "remote changeset accepted for integration",
    );
    if (!settled) {
      await store.expireWorkLeases(new Date().toISOString());
      throw new Error("Lease was lost before integration");
    }

    const integrationRoot =
      services.integrationRoot ?? path.resolve(".coordinator", "integration");
    await mkdir(integrationRoot, { recursive: true });
    await store.saveTaskStatus(run.id, task.id, "validating");
    // Staleness is the one integration outcome that is not a fact about this
    // result: it says another task reached canonical first, which is exactly
    // the advance the replay question exists to grade. Asked only before
    // integrating, the question misses every result that loses that race — and
    // near-simultaneous finishes are the normal case, not the rare one. So it
    // is asked again, against the advance that beat us, now that the advance
    // has completed and can be read.
    //
    // Nothing about the answer is relaxed to do this: it is the same
    // `pinReplayOnto`, so a semantic blocker still requeues unconditionally,
    // and the retry is still pinned to one exact revision. Only the moment the
    // question may be asked has widened.
    let integration: IntegrationResult;
    let staleReassessments = 0;
    /** Whether any attempt came back stale, i.e. this result lost a race. */
    let lostRace = false;
    for (;;) {
      integration = await integrations.integrate({
        repository,
        integrationRoot,
        changeSet: promoted,
        validationCommands: task.validationCommands,
        commitMessage: `coord(${task.id}): ${task.objective}`,
        requireExactBase: true,
        ...(replayableOnto === undefined ? {} : { replayableOnto }),
      });
      await store.saveIntegration(run.id, integration);
      await trace(store, run.id, "validation_completed", task.id, {
        projectId: task.projectId,
        status: integration.status,
        commands: integration.validation.map((entry) => ({
          label: entry.command.label,
          exitCode: entry.exitCode,
        })),
      });
      if (integration.status !== "stale") {
        break;
      }
      // Each re-assessment costs a second integration and validation run, so
      // the budget is small. Exhausting it lands on the requeue this path took
      // unconditionally before, which is the floor this can never fall below.
      lostRace = true;
      staleReassessments += 1;
      if (
        staleReassessments > STALE_REASSESSMENT_BUDGET ||
        !(await pinReplayOnto(integration.canonicalVersion, true))
      ) {
        return await requeueForCanonicalChange(
          store,
          repositories,
          leaseAtStart,
          baseVersion,
          integration.canonicalVersion,
          run.id,
        );
      }
    }
    if (integration.status === "integrated") {
      await store.saveTaskStatus(
        run.id,
        task.id,
        "integrated",
        integration.explanation,
      );
      await store.completeSubmittedTask(task.id, "integrated", run.id);
      await trace(store, run.id, "canonical_promoted", task.id, {
        projectId: task.projectId,
        previousRevision: integration.previousVersion.revision,
        revision: integration.canonicalVersion.revision,
        changeSetId: integration.changeSetId,
      });
      // Only now, with the granted half durably in canonical, is the deferred
      // half turned into work of its own. Queueing it earlier would leave a
      // task asking for the remainder of something that never landed.
      followUp = await queueDeferredScope(
        store,
        run.id,
        task,
        admitted.admission,
        split,
        changeSet,
      );
    } else if (
      (textualMergeAttempt || lostRace) &&
      ["conflict", "validation_failed"].includes(integration.status)
    ) {
      // The free merge was a bet, and it lost — overlapping hunks, or a
      // clean merge the repository's own tests rejected. Losing the bet
      // costs what it always cost: the requeue-to-replan this path took
      // unconditionally before the bet existed. The task is not wrong, so
      // it is not failed.
      //
      // `lostRace` is here to keep that promise exact. A result that reached
      // integration only by being re-graded after a stale attempt used to be
      // requeued unconditionally, having never been validated at all; now
      // that it does get validated, a failure must not turn a task that
      // would have been retried into a dead one. Results assessed before
      // integrating keep the narrower rule: with no textual overlap the
      // advance is unrelated, so a validation failure is the agent's own and
      // a replan would only rediscover it.
      return await requeueForCanonicalChange(
        store,
        repositories,
        leaseAtStart,
        baseVersion,
        assessedAgainst,
        run.id,
      );
    } else {
      await store.saveTaskStatus(
        run.id,
        task.id,
        "failed",
        integration.explanation,
      );
      await store.completeSubmittedTask(task.id, "failed", run.id);
      await trace(store, run.id, "task_failed", task.id, {
        projectId: task.projectId,
        status: integration.status,
        explanation: integration.explanation,
      });
    }
    // The task has settled either way, which is the natural boundary for a
    // handoff: everything it will ever know is now on the record, and the next
    // session should start from that rather than from nothing. A failure to
    // write one must not fail an otherwise good integration.
    await recordTaskHandoff(
      store,
      buildTaskHandoff({
        taskId: task.id,
        objective: task.objective,
        repositoryId: task.repositoryId,
        ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
        runId: run.id,
        canonicalRevision: integration.canonicalVersion.revision,
        decision,
        admission: admitted.admission,
        integration,
        changeSet: promoted,
        followUpTaskIds: followUp === undefined ? [] : [followUp],
        withheldFiles: split.deferred.map((patch) => patch.path).sort(),
        reason:
          integration.status !== "integrated"
            ? "failed"
            : planAdmissionPartial(admitted.admission) ||
                split.deferred.length > 0
              ? "partially_completed"
              : "completed",
        ...(integration.status === "integrated"
          ? {}
          : { failure: integration.explanation }),
      }),
      { runId: run.id },
    ).catch(() => undefined);
    await store.finishRun(run.id, "completed", integration.canonicalVersion);
    runFinished = true;
    return {
      accepted: integration.status === "integrated",
      ...(integration.status === "integrated"
        ? {}
        : { reason: integration.explanation }),
      runId: run.id,
      integrationStatus: integration.status,
    };
  } catch (error) {
    const explanation = errorMessage(error);
    const failedAt = new Date().toISOString();
    const lease = await store.getWorkLease(input.leaseId);
    let canFailTask = lease?.status === "completed";
    if (lease?.status === "active") {
      canFailTask = await store.finishWorkLease(
        lease.id,
        "failed",
        failedAt,
        explanation.slice(0, 2_000),
      );
      if (!canFailTask) {
        await store.expireWorkLeases(failedAt);
      }
    }
    if (canFailTask) {
      await failClaimedTask(store, task.id, run.id);
    }
    await store
      .saveTaskStatus(run.id, task.id, "failed", explanation)
      .catch(() => undefined);
    await trace(store, run.id, "task_failed", task.id, {
      projectId: task.projectId,
      repositoryId: task.repositoryId,
      workerId: leaseAtStart.workerId,
      leaseId: leaseAtStart.id,
      stage: "remote_integration",
      error: explanation,
    }).catch(() => undefined);
    if (!runFinished) {
      await store.finishRun(run.id, "failed").catch(() => undefined);
    }
    return { accepted: false, reason: explanation, runId: run.id };
  }
}

/** Convenience binding for a project-hosted control plane. */
export function workerOperations(
  project: CoordinatorProject,
  store: CoordinationStore,
) {
  const repositories = new RepositoryService();
  const worktrees = new GitWorktreeWorkspaceManager(
    repositories.getGitClient(),
  );
  const sandboxOptions = project.sandboxOptions();
  const workspaces: WorkspaceManager =
    sandboxOptions === undefined
      ? worktrees
      : new DockerWorkspaceManager(sandboxOptions, worktrees);
  const intelligence = new CodeIntelligenceService(repositories);
  const services: WorkResultServices = {
    repositories,
    integrations: new IntegrationService(repositories, workspaces),
    intelligence,
    integrationRoot: project.integrationRoot,
  };
  const planServices: WorkPlanServices = {
    repositories,
    intelligence,
  };
  const processing = new Map<string, Promise<WorkResultAcceptance>>();
  // Admission reads the repository's executing plans and writes one back.
  // Serialising per repository in the hosting process keeps a burst of
  // simultaneous submissions from spending retries on each other; the store's
  // own staleness check is what makes the result correct.
  const admitting = new Map<string, Promise<unknown>>();
  return {
    leaseWork: async (input: {
      workerId: string;
      projectId: string;
      repositoryId?: string;
    }) => await leaseWork(store, input, repositories, project),
    leaseBundle: async (leaseId: string) =>
      await leaseBundle(store, leaseId, repositories),
    admitWorkPlan: async (input: WorkPlanInput) => {
      const lease = await store.getWorkLease(input.leaseId);
      const key = lease?.repositoryId ?? input.leaseId;
      const run = async () => await admitWorkPlan(store, input, planServices);
      // Chained on settlement, not on success: one failed admission must not
      // wedge every later submission in the repository.
      const queued = (admitting.get(key) ?? Promise.resolve()).then(run, run);
      admitting.set(key, queued);
      try {
        return await queued;
      } finally {
        if (admitting.get(key) === queued) {
          admitting.delete(key);
        }
      }
    },
    // Serialised alongside admission for the same repository: a widening reads
    // the executing set and writes a wider contract back into it, which is the
    // same read-decide-write an admission performs.
    arbitrateScopeChange: async (input: WorkScopeInput) => {
      const lease = await store.getWorkLease(input.leaseId);
      const key = lease?.repositoryId ?? input.leaseId;
      const run = async () =>
        await arbitrateScopeChange(store, input, planServices);
      const queued = (admitting.get(key) ?? Promise.resolve()).then(run, run);
      admitting.set(key, queued);
      try {
        return await queued;
      } finally {
        if (admitting.get(key) === queued) {
          admitting.delete(key);
        }
      }
    },
    acceptWorkResult: async (input: WorkResultInput) => {
      const existing = processing.get(input.leaseId);
      if (existing !== undefined) {
        return await existing;
      }
      const operation = acceptWorkResult(store, input, services);
      processing.set(input.leaseId, operation);
      try {
        return await operation;
      } finally {
        if (processing.get(input.leaseId) === operation) {
          processing.delete(input.leaseId);
        }
      }
    },
  };
}
