export * from "./docker-workspace-manager.js";

import { mkdir } from "node:fs/promises";
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
  type CanonicalRepository,
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
  collectChangeSet(
    workspace: TaskWorkspace,
    metadata: ChangeSetMetadata,
  ): Promise<ChangeSet>;
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

export class GitWorktreeWorkspaceManager implements WorkspaceManager {
  public constructor(private readonly git = new GitClient()) {}

  public async create(input: CreateWorkspaceInput): Promise<TaskWorkspace> {
    const rootPath = path.resolve(input.rootPath);
    await mkdir(rootPath, { recursive: true });

    const id = createId("workspace");
    const safeTaskId = input.taskId.replaceAll(/[^A-Za-z0-9_-]/gu, "_");
    const workspacePath = path.join(rootPath, `${safeTaskId}-${id}`);
    assertWithinRoot(rootPath, workspacePath);

    await this.git.run([
      `--git-dir=${input.repository.path}`,
      "worktree",
      "add",
      "--detach",
      workspacePath,
      input.baseVersion.revision,
    ]);

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
    await this.git.run(
      [
        `--git-dir=${workspace.repository.path}`,
        "worktree",
        "remove",
        "--force",
        workspace.path,
      ],
      { allowFailure: true },
    );
    await this.git.run(
      [`--git-dir=${workspace.repository.path}`, "worktree", "prune"],
      { allowFailure: true },
    );
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
      "--no-renames",
      workspace.baseVersion.revision,
      "--",
    ]);

    const patches: FilePatch[] = [];
    for (const line of names.stdout.split(/\r?\n/u)) {
      if (line.trim().length === 0) {
        continue;
      }

      const separatorIndex = line.indexOf("\t");
      if (separatorIndex < 1) {
        throw new Error(`Unexpected git name-status output: ${line}`);
      }

      const code = line.slice(0, separatorIndex);
      const changedPath = normalizeRepositoryPath(
        line.slice(separatorIndex + 1),
      );
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

