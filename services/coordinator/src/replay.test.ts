import assert from "node:assert/strict";
import test from "node:test";

import type { AgentPlan, ChangeSet } from "@coord/shared-types";

import { replayBlockers, type CanonicalAdvance } from "./replay.js";

/**
 * Whether a finished result survives canonical moving under it. Exact-base
 * integration says never; this says "not if the advance was about something
 * else", and has to be sure about "something else".
 */

function plan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    taskId: "task_a",
    objective: "raise the value",
    expectedFiles: ["src/a.ts"],
    expectedSymbols: ["alpha"],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
    ...overrides,
  };
}

function changeSet(paths: string[] = ["src/a.ts"]): ChangeSet {
  return {
    id: "changeset_1",
    taskId: "task_a",
    baseVersion: 1,
    baseRevision: "a".repeat(40),
    patches: paths.map((path) => ({
      path,
      status: "modified",
      patch: `--- a/${path}\n`,
    })),
    commandsRun: [],
    tests: [],
    dependenciesChanged: [],
    symbolsChanged: [],
    riskAssessment: { level: "low", reasons: [] },
    agentExplanation: "done",
    createdAt: new Date().toISOString(),
  };
}

function advance(overrides: Partial<CanonicalAdvance> = {}): CanonicalAdvance {
  return {
    changedFiles: [],
    changedSymbols: [],
    changedApis: [],
    changedSchemas: [],
    changedConfigKeys: [],
    changedTests: [],
    changedServices: [],
    ...overrides,
  };
}

test("an advance in another part of the tree does not block a replay", () => {
  assert.deepEqual(
    replayBlockers(
      plan(),
      changeSet(),
      advance({ changedFiles: ["src/b.ts"], changedSymbols: ["beta"] }),
    ),
    [],
  );
});

test("an advance to a file this result writes blocks it", () => {
  // Two changesets from one base, both promoted, and the second silently
  // discards the first. This is the case exact-base integration exists for.
  assert.deepEqual(
    replayBlockers(
      plan(),
      changeSet(),
      advance({ changedFiles: ["src/a.ts"] }),
    ),
    ["file:src/a.ts"],
  );
});

test("an advance to a file the plan claimed but never patched blocks it", () => {
  // The agent declared the file and reasoned about it; that it chose not to
  // edit it does not make the advance irrelevant.
  assert.deepEqual(
    replayBlockers(
      plan({ expectedFiles: ["src/a.ts", "src/considered.ts"] }),
      changeSet(["src/a.ts"]),
      advance({ changedFiles: ["src/considered.ts"] }),
    ),
    ["file:src/considered.ts"],
  );
});

test("an advance to something the plan depends on blocks it", () => {
  // The textually disjoint case that is still wrong: the agent read this
  // module and wrote code against it. Enrichment resolves imports into
  // `file:` dependency entries, which is what makes this visible at all.
  assert.deepEqual(
    replayBlockers(
      plan({ dependencies: ["file:src/shared.ts", "symbol:helper"] }),
      changeSet(),
      advance({ changedFiles: ["src/shared.ts"] }),
    ),
    ["file:src/shared.ts"],
  );
  assert.deepEqual(
    replayBlockers(
      plan({ dependencies: ["symbol:helper"] }),
      changeSet(),
      advance({ changedSymbols: ["helper"] }),
    ),
    ["symbol:helper"],
  );
});

test("an advance to a symbol this plan claims blocks it", () => {
  assert.deepEqual(
    replayBlockers(
      plan(),
      changeSet(),
      advance({ changedFiles: ["src/b.ts"], changedSymbols: ["alpha"] }),
    ),
    ["symbol:alpha"],
  );
});

test("every resource axis is checked, not just files and symbols", () => {
  const claiming = plan({
    expectedApis: ["GET /v1/a"],
    expectedSchemas: ["users"],
    expectedConfigKeys: ["FEATURE_X"],
    expectedTests: ["suite a"],
    expectedServices: ["ValueService"],
  });
  for (const [field, value, expected] of [
    ["changedApis", "GET /v1/a", "api:GET /v1/a"],
    ["changedSchemas", "users", "schema:users"],
    ["changedConfigKeys", "FEATURE_X", "configuration:FEATURE_X"],
    ["changedTests", "suite a", "test:suite a"],
    ["changedServices", "ValueService", "service:ValueService"],
  ] as const) {
    assert.deepEqual(
      replayBlockers(claiming, changeSet(), advance({ [field]: [value] })),
      [expected],
    );
  }
});

test("path and case differences do not let a collision through", () => {
  assert.deepEqual(
    replayBlockers(
      plan({ expectedFiles: ["src/a.ts"] }),
      changeSet(["src/a.ts"]),
      advance({ changedFiles: ["src\\A.ts"] }),
    ),
    ["file:src\\A.ts"],
  );
});

test("several collisions are all reported, deduplicated and ordered", () => {
  assert.deepEqual(
    replayBlockers(
      plan({ expectedFiles: ["src/a.ts"], expectedSymbols: ["alpha"] }),
      changeSet(["src/a.ts"]),
      advance({
        changedFiles: ["src/a.ts", "src/a.ts"],
        changedSymbols: ["alpha"],
      }),
    ),
    ["file:src/a.ts", "symbol:alpha"],
  );
});
