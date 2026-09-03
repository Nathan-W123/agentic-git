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
  type LineRange,
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

/** The next tenancy of a workspace being advanced. See {@link WorkspaceManager.advance}. */
export interface AdvanceWorkspaceInput {
  taskId: TaskId;
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
  /**
   * Moves an existing workspace's checkout to a newer canonical revision and
   * hands the directory to a new task.
   *
   * This is what lets a conversational task keep its directory between
   * turns: the checkout catches up to canonical while everything untracked —
   * `node_modules`, build output, scratch files — survives, which is the
   * half of a workspace that is expensive to rebuild. The returned record is
   * a new tenancy of the same path: fresh id, the new task, the new base.
   * The old record must not be used again; a changeset collected against it
   * would diff from the wrong base and re-offer work that already landed.
   *
   * Only sound for a workspace whose previous work has already been
   * integrated, which is why it may discard working-tree state rather than
   * merge it: nothing is lost that canonical does not already hold.
   *
   * Optional: a caller falls back to destroy-and-create, which is correct
   * and merely loses the cheap directory.
   */
  advance?(
    workspace: TaskWorkspace,
    input: AdvanceWorkspaceInput,
  ): Promise<TaskWorkspace>;
  runInWorkspace(
    workspace: TaskWorkspace,
    spec: SandboxLaunchSpec,
    options?: WorkspaceCommandOptions,
  ): Promise<ProcessOutput>;
  collectChangeSet(
    workspace: TaskWorkspace,
    metadata: ChangeSetMetadata,
  ): Promise<ChangeSet>;
  /**
   * What the agent has changed so far, while it is still working.
   *
   * Read-only, and deliberately not {@link collectChangeSet}: that one stages
   * untracked files with `git add --intent-to-add` to get them into the diff,
   * which writes to the index of a worktree an agent is actively editing.
   * Doing that on a timer, underneath a running process, is a good way to
   * corrupt somebody's work to draw a progress indicator. This only reads.
   *
   * It also returns no patches — a poll wants names and statuses, not the
   * content of every file on every tick.
   *
   * Optional: a manager with no cheap way to answer simply says nothing, and
   * the run narrates as it did before rather than failing.
   */
  listWorkingChanges?(
    workspace: TaskWorkspace,
  ): Promise<Array<{ path: string; status: FilePatchStatus }>>;
  /**
   * Which lines of each changed file have been written, while the agent works.
   *
   * Separate from {@link listWorkingChanges} on purpose. That one runs on a
   * timer to draw progress and wants names only; this reads a real diff and is
   * asked for once, when a repository-wide claim is being narrowed and the
   * question is how much of a file its holder is actually in.
   *
   * Only tracked edits are located. A file the agent created is new in its
   * entirety and has no base to diff against, so it is left out and stays
   * whole — the absence of a range has to read as "anywhere in this file".
   *
   * Optional, like its neighbour: a manager that cannot answer says nothing,
   * and a claim frozen without it holds its files whole, as it always did.
   */
  listWorkingRanges?(
    workspace: TaskWorkspace,
  ): Promise<Array<{ path: string; ranges: LineRange[] }>>;
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
/**
 * The lines each file gained, read off a `-U0` unified diff.
 *
 * Only the new side is kept. A holder's claim is about the file as it stands
 * now — where its code sits today, for another task to be placed around — and
 * the old side describes a file that no longer exists.
 *
 * A pure deletion has no new lines: `@@ -40,3 +39,0 @@` says three lines left
 * and nothing arrived. It is recorded as the single line the deletion closed
 * over, because a hole in a file is still a place its author has been, and
 * dropping it would leave the file looking untouched at that point.
 */
export function parseUnifiedHunkRanges(
  output: string,
): Array<{ path: string; ranges: LineRange[] }> {
  const byPath = new Map<string, LineRange[]>();
  let current: LineRange[] | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      // "+++ /dev/null" is a file the diff deleted outright; there is no new
      // side to place anything in.
      if (target === "/dev/null") {
        current = undefined;
        continue;
      }
      const path = normalizeRepositoryPath(
        target.startsWith("b/") ? target.slice(2) : target,
      );
      current = byPath.get(path) ?? [];
      byPath.set(path, current);
      continue;
    }
    if (current === undefined || !line.startsWith("@@")) {
      continue;
    }
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (header === null) {
      continue;
    }
    const start = Number(header[1]);
    const count = header[2] === undefined ? 1 : Number(header[2]);
    current.push(
      count === 0
        ? { startLine: Math.max(1, start), endLine: Math.max(1, start) }
        : { startLine: start, endLine: start + count - 1 },
    );
  }
  return [...byPath.entries()]
    .filter(([, ranges]) => ranges.length > 0)
    .map(([path, ranges]) => ({ path, ranges }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

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
 * not run while a delete is in progress. Letting adds overlap each other
 * matters: a wave starts by materialising every task's workspace at once, and
 * each add is a full checkout, so serialising them would turn the widest part
 * of the pipeline into a queue.
 *
 * They are not free of each other, though — see {@link lostTheCommondirRace}.
 * Two adds create two different directories and delete nothing, and still
 * collide, because git writes the new `commondir` non-atomically and every
 * `worktree` invocation reads it. That window is inside git and cannot be
 * held from out here, so it is retried rather than locked out; this lock is
 * only about deletes, which is all it was ever able to be about.
 */
async function withWorktreeRead<T>(
  repositoryPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = mirrorLock(repositoryPath);
  // Waiting on the gate and joining the set have to happen without yielding
  // in between. They did not: `await lock.exclusive` resolved, and only on
  // the next microtask did the reader add itself to `shared`. A delete that
  // arrived in that window published its own gate and took its snapshot of
  // `shared` while the reader was still in the gap — so it waited for nobody
  // and its `prune` ran alongside an `add` that had already been let through.
  // That is the interleaving behind
  //
  //     fatal: failed to read .../worktrees/<other>/commondir
  //
  // and it is why the failure only ever appeared under load: the gap is one
  // microtask wide, and something has to land inside it.
  //
  // So re-check after waking. `lock.exclusive` is replaced synchronously by
  // any delete that arrives, so finding it unchanged means none did, and the
  // registration below runs in that same microtask — before any delete can
  // publish a gate, let alone snapshot the set. Finding it changed means one
  // did, and this reader waits again on the gate it published.
  //
  // A reader can in principle be lapped by an unbroken stream of deletes.
  // Deletes here are one per teardown and finite, and the alternative —
  // registering first and checking afterwards — is a deadlock: the delete
  // waits for the reader it just found, the reader waits for the delete.
  for (;;) {
    const admitted = lock.exclusive;
    await admitted;
    if (lock.exclusive === admitted) {
      break;
    }
  }
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

/**
 * Whether a failed `worktree add` lost a race inside git rather than failing.
 *
 * `git worktree add` writes the new worktree's `commondir` with an ordinary
 * open-truncate-write, so for the moment between the open and the write the
 * file exists and is empty. Every `worktree` invocation on that mirror reads
 * each registered worktree's `commondir` while enumerating, and one that
 * lands in the window dies:
 *
 *     fatal: failed to read .../worktrees/<other>/commondir: Success
 *
 * "Success" is errno untouched — the read did not fail, it returned nothing —
 * which is what makes the message identifiable. Git takes no lock over this,
 * so it is not a window that can be closed from out here.
 *
 * What it can be is survived. The window is microseconds wide and belongs to
 * a *different* add, so the second attempt is against a mirror whose
 * neighbour has finished writing. Deliberately narrow: a retry that also
 * swallowed a bad revision or an occupied path would turn one clear failure
 * into three slow ones.
 */
function lostTheCommondirRace(error: unknown): boolean {
  return /failed to read .*[/\\]worktrees[/\\][^/\\]+[/\\]commondir/u.test(
    error instanceof Error ? error.message : String(error),
  );
}

/** How many times a lost race is worth re-running before it is a failure. */
const WORKTREE_ADD_ATTEMPTS = 3;

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

    for (let attempt = 1; ; attempt += 1) {
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
        break;
      } catch (error) {
        // Whatever went wrong, this mirror may now carry a half-written
        // administrative entry and this path a half-checked-out tree. Both
        // are cleared before anything else looks at either — including the
        // next attempt, which would otherwise find its own path occupied.
        // The prune is exclusive, so it also waits out every other add in
        // flight, which is what separates a retry from the window it lost.
        await withWorktreeWrite(input.repository.path, async () => {
          await this.git.run(
            [`--git-dir=${input.repository.path}`, "worktree", "prune"],
            { allowFailure: true },
          );
        });
        await rm(workspacePath, { recursive: true, force: true });
        if (
          attempt >= WORKTREE_ADD_ATTEMPTS ||
          !lostTheCommondirRace(error)
        ) {
          throw error;
        }
      }
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

  public async advance(
    workspace: TaskWorkspace,
    input: AdvanceWorkspaceInput,
  ): Promise<TaskWorkspace> {
    // No `--end-of-options` here, for the reason the integration service's
    // reset spells out: the container's git (Debian bookworm, 2.39) rejects
    // the terminator on `reset`, so the guard below is the same protection
    // in a form both gits accept — these revisions come from our own store,
    // and anything that is not a bare commit hash has no business reaching
    // a `reset --hard`.
    const revision = input.baseVersion.revision;
    if (!/^[0-9a-f]{4,64}$/iu.test(revision)) {
      throw new Error(
        `Refusing to advance to a revision that is not a commit hash: ${revision}`,
      );
    }
    // `reset --hard` and deliberately no `clean`. The reset clears what the
    // last turn left behind — the dirty tree of already-landed edits and the
    // intent-to-add index entries `collectChangeSet` staged — while leaving
    // everything untracked alone, which is the entire point of keeping the
    // directory. A tracked file the new revision adds is written over any
    // untracked copy in the way, which is correct here: the copy is the same
    // landed content, or older than it.
    //
    // No worktree lock: `reset` never enumerates the mirror's worktree
    // registrations, so it cannot race a teardown the way `add`/`remove`/
    // `prune` do — the same reason `collectChangeSet` runs unlocked.
    await this.git.run([
      "-C",
      workspace.path,
      "reset",
      "--hard",
      "--quiet",
      revision,
    ]);
    // A new tenancy of the same directory. A fresh id on purpose: the
    // durable workspace record is insert-only (ON CONFLICT DO NOTHING), so
    // reusing the old id would silently record nothing for this turn — the
    // record is one turn's occupancy, the path is what persists. See
    // docs/architecture/milestone-landing.md on why the base must move with
    // the tenant.
    return {
      ...workspace,
      id: createId("workspace"),
      taskId: input.taskId,
      baseVersion: input.baseVersion,
      createdAt: new Date().toISOString(),
    };
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

  /**
   * Where inside each tracked file the agent has been writing.
   *
   * `-U0` is the whole trick: with no context lines, every hunk header names
   * exactly the lines that changed, and the output is proportional to the edit
   * rather than to the file. Reading a diff of an 18,000-line file to find out
   * that four functions moved costs about what those four functions cost.
   */
  public async listWorkingRanges(
    workspace: TaskWorkspace,
  ): Promise<Array<{ path: string; ranges: LineRange[] }>> {
    const diff = await this.git.run([
      "-C",
      workspace.path,
      "diff",
      "-U0",
      "--no-renames",
      "--no-color",
      workspace.baseVersion.revision,
    ]);
    return parseUnifiedHunkRanges(diff.stdout);
  }

  /**
   * A read-only snapshot of what has changed so far. See the interface for
   * why this cannot simply call {@link collectChangeSet}.
   */
  public async listWorkingChanges(
    workspace: TaskWorkspace,
  ): Promise<Array<{ path: string; status: FilePatchStatus }>> {
    // Tracked edits against the base the task started from, and untracked
    // files separately — the latter are invisible to `git diff` until they
    // are staged, and staging is exactly what this must not do.
    const [tracked, untracked] = await Promise.all([
      this.git.run([
        "-C",
        workspace.path,
        "diff",
        "--name-status",
        "-z",
        "--no-renames",
        workspace.baseVersion.revision,
      ]),
      this.git.run([
        "-C",
        workspace.path,
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]),
    ]);
    const changes = new Map<string, FilePatchStatus>();
    for (const entry of parseNameStatusZ(tracked.stdout)) {
      changes.set(entry.path, toPatchStatus(entry.code));
    }
    for (const untrackedPath of parsePathListZ(untracked.stdout)) {
      const normalized = normalizeRepositoryPath(untrackedPath);
      // The same build output and scratch files `collectChangeSet` refuses to
      // carry into a changeset. Narrating them would bury the real edits
      // under whatever the agent's toolchain happened to write.
      if (isEphemeralWorkspacePath(normalized, new Set())) {
        continue;
      }
      changes.set(normalized, "added");
    }
    return [...changes]
      .map(([path, status]) => ({ path, status }))
      .sort((left, right) => left.path.localeCompare(right.path));
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
