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

import { GitBatchReader } from "./batch-reader.js";
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

export class SyncDivergedError extends Error {
  public constructor(
    public readonly branch: string,
    public readonly conflicts: readonly string[],
  ) {
    super(
      `Canonical and the remote ${branch} branch have both changed the same ` +
        `files, so a sync cannot merge them cleanly: ` +
        `${conflicts.slice(0, 20).join(", ")}${
          conflicts.length > 20 ? ", …" : ""
        }. Resolve the overlap on one side — land or roll back the local ` +
        "work, or adjust the branch on GitHub — then sync again. Nothing " +
        "was changed.",
    );
    this.name = "SyncDivergedError";
  }
}

export interface SyncFromRemoteOptions {
  remoteUrl: string;
  /** Remote branch to sync from. Defaults to the canonical branch. */
  upstreamBranch?: string;
  credentials?: RemoteRepositoryCredentials;
  /**
   * What to do when both sides changed the same files.
   *
   * `refuse` (the default) changes nothing and throws
   * {@link SyncDivergedError} — right when nobody has decided yet, and
   * wrong as the only option: it left a person with a diverged repository
   * and no way forward that a dashboard could reach.
   *
   * The other two are a person's explicit answer to "which side wins for
   * the files that collide", and neither destroys anything: the merge
   * commit keeps both sides as parents, so the losing version stays in
   * history and in the diff. Files that did *not* collide merge normally
   * either way — a resolution decides only the overlap, and the result
   * names exactly which files it decided.
   */
  conflictResolution?: "refuse" | "prefer-remote" | "prefer-local";
  /**
   * Where the merge worktree is created when both sides moved. Defaults to
   * the system temp directory; callers with a project scratch area pass it
   * so partial state never lands somewhere surprising.
   */
  workspaceRoot?: string;
}

export interface SyncFromRemoteResult {
  status: "already_current" | "fast_forwarded" | "merged";
  remoteUrl: string;
  upstreamBranch: string;
  /** The remote tip the mirror now records as its import point. */
  upstreamRevision: string;
  /** Canonical's tip before and after the sync. Equal on already_current. */
  previousRevision: string;
  revision: string;
  /**
   * Files that collided and were settled by an explicit
   * `conflictResolution`, with the side that won. Absent when nothing
   * collided — a clean merge decides nothing and should not imply it did.
   */
  resolved?: { side: "remote" | "local"; files: string[] };
}

export interface PushToRemoteOptions {
  remoteUrl: string;
  /** Branch to create on the remote. Defaults to a short change-derived name. */
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
  /**
   * Writes the branch label, when the caller has a model that can.
   *
   * Ignored when {@link PushToRemoteOptions.targetBranch} is given — an
   * explicit name is a decision already made — and never required: every
   * answer it fails to produce falls back to the deterministic slug.
   */
  branchNamer?: PushBranchNamer;
}

/**
 * The branch-naming model's seam.
 *
 * A prompt in, a few words out, or nothing — the same shape and the same
 * bargain as the catch-up summariser this reuses. `undefined` and `null` both
 * mean "no model wrote anything", which is what a deployment without a local
 * model, a timeout, a wedged session and a blank reply all produce, and every
 * one of them leaves the branch named the way it was named before.
 *
 * Narrow on purpose: a push is built, tested and correct without it, so a
 * test stubs one function rather than a model.
 */
export type PushBranchNamer = (
  prompt: string,
) => Promise<string | null | undefined>;

export interface PushToRemoteResult {
  remoteUrl: string;
  targetBranch: string;
  /** Human-readable description of the changes represented by the branch. */
  summary: string;
  revision: string;
  upstreamBranch: string;
  upstreamRevision: string | undefined;
  createdBranch: boolean;
}

const DEFAULT_IDENTITY: CommitIdentity = {
  name: "AI Development Coordinator",
  email: "coordinator@localhost",
};

