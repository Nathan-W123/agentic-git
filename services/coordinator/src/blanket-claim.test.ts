import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAgentPlan,
  claimCoversPath,
  claimReservesPath,
  isBlanketClaim,
  type AgentPlan,
  type ChangeSet,
  type TaskDefinition,
} from "@coord/shared-types";

import {
  blanketPlan,
  freezePlanFromWorkingChanges,
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
  assert.ok(claimCoversPath(frozen, "src/render/mesh.ts"));
  assertChangeSetWithinPlan(frozen, changeSet(["src/render/mesh.ts"]));
  // Somewhere else entirely is outside it, and stays outside it.
  assert.ok(!claimCoversPath(frozen, "src/audio/mixer.ts"));
  assert.throws(
    () => assertChangeSetWithinPlan(frozen, changeSet(["src/audio/mixer.ts"])),
    ScopeExpansionError,
  );
});

test("but it reserves only the files it touched, not their neighbours", () => {
  const frozen = freezePlanFromWorkingChanges(blanketPlan(TASK), [
    { path: "src/render/canvas.ts", status: "modified" },
  ]);

  // The file it was seen working in is spoken for, and stays spoken for.
  assert.ok(claimReservesPath(frozen, "src/render/canvas.ts"));
  // Its neighbour is not. The holder may still write it — that is what the
  // directory is for — but a second task asking for it is asking for
  // something nobody has been granted, and gets told so by conflict scoring
  // rather than by a directory prefix.
  assert.ok(!claimReservesPath(frozen, "src/render/mesh.ts"));
  assert.ok(claimCoversPath(frozen, "src/render/mesh.ts"));

  // A claim nobody has narrowed yet is the one case with nothing finer to go
  // on, so it goes on reserving the repository.
  assert.ok(claimReservesPath(blanketPlan(TASK), "src/render/mesh.ts"));
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

  // And to the rest of the holder's own directory, which it may write but has
  // not been given. A freeze widens to directories so a task interrupted
  // halfway through a sweep can finish it — reading that as a reservation is
  // what makes one file's holder the owner of every file beside it.
  const neighbour = controller.admit({
    plan: plan("task_third", ["src/render/mesh.ts"]),
    agentId: "agent-c",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active,
  });
  assert.equal(neighbour.status, "approved");

  // What it is refused is the file the holder was actually seen working in.
  const inside = controller.admit({
    plan: plan("task_fourth", ["src/render/canvas.ts"]),
    agentId: "agent-d",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active,
  });
  assert.equal(inside.status, "sequenced");
  assert.deepEqual(inside.blockedBy, [TASK.id]);
});

test("a frozen claim partially admits a plan reaching a file it touched", () => {
  const frozen = freezePlanFromWorkingChanges(blanketPlan(TASK), [
    { path: "src/render/canvas.ts", status: "modified" },
  ]);
  const controller = new PlanAdmissionController();
  const decided = controller.admit({
    plan: plan("task_second", [
      "src/render/canvas.ts",
      "src/audio/mixer.ts",
    ]),
    agentId: "agent-b",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active: [{ taskId: TASK.id, agentId: "agent-a", plan: frozen }],
  });

  assert.equal(decided.status, "approved_with_constraints");
  assert.deepEqual(decided.blockedBy, []);
  assert.deepEqual(
    decided.deferredResources?.map((resource) => resource.resourceId),
    ["src/render/canvas.ts"],
  );
  assert.deepEqual(
    decided.ownershipGrants
      .filter((grant) => grant.resourceType === "file")
      .map((grant) => grant.resourceId),
    ["src/audio/mixer.ts"],
  );

  // The file beside it is not deferred at all — there is nothing to reduce,
  // so the whole plan is granted.
  const beside = controller.admit({
    plan: plan("task_third", ["src/render/mesh.ts", "src/audio/mixer.ts"]),
    agentId: "agent-c",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active: [{ taskId: TASK.id, agentId: "agent-a", plan: frozen }],
  });
  assert.equal(beside.status, "approved");
});
