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
      const store = SqliteCoordinationStore.open(
        path.join(root, "coordination.db"),
      );
      return {
        store,
        cleanup: async () => {
          // Closed before the file is removed. Windows refuses to unlink a
          // file that is still open, so leaving this to garbage collection
          // made every SQLite contract test an EBUSY away from failing for a
          // reason that has nothing to do with what it asserts.
          //
          // Tolerant of being closed already: several tests close the store
          // themselves as part of what they are checking, and "already shut"
          // is the state this wants rather than an error.
          await store.close().catch(() => undefined);
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

  test(`${backend.name}: a repository can be renamed without its id moving`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      assert.equal(
        (await store.getRepository(REPOSITORY.id))?.displayName,
        undefined,
      );

      await store.renameRepository(REPOSITORY.id, "Widgets");
      const renamed = await store.getRepository(REPOSITORY.id);
      assert.equal(renamed?.displayName, "Widgets");
      // The id is the handle every other row is keyed by, so it never moves.
      assert.equal(renamed?.id, REPOSITORY.id);
      assert.equal(renamed?.path, REPOSITORY.path);

      // A rename is an edit, unlike `saveRepository`, which is
      // first-insert-wins on every backend.
      await store.saveRepository(REPOSITORY);
      assert.equal(
        (await store.getRepository(REPOSITORY.id))?.displayName,
        "Widgets",
      );

      // Clearing puts it back to being called by its id.
      await store.renameRepository(REPOSITORY.id, undefined);
      assert.equal(
        (await store.getRepository(REPOSITORY.id))?.displayName,
        undefined,
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: a save that omits provenance is not a remapping`, async () => {
    // Every run on a GitHub-imported repository used to fail here.
    // `canonical()` in worker-operations narrows a stored repository to
    // `{id, path, branch}` for Git, that narrowed record reaches `createRun`
    // → `saveRepository`, and an absent provider read as "local" — so the
    // same repository looked like a different one and the run never started.
    const { store, cleanup } = await backend.open();
    try {
      const imported = {
        ...REPOSITORY,
        provider: "github" as const,
        remoteUrl: "https://github.com/acme/widgets.git",
      };
      await store.saveRepository(imported);

      // The shape a run actually re-saves: same repository, no provenance.
      await store.saveRepository({
        id: imported.id,
        path: imported.path,
        branch: imported.branch,
      });

      // And the provenance survives it — the row is not quietly relocalised.
      const after = await store.getRepository(imported.id);
      assert.equal(after?.provider, "github");
      assert.equal(after?.remoteUrl, "https://github.com/acme/widgets.git");

      // A record that genuinely states a different provenance is still a
      // remapping, so the guard is narrowed rather than removed.
      await assert.rejects(
        store.saveRepository({
          id: imported.id,
          path: imported.path,
          branch: imported.branch,
          provider: "local",
        }),
        /already mapped/u,
      );
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

  test(`${backend.name}: queued task dependencies release in FIFO order`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const owner = await store.createUser({
        email: "queued-work@example.invalid",
        displayName: "Queued Work",
        passwordDigest: "unused",
      });
      const worker = await store.registerWorker({
        userId: owner.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "queue-worker",
        adapters: ["codex"],
        version: "0.1.0",
      });
      await store.saveRepository(REPOSITORY);
      const first = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "first",
        agentId: "codex",
        validationCommands: [],
      });
      const second = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "second",
        agentId: "codex",
        validationCommands: [],
        queueAfterCurrent: true,
      });
      const third = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "third",
        agentId: "codex",
        validationCommands: [],
        queueAfterCurrent: true,
      });

      assert.equal(second.afterTaskId, first.id);
      assert.equal(third.afterTaskId, second.id);
      const firstLease = await store.leaseNextTask({
        workerId: worker.id,
        repositoryId: REPOSITORY.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 60_000,
        repositoryParallelism: 3,
      });
      assert.equal(firstLease?.task.id, first.id);
      assert.equal(
        await store.leaseNextTask({
          workerId: worker.id,
          repositoryId: REPOSITORY.id,
          baseRevision: BASE_VERSION.revision,
          ttlMs: 60_000,
          repositoryParallelism: 3,
        }),
        undefined,
      );

      assert.ok(firstLease !== undefined);
      await store.completeSubmittedTask(first.id, "integrated");
      await store.finishWorkLease(
        firstLease.lease.id,
        "completed",
        new Date().toISOString(),
      );
      const secondLease = await store.leaseNextTask({
        workerId: worker.id,
        repositoryId: REPOSITORY.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 60_000,
        repositoryParallelism: 3,
      });
      assert.equal(secondLease?.task.id, second.id);

      assert.ok(secondLease !== undefined);
      await store.completeSubmittedTask(second.id, "integrated");
      await store.finishWorkLease(
        secondLease.lease.id,
        "completed",
        new Date().toISOString(),
      );
      const thirdLease = await store.leaseNextTask({
        workerId: worker.id,
        repositoryId: REPOSITORY.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 60_000,
        repositoryParallelism: 3,
      });
      assert.equal(thirdLease?.task.id, third.id);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: a task's context survives being claimed`, async () => {
    // The whole point of the column is that the agent reads it, and the agent
    // only ever sees a *claimed* task — a context that round-trips on submit
    // and is dropped by the claim would look right everywhere except where it
    // is used.
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      const withContext = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "Do the same for the other file",
        agentId: TASK.agentId,
        validationCommands: [],
        context: "Earlier in the thread:\n- rename the config loader",
      });
      assert.equal(
        withContext.context,
        "Earlier in the thread:\n- rename the config loader",
      );

      const listed = (await store.listSubmittedTasks({ repositoryId: REPOSITORY.id }))
        .find((task) => task.id === withContext.id);
      assert.equal(listed?.context, withContext.context);

      const [claimed] = await store.claimSubmittedTasks(REPOSITORY.id);
      assert.equal(claimed?.id, withContext.id);
      assert.equal(claimed?.context, withContext.context);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: a task submitted with no context has none`, async () => {
    // Every task submitted before this column existed is in exactly this
    // state, and reading one must not produce an empty heading downstream.
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      const plain = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: TASK.objective,
        agentId: TASK.agentId,
        validationCommands: [],
      });
      assert.equal(plain.context, undefined);
      const [claimed] = await store.claimSubmittedTasks(REPOSITORY.id);
      assert.equal(claimed?.context, undefined);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: a landed turn leaves its conversational task open, not terminal`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      const submitted = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "first turn",
        agentId: TASK.agentId,
        validationCommands: [],
        conversationId: "thread_root_1",
      });
      assert.equal(submitted.conversationId, "thread_root_1");
      await store.claimSubmittedTasks(REPOSITORY.id);
      await store.openSubmittedTask(submitted.id, "run_1");

      const open = (await store.listSubmittedTasks({ status: "open" }))[0];
      assert.equal(open?.id, submitted.id);
      assert.equal(open?.conversationId, "thread_root_1");
      assert.equal(open?.runId, "run_1");
      // Open is an ending of a turn, not of the task: nothing is completed.
      assert.equal(open?.completedAt, undefined);
      assert.ok(open?.openedAt !== undefined);

      // Not claimable: an open task is waiting for a message, not a worker.
      assert.deepEqual(await store.claimSubmittedTasks(REPOSITORY.id), []);
      // Not completable or retryable either — the next turn is its own task.
      await assert.rejects(
        store.completeSubmittedTask(submitted.id, "integrated"),
        /open/u,
      );
      await assert.rejects(store.retrySubmittedTask(submitted.id), /open/u);
      // And only a claimed task can go open.
      const oneShot = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "one shot",
        agentId: TASK.agentId,
        validationCommands: [],
      });
      await assert.rejects(
        store.openSubmittedTask(oneShot.id),
        /submitted/u,
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: submitting the next turn settles the previous open one`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      const first = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "first turn",
        agentId: TASK.agentId,
        validationCommands: [],
        conversationId: "thread_root_2",
      });
      await store.claimSubmittedTasks(REPOSITORY.id);
      await store.openSubmittedTask(first.id);

      const second = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "second turn",
        agentId: TASK.agentId,
        validationCommands: [],
        conversationId: "thread_root_2",
      });
      const rows = await store.listSubmittedTasks({
        repositoryId: REPOSITORY.id,
      });
      // The first turn's work already landed; the arrival of the next turn
      // is what it was waiting for, so it settles as integrated — and at
      // most one turn of a conversation is ever open.
      assert.equal(
        rows.find((task) => task.id === first.id)?.status,
        "integrated",
      );
      assert.ok(
        rows.find((task) => task.id === first.id)?.completedAt !== undefined,
      );
      assert.equal(
        rows.find((task) => task.id === second.id)?.status,
        "submitted",
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: an open conversation can be ended, and an abandoned one expires`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      const ended = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "conversation somebody ends",
        agentId: TASK.agentId,
        validationCommands: [],
        conversationId: "thread_root_3",
      });
      const abandoned = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "conversation nobody answers",
        agentId: TASK.agentId,
        validationCommands: [],
        conversationId: "thread_root_4",
      });
      await store.claimSubmittedTasks(REPOSITORY.id);
      await store.openSubmittedTask(ended.id);
      await store.openSubmittedTask(abandoned.id);

      // "That's it, we're done" — explicit, and terminal as cancelled.
      const cancelled = await store.cancelSubmittedTask(ended.id);
      assert.equal(cancelled.status, "cancelled");
      assert.ok(cancelled.completedAt !== undefined);

      // Nothing expires ahead of the cutoff…
      assert.deepEqual(
        await store.expireOpenTasks(new Date(0).toISOString()),
        [],
      );
      // …and a cutoff the silence has outlasted settles it as integrated:
      // the work landed, only the waiting is over. A future cutoff stands in
      // for the passage of time.
      const expired = await store.expireOpenTasks(
        new Date(Date.now() + 60_000).toISOString(),
      );
      assert.equal(expired.length, 1);
      assert.equal(expired[0]?.id, abandoned.id);
      assert.equal(expired[0]?.status, "integrated");
      assert.equal(
        (await store.listSubmittedTasks({ status: "open" })).length,
        0,
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: a planned task is unleasable until it is released`, async () => {
    // The hold has to live in the status, because the status is what every
    // lease query selects on. Parked as `submitted` it was ordinary queued
    // work, and `leaseNextTask` takes the oldest queued row in a repository
    // rather than the one its caller meant — so an unrelated dispatch ran
    // work a person had explicitly declined to start.
    const { store, cleanup } = await backend.open();
    try {
      const user = await store.createUser({
        email: "planholder@example.com",
        displayName: "Planner",
        passwordDigest: "digest",
      });
      const worker = await store.registerWorker({
        userId: user.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "worker-plan",
        adapters: ["codex"],
        version: "1",
      });
      await store.saveRepository(REPOSITORY);
      const held = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "rewrite the auth module",
        agentId: "codex",
        validationCommands: [],
        planOnly: true,
      });
      assert.equal(held.status, "planned");

      // The queue cannot see it, even when it is the only task there is.
      assert.equal(
        await store.leaseNextTask({
          workerId: worker.id,
          repositoryId: REPOSITORY.id,
          baseRevision: "rev_1",
          ttlMs: 60_000,
        }),
        undefined,
      );
      // Nor by name: naming a task is not the same as approving it.
      assert.equal(
        await store.leaseNextTask({
          workerId: worker.id,
          taskId: held.id,
          baseRevision: "rev_1",
          ttlMs: 60_000,
        }),
        undefined,
      );
      assert.equal(
        (await store.listSubmittedTasks({ status: "submitted" })).length,
        0,
      );

      const released = await store.releasePlannedTask(held.id);
      assert.equal(released?.status, "submitted");
      // Releasing is the test as well as the write, so a second approval —
      // two people saying "go ahead" at once — starts nothing further.
      assert.equal(await store.releasePlannedTask(held.id), undefined);
      assert.equal(await store.releasePlannedTask("task_missing"), undefined);

      const leased = await store.leaseNextTask({
        workerId: worker.id,
        repositoryId: REPOSITORY.id,
        baseRevision: "rev_1",
        ttlMs: 60_000,
      });
      assert.equal(leased?.task.id, held.id);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: a thread remembers that its ending went elsewhere`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      const root = await store.appendChannelMessage({
        repositoryId: REPOSITORY.id,
        projectId: DEFAULT_PROJECT_ID,
        kind: "agent",
        authorId: "user_1:anthropic",
        content: "On it.",
      });
      assert.equal(root.endedAt, undefined);

      await store.markChannelMessageEnded(REPOSITORY.id, root.id);
      const ended = await store.getChannelMessage(
        REPOSITORY.id,
        root.id,
        "user_1",
      );
      assert.equal(typeof ended?.endedAt, "string");

      // First ending wins, so a re-narrated run cannot restamp the row and
      // make the mark look like it belongs to the later pass.
      await store.markChannelMessageEnded(REPOSITORY.id, root.id);
      assert.equal(
        (await store.getChannelMessage(REPOSITORY.id, root.id, "user_1"))
          ?.endedAt,
        ended?.endedAt,
      );

      // Scoped to its repository, and silent about a message that is not
      // there: this runs inside a narration loop that must not throw.
      await store.markChannelMessageEnded("repo_elsewhere", root.id);
      await store.markChannelMessageEnded(REPOSITORY.id, "chanmsg_missing");
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: a task remembers the model and effort it was asked for`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      const picked = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "raise the retry ceiling",
        agentId: "codex",
        validationCommands: [],
        model: "gpt-5.1-codex",
        effort: "xhigh",
      });
      assert.equal(picked.model, "gpt-5.1-codex");
      assert.equal(picked.effort, "xhigh");
      // Read back, because the runner that builds the adapter loads the row
      // rather than receiving the object the submit returned.
      const listed = (
        await store.listSubmittedTasks({ repositoryId: REPOSITORY.id })
      ).find((task) => task.id === picked.id);
      assert.equal(listed?.model, "gpt-5.1-codex");
      assert.equal(listed?.effort, "xhigh");

      // Absent means "whatever the agent is configured with", not empty
      // strings that would override a real setting with nothing.
      const plain = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "no preference",
        agentId: "codex",
        validationCommands: [],
      });
      assert.equal(plain.model, undefined);
      assert.equal(plain.effort, undefined);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: a plan nobody approved can still be cancelled`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      const held = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "a plan thought better of",
        agentId: "codex",
        validationCommands: [],
        planOnly: true,
      });
      const cancelled = await store.cancelSubmittedTask(held.id);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(await store.releasePlannedTask(held.id), undefined);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: an open task is not requeued when its turn's lease ends`, async () => {
    // The lease is released at the end of each turn while the task stays
    // open — the released arm's requeue must not flip an open task back to
    // submitted, or every conversation would immediately re-run its last
    // turn. Ordering matters: the task goes open before the lease settles.
    const { store, cleanup } = await backend.open();
    try {
      const user = await store.createUser({
        email: "conversations@example.com",
        displayName: "Fleet",
        passwordDigest: "digest",
      });
      const worker = await store.registerWorker({
        userId: user.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "worker-conv",
        adapters: ["codex"],
        version: "1",
      });
      await store.saveRepository(REPOSITORY);
      const task = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "conversational turn",
        agentId: "codex",
        validationCommands: [],
        conversationId: "thread_root_5",
      });
      const leased = await store.leaseNextTask({
        workerId: worker.id,
        baseRevision: BASE_VERSION.revision,
        ttlMs: 60_000,
      });
      assert.equal(leased?.task.id, task.id);
      await store.openSubmittedTask(task.id);
      await store.finishWorkLease(
        leased?.lease.id ?? "",
        "released",
        new Date().toISOString(),
      );
      assert.equal(
        (await store.listSubmittedTasks({ status: "open" }))[0]?.id,
        task.id,
      );
      assert.deepEqual(
        await store.listSubmittedTasks({ status: "submitted" }),
        [],
      );
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
        freshTokens: 250,
        totalTokens: 1_000,
        recordedAt: "2026-01-01T00:01:00.000Z",
      });
      assert.equal(updated.totalTokens, 1_000);
      assert.equal(updated.inputTokens, 900);
      assert.equal(updated.freshTokens, 250);

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

  test(`${backend.name}: a token report without a cache split clears the old one`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      const base = {
        projectId: DEFAULT_PROJECT_ID,
        repositoryId: REPOSITORY.id,
        taskId: TASK.id,
        leaseId: "lease_split",
        agentId: TASK.agentId,
        usageKey: "lease_split:execution",
        phase: "execution",
      } as const;

      await store.recordTokenUsage({
        ...base,
        inputTokens: 2_000,
        outputTokens: 500,
        freshTokens: 2_500,
        totalTokens: 25_000,
        recordedAt: "2026-01-01T00:00:00.000Z",
      });
      // The next snapshot of the same phase reports a larger total and no
      // split. Keeping the earlier fresh figure would leave it beside a total
      // that has since grown — stale, not a smaller truth — and the room's
      // activity line would undercount while claiming to be complete.
      const cleared = await store.recordTokenUsage({
        ...base,
        totalTokens: 40_000,
        recordedAt: "2026-01-01T00:01:00.000Z",
      });
      assert.equal(cleared.totalTokens, 40_000);
      assert.equal(cleared.freshTokens, undefined);

      const stored = await store.listTokenUsage({ leaseId: "lease_split" });
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.freshTokens, undefined);
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
        repositoryId: undefined,
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

  test(`${backend.name}: a password reset is single use and cannot be raced`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const user = await store.createUser({
        email: "forgetful@example.com",
        displayName: "Forgetful",
        passwordDigest: "digest",
      });
      await store.createPasswordReset({
        id: "pwr_1",
        userId: user.id,
        email: "forgetful@example.com",
        secretHash: "hash",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T01:00:00.000Z",
        consumedAt: undefined,
      });

      const stored = await store.getPasswordReset("pwr_1");
      assert.equal(stored?.userId, user.id);
      assert.equal(stored?.secretHash, "hash");
      assert.equal(stored?.consumedAt, undefined);

      const first = await store.consumePasswordReset(
        "pwr_1",
        "2026-01-01T00:10:00.000Z",
      );
      // Two requests racing one link must not both come away believing they
      // set the password.
      const second = await store.consumePasswordReset(
        "pwr_1",
        "2026-01-01T00:10:01.000Z",
      );
      assert.equal(first, true);
      assert.equal(second, false);
      assert.equal(
        (await store.getPasswordReset("pwr_1"))?.consumedAt,
        "2026-01-01T00:10:00.000Z",
      );
      assert.equal(await store.getPasswordReset("pwr_missing"), undefined);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: a new reset link drops the ones before it`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const user = await store.createUser({
        email: "again@example.com",
        displayName: "Again",
        passwordDigest: "digest",
      });
      const other = await store.createUser({
        email: "untouched@example.com",
        displayName: "Untouched",
        passwordDigest: "digest",
      });
      for (const id of ["pwr_a", "pwr_b"]) {
        await store.createPasswordReset({
          id,
          userId: user.id,
          email: "again@example.com",
          secretHash: `hash-${id}`,
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T01:00:00.000Z",
          consumedAt: undefined,
        });
      }
      await store.createPasswordReset({
        id: "pwr_c",
        userId: other.id,
        email: "untouched@example.com",
        secretHash: "hash-c",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T01:00:00.000Z",
        consumedAt: undefined,
      });

      await store.deletePasswordResetsForUser(user.id);
      assert.equal(await store.getPasswordReset("pwr_a"), undefined);
      assert.equal(await store.getPasswordReset("pwr_b"), undefined);
      // One account's reset is not another's: clearing mine leaves yours.
      assert.notEqual(await store.getPasswordReset("pwr_c"), undefined);
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
        repositoryId: REPOSITORY.id,
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

  test(`${backend.name}: a grant reaches one repository and no others`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const user = await store.createUser({
        email: "granted@example.com",
        displayName: "Granted",
        passwordDigest: "digest",
      });
      await store.saveRepositoryGrant({
        repositoryId: "repo_shared",
        userId: user.id,
        role: "developer",
        grantedBy: undefined,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const mine = await store.listGrantsForUser(user.id);
      assert.equal(mine.length, 1);
      assert.equal(mine[0]?.repositoryId, "repo_shared");
      // Nothing about this grant says anything about any other repository.
      assert.deepEqual(await store.listRepositoryGrants("repo_private"), []);

      // Re-granting changes the role rather than duplicating the person.
      await store.saveRepositoryGrant({
        repositoryId: "repo_shared",
        userId: user.id,
        role: "reviewer",
        grantedBy: undefined,
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      const after = await store.listRepositoryGrants("repo_shared");
      assert.equal(after.length, 1);
      assert.equal(after[0]?.role, "reviewer");

      await store.removeRepositoryGrant("repo_shared", user.id);
      assert.deepEqual(await store.listGrantsForUser(user.id), []);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: createdBy persists, and is absent for repositories that predate it`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const creator = await store.createUser({
        email: "creator@example.com",
        displayName: "Creator",
        passwordDigest: "digest",
      });
      await store.saveRepository({
        id: "repo_with_creator",
        path: "/with-creator.git",
        branch: "main",
        createdBy: creator.id,
      });
      assert.equal(
        (await store.getRepository("repo_with_creator"))?.createdBy,
        creator.id,
      );

      // No createdBy at all — the honest state for anything that predates
      // the field, rather than a guessed owner.
      await store.saveRepository({
        id: "repo_without_creator",
        path: "/without-creator.git",
        branch: "main",
      });
      assert.equal(
        (await store.getRepository("repo_without_creator"))?.createdBy,
        undefined,
      );

      // A resubmission (e.g. a retried creation call) must not move
      // createdBy once the first insert has recorded it.
      await store.saveRepository({
        id: "repo_with_creator",
        path: "/with-creator.git",
        branch: "main",
      });
      assert.equal(
        (await store.getRepository("repo_with_creator"))?.createdBy,
        creator.id,
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: a repository that has actually run work can still be deleted`, async () => {
    // The cascade originally covered the channel and grants and nothing else,
    // so the first delete of a repository with real history failed on the
    // foreign key from `runs` — and only repositories nobody had used could
    // be removed, which is the exact opposite of which ones people want to.
    const { store, cleanup } = await backend.open();
    try {
      await populate(store);
      await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: "queued and never claimed",
        agentId: TASK.agentId,
        validationCommands: TASK.validationCommands,
      });
      await store.removeRepository(REPOSITORY.id);
      assert.equal(await store.getRepository(REPOSITORY.id), undefined);
      assert.deepEqual(
        await store.listSubmittedTasks({ repositoryId: REPOSITORY.id }),
        [],
      );
    } finally {
      await cleanup();
    }
  });

  test(`${backend.name}: removeRepository cascades the repository's channel and grants`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository({
        id: "repo_to_delete",
        path: "/to-delete.git",
        branch: "main",
      });
      const alice = await store.createUser({
        email: "alice-delete@example.invalid",
        displayName: "Alice",
        passwordDigest: "unused",
      });
      const guest = await store.createUser({
        email: "guest-delete@example.invalid",
        displayName: "Guest",
        passwordDigest: "unused",
      });

      const posted = await store.appendChannelMessage({
        repositoryId: "repo_to_delete",
        projectId: DEFAULT_PROJECT_ID,
        authorId: alice.id,
        content: "Message in a repository about to be deleted.",
      });
      await store.addChannelReply({
        repositoryId: "repo_to_delete",
        messageId: posted.id,
        authorId: alice.id,
        content: "A reply too.",
      });
      await store.toggleChannelReaction(
        "repo_to_delete",
        posted.id,
        alice.id,
        "👍",
      );
      await store.setChannelAgentOverride("repo_to_delete", "agent_1", {
        name: "Renamed Agent",
      });
      await store.setChannelAgentMember(
        "repo_to_delete",
        alice.id,
        "anthropic",
        true,
      );
      await store.markChannelRead(
        "repo_to_delete",
        alice.id,
        "2026-01-01T00:00:00.000Z",
      );
      await store.saveRepositoryGrant({
        repositoryId: "repo_to_delete",
        userId: guest.id,
        role: "developer",
        grantedBy: alice.id,
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      await store.removeRepository("repo_to_delete");

      assert.equal(await store.getRepository("repo_to_delete"), undefined);
      assert.deepEqual(
        await store.listChannelMessages("repo_to_delete", alice.id),
        [],
      );
      assert.deepEqual(
        await store.listChannelAgentOverrides("repo_to_delete"),
        {},
      );
      assert.deepEqual(
        await store.listChannelAgentMembers("repo_to_delete"),
        [],
      );
      assert.equal(
        await store.getChannelReadCursor("repo_to_delete", alice.id),
        undefined,
      );
      assert.deepEqual(
        await store.listRepositoryGrants("repo_to_delete"),
        [],
      );
      assert.deepEqual(await store.listGrantsForUser(guest.id), []);

      // A repository created later under the same id starts with none of
      // the deleted repository's channel or grants attached to it.
      await store.saveRepository({
        id: "repo_to_delete",
        path: "/to-delete-again.git",
        branch: "main",
      });
      assert.deepEqual(
        await store.listChannelMessages("repo_to_delete", alice.id),
        [],
      );
      assert.deepEqual(
        await store.listRepositoryGrants("repo_to_delete"),
        [],
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: deleting a repository takes its queue and run history with it`, async () => {
    // This used to assert the opposite — that history *refuses* deletion.
    // The refusal surfaced in production as a raw "FOREIGN KEY constraint
    // failed" with nothing offering to clear the history behind it, so every
    // repository that had ever run a task was permanently undeletable. The
    // durable record survives regardless: the audit log carries no foreign
    // key to any of this.
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository({
        id: "repo_with_task",
        path: "/with-task.git",
        branch: "main",
      });
      await store.submitTask({
        repositoryId: "repo_with_task",
        objective: "Do something",
        agentId: "scripted-generic-cli",
        validationCommands: [],
      });
      await store.removeRepository("repo_with_task");
      assert.equal(await store.getRepository("repo_with_task"), undefined);
      assert.deepEqual(
        await store.listSubmittedTasks({ repositoryId: "repo_with_task" }),
        [],
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: direct messages are private to the two people in them`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const alice = await store.createUser({
        email: "dm-alice@example.invalid",
        displayName: "Alice",
        passwordDigest: "unused",
      });
      const bob = await store.createUser({
        email: "dm-bob@example.invalid",
        displayName: "Bob",
        passwordDigest: "unused",
      });
      const carol = await store.createUser({
        email: "dm-carol@example.invalid",
        displayName: "Carol",
        passwordDigest: "unused",
      });

      const first = await store.appendDirectMessage({
        projectId: DEFAULT_PROJECT_ID,
        authorId: alice.id,
        recipientId: bob.id,
        content: "  Can you look at the deploy?  ",
      });
      assert.equal(first.content, "Can you look at the deploy?");
      assert.equal(first.readAt, undefined);
      await assert.rejects(
        store.appendDirectMessage({
          projectId: DEFAULT_PROJECT_ID,
          authorId: alice.id,
          recipientId: bob.id,
          content: "   ",
        }),
        /must have content/u,
      );
      // Writing to yourself is not a conversation, and allowing it would put a
      // row in the table whose pair key names one person twice.
      await assert.rejects(
        store.appendDirectMessage({
          projectId: DEFAULT_PROJECT_ID,
          authorId: alice.id,
          recipientId: alice.id,
          content: "Note to self",
        }),
        /two people/u,
      );

      // Timestamps are milliseconds, so messages sent inside one tick order
      // only by the id tiebreak, which is random. Every assertion below that
      // depends on order gets a real millisecond between the sends.
      const tick = async (): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      };
      await tick();
      const reply = await store.appendDirectMessage({
        projectId: DEFAULT_PROJECT_ID,
        authorId: bob.id,
        recipientId: alice.id,
        content: "Looking now.",
        referencedMessageId: first.id,
      });
      assert.equal(reply.referencedMessageId, first.id);
      await tick();
      await store.appendDirectMessage({
        projectId: DEFAULT_PROJECT_ID,
        authorId: carol.id,
        recipientId: alice.id,
        content: "Unrelated.",
      });

      // One thread from either side, both directions, oldest first.
      const asAlice = await store.listDirectMessages(
        DEFAULT_PROJECT_ID,
        alice.id,
        bob.id,
      );
      assert.deepEqual(
        asAlice.map((message) => message.content),
        ["Can you look at the deploy?", "Looking now."],
      );
      assert.equal(asAlice[1]?.referencedMessageId, first.id);
      await assert.rejects(
        store.appendDirectMessage({
          projectId: DEFAULT_PROJECT_ID,
          authorId: carol.id,
          recipientId: alice.id,
          content: "This is not Carol's conversation.",
          referencedMessageId: first.id,
        }),
        /same conversation/u,
      );
      const asBob = await store.listDirectMessages(
        DEFAULT_PROJECT_ID,
        bob.id,
        alice.id,
      );
      assert.deepEqual(
        asBob.map((message) => message.id),
        asAlice.map((message) => message.id),
      );
      // Carol's message to Alice is a different conversation, and does not
      // leak into the one Bob can read.
      assert.equal(
        asBob.some((message) => message.content === "Unrelated."),
        false,
      );

      // The inbox: both correspondents, most recent first, with Alice's two
      // unread — Bob's reply and Carol's message — counted against her.
      const inbox = await store.listDirectConversations(
        DEFAULT_PROJECT_ID,
        alice.id,
      );
      assert.deepEqual(
        inbox.map((conversation) => conversation.userId),
        [carol.id, bob.id],
      );
      assert.deepEqual(
        inbox.map((conversation) => conversation.unread),
        [1, 1],
      );
      // Alice's own message to Bob is not unread for Alice.
      const bobsInbox = await store.listDirectConversations(
        DEFAULT_PROJECT_ID,
        bob.id,
      );
      assert.deepEqual(
        bobsInbox.map((conversation) => conversation.unread),
        [1],
      );

      // Reading marks only what was addressed to the reader: Alice reading
      // Bob's thread must not mark her own message as read on his behalf.
      const at = new Date().toISOString();
      assert.equal(
        await store.markDirectMessagesRead(
          DEFAULT_PROJECT_ID,
          alice.id,
          bob.id,
          at,
        ),
        1,
      );
      assert.equal(
        (await store.listDirectConversations(DEFAULT_PROJECT_ID, alice.id)).find(
          (conversation) => conversation.userId === bob.id,
        )?.unread,
        0,
      );
      assert.deepEqual(
        (await store.listDirectConversations(DEFAULT_PROJECT_ID, bob.id)).map(
          (conversation) => conversation.unread,
        ),
        [1],
      );
      // Idempotent: a second read has nothing left to mark.
      assert.equal(
        await store.markDirectMessagesRead(
          DEFAULT_PROJECT_ID,
          alice.id,
          bob.id,
          at,
        ),
        0,
      );

      // Paging takes the newest, and hands them back in reading order.
      const latest = await store.listDirectMessages(
        DEFAULT_PROJECT_ID,
        alice.id,
        bob.id,
        { limit: 1 },
      );
      assert.deepEqual(
        latest.map((message) => message.content),
        ["Looking now."],
      );
      const before = await store.listDirectMessages(
        DEFAULT_PROJECT_ID,
        alice.id,
        bob.id,
        { before: latest[0]!.createdAt },
      );
      assert.deepEqual(
        before.map((message) => message.content),
        ["Can you look at the deploy?"],
      );

      // Unsending: the sender's own, gone for both sides, and nobody else's.
      // Bob trying to delete Alice's message is answered the same way as a
      // message that was never there — "not yours" and "already gone" must
      // not be distinguishable, or the answer is a probe.
      assert.equal(
        await store.deleteDirectMessage(
          DEFAULT_PROJECT_ID,
          first.id,
          bob.id,
        ),
        undefined,
      );
      assert.equal(
        (
          await store.listDirectMessages(DEFAULT_PROJECT_ID, bob.id, alice.id)
        ).length,
        2,
      );
      const unsent = await store.deleteDirectMessage(
        DEFAULT_PROJECT_ID,
        first.id,
        alice.id,
      );
      assert.equal(unsent?.id, first.id);
      assert.equal(unsent?.recipientId, bob.id);
      for (const viewer of [alice, bob]) {
        const remaining = await store.listDirectMessages(
          DEFAULT_PROJECT_ID,
          viewer.id,
          viewer.id === alice.id ? bob.id : alice.id,
        );
        assert.deepEqual(
          remaining.map((message) => message.content),
          ["Looking now."],
        );
        assert.equal(remaining[0]?.referencedMessageId, undefined);
      }
      // Deleting twice is not an error, and still says nothing was there.
      assert.equal(
        await store.deleteDirectMessage(
          DEFAULT_PROJECT_ID,
          first.id,
          alice.id,
        ),
        undefined,
      );
    } finally {
      await cleanup();
    }
  });

  test(`${backend.name}: a channel message is blanked when it carries a thread and removed when it does not`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository({
        id: "repo_delete",
        path: "/delete.git",
        branch: "main",
      });
      const alice = await store.createUser({
        email: "del-alice@example.invalid",
        displayName: "Alice",
        passwordDigest: "unused",
      });

      const root = await store.appendChannelMessage({
        repositoryId: "repo_delete",
        projectId: DEFAULT_PROJECT_ID,
        authorId: alice.id,
        content: "Please rename the config key.",
      });
      const reply = await store.addChannelReply({
        repositoryId: "repo_delete",
        messageId: root.id,
        authorId: alice.id,
        content: "Done — three call sites.",
      });
      await store.toggleChannelReaction(
        "repo_delete",
        root.id,
        alice.id,
        "👍",
      );
      await store.toggleChannelMessagePin("repo_delete", root.id, alice.id);

      // Blanked in place: the words and the reactions go, the thread stays.
      // The row keeps its identity and its position, so the reply underneath
      // is still an answer to something rather than to the message above.
      await store.redactChannelMessage("repo_delete", root.id, {
        deletedAt: "2026-01-01T00:00:00.000Z",
        deletedBy: alice.id,
      });
      const redacted = await store.getChannelMessage(
        "repo_delete",
        root.id,
        alice.id,
      );
      assert.equal(redacted?.content, "");
      assert.equal(redacted?.deletedAt, "2026-01-01T00:00:00.000Z");
      assert.equal(redacted?.deletedBy, alice.id);
      assert.deepEqual(redacted?.reactions, {});
      // The pin was attention paid to words that are gone; the banner must
      // not be left pointing at a tombstone.
      assert.equal(redacted?.pinnedAt, undefined);
      assert.deepEqual(
        await store.listPinnedChannelMessages("repo_delete", alice.id),
        [],
      );
      assert.deepEqual(
        redacted?.replies.map((entry) => entry.id),
        [reply.id],
      );
      assert.equal(redacted?.createdAt, root.createdAt);

      // First deletion wins: a second pass must not restamp who unsaid it.
      await store.redactChannelMessage("repo_delete", root.id, {
        deletedAt: "2026-02-02T00:00:00.000Z",
        deletedBy: "someone_else",
      });
      assert.equal(
        (await store.getChannelMessage("repo_delete", root.id, alice.id))
          ?.deletedBy,
        alice.id,
      );

      // A reply is a leaf and simply goes. Removing it leaves the tombstone
      // standing — the two are separate rows and separate decisions.
      const removedReply = await store.deleteChannelReply(
        "repo_delete",
        root.id,
        reply.id,
      );
      assert.equal(removedReply?.id, reply.id);
      assert.deepEqual(
        (await store.getChannelMessage("repo_delete", root.id, alice.id))
          ?.replies,
        [],
      );
      assert.equal(
        await store.deleteChannelReply("repo_delete", root.id, reply.id),
        undefined,
      );

      // Not from another repository's message, however real both ids are.
      const other = await store.appendChannelMessage({
        repositoryId: "repo_delete",
        projectId: DEFAULT_PROJECT_ID,
        authorId: alice.id,
        content: "Unrelated.",
      });
      const otherReply = await store.addChannelReply({
        repositoryId: "repo_delete",
        messageId: other.id,
        authorId: alice.id,
        content: "Also unrelated.",
      });
      assert.equal(
        await store.deleteChannelReply("repo_missing", other.id, otherReply.id),
        undefined,
      );
      assert.equal(
        await store.deleteChannelReply("repo_delete", root.id, otherReply.id),
        undefined,
      );

      // And a message nobody has replied under is not blanked, it is gone.
      await store.deleteChannelMessage("repo_delete", root.id);
      assert.equal(
        await store.getChannelMessage("repo_delete", root.id, alice.id),
        undefined,
      );

      // Redacting something that is not there is not an error.
      await store.redactChannelMessage("repo_delete", "chanmsg_missing", {
        deletedAt: "2026-03-03T00:00:00.000Z",
        deletedBy: alice.id,
      });
    } finally {
      await cleanup();
    }
  });

  test(`${backend.name}: a channel message reference must target the same repository and clears when its target is physically deleted`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository({
        id: "repo_reference",
        path: "/reference.git",
        branch: "main",
      });
      await store.saveRepository({
        id: "repo_reference_other",
        path: "/reference-other.git",
        branch: "main",
      });
      const alice = await store.createUser({
        email: "reference-alice@example.invalid",
        displayName: "Alice",
        passwordDigest: "unused",
      });
      const target = await store.appendChannelMessage({
        repositoryId: "repo_reference",
        projectId: DEFAULT_PROJECT_ID,
        authorId: alice.id,
        content: "What changed in the retry policy?",
      });
      const response = await store.appendChannelMessage({
        repositoryId: "repo_reference",
        projectId: DEFAULT_PROJECT_ID,
        kind: "agent",
        authorId: `${alice.id}:anthropic`,
        content: "It now backs off between attempts.",
        referencedMessageId: target.id,
      });

      assert.equal(response.referencedMessageId, target.id);
      assert.equal(
        (
          await store.getChannelMessage(
            "repo_reference",
            response.id,
            alice.id,
          )
        )?.referencedMessageId,
        target.id,
      );
      await assert.rejects(
        store.appendChannelMessage({
          repositoryId: "repo_reference_other",
          projectId: DEFAULT_PROJECT_ID,
          kind: "agent",
          authorId: `${alice.id}:anthropic`,
          content: "This must not cross rooms.",
          referencedMessageId: target.id,
        }),
        /same repository/u,
      );
      await assert.rejects(
        store.appendChannelMessage({
          repositoryId: "repo_reference",
          projectId: DEFAULT_PROJECT_ID,
          kind: "agent",
          authorId: `${alice.id}:anthropic`,
          content: "This must point at something real.",
          referencedMessageId: "chanmsg_missing",
        }),
        /same repository/u,
      );

      // Redaction leaves an addressable tombstone, so the reference survives.
      await store.redactChannelMessage("repo_reference", target.id, {
        deletedAt: "2026-01-01T00:00:00.000Z",
        deletedBy: alice.id,
      });
      assert.equal(
        (
          await store.getChannelMessage(
            "repo_reference",
            response.id,
            alice.id,
          )
        )?.referencedMessageId,
        target.id,
      );

      // Removing the target row leaves the response but clears its address.
      await store.deleteChannelMessage("repo_reference", target.id);
      assert.equal(
        (
          await store.getChannelMessage(
            "repo_reference",
            response.id,
            alice.id,
          )
        )?.referencedMessageId,
        undefined,
      );
    } finally {
      await cleanup();
    }
  });

  test(`${backend.name}: pinned channel messages toggle, survive paging, and die with the row`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository({
        id: "repo_pins",
        path: "/pins.git",
        branch: "main",
      });
      const alice = await store.createUser({
        email: "pin-alice@example.invalid",
        displayName: "Alice",
        passwordDigest: "unused",
      });
      const bob = await store.createUser({
        email: "pin-bob@example.invalid",
        displayName: "Bob",
        passwordDigest: "unused",
      });

      const first = await store.appendChannelMessage({
        repositoryId: "repo_pins",
        projectId: DEFAULT_PROJECT_ID,
        authorId: alice.id,
        content: "Decision: we ship on Friday.",
      });
      assert.equal(first.pinnedAt, undefined);
      const pinned = await store.toggleChannelMessagePin(
        "repo_pins",
        first.id,
        alice.id,
      );
      assert.ok(pinned.pinnedAt !== undefined);
      assert.equal(pinned.pinnedBy, alice.id);

      // Paging cannot lose a pin: the room moves on, the pin does not. The
      // short gap keeps the timestamps from tying, as the pagination test
      // below this one does.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await store.appendChannelMessage({
        repositoryId: "repo_pins",
        projectId: DEFAULT_PROJECT_ID,
        authorId: bob.id,
        content: "Later chatter.",
      });
      const newestOnly = await store.listChannelMessages("repo_pins", bob.id, {
        limit: 1,
      });
      assert.deepEqual(
        newestOnly.map((message) => message.id),
        [second.id],
      );
      const shelf = await store.listPinnedChannelMessages("repo_pins", bob.id);
      assert.deepEqual(
        shelf.map((message) => message.id),
        [first.id],
      );
      assert.equal(shelf[0]?.pinnedBy, alice.id);

      // Anyone may unpin — a pin is shared attention, not a lock.
      const cleared = await store.toggleChannelMessagePin(
        "repo_pins",
        first.id,
        bob.id,
      );
      assert.equal(cleared.pinnedAt, undefined);
      assert.equal(cleared.pinnedBy, undefined);
      assert.deepEqual(
        await store.listPinnedChannelMessages("repo_pins", bob.id),
        [],
      );

      // Re-pinning records the new pinner, and deletion takes the pin with
      // the row — the columns live and die with the message.
      const repinned = await store.toggleChannelMessagePin(
        "repo_pins",
        first.id,
        bob.id,
      );
      assert.equal(repinned.pinnedBy, bob.id);
      await store.deleteChannelMessage("repo_pins", first.id);
      assert.deepEqual(
        await store.listPinnedChannelMessages("repo_pins", bob.id),
        [],
      );

      await assert.rejects(
        store.toggleChannelMessagePin("repo_pins", "chanmsg_missing", alice.id),
        /Unknown channel message/u,
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: a channel counts every root and reply it holds`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository({
        id: "repo_counted",
        path: "/counted.git",
        branch: "main",
      });
      await store.saveRepository({
        id: "repo_other",
        path: "/other.git",
        branch: "main",
      });
      const alice = await store.createUser({
        email: "alice@example.invalid",
        displayName: "Alice",
        passwordDigest: "unused",
      });

      assert.deepEqual(await store.countChannelMessages("repo_counted"), {
        messages: 0,
        replies: 0,
      });

      // Past `listChannelMessages`'s 200-row page, which is what the count
      // exists to see beyond: measuring the page reported the cap, not the room.
      const threaded = await store.appendChannelMessage({
        repositoryId: "repo_counted",
        projectId: DEFAULT_PROJECT_ID,
        authorId: alice.id,
        content: "The thread everything hangs off.",
      });
      const redacted = await store.appendChannelMessage({
        repositoryId: "repo_counted",
        projectId: DEFAULT_PROJECT_ID,
        authorId: alice.id,
        content: "Said and then taken back.",
      });
      for (let index = 0; index < 203; index += 1) {
        await store.appendChannelMessage({
          repositoryId: "repo_counted",
          projectId: DEFAULT_PROJECT_ID,
          authorId: alice.id,
          content: `Line ${index}`,
        });
      }
      const firstReply = await store.addChannelReply({
        repositoryId: "repo_counted",
        messageId: threaded.id,
        authorId: alice.id,
        content: "First reply.",
      });
      await store.addChannelReply({
        repositoryId: "repo_counted",
        messageId: threaded.id,
        authorId: alice.id,
        content: "Second reply.",
      });
      // Another room's traffic is not this room's.
      await store.appendChannelMessage({
        repositoryId: "repo_other",
        projectId: DEFAULT_PROJECT_ID,
        authorId: alice.id,
        content: "Elsewhere.",
      });

      const listed = await store.listChannelMessages("repo_counted", alice.id, {
        limit: 200,
      });
      assert.equal(listed.length, 200);
      assert.deepEqual(await store.countChannelMessages("repo_counted"), {
        messages: 205,
        replies: 2,
      });
      assert.deepEqual(await store.countChannelMessages("repo_other"), {
        messages: 1,
        replies: 0,
      });

      // A redacted root still stands in the room — its thread and its replies
      // are still there — so it is still counted.
      await store.redactChannelMessage("repo_counted", redacted.id, {
        deletedAt: new Date().toISOString(),
        deletedBy: alice.id,
      });
      assert.deepEqual(await store.countChannelMessages("repo_counted"), {
        messages: 205,
        replies: 2,
      });

      // What is actually removed stops counting, and a deleted root takes its
      // remaining replies with it.
      await store.deleteChannelReply("repo_counted", threaded.id, firstReply.id);
      await store.deleteChannelMessage("repo_counted", threaded.id);
      assert.deepEqual(await store.countChannelMessages("repo_counted"), {
        messages: 204,
        replies: 0,
      });
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: channel reply content is finalized in place within its thread`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository({
        id: "repo_reply_update",
        path: "/reply-update.git",
        branch: "main",
      });
      await store.saveRepository({
        id: "repo_reply_update_other",
        path: "/reply-update-other.git",
        branch: "main",
      });
      const alice = await store.createUser({
        email: "reply-update@example.invalid",
        displayName: "Alice",
        passwordDigest: "unused",
      });
      const root = await store.appendChannelMessage({
        repositoryId: "repo_reply_update",
        projectId: DEFAULT_PROJECT_ID,
        authorId: alice.id,
        content: "Please tighten the retry policy.",
      });
      const siblingRoot = await store.appendChannelMessage({
        repositoryId: "repo_reply_update",
        projectId: DEFAULT_PROJECT_ID,
        authorId: alice.id,
        content: "An unrelated thread.",
      });
      const reply = await store.addChannelReply({
        repositoryId: "repo_reply_update",
        messageId: root.id,
        kind: "agent",
        authorId: alice.id,
        content: "I've taken this task and I'm working on it.",
      });

      // All three identities bound the update. A real reply id is not enough
      // to rewrite it through another repository or another thread root.
      await store.setChannelReplyContent(
        "repo_reply_update_other",
        root.id,
        reply.id,
        "Wrong repository.",
      );
      await store.setChannelReplyContent(
        "repo_reply_update",
        siblingRoot.id,
        reply.id,
        "Wrong thread.",
      );
      assert.equal(
        (
          await store.getChannelMessage(
            "repo_reply_update",
            root.id,
            alice.id,
          )
        )?.replies[0]?.content,
        reply.content,
      );

      const intent =
        "I'll inspect the retry callers, update the policy, and verify it.";
      await store.setChannelReplyContent(
        "repo_reply_update",
        root.id,
        reply.id,
        intent,
      );
      const updated = (
        await store.getChannelMessage(
          "repo_reply_update",
          root.id,
          alice.id,
        )
      )?.replies[0];
      assert.deepEqual(updated, { ...reply, content: intent });
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: a repository channel threads, reacts, and tracks per-viewer state`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository({
        id: "repo_channel",
        path: "/channel.git",
        branch: "main",
      });
      const alice = await store.createUser({
        email: "alice@example.invalid",
        displayName: "Alice",
        passwordDigest: "unused",
      });
      const bob = await store.createUser({
        email: "bob@example.invalid",
        displayName: "Bob",
        passwordDigest: "unused",
      });

      const posted = await store.appendChannelMessage({
        repositoryId: "repo_channel",
        projectId: DEFAULT_PROJECT_ID,
        authorId: alice.id,
        content: "  Kicking off this repository's shared channel.  ",
      });
      // Content is trimmed, and an empty message is not a message at all.
      assert.equal(
        posted.content,
        "Kicking off this repository's shared channel.",
      );
      assert.equal(posted.kind, "user");
      assert.deepEqual(posted.replies, []);
      assert.deepEqual(posted.reactions, {});
      await assert.rejects(
        store.appendChannelMessage({
          repositoryId: "repo_channel",
          projectId: DEFAULT_PROJECT_ID,
          authorId: alice.id,
          content: "   ",
        }),
        /content/u,
      );

      const reply = await store.addChannelReply({
        repositoryId: "repo_channel",
        messageId: posted.id,
        authorId: bob.id,
        content: "Glad to be here.",
      });
      assert.equal(reply.messageId, posted.id);
      await assert.rejects(
        store.addChannelReply({
          repositoryId: "repo_channel",
          messageId: "chanmsg_missing",
          authorId: bob.id,
          content: "orphan",
        }),
        /Unknown channel message/u,
      );

      // Reactions are per-viewer: Alice's own reaction should not read as
      // "mine" for Bob, and toggling twice is on, then off.
      const afterAliceReacts = await store.toggleChannelReaction(
        "repo_channel",
        posted.id,
        alice.id,
        "👍",
      );
      assert.deepEqual(afterAliceReacts.reactions["👍"], {
        emoji: "👍",
        count: 1,
        mine: true,
      });
      const seenByBob = await store.getChannelMessage(
        "repo_channel",
        posted.id,
        bob.id,
      );
      assert.deepEqual(seenByBob?.reactions["👍"], {
        emoji: "👍",
        count: 1,
        mine: false,
      });
      const afterBobReacts = await store.toggleChannelReaction(
        "repo_channel",
        posted.id,
        bob.id,
        "👍",
      );
      assert.equal(afterBobReacts.reactions["👍"]?.count, 2);
      const afterAliceUnreacts = await store.toggleChannelReaction(
        "repo_channel",
        posted.id,
        alice.id,
        "👍",
      );
      assert.equal(afterAliceUnreacts.reactions["👍"]?.count, 1);
      assert.equal(afterAliceUnreacts.reactions["👍"]?.mine, false);

      // A short, deliberate gap so the second message's timestamp cannot tie
      // with the first's — `before` pagination is a strict string compare.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await store.appendChannelMessage({
        repositoryId: "repo_channel",
        projectId: DEFAULT_PROJECT_ID,
        authorId: bob.id,
        content: "Second message.",
      });
      const newestOnly = await store.listChannelMessages("repo_channel", alice.id, {
        limit: 1,
      });
      assert.equal(newestOnly.length, 1);
      assert.equal(newestOnly[0]?.id, second.id);
      const olderPage = await store.listChannelMessages("repo_channel", alice.id, {
        before: second.createdAt,
      });
      assert.deepEqual(
        olderPage.map((message) => message.id),
        [posted.id],
      );
      assert.equal(olderPage[0]?.replies.length, 1);

      assert.equal(
        await store.getChannelMessage("repo_channel", "chanmsg_missing", alice.id),
        undefined,
      );

      // Per-(repository, agent) overrides merge rather than replace: setting
      // just the model afterward must not clear the name set earlier.
      const named = await store.setChannelAgentOverride("repo_channel", "agent_1", {
        name: "Scout",
      });
      assert.equal(named.name, "Scout");
      assert.equal(named.model, undefined);
      const withModel = await store.setChannelAgentOverride(
        "repo_channel",
        "agent_1",
        { model: "opus" },
      );
      assert.equal(withModel.name, "Scout");
      assert.equal(withModel.model, "opus");
      // A role is just another field in the same merge — set independently,
      // and it must not disturb the name or model already there.
      const withRole = await store.setChannelAgentOverride(
        "repo_channel",
        "agent_1",
        { role: "Frontend Agent" },
      );
      assert.equal(withRole.name, "Scout");
      assert.equal(withRole.model, "opus");
      assert.equal(withRole.role, "Frontend Agent");
      const overrides = await store.listChannelAgentOverrides("repo_channel");
      assert.equal(overrides["agent_1"]?.name, "Scout");
      assert.equal(overrides["agent_1"]?.role, "Frontend Agent");
      assert.equal(Object.keys(overrides).length, 1);

      // Call signs: the account-wide name an agent answers to in every
      // channel, kept here so it outlives the control plane's local secrets
      // file — losing that file is what made every roster fall back to
      // "Claude (Nathan)" after a restart.
      assert.deepEqual(await store.listAgentCallSigns(), []);
      const dealt = await store.setAgentCallSign(alice.id, "anthropic", "Athena");
      assert.equal(dealt.callSign, "Athena");
      assert.equal(dealt.userId, alice.id);
      assert.equal(dealt.provider, "anthropic");
      await store.setAgentCallSign(bob.id, "openai", "Vesta");
      // Keyed by (user, provider): renaming replaces rather than duplicates.
      await store.setAgentCallSign(alice.id, "anthropic", "Icarus");
      const signs = await store.listAgentCallSigns();
      assert.equal(signs.length, 2);
      assert.equal(
        signs.find(
          (sign) => sign.userId === alice.id && sign.provider === "anthropic",
        )?.callSign,
        "Icarus",
      );
      // Clearing forgets it, so a name deliberately removed does not come
      // back on the next restart.
      await store.clearAgentCallSign(alice.id, "anthropic");
      const remaining = await store.listAgentCallSigns();
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0]?.callSign, "Vesta");
      await store.clearAgentCallSign(bob.id, "openai");
      assert.deepEqual(await store.listAgentCallSigns(), []);

      // Opt-in channel membership: empty until explicitly added, additions
      // are per (repository, user, provider), and removal is symmetric.
      assert.deepEqual(
        await store.listChannelAgentMembers("repo_channel"),
        [],
      );
      await store.setChannelAgentMember("repo_channel", alice.id, "anthropic", true);
      await store.setChannelAgentMember("repo_channel", bob.id, "openai", true);
      const members = await store.listChannelAgentMembers("repo_channel");
      assert.equal(members.length, 2);
      assert.ok(
        members.some(
          (member) => member.userId === alice.id && member.provider === "anthropic",
        ),
      );
      assert.ok(
        members.some(
          (member) => member.userId === bob.id && member.provider === "openai",
        ),
      );
      // Adding the same membership twice is not an error and does not
      // duplicate the row.
      await store.setChannelAgentMember("repo_channel", alice.id, "anthropic", true);
      assert.equal(
        (await store.listChannelAgentMembers("repo_channel")).length,
        2,
      );
      // Membership is scoped to its own repository.
      assert.deepEqual(
        await store.listChannelAgentMembers("repo_channel_other"),
        [],
      );
      await store.setChannelAgentMember("repo_channel", alice.id, "anthropic", false);
      const afterRemoval = await store.listChannelAgentMembers("repo_channel");
      assert.equal(afterRemoval.length, 1);
      assert.equal(afterRemoval[0]?.userId, bob.id);
      // Removing something never present is a harmless no-op.
      await store.setChannelAgentMember("repo_channel", alice.id, "google", false);

      // The one-time backfill flag is per repository and starts unset.
      assert.equal(
        await store.hasBackfilledChannelMembership("repo_channel"),
        false,
      );
      await store.markChannelMembershipBackfilled("repo_channel");
      assert.equal(
        await store.hasBackfilledChannelMembership("repo_channel"),
        true,
      );
      assert.equal(
        await store.hasBackfilledChannelMembership("repo_channel_other"),
        false,
      );
      // Marking it again is idempotent, not an error.
      await store.markChannelMembershipBackfilled("repo_channel");
      assert.equal(
        await store.hasBackfilledChannelMembership("repo_channel"),
        true,
      );

      // What a thread's work changed, kept with the thread.
      //
      // The line counts are the part worth a contract test: they were written
      // into the row and dropped on the way back out, so the thread rendered
      // them once from whatever the collector had returned and showed paths
      // alone from the next read onward. Only the SQL stores had the bug —
      // the in-memory one hands back the objects it was given — which is why
      // it needs asserting here, against every backend, rather than wherever
      // the summary is produced.
      await store.setChannelMessageTask("repo_channel", posted.id, "task_files");
      await store.setChannelMessageChangedFiles("repo_channel", posted.id, [
        { path: "src/engine.ts", status: "modified", added: 12, removed: 3 },
        // No counts at all: written before a run reported them, and it must
        // stay countless rather than become "+0 −0".
        { path: "src/old.ts", status: "deleted" },
      ]);
      const summarised = await store.getChannelMessage(
        "repo_channel",
        posted.id,
        alice.id,
      );
      assert.equal(summarised?.taskId, "task_files");
      assert.deepEqual(summarised?.changedFiles, [
        { path: "src/engine.ts", status: "modified", added: 12, removed: 3 },
        { path: "src/old.ts", status: "deleted" },
      ]);
      // And through the list route, which is how the channel actually reads.
      const listedSummary = (
        await store.listChannelMessages("repo_channel", alice.id, { limit: 50 })
      ).find((message) => message.id === posted.id);
      assert.equal(listedSummary?.changedFiles?.[0]?.added, 12);
      assert.equal(listedSummary?.changedFiles?.[0]?.removed, 3);
      // An empty summary is not a summary: a thread with nothing recorded
      // reads as "not computed yet" so the gateway's backfill can try again.
      await store.setChannelMessageChangedFiles("repo_channel", posted.id, []);
      assert.equal(
        (await store.getChannelMessage("repo_channel", posted.id, alice.id))
          ?.changedFiles,
        undefined,
      );

      // Read cursors are per (repository, user).
      assert.equal(
        await store.getChannelReadCursor("repo_channel", alice.id),
        undefined,
      );
      await store.markChannelRead(
        "repo_channel",
        alice.id,
        "2026-01-05T00:00:00.000Z",
      );
      assert.equal(
        await store.getChannelReadCursor("repo_channel", alice.id),
        "2026-01-05T00:00:00.000Z",
      );
      assert.equal(
        await store.getChannelReadCursor("repo_channel", bob.id),
        undefined,
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: a catch-up mark is personal and only moves forward`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const alice = await store.createUser({
        email: "catchup-alice@example.invalid",
        displayName: "Alice",
        passwordDigest: "unused",
      });
      const bob = await store.createUser({
        email: "catchup-bob@example.invalid",
        displayName: "Bob",
        passwordDigest: "unused",
      });

      // Somebody who has never been shown a catch-up has no mark, which is
      // what makes their first visit report nothing.
      assert.equal(
        await store.getCatchUpCursor(DEFAULT_PROJECT_ID, alice.id),
        undefined,
      );

      await store.markCatchUpSeen(
        DEFAULT_PROJECT_ID,
        alice.id,
        "2026-02-01T10:00:00.000Z",
      );
      assert.deepEqual(
        await store.getCatchUpCursor(DEFAULT_PROJECT_ID, alice.id),
        {
          projectId: DEFAULT_PROJECT_ID,
          userId: alice.id,
          seenAt: "2026-02-01T10:00:00.000Z",
        },
      );
      // One person's catch-up says nothing about anybody else's.
      assert.equal(
        await store.getCatchUpCursor(DEFAULT_PROJECT_ID, bob.id),
        undefined,
      );

      await store.markCatchUpSeen(
        DEFAULT_PROJECT_ID,
        alice.id,
        "2026-02-01T12:00:00.000Z",
      );
      assert.equal(
        (await store.getCatchUpCursor(DEFAULT_PROJECT_ID, alice.id))?.seenAt,
        "2026-02-01T12:00:00.000Z",
      );
      // A second tab finishing late must not drag the mark backwards, or the
      // same news is announced again on the next sign-in.
      await store.markCatchUpSeen(
        DEFAULT_PROJECT_ID,
        alice.id,
        "2026-02-01T11:00:00.000Z",
      );
      assert.equal(
        (await store.getCatchUpCursor(DEFAULT_PROJECT_ID, alice.id))?.seenAt,
        "2026-02-01T12:00:00.000Z",
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });
}
