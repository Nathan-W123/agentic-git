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
  findTaskHandoffs,
  seedContextForTask,
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
 * How long to wait for a result to reach its approval gate.
 *
 * A deadline rather than an attempt count, and a generous one: the result has
 * to be validated and recorded before it asks for approval, and on a machine
 * running every package's suite at once that takes far longer than it does
 * alone. This bounds a hang; it is not a performance assertion.
 */
const APPROVAL_WAIT_MS = 60_000;

async function approvalFor(harness: Harness, taskId: string) {
  const deadline = Date.now() + APPROVAL_WAIT_MS;
  let approval = (await harness.store.listApprovals({ taskId }))[0];
  while (approval === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    approval = (await harness.store.listApprovals({ taskId }))[0];
  }
  assert.ok(
    approval,
    `the result must stop for a human (waited ${APPROVAL_WAIT_MS}ms)`,
  );
  return approval;
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

test("an approved remote plan is immutable across retries", async () => {
  const harness = await createHarness();
  try {
    await submit(harness);
    const assignment = await lease(harness);
    assert.ok(assignment);

    const first = await admit(harness, assignment);
    assert.equal(first.outcome, "admitted");
    assert.equal(
      first.outcome === "admitted" ? first.admission.status : undefined,
      "approved",
    );

    const retried = await admit(harness, assignment, {
      expectedFiles: ["src/value.js", "src/other.js"],
      expectedSymbols: ["value", "other"],
    });
    assert.deepEqual(retried, first);
    assert.deepEqual(
      (await harness.store.getWorkLease(assignment.lease.id))?.plan?.plan
        .expectedFiles,
      ["src/value.js"],
    );
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

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
    const approval = await approvalFor(harness, taskId);
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

test("a gated remote plan waits for a reviewer before any agent runs", async () => {
  const harness = await createHarness();
  try {
    // The gate the local coordinator has always had, asked for remotely.
    await harness.store.updateProject(DEFAULT_PROJECT_ID, {
      policy: {
        version: 1,
        approvals: { requireRemotePlanReview: true, riskLevels: ["high"] },
      },
    });

    const taskId = await submit(harness);
    const assignment = await lease(harness);
    assert.ok(assignment);

    const pending = await admit(harness, assignment, { riskLevel: "high" });
    assert.equal(pending.outcome, "admitted");
    const first =
      pending.outcome === "admitted" ? pending.admission : undefined;
    assert.equal(first?.status, "sequenced");
    assert.equal(first?.awaitingApproval, true);
    assert.ok(first?.approvalId);
    assert.ok(first?.runId);
    // Not approved: the worker has no licence to execute, which is the whole
    // point of moving the gate ahead of execution.
    assert.equal(first === undefined ? true : planAdmissionApproved(first), false);
    assert.match(first?.explanation ?? "", /waiting for human approval/u);

    const approval = await approvalFor(harness, taskId);
    assert.equal(approval.kind, "policy_override");
    assert.ok(
      approval.reasons.some((reason) => reason.includes("risk level is high")),
    );

    // Resubmitting while the reviewer is still deciding is idempotent: the
    // same approval, not a second one queued behind the first.
    const again = await admit(harness, assignment, { riskLevel: "high" });
    assert.equal(
      again.outcome === "admitted" ? again.admission.approvalId : undefined,
      approval.id,
    );
    assert.equal((await harness.store.listApprovals({ taskId })).length, 1);

    await harness.store.decideApproval({
      approvalId: approval.id,
      status: "approved",
      decidedBy: "reviewer",
      comment: "Reviewed the plan before it ran",
      decidedAt: new Date().toISOString(),
    });

    const admitted = await admit(harness, assignment, { riskLevel: "high" });
    assert.equal(admitted.outcome, "admitted");
    const decision =
      admitted.outcome === "admitted" ? admitted.admission : undefined;
    assert.ok(decision && planAdmissionApproved(decision));
    // The run opened to carry the approval is the run the result will use.
    assert.equal(decision?.runId, first?.runId);
    assert.ok((decision?.ownershipGrants.length ?? 0) > 0);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a rejected remote plan fails its lease instead of executing", async () => {
  const harness = await createHarness();
  try {
    await harness.store.updateProject(DEFAULT_PROJECT_ID, {
      policy: {
        version: 1,
        approvals: { requireRemotePlanReview: true, riskLevels: ["high"] },
      },
    });

    const taskId = await submit(harness);
    const assignment = await lease(harness);
    assert.ok(assignment);
    await admit(harness, assignment, { riskLevel: "high" });

    const approval = await approvalFor(harness, taskId);
    await harness.store.decideApproval({
      approvalId: approval.id,
      status: "rejected",
      decidedBy: "reviewer",
      comment: "Too risky to run unattended",
      decidedAt: new Date().toISOString(),
    });

    const refused = await admit(harness, assignment, { riskLevel: "high" });
    assert.equal(refused.outcome, "rejected");
    assert.match(
      refused.outcome === "rejected" ? refused.reason : "",
      /not approved/u,
    );

    // Failed, not requeued: the same plan would be refused again, and a
    // reviewer's "no" is not a transient condition to retry through.
    assert.equal(
      (await harness.store.getWorkLease(assignment.lease.id))?.status,
      "failed",
    );
    const tasks = await harness.store.listSubmittedTasks();
    assert.equal(tasks.find((task) => task.id === taskId)?.status, "failed");
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
    const approval = await approvalFor(harness, taskId);
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

test("a task waiting on running work goes to the back of the lease queue", async () => {
  const harness = await createHarness();
  try {
    // `waiting` was refused and told to wait for `blocker`, which is still
    // executing. `ready` has never been refused. Leasing is where planning is
    // paid for, so handing a worker the waiting task would buy a full planning
    // round to be told to wait again — 74% of planning calls in the ten-task
    // live run were exactly that.
    const blocker = await submit(harness);
    const held = await lease(harness);
    assert.ok(held);
    assert.equal(held.task.id, blocker);

    const waiting = await submit(harness);
    const ready = await submit(harness);
    await harness.store.appendAudit(undefined, {
      type: "plan_admitted",
      taskId: waiting,
      data: { status: "sequenced", blockedBy: [blocker] },
    });

    const next = await lease(harness);
    assert.ok(next);
    assert.equal(
      next.task.id,
      ready,
      "the task with nothing in its way must be leased first",
    );
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a waiting task is still leased when nothing else can run", async () => {
  const harness = await createHarness();
  try {
    // Postponed, never excluded. If the queue holds nothing but tasks waiting
    // on a blocker, a worker must still take one — otherwise the ordering
    // preference becomes a starvation bug, and the deadlock it causes would be
    // worse than the replanning it saves.
    const blocker = await submit(harness);
    const held = await lease(harness);
    assert.ok(held);

    const waiting = await submit(harness);
    await harness.store.appendAudit(undefined, {
      type: "plan_admitted",
      taskId: waiting,
      data: { status: "sequenced", blockedBy: [held.task.id] },
    });
    void blocker;

    const next = await lease(harness);
    assert.ok(next, "the only remaining task must still be leasable");
    assert.equal(next.task.id, waiting);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a task whose blocker has finished is not postponed", async () => {
  const harness = await createHarness();
  try {
    // The refusal is a fact about a moment, not a standing property. Once the
    // blocker settles the task is ready, and reading the live lease table
    // rather than trusting the old answer is what makes that true.
    const blocker = await submit(harness);
    const held = await lease(harness);
    assert.ok(held);

    const waiting = await submit(harness);
    const ready = await submit(harness);
    await harness.store.appendAudit(undefined, {
      type: "plan_admitted",
      taskId: waiting,
      data: { status: "sequenced", blockedBy: [blocker] },
    });

    await harness.store.finishWorkLease(
      held.lease.id,
      "completed",
      new Date().toISOString(),
      "blocker integrated",
    );
    await harness.store.completeSubmittedTask(blocker, "integrated");

    const next = await lease(harness);
    assert.ok(next);
    assert.equal(
      next.task.id,
      waiting,
      "with its blocker gone the waiting task returns to submission order",
    );
    void ready;
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("an exhausted daily token budget stops leasing until cleared", async () => {
  const harness = await createHarness();
  try {
    await harness.store.updateProject(DEFAULT_PROJECT_ID, {
      policy: {
        version: 1,
        budgets: { maxProjectTokensPerDay: 10_000 },
      },
    });

    await submit(harness);
    const first = await lease(harness);
    assert.ok(first, "the untouched budget must admit the first lease");

    // The spend an agent reported, recorded against the lease that incurred
    // it — the same write the heartbeat performs in the running system.
    await harness.store.recordTokenUsage({
      usageKey: `${first.lease.id}:execution`,
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: "repo_worker",
      taskId: first.task.id,
      leaseId: first.lease.id,
      agentId: first.task.agentId,
      phase: "execution",
      totalTokens: 12_000,
      recordedAt: new Date().toISOString(),
    });
    await harness.store.finishWorkLease(
      first.lease.id,
      "completed",
      new Date().toISOString(),
      "spent the budget",
    );
    await harness.store.completeSubmittedTask(first.task.id, "integrated");

    // Queued, not failed: a token budget throttles spend exactly as the
    // runtime budget throttles time, and neither discards work.
    const queued = await submit(harness);
    assert.equal(await lease(harness), undefined);
    assert.equal(
      (await harness.store.listSubmittedTasks()).find(
        (task) => task.id === queued,
      )?.status,
      "submitted",
    );

    await harness.store.updateProject(DEFAULT_PROJECT_ID, { policy: null });
    assert.equal((await lease(harness))?.task.id, queued);
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
    // was fine when it was approved and canonical moved during execution onto
    // the very file it declared. An advance elsewhere in the tree is replayed
    // rather than requeued; this is the advance that cannot be.
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
    await writeFile(
      path.join(competing.path, "src", "value.js"),
      "export const value = 99;\n",
    );
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

test("concurrent workers in one repository cannot corrupt canonical; a disjoint loser is replayed", async () => {
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

    // Worker B built from a base canonical has now moved past. The advance
    // was worker A rewriting src/value.js, which worker B neither touches nor
    // depends on, so B's finished result is replayed onto the newer revision
    // rather than thrown away. Canonical is still safe: the three-way apply,
    // the applied-versus-declared check and the compare-and-swap promotion all
    // still run, and B's own agent run is not spent twice.
    const acceptedB = await acceptWorkResult(
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
    assert.equal(acceptedB.accepted, true, acceptedB.reason);
    assert.equal(acceptedB.integrationStatus, "integrated");
    assert.equal(
      (await harness.store.listSubmittedTasks()).find(
        (task) => task.id === taskB.id,
      )?.status,
      "integrated",
    );
    // The record says the result outlived its base rather than pretending it
    // was an ordinary promotion.
    const replayed = (await harness.store.getRun(acceptedB.runId ?? ""))
      ?.integrations.at(-1);
    assert.equal(replayed?.replayedFrom, assignmentB.lease.baseRevision);
    assert.notEqual(
      replayed?.previousVersion.revision,
      assignmentB.lease.baseRevision,
    );
    // Task B never had to be leased a second time.
    assert.equal(
      (await harness.store.listWorkLeases({ status: "active" })).length,
      0,
    );

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
  /**
   * Runs once the first submission has been answered. The contested file is
   * freed from here rather than from the start of the run, so how long the
   * holder holds it is measured from a point both runs reach — otherwise a
   * loaded machine makes the first round trip, not the holder, the thing being
   * measured.
   */
  onFirstAnswer: () => void = () => undefined,
): Promise<{ admission: PlanAdmission; waitedMs: number; attempts: number }> {
  const startedAt = Date.now();
  let attempts = 0;
  const submit = async () => {
    attempts += 1;
    return await admitWorkPlan(
      harness.store,
      {
        leaseId: assignment.lease.id,
        actorId: "user",
        plan: splitTaskPlan(assignment),
      },
      services,
    );
  };
  let outcome = await submit();
  onFirstAnswer();
  while (
    outcome.outcome === "admitted" &&
    !planAdmissionApproved(outcome.admission) &&
    Date.now() - startedAt < 60_000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    outcome = await submit();
  }
  assert.ok(outcome.outcome === "admitted");
  return {
    admission: outcome.admission,
    waitedMs: Date.now() - startedAt,
    attempts,
  };
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

    // The held-back work is kept, joined to the follow-up that will redo it.
    // It is never replayed — the file it was written against is being
    // rewritten by the holder — but the next agent does not start cold.
    const withheld = (
      await harness.store.listAuditEvents({ taskId: followUp.id })
    ).find((entry) => entry.event.type === "changeset_withheld");
    assert.ok(withheld, "the withheld patches must be kept, not dropped");
    assert.equal(withheld.event.data["deferredFrom"], split.task.id);
    assert.equal(withheld.event.data["baseRevision"], split.lease.baseRevision);
    assert.equal(withheld.event.data["truncated"], false);
    const patches = withheld.event.data["patches"] as {
      path: string;
      patch: string;
    }[];
    assert.deepEqual(
      patches.map((entry) => entry.path),
      ["src/value.js"],
    );
    // The actual diff, not just a note that there was one.
    assert.match(patches[0]?.patch ?? "", /^--- a\/src\/value\.js/mu);
    assert.match(patches[0]?.patch ?? "", /\+export const value = 999;/u);
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

    // The contested file is freed HOLD_MS after each run's first submission is
    // answered, not after the run starts. Both runs therefore measure the same
    // wait from the same point, and a loaded machine slowing a round trip down
    // cannot be mistaken for the holder taking longer.
    const releaseAfterHold = (harness: Harness, leaseId: string) => (): void => {
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

    const wholePlan = await admissionWait(
      sequenced,
      sequencedSplit,
      {
        repositories: sequenced.repositories,
        admissions: new WholePlanAdmissions(),
      },
      releaseAfterHold(sequenced, sequencedHolder.lease.id),
    );
    const split = await admissionWait(
      partial,
      partialSplit,
      { repositories: partial.repositories },
      releaseAfterHold(partial, partialHolder.lease.id),
    );

    // All-or-nothing: refused on the first submission, and nothing could start
    // until the holder let go — so it came back for more than one round trip
    // and spent at least the holding period idle.
    assert.equal(wholePlan.admission.status, "approved");
    assert.ok(
      wholePlan.attempts > 1,
      `all-or-nothing admission should have had to resubmit, took ${wholePlan.attempts} attempt(s)`,
    );
    assert.ok(
      wholePlan.waitedMs >= HOLD_MS,
      `all-or-nothing admission should have waited for the holder, waited ${wholePlan.waitedMs}ms`,
    );

    // Partial: admitted on the four free files by the first submission, with
    // the holder still holding the fifth. This is the load-independent form of
    // the claim — one round trip, no waiting, whatever the machine is doing.
    assert.equal(split.admission.status, "approved_with_constraints");
    assert.deepEqual(deferredFilePaths(split.admission), ["src/value.js"]);
    assert.equal(
      split.attempts,
      1,
      `partial admission should have been answered on the first submission, took ${split.attempts}`,
    );
    assert.equal(
      (await partial.store.getWorkLease(partialHolder.lease.id))?.status,
      "active",
      "the partial run must have been admitted before the holder let go",
    );
    // And the difference is the holding period, not noise. Both runs pay the
    // same fixed admission cost; only one of them also sits out the wait.
    assert.ok(
      wholePlan.waitedMs - split.waitedMs >= HOLD_MS / 2,
      `all-or-nothing ${wholePlan.waitedMs}ms should exceed partial ${split.waitedMs}ms by the holding period`,
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

test("a result is still requeued when the advance touched what it depends on", async () => {
  // The other half of replay. Admission cannot see every way canonical moves —
  // a local coordinator run, a rollback, an operator push — so the replay check
  // is what stands between a finished result and a base that changed
  // underneath it. Here canonical moves outside arbitration entirely, onto the
  // very file this result rewrites, and the result is refused exactly as
  // before.
  const harness = await createHarness();
  try {
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

    // The agent's finished work, built against the leased base.
    const agentWorkspace = await workspaces.create({
      taskId,
      rootPath: path.join(harness.root, "agent-workspaces"),
      repository,
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

    // Canonical moves by a route this arbitration never saw, onto the same
    // file. This is what the check exists for.
    const before = await harness.repositories.getCanonicalVersion(repository);
    const outside = await workspaces.create({
      taskId: "outside",
      rootPath: path.join(harness.root, "outside"),
      repository,
      baseVersion: before,
    });
    await writeFile(
      path.join(outside.path, "src", "value.js"),
      "export const value = 7;\n",
      "utf8",
    );
    const candidate = await harness.repositories.commitAll(
      outside.path,
      "changed outside arbitration",
    );
    assert.ok(candidate);
    assert.equal(
      await harness.repositories.promote(
        repository,
        candidate,
        before.revision,
      ),
      true,
    );
    await workspaces.destroy(outside);

    const outcome = await acceptWorkResult(
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

    assert.equal(outcome.accepted, false);
    assert.equal(outcome.requeued, true);
    assert.equal(
      (await harness.store.listSubmittedTasks()).find(
        (task) => task.id === taskId,
      )?.status,
      "submitted",
    );
    // The outside change is still what canonical holds: nothing was replayed
    // over the top of it.
    const version = await harness.repositories.getCanonicalVersion(repository);
    assert.equal(
      await harness.repositories.readFile(
        repository,
        version.revision,
        "src/value.js",
      ),
      "export const value = 7;\n",
    );
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

/**
 * Withholding a symbol end to end.
 *
 * The contested resource is not a file this time: both tasks want the same
 * function, which lives in a file only one of them declares. Ownership could
 * always see that; what is new is that the plan can be admitted on everything
 * else and the result held to it.
 */

/** A module whose two exports can be contested independently. */
const SHAPES = [
  "export const keepMe = 1;",
  "",
  "export function contended() {",
  "  return keepMe;",
  "}",
  "",
].join("\n");

async function symbolHarness(): Promise<Harness> {
  return await createHarness(new InMemoryCoordinationStore(), {
    "src/shapes.js": SHAPES,
    "src/free.js": "export const free = 1;\n",
  });
}

test("a symbol is withheld while the file holding it keeps working", async () => {
  const harness = await symbolHarness();
  try {
    // The holder declares only src/other.js, but claims the symbol
    // `contended` — the case ownership catches and file paths cannot.
    await harness.store.submitTask({
      repositoryId: "repo_worker",
      objective: "rework the contended helper",
      agentId: "generic-cli",
      validationCommands: [],
    });
    const holder = await leaseWork(
      harness.store,
      {
        workerId: harness.workerId,
        projectId: DEFAULT_PROJECT_ID,
        repositoryParallelism: 2,
      },
      harness.repositories,
    );
    assert.ok(holder);
    const holderAdmission = await admitWorkPlan(
      harness.store,
      {
        leaseId: holder.lease.id,
        actorId: "user",
        plan: plan(holder.task.id, {
          objective: holder.task.objective,
          expectedFiles: ["src/other.js"],
          expectedSymbols: ["contended"],
        }),
      },
      { repositories: harness.repositories },
    );
    assert.ok(holderAdmission.outcome === "admitted");
    assert.equal(holderAdmission.admission.status, "approved");

    // The second task declares the file that actually holds `contended`, plus
    // an unrelated one.
    const split = await leaseTheSplitTask(harness);
    const splitPlan = plan(split.task.id, {
      objective: split.task.objective,
      expectedFiles: ["src/shapes.js", "src/free.js"],
      expectedSymbols: ["keepMe", "contended"],
    });
    const admitted = await admitWorkPlan(
      harness.store,
      { leaseId: split.lease.id, actorId: "user", plan: splitPlan },
      { repositories: harness.repositories },
    );
    assert.ok(admitted.outcome === "admitted");
    assert.equal(admitted.admission.status, "approved_with_constraints");

    // The symbol is withheld; the file holding it is not.
    assert.deepEqual(
      admitted.admission.deferredResources?.map(
        (resource) => `${resource.resourceType}:${resource.resourceId}`,
      ),
      ["symbol:contended"],
    );
    assert.deepEqual(
      admitted.admission.ownershipGrants
        .filter((grant) => grant.resourceType === "file")
        .map((grant) => grant.resourceId)
        .sort(),
      ["src/free.js", "src/shapes.js"],
    );

    // The agent edits `keepMe` in the granted file, and leaves `contended`
    // alone — the case that is supposed to sail through.
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
      rootPath: path.join(harness.root, "symbol-workspace"),
      repository,
      baseVersion: split.canonicalVersion,
    });
    await writeFile(
      path.join(workspace.path, "src", "shapes.js"),
      SHAPES.replace("export const keepMe = 1;", "export const keepMe = 100;"),
      "utf8",
    );
    const changeSet = await workspaces.collectChangeSet(workspace, {
      symbolsChanged: ["keepMe"],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "raised keepMe and left contended alone",
    });
    await workspaces.destroy(workspace);

    const accepted = await acceptWorkResult(
      harness.store,
      {
        leaseId: split.lease.id,
        status: "completed",
        actorId: "user",
        plan: splitPlan,
        changeSet,
      },
      {
        repositories: harness.repositories,
        integrationRoot: path.join(harness.root, "integration"),
      },
    );
    assert.equal(accepted.accepted, true, accepted.reason);

    const version = await harness.repositories.getCanonicalVersion(repository);
    const promoted = await harness.repositories.readFile(
      repository,
      version.revision,
      "src/shapes.js",
    );
    assert.match(promoted, /keepMe = 100/u);
    // `contended` is exactly as it was: the holder still owns it.
    assert.match(promoted, /export function contended\(\) \{/u);
    assert.equal(
      (await harness.store.getWorkLease(holder.lease.id))?.status,
      "active",
    );
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a patch reaching into a withheld symbol loses its file, not the run", async () => {
  const harness = await symbolHarness();
  try {
    await harness.store.submitTask({
      repositoryId: "repo_worker",
      objective: "rework the contended helper",
      agentId: "generic-cli",
      validationCommands: [],
    });
    const holder = await leaseWork(
      harness.store,
      {
        workerId: harness.workerId,
        projectId: DEFAULT_PROJECT_ID,
        repositoryParallelism: 2,
      },
      harness.repositories,
    );
    assert.ok(holder);
    await admitWorkPlan(
      harness.store,
      {
        leaseId: holder.lease.id,
        actorId: "user",
        plan: plan(holder.task.id, {
          objective: holder.task.objective,
          expectedFiles: ["src/other.js"],
          expectedSymbols: ["contended"],
        }),
      },
      { repositories: harness.repositories },
    );

    const split = await leaseTheSplitTask(harness);
    const splitPlan = plan(split.task.id, {
      objective: split.task.objective,
      expectedFiles: ["src/shapes.js", "src/free.js"],
      expectedSymbols: ["keepMe", "contended"],
    });
    const admitted = await admitWorkPlan(
      harness.store,
      { leaseId: split.lease.id, actorId: "user", plan: splitPlan },
      { repositories: harness.repositories },
    );
    assert.ok(admitted.outcome === "admitted");
    assert.equal(admitted.admission.status, "approved_with_constraints");

    // This time the agent ignores the constraint and rewrites `contended`,
    // while also editing an unrelated file it does own.
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
      rootPath: path.join(harness.root, "symbol-escape-workspace"),
      repository,
      baseVersion: split.canonicalVersion,
    });
    await writeFile(
      path.join(workspace.path, "src", "shapes.js"),
      SHAPES.replace("  return keepMe;", "  return keepMe * 2;"),
      "utf8",
    );
    await writeFile(
      path.join(workspace.path, "src", "free.js"),
      "export const free = 42;\n",
      "utf8",
    );
    const changeSet = await workspaces.collectChangeSet(workspace, {
      symbolsChanged: ["contended", "free"],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "rewrote contended anyway",
    });
    await workspaces.destroy(workspace);

    const accepted = await acceptWorkResult(
      harness.store,
      {
        leaseId: split.lease.id,
        status: "completed",
        actorId: "user",
        plan: splitPlan,
        changeSet,
      },
      {
        repositories: harness.repositories,
        integrationRoot: path.join(harness.root, "integration"),
      },
    );

    // The unrelated file still lands. The file holding the withheld symbol
    // does not — the run is not lost, only the part of it that reached where
    // it was told not to.
    assert.equal(accepted.accepted, true, accepted.reason);
    const version = await harness.repositories.getCanonicalVersion(repository);
    assert.equal(
      await harness.repositories.readFile(
        repository,
        version.revision,
        "src/free.js",
      ),
      "export const free = 42;\n",
    );
    assert.match(
      await harness.repositories.readFile(
        repository,
        version.revision,
        "src/shapes.js",
      ),
      /return keepMe;/u,
    );

    // The dropped file is named in the follow-up, so its other edits are not
    // silently gone.
    const followUp = (
      await harness.store.listSubmittedTasks({ status: "submitted" })
    ).find((task) => task.objective.includes(DEFERRED_SCOPE_MARKER));
    assert.ok(followUp);
    assert.match(followUp.objective, /symbol contended/u);
    assert.match(followUp.objective, /src\/shapes\.js/u);

    const collected = (
      await harness.store.listAuditEvents({ taskId: split.task.id })
    ).find((entry) => entry.event.type === "changeset_collected");
    assert.deepEqual(collected?.event.data["withheldSymbols"], {
      "src/shapes.js": ["contended"],
    });
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a settled task leaves a handoff a later task can be seeded with", async () => {
  // The compaction boundary in practice: the task finishes, and what it
  // learned is on the record in a form a fresh session can start from without
  // replaying anything.
  const harness = await splitHarness();
  try {
    const holder = await holdTheContestedFile(harness);
    const split = await leaseTheSplitTask(harness);
    const admitted = await admitWorkPlan(
      harness.store,
      { leaseId: split.lease.id, actorId: "user", plan: splitTaskPlan(split) },
      { repositories: harness.repositories },
    );
    assert.ok(admitted.outcome === "admitted");
    assert.equal(admitted.admission.status, "approved_with_constraints");

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
      rootPath: path.join(harness.root, "handoff-workspace"),
      repository,
      baseVersion: split.canonicalVersion,
    });
    for (const [index, file] of FREE_FILES.entries()) {
      await writeFile(
        path.join(workspace.path, file),
        `export const free${index} = ${index + 100};
`,
        "utf8",
      );
    }
    const changeSet = await workspaces.collectChangeSet(workspace, {
      symbolsChanged: [],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "raised the free constants",
    });
    await workspaces.destroy(workspace);

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

    const handoffs = await findTaskHandoffs(harness.store, {
      taskId: split.task.id,
    });
    assert.equal(handoffs.length, 1, "a settled task must leave exactly one");
    const handoff = handoffs[0];
    assert.ok(handoff);

    // Partial, because the contested file was withheld — and it names the
    // holder rather than saying something vague about a conflict.
    assert.equal(handoff.reason, "partially_completed");
    assert.ok(
      handoff.open.some(
        (entry) =>
          entry.item.includes("src/value.js") &&
          entry.blockedBy.includes(holder.task.id),
      ),
      JSON.stringify(handoff.open),
    );
    // Every "done" line points at something checkable.
    assert.ok(
      handoff.completed.some(
        (entry) => entry.kind === "canonical_promotion",
      ),
    );
    assert.ok(
      handoff.completed.some((entry) => entry.kind === "follow_up_task"),
      "the queued follow-up belongs in the record",
    );
    // And the next session gets it as context, not as raw history.
    const seeded = await seedContextForTask(harness.store, {
      resources: ["src/value.js"],
    });
    assert.match(seeded, /Handoff from earlier work/u);
    assert.match(seeded, /src\/value\.js/u);
    assert.match(seeded, /Next steps/u);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a solo plan is approved on the spot, without arbitration machinery", async () => {
  const harness = await createHarness();
  try {
    await submit(harness);
    const assignment = await lease(harness);
    assert.ok(assignment);

    const outcome = await admit(harness, assignment);
    assert.equal(outcome.outcome, "admitted");
    const admission =
      outcome.outcome === "admitted" ? outcome.admission : undefined;
    assert.equal(admission?.status, "approved");
    assert.match(admission?.explanation ?? "", /without arbitration/u);

    // The stored plan is the declared plan: nothing existed to enrich or
    // ground it against, and the next arrival computes both on the fly.
    const stored = await harness.store.getWorkLease(assignment.lease.id);
    assert.equal(stored?.plan?.plan.grounding, undefined);
    assert.deepEqual(stored?.plan?.plan.expectedFiles, ["src/value.js"]);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("the second arrival is arbitrated against a fast-path plan's real footprint", async () => {
  const harness = await createHarness(new InMemoryCoordinationStore(), {
    "src/pricing/total.js":
      "export function subtotal(lines) { return 1; }\n" +
      "export function orderTotal(customer, lines) { return 2; }\n",
  });
  try {
    // First worker goes solo on the real pricing file; its stored plan is
    // bare — declared files only, no enrichment, no grounding.
    await submit(harness);
    const first = await lease(harness);
    assert.ok(first);
    const solo = await admit(harness, first, {
      expectedFiles: ["src/pricing/total.js"],
      expectedSymbols: [],
    });
    assert.equal(solo.outcome, "admitted");
    assert.equal(
      solo.outcome === "admitted" ? solo.admission.status : undefined,
      "approved",
    );

    // Second worker declares a file that does not exist and a symbol that
    // does not resolve — the recorded live hallucination shape. Detection
    // requires both halves of the fix: grounding maps calculateTotal to
    // orderTotal in src/pricing/total.js, and the fast-path plan is enriched
    // on the fly so that file's symbols are claimed by the first task.
    await harness.store.submitTask({
      repositoryId: "repo_worker",
      objective: "charge a checkout fee",
      agentId: "generic-cli",
      validationCommands: [],
    });
    const second = await lease(harness);
    assert.ok(second);
    const contested = await admit(harness, second, {
      objective: second.task.objective,
      expectedFiles: ["src/checkout.js"],
      expectedSymbols: ["calculateTotal"],
    });
    assert.equal(contested.outcome, "admitted");
    const admission =
      contested.outcome === "admitted" ? contested.admission : undefined;
    assert.equal(admission?.status, "sequenced");
    assert.deepEqual(admission?.blockedBy, [first.task.id]);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a fast-path admission still lands through exact-base integration", async () => {
  const harness = await createHarness();
  try {
    const taskId = await submit(harness);
    const assignment = await leaseAndAdmit(harness);

    const accepted = await acceptWorkResult(harness.store, {
      leaseId: assignment.lease.id,
      status: "completed",
      actorId: "user",
      plan: plan(taskId),
      changeSet: resultStub(taskId, harness.revision, {
        patches: [
          {
            path: "src/value.js",
            status: "modified",
            patch:
              "diff --git a/src/value.js b/src/value.js\n" +
              "--- a/src/value.js\n" +
              "+++ b/src/value.js\n" +
              "@@ -1 +1 @@\n" +
              "-export const value = 1;\n" +
              "+export const value = 2;\n",
          },
        ],
      }),
    });
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.integrationStatus, "integrated");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

/** Shared-mode prose file where concurrent same-file work is legitimate. */
const GUIDE = Array.from(
  { length: 40 },
  (_, index) => `Guide line ${String(index + 1)}.`,
).join("\n") + "\n";

async function collectEdit(
  harness: Harness,
  taskId: string,
  baseVersion: { sequence: number; revision: string; branch: string; createdAt: string },
  edit: (content: string) => string,
) {
  const repository = await harness.store.getRepository("repo_worker");
  assert.ok(repository);
  const canonicalRepo = {
    id: repository.id,
    path: repository.path,
    branch: repository.branch,
  };
  const workspaces = new GitWorktreeWorkspaceManager(
    harness.repositories.getGitClient(),
  );
  const workspace = await workspaces.create({
    taskId,
    rootPath: path.join(harness.root, "merge-workspaces"),
    repository: canonicalRepo,
    baseVersion,
  });
  const target = path.join(workspace.path, "docs", "guide.md");
  await writeFile(target, edit(await readFile(target, "utf8")), "utf8");
  const changeSet = await workspaces.collectChangeSet(workspace, {
    symbolsChanged: [],
    riskAssessment: { level: "low", reasons: [] },
    agentExplanation: "edited the guide",
  });
  await workspaces.destroy(workspace);
  return changeSet;
}

/**
 * One admitted task on a shared prose file, with canonical advanced under it
 * by an external edit to the same file — a human push, or a local
 * coordinator run the lease system never saw.
 */
async function externalAdvanceOnGuide(harness: Harness) {
  const taskB = await harness.store.submitTask({
    repositoryId: "repo_worker",
    objective: "correct the closing summary",
    agentId: "generic-cli",
    validationCommands: [],
  });
  const assignmentB = await leaseWork(harness.store, {
    workerId: harness.workerId,
    projectId: DEFAULT_PROJECT_ID,
  });
  assert.ok(assignmentB);
  const outcome = await admit(harness, assignmentB, {
    objective: assignmentB.task.objective,
    expectedFiles: ["docs/guide.md"],
    expectedSymbols: [],
  });
  assert.equal(
    outcome.outcome === "admitted" ? outcome.admission.status : outcome,
    "approved",
  );

  const repository = await harness.store.getRepository("repo_worker");
  assert.ok(repository);
  const canonicalRepo = {
    id: repository.id,
    path: repository.path,
    branch: repository.branch,
  };
  const workspaces = new GitWorktreeWorkspaceManager(
    harness.repositories.getGitClient(),
  );
  const competing = await workspaces.create({
    taskId: "external-edit",
    rootPath: path.join(harness.root, "external"),
    repository: canonicalRepo,
    baseVersion: assignmentB.canonicalVersion,
  });
  const target = path.join(competing.path, "docs", "guide.md");
  await writeFile(
    target,
    (await readFile(target, "utf8")).replace(
      "Guide line 1.",
      "Guide line 1, expanded externally.",
    ),
    "utf8",
  );
  const candidate = await harness.repositories.commitAll(
    competing.path,
    "advance canonical",
  );
  assert.ok(candidate);
  assert.equal(
    await harness.repositories.promote(
      canonicalRepo,
      candidate,
      assignmentB.canonicalVersion.revision,
    ),
    true,
  );
  await workspaces.destroy(competing);
  return { taskB, assignmentB };
}

test("a same-file loser with disjoint hunks is merged for free instead of replanned", async () => {
  const harness = await createHarness(new InMemoryCoordinationStore(), {
    "docs/guide.md": GUIDE,
  });
  try {
    const { taskB, assignmentB } = await externalAdvanceOnGuide(harness);
    const acceptedB = await acceptWorkResult(
      harness.store,
      {
        leaseId: assignmentB.lease.id,
        status: "completed",
        actorId: "user",
        plan: plan(taskB.id, {
          objective: taskB.objective,
          expectedFiles: ["docs/guide.md"],
          expectedSymbols: [],
        }),
        changeSet: await collectEdit(
          harness,
          taskB.id,
          assignmentB.canonicalVersion,
          (content) =>
            content.replace("Guide line 40.", "Guide line 40, corrected."),
        ),
      },
      {
        repositories: harness.repositories,
        integrationRoot: path.join(harness.root, "integration"),
      },
    );

    // The free three-way merge landed the disjoint hunks; no replan was paid.
    assert.equal(acceptedB.accepted, true, acceptedB.reason);
    assert.equal(acceptedB.integrationStatus, "integrated");
    assert.equal(acceptedB.requeued, undefined);
    const tasks = await harness.store.listSubmittedTasks();
    assert.ok(tasks.every((entry) => entry.status === "integrated"));
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a same-file loser with overlapping hunks is requeued to replan, not failed", async () => {
  const harness = await createHarness(new InMemoryCoordinationStore(), {
    "docs/guide.md": GUIDE,
  });
  try {
    const { taskB, assignmentB } = await externalAdvanceOnGuide(harness);
    const acceptedB = await acceptWorkResult(
      harness.store,
      {
        leaseId: assignmentB.lease.id,
        status: "completed",
        actorId: "user",
        plan: plan(taskB.id, {
          objective: taskB.objective,
          expectedFiles: ["docs/guide.md"],
          expectedSymbols: [],
        }),
        changeSet: await collectEdit(
          harness,
          taskB.id,
          assignmentB.canonicalVersion,
          // Same line the winner rewrote: the merge must conflict.
          (content) => content.replace("Guide line 1.", "Guide line 1, redone."),
        ),
      },
      {
        repositories: harness.repositories,
        integrationRoot: path.join(harness.root, "integration"),
      },
    );

    // Losing the free bet costs what it always cost: a requeue to replan.
    assert.equal(acceptedB.accepted, false);
    assert.equal(acceptedB.requeued, true);
    const taskAfter = (await harness.store.listSubmittedTasks()).find(
      (entry) => entry.id === taskB.id,
    );
    assert.equal(taskAfter?.status, "submitted");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

/**
 * Two edit sites far enough apart that git emits two hunks: one inside the
 * contended function, one well clear of it. The whole point of dividing is
 * that these two stop sharing a fate.
 */
const SPACED_SHAPES = [
  "export const keepMe = 1;",
  "",
  "export function alpha() {",
  "  return keepMe;",
  "}",
  "",
  "export function spacerOne() {",
  "  return 1;",
  "}",
  "",
  "export function spacerTwo() {",
  "  return 2;",
  "}",
  "",
  "export function contended() {",
  "  return keepMe + 1;",
  "}",
  "",
].join("\n");

async function spacedHarness(): Promise<Harness> {
  return await createHarness(new InMemoryCoordinationStore(), {
    "src/spaced.js": SPACED_SHAPES,
    "src/free.js": "export const free = 1;\n",
  });
}

test("hunks clear of a withheld symbol land while only the trespass waits", async () => {
  const harness = await spacedHarness();
  try {
    await harness.store.submitTask({
      repositoryId: "repo_worker",
      objective: "rework the contended helper",
      agentId: "generic-cli",
      validationCommands: [],
    });
    const holder = await leaseWork(
      harness.store,
      {
        workerId: harness.workerId,
        projectId: DEFAULT_PROJECT_ID,
        repositoryParallelism: 2,
      },
      harness.repositories,
    );
    assert.ok(holder);
    await admitWorkPlan(
      harness.store,
      {
        leaseId: holder.lease.id,
        actorId: "user",
        plan: plan(holder.task.id, {
          objective: holder.task.objective,
          expectedFiles: ["src/other.js"],
          expectedSymbols: ["contended"],
        }),
      },
      { repositories: harness.repositories },
    );

    const split = await leaseTheSplitTask(harness);
    const splitPlan = plan(split.task.id, {
      objective: split.task.objective,
      expectedFiles: ["src/spaced.js", "src/free.js"],
      expectedSymbols: ["alpha", "contended"],
    });
    const admitted = await admitWorkPlan(
      harness.store,
      { leaseId: split.lease.id, actorId: "user", plan: splitPlan },
      { repositories: harness.repositories },
    );
    assert.ok(admitted.outcome === "admitted");
    assert.equal(admitted.admission.status, "approved_with_constraints");
    // The agent is told which lines, not just which name.
    assert.ok(
      admitted.admission.constraints.some((entry) =>
        /src\/spaced\.js lines \d+-\d+/u.test(entry),
      ),
      admitted.admission.constraints.join(" | "),
    );

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
      rootPath: path.join(harness.root, "divided-workspace"),
      repository,
      baseVersion: split.canonicalVersion,
    });
    // Both edits in one file: one in `alpha`, which this task owns, and one
    // in `contended`, which it does not.
    await writeFile(
      path.join(workspace.path, "src", "spaced.js"),
      SPACED_SHAPES.replace("  return keepMe;\n", "  return keepMe * 10;\n")
        .replace("  return keepMe + 1;\n", "  return keepMe + 99;\n"),
      "utf8",
    );
    const changeSet = await workspaces.collectChangeSet(workspace, {
      symbolsChanged: ["alpha", "contended"],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "raised both constants",
    });
    await workspaces.destroy(workspace);

    const accepted = await acceptWorkResult(
      harness.store,
      {
        leaseId: split.lease.id,
        status: "completed",
        actorId: "user",
        plan: splitPlan,
        changeSet,
      },
      {
        repositories: harness.repositories,
        integrationRoot: path.join(harness.root, "integration"),
      },
    );
    assert.equal(accepted.accepted, true, accepted.reason);

    const version = await harness.repositories.getCanonicalVersion(repository);
    const landed = await harness.repositories.readFile(
      repository,
      version.revision,
      "src/spaced.js",
    );
    // The edit this task owned is in canonical; the one it did not is not.
    assert.match(landed, /return keepMe \* 10;/u);
    assert.match(landed, /return keepMe \+ 1;/u);
    assert.doesNotMatch(landed, /return keepMe \+ 99;/u);

    const collected = (
      await harness.store.listAuditEvents({ taskId: split.task.id })
    ).find((entry) => entry.event.type === "changeset_collected");
    assert.deepEqual(collected?.event.data["dividedPatches"], [
      {
        path: "src/spaced.js",
        grantedHunks: 1,
        deferredHunks: 1,
        symbols: ["contended"],
      },
    ]);

    // The file is still named in the follow-up: part of its work was dropped.
    const followUp = (
      await harness.store.listSubmittedTasks({ status: "submitted" })
    ).find((task) => task.objective.includes(DEFERRED_SCOPE_MARKER));
    assert.ok(followUp);
    assert.match(followUp.objective, /src\/spaced\.js/u);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});
