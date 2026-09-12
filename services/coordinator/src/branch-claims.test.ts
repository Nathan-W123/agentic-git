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

import type { BranchClaim, ClaimedShape } from "@coord/persistence";
import { interfaceScopeOf } from "@coord/shared-types";
import type { AgentPlan, ChangeSet, FilePatch } from "@coord/shared-types";

import {
  branchClaimsAsActivePlans,
  claimCrossesBranches,
  claimFromChangeSet,
  movedAgainstCanonical,
  rangesFromPatches,
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
    shapes: [],
    createdAt: "2026-09-08T10:00:00.000Z",
    ...overrides,
  };
}

/** The plan under arbitration, with only what a test is about spelled out. */
function plan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return { ...PLAN, ...overrides };
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

test("what the files hold beats what the plan predicted, both ways", () => {
  const changeSet: ChangeSet = {
    id: "cs_1",
    taskId: "task_a",
    baseVersion: 1,
    baseRevision: "b".repeat(40),
    patches: [patch("src/payments.ts", "@@ -1,2 +1,5 @@\n+const a = 1;\n")],
    commandsRun: [],
    tests: [],
    dependenciesChanged: [],
    // The agent's own account. Easy to mistake for something computed — it
    // is a field the agent fills in itself on the worker path — so it is a
    // fallback here and never the answer when the files can be read.
    symbolsChanged: ["whatTheAgentSaid"],
    riskAssessment: { level: "low", reasons: [] },
    agentExplanation: "",
    createdAt: "2026-09-08T10:00:00.000Z",
  };
  const plan: AgentPlan = {
    ...PLAN,
    taskId: "task_a",
    // Forecast three config keys, and a route.
    expectedConfigKeys: ["A", "B", "C"],
    expectedApis: ["POST /predicted"],
  };

  const observed = claimFromChangeSet({
    repositoryId: "repo",
    branch: "kumi/payments-v2",
    revision: "c".repeat(40),
    changeSet,
    plan,
    // What the changed files actually contain, read from the index.
    resources: {
      symbols: ["chargeTotal"],
      apis: ["POST /charges"],
      // One key, not the three that were forecast — and a different one.
      configKeys: ["PAYMENT_LIMIT_PER_MINUTE"],
      schemas: [],
      services: [],
    },
  });
  // Under-claiming is the dangerous half: a key the plan never mentioned goes
  // unclaimed, so another branch changes it unopposed and both merge cleanly
  // into something broken.
  assert.deepEqual(observed.configKeys, ["PAYMENT_LIMIT_PER_MINUTE"]);
  // Over-claiming is the annoying half: two keys nobody touched would be held
  // for the life of the branch, refusing work for no reason.
  assert.equal(observed.configKeys.includes("A"), false);
  assert.deepEqual(observed.apis, ["POST /charges"]);
  assert.deepEqual(observed.symbols, ["chargeTotal"]);
  // Empty is an answer, not a gap: files that declare no schema hold none,
  // and falling back to the plan here would resurrect the forecast.
  assert.deepEqual(observed.schemas, []);

  // Stated for every field, not just the one that happened to be empty
  // above. `?? ` is the right operator and `|| ` is the wrong one, and the
  // difference only shows when an observation is legitimately empty — a task
  // that changed a README exports nothing, and must not be recorded as
  // holding whatever the agent said it would.
  const nothing = claimFromChangeSet({
    repositoryId: "repo",
    branch: "kumi/payments-v2",
    revision: "c".repeat(40),
    changeSet,
    plan,
    resources: {
      symbols: [],
      apis: [],
      configKeys: [],
      schemas: [],
      services: [],
    },
  });
  for (const [field, held] of [
    ["symbols", nothing.symbols],
    ["apis", nothing.apis],
    ["configKeys", nothing.configKeys],
    ["schemas", nothing.schemas],
    ["services", nothing.services],
  ] as const) {
    assert.deepEqual(held, [], `${field} should stay empty, not fall back`);
  }

  // Without the index — a coordinator that could not build one — the plan is
  // the fallback. Weaker, and better than recording nothing.
  const guessed = claimFromChangeSet({
    repositoryId: "repo",
    branch: "kumi/payments-v2",
    revision: "c".repeat(40),
    changeSet,
    plan,
  });
  assert.deepEqual(guessed.configKeys, ["A", "B", "C"]);
  assert.deepEqual(guessed.apis, ["POST /predicted"]);
  assert.deepEqual(guessed.symbols, ["whatTheAgentSaid"]);
});

