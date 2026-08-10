import { createHash } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { CodeIntelligenceService } from "@coord/code-intelligence";
import {
  PlanAdmissionController,
  StoreApprovalController,
  approvalPolicyForProject,
} from "@coord/coordinator";
import { IntegrationService } from "@coord/integration-service";
import type { CoordinationStore } from "@coord/persistence";
import {
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  assertAgentPlan,
  createId,
  planAdmissionApproved,
  type AgentPlan,
  type CanonicalVersion,
  type CoordinatorDecision,
} from "@coord/shared-types";
import {
  DockerWorkspaceManager,
  GitWorktreeWorkspaceManager,
  type TaskWorkspace,
} from "@coord/workspace-manager";

import type { CoordinatorProject } from "@coord/cli/project";

/**
 * Overlay workspaces: a human's own isolated copy of a repository, editable
 * from the dashboard.
 *
 * Design constraints, in order of importance:
 *
 * 1. **Canonical is never written directly.** An overlay is a detached git
 *    worktree based on a canonical revision. The only way its edits reach
 *    canonical is {@link OverlayWorkspaceService.submit}, which pushes them
 *    through the same pipeline as any agent's work: plan, admission against
 *    active leases, policy gates (human approval where the project demands
 *    it), validation commands, and compare-and-swap promotion.
 *
 * 2. **Ownership is by construction, not by lookup.** The overlay directory
 *    name is a hash of (user, project, repository), and every route handler
 *    passes the *authenticated* user id. There is no identifier a caller can
 *    supply to reach another user's overlay.
 *
 * 3. **Commands only run inside the Docker sandbox.** `exec` reuses the same
 *    DockerWorkspaceManager confinement agents get: network `none` by
 *    default, all capabilities dropped, read-only root filesystem, pid /
 *    memory / cpu limits, and only the overlay directory mounted. If the
 *    project has no sandbox configured, `exec` refuses; it never falls back
 *    to running on the host.
 *
 * 4. **Overlays survive restarts.** They live under `.coordinator/overlays`,
 *    deliberately outside the workspace/planning/integration scratch roots
 *    that crash recovery clears at boot.
 */

export interface OverlayScope {
  userId: string;
  projectId: string;
  repositoryId: string;
}

export interface OverlayMeta {
  version: 1;
  userId: string;
  projectId: string;
  repositoryId: string;
  baseVersion: CanonicalVersion;
  createdAt: string;
}

export interface OverlayStatus {
  exists: boolean;
  baseRevision?: string;
  baseSequence?: number;
  canonicalRevision: string;
  dirtyFiles: string[];
  sandbox: { available: boolean; image?: string; explanation: string };
}

export interface OverlayFileEntry {
  path: string;
  size: number;
}

export interface OverlayFileContent {
  path: string;
  content: string;
  size: number;
  binary: boolean;
  truncated: boolean;
}

export interface OverlayExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface OverlaySubmitResult {
  status: string;
  explanation: string;
  runId?: string;
  taskId?: string;
  revision?: string;
  files?: string[];
  blockedBy?: string[];
}

export class OverlayError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OverlayError";
  }
}

/** Reading a whole repository file into a JSON response needs a ceiling. */
const MAX_READ_BYTES = 1024 * 1024;
/** Writes are capped below the gateway body limit to leave JSON headroom. */
export const MAX_WRITE_BYTES = 512 * 1024;
const MAX_TREE_ENTRIES = 20_000;
const EXEC_TIMEOUT_MS = 30_000;
const EXEC_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_COMMAND_LENGTH = 4_000;

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

/**
 * Resolves a repository-relative path and refuses anything that escapes the
 * overlay or touches git metadata. The `.git` check matters even though the
 * worktree's `.git` is a file: rewriting it would repoint the worktree at an
 * arbitrary repository.
 */
export function resolveOverlayPath(root: string, relative: string): string {
  if (relative.length === 0 || relative.includes("\0")) {
    throw new OverlayError(400, "invalid_path", "File path is invalid");
  }
  const resolved = path.resolve(root, relative);
  const relation = path.relative(path.resolve(root), resolved);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new OverlayError(
      400,
      "invalid_path",
      "File path escapes the workspace",
    );
  }
  const segments = relation.split(path.sep);
  if (segments.some((segment) => segment === ".git")) {
    throw new OverlayError(
      400,
      "invalid_path",
      "Git metadata cannot be read or edited through the workspace API",
    );
  }
  return resolved;
}

