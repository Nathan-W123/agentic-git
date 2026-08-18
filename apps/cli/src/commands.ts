import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexAdapter } from "@coord/adapter-codex";
import { GenericCliAdapter } from "@coord/adapter-generic-cli";
import {
  PROMPT_CLI_EFFORTS,
  createClaudeAdapter,
  createGeminiAdapter,
  type PromptCliEffort,
} from "@coord/adapter-prompt-cli";
import type { AgentAdapter } from "@coord/agent-protocol";
import {
  Coordinator,
  ConversationRegistry,
  TaskCancellationRegistry,
  approvalPolicyForProject,
  type ActionAuthority,
  type CoordinatedTask,
  type PlanAuthority,
  type QuestionController,
} from "@coord/coordinator";
import type {
  CoordinationStore,
  StoredRepository,
  SubmittedTask,
  WorkLease,
} from "@coord/persistence";
import { DEFAULT_ORGANIZATION_ID, DEFAULT_PROJECT_ID } from "@coord/persistence";
import {
  normalizeGitHubRepository,
  RepositoryService,
  sanitizeChildEnv,
  type CanonicalRepository,
} from "@coord/repository-service";
import type { TaskDefinition } from "@coord/shared-types";
import {
  DockerWorkspaceManager,
  GitWorktreeWorkspaceManager,
  type CredentialHome,
  type UserCredentialStore,
  type VendorCliKind,
  type WorkspaceManager,
  type WorkspaceSandbox,
} from "@coord/workspace-manager";

import { LeasePlanAuthority } from "./lease-admission.js";
import type { AgentConfig, CoordinatorProject } from "./project.js";
import {
  configuredRepositoryParallelism,
  WORK_LEASE_TTL_MS,
} from "./worker-operations.js";

/** Name the in-process runner registers itself under, and finds itself by. */
const LOCAL_RUNNER_WORKER_NAME = "in-process-runner";

/**
 * Heartbeat interval for the leases a local run holds.
 *
 * A fifth of the TTL, so four consecutive missed beats are survivable before
 * a lease that is genuinely still being worked on is reaped out from under it.
 */
const LOCAL_LEASE_HEARTBEAT_MS = WORK_LEASE_TTL_MS / 5;

/**
 * How long a conversation may wait for its next message before it is over.
 *
 * Six hours, deliberately the same span the gateway treats a thread as
 * current for (`THREAD_MERGE_MAX_AGE_MS`): a reply inside the window
 * continues the conversation, a reply after it starts an ordinary task in
 * the same thread — the two clocks describing "is this still going on"
 * should not disagree with each other.
 *
 * A deployment whose people work to a different rhythm sets
 * COORD_OPEN_CONVERSATION_MAX_AGE_MS.
 */
const OPEN_CONVERSATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * The configured span, or the default above.
 *
 * Read per sweep rather than once at module load so a control plane that is
 * reconfigured and restarted picks the new value up wherever it is set, and
 * so a test can state the deadline it means. A value that is not a
 * whole number of milliseconds is refused rather than ignored: silently
 * sweeping on the default would end conversations an operator believed they
 * had kept open.
 */
function openConversationMaxAgeMs(): number {
  const raw = process.env["COORD_OPEN_CONVERSATION_MAX_AGE_MS"]?.trim() ?? "";
  if (raw.length === 0) {
    return OPEN_CONVERSATION_MAX_AGE_MS;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      "COORD_OPEN_CONVERSATION_MAX_AGE_MS must be a non-negative integer",
    );
  }
  return value;
}

/**
 * The worker record this process leases work under, if one can be had.
 *
 * A lease belongs to a worker, a worker belongs to a user, and a deployment
 * that has never had a user has nobody to attribute one to. That is a real
 * configuration — a bare CLI project, a benchmark fixture — and it must keep
 * running, so this answers `undefined` rather than throwing and the caller
 * degrades to the unarbitrated path with a warning.
 */
async function localRunnerWorkerId(
  store: CoordinationStore,
): Promise<string | undefined> {
  const existing = (
    await store.listWorkers({ organizationId: DEFAULT_ORGANIZATION_ID })
  ).find((worker) => worker.name === LOCAL_RUNNER_WORKER_NAME);
  if (existing !== undefined) {
    return existing.id;
  }
  const [owner] = await store.listUsers();
  if (owner === undefined) {
    return undefined;
  }
  const worker = await store.registerWorker({
    userId: owner.id,
    organizationId: DEFAULT_ORGANIZATION_ID,
    name: LOCAL_RUNNER_WORKER_NAME,
    // Leases are taken by explicit task id rather than by polling for
    // compatible work, so this list is a description of the process rather
    // than a filter anything matches against.
    adapters: ["generic-cli", "claude", "codex", "gemini"],
    version: "in-process",
  });
  return worker.id;
}

/**
 * Claims this repository's queued work, holding a durable lease per task.
 *
 * The lease is what makes a task visible to everything else running in the
 * same repository: plan admission arbitrates against the plans recorded on
 * active leases, so a runner that claims work without leasing it is invisible
 * to arbitration and blind to it. That was true of this path until now, and it
 * is why two dispatches could both be admitted for the same file.
 *
 * Returns `undefined` when no worker identity is available, which tells the
 * caller to fall back to claiming without leases.
 */
async function leaseQueuedWork(
  store: CoordinationStore,
  input: {
    workerId: string;
    repositoryId: string;
    projectId: string;
    baseRevision: string;
  },
): Promise<Array<{ task: SubmittedTask; lease: WorkLease }>> {
  const leased: Array<{ task: SubmittedTask; lease: WorkLease }> = [];
  // One at a time, because each lease changes what the next call may take:
  // the repository parallelism bound is counted across active leases, so
  // asking for everything at once would ignore it.
  for (;;) {
    const next = await store.leaseNextTask({
      workerId: input.workerId,
      repositoryId: input.repositoryId,
      projectId: input.projectId,
      baseRevision: input.baseRevision,
      ttlMs: WORK_LEASE_TTL_MS,
      repositoryParallelism: configuredRepositoryParallelism(),
    });
    if (next === undefined) {
      return leased;
    }
    leased.push({ task: next.task, lease: next.lease });
  }
}

