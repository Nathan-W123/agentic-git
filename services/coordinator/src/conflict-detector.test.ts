import assert from "node:assert/strict";
import test from "node:test";

import type { AgentPlan } from "@coord/shared-types";

import { ConflictDetector } from "./conflict-detector.js";

function plan(taskId: string, expectedFiles: string[]): AgentPlan {
  return {
    taskId,
    objective: taskId,
    expectedFiles,
    expectedSymbols: [],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };
}

test("returns deterministic evidence for file overlap", () => {
  const detector = new ConflictDetector();
  const assessment = detector.assess(
    plan("task_a", ["src/a.ts", "src/shared.ts"]),
    plan("task_b", ["src/b.ts", "src/shared.ts"]),
  );

  assert.ok(assessment);
  assert.equal(assessment.score, 20);
  assert.equal(assessment.disposition, "concurrent");
  assert.deepEqual(assessment.evidence[0]?.resources, ["src/shared.ts"]);
});

test("returns no assessment for independent plans", () => {
  const detector = new ConflictDetector();
  assert.equal(
    detector.assess(
      plan("task_a", ["src/a.ts"]),
      plan("task_b", ["src/b.ts"]),
    ),
    undefined,
  );
});

