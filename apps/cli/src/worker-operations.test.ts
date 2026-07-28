import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_PROJECT_ID,
  InMemoryCoordinationStore,
  PostgresCoordinationStore,
  type CoordinationStore,
} from "@coord/persistence";
import {
  createScratchDatabase,
  startPostgresTestServer,
} from "@coord/persistence/testing";
import { GitClient, RepositoryService } from "@coord/repository-service";
import type { AgentPlan, ChangeSet } from "@coord/shared-types";
import { GitWorktreeWorkspaceManager } from "@coord/workspace-manager";

import {
  acceptWorkResult,
  leaseBundle,
  leaseWork,
} from "./worker-operations.js";

/**
 * The control-plane half of the worker protocol, tested against a real Git
 * repository rather than a stub, because the point of the bundle is that a
 * worker with no filesystem access can reconstruct the workspace from it.
 */

interface Harness {
  root: string;
  store: CoordinationStore;
  repositories: RepositoryService;
  workerId: string;
  revision: string;
}

async function createHarness(
  store: CoordinationStore = new InMemoryCoordinationStore(),
): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cwork-"));
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
    "repo_worker",
    "main",
  );
  const version = await repositories.getCanonicalVersion(canonical);

  await store.saveRepository({
    id: canonical.id,
    path: canonical.path,
    branch: canonical.branch,
  });
  const user = await store.createUser({
    email: "fleet@example.com",
    displayName: "Fleet",
    passwordDigest: "digest",
  });
  const worker = await store.registerWorker({
    userId: user.id,
    name: "worker-a",
    adapters: ["generic-cli"],
    version: "1.0.0",
  });

  return {
    root,
    store,
    repositories,
    workerId: worker.id,
    revision: version.revision,
  };
}

async function submit(harness: Harness): Promise<string> {
  const task = await harness.store.submitTask({
    repositoryId: "repo_worker",
    objective: "raise the value",
    agentId: "generic-cli",
    validationCommands: [],
  });
  return task.id;
}

async function lease(harness: Harness) {
  return await leaseWork(harness.store, {
    workerId: harness.workerId,
    projectId: DEFAULT_PROJECT_ID,
  });
}

function plan(taskId: string): AgentPlan {
  return {
    taskId,
    objective: "raise the value",
    expectedFiles: ["src/value.js"],
    expectedSymbols: ["value"],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };
}

