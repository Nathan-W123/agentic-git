import { spawn } from "node:child_process";
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

/** One `Key: value` line in a commit's trailer block. */
export interface CommitTrailer {
  key: string;
  value: string;
}

export interface CommitOptions {
  /**
   * Who wrote the change.
   *
   * The coordinator stays the *committer* — it is what ran `git commit`, and
   * claiming otherwise would be false — while the author records whoever
   * actually produced the work. Git keeps the two apart for exactly this
   * case, and `git log --format=%an` and `git blame` both read the author.
   */
  author?: CommitIdentity;
  /**
   * Provenance to record in the commit message's trailer block.
   *
   * A canonical commit is the one artifact that outlives the coordinator's
   * database. Everything a reader needs to reconstruct why it exists — the
   * task, the changeset, the base it was written against, what validated it,
   * who approved it — belongs here rather than only in a table that a clone
   * of the repository does not come with.
   */
  trailers?: readonly CommitTrailer[];
}

const TRAILER_KEY = /^[A-Za-z][A-Za-z0-9-]*$/u;

/**
 * Renders a trailer block git will parse back out.
 *
 * Values are flattened to one line: a trailer's value ends at the newline, so
 * an objective containing one would silently truncate the trailer and leave
 * the remainder sitting in the message as prose. Empty values are dropped
 * rather than written as a key with nothing after it.
 */
export function formatTrailers(trailers: readonly CommitTrailer[]): string {
  const lines: string[] = [];
  for (const trailer of trailers) {
    if (!TRAILER_KEY.test(trailer.key)) {
      throw new Error(`Invalid commit trailer key: ${trailer.key}`);
    }
    const value = trailer.value.replaceAll(/\s+/gu, " ").trim();
    if (value.length === 0) {
      continue;
    }
    lines.push(`${trailer.key}: ${value}`);
  }
  return lines.join("\n");
}

/**
 * The commit author for work an agent produced.
 *
 * The address is under `.invalid`, which RFC 2606 reserves precisely so that
 * a made-up address cannot collide with a real one or look deliverable. It
 * exists to make `git log --author` and `git shortlog` work across agents,
 * not to be written to.
 */
export function agentCommitIdentity(agentId: string): CommitIdentity {
  const name = agentId.replaceAll(/[\r\n<>]/gu, " ").trim();
  const local = agentId.replaceAll(/[^A-Za-z0-9._-]/gu, "-").slice(0, 64);
  return {
    name: name.length === 0 ? "agent" : name,
    email: `${local.length === 0 ? "agent" : local}@agents.invalid`,
  };
}