const PUSH_BRANCH_PREFIX = "coord/";
const PUSH_BRANCH_WORDS = 4;
const PUSH_BRANCH_SLUG_LENGTH = 26;
/** What the slug says when the description left nothing to say. */
const PUSH_BRANCH_FALLBACK_SLUG = "canonical-update";
const PUSH_SUMMARY_LENGTH = 500;
const PUSH_SUBJECT_LIMIT = 12;
const PUSH_BRANCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "i",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "should",
  "that",
  "the",
  "then",
  "this",
  "to",
  "was",
  "when",
  "with",
  "you",
  "your",
]);

/** Removes coordinator plumbing from a commit subject before people see it. */
function pushSubject(value: string): string | undefined {
  const subject = value
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replace(/^coord\([^)]*\):\s*/iu, "")
    .replaceAll(/\btask_[a-z0-9-]{8,}\b/giu, "")
    .replaceAll(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
      "",
    )
    .replaceAll(/\s+/gu, " ")
    .trim();
  if (
    subject.length === 0 ||
    /^(?:initial commit|merge\s+(?:branch|commit|remote-tracking branch)\b|sync\s+.+\s+from\s+origin:)/iu.test(
      subject,
    )
  ) {
    return undefined;
  }
  return subject;
}

/** Turns the longer description into the deliberately small branch label. */
function pushBranchSlug(summary: string): string {
  const words = summary
    .replaceAll(/https?:\/\/\S+/giu, " ")
    .normalize("NFKD")
    .replaceAll(/\p{Mark}/gu, "")
    .toLowerCase()
    .match(/[a-z0-9]+/gu) ?? [];
  const meaningful = words.filter(
    (word) => /[a-z]/u.test(word) && !PUSH_BRANCH_STOP_WORDS.has(word),
  );
  const chosen = meaningful.slice(0, PUSH_BRANCH_WORDS);
  const slug = chosen
    .join("-")
    .slice(0, PUSH_BRANCH_SLUG_LENGTH)
    .replace(/-+$/u, "");
  return slug.length === 0 ? PUSH_BRANCH_FALLBACK_SLUG : slug;
}

/**
 * What the naming model is asked for.
 *
 * Written for the same small instruction model the catch-up popup uses, so it
 * is blunt: say the shape of the answer in the instruction, forbid the things
 * such a model reliably adds — a prefix, an explanation, quotes — and hand it
 * the description as plain prose rather than as anything it will echo back.
 */
export const PUSH_BRANCH_PROMPT = [
  "Name a git branch for these changes, in two to four lowercase words joined",
  "by hyphens. Answer with the name only: no prefix, no slashes, no quotes, no",
  "explanation. Use only the facts given, and do not invent details.",
].join(" ");

/**
 * How long the branch name may take before the deterministic one is used.
 *
 * A push is somebody waiting at a prompt for work to reach GitHub, and a
 * branch label is the least important thing about it — so the model gets one
 * short window and the push carries on regardless. This bounds a namer that
 * does not bound itself; one that does simply answers first.
 */
export const PUSH_BRANCH_NAME_TIMEOUT_MS = 6_000;

/**
 * The branch label out of whatever the model replied, or nothing.
 *
 * Small models fence their answers, prefix them with "Branch name:", wrap
 * them in quotes and then explain themselves on the next line. The first
 * non-empty line is taken, the decoration comes off, and the result goes
 * through the same slug the deterministic name is built with — so a model can
 * only ever choose the *words* of a branch name, never its shape, and no
 * reply can produce something `git check-ref-format` would refuse. A reply
 * with no usable words in it comes back `undefined`, which the caller reads
 * as "no name was written" and falls back.
 */
export function sanitisePushBranchName(
  raw: string | null | undefined,
): string | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const line = raw
    .replaceAll(/```[a-z]*\n?/giu, "\n")
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (line === undefined) {
    return undefined;
  }
  const stripped = line
    .replace(/^[\s>*\-•"'`]+/u, "")
    .replace(/^(?:branch(?:\s*name)?|name)\s*[:=-]\s*/iu, "")
    .replace(/^coord\//iu, "");
  const slug = pushBranchSlug(stripped);
  return slug === PUSH_BRANCH_FALLBACK_SLUG ? undefined : slug;
}

