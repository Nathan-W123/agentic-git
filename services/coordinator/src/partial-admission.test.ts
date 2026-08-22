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
  withheldPatchRecord,
} from "./partial-admission.js";
import { PlanAdmissionController } from "./plan-admission.js";

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

/**
 * Enforcing a withheld symbol. The file was granted, so its path alone says
 * nothing; what decides is whether the diff reached into the lines the symbol
 * occupies at the base revision.
 */

function symbolAdmission(symbols: string[]): PlanAdmission {
  return {
    ...admission([]),
    status: "approved_with_constraints",
    deferredResources: symbols.map(
      (resourceId): DeferredResource => ({
        resourceType: "symbol",
        resourceId,
        heldBy: ["task_b"],
        reason: "held by task_b",
      }),
    ),
  };
}

const RANGES = [
  { name: "alpha", startLine: 1, endLine: 5 },
  { name: "withheld", startLine: 10, endLine: 20 },
];

function patchTouching(path: string, header: string): ChangeSet {
  return {
    ...changeSet([]),
    patches: [
      {
        path,
        status: "modified",
        patch: `--- a/${path}\n+++ b/${path}\n${header}\n-old\n+new\n`,
      },
    ],
  };
}

test("a patch that stays clear of a withheld symbol is promoted", () => {
  const split = splitChangeSet(
    admittedPlan(["src/a.ts"]),
    symbolAdmission(["withheld"]),
    patchTouching("src/a.ts", "@@ -1,3 +1,3 @@"),
    () => RANGES,
  );

  assert.deepEqual(
    split.granted.patches.map((entry) => entry.path),
    ["src/a.ts"],
  );
  assert.deepEqual(split.deferred, []);
  assert.deepEqual(split.withheldSymbols, {});
});

test("a patch with nothing outside the withheld symbol loses the file", () => {
  // There is nothing to divide: every hunk reaches the withheld lines, so the
  // file goes to the follow-up intact.
  const split = splitChangeSet(
    admittedPlan(["src/a.ts"]),
    symbolAdmission(["withheld"]),
    patchTouching("src/a.ts", "@@ -12,4 +12,6 @@"),
    () => RANGES,
  );

  assert.deepEqual(split.granted.patches, []);
  assert.deepEqual(
    split.deferred.map((entry) => entry.path),
    ["src/a.ts"],
  );
  assert.deepEqual(split.withheldSymbols, { "src/a.ts": ["withheld"] });
  assert.deepEqual(split.divided, []);
});

/**
 * Dividing a patch rather than losing the file to it.
 *
 * The unit of withholding used to be the file even when the contest was a
 * symbol inside it: one trespassing hunk cost every other edit in that file a
 * whole follow-up task. What is enforced now is the line range, so the hunks
 * that stayed clear of it are promoted with the rest of the changeset.
 */

function multiHunkPatch(path: string, ...headers: string[]): ChangeSet {
  return {
    ...changeSet([]),
    patches: [
      {
        path,
        status: "modified",
        patch:
          `--- a/${path}\n+++ b/${path}\n` +
          headers.map((header) => `${header}\n keep\n-old\n+new\n`).join(""),
      },
    ],
  };
}

test("hunks clear of a withheld symbol are promoted, not lost with it", () => {
  const split = splitChangeSet(
    admittedPlan(["src/a.ts"]),
    symbolAdmission(["withheld"]),
    // Three edits: one before the withheld window, one inside it, one after.
    multiHunkPatch(
      "src/a.ts",
      "@@ -6,2 +6,2 @@",
      "@@ -12,2 +12,2 @@",
      "@@ -40,2 +40,2 @@",
    ),
    () => RANGES,
  );

  assert.deepEqual(
    split.granted.patches.map((entry) => entry.path),
    ["src/a.ts"],
  );
  const promoted = split.granted.patches[0]?.patch ?? "";
  assert.match(promoted, /@@ -6,2/u);
  assert.match(promoted, /@@ -40,2/u);
  assert.doesNotMatch(promoted, /@@ -12,2/u);

  // The trespassing hunk still goes back, and only it.
  assert.equal(split.deferred.length, 1);
  const held = split.deferred[0]?.patch ?? "";
  assert.match(held, /@@ -12,2/u);
  assert.doesNotMatch(held, /@@ -6,2/u);
  assert.doesNotMatch(held, /@@ -40,2/u);

  assert.deepEqual(split.withheldSymbols, { "src/a.ts": ["withheld"] });
  assert.deepEqual(split.divided, [
    {
      path: "src/a.ts",
      grantedHunks: 2,
      deferredHunks: 1,
      symbols: ["withheld"],
    },
  ]);
});

