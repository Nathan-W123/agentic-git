import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBenchmark, runCoordinatedFixture } from "./benchmark.js";
import { createBenchmarkFixture } from "./fixture.js";
import {
  MIXED_SCENARIO,
  TASK_CAP,
  TASK_CONFIG,
  TASK_FLOOR,
  TASK_FORMAT,
  TASK_NORMALIZE,
} from "./scenarios.js";

test("a three-way collision is sequenced without serializing independent work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-mixed-test-"));

  try {
    const fixture = await createBenchmarkFixture(root, "mixed", {
      scenario: MIXED_SCENARIO,
    });
    const result = await runCoordinatedFixture(fixture);

    // normalize, cap, and floor pairwise overlap on src/counter.js.
    assert.equal(result.metrics.conflictWarnings, 3);
    assert.equal(result.metrics.tasksCompleted, 5);
    assert.equal(result.metrics.completionRate, 1);
    assert.equal(result.metrics.integrationFailures, 0);
    assert.equal(result.metrics.undetectedConflicts, 0);

    // The two independent tasks are approved immediately; the later counter
    // tasks are queued behind whichever took file ownership first.
    const decisions = new Map(
      result.run.tasks.map((entry) => [entry.task.id, entry.decision]),
    );
    assert.equal(decisions.get(TASK_NORMALIZE.id)?.decision, "approved");
    assert.equal(decisions.get(TASK_FORMAT.id)?.decision, "approved");
    assert.equal(decisions.get(TASK_CONFIG.id)?.decision, "approved");
    assert.equal(decisions.get(TASK_CAP.id)?.decision, "queued");
    assert.equal(decisions.get(TASK_FLOOR.id)?.decision, "queued");
    assert.deepEqual(decisions.get(TASK_FLOOR.id)?.blockedBy, [
      TASK_NORMALIZE.id,
      TASK_CAP.id,
    ]);

    // All three counter edits compose, in plan order, on the final revision.
    const counter = await fixture.repositories.readFile(
      fixture.repository,
      result.run.canonicalVersion.revision,
      "src/counter.js",
    );
    assert.match(
      counter,
      /return Math\.max\(Math\.min\(Number\(value\) \+ 1, 10\), 0\);/u,
    );

    const format = await fixture.repositories.readFile(
      fixture.repository,
      result.run.canonicalVersion.revision,
      "src/format.js",
    );
    assert.match(format, /count: \$\{value\}/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the mixed scenario shows coordination removing rework at scale", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-mixed-bench-"));

  try {
    const report = await runBenchmark(root, { scenario: MIXED_SCENARIO });

    assert.equal(report.scenario, "mixed");
    assert.equal(report.coordinated.tasksPlanned, 5);
    assert.equal(report.coordinated.tasksCompleted, 5);
    assert.equal(report.coordinated.reworkCount, 0);
    assert.equal(report.coordinated.integrationAttempts, 5);

    // Two of the three counter tasks build a patch against a stale revision.
    assert.equal(report.uncoordinated.tasksCompleted, 5);
    assert.equal(report.uncoordinated.reworkCount, 2);
    assert.equal(report.uncoordinated.integrationAttempts, 7);
    assert.equal(report.reworkAvoided, 2);
    assert.equal(report.uncoordinated.reworkRate, 0.4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