/** Registered repositories are addressed by a short, filesystem-safe id. */
function assertRepositoryId(id: string): string {
  if (id.length > 80 || !/^[a-z0-9][a-z0-9._-]*$/iu.test(id)) {
    throw new Error(
      `Repository id must be at most 80 characters, start alphanumeric, and ` +
        `contain only letters, digits, dot, dash, or underscore: ${id}`,
    );
  }
  return id;
}

/**
 * Which adapters authenticate through a vendor CLI login, and so can be
 * pointed at a specific user's account.
 */
const VENDOR_ADAPTERS: Partial<Record<string, VendorCliKind>> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
};

function toCanonical(repository: StoredRepository): CanonicalRepository {
  return {
    id: repository.id,
    path: repository.path,
    branch: repository.branch,
  };
}

export interface RepoAddOptions {
  sourcePath: string;
  id?: string;
  branch?: string;
  projectId?: string;
  setDefault?: boolean;
  /** The authenticated caller creating this repository, if there is one. */
  createdBy?: string;
}

export interface RepoCreateOptions {
  id: string;
  branch?: string;
  projectId?: string;
  setDefault?: boolean;
  /** The authenticated caller creating this repository, if there is one. */
  createdBy?: string;
}

export interface RepoRemoveOptions {
  id: string;
}

/**
 * Creates a greenfield canonical repository with an empty initial commit.
 *
 * The temporary working repository exists only long enough for `repoAdd` to
 * produce the canonical bare mirror. No host working tree is retained.
 */
export async function repoCreate(
  project: CoordinatorProject,
  store: CoordinationStore,
  options: RepoCreateOptions,
): Promise<StoredRepository> {
  const id = assertRepositoryId(options.id);
  const sourcePath = await mkdtemp(path.join(os.tmpdir(), "coord-greenfield-"));
  try {
    return await repoAdd(project, store, {
      sourcePath,
      id,
      ...(options.branch === undefined ? {} : { branch: options.branch }),
      ...(options.projectId === undefined
        ? {}
        : { projectId: options.projectId }),
      ...(options.setDefault === undefined
        ? {}
        : { setDefault: options.setDefault }),
      ...(options.createdBy === undefined
        ? {}
        : { createdBy: options.createdBy }),
    });
  } finally {
    await rm(sourcePath, { recursive: true, force: true });
  }
}

/**
 * Removes both halves of a registered repository: its canonical mirror and
 * its persisted coordination state.
 *
 * The mirror is moved out of its name before the store is changed. That makes
 * the original name immediately reusable once persistence deletion succeeds,
 * while still allowing the mirror to be put back if that deletion fails.
 */
export async function repoRemove(
  project: CoordinatorProject,
  store: CoordinationStore,
  options: RepoRemoveOptions,
): Promise<void> {
  const id = assertRepositoryId(options.id);
  const repository = await store.getRepository(id);
  if (repository === undefined) {
    throw new Error(`Unknown repository: ${id}`);
  }

  const repositoriesPath = path.resolve(project.repositoriesPath);
  const canonicalPath = path.resolve(repository.path);
  if (path.dirname(canonicalPath) !== repositoriesPath) {
    throw new Error(
      `Refusing to remove repository outside ${repositoriesPath}: ${canonicalPath}`,
    );
  }

  const retiredPath = path.join(
    repositoriesPath,
    `.${id}.deleting-${randomUUID()}`,
  );
  let mirrorMoved = false;
  try {
    await rename(canonicalPath, retiredPath);
    mirrorMoved = true;
  } catch (error) {
    // A stale registration whose mirror is already gone should still be
    // removable; clearing it is what lets the same id be created again.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  try {
    await store.removeRepository(id);
  } catch (error) {
    if (mirrorMoved) {
      try {
        await rename(retiredPath, canonicalPath);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Repository deletion and canonical mirror restoration both failed for ${id}`,
        );
      }
    }
    throw error;
  }

  if (mirrorMoved) {
    await rm(retiredPath, { recursive: true, force: true });
  }
}

/**
 * Imports a working repository as a canonical bare mirror.
 *
 * The mirror lives inside the project so the canonical state is never the
 * developer's own working tree, which must stay free to change independently.
 */
export async function repoAdd(
  project: CoordinatorProject,
  store: CoordinationStore,
  options: RepoAddOptions,
): Promise<StoredRepository> {
  const sourcePath = path.resolve(options.sourcePath);
  const id = assertRepositoryId(
    options.id ?? path.basename(sourcePath).toLowerCase(),
  );

  if ((await store.getRepository(id)) !== undefined) {
    throw new Error(
      `A repository named ${id} is already registered. Pass --id to choose another name.`,
    );
  }

  const branch = options.branch ?? "main";
  const destination = path.join(project.repositoriesPath, `${id}.git`);
  await mkdir(project.repositoriesPath, { recursive: true });

  const repositories = new RepositoryService();
  const previousDefault = project.config.defaultRepository;
  let imported = false;
  let registered = false;
  try {
    const canonical = await repositories.importLocalRepository(
      sourcePath,
      destination,
      id,
      branch,
    );
    imported = true;

    const stored: StoredRepository = {
      id: canonical.id,
      path: canonical.path,
      branch: canonical.branch,
      ...(options.createdBy === undefined
        ? {}
        : { createdBy: options.createdBy }),
    };
    const version = await repositories.getCanonicalVersion(canonical);
    await store.saveRepository(stored);
    registered = true;
    await store.linkRepository(options.projectId ?? DEFAULT_PROJECT_ID, stored.id);
    await store.saveCanonicalVersion(stored.id, version);

    if (
      options.setDefault === true ||
      project.config.defaultRepository === undefined
    ) {
      project.config.defaultRepository = stored.id;
      await project.save();
    }

    return stored;
  } catch (error) {
    if (previousDefault === undefined) {
      delete project.config.defaultRepository;
    } else {
      project.config.defaultRepository = previousDefault;
    }
    const cleanupErrors: unknown[] = [];
    let registrationRemoved = !registered;
    if (registered) {
      try {
        await store.removeRepository(id);
        registrationRemoved = true;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (imported && registrationRemoved) {
      try {
        await rm(path.resolve(destination), { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Repository registration and rollback both failed for ${id}`,
      );
    }
    throw error;
  }
}