test("what was measured against canonical is written down, and so is its absence", () => {
  // The coordinator computes which names the branch moved and hands them in
  // beside the resources. The first version of this function took them in
  // and never wrote them out, so no claim ever carried a measurement and
  // `claimCrossesBranches` fell back to presence for every branch — the
  // fast path refused on names nobody had touched.
  const changeSet: ChangeSet = {
    id: "cs_1",
    taskId: "task_a",
    baseVersion: 1,
    baseRevision: "b".repeat(40),
    patches: [patch("src/payments.ts", "@@ -1,2 +1,5 @@\n+const a = 1;\n")],
    commandsRun: [],
    tests: [],
    dependenciesChanged: [],
    symbolsChanged: [],
    riskAssessment: { level: "low", reasons: [] },
    agentExplanation: "",
    createdAt: "2026-09-08T10:00:00.000Z",
  };
  const moved = { apis: ["POST /charges"], schemas: [], configKeys: [], services: [] };
  const measured = claimFromChangeSet({
    repositoryId: "repo",
    branch: "kumi/payments-v2",
    revision: "c".repeat(40),
    changeSet,
    resources: { symbols: [], apis: ["POST /charges"], configKeys: [], schemas: [], services: [] },
    movedResources: moved,
  });
  assert.deepEqual(measured.movedResources, moved);
  // Absent is a statement of its own — nobody compared — and must not be
  // written as empty lists, which would say "compared, and nothing moved".
  const unmeasured = claimFromChangeSet({
    repositoryId: "repo",
    branch: "kumi/payments-v2",
    revision: "c".repeat(40),
    changeSet,
  });
  assert.equal("movedResources" in unmeasured, false);
});

test("a branch's claims arbitrate as a plan, whole, for something else to narrow", () => {
  const active = branchClaimsAsActivePlans([
    claim({
      symbols: ["issueToken"],
      apis: ["POST /session"],
      ranges: [
        { file: "src/session.ts", start: 10, end: 20 },
        // Two hunks in one file are one file to claim.
        { file: "src/session.ts", start: 40, end: 44 },
      ],
    }),
  ]);
  assert.equal(active.length, 1);
  const plan = active[0]?.plan;
  assert.deepEqual(plan?.expectedSymbols, ["issueToken"]);
  assert.deepEqual(plan?.expectedApis, ["POST /session"]);
  assert.deepEqual(plan?.declared?.symbols, ["issueToken"]);
  // The whole surface, files included, because `interfaceScopeOf` is what
  // decides which of them cross between branches — and it already had to,
  // for two agents running at the same time. Emptying files here would be a
  // second, blunter copy of that rule.
  assert.deepEqual(plan?.expectedFiles, ["src/session.ts"]);
  // Named so a refusal can say where the contention came from rather than
  // pointing at a task id nobody recognises.
  assert.equal(active[0]?.agentId, "branch:kumi/payments-v2");
});

