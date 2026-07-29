import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryCoordinationStore } from "@coord/persistence";
import type {
  ChangeSet,
  CoordinatorDecision,
  IntegrationResult,
  PlanAdmission,
} from "@coord/shared-types";

import {
  buildTaskHandoff,
  handoffResources,
  isTaskHandoff,
  renderHandoffContext,
  type HandoffInput,
} from "./handoff.js";
import {
  findTaskHandoffs,
  recordTaskHandoff,
  seedContextForTask,
} from "./handoff-store.js";

/**
 * A handoff is a view over the run record, not a recollection of it. These
 * tests hold it to that: every field has to come from evidence that was
 * actually passed in, and nothing may appear that was not.
 */

const VERSION = (revision: string, sequence: number) => ({
  sequence,
  revision,
  branch: "main",
  createdAt: "2026-07-29T00:00:00.000Z",
});

function integration(
  overrides: Partial<IntegrationResult> = {},
): IntegrationResult {
  return {
    taskId: "task_a",
    changeSetId: "changeset_1",
    status: "integrated",
    previousVersion: VERSION("a".repeat(40), 1),
    canonicalVersion: VERSION("b".repeat(40), 2),
    validation: [
      {
        command: { executable: "node", args: ["--test"], label: "tests" },
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        startedAt: "2026-07-29T00:00:00.000Z",
        durationMs: 10,
      },
    ],
    explanation: "Promoted bbbbbbbbbbbb atomically",
    ...overrides,
  };
}

function changeSet(paths: string[]): ChangeSet {
  return {
    id: "changeset_1",
    taskId: "task_a",
    baseVersion: 1,
    baseRevision: "a".repeat(40),
    patches: paths.map((path) => ({
      path,
      status: "modified" as const,
      patch: `--- a/${path}\n`,
    })),
    commandsRun: [],
    tests: [],
    dependenciesChanged: [],
    symbolsChanged: [],
    riskAssessment: { level: "low", reasons: [] },
    agentExplanation: "did the work",
    createdAt: "2026-07-29T00:00:00.000Z",
  };
}

