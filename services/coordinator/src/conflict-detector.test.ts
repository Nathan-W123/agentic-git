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

test("rejects invalid weights and unordered thresholds", () => {
  assert.throws(
    () =>
      new ConflictDetector({
        fileOverlapWeight: -1,
        thresholds: {
          concurrentMaximum: 20,
          notifyMaximum: 45,
          sequenceMaximum: 70,
        },
      }),
    RangeError,
  );
  assert.throws(
    () =>
      new ConflictDetector({
        fileOverlapWeight: 20,
        thresholds: {
          concurrentMaximum: 50,
          notifyMaximum: 40,
          sequenceMaximum: 70,
        },
      }),
    RangeError,
  );
});

/**
 * Replay of a recorded live failure (2026-07-29, real Codex agents on the
 * live-pricing repository): two agents each invented a different name for the
 * real `orderTotal` in `src/pricing/total.js`, plus file paths that do not
 * exist. Their declared plans share nothing, so arbitration on declarations
 * alone admitted both concurrently and one execution was thrown away at
 * integration. Grounding maps both inventions back to the same real code.
 */
test("plans hallucinating different names for the same real code overlap once grounded", () => {
  const detector = new ConflictDetector();
  const handlingFee: AgentPlan = {
    ...plan("task_handling_fee", ["src/checkout.js"]),
    expectedSymbols: ["calculateTotal"],
  };
  const freeDelivery: AgentPlan = {
    ...plan("task_free_delivery", ["src/order.js"]),
    expectedSymbols: ["computeOrderTotal"],
  };

  // Before grounding: the invented names share nothing, so the detector sees
  // no structural evidence at all — this is the recorded failure.
  assert.equal(detector.assess(handlingFee, freeDelivery), undefined);

  // After grounding (as the coordinator computes it from the real index):
  // both symbols resolve to orderTotal, which lives in src/pricing/total.js.
  const grounded = (candidate: AgentPlan, declared: string): AgentPlan => ({
    ...candidate,
    grounding: {
      confidence: "grounded",
      revision: "a".repeat(40),
      missingFiles: candidate.expectedFiles,
      unresolvedSymbols: [declared],
      fileReferents: [],
      symbolReferents: [
        {
          declared,
          resolved: "orderTotal",
          files: ["src/pricing/total.js"],
        },
      ],
      notes: [],
    },
  });
  const assessment = detector.assess(
    grounded(handlingFee, "calculateTotal"),
    grounded(freeDelivery, "computeOrderTotal"),
  );

  assert.ok(assessment);
  // One shared file (20) plus one shared symbol (35): sequenced, not blocked.
  assert.equal(assessment.score, 55);
  assert.equal(assessment.disposition, "sequence");
  const fileEvidence = assessment.evidence.find(
    (entry) => entry.kind === "file_overlap",
  );
  const symbolEvidence = assessment.evidence.find(
    (entry) => entry.kind === "symbol_overlap",
  );
  assert.deepEqual(fileEvidence?.resources, ["src/pricing/total.js"]);
  assert.deepEqual(symbolEvidence?.resources, ["orderTotal"]);
  // The audit trail says these resources came from verification, not the agents.
  assert.match(fileEvidence?.explanation ?? "", /grounded/u);
});
