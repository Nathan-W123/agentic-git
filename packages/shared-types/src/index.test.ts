import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAgentPlan,
  assertChangeSet,
  assertProjectPolicy,
  normalizeRepositoryPath,
  projectBudgets,
  uniqueRepositoryPaths,
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
