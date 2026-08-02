import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { SqliteCoordinationStore } from "./sqlite-store.js";
import { DEFAULT_ORGANIZATION_ID, type CoordinationStore } from "./store.js";

/**
 * Work assignment when several worker daemons share one database.
 *
 * The multi-device model has workers on separate machines polling the same
 * coordination store. Two workers receiving the same task would mean the same
 * change produced twice, integrated twice, and billed twice — and the failure
 * is silent, because both workers succeed.
 *
 * `leaseNextTask` claims the task and issues the lease in one transaction, and
 * a partial unique index makes a second active lease per task unrepresentable.
 * Neither guarantee is exercised by single-process tests, which never contend.
 * These tests use real processes against one SQLite file.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE_ENTRY = path.join(HERE, "index.js").split(path.sep).join("/");
const run = promisify(execFile);

/**
 * One worker process: leases until the queue is empty, reporting what it got.
 *
 * Draining rather than taking a single task is what makes a duplicate visible.
 * With one lease each, a bug that hands the same task to two workers could hide
 * behind the queue simply being longer than the worker count.
 */
const WORKER_SOURCE = `
import { SqliteCoordinationStore } from ${JSON.stringify(`file:///${STORE_ENTRY}`)};

const [databasePath, workerId, baseRevision, startAtRaw] = process.argv.slice(2);
const startAt = Number(startAtRaw);

const store = SqliteCoordinationStore.open(databasePath);
const leased = [];

while (Date.now() < startAt) {
  // Spin so every worker enters the loop within the same millisecond or two.
}

