import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteCoordinationStore } from "@coord/persistence";

import { runCoordinatedFixture } from "./benchmark.js";
import { createBenchmarkFixture } from "./fixture.js";
import { OVERLAP_SCENARIO, TASK_CAP, TASK_NORMALIZE } from "./scenarios.js";

test("a coordinated run is recorded and survives reopening the store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-persist-"));
  const databasePath = path.join(root, "state", "coordination.db");

  try {
    const fixture = await createBenchmarkFixture(root, "persisted", {
      scenario: OVERLAP_SCENARIO,
    });

    const store = SqliteCoordinationStore.open(databasePath);
    let runId: string;
    try {
      const result = await runCoordinatedFixture(fixture, { store });
      assert.equal(result.metrics.tasksCompleted, 2);
      runId = (await store.listRuns())[0]?.id ?? "";
      assert.notEqual(runId, "");
    } finally {
      await store.close();
    }

    // A second store instance stands in for a later process.
    const reopened = SqliteCoordinationStore.open(databasePath);
    try {
      const detail = await reopened.getRun(runId);
      assert.ok(detail !== undefined);

      assert.equal(detail.run.status, "completed");
      assert.equal(detail.run.scenario, "overlap");
      assert.notEqual(detail.run.finalRevision, detail.run.baseRevision);

      // Both tasks, their plans, and the sequencing decision are recorded.
      assert.deepEqual(
        detail.tasks.map((task) => task.id).sort(),
        [TASK_CAP.id, TASK_NORMALIZE.id].sort(),
      );
      for (const task of detail.tasks) {
        assert.equal(task.status, "integrated");
        assert.ok(task.plan !== undefined, `${task.id} has no plan`);
        assert.ok(task.sessionId !== undefined, `${task.id} has no session`);
      }
      const capped = detail.tasks.find((task) => task.id === TASK_CAP.id);
      assert.equal(capped?.decision?.decision, "queued");
      assert.deepEqual(capped?.decision?.blockedBy, [TASK_NORMALIZE.id]);

      // The overlap that caused the sequencing is preserved as evidence.
      assert.equal(detail.conflicts.length, 1);
      assert.deepEqual(detail.conflicts[0]?.evidence[0]?.resources, [
        "src/counter.js",
      ]);

      // Changesets keep their patch text, so a diff review needs no worktree.
      assert.equal(detail.changeSets.length, 2);
      for (const changeSet of detail.changeSets) {
        assert.ok(changeSet.patches.length > 0);
        assert.ok(changeSet.patches.every((patch) => patch.patch.length > 0));
      }

      assert.equal(detail.integrations.length, 2);
      assert.ok(
        detail.integrations.every((entry) => entry.status === "integrated"),
      );
      // Each integration records the distinct base it was attempted against.
      const bases = detail.integrations.map(
        (entry) => entry.previousVersion.revision,
      );
      assert.equal(new Set(bases).size, 2);

      assert.ok(detail.workspaces.length >= 2);
      assert.ok(detail.leases.length >= 2);

      const verification = await reopened.verifyAudit();
      assert.equal(verification.valid, true);
      assert.ok(verification.events > 10);
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run without a store behaves exactly as before", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-nopersist-"));
  try {
    const fixture = await createBenchmarkFixture(root, "unpersisted", {
      scenario: OVERLAP_SCENARIO,
    });
    const result = await runCoordinatedFixture(fixture);

    assert.equal(result.metrics.tasksCompleted, 2);
    assert.equal(result.run.conflicts.length, 1);
    assert.ok(result.run.audit.length > 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
