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
import {
  DEFERRED_SCOPE_MARKER,
  PlanAdmissionController,
  type PlanAdmissionInput,
} from "@coord/coordinator";
import { GitClient, RepositoryService } from "@coord/repository-service";
import {
  deferredFilePaths,
  planAdmissionApproved,
  planAdmissionPartial,
  type AgentPlan,
  type ChangeSet,
  type PlanAdmission,
} from "@coord/shared-types";
import { GitWorktreeWorkspaceManager } from "@coord/workspace-manager";

import {
  acceptWorkResult,
  admitWorkPlan,
  leaseBundle,
  leaseWork,
  type WorkAssignment,
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
  /** Extra seeded files, repository-relative, for multi-file scenarios. */
  extraFiles: Readonly<Record<string, string>> = {},
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
  for (const [file, contents] of Object.entries(extraFiles)) {
    const target = path.join(sourcePath, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
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

function plan(
  taskId: string,
  overrides: Partial<AgentPlan> = {},
): AgentPlan {
  return {
    taskId,
    objective: "raise the value",
    expectedFiles: ["src/value.js"],
    expectedSymbols: ["value"],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
    ...overrides,
  };
}

/**
 * The plan-first step every remote result now has to pass through: the worker
 * submits its plan and the control plane answers before any editing.
 */
async function admit(
  harness: Harness,
  assignment: WorkAssignment,
  overrides: Partial<AgentPlan> = {},
) {
  return await admitWorkPlan(
    harness.store,
    {
      leaseId: assignment.lease.id,
      actorId: "user",
      plan: plan(assignment.task.id, {
        objective: assignment.task.objective,
        ...overrides,
      }),
    },
    { repositories: harness.repositories },
  );
}

/** Leases and admits in one step, for tests about what happens afterwards. */
async function leaseAndAdmit(
  harness: Harness,
  overrides: Partial<AgentPlan> = {},
): Promise<WorkAssignment> {
  const assignment = await lease(harness);
  assert.ok(assignment);
  const outcome = await admit(harness, assignment, overrides);
  assert.equal(outcome.outcome, "admitted");
  assert.equal(
    outcome.outcome === "admitted" ? outcome.admission.status : undefined,
    "approved",
  );
  return assignment;
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
    const assignment = await leaseAndAdmit(harness);
    const leaseId = assignment.lease.id;

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
    const assignment = await leaseAndAdmit(harness);
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
    const assignment = await leaseAndAdmit(harness, { riskLevel: "high" });
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

test("a project policy forces review of an otherwise benign changeset", async () => {
  const harness = await createHarness();
  try {
    // Declarative policy on the default project: every changeset needs a
    // human, even a low-risk one touching nothing protected.
    await harness.store.updateProject(DEFAULT_PROJECT_ID, {
      policy: { version: 1, approvals: { requireChangesetReview: true } },
    });

    const taskId = await submit(harness);
    const assignment = await leaseAndAdmit(harness);
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
      rootPath: path.join(harness.root, "policy-workspace"),
      repository,
      baseVersion: assignment.canonicalVersion,
    });
    await writeFile(
      path.join(workspace.path, "src", "value.js"),
      "export const value = 4;\n",
    );
    const changeSet = await workspaces.collectChangeSet(workspace, {
      symbolsChanged: ["value"],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "benign low-risk update",
    });
    await workspaces.destroy(workspace);

    const resultPromise = acceptWorkResult(
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
        integrationRoot: path.join(harness.root, "policy-integration"),
      },
    );
    let approval = (await harness.store.listApprovals({ taskId }))[0];
    for (let attempt = 0; approval === undefined && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      approval = (await harness.store.listApprovals({ taskId }))[0];
    }
    assert.ok(approval);
    assert.ok(
      approval.reasons.some((reason) =>
        reason.includes("Project policy requires"),
      ),
    );
    await harness.store.decideApproval({
      approvalId: approval.id,
      status: "approved",
      decidedBy: "reviewer",
      comment: "Policy-mandated review",
      decidedAt: new Date().toISOString(),
    });

    const result = await resultPromise;
    assert.equal(result.accepted, true, result.reason);
    assert.equal(result.integrationStatus, "integrated");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("an exhausted daily runtime budget stops leasing until cleared", async () => {
  const harness = await createHarness();
  try {
    await harness.store.updateProject(DEFAULT_PROJECT_ID, {
      policy: {
        version: 1,
        budgets: { maxProjectRuntimeMsPerDay: 60_000 },
      },
    });

    await submit(harness);
    const first = await lease(harness);
    assert.ok(first, "the untouched budget must admit the first lease");

    // Settle the lease with two minutes of recorded runtime — more than the
    // one-minute daily budget.
    const finishAt = new Date(
      new Date(first.lease.issuedAt).getTime() + 120_000,
    ).toISOString();
    assert.equal(
      await harness.store.finishWorkLease(
        first.lease.id,
        "completed",
        finishAt,
        "consumed the budget",
      ),
      true,
    );
    await harness.store.completeSubmittedTask(first.task.id, "integrated");

    // The next task stays queued, not failed: budgets throttle, they do not
    // discard work.
    const queued = await submit(harness);
    assert.equal(await lease(harness), undefined);
    assert.equal(
      (await harness.store.listSubmittedTasks()).find(
        (task) => task.id === queued,
      )?.status,
      "submitted",
    );

    // Removing the budget restores leasing immediately.
    await harness.store.updateProject(DEFAULT_PROJECT_ID, { policy: null });
    assert.equal((await lease(harness))?.task.id, queued);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("canonical movement requeues remote work for a fresh plan", async () => {
  const harness = await createHarness();
  try {
    const taskId = await submit(harness);
    // Admitted at the original base, so this exercises the backstop: the plan
    // was fine when it was approved and canonical moved during execution.
    const assignment = await leaseAndAdmit(harness);
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

test("concurrent workers in one repository cannot corrupt canonical; the loser replans", async () => {
  const harness = await createHarness();
  try {
    const secondUser = await harness.store.createUser({
      email: "fleet-b@example.com",
      displayName: "Fleet B",
      passwordDigest: "digest",
    });
    const secondWorker = await harness.store.registerWorker({
      userId: secondUser.id,
      name: "worker-b",
      adapters: ["generic-cli"],
      version: "1.0.0",
    });

    const taskA = await harness.store.submitTask({
      repositoryId: "repo_worker",
      objective: "raise the value",
      agentId: "generic-cli",
      validationCommands: [],
    });
    const taskB = await harness.store.submitTask({
      repositoryId: "repo_worker",
      objective: "add another module",
      agentId: "generic-cli",
      validationCommands: [],
    });

    // Both workers hold leases in the same repository, at the same base.
    const assignmentA = await leaseWork(harness.store, {
      workerId: harness.workerId,
      projectId: DEFAULT_PROJECT_ID,
      repositoryParallelism: 2,
    });
    const assignmentB = await leaseWork(harness.store, {
      workerId: secondWorker.id,
      projectId: DEFAULT_PROJECT_ID,
      repositoryParallelism: 2,
    });
    assert.equal(assignmentA?.task.id, taskA.id);
    assert.equal(assignmentB?.task.id, taskB.id);
    assert.ok(assignmentA && assignmentB);
    assert.equal(assignmentA.lease.baseRevision, assignmentB.lease.baseRevision);

    // Disjoint plans: admission lets both run, which is the behaviour the
    // parallelism cap exists to enable.
    const admissions: [WorkAssignment, Partial<AgentPlan>][] = [
      [assignmentA, {}],
      [
        assignmentB,
        { expectedFiles: ["src/other.js"], expectedSymbols: ["other"] },
      ],
    ];
    for (const [assignment, overrides] of admissions) {
      const outcome = await admit(harness, assignment, overrides);
      assert.equal(
        outcome.outcome === "admitted" ? outcome.admission.status : outcome,
        "approved",
      );
    }

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
    const collect = async (
      taskId: string,
      baseVersion: typeof assignmentA.canonicalVersion,
      file: string,
      content: string,
      symbols: string[],
    ) => {
      const workspace = await workspaces.create({
        taskId,
        rootPath: path.join(harness.root, "agent-workspaces"),
        repository: canonical,
        baseVersion,
      });
      await mkdir(path.dirname(path.join(workspace.path, file)), {
        recursive: true,
      });
      await writeFile(path.join(workspace.path, file), content, "utf8");
      const changeSet = await workspaces.collectChangeSet(workspace, {
        symbolsChanged: symbols,
        riskAssessment: { level: "low", reasons: [] },
        agentExplanation: `changed ${file}`,
      });
      await workspaces.destroy(workspace);
      return changeSet;
    };

    // Worker A integrates first and moves canonical.
    const acceptedA = await acceptWorkResult(
      harness.store,
      {
        leaseId: assignmentA.lease.id,
        status: "completed",
        actorId: "user",
        plan: plan(taskA.id),
        changeSet: await collect(
          taskA.id,
          assignmentA.canonicalVersion,
          "src/value.js",
          "export const value = 2;\n",
          ["value"],
        ),
      },
      {
        repositories: harness.repositories,
        integrationRoot: path.join(harness.root, "integration"),
      },
    );
    assert.equal(acceptedA.accepted, true, acceptedA.reason);

    // Worker B built from the now-stale base. Its result must not integrate
    // — and must not fail the task either: it requeues to replan.
    const staleResult = await acceptWorkResult(
      harness.store,
      {
        leaseId: assignmentB.lease.id,
        status: "completed",
        actorId: "user",
        plan: plan(taskB.id, {
          objective: "add another module",
          expectedFiles: ["src/other.js"],
          expectedSymbols: ["other"],
        }),
        changeSet: await collect(
          taskB.id,
          assignmentB.canonicalVersion,
          "src/other.js",
          "export const other = 1;\n",
          ["other"],
        ),
      },
      {
        repositories: harness.repositories,
        integrationRoot: path.join(harness.root, "integration"),
      },
    );
    assert.equal(staleResult.accepted, false);
    assert.equal(staleResult.requeued, true);
    assert.equal(
      (await harness.store.listSubmittedTasks()).find(
        (task) => task.id === taskB.id,
      )?.status,
      "submitted",
    );

    // The requeued task re-leases at the promoted revision and integrates.
    const retryAssignment = await leaseWork(harness.store, {
      workerId: secondWorker.id,
      projectId: DEFAULT_PROJECT_ID,
      repositoryParallelism: 2,
    });
    assert.equal(retryAssignment?.task.id, taskB.id);
    assert.ok(retryAssignment);
    assert.notEqual(
      retryAssignment.lease.baseRevision,
      assignmentB.lease.baseRevision,
    );
    const readmitted = await admit(harness, retryAssignment, {
      expectedFiles: ["src/other.js"],
      expectedSymbols: ["other"],
    });
    assert.equal(
      readmitted.outcome === "admitted" ? readmitted.admission.status : readmitted,
      "approved",
    );
    const acceptedB = await acceptWorkResult(
      harness.store,
      {
        leaseId: retryAssignment.lease.id,
        status: "completed",
        actorId: "user",
        plan: plan(taskB.id, {
          objective: "add another module",
          expectedFiles: ["src/other.js"],
          expectedSymbols: ["other"],
        }),
        changeSet: await collect(
          taskB.id,
          retryAssignment.canonicalVersion,
          "src/other.js",
          "export const other = 1;\n",
          ["other"],
        ),
      },
      {
        repositories: harness.repositories,
        integrationRoot: path.join(harness.root, "integration"),
      },
    );
    assert.equal(acceptedB.accepted, true, acceptedB.reason);

    // Canonical carries both changes, in order, with a valid audit chain.
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
      await harness.repositories.readFile(
        canonical,
        version.revision,
        "src/other.js",
      ),
      "export const other = 1;\n",
    );
    assert.equal((await harness.store.verifyAudit()).valid, true);
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
    assert.equal(assignment.protocolVersion, 2);

    // Plan first: the control plane answers before the worker edits anything,
    // and the verdict is durable in Postgres.
    const admitted = await admit(harness, assignment);
    assert.equal(admitted.outcome, "admitted");
    assert.equal(
      admitted.outcome === "admitted" ? admitted.admission.status : undefined,
      "approved",
    );
    const admittedLease = await harness.store.getWorkLease(assignment.lease.id);
    assert.equal(admittedLease?.plan?.admission.status, "approved");
    assert.ok((admittedLease?.plan?.admission.ownershipGrants.length ?? 0) > 0);

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

test("two workers targeting one file are separated at plan time, not after executing", async () => {
  // The behaviour this whole protocol change exists for. Two remote workers
  // lease concurrently in one repository and plan against the same file. Under
  // the previous optimistic model both would have run an agent to completion
  // and the loser's work would have been discarded at integration. Here the
  // second worker is sequenced while its agent is still idle, and the proof is
  // countable: exactly one run per task, one changeset per task, and no
  // discarded execution anywhere in the durable record.
  //
  // Against a real Postgres server, because the serialization that makes the
  // arbitration sound is the store's, not the process's.
  const server =
    process.env["COORD_SKIP_POSTGRES_TESTS"] === "1"
      ? undefined
      : await startPostgresTestServer({
          containerName: "coord-postgres-worker-smoke",
        });
  if (server === undefined) {
    console.warn(
      "postgres: plan-time conflict test skipped (Docker is unavailable and " +
        "COORD_TEST_POSTGRES_URL is not set)",
    );
    return;
  }
  const database = await createScratchDatabase(server.adminUrl);
  const store = PostgresCoordinationStore.open(database.url);
  let harness: Harness | undefined;
  try {
    harness = await createHarness(store);
    const secondUser = await store.createUser({
      email: "fleet-plan-b@example.com",
      displayName: "Fleet B",
      passwordDigest: "digest",
    });
    const secondWorker = await store.registerWorker({
      userId: secondUser.id,
      name: "worker-b",
      adapters: ["generic-cli"],
      version: "1.0.0",
    });

    const taskA = await store.submitTask({
      repositoryId: "repo_worker",
      objective: "raise the value",
      agentId: "generic-cli",
      validationCommands: [],
    });
    const taskB = await store.submitTask({
      repositoryId: "repo_worker",
      objective: "extend the value module",
      agentId: "generic-cli",
      validationCommands: [],
    });

    const assignmentA = await leaseWork(store, {
      workerId: harness.workerId,
      projectId: DEFAULT_PROJECT_ID,
      repositoryParallelism: 2,
    });
    const assignmentB = await leaseWork(store, {
      workerId: secondWorker.id,
      projectId: DEFAULT_PROJECT_ID,
      repositoryParallelism: 2,
    });
    assert.ok(assignmentA && assignmentB);
    assert.equal(assignmentA.task.id, taskA.id);
    assert.equal(assignmentB.task.id, taskB.id);
    // Both hold the same base: this is exactly the race the old model lost.
    assert.equal(assignmentA.lease.baseRevision, assignmentB.lease.baseRevision);

    // Worker A plans first and is granted ownership of the file.
    const admittedA = await admit(harness, assignmentA);
    assert.equal(admittedA.outcome, "admitted");
    assert.equal(
      admittedA.outcome === "admitted" ? admittedA.admission.status : undefined,
      "approved",
    );
    assert.ok(
      admittedA.outcome === "admitted" &&
        admittedA.admission.ownershipGrants.some(
          (grant) =>
            grant.resourceType === "file" &&
            grant.resourceId === "src/value.js" &&
            grant.mode === "exclusive",
        ),
      "worker A must hold the file exclusively",
    );

    // Worker B plans against the same file and is stopped here — before its
    // agent has written a line.
    const admittedB = await admit(harness, assignmentB, {
      expectedSymbols: ["value", "extra"],
    });
    assert.equal(admittedB.outcome, "admitted");
    assert.ok(admittedB.outcome === "admitted");
    assert.equal(admittedB.admission.status, "sequenced");
    assert.deepEqual(admittedB.admission.blockedBy, [taskA.id]);
    assert.equal(admittedB.admission.ownershipGrants.length, 0);
    assert.ok((admittedB.admission.retryAfterMs ?? 0) > 0);
    assert.ok(
      admittedB.admission.conflicts.some((assessment) =>
        assessment.evidence.some(
          (entry) =>
            entry.kind === "file_overlap" &&
            entry.resources.includes("src/value.js"),
        ),
      ),
      "the sequencing decision must cite the overlapping file",
    );
    // Nothing has executed yet: the conflict was found before any run existed.
    assert.equal((await store.listRuns()).length, 0);

    const stored = await store.getRepository("repo_worker");
    assert.ok(stored);
    const repository = {
      id: stored.id,
      path: stored.path,
      branch: stored.branch,
    };
    const workspaces = new GitWorktreeWorkspaceManager(
      harness.repositories.getGitClient(),
    );
    const collect = async (
      taskId: string,
      baseVersion: typeof assignmentA.canonicalVersion,
      content: string,
      symbols: string[],
    ) => {
      const workspace = await workspaces.create({
        taskId,
        rootPath: path.join(harness?.root ?? "", "agent-workspaces"),
        repository,
        baseVersion,
      });
      await writeFile(
        path.join(workspace.path, "src", "value.js"),
        content,
        "utf8",
      );
      const changeSet = await workspaces.collectChangeSet(workspace, {
        symbolsChanged: symbols,
        riskAssessment: { level: "low", reasons: [] },
        agentExplanation: `wrote ${taskId}`,
      });
      await workspaces.destroy(workspace);
      return changeSet;
    };

    // Worker A executes against its grant and integrates.
    const acceptedA = await acceptWorkResult(
      store,
      {
        leaseId: assignmentA.lease.id,
        status: "completed",
        actorId: "user",
        plan: plan(taskA.id, { objective: taskA.objective }),
        changeSet: await collect(
          taskA.id,
          assignmentA.canonicalVersion,
          "export const value = 2;\n",
          ["value"],
        ),
      },
      {
        repositories: harness.repositories,
        integrationRoot: path.join(harness.root, "integration"),
      },
    );
    assert.equal(acceptedA.accepted, true, acceptedA.reason);

    // Worker B, still idle, resubmits the plan it already has. Canonical moved
    // while it waited, so the answer is to plan again rather than to run —
    // again without spending any execution time.
    const resubmitted = await admit(harness, assignmentB, {
      expectedSymbols: ["value", "extra"],
    });
    assert.ok(resubmitted.outcome === "admitted");
    assert.equal(resubmitted.admission.status, "blocked");
    assert.equal(resubmitted.admission.requeue, true);
    assert.equal(
      (await store.getWorkLease(assignmentB.lease.id))?.status,
      "released",
    );
    assert.equal(
      (await store.listSubmittedTasks()).find((task) => task.id === taskB.id)
        ?.status,
      "submitted",
    );

    // It re-leases at the promoted revision, replans, and is now approved:
    // the file it wanted is free.
    const retry = await leaseWork(store, {
      workerId: secondWorker.id,
      projectId: DEFAULT_PROJECT_ID,
      repositoryParallelism: 2,
    });
    assert.ok(retry);
    assert.equal(retry.task.id, taskB.id);
    assert.notEqual(retry.lease.baseRevision, assignmentB.lease.baseRevision);
    const admittedRetry = await admit(harness, retry, {
      expectedSymbols: ["value", "extra"],
    });
    assert.ok(admittedRetry.outcome === "admitted");
    assert.equal(admittedRetry.admission.status, "approved");

    const acceptedB = await acceptWorkResult(
      store,
      {
        leaseId: retry.lease.id,
        status: "completed",
        actorId: "user",
        plan: plan(taskB.id, {
          objective: taskB.objective,
          expectedSymbols: ["value", "extra"],
        }),
        changeSet: await collect(
          taskB.id,
          retry.canonicalVersion,
          "export const value = 2;\nexport const extra = true;\n",
          ["extra"],
        ),
      },
      {
        repositories: harness.repositories,
        integrationRoot: path.join(harness.root, "integration"),
      },
    );
    assert.equal(acceptedB.accepted, true, acceptedB.reason);

    // Canonical carries both changes, serialized in the order arbitration
    // chose.
    const version = await harness.repositories.getCanonicalVersion(repository);
    assert.equal(
      await harness.repositories.readFile(
        repository,
        version.revision,
        "src/value.js",
      ),
      "export const value = 2;\nexport const extra = true;\n",
    );

    // The countable proof: one run and one changeset per task. A discarded
    // execution would have left a third run and a second changeset for taskB.
    const runs = await store.listRuns();
    assert.equal(runs.length, 2);
    const audit = await store.listAudit();
    assert.equal(
      audit.filter(
        (event) =>
          event.type === "changeset_collected" && event.taskId === taskB.id,
      ).length,
      1,
    );
    // And the deferral itself is on the record, with its evidence.
    assert.equal(
      audit.filter(
        (event) =>
          event.type === "plan_admitted" &&
          event.taskId === taskB.id &&
          event.data["status"] === "sequenced",
      ).length,
      1,
    );
    assert.ok(
      audit.some(
        (event) =>
          event.type === "conflict_detected" &&
          event.data["stage"] === "remote_plan_admission",
      ),
    );
    assert.equal((await store.verifyAudit()).valid, true);
  } finally {
    await store.close();
    await database.drop();
    await server.stop();
    if (harness !== undefined) {
      await rm(harness.root, { recursive: true, force: true });
    }
  }
});

test("a result without an approved admission is refused", async () => {
  const harness = await createHarness();
  try {
    const taskId = await submit(harness);
    const assignment = await lease(harness);
    assert.ok(assignment);

    // Skipping admission entirely is what an old, plan-blind worker does.
    const unplanned = await acceptWorkResult(harness.store, {
      leaseId: assignment.lease.id,
      status: "completed",
      actorId: "user",
      plan: plan(taskId),
      changeSet: resultStub(taskId, harness.revision),
    });
    assert.equal(unplanned.accepted, false);
    assert.match(unplanned.reason ?? "", /require an admitted plan/u);
    assert.equal(
      (await harness.store.getWorkLease(assignment.lease.id))?.status,
      "failed",
    );
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a result cannot claim resources its admitted plan never covered", async () => {
  const harness = await createHarness();
  try {
    const taskId = await submit(harness);
    const assignment = await leaseAndAdmit(harness);

    // The admitted plan covered src/value.js. Reporting a wider one after the
    // fact would mean claiming ownership nobody had a chance to object to.
    const widened = await acceptWorkResult(
      harness.store,
      {
        leaseId: assignment.lease.id,
        status: "completed",
        actorId: "user",
        plan: plan(taskId, {
          expectedFiles: ["src/value.js", "src/secret.js"],
        }),
        changeSet: resultStub(taskId, harness.revision),
      },
      { repositories: harness.repositories },
    );
    assert.equal(widened.accepted, false);
    assert.match(widened.reason ?? "", /src\/secret\.js/u);
    assert.equal(
      (await harness.store.getWorkLease(assignment.lease.id))?.status,
      "failed",
    );
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("an unusable plan fails the lease instead of looping", async () => {
  const harness = await createHarness();
  try {
    const taskId = await submit(harness);
    const assignment = await lease(harness);
    assert.ok(assignment);

    const rejected = await admitWorkPlan(
      harness.store,
      {
        leaseId: assignment.lease.id,
        actorId: "user",
        // Right task, wrong objective: the agent planned something other than
        // what it was leased.
        plan: plan(taskId, { objective: "something else entirely" }),
      },
      { repositories: harness.repositories },
    );
    assert.equal(rejected.outcome, "rejected");
    assert.match(
      rejected.outcome === "rejected" ? rejected.reason : "",
      /objective does not match/u,
    );
    assert.equal(
      (await harness.store.getWorkLease(assignment.lease.id))?.status,
      "failed",
    );
    // Failed, not requeued: the same plan would be rejected again forever.
    assert.equal(
      (await harness.store.listSubmittedTasks())[0]?.status,
      "failed",
    );
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a lapsed lease cannot have a plan admitted", async () => {
  const harness = await createHarness();
  try {
    const taskId = await submit(harness);
    const assignment = await lease(harness);
    assert.ok(assignment);
    await harness.store.expireWorkLeases(
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    );

    const outcome = await admitWorkPlan(
      harness.store,
      {
        leaseId: assignment.lease.id,
        actorId: "user",
        plan: plan(taskId),
      },
      { repositories: harness.repositories },
    );
    assert.equal(outcome.outcome, "lease_lost");
    // The task is back in the queue for whoever leases it next.
    assert.equal(
      (await harness.store.listSubmittedTasks({ status: "submitted" })).length,
      1,
    );
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

/**
 * Partial admission end to end.
 *
 * One task holds src/value.js. A second task declares that file plus four
 * nobody is touching. All-or-nothing arbitration makes the second task wait
 * for all five; here it is admitted on the four immediately, the fifth is
 * withheld, and the withheld part comes back as a task of its own.
 */

const FREE_FILES = ["src/a.js", "src/b.js", "src/c.js", "src/d.js"];

/** A repository with the contested file plus four uncontested ones. */
async function splitHarness(): Promise<Harness> {
  return await createHarness(
    new InMemoryCoordinationStore(),
    Object.fromEntries(
      FREE_FILES.map((file, index) => [
        file,
        `export const free${index} = ${index};\n`,
      ]),
    ),
  );
}

/** Puts one task in flight holding src/value.js, and leaves it holding it. */
async function holdTheContestedFile(harness: Harness): Promise<WorkAssignment> {
  await harness.store.submitTask({
    repositoryId: "repo_worker",
    objective: "extend the value module",
    agentId: "generic-cli",
    validationCommands: [],
  });
  const assignment = await leaseWork(
    harness.store,
    {
      workerId: harness.workerId,
      projectId: DEFAULT_PROJECT_ID,
      repositoryParallelism: 2,
    },
    harness.repositories,
  );
  assert.ok(assignment);
  const outcome = await admitWorkPlan(
    harness.store,
    {
      leaseId: assignment.lease.id,
      actorId: "user",
      plan: plan(assignment.task.id, {
        objective: assignment.task.objective,
        expectedFiles: ["src/value.js"],
        expectedSymbols: ["value"],
      }),
    },
    { repositories: harness.repositories },
  );
  assert.ok(outcome.outcome === "admitted");
  assert.equal(outcome.admission.status, "approved");
  return assignment;
}

/** Leases the second task, which wants the held file and four free ones. */
async function leaseTheSplitTask(harness: Harness): Promise<WorkAssignment> {
  const user = await harness.store.createUser({
    email: `split-${Math.random().toString(36).slice(2)}@example.com`,
    displayName: "Split",
    passwordDigest: "digest",
  });
  const worker = await harness.store.registerWorker({
    userId: user.id,
    name: `worker-split-${Math.random().toString(36).slice(2)}`,
    adapters: ["generic-cli"],
    version: "1.0.0",
  });
  await harness.store.submitTask({
    repositoryId: "repo_worker",
    objective: "raise every constant",
    agentId: "generic-cli",
    validationCommands: [],
  });
  const assignment = await leaseWork(
    harness.store,
    {
      workerId: worker.id,
      projectId: DEFAULT_PROJECT_ID,
      repositoryParallelism: 2,
    },
    harness.repositories,
  );
  assert.ok(assignment);
  return assignment;
}

function splitTaskPlan(assignment: WorkAssignment): AgentPlan {
  return plan(assignment.task.id, {
    objective: assignment.task.objective,
    expectedFiles: [...FREE_FILES, "src/value.js"],
    expectedSymbols: [],
  });
}

/**
 * Submits a plan and keeps resubmitting it until it is admitted, exactly as
 * the worker's deferral loop does, returning how long that took.
 */
async function admissionWait(
  harness: Harness,
  assignment: WorkAssignment,
  services: Parameters<typeof admitWorkPlan>[2],
): Promise<{ admission: PlanAdmission; waitedMs: number }> {
  const startedAt = Date.now();
  const submit = async () =>
    await admitWorkPlan(
      harness.store,
      {
        leaseId: assignment.lease.id,
        actorId: "user",
        plan: splitTaskPlan(assignment),
      },
      services,
    );
  let outcome = await submit();
  while (
    outcome.outcome === "admitted" &&
    !planAdmissionApproved(outcome.admission) &&
    Date.now() - startedAt < 30_000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    outcome = await submit();
  }
  assert.ok(outcome.outcome === "admitted");
  return { admission: outcome.admission, waitedMs: Date.now() - startedAt };
}

/** Arbitration as it was before partial admission: the whole plan or none. */
class WholePlanAdmissions extends PlanAdmissionController {
  public override admit(input: PlanAdmissionInput): PlanAdmission {
    return super.admit({ ...input, partialAdmission: false });
  }
}

test("a partly contested task lands its free files while the contested one is still held", async () => {
  const harness = await splitHarness();
  try {
    const holder = await holdTheContestedFile(harness);
    const split = await leaseTheSplitTask(harness);

    const admitted = await admitWorkPlan(
      harness.store,
      {
        leaseId: split.lease.id,
        actorId: "user",
        plan: splitTaskPlan(split),
      },
      { repositories: harness.repositories },
    );
    assert.ok(admitted.outcome === "admitted");
    const admission = admitted.admission;

    // Admitted, not sequenced — and specific about what it withheld.
    assert.equal(admission.status, "approved_with_constraints");
    assert.ok(planAdmissionPartial(admission));
    assert.deepEqual(deferredFilePaths(admission), ["src/value.js"]);
    assert.deepEqual(
      admission.deferredResources
        ?.filter((resource) => resource.resourceType === "file")
        .flatMap((resource) => resource.heldBy),
      [holder.task.id],
    );
    assert.deepEqual(
      admission.ownershipGrants
        .filter((grant) => grant.resourceType === "file")
        .map((grant) => grant.resourceId)
        .sort(),
      FREE_FILES,
    );
    // The contested file is owned by nobody but the holder.
    assert.ok(
      !admission.ownershipGrants.some(
        (grant) => grant.resourceId === "src/value.js",
      ),
    );

    // The agent ignores the constraint and edits all five files. What it was
    // told does not decide what lands; what it was granted does.
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
      taskId: split.task.id,
      rootPath: path.join(harness.root, "split-workspace"),
      repository,
      baseVersion: split.canonicalVersion,
    });
    for (const [index, file] of FREE_FILES.entries()) {
      await writeFile(
        path.join(workspace.path, file),
        `export const free${index} = ${index + 100};\n`,
        "utf8",
      );
    }
    await writeFile(
      path.join(workspace.path, "src", "value.js"),
      "export const value = 999;\n",
      "utf8",
    );
    const changeSet = await workspaces.collectChangeSet(workspace, {
      symbolsChanged: [],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "raised every constant",
    });
    await workspaces.destroy(workspace);
    assert.equal(changeSet.patches.length, 5);

    const accepted = await acceptWorkResult(
      harness.store,
      {
        leaseId: split.lease.id,
        status: "completed",
        actorId: "user",
        plan: splitTaskPlan(split),
        changeSet,
      },
      {
        repositories: harness.repositories,
        integrationRoot: path.join(harness.root, "integration"),
      },
    );
    assert.equal(accepted.accepted, true, accepted.reason);
    assert.equal(accepted.integrationStatus, "integrated");

    // The four free files are in canonical. The contested one is untouched:
    // a patch was produced for it and never applied.
    const version = await harness.repositories.getCanonicalVersion(repository);
    for (const [index, file] of FREE_FILES.entries()) {
      assert.equal(
        await harness.repositories.readFile(repository, version.revision, file),
        `export const free${index} = ${index + 100};\n`,
      );
    }
    assert.equal(
      await harness.repositories.readFile(
        repository,
        version.revision,
        "src/value.js",
      ),
      "export const value = 1;\n",
    );

    // The whole point, stated as a fact about time: this landed while the
    // holder still held the contested file. Under all-or-nothing arbitration
    // none of it could have landed before the holder settled.
    assert.equal(
      (await harness.store.getWorkLease(holder.lease.id))?.status,
      "active",
    );
    assert.equal(
      (await harness.store.listSubmittedTasks()).find(
        (task) => task.id === holder.task.id,
      )?.status,
      "claimed",
    );

    // The withheld work is queued as a task of its own, not lost.
    const followUp = (
      await harness.store.listSubmittedTasks({ status: "submitted" })
    ).find((task) => task.objective.includes(DEFERRED_SCOPE_MARKER));
    assert.ok(followUp, "the deferred scope must come back as a task");
    assert.match(followUp.objective, /src\/value\.js/u);
    assert.match(followUp.objective, /raise every constant/u);
    assert.equal(followUp.repositoryId, "repo_worker");
    assert.equal(followUp.agentId, split.task.agentId);

    // The record shows what was promoted and what was held back, rather than
    // implying the agent's whole output reached canonical.
    const detail = await harness.store.getRun(accepted.runId ?? "");
    assert.equal(detail?.changeSets.length, 1);
    assert.deepEqual(
      detail?.changeSets[0]?.patches.map((entry) => entry.path).sort(),
      FREE_FILES,
    );
    const collected = (
      await harness.store.listAuditEvents({ taskId: split.task.id })
    ).find((entry) => entry.event.type === "changeset_collected");
    assert.deepEqual(collected?.event.data["withheldFiles"], ["src/value.js"]);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("partial admission starts work that all-or-nothing arbitration would have made wait", async () => {
  // The timing claim, measured. Both runs are the same repository shape, the
  // same two tasks and the same contested file; the only difference is whether
  // admission may split the plan. The holder settles after a fixed delay, so
  // the all-or-nothing run cannot start before then and the partial run does
  // not have to wait at all.
  const HOLD_MS = 2_000;

  const sequenced = await splitHarness();
  const partial = await splitHarness();
  const releaseTimers: NodeJS.Timeout[] = [];
  try {
    const sequencedHolder = await holdTheContestedFile(sequenced);
    const sequencedSplit = await leaseTheSplitTask(sequenced);
    const partialHolder = await holdTheContestedFile(partial);
    const partialSplit = await leaseTheSplitTask(partial);

    // The contested file frees up HOLD_MS after each run starts, so the two
    // measurements are of the same wait and not of each other's setup.
    const releaseAfterHold = (harness: Harness, leaseId: string): void => {
      releaseTimers.push(
        setTimeout(() => {
          void harness.store.finishWorkLease(
            leaseId,
            "released",
            new Date().toISOString(),
            "holder finished",
          );
        }, HOLD_MS),
      );
    };

    releaseAfterHold(sequenced, sequencedHolder.lease.id);
    const wholePlan = await admissionWait(sequenced, sequencedSplit, {
      repositories: sequenced.repositories,
      admissions: new WholePlanAdmissions(),
    });

    releaseAfterHold(partial, partialHolder.lease.id);
    const split = await admissionWait(partial, partialSplit, {
      repositories: partial.repositories,
    });

    // All-or-nothing: nothing could start until the holder let go.
    assert.equal(wholePlan.admission.status, "approved");
    assert.ok(
      wholePlan.waitedMs >= HOLD_MS,
      `all-or-nothing admission should have waited for the holder, waited ${wholePlan.waitedMs}ms`,
    );

    // Partial: admitted on the four free files on the first submission, with
    // the holder still holding the fifth.
    assert.equal(split.admission.status, "approved_with_constraints");
    assert.deepEqual(deferredFilePaths(split.admission), ["src/value.js"]);
    assert.ok(
      split.waitedMs < HOLD_MS,
      `partial admission should not have waited for the holder, waited ${split.waitedMs}ms`,
    );
    assert.ok(
      split.waitedMs < wholePlan.waitedMs,
      `partial ${split.waitedMs}ms should beat all-or-nothing ${wholePlan.waitedMs}ms`,
    );
    assert.equal(
      (await partial.store.getWorkLease(partialHolder.lease.id))?.status,
      "active",
      "the partial run must have been admitted before the holder let go",
    );
  } finally {
    for (const timer of releaseTimers) {
      clearTimeout(timer);
    }
    await rm(sequenced.root, { recursive: true, force: true });
    await rm(partial.root, { recursive: true, force: true });
  }
});

test("a follow-up task is arbitrated whole, so a task sheds scope only once", async () => {
  const harness = await splitHarness();
  try {
    const holder = await holdTheContestedFile(harness);
    // A follow-up naming the contested file and a free one. Partial admission
    // would happily grant the free one; the marker in the objective is what
    // stops it, and the task waits for the whole thing instead.
    await harness.store.submitTask({
      repositoryId: "repo_worker",
      objective: `${DEFERRED_SCOPE_MARKER} raise every constant — only the part that belongs in src/value.js`,
      agentId: "generic-cli",
      validationCommands: [],
    });
    const assignment = await leaseWork(
      harness.store,
      {
        workerId: harness.workerId,
        projectId: DEFAULT_PROJECT_ID,
        repositoryParallelism: 2,
      },
      harness.repositories,
    );
    assert.ok(assignment);
    assert.ok(assignment.task.objective.includes(DEFERRED_SCOPE_MARKER));

    const outcome = await admitWorkPlan(
      harness.store,
      {
        leaseId: assignment.lease.id,
        actorId: "user",
        plan: plan(assignment.task.id, {
          objective: assignment.task.objective,
          expectedFiles: ["src/a.js", "src/value.js"],
          expectedSymbols: [],
        }),
      },
      { repositories: harness.repositories },
    );
    assert.ok(outcome.outcome === "admitted");
    assert.equal(outcome.admission.status, "sequenced");
    assert.equal(outcome.admission.deferredResources, undefined);
    assert.deepEqual(outcome.admission.blockedBy, [holder.task.id]);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("an agent that only edited the deferred file is requeued, not failed", async () => {
  const harness = await splitHarness();
  try {
    await holdTheContestedFile(harness);
    const split = await leaseTheSplitTask(harness);
    const admitted = await admitWorkPlan(
      harness.store,
      {
        leaseId: split.lease.id,
        actorId: "user",
        plan: splitTaskPlan(split),
      },
      { repositories: harness.repositories },
    );
    assert.ok(admitted.outcome === "admitted");
    assert.equal(admitted.admission.status, "approved_with_constraints");

    const stored = await harness.store.getRepository("repo_worker");
    assert.ok(stored);
    const workspaces = new GitWorktreeWorkspaceManager(
      harness.repositories.getGitClient(),
    );
    const workspace = await workspaces.create({
      taskId: split.task.id,
      rootPath: path.join(harness.root, "deferred-only-workspace"),
      repository: {
        id: stored.id,
        path: stored.path,
        branch: stored.branch,
      },
      baseVersion: split.canonicalVersion,
    });
    await writeFile(
      path.join(workspace.path, "src", "value.js"),
      "export const value = 42;\n",
      "utf8",
    );
    const changeSet = await workspaces.collectChangeSet(workspace, {
      symbolsChanged: [],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "only touched the deferred file",
    });
    await workspaces.destroy(workspace);

    const outcome = await acceptWorkResult(
      harness.store,
      {
        leaseId: split.lease.id,
        status: "completed",
        actorId: "user",
        plan: splitTaskPlan(split),
        changeSet,
      },
      {
        repositories: harness.repositories,
        integrationRoot: path.join(harness.root, "integration"),
      },
    );

    // Nothing to promote, but nothing wrong with the task either: it goes back
    // to the queue at full scope rather than being marked failed.
    assert.equal(outcome.accepted, false);
    assert.equal(outcome.requeued, true);
    assert.match(outcome.reason ?? "", /deferred resource/u);
    assert.equal(
      (await harness.store.listSubmittedTasks()).find(
        (task) => task.id === split.task.id,
      )?.status,
      "submitted",
    );
    // Canonical never moved, and no follow-up task was invented for work that
    // never landed.
    assert.equal(
      (await harness.store.listSubmittedTasks()).some((task) =>
        task.objective.includes(DEFERRED_SCOPE_MARKER),
      ),
      false,
    );
    assert.equal((await harness.store.listRuns()).length, 0);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a changeset touching a file that was never arbitrated is still refused", async () => {
  // Partial admission widens what a result may declare, not what it may
  // write. A file in neither the granted nor the deferred set is the same
  // scope escape it always was.
  const harness = await splitHarness();
  try {
    await holdTheContestedFile(harness);
    const split = await leaseTheSplitTask(harness);
    const admitted = await admitWorkPlan(
      harness.store,
      {
        leaseId: split.lease.id,
        actorId: "user",
        plan: splitTaskPlan(split),
      },
      { repositories: harness.repositories },
    );
    assert.ok(admitted.outcome === "admitted");
    assert.equal(admitted.admission.status, "approved_with_constraints");

    const stored = await harness.store.getRepository("repo_worker");
    assert.ok(stored);
    const workspaces = new GitWorktreeWorkspaceManager(
      harness.repositories.getGitClient(),
    );
    const workspace = await workspaces.create({
      taskId: split.task.id,
      rootPath: path.join(harness.root, "escape-workspace"),
      repository: {
        id: stored.id,
        path: stored.path,
        branch: stored.branch,
      },
      baseVersion: split.canonicalVersion,
    });
    await writeFile(
      path.join(workspace.path, "src", "a.js"),
      "export const free0 = 100;\n",
      "utf8",
    );
    await writeFile(
      path.join(workspace.path, "src", "surprise.js"),
      "export const surprise = true;\n",
      "utf8",
    );
    const changeSet = await workspaces.collectChangeSet(workspace, {
      symbolsChanged: [],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "wandered outside the plan",
    });
    await workspaces.destroy(workspace);

    const outcome = await acceptWorkResult(
      harness.store,
      {
        leaseId: split.lease.id,
        status: "completed",
        actorId: "user",
        plan: splitTaskPlan(split),
        changeSet,
      },
      {
        repositories: harness.repositories,
        integrationRoot: path.join(harness.root, "integration"),
      },
    );
    assert.equal(outcome.accepted, false);
    assert.match(outcome.reason ?? "", /src\/surprise\.js/u);
    assert.equal(
      (await harness.store.getWorkLease(split.lease.id))?.status,
      "failed",
    );
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});
