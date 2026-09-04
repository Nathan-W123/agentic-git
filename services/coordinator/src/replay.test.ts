import assert from "node:assert/strict";
import test from "node:test";

import type { AgentPlan, ChangeSet } from "@coord/shared-types";

import {
  assessReplay,
  residualAdvance,
  speculationLanded,
  replayBlockers,
  type CanonicalAdvance,
} from "./replay.js";

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

test("residual advance drops what speculation already covered", () => {
  assert.deepEqual(
    residualAdvance(
      advance({
        changedFiles: ["src/a.ts", "src/b.ts"],
        changedSymbols: ["alpha", "beta"],
      }),
      advance({ changedFiles: ["src/a.ts"], changedSymbols: ["alpha"] }),
    ),
    advance({ changedFiles: ["src/b.ts"], changedSymbols: ["beta"] }),
  );
});

test("a fully covered advance leaves an empty residual", () => {
  const landed = advance({
    changedFiles: ["src/a.ts"],
    changedSymbols: ["alpha"],
  });
  assert.deepEqual(residualAdvance(landed, landed), advance());
  assert.equal(speculationLanded(landed, landed), true);
});

test("speculation that predicted a file the advance omitted is invalid", () => {
  assert.equal(
    speculationLanded(
      advance({ changedFiles: ["src/a.ts", "src/b.ts"] }),
      advance({ changedFiles: ["src/a.ts"] }),
    ),
    false,
  );
});

test("assessReplay against a residual treats a covered holder landing as unsurprising", () => {
  const waiting = plan({
    expectedFiles: ["src/a.ts", "src/shared.ts"],
    dependencies: ["file:src/shared.ts"],
  });
  const landed = advance({ changedFiles: ["src/shared.ts"] });
  const speculated = advance({ changedFiles: ["src/shared.ts"] });
  const full = assessReplay(waiting, changeSet(["src/a.ts"]), landed);
  assert.deepEqual(full.semantic, ["file:src/shared.ts"]);
  const residual = assessReplay(
    waiting,
    changeSet(["src/a.ts"]),
    residualAdvance(landed, speculated),
  );
  assert.deepEqual(residual.semantic, []);
  assert.deepEqual(residual.textual, []);
});

test("a plan with an uncomputable read set treats every advance as semantic", () => {
  // Absence of evidence, not evidence of absence. `dependencies` is empty on
  // both plans below; only one of them knows that means anything.
  const advanced = advance({ changedFiles: ["src/elsewhere.ts"] });

  const guessing = assessReplay(plan(), changeSet(), advanced);
  assert.deepEqual(guessing.semantic, []);

  const honest = assessReplay(
    plan({ dependenciesUnknown: true }),
    changeSet(),
    advanced,
  );
  assert.deepEqual(honest.semantic, ["file:src/elsewhere.ts"]);
  assert.deepEqual(honest.textual, []);
});

test("a known-empty read set still replays a textual overlap", () => {
  // The optimisation this must not cost: a plan whose read set was genuinely
  // computed keeps the cheap answer, and an advance on a file it also wrote
  // stays textual rather than being promoted to semantic.
  const assessment = assessReplay(
    plan(),
    changeSet(["src/a.ts"]),
    advance({ changedFiles: ["src/a.ts"] }),
  );
  assert.deepEqual(assessment.semantic, []);
  assert.deepEqual(assessment.textual, ["file:src/a.ts"]);
});
