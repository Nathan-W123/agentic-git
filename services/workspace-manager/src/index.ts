export * from "./docker-workspace-manager.js";
export * from "./egress-gateway.js";
export * from "./user-credentials.js";
export * from "./vendor-credentials.js";
export * from "./vendor-sandbox.js";

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
  expectedFiles?: string[];
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
const MAX_CHANGESET_FILES = 2_000;
const EPHEMERAL_DIRECTORY_NAMES = new Set([
  ".gradle",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".output",
  ".pnpm-store",
  ".pytest_cache",
  ".ruff_cache",
  ".svelte-kit",
  ".tox",
  ".turbo",
  ".venv",
  ".vite",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "venv",
]);

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

export function parsePathListZ(output: string): string[] {
  return output
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map(normalizeRepositoryPath);
}

export function isEphemeralWorkspacePath(
  repositoryPath: string,
  expectedFiles: ReadonlySet<string> = new Set(),
): boolean {
  if (
    expectedFiles.has(repositoryPath) ||
    [...expectedFiles].some((expected) =>
      repositoryPath.startsWith(`${expected}/`),
    )
  ) {
    return false;
  }
  const segments = repositoryPath.split("/");
  return (
    segments.some((segment) => EPHEMERAL_DIRECTORY_NAMES.has(segment)) ||
    repositoryPath.endsWith(".tsbuildinfo") ||
    repositoryPath.startsWith(".yarn/cache/") ||
    repositoryPath.startsWith(".yarn/unplugged/") ||
    repositoryPath.endsWith("/.yarn/install-state.gz") ||
    repositoryPath.includes("/.yarn/cache/") ||
    repositoryPath.includes("/.yarn/unplugged/") ||
    repositoryPath === ".DS_Store" ||
    repositoryPath.endsWith("/.DS_Store") ||
    repositoryPath === "Thumbs.db" ||
    repositoryPath.endsWith("/Thumbs.db")
  );
}

function literalPathspec(repositoryPath: string): string {
  return `:(literal)${repositoryPath}`;
}

function topLevelPaths(repositoryPaths: readonly string[]): string[] {
  const selected: string[] = [];
  for (const repositoryPath of [...repositoryPaths].sort(
    (left, right) => left.length - right.length,
  )) {
    if (
      !selected.some(
        (parent) =>
          repositoryPath === parent || repositoryPath.startsWith(`${parent}/`),
      )
    ) {
      selected.push(repositoryPath);
    }
  }
  return selected;
}

/**
 * Serialises worktree bookkeeping per canonical mirror.
 *
 * `git worktree add`, `remove` and `prune` all begin by enumerating every
 * worktree the mirror has registered and reading each one's `commondir`. None
 * of them takes a lock over that, so two running at once can have one reading
 * an administrative directory the other is in the middle of deleting:
 *
 *     fatal: failed to read .../worktrees/<other>/commondir: No such file or directory
 *
 * Removing a directory is not atomic — `commondir` disappears before the entry
 * containing it does — so the window is real, and on a loaded machine with
 * several integrations finishing together it is wide enough to hit. It was
 * observed exactly once, in a full-suite run with the CPU saturated, and could
 * not be provoked in isolation afterwards; that is the signature of a
 * timing window, not of it being absent.
 *
 * The map is module-level rather than per instance deliberately. The
 * integration service, the benchmark driver and crash recovery each construct
 * their own manager against the same mirror, so an instance field would
 * serialise nothing that actually collides.
 *
 * Only the git calls are held — never the filesystem deletion, which is the
 * slow part and touches nothing shared.
 */
interface MirrorLock {
  /** Resolves when the current exclusive holder, if any, is done. */
  exclusive: Promise<void>;
  /** In-flight shared holders, which an exclusive request waits behind. */
  shared: Set<Promise<void>>;
}

const worktreeLocks = new Map<string, MirrorLock>();

