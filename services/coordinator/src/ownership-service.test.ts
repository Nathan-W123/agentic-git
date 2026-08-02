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

/**
 * A lease on part of a file.
 *
 * An exclusive lease has always meant the whole path, so a task occupying one
 * function refused every other task the rest of the file. A claim that says
 * which lines it means can be answered with the only question that matters —
 * do these two claims meet — and a claim that says nothing still means all of
 * them, so nothing that behaved one way before behaves differently now.
 */

test("two claims on different lines of one file are both granted", () => {
  const service = new OwnershipService();
  service.acquire(plan("task_a"), "agent_a", 1, {
    fileClaims: [
      { file: "src/shared.ts", ranges: [{ startLine: 40, endLine: 80 }] },
    ],
  });
  const second = service.acquire(plan("task_b"), "agent_b", 1, {
    fileClaims: [
      { file: "src/shared.ts", ranges: [{ startLine: 100, endLine: 140 }] },
    ],
  });

  assert.equal(second.length, 1);
  assert.deepEqual(second[0]?.ranges, [{ startLine: 100, endLine: 140 }]);
});

test("claims that meet on one line still collide", () => {
  const service = new OwnershipService();
  service.acquire(plan("task_a"), "agent_a", 1, {
    fileClaims: [
      { file: "src/shared.ts", ranges: [{ startLine: 40, endLine: 80 }] },
    ],
  });

  assert.throws(
    () =>
      service.acquire(plan("task_b"), "agent_b", 1, {
        fileClaims: [
          { file: "src/shared.ts", ranges: [{ startLine: 80, endLine: 120 }] },
        ],
      }),
    OwnershipConflictError,
  );
});

test("a claim that names no lines still means the whole file", () => {
  // Both directions: the narrow lease does not let a whole-file claim past it,
  // and a whole-file lease does not let a narrow claim past it either.
  const held = new OwnershipService();
  held.acquire(plan("task_a"), "agent_a", 1, {
    fileClaims: [
      { file: "src/shared.ts", ranges: [{ startLine: 40, endLine: 80 }] },
    ],
  });
  assert.throws(
    () => held.acquire(plan("task_b"), "agent_b", 1),
    OwnershipConflictError,
  );

  const whole = new OwnershipService();
  whole.acquire(plan("task_a"), "agent_a", 1);
  assert.throws(
    () =>
      whole.acquire(plan("task_b"), "agent_b", 1, {
        fileClaims: [
          { file: "src/shared.ts", ranges: [{ startLine: 40, endLine: 80 }] },
        ],
      }),
    OwnershipConflictError,
  );
});

test("a claim can lease a file the plan never named", () => {
  // This is how work that reaches code through a grounded referent takes a
  // lease on the file that code really lives in — narrow, because that reach
  // is exactly as wide as the symbols the index placed.
  const service = new OwnershipService();
  const leases = service.acquire(plan("task_a"), "agent_a", 1, {
    fileClaims: [
      { file: "src/pricing/total.js", ranges: [{ startLine: 4, endLine: 11 }] },
    ],
  });

  assert.deepEqual(
    leases.map((lease) => lease.resourceId).sort(),
    ["src/pricing/total.js", "src/shared.ts"],
  );
  assert.equal(
    service
      .blockersFor(plan("task_b"), {
        fileClaims: [
          {
            file: "src/pricing/total.js",
            ranges: [{ startLine: 20, endLine: 24 }],
          },
        ],
      })
      .filter((lease) => lease.resourceId === "src/pricing/total.js").length,
    0,
  );
});

test("blockers are reported at the same granularity leases are issued", () => {
  const service = new OwnershipService();
  service.acquire(plan("task_a"), "agent_a", 1, {
    fileClaims: [
      { file: "src/shared.ts", ranges: [{ startLine: 40, endLine: 80 }] },
    ],
  });

  assert.equal(
    service.blockersFor(plan("task_b"), {
      fileClaims: [
        { file: "src/shared.ts", ranges: [{ startLine: 10, endLine: 20 }] },
      ],
    }).length,
    0,
  );
  // And a plan asking for the whole file is still told who is in the way.
  const blockers = service.blockersFor(plan("task_b"));
  assert.equal(blockers.length, 1);
  assert.deepEqual(blockers[0]?.ranges, [{ startLine: 40, endLine: 80 }]);
});
