import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexAdapter } from "@coord/adapter-codex";
import { GenericCliAdapter } from "@coord/adapter-generic-cli";
import {
  createClaudeAdapter,
  createGeminiAdapter,
} from "@coord/adapter-prompt-cli";
import type { AgentAdapter } from "@coord/agent-protocol";
import { Coordinator, approvalPolicyForProject } from "@coord/coordinator";
import type {
  CoordinationStore,
  StoredRepository,
  SubmittedTask,
} from "@coord/persistence";
import { DEFAULT_PROJECT_ID } from "@coord/persistence";
import {
  normalizeGitHubRepository,
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import type { TaskDefinition } from "@coord/shared-types";
import {
  DockerWorkspaceManager,
  GitWorktreeWorkspaceManager,
  type WorkspaceManager,
  type WorkspaceSandbox,
} from "@coord/workspace-manager";

import type { AgentConfig, CoordinatorProject } from "./project.js";

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
}

export interface RepoCreateOptions {
  id: string;
  branch?: string;
  projectId?: string;
  setDefault?: boolean;
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
    });
  } finally {
    await rm(sourcePath, { recursive: true, force: true });
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

function createAdapter(
  agent: AgentConfig,
  agentId: string,
  repository: CanonicalRepository,
  workspaces: WorkspaceManager,
  sandbox: WorkspaceSandbox | undefined,
  planningRoot: string,
): AgentAdapter {
  if (agent.adapter === "codex") {
    if (sandbox !== undefined) {
      throw new Error(
        "Codex agents currently use the Codex CLI sandbox and cannot run " +
          "inside the project's Docker sandbox",
      );
    }
    return new CodexAdapter({
      agentId,
      repository,
      workspaces,
      planningRoot,
      ...(agent.command === undefined ? {} : { command: agent.command }),
      ...(agent.args === undefined ? {} : { args: agent.args }),
      ...(agent.planningTimeoutMs === undefined
        ? {}
        : { planningTimeoutMs: agent.planningTimeoutMs }),
      ...(agent.executionTimeoutMs === undefined
        ? {}
        : { executionTimeoutMs: agent.executionTimeoutMs }),
      ...(agent.windowsSandbox === undefined
        ? {}
        : { windowsSandbox: agent.windowsSandbox }),
      ...(agent.env === undefined
        ? {}
        : { env: { ...process.env, ...agent.env } }),
    });
  }

  if (agent.adapter === "claude" || agent.adapter === "gemini") {
    if (sandbox !== undefined) {
      throw new Error(
        `${agent.adapter} agents run the vendor CLI on the host with its own ` +
          "login state and cannot run inside the project's Docker sandbox",
      );
    }
    const create =
      agent.adapter === "claude" ? createClaudeAdapter : createGeminiAdapter;
    return create({
      agentId,
      repository,
      workspaces,
      planningRoot,
      ...(agent.command === undefined ? {} : { command: agent.command }),
      ...(agent.args === undefined ? {} : { args: agent.args }),
      ...(agent.planningTimeoutMs === undefined
        ? {}
        : { planningTimeoutMs: agent.planningTimeoutMs }),
      ...(agent.executionTimeoutMs === undefined
        ? {}
        : { executionTimeoutMs: agent.executionTimeoutMs }),
      ...(agent.effort === undefined ? {} : { effort: agent.effort }),
      ...(agent.env === undefined
        ? {}
        : { env: { ...process.env, ...agent.env } }),
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
          ? { ...process.env, ...(agent.env ?? {}) }
          : { ...process.env },
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
}

export interface RunSummary {
  repository: StoredRepository;
  claimed: SubmittedTask[];
  runId: string | undefined;
  integrated: number;
  failed: number;
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

  const claimed = await store.claimSubmittedTasks(
    repository.id,
    projectId,
  );
  if (claimed.length === 0) {
    const repositories = new RepositoryService();
    const version = await repositories.getCanonicalVersion(canonical);
    return {
      repository,
      claimed,
      runId: undefined,
      integrated: 0,
      failed: 0,
      conflicts: 0,
      finalRevision: version.revision,
    };
  }

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

    const tasks = claimed.map((task) => {
      const definition: TaskDefinition = {
        id: task.id,
        objective: task.objective,
        agentId: task.agentId,
        validationCommands: task.validationCommands,
        ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
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
      return {
        task: definition,
        adapter: createAdapter(
          agent,
          agentId,
          canonical,
          workspaces,
          agentSandbox,
          project.planningRoot,
        ),
      };
    });

    // The project's stored declarative policy governs approvals for this
    // run; without one the coordinator keeps its built-in defaults.
    const projectRecord = await store.getProject(projectId);
    const coordinator = new Coordinator({
      repositories,
      workspaces,
      store,
      approvalPolicy: approvalPolicyForProject(projectRecord?.policy),
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
    for (const entry of result.tasks) {
      const status = entry.status === "integrated" ? "integrated" : "failed";
      if (status === "integrated") {
        integrated += 1;
      } else {
        failed += 1;
      }
      await store.completeSubmittedTask(entry.task.id, status, result.runId);
    }

    return {
      repository,
      claimed,
      runId: result.runId,
      integrated,
      failed,
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
  }
}