async function assertNoOverlaySymlink(
  root: string,
  resolved: string,
): Promise<void> {
  const relation = path.relative(path.resolve(root), resolved);
  let current = path.resolve(root);
  for (const segment of relation.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new OverlayError(
          400,
          "invalid_path",
          "Symbolic links cannot be followed through the workspace API",
        );
      }
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        // The first missing component means every remaining component is new.
        return;
      }
      throw error;
    }
  }
}

function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, 8_192);
  return probe.includes(0);
}

export class OverlayWorkspaceService {
  private readonly repositories: RepositoryService;
  private readonly worktrees: GitWorktreeWorkspaceManager;
  private readonly overlayLocks = new Map<string, Promise<void>>();
  private dockerProbe:
    | { at: number; available: boolean; explanation: string }
    | undefined;

  public constructor(
    private readonly project: CoordinatorProject,
    private readonly store: CoordinationStore,
    repositories?: RepositoryService,
  ) {
    this.repositories = repositories ?? new RepositoryService();
    this.worktrees = new GitWorktreeWorkspaceManager(
      this.repositories.getGitClient(),
    );
  }

  public get overlaysRoot(): string {
    return path.join(this.project.directory, "overlays");
  }

  /** Deterministic, collision-free, and short enough for Windows paths. */
  public overlayDirectory(scope: OverlayScope): string {
    const digest = createHash("sha256")
      .update(`${scope.userId}\0${scope.projectId}\0${scope.repositoryId}`)
      .digest("hex")
      .slice(0, 20);
    return path.join(this.overlaysRoot, digest);
  }