test("a divided file keeps its own identity on both halves", () => {
  // Both halves describe the same path at the same base revision; nothing
  // about the file's identity changes because the patch was split.
  const split = splitChangeSet(
    admittedPlan(["src/a.ts"]),
    symbolAdmission(["withheld"]),
    multiHunkPatch("src/a.ts", "@@ -6,2 +6,2 @@", "@@ -12,2 +12,2 @@"),
    () => RANGES,
  );

  assert.equal(split.granted.patches[0]?.path, "src/a.ts");
  assert.equal(split.granted.patches[0]?.status, "modified");
  assert.equal(split.deferred[0]?.path, "src/a.ts");
  assert.equal(split.deferred[0]?.status, "modified");
  // The promoted changeset is a derived artifact and says so.
  assert.notEqual(split.granted.id, "changeset_agent");
});

test("an added or deleted file is never divided", () => {
  // "Part of a file being created" is not a thing that exists; the whole
  // creation is either granted or held back.
  const created = multiHunkPatch(
    "src/a.ts",
    "@@ -6,2 +6,2 @@",
    "@@ -12,2 +12,2 @@",
  );
  const split = splitChangeSet(
    admittedPlan(["src/a.ts"]),
    symbolAdmission(["withheld"]),
    {
      ...created,
      patches: created.patches.map((entry) => ({ ...entry, status: "added" })),
    },
    () => RANGES,
  );

  assert.deepEqual(split.granted.patches, []);
  assert.equal(split.deferred.length, 1);
  assert.deepEqual(split.divided, []);
});

test("a file that cannot be located is held whole rather than divided", () => {
  // No ranges means no line to divide at, and the fail-closed answer stands.
  const split = splitChangeSet(
    admittedPlan(["src/a.ts"]),
    symbolAdmission(["withheld"]),
    multiHunkPatch("src/a.ts", "@@ -6,2 +6,2 @@", "@@ -12,2 +12,2 @@"),
    () => undefined,
  );

  assert.deepEqual(split.granted.patches, []);
  assert.equal(split.deferred.length, 1);
  assert.deepEqual(split.divided, []);
});

test("a granted file that cannot be read is held back, not waved through", () => {
  // Fail closed. If the enforcement information is missing at the moment it is
  // needed, the patch does not get the benefit of the doubt.
  const split = splitChangeSet(
    admittedPlan(["src/a.ts"]),
    symbolAdmission(["withheld"]),
    patchTouching("src/a.ts", "@@ -1,3 +1,3 @@"),
    () => undefined,
  );

  assert.deepEqual(split.granted.patches, []);
  assert.deepEqual(split.withheldSymbols, { "src/a.ts": ["withheld"] });
});

test("no withheld symbols means no patch is ever read for one", () => {
  // The ranges callback is not even consulted, so an admission that withheld
  // nothing finer than a file costs nothing to enforce.
  let consulted = false;
  const split = splitChangeSet(
    admittedPlan(["src/a.ts"]),
    admission(["src/shared.ts"]),
    patchTouching("src/a.ts", "@@ -12,4 +12,6 @@"),
    () => {
      consulted = true;
      return RANGES;
    },
  );

  assert.equal(consulted, false);
  assert.deepEqual(
    split.granted.patches.map((entry) => entry.path),
    ["src/a.ts"],
  );
});