/**
 * The model's branch name for this description, or nothing.
 *
 * Everything that can go wrong here is the same answer: a namer that throws,
 * one that takes too long, and one that replies with nothing usable all leave
 * the caller with the deterministic name it would have used anyway. Nothing a
 * model does is allowed to fail or delay a push.
 */
async function namePushBranch(
  namer: PushBranchNamer,
  summary: string,
): Promise<string | undefined> {
  const prompt = [PUSH_BRANCH_PROMPT, "", `Changes: ${summary}`].join("\n");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const written = await Promise.race([
      namer(prompt),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          resolve(undefined);
        }, PUSH_BRANCH_NAME_TIMEOUT_MS);
        // Never a reason to hold a process open for a branch label.
        timer.unref?.();
      }),
    ]);
    return sanitisePushBranchName(written);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

/** One blob in a revision: where it lives and what it is. */
export interface RepositoryFileEntry {
  path: string;
  oid: string;
  /** `blob` for a file; `commit` for a submodule, which has no contents here. */
  type: string;
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
   * Describes what this push adds beyond its upstream baseline.
   *
   * Canonical commit subjects carry the task objective, which is the durable
   * human description available even when the coordination database is not
   * beside a copied mirror. Merge commits are excluded so a sync immediately
   * before push does not turn "Sync ... <sha>" into the public name of the
   * work. The longer text is kept for the result while only a few useful words
   * become the branch name.
   *
   * Those words are the local model's when the caller supplied one — the same
   * model that names finished work in the catch-up popup, asked here to name
   * the branch — because the first four non-stop words of a commit subject
   * make a branch nobody can read at a glance. It is presentation only: the
   * summary, the revision and everything the push actually does are unchanged
   * by it, and a deployment with no model gets exactly the old name.
   */
  private async describePush(
    repository: CanonicalRepository,
    commit: string,
    baseline: string | undefined,
    branchNamer?: PushBranchNamer,
  ): Promise<{ summary: string; defaultBranch: string }> {
    const revision = baseline === undefined ? commit : `${baseline}..${commit}`;
    const log = await this.git.run(
      [
        `--git-dir=${repository.path}`,
        "log",
        "--no-merges",
        `--max-count=${baseline === undefined ? 1 : PUSH_SUBJECT_LIMIT}`,
        "--format=%s",
        "--end-of-options",
        revision,
      ],
      {
        allowFailure: true,
        maxOutputBytes: 128 * 1024,
      },
    );
    const subjects: string[] = [];
    if (log.exitCode === 0) {
      for (const line of log.stdout.split(/\r?\n/gu)) {
        const subject = pushSubject(line);
        if (subject !== undefined && !subjects.includes(subject)) {
          subjects.push(subject);
        }
      }
    }

    let summary = subjects.join("; ");
    if (summary.length === 0) {
      const diffArgs =
        baseline === undefined
          ? [
              `--git-dir=${repository.path}`,
              "diff-tree",
              "--root",
              "--no-commit-id",
              "--name-only",
              "-r",
              "--end-of-options",
              commit,
            ]
          : [
              `--git-dir=${repository.path}`,
              "diff",
              "--name-only",
              "--end-of-options",
              baseline,
              commit,
            ];
      const diff = await this.git.run(diffArgs, {
        allowFailure: true,
        maxOutputBytes: 128 * 1024,
      });
      const files =
        diff.exitCode === 0
          ? diff.stdout
              .split(/\r?\n/gu)
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0)
          : [];
      summary =
        files.length === 0
          ? "Update canonical repository"
          : `Update ${files.slice(0, 3).join(", ")}${
              files.length > 3 ? ` and ${files.length - 3} more files` : ""
            }`;
    }
    if (summary.length > PUSH_SUMMARY_LENGTH) {
      summary = `${summary.slice(0, PUSH_SUMMARY_LENGTH - 1).trimEnd()}…`;
    }
    const written =
      branchNamer === undefined
        ? undefined
        : await namePushBranch(branchNamer, summary);
    return {
      summary,
      defaultBranch: `${PUSH_BRANCH_PREFIX}${written ?? pushBranchSlug(summary)}`,
    };
  }

  /**
   * Publishes canonical state to a remote branch.
   *
   * Two defaults keep this from destroying work. It pushes to a dedicated,
   * change-named branch rather than the branch it imported from, and it never
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

    // A caller that already knows the branch it wants never wakes the model:
    // the name is decided, and the only thing left to describe is the summary.
    const description = await this.describePush(
      repository,
      commit,
      baseline,
      options.targetBranch === undefined ? options.branchNamer : undefined,
    );
    const targetBranch = options.targetBranch ?? description.defaultBranch;
    await this.assertBranchName(targetBranch);

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
      summary: description.summary,
      revision: commit,
      upstreamBranch,
      upstreamRevision: currentUpstream,
      createdBranch: existingTarget === undefined,
    };
  }

  /**
   * Brings canonical up to date with the remote it was imported from — the
   * missing half of the export flow. Import happens once; after that, work
   * merged on GitHub leaves the mirror behind, {@link pushToRemote} rightly
   * refuses, and until this existed the only remedy was a fresh import under
   * a new name.
   *
   * Three honest outcomes. The mirror may already contain the remote tip
   * (`already_current`); the remote may simply be ahead (`fast_forwarded`);
   * or both sides may have moved, in which case the histories are joined
   * with a true merge commit (`merged`) so neither side's commits are
   * rewritten or squashed away. A merge that would conflict is refused with
   * the overlapping files named, and canonical is left exactly as it was —
   * resolving a conflict is judgement, and this operation has none to offer.
   *
   * Every outcome ends by moving the recorded import point to the remote's
   * current tip, which is precisely what lets the next push proceed.
   *
   * This moves `refs/heads/<branch>` outside the coordinated write path, so
   * callers must hold it away from live work — the CLI layer refuses while
   * tasks are executing in the repository. The fast-forward itself is a
   * compare-and-swap on the old tip, so a promotion racing past it fails
   * this sync rather than losing its own update.
   */
  public async syncFromRemote(
    repository: CanonicalRepository,
    options: SyncFromRemoteOptions,
  ): Promise<SyncFromRemoteResult> {
    const remoteUrl = normalizeRemoteUrl(options.remoteUrl);
    const upstreamBranch = options.upstreamBranch ?? repository.branch;
    await this.assertBranchName(upstreamBranch);
    await this.assertBranchName(repository.branch);
    const upstreamRef = `refs/coord/upstream/${upstreamBranch}`;
    await this.assertRefName(upstreamRef);
    const branchRef = `refs/heads/${repository.branch}`;

    await this.git.run(
      [
        `--git-dir=${repository.path}`,
        "fetch",
        "--no-tags",
        "--end-of-options",
        remoteUrl,
        // Forced on purpose: this ref mirrors whatever the remote says now,
        // and the remote rewriting its branch must not wedge every future
        // sync. Canonical's own branch is never the target here.
        `+refs/heads/${upstreamBranch}:${upstreamRef}`,
      ],
      {
        env: remoteEnvironment(options.credentials),
        timeoutMs: 10 * 60 * 1000,
        maxOutputBytes: 1024 * 1024,
      },
    );

    try {
      const [upstreamResolved, localResolved] = await Promise.all([
        this.git.run([
          `--git-dir=${repository.path}`,
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${upstreamRef}^{commit}`,
        ]),
        this.git.run([
          `--git-dir=${repository.path}`,
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${branchRef}^{commit}`,
        ]),
      ]);
      const upstreamRevision = upstreamResolved.stdout.trim();
      const previousRevision = localResolved.stdout.trim();

      const result: Omit<SyncFromRemoteResult, "status" | "revision"> = {
        remoteUrl,
        upstreamBranch,
        upstreamRevision,
        previousRevision,
      };

      if (await this.isAncestor(repository, upstreamRevision, previousRevision)) {
        // Canonical already holds everything the remote has — including the
        // equal case. The import point still moves: it is the recorded
        // answer to "what upstream state has this mirror seen", and the
        // whole reason a stale one blocks the push.
        await this.recordImportPoint(repository, upstreamBranch, upstreamRevision);
        return { ...result, status: "already_current", revision: previousRevision };
      }

      if (await this.isAncestor(repository, previousRevision, upstreamRevision)) {
        // The compare-and-swap form: if canonical moved since it was read
        // above, this fails rather than discarding that move.
        await this.git.run([
          `--git-dir=${repository.path}`,
          "update-ref",
          "--end-of-options",
          branchRef,
          upstreamRevision,
          previousRevision,
        ]);
        await this.recordImportPoint(repository, upstreamBranch, upstreamRevision);
        return { ...result, status: "fast_forwarded", revision: upstreamRevision };
      }

      const merged = await this.mergeUpstream(
        repository,
        upstreamRef,
        upstreamRevision,
        upstreamBranch,
        options.workspaceRoot,
        options.conflictResolution ?? "refuse",
      );
      await this.recordImportPoint(repository, upstreamBranch, upstreamRevision);
      return {
        ...result,
        status: "merged",
        revision: merged.revision,
        ...(merged.resolved === undefined
          ? {}
          : { resolved: merged.resolved }),
      };
    } finally {
      // Scaffolding, like a finished lease: the fetched ref has served its
      // purpose, and `refs/coord/` should list only what still means
      // something.
      await this.git.run(
        [`--git-dir=${repository.path}`, "update-ref", "-d", upstreamRef],
        { allowFailure: true },
      );
    }
  }

  /** `git merge-base --is-ancestor`, with real errors kept distinct from "no". */
  private async isAncestor(
    repository: CanonicalRepository,
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
    const args = [
      `--git-dir=${repository.path}`,
      "merge-base",
      "--is-ancestor",
      "--end-of-options",
      ancestor,
      descendant,
    ] as const;
    const result = await this.git.run(args, { allowFailure: true });
    if (result.exitCode === 0) {
      return true;
    }
    if (result.exitCode === 1) {
      return false;
    }
    throw new GitCommandError(args, result);
  }

  private async recordImportPoint(
    repository: CanonicalRepository,
    branch: string,
    revision: string,
  ): Promise<void> {
    await this.git.run([
      `--git-dir=${repository.path}`,
      "update-ref",
      `${IMPORT_REF_PREFIX}${branch}`,
      "--end-of-options",
      revision,
    ]);
  }

  /**
   * Joins diverged histories with a real merge commit, in a throwaway
   * worktree because a bare mirror has nowhere to resolve trees. Conflicts
   * abort the merge and throw {@link SyncDivergedError} with the files
   * named; the worktree is removed either way.
   */
  private async mergeUpstream(
    repository: CanonicalRepository,
    upstreamRef: string,
    upstreamRevision: string,
    upstreamBranch: string,
    workspaceRoot: string | undefined,
    conflictResolution: "refuse" | "prefer-remote" | "prefer-local",
  ): Promise<{
    revision: string;
    resolved?: { side: "remote" | "local"; files: string[] };
  }> {
    assertIdentity(this.identity);
    const scratchRoot = workspaceRoot ?? os.tmpdir();
    await mkdir(scratchRoot, { recursive: true });
    const worktreePath = await mkdtemp(
      path.join(scratchRoot, `${repository.id}-sync-`),
    );
    const emptyHooks = await mkdtemp(
      path.join(os.tmpdir(), "coord-disabled-hooks-"),
    );
    let worktreeAdded = false;
    try {
      await this.git.run([
        `--git-dir=${repository.path}`,
        "worktree",
        "add",
        "--end-of-options",
        worktreePath,
        repository.branch,
      ]);
      worktreeAdded = true;
      const mergeArgs = (strategy?: "theirs" | "ours"): string[] => [
        "-C",
        worktreePath,
        "-c",
        `user.name=${this.identity.name}`,
        "-c",
        `user.email=${this.identity.email}`,
        "-c",
        `core.hooksPath=${emptyHooks}`,
        "merge",
        "--no-ff",
        "--no-edit",
        "--no-gpg-sign",
        "--no-verify",
        ...(strategy === undefined ? [] : ["-X", strategy]),
        "-m",
        strategy === undefined
          ? `Sync ${upstreamBranch} from origin: merge ${upstreamRevision.slice(0, 12)} into canonical`
          : `Sync ${upstreamBranch} from origin: merge ${upstreamRevision.slice(0, 12)} into canonical, ` +
            `taking ${strategy === "theirs" ? "GitHub's" : "canonical's"} side where they collided`,
        "--end-of-options",
        upstreamRef,
      ];
      // Always tried clean first, even when a resolution is on offer: a
      // strategy must decide only the files that genuinely collide, and
      // this pass is also what names them for the record.
      const plain = mergeArgs();
      const merge = await this.git.run(plain, { allowFailure: true });
      if (merge.exitCode === 0) {
        const merged = await this.git.run([
          "-C",
          worktreePath,
          "rev-parse",
          "HEAD",
        ]);
        return { revision: merged.stdout.trim() };
      }
      const conflicted = await this.git.run(
        ["-C", worktreePath, "diff", "--name-only", "--diff-filter=U"],
        { allowFailure: true },
      );
      const conflicts = conflicted.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      await this.git.run(["-C", worktreePath, "merge", "--abort"], {
        allowFailure: true,
      });
      if (conflicts.length === 0) {
        throw new GitCommandError(plain, merge);
      }
      if (conflictResolution === "refuse") {
        throw new SyncDivergedError(upstreamBranch, conflicts);
      }
      // `-X` is git's own per-hunk preference, not a wholesale checkout: a
      // file that collides in one place and merges cleanly in another keeps
      // both, and the losing content stays reachable through the merge's
      // other parent either way.
      const strategy =
        conflictResolution === "prefer-remote" ? "theirs" : "ours";
      const resolvedMerge = await this.git.run(mergeArgs(strategy), {
        allowFailure: true,
      });
      if (resolvedMerge.exitCode !== 0) {
        await this.git.run(["-C", worktreePath, "merge", "--abort"], {
          allowFailure: true,
        });
        // A collision `-X` cannot settle — the same file deleted on one side
        // and edited on the other is the usual one — is still a refusal,
        // because there is no version of it for a preference to pick.
        throw new SyncDivergedError(upstreamBranch, conflicts);
      }
      const merged = await this.git.run([
        "-C",
        worktreePath,
        "rev-parse",
        "HEAD",
      ]);
      return {
        revision: merged.stdout.trim(),
        resolved: {
          side: strategy === "theirs" ? "remote" : "local",
          files: conflicts,
        },
      };
    } finally {
      if (worktreeAdded) {
        await this.git.run(
          [
            `--git-dir=${repository.path}`,
            "worktree",
            "remove",
            "--force",
            "--end-of-options",
            worktreePath,
          ],
          { allowFailure: true },
        );
      }
      await rm(worktreePath, { recursive: true, force: true });
      await rm(emptyHooks, { recursive: true, force: true });
    }
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
    /** A commit the caller already holds, so only the difference is packed. */
    have?: string,
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
        // A worker that already holds an ancestor gets only what it lacks.
        //
        // Without this, every task on every machine transfers the repository's
        // whole reachable history — 41 MB for a modest one — over the network,
        // on every mention, for a change that is usually a handful of commits.
        // Egress is billed and the wait belongs to the person who asked, so
        // the same bytes were being paid for twice on each dispatch.
        //
        // `have` is a claim a remote worker makes about its own cache, so it
        // is checked rather than trusted: the shape first, then whether this
        // repository actually holds that commit. A bundle whose prerequisite
        // the receiver cannot resolve is worse than a large one, because it
        // fails to unbundle at all — so anything unverifiable falls back to
        // full history, which is exactly the behaviour that came before.
        const usable =
          have !== undefined &&
          /^[0-9a-f]{40}$/u.test(have) &&
          (
            await this.git.run(
              [
                `--git-dir=${repository.path}`,
                "cat-file",
                "-e",
                `${have}^{commit}`,
              ],
              { allowFailure: true },
            )
          ).exitCode === 0;
        await this.git.run([
          `--git-dir=${repository.path}`,
          "bundle",
          "create",
          bundlePath,
          "--end-of-options",
          refName,
          ...(usable ? [`^${have}`] : []),
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

  /**
   * Every source path at this revision with the blob it resolves to.
   *
   * The object id is what makes an index reusable: content addresses this
   * file's parse, so a revision that changed three files can keep the other
   * four hundred without asking whether they moved, without a diff, and
   * without trusting that two revisions are related at all.
   */
  public async listFileEntries(
    repository: CanonicalRepository,
    revision: string,
  ): Promise<RepositoryFileEntry[]> {
    const result = await this.git.run([
      `--git-dir=${repository.path}`,
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      revision,
    ]);
    return result.stdout
      .split("\0")
      .filter((entry) => entry.length > 0)
      .flatMap((entry) => {
        // `<mode> SP <type> SP <oid> TAB <path>`, and `-z` means the path is
        // the raw remainder rather than a quoted string.
        const tab = entry.indexOf("\t");
        if (tab === -1) {
          return [];
        }
        const [, type = "", oid = ""] = entry.slice(0, tab).split(" ");
        // Submodules stay in the listing. They are real paths, and `listFiles`
        // has always reported them, so dropping them here would quietly shrink
        // the set that answers "does this declared path exist".
        return [{ path: normalizeRepositoryPath(entry.slice(tab + 1)), oid, type }];
      })
      .sort((left, right) => (left.path < right.path ? -1 : 1));
  }

  /**
   * A reader that answers many paths at this revision over one git process.
   *
   * The caller must `close()` it. Reads are answered in the order requested.
   */
  public openBatchReader(
    repository: CanonicalRepository,
    revision: string,
  ): GitBatchReader {
    return new GitBatchReader(repository.path, revision);
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
    await this.preserveLineEndings(repositoryPath);
  }

  /**
   * Stops git rewriting the bytes an agent wrote.
   *
   * Git for Windows ships `core.autocrlf=true` at system level, so a file
   * written with LF, committed, and checked back out comes back with CRLF.
   * That is a reasonable default for a person editing files on Windows and a
   * bad one here: this system's whole contract is that a change set is what
   * the agent produced. An agent that writes a file and reads it back after
   * landing was seeing different bytes than it wrote, which shows up as
   * spurious diff noise and — where an agent compares its own work — as work
   * that appears not to have been done.
   *
   * Set on the canonical repository, which is where it takes effect: a
   * worktree shares the config of the repository it belongs to, so every
   * workspace cut from this one inherits it.
   *
   * Deliberately independent of the host. A repository that round-trips
   * exactly on Linux and not on Windows is a repository whose behaviour
   * depends on which machine the control plane happens to be running, which
   * is not a difference anybody should have to know about.
   */
  private async preserveLineEndings(repositoryPath: string): Promise<void> {
    await this.git.run([
      `--git-dir=${repositoryPath}`,
      "config",
      "--local",
      "core.autocrlf",
      "false",
    ]);
    await this.git.run([
      `--git-dir=${repositoryPath}`,
      "config",
      "--local",
      "core.eol",
      "lf",
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
