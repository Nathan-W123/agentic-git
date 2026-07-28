import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentPlan,
  ChangeSet,
  DeferredResource,
  FilePatch,
  PlanAdmission,
} from "@coord/shared-types";

import {
  DEFERRED_SCOPE_MARKER,
  deferredScopeObjective,
  isDeferredScopeFollowUp,
  splitChangeSet,
} from "./partial-admission.js";

/**
 * Where a partial admission stops being a promise and becomes enforcement:
 * the agent's output is sorted against what was actually granted, and only
 * the granted part can reach canonical.
 */

function patch(path: string): FilePatch {
  return { path, status: "modified", patch: `--- a/${path}\n+++ b/${path}\n` };
}

function admittedPlan(files: string[]): AgentPlan {
  return {
    taskId: "task_a",
    objective: "raise the value",
    expectedFiles: files,
    expectedSymbols: [],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };
}

function admission(deferred: string[]): PlanAdmission {
  return {
    status: deferred.length === 0 ? "approved" : "approved_with_constraints",
    taskId: "task_a",
    planRevision: 1,
    baseRevision: "a".repeat(40),
    ownershipGrants: [],
    constraints: [],
    blockedBy: [],
    conflicts: [],
    explanation: "test",
    decidedAt: new Date().toISOString(),
    deferredResources: deferred.map(
      (resourceId): DeferredResource => ({
        resourceType: "file",
        resourceId,
        heldBy: ["task_b"],
        reason: "held by task_b",
      }),
    ),
  };
}

function changeSet(paths: string[]): ChangeSet {
  return {
    id: "changeset_agent",
    taskId: "task_a",
    baseVersion: 1,
    baseRevision: "a".repeat(40),
    patches: paths.map(patch),
    commandsRun: [],
    tests: [],
    dependenciesChanged: [],
    symbolsChanged: [],
    riskAssessment: { level: "low", reasons: [] },
    agentExplanation: "did the work",
    createdAt: new Date().toISOString(),
  };
}

test("an agent that respected the deferral is passed through untouched", () => {
  const split = splitChangeSet(
    admittedPlan(["src/a.ts", "src/b.ts"]),
    admission(["src/shared.ts"]),
    changeSet(["src/a.ts", "src/b.ts"]),
  );

  // Same object identity is the point: nothing was split, so nothing is
  // re-labelled and the agent's own changeset id is what gets recorded.
  assert.equal(split.granted.id, "changeset_agent");
  assert.deepEqual(split.deferred, []);
  assert.deepEqual(split.escaped, []);
});

test("patches on a deferred file are held back, not applied", () => {
  const split = splitChangeSet(
    admittedPlan(["src/a.ts", "src/b.ts"]),
    admission(["src/shared.ts"]),
    changeSet(["src/a.ts", "src/shared.ts", "src/b.ts"]),
  );

  assert.deepEqual(
    split.granted.patches.map((entry) => entry.path),
    ["src/a.ts", "src/b.ts"],
  );
  assert.deepEqual(
    split.deferred.map((entry) => entry.path),
    ["src/shared.ts"],
  );
  assert.deepEqual(split.escaped, []);
  // The promoted subset is a different artifact from what the agent handed
  // over, and says so rather than borrowing the original's identity.
  assert.notEqual(split.granted.id, "changeset_agent");
  assert.match(split.granted.id, /^changeset_/u);
  // Everything else about the changeset — base, risk, explanation — is the
  // agent's, unaltered.
  assert.equal(split.granted.baseRevision, "a".repeat(40));
  assert.equal(split.granted.agentExplanation, "did the work");
});

test("a file that was neither granted nor deferred is an escape", () => {
  const split = splitChangeSet(
    admittedPlan(["src/a.ts"]),
    admission(["src/shared.ts"]),
    changeSet(["src/a.ts", "src/shared.ts", "src/surprise.ts"]),
  );

  assert.deepEqual(split.escaped, ["src/surprise.ts"]);
  assert.deepEqual(
    split.granted.patches.map((entry) => entry.path),
    ["src/a.ts"],
  );
});

test("an agent that only edited the deferred file leaves nothing to promote", () => {
  const split = splitChangeSet(
    admittedPlan(["src/a.ts"]),
    admission(["src/shared.ts"]),
    changeSet(["src/shared.ts"]),
  );

  assert.deepEqual(split.granted.patches, []);
  assert.equal(split.deferred.length, 1);
});

test("a whole admission splits nothing", () => {
  const set = changeSet(["src/a.ts"]);
  const split = splitChangeSet(admittedPlan(["src/a.ts"]), admission([]), set);

  assert.equal(split.granted, set);
  assert.deepEqual(split.deferred, []);
});

test("a follow-up objective names the deferred work and marks its lineage", () => {
  const objective = deferredScopeObjective("raise the value", [
    {
      resourceType: "file",
      resourceId: "src/shared.ts",
      heldBy: ["task_b"],
      reason: "held by task_b",
    },
  ]);

  assert.match(objective, /src\/shared\.ts/u);
  assert.match(objective, /raise the value/u);
  assert.ok(objective.includes(DEFERRED_SCOPE_MARKER));
  // The marker is what stops a follow-up from being split again, so a task
  // sheds scope at most once.
  assert.equal(isDeferredScopeFollowUp(objective), true);
  assert.equal(isDeferredScopeFollowUp("raise the value"), false);
});
