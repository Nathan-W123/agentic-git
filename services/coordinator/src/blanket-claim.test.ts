import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAgentPlan,
  claimCoversPath,
  claimOccupiesPath,
  isBlanketClaim,
  type AgentPlan,
  type ChangeSet,
  type TaskDefinition,
} from "@coord/shared-types";

import {
  blanketPlan,
  freezePlanFromWorkingChanges,
  frozenTouchedRanges,
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

test("the two readings of a claim disagree, and are meant to", () => {
  const frozen = freezePlanFromWorkingChanges(blanketPlan(TASK), [
    { path: "src/render/canvas.ts", status: "modified" },
  ]);

  // The file it was seen working in is held under both readings.
  assert.ok(claimOccupiesPath(frozen, "src/render/canvas.ts"));
  assert.ok(claimCoversPath(frozen, "src/render/canvas.ts"));

  // Its neighbour is the case the two readings are for. The holder may write
  // it — that is what the directory is for — but it does not hold it, so a
  // second task asking for it is answered by conflict scoring rather than by
  // a directory prefix. Anything reading the wide one to decide who waits
  // reintroduces the lockout; anything reading the narrow one to decide what
  // the holder may write breaks the sweep it was frozen in the middle of.
  assert.ok(!claimOccupiesPath(frozen, "src/render/mesh.ts"));
  assert.ok(claimCoversPath(frozen, "src/render/mesh.ts"));

  // A claim nobody has narrowed yet is the one case with nothing finer to go
  // on, so both readings still give it the repository.
  assert.ok(claimOccupiesPath(blanketPlan(TASK), "src/render/mesh.ts"));
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

  // And to nothing the holder actually named. The neighbouring file it may
  // write but has not been given has its own test below.
  const inside = controller.admit({
    plan: plan("task_third", ["src/render/canvas.ts"]),
    agentId: "agent-c",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active,
  });
  assert.equal(inside.status, "sequenced");
  assert.deepEqual(inside.blockedBy, [TASK.id]);
});

test("a frozen claim does not hold the files beside the one it named", () => {
  // The directories a freeze carries are room for files the holder may still
  // create, not a hold over every file that already lives there. One task
  // touching one file of a directory must not queue everybody else behind the
  // rest of it.
  const frozen = freezePlanFromWorkingChanges(blanketPlan(TASK), [
    { path: "src/render/canvas.ts", status: "modified" },
  ]);
  const controller = new PlanAdmissionController();
  const decided = controller.admit({
    plan: plan("task_second", ["src/render/mesh.ts"]),
    agentId: "agent-b",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active: [{ taskId: TASK.id, agentId: "agent-a", plan: frozen }],
  });

  assert.equal(decided.status, "approved");
  assert.deepEqual(decided.blockedBy, []);
  assert.deepEqual(
    decided.ownershipGrants
      .filter((grant) => grant.resourceType === "file")
      .map((grant) => grant.resourceId),
    ["src/render/mesh.ts"],
  );
  // The holder may still write there itself: what it is allowed to reach is
  // unchanged, and only arbitration reads the directories more narrowly.
  assertChangeSetWithinPlan(frozen, changeSet(["src/render/mesh.ts"]));
});

test("a frozen claim partially admits a plan with work outside its directories", () => {
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

/**
 * Where the index says three functions live in one file, for the tests below.
 * The middle one is what a frozen holder is caught working in.
 */
const PLACED = [
  { name: "renderChannel", startLine: 100, endLine: 200 },
  { name: "renameAgent", startLine: 300, endLine: 400 },
  { name: "agentIdentityFor", startLine: 500, endLine: 600 },
];
const BIG_FILE = "services/api-gateway/src/server.ts";

function askAgainstFrozen(frozen: AgentPlan): ReturnType<
  PlanAdmissionController["admit"]
> {
  return new PlanAdmissionController().admit({
    plan: {
      ...plan("task_waiter", [BIG_FILE]),
      expectedSymbols: ["renameAgent", "agentIdentityFor"],
    },
    agentId: "agent-b",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active: [{ taskId: TASK.id, agentId: "agent-a", plan: frozen }],
    symbolRangesInFile: (file) => (file === BIG_FILE ? PLACED : undefined),
    resourcesInFile: (file) =>
      file === BIG_FILE
        ? PLACED.map((span) => ({
            resourceType: "symbol" as const,
            resourceId: span.name,
          }))
        : [],
  });
}

test("a freeze keeps the lines it was shown, and says nothing where it saw none", () => {
  const watched = freezePlanFromWorkingChanges(blanketPlan(TASK), [
    { path: BIG_FILE, status: "modified", ranges: [{ startLine: 120, endLine: 140 }] },
    // Observed as changed, but nowhere located inside — a created file has no
    // base to diff against.
    { path: "src/brand-new.ts", status: "added" },
  ]);

  assert.deepEqual(frozenTouchedRanges(watched, BIG_FILE), [
    { startLine: 120, endLine: 140 },
  ]);
  // The absence has to read as "anywhere in this file", never as "nowhere".
  assert.equal(frozenTouchedRanges(watched, "src/brand-new.ts"), undefined);

  const unwatched = freezePlanFromWorkingChanges(blanketPlan(TASK), [
    { path: BIG_FILE, status: "modified" },
  ]);
  assert.equal(unwatched.claim?.kind === "frozen" ? unwatched.claim.touched : "x", undefined);
  assert.equal(frozenTouchedRanges(unwatched, BIG_FILE), undefined);
});

test("a frozen holder that was watched can be split around", () => {
  // The thing that could not happen before. A plan frozen from a worktree
  // declares no symbols and never will, so arbitration had nothing to bound
  // it with and handed over every file whole — which for a repository whose
  // largest file is most of its backend meant one holder stopped everybody.
  const decided = askAgainstFrozen(
    freezePlanFromWorkingChanges(blanketPlan(TASK), [
      { path: BIG_FILE, status: "modified", ranges: [{ startLine: 120, endLine: 140 }] },
    ]),
  );

  assert.equal(decided.status, "approved_with_constraints");
  assert.deepEqual(
    decided.deferredResources?.map((resource) => resource.resourceId),
    ["renderChannel"],
  );
  // And the waiter really gets the file: what it is told to avoid is the one
  // function the holder is inside.
  assert.deepEqual(
    decided.ownershipGrants
      .filter((grant) => grant.resourceType === "file")
      .map((grant) => grant.resourceId),
    [BIG_FILE],
  );
});

test("an edit that lands outside every symbol still takes the whole file", () => {
  // Imports, top-level statements, the space between functions. An edit no
  // name contains is an edit this cannot bound, and a claim narrower than the
  // truth hands another task lines the holder will overwrite.
  const decided = askAgainstFrozen(
    freezePlanFromWorkingChanges(blanketPlan(TASK), [
      { path: BIG_FILE, status: "modified", ranges: [{ startLine: 50, endLine: 55 }] },
    ]),
  );

  assert.equal(decided.status, "sequenced");
  assert.deepEqual(decided.blockedBy, [TASK.id]);
});

test("a freeze nobody watched behaves exactly as it did before", () => {
  const decided = askAgainstFrozen(
    freezePlanFromWorkingChanges(blanketPlan(TASK), [
      { path: BIG_FILE, status: "modified" },
    ]),
  );

  assert.equal(decided.status, "sequenced");
  assert.deepEqual(decided.blockedBy, [TASK.id]);
});

test("a holder watched inside a function the waiter wants keeps that function", () => {
  const decided = askAgainstFrozen(
    freezePlanFromWorkingChanges(blanketPlan(TASK), [
      { path: BIG_FILE, status: "modified", ranges: [{ startLine: 310, endLine: 320 }] },
    ]),
  );

  // Still a split, not a stop: the waiter declared two symbols and only one of
  // them is spoken for.
  assert.equal(decided.status, "approved_with_constraints");
  assert.deepEqual(
    decided.deferredResources?.map((resource) => resource.resourceId),
    ["renameAgent"],
  );
});
