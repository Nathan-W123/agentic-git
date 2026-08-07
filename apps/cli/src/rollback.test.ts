import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
  InMemoryCoordinationStore,
  type CoordinationStore,
} from "@coord/persistence";
import { RepositoryService } from "@coord/repository-service";
import type { AgentPlan } from "@coord/shared-types";

import { CoordinatorProject } from "./project.js";
import { rollbackCanonical } from "./rollback.js";
import { leaseWork, admitWorkPlan } from "./worker-operations.js";

/**
 * Rollback is the one operation where the obvious implementation — a hard
 * reset — would quietly bypass every guarantee the platform makes. These tests
 * are about proving it does not: a rollback is planned, conflict-checked,
 * validated, and promoted by compare-and-swap like anything else.
 */

interface Harness {
  root: string;
  store: CoordinationStore;
  project: CoordinatorProject;
  repositories: RepositoryService;
  canonical: { id: string; path: string; branch: string };
  first: string;
  second: string;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "croll-"));
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
    "repo_rollback",
    "main",
  );
  const first = (await repositories.getCanonicalVersion(canonical)).revision;

  const store = new InMemoryCoordinationStore();
  await store.saveRepository({
    id: canonical.id,
    path: canonical.path,
    branch: canonical.branch,
  });

  // A second canonical revision, promoted the ordinary way.
  const { GitWorktreeWorkspaceManager } = await import(
    "@coord/workspace-manager"
  );
  const workspaces = new GitWorktreeWorkspaceManager(
    repositories.getGitClient(),
  );
  const workspace = await workspaces.create({
    taskId: "seed_second",
    rootPath: path.join(root, "seed-workspaces"),
    repository: canonical,
    baseVersion: await repositories.getCanonicalVersion(canonical),
  });
  await writeFile(
    path.join(workspace.path, "src", "value.js"),
    "export const value = 2;\n",
    "utf8",
  );
  await writeFile(
    path.join(workspace.path, "src", "added.js"),
    "export const added = true;\n",
    "utf8",
  );
  const candidate = await repositories.commitAll(workspace.path, "advance");
  assert.ok(candidate);
  assert.equal(
    await repositories.promote(canonical, candidate, first),
    true,
  );
  await workspaces.destroy(workspace);
  const second = (await repositories.getCanonicalVersion(canonical)).revision;

  return {
    root,
    store,
    project,
    repositories,
    canonical: {
      id: canonical.id,
      path: canonical.path,
      branch: canonical.branch,
    },
    first,
    second,
  };
}

/** Approves the first request to appear, so a gated call can complete. */
/**
 * How long to wait for a pipeline stage to reach its approval gate. Generous
 * on purpose: it bounds a hang, it is not a performance assertion.
 */
const APPROVAL_WAIT_MS = 60_000;

async function approveWhenAsked(
  store: CoordinationStore,
  decision: "approved" | "rejected" = "approved",
): Promise<string> {
  // Waits on a deadline rather than an attempt count. The rollback has to
  // plan, assess conflicts and build a changeset before it asks for approval,
  // and on a machine running the whole monorepo's suites at once that takes
  // far longer than it does alone — a fixed number of 10ms attempts turns a
  // busy CPU into a test failure.
  const deadline = Date.now() + APPROVAL_WAIT_MS;
  let approval = (await store.listApprovals({}))[0];
  while (approval === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    approval = (await store.listApprovals({}))[0];
  }
  assert.ok(
    approval,
    `a rollback must stop for a human (waited ${APPROVAL_WAIT_MS}ms)`,
  );
  await store.decideApproval({
    approvalId: approval.id,
    status: decision,
    decidedBy: "reviewer",
    comment: "reviewed",
    decidedAt: new Date().toISOString(),
  });
  return approval.id;
}

