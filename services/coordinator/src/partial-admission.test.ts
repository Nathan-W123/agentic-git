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

test("a patch reaching into a withheld symbol loses the whole file", () => {
  // Promoting the rest would mean rewriting hunk offsets to publish half a
  // diff. The file goes to the follow-up intact instead.
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
