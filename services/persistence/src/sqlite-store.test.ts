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

/**
 * SQLite refuses a statement carrying more than 32765 bound parameters, and
 * the prefix check used to name every event it was archiving. The limit is
 * therefore a ceiling on how much history can ever be retired — and it is the
 * busiest log, the one that most needs archiving, that hits it first.
 */
test("an audit prefix larger than SQLite's parameter limit still archives", async () => {
  const store = SqliteCoordinationStore.open(":memory:");
  try {
    const run = await store.createRun({
      repository: REPOSITORY,
      mode: "coordinated",
      baseVersion: BASE_VERSION,
    });
    // One past the driver's parameter ceiling, which is where the old check
    // stopped being expressible at all.
    const events = 32_766;
    for (let index = 0; index < events; index += 1) {
      await store.appendAudit(run.id, { type: "task_submitted" });
    }

    const archived = await store.archiveAuditEvents({ throughSequence: events });
    assert.equal(archived?.events.length, events);
    assert.equal(archived?.checkpoint.events, events);
    assert.equal(archived?.checkpoint.throughSequence, events);
    // The chain still verifies across the checkpoint, which is the whole
    // point of archiving rather than deleting.
    assert.equal((await store.verifyAudit()).valid, true);
    assert.deepEqual(await store.listAuditEvents(), []);
  } finally {
    await store.close();
  }
});

/**
 * SQLite takes text as a NUL-terminated C string, so a string with a NUL in
 * it used to be stored up to that point while the very same call handed the
 * caller back the whole string it passed in. The truncation only surfaced on
 * the next read, with nothing left to recover the lost tail from.
 */
test("text carrying a NUL is refused rather than quietly truncated", async () => {
  const store = SqliteCoordinationStore.open(":memory:");
  try {
    const organization = await store.createOrganization({
      slug: "acme",
      name: "Acme",
    });
    const project = await store.createProject({
      organizationId: organization.id,
      slug: "web",
      name: "Web",
    });
    const author = await store.createUser({
      email: "author@example.com",
      displayName: "Author",
      passwordDigest: "digest",
    });
    const reader = await store.createUser({
      email: "reader@example.com",
      displayName: "Reader",
      passwordDigest: "digest",
    });

    await assert.rejects(
      store.appendDirectMessage({
        projectId: project.id,
        authorId: author.id,
        recipientId: reader.id,
        content: "before\u0000after",
      }),
      /NUL character/u,
    );
    // Nothing was written, so nobody is left holding half a sentence.
    assert.deepEqual(
      await store.listDirectMessages(project.id, author.id, reader.id),
      [],
    );

    // Everything else Unicode can hold still round-trips untouched.
    const emoji = await store.appendDirectMessage({
      projectId: project.id,
      authorId: author.id,
      recipientId: reader.id,
      content: "ship it \u{1F680} café слово",
    });
    const [stored] = await store.listDirectMessages(
      project.id,
      author.id,
      reader.id,
    );
    assert.equal(stored?.content, emoji.content);
  } finally {
    await store.close();
  }
});

/**
 * An empty path is SQLite's request for a private database that is deleted
 * when the connection closes. Every write would be accepted and reported as
 * saved, and the whole store would be gone at shutdown without one error
 * anywhere — which is what a blank configured path used to produce.
 */
test("an empty database path is refused rather than opened as a scratch database", () => {
  assert.throws(
    () => SqliteCoordinationStore.open(""),
    /needs a path/u,
  );
  assert.throws(
    () => SqliteCoordinationStore.open("   "),
    /needs a path/u,
  );
});

/**
 * The sweep used to answer with how much smaller the table got, which is a
 * different number from how many credentials it removed as soon as anything
 * else is writing. The caller reports this figure as tokens expired.
 */
test("expiring tokens counts what the sweep deleted, not how much the table shrank", async () => {
  await withDatabase(async (databasePath) => {
    const store = SqliteCoordinationStore.open(databasePath);
    const user = await store.createUser({
      email: "owner@example.com",
      displayName: "Owner",
      passwordDigest: "digest",
    });
    for (const id of ["tok_first", "tok_second"]) {
      await store.createApiToken({
        id,
        userId: user.id,
        organizationId: undefined,
        name: id,
        secretHash: "hash",
        scopes: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBySession: undefined,
        createdByToken: undefined,
        editorVendor: undefined,
        expiresAt: "2026-02-01T00:00:00.000Z",
        lastUsedAt: undefined,
        lastUsedIp: undefined,
        revokedAt: undefined,
        revokedReason: undefined,
      });
    }
    await store.close();

    // Stands in for another process minting a token while the sweep runs: for
    // every row the delete removes, one appears. The table is exactly as big
    // afterwards as it was before, so a before-and-after count reads zero.
    const db = new DatabaseSync(databasePath);
    db.exec(
      `CREATE TRIGGER api_tokens_replace AFTER DELETE ON api_tokens
       BEGIN
         INSERT INTO api_tokens
           (id, user_id, name, secret_hash, scopes_json, created_at, expires_at)
         VALUES ('replacement_' || old.id, old.user_id, old.name, old.secret_hash,
                 '[]', old.created_at, NULL);
       END`,
    );
    db.close();

    const reopened = SqliteCoordinationStore.open(databasePath);
    try {
      assert.equal(
        await reopened.deleteExpiredApiTokens("2026-06-01T00:00:00.000Z"),
        2,
      );
      // And the expired pair really is gone, whatever else arrived.
      assert.equal(await reopened.getApiToken("tok_first"), undefined);
      assert.equal(await reopened.getApiToken("tok_second"), undefined);
    } finally {
      await reopened.close();
    }
  });
});