function admission(overrides: Partial<PlanAdmission> = {}): PlanAdmission {
  return {
    status: "approved",
    taskId: "task_a",
    planRevision: 1,
    baseRevision: "a".repeat(40),
    ownershipGrants: [],
    constraints: [],
    blockedBy: [],
    conflicts: [],
    explanation: "no structural conflict with executing work",
    decidedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

function decision(overrides: Partial<CoordinatorDecision> = {}): CoordinatorDecision {
  return {
    decision: "approved",
    taskId: "task_a",
    ownershipGrants: [],
    constraints: [],
    blockedBy: [],
    explanation: "approved",
    ...overrides,
  };
}

function input(overrides: Partial<HandoffInput> = {}): HandoffInput {
  return {
    taskId: "task_a",
    objective: "Raise the value",
    repositoryId: "repo_1",
    canonicalRevision: "b".repeat(40),
    reason: "completed",
    now: () => new Date("2026-07-29T12:00:00.000Z"),
    ...overrides,
  };
}

test("a clean completion cites the promotion, the diff, and the passing gate", () => {
  const handoff = buildTaskHandoff(
    input({ integration: integration(), changeSet: changeSet(["src/a.ts"]) }),
  );

  assert.equal(handoff.reason, "completed");
  assert.deepEqual(
    handoff.completed.map((entry) => [entry.kind, entry.reference]),
    [
      ["canonical_promotion", "b".repeat(40)],
      ["changeset", "changeset_1"],
      ["validation", "tests"],
    ],
  );
  assert.match(
    handoff.completed[2]?.detail ?? "",
    /passed \(node --test\)/u,
  );
  // Nothing outstanding, and it says so rather than leaving an empty section
  // a reader has to interpret.
  assert.deepEqual(handoff.open, []);
  assert.deepEqual(handoff.nextSteps, ["nothing outstanding from this task"]);
  assert.deepEqual(handoff.gotchas, []);
});

test("a withheld resource becomes an open item naming who holds it", () => {
  const handoff = buildTaskHandoff(
    input({
      reason: "partially_completed",
      integration: integration(),
      changeSet: changeSet(["src/a.ts"]),
      admission: admission({
        status: "approved_with_constraints",
        deferredResources: [
          {
            resourceType: "file",
            resourceId: "src/shared.ts",
            heldBy: ["task_b"],
            reason: "owned by task_b in exclusive mode",
          },
        ],
      }),
      followUpTaskIds: ["task_followup"],
      withheldFiles: ["src/shared.ts"],
    }),
  );

  assert.deepEqual(handoff.open[0], {
    item: "file:src/shared.ts was not modified",
    blockedBy: ["task_b"],
    reason: "owned by task_b in exclusive mode",
  });
  // The dropped patch is recorded separately from the withheld resource: one
  // is "you were not allowed", the other is "work exists and was not applied".
  assert.match(handoff.open[1]?.item ?? "", /edits to src\/shared\.ts/u);
  assert.ok(
    handoff.completed.some(
      (entry) => entry.kind === "follow_up_task" && entry.reference === "task_followup",
    ),
  );
  assert.ok(
    handoff.nextSteps.some((step) => step.includes("task_followup")),
    handoff.nextSteps.join(" | "),
  );
  assert.ok(
    handoff.nextSteps.some((step) => step.includes("task_b")),
    "a blocked item should say what to wait for",
  );
});

test("a failing gate is a gotcha with its output, not a vague warning", () => {
  const handoff = buildTaskHandoff(
    input({
      reason: "failed",
      failure: "validation failed",
      integration: integration({
        status: "validation_failed",
        explanation: "Validation failed: tests",
        validation: [
          {
            command: { executable: "node", args: ["--test"], label: "tests" },
            exitCode: 1,
            stdout: "",
            stderr: "AssertionError: 29 !== 26",
            startedAt: "2026-07-29T00:00:00.000Z",
            durationMs: 10,
          },
        ],
      }),
    }),
  );

  assert.equal(handoff.reason, "failed");
  assert.match(handoff.gotchas[0] ?? "", /"tests" fails here \(exit 1\)/u);
  assert.match(handoff.gotchas[0] ?? "", /29 !== 26/u);
  assert.ok(
    handoff.open.some((entry) => entry.reason === "validation failed"),
  );
});

test("a replayed result says so, because the revision gap is visible", () => {
  const handoff = buildTaskHandoff(
    input({
      integration: integration({ replayedFrom: "c".repeat(40) }),
    }),
  );
  assert.match(handoff.gotchas[0] ?? "", /replayed onto a newer revision/u);
  assert.match(handoff.gotchas[0] ?? "", /cccccccccccc/u);
});

test("decisions carry the reason, not just the verdict", () => {
  const handoff = buildTaskHandoff(
    input({
      admission: admission({
        status: "approved_with_constraints",
        conflicts: [
          {
            taskIds: ["task_a", "task_b"],
            score: 35,
            disposition: "concurrent_with_notification",
            evidence: [],
            explanation: "symbol_overlap: orderTotal (+35)",
          },
        ],
      }),
      decision: decision({
        constraints: ["Do not modify src/shared.ts"],
      }),
      integration: integration(),
    }),
  );

  assert.match(handoff.decisions[0]?.decision ?? "", /approved_with_constraints/u);
  assert.match(handoff.decisions[0]?.rationale ?? "", /no structural conflict/u);
  assert.match(handoff.decisions[1]?.decision ?? "", /task_b scored 35/u);
  assert.match(handoff.decisions[1]?.rationale ?? "", /symbol_overlap/u);
  assert.equal(handoff.decisions[2]?.rationale, "Do not modify src/shared.ts");
});

test("the rendered context is checkable prose, and empty when there is nothing", () => {
  assert.equal(renderHandoffContext([]), "");

  const rendered = renderHandoffContext([
    buildTaskHandoff(
      input({
        integration: integration(),
        changeSet: changeSet(["src/a.ts"]),
      }),
    ),
  ]);
  assert.match(rendered, /## Handoff from earlier work/u);
  assert.match(rendered, /task_a — completed/u);
  assert.match(rendered, /canonical_promotion \[bbbb/u);
  assert.match(rendered, /Objective: Raise the value/u);
  // It tells the reader the claims are checkable rather than asking for trust.
  assert.match(rendered, /can be checked against the run it names/u);
});

test("a handoff round-trips through the audit log and comes back typed", async () => {
  const store = new InMemoryCoordinationStore();
  const handoff = buildTaskHandoff(
    input({
      projectId: "project_local",
      integration: integration(),
      changeSet: changeSet(["src/a.ts"]),
    }),
  );
  await recordTaskHandoff(store, handoff);

  const found = await findTaskHandoffs(store, { taskId: "task_a" });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], handoff);
  assert.equal(isTaskHandoff(found[0]), true);

  const seeded = await seedContextForTask(store, { taskId: "task_a" });
  assert.match(seeded, /task_a — completed/u);
});

test("handoffs are found by the resources they touched, newest first", async () => {
  const store = new InMemoryCoordinationStore();
  await recordTaskHandoff(
    store,
    buildTaskHandoff(
      input({
        taskId: "task_old",
        integration: integration(),
        changeSet: changeSet(["src/pricing/total.js"]),
        now: () => new Date("2026-07-29T10:00:00.000Z"),
      }),
    ),
  );
  await recordTaskHandoff(
    store,
    buildTaskHandoff(
      input({
        taskId: "task_new",
        integration: integration(),
        changeSet: changeSet(["src/pricing/total.js"]),
        now: () => new Date("2026-07-29T11:00:00.000Z"),
      }),
    ),
  );
  await recordTaskHandoff(
    store,
    buildTaskHandoff(
      input({
        taskId: "task_elsewhere",
        integration: integration(),
        changeSet: changeSet(["docs/readme.md"]),
      }),
    ),
  );

  const related = await findTaskHandoffs(store, {
    resources: ["src/pricing/total.js"],
  });
  assert.deepEqual(
    related.map((entry) => entry.taskId),
    ["task_new", "task_old"],
    "a successor needs the most recent state of the world first",
  );

  // Topical similarity is not the relation; touching the same file is.
  const unrelated = await findTaskHandoffs(store, {
    resources: ["src/nothing.ts"],
  });
  assert.deepEqual(unrelated, []);
});

test("resources are extracted from what the task actually touched", () => {
  const handoff = buildTaskHandoff(
    input({
      integration: integration(),
      changeSet: changeSet(["src/a.ts", "src/b.ts"]),
      admission: admission({
        deferredResources: [
          {
            resourceType: "file",
            resourceId: "src/shared.ts",
            heldBy: ["task_b"],
            reason: "held",
          },
        ],
      }),
    }),
  );
  assert.deepEqual(handoffResources(handoff), [
    "src/a.ts",
    "src/b.ts",
    "src/shared.ts",
  ]);
});

test("a non-handoff audit payload is ignored rather than half-parsed", async () => {
  const store = new InMemoryCoordinationStore();
  await store.appendAudit(undefined, {
    type: "handoff_recorded",
    taskId: "task_a",
    data: { handoff: { version: 99, taskId: "task_a" } },
  });
  assert.deepEqual(await findTaskHandoffs(store, { taskId: "task_a" }), []);
  assert.equal(isTaskHandoff({ version: 1 }), false);
});
