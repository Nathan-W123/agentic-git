import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBenchmark } from "./benchmark.js";
import { DEPENDENCY_SCENARIO, TASK_BOXED } from "./scenarios.js";

test("dependency coordination replans a cross-file consumer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-dependency-test-"));

  try {
    const report = await runBenchmark(root, { scenario: DEPENDENCY_SCENARIO });

    assert.equal(report.coordinated.conflictWarnings, 1);
    assert.equal(report.coordinated.tasksCompleted, 2);
    assert.equal(report.coordinated.completionRate, 1);
    assert.equal(report.coordinated.integrationFailures, 0);
    assert.equal(report.coordinated.undetectedConflicts, 0);

    // The baseline starts the consumer from stale canonical, fails once, then
    // rebuilds it against the producer's accepted contract.
    assert.equal(report.uncoordinated.tasksCompleted, 2);
    assert.equal(report.uncoordinated.reworkCount, 1);
    assert.equal(report.uncoordinated.undetectedConflicts, 0);
    assert.equal(report.uncoordinated.integrationAttempts, 3);
    assert.equal(report.reworkAvoided, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the dependency scenario pins the producer before its consumer", () => {
  assert.equal(DEPENDENCY_SCENARIO.knownUndetectedConflicts, undefined);
  assert.equal(DEPENDENCY_SCENARIO.tasks[0]?.task.id, TASK_BOXED.id);
  assert.deepEqual(
    DEPENDENCY_SCENARIO.tasks[1]?.behavior.plan.dependencies,
    ["symbol:increment"],
  );
});