test("what a branch holds is reduced to what actually crosses to another one", () => {
  // The line the whole design turns on, checked against the function that
  // draws it rather than against my description of it. An ordinary source
  // file is local and drops out; a migration and a route do not.
  const [entry] = branchClaimsAsActivePlans([
    claim({
      symbols: ["issueToken"],
      apis: ["POST /session"],
      ranges: [
        { file: "src/session.ts", start: 1, end: 9 },
        { file: "database/migrations/003_sessions.sql", start: 1, end: 4 },
      ],
    }),
  ]);
  assert.ok(entry !== undefined);
  const shared = interfaceScopeOf(entry.plan, {
    exported: new Set(["issuetoken"]),
    known: new Set(["issuetoken"]),
  });
  assert.ok(shared !== undefined, "an exported symbol has to survive");
  assert.deepEqual(shared?.expectedApis, ["POST /session"]);
  assert.deepEqual(shared?.expectedSymbols, ["issueToken"]);
  // Ordinary source is the branch's own business; a migration is everybody's.
  assert.deepEqual(shared?.expectedFiles, [
    "database/migrations/003_sessions.sql",
  ]);

  // And a branch holding nothing shared says nothing to another branch —
  // which is the whole benefit of branching, and the thing that stops a
  // channel queueing behind work that cannot affect it.
  const [local] = branchClaimsAsActivePlans([
    claim({
      symbols: ["helper"],
      ranges: [{ file: "src/local.ts", start: 1, end: 9 }],
    }),
  ]);
  assert.ok(local !== undefined);
  assert.equal(
    interfaceScopeOf(local.plan, {
      exported: new Set<string>(),
      known: new Set(["helper"]),
    }),
    undefined,
  );
});

test("only what can reach another branch holds the blanket path off", () => {
  // The blanket fast path grants a lone task the whole repository without
  // planning, and therefore without arbitrating against anything. It used to
  // refuse the moment *any* branch held *anything* — and because a claim's
  // `symbols` is every symbol in every file the branch touched, that was
  // every branch that had ever landed work. Solo tasks stopped getting a
  // blanket claim at all.
  const local = claim({
    symbols: ["charge", "receiptFor"],
    ranges: [{ file: "services/billing/src/charge.ts", start: 9, end: 21 }],
    apis: [],
    schemas: [],
    configKeys: [],
    services: [],
    shapes: [],
  });
  assert.equal(claimCrossesBranches(local), false);

  // Each of the five that genuinely crosses, on its own.
  for (const field of ["apis", "schemas", "configKeys", "services"] as const) {
    assert.equal(
      claimCrossesBranches(claim({ ...local, [field]: ["something"] })),
      true,
      field,
    );
  }
  assert.equal(
    claimCrossesBranches(
      claim({
        ...local,
        shapes: [
          {
            file: "services/billing/src/charge.ts",
            symbol: "charge",
            shape: "(input: ChargeInput): Promise<Receipt>",
            digest: "abc",
            consumers: [],
          },
        ],
      }),
    ),
    true,
  );
});

test("a contract the branch touched but did not move holds nothing", () => {
  // The case that made the fast path unreachable. A claim records every
  // exported shape in every file its diff touched, so a branch that fixed a
  // private helper in a file that happens to export something recorded a
  // shape — and the old presence test read that as a held contract. Almost
  // every branch has one, so almost every solo task planned instead.
  const shape = (over: Partial<ClaimedShape> = {}): ClaimedShape => ({
    file: "apps/web/public/app.js",
    symbol: "render",
    shape: "(): void",
    digest: "same-as-canonical",
    consumers: [],
    ...over,
  });
  const held = claim({
    symbols: ["helper"],
    apis: [],
    schemas: [],
    configKeys: [],
    services: [],
    ranges: [],
  });

  assert.equal(
    claimCrossesBranches({ ...held, shapes: [shape({ moved: false })] }),
    false,
  );
  assert.equal(
    claimCrossesBranches({ ...held, shapes: [shape({ moved: true })] }),
    true,
  );
  // One moved among many that did not is still a hold: the test is "any",
  // not "all", or a branch could hide a moved contract behind untouched ones.
  assert.equal(
    claimCrossesBranches({
      ...held,
      shapes: [
        shape({ moved: false }),
        shape({ symbol: "mount", moved: true }),
        shape({ symbol: "unmount", moved: false }),
      ],
    }),
    true,
  );
});

