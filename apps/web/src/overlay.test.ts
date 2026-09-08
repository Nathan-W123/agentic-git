import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoordinatorProject } from "@coord/cli/project";
import {
  DEFAULT_PROJECT_ID,
  InMemoryCoordinationStore,
} from "@coord/persistence";
import { RepositoryService } from "@coord/repository-service";

import {
  MAX_WRITE_BYTES,
  OverlayError,
  OverlayWorkspaceService,
  resolveOverlayPath,
} from "./overlay.js";

/**
 * The overlay workspace is the dashboard's write surface, so these tests are
 * mostly about what it must never do: reach outside its own directory, touch
 * git metadata, run commands on the host, address another user's overlay, or
 * write canonical directly. The happy paths ride along.
 */

interface Harness {
  root: string;
  store: InMemoryCoordinationStore;
  project: CoordinatorProject;
  repositories: RepositoryService;
  service: OverlayWorkspaceService;
  repositoryId: string;
  firstRevision: string;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coverlay-"));
  const projectRoot = path.join(root, "cp");
  await mkdir(projectRoot, { recursive: true });
  const project = await CoordinatorProject.init(projectRoot);
  project.config.validationCommands = [];
  await project.save();

  const sourcePath = path.join(root, "src-repo");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "src", "value.js"),
    "export const value = 1;\n",
    "utf8",
  );
  await repositories.commitAll(sourcePath, "seed");
  const canonical = await repositories.importLocalRepository(
    sourcePath,
    path.join(root, "canon.git"),
    "repo_overlay",
    "main",
  );
  const firstRevision = (await repositories.getCanonicalVersion(canonical))
    .revision;

  const store = new InMemoryCoordinationStore();
  await store.saveRepository({
    id: canonical.id,
    path: canonical.path,
    branch: canonical.branch,
  });
  await store.linkRepository(DEFAULT_PROJECT_ID, canonical.id);

  const service = new OverlayWorkspaceService(project, store, repositories);
  return {
    root,
    store,
    project,
    repositories,
    service,
    repositoryId: canonical.id,
    firstRevision,
  };
}