test("a follow-up objective names the files a withheld symbol cost", () => {
  const objective = deferredScopeObjective(
    "raise the value",
    [
      {
        resourceType: "symbol",
        resourceId: "withheld",
        heldBy: ["task_b"],
        reason: "held by task_b",
      },
    ],
    ["src/a.ts"],
  );

  // Both the symbol and the file whose other edits went with it, or that work
  // is silently gone.
  assert.match(objective, /symbol withheld/u);
  assert.match(objective, /src\/a\.ts/u);
  assert.equal(isDeferredScopeFollowUp(objective), true);
});

/**
 * Keeping the work a partial admission held back. It is never replayed — the
 * base it was written against is being rewritten by whoever holds the deferred
 * resource — but discarding it silently would make the follow-up a cold start.
 */

function sized(path: string, bytes: number): FilePatch {
  return { path, status: "modified", patch: "x".repeat(bytes) };
}

test("withheld patches are kept whole, with their size recorded", () => {
  const record = withheldPatchRecord([sized("src/a.ts", 10), sized("src/b.ts", 20)]);

  assert.equal(record.truncated, false);
  assert.equal(record.bytes, 30);
  assert.deepEqual(
    record.patches.map((entry) => entry.path),
    ["src/a.ts", "src/b.ts"],
  );
  assert.equal(record.patches[0]?.patch.length, 10);
  assert.equal(record.patches[0]?.omitted, undefined);
});

test("a patch past the budget is dropped whole rather than cut in half", () => {
  // Half a diff reads like a diff and applies like nothing. An honest note
  // that it was dropped is worth more to the agent reading it.
  const record = withheldPatchRecord(
    [sized("src/a.ts", 60), sized("src/big.ts", 100), sized("src/c.ts", 10)],
    80,
  );

  assert.equal(record.truncated, true);
  assert.equal(record.bytes, 70);
  assert.deepEqual(
    record.patches.map((entry) => ({
      path: entry.path,
      kept: entry.patch.length > 0,
    })),
    [
      { path: "src/a.ts", kept: true },
      // Over budget, so recorded by name only.
      { path: "src/big.ts", kept: false },
      // The budget is not exhausted by the one that did not fit; smaller
      // patches after it still make it in.
      { path: "src/c.ts", kept: true },
    ],
  );
  assert.equal(record.patches[1]?.omitted, true);
});

test("nothing withheld records nothing", () => {
  assert.deepEqual(withheldPatchRecord([]), {
    patches: [],
    truncated: false,
    bytes: 0,
  });
});

/**
 * Two agents, one file, a function each.
 *
 * The case symbol-level admission exists for, and the one it could not do
 * until the enriched symbol set stopped being read as a claim. `enrichPlan`
 * gives a plan that names a file every symbol in it, so a holder that
 * declared one function claimed all of them: the second agent was admitted to
 * the file with every function withheld, wrote the one it came for, had every
 * hunk deferred back out, and landed nothing after a full run.
 */
test("two agents editing different functions of one file both keep theirs", () => {
  const ranges = [
    { name: "alpha", startLine: 6, endLine: 12 },
    { name: "beta", startLine: 15, endLine: 21 },
    { name: "gamma", startLine: 24, endLine: 30 },
  ];
  const file = "src/mod.ts";
  const plan = (taskId: string, symbols: string[]): AgentPlan => ({
    taskId,
    objective: taskId,
    expectedFiles: [file],
    expectedSymbols: symbols,
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  });

  // Exactly what enrichment produces: the holder declared `alpha`, and every
  // symbol in the file was added to what it expects.
  const holder: AgentPlan = {
    ...plan("task_holder", ["alpha", "beta", "gamma"]),
    declaredSymbols: ["alpha"],
  };

  const admission = new PlanAdmissionController().admit({
    plan: plan("task_candidate", ["gamma"]),
    agentId: "agent_candidate",
    baseRevision: "r1",
    baseVersion: 1,
    active: [
      {
        taskId: "task_holder",
        agentId: "agent_holder",
        plan: holder,
      },
    ],
    planRevision: 1,
    symbolRangesInFile: (candidate) =>
      candidate === file ? ranges : undefined,
  });

  assert.equal(admission.status, "approved_with_constraints");
  const withheld = (admission.deferredResources ?? []).map(
    (resource) => resource.resourceId,
  );
  // The holder's own function, and only it. `beta` was never claimed by
  // anyone, and `gamma` is what the candidate came for.
  assert.deepEqual(withheld, ["alpha"]);
});

