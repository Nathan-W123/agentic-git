import assert from "node:assert/strict";
import test from "node:test";

import type { AgentPlan } from "@coord/shared-types";

import {
  OwnershipApprovalRequiredError,
  OwnershipConflictError,
  OwnershipService,
} from "./ownership-service.js";

function plan(taskId: string): AgentPlan {
  return {
    taskId,
    objective: taskId,
    expectedFiles: ["src/shared.ts"],
    expectedSymbols: [],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };
}

test("grants and releases exclusive file ownership", () => {
  const service = new OwnershipService(
    () => new Date("2026-01-01T00:00:00.000Z"),
  );
  const leases = service.acquire(plan("task_a"), "agent_a", 1);

  assert.equal(leases.length, 1);
  assert.equal(leases[0]?.mode, "exclusive");
  assert.throws(
    () => service.acquire(plan("task_b"), "agent_b", 1),
    OwnershipConflictError,
  );

  service.releaseTask("task_a");
  assert.equal(service.acquire(plan("task_b"), "agent_b", 1).length, 1);
});

test("shared documentation and intent resources can coexist", () => {
  const service = new OwnershipService();
  const first: AgentPlan = {
    ...plan("task_a"),
    expectedFiles: ["README.md"],
    expectedApis: ["GET /health"],
  };
  const second: AgentPlan = {
    ...plan("task_b"),
    expectedFiles: ["README.md"],
    expectedApis: ["GET /health"],
  };

  service.acquire(first, "agent_a", 1);
  const leases = service.acquire(second, "agent_b", 1);
  assert.deepEqual(
    leases.map((lease) => lease.mode).sort(),
    ["intent", "shared"],
  );
});

test("schema leases require an explicit approval resource", () => {
  const service = new OwnershipService();
  const schemaPlan: AgentPlan = {
    ...plan("task_schema"),
    expectedFiles: [],
    expectedSchemas: ["table:users"],
  };

  assert.throws(
    () => service.acquire(schemaPlan, "agent", 1),
    OwnershipApprovalRequiredError,
  );
  const leases = service.acquire(schemaPlan, "agent", 1, {
    approvedResources: new Set(["schema\0table:users"]),
  });
  assert.equal(leases[0]?.mode, "approval_required");
});

test("expired leases stop blocking new work", () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const service = new OwnershipService(() => now, 1_000);
  service.acquire(plan("task_a"), "agent_a", 1);
  now = new Date("2026-01-01T00:00:02.000Z");

  assert.equal(service.acquire(plan("task_b"), "agent_b", 2).length, 1);
  assert.equal(service.activeLeases()[0]?.taskId, "task_b");
});

test("active work can renew ownership before a long execution expires", () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const service = new OwnershipService(() => now, 1_000);
  const original = service.acquire(plan("task_a"), "agent_a", 1)[0];
  now = new Date("2026-01-01T00:00:00.800Z");
  const renewed = service.renewActive()[0];

  assert.ok(original);
  assert.ok(renewed);
  assert.ok(renewed.expiresAt > original.expiresAt);
  now = new Date("2026-01-01T00:00:01.200Z");
  assert.throws(
    () => service.acquire(plan("task_b"), "agent_b", 2),
    OwnershipConflictError,
  );
});
