import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  reportedUsage,
  runBenchmark,
  runCoordinatedFixture,
} from "./benchmark.js";
import { createBenchmarkFixture } from "./fixture.js";
import { OVERLAP_SCENARIO } from "./scenarios.js";

test("coordination avoids one stale-patch rework cycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-benchmark-test-"));

  try {
    const report = await runBenchmark(root, { scenario: OVERLAP_SCENARIO });
    assert.equal(report.scenario, "overlap");
    assert.equal(report.coordinated.tasksCompleted, 2);
    assert.equal(report.coordinated.reworkCount, 0);
    assert.equal(report.coordinated.integrationFailures, 0);
    assert.equal(report.coordinated.conflictWarnings, 1);
    assert.equal(report.uncoordinated.tasksCompleted, 2);
    assert.equal(report.uncoordinated.reworkCount, 1);
    assert.equal(report.uncoordinated.integrationAttempts, 3);
    assert.equal(report.reworkAvoided, 1);
    assert.equal(report.coordinated.completionRate, 1);
    assert.equal(report.uncoordinated.completionRate, 1);
    assert.equal(report.uncoordinated.reworkRate, 0.5);
    assert.equal(report.reworkRateAvoided, 0.5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the coordinated canonical result contains both task intents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-result-test-"));

  try {
    const fixture = await createBenchmarkFixture(root, "combined", {
      scenario: OVERLAP_SCENARIO,
    });
    const result = await runCoordinatedFixture(fixture);
    const source = await fixture.repositories.readFile(
      fixture.repository,
      result.run.canonicalVersion.revision,
      "src/counter.js",
    );
    assert.match(source, /return Math\.min\(Number\(value\) \+ 1, 10\);/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("any adapter that accounts for its spend is counted, not just Codex", () => {
  // This was `instanceof CodexAdapter`, so a Claude-driven benchmark reported
  // no tokens — not because none were spent but because nothing asked. The
  // two adapters also name the figure differently: Codex counts `tokens`,
  // prompt-cli totals its breakdown as `totalTokens`.
  const codexShaped = {
    allTokenUsage: () => [
      { taskId: "t1", phase: "planning", tokens: 120 },
      { taskId: "t1", phase: "execution", tokens: 900 },
    ],
  } as unknown as Parameters<typeof reportedUsage>[0];
  assert.deepEqual(reportedUsage(codexShaped), [
    { taskId: "t1", phase: "planning", tokens: 120 },
    { taskId: "t1", phase: "execution", tokens: 900 },
  ]);

  const promptCliShaped = {
    allTokenUsage: () => [
      { taskId: "t2", phase: "planning", totalTokens: 40, inputTokens: 30 },
    ],
  } as unknown as Parameters<typeof reportedUsage>[0];
  assert.deepEqual(reportedUsage(promptCliShaped), [
    { taskId: "t2", phase: "planning", tokens: 40 },
  ]);

  // A scripted adapter reports nothing, and must keep reporting nothing —
  // "0 tokens" for a fixture that costs nothing reads as a measurement rather
  // than as silence, which is the distinction `tokenMetrics` rests on.
  const scripted = {} as unknown as Parameters<typeof reportedUsage>[0];
  assert.deepEqual(reportedUsage(scripted), []);

  // Malformed rows are dropped rather than counted as zero or NaN.
  const noisy = {
    allTokenUsage: () => [
      { taskId: "t3", phase: "planning" },
      { taskId: "t3", phase: "execution", tokens: Number.NaN },
      { phase: "execution", tokens: 5 },
      { taskId: "t3", phase: "execution", tokens: 7 },
    ],
  } as unknown as Parameters<typeof reportedUsage>[0];
  assert.deepEqual(reportedUsage(noisy), [
    { taskId: "t3", phase: "execution", tokens: 7 },
  ]);
});
