import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CodeIntelligenceService,
  groundedIntentAssessor,
  groundPlan,
} from "@coord/code-intelligence";
import {
  DEFAULT_PLAN_RETRY_MS,
  OwnershipService,
  PlanAdmissionController,
  blanketPlan,
  estimateScope,
  recentTouchPoints,
  scopeStartingPoints,
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

import {
  extendEditorWork,
  reportEditorWork,
  takeEditorWork,
} from "./editor-work.js";
import {
  blockedAdmissionHistory,
  wasPartiallyAdmitted,
} from "./admission-history.js";
import { LeasePlanAuthority } from "./lease-admission.js";
import {
  CLAIM_HEARTBEAT_INTERVAL_MS,
  askToDeliver,
  parseWorkingChanges,
  registerRemoteHolder,
  releaseRemoteHolder,
  rememberWorkingChanges,
  settleDeclaration,
} from "./remote-holders.js";
import type {
  CoordinationStore,
  SubmittedTask,
  TaskKind,
  WorkLease,
} from "@coord/persistence";
import {
  agentCommitIdentity,
  LEASE_REF_PREFIX,
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  assertAgentPlan,
  assertChangeSet,
  createId,
  deferredFilePaths,
  isBlanketClaim,
  mergePlanScope,
  normalizeRepositoryPath,
  planAdmissionApproved,
  planAdmissionPartial,
  projectBudgets,
  reducePlanScope,
  summariseChangedFiles,
  rankTouchedFiles,
  uniqueRepositoryPaths,
  uniqueStrings,
  type AgentPlan,
  type CanonicalVersion,
  type ChangeSet,
  type FilePatch,
  type CoordinatorDecision,
  type DeferredResource,
  type IntegrationResult,
  type PlanAdmission,
  type ResourceType,
  type ScopeChangeDecision,
  type ScopeChangeRequest,
  type TaskDefinition,
  type TaskId,
  type WorkAssignment as SharedWorkAssignment,
  mcpServersForLease,
  summariseGrants,
} from "@coord/shared-types";
import {
  DockerWorkspaceManager,
  GitWorktreeWorkspaceManager,
  type SecretSealer,
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
export function legacyAdmissionLoop(): boolean {
  return process.env["COORD_LEGACY_ADMISSION_LOOP"] === "1";
}

/**
 * Whether this deployment refuses to execute agents itself.
 *
 * Re-exported rather than defined here, and that move is the point. The queue
 * is not the only executor: the gateway answers questions and runs its own
 * ceremonial turns through a provider, on a path this file never sees. When
 * the predicate lived here, only one of the two could reach it, and the
 * deployment that set the variable stopped draining the queue while still
 * running an agent for every mention. It now lives in `@coord/shared-types`,
 * which both executors already depend on, so there is one answer rather than
 * one answer and one blind spot.
 */
export { localAgentsOnly } from "@coord/shared-types";

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
/**
 * The fewest concurrent leases a repository is given, whatever the host.
 *
 * A floor rather than a ceiling, which is a deliberate reversal. Four was the
 * most that had been observed completing — the one live run at five livelocked
 * — but that run predates the three defects fixed in the two commits before
 * this one, and all three scale with N: a result that both deferred scope and
 * salvaged a conflict silently lost the salvaged half, an abandoned
 * declaration ask failed the task it asked, and concurrent credential
 * rotations overwrote each other. The evidence against five was evidence
 * against five *with those bugs in it*.
 *
 * Below four the system also loses the thing it exists for. Partial admission
 * is computed only against other executing plans, so at parallelism one it can
 * never fire and chunk admission is dead code.
 */
const MINIMUM_REPOSITORY_PARALLELISM = 4;

/** What one agent is priced at where this repository states a price. */
const AGENT_MEMORY_BYTES = 2 * 1024 ** 3;
/** The sidecar a sandboxed agent carries beside it. */
const AGENT_SIDECAR_BYTES = 0.25 * 1024 ** 3;
/** Left for the control plane, which on a single box is a CPU consumer too. */
const HOST_RESERVE_BYTES = 2 * 1024 ** 3;

/**
 * How many concurrent leases this host can actually hold, derived rather than
 * guessed.
 *
 * Memory is the term that binds. An agent is a vendor CLI waiting on model
 * round trips far more than it is a CPU consumer, so cores are a poor divisor
 * — a formula built on them lands at one agent on a four-core box and puts
 * the system back where partial admission can never fire. What each agent
 * genuinely holds is its own process, its own worktree and its share of the
 * index caches, and that is measurable: this repository prices an agent at
 * 2 GiB, plus a quarter for the egress sidecar when sandboxed.
 *
 * Clamped both ways. Never above what has actually been observed completing,
 * because the ceiling is an evidence statement rather than a capacity one;
 * never below one, because the stores serialise to one absent a value and a
 * zero would stop the repository entirely.
 */
export function derivedRepositoryParallelism(
  totalMemoryBytes: number = os.totalmem(),
): number {
  const usable = totalMemoryBytes - HOST_RESERVE_BYTES;
  const fits = Math.floor(usable / (AGENT_MEMORY_BYTES + AGENT_SIDECAR_BYTES));
  return Math.max(MINIMUM_REPOSITORY_PARALLELISM, fits);
}

/**
 * @deprecated Read {@link derivedRepositoryParallelism} instead. Kept because
 * it is exported and named in tests and documentation.
 */
export const DEFAULT_REPOSITORY_PARALLELISM = MINIMUM_REPOSITORY_PARALLELISM;

export function configuredRepositoryParallelism(explicit?: number): number {
  if (explicit !== undefined) {
    return explicit;
  }
  const raw = process.env["COORD_REPOSITORY_PARALLELISM"]?.trim() ?? "";
  if (raw.length === 0) {
    return derivedRepositoryParallelism();
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
 * Whether a task alone in its repository is handed the whole of it instead of
 * being asked to plan.
 *
 * On unless a deployment says otherwise. The claim costs nothing to give —
 * nothing else can be admitted while it is held — and it removes the single
 * largest fixed delay before a solo task's first edit. `COORD_BLANKET_CLAIM=0`
 * puts every task back through planning, which is the state the system was in
 * before this existed.
 */
export function configuredBlanketClaims(explicit?: boolean): boolean {
  if (explicit !== undefined) {
    return explicit;
  }
  const raw = process.env["COORD_BLANKET_CLAIM"]?.trim().toLowerCase() ?? "";
  if (raw.length === 0) {
    return true;
  }
  return !["0", "false", "off", "no"].includes(raw);
}

/**
 * Wire version of the remote worker protocol.
 *
 * 1 planned and executed in one shot and posted a result.
 * 2 submits the plan for admission first and only executes once the control
 *   plane grants ownership, so a conflict costs a planning round trip instead
 *   of a discarded execution.
 * 3 asks for a repository claim before planning, reports its working changes
 *   on the heartbeat, and adopts a claim the control plane narrows underneath
 *   it. A version-2 worker is never granted a claim, because a claim it could
 *   not be told about is one nobody could take back.
 * 4 carries the project's approved MCP servers in the lease. A version-3
 *   worker is never sent them, and the thread is told, because a run that
 *   silently lacks tools it was promised is the failure this exists to
 *   prevent.
 */
export const WORKER_PROTOCOL_VERSION = 4;

/**
 * The shared shape, with this package's lease and task rows filled in.
 *
 * Re-exported under the old name because the worker imports it from here and
 * has no reason to know the definition moved. The gateway names the same
 * alias from the same shared definition, so the two ends of the wire cannot
 * disagree about a field again.
 */
export type WorkAssignment = SharedWorkAssignment<WorkLease, SubmittedTask>;

export interface WorkResultInput {
  leaseId: string;
  status: "completed" | "failed";
  actorId: string;
  plan: unknown;
  changeSet: unknown;
  detail?: string;
  /**
   * What the agent said, when the lease was on a question.
   *
   * Kept apart from `detail`, which is a failure reason with a short bound
   * and no reader outside a log. An answer is prose somebody is about to read
   * in a channel, and putting it in `detail` would have meant either
   * truncating answers or loosening the bound on failure text.
   */
  answer?: string;
}

export interface WorkResultAcceptance {
  accepted: boolean;
  /** The answer, when the lease was on a question. The gateway posts it. */
  answer?: string;
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

export interface WorkResultServices {
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

/**
 * Derived from the lease so concurrent bundle requests cannot collide.
 *
 * Fully qualified and outside `refs/heads/`: a lease is scaffolding for one
 * remote execution, and these used to appear as branches of the canonical
 * repository for as long as the lease lived — longer, if the process died
 * before deleting one.
 */
// Compatibility re-export for task-routing callers. Completion no longer
// depends on this heuristic: a completed run with no diff is still complete.
export { readsAsReportRequest } from "@coord/shared-types";

export function bundleRefFor(leaseId: string): string {
  return `${LEASE_REF_PREFIX}${leaseId.replaceAll(/[^A-Za-z0-9_-]/gu, "")}`;
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
      // Resolving a row from a lease that already exists, so the fail-closed
      // default is the wrong question here: whatever this lease is on, this
      // function's job is to find it. Without `any` a question lease resolves
      // to nothing and `acceptWorkResult` rejects the answer with "The leased
      // task is no longer claimed" — which reads as a lease bug and is not
      // one.
      kind: "any",
    })
  ).find((task) => task.id === lease.taskId);
}

async function failClaimedTask(
  store: CoordinationStore,
  taskId: string,
  runId?: string,
): Promise<void> {
  const current = (await store.listSubmittedTasks({ kind: "any" })).find(
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

/**
 * The adapter a task's agent needs, or `undefined` when nothing constrains it.
 *
 * Exported under a longer name for `editor-work.ts`, which asks the identical
 * question about an editor: an editor advertises exactly one vendor, and work
 * for a different one must fall past it rather than be taken and failed.
 */
export function editorAdapterName(
  project: CoordinatorProject | undefined,
  task: SubmittedTask,
): string | undefined {
  return adapterName(project, task);
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
 * How long after a worker was last heard from its owner's queue stays reserved.
 *
 * Three missed polls. The window can be generous because the cost of being
 * wrong is asymmetric: hold a reservation too long and the owner's task waits
 * for a machine that is coming back anyway; drop it too early and the control
 * plane runs their work on the host account, which is the thing this exists to
 * prevent. A worker refreshes this on every poll, not only while holding a
 * lease — `touchWorker` is called at the top of the leases endpoint — so an
 * idle desktop stays live without inventing a separate presence ping.
 */
const OWNER_RESERVATION_MS = 3 * HEARTBEAT_INTERVAL_MS;

/**
 * The users whose queued work belongs to a machine of their own.
 *
 * The in-process control plane can execute as anyone, so left alone it drains
 * the queue the moment a task lands and a user's desktop never sees their own
 * work. Passing this to {@link CoordinationStore.leaseNextTask} as
 * `excludeSubmittedBy` makes it stand back for exactly as long as the owner's
 * machine is answering.
 *
 * Empty whenever nobody has registered a worker, which is every deployment
 * that runs the control plane alone — so this changes nothing for them.
 */
export async function reservedOwners(
  store: CoordinationStore,
  organizationId?: string,
  now: Date = new Date(),
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - OWNER_RESERVATION_MS).toISOString();
  const workers = await store.listWorkers(
    organizationId === undefined ? undefined : { organizationId },
  );
  const owners = new Set<string>();
  for (const worker of workers) {
    if (worker.lastSeenAt > cutoff) {
      owners.add(worker.userId);
    }
  }
  return [...owners];
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
    /**
     * The only repositories this caller may be handed work from.
     *
     * Absent means "no limit", which is what an organization member gets.
     * Present means the caller reaches this project through repository
     * grants and holds precisely these — someone invited to one repository,
     * running a worker on their own machine. Without it, a grant on one
     * repository would be a licence to execute tasks from every other
     * repository in the same project, on their laptop, with their
     * credentials, which is the opposite of what granting one repository
     * means.
     *
     * An empty set is therefore honoured as "nothing", not read as absent.
     */
    repositories?: ReadonlySet<string>;
    /** Test override; deployments configure COORD_REPOSITORY_PARALLELISM. */
    repositoryParallelism?: number;
    /**
     * What this worker is able to execute. Defaults to work alone.
     *
     * A desktop built before questions existed sends nothing, so it is never
     * offered one — that default is the entire compatibility story, and the
     * reason no protocol version had to move.
     */
    kinds?: readonly TaskKind[];
    /**
     * The protocol version the worker reported when it asked. Absent from a
     * worker built before it was sent, which is why it is read as 1 and not
     * as "current": the lease has to know what the other end will look for.
     */
    protocolVersion?: number;
  },
  repositories = new RepositoryService(),
  project?: CoordinatorProject,
  services: {
    /**
     * Opens the project's sealed MCP secrets for the lease. Omitted by the
     * bare CLI and by tests that are not about tools, and with it omitted no
     * server is ever attached — see `mcpServersForLease`.
     */
    sealer?: SecretSealer;
  } = {},
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

  const kinds = input.kinds ?? ["task"];
  // Listed per kind and concatenated rather than asked for with `any`,
  // because `any` would also hand back kinds this worker did not ask for. The
  // two-element case is the whole of it, and questions come first for the
  // same reason the store orders them first: somebody is watching for one.
  const pending = (
    await Promise.all(
      [...kinds]
        .sort((left, right) =>
          Number(left !== "question") - Number(right !== "question"),
        )
        .map(
          async (kind) =>
            await store.listSubmittedTasks({
              projectId: input.projectId,
              status: "submitted",
              kind,
              ...(input.repositoryId === undefined
                ? {}
                : { repositoryId: input.repositoryId }),
            }),
        ),
    )
  ).flat();

  // Applied after listing rather than pushed into the query, because the
  // store's filter takes one repository and this is a set. A worker asking
  // for a specific `repositoryId` it does not hold falls out here too, which
  // is the point: the id on the request is a preference the worker states,
  // never a permission it asserts.
  const reachable =
    input.repositories === undefined
      ? pending
      : pending.filter((task) => input.repositories?.has(task.repositoryId));

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
    : await tasksWaitingOnActiveWork(store, reachable);
  const ordered = [
    ...reachable.filter((task) => !waiting.has(task.id)),
    ...reachable.filter((task) => waiting.has(task.id)),
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
      // This machine has exactly one set of vendor logins to offer, so it may
      // only take work belonging to the person who registered it.
      claimableBy: worker.userId,
      // Named again at the claim, not only in the listing above. The store's
      // clause is the one that actually holds — the listing narrows what this
      // loop considers, the clause is what stops any caller taking a kind it
      // cannot execute.
      kinds,
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
    // After the lease is recorded, never before: a secret is opened only for
    // a task this worker now holds, and every gate in there answers "attach
    // nothing" rather than throwing, so the lease just issued cannot be lost
    // to a tool it did not need.
    const mcpServers = await mcpServersForLease(store, {
      opener: services.sealer,
      projectId: input.projectId,
      repositoryId: leased.task.repositoryId,
      taskId: leased.task.id,
      taskSubmittedBy: leased.task.submittedBy,
      workerId: worker.id,
      workerUserId: worker.userId,
      workerProtocolVersion: input.protocolVersion,
      leaseId: leased.lease.id,
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
      // Only when there is something to carry. An older worker that does not
      // know the field never sees an empty one either.
      ...(mcpServers === undefined ? {} : { mcpServers }),
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
  /** What the worker says it already has, so only the delta is packed. */
  have?: string,
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
    have,
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
  letGoOfClaim(lease.taskId);
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
      const currentTask = (await store.listSubmittedTasks({ kind: "any" })).find(
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
  admission: PlanAdmission,
  split: { deferred: readonly { path: string }[] },
): Promise<WorkResultAcceptance> {
  const resources = admission.deferredResources ?? [];
  const paths = [
    ...new Set([
      ...split.deferred.map((patch) => patch.path),
      ...resources
        .filter((resource) => resource.resourceType === "file")
        .map((resource) => resource.resourceId),
    ]),
  ].sort();
  const labels = resources.map(
    (resource) => `${resource.resourceType}:${resource.resourceId}`,
  );
  const blockedBy = [
    ...new Set(resources.flatMap((resource) => resource.heldBy)),
  ].sort();
  const reason =
    "No work could be completed without the deferred resources " +
    `(${(labels.length > 0 ? labels : paths).join(", ")}); the task was ` +
    "requeued at full scope to wait for them";
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
  await trace(store, undefined, "plan_admitted", task.id, {
    projectId: task.projectId,
    repositoryId: task.repositoryId,
    workerId: lease.workerId,
    leaseId: lease.id,
    status: "sequenced",
    blockedBy,
    constraints: ["Retry the whole plan after the holders finish"],
    deferredFiles: paths,
    deferredResources: resources,
    explanation: reason,
    partialNoProgress: true,
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
    // The rest of the same request: whatever conversation the original was
    // asked inside is as much the follow-up's background as it was its own.
    ...(task.context === undefined ? {} : { context: task.context }),
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
 * Turns the half of a conflicting changeset that could not land into a task.
 *
 * A conflict used to end the whole result: every clean file and clean hunk
 * beside the contested one was discarded, and a replan bought back work that
 * had already been done. Integration now promotes what still applies, which
 * leaves precisely this remainder to account for.
 *
 * It reuses the deferred-scope marker on purpose. That marker is what stops a
 * follow-up from splitting again, and the termination argument is the same
 * here: one division per task, or a task could shed a file per round forever,
 * each round costing an agent run.
 *
 * The contested patches are recorded but never replayed. They were written
 * against a version of the file that has since moved — that is what made them
 * conflict — so they are context for whoever picks the follow-up up, not a
 * diff to re-apply.
 */
async function queueSalvagedConflict(
  store: CoordinationStore,
  runId: string,
  task: SubmittedTask,
  deferred: readonly FilePatch[],
  reported: ChangeSet,
): Promise<string | undefined> {
  if (deferred.length === 0) {
    return undefined;
  }
  const paths = [...new Set(deferred.map((patch) => patch.path))].sort();
  const followUp = await store.submitTask({
    repositoryId: task.repositoryId,
    ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
    objective: deferredScopeObjective(task.objective, [], paths),
    agentId: task.agentId,
    validationCommands: task.validationCommands,
    ...(task.submittedBy === undefined ? {} : { submittedBy: task.submittedBy }),
    ...(task.context === undefined ? {} : { context: task.context }),
  });
  await trace(store, runId, "task_submitted", followUp.id, {
    projectId: task.projectId,
    repositoryId: task.repositoryId,
    objective: followUp.objective,
    deferredFrom: task.id,
    conflictedPaths: paths,
  });

  const record = withheldPatchRecord([...deferred]);
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
      "Patches that conflicted with canonical while the rest of the same " +
      "changeset was promoted. Kept as context for the follow-up task; " +
      "never replayed, because the base they were written against is " +
      "exactly what moved underneath them",
  });
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
    requiredRole: "admin",
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

/**
 * How long the control plane will spend deciding whether a remote worker can
 * have the repository, before answering "plan it yourself".
 *
 * A claim is worth an index build — a planning round trip is an agent round
 * trip and this is the cheaper of the two — but the trade only holds while
 * somebody is *waiting* on it. Here the waiter is a laptop holding an open
 * HTTP request, so past this the answer is no and the worker plans exactly as
 * it does today. The fall-through is free; the wait is not.
 */
export const BLANKET_CLAIM_DEADLINE_MS = 20_000;

/**
 * What the control plane already knows, handed down before a worker plans.
 *
 * Either the repository itself — in which case there is nothing to plan — or,
 * failing that, where to start reading. The second is the cheaper half of the
 * same idea and applies to the tasks the first cannot help: planning is an
 * agent reading its way into a repository a tool call at a time, and most of
 * that reading is a search for something the control plane has already
 * computed. In-process both have been handed to the planning prompt for as
 * long as they have existed; a remote worker was told neither, and started
 * every plan from nothing.
 */
export interface WorkClaimOutcome {
  plan?: AgentPlan;
  planningContext?: string;
}

export interface WorkClaimInput {
  leaseId: string;
  /** The protocol the caller speaks; below 3 there is no claim to grant. */
  protocolVersion: number;
}

interface WorkClaimServices {
  repositories?: RepositoryService;
  intelligence?: CodeIntelligenceService;
  admissions?: PlanAdmissionController;
  blanketClaims?: boolean;
  deadlineMs?: number;
}

/**
 * The whole repository, for a remote task nobody is competing with.
 *
 * This is the step the worker protocol never had. In-process, a solo task is
 * handed its repository and never asked to describe itself: the plan an agent
 * would have written exists so a second task can arbitrate against it, and
 * where there is no second task the round trip buys nothing. Moving execution
 * onto people's own machines put that step on the far side of a boundary it
 * did not cross, so every desktop task went back to paying a full agent
 * planning call before its first edit — measured in the repository's own
 * benchmark at two thirds of all executions, and minutes each.
 *
 * The conditions are the in-process ones, restated against durable state
 * because that is all a remote holder and its arrivals can both see:
 *
 * - blanket claims are on for this deployment;
 * - the lease is live and has no contract yet (a resumed turn or a retry
 *   after a deferral already has one, and widening it is what the
 *   immutability rule on approved admissions forbids);
 * - nothing else is active in this repository, including a task that has
 *   leased but not yet planned — admitting a claim beside one of those would
 *   refuse it everything the moment it submitted, and it has paid for its
 *   plan by then;
 * - the objective produced an *anchored* scope estimate, so the claim can be
 *   narrowed the moment somebody arrives. A claim that can never be given
 *   back early is not worth the planning round it saves.
 *
 * There is no longer a condition about how many workers are live. There was
 * one while a remote claim could not be given back: a claim that cannot be
 * narrowed is worse than no claim, so "there is nobody to block" stood in for
 * the safety property until the property itself existed. It exists now — the
 * heartbeat carries what a holder has written, the ask reaches it wherever it
 * is running, and an arrival that cannot get an answer waits rather than
 * freezing on a guess. A second machine is no longer a reason to withhold.
 */
export async function claimWorkRepository(
  store: CoordinationStore,
  input: WorkClaimInput,
  services: WorkClaimServices = {},
): Promise<WorkClaimOutcome> {
  const now = new Date().toISOString();
  await store.expireWorkLeases(now);
  const lease = await store.getWorkLease(input.leaseId);
  if (lease === undefined || lease.status !== "active" || lease.expiresAt <= now) {
    return {};
  }
  const task = await submittedTask(store, lease);
  if (task === undefined || task.status !== "claimed") {
    return {};
  }
  const storedRepository = await store.getRepository(lease.repositoryId);
  if (storedRepository === undefined) {
    return {};
  }
  const repositories = services.repositories ?? new RepositoryService();
  const intelligence =
    services.intelligence ?? new CodeIntelligenceService(repositories);
  const admissions = services.admissions ?? new PlanAdmissionController();
  const repository = canonical(storedRepository);
  let baseVersion: CanonicalVersion;
  try {
    baseVersion = await repositories.getVersionAtRevision(
      repository,
      lease.baseRevision,
    );
  } catch {
    return {};
  }

  // The expensive step, and the one with a stopwatch on it. Everything above
  // is a read of durable state; this builds a symbol index at the lease's
  // revision, and it pays for itself twice — once as the ground a claim can
  // later be narrowed to, and once as the note that stops an agent reading
  // its way into a repository to find a file the objective already named.
  const estimate = await withDeadline(
    intelligence
      .index(repository, lease.baseRevision)
      .then((built) => estimateScope(task.objective, built))
      .catch(() => undefined),
    services.deadlineMs ?? BLANKET_CLAIM_DEADLINE_MS,
    undefined,
  );
  // Where this repository has been working lately. Cheap, durable, and the
  // other half of the same problem: the estimate is silent whenever the words
  // a person used are not the words in the paths, which is most of the time.
  const recentlyTouched = await store
    .recentlyTouchedFiles({ repositoryId: lease.repositoryId })
    .then((samples) => rankTouchedFiles(samples, Date.now()))
    .catch(() => []);
  const planningContext = [
    estimate === undefined ? "" : scopeStartingPoints(estimate),
    recentTouchPoints(recentlyTouched),
  ]
    .filter((part) => part !== "")
    .join("\n\n");

  const estimatedFiles =
    estimate?.confidence === "anchored"
      ? estimate.files.map((file) => file.path)
      : [];
  const claim = await grantBlanketClaim({
    store,
    admissions,
    lease,
    task,
    baseVersion,
    estimatedFiles,
    protocolVersion: input.protocolVersion,
    ...(services.blanketClaims === undefined
      ? {}
      : { blanketClaims: services.blanketClaims }),
  });
  return {
    ...(claim === undefined ? {} : { plan: claim }),
    // Carried even when a claim was granted is *not* what happens: a claimed
    // task never plans, so a note about where to start reading is a paragraph
    // nobody reads. This is the consolation prize, and the tasks that get it
    // are exactly the contended ones — the slow ones.
    ...(claim !== undefined || planningContext === "" ? {} : { planningContext }),
  };
}

/**
 * The claim itself, once everything it needs has been gathered.
 *
 * Split from the gathering because the two have different failure modes: the
 * reads above are worth doing whatever happens, and every refusal here means
 * "plan as you always did" rather than "something went wrong".
 */
async function grantBlanketClaim(input: {
  store: CoordinationStore;
  admissions: PlanAdmissionController;
  lease: WorkLease;
  task: SubmittedTask;
  baseVersion: CanonicalVersion;
  estimatedFiles: readonly string[];
  protocolVersion: number;
  blanketClaims?: boolean;
}): Promise<AgentPlan | undefined> {
  const { store, lease, task } = input;
  if (!configuredBlanketClaims(input.blanketClaims)) {
    return undefined;
  }
  if (input.protocolVersion < 3) {
    // A worker that cannot be told its claim was narrowed must never be given
    // one. It would hold the repository until its task ended, and every
    // arrival would wait that out.
    return undefined;
  }
  if (lease.plan !== undefined) {
    // A contract already exists — a resumed turn, or a retry after a deferral.
    // Replacing it with a wider one is what the immutability rule on approved
    // admissions forbids.
    return undefined;
  }
  if (input.estimatedFiles.length === 0) {
    // An objective that anchored nothing cannot be narrowed by declaration
    // either, and a claim that can never be given back early is not worth the
    // planning round it saves.
    return undefined;
  }
  const others = (
    await store.listWorkLeases({
      status: "active",
      repositoryId: lease.repositoryId,
    })
  ).filter((candidate) => candidate.id !== lease.id);
  if (others.length > 0) {
    return undefined;
  }
  const plan = blanketPlan(
    {
      id: task.id,
      objective: task.objective,
      agentId: task.agentId,
      validationCommands: task.validationCommands,
    },
    undefined,
    input.estimatedFiles,
  );
  const admission = input.admissions.admit({
    plan,
    agentId: task.agentId,
    baseRevision: input.baseVersion.revision,
    baseVersion: input.baseVersion.sequence,
    active: [],
    planRevision: 1,
  });
  if (!planAdmissionApproved(admission)) {
    return undefined;
  }
  const saved = await store.saveWorkLeasePlan({
    leaseId: lease.id,
    submission: { plan, admission },
    // Nothing else is admitted here, and the write is refused if that stopped
    // being true between the read above and this line. A refusal is not an
    // error: somebody arrived, and the worker plans as it always did.
    observedApprovedLeaseIds: [],
  });
  if (saved.outcome !== "saved") {
    return undefined;
  }
  // Published the moment the claim is, so an arrival can reach the holder
  // through exactly the registry a local one is reached through.
  registerRemoteHolder({
    task: {
      id: task.id,
      objective: task.objective,
      agentId: task.agentId,
      validationCommands: task.validationCommands,
    },
    repositoryId: lease.repositoryId,
    leaseId: lease.id,
  });
  await store.appendAudit(undefined, {
    type: "blanket_claim_granted",
    taskId: task.id,
    data: {
      ...(lease.projectId === undefined ? {} : { projectId: lease.projectId }),
      repositoryId: lease.repositoryId,
      leaseId: lease.id,
      workerId: lease.workerId,
      baseRevision: lease.baseRevision,
      planningCallsSaved: 1,
    },
  });
  return plan;
}

/** Resolves with the fallback rather than keeping a caller waiting. */
async function withDeadline<T>(
  work: Promise<T>,
  milliseconds: number,
  fallback: T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), milliseconds);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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

/**
 * How many times admission is recomputed when a rival admission lands first.
 *
 * Scaled, because the thing it absorbs scales. The compare-and-set is over the
 * whole set of approved lease ids in the repository, so it is invalidated by
 * every admission *and* every lease finishing — with N concurrent workers a
 * plan can lose the race up to N-1 times through no fault of its own. Held at
 * a flat four, a synchronised burst exhausted the budget from about six and
 * the plan was answered `sequenced` with no conflicts and a fifteen-second
 * retry: a sleep on an unconflicted plan, while its worker kept heartbeating
 * and holding the slot.
 *
 * One spare round above the worst case, floored at the old value so nothing
 * gets fewer retries than it used to.
 */
export function maxAdmissionAttempts(parallelism: number): number {
  return Math.max(4, parallelism + 1);
}

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
export async function tasksWaitingOnActiveWork(
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

// Re-exported rather than moved out of sight: these have callers, tests
// among them, that name this module and have no reason to care that the
// readers moved so the two admission paths could share one narrowing.
export {
  blockedAdmissionHistory,
  wasPartiallyAdmitted,
} from "./admission-history.js";

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
  //
  // But *any* movement used to requeue, which is stricter than this codebase
  // treats finished work. `assessReplay` already separates an advance that
  // invalidates what a task knows from overlap a three-way apply absorbs, and
  // a finished *result* is only sent back for the former. An unexecuted plan
  // is worth less than a finished result, so refusing it on evidence that
  // would not refuse a result is backwards.
  //
  // Measured on the A/B series, this is where the coordinated arm spends: 16
  // to 26 replans a run at roughly 145k tokens each, with five workers racing
  // nine integrations, and the two tasks that failed outright show "Canonical
  // advanced before this plan was submitted" two and three times in a row.
  // Most of those advances never touched the plan discarded for them.
  //
  // `COORD_STRICT_PLAN_REBASE=1` restores the unconditional requeue.
  let advanceIsUnrelated = false;
  if (
    current.revision !== baseVersion.revision &&
    process.env["COORD_STRICT_PLAN_REBASE"] !== "1"
  ) {
    const advance = await canonicalAdvance(
      repositories,
      intelligence,
      repository,
      baseVersion,
      current,
    ).catch(() => undefined);
    if (advance !== undefined) {
      // Nothing has executed, so the empty patch list is the honest input
      // rather than a placeholder: the only question here is whether the
      // advance disturbs what this plan claims or depends on.
      const assessment = assessReplay(
        submitted,
        {
          id: "",
          taskId: task.id,
          baseVersion: baseVersion.sequence,
          baseRevision: baseVersion.revision,
          patches: [],
          commandsRun: [],
          tests: [],
          dependenciesChanged: [],
          symbolsChanged: [],
          riskAssessment: { level: "low", reasons: [] },
          agentExplanation: "",
          createdAt: new Date().toISOString(),
        },
        advance,
      );
      // Deliberately stricter than the result path, which tolerates `textual`
      // overlap because a three-way apply absorbs it. That reasoning holds for
      // a changeset already written against the old tree; for a plan about to
      // be *written*, letting an agent edit a file whose current contents it
      // has never seen is a different bet, and not one worth taking to save a
      // planning round. So the requeue is skipped only when the advance
      // touches nothing this plan claims or depends on at all.
      advanceIsUnrelated =
        assessment.semantic.length === 0 && assessment.textual.length === 0;
    }
  }
  if (current.revision !== baseVersion.revision && !advanceIsUnrelated) {
    await requeueForCanonicalChange(
      store,
      repositories,
      lease,
      baseVersion,
      current,
    );
    // What moved, so the next attempt can amend this plan instead of writing
    // a new one. Computed here rather than left to the worker because the
    // control plane is the only side that can see both revisions: the worker
    // holds a bundle of the old one only.
    //
    // A failure to describe the change is not a failure to requeue — the
    // task is already back in the queue by this point, and a worker that
    // receives no notice simply plans cold, which is the behaviour this
    // replaces.
    const advance = await canonicalAdvance(
      repositories,
      intelligence,
      repository,
      baseVersion,
      current,
    ).catch(() => undefined);
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
        ...(advance === undefined
          ? {}
          : {
              canonicalChange: {
                previousVersion: baseVersion,
                canonicalVersion: current,
                changedFiles: [...advance.changedFiles],
                changedSymbols: [...advance.changedSymbols],
                changedApis: [...advance.changedApis],
                changedSchemas: [...advance.changedSchemas],
                changedConfigKeys: [...advance.changedConfigKeys],
                changedTests: [...advance.changedTests],
                changedServices: [...advance.changedServices],
                reason:
                  "canonical advanced while this plan was being written",
              },
            }),
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
            grants: summariseGrants(grants),
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
  const alreadySplit = await wasPartiallyAdmitted(store, task.id);
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

  const attemptBudget = maxAdmissionAttempts(
    configuredRepositoryParallelism(),
  );
  for (let attempt = 1; attempt <= attemptBudget; attempt += 1) {
    const executing = await executingPlans(store, lease);
    // A plan admitted through the solo fast path was stored as declared —
    // nothing existed to arbitrate it against, so nothing enriched it. This
    // candidate is that something. Enrichment and grounding are deterministic
    // functions of plan and index, so computing them now yields exactly what
    // full admission would have stored, and the comparison loses nothing to
    // the fast path having skipped it.
    let active = executing.active.map((entry) =>
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

    // A repository-wide claim is narrowed here, on arrival, before anything is
    // decided against it.
    //
    // Without this the answer was foregone: a blanket claim covers every path,
    // so `claimBlocked` refused whatever this plan said and the holder was
    // never asked anything. The pieces to ask it were all present and all
    // unreachable — a remote holder publishes itself into the same registry a
    // local one does, and its heartbeat beats faster while a claim is held
    // precisely so it can carry an ask — but the ask is armed by asking, and
    // the only caller that asks lives on the local coordinator's admission
    // path. So the heartbeat delivered nothing, every time, and an arrival
    // waited for a poll that had no reason to fire.
    //
    // The narrowing is the local path's own, called rather than copied: the
    // ask, its bound, the freeze that covers a holder which will not answer,
    // and the compare-and-swap that makes a lost race harmless all come with
    // it. `leaseIdForTask` is empty deliberately — the holder is not a task
    // this process is executing, which is the arrival's case the freeze
    // already handles by finding the lease itself.
    //
    // Answering `undefined` leaves the claim whole and this plan sequenced,
    // which is exactly today's behaviour and the right one: a holder that
    // cannot be read or is still answering has not said anything that would
    // make it safe to admit somebody into its files.
    const blanket = active.find((entry) => isBlanketClaim(entry.plan));
    if (blanket !== undefined && blanket.plan.expectedFiles.length > 0) {
      const narrowed = await new LeasePlanAuthority({
        store,
        leaseIdForTask: new Map(),
        repositories,
        intelligence,
        admissions,
      })
        .narrowBlanketHolder(
          blanket,
          baseVersion,
          repository,
          // What this arrival is asking for. A file the holder only guessed at
          // and has never written to is released to it here rather than held
          // for the rest of the holder's run.
          uniqueRepositoryPaths(plan.expectedFiles),
          task.projectId,
        )
        .catch(() => undefined);
      if (narrowed !== undefined) {
        active = active.map((entry) =>
          entry.taskId === blanket.taskId ? narrowed : entry,
        );
      }
    }

    const decided = admissions.admit({
      plan,
      agentId: task.agentId,
      baseRevision: baseVersion.revision,
      baseVersion: baseVersion.sequence,
      active,
      // A task that already exists because an earlier admission was partial is
      // decided whole. One split per lineage is what stops a task from shedding
      // scope round after round, each round paying for another agent run.
      partialAdmission:
        !isDeferredScopeFollowUp(task.objective) && !alreadySplit,
      // The same index that enriched this plan is what can say which of the
      // enriched claims came from which file, so a withheld file takes its own
      // symbols with it instead of leaving them to block the remainder.
      resourcesInFile: (file) => intelligence.resourcesInFile(index, file),
      // And where those symbols live, so one can be withheld while the file
      // holding it is granted — the index is built at the base revision, which
      // is the coordinate system a diff hunk's old side is measured in.
      symbolRangesInFile: (file) =>
        intelligence.symbolRangesInFile(index, file),
      // The same index also grounds what each plan *says* it wants, which is
      // the only reading available against a plan whose declarations verified
      // as fiction. This evidence is advisory and cannot reach `sequence` or
      // `block`; at most it asks a human to look. It is switched on ahead of
      // the live validation that would justify it, and
      // `COORD_DISABLE_INTENT_GROUNDING=1` turns it back off — see
      // docs/benchmarks/intent-grounding-wired.md.
      intentAssessment: groundedIntentAssessor(index),
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
        grants: summariseGrants(admission.ownershipGrants),
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
      grants: summariseGrants(admission.ownershipGrants),
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
/**
 * Lets go of a remote holder the moment its lease stops being one.
 *
 * Called on every way a lease ends rather than only the happy one: a holder
 * left published is a holder an arrival can pause, and pausing a task that
 * finished five minutes ago is a network round trip to nobody. Harmless for a
 * task that never held a claim, which is what lets every settle path call it
 * without first asking.
 */
function letGoOfClaim(taskId: string): void {
  releaseRemoteHolder(taskId);
}

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

  // A question ends here, before everything below it.
  //
  // The whole apparatus that follows — plan admission, exact-base
  // integration, the changeset, validation, canonical advance — exists to
  // land an edit safely. A question produced no edit. There is nothing to
  // admit, nothing to integrate, and no revision to pin, so a question that
  // fell through would be rejected for having no admitted plan: an answer the
  // agent really did compute, refused for missing paperwork it was never
  // asked to file.
  //
  // Failures still take the ordinary path below, which is deliberate: "the
  // model could not answer" and "the task failed" want the same lease
  // bookkeeping, and the gateway is what turns either into a sentence.
  if (task.kind === "question" && input.status === "completed") {
    const answer = (input.answer ?? "").trim();
    if (answer.length === 0) {
      // Nothing to post, so this is a failure and not a silent success. The
      // alternative is an empty message in a thread where somebody asked, and
      // the adapters make it worse than empty: with no explanation they fall
      // back to "<agent> completed <objective>", and a question's objective
      // *is* the asker's own sentence handed back to them.
      return await rejectWorkerResult(
        store,
        leaseAtStart,
        "The agent answered with nothing",
      );
    }
    letGoOfClaim(task.id);
    const settled = await store.finishWorkLease(
      input.leaseId,
      "completed",
      now,
    );
    if (!settled) {
      await store.expireWorkLeases(now);
      return { accepted: false, reason: "lease was lost before the answer" };
    }
    // `integrated` rather than a status of its own: the row is finished and
    // every sweep that looks for unfinished work should stop seeing it. What
    // landed was an answer rather than a commit, which is the gateway's
    // business to post, not the queue's to model.
    await store.completeSubmittedTask(task.id, "integrated");
    // The event for work that succeeds by changing nothing, which is what its
    // own documentation says it is for — an audit, a summary. An answer is
    // the same shape: a real result with no patch behind it, and recording it
    // as `task_failed` is exactly the mistake that event exists to prevent.
    await trace(store, undefined, "task_reported", task.id, {
      projectId: task.projectId,
      repositoryId: task.repositoryId,
      workerId: leaseAtStart.workerId,
      leaseId: leaseAtStart.id,
      kind: "question",
    });
    return { accepted: true, answer };
  }

  if (input.status === "failed") {
    letGoOfClaim(task.id);
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
      // `error`, not `detail`, and the difference was the whole bug. Every
      // other emitter of this event records `error` or `explanation`, and the
      // narration reads exactly those two — so a failure reported by a remote
      // worker arrived with its reason under a key nothing looks at, and the
      // room was told "I could not finish this." with nothing after it.
      //
      // That is every failure on a deployment which has moved execution onto
      // people's machines, because there a worker reports all of them.
      error: input.detail ?? "worker reported failure",
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

  // A partial admission is useful only if its free portion can make progress
  // independently. An empty granted changeset proves that it could not —
  // whether the agent obeyed the constraint and wrote nothing, or wrote only
  // to withheld files. Return the original task at full scope so its next
  // admission waits for the holders instead of reporting an empty success.
  if (
    split.granted.patches.length === 0 &&
    planAdmissionPartial(admitted.admission)
  ) {
    return await requeueForDeferredScope(
      store,
      leaseAtStart,
      task,
      admitted.admission,
      split,
    );
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
    ...(task.context === undefined ? {} : { context: task.context }),
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
  // Both remainders, not one. A result can leave two different kinds of work
  // behind — the scope admission deferred, and the hunks a conflict held back
  // — and they are independent: neither implies the other, and a result that
  // produces both must queue both.
  const followUps: string[] = [];
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
      // The same set with each file's status, which is what a thread hangs its
      // "N files changed" summary off. `files` stays bare paths because the
      // channel narration reads it that way and says them in a sentence.
      //
      // The gateway has documented this field as the authoritative final list
      // since the summary was written, and nothing ever emitted it — so the
      // only shape that ever reached a thread was the live one the coordinator
      // polls out mid-run, which exists only while the run is being watched.
      // That is why a finished task could end up with no list at all.
      changedFiles: summariseChangedFiles(promoted.patches),
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
    let approvedBy: string | undefined;
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
      // Captured for the commit's trailer block: who let this into canonical
      // is part of why the commit exists, and the approval record lives in a
      // database the repository does not travel with.
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
      approvedBy = review.request.decidedBy;
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
    letGoOfClaim(task.id);
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
        author: agentCommitIdentity(task.agentId),
        trailers: [
          { key: "Agent", value: task.agentId },
          ...(approvedBy === undefined
            ? []
            : [{ key: "Approved-By", value: approvedBy }]),
          // A partial admission means canonical is receiving only part of
          // what the agent wrote, with the rest requeued. A reader comparing
          // this commit against the task would otherwise find it short.
          ...(split.deferred.length === 0
            ? []
            : [
                {
                  key: "Partial-Admission",
                  value: `${split.granted.patches.length} of ${
                    split.granted.patches.length + split.deferred.length
                  } file(s) granted; deferred: ${split.deferred
                    .map((patch) => patch.path)
                    .join(" ")}`,
                },
              ]),
        ],
        // One division per task, for the same reason partial admission has
        // that rule: without it a task could shed a file per round forever.
        salvageConflicts: !isDeferredScopeFollowUp(task.objective),
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
    // A completed worker run does not need a diff to have a deliverable.
    // Answers, audits, reviews and platform actions may all leave canonical
    // untouched, and guessing intent from the objective made successful work
    // fail whenever the wording fell outside the heuristic. Execution errors
    // are reported by the worker as failures before this integration result.
    const reported = integration.status === "empty";
    const successful = integration.status === "integrated" || reported;
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
        // Stamped for the same reason `changeset_collected` above stamps it:
        // a reader of the log has the task id but no cheap way back to the
        // repository, and anything watching canonical *per repository* — the
        // auditor — cannot filter without it. `AuditEventFilter` has no
        // repository term, so this field is the only thing standing between
        // "canonical moved" and knowing where.
        repositoryId: task.repositoryId,
        previousRevision: integration.previousVersion.revision,
        revision: integration.canonicalVersion.revision,
        changeSetId: integration.changeSetId,
        // The agent's own account of what it did. The channel narration has
        // read this field since it learned to prefer the agent's words over
        // "Done — the change is in canonical", and nothing ever wrote it — so
        // every promotion fell through to the canned line and every task
        // ended identically. The account has existed since `collectChanges`;
        // it was simply never put on the one event the narration reads.
        agentExplanation: promoted.agentExplanation,
      });
      // Only now, with the granted half durably in canonical, is the deferred
      // half turned into work of its own. Queueing it earlier would leave a
      // task asking for the remainder of something that never landed.
      const deferredFollowUp = await queueDeferredScope(
        store,
        run.id,
        task,
        admitted.admission,
        split,
        changeSet,
      );
      if (deferredFollowUp !== undefined) {
        followUps.push(deferredFollowUp);
      }
      // Same rule for the half a conflict held back: only once the rest is
      // durably in canonical is the remainder worth asking anyone for.
      //
      // Asked unconditionally, which it was not. This read `followUp ??=`, so
      // whenever admission had deferred anything the salvage call never ran at
      // all — and it is the only place the salvaged hunks are requeued and the
      // only emitter of their `changeset_withheld` audit event. The patches
      // were dropped: the task was marked integrated, the handoff listed only
      // the admission-deferred paths, `saveIntegration` has no column for the
      // salvaged set, and the explanation still said how many were "requeued"
      // when none had been.
      //
      // Both preconditions are contention-only, so at parallelism 1 this could
      // not happen and the in-process coordinator — which queues both
      // unconditionally, and whose comment asserts this path already did —
      // never diverged visibly.
      const salvagedFollowUp = await queueSalvagedConflict(
        store,
        run.id,
        task,
        integration.salvagedDeferred ?? [],
        changeSet,
      );
      if (salvagedFollowUp !== undefined) {
        followUps.push(salvagedFollowUp);
      }
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
    } else if (reported) {
      const explanation =
        changeSet.agentExplanation.trim().length > 0
          ? changeSet.agentExplanation.trim()
          : "Reported without changing any files.";
      await store.saveTaskStatus(run.id, task.id, "integrated", explanation);
      await store.completeSubmittedTask(task.id, "integrated", run.id);
      await trace(store, run.id, "task_reported", task.id, {
        projectId: task.projectId,
        repositoryId: task.repositoryId,
        explanation,
      });
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
        followUpTaskIds: [...followUps],
        withheldFiles: split.deferred.map((patch) => patch.path).sort(),
        reason:
          !successful
            ? "failed"
            : integration.status === "integrated" &&
                (planAdmissionPartial(admitted.admission) ||
                  split.deferred.length > 0)
              ? "partially_completed"
              : "completed",
        ...(successful
          ? {}
          : { failure: integration.explanation }),
      }),
      { runId: run.id },
    ).catch(() => undefined);
    await store.finishRun(
      run.id,
      successful ? "completed" : "failed",
      integration.canonicalVersion,
    );
    runFinished = true;
    return {
      accepted: successful,
      ...(successful
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

/**
 * Convenience binding for a project-hosted control plane.
 *
 * The optional `shared` argument is how a hosting process hands in services
 * that are worth keeping for its lifetime — above all the code intelligence
 * one, whose index cache is keyed on `(repository path, revision)` and so is
 * useless on an instance that is rebuilt per call. Omitted, this constructs
 * its own exactly as it always did, which is what the bare CLI and the tests
 * rely on.
 */
export function workerOperations(
  project: CoordinatorProject,
  store: CoordinationStore,
  shared: {
    repositories?: RepositoryService;
    intelligence?: CodeIntelligenceService;
    /**
     * The credential store's sealer, so a lease can open the project's MCP
     * secrets. The hosting web process passes the same one it gives the
     * gateway that seals them; a process that passes none never attaches a
     * server, whatever the table holds.
     */
    sealer?: SecretSealer;
  } = {},
) {
  const repositories = shared.repositories ?? new RepositoryService();
  const worktrees = new GitWorktreeWorkspaceManager(
    repositories.getGitClient(),
  );
  const sandboxOptions = project.sandboxOptions();
  const workspaces: WorkspaceManager =
    sandboxOptions === undefined
      ? worktrees
      : new DockerWorkspaceManager(sandboxOptions, worktrees);
  const intelligence =
    shared.intelligence ?? new CodeIntelligenceService(repositories);
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
      repositories?: ReadonlySet<string>;
      kinds?: readonly TaskKind[];
      protocolVersion?: number;
    }) =>
      await leaseWork(
        store,
        input,
        repositories,
        project,
        shared.sealer === undefined ? {} : { sealer: shared.sealer },
      ),
    leaseBundle: async (leaseId: string, have?: string) =>
      await leaseBundle(store, leaseId, repositories, have),
    claimHeartbeat: async (input: {
      leaseId: string;
      workingChanges?: unknown;
    }): Promise<Record<string, unknown>> => {
      const lease = await store.getWorkLease(input.leaseId);
      const held = lease?.plan?.plan;
      if (lease === undefined || held === undefined) {
        return {};
      }
      const reported = parseWorkingChanges(input.workingChanges);
      if (reported !== undefined) {
        rememberWorkingChanges(lease.taskId, reported);
      }
      if (!isBlanketClaim(held)) {
        // The claim became an ordinary plan while this holder was working, and
        // the holder does not know. Told here, because a holder that is not
        // told goes on believing it has the repository and goes on telling its
        // agent so — the same fault the in-process poll exists to prevent, at
        // a distance.
        return { narrowedPlan: held };
      }
      const askId = askToDeliver(lease.taskId);
      return {
        // Beaten faster while a claim is held, so an arrival's window onto
        // this holder is ten seconds wide rather than sixty. Nothing else is
        // paced by it, and an idle claim costs six cheap calls a minute
        // against a lease that is already open.
        heartbeatIntervalMs: CLAIM_HEARTBEAT_INTERVAL_MS,
        ...(askId === undefined ? {} : { declareScope: { askId } }),
      };
    },
    settleClaimDeclaration: async (input: {
      leaseId: string;
      askId: string;
      declaration?: unknown;
      workingChanges?: unknown;
    }): Promise<boolean> => {
      const lease = await store.getWorkLease(input.leaseId);
      if (lease === undefined) {
        return false;
      }
      const declared = input.declaration;
      return settleDeclaration(
        lease.taskId,
        input.askId,
        typeof declared === "object" && declared !== null
          ? (declared as { files: readonly string[]; symbols: readonly string[] })
          : undefined,
        parseWorkingChanges(input.workingChanges),
      );
    },
    claimWorkRepository: async (input: {
      leaseId: string;
      actorId: string;
      protocolVersion: number;
    }) =>
      await claimWorkRepository(
        store,
        { leaseId: input.leaseId, protocolVersion: input.protocolVersion },
        { repositories, intelligence },
      ),
    admitWorkPlan: async (input: WorkPlanInput) => {
      const lease = await store.getWorkLease(input.leaseId);
      const key = lease?.repositoryId ?? input.leaseId;
      // Build the repository index *before* queueing behind the other
      // admissions for this repository.
      //
      // Admission is serialised per repository because it is a read-decide-
      // write against the executing set, and that serialisation is the
      // safety property — it is not touched here. But indexing is read-only
      // work against one fixed revision, and it was sitting inside the
      // critical section, so every waiting submission paid for the one in
      // front of it to finish indexing before its own decision could start.
      //
      // The index is cached on `(repository path, revision)`, so warming it
      // here means the call inside `admitWorkPlan` is a cache hit against the
      // identical key. A revision that moves produces a different key and a
      // fresh build, exactly as before: this cannot serve a stale index, and
      // a failure to warm is ignored because the real build is still there.
      if (lease !== undefined) {
        const stored = await store.getRepository(lease.repositoryId);
        if (stored !== undefined) {
          await intelligence
            .index(
              {
                id: stored.id,
                path: stored.path,
                branch: stored.branch,
              },
              lease.baseRevision,
            )
            .catch(() => undefined);
        }
      }
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
    editorWork: {
      take: async (input: {
        actorId: string;
        organizationId: string;
        projectId: string;
        repositoryIds: readonly string[];
        vendor: string;
        label: string;
        taskId?: string;
      }) => {
        const taken = await takeEditorWork(store, input, repositories, project);
        return taken === undefined
          ? undefined
          : {
              leaseId: taken.leaseId,
              taskId: taken.task.id,
              objective: taken.task.objective,
              repositoryId: taken.task.repositoryId,
              branch: taken.repository.branch,
              baseRevision: taken.baseRevision,
              baseVersion: taken.baseVersion,
              expiresAt: taken.expiresAt,
              // Flattened to the line somebody would type. The tool prints
              // these for an agent to run, and a structured triple would have
              // to be reassembled by a model that can only guess at quoting.
              validationCommands: taken.task.validationCommands.map(
                (command) =>
                  [command.executable, ...command.args].join(" ").trim(),
              ),
            };
      },
      // Queued behind the same per-repository chain admission uses, and for
      // the same reason: this path admits a plan too, and two of them
      // deciding against the same executing set at once is exactly what that
      // serialisation exists to prevent.
      report: async (input: {
        leaseId: string;
        actorId: string;
        status: "completed" | "failed" | "released";
        patches: readonly FilePatch[];
        summary: string;
        detail?: string;
      }) => {
        const lease = await store.getWorkLease(input.leaseId);
        const key = lease?.repositoryId ?? input.leaseId;
        const run = async () =>
          await reportEditorWork(store, input, services);
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
      extend: async (input: { leaseId: string; ttlMs: number }) =>
        await extendEditorWork(store, input),
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