test("a rollback restores the earlier tree by moving canonical forward", async () => {
  const harness = await createHarness();
  try {
    const pending = rollbackCanonical(
      harness.project,
      harness.store,
      {
        repositoryId: "repo_rollback",
        targetRevision: harness.first,
        actorId: "user_admin",
        projectId: DEFAULT_PROJECT_ID,
        reason: "bad release",
      },
      { repositories: harness.repositories },
    );
    // A rollback discards accepted work, so it asks a human even on a project
    // with no policy at all — `requireRollbackReview` defaults to true and is
    // deliberately not governed by the (now opt-in) `enabled` switch.
    await approveWhenAsked(harness.store);
    const result = await pending;

    assert.equal(result.status, "integrated", result.explanation);
    assert.ok(result.runId);

    // The tree matches the target again.
    const version = await harness.repositories.getCanonicalVersion(
      harness.canonical,
    );
    assert.equal(
      await harness.repositories.readFile(
        harness.canonical,
        version.revision,
        "src/value.js",
      ),
      "export const value = 1;\n",
    );
    // The file added after the target is gone from the tree.
    assert.deepEqual(
      await harness.repositories.listFiles(
        harness.canonical,
        version.revision,
      ),
      ["src/value.js"],
    );

    // History moved forward rather than being rewritten: the reverted
    // revision is still reachable, which a hard reset would have discarded.
    const history = await harness.repositories.listCanonicalHistory(
      harness.canonical,
    );
    assert.equal(history.length, 3);
    assert.equal(history[0]?.revision, version.revision);
    assert.equal(history[1]?.revision, harness.second);
    assert.equal(history[2]?.revision, harness.first);
    assert.notEqual(version.revision, harness.first);
    assert.ok(version.sequence > 2);

    // And it went through the pipeline: a run, a plan, a changeset, an
    // integration, and a promotion event naming what was restored.
    const detail = await harness.store.getRun(result.runId);
    assert.equal(detail?.run.scenario, "canonical-rollback");
    assert.equal(detail?.changeSets.length, 1);
    assert.equal(detail?.integrations[0]?.status, "integrated");
    assert.equal(detail?.tasks[0]?.status, "integrated");
    assert.ok((detail?.tasks[0]?.plan?.expectedFiles.length ?? 0) > 0);
    const promoted = (await harness.store.listAudit()).find(
      (event) => event.type === "canonical_promoted",
    );
    assert.equal(promoted?.data["rolledBackTo"], harness.first);
    assert.equal((await harness.store.verifyAudit()).valid, true);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("rolling back to the current revision changes nothing", async () => {
  const harness = await createHarness();
  try {
    const result = await rollbackCanonical(
      harness.project,
      harness.store,
      {
        repositoryId: "repo_rollback",
        targetRevision: harness.second,
        actorId: "user_admin",
      },
      { repositories: harness.repositories },
    );
    assert.equal(result.status, "noop");
    assert.equal((await harness.store.listRuns()).length, 0);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a rollback is blocked by work already executing on the same files", async () => {
  const harness = await createHarness();
  try {
    // A remote worker holds an admitted plan on the file the rollback needs.
    const user = await harness.store.createUser({
      email: "fleet@example.com",
      displayName: "Fleet",
      passwordDigest: "digest",
    });
    const worker = await harness.store.registerWorker({
      userId: user.id,
      organizationId: DEFAULT_ORGANIZATION_ID,
      name: "worker-a",
      adapters: ["generic-cli"],
      version: "1.0.0",
    });
    const task = await harness.store.submitTask({
      repositoryId: "repo_rollback",
      objective: "raise the value",
      agentId: "generic-cli",
      validationCommands: [],
    });
    const assignment = await leaseWork(
      harness.store,
      { workerId: worker.id, projectId: DEFAULT_PROJECT_ID },
      harness.repositories,
    );
    assert.ok(assignment);
    const plan: AgentPlan = {
      taskId: task.id,
      objective: task.objective,
      expectedFiles: ["src/value.js"],
      expectedSymbols: ["value"],
      dependencies: [],
      commands: [],
      externalAccess: [],
      riskLevel: "low",
    };
    const admitted = await admitWorkPlan(
      harness.store,
      { leaseId: assignment.lease.id, actorId: "user", plan },
      { repositories: harness.repositories },
    );
    assert.equal(
      admitted.outcome === "admitted" ? admitted.admission.status : undefined,
      "approved",
    );

    const result = await rollbackCanonical(
      harness.project,
      harness.store,
      {
        repositoryId: "repo_rollback",
        targetRevision: harness.first,
        actorId: "user_admin",
        projectId: DEFAULT_PROJECT_ID,
      },
      { repositories: harness.repositories },
    );

    // Refused, not forced: the rollback would have overwritten a file an agent
    // is mid-edit on.
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.blockedBy, [task.id]);
    assert.equal((await harness.store.listRuns()).length, 0);

    // Canonical is untouched.
    const version = await harness.repositories.getCanonicalVersion(
      harness.canonical,
    );
    assert.equal(version.revision, harness.second);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a rejected rollback leaves canonical exactly where it was", async () => {
  const harness = await createHarness();
  try {
    const pending = rollbackCanonical(
      harness.project,
      harness.store,
      {
        repositoryId: "repo_rollback",
        targetRevision: harness.first,
        actorId: "user_admin",
        projectId: DEFAULT_PROJECT_ID,
      },
      { repositories: harness.repositories },
    );
    await approveWhenAsked(harness.store, "rejected");

    const result = await pending;
    assert.notEqual(result.status, "integrated");
    assert.match(result.explanation, /was not granted/u);

    // A rejected rollback leaves canonical exactly where it was.
    const version = await harness.repositories.getCanonicalVersion(
      harness.canonical,
    );
    assert.equal(version.revision, harness.second);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});
