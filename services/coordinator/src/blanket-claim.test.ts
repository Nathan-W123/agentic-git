import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAgentPlan,
  isBlanketClaim,
  type AgentPlan,
  type ChangeSet,
  type TaskDefinition,
} from "@coord/shared-types";

import {
  blanketPlan,
  freezePlanFromWorkingChanges,
  frozenClaimCovers,
} from "./blanket-claim.js";
import { PlanAdmissionController } from "./plan-admission.js";
import {
  ScopeExpansionError,
  assertChangeSetWithinPlan,
} from "./scope-validator.js";

/**
 * A task alone in its repository is handed all of it without an agent ever
 * being asked what it intends to touch, and keeps that claim until somebody
 * else turns up. These cover the two moments that matter: the claim, and the
 * narrowing that ends it.
 */

const TASK: TaskDefinition = {
  id: "task_solo",
  objective: "rename the widget",
  agentId: "agent-a",
  validationCommands: [{ executable: "npm", args: ["test"], label: "test" }],
};

function changeSet(paths: readonly string[]): ChangeSet {
  return {
    id: "cs_1",
    taskId: TASK.id,
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    patches: paths.map((path) => ({
      path,
      status: "modified" as const,
      patch: "diff",
    })),
    commandsRun: [],
    tests: [],
    dependenciesChanged: [],
    symbolsChanged: [],
    riskAssessment: { level: "low", reasons: [] },
    agentExplanation: "",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function plan(taskId: string, files: string[]): AgentPlan {
  return {
    taskId,
    objective: `objective for ${taskId}`,
    expectedFiles: files,
    expectedSymbols: [],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };
}

test("a blanket claim is a real plan that names no files", () => {
  const claim = blanketPlan(TASK);

  // Everything downstream is handed an ordinary plan; only the marker says
  // the empty declarations mean "all of it" rather than "none of it".
  assertAgentPlan(claim);
  assert.equal(claim.taskId, TASK.id);
  assert.deepEqual(claim.expectedFiles, []);
  assert.deepEqual(claim.commands, TASK.validationCommands);
  assert.ok(isBlanketClaim(claim));
});

test("a blanket claim approves every file the agent writes", () => {
  const claim = blanketPlan(TASK);

  // The task that never planned must still settle: collection validates its
  // changeset against a plan that declared nothing, and that has to pass.
  assertChangeSetWithinPlan(claim, changeSet(["src/a.ts", "docs/b.md"]));
});

test("freezing derives the claim from what was touched, not from a guess", () => {
  const frozen = freezePlanFromWorkingChanges(blanketPlan(TASK), [
    { path: "src/render/canvas.ts", status: "modified" },
    { path: "src/render/shader.ts", status: "added" },
    { path: "README.md", status: "modified" },
  ]);

  assert.equal(frozen.claim?.kind, "frozen");
  assert.deepEqual(frozen.expectedFiles, [
    "README.md",
    "src/render/canvas.ts",
    "src/render/shader.ts",
  ]);
  // Directories, so a sweep frozen halfway through keeps moving inside the
  // directory it is working in — and the repository root is never a
  // directory, or the narrowing would give nothing back.
  assert.deepEqual(frozen.claim?.kind === "frozen" ? frozen.claim.directories : [], [
    "src/render/",
  ]);
  assert.ok(!isBlanketClaim(frozen));
});

test("a frozen claim covers the rest of its directories and nothing else", () => {
  const frozen = freezePlanFromWorkingChanges(blanketPlan(TASK), [
    { path: "src/render/canvas.ts", status: "modified" },
  ]);

  // The next file of the sweep, written a second after the freeze.
  assert.ok(frozenClaimCovers(frozen, "src/render/mesh.ts"));
  assertChangeSetWithinPlan(frozen, changeSet(["src/render/mesh.ts"]));
  // Somewhere else entirely is outside it, and stays outside it.
  assert.ok(!frozenClaimCovers(frozen, "src/audio/mixer.ts"));
  assert.throws(
    () => assertChangeSetWithinPlan(frozen, changeSet(["src/audio/mixer.ts"])),
    ScopeExpansionError,
  );
});

test("nothing is admitted while a repository-wide claim is held", () => {
  const controller = new PlanAdmissionController();
  const decided = controller.admit({
    plan: plan("task_second", ["docs/unrelated.md"]),
    agentId: "agent-b",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active: [
      { taskId: TASK.id, agentId: "agent-a", plan: blanketPlan(TASK) },
    ],
  });

  // Refused outright rather than queued inside the decision: the answer comes
  // back with a retry, which is the caller's cue to come again later. Nothing
  // here waits on the holder.
  assert.equal(decided.status, "sequenced");
  assert.deepEqual(decided.blockedBy, [TASK.id]);
  assert.ok((decided.retryAfterMs ?? 0) > 0);
  assert.deepEqual(decided.ownershipGrants, []);
});

test("a frozen claim admits the arriving task to everything outside it", () => {
  const frozen = freezePlanFromWorkingChanges(blanketPlan(TASK), [
    { path: "src/render/canvas.ts", status: "modified" },
  ]);
  const controller = new PlanAdmissionController();
  const active = [{ taskId: TASK.id, agentId: "agent-a", plan: frozen }];

  const outside = controller.admit({
    plan: plan("task_second", ["src/audio/mixer.ts"]),
    agentId: "agent-b",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active,
  });
  assert.equal(outside.status, "approved");

  // And to nothing inside it, including a file the holder has not touched yet
  // but is plainly working through.
  const inside = controller.admit({
    plan: plan("task_third", ["src/render/mesh.ts"]),
    agentId: "agent-c",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active,
  });
  assert.equal(inside.status, "sequenced");
  assert.deepEqual(inside.blockedBy, [TASK.id]);
});
