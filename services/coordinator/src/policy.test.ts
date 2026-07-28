import assert from "node:assert/strict";
import test from "node:test";

import type { AgentPlan, ChangeSet } from "@coord/shared-types";

import { approvalPolicyForProject } from "./policy.js";

function planStub(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    taskId: "task_policy",
    objective: "objective",
    expectedFiles: ["src/value.js"],
    expectedSymbols: [],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
    ...overrides,
  };
}

function changeSetStub(paths: string[]): ChangeSet {
  return {
    id: "changeset_policy",
    taskId: "task_policy",
    baseVersion: 1,
    baseRevision: "a".repeat(40),
    patches: paths.map((path) => ({
      path,
      status: "modified" as const,
      patch: "@@ -1 +1 @@\n-a\n+b\n",
    })),
    commandsRun: [],
    tests: [],
    dependenciesChanged: [],
    symbolsChanged: [],
    riskAssessment: { level: "low", reasons: [] },
    agentExplanation: "benign",
    createdAt: new Date().toISOString(),
  };
}

test("no stored policy means the built-in defaults", () => {
  const policy = approvalPolicyForProject(undefined);
  assert.deepEqual(policy.planReasons(planStub()), []);
  assert.notEqual(
    policy.planReasons(planStub({ riskLevel: "high" })).length,
    0,
  );
  // package.json is a default protected pattern.
  assert.notEqual(
    policy.planReasons(planStub({ expectedFiles: ["package.json"] })).length,
    0,
  );
});

test("a declarative policy replaces risk levels, paths, and review mode", () => {
  const policy = approvalPolicyForProject({
    version: 1,
    approvals: {
      riskLevels: ["low", "medium", "high", "critical"],
      protectedPaths: ["generated/**"],
      requireChangesetReview: true,
      approvalTimeoutMs: 5_000,
    },
  });

  // Every risk level now needs review.
  assert.notEqual(policy.planReasons(planStub()).length, 0);
  // Custom protected paths replace the defaults entirely.
  const calm = approvalPolicyForProject({
    version: 1,
    approvals: { riskLevels: [], protectedPaths: ["generated/**"] },
  });
  assert.deepEqual(
    calm.planReasons(planStub({ expectedFiles: ["package.json"] })),
    [],
  );
  assert.notEqual(
    calm.planReasons(planStub({ expectedFiles: ["generated/api.ts"] })).length,
    0,
  );
  // requireChangesetReview forces review of a benign changeset.
  assert.ok(
    policy
      .changesetReasons(planStub(), changeSetStub(["src/value.js"]))
      .some((reason) => reason.includes("Project policy requires")),
  );
  assert.equal(policy.timeoutMs, 5_000);
});

test("a corrupt stored policy throws instead of silently using defaults", () => {
  assert.throws(
    () => approvalPolicyForProject({ version: 7 }),
    TypeError,
  );
  assert.throws(
    () =>
      approvalPolicyForProject({
        version: 1,
        approvals: { riskLevels: ["catastrophic"] },
      }),
    TypeError,
  );
  assert.throws(
    () =>
      approvalPolicyForProject({
        version: 1,
        approvals: { surprise: true },
      }),
    TypeError,
  );
});
