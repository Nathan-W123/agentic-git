import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { CanonicalVersion, TaskDefinition } from "@coord/shared-types";

import { LATEST_SCHEMA_VERSION } from "./schema.js";
import { SqliteCoordinationStore } from "./sqlite-store.js";

const REPOSITORY = { id: "repo_1", path: "/canonical.git", branch: "main" };

const BASE_VERSION: CanonicalVersion = {
  sequence: 1,
  revision: "a".repeat(40),
  branch: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const TASK: TaskDefinition = {
  id: "task_1",
  objective: "Do the thing",
  agentId: "agent",
  validationCommands: [],
};

async function withDatabase(
  run: (databasePath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-sqlite-"));
  try {
    await run(path.join(root, "nested", "coordination.db"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("state survives closing and reopening the database", async () => {
  await withDatabase(async (databasePath) => {
    const first = SqliteCoordinationStore.open(databasePath);
    const run = await first.createRun({
      repository: REPOSITORY,
      mode: "coordinated",
      scenario: "overlap",
      baseVersion: BASE_VERSION,
    });
    await first.saveTask(run.id, TASK);
    await first.appendAudit(run.id, { type: "task_submitted", taskId: TASK.id });
    await first.finishRun(run.id, "completed", BASE_VERSION);
    await first.close();

    // A separate store instance stands in for a separate process.
    const second = SqliteCoordinationStore.open(databasePath);
    try {
      const runs = await second.listRuns();
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.id, run.id);

      const detail = await second.getRun(run.id);
      assert.equal(detail?.tasks[0]?.id, TASK.id);
      assert.equal(detail?.audit.length, 1);
      assert.equal((await second.verifyAudit()).valid, true);
    } finally {
      await second.close();
    }
  });
});

test("the parent directory is created when missing", async () => {
  await withDatabase(async (databasePath) => {
    const store = SqliteCoordinationStore.open(databasePath);
    await store.close();
    // Opening again proves the file, not just the directory, was created.
    const reopened = SqliteCoordinationStore.open(databasePath);
    assert.deepEqual(await reopened.listRuns(), []);
    await reopened.close();
  });
});

test("migrations apply once and are idempotent across opens", async () => {
  await withDatabase(async (databasePath) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const store = SqliteCoordinationStore.open(databasePath);
      await store.close();
    }

    const db = new DatabaseSync(databasePath);
    try {
      const rows = db.prepare("SELECT version FROM schema_version").all();
      assert.equal(rows.length, LATEST_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});

test("a database from a newer build is refused rather than downgraded", async () => {
  await withDatabase(async (databasePath) => {
    const store = SqliteCoordinationStore.open(databasePath);
    await store.close();

    const db = new DatabaseSync(databasePath);
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(
      LATEST_SCHEMA_VERSION + 5,
    );
    db.close();

    assert.throws(
      () => SqliteCoordinationStore.open(databasePath),
      /newer than this build understands/u,
    );
  });
});

test("audit events cannot be edited, or deleted without a checkpoint", async () => {
  await withDatabase(async (databasePath) => {
    const store = SqliteCoordinationStore.open(databasePath);
    const run = await store.createRun({
      repository: REPOSITORY,
      mode: "coordinated",
      baseVersion: BASE_VERSION,
    });
    await store.appendAudit(run.id, { type: "task_submitted", taskId: TASK.id });
    await store.close();

    const db = new DatabaseSync(databasePath);
    try {
      assert.throws(
        () => db.exec("UPDATE audit_events SET type = 'task_failed'"),
        /append-only/u,
      );
      // Deletion is no longer barred outright — retention needs a way out —
      // but only below a checkpoint, and none has been written here.
      assert.throws(
        () => db.exec("DELETE FROM audit_events"),
        /may only be pruned below a recorded checkpoint/u,
      );
      const remaining = db
        .prepare("SELECT COUNT(*) AS total FROM audit_events")
        .get() as { total: number };
      assert.equal(Number(remaining.total), 1);
    } finally {
      db.close();
    }
  });
});

/**
 * The triggers stop in-place edits, but anyone who can write the file can drop
 * and rebuild the table. The chain is what makes that detectable.
 */
test("rebuilding the audit table without the chain is detected", async () => {
  await withDatabase(async (databasePath) => {
    const store = SqliteCoordinationStore.open(databasePath);
    const run = await store.createRun({
      repository: REPOSITORY,
      mode: "coordinated",
      baseVersion: BASE_VERSION,
    });
    await store.appendAudit(run.id, { type: "task_submitted", taskId: TASK.id });
    await store.appendAudit(run.id, { type: "plan_received", taskId: TASK.id });
    await store.appendAudit(run.id, { type: "canonical_promoted", taskId: TASK.id });
    assert.equal((await store.verifyAudit()).valid, true);
    await store.close();

    const db = new DatabaseSync(databasePath);
    try {
      // Stand in for an attacker with file access: remove the guard entirely
      // and cut an event out of the middle, where no checkpoint would ever
      // have allowed it.
      db.exec("DROP TRIGGER audit_events_prune_guard");
      db.exec("DELETE FROM audit_events WHERE type = 'plan_received'");
    } finally {
      db.close();
    }

    const reopened = SqliteCoordinationStore.open(databasePath);
    try {
      const verification = await reopened.verifyAudit();
      assert.equal(verification.valid, false);
      if (verification.valid) {
        return;
      }
      assert.match(verification.reason, /removed, reordered, or inserted/u);
    } finally {
      await reopened.close();
    }
  });
});

test("concurrent stores on one file share a single audit chain", async () => {
  await withDatabase(async (databasePath) => {
    const first = SqliteCoordinationStore.open(databasePath);
    const second = SqliteCoordinationStore.open(databasePath);
    try {
      const run = await first.createRun({
        repository: REPOSITORY,
        mode: "coordinated",
        baseVersion: BASE_VERSION,
      });
      await first.appendAudit(run.id, { type: "task_submitted" });
      await second.appendAudit(run.id, { type: "plan_received" });
      await first.appendAudit(run.id, { type: "canonical_promoted" });

      const verification = await second.verifyAudit();
      assert.equal(verification.valid, true);
      assert.equal(verification.events, 3);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