/** Windows paths differ in case without differing in identity. */
function lockKey(repositoryPath: string): string {
  const resolved = path.resolve(repositoryPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function mirrorLock(repositoryPath: string): MirrorLock {
  const key = lockKey(repositoryPath);
  const existing = worktreeLocks.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created: MirrorLock = {
    exclusive: Promise.resolve(),
    shared: new Set(),
  };
  worktreeLocks.set(key, created);
  return created;
}

/**
 * Exclusive access, for the operations that *delete* — `remove` and `prune`.
 *
 * These are the only ones that can pull an administrative directory out from
 * under a concurrent reader, so they are the only ones that need to exclude
 * everybody.
 */
async function withWorktreeWrite<T>(
  repositoryPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = mirrorLock(repositoryPath);
  const previous = lock.exclusive;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  lock.exclusive = previous.then(() => gate);
  await previous;
  // Readers admitted before this point still hold their enumeration open.
  await Promise.allSettled([...lock.shared]);
  try {
    return await operation();
  } finally {
    release();
  }
}

/**
 * Shared access, for `add`.
 *
 * Adding enumerates the registered worktrees like everything else, so it must
 * not run while a delete is in progress — but two adds create two *different*
 * directories and remove nothing, so they cannot hurt each other. Letting
 * them overlap matters: a wave starts by materialising every task's workspace
 * at once, and serialising that would turn the widest part of the pipeline
 * into a queue for no safety gained.
 */
async function withWorktreeRead<T>(
  repositoryPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = mirrorLock(repositoryPath);
  await lock.exclusive;
  let release: () => void = () => {};
  const entry = new Promise<void>((resolve) => {
    release = resolve;
  });
  lock.shared.add(entry);
  try {
    return await operation();
  } finally {
    release();
    lock.shared.delete(entry);
  }
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
      await withWorktreeRead(input.repository.path, async () => {
        await this.git.run([
          `--git-dir=${input.repository.path}`,
          "worktree",
          "add",
          "--detach",
          workspacePath,
          input.baseVersion.revision,
        ]);
      });
    } catch (error) {
      await withWorktreeWrite(input.repository.path, async () => {
        await this.git.run(
          [`--git-dir=${input.repository.path}`, "worktree", "prune"],
          { allowFailure: true },
        );
      });
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
    const untrackedDirectories = await this.git.run(
      [
        "-C",
        workspace.path,
        "ls-files",
        "--others",
        "--directory",
        "-z",
      ],
      { allowFailure: true },
    );
    if (untrackedDirectories.exitCode === 0) {
      const ephemeralDirectories = topLevelPaths(
        parsePathListZ(untrackedDirectories.stdout).filter((repositoryPath) =>
          isEphemeralWorkspacePath(repositoryPath),
        ),
      );
      await Promise.allSettled(
        ephemeralDirectories.map(async (repositoryPath) => {
          const directoryPath = path.resolve(workspace.path, repositoryPath);
          assertWithinRoot(workspace.path, directoryPath);
          await rm(directoryPath, { recursive: true, force: true });
        }),
      );
    }
    const removeArgs = [
      `--git-dir=${workspace.repository.path}`,
      "worktree",
      "remove",
      "--force",
      workspace.path,
    ] as const;
    const pruneArgs = [
      `--git-dir=${workspace.repository.path}`,
      "worktree",
      "prune",
    ] as const;
    // One critical section for both: a prune between another teardown's
    // remove and its prune is exactly the interleaving that breaks.
    //
    // Pruning is skipped when the removal succeeded. `worktree remove` takes
    // its own registration with it, so there is nothing of this workspace's
    // left to prune, and running it anyway made every teardown pay to rescan
    // every worktree the mirror has — under an exclusive lock, so the cost
    // was quadratic in the width of the wave rather than merely wasted.
    // Registrations orphaned some other way are swept at startup by crash
    // recovery, which is where that belongs.
    const { removal, prune } = await withWorktreeWrite(
      workspace.repository.path,
      async () => {
        const removed = await this.git.run(removeArgs, { allowFailure: true });
        return {
          removal: removed,
          prune:
            removed.exitCode === 0
              ? undefined
              : await this.git.run(pruneArgs, { allowFailure: true }),
        };
      },
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
    if (prune !== undefined && prune.exitCode !== 0) {
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
    const untracked = await this.git.run([
      "-C",
      workspace.path,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const expectedFiles = new Set(
      (metadata.expectedFiles ?? []).map(normalizeRepositoryPath),
    );
    const candidateUntrackedPaths = parsePathListZ(untracked.stdout).filter(
      (repositoryPath) =>
        !isEphemeralWorkspacePath(repositoryPath, expectedFiles),
    );
    if (candidateUntrackedPaths.length > MAX_CHANGESET_FILES) {
      throw new Error(
        `Changeset has ${candidateUntrackedPaths.length} untracked files; limit is ${MAX_CHANGESET_FILES}`,
      );
    }
    if (candidateUntrackedPaths.length > 0) {
      await this.git.run(
        [
          "-C",
          workspace.path,
          "add",
          "--intent-to-add",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ],
        {
          input: `${candidateUntrackedPaths.map(literalPathspec).join("\0")}\0`,
        },
      );
    }

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
    const changedEntries = parseNameStatusZ(names.stdout);
    if (changedEntries.length > MAX_CHANGESET_FILES) {
      throw new Error(
        `Changeset has ${changedEntries.length} files; limit is ${MAX_CHANGESET_FILES}`,
      );
    }

    const patches: FilePatch[] = [];
    for (const entry of changedEntries) {
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
        literalPathspec(changedPath),
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