/**
 * A JSON column read as a list used to be a cast and nothing more, so a column
 * holding an object came back typed as an array and failed at whatever `.map`
 * or `.includes` touched it next — a service away from the row that was wrong.
 * An unreadable column is an unknown, and an unknown must not arrive as an
 * empty list either: "this worker supports no adapters" is an answer.
 */
test("a list column holding something else is reported, not handed back as a list", async () => {
  await withDatabase(async (databasePath) => {
    const store = SqliteCoordinationStore.open(databasePath);
    const organization = await store.createOrganization({
      slug: "acme",
      name: "Acme",
    });
    const user = await store.createUser({
      email: "worker@example.com",
      displayName: "Worker",
      passwordDigest: "digest",
    });
    const worker = await store.registerWorker({
      userId: user.id,
      organizationId: organization.id,
      name: "laptop",
      adapters: ["claude"],
      version: "1.0.0",
    });
    await store.close();

    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE workers SET adapters_json = ? WHERE id = ?").run(
      '{"claude":true}',
      worker.id,
    );
    db.close();

    const reopened = SqliteCoordinationStore.open(databasePath);
    try {
      await assert.rejects(
        reopened.getWorker(worker.id),
        /adapters_json.*JSON array/su,
      );
      // Unreadable JSON says which column too, rather than a bare parser
      // complaint that names no row and no table.
      const broken = new DatabaseSync(databasePath);
      broken.prepare("UPDATE workers SET adapters_json = ? WHERE id = ?").run(
        "not json",
        worker.id,
      );
      broken.close();
      await assert.rejects(
        reopened.listWorkers(),
        /adapters_json does not hold readable JSON/u,
      );
    } finally {
      await reopened.close();
    }
  });
});

/**
 * A hold is a promise about a window of time. Zero or less wrote one that had
 * already lapsed — indistinguishable, on the next read, from nobody editing
 * the file at all — and a lifetime past the representable range surfaced as a
 * bare "Invalid time value" thrown from inside the store.
 */
test("an editor hold needs a lifetime it can honour", async () => {
  const store = SqliteCoordinationStore.open(":memory:");
  try {
    for (const ttlMs of [0, -1_000, Number.NaN, 1.5]) {
      await assert.rejects(
        store.holdEditorFile({
          repositoryId: REPOSITORY.id,
          userId: "user_1",
          file: "src/index.ts",
          ttlMs,
        }),
        RangeError,
      );
    }
    await assert.rejects(
      store.holdEditorFile({
        repositoryId: REPOSITORY.id,
        userId: "user_1",
        file: "src/index.ts",
        ttlMs: Number.MAX_SAFE_INTEGER,
      }),
      /too large/u,
    );
    // Nothing was taken, so the file still reads as unheld.
    assert.deepEqual(await store.listEditorHolds(REPOSITORY.id), []);

    const hold = await store.holdEditorFile({
      repositoryId: REPOSITORY.id,
      userId: "user_1",
      file: "src/index.ts",
      ttlMs: 60_000,
    });
    assert.ok(hold.expiresAt > hold.acquiredAt);
    assert.equal((await store.listEditorHolds(REPOSITORY.id)).length, 1);
  } finally {
    await store.close();
  }
});

/**
 * `LIMIT -1` is SQLite for "no limit", so a page size that came out of an
 * arithmetic slip used to hand back the entire conversation instead of the
 * tail of it — the largest possible answer to a request for the smallest.
 */
test("a negative page size is refused rather than read as unbounded", async () => {
  const store = SqliteCoordinationStore.open(":memory:");
  try {
    const organization = await store.createOrganization({
      slug: "acme",
      name: "Acme",
    });
    const project = await store.createProject({
      organizationId: organization.id,
      slug: "web",
      name: "Web",
    });
    const author = await store.createUser({
      email: "author@example.com",
      displayName: "Author",
      passwordDigest: "digest",
    });
    const reader = await store.createUser({
      email: "reader@example.com",
      displayName: "Reader",
      passwordDigest: "digest",
    });
    for (let index = 0; index < 4; index += 1) {
      await store.appendDirectMessage({
        projectId: project.id,
        authorId: author.id,
        recipientId: reader.id,
        content: `message ${index}`,
      });
    }

    for (const limit of [-1, -25, 1.5, Number.NaN]) {
      await assert.rejects(
        store.listDirectMessages(project.id, author.id, reader.id, { limit }),
        RangeError,
      );
    }
    // An absent limit still means the whole conversation, and a real one
    // still pages.
    assert.equal(
      (await store.listDirectMessages(project.id, author.id, reader.id)).length,
      4,
    );
    // A real limit still pages — `at least`, because a page takes in the
    // whole of its boundary group rather than cutting inside one position
    // and leaving the rest of that group on no page at all. Four messages
    // written in a loop share a millisecond, so this page is all four:
    // `limit` is a page size, not a hard count. See `DirectMessageFilter`.
    const paged = await store.listDirectMessages(
      project.id,
      author.id,
      reader.id,
      { limit: 2 },
    );
    assert.ok(paged.length >= 2, "a limit of two is at least two");

    await assert.rejects(
      store.listMcpSessions(author.id, { limit: -1 }),
      RangeError,
    );
  } finally {
    await store.close();
  }
});
