/**
 * What a branch holds, and what the next plan is told about it.
 *
 * The property worth stating plainly, because it is the whole point: two
 * tasks an hour apart on two branches never appear in each other's `active`
 * set, so nothing today stops the second from editing what the first already
 * changed — and the collision surfaces at merge, hours later, as git's
 * problem rather than the coordinator's. These cover the pieces that close
 * that: reading what landed, turning it into something the ladder can
 * arbitrate, and saying the advisory half out loud.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BranchClaim } from "@coord/persistence";
import type { AgentPlan, ChangeSet, FilePatch } from "@coord/shared-types";

import {
  branchClaimsAsActivePlans,
  claimFromChangeSet,
  describeRangeWarnings,
  rangeWarnings,
  rangesFromPatches,
  rangesOverlap,
} from "./branch-claims.js";

function patch(path: string, body: string): FilePatch {
  return { path, status: "modified", patch: body };
}

function claim(overrides: Partial<BranchClaim> = {}): BranchClaim {
  return {
    id: "bclaim_1",
    repositoryId: "repo",
    branch: "kumi/payments-v2",
    taskId: "task_a",
    revision: "a".repeat(40),
    symbols: [],
    apis: [],
    schemas: [],
    configKeys: [],
    services: [],
    ranges: [],
    createdAt: "2026-09-08T10:00:00.000Z",
    ...overrides,
  };
}

const PLAN: AgentPlan = {
  taskId: "task_b",
  objective: "cap the retry backoff",
  expectedFiles: ["src/login.ts"],
  expectedSymbols: [],
  dependencies: [],
  commands: [],
  externalAccess: [],
  riskLevel: "low",
};

test("the lines a patch changed are read from its hunk headers", () => {
  const ranges = rangesFromPatches([
    patch(
      "src/login.ts",
      [
        "@@ -10,4 +10,6 @@ export function login() {",
        " const a = 1;",
        "+const b = 2;",
        "@@ -40 +42 @@",
        "-const old = true;",
        "+const now = true;",
      ].join("\n"),
    ),
  ]);
  // Two hunks, on the current side of the file. The second has no length,
  // which git writes for a single line rather than as `,1`.
  assert.deepEqual(ranges, [
    { file: "src/login.ts", start: 10, end: 16 },
    { file: "src/login.ts", start: 42, end: 43 },
  ]);
});

test("adjacent edits do not collide, overlapping ones do", () => {
  const at = (start: number, end: number) => ({ file: "a.ts", start, end });
  // Half-open, so two edits on neighbouring lines are two edits rather than
  // a conflict. This is the difference between a warning worth reading and
  // one that fires on every file anybody has been near.
  assert.equal(rangesOverlap(at(10, 12), at(12, 14)), false);
  assert.equal(rangesOverlap(at(10, 13), at(12, 14)), true);
  assert.equal(rangesOverlap(at(10, 12), at(8, 11)), true);
  // A different file is never a collision, whatever the numbers say.
  assert.equal(
    rangesOverlap(at(10, 20), { file: "b.ts", start: 10, end: 20 }),
    false,
  );
});

test("what a branch holds is read from what landed, not from the forecast", () => {
  const changeSet: ChangeSet = {
    id: "cs_1",
    taskId: "task_a",
    baseVersion: 1,
    baseRevision: "b".repeat(40),
    patches: [patch("src/payments.ts", "@@ -1,2 +1,5 @@\n+const a = 1;\n")],
    commandsRun: [],
    tests: [],
    dependenciesChanged: [],
    // Computed by the integration from the diff, so it is a fact about what
    // the task did rather than what it said it would do.
    symbolsChanged: ["chargeTotal"],
    riskAssessment: { level: "low", reasons: [] },
    agentExplanation: "",
    createdAt: "2026-09-08T10:00:00.000Z",
  };
  const recorded = claimFromChangeSet({
    repositoryId: "repo",
    branch: "kumi/payments-v2",
    revision: "c".repeat(40),
    changeSet,
    plan: {
      ...PLAN,
      taskId: "task_a",
      // The plan forecast four files; only one was touched. What is claimed
      // is the one, because claiming the forecast would hold three files
      // nobody edited for the life of the branch.
      expectedFiles: ["src/payments.ts", "src/a.ts", "src/b.ts", "src/c.ts"],
      expectedApis: ["POST /charges"],
      expectedSchemas: ["charges"],
    },
  });
  assert.deepEqual(recorded.symbols, ["chargeTotal"]);
  assert.deepEqual(recorded.apis, ["POST /charges"]);
  assert.deepEqual(recorded.schemas, ["charges"]);
  assert.deepEqual(recorded.ranges, [
    { file: "src/payments.ts", start: 1, end: 6 },
  ]);
  assert.equal(recorded.branch, "kumi/payments-v2");
  assert.equal(recorded.taskId, "task_a");
});

test("a branch's claims arbitrate as a plan, and carry no files", () => {
  const active = branchClaimsAsActivePlans([
    // With ranges, deliberately. Without them this test passed against a
    // synthetic plan that *did* carry files — `expectedFiles` was empty
    // either way — so the one assertion that guards the enforcement boundary
    // was checking nothing.
    claim({
      symbols: ["issueToken"],
      apis: ["POST /session"],
      ranges: [{ file: "src/session.ts", start: 10, end: 20 }],
    }),
    // Nothing semantic to hold: a task that only moved lines around inside a
    // function contributes no enforcement, which is right — its collisions
    // are textual, and textual is the advisory half.
    claim({ id: "bclaim_2", ranges: [{ file: "a.ts", start: 1, end: 2 }] }),
  ]);
  assert.equal(active.length, 1);
  const plan = active[0]?.plan;
  assert.deepEqual(plan?.expectedSymbols, ["issueToken"]);
  assert.deepEqual(plan?.expectedApis, ["POST /session"]);
  // The enforcement boundary, in one assertion. A synthetic plan carrying
  // files would make the detector's file overlap fire and turn the whole
  // thing binding — which is the opposite of what this is for.
  assert.deepEqual(plan?.expectedFiles, []);
  assert.deepEqual(plan?.declared?.symbols, ["issueToken"]);
  // Named so a refusal can say where the contention came from rather than
  // pointing at a task id nobody recognises.
  assert.equal(active[0]?.agentId, "branch:kumi/payments-v2");
});

test("a plan is told which lines another branch is already holding", () => {
  const warnings = rangeWarnings(PLAN, [
    claim({
      ranges: [
        { file: "src/login.ts", start: 40, end: 60 },
        // A file this plan is not touching is not this plan's business.
        { file: "src/unrelated.ts", start: 1, end: 9 },
      ],
    }),
  ]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.file, "src/login.ts");
  assert.equal(warnings[0]?.branch, "kumi/payments-v2");
  assert.equal(warnings[0]?.start, 40);

  const said = describeRangeWarnings(warnings);
  assert.equal(said.length, 1);
  // The lines, not just the file. "src/login.ts is busy" is true of most
  // files in most repositories and teaches somebody to ignore the warning.
  assert.match(String(said[0]), /lines 40–59/u);
  assert.match(String(said[0]), /#payments-v2/u);
  assert.match(String(said[0]), /has not merged yet/u);
});

test("many hunks in one file are one sentence, with the count kept", () => {
  const ranges = Array.from({ length: 30 }, (_, index) => ({
    file: "src/login.ts",
    start: index * 10 + 1,
    end: index * 10 + 4,
  }));
  const said = describeRangeWarnings(rangeWarnings(PLAN, [claim({ ranges })]));
  // A task that rewrote a module produced a hunk every few lines. Thirty
  // sentences about one file is a wall nobody reads; one sentence saying
  // thirty is a fact somebody acts on.
  assert.equal(said.length, 1);
  assert.match(String(said[0]), /30 places/u);
});

test("a plan touching nothing anybody holds is told nothing", () => {
  const quiet = rangeWarnings(
    { ...PLAN, expectedFiles: ["src/elsewhere.ts"] },
    [claim({ ranges: [{ file: "src/login.ts", start: 1, end: 90 }] })],
  );
  assert.deepEqual(quiet, []);
  assert.deepEqual(describeRangeWarnings(quiet), []);
});
