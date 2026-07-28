import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  normalizeRepositoryPath,
  type CanonicalVersion,
} from "@coord/shared-types";

import { GitClient, GitCommandError } from "./git-client.js";

/** One promotion in the canonical branch's history. */
export interface CanonicalHistoryEntry {
  revision: string;
  /** History depth, matching {@link CanonicalVersion.sequence}. */
  sequence: number;
  createdAt: string;
  author: string;
  subject: string;
  branch: string;
}

export interface CanonicalRepository {
  id: string;
  path: string;
  branch: string;
}

export interface CommitIdentity {
  name: string;
  email: string;
}

export interface RemoteRepositoryCredentials {
  /** GitHub accepts `x-access-token`; other Git hosts may require a username. */
  username?: string;
  token: string;
}

export interface RemoteImportOptions {
  branch?: string;
  credentials?: RemoteRepositoryCredentials;
}

/**
 * Where the import point is recorded.
 *
 * The upstream tip at import time is stored as a ref inside the canonical
 * mirror rather than in a database, so the mirror stays self-describing: a
 * repository copied to another host still knows what it diverged from.
 */
export const IMPORT_REF_PREFIX = "refs/coord/imported/";

export class UpstreamChangedError extends Error {
  public constructor(
    public readonly branch: string,
    public readonly importedRevision: string,
    public readonly currentRevision: string | undefined,
  ) {
    super(
      `The remote ${branch} branch has moved since import: it was ` +
        `${importedRevision.slice(0, 12)} and is now ` +
        `${currentRevision?.slice(0, 12) ?? "absent"}. Pushing now could bury ` +
        "work that happened on GitHub in the meantime. Re-import the " +
        "repository, or pass an explicit upstream revision once the change " +
        "has been reviewed.",
    );
    this.name = "UpstreamChangedError";
  }
}

export interface PushToRemoteOptions {
  remoteUrl: string;
  /** Branch to create on the remote. Defaults to a dated export branch. */
  targetBranch?: string;
  /** Revision to publish. Defaults to the canonical branch tip. */
  revision?: string;
  /** Remote branch the import came from. Defaults to the canonical branch. */
  upstreamBranch?: string;
  /** Overrides the recorded import point. */
  expectedUpstreamRevision?: string;
  /** Proceed even though no import point is recorded. */
  allowUnverifiedUpstream?: boolean;
  /** Permit updating a target branch that already exists. Never forces. */
  allowExistingTarget?: boolean;
  credentials?: RemoteRepositoryCredentials;
}

export interface PushToRemoteResult {
  remoteUrl: string;
  targetBranch: string;
  revision: string;
  upstreamBranch: string;
  upstreamRevision: string | undefined;
  createdBranch: boolean;
}

const DEFAULT_IDENTITY: CommitIdentity = {
  name: "AI Development Coordinator",
  email: "coordinator@localhost",
};

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

export class RepositoryService {
  /**
   * Branch names already accepted by `git check-ref-format`.
   *
   * The check is a pure function of the string — it reads no repository state —
   * but it costs a process launch, and `getCanonicalVersion` runs it on every
   * call. A coordinated run asks for the canonical version once per wave and
   * again inside every integration, so the same handful of names were being
   * re-validated a dozen or more times per run. Names are only ever added after
   * git has approved them, so a hit is exactly as authoritative as a miss.
   */
  private readonly validatedBranches = new Set<string>();
  private readonly bundleLocks = new Map<string, Promise<void>>();

  public constructor(
    private readonly git = new GitClient(),
    private readonly identity: CommitIdentity = DEFAULT_IDENTITY,
  ) {}

  public async initializeWorkingRepository(
    repositoryPath: string,
    branch = "main",
  ): Promise<void> {
    await mkdir(repositoryPath, { recursive: true });
    await this.git.run(["init", `--initial-branch=${branch}`, repositoryPath]);
  }

