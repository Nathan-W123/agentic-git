import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBenchmark } from "./benchmark.js";
import { DEPENDENCY_SCENARIO, TASK_BOXED, TASK_TOTAL } from "./scenarios.js";

test("file-level detection misses a cross-file dependency conflict", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-dependency-test-"));

  try {
    const report = await runBenchmark(root, { scenario: DEPENDENCY_SCENARIO });

    // The two tasks touch disjoint files, so nothing is predicted.
    assert.equal(report.coordinated.conflictWarnings, 0);

    // The signature change lands; the new caller applies cleanly and then
    // fails validation. Coordination does not help, and the metric says so
    // rather than reporting a clean run.
    assert.equal(report.coordinated.tasksCompleted, 1);
    assert.equal(report.coordinated.completionRate, 0.5);
    assert.equal(report.coordinated.integrationFailures, 1);
    assert.equal(report.coordinated.undetectedConflicts, 1);

    // The baseline burns an extra attempt replaying work that cannot succeed.
    assert.equal(report.uncoordinated.tasksCompleted, 1);
    assert.equal(report.uncoordinated.reworkCount, 1);
    assert.equal(report.uncoordinated.undetectedConflicts, 1);
    assert.equal(report.uncoordinated.integrationAttempts, 3);
    assert.equal(report.reworkAvoided, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the dependency scenario documents which task cannot be predicted", () => {
  assert.deepEqual(
    Object.keys(DEPENDENCY_SCENARIO.knownUndetectedConflicts ?? {}),
    [TASK_TOTAL.id],
  );
  // Integration order decides which side of the pair fails, so the scenario
  // pins the signature change first.
  assert.equal(DEPENDENCY_SCENARIO.tasks[0]?.task.id, TASK_BOXED.id);
});