function assertIdentity(identity: CommitIdentity): void {
  for (const field of [identity.name, identity.email]) {
    if (field.length === 0 || /[\r\n<>]/u.test(field)) {
      throw new Error(
        "Commit identity fields must be non-empty and free of line breaks and angle brackets",
      );
    }
  }
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

/**
 * Where a lease's bundle ref lives.
 *
 * Deliberately outside `refs/heads/`: a lease is scaffolding for one remote
 * execution, not a branch anybody should see when listing the repository's
 * branches or cloning the mirror.
 */
export const LEASE_REF_PREFIX = "refs/coord/leases/";

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
      await this.enableReflog(stagedRepository);
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
      await this.enableReflog(stagedRepository);
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
    const args = [
      "ls-remote",
      "--exit-code",
      "--heads",
      "--end-of-options",
      remoteUrl,
      branch,
    ] as const;
    const result = await this.git.run(
      args,
      {
        env: remoteEnvironment(credentials),
        allowFailure: true,
        timeoutMs: 60_000,
        maxOutputBytes: 1024 * 1024,
      },
    );
    if (result.exitCode === 2) {
      // Git reserves exit 2 for a successful lookup with no matching ref.
      return undefined;
    }
    if (result.exitCode !== 0) {
      // Authentication, DNS, transport, and protocol failures are not proof
      // that a branch is absent. Treating them that way can defeat the
      // upstream-change check that makes export safe.
      throw new GitCommandError(args, result);
    }
    const line = result.stdout.split(/\r?\n/u).find((entry) => entry.trim().length > 0);
    const revision = line?.split(/\s+/u)[0];
    if (revision === undefined || !/^[0-9a-f]{40,64}$/iu.test(revision)) {
      throw new Error(`Remote returned an invalid tip for ${branch}`);
    }
    return revision;
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

  /**
   * Validates a fully qualified ref, for refs that are deliberately not
   * branches.
   *
   * {@link assertBranchName} prefixes `refs/heads/`, which is exactly what a
   * ref living outside the branch namespace must not get. Cached on the same
   * reasoning: `check-ref-format` reads no repository state.
   */
  public async assertRefName(reference: string): Promise<void> {
    if (!reference.startsWith("refs/")) {
      throw new Error(`Ref must be fully qualified: ${reference}`);
    }
    if (this.validatedBranches.has(reference)) {
      return;
    }
    await this.git.run(["check-ref-format", reference]);
    this.validatedBranches.add(reference);
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

    const sequence = Number.parseInt(sequenceResult.stdout.trim(), 10);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error(
        `Could not determine history depth for canonical branch ${repository.branch}`,
      );
    }

    return {
      sequence,
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
    options: CommitOptions = {},
  ): Promise<string | undefined> {
    await this.git.run(["-C", worktreePath, "add", "--all", "--"]);
    return this.commitIndex(worktreePath, message, options);
  }

  /**
   * Commits exactly the content already staged in the index.
   *
   * Integration uses this after validating that the staged tree still matches
   * the admitted changeset. Re-staging here would accidentally promote
   * untracked dependency or build output produced by validation commands.
   */
  public async commitIndex(
    worktreePath: string,
    message: string,
    options: CommitOptions = {},
  ): Promise<string | undefined> {
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

    assertIdentity(this.identity);
    const author = options.author;
    if (author !== undefined) {
      assertIdentity(author);
    }
    const trailerBlock = formatTrailers(options.trailers ?? []);
    const fullMessage =
      trailerBlock.length === 0
        ? message
        : `${message.trimEnd()}\n\n${trailerBlock}\n`;

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
        // The coordinator committed it; the author is whoever wrote it.
        ...(author === undefined
          ? []
          : [`--author=${author.name} <${author.email}>`]),
        "-m",
        fullMessage,
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
   * worker fetches from directly. It advertises only the lease ref and
   * excludes newer canonical refs, but necessarily includes the ancestors
   * reachable from that commit so Git can materialize the snapshot.
   *
   * `refName` is fully qualified and lives under `refs/coord/leases/`, outside
   * the branch namespace. A lease is scaffolding, not a branch: putting these
   * in `refs/heads/` made every in-flight lease show up as a branch of the
   * canonical repository, and left one behind on any crash between creating
   * the ref and deleting it — which then pinned its objects against `gc` and
   * blocked that lease from ever being bundled again.
   *
   * The bundle is written to a file rather than captured from stdout because
   * it is binary, and the process runner decodes output as UTF-8.
   */
  public async createBundle(
    repository: CanonicalRepository,
    revision: string,
    refName: string,
  ): Promise<Buffer> {
    await this.assertRefName(refName);
    const key = `${repository.path}\0${refName}`;
    return await this.withBundleLock(key, async () => {
      // Git refuses to bundle a bare commit: a bundle carries refs, not commits.
      // A short-lived ref names the revision so an arbitrary commit can be
      // packaged after canonical advances beyond the lease.
      const reference = refName;
      const staging = await mkdtemp(path.join(os.tmpdir(), "coord-bundle-"));
      const bundlePath = path.join(staging, "revision.bundle");
      let createdReference = false;
      try {
        const existing = await this.git.run(
          [
            `--git-dir=${repository.path}`,
            "show-ref",
            "--verify",
            "--quiet",
            "--",
            reference,
          ],
          { allowFailure: true },
        );
        if (existing.exitCode === 0) {
          throw new Error(
            `Bundle ref ${reference} already exists and will not be overwritten`,
          );
        }
        if (existing.exitCode !== 1) {
          throw new GitCommandError(
            [
              `--git-dir=${repository.path}`,
              "show-ref",
              "--verify",
              "--quiet",
              "--",
              reference,
            ],
            existing,
          );
        }
        await this.git.run([
          `--git-dir=${repository.path}`,
          "update-ref",
          reference,
          "--end-of-options",
          revision,
          // Empty old value means "create only". This closes the race between
          // the existence check and update-ref without assuming hash length.
          "",
        ]);
        createdReference = true;
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
        if (createdReference) {
          await this.git.run(
            [`--git-dir=${repository.path}`, "update-ref", "-d", reference],
            { allowFailure: true },
          );
        }
        await rm(staging, { recursive: true, force: true });
      }
    });
  }

  /**
   * Every lease ref currently present in a canonical mirror.
   *
   * `createBundle` deletes its ref in a `finally`, which covers a thrown
   * error but not a killed process. Crash recovery uses this to find the refs
   * that outlived the run that made them: each one pins its objects against
   * `gc` and blocks that lease from being bundled again.
   */
  public async listLeaseRefs(
    repository: CanonicalRepository,
  ): Promise<string[]> {
    const result = await this.git.run(
      [
        `--git-dir=${repository.path}`,
        "for-each-ref",
        "--format=%(refname)",
        `${LEASE_REF_PREFIX}**`,
      ],
      { allowFailure: true },
    );
    if (result.exitCode !== 0) {
      return [];
    }
    return result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith(LEASE_REF_PREFIX));
  }

  /** Removes one lease ref. Absent is success, since the goal is absence. */
  public async deleteLeaseRef(
    repository: CanonicalRepository,
    reference: string,
  ): Promise<void> {
    if (!reference.startsWith(LEASE_REF_PREFIX)) {
      throw new Error(`Not a lease ref: ${reference}`);
    }
    await this.git.run(
      [`--git-dir=${repository.path}`, "update-ref", "-d", reference],
      { allowFailure: true },
    );
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

  /**
   * One file out of canonical, as the bytes it actually is.
   *
   * Separate from {@link readFile} because that one answers with text, and
   * text is a lossy way to hold a PNG: decoding bytes as UTF-8 replaces
   * everything invalid with U+FFFD, and re-encoding produces a file that is
   * the right length and no longer an image. Anything binary — a screenshot
   * an agent committed, most obviously — has to come back this way.
   *
   * `undefined` when the path is not in that revision, which is an ordinary
   * answer: a caller walking a change set will ask about files that were
   * deleted by it.
   */
  public async readFileBytes(
    repository: CanonicalRepository,
    revision: string,
    repositoryPath: string,
  ): Promise<Buffer | undefined> {
    const safePath = normalizeRepositoryPath(repositoryPath);
    return await new Promise((resolve, reject) => {
      const child = spawn(
        "git",
        [
          `--git-dir=${repository.path}`,
          "show",
          "--end-of-options",
          `${revision}:${safePath}`,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        // A missing path and a malformed revision are both a non-zero exit,
        // and neither is worth an exception: the caller asked whether this
        // file is there.
        resolve(code === 0 ? Buffer.concat(chunks) : undefined);
      });
    });
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

  /**
   * The unified diff between two canonical revisions, truncated to a budget.
   *
   * For readers that want to *understand* a change rather than replay it —
   * the auditor, which sends this to a model and pays per token for it. The
   * budget is enforced here rather than by the caller because the caller
   * cannot know how big a diff is until it has already paid to receive it,
   * and an unbounded `git diff` on a revision that reformatted the tree is
   * both a memory problem locally and a very expensive prompt afterwards.
   *
   * Truncation is reported rather than hidden: a reader told it is seeing
   * part of a change can say so, and one that quietly saw half of it will
   * report the missing half as absent.
   *
   * Binary files are summarised by Git itself ("Binary files … differ") and
   * left that way; there is nothing useful to read in the bytes and every
   * byte would be paid for.
   */
  public async diffBetween(
    repository: CanonicalRepository,
    fromRevision: string,
    toRevision: string,
    maxBytes = 200_000,
  ): Promise<{ patch: string; truncated: boolean }> {
    if (fromRevision === toRevision) {
      return { patch: "", truncated: false };
    }
    const result = await this.git.run([
      `--git-dir=${repository.path}`,
      "diff",
      "--no-color",
      "--no-renames",
      // Keeps a hunk readable on its own: three lines of context is the Git
      // default and the point at which a reviewer can tell what a changed
      // line sits inside without paying for the whole file.
      "--unified=3",
      fromRevision,
      toRevision,
      "--",
    ]);
    const patch = result.stdout;
    return patch.length <= maxBytes
      ? { patch, truncated: false }
      : { patch: patch.slice(0, maxBytes), truncated: true };
  }

  public getGitClient(): GitClient {
    return this.git;
  }

  /**
   * Turns on the reflog for a canonical mirror.
   *
   * Git defaults `core.logAllRefUpdates` to true only for non-bare
   * repositories, and every canonical mirror is bare — so promotions, the
   * compare-and-swap that rejected one, and rollbacks all moved
   * `refs/heads/<branch>` leaving no trace in the repository itself. The
   * coordinator's own audit trail recorded them, which is worth exactly as
   * much as a record that cannot be checked against anything.
   *
   * With this set, `git reflog refs/heads/<branch>` in the mirror is an
   * independent account of every move of canonical, written by git rather
   * than by us.
   */
  /**
   * Turns the reflog on for a mirror that already exists.
   *
   * Imports do this for themselves, but a deployment that imported before
   * reflogs were enabled would otherwise never get one. Startup recovery
   * calls this so existing mirrors are brought up to the same footing rather
   * than being silently worse off than new ones. Setting a config value that
   * is already set is a no-op, so it is safe to run every boot.
   */
  public async ensureReflog(repository: CanonicalRepository): Promise<void> {
    await this.enableReflog(repository.path);
  }

  private async enableReflog(repositoryPath: string): Promise<void> {
    await this.git.run([
      `--git-dir=${repositoryPath}`,
      "config",
      "--local",
      "core.logAllRefUpdates",
      "true",
    ]);
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
