/**
 * Who is in a file, and whether they are in the way.
 *
 * Two ways to be wrong and both are bad in the same direction as everywhere
 * else in this system: miss a holder and two people write the same lines
 * through different doors; report one that is not there and the gate becomes
 * something people override without reading, which spends the credibility the
 * real refusals need.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { EditorHold } from "@coord/persistence";
import type { ResourceLease } from "@coord/shared-types";

import { holderBlocks, holdersOfFile, type AgentHolding } from "./editor-holds.js";

function hold(overrides: Partial<EditorHold> = {}): EditorHold {
  return {
    repositoryId: "repo",
    branch: "kumi/payments-v2",
    userId: "user_nathan" as EditorHold["userId"],
    file: "src/login.ts",
    ranges: [],
    acquiredAt: "2026-09-08T10:00:00.000Z",
    renewedAt: "2026-09-08T10:00:30.000Z",
    expiresAt: "2026-09-08T10:01:15.000Z",
    ...overrides,
  };
}

function grant(overrides: Partial<ResourceLease> = {}): ResourceLease {
  return {
    leaseId: "lease_1" as ResourceLease["leaseId"],
    resourceType: "file",
    resourceId: "src/login.ts",
    principalId: "claude" as ResourceLease["principalId"],
    taskId: "task_1" as ResourceLease["taskId"],
    mode: "exclusive",
    baseVersion: 1,
    expiresAt: "2026-09-08T10:05:00.000Z",
    ...overrides,
  };
}

function agent(overrides: Partial<AgentHolding> = {}): AgentHolding {
  return { principalId: "claude", taskId: "task_1", grants: [grant()], ...overrides };
}

test("people and agents come back as one list, and the asker is left out", () => {
  const holders = holdersOfFile({
    humans: [hold(), hold({ userId: "user_ethan" as EditorHold["userId"] })],
    agents: [agent()],
    path: "src/login.ts",
    exceptUser: "user_nathan",
  });

  // Both kinds, one answer. Asking twice in two shapes is how a save comes to
  // be refused for a reason the editor cannot draw.
  assert.deepEqual(
    holders.map((holder) => [holder.kind, holder.principalId]),
    [
      ["agent", "claude"],
      ["human", "user_ethan"],
    ],
  );
  // The asker's own hold is not contention. Left in, the gate would refuse
  // somebody their own file the moment they typed in it.
  assert.equal(
    holders.some((holder) => holder.principalId === "user_nathan"),
    false,
  );
  // An agent's holding says what it is holding the file *for*, which is what
  // makes the block in the margin worth reading.
  assert.equal(holders[0]?.taskId, "task_1");
  // A person's says when it lapses, so a reader can tell a live editor from
  // one that is about to give the file back.
  assert.equal(holders[1]?.expiresAt, "2026-09-08T10:01:15.000Z");
  assert.equal(holders[1]?.since, "2026-09-08T10:00:00.000Z");
});

test("only the file that was asked about, and only files", () => {
  const holders = holdersOfFile({
    humans: [hold({ file: "src/other.ts" }), hold({ userId: "user_ethan" as EditorHold["userId"] })],
    agents: [
      agent({
        grants: [
          grant({ resourceId: "src/other.ts" }),
          // A plan holds symbols, routes and schemas too. None of them is a
          // thing to draw a block around in a text editor — they are
          // arbitrated where plans are arbitrated.
          grant({ resourceType: "symbol", resourceId: "issueToken" }),
          grant(),
        ],
      }),
    ],
    path: "src/login.ts",
  });
  assert.deepEqual(
    holders.map((holder) => [holder.kind, holder.file]),
    [
      ["agent", "src/login.ts"],
      ["human", "src/login.ts"],
    ],
  );

  // With no path it is everybody, everywhere — which is what a branch-wide
  // view wants.
  assert.equal(
    holdersOfFile({
      humans: [hold({ file: "src/other.ts" })],
      agents: [agent()],
    }).length,
    2,
  );

  // And that is the question that proves the kind filter does its own work.
  // Asked about one path, a symbol grant is dropped by the path filter
  // whatever `resourceType` says; asked about everything, only the kind
  // filter stands between a symbol and a block drawn in a text editor.
  assert.deepEqual(
    holdersOfFile({
      humans: [],
      agents: [
        agent({
          grants: [
            grant({ resourceType: "symbol", resourceId: "issueToken" }),
            grant({ resourceType: "api", resourceId: "POST /charges" }),
            grant(),
          ],
        }),
      ],
    }).map((holder) => holder.file),
    ["src/login.ts"],
  );
});

test("a lease's lines are read into the half-open convention everything else uses", () => {
  // `endLine` on a lease is the last line covered. A range that ended there
  // would be one line short against every other range in the system, and the
  // symptom would be a block drawn one line too small and an overlap missed
  // at exactly the boundary.
  const holders = holdersOfFile({
    humans: [],
    agents: [agent({ grants: [grant({ ranges: [{ startLine: 10, endLine: 20 }] })] })],
  });
  assert.deepEqual(holders[0]?.ranges, [
    { file: "src/login.ts", start: 10, end: 21 },
  ]);
});

test("a whole-file hold is in the way of everything", () => {
  const whole = holdersOfFile({ humans: [hold()], agents: [] })[0];
  assert.ok(whole !== undefined);
  // Empty ranges mean the whole file, and they mean it from either side: a
  // plan that named the file outright, and an editor that has not said where
  // in it somebody is.
  assert.equal(holderBlocks(whole, []), true);
  assert.equal(holderBlocks(whole, [{ file: "src/login.ts", start: 1, end: 2 }]), true);

  const partial = holdersOfFile({
    humans: [hold({ ranges: [{ file: "src/login.ts", start: 10, end: 20 }] })],
    agents: [],
  })[0];
  assert.ok(partial !== undefined);
  assert.equal(holderBlocks(partial, []), true);
});

test("two people on neighbouring lines are not a collision", () => {
  const holder = holdersOfFile({
    humans: [hold({ ranges: [{ file: "src/login.ts", start: 10, end: 20 }] })],
    agents: [],
  })[0];
  assert.ok(holder !== undefined);

  const blocks = (start: number, end: number): boolean =>
    holderBlocks(holder, [{ file: "src/login.ts", start, end }]);

  // Overlapping, in every direction it can overlap.
  assert.equal(blocks(15, 18), true, "inside");
  assert.equal(blocks(5, 15), true, "over the start");
  assert.equal(blocks(15, 30), true, "over the end");
  assert.equal(blocks(1, 40), true, "around it");

  // And the boundaries. Half-open, so a hold that ends where another begins
  // is two people on neighbouring lines. Closed ranges here would refuse a
  // save for touching the line after somebody else's last one, which is the
  // kind of false refusal that teaches people to override without reading.
  assert.equal(blocks(20, 25), false, "starting where it ends");
  assert.equal(blocks(1, 10), false, "ending where it starts");
  assert.equal(blocks(19, 25), true, "one line inside the end");
});

test("nobody holding anything is nobody in the way", () => {
  assert.deepEqual(holdersOfFile({ humans: [], agents: [] }), []);
  // An agent with a lease that grants nothing is not a holder either.
  assert.deepEqual(
    holdersOfFile({ humans: [], agents: [agent({ grants: [] })] }),
    [],
  );
});