test("a claim nobody measured falls back rather than guessing", () => {
  // Written before `moved` existed, or written when canonical would not
  // index. Either way there is no measurement to read, and "we did not
  // check" must not be answered as "we checked and it is fine" — that would
  // widen the fast path exactly when something went wrong.
  const unmeasured = claim({
    apis: [],
    schemas: [],
    configKeys: [],
    services: [],
    ranges: [],
    shapes: [
      {
        file: "apps/web/public/app.js",
        symbol: "render",
        shape: "(): void",
        digest: "d",
        consumers: [],
      },
    ],
  });
  assert.equal(claimCrossesBranches(unmeasured), true);
  // And a measured claim with nothing in it is not the same as an unmeasured
  // one: no shapes at all is genuinely nothing held.
  assert.equal(claimCrossesBranches({ ...unmeasured, shapes: [] }), false);
});

test("a half-marked claim is treated as unmeasured, not half-trusted", () => {
  // Should not arise: the recorder marks every shape it saw or none of them.
  // If it ever does, something went wrong, and the answer to that is the
  // blunt test rather than a confident one built on the half that is there.
  const half = claim({
    apis: [],
    schemas: [],
    configKeys: [],
    services: [],
    ranges: [],
    shapes: [
      {
        file: "a.ts",
        symbol: "one",
        shape: "(): void",
        digest: "d",
        consumers: [],
        moved: false,
      },
      { file: "a.ts", symbol: "two", shape: "(): void", digest: "d", consumers: [] },
    ],
  });
  assert.equal(claimCrossesBranches(half), true);
});

test("a route the branch touched but did not change holds nothing", () => {
  // Same error as the shapes one, in the four name lists. A claim records
  // every route in every file its diff touched, so editing a comment in a
  // routes file claimed every route that file declares.
  const touched = claim({
    apis: ["POST /channels", "GET /channels"],
    schemas: [],
    configKeys: [],
    services: [],
    ranges: [],
    shapes: [],
  });
  assert.equal(
    claimCrossesBranches({
      ...touched,
      movedResources: { apis: [], schemas: [], configKeys: [], services: [] },
    }),
    false,
  );
  // One route genuinely added or removed is still a hold.
  assert.equal(
    claimCrossesBranches({
      ...touched,
      movedResources: {
        apis: ["DELETE /channels"],
        schemas: [],
        configKeys: [],
        services: [],
      },
    }),
    true,
  );
  // Each dimension answers for itself: a measured-clean api list must not
  // excuse a schema that moved.
  assert.equal(
    claimCrossesBranches({
      ...touched,
      schemas: ["sub_channels"],
      movedResources: {
        apis: [],
        schemas: ["sub_channels"],
        configKeys: [],
        services: [],
      },
    }),
    true,
  );
  // And an unmeasured claim falls back to presence, as before.
  assert.equal(claimCrossesBranches(touched), true);
});

test("a name gone from the branch counts as moved, not as quiet", () => {
  // Both directions. A route the branch added is obvious; a route it deleted
  // is the one a set difference computed one way silently misses — and a
  // branch that removed a route while reading as holding nothing is exactly
  // the collision the blanket path exists to avoid.
  const moved = movedAgainstCanonical(
    { apis: ["GET /a"], schemas: [], configKeys: [], services: [] },
    {
      apis: ["GET /a", "DELETE /gone"],
      schemas: [],
      configKeys: [],
      services: [],
    },
  );
  assert.deepEqual(moved.apis, ["DELETE /gone"]);

  const added = movedAgainstCanonical(
    { apis: ["GET /a", "POST /new"], schemas: [], configKeys: [], services: [] },
    { apis: ["GET /a"], schemas: [], configKeys: [], services: [] },
  );
  assert.deepEqual(added.apis, ["POST /new"]);

  // Identical on both sides is a file touched without its routes changing.
  const same = movedAgainstCanonical(
    { apis: ["GET /a"], schemas: ["t"], configKeys: [], services: [] },
    { apis: ["GET /a"], schemas: ["t"], configKeys: [], services: [] },
  );
  assert.deepEqual(same, {
    apis: [],
    schemas: [],
    configKeys: [],
    services: [],
  });
});