  private async withOverlayLock<T>(
    scope: OverlayScope,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = this.overlayDirectory(scope);
    const previous = this.overlayLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => gate);
    this.overlayLocks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.overlayLocks.get(key) === current) {
        this.overlayLocks.delete(key);
      }
    }
  }

  private metaPath(scope: OverlayScope): string {
    return `${this.overlayDirectory(scope)}.json`;
  }

  private async repository(scope: OverlayScope): Promise<CanonicalRepository> {
    if (
      !(await this.store.projectHasRepository(
        scope.projectId,
        scope.repositoryId,
      ))
    ) {
      throw new OverlayError(404, "not_found", "Repository was not found");
    }
    const stored = await this.store.getRepository(scope.repositoryId);
    if (stored === undefined) {
      throw new OverlayError(404, "not_found", "Repository was not found");
    }
    return { id: stored.id, path: stored.path, branch: stored.branch };
  }

  private async readMeta(scope: OverlayScope): Promise<OverlayMeta | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.metaPath(scope), "utf8");
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(raw);
    } catch {
      throw new OverlayError(
        409,
        "overlay_corrupt",
        "The workspace record is invalid; discard and reopen it",
      );
    }
    const value =
      typeof candidate === "object" && candidate !== null
        ? (candidate as Partial<OverlayMeta>)
        : undefined;
    const base =
      typeof value?.baseVersion === "object" &&
      value.baseVersion !== null
        ? value.baseVersion
        : undefined;
    // Validate the full coordinate system, not only ownership. A hand-edited
    // base revision or sequence could otherwise bypass stale-base protection.
    if (
      value?.version !== 1 ||
      value.userId !== scope.userId ||
      value.projectId !== scope.projectId ||
      value.repositoryId !== scope.repositoryId ||
      base === undefined ||
      !Number.isSafeInteger(base.sequence) ||
      base.sequence < 1 ||
      typeof base.revision !== "string" ||
      base.revision.length === 0 ||
      typeof base.branch !== "string" ||
      base.branch.length === 0 ||
      typeof base.createdAt !== "string" ||
      typeof value.createdAt !== "string"
    ) {
      throw new OverlayError(
        409,
        "overlay_corrupt",
        "The workspace record does not match its owner; discard and reopen it",
      );
    }
    return value as OverlayMeta;
  }

  private async requireOverlay(
    scope: OverlayScope,
  ): Promise<{ meta: OverlayMeta; directory: string }> {
    const meta = await this.readMeta(scope);
    const directory = this.overlayDirectory(scope);
    if (meta === undefined) {
      throw new OverlayError(
        409,
        "no_workspace",
        "Open a workspace before using it",
      );
    }
    try {
      await stat(directory);
    } catch {
      throw new OverlayError(
        409,
        "no_workspace",
        "The workspace directory is missing; discard and reopen it",
      );
    }
    return { meta, directory };
  }

  private asTaskWorkspace(
    meta: OverlayMeta,
    directory: string,
    repository: CanonicalRepository,
  ): TaskWorkspace {
    return {
      id: path.basename(directory),
      taskId: createId("task"),
      path: directory,
      // Convention from the adapters: a reconstructed workspace reports
      // itself as its own root. DockerWorkspaceManager derives the git mask
      // path from dirname(path), which is the overlays root here.
      rootPath: directory,
      repository,
      baseVersion: meta.baseVersion,
      isolation: "docker",
      createdAt: meta.createdAt,
    };
  }

  private async sandboxStatus(): Promise<{
    available: boolean;
    image?: string;
    explanation: string;
  }> {
    const options = this.project.sandboxOptions();
    if (options === undefined) {
      return {
        available: false,
        explanation:
          "No Docker sandbox is configured for this project; the terminal is disabled",
      };
    }
    const now = Date.now();
    if (this.dockerProbe === undefined || now - this.dockerProbe.at > 60_000) {
      try {
        await new DockerWorkspaceManager(options).assertAvailable();
        this.dockerProbe = {
          at: now,
          available: true,
          explanation: "Docker sandbox runtime is available",
        };
      } catch (error) {
        this.dockerProbe = {
          at: now,
          available: false,
          explanation:
            error instanceof Error ? error.message : "Docker is unavailable",
        };
      }
    }
    return {
      available: this.dockerProbe.available,
      image: options.image,
      explanation: this.dockerProbe.explanation,
    };
  }

  public async status(scope: OverlayScope): Promise<OverlayStatus> {
    return await this.withOverlayLock(
      scope,
      async () => await this.statusUnlocked(scope),
    );
  }

  private async statusUnlocked(scope: OverlayScope): Promise<OverlayStatus> {
    const repository = await this.repository(scope);
    const canonical = await this.repositories.getCanonicalVersion(repository);
    const meta = await this.readMeta(scope);
    const sandbox = await this.sandboxStatus();
    if (meta === undefined) {
      return {
        exists: false,
        canonicalRevision: canonical.revision,
        dirtyFiles: [],
        sandbox,
      };
    }
    let dirtyFiles: string[] = [];
    try {
      dirtyFiles = await this.changedFiles(
        this.overlayDirectory(scope),
        meta.baseVersion.revision,
      );
    } catch {
      // A broken worktree should not blank the status; the client offers
      // discard/reset either way.
    }
    return {
      exists: true,
      baseRevision: meta.baseVersion.revision,
      baseSequence: meta.baseVersion.sequence,
      canonicalRevision: canonical.revision,
      dirtyFiles,
      sandbox,
    };
  }

  private async changedFiles(
    directory: string,
    baseRevision: string,
  ): Promise<string[]> {
    const git = this.repositories.getGitClient();
    // Same trick collectChangeSet uses: intent-to-add makes new files visible
    // to diff without staging their content.
    await git.run(["-C", directory, "add", "--intent-to-add", "--", "."]);
    const diff = await git.run([
      "-C",
      directory,
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      baseRevision,
      "--",
    ]);
    return diff.stdout.split("\0").filter((entry) => entry.length > 0);
  }

  public async open(scope: OverlayScope): Promise<OverlayStatus> {
    return await this.withOverlayLock(
      scope,
      async () => await this.openUnlocked(scope),
    );
  }

  private async openUnlocked(scope: OverlayScope): Promise<OverlayStatus> {
    const repository = await this.repository(scope);
    const existing = await this.readMeta(scope);
    if (existing !== undefined) {
      return await this.statusUnlocked(scope);
    }
    const canonical = await this.repositories.getCanonicalVersion(repository);
    await mkdir(this.overlaysRoot, { recursive: true });
    // DockerWorkspaceManager expects this mask file next to the workspace
    // directory; it is bind-mounted read-only over the worktree's `.git`
    // pointer inside the container.
    await writeFile(
      path.join(this.overlaysRoot, ".coord-empty-git-mask"),
      "",
      { flag: "w" },
    );
    const directory = this.overlayDirectory(scope);
    const git = this.repositories.getGitClient();
    const metadataPath = this.metaPath(scope);
    const stagedMetadata = `${metadataPath}.${createId("tmp")}`;
    let created = false;
    try {
      await git.run([
        `--git-dir=${repository.path}`,
        "worktree",
        "add",
        "--detach",
        directory,
        canonical.revision,
      ]);
      created = true;
      const meta: OverlayMeta = {
        version: 1,
        userId: scope.userId,
        projectId: scope.projectId,
        repositoryId: scope.repositoryId,
        baseVersion: canonical,
        createdAt: new Date().toISOString(),
      };
      await writeFile(
        stagedMetadata,
        `${JSON.stringify(meta, undefined, 2)}\n`,
        "utf8",
      );
      await rename(stagedMetadata, metadataPath);
      await this.store.appendAudit(undefined, {
        type: "workspace_created",
        data: {
          projectId: scope.projectId,
          repositoryId: scope.repositoryId,
          actorId: scope.userId,
          kind: "human-overlay",
          baseRevision: canonical.revision,
        },
      });
      return await this.statusUnlocked(scope);
    } catch (error) {
      if (created) {
        await git.run(
          [
            `--git-dir=${repository.path}`,
            "worktree",
            "remove",
            "--force",
            directory,
          ],
          { allowFailure: true },
        );
      }
      await rm(stagedMetadata, { force: true });
      await rm(metadataPath, { force: true });
      await rm(directory, { recursive: true, force: true });
      await git.run(
        [`--git-dir=${repository.path}`, "worktree", "prune"],
        { allowFailure: true },
      );
      throw error;
    }
  }

  public async discard(scope: OverlayScope): Promise<void> {
    await this.withOverlayLock(
      scope,
      async () => await this.discardUnlocked(scope),
    );
  }

  private async discardUnlocked(scope: OverlayScope): Promise<void> {
    const repository = await this.repository(scope);
    const directory = this.overlayDirectory(scope);
    const git = this.repositories.getGitClient();
    await git.run(
      [
        `--git-dir=${repository.path}`,
        "worktree",
        "remove",
        "--force",
        directory,
      ],
      { allowFailure: true },
    );
    await git.run(
      [`--git-dir=${repository.path}`, "worktree", "prune"],
      { allowFailure: true },
    );
    await rm(directory, { recursive: true, force: true });
    await rm(this.metaPath(scope), { force: true });
  }

  public async reset(scope: OverlayScope): Promise<OverlayStatus> {
    return await this.withOverlayLock(scope, async () => {
      await this.discardUnlocked(scope);
      return await this.openUnlocked(scope);
    });
  }

  public async listFiles(scope: OverlayScope): Promise<OverlayFileEntry[]> {
    return await this.withOverlayLock(scope, async () => {
      return await this.listFilesUnlocked(scope);
    });
  }

  private async listFilesUnlocked(
    scope: OverlayScope,
  ): Promise<OverlayFileEntry[]> {
    const { directory } = await this.requireOverlay(scope);
    const entries: OverlayFileEntry[] = [];
    const walk = async (current: string): Promise<void> => {
      const children = await readdir(current, { withFileTypes: true });
      for (const child of children) {
        if (entries.length >= MAX_TREE_ENTRIES) {
          return;
        }
        if (child.name === ".git") {
          continue;
        }
        const childPath = path.join(current, child.name);
        if (child.isDirectory()) {
          await walk(childPath);
        } else if (child.isFile()) {
          const info = await stat(childPath);
          entries.push({
            path: path
              .relative(directory, childPath)
              .replaceAll(path.sep, "/"),
            size: info.size,
          });
        }
      }
    };
    await walk(directory);
    entries.sort((left, right) => left.path.localeCompare(right.path));
    return entries;
  }

  public async readOverlayFile(
    scope: OverlayScope,
    relative: string,
  ): Promise<OverlayFileContent> {
    return await this.withOverlayLock(scope, async () => {
      return await this.readOverlayFileUnlocked(scope, relative);
    });
  }

  private async readOverlayFileUnlocked(
    scope: OverlayScope,
    relative: string,
  ): Promise<OverlayFileContent> {
    const { directory } = await this.requireOverlay(scope);
    const resolved = resolveOverlayPath(directory, relative);
    await assertNoOverlaySymlink(directory, resolved);
    let buffer: Buffer;
    try {
      buffer = await readFile(resolved);
    } catch (error) {
      if (isErrorCode(error, "ENOENT") || isErrorCode(error, "EISDIR")) {
        throw new OverlayError(404, "not_found", "File was not found");
      }
      throw error;
    }
    const binary = looksBinary(buffer);
    const truncated = buffer.byteLength > MAX_READ_BYTES;
    return {
      path: relative,
      content: binary
        ? ""
        : buffer.subarray(0, MAX_READ_BYTES).toString("utf8"),
      size: buffer.byteLength,
      binary,
      truncated,
    };
  }

  public async writeOverlayFile(
    scope: OverlayScope,
    relative: string,
    content: string,
  ): Promise<void> {
    await this.withOverlayLock(scope, async () => {
      await this.writeOverlayFileUnlocked(scope, relative, content);
    });
  }

  /**
   * Moves or renames a file inside the overlay.
   *
   * Done here rather than as a write-then-delete from the browser because a
   * move is one intention: two calls could leave a copy at both paths if the
   * second failed, and a reviewer would see an unexplained duplicate rather
   * than a rename. Holding the overlay lock for both halves makes the pair
   * atomic with respect to every other overlay operation.
   *
   * It needs no pipeline of its own. The overlay *is* the staging area every
   * edit already goes through: `submit` turns whatever the overlay holds into
   * a changeset, which is then admitted, validated and promoted like any
   * other. A move therefore arrives at review as a deletion and an addition
   * of the same content, which is exactly what it is, and is revertible by
   * the same means.
   */
  public async moveOverlayFile(
    scope: OverlayScope,
    from: string,
    to: string,
  ): Promise<void> {
    await this.withOverlayLock(scope, async () => {
      const { directory } = await this.requireOverlay(scope);
      const source = resolveOverlayPath(directory, from);
      const target = resolveOverlayPath(directory, to);
      if (source === target) {
        return;
      }
      await assertNoOverlaySymlink(directory, source);
      await assertNoOverlaySymlink(directory, target);
      // Refusing rather than overwriting: a move that silently replaces
      // somebody else's file destroys work with no record that it existed.
      const occupied = await lstat(target).then(
        () => true,
        () => false,
      );
      if (occupied) {
        throw new OverlayError(409, "target_exists", `${to} already exists`);
      }
      const present = await lstat(source).then(
        () => true,
        () => false,
      );
      if (!present) {
        throw new OverlayError(404, "file_not_found", `${from} was not found`);
      }
      await mkdir(path.dirname(target), { recursive: true });
      // `rename` rather than copy-then-delete: within one overlay directory
      // it is a single filesystem operation, so there is no window in which
      // the file exists at both paths or at neither.
      await rename(source, target);
    });
  }

  private async writeOverlayFileUnlocked(
    scope: OverlayScope,
    relative: string,
    content: string,
  ): Promise<void> {
    const { directory } = await this.requireOverlay(scope);
    const resolved = resolveOverlayPath(directory, relative);
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
      throw new OverlayError(
        413,
        "file_too_large",
        `Files larger than ${MAX_WRITE_BYTES} bytes cannot be saved through the dashboard`,
      );
    }
    await assertNoOverlaySymlink(directory, resolved);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf8");
  }

  /**
   * Runs one shell command inside the project's Docker sandbox.
   *
   * Strictly weaker than a real terminal on purpose: one process per request,
   * no PTY, a hard timeout, and a bounded output buffer. The confinement is
   * exactly what agents get — DockerWorkspaceManager defaults deny the
   * network, drop all capabilities, make the root filesystem read-only, and
   * mount only the overlay worktree. Without a configured sandbox this
   * refuses rather than degrading to host execution.
   */
  public async exec(
    scope: OverlayScope,
    command: string,
  ): Promise<OverlayExecResult> {
    return await this.withOverlayLock(
      scope,
      async () => await this.execUnlocked(scope, command),
    );
  }

  private async execUnlocked(
    scope: OverlayScope,
    command: string,
  ): Promise<OverlayExecResult> {
    if (
      command.length === 0 ||
      command.length > MAX_COMMAND_LENGTH ||
      command.includes("\0")
    ) {
      throw new OverlayError(400, "invalid_command", "Command length is invalid");
    }
    const options = this.project.sandboxOptions();
    if (options === undefined) {
      throw new OverlayError(
        501,
        "sandbox_unavailable",
        "This project has no Docker sandbox configured; the terminal is disabled",
      );
    }
    const repository = await this.repository(scope);
    const { meta, directory } = await this.requireOverlay(scope);
    const workspace = this.asTaskWorkspace(meta, directory, repository);
    const docker = new DockerWorkspaceManager(options);
    const result = await docker.runInWorkspace(
      workspace,
      { command: "bash", args: ["-lc", command] },
      { timeoutMs: EXEC_TIMEOUT_MS, maxOutputBytes: EXEC_MAX_OUTPUT_BYTES },
    );
    await this.store.appendAudit(undefined, {
      type: "workspace_command_executed",
      data: {
        projectId: scope.projectId,
        repositoryId: scope.repositoryId,
        actorId: scope.userId,
        command: command.slice(0, 500),
        exitCode: result.exitCode,
        durationMs: Math.round(result.durationMs),
      },
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut === true,
    };
  }

  /**
   * Submits the overlay's edits through the ordinary integration pipeline.
   *
   * Deliberately modeled on canonical rollback: the overlay's diff becomes a
   * real changeset, planned against the files it touches, admitted against
   * plans currently executing, gated by the project's approval policy, run
   * through the validation commands, and promoted by compare-and-swap. A
   * stale overlay (canonical moved since it was opened) fails promotion
   * rather than being force-merged; the user resets and reapplies.
   */
  public async submit(
    scope: OverlayScope,
    objective: string,
  ): Promise<OverlaySubmitResult> {
    return await this.withOverlayLock(
      scope,
      async () => await this.submitUnlocked(scope, objective),
    );
  }

  private async submitUnlocked(
    scope: OverlayScope,
    objective: string,
  ): Promise<OverlaySubmitResult> {
    const repository = await this.repository(scope);
    const { meta, directory } = await this.requireOverlay(scope);
    const intelligence = new CodeIntelligenceService(this.repositories);
    const integrations = new IntegrationService(
      this.repositories,
      this.worktrees,
    );
    const admissions = new PlanAdmissionController();

    const files = await this.changedFiles(directory, meta.baseVersion.revision);
    if (files.length === 0) {
      return {
        status: "noop",
        explanation: "The workspace has no changes to submit",
      };
    }

    const taskId = createId("task");
    const summary =
      objective.trim().length === 0
        ? `Workspace edit across ${files.length} file(s)`
        : objective.trim();
    const index = await intelligence.index(
      repository,
      meta.baseVersion.revision,
    );
    const plan = intelligence.enrichPlan(
      {
        taskId,
        objective: summary,
        expectedFiles: [...files],
        expectedSymbols: [],
        dependencies: [],
        commands: [],
        externalAccess: [],
        // A human edit is ordinary work, not a rollback of accepted work;
        // the project's policy decides whether medium risk needs review.
        riskLevel: "medium",
        intent: summary,
      },
      index,
    );
    assertAgentPlan(plan);

    const leases = await this.store.listWorkLeases({
      status: "active",
      repositoryId: repository.id,
    });
    const tasks = await this.store.listSubmittedTasks({
      repositoryId: repository.id,
    });
    const agentFor = new Map(tasks.map((task) => [task.id, task.agentId]));
    const active = leases
      .filter(
        (lease) =>
          lease.plan !== undefined &&
          planAdmissionApproved(lease.plan.admission),
      )
      .map((lease) => ({
        taskId: lease.taskId,
        agentId: agentFor.get(lease.taskId) ?? lease.workerId,
        plan: (lease.plan as { plan: AgentPlan }).plan,
      }));
    const admission = admissions.admit({
      plan,
      agentId: `human-${scope.userId}`,
      baseRevision: meta.baseVersion.revision,
      baseVersion: meta.baseVersion.sequence,
      active,
    });
    if (!planAdmissionApproved(admission)) {
      await this.store.appendAudit(undefined, {
        type: "conflict_detected",
        taskId,
        data: {
          projectId: scope.projectId,
          repositoryId: repository.id,
          stage: "workspace_submit_admission",
          blockedBy: [...admission.blockedBy],
          explanation: admission.explanation,
        },
      });
      return {
        status: "blocked",
        explanation: admission.explanation,
        blockedBy: [...admission.blockedBy],
        taskId,
        files,
      };
    }

    const stored = await this.store.getRepository(repository.id);
    if (stored === undefined) {
      throw new OverlayError(404, "not_found", "Repository was not found");
    }
    const run = await this.store.createRun({
      repository: stored,
      projectId: scope.projectId,
      mode: "coordinated",
      scenario: "workspace-submit",
      baseVersion: meta.baseVersion,
    });
    let runFinished = false;
    try {
      await this.store.saveTask(run.id, {
        id: taskId,
        objective: summary,
        agentId: `human-${scope.userId}`,
        validationCommands: this.project.config.validationCommands,
        projectId: scope.projectId,
      });
      await this.store.saveTaskStatus(run.id, taskId, "planning");
      await this.store.savePlan(run.id, taskId, plan);
      await this.store.savePlanRevision(run.id, taskId, {
        revision: 1,
        reason: "initial",
        canonicalRevision: meta.baseVersion.revision,
        plan,
      });
      await this.store.appendAudit(run.id, {
        type: "plan_received",
        taskId,
        data: {
          projectId: scope.projectId,
          repositoryId: repository.id,
          expectedFiles: plan.expectedFiles,
          riskLevel: plan.riskLevel,
          actorId: scope.userId,
          source: "workspace-submit",
        },
      });

      const workspace = this.asTaskWorkspace(meta, directory, repository);
      workspace.taskId = taskId;
      await this.store.saveTaskStatus(run.id, taskId, "running");
      const changeSet = await this.worktrees.collectChangeSet(workspace, {
        symbolsChanged: [],
        riskAssessment: {
          level: "medium",
          reasons: [`Human workspace edit across ${files.length} file(s)`],
        },
        agentExplanation: summary,
      });
      if (changeSet.patches.length === 0) {
        throw new Error("The workspace diff produced no patches");
      }
      await this.store.saveChangeSet(run.id, changeSet);
      await this.store.appendAudit(run.id, {
        type: "changeset_collected",
        taskId,
        data: {
          projectId: scope.projectId,
          changeSetId: changeSet.id,
          files: changeSet.patches.map((patch) => patch.path),
        },
      });

      const projectRecord = await this.store.getProject(scope.projectId);
      const policy = approvalPolicyForProject(projectRecord?.policy);
      const reasons = [
        ...policy.planReasons(plan),
        ...policy.changesetReasons(plan, changeSet, {
          planWasReviewed: true,
        }),
      ];
      const decision: CoordinatorDecision = {
        decision: reasons.length === 0 ? "approved" : "approved_with_constraints",
        taskId,
        planRevision: 1,
        ownershipGrants: [],
        constraints: [
          "Workspace edits pass the same validation as any other change",
          ...(reasons.length === 0 ? [] : ["Edit received human approval"]),
        ],
        blockedBy: [],
        explanation: `Submitting workspace edits: ${summary}`,
      };
      if (reasons.length > 0) {
        await this.store.saveTaskStatus(
          run.id,
          taskId,
          "awaiting_approval",
          reasons.join("; "),
        );
        const review = await new StoreApprovalController(
          this.store,
          policy.timeoutMs,
        ).review({
          ...(projectRecord === undefined
            ? {}
            : { organizationId: projectRecord.organizationId }),
          projectId: scope.projectId,
          repositoryId: repository.id,
          runId: run.id,
          taskId,
          kind: "changeset",
          requestedBy: scope.userId,
          reasons,
          changeSetId: changeSet.id,
          onRequested: async (request) => {
            await this.store.appendAudit(run.id, {
              type: "approval_requested",
              taskId,
              data: {
                projectId: scope.projectId,
                approvalId: request.id,
                reasons: request.reasons,
                expiresAt: request.expiresAt,
              },
            });
          },
        });
        await this.store.appendAudit(run.id, {
          type: "approval_decided",
          taskId,
          data: {
            projectId: scope.projectId,
            approvalId: review.request.id,
            status: review.request.status,
            decidedBy: review.request.decidedBy,
          },
        });
        if (!review.approved) {
          throw new Error(
            `Approval ${review.request.id} was not granted: ${review.explanation}`,
          );
        }
      }
      await this.store.saveDecision(run.id, decision);
      await this.store.saveTaskStatus(run.id, taskId, "validating");

      const integration = await integrations.integrate({
        repository,
        integrationRoot: this.project.integrationRoot,
        changeSet,
        validationCommands: this.project.config.validationCommands,
        commitMessage: `coord(workspace): ${summary}`,
        // Compare-and-swap like every other change: a stale overlay fails
        // promotion instead of being force-merged over newer canonical.
        requireExactBase: true,
      });
      await this.store.saveIntegration(run.id, integration);
      await this.store.appendAudit(run.id, {
        type: "validation_completed",
        taskId,
        data: {
          projectId: scope.projectId,
          status: integration.status,
          commands: integration.validation.map((entry) => ({
            label: entry.command.label,
            exitCode: entry.exitCode,
          })),
        },
      });

      if (integration.status === "integrated") {
        await this.store.saveTaskStatus(
          run.id,
          taskId,
          "integrated",
          integration.explanation,
        );
        await this.store.appendAudit(run.id, {
          type: "canonical_promoted",
          taskId,
          data: {
            projectId: scope.projectId,
            previousRevision: integration.previousVersion.revision,
            revision: integration.canonicalVersion.revision,
            changeSetId: integration.changeSetId,
            actorId: scope.userId,
            source: "workspace-submit",
          },
        });
        // The overlay's edits are now canonical; rebase it onto the new
        // head so the next edit starts clean.
        await this.discardUnlocked(scope);
        await this.openUnlocked(scope);
      } else {
        await this.store.saveTaskStatus(
          run.id,
          taskId,
          "failed",
          integration.explanation,
        );
        await this.store.appendAudit(run.id, {
          type: "task_failed",
          taskId,
          data: {
            projectId: scope.projectId,
            stage: "workspace_submit_integration",
            status: integration.status,
            explanation: integration.explanation,
          },
        });
      }
      await this.store.finishRun(
        run.id,
        integration.status === "integrated" ? "completed" : "failed",
        integration.canonicalVersion,
      );
      runFinished = true;
      return {
        status: integration.status,
        explanation: integration.explanation,
        runId: run.id,
        taskId,
        revision: integration.canonicalVersion.revision,
        files,
      };
    } catch (error) {
      const explanation =
        error instanceof Error ? error.message : String(error);
      await this.store
        .saveTaskStatus(run.id, taskId, "failed", explanation)
        .catch(() => undefined);
      await this.store
        .appendAudit(run.id, {
          type: "task_failed",
          taskId,
          data: {
            projectId: scope.projectId,
            stage: "workspace_submit",
            error: explanation,
          },
        })
        .catch(() => undefined);
      if (!runFinished) {
        await this.store.finishRun(run.id, "failed").catch(() => undefined);
      }
      return {
        status: "policy_failed",
        explanation,
        runId: run.id,
        taskId,
        files,
      };
    }
  }
}