function resultStub(
  taskId: string,
  revision: string,
  overrides: Partial<ChangeSet> = {},
): ChangeSet {
  return {
    id: "changeset_1",
    taskId,
    baseVersion: 1,
    baseRevision: revision,
    patches: [],
    commandsRun: [],
    tests: [],
    dependenciesChanged: [],
    symbolsChanged: ["value"],
    riskAssessment: { level: "low", reasons: [] },
    agentExplanation: "raised the value",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("a lease pins the worker to the canonical revision", async () => {
  const harness = await createHarness();
  try {
    assert.equal(await lease(harness), undefined);

    const taskId = await submit(harness);
    const assignment = await lease(harness);

    assert.equal(assignment?.task.id, taskId);
    assert.equal(assignment?.lease.baseRevision, harness.revision);
    assert.equal(assignment?.repository.branch, "main");
    assert.match(assignment?.bundleUrl ?? "", /\/workers\/leases\/.+\/bundle$/u);
    assert.ok((assignment?.heartbeatIntervalMs ?? 0) > 0);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a worker reconstructs the workspace from the bundle alone", async () => {
  const harness = await createHarness();
  try {
    await submit(harness);
    const assignment = await lease(harness);
    const bundle = await leaseBundle(
      harness.store,
      assignment?.lease.id ?? "",
    );
    assert.ok(bundle !== undefined);
    // Git bundles are binary and start with a signature line.
    assert.match(bundle.subarray(0, 16).toString("utf8"), /^# v\d/u);

    // Stand in for a worker on another machine: it has the bytes and nothing
    // else — no access to the canonical repository path.
    const remote = path.join(harness.root, "worker-side");
    await mkdir(remote, { recursive: true });
    const bundlePath = path.join(remote, "revision.bundle");
    await writeFile(bundlePath, bundle);

    const git = new GitClient();
    const workspace = path.join(remote, "workspace");
    await git.run([
      "clone",
      "--branch",
      assignment?.bundleRef ?? "",
      bundlePath,
      workspace,
    ]);

    // Line endings are not part of the contract: a worker on Windows checks
    // out with autocrlf, and git converts back when it diffs, so a CRLF
    // working tree still produces a clean patch.
    const restored = await readFile(
      path.join(workspace, "src", "value.js"),
      "utf8",
    );
    assert.equal(
      restored.replaceAll("\r\n", "\n"),
      "export const value = 1;\n",
    );

    const head = await git.run(["-C", workspace, "rev-parse", "HEAD"]);
    assert.equal(head.stdout.trim(), harness.revision);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a bundle is only served for an active lease", async () => {
  const harness = await createHarness();
  try {
    await submit(harness);
    const assignment = await lease(harness);
    const leaseId = assignment?.lease.id ?? "";

    await harness.store.finishWorkLease(
      leaseId,
      "released",
      new Date().toISOString(),
    );
    assert.equal(await leaseBundle(harness.store, leaseId), undefined);
    assert.equal(await leaseBundle(harness.store, "lease_missing"), undefined);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("an invalid completed result fails the lease instead of retrying forever", async () => {
  const harness = await createHarness();
  try {
    const taskId = await submit(harness);
    const assignment = await lease(harness);
    const leaseId = assignment?.lease.id ?? "";

    const rejected = await acceptWorkResult(harness.store, {
      leaseId,
      status: "completed",
      actorId: "user",
      plan: plan(taskId),
      changeSet: resultStub(taskId, "b".repeat(40)),
    });
    assert.equal(rejected.accepted, false);
    assert.match(rejected.reason ?? "", /base does not match/u);
    assert.equal(
      (await harness.store.getWorkLease(leaseId))?.status,
      "failed",
    );
    assert.equal(
      (await harness.store.listSubmittedTasks())[0]?.status,
      "failed",
    );
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a valid remote result is recorded, validated, and promoted", async () => {
  const harness = await createHarness();
  try {
    const taskId = await submit(harness);
    const assignment = await lease(harness);
    assert.ok(assignment);
    const repository = await harness.store.getRepository("repo_worker");
    assert.ok(repository);
    const canonical = {
      id: repository.id,
      path: repository.path,
      branch: repository.branch,
    };
    const workspaces = new GitWorktreeWorkspaceManager(
      harness.repositories.getGitClient(),
    );
    const workspace = await workspaces.create({
      taskId,
      rootPath: path.join(harness.root, "agent-workspaces"),
      repository: canonical,
      baseVersion: assignment.canonicalVersion,
    });
    await writeFile(
      path.join(workspace.path, "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );
    const changeSet = await workspaces.collectChangeSet(workspace, {
      symbolsChanged: ["value"],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "raised the value",
    });
    await workspaces.destroy(workspace);

    const accepted = await acceptWorkResult(
      harness.store,
      {
        leaseId: assignment.lease.id,
        status: "completed",
        actorId: "user",
        plan: plan(taskId),
        changeSet,
      },
      {
        repositories: harness.repositories,
        integrationRoot: path.join(harness.root, "integration"),
      },
    );
    assert.equal(accepted.accepted, true, accepted.reason);
    assert.equal(accepted.integrationStatus, "integrated");
    assert.ok(accepted.runId);
    assert.equal(
      (await harness.store.listSubmittedTasks())[0]?.status,
      "integrated",
    );
    const version = await harness.repositories.getCanonicalVersion(canonical);
    assert.equal(
      await harness.repositories.readFile(
        canonical,
        version.revision,
        "src/value.js",
      ),
      "export const value = 2;\n",
    );
    const detail = await harness.store.getRun(accepted.runId);
    assert.equal(detail?.changeSets.length, 1);
    assert.equal(detail?.integrations[0]?.status, "integrated");
    const duplicate = await acceptWorkResult(
      harness.store,
      {
        leaseId: assignment.lease.id,
        status: "completed",
        actorId: "user",
        plan: plan(taskId),
        changeSet,
      },
      { repositories: harness.repositories },
    );
    assert.equal(duplicate.accepted, true);
    assert.equal(duplicate.runId, accepted.runId);
    assert.equal((await harness.store.listRuns()).length, 1);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a protected remote result waits for durable human approval", async () => {
  const harness = await createHarness();
  try {
    const taskId = await submit(harness);
    const assignment = await lease(harness);
    assert.ok(assignment);
    const stored = await harness.store.getRepository("repo_worker");
    assert.ok(stored);
    const repository = {
      id: stored.id,
      path: stored.path,
      branch: stored.branch,
    };
    const workspaces = new GitWorktreeWorkspaceManager(
      harness.repositories.getGitClient(),
    );
    const workspace = await workspaces.create({
      taskId,
      rootPath: path.join(harness.root, "approval-workspace"),
      repository,
      baseVersion: assignment.canonicalVersion,
    });
    await writeFile(
      path.join(workspace.path, "src", "value.js"),
      "export const value = 3;\n",
    );
    const changeSet = await workspaces.collectChangeSet(workspace, {
      symbolsChanged: ["value"],
      riskAssessment: { level: "high", reasons: ["protected behavior"] },
      agentExplanation: "approved high-risk update",
    });
    await workspaces.destroy(workspace);
    const highRiskPlan = { ...plan(taskId), riskLevel: "high" as const };

    const resultPromise = acceptWorkResult(
      harness.store,
      {
        leaseId: assignment.lease.id,
        status: "completed",
        actorId: "user",
        plan: highRiskPlan,
        changeSet,
      },
      {
        repositories: harness.repositories,
        integrationRoot: path.join(harness.root, "approval-integration"),
      },
    );
    let approval = (await harness.store.listApprovals({ taskId }))[0];
    for (let attempt = 0; approval === undefined && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      approval = (await harness.store.listApprovals({ taskId }))[0];
    }
    assert.ok(approval);
    assert.equal(approval.status, "pending");
    await harness.store.decideApproval({
      approvalId: approval.id,
      status: "approved",
      decidedBy: "reviewer",
      comment: "Reviewed the remote diff",
      decidedAt: new Date().toISOString(),
    });

    const result = await resultPromise;
    assert.equal(result.accepted, true, result.reason);
    const detail = await harness.store.getRun(result.runId ?? "");
    assert.equal(detail?.approvals[0]?.status, "approved");
    assert.equal(detail?.tasks[0]?.status, "integrated");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("canonical movement requeues remote work for a fresh plan", async () => {
  const harness = await createHarness();
  try {
    const taskId = await submit(harness);
    const assignment = await lease(harness);
    assert.ok(assignment);
    const stored = await harness.store.getRepository("repo_worker");
    assert.ok(stored);
    const repository = {
      id: stored.id,
      path: stored.path,
      branch: stored.branch,
    };
    const workspaces = new GitWorktreeWorkspaceManager(
      harness.repositories.getGitClient(),
    );
    const competing = await workspaces.create({
      taskId: "competing",
      rootPath: path.join(harness.root, "competing"),
      repository,
      baseVersion: assignment.canonicalVersion,
    });
    await writeFile(path.join(competing.path, "README.md"), "new canonical\n");
    const candidate = await harness.repositories.commitAll(
      competing.path,
      "advance canonical",
    );
    assert.ok(candidate);
    assert.equal(
      await harness.repositories.promote(
        repository,
        candidate,
        assignment.canonicalVersion.revision,
      ),
      true,
    );
    await workspaces.destroy(competing);

    const result = await acceptWorkResult(
      harness.store,
      {
        leaseId: assignment.lease.id,
        status: "completed",
        actorId: "user",
        plan: plan(taskId),
        changeSet: resultStub(taskId, assignment.canonicalVersion.revision),
      },
      { repositories: harness.repositories },
    );
    assert.equal(result.accepted, false);
    assert.equal(result.requeued, true);
    assert.equal(
      (await harness.store.getWorkLease(assignment.lease.id))?.status,
      "released",
    );
    assert.equal(
      (await harness.store.listSubmittedTasks())[0]?.status,
      "submitted",
    );
    assert.ok(
      (await harness.store.listAudit()).some(
        (event) =>
          event.type === "replan_requested" && event.taskId === taskId,
      ),
    );
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a lapsed lease cannot report a result", async () => {
  const harness = await createHarness();
  try {
    const taskId = await submit(harness);
    const assignment = await lease(harness);
    const leaseId = assignment?.lease.id ?? "";

    // The worker stalled, the lease expired, and the task went back to the
    // queue. Accepting its late result would let two workers write the task.
    await harness.store.expireWorkLeases(
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    );
    const late = await acceptWorkResult(harness.store, {
      leaseId,
      status: "completed",
      actorId: "user",
      plan: plan(taskId),
      changeSet: resultStub(taskId, harness.revision),
    });
    assert.equal(late.accepted, false);
    assert.match(late.reason ?? "", /lease is expired/u);

    // And the task really is available again.
    assert.equal(
      (await harness.store.listSubmittedTasks({ status: "submitted" })).length,
      1,
    );
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a failed result settles the task and is audited", async () => {
  const harness = await createHarness();
  try {
    const taskId = await submit(harness);
    const assignment = await lease(harness);

    const result = await acceptWorkResult(harness.store, {
      leaseId: assignment?.lease.id ?? "",
      status: "failed",
      actorId: "user",
      plan: undefined,
      changeSet: undefined,
      detail: "agent exited with code 3",
    });
    assert.equal(result.accepted, true);

    const tasks = await harness.store.listSubmittedTasks();
    assert.equal(tasks.find((entry) => entry.id === taskId)?.status, "failed");

    const audit = await harness.store.listAudit();
    const failure = audit.find((event) => event.type === "task_failed");
    assert.equal(failure?.taskId, taskId);
    assert.equal(failure?.data["detail"], "agent exited with code 3");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("the full remote cycle runs end to end against a Postgres store", async () => {
  // The contract suite proves the Postgres store honors the storage contract;
  // this proves the actual runtime path — lease, bundle, result, three-way
  // integration, canonical promotion — against a real server, the way a
  // COORD_DATABASE_URL deployment runs it. Same Docker policy as the contract
  // suite: skipped only when Docker is absent, loud about it, and its own
  // container name because turbo runs package suites concurrently.
  const server =
    process.env["COORD_SKIP_POSTGRES_TESTS"] === "1"
      ? undefined
      : await startPostgresTestServer({
          containerName: "coord-postgres-worker-smoke",
        });
  if (server === undefined) {
    console.warn(
      "postgres: remote-cycle smoke test skipped (Docker is unavailable and " +
        "COORD_TEST_POSTGRES_URL is not set)",
    );
    return;
  }
  const database = await createScratchDatabase(server.adminUrl);
  const store = PostgresCoordinationStore.open(database.url);
  let harness: Harness | undefined;
  try {
    harness = await createHarness(store);
    const taskId = await submit(harness);
    const assignment = await lease(harness);
    assert.ok(assignment);
    assert.equal(assignment.task.id, taskId);
    assert.equal(assignment.lease.baseRevision, harness.revision);

    // The worker side: reconstruct the workspace from the bundle bytes alone.
    const bundle = await leaseBundle(harness.store, assignment.lease.id);
    assert.ok(bundle !== undefined);
    const remote = path.join(harness.root, "worker-side");
    await mkdir(remote, { recursive: true });
    const bundlePath = path.join(remote, "revision.bundle");
    await writeFile(bundlePath, bundle);
    const git = new GitClient();
    const workspace = path.join(remote, "workspace");
    await git.run([
      "clone",
      "--branch",
      assignment.bundleRef,
      bundlePath,
      workspace,
    ]);
    await writeFile(
      path.join(workspace, "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );

    // Collect the changeset from a coordinator-side worktree, exactly as the
    // in-memory promotion test does, and hand the result back.
    const repository = await harness.store.getRepository("repo_worker");
    assert.ok(repository);
    const canonical = {
      id: repository.id,
      path: repository.path,
      branch: repository.branch,
    };
    const workspaces = new GitWorktreeWorkspaceManager(
      harness.repositories.getGitClient(),
    );
    const agentWorkspace = await workspaces.create({
      taskId,
      rootPath: path.join(harness.root, "agent-workspaces"),
      repository: canonical,
      baseVersion: assignment.canonicalVersion,
    });
    await writeFile(
      path.join(agentWorkspace.path, "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );
    const changeSet = await workspaces.collectChangeSet(agentWorkspace, {
      symbolsChanged: ["value"],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "raised the value",
    });
    await workspaces.destroy(agentWorkspace);

    const accepted = await acceptWorkResult(
      harness.store,
      {
        leaseId: assignment.lease.id,
        status: "completed",
        actorId: "user",
        plan: plan(taskId),
        changeSet,
      },
      {
        repositories: harness.repositories,
        integrationRoot: path.join(harness.root, "integration"),
      },
    );
    assert.equal(accepted.accepted, true, accepted.reason);
    assert.equal(accepted.integrationStatus, "integrated");
    assert.ok(accepted.runId);

    // The change is canonical, and every durable record went through Postgres.
    const version = await harness.repositories.getCanonicalVersion(canonical);
    assert.equal(
      await harness.repositories.readFile(
        canonical,
        version.revision,
        "src/value.js",
      ),
      "export const value = 2;\n",
    );
    assert.equal(
      (await harness.store.listSubmittedTasks())[0]?.status,
      "integrated",
    );
    const detail = await harness.store.getRun(accepted.runId);
    assert.equal(detail?.changeSets.length, 1);
    assert.equal(detail?.integrations[0]?.status, "integrated");
    assert.equal((await harness.store.verifyAudit()).valid, true);
  } finally {
    await store.close();
    await database.drop();
    await server.stop();
    if (harness !== undefined) {
      await rm(harness.root, { recursive: true, force: true });
    }
  }
});
