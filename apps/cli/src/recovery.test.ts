import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
  InMemoryCoordinationStore,
} from "@coord/persistence";
import { RepositoryService } from "@coord/repository-service";
import { GitWorktreeWorkspaceManager } from "@coord/workspace-manager";

import { CoordinatorProject } from "./project.js";
import {
  drainInFlightWork,
  reapStrandedWork,
  recoverCoordinationState,
} from "./recovery.js";

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
      organizationId: DEFAULT_ORGANIZATION_ID,
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

/**
 * `createBundle` deletes its lease ref in a `finally`, which a killed process
 * never reaches. A survivor is not harmless: it holds every object it reaches
 * against `gc`, and bundling refuses to overwrite an existing ref, so that
 * lease can never be served again.
 */
test("recovery sweeps lease refs no active lease owns", async () => {
  const fixture = await createFixture();
  try {
    const git = fixture.repositories.getGitClient();
    const orphaned = "refs/coord/leases/lease_dead";
    await git.run([
      `--git-dir=${fixture.canonical.path}`,
      "update-ref",
      orphaned,
      fixture.version.revision,
    ]);

    const report = await recoverCoordinationState(
      fixture.project,
      fixture.store,
      fixture.repositories,
    );

    assert.deepEqual(report.removedLeaseRefs, [orphaned]);
    assert.deepEqual(report.warnings, []);
    const remaining = await git.run(
      [
        `--git-dir=${fixture.canonical.path}`,
        "show-ref",
        "--verify",
        "--quiet",
        "--",
        orphaned,
      ],
      { allowFailure: true },
    );
    assert.notEqual(remaining.exitCode, 0);

    // The canonical branch is not a lease ref and must be untouched.
    const canonicalStill = await fixture.repositories.getCanonicalVersion(
      fixture.canonical,
    );
    assert.equal(canonicalStill.revision, fixture.version.revision);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

/**
 * Canonical mirrors are bare, and git only defaults `core.logAllRefUpdates`
 * to true for non-bare repositories — so every promotion moved the branch
 * leaving no trace git itself had written.
 */
test("an imported mirror keeps a reflog of its canonical branch", async () => {
  const fixture = await createFixture();
  try {
    const git = fixture.repositories.getGitClient();
    const setting = await git.run([
      `--git-dir=${fixture.canonical.path}`,
      "config",
      "--get",
      "core.logAllRefUpdates",
    ]);
    assert.equal(setting.stdout.trim(), "true");

    // A real promotion, so the branch genuinely moves: git writes no reflog
    // entry for an update that changes nothing.
    const workspaces = new GitWorktreeWorkspaceManager(git);
    const workspace = await workspaces.create({
      taskId: "task_reflog",
      rootPath: fixture.project.workspaceRoot,
      repository: fixture.canonical,
      baseVersion: fixture.version,
    });
    await writeFile(
      path.join(workspace.path, "value.js"),
      "export const v = 2;\n",
    );
    const candidate = await fixture.repositories.commitAll(
      workspace.path,
      "advance canonical",
    );
    assert.ok(candidate !== undefined);
    assert.equal(
      await fixture.repositories.promote(
        fixture.canonical,
        candidate,
        fixture.version.revision,
      ),
      true,
    );
    await workspaces.destroy(workspace);

    // The move is now recorded by git itself, independently of the
    // coordinator's own audit trail.
    const reflog = await git.run([
      `--git-dir=${fixture.canonical.path}`,
      "reflog",
      "show",
      `refs/heads/${fixture.canonical.branch}`,
    ]);
    assert.match(reflog.stdout, new RegExp(candidate.slice(0, 7), "u"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the stranded sweep spares a fresh claim and requeues an abandoned one", async () => {
  const store = new InMemoryCoordinationStore();
  await store.saveRepository({
    id: "repo_sweep",
    path: "/tmp/repo_sweep.git",
    branch: "main",
  });
  const task = await store.submitTask({
    repositoryId: "repo_sweep",
    objective: "work whose run died without settling it",
    agentId: "generic-cli",
    validationCommands: [],
  });
  const thread = await store.appendChannelMessage({
    repositoryId: "repo_sweep",
    projectId: DEFAULT_PROJECT_ID,
    kind: "user",
    authorId: "user_1",
    content: "@claude do the thing",
  });
  await store.setChannelMessageTask("repo_sweep", thread.id, task.id);
  await store.claimSubmittedTasks("repo_sweep");

  // A claim made a moment ago is a run that has just started, not debris.
  assert.deepEqual((await reapStrandedWork(store)).requeuedTasks, []);
  assert.equal(
    (await store.listSubmittedTasks()).at(0)?.status,
    "claimed",
  );

  const report = await reapStrandedWork(store, {
    claimedBefore: new Date(Date.now() + 1_000).toISOString(),
  });
  assert.deepEqual(report.requeuedTasks, [task.id]);
  assert.deepEqual(report.warnings, []);
  assert.equal((await store.listSubmittedTasks()).at(0)?.status, "submitted");

  // The thread hears about it rather than sitting on its last progress line.
  const [root] = await store.listChannelMessages("repo_sweep", "user_1");
  const notices = (root?.replies ?? []).filter(
    (reply) => reply.kind === "system",
  );
  assert.equal(notices.length, 1);
  assert.match(notices[0]?.content ?? "", /restarted/u);

  // And is told once, not once per sweep.
  await store.claimSubmittedTasks("repo_sweep");
  await reapStrandedWork(store, {
    claimedBefore: new Date(Date.now() + 1_000).toISOString(),
  });
  const [again] = await store.listChannelMessages("repo_sweep", "user_1");
  assert.equal(
    (again?.replies ?? []).filter((reply) => reply.kind === "system").length,
    1,
  );
});

test("the stranded sweep leaves a claim with a live lease behind it alone", async () => {
  const store = new InMemoryCoordinationStore();
  await store.saveRepository({
    id: "repo_live",
    path: "/tmp/repo_live.git",
    branch: "main",
  });
  const user = await store.createUser({
    email: "live@example.com",
    displayName: "Live",
    passwordDigest: "digest",
  });
  const worker = await store.registerWorker({
    userId: user.id,
    organizationId: DEFAULT_ORGANIZATION_ID,
    name: "live-worker",
    adapters: ["generic-cli"],
    version: "1",
  });
  const task = await store.submitTask({
    repositoryId: "repo_live",
    objective: "a remote worker is on this right now",
    agentId: "generic-cli",
    validationCommands: [],
  });
  const leased = await store.leaseNextTask({
    workerId: worker.id,
    baseRevision: "0".repeat(40),
    ttlMs: 60 * 60 * 1000,
  });
  assert.ok(leased, "the remote worker should have taken the task");
  assert.equal(leased.task.id, task.id);

  const report = await reapStrandedWork(store, {
    claimedBefore: new Date(Date.now() + 1_000).toISOString(),
  });
  assert.deepEqual(report.requeuedTasks, []);
  assert.equal((await store.listSubmittedTasks()).at(0)?.status, "claimed");
});

test("a restart only promises a restart to work it actually requeued", async () => {
  // The bug this pins: releasing a lease and requeueing its task are two
  // different events, and the drain treated them as one. `finishWorkLease`
  // answers for the *lease*; it only returns the task to the queue when the
  // row is `claimed`. A task that had moved on — `open` because a
  // conversational turn had landed, `paused` because a person stopped it —
  // had its lease released and was then told in its thread that it would
  // "start again shortly". Nothing was ever going to start it: no sweep reads
  // those statuses and the queue resume reads only `submitted`.
  for (const [label, advance, expected] of [
    ["claimed", async () => {}, "submitted"],
    [
      "open",
      async (store: InMemoryCoordinationStore, taskId: string) => {
        await store.openSubmittedTask(taskId);
      },
      "open",
    ],
  ] as const) {
    const store = new InMemoryCoordinationStore();
    await store.saveRepository({
      id: "repo_drain",
      path: "/tmp/repo_drain.git",
      branch: "main",
    });
    const user = await store.createUser({
      email: `drain-${label}@example.com`,
      displayName: "Drain",
      passwordDigest: "digest",
    });
    // The name the web control plane's in-process runner registers under,
    // which is the only worker the drain hands work back for.
    const worker = await store.registerWorker({
      userId: user.id,
      organizationId: DEFAULT_ORGANIZATION_ID,
      name: "in-process-runner",
      adapters: ["generic-cli"],
      version: "1",
    });
    const task = await store.submitTask({
      repositoryId: "repo_drain",
      projectId: DEFAULT_PROJECT_ID,
      objective: "an agent is on this right now",
      agentId: "generic-cli",
      validationCommands: [],
      submittedBy: user.id,
    });
    const thread = await store.appendChannelMessage({
      repositoryId: "repo_drain",
      projectId: DEFAULT_PROJECT_ID,
      kind: "user",
      authorId: user.id,
      content: "@claude do the thing",
    });
    await store.setChannelMessageTask("repo_drain", thread.id, task.id);
    assert.ok(
      await store.leaseNextTask({
        workerId: worker.id,
        baseRevision: "0".repeat(40),
        ttlMs: 5 * 60 * 1000,
      }),
      `${label}: the runner should have taken the task`,
    );
    await advance(store, task.id);

    const requeued = await drainInFlightWork(store);

    const after = (await store.listSubmittedTasks()).at(0)?.status;
    assert.equal(after, expected, label);
    const [root] = await store.listChannelMessages("repo_drain", user.id);
    const notices = (root?.replies ?? []).filter(
      (reply) => reply.kind === "system",
    );
    if (expected === "submitted") {
      // Genuinely queued again, so the thread is told and the queue resume —
      // which reads `submitted` and nothing else — will find it.
      assert.deepEqual(requeued, [task.id], label);
      assert.equal(notices.length, 1, label);
      assert.match(notices[0]?.content ?? "", /start again shortly/u, label);
    } else {
      // Left where it was, so nothing is claimed on its behalf. Silence is
      // the honest answer: from the reader's side nothing about it changed.
      assert.deepEqual(requeued, [], label);
      assert.deepEqual(
        notices.map((notice) => notice.content),
        [],
        `${label}: a task that was not requeued was promised a restart`,
      );
    }
  }
});
