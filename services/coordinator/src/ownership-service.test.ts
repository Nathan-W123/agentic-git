import assert from "node:assert/strict";
import test from "node:test";

import type { AgentPlan } from "@coord/shared-types";

import {
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

