import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { InMemoryCoordinationStore } from "@coord/persistence";
import { RepositoryService } from "@coord/repository-service";
import { GitWorktreeWorkspaceManager } from "@coord/workspace-manager";

import { CoordinatorProject } from "./project.js";
import { recoverCoordinationState } from "./recovery.js";

/**
 * Crash recovery is exercised the way a crash actually leaves things: state
 * written mid-flight and never finalized, worktrees on disk that no process
 * remembers, and live remote leases that must be left alone.
 */

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "crecover-"));
  const project = await CoordinatorProject.init(root);
  const store = new InMemoryCoordinationStore();
  const repositories = new RepositoryService();

  const sourcePath = path.join(root, "src-repo");
  await repositories.initializeWorkingRepository(sourcePath);
  await writeFile(path.join(sourcePath, "value.js"), "export const v = 1;\n");
  await repositories.commitAll(sourcePath, "seed");
  const canonical = await repositories.importLocalRepository(
    sourcePath,
    path.join(root, "canon.git"),
    "repo_recover",
    "main",
  );
  await store.saveRepository({
    id: canonical.id,
    path: canonical.path,
    branch: canonical.branch,
  });
  const version = await repositories.getCanonicalVersion(canonical);
  return { root, project, store, repositories, canonical, version };
}

