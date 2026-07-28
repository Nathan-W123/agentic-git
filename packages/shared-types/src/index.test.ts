import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAgentPlan,
  assertChangeSet,
  assertProjectPolicy,
  deferredFilePaths,
  normalizeRepositoryPath,
  planAdmissionApproved,
  planAdmissionPartial,
  projectBudgets,
  reducePlanScope,
  uniqueRepositoryPaths,
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
