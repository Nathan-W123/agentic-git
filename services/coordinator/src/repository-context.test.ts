import assert from "node:assert/strict";
import test from "node:test";

import { SqliteCoordinationStore } from "@coord/persistence";
import {
  REPOSITORY_CONTEXT_HEADING,
  type IntegrationResult,
  type TaskHandoff,
} from "@coord/shared-types";

import { buildTaskHandoff } from "./handoff.js";
import {
  DERIVED_PITFALLS_HEADING,
  derivePitfalls,
  standingContextForTask,
} from "./repository-context.js";

/**
 * The derived block is a projection of validation evidence in recorded
 * handoffs, and nothing else. These tests hold it to the same rule the
 * handoffs keep: every line has to come from evidence that was actually
 * recorded, under a heading that says nobody wrote it.
 */

const VERSION = (revision: string, sequence: number) => ({
  sequence,
  revision,
  branch: "main",
  createdAt: "2026-07-29T00:00:00.000Z",
});

function validation(label: string, exitCode: number) {
  return {
    command: { executable: "npm", args: ["run", label], label },
    exitCode,
    stdout: "",
    stderr: exitCode === 0 ? "" : "boom",
    startedAt: "2026-07-29T00:00:00.000Z",
    durationMs: 10,
  };
}

function integration(
  overrides: Partial<IntegrationResult> = {},
): IntegrationResult {
  return {
    taskId: "task_a",
    changeSetId: "changeset_1",
    status: "integrated",
    previousVersion: VERSION("a".repeat(40), 1),
    canonicalVersion: VERSION("b".repeat(40), 2),
    validation: [validation("tests", 0)],
    explanation: "Promoted bbbbbbbbbbbb atomically",
    ...overrides,
  };
}

function handoffWith(
  taskId: string,
  results: ReadonlyArray<[label: string, exitCode: number]>,
): TaskHandoff {
  return buildTaskHandoff({
    taskId,
    objective: `objective of ${taskId}`,
    repositoryId: "repo_1",
    canonicalRevision: "b".repeat(40),
    reason: "completed",
    integration: integration({
      validation: results.map(([label, exitCode]) => validation(label, exitCode)),
    }),
    now: () => new Date("2026-07-29T12:00:00.000Z"),
  });
}

test("a label that failed once is not a pitfall; one that keeps failing is, with its counts", () => {
  // Every task fails something at some point. One failure is that; two or
  // more across handoffs is a command that does not work here, which is what
  // a person would want to write into the standing context.
  assert.equal(
    derivePitfalls([
      handoffWith("task_1", [["tests", 1]]),
      handoffWith("task_2", [["tests", 0]]),
    ]),
    "",
  );

  // Newest first, as `findTaskHandoffs` returns them.
  const derived = derivePitfalls([
    handoffWith("task_3", [["tests", 1], ["lint", 0]]),
    handoffWith("task_2", [["tests", 0], ["lint", 0]]),
    handoffWith("task_1", [["tests", 1], ["lint", 0]]),
  ]);
  assert.ok(derived.startsWith(DERIVED_PITFALLS_HEADING), derived);
  assert.match(derived, /not written by anyone/u);
  assert.match(
    derived,
    /- `tests` failed in 2 of the last 3 tasks that ran it \(most recently task_3\)/u,
  );
  assert.doesNotMatch(derived, /`lint`/u);
});

test("a task retried after a failure is one task, however many handoffs it left", () => {
  // A retry keeps the task id and records a handoff per attempt. Two
  // attempts of one task must not read as two tasks: the line names tasks,
  // and a projection that overstates its evidence is the thing the
  // "not written by anyone" heading promises the reader it is not.
  assert.equal(
    derivePitfalls([
      handoffWith("task_1", [["tests", 1]]),
      handoffWith("task_1", [["tests", 1]]),
    ]),
    "",
  );

  // Two tasks failing, one of them twice, plus a third that passed: three
  // tasks ran it, two failed, and the retry adds nothing to either count.
  const derived = derivePitfalls([
    handoffWith("task_3", [["tests", 0]]),
    handoffWith("task_2", [["tests", 1]]),
    handoffWith("task_2", [["tests", 1]]),
    handoffWith("task_1", [["tests", 1]]),
  ]);
  assert.match(
    derived,
    /- `tests` failed in 2 of the last 3 tasks that ran it \(most recently task_2\)/u,
  );
});

test("only validation evidence counts towards a pitfall", () => {
  // A promotion, a changeset and a follow-up are evidence of other things.
  // Two handoffs with those alone, and a validation line whose detail is
  // not one this projection understands, produce nothing rather than a
  // guess.
  const unrelated: TaskHandoff = {
    ...handoffWith("task_9", []),
    completed: [
      { kind: "canonical_promotion", reference: "b".repeat(40), detail: "promoted" },
      { kind: "changeset", reference: "changeset_1", detail: "3 files" },
      { kind: "validation", reference: "tests", detail: "skipped by policy" },
    ],
  };
  assert.equal(derivePitfalls([unrelated, { ...unrelated, taskId: "task_8" }]), "");
});

test("the standing context is read from the store and rendered, or is nothing", async () => {
  const store = SqliteCoordinationStore.open(":memory:");
  try {
    await store.saveRepository({ id: "repo_1", path: "/canonical.git", branch: "main" });
    assert.equal(await standingContextForTask(store, { repositoryId: "repo_1" }), "");

    await store.saveRepositoryContext({
      repositoryId: "repo_1",
      content: "Run `npm test` before reporting.",
      updatedBy: "user_nathan",
    });
    const rendered = await standingContextForTask(store, { repositoryId: "repo_1" });
    assert.ok(rendered.startsWith(REPOSITORY_CONTEXT_HEADING), rendered);
    assert.match(rendered, /Run `npm test` before reporting\./u);
    assert.match(rendered, /version 1/u);

    // Never throws: a task that cannot read the note still does the work.
    await store.close();
    assert.equal(await standingContextForTask(store, { repositoryId: "repo_1" }), "");
  } finally {
    await store.close().catch(() => undefined);
  }
});