  /**
   * Prepares a source directory that has no history yet.
   *
   * A greenfield project starts as an empty folder, but the import flow needs
   * `refs/heads/<branch>` to exist. Rather than making the caller run git by
   * hand, initialise and make one commit.
   *
   * A repository that already has commits is never touched: if the requested
   * branch is missing there, the caller asked for something that genuinely does
   * not exist, and inventing a commit would hide that.
   */
  private async prepareGreenfieldSource(
    sourcePath: string,
    branch: string,
  ): Promise<boolean> {
    await mkdir(sourcePath, { recursive: true });

    const isRepository = await this.git.run(
      ["-C", sourcePath, "rev-parse", "--git-dir"],
      { allowFailure: true },
    );
    if (isRepository.exitCode !== 0) {
      await this.git.run([
        "init",
        `--initial-branch=${branch}`,
        "--end-of-options",
        sourcePath,
      ]);
    }

    const hasBranch = await this.git.run(
      ["-C", sourcePath, "show-ref", "--verify", `refs/heads/${branch}`],
      { allowFailure: true },
    );
    if (hasBranch.exitCode === 0) {
      return false;
    }

    const hasAnyCommit = await this.git.run(
      ["-C", sourcePath, "rev-parse", "--verify", "HEAD"],
      { allowFailure: true },
    );
    if (hasAnyCommit.exitCode === 0) {
      throw new Error(
        `${sourcePath} has commits but no ${branch} branch. Create or rename ` +
          "the branch, or import the branch that exists.",
      );
    }

    // Unborn HEAD may still point at git's default name rather than the branch
    // that was asked for, so aim it before the first commit lands.
    await this.git.run([
      "-C",
      sourcePath,
      "symbolic-ref",
      "HEAD",
      `refs/heads/${branch}`,
    ]);
    // Any files already sitting in the directory become the scaffold; with an
    // empty directory this produces an empty root commit instead of failing.
    await this.git.run(["-C", sourcePath, "add", "--all", "--"]);
    const emptyHooks = await mkdtemp(
      path.join(os.tmpdir(), "coord-disabled-hooks-"),
    );
    try {
      await this.git.run([
        "-C",
        sourcePath,
        "-c",
        `user.name=${this.identity.name}`,
        "-c",
        `user.email=${this.identity.email}`,
        "-c",
        `core.hooksPath=${emptyHooks}`,
        "commit",
        "--allow-empty",
        "--no-gpg-sign",
        "--no-verify",
        "-m",
        "Initial commit",
      ]);
    } finally {
      await rm(emptyHooks, { recursive: true, force: true });
    }
    return true;
  }

  public async importLocalRepository(
    sourcePath: string,
    destinationPath: string,
    id: string,
    branch = "main",
  ): Promise<CanonicalRepository> {
    await this.assertBranchName(branch);
    await this.prepareGreenfieldSource(sourcePath, branch);

    const resolvedDestination = path.resolve(destinationPath);
    const destinationParent = path.dirname(resolvedDestination);
    await mkdir(destinationParent, { recursive: true });
    try {
      await lstat(resolvedDestination);
      throw new Error(`Canonical repository already exists: ${resolvedDestination}`);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
    }

    const stagingRoot = await mkdtemp(
      path.join(destinationParent, `.${path.basename(resolvedDestination)}.import-`),
    );
    const stagedRepository = path.join(stagingRoot, "repository.git");
    try {
      await this.git.run(["clone", "--bare", sourcePath, stagedRepository]);
      await this.git.run([
        `--git-dir=${stagedRepository}`,
        "show-ref",
        "--verify",
        `refs/heads/${branch}`,
      ]);
      await rename(stagedRepository, resolvedDestination);
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }

    return {
      id,
      path: resolvedDestination,
      branch,
    };
  }

