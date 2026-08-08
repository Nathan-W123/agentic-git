import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import type {
  AgentPlan,
  CanonicalVersion,
  ChangeSet,
  ConflictAssessment,
  CoordinatorDecision,
  IntegrationResult,
  ResourceLease,
  TaskDefinition,
} from "@coord/shared-types";

import { InMemoryCoordinationStore } from "./memory-store.js";
import { PostgresCoordinationStore } from "./postgres-store.js";
import {
  createScratchDatabase,
  startPostgresTestServer,
} from "./postgres-test-support.js";
import { SqliteCoordinationStore } from "./sqlite-store.js";
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
  type CoordinationStore,
} from "./store.js";

/**
 * Behavior every store implementation must share.
 *
 * Running one suite against both backends keeps the in-memory default honest:
 * a divergence would otherwise only surface once persistence was switched on.
 */

const REPOSITORY = { id: "repo_1", path: "/canonical.git", branch: "main" };

const BASE_VERSION: CanonicalVersion = {
  sequence: 1,
  revision: "a".repeat(40),
  branch: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const FINAL_VERSION: CanonicalVersion = {
  sequence: 2,
  revision: "b".repeat(40),
  branch: "main",
  createdAt: "2026-01-01T00:05:00.000Z",
};

const TASK: TaskDefinition = {
  id: "task_cap_value",
  objective: "Cap the incremented value at ten",
  agentId: "scripted-generic-cli",
  validationCommands: [
    { executable: "node", args: ["--test"], label: "repository tests" },
  ],
};

const PLAN: AgentPlan = {
  taskId: TASK.id,
  objective: TASK.objective,
  expectedFiles: ["src/counter.js"],
  expectedSymbols: ["increment"],
  dependencies: [],
  commands: TASK.validationCommands,
  externalAccess: [],
  riskLevel: "low",
};

const DECISION: CoordinatorDecision = {
  decision: "queued",
  taskId: TASK.id,
  workspaceId: "workspace_1",
  ownershipGrants: [],
  constraints: ["Start from canonical state after blocking tasks integrate"],
  blockedBy: ["task_normalize_input"],
  explanation: "Queued behind task_normalize_input",
};

const CONFLICT: ConflictAssessment = {
  taskIds: ["task_normalize_input", TASK.id],
  score: 20,
  disposition: "concurrent",
  evidence: [
    {
      kind: "file_overlap",
      resources: ["src/counter.js"],
      taskIds: ["task_normalize_input", TASK.id],
      score: 20,
    },
  ],
  explanation: "1 planned file overlap(s): src/counter.js.",
};

const LEASE: ResourceLease = {
  leaseId: "lease_1",
  resourceType: "file",
  resourceId: "src/counter.js",
  principalId: TASK.agentId,
  taskId: TASK.id,
  mode: "exclusive",
  baseVersion: 1,
  expiresAt: "2026-01-01T00:05:00.000Z",
};

const CHANGESET: ChangeSet = {
  id: "changeset_1",
  taskId: TASK.id,
  baseVersion: 1,
  baseRevision: BASE_VERSION.revision,
  patches: [
    { path: "src/counter.js", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b\n" },
    { path: "test/cap.test.js", status: "added", patch: "@@ -0,0 +1 @@\n+x\n" },
  ],
  commandsRun: [],
  tests: [],
  dependenciesChanged: [],
  symbolsChanged: ["increment"],
  riskAssessment: { level: "low", reasons: ["file-level change only"] },
  agentExplanation: "capped the incremented value at ten",
  createdAt: "2026-01-01T00:02:00.000Z",
};

const INTEGRATION: IntegrationResult = {
  taskId: TASK.id,
  changeSetId: CHANGESET.id,
  status: "integrated",
  previousVersion: BASE_VERSION,
  canonicalVersion: FINAL_VERSION,
  validation: [],
  candidateRevision: "c".repeat(40),
  explanation: "Promoted cccccccccccc atomically",
};

async function populate(store: CoordinationStore): Promise<string> {
  const run = await store.createRun({
    repository: REPOSITORY,
    mode: "coordinated",
    scenario: "overlap",
    baseVersion: BASE_VERSION,
  });

  await store.saveTask(run.id, TASK);
  await store.appendAudit(run.id, {
    type: "task_submitted",
    taskId: TASK.id,
    data: { objective: TASK.objective },
  });
  await store.savePlan(run.id, TASK.id, PLAN);
  await store.saveSession(run.id, {
    id: "session_1",
    agentId: TASK.agentId,
    taskId: TASK.id,
    startedAt: "2026-01-01T00:01:00.000Z",
  });
  await store.saveDecision(run.id, DECISION);
  await store.saveConflicts(run.id, [CONFLICT]);
  await store.saveLeases(run.id, [LEASE]);
  await store.saveWorkspace(run.id, {
    id: "workspace_1",
    runId: run.id,
    taskId: TASK.id,
    path: "/workspaces/task_cap_value",
    isolation: "git-worktree",
    baseRevision: BASE_VERSION.revision,
    createdAt: "2026-01-01T00:01:30.000Z",
  });
  await store.saveChangeSet(run.id, CHANGESET);
  await store.appendAudit(run.id, {
    type: "changeset_collected",
    taskId: TASK.id,
    data: { changeSetId: CHANGESET.id },
  });
  await store.saveIntegration(run.id, INTEGRATION);
  await store.releaseLeases(run.id, TASK.id);
  await store.saveTaskStatus(run.id, TASK.id, "integrated", "Promoted");
  await store.finishRun(run.id, "completed", FINAL_VERSION);
  return run.id;
}

interface Backend {
  name: string;
  open: () => Promise<{ store: CoordinationStore; cleanup: () => Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: "in-memory",
    open: async () => ({
      store: new InMemoryCoordinationStore(),
      cleanup: async () => undefined,
    }),
  },
  {
    name: "sqlite",
    open: async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "coord-store-"));
      return {
        store: SqliteCoordinationStore.open(path.join(root, "coordination.db")),
        cleanup: async () => {
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  },
];

// The Postgres backend runs against a real server — a dockerized one that
// this suite manages, or whatever COORD_TEST_POSTGRES_URL points at. Each
// test gets its own scratch database, mirroring each SQLite test's fresh
// temporary file. The backend is skipped only when Docker itself is absent;
// once a server is reachable, any failure fails the suite.
const postgresServer =
  process.env["COORD_SKIP_POSTGRES_TESTS"] === "1"
    ? undefined
    : await startPostgresTestServer();
if (postgresServer === undefined) {
  console.warn(
    "postgres: contract tests skipped (Docker is unavailable and " +
      "COORD_TEST_POSTGRES_URL is not set)",
  );
} else {
  after(async () => {
    await postgresServer.stop();
  });
  backends.push({
    name: "postgres",
    open: async () => {
      const database = await createScratchDatabase(postgresServer.adminUrl);
      return {
        store: PostgresCoordinationStore.open(database.url),
        cleanup: async () => {
          await database.drop();
        },
      };
    },
  });
}

for (const backend of backends) {
  test(`${backend.name}: a completed run reads back in full`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const runId = await populate(store);
      const detail = await store.getRun(runId);
      assert.ok(detail !== undefined);

      assert.equal(detail.run.status, "completed");
      assert.equal(detail.run.scenario, "overlap");
      assert.equal(detail.run.baseRevision, BASE_VERSION.revision);
      assert.equal(detail.run.finalRevision, FINAL_VERSION.revision);

      assert.equal(detail.tasks.length, 1);
      assert.equal(detail.tasks[0]?.status, "integrated");
      assert.equal(detail.tasks[0]?.sessionId, "session_1");
      assert.equal(
        detail.tasks[0]?.sessionStartedAt,
        "2026-01-01T00:01:00.000Z",
      );
      assert.deepEqual(
        detail.tasks[0]?.validationCommands,
        TASK.validationCommands,
      );
      assert.deepEqual(detail.tasks[0]?.plan, PLAN);
      assert.deepEqual(detail.tasks[0]?.decision, DECISION);

      assert.deepEqual(detail.conflicts, [CONFLICT]);
      assert.deepEqual(detail.changeSets, [CHANGESET]);
      assert.deepEqual(detail.integrations, [INTEGRATION]);
      assert.equal(detail.leases.length, 1);
      assert.equal(detail.workspaces.length, 1);
      assert.equal(detail.audit.length, 2);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: repository ids cannot be remapped`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      await store.saveRepository(REPOSITORY);
      await assert.rejects(
        store.saveRepository({ ...REPOSITORY, path: "/other.git" }),
        /already mapped/u,
      );
      assert.deepEqual(await store.getRepository(REPOSITORY.id), REPOSITORY);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: history reads are detached snapshots`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const runId = await populate(store);
      const first = await store.getRun(runId);
      assert.ok(first !== undefined);
      first.run.status = "failed";
      first.tasks[0]?.plan?.expectedFiles.push("src/forged.js");
      if (first.changeSets[0]?.patches[0] !== undefined) {
        first.changeSets[0].patches[0].path = "src/forged.js";
      }
      first.audit[0]!.data = { forged: true };

      const second = await store.getRun(runId);
      assert.equal(second?.run.status, "completed");
      assert.deepEqual(second?.tasks[0]?.plan?.expectedFiles, [
        "src/counter.js",
      ]);
      assert.equal(
        second?.changeSets[0]?.patches[0]?.path,
        "src/counter.js",
      );
      assert.deepEqual(second?.audit[0]?.data, {
        objective: TASK.objective,
      });
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: file patches keep their order and content`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const runId = await populate(store);
      const detail = await store.getRun(runId);
      const patches = detail?.changeSets[0]?.patches ?? [];
      assert.deepEqual(
        patches.map((patch) => patch.path),
        ["src/counter.js", "test/cap.test.js"],
      );
      assert.equal(patches[1]?.status, "added");
      assert.equal(patches[0]?.patch, CHANGESET.patches[0]?.patch);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: saving a changeset twice is idempotent`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const runId = await populate(store);
      await store.saveChangeSet(runId, CHANGESET);
      const detail = await store.getRun(runId);
      assert.equal(detail?.changeSets.length, 1);
      assert.equal(detail?.changeSets[0]?.patches.length, 2);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: integration cleanup warnings survive history reads`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const runId = await populate(store);
      await store.saveIntegration(runId, {
        ...INTEGRATION,
        cleanupWarnings: ["workspace cleanup failed"],
        explanation:
          `${INTEGRATION.explanation}; workspace cleanup failed`,
      });
      const detail = await store.getRun(runId);
      assert.deepEqual(
        detail?.integrations.at(-1)?.cleanupWarnings,
        ["workspace cleanup failed"],
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: claimed and failed tasks can be explicitly retried`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      const submitted = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: TASK.objective,
        agentId: TASK.agentId,
        validationCommands: TASK.validationCommands,
      });
      assert.equal(submitted.claimedAt, undefined);
      assert.equal(submitted.completedAt, undefined);

      const firstClaim = await store.claimSubmittedTasks(REPOSITORY.id);
      assert.equal(firstClaim[0]?.status, "claimed");
      assert.ok(firstClaim[0]?.claimedAt !== undefined);

      const retriedClaim = await store.retrySubmittedTask(submitted.id);
      assert.equal(retriedClaim.status, "submitted");
      assert.equal(retriedClaim.claimedAt, undefined);

      await store.claimSubmittedTasks(REPOSITORY.id);
      await store.completeSubmittedTask(submitted.id, "failed");
      const failed = (
        await store.listSubmittedTasks({ status: "failed" })
      )[0];
      assert.ok(failed?.completedAt !== undefined);

      await store.retrySubmittedTask(submitted.id);
      await store.claimSubmittedTasks(REPOSITORY.id);
      await store.completeSubmittedTask(submitted.id, "integrated");
      await assert.rejects(store.retrySubmittedTask(submitted.id), /integrated/u);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: concurrent claims never return the same task twice`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: TASK.objective,
        agentId: TASK.agentId,
        validationCommands: [],
      });
      const claims = await Promise.all([
        store.claimSubmittedTasks(REPOSITORY.id),
        store.claimSubmittedTasks(REPOSITORY.id),
      ]);
      assert.equal(claims[0]!.length + claims[1]!.length, 1);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: project-scoped claims cannot consume another queue`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      assert.equal(
        await store.projectHasRepository(DEFAULT_PROJECT_ID, REPOSITORY.id),
        false,
      );
      await store.linkRepository(DEFAULT_PROJECT_ID, REPOSITORY.id);
      const secondProject = await store.createProject({
        organizationId: DEFAULT_ORGANIZATION_ID,
        slug: "second-project",
        name: "Second project",
      });
      await store.linkRepository(secondProject.id, REPOSITORY.id);
      const localTask = await store.submitTask({
        projectId: DEFAULT_PROJECT_ID,
        repositoryId: REPOSITORY.id,
        objective: "Local project task",
        agentId: TASK.agentId,
        validationCommands: [],
      });
      const secondTask = await store.submitTask({
        projectId: secondProject.id,
        repositoryId: REPOSITORY.id,
        objective: "Second project task",
        agentId: TASK.agentId,
        validationCommands: [],
      });

      const claimed = await store.claimSubmittedTasks(
        REPOSITORY.id,
        secondProject.id,
      );
      assert.deepEqual(claimed.map((task) => task.id), [secondTask.id]);
      assert.equal(
        (await store.listSubmittedTasks()).find(
          (task) => task.id === localTask.id,
        )?.status,
        "submitted",
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  /**
   * The tenant filter has to hold in the query, not in the caller.
   *
   * Every backend answers `listWorkers` differently — an in-memory scan, a
   * SQLite prepared statement, a Postgres parameterised query — so this is
   * exactly the kind of rule that can hold in the default store and quietly
   * fail in the one a real deployment runs. Asserting it here is what makes
   * the gateway's authorization check meaningful: the check decides which
   * organization may be named, and this decides that naming it actually
   * bounds the rows.
   */
  test(`${backend.name}: workers list only within their organization`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const alpha = await store.createOrganization({
        slug: "alpha",
        name: "Alpha",
      });
      const beta = await store.createOrganization({
        slug: "beta",
        name: "Beta",
      });
      const alphaUser = await store.createUser({
        email: "alpha@example.com",
        displayName: "Alpha",
        passwordDigest: "digest",
      });
      // One user in both organizations, so the filter cannot pass by
      // accidentally keying on the owner instead of the tenant.
      const betaUser = alphaUser;

      const alphaWorker = await store.registerWorker({
        userId: alphaUser.id,
        organizationId: alpha.id,
        name: "alpha-worker",
        adapters: ["codex"],
        version: "1",
      });
      const betaWorker = await store.registerWorker({
        userId: betaUser.id,
        organizationId: beta.id,
        name: "beta-worker",
        adapters: ["codex"],
        version: "1",
      });

      assert.deepEqual(
        (await store.listWorkers({ organizationId: alpha.id })).map(
          (worker) => worker.id,
        ),
        [alphaWorker.id],
      );
      assert.deepEqual(
        (await store.listWorkers({ organizationId: beta.id })).map(
          (worker) => worker.id,
        ),
        [betaWorker.id],
      );
      assert.equal(
        (await store.listWorkers({ organizationId: alpha.id }))[0]
          ?.organizationId,
        alpha.id,
      );

      // An organization with no workers gets an empty list, not everything.
      const empty = await store.createOrganization({
        slug: "gamma",
        name: "Gamma",
      });
      assert.deepEqual(await store.listWorkers({ organizationId: empty.id }), []);

      // An unknown organization must not be treated as "no filter".
      assert.deepEqual(
        await store.listWorkers({ organizationId: "org_does_not_exist" }),
        [],
      );

      // The unfiltered call is the administrative one and still sees both, so
      // the filter is doing the narrowing rather than the data being absent.
      const all = (await store.listWorkers()).map((worker) => worker.id);
      assert.equal(all.includes(alphaWorker.id), true);
      assert.equal(all.includes(betaWorker.id), true);

      // A worker cannot be registered into an organization that does not
      // exist, which is what keeps the column from holding an unresolvable id.
      await assert.rejects(
        store.registerWorker({
          userId: alphaUser.id,
          organizationId: "org_does_not_exist",
          name: "nowhere",
          adapters: [],
          version: "1",
        }),
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: a task leases to exactly one worker`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const user = await store.createUser({
        email: "fleet@example.com",
        displayName: "Fleet",
        passwordDigest: "digest",
      });
      const first = await store.registerWorker({
        userId: user.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "worker-a",
        adapters: ["codex"],
        version: "1",
      });
      const second = await store.registerWorker({
        userId: user.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "worker-b",
        adapters: ["generic-cli"],
        version: "1",
      });
      await store.saveRepository(REPOSITORY);
      const task = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "cap the value",
        agentId: "codex",
        validationCommands: [],
      });

      const leased = await store.leaseNextTask({
        workerId: first.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 60_000,
      });
      assert.equal(leased?.task.id, task.id);
      assert.equal(leased?.lease.status, "active");
      assert.equal(leased?.lease.workerId, first.id);
      assert.equal(leased?.lease.baseRevision, BASE_VERSION.revision);

      // The task is no longer pending, so a second worker gets nothing.
      const contested = await store.leaseNextTask({
        workerId: second.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 60_000,
      });
      assert.equal(contested, undefined);
      assert.equal(
        (await store.listSubmittedTasks({ status: "submitted" })).length,
        0,
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: an expired lease returns its task to the queue`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const user = await store.createUser({
        email: "fleet2@example.com",
        displayName: "Fleet",
        passwordDigest: "digest",
      });
      const worker = await store.registerWorker({
        userId: user.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "worker",
        adapters: [],
        version: "1",
      });
      await store.saveRepository(REPOSITORY);
      const task = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "objective",
        agentId: "codex",
        validationCommands: [],
      });

      // A worker that dies stops heartbeating; the lease must lapse rather
      // than strand the task forever.
      const leased = await store.leaseNextTask({
        workerId: worker.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 1,
      });
      assert.notEqual(leased, undefined);

      const expired = await store.expireWorkLeases(
        new Date(Date.now() + 60_000).toISOString(),
      );
      assert.equal(expired.length, 1);
      assert.equal(
        (await store.getWorkLease(leased?.lease.id ?? ""))?.status,
        "expired",
      );

      const requeued = await store.listSubmittedTasks({ status: "submitted" });
      assert.deepEqual(
        requeued.map((entry) => entry.id),
        [task.id],
      );

      // And it can be picked up again by another worker.
      const relet = await store.leaseNextTask({
        workerId: worker.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 60_000,
      });
      assert.equal(relet?.task.id, task.id);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: heartbeats extend a lease and settle it on completion`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const user = await store.createUser({
        email: "fleet3@example.com",
        displayName: "Fleet",
        passwordDigest: "digest",
      });
      const worker = await store.registerWorker({
        userId: user.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "worker",
        adapters: [],
        version: "1",
      });
      await store.saveRepository(REPOSITORY);
      await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "objective",
        agentId: "codex",
        validationCommands: [],
      });
      const leased = await store.leaseNextTask({
        workerId: worker.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 1_000,
      });
      const leaseId = leased?.lease.id ?? "";

      const extended = await store.heartbeatWorkLease(
        leaseId,
        "2026-01-01T00:00:00.000Z",
        "2099-01-01T00:00:00.000Z",
      );
      assert.equal(extended?.expiresAt, "2099-01-01T00:00:00.000Z");
      // Now far in the future, so a sweep must leave it alone.
      assert.deepEqual(await store.expireWorkLeases(new Date().toISOString()), []);

      await store.finishWorkLease(
        leaseId,
        "completed",
        "2026-01-02T00:00:00.000Z",
        "changeset accepted",
      );
      const settled = await store.getWorkLease(leaseId);
      assert.equal(settled?.status, "completed");
      assert.equal(settled?.detail, "changeset accepted");

      // A settled task is not requeued, and a late heartbeat is refused.
      assert.equal(
        (await store.listSubmittedTasks({ status: "submitted" })).length,
        0,
      );
      assert.equal(
        await store.heartbeatWorkLease(leaseId, "x", "2099-01-01T00:00:00.000Z"),
        undefined,
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: releasing a lease requeues the task for another worker`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const user = await store.createUser({
        email: "fleet4@example.com",
        displayName: "Fleet",
        passwordDigest: "digest",
      });
      const worker = await store.registerWorker({
        userId: user.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "worker",
        adapters: [],
        version: "1",
      });
      await store.saveRepository(REPOSITORY);
      const task = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "objective",
        agentId: "codex",
        validationCommands: [],
      });
      const leased = await store.leaseNextTask({
        workerId: worker.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 60_000,
      });

      await store.finishWorkLease(
        leased?.lease.id ?? "",
        "released",
        new Date().toISOString(),
        "worker shutting down",
      );
      assert.deepEqual(
        (await store.listSubmittedTasks({ status: "submitted" })).map(
          (entry) => entry.id,
        ),
        [task.id],
      );
      assert.deepEqual(
        (await store.listWorkLeases({ workerId: worker.id, status: "released" }))
          .length,
        1,
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: api tokens round-trip, revoke, and expire`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const user = await store.createUser({
        email: "worker@example.com",
        displayName: "Worker",
        passwordDigest: "test-digest",
      });

      await store.createApiToken({
        id: "tok_live",
        userId: user.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "worker",
        secretHash: "hash-live",
        scopes: ["view", "run_task"],
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBySession: "auth_1",
        expiresAt: "2026-06-01T00:00:00.000Z",
        lastUsedAt: undefined,
        lastUsedIp: undefined,
        revokedAt: undefined,
        revokedReason: undefined,
      });
      await store.createApiToken({
        id: "tok_stale",
        userId: user.id,
        organizationId: undefined,
        name: "expired",
        secretHash: "hash-stale",
        scopes: ["view"],
        createdAt: "2025-01-01T00:00:00.000Z",
        createdBySession: undefined,
        expiresAt: "2025-02-01T00:00:00.000Z",
        lastUsedAt: undefined,
        lastUsedIp: undefined,
        revokedAt: undefined,
        revokedReason: undefined,
      });

      const live = await store.getApiToken("tok_live");
      assert.equal(live?.name, "worker");
      assert.deepEqual(live?.scopes, ["view", "run_task"]);
      assert.equal(live?.organizationId, DEFAULT_ORGANIZATION_ID);
      assert.equal(live?.createdBySession, "auth_1");
      // The secret digest is all that is kept; there is no plaintext column.
      assert.equal(live?.secretHash, "hash-live");

      // Newest first, and both belong to the same user.
      assert.deepEqual(
        (await store.listApiTokens(user.id)).map((token) => token.id),
        ["tok_live", "tok_stale"],
      );

      await store.touchApiToken("tok_live", "2026-02-02T00:00:00.000Z", "10.0.0.9");
      const touched = await store.getApiToken("tok_live");
      assert.equal(touched?.lastUsedAt, "2026-02-02T00:00:00.000Z");
      assert.equal(touched?.lastUsedIp, "10.0.0.9");

      await store.revokeApiToken("tok_live", "2026-03-03T00:00:00.000Z", "compromised");
      const revoked = await store.getApiToken("tok_live");
      assert.equal(revoked?.revokedAt, "2026-03-03T00:00:00.000Z");
      assert.equal(revoked?.revokedReason, "compromised");

      // Revocation is final: a second call must not rewrite when or why.
      await store.revokeApiToken("tok_live", "2026-04-04T00:00:00.000Z", "again");
      assert.equal(
        (await store.getApiToken("tok_live"))?.revokedAt,
        "2026-03-03T00:00:00.000Z",
      );

      // Only the token whose expiry has passed is swept.
      assert.equal(await store.deleteExpiredApiTokens("2026-01-15T00:00:00.000Z"), 1);
      assert.equal(await store.getApiToken("tok_stale"), undefined);
      assert.notEqual(await store.getApiToken("tok_live"), undefined);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: tenant membership and auth sessions round-trip`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const user = await store.createUser({
        email: "Developer@Example.com",
        displayName: "Developer",
        passwordDigest: "test-digest",
      });
      await store.saveMembership({
        organizationId: DEFAULT_ORGANIZATION_ID,
        userId: user.id,
        role: "developer",
      });
      assert.deepEqual(
        (await store.listOrganizations(user.id)).map(
          (organization) => organization.id,
        ),
        [DEFAULT_ORGANIZATION_ID],
      );
      assert.equal(
        (
          await store.getMembership(DEFAULT_ORGANIZATION_ID, user.id)
        )?.role,
        "developer",
      );

      await store.createAuthSession({
        id: "auth_contract",
        userId: user.id,
        secretHash: "secret-hash",
        csrfHash: "csrf-hash",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T02:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        ipAddress: "127.0.0.1",
        userAgent: "contract-test",
      });
      await store.touchAuthSession(
        "auth_contract",
        "2026-01-01T00:01:00.000Z",
      );
      assert.equal(
        (await store.getAuthSession("auth_contract"))?.lastSeenAt,
        "2026-01-01T00:01:00.000Z",
      );
      await store.revokeUserSessions(user.id);
      assert.equal(await store.getAuthSession("auth_contract"), undefined);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: plan revisions and scope decisions remain ordered`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const runId = await populate(store);
      await store.savePlanRevision(runId, TASK.id, {
        revision: 1,
        reason: "initial",
        canonicalRevision: BASE_VERSION.revision,
        plan: PLAN,
      });
      const revisedPlan: AgentPlan = {
        ...PLAN,
        expectedFiles: [...PLAN.expectedFiles, "src/extra.js"],
      };
      await store.savePlanRevision(runId, TASK.id, {
        revision: 2,
        reason: "scope_change",
        canonicalRevision: BASE_VERSION.revision,
        plan: revisedPlan,
      });
      const request = {
        id: "scope_contract",
        taskId: TASK.id,
        additionalFiles: ["src/extra.js"],
        additionalSymbols: [],
        additionalApis: [],
        additionalSchemas: [],
        additionalConfigKeys: [],
        additionalTests: [],
        additionalServices: [],
        reason: "Implementation needs a helper",
        occurredAt: "2026-01-01T00:02:00.000Z",
      };
      await store.saveScopeChange(runId, request);
      await store.saveScopeChangeDecision(runId, {
        requestId: request.id,
        taskId: TASK.id,
        decision: "approved",
        revisedPlan,
        constraints: [],
        ownershipGrants: [],
        explanation: "Conflict-free",
        decidedAt: "2026-01-01T00:02:01.000Z",
      });

      const detail = await store.getRun(runId);
      assert.deepEqual(
        detail?.planRevisions.map((revision) => revision.revision),
        [1, 2],
      );
      assert.equal(detail?.scopeChanges[0]?.decision?.decision, "approved");
      assert.deepEqual(
        await store.listPlanRevisions(runId, TASK.id),
        detail?.planRevisions,
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: approval decisions are final and pending gates expire`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const runId = await populate(store);
      const approval = await store.createApproval({
        organizationId: DEFAULT_ORGANIZATION_ID,
        projectId: DEFAULT_PROJECT_ID,
        repositoryId: REPOSITORY.id,
        runId,
        taskId: TASK.id,
        kind: "changeset",
        requestedBy: TASK.agentId,
        requiredRole: "reviewer",
        reasons: ["Protected changeset"],
        changeSetId: CHANGESET.id,
        expiresAt: "2026-01-01T01:00:00.000Z",
      });
      const decided = await store.decideApproval({
        approvalId: approval.id,
        status: "approved",
        decidedBy: "reviewer_contract",
        comment: "Reviewed",
        decidedAt: "2026-01-01T00:10:00.000Z",
      });
      assert.equal(decided.status, "approved");
      await assert.rejects(
        store.decideApproval({
          approvalId: approval.id,
          status: "rejected",
          decidedBy: "reviewer_contract",
          comment: "Changed mind",
          decidedAt: "2026-01-01T00:11:00.000Z",
        }),
        /approved/u,
      );

      const expiring = await store.createApproval({
        organizationId: DEFAULT_ORGANIZATION_ID,
        projectId: DEFAULT_PROJECT_ID,
        repositoryId: REPOSITORY.id,
        runId,
        taskId: TASK.id,
        kind: "policy_override",
        requestedBy: TASK.agentId,
        requiredRole: "admin",
        reasons: ["Risk policy"],
        expiresAt: "2026-01-01T00:20:00.000Z",
      });
      assert.equal(
        await store.expireApprovals("2026-01-01T00:21:00.000Z"),
        1,
      );
      assert.equal((await store.getApproval(expiring.id))?.status, "expired");
      assert.equal((await store.getRun(runId))?.approvals.length, 2);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: the audit chain verifies after a run`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await populate(store);
      const verification = await store.verifyAudit();
      assert.equal(verification.valid, true);
      assert.equal(verification.events, 2);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: audit events are scoped to their run`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const first = await populate(store);
      const second = await populate(store);
      assert.notEqual(first, second);

      assert.equal((await store.listAudit(first)).length, 2);
      assert.equal((await store.listAudit(second)).length, 2);
      assert.equal((await store.listAudit()).length, 4);
      assert.equal((await store.verifyAudit()).valid, true);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: expiring a lease reports it as expired, not as still active`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const owner = await store.createUser({
        email: "lease-owner@example.invalid",
        displayName: "Lease Owner",
        passwordDigest: "unused",
      });
      const worker = await store.registerWorker({
        userId: owner.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "worker",
        adapters: ["codex"],
        version: "0.1.0",
      });
      await store.saveRepository(REPOSITORY);
      await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "queued objective",
        agentId: "codex",
        validationCommands: TASK.validationCommands,
      });

      const work = await store.leaseNextTask({
        workerId: worker.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 1,
      });
      assert.ok(work !== undefined);

      const afterExpiry = new Date(Date.now() + 60_000).toISOString();
      const originalExpiry = work.lease.expiresAt;
      assert.equal(
        await store.heartbeatWorkLease(
          work.lease.id,
          afterExpiry,
          new Date(Date.now() + 120_000).toISOString(),
        ),
        undefined,
      );
      assert.equal(
        (await store.getWorkLease(work.lease.id))?.expiresAt,
        originalExpiry,
      );
      assert.equal(
        await store.finishWorkLease(
          work.lease.id,
          "completed",
          afterExpiry,
          "late result",
        ),
        false,
      );
      const expired = await store.expireWorkLeases(afterExpiry);
      assert.equal(expired.length, 1);

      // The returned record must describe the lease after expiry. One backend
      // returned the row as it was before the update, so callers reporting
      // reclaimed work described it as still running.
      assert.equal(expired[0]?.status, "expired");
      assert.equal(expired[0]?.outcome, "expired");
      assert.ok(expired[0]?.finishedAt !== undefined);
      assert.deepEqual(await store.listWorkLeases({ status: "active" }), []);

      // And the task itself is queued again rather than stranded as claimed.
      const pending = await store.listSubmittedTasks({ status: "submitted" });
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.id, work.task.id);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: only one remote lease per repository is active`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const owner = await store.createUser({
        email: "serialized-worker@example.invalid",
        displayName: "Serialized Worker",
        passwordDigest: "unused",
      });
      const firstWorker = await store.registerWorker({
        userId: owner.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "worker-a",
        adapters: ["codex"],
        version: "0.1.0",
      });
      const secondWorker = await store.registerWorker({
        userId: owner.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "worker-b",
        adapters: ["codex"],
        version: "0.1.0",
      });
      await store.saveRepository(REPOSITORY);
      for (const objective of ["first", "second"]) {
        await store.submitTask({
          repositoryId: REPOSITORY.id,
          objective,
          agentId: "codex",
          validationCommands: [],
        });
      }

      const first = await store.leaseNextTask({
        workerId: firstWorker.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 60_000,
      });
      assert.ok(first !== undefined);
      assert.equal(
        await store.leaseNextTask({
          workerId: secondWorker.id,
          baseRevision: BASE_VERSION.revision,
          ttlMs: 60_000,
        }),
        undefined,
      );

      assert.equal(
        await store.finishWorkLease(
          first.lease.id,
          "released",
          new Date().toISOString(),
          "test release",
        ),
        true,
      );
      assert.ok(
        (await store.leaseNextTask({
          workerId: secondWorker.id,
          baseRevision: BASE_VERSION.revision,
          ttlMs: 60_000,
        })) !== undefined,
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: project policy round-trips, survives edits, and clears`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const project = await store.createProject({
        organizationId: DEFAULT_ORGANIZATION_ID,
        slug: "policied",
        name: "Policied",
      });
      assert.equal(project.policy, undefined);

      const policy = {
        version: 1,
        approvals: {
          requireChangesetReview: true,
          protectedPaths: ["secrets/**"],
        },
      };
      const updated = await store.updateProject(project.id, { policy });
      assert.deepEqual(updated.policy, policy);
      assert.deepEqual((await store.getProject(project.id))?.policy, policy);

      // Unrelated edits leave the policy alone; null removes it.
      const renamed = await store.updateProject(project.id, {
        name: "Renamed",
      });
      assert.deepEqual(renamed.policy, policy);
      const cleared = await store.updateProject(project.id, { policy: null });
      assert.equal(cleared.policy, undefined);
      assert.equal((await store.getProject(project.id))?.policy, undefined);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: repository parallelism admits concurrent leases without double-assignment`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const owner = await store.createUser({
        email: "parallel-fleet@example.invalid",
        displayName: "Parallel Fleet",
        passwordDigest: "unused",
      });
      const firstWorker = await store.registerWorker({
        userId: owner.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "worker-a",
        adapters: ["codex"],
        version: "0.1.0",
      });
      const secondWorker = await store.registerWorker({
        userId: owner.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "worker-b",
        adapters: ["codex"],
        version: "0.1.0",
      });
      await store.saveRepository(REPOSITORY);
      for (const objective of ["first", "second", "third"]) {
        await store.submitTask({
          repositoryId: REPOSITORY.id,
          objective,
          agentId: "codex",
          validationCommands: [],
        });
      }

      await assert.rejects(
        store.leaseNextTask({
          workerId: firstWorker.id,
          baseRevision: BASE_VERSION.revision,
          ttlMs: 60_000,
          repositoryParallelism: 0,
        }),
        RangeError,
      );

      // Two workers hold two distinct tasks in one repository at once.
      const first = await store.leaseNextTask({
        workerId: firstWorker.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 60_000,
        repositoryParallelism: 2,
      });
      const second = await store.leaseNextTask({
        workerId: secondWorker.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 60_000,
        repositoryParallelism: 2,
      });
      assert.ok(first !== undefined);
      assert.ok(second !== undefined);
      assert.notEqual(first.task.id, second.task.id);

      // The cap is enforced: a third lease is refused until one settles.
      assert.equal(
        await store.leaseNextTask({
          workerId: firstWorker.id,
          baseRevision: BASE_VERSION.revision,
          ttlMs: 60_000,
          repositoryParallelism: 2,
        }),
        undefined,
      );
      assert.equal(
        await store.finishWorkLease(
          first.lease.id,
          "completed",
          new Date().toISOString(),
          "done",
        ),
        true,
      );
      const third = await store.leaseNextTask({
        workerId: firstWorker.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 60_000,
        repositoryParallelism: 2,
      });
      assert.ok(third !== undefined);
      assert.notEqual(third.task.id, second.task.id);

      // Task-level exclusivity never relaxes: every active lease holds a
      // distinct task.
      const active = await store.listWorkLeases({ status: "active" });
      assert.equal(
        new Set(active.map((lease) => lease.taskId)).size,
        active.length,
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: work leases filter by project and issue time`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const owner = await store.createUser({
        email: "lease-filter@example.invalid",
        displayName: "Lease Filter",
        passwordDigest: "unused",
      });
      const worker = await store.registerWorker({
        userId: owner.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "worker",
        adapters: ["codex"],
        version: "0.1.0",
      });
      const secondProject = await store.createProject({
        organizationId: DEFAULT_ORGANIZATION_ID,
        slug: "lease-filter",
        name: "Lease Filter",
      });
      await store.saveRepository(REPOSITORY);
      const otherRepository = {
        id: "repo_filter_2",
        path: "/canonical-2.git",
        branch: "main",
      };
      await store.saveRepository(otherRepository);
      await store.submitTask({
        repositoryId: REPOSITORY.id,
        projectId: DEFAULT_PROJECT_ID,
        objective: "default project task",
        agentId: "codex",
        validationCommands: [],
      });
      await store.submitTask({
        repositoryId: otherRepository.id,
        projectId: secondProject.id,
        objective: "second project task",
        agentId: "codex",
        validationCommands: [],
      });

      const first = await store.leaseNextTask({
        workerId: worker.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 60_000,
        projectId: DEFAULT_PROJECT_ID,
      });
      const second = await store.leaseNextTask({
        workerId: worker.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 60_000,
        projectId: secondProject.id,
      });
      assert.ok(first !== undefined && second !== undefined);

      assert.deepEqual(
        (await store.listWorkLeases({ projectId: DEFAULT_PROJECT_ID })).map(
          (lease) => lease.id,
        ),
        [first.lease.id],
      );
      assert.deepEqual(
        (await store.listWorkLeases({ projectId: secondProject.id })).map(
          (lease) => lease.id,
        ),
        [second.lease.id],
      );
      assert.equal(
        (
          await store.listWorkLeases({
            issuedAfter: "1970-01-01T00:00:00.000Z",
          })
        ).length,
        2,
      );
      assert.deepEqual(
        await store.listWorkLeases({
          issuedAfter: "2999-01-01T00:00:00.000Z",
        }),
        [],
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: lease plans are recorded and serialized against each other`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const owner = await store.createUser({
        email: "plan-fleet@example.invalid",
        displayName: "Plan Fleet",
        passwordDigest: "unused",
      });
      const firstWorker = await store.registerWorker({
        userId: owner.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "worker-a",
        adapters: ["codex"],
        version: "0.1.0",
      });
      const secondWorker = await store.registerWorker({
        userId: owner.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "worker-b",
        adapters: ["codex"],
        version: "0.1.0",
      });
      await store.saveRepository(REPOSITORY);
      for (const objective of ["first", "second"]) {
        await store.submitTask({
          repositoryId: REPOSITORY.id,
          objective,
          agentId: "codex",
          validationCommands: [],
        });
      }
      const first = await store.leaseNextTask({
        workerId: firstWorker.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 60_000,
        repositoryParallelism: 2,
      });
      const second = await store.leaseNextTask({
        workerId: secondWorker.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 60_000,
        repositoryParallelism: 2,
      });
      assert.ok(first !== undefined && second !== undefined);

      const submissionFor = (taskId: string, status: "approved" | "sequenced") => ({
        plan: { ...PLAN, taskId },
        admission: {
          status,
          taskId,
          planRevision: 1,
          baseRevision: BASE_VERSION.revision,
          ownershipGrants: [],
          constraints: [],
          blockedBy: [],
          conflicts: [],
          explanation: "contract test",
          decidedAt: "2026-01-01T00:00:00.000Z",
        },
      });

      // Nothing admitted yet, so an empty observed set is the accurate view.
      const savedFirst = await store.saveWorkLeasePlan({
        leaseId: first.lease.id,
        submission: submissionFor(first.task.id, "approved"),
        observedApprovedLeaseIds: [],
      });
      assert.equal(savedFirst.outcome, "saved");
      assert.equal(
        (await store.getWorkLease(first.lease.id))?.plan?.admission.status,
        "approved",
      );

      // The second worker decided from the same empty view. Its write is
      // refused, because by now the first plan is executing — this is what
      // stops two conflicting plans from both being approved.
      const stale = await store.saveWorkLeasePlan({
        leaseId: second.lease.id,
        submission: submissionFor(second.task.id, "approved"),
        observedApprovedLeaseIds: [],
      });
      assert.equal(stale.outcome, "stale");
      assert.deepEqual(
        stale.outcome === "stale" ? stale.approvedLeaseIds : [],
        [first.lease.id],
      );
      assert.equal((await store.getWorkLease(second.lease.id))?.plan, undefined);

      // Deciding again against the true view succeeds.
      const retried = await store.saveWorkLeasePlan({
        leaseId: second.lease.id,
        submission: submissionFor(second.task.id, "sequenced"),
        observedApprovedLeaseIds: [first.lease.id],
      });
      assert.equal(retried.outcome, "saved");

      // A sequenced plan is not executing work, so it does not count towards
      // the observed set the next admission has to match.
      const resubmitted = await store.saveWorkLeasePlan({
        leaseId: second.lease.id,
        submission: submissionFor(second.task.id, "approved"),
        observedApprovedLeaseIds: [first.lease.id],
      });
      assert.equal(resubmitted.outcome, "saved");

      // Once approved, the plan is the worker's execution contract. A retry
      // may observe it, but can never replace it with a wider plan.
      const wider = submissionFor(second.task.id, "approved");
      wider.plan.expectedFiles = ["src/value.ts", "src/secret.ts"];
      const immutable = await store.saveWorkLeasePlan({
        leaseId: second.lease.id,
        submission: wider,
        observedApprovedLeaseIds: [first.lease.id],
      });
      assert.equal(immutable.outcome, "already_admitted");
      assert.deepEqual(
        (await store.getWorkLease(second.lease.id))?.plan?.plan.expectedFiles,
        PLAN.expectedFiles,
      );

      // Repository scoping: a lease elsewhere never enters the view.
      assert.deepEqual(
        (
          await store.listWorkLeases({
            status: "active",
            repositoryId: REPOSITORY.id,
          })
        )
          .map((lease) => lease.id)
          .sort(),
        [first.lease.id, second.lease.id].sort(),
      );
      assert.deepEqual(
        await store.listWorkLeases({ repositoryId: "repo_absent" }),
        [],
      );

      // A settled lease cannot record a plan.
      assert.equal(
        await store.finishWorkLease(
          first.lease.id,
          "completed",
          new Date().toISOString(),
          "done",
        ),
        true,
      );
      const lost = await store.saveWorkLeasePlan({
        leaseId: first.lease.id,
        submission: submissionFor(first.task.id, "approved"),
        observedApprovedLeaseIds: [],
      });
      assert.equal(lost.outcome, "lease_lost");
      assert.equal(
        (
          await store.saveWorkLeasePlan({
            leaseId: "lease_missing",
            submission: submissionFor("task_missing", "approved"),
            observedApprovedLeaseIds: [],
          })
        ).outcome,
        "lease_lost",
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: worker and task references are validated consistently`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await assert.rejects(
        store.registerWorker({
          userId: "user_missing",
          organizationId: DEFAULT_ORGANIZATION_ID,
          name: "worker",
          adapters: [],
          version: "1",
        }),
        /user|foreign key/iu,
      );
      await assert.rejects(
        store.submitTask({
          repositoryId: "repo_missing",
          objective: "objective",
          agentId: "codex",
          validationCommands: [],
        }),
        /repository|foreign key/iu,
      );

      await store.saveRepository(REPOSITORY);
      await assert.rejects(
        store.submitTask({
          projectId: "project_missing",
          repositoryId: REPOSITORY.id,
          objective: "objective",
          agentId: "codex",
          validationCommands: [],
        }),
        /project|foreign key/iu,
      );
      await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "objective",
        agentId: "codex",
        validationCommands: [],
      });
      await assert.rejects(
        store.leaseNextTask({
          workerId: "worker_missing",
          baseRevision: BASE_VERSION.revision,
          ttlMs: 60_000,
        }),
        /worker|foreign key/iu,
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: changeset comments thread, resolve, and read back with the run`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const runId = await populate(store);
      const author = await store.createUser({
        email: "reviewer@example.invalid",
        displayName: "Reviewer",
        passwordDigest: "unused",
      });
      const detail = await store.getRun(runId);
      const changeSet = detail?.changeSets[0];
      assert.ok(changeSet);
      const filePath = changeSet.patches[0]?.path;
      assert.ok(filePath);

      const general = await store.addChangesetComment({
        runId,
        changeSetId: changeSet.id,
        taskId: changeSet.taskId,
        authorId: author.id,
        body: "  Overall this looks right.  ",
      });
      // Bodies are trimmed, and an empty one is not a comment at all.
      assert.equal(general.body, "Overall this looks right.");
      assert.equal(general.filePath, undefined);
      assert.equal(general.resolvedAt, undefined);
      await assert.rejects(
        store.addChangesetComment({
          runId,
          changeSetId: changeSet.id,
          taskId: changeSet.taskId,
          authorId: author.id,
          body: "   ",
        }),
        /body/u,
      );
      // A comment must belong to a changeset that exists in that run.
      await assert.rejects(
        store.addChangesetComment({
          runId,
          changeSetId: "changeset_missing",
          taskId: changeSet.taskId,
          authorId: author.id,
          body: "orphan",
        }),
        /Unknown changeset/u,
      );

      const anchored = await store.addChangesetComment({
        runId,
        changeSetId: changeSet.id,
        taskId: changeSet.taskId,
        filePath,
        authorId: author.id,
        body: "This branch needs a test.",
      });
      assert.equal(anchored.filePath, filePath);

      assert.equal((await store.listChangesetComments({ runId })).length, 2);
      assert.equal(
        (await store.listChangesetComments({ resolved: false })).length,
        2,
      );

      const resolved = await store.resolveChangesetComment(
        anchored.id,
        author.id,
        "2026-02-01T00:00:00.000Z",
      );
      assert.equal(resolved.resolvedAt, "2026-02-01T00:00:00.000Z");
      assert.equal(resolved.resolvedBy, author.id);
      // Resolving again keeps the first reviewer rather than reassigning it.
      const again = await store.resolveChangesetComment(
        anchored.id,
        author.id,
        "2026-03-01T00:00:00.000Z",
      );
      assert.equal(again.resolvedAt, "2026-02-01T00:00:00.000Z");
      assert.equal(
        (await store.listChangesetComments({ resolved: true })).length,
        1,
      );

      // The run detail carries them, so a reviewer opening a run sees the
      // thread without a second request.
      const reread = await store.getRun(runId);
      assert.equal(reread?.comments.length, 2);
      assert.deepEqual(
        reread?.comments.map((comment) => comment.body),
        ["Overall this looks right.", "This branch needs a test."],
      );
      assert.equal(await store.getChangesetComment("comment_missing"), undefined);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: audit events filter by type, task, project, and time`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.appendAudit(undefined, {
        type: "task_submitted",
        taskId: "task_one",
        data: { projectId: DEFAULT_PROJECT_ID },
      });
      await store.appendAudit(undefined, {
        type: "plan_admitted",
        taskId: "task_one",
        data: { projectId: DEFAULT_PROJECT_ID, status: "approved" },
      });
      await store.appendAudit(undefined, {
        type: "task_submitted",
        taskId: "task_two",
        data: { projectId: "project_other" },
      });
      await store.appendAudit(undefined, {
        type: "task_failed",
        taskId: "task_two",
        data: {},
      });

      const byType = await store.listAuditEvents({ types: ["task_submitted"] });
      assert.deepEqual(
        byType.map((entry) => entry.event.taskId),
        ["task_one", "task_two"],
      );
      const byTypes = await store.listAuditEvents({
        types: ["plan_admitted", "task_failed"],
      });
      assert.equal(byTypes.length, 2);
      // An empty type list means "nothing matches", not "no filter".
      assert.deepEqual(await store.listAuditEvents({ types: [] }), []);

      assert.equal(
        (await store.listAuditEvents({ taskId: "task_one" })).length,
        2,
      );
      // Project lives inside the event payload, and an event without one is
      // excluded rather than assumed to belong to the project asked for.
      const byProject = await store.listAuditEvents({
        projectId: DEFAULT_PROJECT_ID,
      });
      assert.equal(byProject.length, 2);
      assert.ok(
        byProject.every((entry) => entry.event.taskId === "task_one"),
      );

      const all = await store.listAuditEvents({});
      const second = all[1];
      assert.ok(second !== undefined);
      // occurredAfter is inclusive and occurredBefore exclusive. Events
      // written in the same millisecond share a timestamp, so the bound is
      // asserted on time rather than on sequence.
      const from = await store.listAuditEvents({
        occurredAfter: second.event.occurredAt,
      });
      assert.ok(from.length > 0);
      assert.ok(
        from.every(
          (entry) => entry.event.occurredAt >= second.event.occurredAt,
        ),
      );
      assert.deepEqual(
        await store.listAuditEvents({
          occurredBefore: all[0]?.event.occurredAt ?? "",
        }),
        [],
      );

      // Filters compose rather than override one another.
      assert.equal(
        (
          await store.listAuditEvents({
            taskId: "task_one",
            types: ["plan_admitted"],
            projectId: DEFAULT_PROJECT_ID,
          })
        ).length,
        1,
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: archiving compacts the audit log without breaking verification`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      for (let index = 0; index < 6; index += 1) {
        await store.appendAudit(undefined, {
          type: "task_submitted",
          taskId: `task_${index}`,
          data: { projectId: DEFAULT_PROJECT_ID, index },
        });
      }
      assert.equal((await store.verifyAudit()).valid, true);

      // Archiving needs an explicit boundary; a bare call would be ambiguous
      // between "everything" and "nothing".
      await assert.rejects(store.archiveAuditEvents({}), /boundary/u);

      const archived = await store.archiveAuditEvents({ throughSequence: 4 });
      assert.ok(archived !== undefined);
      assert.equal(archived.checkpoint.throughSequence, 4);
      assert.equal(archived.checkpoint.events, 4);
      assert.equal(archived.events.length, 4);
      assert.equal(archived.checkpoint.chainHash.length, 64);

      // The live log now starts mid-chain, and verification still passes
      // because the checkpoint carries the link it continues from.
      const live = await store.listAuditEvents({});
      assert.deepEqual(
        live.map((entry) => entry.sequence),
        [5, 6],
      );
      const verified = await store.verifyAudit();
      assert.equal(verified.valid, true, JSON.stringify(verified));
      assert.equal(verified.valid && verified.events, 2);
      assert.equal(verified.valid && verified.archivedEvents, 4);

      // Archived events are still readable, through the same filters.
      assert.equal((await store.listArchivedAuditEvents({})).length, 4);
      assert.equal(
        (await store.listArchivedAuditEvents({ taskId: "task_0" })).length,
        1,
      );
      const checkpoints = await store.listAuditCheckpoints();
      assert.equal(checkpoints.length, 1);
      assert.equal(checkpoints[0]?.id, archived.checkpoint.id);

      // Appending after a compaction continues the same chain rather than
      // starting a new one.
      await store.appendAudit(undefined, {
        type: "task_failed",
        taskId: "task_after",
        data: {},
      });
      assert.equal((await store.verifyAudit()).valid, true);

      // Archiving the rest empties the live log entirely; the next event must
      // still link to the newest checkpoint.
      const rest = await store.archiveAuditEvents({ throughSequence: 7 });
      assert.ok(rest !== undefined);
      assert.deepEqual(await store.listAuditEvents({}), []);
      await store.appendAudit(undefined, {
        type: "task_submitted",
        taskId: "task_last",
        data: {},
      });
      const afterEmpty = await store.verifyAudit();
      assert.equal(afterEmpty.valid, true, JSON.stringify(afterEmpty));
      assert.equal(afterEmpty.valid && afterEmpty.archivedEvents, 7);

      // Nothing left to archive answers undefined rather than writing an
      // empty checkpoint.
      assert.equal(
        await store.archiveAuditEvents({ throughSequence: 7 }),
        undefined,
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: pruning an archive keeps the segment attested`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      for (let index = 0; index < 4; index += 1) {
        await store.appendAudit(undefined, {
          type: "task_submitted",
          taskId: `task_${index}`,
          data: {},
        });
      }
      const archived = await store.archiveAuditEvents({ throughSequence: 3 });
      assert.ok(archived !== undefined);

      // Only a checkpointed range may be dropped.
      await assert.rejects(
        store.pruneArchivedAuditEvents(1),
        /recorded checkpoint/u,
      );

      // Pruning takes whole segments: half a segment would stop reproducing
      // its digest and verification would report housekeeping as tampering.
      assert.equal(await store.pruneArchivedAuditEvents(3), 3);
      assert.deepEqual(await store.listArchivedAuditEvents({}), []);
      assert.equal((await store.listAuditCheckpoints()).length, 1);

      // The contents are gone but the chain still verifies: the checkpoint
      // attests the segment, which is the honest limit of what survives.
      const verified = await store.verifyAudit();
      assert.equal(verified.valid, true, JSON.stringify(verified));
      assert.equal(verified.valid && verified.attestedCheckpoints, 1);
      assert.equal(verified.valid && verified.archivedEvents, undefined);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: tampering with an archived segment is still detected`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      for (let index = 0; index < 4; index += 1) {
        await store.appendAudit(undefined, {
          type: "task_submitted",
          taskId: `task_${index}`,
          data: {},
        });
      }
      const archived = await store.archiveAuditEvents({ throughSequence: 3 });
      assert.ok(archived !== undefined);
      assert.equal((await store.verifyAudit()).valid, true);

      // Removing one archived event is the attack compaction could have
      // opened: it is not covered by the live chain any more, so only the
      // checkpoint digest can catch it.
      const raw = store as unknown as {
        db?: { exec(sql: string): void };
        query?(sql: string): Promise<unknown>;
        auditArchive?: unknown[];
      };
      if (raw.db !== undefined) {
        raw.db.exec("DELETE FROM audit_archive WHERE sequence = 2");
      } else if (raw.query !== undefined) {
        await raw.query("DELETE FROM audit_archive WHERE sequence = 2");
      } else {
        raw.auditArchive?.splice(1, 1);
      }

      const verified = await store.verifyAudit();
      assert.equal(verified.valid, false);
      assert.equal(
        verified.valid === false && verified.brokenAt,
        archived.checkpoint.throughSequence,
      );
      assert.match(
        verified.valid === false ? verified.reason : "",
        /checkpoint digest|previous hash/u,
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: audit events cannot be deleted without a checkpoint`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.appendAudit(undefined, {
        type: "task_submitted",
        taskId: "task_guard",
        data: {},
      });
      // The guard lives in the database, not in application code, so raw SQL
      // is the only way to prove it. In-memory has no SQL surface; its
      // equivalent is that no delete path exists at all.
      const raw = (
        store as unknown as {
          db?: { exec(sql: string): void };
          query?(sql: string): Promise<unknown>;
        }
      );
      if (raw.db !== undefined) {
        assert.throws(
          () => raw.db?.exec("DELETE FROM audit_events"),
          /checkpoint/u,
        );
      } else if (raw.query !== undefined) {
        await assert.rejects(
          raw.query("DELETE FROM audit_events"),
          /checkpoint/u,
        );
      }
      assert.equal((await store.listAuditEvents({})).length, 1);
      assert.equal((await store.verifyAudit()).valid, true);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: reported token usage replaces its own running total`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      const base = {
        projectId: DEFAULT_PROJECT_ID,
        repositoryId: REPOSITORY.id,
        taskId: TASK.id,
        leaseId: "lease_1",
        agentId: TASK.agentId,
      } as const;

      await store.recordTokenUsage({
        ...base,
        usageKey: "lease_1:planning",
        phase: "planning",
        totalTokens: 400,
        recordedAt: "2026-01-01T00:00:00.000Z",
      });
      // The worker reports a running total, not an increment, so a second
      // report of the same phase must overwrite rather than accumulate —
      // otherwise the bill grows with the heartbeat rate rather than with
      // what was actually spent.
      const updated = await store.recordTokenUsage({
        ...base,
        usageKey: "lease_1:planning",
        phase: "planning",
        inputTokens: 900,
        outputTokens: 100,
        totalTokens: 1_000,
        recordedAt: "2026-01-01T00:01:00.000Z",
      });
      assert.equal(updated.totalTokens, 1_000);
      assert.equal(updated.inputTokens, 900);

      await store.recordTokenUsage({
        ...base,
        usageKey: "lease_1:execution",
        phase: "execution",
        totalTokens: 2_500,
        recordedAt: "2026-01-01T00:02:00.000Z",
      });

      const forLease = await store.listTokenUsage({ leaseId: "lease_1" });
      assert.equal(forLease.length, 2);
      assert.equal(
        forLease.reduce((sum, entry) => sum + entry.totalTokens, 0),
        3_500,
      );

      // The two filters a budget is actually enforced through.
      assert.equal(
        (await store.listTokenUsage({ projectId: DEFAULT_PROJECT_ID })).length,
        2,
      );
      assert.equal(
        (
          await store.listTokenUsage({
            recordedAfter: "2026-01-01T00:01:30.000Z",
          })
        ).length,
        1,
      );
      assert.deepEqual(await store.listTokenUsage({ taskId: "task_other" }), []);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: runs list newest first and unknown ids return undefined`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await populate(store);
      await populate(store);
      const runs = await store.listRuns();
      assert.equal(runs.length, 2);
      assert.equal(await store.getRun("run_missing"), undefined);
      await assert.rejects(store.listRuns(0), RangeError);
    } finally {
      await store.close();
      await cleanup();
    }
  });
  test(`${backend.name}: an invitation is single use and cannot be raced`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const inviter = await store.createUser({
        email: "owner@example.com",
        displayName: "Owner",
        passwordDigest: "digest",
      });
      const joiner = await store.createUser({
        email: "joiner@example.com",
        displayName: "Joiner",
        passwordDigest: "digest",
      });
      const other = await store.createUser({
        email: "other@example.com",
        displayName: "Other",
        passwordDigest: "digest",
      });
      await store.createInvitation({
        id: "inv_1",
        organizationId: DEFAULT_ORGANIZATION_ID,
        email: "joiner@example.com",
        role: "developer",
        secretHash: "hash",
        invitedBy: inviter.id,
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-08T00:00:00.000Z",
        acceptedAt: undefined,
        acceptedBy: undefined,
        revokedAt: undefined,
      });

      const first = await store.acceptInvitation(
        "inv_1",
        joiner.id,
        "2026-01-02T00:00:00.000Z",
      );
      // A link that admitted one person must not admit a second: two people
      // opening the same invitation cannot both come away believing they were
      // let in.
      const second = await store.acceptInvitation(
        "inv_1",
        other.id,
        "2026-01-02T00:00:01.000Z",
      );
      assert.equal(first, true);
      assert.equal(second, false);

      const stored = await store.getInvitation("inv_1");
      assert.equal(stored?.acceptedBy, joiner.id);
      // The record survives being used, so who joined and when stays auditable.
      const listed = await store.listInvitations(DEFAULT_ORGANIZATION_ID);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.email, "joiner@example.com");
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: a revoked invitation stops working`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const inviter = await store.createUser({
        email: "owner2@example.com",
        displayName: "Owner",
        passwordDigest: "digest",
      });
      const joiner = await store.createUser({
        email: "late@example.com",
        displayName: "Late",
        passwordDigest: "digest",
      });
      await store.createInvitation({
        id: "inv_2",
        organizationId: DEFAULT_ORGANIZATION_ID,
        email: "late@example.com",
        role: "viewer",
        secretHash: "hash",
        invitedBy: inviter.id,
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-08T00:00:00.000Z",
        acceptedAt: undefined,
        acceptedBy: undefined,
        revokedAt: undefined,
      });
      await store.revokeInvitation("inv_2", "2026-01-03T00:00:00.000Z");
      assert.equal(
        await store.acceptInvitation("inv_2", joiner.id, "2026-01-04T00:00:00.000Z"),
        false,
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });
}
