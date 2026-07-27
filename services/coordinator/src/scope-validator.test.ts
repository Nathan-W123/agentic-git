import assert from "node:assert/strict";
import test from "node:test";

import type { AgentPlan, ChangeSet } from "@coord/shared-types";

import {
  ScopeExpansionError,
  assertChangeSetWithinPlan,
} from "./scope-validator.js";

const plan: AgentPlan = {
  taskId: "task_1",
  objective: "Update one file",
  expectedFiles: ["src/approved.ts"],
  expectedSymbols: [],
  dependencies: [],
  commands: [],
  externalAccess: [],
  riskLevel: "low",
};

function changeSet(path: string): ChangeSet {
  return {
    id: "changeset_1",
    taskId: plan.taskId,
    baseVersion: 1,
    baseRevision: "abc",
    patches: [{ path, status: "modified", patch: "patch" }],
    commandsRun: [],
    tests: [],
    dependenciesChanged: [],
    symbolsChanged: [],
    riskAssessment: { level: "low", reasons: [] },
    agentExplanation: "fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

test("accepts patches declared in the plan", () => {
  assert.doesNotThrow(() =>
    assertChangeSetWithinPlan(plan, changeSet("src/approved.ts")),
  );
});

test("rejects unapproved scope expansion", () => {
  assert.throws(
    () => assertChangeSetWithinPlan(plan, changeSet("src/unapproved.ts")),
    ScopeExpansionError,
  );
});

