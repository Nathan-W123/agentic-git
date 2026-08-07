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

test("no stored policy means nobody is asked", () => {
  // The default reversed on 2026-08-06: an unconfigured project runs
  // unattended. Nothing about *what* would be risky changed — only whether
  // anyone is stopped for it — so the sensitive cases below are the same ones
  // that used to gate, asserted to pass straight through now.
  const policy = approvalPolicyForProject(undefined);
  assert.deepEqual(policy.planReasons(planStub()), []);
  assert.deepEqual(policy.planReasons(planStub({ riskLevel: "critical" })), []);
  assert.deepEqual(
    policy.planReasons(planStub({ expectedFiles: ["package.json"] })),
    [],
  );
  assert.deepEqual(
    policy.planReasons(planStub({ expectedSchemas: ["Game"] })),
    [],
  );
});

test("one field restores every gate the old default had", () => {
  // The guarantee behind reversing the default: a team that wants review sets
  // `enabled: true` and gets the whole previous behaviour, because none of the
  // sub-defaults moved. If any of these stops holding, the default flip has
  // quietly become a feature removal.
  const policy = approvalPolicyForProject({
    version: 1,
    approvals: { enabled: true },
  });
  assert.deepEqual(policy.planReasons(planStub()), []);
  assert.notEqual(policy.planReasons(planStub({ riskLevel: "high" })).length, 0);
  // package.json is still a default protected pattern.
  assert.notEqual(
    policy.planReasons(planStub({ expectedFiles: ["package.json"] })).length,
    0,
  );
  // Schema review is still on by default *within* an enabled policy.
  assert.notEqual(
    policy.planReasons(planStub({ expectedSchemas: ["Game"] })).length,
    0,
  );
  // And the timeout a reviewer gets is unchanged.
  assert.equal(policy.timeoutMs, 24 * 60 * 60 * 1000);
});

test("a declarative policy replaces risk levels, paths, and review mode", () => {
  const policy = approvalPolicyForProject({
    version: 1,
    approvals: {
      enabled: true,
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
    approvals: { enabled: true, riskLevels: [], protectedPaths: ["generated/**"] },
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

test("an unattended policy removes human pauses without weakening defaults", () => {
  const sensitivePlan = planStub({
    expectedFiles: ["package.json"],
    expectedSchemas: ["Game"],
    riskLevel: "critical",
  });
  // Explicitly enabled, because that is now the configuration that gates.
  const reviewing = approvalPolicyForProject({
    version: 1,
    approvals: { enabled: true },
  });
  assert.notEqual(reviewing.planReasons(sensitivePlan).length, 0);
  assert.deepEqual(
    reviewing.changesetReasons(
      sensitivePlan,
      changeSetStub(["package.json"]),
      { planWasReviewed: true },
    ),
    [],
  );

  // Both spellings of unattended: explicitly off, and simply unconfigured.
  for (const unattended of [
    approvalPolicyForProject({ version: 1, approvals: { enabled: false } }),
    approvalPolicyForProject(undefined),
  ]) {
    assert.deepEqual(unattended.planReasons(sensitivePlan), []);
    assert.deepEqual(
      unattended.changesetReasons(
        sensitivePlan,
        changeSetStub(["package.json"]),
      ),
      [],
    );
  }
});

test("schema review can be delegated to protected migration paths", () => {
  const policy = approvalPolicyForProject({
    version: 1,
    approvals: {
      enabled: true,
      requireSchemaReview: false,
      riskLevels: ["critical"],
      protectedPaths: ["database/migrations/**"],
    },
  });
  assert.deepEqual(
    policy.planReasons(
      planStub({
        expectedFiles: ["src/api-schema.ts"],
        expectedSchemas: ["GameResponse"],
        riskLevel: "medium",
      }),
    ),
    [],
  );
  assert.notEqual(
    policy.planReasons(
      planStub({
        expectedFiles: ["database/migrations/001-games.sql"],
        expectedSchemas: ["games"],
      }),
    ).length,
    0,
  );
});

test("a rollback still asks a human on a project that configured nothing", () => {
  // The safety consequence of making approvals opt-in, and the carve-out that
  // answers it. Everything else reviews work arriving through the pipeline and
  // is now off by default; a rollback discards work that was already accepted,
  // is issued by an operator rather than an agent, and nothing downstream
  // re-checks it. Before approvals became opt-in it was gated only as a side
  // effect of the rollback plan being marked high risk.
  const unconfigured = approvalPolicyForProject(undefined);
  assert.deepEqual(unconfigured.planReasons(planStub({ riskLevel: "high" })), []);
  assert.notEqual(unconfigured.rollbackReasons().length, 0);

  // Explicitly unattended is still not permission to discard accepted work.
  const unattended = approvalPolicyForProject({
    version: 1,
    approvals: { enabled: false },
  });
  assert.notEqual(unattended.rollbackReasons().length, 0);

  // A deployment that wants no prompt anywhere has to say so.
  const silent = approvalPolicyForProject({
    version: 1,
    approvals: { requireRollbackReview: false },
  });
  assert.deepEqual(silent.rollbackReasons(), []);
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
  assert.throws(
    () =>
      approvalPolicyForProject({
        version: 1,
        approvals: { enabled: "sometimes" },
      }),
    TypeError,
  );
  assert.throws(
    () =>
      approvalPolicyForProject({
        version: 1,
        approvals: { requireSchemaReview: "sometimes" },
      }),
    TypeError,
  );
  assert.throws(
    () =>
      approvalPolicyForProject({
        version: 1,
        approvals: { requireRollbackReview: "sometimes" },
      }),
    TypeError,
  );
});