try {
  for (;;) {
    const work = await store.leaseNextTask({
      workerId,
      baseRevision,
      ttlMs: 60000,
    });
    if (work === undefined) {
      break;
    }
    leased.push({ taskId: work.task.id, leaseId: work.lease.id });
  }
  process.stdout.write(JSON.stringify({ workerId, leased }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      workerId,
      leased,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
} finally {
  await store.close();
}
`;

interface WorkerResult {
  workerId: string;
  leased: { taskId: string; leaseId: string }[];
  error?: string;
}

interface Harness {
  root: string;
  databasePath: string;
  store: CoordinationStore;
  repositoryId: string;
  /** Registers a worker and returns its id; leases carry a foreign key to it. */
  addWorker: (name: string) => Promise<string>;
  cleanup: () => Promise<void>;
}

const BASE_REVISION = "c".repeat(40);

async function createHarness(taskCount: number): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-lease-"));
  const databasePath = path.join(root, "coordination.db");
  const store = SqliteCoordinationStore.open(databasePath);

  const owner = await store.createUser({
    email: "owner@example.invalid",
    displayName: "Owner",
    passwordDigest: "unused",
  });

  const repositoryId = "repo_shared";
  await store.saveRepository({
    id: repositoryId,
    path: path.join(root, "canonical.git"),
    branch: "main",
  });

  for (let index = 0; index < taskCount; index += 1) {
    await store.submitTask({
      repositoryId,
      objective: `queued objective ${index}`,
      agentId: "codex",
      validationCommands: [
        { executable: "node", args: ["--test"], label: "repository tests" },
      ],
    });
  }

  return {
    root,
    databasePath,
    store,
    repositoryId,
    addWorker: async (name) => {
      const worker = await store.registerWorker({
        userId: owner.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name,
        adapters: ["codex"],
        version: "0.1.0",
      });
      return worker.id;
    },
    cleanup: async () => {
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function raceWorkers(
  harness: Harness,
  workerCount: number,
): Promise<WorkerResult[]> {
  const workerPath = path.join(harness.root, "worker.mjs");
  await writeFile(workerPath, WORKER_SOURCE, "utf8");
  const startAt = Date.now() + 1500 + workerCount * 250;

  const workerIds = await Promise.all(
    Array.from({ length: workerCount }, async (_unused, index) =>
      await harness.addWorker(`racer-${index}`),
    ),
  );

  return await Promise.all(
    workerIds.map(async (workerId) => {
      const { stdout, stderr } = await run(
        process.execPath,
        [
          workerPath,
          harness.databasePath,
          workerId,
          BASE_REVISION,
          String(startAt),
        ],
        { timeout: 60_000 },
      );
      assert.ok(stdout.trim().length > 0, `worker produced no result: ${stderr}`);
      return JSON.parse(stdout.trim()) as WorkerResult;
    }),
  );
}

test("concurrent workers never receive the same queued task twice", async () => {
  const taskCount = 12;
  const harness = await createHarness(taskCount);
  try {
    const results = await raceWorkers(harness, 4);

    for (const result of results) {
      assert.equal(
        result.error,
        undefined,
        `${result.workerId} failed to lease: ${result.error}`,
      );
    }

    const assignments = results.flatMap((result) => result.leased);

    // The whole point: no task appears in two workers' lists.
    const taskIds = assignments.map((entry) => entry.taskId);
    assert.equal(
      new Set(taskIds).size,
      taskIds.length,
      `a task was leased more than once: ${JSON.stringify(taskIds)}`,
    );

    // And nothing was dropped — contention must not lose work either.
    assert.equal(taskIds.length, taskCount);
    assert.equal(new Set(assignments.map((entry) => entry.leaseId)).size, taskCount);

    // Every task is now claimed rather than pending.
    const pending = await harness.store.listSubmittedTasks({
      repositoryId: harness.repositoryId,
      status: "submitted",
    });
    assert.equal(pending.length, 0);

    const active = await harness.store.listWorkLeases({ status: "active" });
    assert.equal(active.length, taskCount);
  } finally {
    await harness.cleanup();
  }
});

test("an expired lease returns its task to exactly one other worker", async () => {
  const harness = await createHarness(1);
  try {
    // A worker on one device takes the task, then its machine dies.
    const first = await harness.store.leaseNextTask({
      workerId: await harness.addWorker("lost"),
      baseRevision: BASE_REVISION,
      ttlMs: 1,
    });
    assert.ok(first !== undefined);

    // Nothing is available while the lease is still held.
    const blocked = await harness.store.leaseNextTask({
      workerId: await harness.addWorker("other"),
      baseRevision: BASE_REVISION,
      ttlMs: 60_000,
    });
    assert.equal(blocked, undefined);

    const expired = await harness.store.expireWorkLeases(
      new Date(Date.now() + 60_000).toISOString(),
    );
    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.status, "expired");

    // Requeued, and still only claimable once even under contention.
    const results = await raceWorkers(harness, 3);
    const assignments = results.flatMap((result) => result.leased);
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0]?.taskId, first.task.id);
  } finally {
    await harness.cleanup();
  }
});

test("a task cancelled between poll and lease is not handed out", async () => {
  const harness = await createHarness(2);
  try {
    const queued = await harness.store.listSubmittedTasks({
      repositoryId: harness.repositoryId,
    });
    assert.equal(queued.length, 2);
    const doomed = queued[0];
    assert.ok(doomed !== undefined);

    await harness.store.cancelSubmittedTask(doomed.id);

    const results = await raceWorkers(harness, 3);
    const taskIds = results.flatMap((result) =>
      result.leased.map((entry) => entry.taskId),
    );
    assert.equal(taskIds.length, 1);
    assert.ok(!taskIds.includes(doomed.id));
  } finally {
    await harness.cleanup();
  }
});

test("the default organization is present for a freshly opened shared database", async () => {
  const harness = await createHarness(0);
  try {
    // Workers on other devices open the same file without running setup; the
    // schema migration has to leave it usable on its own.
    const organization = await harness.store.getOrganization(
      DEFAULT_ORGANIZATION_ID,
    );
    assert.ok(organization !== undefined);
  } finally {
    await harness.cleanup();
  }
});
