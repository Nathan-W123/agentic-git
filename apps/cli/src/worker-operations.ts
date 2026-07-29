import { mkdir } from "node:fs/promises";
import path from "node:path";

import { CodeIntelligenceService, groundPlan } from "@coord/code-intelligence";
import {
  DEFAULT_PLAN_RETRY_MS,
  PlanAdmissionController,
  ScopeExpansionError,
  StoreApprovalController,
  approvalPolicyForProject,
  assertChangeSetWithinPlan,
  deferredScopeObjective,
  isDeferredScopeFollowUp,
  replayBlockers,
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
  deferredFilePaths,
  normalizeRepositoryPath,
  planAdmissionApproved,
  planAdmissionPartial,
  projectBudgets,
  reducePlanScope,
  type AgentPlan,
  type CanonicalVersion,
  type ChangeSet,
  type CoordinatorDecision,
  type DeferredResource,
  type IntegrationResult,
  type PlanAdmission,
  type ResourceType,
  type TaskDefinition,
} from "@coord/shared-types";
import {
  DockerWorkspaceManager,
  GitWorktreeWorkspaceManager,
  type WorkspaceManager,
} from "@coord/workspace-manager";

import type { CoordinatorProject } from "./project.js";

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
  const budget = projectBudgets(projectRecord?.policy).maxProjectRuntimeMsPerDay;
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

  // Try every compatible candidate rather than only the first: another
  // worker polling at the same moment may have claimed it, or its
  // repository may be at its parallelism cap while a later task's is not.
  for (const next of pending) {
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
      throw new Error("Plan objective does not match the leased task");
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

  for (let attempt = 1; attempt <= MAX_ADMISSION_ATTEMPTS; attempt += 1) {
    const executing = await executingPlans(store, lease);
    const admission = admissions.admit({
      plan,
      agentId: task.agentId,
      baseRevision: baseVersion.revision,
      baseVersion: baseVersion.sequence,
      active: executing.active,
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
    });
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
  const replay = async (
    current: CanonicalVersion,
  ): Promise<string[]> =>
    replayBlockers(
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

  const currentBeforeRun = await repositories.getCanonicalVersion(repository);
  if (
    currentBeforeRun.revision !== baseVersion.revision &&
    (await replay(currentBeforeRun)).length > 0
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
  const run = await store.createRun({
    repository: storedRepository,
    ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
    mode: "coordinated",
    scenario: "remote-worker",
    baseVersion,
  });
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
    let replayableOnto: string | undefined;
    if (currentBeforeIntegration.revision !== baseVersion.revision) {
      const blockers = await replay(currentBeforeIntegration);
      if (blockers.length > 0) {
        return await requeueForCanonicalChange(
          store,
          repositories,
          leaseAtStart,
          baseVersion,
          currentBeforeIntegration,
          run.id,
        );
      }
      // Pinned to this exact revision. If canonical moves once more before the
      // integration reads it, the permission no longer matches and the result
      // is refused as stale, exactly as it was before replay existed.
      replayableOnto = currentBeforeIntegration.revision;
      await trace(store, run.id, "canonical_changed", task.id, {
        projectId: task.projectId,
        repositoryId: task.repositoryId,
        previousRevision: baseVersion.revision,
        revision: currentBeforeIntegration.revision,
        workerId: leaseAtStart.workerId,
        leaseId: leaseAtStart.id,
        replayed: true,
        explanation:
          "Canonical advanced without touching anything this result depends " +
          "on, so the result was replayed rather than requeued",
      });
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

    await mkdir(
      services.integrationRoot ??
        path.resolve(".coordinator", "integration"),
      { recursive: true },
    );
    await store.saveTaskStatus(run.id, task.id, "validating");
    const integration = await integrations.integrate({
      repository,
      integrationRoot:
        services.integrationRoot ??
        path.resolve(".coordinator", "integration"),
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

    if (integration.status === "stale") {
      return await requeueForCanonicalChange(
        store,
        repositories,
        leaseAtStart,
        baseVersion,
        integration.canonicalVersion,
        run.id,
      );
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
