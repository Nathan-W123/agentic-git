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
