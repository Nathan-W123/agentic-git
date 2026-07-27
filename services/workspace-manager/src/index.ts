export * from "./docker-workspace-manager.js";

import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  createId,
  normalizeRepositoryPath,
  type CanonicalVersion,
  type ChangeSet,
  type CommandResult,
  type FilePatch,
  type FilePatchStatus,
  type RiskAssessment,
  type TaskId,
  type TestResult,
} from "@coord/shared-types";
import {
  GitClient,
  GitCommandError,
  runProcess,
  type CanonicalRepository,
  type ProcessOptions,
  type ProcessOutput,
} from "@coord/repository-service";

/**
 * How strongly a workspace isolates the agent process.
 *
 * `git-worktree` isolates the filesystem only. `docker` additionally isolates
 * the process, network, and resource limits of the agent command.
 */
export type WorkspaceIsolation = "git-worktree" | "docker";

export interface TaskWorkspace {
  id: string;
  taskId: TaskId;
  path: string;
  rootPath: string;
  repository: CanonicalRepository;
  baseVersion: CanonicalVersion;
  isolation: WorkspaceIsolation;
  createdAt: string;
}

/** A command to execute, always as an argument array and never through a shell. */
export interface SandboxLaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Rewrites an agent launch so the command runs inside a confinement boundary.
 *
 * Implementations are provided by workspace backends, so adapters depend on
 * this contract rather than on any specific sandbox technology.
 */
export interface WorkspaceSandbox {
  /**
   * Wraps `spec`. When `workspace` is omitted the agent has not been granted a
   * workspace yet and must run without any host mount.
   */
  wrapLaunch(spec: SandboxLaunchSpec, workspace?: TaskWorkspace): SandboxLaunchSpec;
  /** The workspace path as the confined process sees it. */
  resolveWorkspacePath(workspace: TaskWorkspace): string;
}

export interface CreateWorkspaceInput {
  taskId: TaskId;
  rootPath: string;
  repository: CanonicalRepository;
  baseVersion: CanonicalVersion;
}

export interface ChangeSetMetadata {
  symbolsChanged: string[];
  riskAssessment: RiskAssessment;
  agentExplanation: string;
  commandsRun?: CommandResult[];
  tests?: TestResult[];
}

export interface WorkspaceManager {
  create(input: CreateWorkspaceInput): Promise<TaskWorkspace>;
  destroy(workspace: TaskWorkspace): Promise<void>;
  runInWorkspace(
    workspace: TaskWorkspace,
    spec: SandboxLaunchSpec,
    options?: WorkspaceCommandOptions,
  ): Promise<ProcessOutput>;
  collectChangeSet(
    workspace: TaskWorkspace,
    metadata: ChangeSetMetadata,
  ): Promise<ChangeSet>;
}

export type WorkspaceCommandOptions = Pick<
  ProcessOptions,
  "input" | "timeoutMs" | "maxOutputBytes"
>;

export interface NameStatusEntry {
  code: string;
  path: string;
}

/** Parses `git diff --name-status -z` without corrupting tabs or newlines. */
export function parseNameStatusZ(output: string): NameStatusEntry[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") {
    fields.pop();
  }
  if (fields.length % 2 !== 0) {
    throw new Error("Unexpected NUL-delimited git name-status output");
  }

  const entries: NameStatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const code = fields[index];
    const changedPath = fields[index + 1];
    if (code === undefined || code.length === 0 || changedPath === undefined) {
      throw new Error("Unexpected NUL-delimited git name-status output");
    }
    entries.push({
      code,
      path: normalizeRepositoryPath(changedPath),
    });
  }
  return entries;
}

function toPatchStatus(code: string): FilePatchStatus {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    default:
      return "modified";
  }
}

/**
 * Windows caps most paths at 260 characters, and git stores worktree metadata
 * under a directory of the same name inside the canonical repository, so the
 * name is charged twice against that budget. Submitted tasks carry UUID
 * identifiers, which overflow it before any repository content is added.
 *
 * The directory name is therefore truncated. Full identifiers stay on the
 * workspace record, which is what everything downstream actually reads.
 */
const MAX_TASK_SEGMENT = 24;
const WORKSPACE_SUFFIX_LENGTH = 12;

export function workspaceDirectoryName(
  taskId: TaskId,
  workspaceId: string,
): string {
  const safeTaskId = taskId
    .replaceAll(/[^A-Za-z0-9_-]/gu, "_")
    .slice(0, MAX_TASK_SEGMENT);
  const suffix = workspaceId
    .replaceAll(/[^A-Za-z0-9]/gu, "")
    .slice(-WORKSPACE_SUFFIX_LENGTH);
  return `${safeTaskId}-${suffix}`;
}

