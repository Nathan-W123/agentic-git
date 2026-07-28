import assert from "node:assert/strict";
import test from "node:test";

import type { AgentPlan } from "@coord/shared-types";

import {
  PlanAdmissionController,
  approvedSchemaResources,
  structuralConflict,
} from "./plan-admission.js";
import { ConflictDetector } from "./conflict-detector.js";

/**
 * Arbitration of a single plan against the work already running — the answer a
 * remote worker gets before it is allowed to edit anything.
 */

function plan(taskId: string, overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    taskId,
    objective: `objective for ${taskId}`,
    expectedFiles: ["src/value.ts"],
    expectedSymbols: ["value"],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
    ...overrides,
  };
}

/** Scores nothing, leaving ownership as the only judge. */
function silentDetector(): ConflictDetector {
  return new ConflictDetector({
    fileOverlapWeight: 0,
    symbolOverlapWeight: 0,
    dependencyImpactWeight: 0,
    apiOverlapWeight: 0,
    schemaOverlapWeight: 0,
    configurationOverlapWeight: 0,
    testOverlapWeight: 0,
    semanticConflictWeight: 0,
    thresholds: { concurrentMaximum: 20, notifyMaximum: 45, sequenceMaximum: 70 },
  });
}

function admit(
  candidate: AgentPlan,
  active: readonly AgentPlan[],
  controller = new PlanAdmissionController(),
) {
  return controller.admit({
    plan: candidate,
    agentId: "agent-a",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active: active.map((entry) => ({
      taskId: entry.taskId,
      agentId: "agent-b",
      plan: entry,
    })),
  });
}

test("a plan with nothing running is approved and granted ownership", () => {
  const admission = admit(plan("task_a"), []);

  assert.equal(admission.status, "approved");
  assert.deepEqual(admission.blockedBy, []);
  assert.equal(admission.conflicts.length, 0);
  assert.equal(admission.baseRevision, "a".repeat(40));
  // Ownership is real: the file and the symbol are both claimed.
  assert.deepEqual(
    admission.ownershipGrants
      .map((lease) => `${lease.resourceType}:${lease.resourceId}`)
      .sort(),
    ["file:src/value.ts", "symbol:value"],
  );
  assert.equal(admission.ownershipGrants[0]?.taskId, "task_a");
  assert.equal(admission.retryAfterMs, undefined);
});

test("a plan overlapping executing work is sequenced behind it, not approved", () => {
  const admission = admit(plan("task_a"), [plan("task_b")]);

  assert.equal(admission.status, "sequenced");
  assert.deepEqual(admission.blockedBy, ["task_b"]);
  assert.equal(admission.ownershipGrants.length, 0);
  assert.ok((admission.retryAfterMs ?? 0) > 0);
  assert.ok(admission.conflicts.every(structuralConflict));
  assert.match(admission.explanation, /file_overlap/u);
});

test("disjoint plans run concurrently", () => {
  const admission = admit(
    plan("task_a", {
      expectedFiles: ["src/a.ts"],
      expectedSymbols: ["alpha"],
    }),
    [plan("task_b", { expectedFiles: ["src/b.ts"], expectedSymbols: ["beta"] })],
  );

  assert.equal(admission.status, "approved");
  assert.deepEqual(admission.blockedBy, []);
  assert.equal(admission.ownershipGrants.length, 2);
});

test("evidence past the sequencing threshold blocks rather than orders", () => {
  // Enough overlapping resources that ordering the two would only relocate
  // the collision; the detector reports "block" and admission refuses.
  const files = Array.from({ length: 6 }, (_, index) => `src/f${index}.ts`);
  const admission = admit(
    plan("task_a", { expectedFiles: files, expectedSymbols: [] }),
    [plan("task_b", { expectedFiles: files, expectedSymbols: [] })],
  );

  assert.equal(admission.status, "blocked");
  assert.deepEqual(admission.blockedBy, ["task_b"]);
  assert.equal(admission.ownershipGrants.length, 0);
});

test("ownership refuses an overlap that conflict scoring lets through", () => {
  // A file only one plan names cannot produce overlap evidence, so scoring is
  // silent. The enriched symbol both plans touch is what ownership catches —
  // which is why admission consults both rather than either alone.
  const admission = admit(
    plan("task_a", { expectedFiles: ["src/a.ts"] }),
    [plan("task_b", { expectedFiles: ["src/b.ts"] })],
    new PlanAdmissionController(silentDetector()),
  );

  assert.equal(admission.status, "sequenced");
  assert.deepEqual(admission.blockedBy, ["task_b"]);
  assert.match(admission.explanation, /Ownership is held by task_b/u);
});

test("shared-mode resources do not collide in ownership", () => {
  // Two plans on the same markdown file: conflict scoring still sequences
  // them, but ownership on its own does not, because prose is shared rather
  // than exclusive. Silencing the detector isolates that half.
  const admission = admit(
    plan("task_a", { expectedFiles: ["docs/guide.md"], expectedSymbols: [] }),
    [plan("task_b", { expectedFiles: ["docs/guide.md"], expectedSymbols: [] })],
    new PlanAdmissionController(silentDetector()),
  );

  assert.equal(admission.status, "approved");
  assert.deepEqual(admission.blockedBy, []);
  assert.equal(admission.ownershipGrants[0]?.mode, "shared");
});

test("advisory-only overlap approves with the evidence attached", () => {
  const admission = admit(
    plan("task_a", {
      objective: "enable feature flags",
      intent: "enable feature flags",
      expectedFiles: ["src/a.ts"],
      expectedSymbols: ["alpha"],
    }),
    [
      plan("task_b", {
        objective: "disable feature flags",
        intent: "disable feature flags",
        expectedFiles: ["src/b.ts"],
        expectedSymbols: ["beta"],
      }),
    ],
  );

  assert.equal(admission.status, "approved_with_constraints");
  assert.deepEqual(admission.blockedBy, []);
  assert.ok(admission.ownershipGrants.length > 0);
  assert.equal(admission.conflicts.length, 1);
  assert.equal(admission.conflicts[0]?.evidence[0]?.advisory, true);
  assert.match(admission.constraints[0] ?? "", /Advisory overlap with task_b/u);
});

test("a resubmitted plan is not sequenced behind its own earlier admission", () => {
  // The deferral loop resubmits the same plan repeatedly; matching task ids
  // must not read as a conflict with itself.
  const admission = admit(plan("task_a"), [plan("task_a")]);

  assert.equal(admission.status, "approved");
  assert.deepEqual(admission.blockedBy, []);
});

test("a plan's own schemas are the approval for claiming them", () => {
  const withSchema = plan("task_a", { expectedSchemas: ["users"] });
  assert.ok(approvedSchemaResources(withSchema).has("schema\0users"));

  const admission = admit(withSchema, []);
  assert.equal(admission.status, "approved");
  assert.ok(
    admission.ownershipGrants.some(
      (lease) =>
        lease.resourceType === "schema" && lease.mode === "approval_required",
    ),
  );
});
