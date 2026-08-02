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

/**
 * The regression the 2026-07-31 audit found: advisory evidence could not block
 * on its own, but it could push a pair that had *some* structural evidence
 * over the next threshold, because both were summed into the score the
 * thresholds read. Here the file overlap alone scores 20 — concurrent — and
 * the advisory intent score is large enough to reach `block` if it were
 * counted. It must not be.
 */
test("advisory evidence cannot lift a disposition past notification", () => {
  const detector = new ConflictDetector({
    fileOverlapWeight: 20,
    semanticConflictWeight: 100,
    thresholds: {
      concurrentMaximum: 20,
      notifyMaximum: 45,
      sequenceMaximum: 70,
    },
  });
  const remove = {
    ...plan("remove", ["src/shared.ts"]),
    objective: "Remove password authentication",
    intent: "Remove password authentication",
  };
  const add = {
    ...plan("add", ["src/shared.ts"]),
    objective: "Add password reset authentication",
    intent: "Add password reset authentication",
  };
  const assessment = detector.assess(remove, add);

  assert.ok(assessment);
  // Reported score still totals every piece of evidence: 20 structural + 90
  // advisory. The disposition is computed from the 20 alone.
  assert.equal(assessment.score, 100);
  assert.equal(assessment.disposition, "concurrent_with_notification");
  assert.match(assessment.explanation, /Structural evidence controls scheduling \(20 of 100\)/u);
  assert.equal(
    assessment.evidence.some((entry) => entry.kind === "intent_conflict"),
    true,
  );
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

/**
 * Scoring a shared path on what each side reaches inside it.
 *
 * `file_overlap` sequenced two plans that named the same file regardless of
 * what they did in it, which is the right answer only while a claim on a file
 * cannot be narrower than the file. Given something that can say which lines
 * each side reaches, a path both name but neither meets the other inside is
 * not a collision.
 */

/** task_a occupies the head of the file, task_b the tail. */
const OCCUPIES: Record<string, { startLine: number; endLine: number }[]> = {
  task_a: [{ startLine: 1, endLine: 39 }],
  task_b: [{ startLine: 40, endLine: 80 }],
};

test("a shared path neither side reaches into is not evidence", () => {
  const detector = new ConflictDetector();
  const assessment = detector.assess(
    plan("task_a", ["src/pricing/total.js"]),
    plan("task_b", ["src/pricing/total.js"]),
    (entry) => OCCUPIES[entry.taskId],
  );

  assert.equal(assessment, undefined);
});

test("a shared path both sides reach into is evidence as before", () => {
  const detector = new ConflictDetector();
  const assessment = detector.assess(
    plan("task_a", ["src/pricing/total.js"]),
    plan("task_b", ["src/pricing/total.js"]),
    (entry) =>
      entry.taskId === "task_a"
        ? [{ startLine: 1, endLine: 50 }]
        : OCCUPIES.task_b,
  );

  assert.ok(assessment);
  assert.deepEqual(
    assessment.evidence.find((entry) => entry.kind === "file_overlap")
      ?.resources,
    ["src/pricing/total.js"],
  );
});

test("a side that reaches the whole file collides with anything", () => {
  // `undefined` is what a plan that simply named the path says, and it has to
  // keep meaning all of it or the ordinary case would quietly stop colliding.
  const detector = new ConflictDetector();
  const assessment = detector.assess(
    plan("task_a", ["src/pricing/total.js"]),
    plan("task_b", ["src/pricing/total.js"]),
    (entry) => (entry.taskId === "task_a" ? undefined : OCCUPIES.task_b),
  );

  assert.ok(assessment);
  assert.equal(assessment.disposition, "concurrent");
  assert.equal(
    assessment.evidence.some((entry) => entry.kind === "file_overlap"),
    true,
  );
});

test("without an occupancy view every shared path is evidence", () => {
  const detector = new ConflictDetector();
  const assessment = detector.assess(
    plan("task_a", ["src/pricing/total.js"]),
    plan("task_b", ["src/pricing/total.js"]),
  );

  assert.ok(assessment);
  assert.deepEqual(
    assessment.evidence.find((entry) => entry.kind === "file_overlap")
      ?.resources,
    ["src/pricing/total.js"],
  );
});