function assertWithinRoot(rootPath: string, candidatePath: string): void {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Workspace path escapes its root: ${candidatePath}`);
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

export class GitWorktreeWorkspaceManager implements WorkspaceManager {
  public constructor(private readonly git = new GitClient()) {}

  public async create(input: CreateWorkspaceInput): Promise<TaskWorkspace> {
    const rootPath = path.resolve(input.rootPath);
    await mkdir(rootPath, { recursive: true });

    const id = createId("workspace");
    const workspacePath = path.join(
      rootPath,
      workspaceDirectoryName(input.taskId, id),
    );
    assertWithinRoot(rootPath, workspacePath);

    try {
      await this.git.run([
        `--git-dir=${input.repository.path}`,
        "worktree",
        "add",
        "--detach",
        workspacePath,
        input.baseVersion.revision,
      ]);
    } catch (error) {
      await this.git.run(
        [`--git-dir=${input.repository.path}`, "worktree", "prune"],
        { allowFailure: true },
      );
      await rm(workspacePath, { recursive: true, force: true });
      throw error;
    }

    return {
      id,
      taskId: input.taskId,
      path: workspacePath,
      rootPath,
      repository: input.repository,
      baseVersion: input.baseVersion,
      isolation: "git-worktree",
      createdAt: new Date().toISOString(),
    };
  }

  public async destroy(workspace: TaskWorkspace): Promise<void> {
    assertWithinRoot(workspace.rootPath, workspace.path);
    const removeArgs = [
      `--git-dir=${workspace.repository.path}`,
      "worktree",
      "remove",
      "--force",
      workspace.path,
    ] as const;
    const removal = await this.git.run(removeArgs, { allowFailure: true });
    const pruneArgs = [
      `--git-dir=${workspace.repository.path}`,
      "worktree",
      "prune",
    ] as const;
    const prune = await this.git.run(
      pruneArgs,
      { allowFailure: true },
    );
    if (removal.exitCode !== 0) {
      try {
        await lstat(workspace.path);
        throw new GitCommandError(removeArgs, removal);
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) {
          throw error;
        }
      }
    }
    if (prune.exitCode !== 0) {
      throw new GitCommandError(pruneArgs, prune);
    }
  }

  public async runInWorkspace(
    workspace: TaskWorkspace,
    spec: SandboxLaunchSpec,
    options: WorkspaceCommandOptions = {},
  ): Promise<ProcessOutput> {
    const commandDirectory =
      spec.cwd === undefined
        ? workspace.path
        : path.resolve(workspace.path, spec.cwd);
    assertWithinRoot(workspace.path, commandDirectory);
    return await runProcess(spec.command, spec.args, {
      cwd: commandDirectory,
      ...(spec.env === undefined ? {} : { env: spec.env }),
      ...options,
    });
  }

  public async collectChangeSet(
    workspace: TaskWorkspace,
    metadata: ChangeSetMetadata,
  ): Promise<ChangeSet> {
    await this.git.run([
      "-C",
      workspace.path,
      "add",
      "--intent-to-add",
      "--",
      ".",
    ]);

    const names = await this.git.run([
      "-C",
      workspace.path,
      "diff",
      "--name-status",
      "-z",
      "--no-renames",
      workspace.baseVersion.revision,
      "--",
    ]);

    const patches: FilePatch[] = [];
    for (const entry of parseNameStatusZ(names.stdout)) {
      const { code, path: changedPath } = entry;
      const patch = await this.git.run([
        "-C",
        workspace.path,
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-renames",
        workspace.baseVersion.revision,
        "--",
        changedPath,
      ]);

      patches.push({
        path: changedPath,
        status: toPatchStatus(code),
        patch: patch.stdout,
      });
    }

    const dependencyFiles = new Set([
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
    ]);

    return {
      id: createId("changeset"),
      taskId: workspace.taskId,
      baseVersion: workspace.baseVersion.sequence,
      baseRevision: workspace.baseVersion.revision,
      patches,
      commandsRun: metadata.commandsRun ?? [],
      tests: metadata.tests ?? [],
      dependenciesChanged: patches
        .map((entry) => entry.path)
        .filter((entry) => dependencyFiles.has(path.posix.basename(entry))),
      symbolsChanged: [...metadata.symbolsChanged],
      riskAssessment: metadata.riskAssessment,
      agentExplanation: metadata.agentExplanation,
      createdAt: new Date().toISOString(),
    };
  }
}
