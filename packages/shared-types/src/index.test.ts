import assert from "node:assert/strict";
import test from "node:test";

import {
  arbitrationFiles,
  arbitrationSymbols,
  assertAgentPlan,
  assertChangeSet,
  assertProjectPolicy,
  deferredFilePaths,
  normalizeRepositoryPath,
  planAdmissionApproved,
  substituteGroundedNames,
  planAdmissionPartial,
  planGroundingConfidence,
  projectBudgets,
  readsAsReportRequest,
  reducePlanScope,
  ROLE_CONTEXT_PREFIX,
  uniqueRepositoryPaths,
  withoutRoleContext,
  type AgentPlan,
  type PlanAdmission,
} from "./index.js";

test("normalizes and deduplicates repository paths", () => {
  assert.deepEqual(
    uniqueRepositoryPaths(["src\\index.ts", "src/index.ts", "./test/a.ts"]),
    ["src/index.ts", "test/a.ts"],
  );
});

test("rejects paths outside the repository", () => {
  assert.throws(() => normalizeRepositoryPath("../secret.txt"), /escapes/u);
  assert.throws(() => normalizeRepositoryPath("C:\\secret.txt"), /Invalid/u);
});

test("preserves whitespace that is part of a legal Git filename", () => {
  assert.equal(
    normalizeRepositoryPath(" src/filename .ts "),
    " src/filename .ts ",
  );
});

test("validates and normalizes an agent plan", () => {
  const plan: unknown = {
    taskId: "task_1",
    objective: "Change a file",
    expectedFiles: ["src\\index.ts"],
    expectedSymbols: [],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };

  assertAgentPlan(plan);
  assert.deepEqual(plan.expectedFiles, ["src/index.ts"]);
});

test("rejects malformed validation commands in an agent plan", () => {
  assert.throws(() =>
    assertAgentPlan({
      taskId: "task_1",
      objective: "Change a file",
      expectedFiles: ["src/index.ts"],
      expectedSymbols: [],
      dependencies: [],
      commands: [{ executable: "node", args: "bad", label: "tests" }],
      externalAccess: [],
      riskLevel: "low",
    }),
  );
});