function unixLines(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

function scopeFor(harness: Harness, userId = "user_alpha") {
  return {
    userId,
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: harness.repositoryId,
  };
}

test("overlay paths cannot escape the workspace or touch git metadata", () => {
  const root = path.join(os.tmpdir(), "overlay-root");
  assert.ok(resolveOverlayPath(root, "src/value.js").startsWith(path.resolve(root)));
  assert.ok(resolveOverlayPath(root, "deep/../src/ok.txt"));
  for (const bad of [
    "../outside.txt",
    "src/../../outside.txt",
    "..",
    "",
    "a\0b",
    ".git",
    ".git/config",
    "nested/.git/hooks/pre-commit",
    path.join(os.homedir(), "abs.txt"),
  ]) {
    assert.throws(
      () => resolveOverlayPath(root, bad),
      OverlayError,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

test("an overlay is created from canonical, edited, and reported dirty", async () => {
  const harness = await createHarness();
  const scope = scopeFor(harness);

  const before = await harness.service.status(scope);
  assert.equal(before.exists, false);
  assert.equal(before.canonicalRevision, harness.firstRevision);

  const opened = await harness.service.open(scope);
  assert.equal(opened.exists, true);
  assert.equal(opened.baseRevision, harness.firstRevision);
  assert.deepEqual(opened.dirtyFiles, []);

  const files = await harness.service.listFiles(scope);
  assert.deepEqual(
    files.map((entry) => entry.path),
    ["src/value.js"],
  );

  const read = await harness.service.readOverlayFile(scope, "src/value.js");
  // Git's autocrlf may smudge LF to CRLF in the worktree on Windows.
  assert.equal(unixLines(read.content), "export const value = 1;\n");
  assert.equal(read.binary, false);

  await harness.service.writeOverlayFile(
    scope,
    "src/value.js",
    "export const value = 2;\n",
  );
  await harness.service.writeOverlayFile(
    scope,
    "src/new-file.js",
    "export const added = true;\n",
  );
  const dirty = await harness.service.status(scope);
  assert.deepEqual(
    [...dirty.dirtyFiles].sort(),
    ["src/new-file.js", "src/value.js"],
  );

  // Reset returns to canonical and drops the edits.
  const reset = await harness.service.reset(scope);
  assert.deepEqual(reset.dirtyFiles, []);
  const after = await harness.service.readOverlayFile(scope, "src/value.js");
  assert.equal(unixLines(after.content), "export const value = 1;\n");
});

test("concurrent opens converge on one valid overlay", async () => {
  const harness = await createHarness();
  const scope = scopeFor(harness);
  const [first, second] = await Promise.all([
    harness.service.open(scope),
    harness.service.open(scope),
  ]);

  assert.equal(first.exists, true);
  assert.equal(second.exists, true);
  assert.equal(first.baseRevision, second.baseRevision);
  assert.equal(
    unixLines(
      (await harness.service.readOverlayFile(scope, "src/value.js")).content,
    ),
    "export const value = 1;\n",
  );
});

test("overlay file APIs never follow symlinks outside the workspace", async () => {
  const harness = await createHarness();
  const scope = scopeFor(harness);
  await harness.service.open(scope);

  const outside = path.join(harness.root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.txt"), "host secret\n", "utf8");
  const link = path.join(
    harness.service.overlayDirectory(scope),
    "outside-link",
  );
  await symlink(
    outside,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );

  await assert.rejects(
    harness.service.readOverlayFile(scope, "outside-link/secret.txt"),
    (error: unknown) =>
      error instanceof OverlayError && error.code === "invalid_path",
  );
  await assert.rejects(
    harness.service.writeOverlayFile(
      scope,
      "outside-link/secret.txt",
      "overwritten\n",
    ),
    (error: unknown) =>
      error instanceof OverlayError && error.code === "invalid_path",
  );
  assert.equal(
    await readFile(path.join(outside, "secret.txt"), "utf8"),
    "host secret\n",
  );
});

test("two users get disjoint overlays and cannot address each other's", async () => {
  const harness = await createHarness();
  const alpha = scopeFor(harness, "user_alpha");
  const beta = scopeFor(harness, "user_beta");

  await harness.service.open(alpha);
  await harness.service.writeOverlayFile(alpha, "src/value.js", "alpha\n");

  // Beta's scope simply has no workspace; alpha's edits are unreachable.
  assert.notEqual(
    harness.service.overlayDirectory(alpha),
    harness.service.overlayDirectory(beta),
  );
  await assert.rejects(
    harness.service.readOverlayFile(beta, "src/value.js"),
    (error: unknown) =>
      error instanceof OverlayError && error.code === "no_workspace",
  );

  await harness.service.open(beta);
  const betaRead = await harness.service.readOverlayFile(beta, "src/value.js");
  assert.equal(unixLines(betaRead.content), "export const value = 1;\n");
});

test("a workspace record claimed by another user is refused, not adopted", async () => {
  const harness = await createHarness();
  const alpha = scopeFor(harness, "user_alpha");
  await harness.service.open(alpha);

  // Simulate a corrupted or hand-tampered ownership record.
  const metaPath = `${harness.service.overlayDirectory(alpha)}.json`;
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  meta.userId = "user_mallory";
  await writeFile(metaPath, JSON.stringify(meta), "utf8");

  await assert.rejects(
    harness.service.status(alpha),
    (error: unknown) =>
      error instanceof OverlayError && error.code === "overlay_corrupt",
  );
});

test("oversized writes are refused before touching disk", async () => {
  const harness = await createHarness();
  const scope = scopeFor(harness);
  await harness.service.open(scope);
  await assert.rejects(
    harness.service.writeOverlayFile(
      scope,
      "big.txt",
      "x".repeat(MAX_WRITE_BYTES + 1),
    ),
    (error: unknown) =>
      error instanceof OverlayError && error.code === "file_too_large",
  );
});

test("exec refuses when no Docker sandbox is configured — never host exec", async () => {
  const harness = await createHarness();
  const scope = scopeFor(harness);
  await harness.service.open(scope);
  assert.equal(harness.project.config.sandbox, undefined);
  await assert.rejects(
    harness.service.exec(scope, "echo hello"),
    (error: unknown) =>
      error instanceof OverlayError &&
      error.status === 501 &&
      error.code === "sandbox_unavailable",
  );
});

test("submit pushes overlay edits through the pipeline into canonical", async () => {
  const harness = await createHarness();
  const scope = scopeFor(harness);
  await harness.service.open(scope);

  const empty = await harness.service.submit(scope, "nothing yet");
  assert.equal(empty.status, "noop");

  await harness.service.writeOverlayFile(
    scope,
    "src/value.js",
    "export const value = 42;\n",
  );
  const result = await harness.service.submit(scope, "bump the value");
  assert.equal(result.status, "integrated");
  assert.ok(result.runId);

  // Canonical advanced through promotion, not through a direct write: the
  // run record and audit chain exist, and the new head carries the edit.
  const canonical = await harness.repositories.getCanonicalVersion({
    id: harness.repositoryId,
    path: (await harness.store.getRepository(harness.repositoryId))!.path,
    branch: "main",
  });
  assert.notEqual(canonical.revision, harness.firstRevision);
  const detail = await harness.store.getRun(result.runId!);
  assert.ok(detail);
  assert.equal(detail!.integrations.at(-1)?.status, "integrated");
  assert.equal(detail!.run.status, "completed");
  const audit = (await harness.store.listAuditEvents({ limit: 1000 })).map(
    (record) => record.event.type,
  );
  assert.ok(audit.includes("canonical_promoted"));

  // The overlay was rebased onto the new head, ready for the next edit.
  const after = await harness.service.status(scope);
  assert.equal(after.exists, true);
  assert.equal(after.baseRevision, canonical.revision);
  assert.deepEqual(after.dirtyFiles, []);
});

test("a stale overlay fails promotion instead of clobbering newer canonical", async () => {
  const harness = await createHarness();
  const alpha = scopeFor(harness, "user_alpha");
  const beta = scopeFor(harness, "user_beta");
  await harness.service.open(alpha);
  await harness.service.open(beta);

  await harness.service.writeOverlayFile(alpha, "src/value.js", "alpha wins\n");
  const first = await harness.service.submit(alpha, "alpha edit");
  assert.equal(first.status, "integrated");

  // Beta's overlay is still based on the old canonical revision.
  await harness.service.writeOverlayFile(beta, "src/value.js", "beta late\n");
  const second = await harness.service.submit(beta, "beta edit");
  assert.notEqual(second.status, "integrated");

  // The refusal reached integration and was recorded there — this is the
  // promotion path, not the policy path that fails before integrating.
  assert.ok(second.runId);
  const failed = await harness.store.getRun(second.runId!);
  assert.equal(failed?.integrations.at(-1)?.status, second.status);
  // So the run must say so too. Reporting "completed" for a submit that never
  // reached canonical is the one thing a reader cannot recover from.
  assert.equal(failed?.run.status, "failed");
  assert.ok(failed?.run.finishedAt);

  const canonicalPath = (await harness.store.getRepository(
    harness.repositoryId,
  ))!.path;
  const canonical = await harness.repositories.getCanonicalVersion({
    id: harness.repositoryId,
    path: canonicalPath,
    branch: "main",
  });
  const content = await harness.repositories.readFile(
    { id: harness.repositoryId, path: canonicalPath, branch: "main" },
    canonical.revision,
    "src/value.js",
  );
  assert.equal(content, "alpha wins\n");
});

test("discard removes the worktree and its ownership record", async () => {
  const harness = await createHarness();
  const scope = scopeFor(harness);
  await harness.service.open(scope);
  const directory = harness.service.overlayDirectory(scope);
  await harness.service.discard(scope);
  await assert.rejects(stat(directory));
  const status = await harness.service.status(scope);
  assert.equal(status.exists, false);
});

test("a file can be moved inside the overlay, and the move is a change like any other", async () => {
  // A move needs no pipeline of its own: the overlay is the staging area every
  // edit already goes through, so a rename arrives at review as a deletion and
  // an addition of the same content, revertible by the same means.
  const harness = await createHarness();
  const scope = scopeFor(harness);
  await harness.service.open(scope);

  await harness.service.moveOverlayFile(
    scope,
    "src/value.js",
    "src/renamed/value.js",
  );

  const files = await harness.service.listFiles(scope);
  assert.deepEqual(
    files.map((entry) => entry.path),
    ["src/renamed/value.js"],
    "the file should exist only at its new path",
  );
  const moved = await harness.service.readOverlayFile(
    scope,
    "src/renamed/value.js",
  );
  assert.equal(unixLines(moved.content), "export const value = 1;\n");

  // And the overlay reports itself dirty, which is what carries the move into
  // a changeset when the workspace is submitted.
  const status = await harness.service.status(scope);
  assert.equal(status.exists, true);
  assert.notDeepEqual(status.dirtyFiles, []);
});

test("a move refuses to overwrite, or to invent a source", async () => {
  // Overwriting silently would destroy somebody's work with no record that it
  // was ever there, which is worse than refusing.
  const harness = await createHarness();
  const scope = scopeFor(harness);
  await harness.service.open(scope);
  await harness.service.writeOverlayFile(scope, "src/other.js", "export const other = 1;\n");

  await assert.rejects(
    async () =>
      await harness.service.moveOverlayFile(scope, "src/value.js", "src/other.js"),
    (error: unknown) => (error as { code?: string }).code === "target_exists",
  );
  await assert.rejects(
    async () =>
      await harness.service.moveOverlayFile(scope, "src/absent.js", "src/new.js"),
    (error: unknown) => (error as { code?: string }).code === "file_not_found",
  );
  // Both files are still where they were.
  const files = await harness.service.listFiles(scope);
  assert.deepEqual(
    files.map((entry) => entry.path).sort(),
    ["src/other.js", "src/value.js"],
  );
});

test("a move cannot escape the overlay", async () => {
  // Same guarantee the read and write paths have: a path is resolved inside
  // the overlay or refused, so a rename is not a way out of it.
  const harness = await createHarness();
  const scope = scopeFor(harness);
  await harness.service.open(scope);
  const cases: [string, string][] = [
    ["src/value.js", "../escaped.js"],
    ["../../etc/passwd", "src/stolen.js"],
    ["src/value.js", ".git/hooks/pre-commit"],
  ];
  for (const [from, to] of cases) {
    await assert.rejects(
      async () => await harness.service.moveOverlayFile(scope, from, to),
      `${from} -> ${to} should be refused`,
    );
  }
});

/* ------------------------------------------------ a branch of one's own ---- */

test("a branch gets its own workspace, and one without a branch keeps its own", async () => {
  const harness = await createHarness();
  const plain = scopeFor(harness);
  const onBranch = { ...plain, branch: "kumi/payments-v2" };
  const onAnother = { ...plain, branch: "kumi/retry-backoff" };

  // The directory is the identity. Two branches are two checkouts — not one
  // that switches under somebody's unsaved edits — and a workspace with no
  // branch is a third thing again.
  const directories = [plain, onBranch, onAnother].map((scope) =>
    harness.service.overlayDirectory(scope),
  );
  assert.equal(new Set(directories).size, 3, directories.join(" "));

  // And the one with no branch hashes to exactly what it hashed to *before*
  // branches existed. This is the migration, and it is the whole reason the
  // branch is appended rather than always included: an overlay directory is
  // found by recomputing its name, so a scheme that hashes the branch
  // unconditionally — even as an empty string — renames every overlay on disk
  // at the moment of deploy and orphans every workspace anybody had open,
  // silently, with the old directories left behind as garbage.
  //
  // Pinned against a literal digest rather than against this function's own
  // output for another scope. Comparing the scheme to itself is vacuous here:
  // a scheme that appended `\0` to every key would keep absent and empty
  // agreeing with each other while agreeing with nothing already on disk.
  // The constant is sha256("user_alpha\0project_local\0repo_overlay") — the
  // key the released code builds — truncated the way the directory name is.
  const beforeBranchesExisted = "9be920ed3d7bf3478207";
  assert.equal(
    path.basename(harness.service.overlayDirectory(plain)),
    beforeBranchesExisted,
  );
  assert.equal(
    path.basename(harness.service.overlayDirectory({ ...plain, branch: "" })),
    beforeBranchesExisted,
    "an empty branch has to name the same directory as no branch at all",
  );
});

test("a branch workspace is cut from that branch, not from canonical", async () => {
  const harness = await createHarness();
  const stored = await harness.store.getRepository(harness.repositoryId);
  const git = harness.repositories.getGitClient();
  const work = path.join(harness.root, "wt-branch");
  await git.run([
    `--git-dir=${stored?.path ?? ""}`,
    "worktree",
    "add",
    "-b",
    "kumi/payments-v2",
    work,
    "HEAD",
  ]);
  await writeFile(
    path.join(work, "src", "value.js"),
    "export const value = 99;\n",
    "utf8",
  );
  await harness.repositories.commitAll(work, "raise the value on the branch");

  // Canonical still says 1; the branch says 99. A workspace opened for the
  // branch has to show 99, or the Files list in a work channel is the
  // repository's code with the channel's name on it — which is worse than
  // showing nothing, because it looks right.
  const onBranch = { ...scopeFor(harness), branch: "kumi/payments-v2" };
  await harness.service.open(onBranch);
  const fromBranch = await harness.service.readOverlayFile(onBranch, "src/value.js");
  assert.match(unixLines(fromBranch.content), /value = 99/u);

  const plain = scopeFor(harness);
  await harness.service.open(plain);
  const fromCanonical = await harness.service.readOverlayFile(plain, "src/value.js");
  assert.match(unixLines(fromCanonical.content), /value = 1/u);

  // Both exist at once, in their own directories, with their own edits. Two
  // channels being worked on side by side is the ordinary case, not a
  // conflict to resolve.
  await harness.service.writeOverlayFile(onBranch, "src/value.js", "export const value = 100;\n");
  const untouched = await harness.service.readOverlayFile(plain, "src/value.js");
  assert.match(unixLines(untouched.content), /value = 1/u);
});

test("a workspace record cannot be reinterpreted as another branch's", async () => {
  const harness = await createHarness();
  const stored = await harness.store.getRepository(harness.repositoryId);
  const git = harness.repositories.getGitClient();
  const work = path.join(harness.root, "wt-claim");
  await git.run([
    `--git-dir=${stored?.path ?? ""}`,
    "worktree",
    "add",
    "-b",
    "kumi/claimed",
    work,
    "HEAD",
  ]);
  await harness.repositories.commitAll(work, "a commit on the branch");

  const onBranch = { ...scopeFor(harness), branch: "kumi/claimed" };
  await harness.service.open(onBranch);

  // The directory already hashes the branch, so a record whose branch does
  // not match the scope reading it means either a hand-edited file or a hash
  // collision. Refused, not reconciled — the same posture the owner check
  // takes, and for the same reason: the alternative is quietly handing
  // somebody a checkout of work that is not what they asked for.
  const metaPath = `${harness.service.overlayDirectory(onBranch)}.json`;
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  assert.equal(meta.branch, "kumi/claimed");
  await writeFile(
    metaPath,
    JSON.stringify({ ...meta, branch: "kumi/somebody-elses" }, undefined, 2),
    "utf8",
  );
  await assert.rejects(
    async () => await harness.service.status(onBranch),
    (error: unknown) =>
      error instanceof OverlayError && error.code === "overlay_corrupt",
  );
});