export interface GitHubRepoImportOptions {
  repository: string;
  id?: string;
  branch?: string;
  token?: string;
  projectId?: string;
  setDefault?: boolean;
  /** The authenticated caller importing this repository, if there is one. */
  createdBy?: string;
}

/** Imports a public or token-authenticated GitHub repository as canonical. */
export async function repoImportGitHub(
  project: CoordinatorProject,
  store: CoordinationStore,
  options: GitHubRepoImportOptions,
): Promise<StoredRepository> {
  const remoteUrl = normalizeGitHubRepository(options.repository);
  const remotePath = new URL(
    remoteUrl.startsWith("git@")
      ? `https://github.com/${remoteUrl.slice("git@github.com:".length)}`
      : remoteUrl,
  ).pathname.replace(/\.git$/u, "");
  const inferred = remotePath.split("/").filter(Boolean).at(-1) ?? "repository";
  const id = assertRepositoryId(options.id ?? inferred.toLowerCase());
  if ((await store.getRepository(id)) !== undefined) {
    throw new Error(
      `A repository named ${id} is already registered. Pass --id to choose another name.`,
    );
  }

  const destination = path.join(project.repositoriesPath, `${id}.git`);
  await mkdir(project.repositoriesPath, { recursive: true });
  const repositories = new RepositoryService();
  const previousDefault = project.config.defaultRepository;
  let imported = false;
  let registered = false;
  try {
    const canonical = await repositories.importRemoteRepository(
      remoteUrl,
      destination,
      id,
      {
        ...(options.branch === undefined ? {} : { branch: options.branch }),
        ...(options.token === undefined
          ? {}
          : { credentials: { token: options.token } }),
      },
    );
    imported = true;
    const stored: StoredRepository = {
      id: canonical.id,
      path: canonical.path,
      branch: canonical.branch,
      provider: "github",
      remoteUrl,
      ...(options.createdBy === undefined
        ? {}
        : { createdBy: options.createdBy }),
    };
    const version = await repositories.getCanonicalVersion(canonical);
    await store.saveRepository(stored);
    registered = true;
    await store.linkRepository(options.projectId ?? DEFAULT_PROJECT_ID, stored.id);
    await store.saveCanonicalVersion(stored.id, version);
    if (
      options.setDefault === true ||
      project.config.defaultRepository === undefined
    ) {
      project.config.defaultRepository = stored.id;
      await project.save();
    }
    return stored;
  } catch (error) {
    if (previousDefault === undefined) {
      delete project.config.defaultRepository;
    } else {
      project.config.defaultRepository = previousDefault;
    }
    const cleanupErrors: unknown[] = [];
    let registrationRemoved = !registered;
    if (registered) {
      try {
        await store.removeRepository(id);
        registrationRemoved = true;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (imported && registrationRemoved) {
      try {
        await rm(path.resolve(destination), { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `GitHub repository registration and rollback both failed for ${id}`,
      );
    }
    throw error;
  }
}

export async function resolveRepository(
  project: CoordinatorProject,
  store: CoordinationStore,
  id: string | undefined,
): Promise<StoredRepository> {
  const resolved = id ?? project.config.defaultRepository;
  if (resolved === undefined) {
    throw new Error(
      "No repository specified and no default is set. Run `coord repo add <path>` first.",
    );
  }

  const repository = await store.getRepository(resolved);
  if (repository === undefined) {
    const known = (await store.listRepositories()).map((entry) => entry.id);
    throw new Error(
      `Unknown repository: ${resolved}.` +
        (known.length === 0
          ? " None are registered."
          : ` Registered: ${known.join(", ")}.`),
    );
  }
  return repository;
}

export interface TaskSubmitOptions {
  objective: string;
  repositoryId?: string;
  projectId?: string;
  agentId?: string;
  submittedBy?: string;
  /** Do not lease this task until the referenced task is no longer active. */
  afterTaskId?: string;
  /** Atomically queue after this agent owner's latest unfinished task. */
  queueAfterCurrent?: boolean;
  /**
   * Background for the agent that will run this, kept out of the objective
   * (which is rendered wherever the request is shown). Set by the channel
   * dispatcher with the thread the request was asked inside; see
   * `SubmitTaskInput.context` in the persistence store.
   */
  context?: string;
  /**
   * The conversation this task is one turn of. See
   * `SubmitTaskInput.conversationId` in the persistence store.
   */
  conversationId?: string;
  /**
   * File this as held rather than queued. See `SubmitTaskInput.planOnly` in
   * the persistence store.
   */
  planOnly?: boolean;
  /**
   * Per-task overrides of the agent's configured model / reasoning level. See
   * `SubmitTaskInput.model` in the persistence store.
   */
  model?: string;
  effort?: string;
}

export async function taskSubmit(
  project: CoordinatorProject,
  store: CoordinationStore,
  options: TaskSubmitOptions,
): Promise<SubmittedTask> {
  if (options.objective.trim().length === 0) {
    throw new Error("A task needs a non-empty --objective");
  }

  const repository = await resolveRepository(
    project,
    store,
    options.repositoryId,
  );
  const [agentId] = project.requireAgent(options.agentId);

  return await store.submitTask({
    repositoryId: repository.id,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    objective: options.objective.trim(),
    agentId,
    validationCommands: project.config.validationCommands,
    ...(options.submittedBy === undefined
      ? {}
      : { submittedBy: options.submittedBy }),
    ...(options.afterTaskId === undefined
      ? {}
      : { afterTaskId: options.afterTaskId }),
    ...(options.queueAfterCurrent === true
      ? { queueAfterCurrent: true }
      : {}),
    ...(options.context === undefined || options.context.trim() === ""
      ? {}
      : { context: options.context.trim() }),
    ...(options.conversationId === undefined
      ? {}
      : { conversationId: options.conversationId }),
    ...(options.planOnly === true ? { planOnly: true } : {}),
    ...(options.model === undefined || options.model.trim() === ""
      ? {}
      : { model: options.model.trim() }),
    ...(options.effort === undefined || options.effort.trim() === ""
      ? {}
      : { effort: options.effort.trim() }),
  });
}

export async function taskRetry(
  store: CoordinationStore,
  taskId: string,
): Promise<SubmittedTask> {
  if (taskId.trim().length === 0) {
    throw new Error("A task id is required");
  }
  return await store.retrySubmittedTask(taskId);
}

export async function taskCancel(
  store: CoordinationStore,
  taskId: string,
): Promise<SubmittedTask> {
  if (taskId.trim().length === 0) {
    throw new Error("A task id is required");
  }
  return await store.cancelSubmittedTask(taskId);
}

export interface CancelTasksInput {
  repositoryId: string;
  projectId?: string;
  /** Stop exactly these tasks. Wins over `agentId` when both are given. */
  taskIds?: string[];
  /** Stop every active task dispatched to this agent. */
  agentId?: string;
  /**
   * Stop only tasks this person submitted, narrowing `agentId`. A channel
   * persona is an (owner, vendor) pair, but every persona of one vendor
   * resolves to the same configured agent — so an `agentId` sweep alone
   * takes other people's same-vendor work with it, which is exactly how
   * "/stop @agent" once stopped everyone's tasks.
   */
  submittedBy?: string;
  /** Why, in the canceller's words — recorded on the lease and the audit. */
  reason: string;
  /** Who asked, for the audit trail. */
  actorId?: string;
  /** The live-run bridge; absent on a bare CLI, where nothing is running. */
  cancellations?: TaskCancellationRegistry;
}

export interface CancelledTaskReport {
  id: string;
  agentId: string;
  objective: string;
  /** What the task was doing when it was stopped. */
  was: "running" | "queued" | "held" | "waiting";
}

const CANCELLED_WAS: Record<string, CancelledTaskReport["was"]> = {
  claimed: "running",
  submitted: "queued",
  planned: "held",
  open: "waiting",
};

/**
 * Stops work: one task, an agent's tasks, or a whole repository's.
 *
 * One function on purpose. Cancellation used to exist three times — a store
 * flip in the thread command, a store flip behind the REST route, nothing at
 * all for a running session — and each did a different fraction of the job.
 * The whole job is four steps, in an order that closes the races:
 *
 * 1. the queue row goes `cancelled`, so nothing can lease it afresh;
 * 2. the live session, if this process holds one, is aborted through the
 *    {@link TaskCancellationRegistry};
 * 3. the active work lease, if any, is released — which is the established
 *    kill switch for a remote worker (its heartbeat answers `lease_lost`
 *    and it cancels its own session), and releases the plans arbitration
 *    was sequencing behind either way. Releasing cannot requeue the task:
 *    every store guards that on the row still being `claimed`;
 * 4. a `task_cancelled` audit event, which is what the channel narrates
 *    from — a task that stops silently is the failure mode this exists for.
 *
 * A task that settles mid-flight — integrated or failed between the listing
 * and the write — is skipped rather than fought over: its ending already
 * happened, and reporting it stopped would be a lie.
 */
export async function cancelTasks(
  store: CoordinationStore,
  input: CancelTasksInput,
): Promise<CancelledTaskReport[]> {
  const explicit = input.taskIds === undefined ? undefined : new Set(input.taskIds);
  const candidates = (
    await store.listSubmittedTasks({
      repositoryId: input.repositoryId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    })
  ).filter((task) => {
    if (CANCELLED_WAS[task.status] === undefined) {
      return false;
    }
    if (explicit !== undefined) {
      return explicit.has(task.id);
    }
    // An open conversation is not burning anything — it is a thread waiting
    // for its person to reply — so a sweep leaves it alone. Ending one is a
    // deliberate act on that one task, which is the explicit-ids shape.
    if (task.status === "open") {
      return false;
    }
    return (
      (input.agentId === undefined || task.agentId === input.agentId) &&
      (input.submittedBy === undefined ||
        task.submittedBy === input.submittedBy)
    );
  });
  if (candidates.length === 0) {
    return [];
  }

  const activeLeases = candidates.some((task) => task.status === "claimed")
    ? await store.listWorkLeases({
        repositoryId: input.repositoryId,
        status: "active",
      })
    : [];

  const reports: CancelledTaskReport[] = [];
  for (const task of candidates) {
    try {
      await store.cancelSubmittedTask(task.id);
    } catch {
      // Settled between the listing and now. Its ending already happened.
      continue;
    }
    await input.cancellations?.cancel(task.id, input.reason);
    const lease = activeLeases.find(
      (candidate) => candidate.taskId === task.id,
    );
    if (lease !== undefined) {
      await store.finishWorkLease(
        lease.id,
        "released",
        new Date().toISOString(),
        input.reason,
      );
    }
    await store.appendAudit(undefined, {
      type: "task_cancelled",
      taskId: task.id,
      data: {
        repositoryId: input.repositoryId,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        reason: input.reason,
      },
    });
    reports.push({
      id: task.id,
      agentId: task.agentId,
      objective: task.objective,
      was: CANCELLED_WAS[task.status] ?? "queued",
    });
  }
  return reports;
}

/**
 * Which sandbox Codex's edit phase runs under, with the deployment allowed
 * the last word.
 *
 * `COORD_CODEX_SANDBOX` exists because the answer is a property of the host,
 * not of the project: the same repository is correct with `workspace-write`
 * on a laptop and unrunnable with it inside a container. Codex's scoped-write
 * sandbox needs a platform helper, and where that helper is missing it does
 * not degrade gracefully — it refuses filesystem access outright, so the run
 * reports that its "repository access request was rejected" and reads
 * nothing. A container is already the isolation the sandbox would provide,
 * which is the one case the adapter documents `danger-full-access` for.
 *
 * The environment wins over the config file so an image can set it once for
 * every project it will ever run, and an unrecognised value is ignored rather
 * than failing the run — a typo in a deployment variable should not take the
 * coordinator down.
 */
export function codexExecutionSandbox(
  configured: "workspace-write" | "danger-full-access" | undefined,
): "workspace-write" | "danger-full-access" | undefined {
  const fromEnv = process.env["COORD_CODEX_SANDBOX"]?.trim();
  if (fromEnv === "workspace-write" || fromEnv === "danger-full-access") {
    return fromEnv;
  }
  return configured;
}

/**
 * The agent's configured args with a per-task model swapped in.
 *
 * Replaces rather than appends: both adapters accept only `--model <id>`
 * pairs, and prompt-cli accepts exactly one, so adding a second would throw
 * at construction instead of overriding anything.
 */
export function withModelOverride(
  args: readonly string[] | undefined,
  model: string | undefined,
): readonly string[] | undefined {
  if (model === undefined || model.trim() === "") {
    return args;
  }
  const kept: string[] = [];
  const existing = args ?? [];
  for (let index = 0; index < existing.length; index += 2) {
    const flag = existing[index];
    if (flag !== "--model" && flag !== "-m") {
      const value = existing[index + 1];
      kept.push(...(value === undefined ? [flag as string] : [flag as string, value]));
    }
  }
  return [...kept, "--model", model.trim()];
}

function createAdapter(
  agent: AgentConfig,
  agentId: string,
  repository: CanonicalRepository,
  workspaces: WorkspaceManager,
  sandbox: WorkspaceSandbox | undefined,
  planningRoot: string,
  /**
   * Replaces the inherited process environment for this one task, so the
   * vendor CLI authenticates as the task's submitter rather than as whoever
   * the host machine is logged in as. Undefined keeps the previous
   * behaviour of running under the host's own CLI login.
   */
  baseEnv: NodeJS.ProcessEnv = process.env,
  /**
   * What this one task asked to run with, from the channel that dispatched
   * it. Beats the agent's configured default, because it is the more specific
   * statement: deployment config says how this agent usually runs, and a room
   * that picked a model is saying how this request should.
   */
  override: { model?: string | undefined; effort?: string | undefined } = {},
): AgentAdapter {
  const args = withModelOverride(agent.args, override.model);
  // Config carries `effort` only on the prompt-cli agents, which is where the
  // setting has always been expressible. A per-task override reaches Codex
  // too, because the channel can now ask for one and the adapter can now
  // honour it — deployment config catching up is a separate change.
  const configuredEffort =
    agent.adapter === "claude" || agent.adapter === "gemini"
      ? agent.effort
      : undefined;
  const effort = override.effort ?? configuredEffort;
  // The agent's own env block still wins: it is deployment configuration,
  // whereas the credential environment is per task.
  const launchEnv =
    agent.env === undefined && baseEnv === process.env
      ? undefined
      : { ...baseEnv, ...(agent.env ?? {}) };

  if (agent.adapter === "codex") {
    if (sandbox !== undefined) {
      throw new Error(
        "Codex agents currently use the Codex CLI sandbox and cannot run " +
          "inside the project's Docker sandbox. The egress allowlist and " +
          "scoped credential mounts this needed now exist " +
          "(openVendorSandbox in @coord/workspace-manager); what remains is " +
          "adapter wiring, including a mount for the --output-schema file the " +
          "adapter writes to a host temp directory. See " +
          "docs/architecture/vendor-cli-sandboxing.md",
      );
    }
    const executionSandbox = codexExecutionSandbox(agent.executionSandbox);
    return new CodexAdapter({
      agentId,
      repository,
      workspaces,
      planningRoot,
      ...(agent.command === undefined ? {} : { command: agent.command }),
      ...(args === undefined ? {} : { args }),
      ...(effort === undefined ? {} : { effort }),
      ...(agent.planningTimeoutMs === undefined
        ? {}
        : { planningTimeoutMs: agent.planningTimeoutMs }),
      ...(agent.executionTimeoutMs === undefined
        ? {}
        : { executionTimeoutMs: agent.executionTimeoutMs }),
      ...(agent.windowsSandbox === undefined
        ? {}
        : { windowsSandbox: agent.windowsSandbox }),
      ...(executionSandbox === undefined ? {} : { executionSandbox }),
      ...(launchEnv === undefined ? {} : { env: launchEnv }),
    });
  }

  if (agent.adapter === "claude" || agent.adapter === "gemini") {
    if (sandbox !== undefined) {
      throw new Error(
        `${agent.adapter} agents run the vendor CLI on the host with its own ` +
          "login state and cannot run inside the project's Docker sandbox. " +
          "The egress allowlist and scoped credential mounts this needed now " +
          "exist (openVendorSandbox in @coord/workspace-manager); what remains " +
          "is adapter wiring. See docs/architecture/vendor-cli-sandboxing.md",
      );
    }
    // Refused here rather than narrowed away, because a level this CLI does
    // not take is a request that cannot be honoured, and silently running at
    // the default would answer a question about reasoning depth with a
    // different answer than the one asked for. The message names the
    // vocabulary; the channel surfaces it as "I could not start this".
    if (
      effort !== undefined &&
      !(PROMPT_CLI_EFFORTS as readonly string[]).includes(effort)
    ) {
      throw new Error(
        `Agent "${agentId}" was asked for reasoning effort "${effort}", but ` +
          `${agent.adapter} accepts ${PROMPT_CLI_EFFORTS.join(", ")}`,
      );
    }
    const promptEffort = effort as PromptCliEffort | undefined;
    const create =
      agent.adapter === "claude" ? createClaudeAdapter : createGeminiAdapter;
    return create({
      agentId,
      repository,
      workspaces,
      planningRoot,
      ...(agent.command === undefined ? {} : { command: agent.command }),
      ...(args === undefined ? {} : { args }),
      ...(agent.planningTimeoutMs === undefined
        ? {}
        : { planningTimeoutMs: agent.planningTimeoutMs }),
      ...(agent.executionTimeoutMs === undefined
        ? {}
        : { executionTimeoutMs: agent.executionTimeoutMs }),
      ...(promptEffort === undefined ? {} : { effort: promptEffort }),
      ...(launchEnv === undefined ? {} : { env: launchEnv }),
    });
  }

  if (agent.command === undefined) {
    throw new Error(
      `Agent "${agentId}" has no command; a generic-cli agent must name an executable`,
    );
  }
  return new GenericCliAdapter({
    agentId,
    launch: {
      command: agent.command,
      args: [...(agent.args ?? [])],
      env:
        sandbox === undefined
          ? { ...baseEnv, ...(agent.env ?? {}) }
          : { ...baseEnv },
    },
    repository,
    workspaces,
    planningRoot,
    ...(agent.executionTimeoutMs === undefined
      ? {}
      : { executionTimeoutMs: agent.executionTimeoutMs }),
    ...(sandbox === undefined ? {} : { sandbox }),
  });
}

export interface RunOptions {
  repositoryId?: string;
  projectId?: string;
  /**
   * Where an agent's question goes, and where its answer comes back from.
   *
   * Absent on the CLI, which has nobody watching to ask — a question there
   * is cancelled at once rather than waiting out a deadline for an answer
   * that was never coming.
   */
  questions?: QuestionController;
  /**
   * Who performs what an agent asks the platform for.
   *
   * Absent on the CLI for the same reason `questions` is: nothing here can
   * start a preview or hold one open, so an agent that asks is told plainly
   * that this deployment does nothing and carries on.
   */
  actions?: ActionAuthority;
  /**
   * Per-user vendor credentials. When supplied, a task whose submitter has
   * connected their own provider account runs under that account instead of
   * the host machine's CLI login.
   *
   * Absent — the trusted single-operator CLI, and any deployment where nobody
   * has connected an account — everything keeps running under the host login,
   * which is the previous behaviour.
   */
  credentials?: UserCredentialStore;
  /**
   * What to do when a task's submitter has no usable credential. `host-login`
   * falls back to the machine's own CLI login; `refuse` fails the task.
   *
   * A multi-tenant deployment wants `refuse`: silently charging the host
   * owner for someone else's task is the exact confusion this feature exists
   * to remove. The default stays `host-login` so existing single-operator
   * projects are unaffected.
   */
  credentialPolicy?: "host-login" | "refuse";
  /**
   * Where open conversations live between runs.
   *
   * A coordinator is built per run — its approval policy and plan authority
   * belong to that run — so conversational continuity cannot live inside
   * one. A long-lived host (the web app) makes one registry per process and
   * passes it here; every run's coordinator then reads and feeds the same
   * conversations. The CLI passes nothing: its process ends with the run,
   * and a conversation's next turn simply starts cold from the thread.
   */
  conversations?: ConversationRegistry;
  /**
   * Where a person's "stop" reaches this run's live sessions.
   *
   * Same lifecycle as `conversations`: one per process on a long-lived
   * host, shared between the API surface that hears the stop and the run
   * that holds the session. Absent on the CLI, where ^C already stops
   * everything this would.
   */
  cancellations?: TaskCancellationRegistry;
}

/**
 * Opens the credential environment a task should run under, or undefined to
 * fall back to the host's own CLI login.
 *
 * Only the vendor-CLI adapters authenticate this way. A `generic-cli` agent
 * runs an arbitrary executable whose credentials are the deployment's
 * business, so nothing is injected for it.
 */
export async function openSubmitterCredentialHome(
  agent: AgentConfig,
  task: SubmittedTask,
  options: RunOptions,
): Promise<CredentialHome | undefined> {
  // An omitted adapter means generic-cli, which authenticates however its
  // executable does and gets nothing injected.
  const vendor = VENDOR_ADAPTERS[agent.adapter ?? "generic-cli"];
  if (options.credentials === undefined || vendor === undefined) {
    return undefined;
  }

  const refuse = (reason: string): never => {
    throw new Error(
      `Task ${task.id} cannot run: ${reason}. This project requires each ` +
        `task to run under its submitter's own ${vendor} account; connect ` +
        `one in the dashboard, or set the credential policy back to ` +
        `host-login to spend the host owner's account instead.`,
    );
  };

  if (task.submittedBy === undefined) {
    // A task with no submitter predates per-user credentials or came from the
    // local CLI. There is no user to charge, so only the host login is left.
    return options.credentialPolicy === "refuse"
      ? refuse("it records no submitter")
      : undefined;
  }

  const home = await options.credentials.openCredentialHome({
    userId: task.submittedBy,
    vendor,
    baseEnv: sanitizeChildEnv(process.env),
    // A coordinator stages every task home before starting any of them. Task
    // homes therefore share the reservation; provider chat takes the
    // exclusive side and waits until the run has filed any rotated session.
    mode: "shared",
  });
  if (home === undefined) {
    return options.credentialPolicy === "refuse"
      ? refuse(`its submitter has connected no ${vendor} account`)
      : undefined;
  }
  // The store-backed home files usage and token rotation before releasing its
  // reservation. A reply waiting on the exclusive side therefore cannot read
  // between deleting the task home and storing the refreshed session.
  return home;
}

export interface RunSummary {
  repository: StoredRepository;
  claimed: SubmittedTask[];
  runId: string | undefined;
  integrated: number;
  failed: number;
  /** Stopped by a person mid-run, which is neither of the other two. */
  cancelled: number;
  finalRevision: string;
  conflicts: number;
}

/**
 * Executes every pending task for a repository through the coordinator.
 *
 * Tasks are claimed before the run starts, so a crash leaves them marked
 * `claimed` rather than returning them to the queue to be executed twice.
 */
export async function runPendingTasks(
  project: CoordinatorProject,
  store: CoordinationStore,
  options: RunOptions = {},
): Promise<RunSummary> {
  const repository = await resolveRepository(
    project,
    store,
    options.repositoryId,
  );
  const canonical = toCanonical(repository);
  const projectId = options.projectId ?? DEFAULT_PROJECT_ID;

  // Conversations whose silence has outlasted the deadline end before new
  // work starts — the sweep is opportunistic, like every lease expiry in
  // this codebase, because between turns nothing is ticking on its own. The
  // store settles the rows; the registry, when there is one, releases the
  // directories and sessions those conversations were keeping.
  const expiredConversations = await store.expireOpenTasks(
    new Date(Date.now() - openConversationMaxAgeMs()).toISOString(),
    { repositoryId: repository.id },
  );
  for (const expired of expiredConversations) {
    if (expired.conversationId !== undefined) {
      await options.conversations
        ?.endConversation(expired.conversationId)
        .catch(() => undefined);
    }
  }

  // Leases first, claims only as a fallback. A leased task is one every other
  // run in this repository can see, which is what lets plan admission decide
  // between them; a merely claimed task is invisible, and two runs holding
  // invisible claims on the same file is the whole of the bug this replaced.
  const repositoriesForLease = new RepositoryService();
  const workerId = await localRunnerWorkerId(store);
  const leases = new Map<string, WorkLease>();
  let claimed: SubmittedTask[];
  if (workerId === undefined) {
    // Said out loud rather than degraded silently: arbitration being absent
    // without anyone noticing is exactly how this went unfixed for so long.
    process.emitWarning(
      "No user account exists to register a local worker under, so this run " +
        "cannot hold work leases. Tasks will execute without cross-run plan " +
        "admission; overlapping work is caught only at integration time.",
    );
    claimed = await store.claimSubmittedTasks(repository.id, projectId);
  } else {
    const baseVersion =
      await repositoriesForLease.getCanonicalVersion(canonical);
    const leasedWork = await leaseQueuedWork(store, {
      workerId,
      repositoryId: repository.id,
      projectId,
      baseRevision: baseVersion.revision,
    });
    claimed = leasedWork.map((entry) => entry.task);
    for (const entry of leasedWork) {
      leases.set(entry.task.id, entry.lease);
    }
  }
  if (claimed.length === 0) {
    const repositories = new RepositoryService();
    const version = await repositories.getCanonicalVersion(canonical);
    return {
      repository,
      claimed,
      runId: undefined,
      integrated: 0,
      failed: 0,
      cancelled: 0,
      conflicts: 0,
      finalRevision: version.revision,
    };
  }

  // Staged outside the try so the finally can always reach them: each home
  // holds a copy of one user's credential and whatever the CLI refreshed into
  // it, and must not outlive the run whichever way the run ends.
  const credentialHomes: CredentialHome[] = [];
  // A lease that stops being renewed is reaped and its task requeued, so this
  // has to outlive every path out of the run — including the ones that throw.
  const heartbeat =
    leases.size === 0
      ? undefined
      : setInterval(() => {
          const now = Date.now();
          const at = new Date(now).toISOString();
          const expiresAt = new Date(now + WORK_LEASE_TTL_MS).toISOString();
          for (const lease of leases.values()) {
            void store
              .heartbeatWorkLease(lease.id, at, expiresAt)
              .catch(() => {
                // A missed beat is survivable; the TTL allows several. Failing
                // the run over one would be worse than the lapse it prevents.
              });
          }
        }, LOCAL_LEASE_HEARTBEAT_MS);
  heartbeat?.unref?.();
  try {
    const repositories = new RepositoryService();
    const worktrees = new GitWorktreeWorkspaceManager(
      repositories.getGitClient(),
    );
    const sandboxOptions = project.sandboxOptions();
    const docker =
      sandboxOptions === undefined
        ? undefined
        : new DockerWorkspaceManager(sandboxOptions, worktrees);
    const workspaces: WorkspaceManager = docker ?? worktrees;

    await mkdir(project.workspaceRoot, { recursive: true });
    await mkdir(project.integrationRoot, { recursive: true });

    const tasks: CoordinatedTask[] = [];
    for (const task of claimed) {
      const definition: TaskDefinition = {
        id: task.id,
        objective: task.objective,
        agentId: task.agentId,
        validationCommands: task.validationCommands,
        ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
        ...(task.context === undefined ? {} : { context: task.context }),
      };
      const [agentId, agent] = project.requireAgent(task.agentId);
      const agentSandbox =
        sandboxOptions === undefined
          ? undefined
          : new DockerWorkspaceManager(
              {
                ...sandboxOptions,
                ...(agent.env === undefined ? {} : { env: agent.env }),
              },
              worktrees,
            );
      const home = await openSubmitterCredentialHome(agent, task, options);
      if (home !== undefined) {
        credentialHomes.push(home);
      }
      tasks.push({
        task: definition,
        adapter: createAdapter(
          agent,
          agentId,
          canonical,
          workspaces,
          agentSandbox,
          project.planningRoot,
          home?.env ?? process.env,
          // The room's choice, if the room made one.
          { model: task.model, effort: task.effort },
        ),
        // One turn of a conversation, when the row says so: the coordinator
        // resumes whatever the registry still holds for this id, and starts
        // cold — same directory rules, fresh session — when it holds
        // nothing, which is also what a restart looks like.
        ...(task.conversationId === undefined
          ? {}
          : { conversationId: task.conversationId }),
      });
    }

    // The project's stored declarative policy governs approvals for this
    // run; without one the coordinator keeps its built-in defaults.
    const projectRecord = await store.getProject(projectId);
    // Only where this run actually holds leases. Without them there is nothing
    // to publish a plan onto and nothing to read other plans from, and an
    // authority that could do neither would answer "admitted" to everything
    // while looking like arbitration.
    const planAuthority: PlanAuthority | undefined =
      leases.size === 0
        ? undefined
        : new LeasePlanAuthority({
            store,
            leaseIdForTask: new Map(
              [...leases].map(([taskId, lease]) => [taskId, lease.id]),
            ),
            repositories,
          });
    const coordinator = new Coordinator({
      repositories,
      workspaces,
      store,
      approvalPolicy: approvalPolicyForProject(projectRecord?.policy),
      ...(planAuthority === undefined ? {} : { planAuthority }),
      ...(options.actions === undefined
        ? {}
        : { actionAuthority: options.actions }),
      ...(options.questions === undefined
        ? {}
        : { questions: options.questions }),
      ...(options.conversations === undefined
        ? {}
        : { conversations: options.conversations }),
      ...(options.cancellations === undefined
        ? {}
        : { cancellations: options.cancellations }),
    });
    const result = await coordinator.run({
      repository: canonical,
      workspaceRoot: project.workspaceRoot,
      integrationRoot: project.integrationRoot,
      projectId,
      tasks,
    });

    let integrated = 0;
    let failed = 0;
    let cancelled = 0;
    for (const entry of result.tasks) {
      if (entry.status === "cancelled") {
        // Whoever stopped it already settled the row and released the lease
        // — that is how the run came to notice at all. Writing a completion
        // here would throw against the terminal row, and re-finishing the
        // lease is refused as inactive; the run only stops tracking it.
        cancelled += 1;
        leases.delete(entry.task.id);
        continue;
      }
      const status = entry.status === "integrated" ? "integrated" : "failed";
      if (status === "integrated") {
        integrated += 1;
      } else {
        failed += 1;
      }
      const source = claimed.find(
        (candidate) => candidate.id === entry.task.id,
      );
      try {
        if (status === "integrated" && source?.conversationId !== undefined) {
          // A conversational turn that landed leaves its task open — waiting
          // for the next message, not finished. Before the lease settles, so
          // no released arm can catch the row still claimed and requeue it.
          await store.openSubmittedTask(entry.task.id, result.runId);
        } else {
          await store.completeSubmittedTask(entry.task.id, status, result.runId);
        }
      } catch (error) {
        // The one legitimate loser here is a cancel that landed while this
        // task was already past the point of stopping: its row is terminal,
        // the person's answer stands, and throwing would strand every later
        // task's row in `claimed`. Anything else is still an error.
        if (options.cancellations?.reasonFor(entry.task.id) === undefined) {
          throw error;
        }
      }
      const lease = leases.get(entry.task.id);
      if (lease !== undefined) {
        // Settled the moment the task is, not at the end of the run: the lease
        // is what holds this task's plan in front of everyone else's
        // arbitration, and holding it past the work would queue the next task
        // behind something already finished.
        await store.finishWorkLease(
          lease.id,
          status === "integrated" ? "completed" : "failed",
          new Date().toISOString(),
          entry.explanation,
        );
        leases.delete(entry.task.id);
      }
    }

    return {
      repository,
      claimed,
      runId: result.runId,
      integrated,
      failed,
      cancelled,
      conflicts: result.conflicts.length,
      finalRevision: result.canonicalVersion.revision,
    };
  } catch (error) {
    // Setup can fail after claiming. Complete every task that is still claimed
    // while preserving any outcomes that were already durably finalized.
    const claimedIds = new Set(claimed.map((task) => task.id));
    const unresolved = (
      await store.listSubmittedTasks({
        repositoryId: repository.id,
        status: "claimed",
      })
    ).filter((task) => claimedIds.has(task.id));
    const cleanup = await Promise.allSettled(
      unresolved.map((task) =>
        store.completeSubmittedTask(task.id, "failed"),
      ),
    );
    const cleanupFailures = cleanup
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "The run failed and one or more claimed tasks could not be finalized",
      );
    }
    throw error;
  } finally {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
    }
    // Whatever path ended the run, no live abort may outlive it: the
    // sessions are gone, and a handler kept past this point would hold the
    // dead adapter — and everything it closes over — for the process's life.
    if (options.cancellations !== undefined) {
      for (const task of claimed) {
        options.cancellations.release(task.id);
      }
    }
    // Any lease still held here belongs to a task that never reached an
    // outcome. Settling them is what stops a failed run from blocking the
    // repository until its leases time out: an unsettled lease still carries
    // an approved plan, and admission would keep sequencing new work behind a
    // task that is no longer running.
    await Promise.allSettled(
      [...leases.values()].map((lease) =>
        store.finishWorkLease(
          lease.id,
          "failed",
          new Date().toISOString(),
          "run ended without an outcome for this task",
        ),
      ),
    );
    // Best effort by design: a directory left behind is worth reporting, but
    // not worth masking the run's own outcome with.
    await Promise.allSettled(credentialHomes.map((home) => home.close()));
  }
}