test("validates and normalizes a changeset received over the wire", () => {
  const changeSet: unknown = {
    id: " change_1 ",
    taskId: " task_1 ",
    baseVersion: 1,
    baseRevision: "abc123",
    patches: [
      {
        path: "src\\index.ts",
        status: "modified",
        patch: "diff --git a/src/index.ts b/src/index.ts\n",
      },
    ],
    commandsRun: [],
    tests: [],
    dependenciesChanged: [" dep ", "dep"],
    symbolsChanged: ["main"],
    riskAssessment: { level: "low", reasons: [" safe ", "safe"] },
    agentExplanation: "Updated the entry point",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  assertChangeSet(changeSet);
  assert.equal(changeSet.id, "change_1");
  assert.equal(changeSet.taskId, "task_1");
  assert.equal(changeSet.patches[0]?.path, "src/index.ts");
  assert.deepEqual(changeSet.dependenciesChanged, ["dep"]);
  assert.deepEqual(changeSet.riskAssessment.reasons, ["safe"]);
});

test("rejects malformed or escaping changesets", () => {
  const valid = {
    id: "change_1",
    taskId: "task_1",
    baseVersion: 1,
    baseRevision: "abc123",
    patches: [],
    commandsRun: [],
    tests: [],
    dependenciesChanged: [],
    symbolsChanged: [],
    riskAssessment: { level: "low", reasons: [] },
    agentExplanation: "",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  assert.throws(() =>
    assertChangeSet({
      ...valid,
      patches: [{ path: "../secret", status: "added", patch: "content" }],
    }),
  );
  assert.throws(() =>
    assertChangeSet({
      ...valid,
      tests: [{ name: "test", status: "unknown", durationMs: 0, output: "" }],
    }),
  );
});

test("project policy accepts budgets and rejects malformed ones", () => {
  const policy = {
    version: 1,
    budgets: { maxTaskRuntimeMs: 60_000, maxProjectRuntimeMsPerDay: 3_600_000 },
  };
  assertProjectPolicy(policy);
  assert.deepEqual(projectBudgets(policy as never), {
    maxTaskRuntimeMs: 60_000,
    maxProjectRuntimeMsPerDay: 3_600_000,
  });
  assert.deepEqual(projectBudgets(undefined), {});
  assert.deepEqual(projectBudgets({ version: 1 } as never), {});

  assert.throws(() =>
    assertProjectPolicy({ version: 1, budgets: { maxTaskRuntimeMs: 0 } }),
  );
  assert.throws(() =>
    assertProjectPolicy({ version: 1, budgets: { monthlyDollars: 5 } }),
  );
  assert.throws(() =>
    assertProjectPolicy({ version: 1, budgets: [] }),
  );
  // A corrupt policy must throw rather than read as "no budgets".
  assert.throws(() => projectBudgets({ version: 9 } as never));
});

test("reducing a plan's scope removes claims and nothing else", () => {
  const plan: AgentPlan = {
    taskId: "task_1",
    objective: "Widen the API",
    expectedFiles: ["src/a.ts", "src/shared.ts"],
    expectedSymbols: ["alpha"],
    expectedApis: ["GET /v1/a"],
    expectedTests: ["test/a.test.ts"],
    dependencies: ["src/shared.ts"],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };

  const reduced = reducePlanScope(plan, [
    { resourceType: "file", resourceId: "SRC/Shared.ts" },
    { resourceType: "api", resourceId: "GET /v1/a" },
  ]);

  assert.deepEqual(reduced.expectedFiles, ["src/a.ts"]);
  assert.deepEqual(reduced.expectedApis, []);
  // A dependency is something the plan reads, not something it claims, so
  // dropping the claim must not drop the dependency.
  assert.deepEqual(reduced.dependencies, ["src/shared.ts"]);
  // Identity and everything unrelated survive untouched: every check
  // downstream compares the objective to decide the plan is for this task.
  assert.equal(reduced.objective, plan.objective);
  assert.deepEqual(reduced.expectedSymbols, ["alpha"]);
  assert.deepEqual(reduced.expectedTests, ["test/a.test.ts"]);
  // The original is left alone.
  assert.equal(plan.expectedFiles.length, 2);
});

test("a partial admission is an approval, and says what it withheld", () => {
  const admission: PlanAdmission = {
    status: "approved_with_constraints",
    taskId: "task_1",
    planRevision: 1,
    baseRevision: "a".repeat(40),
    ownershipGrants: [],
    constraints: [],
    blockedBy: [],
    conflicts: [],
    explanation: "partial",
    decidedAt: new Date().toISOString(),
    deferredResources: [
      {
        resourceType: "file",
        resourceId: "src\\shared.ts",
        heldBy: ["task_2"],
        reason: "held by task_2",
      },
      {
        resourceType: "symbol",
        resourceId: "shared",
        heldBy: ["task_2"],
        reason: "held by task_2",
      },
    ],
  };

  assert.equal(planAdmissionApproved(admission), true);
  assert.equal(planAdmissionPartial(admission), true);
  // Deferred files come back in the form a changeset patch path takes.
  assert.deepEqual(deferredFilePaths(admission), ["src/shared.ts"]);

  const whole = { ...admission, deferredResources: [] };
  assert.equal(planAdmissionPartial(whole), false);
  assert.deepEqual(deferredFilePaths(whole), []);
  // A refusal is never partial, whatever it carries.
  assert.equal(
    planAdmissionPartial({ ...admission, status: "sequenced" }),
    false,
  );
});

test("arbitration views merge declared resources with grounded referents", () => {
  const plan: AgentPlan = {
    taskId: "task_1",
    objective: "Change pricing",
    expectedFiles: ["src/checkout.js"],
    expectedSymbols: ["calculateTotal"],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
    grounding: {
      confidence: "grounded",
      revision: "a".repeat(40),
      missingFiles: ["src/checkout.js"],
      unresolvedSymbols: ["calculateTotal"],
      fileReferents: [{ declared: "src/checkout.js", resolved: "src/order.js" }],
      symbolReferents: [
        {
          declared: "calculateTotal",
          resolved: "orderTotal",
          files: ["src/pricing/total.js"],
        },
      ],
      notes: [],
    },
  };

  assert.deepEqual(arbitrationFiles(plan), [
    "src/checkout.js",
    "src/order.js",
    "src/pricing/total.js",
  ]);
  assert.deepEqual(arbitrationSymbols(plan), ["calculateTotal", "orderTotal"]);
  assert.equal(planGroundingConfidence(plan), "grounded");
  // Legacy plans without a grounding record behave exactly as before.
  const { grounding: ignored, ...legacy } = plan;
  assert.deepEqual(arbitrationFiles(legacy), ["src/checkout.js"]);
  assert.equal(planGroundingConfidence(legacy), "verified");
});

test("reducing a plan's scope takes the withheld declaration's grounding with it", () => {
  const plan: AgentPlan = {
    taskId: "task_1",
    objective: "Change pricing",
    expectedFiles: ["src/checkout.js", "src/kept.js"],
    expectedSymbols: ["calculateTotal"],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
    grounding: {
      confidence: "grounded",
      revision: "a".repeat(40),
      missingFiles: ["src/checkout.js"],
      unresolvedSymbols: ["calculateTotal"],
      fileReferents: [{ declared: "src/checkout.js", resolved: "src/order.js" }],
      symbolReferents: [
        {
          declared: "calculateTotal",
          resolved: "orderTotal",
          files: ["src/pricing/total.js"],
        },
      ],
      notes: [],
    },
  };

  const reduced = reducePlanScope(plan, [
    { resourceType: "file", resourceId: "src/checkout.js" },
    { resourceType: "symbol", resourceId: "calculateTotal" },
  ]);

  assert.deepEqual(reduced.expectedFiles, ["src/kept.js"]);
  assert.deepEqual(reduced.grounding?.missingFiles, []);
  assert.deepEqual(reduced.grounding?.fileReferents, []);
  assert.deepEqual(reduced.grounding?.symbolReferents, []);
  assert.deepEqual(arbitrationFiles(reduced), ["src/kept.js"]);
});

test("rejects a malformed grounding record on an agent plan", () => {
  assert.throws(() =>
    assertAgentPlan({
      taskId: "task_1",
      objective: "Change a file",
      expectedFiles: ["src/index.ts"],
      expectedSymbols: [],
      dependencies: [],
      commands: [],
      externalAccess: [],
      riskLevel: "low",
      grounding: { confidence: "certain" },
    }),
  );
});

/**
 * Rewriting a plan to say what verification decided it meant.
 *
 * Arbitration already reasons over referents. This is the same mapping pointed
 * at the agent instead: the previous plan a replan is shown carries the real
 * names, not the invented ones it is being asked not to repeat.
 */

const HALLUCINATED: AgentPlan = {
  taskId: "task_1",
  objective: "Change pricing",
  expectedFiles: ["src/checkout.js", "src/pricing/total.js", "src/brand-new.js"],
  expectedSymbols: ["calculateTotal", "brandNewHelper"],
  dependencies: [],
  commands: [],
  externalAccess: [],
  riskLevel: "low",
  grounding: {
    confidence: "grounded",
    revision: "a".repeat(40),
    missingFiles: ["src/checkout.js", "src/brand-new.js"],
    unresolvedSymbols: ["calculateTotal", "brandNewHelper"],
    fileReferents: [
      { declared: "src/checkout.js", resolved: "src/order.js" },
    ],
    symbolReferents: [
      {
        declared: "calculateTotal",
        resolved: "orderTotal",
        files: ["src/pricing/total.js"],
      },
    ],
    notes: ["declared file src/checkout.js does not exist"],
  },
};

test("a resolvable misname is replaced by the name it really meant", () => {
  const view = substituteGroundedNames(HALLUCINATED);

  assert.ok(!view.plan.expectedFiles.includes("src/checkout.js"));
  assert.ok(view.plan.expectedFiles.includes("src/order.js"));
  assert.ok(!view.plan.expectedSymbols.includes("calculateTotal"));
  assert.ok(view.plan.expectedSymbols.includes("orderTotal"));
  // A declaration that already resolved is untouched.
  assert.ok(view.plan.expectedFiles.includes("src/pricing/total.js"));
});

test("a declaration that grounds to nothing is reported, not rewritten", () => {
  // A plan for a new module names files that do not exist yet. Correcting
  // those would be inventing a correction.
  const view = substituteGroundedNames(HALLUCINATED);

  assert.ok(view.plan.expectedFiles.includes("src/brand-new.js"));
  assert.ok(view.plan.expectedSymbols.includes("brandNewHelper"));
  assert.deepEqual(view.inventedFiles, ["src/brand-new.js"]);
  assert.deepEqual(view.inventedSymbols, ["brandNewHelper"]);
});

test("every substitution is reported with where the real code lives", () => {
  const view = substituteGroundedNames(HALLUCINATED);

  assert.deepEqual(view.substitutions, [
    {
      kind: "file",
      declared: "src/checkout.js",
      resolved: ["src/order.js"],
      files: [],
    },
    {
      kind: "symbol",
      declared: "calculateTotal",
      resolved: ["orderTotal"],
      files: ["src/pricing/total.js"],
    },
  ]);
});

test("the grounding record is dropped rather than carried forward", () => {
  // Its missingFiles list is a verbatim copy of exactly the names the agent
  // should not repeat, which is the last thing to put back in front of it.
  const view = substituteGroundedNames(HALLUCINATED);
  assert.equal(view.plan.grounding, undefined);
  assert.doesNotMatch(JSON.stringify(view.plan), /src\/checkout\.js/u);
});

test("an ambiguous misname keeps every candidate it could mean", () => {
  const view = substituteGroundedNames({
    ...HALLUCINATED,
    expectedFiles: ["order.js"],
    expectedSymbols: [],
    grounding: {
      ...HALLUCINATED.grounding!,
      missingFiles: ["order.js"],
      unresolvedSymbols: [],
      fileReferents: [
        { declared: "order.js", resolved: "src/order.js" },
        { declared: "order.js", resolved: "src/legacy/order.js" },
      ],
      symbolReferents: [],
    },
  });

  assert.deepEqual(view.plan.expectedFiles, [
    "src/legacy/order.js",
    "src/order.js",
  ]);
  assert.deepEqual(view.substitutions[0]?.resolved, [
    "src/order.js",
    "src/legacy/order.js",
  ]);
});

test("a plan with no grounding record is returned exactly as it came", () => {
  const { grounding: ignored, ...bare } = HALLUCINATED;
  void ignored;
  const view = substituteGroundedNames(bare);

  assert.equal(view.plan, bare);
  assert.deepEqual(view.substitutions, []);
  assert.deepEqual(view.inventedFiles, []);
});

test("a role preamble does not decide whether a request was a report", () => {
  // A channel dispatch prepends the agent's declared role to every objective
  // it submits. That sentence is the operator describing the agent, not
  // anybody asking for work — but the editing-verb veto read it anyway, so an
  // agent whose role happened to say "fixer" or "implementation" failed the
  // check on every task it was ever given, and every audit it ran came back
  // recorded as a failure.
  const roles = [
    "Codebase auditor and fixer",
    "Implementation engineer",
    "Reviewer who writes patches",
  ];
  for (const role of roles) {
    assert.equal(
      readsAsReportRequest(
        `${ROLE_CONTEXT_PREFIX} ${role}.\n\naudit the codebase`,
      ),
      true,
      role,
    );
  }

  // The veto still has to work on the request itself, which is the alarm
  // that catches a sandbox silently refusing every edit.
  assert.equal(
    readsAsReportRequest(
      `${ROLE_CONTEXT_PREFIX} Codebase auditor.\n\nfix the retry loop`,
    ),
    false,
  );

  // Every paragraph of the request is read, not just the first. Keeping only
  // the paragraph after the preamble would let "and fix what you find" hide
  // behind an opening "audit", and an empty changeset from a task that was
  // meant to write would pass for a report.
  assert.equal(
    readsAsReportRequest(
      `${ROLE_CONTEXT_PREFIX} Auditor.\n\naudit the codebase\n\n` +
        "and fix anything you find",
    ),
    false,
  );
  assert.equal(
    withoutRoleContext(
      `${ROLE_CONTEXT_PREFIX} Auditor.\n\nfirst para\n\nsecond para`,
    ),
    "first para\n\nsecond para",
  );

  // An objective with no preamble is untouched, and a preamble with no
  // request behind it is left alone rather than reduced to nothing.
  assert.equal(readsAsReportRequest("audit the codebase"), true);
  assert.equal(withoutRoleContext("audit the codebase"), "audit the codebase");
  assert.equal(
    withoutRoleContext(`${ROLE_CONTEXT_PREFIX} Auditor.`),
    `${ROLE_CONTEXT_PREFIX} Auditor.`,
  );
  assert.equal(
    withoutRoleContext(`${ROLE_CONTEXT_PREFIX} Auditor.\n\naudit the codebase`),
    "audit the codebase",
  );
});