test("recovery requeues stranded claims but leaves live remote leases alone", async () => {
  const fixture = await createFixture();
  try {
    const { store } = fixture;
    const user = await store.createUser({
      email: "recover@example.com",
      displayName: "Recover",
      passwordDigest: "digest",
    });
    const worker = await store.registerWorker({
      userId: user.id,
      name: "live-worker",
      adapters: ["generic-cli"],
      version: "1",
    });

    // A remote task with a live (unexpired) lease: must not be disturbed.
    const remoteTask = await store.submitTask({
      repositoryId: "repo_recover",
      objective: "remote work in flight",
      agentId: "generic-cli",
      validationCommands: [],
    });
    const leased = await store.leaseNextTask({
      workerId: worker.id,
      baseRevision: fixture.version.revision,
      ttlMs: 60 * 60 * 1000,
    });
    assert.equal(leased?.task.id, remoteTask.id);

    // A locally claimed task whose process died: no lease exists for it.
    const strandedTask = await store.submitTask({
      repositoryId: "repo_recover",
      objective: "stranded local work",
      agentId: "generic-cli",
      validationCommands: [],
    });
    await store.claimSubmittedTasks("repo_recover");
    // claimSubmittedTasks claims every pending task; the remote one is
    // already claimed via its lease, so only the stranded one moved.

    const report = await recoverCoordinationState(
      fixture.project,
      fixture.store,
      fixture.repositories,
    );
    assert.deepEqual(report.requeuedTasks, [strandedTask.id]);
    assert.deepEqual(report.expiredLeases, []);

    const tasks = await store.listSubmittedTasks();
    assert.equal(
      tasks.find((task) => task.id === strandedTask.id)?.status,
      "submitted",
    );
    assert.equal(
      tasks.find((task) => task.id === remoteTask.id)?.status,
      "claimed",
    );
    assert.equal(
      (await store.getWorkLease(leased.lease.id))?.status,
      "active",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("recovery fails stranded runs and their in-flight tasks", async () => {
  const fixture = await createFixture();
  try {
    const { store } = fixture;
    const run = await store.createRun({
      repository: {
        id: "repo_recover",
        path: fixture.canonical.path,
        branch: "main",
      },
      mode: "coordinated",
      scenario: "crash",
      baseVersion: fixture.version,
    });
    await store.saveTask(run.id, {
      id: "task_mid_flight",
      objective: "died mid-run",
      agentId: "generic-cli",
      validationCommands: [],
    });
    await store.saveTaskStatus(run.id, "task_mid_flight", "running");

    const report = await recoverCoordinationState(
      fixture.project,
      fixture.store,
      fixture.repositories,
    );
    assert.deepEqual(report.failedRuns, [run.id]);

    const detail = await store.getRun(run.id);
    assert.equal(detail?.run.status, "failed");
    assert.equal(detail?.tasks[0]?.status, "failed");
    assert.match(detail?.tasks[0]?.explanation ?? "", /restarted/u);
    const audit = await store.listAudit();
    assert.ok(audit.some((event) => event.type === "recovery_completed"));

    // Idempotent: a second pass finds nothing.
    const again = await recoverCoordinationState(
      fixture.project,
      fixture.store,
      fixture.repositories,
    );
    assert.deepEqual(again.failedRuns, []);
    assert.deepEqual(again.requeuedTasks, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("recovery integrates a changeset the crash stranded before promotion", async () => {
  const fixture = await createFixture();
  try {
    const { store } = fixture;
    // The queue task the crashed process was working through, claimed but
    // never completed — exactly the state a crash between collecting a
    // changeset and promoting it leaves behind.
    const submitted = await store.submitTask({
      repositoryId: "repo_recover",
      objective: "raise the value",
      agentId: "generic-cli",
      validationCommands: [],
    });
    await store.claimSubmittedTasks("repo_recover");

    const run = await store.createRun({
      repository: {
        id: "repo_recover",
        path: fixture.canonical.path,
        branch: "main",
      },
      mode: "coordinated",
      baseVersion: fixture.version,
    });
    await store.saveTask(run.id, {
      id: submitted.id,
      objective: "raise the value",
      agentId: "generic-cli",
      validationCommands: [],
    });
    await store.saveTaskStatus(run.id, submitted.id, "running");

    // A real unified diff, because recovery integrates it for real: the
    // patch is applied three-way, compared against its declaration, and
    // promoted by compare-and-swap like any other changeset.
    const patch = [
      "diff --git a/value.js b/value.js",
      "--- a/value.js",
      "+++ b/value.js",
      "@@ -1 +1 @@",
      "-export const v = 1;",
      "+export const v = 2;",
      "",
    ].join("\n");
    await store.saveChangeSet(run.id, {
      id: "cs_stranded",
      taskId: submitted.id,
      baseVersion: fixture.version.sequence,
      baseRevision: fixture.version.revision,
      patches: [{ path: "value.js", status: "modified", patch }],
      symbolsChanged: ["v"],
      commandsRun: [],
      tests: [],
      dependenciesChanged: [],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "raised the value",
      createdAt: new Date().toISOString(),
    });

    const report = await recoverCoordinationState(
      fixture.project,
      fixture.store,
      fixture.repositories,
    );

    assert.deepEqual(report.resumedTasks, [submitted.id]);
    // Resumed, not restarted: the task is finished, not back in the queue.
    assert.deepEqual(report.requeuedTasks, []);
    assert.deepEqual(report.failedRuns, []);

    const tasks = await store.listSubmittedTasks();
    assert.equal(
      tasks.find((task) => task.id === submitted.id)?.status,
      "integrated",
    );

    // Canonical really moved; the work was promoted, not merely marked done.
    const version = await fixture.repositories.getCanonicalVersion(
      fixture.canonical,
    );
    assert.notEqual(version.revision, fixture.version.revision);
    assert.equal(
      await fixture.repositories.readFile(
        fixture.canonical,
        version.revision,
        "value.js",
      ),
      "export const v = 2;\n",
    );

    const detail = await store.getRun(run.id);
    assert.equal(detail?.run.status, "completed");
    assert.equal(detail?.tasks[0]?.status, "integrated");
    assert.equal(detail?.integrations.at(-1)?.status, "integrated");
    const audit = await store.listAudit();
    assert.ok(
      audit.some(
        (event) =>
          event.type === "canonical_promoted" &&
          event.data["stage"] === "crash_recovery",
      ),
    );

    // Idempotent: the changeset now has an integration record, so a second
    // pass must not re-apply it.
    const again = await recoverCoordinationState(
      fixture.project,
      fixture.store,
      fixture.repositories,
    );
    assert.deepEqual(again.resumedTasks, []);
    assert.deepEqual(again.failedRuns, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("recovery clears orphaned worktrees and prunes their registrations", async () => {
  const fixture = await createFixture();
  try {
    // A real worktree, created against the canonical mirror and then
    // abandoned — exactly what a crash mid-execution leaves behind.
    const workspaces = new GitWorktreeWorkspaceManager(
      fixture.repositories.getGitClient(),
    );
    const workspace = await workspaces.create({
      taskId: "task_orphan",
      rootPath: fixture.project.workspaceRoot,
      repository: fixture.canonical,
      baseVersion: fixture.version,
    });
    await mkdir(fixture.project.integrationRoot, { recursive: true });
    await writeFile(
      path.join(fixture.project.integrationRoot, "leftover.txt"),
      "debris",
    );

    const before = await fixture.repositories
      .getGitClient()
      .run(["-C", fixture.canonical.path, "worktree", "list"]);
    assert.ok(before.stdout.includes(path.basename(workspace.path)));

    const report = await recoverCoordinationState(
      fixture.project,
      fixture.store,
      fixture.repositories,
    );
    assert.ok(report.removedDirectories.length >= 2);
    assert.deepEqual(report.prunedRepositories, ["repo_recover"]);
    assert.deepEqual(report.warnings, []);

    assert.deepEqual(
      await readdir(fixture.project.workspaceRoot).catch(() => []),
      [],
    );
    const after = await fixture.repositories
      .getGitClient()
      .run(["-C", fixture.canonical.path, "worktree", "list"]);
    assert.ok(!after.stdout.includes(path.basename(workspace.path)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