/**
 * Releasing a symbol, and the waiter picking it up.
 *
 * Splitting a file is only half of what symbol-level arbitration promises.
 * The other half is that the withholding ends: a holder that gives up a
 * function, or finishes with it, has to stop standing in the way of whoever
 * was refused it. Nothing here is a timer or a signal — `active` is derived
 * from the live leases, so a holder that narrowed its plan or went away is
 * simply a different set of declarations, and the next admission is decided
 * against that.
 */
const RELEASE_FILE = "src/mod.ts";
const RELEASE_RANGES = [
  { name: "alpha", startLine: 6, endLine: 12 },
  { name: "beta", startLine: 15, endLine: 21 },
  { name: "gamma", startLine: 24, endLine: 30 },
];

function releasePlan(taskId: string, symbols: string[]): AgentPlan {
  return {
    taskId,
    objective: taskId,
    expectedFiles: [RELEASE_FILE],
    expectedSymbols: symbols,
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };
}

/** The holder as enrichment leaves it: every symbol, one of them its own. */
function releaseHolder(declared: string[]): {
  taskId: string;
  agentId: string;
  plan: AgentPlan;
} {
  return {
    taskId: "task_holder",
    agentId: "agent_holder",
    plan: {
      ...releasePlan("task_holder", ["alpha", "beta", "gamma"]),
      declaredSymbols: declared,
    },
  };
}

function askFor(
  symbols: string[],
  active: { taskId: string; agentId: string; plan: AgentPlan }[],
): PlanAdmission {
  return new PlanAdmissionController().admit({
    plan: releasePlan("task_candidate", symbols),
    agentId: "agent_candidate",
    baseRevision: "r1",
    baseVersion: 1,
    active,
    planRevision: 1,
    symbolRangesInFile: (file) =>
      file === RELEASE_FILE ? RELEASE_RANGES : undefined,
  });
}

function withheldBy(admission: PlanAdmission): string[] {
  return (admission.deferredResources ?? [])
    .map((resource) => resource.resourceId)
    .sort();
}

test("a held symbol is withheld while its holder still declares it", () => {
  const admission = askFor(["alpha"], [releaseHolder(["alpha"])]);
  // Admitted to the file, refused the function — the candidate can still work
  // elsewhere in it, and the refused half comes back as a follow-up.
  assert.equal(admission.status, "approved_with_constraints");
  assert.deepEqual(withheldBy(admission), ["alpha"]);
});

test("releasing a symbol hands it to the task that was refused it", () => {
  // The same holder, having moved on from `alpha` to `beta`. Nothing else
  // about the request changes, so the only thing that can account for the
  // different answer is the release.
  const before = askFor(["alpha"], [releaseHolder(["alpha"])]);
  const after = askFor(["alpha"], [releaseHolder(["beta"])]);
  assert.deepEqual(withheldBy(before), ["alpha"]);
  assert.deepEqual(
    withheldBy(after),
    ["beta"],
    "alpha was released, so it should no longer be withheld",
  );
  assert.equal(
    withheldBy(after).includes("alpha"),
    false,
    "the released symbol must not still be held against the candidate",
  );
});

test("a holder that finished withholds nothing at all", () => {
  // Settling is the coarsest release there is: the lease ends, the plan
  // leaves `active`, and the next admission is a plain one.
  const admission = askFor(["alpha"], []);
  assert.equal(admission.status, "approved");
  assert.deepEqual(withheldBy(admission), []);
});

test("releasing one symbol does not release the ones still held", () => {
  // The failure worth guarding against is a release that over-delivers: a
  // holder that gave up `alpha` still has `beta`, and a candidate wanting
  // both must get exactly one of them.
  const admission = askFor(["alpha", "beta"], [releaseHolder(["beta"])]);
  assert.equal(admission.status, "approved_with_constraints");
  assert.deepEqual(withheldBy(admission), ["beta"]);
});