  /**
   * Imports an HTTPS or SSH remote without embedding credentials in
   * the URL or process arguments. Token authentication is supplied through
   * Git's environment-backed configuration and exists only in the child.
   */
  public async importRemoteRepository(
    sourceUrl: string,
    destinationPath: string,
    id: string,
    options: RemoteImportOptions = {},
  ): Promise<CanonicalRepository> {
    const remote = normalizeRemoteUrl(sourceUrl);
    if (options.branch !== undefined) {
      await this.assertBranchName(options.branch);
    }

    const resolvedDestination = path.resolve(destinationPath);
    const destinationParent = path.dirname(resolvedDestination);
    await mkdir(destinationParent, { recursive: true });
    try {
      await lstat(resolvedDestination);
      throw new Error(`Canonical repository already exists: ${resolvedDestination}`);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
    }

    const stagingRoot = await mkdtemp(
      path.join(destinationParent, `.${path.basename(resolvedDestination)}.import-`),
    );
    const stagedRepository = path.join(stagingRoot, "repository.git");
    try {
      await this.git.run(
        ["clone", "--bare", remote, stagedRepository],
        {
          env: remoteEnvironment(options.credentials),
          timeoutMs: 10 * 60 * 1000,
          maxOutputBytes: 1024 * 1024,
        },
      );
      const branch =
        options.branch ??
        (await this.discoverDefaultBranch(stagedRepository));
      await this.assertBranchName(branch);
      const tip = await this.git.run([
        `--git-dir=${stagedRepository}`,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `refs/heads/${branch}`,
      ]);
      // Remember what the remote looked like, so a later push can tell whether
      // anyone else has committed since.
      await this.git.run([
        `--git-dir=${stagedRepository}`,
        "update-ref",
        `${IMPORT_REF_PREFIX}${branch}`,
        "--end-of-options",
        tip.stdout.trim(),
      ]);
      await rename(stagedRepository, resolvedDestination);
      return {
        id,
        path: resolvedDestination,
        branch,
      };
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  /** Reads a single remote ref without cloning. */
  private async remoteTip(
    remoteUrl: string,
    branch: string,
    credentials: RemoteRepositoryCredentials | undefined,
  ): Promise<string | undefined> {
    const result = await this.git.run(
      ["ls-remote", "--exit-code", "--heads", "--end-of-options", remoteUrl, branch],
      {
        env: remoteEnvironment(credentials),
        allowFailure: true,
        timeoutMs: 60_000,
        maxOutputBytes: 1024 * 1024,
      },
    );
    if (result.exitCode !== 0) {
      // exit 2 means the ref simply does not exist, which is not an error here.
      return undefined;
    }
    const line = result.stdout.split(/\r?\n/u).find((entry) => entry.trim().length > 0);
    return line?.split(/\s+/u)[0];
  }

  /** The upstream revision recorded when this repository was imported. */
  public async importedRevision(
    repository: CanonicalRepository,
    branch = repository.branch,
  ): Promise<string | undefined> {
    const result = await this.git.run(
      [
        `--git-dir=${repository.path}`,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${IMPORT_REF_PREFIX}${branch}`,
      ],
      { allowFailure: true },
    );
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  /**
   * Publishes canonical state to a remote branch.
   *
   * Two defaults keep this from destroying work. It pushes to a dedicated
   * export branch rather than the branch it imported from, and it never
   * force-pushes, so the remote decides whether the update is a fast-forward.
   * Before pushing it compares the remote's current tip against the revision
   * recorded at import; if someone else has committed in the meantime the push
   * is refused outright rather than merged on a guess.
   */
  public async pushToRemote(
    repository: CanonicalRepository,
    options: PushToRemoteOptions,
  ): Promise<PushToRemoteResult> {
    const remoteUrl = normalizeRemoteUrl(options.remoteUrl);
    const upstreamBranch = options.upstreamBranch ?? repository.branch;
    await this.assertBranchName(upstreamBranch);

    const targetBranch =
      options.targetBranch ??
      `coord/export-${new Date()
        .toISOString()
        .replaceAll(/[:.]/gu, "-")
        .slice(0, 19)}`;
    await this.assertBranchName(targetBranch);

    const revision =
      options.revision ?? (await this.getCanonicalVersion(repository)).revision;
    const resolved = await this.git.run([
      `--git-dir=${repository.path}`,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${revision}^{commit}`,
    ]);
    const commit = resolved.stdout.trim();

    const baseline =
      options.expectedUpstreamRevision ??
      (await this.importedRevision(repository, upstreamBranch));
    const currentUpstream = await this.remoteTip(
      remoteUrl,
      upstreamBranch,
      options.credentials,
    );

    if (baseline === undefined) {
      if (options.allowUnverifiedUpstream !== true) {
        throw new Error(
          `No import point is recorded for ${upstreamBranch}, so upstream ` +
            "changes cannot be detected. Re-import the repository, supply an " +
            "expected upstream revision, or explicitly allow an unverified push.",
        );
      }
    } else if (currentUpstream !== baseline) {
      throw new UpstreamChangedError(upstreamBranch, baseline, currentUpstream);
    }

    const existingTarget = await this.remoteTip(
      remoteUrl,
      targetBranch,
      options.credentials,
    );
    if (existingTarget !== undefined && options.allowExistingTarget !== true) {
      throw new Error(
        `The remote already has a ${targetBranch} branch. Choose another ` +
          "target branch, or allow updating the existing one.",
      );
    }

    await this.git.run(
      [
        `--git-dir=${repository.path}`,
        "push",
        "--end-of-options",
        remoteUrl,
        `${commit}:refs/heads/${targetBranch}`,
      ],
      {
        env: remoteEnvironment(options.credentials),
        timeoutMs: 10 * 60 * 1000,
        maxOutputBytes: 1024 * 1024,
      },
    );

    return {
      remoteUrl,
      targetBranch,
      revision: commit,
      upstreamBranch,
      upstreamRevision: currentUpstream,
      createdBranch: existingTarget === undefined,
    };
  }

  public async assertBranchName(branch: string): Promise<void> {
    if (branch.length === 0) {
      throw new Error("Canonical branch must not be empty");
    }
    if (this.validatedBranches.has(branch)) {
      return;
    }
    await this.git.run(["check-ref-format", `refs/heads/${branch}`]);
    this.validatedBranches.add(branch);
  }

  public async getCanonicalVersion(
    repository: CanonicalRepository,
  ): Promise<CanonicalVersion> {
    await this.assertBranchName(repository.branch);
    const reference = `refs/heads/${repository.branch}`;

    // Resolving the ref used to come first, because the two queries that
    // followed were written to take the resolved revision. Both accept the ref
    // name just as well, which makes all of it one round of processes instead
    // of two. `for-each-ref` also yields the commit date, so the separate
    // `show` is gone.
    //
    // It reports a missing ref as empty output rather than as a failure, so
    // the check that `rev-parse --verify` used to perform is now explicit.
    const [referenceResult, sequenceResult] = await Promise.all([
      this.git.run([
        `--git-dir=${repository.path}`,
        "for-each-ref",
        "--format=%(objectname)%09%(committerdate:iso-strict)",
        reference,
      ]),
      this.git.run(
        [`--git-dir=${repository.path}`, "rev-list", "--count", reference],
        { allowFailure: true },
      ),
    ]);

    const [revision, createdAt] = referenceResult.stdout.trim().split("\t");
    if (revision === undefined || revision.length === 0) {
      throw new Error(
        `Canonical branch ${repository.branch} does not exist in ${repository.path}`,
      );
    }

    return {
      sequence: Number.parseInt(sequenceResult.stdout.trim(), 10),
      revision,
      branch: repository.branch,
      createdAt: createdAt ?? "",
    };
  }

  /** Resolves a canonical-version record for an already selected commit. */
  public async getVersionAtRevision(
    repository: CanonicalRepository,
    revision: string,
  ): Promise<CanonicalVersion> {
    const candidate = revision.trim();
    if (candidate.length === 0) {
      throw new Error("Revision must not be empty");
    }
    const [resolved, sequence, createdAt] = await Promise.all([
      this.git.run([
        `--git-dir=${repository.path}`,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${candidate}^{commit}`,
      ]),
      this.git.run([
        `--git-dir=${repository.path}`,
        "rev-list",
        "--count",
        "--end-of-options",
        candidate,
      ]),
      this.git.run([
        `--git-dir=${repository.path}`,
        "show",
        "-s",
        "--format=%cI",
        "--end-of-options",
        candidate,
      ]),
    ]);
    const sequenceNumber = Number.parseInt(sequence.stdout.trim(), 10);
    if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 1) {
      throw new Error(`Could not determine history depth for ${candidate}`);
    }
    return {
      sequence: sequenceNumber,
      revision: resolved.stdout.trim(),
      branch: repository.branch,
      createdAt: createdAt.stdout.trim(),
    };
  }

  public async commitAll(
    worktreePath: string,
    message: string,
  ): Promise<string | undefined> {
    await this.git.run(["-C", worktreePath, "add", "--all", "--"]);
    const diffArgs = [
      "-C",
      worktreePath,
      "diff",
      "--cached",
      "--quiet",
      "--exit-code",
    ] as const;
    const diff = await this.git.run(
      diffArgs,
      { allowFailure: true },
    );

    if (diff.exitCode === 0) {
      return undefined;
    }
    if (diff.exitCode !== 1) {
      throw new GitCommandError(diffArgs, diff);
    }

    const emptyHooks = await mkdtemp(
      path.join(os.tmpdir(), "coord-disabled-hooks-"),
    );
    try {
      await this.git.run([
        "-C",
        worktreePath,
        "-c",
        `user.name=${this.identity.name}`,
        "-c",
        `user.email=${this.identity.email}`,
        "-c",
        `core.hooksPath=${emptyHooks}`,
        "commit",
        "--no-gpg-sign",
        "--no-verify",
        "-m",
        message,
      ]);
    } finally {
      await rm(emptyHooks, { recursive: true, force: true });
    }

    const revision = await this.git.run([
      "-C",
      worktreePath,
      "rev-parse",
      "HEAD",
    ]);
    return revision.stdout.trim();
  }

  public async promote(
    repository: CanonicalRepository,
    candidateRevision: string,
    expectedRevision: string,
  ): Promise<boolean> {
    const result = await this.git.run(
      [
        `--git-dir=${repository.path}`,
        "update-ref",
        `refs/heads/${repository.branch}`,
        candidateRevision,
        expectedRevision,
      ],
      { allowFailure: true },
    );
    if (result.exitCode === 0) {
      return true;
    }

    const current = await this.getCanonicalVersion(repository);
    if (current.revision === candidateRevision) {
      return true;
    }
    if (current.revision !== expectedRevision) {
      return false;
    }
    throw new GitCommandError(
      [
        `--git-dir=${repository.path}`,
        "update-ref",
        `refs/heads/${repository.branch}`,
        candidateRevision,
        expectedRevision,
      ],
      result,
    );
  }

  /**
   * Packages one revision as a Git bundle.
   *
   * This is how a remote worker materialises a workspace without the control
   * plane running a Git server: the bundle is a single self-contained file the
   * worker can clone from directly. It advertises only the lease ref and
   * excludes newer canonical refs, but necessarily includes the ancestors
   * reachable from that commit so Git can materialize the snapshot.
   *
   * The bundle is written to a file rather than captured from stdout because
   * it is binary, and the process runner decodes output as UTF-8.
   */
  public async createBundle(
    repository: CanonicalRepository,
    revision: string,
    refName: string,
  ): Promise<Buffer> {
    await this.assertBranchName(refName);
    const key = `${repository.path}\0${refName}`;
    return await this.withBundleLock(key, async () => {
      // Git refuses to bundle a bare commit: a bundle carries refs, not commits.
      // A short-lived branch names the revision so an arbitrary commit can be
      // packaged after canonical advances beyond the lease.
      const reference = `refs/heads/${refName}`;
      const staging = await mkdtemp(path.join(os.tmpdir(), "coord-bundle-"));
      const bundlePath = path.join(staging, "revision.bundle");
      try {
        await this.git.run([
          `--git-dir=${repository.path}`,
          "update-ref",
          reference,
          "--end-of-options",
          revision,
        ]);
        await this.git.run([
          `--git-dir=${repository.path}`,
          "bundle",
          "create",
          bundlePath,
          "--end-of-options",
          refName,
        ]);
        return await readFile(bundlePath);
      } finally {
        await this.git.run(
          [`--git-dir=${repository.path}`, "update-ref", "-d", reference],
          { allowFailure: true },
        );
        await rm(staging, { recursive: true, force: true });
      }
    });
  }

  private async withBundleLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.bundleLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => gate);
    this.bundleLocks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.bundleLocks.get(key) === current) {
        this.bundleLocks.delete(key);
      }
    }
  }

  public async readFile(
    repository: CanonicalRepository,
    revision: string,
    repositoryPath: string,
  ): Promise<string> {
    const safePath = normalizeRepositoryPath(repositoryPath);
    const result = await this.git.run([
      `--git-dir=${repository.path}`,
      "show",
      "--end-of-options",
      `${revision}:${safePath}`,
    ]);
    return result.stdout;
  }

  public async listFiles(
    repository: CanonicalRepository,
    revision: string,
  ): Promise<string[]> {
    const result = await this.git.run([
      `--git-dir=${repository.path}`,
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      "--full-tree",
      revision,
    ]);
    return result.stdout
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map(normalizeRepositoryPath)
      .sort();
  }

  /**
   * The canonical branch's promotion history, newest first.
   *
   * Read from Git rather than from the store's `canonical_versions` table:
   * that table records the versions the coordinator happened to observe, while
   * the branch is the actual record of what canonical has been. A history view
   * that disagreed with `git log` would be worse than none.
   */
  public async listCanonicalHistory(
    repository: CanonicalRepository,
    limit = 50,
  ): Promise<CanonicalHistoryEntry[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError("History limit must be between 1 and 500");
    }
    await this.assertBranchName(repository.branch);
    const reference = `refs/heads/${repository.branch}`;
    const [log, total] = await Promise.all([
      this.git.run([
        `--git-dir=${repository.path}`,
        "log",
        `--max-count=${limit}`,
        // Unit separator between fields and a NUL between records, so a commit
        // subject containing tabs or newlines cannot split a record.
        "--format=%H%x1f%cI%x1f%an%x1f%s%x00",
        reference,
      ]),
      this.git.run(
        [`--git-dir=${repository.path}`, "rev-list", "--count", reference],
        { allowFailure: true },
      ),
    ]);
    const depth = Number.parseInt(total.stdout.trim(), 10);
    return log.stdout
      .split("\0")
      .map((record) => record.trim())
      .filter((record) => record.length > 0)
      .map((record, index): CanonicalHistoryEntry => {
        const [revision, createdAt, author, subject] = record.split("\x1f");
        return {
          revision: revision ?? "",
          // The tip is the deepest commit; each older entry is one shallower.
          sequence: Number.isSafeInteger(depth) ? depth - index : 0,
          createdAt: createdAt ?? "",
          author: author ?? "",
          subject: subject ?? "",
          branch: repository.branch,
        };
      });
  }

  public async listChangedFiles(
    repository: CanonicalRepository,
    fromRevision: string,
    toRevision: string,
  ): Promise<string[]> {
    if (fromRevision === toRevision) {
      return [];
    }
    const result = await this.git.run([
      `--git-dir=${repository.path}`,
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      fromRevision,
      toRevision,
      "--",
    ]);
    return result.stdout
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map(normalizeRepositoryPath)
      .sort();
  }

  public getGitClient(): GitClient {
    return this.git;
  }

  private async discoverDefaultBranch(repositoryPath: string): Promise<string> {
    const symbolic = await this.git.run([
      `--git-dir=${repositoryPath}`,
      "symbolic-ref",
      "--short",
      "HEAD",
    ]);
    const branch = symbolic.stdout.trim();
    if (branch.length === 0) {
      throw new Error("Remote repository does not advertise a default branch");
    }
    return branch;
  }
}

export function normalizeGitHubRepository(value: string): string {
  const trimmed = value.trim();
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(
    trimmed,
  );
  if (shorthand !== null) {
    return `https://github.com/${shorthand[1]}/${shorthand[2]}.git`;
  }

  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(
    trimmed,
  );
  if (ssh !== null) {
    return `git@github.com:${ssh[1]}/${ssh[2]}.git`;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      "GitHub repository must be owner/name, an HTTPS URL, or an SSH URL",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error("Only credential-free https://github.com URLs are accepted");
  }
  const parts = parsed.pathname
    .replace(/\.git$/u, "")
    .split("/")
    .filter(Boolean);
  if (
    parts.length !== 2 ||
    !parts.every((part) => /^[A-Za-z0-9_.-]+$/u.test(part))
  ) {
    throw new Error("GitHub repository URL must contain exactly owner/name");
  }
  return `https://github.com/${parts[0]}/${parts[1]}.git`;
}

function normalizeRemoteUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("\0") || trimmed.length === 0) {
    throw new Error("Remote repository URL is invalid");
  }
  if (/^git@[^:]+:[^\s]+$/u.test(trimmed)) {
    return trimmed;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Remote repository must be an absolute Git URL");
  }
  if (
    !["https:", "ssh:"].includes(parsed.protocol) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(
      "Remote repository URL must use HTTPS or SSH and contain no credentials, query, or fragment",
    );
  }
  return parsed.toString();
}

function remoteEnvironment(
  credentials: RemoteRepositoryCredentials | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
  };
  if (credentials === undefined) {
    return env;
  }
  if (
    credentials.token.length === 0 ||
    credentials.token.includes("\0") ||
    credentials.token.includes("\r") ||
    credentials.token.includes("\n")
  ) {
    throw new Error("Remote repository token must be a non-empty single line");
  }
  const username = credentials.username ?? "x-access-token";
  if (
    username.length === 0 ||
    username.includes("\0") ||
    username.includes(":") ||
    /[\r\n]/u.test(username)
  ) {
    throw new Error("Remote repository username is invalid");
  }
  const basic = Buffer.from(`${username}:${credentials.token}`, "utf8").toString(
    "base64",
  );
  return {
    ...env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}
