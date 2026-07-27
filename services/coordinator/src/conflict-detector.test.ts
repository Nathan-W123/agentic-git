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

test("scores every structural evidence class deterministically", () => {
  const detector = new ConflictDetector();
  const first: AgentPlan = {
    ...plan("task_a", ["src/shared.ts"]),
    expectedSymbols: ["sharedSymbol"],
    expectedApis: ["POST /users"],
    expectedSchemas: ["table:users"],
    expectedConfigKeys: ["AUTH_MODE"],
    expectedTests: ["creates users"],
    expectedServices: ["UserService"],
  };
  const second: AgentPlan = {
    ...plan("task_b", ["src/shared.ts"]),
    expectedSymbols: ["sharedSymbol"],
    expectedApis: ["POST /users"],
    expectedSchemas: ["table:users"],
    expectedConfigKeys: ["AUTH_MODE"],
    expectedTests: ["creates users"],
    expectedServices: ["UserService"],
  };
  const assessment = detector.assess(first, second);

  assert.ok(assessment);
  assert.equal(assessment.score, 100);
  assert.equal(assessment.disposition, "block");
  assert.deepEqual(
    assessment.evidence.map((entry) => entry.kind),
    [
      "file_overlap",
      "symbol_overlap",
      "dependency_impact",
      "api_overlap",
      "schema_overlap",
      "configuration_overlap",
      "test_overlap",
    ],
  );
});

test("orders a producer before a consumer in different files", () => {
  const detector = new ConflictDetector();
  const producer: AgentPlan = {
    ...plan("producer", ["src/api.ts"]),
    expectedSymbols: ["createUser"],
  };
  const consumer: AgentPlan = {
    ...plan("consumer", ["src/caller.ts"]),
    dependencies: ["symbol:createUser"],
  };

  assert.deepEqual(detector.preferredOrder(producer, consumer), [
    "producer",
    "consumer",
  ]);
  assert.equal(detector.conflictsForScheduling(producer, consumer), true);
});

test("intent-only evidence remains advisory even above blocking thresholds", () => {
  const detector = new ConflictDetector({
    fileOverlapWeight: 20,
    semanticConflictWeight: 100,
    thresholds: {
      concurrentMaximum: 5,
      notifyMaximum: 10,
      sequenceMaximum: 20,
    },
  });
  const remove = {
    ...plan("remove", ["src/a.ts"]),
    objective: "Remove password authentication",
    intent: "Remove password authentication",
  };
  const add = {
    ...plan("add", ["src/b.ts"]),
    objective: "Add password reset authentication",
    intent: "Add password reset authentication",
  };
  const assessment = detector.assess(remove, add);

  assert.ok(assessment);
  assert.equal(assessment.score, 90);
  assert.equal(assessment.disposition, "concurrent_with_notification");
  assert.equal(assessment.evidence[0]?.kind, "intent_conflict");
  assert.equal(assessment.evidence[0]?.advisory, true);
  assert.equal(detector.conflictsForScheduling(remove, add), false);
});

test("custom thresholds change scheduling disposition without changing evidence", () => {
  const detector = new ConflictDetector({
    fileOverlapWeight: 20,
    thresholds: {
      concurrentMaximum: 5,
      notifyMaximum: 10,
      sequenceMaximum: 15,
    },
  });
  const assessment = detector.assess(
    plan("task_a", ["src/shared.ts"]),
    plan("task_b", ["src/shared.ts"]),
  );
  assert.equal(assessment?.score, 20);
  assert.equal(assessment?.disposition, "block");
});
