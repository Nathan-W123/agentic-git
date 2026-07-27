import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAgentPlan,
  normalizeRepositoryPath,
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

