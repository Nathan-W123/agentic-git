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


test("a repository-wide claim approves what it never declared", () => {
  // The task that was never asked for a file list still has to settle, and
  // its changeset is validated against a plan naming nothing.
  const claimed = {
    ...plan,
    expectedFiles: [],
    claim: { kind: "blanket" as const, grantedAt: "2026-01-01T00:00:00.000Z" },
  };

  assert.doesNotThrow(() =>
    assertChangeSetWithinPlan(claimed, changeSet("src/anything.ts")),
  );
});

test("a frozen claim approves its directories and refuses the rest", () => {
  const frozen = {
    ...plan,
    expectedFiles: ["src/render/canvas.ts"],
    claim: {
      kind: "frozen" as const,
      directories: ["src/render/"],
      frozenAt: "2026-01-01T00:00:00.000Z",
    },
  };

  assert.doesNotThrow(() =>
    assertChangeSetWithinPlan(frozen, changeSet("src/render/mesh.ts")),
  );
  assert.throws(
    () => assertChangeSetWithinPlan(frozen, changeSet("src/audio/mixer.ts")),
    ScopeExpansionError,
  );
});
