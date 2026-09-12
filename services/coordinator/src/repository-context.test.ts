import assert from "node:assert/strict";
import test from "node:test";

import type { CoordinationStore } from "@coord/persistence";
import { SqliteCoordinationStore } from "@coord/persistence";
import {
  REPOSITORY_CONTEXT_HEADING,
  type IntegrationResult,
  type TaskHandoff,
} from "@coord/shared-types";

import { buildTaskHandoff } from "./handoff.js";
import {
  DERIVED_PITFALLS_HEADING,
  UNREADABLE_CONTEXT_HEADING,
  UNREADABLE_STANDING_CONTEXT,
  derivePitfalls,
  standingContextForTask,
} from "./repository-context.js";

/**
 * The derived block is a projection of validation evidence in recorded
 * handoffs, and nothing else. These tests hold it to the same rule the
 * handoffs keep: every line has to come from evidence that was actually
 * recorded, under a heading that says nobody wrote it.
 *
 * The standing-context tests hold the read to the other rule: what the store
 * would not tell us is reported as unknown. A repository with no note and a
 * repository whose note could not be read are different answers, because the
 * consumer of both is a planning prompt, and a prompt with no note in it is
 * read as a repository with nothing to keep to.
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
  } finally {
    await store.close().catch(() => undefined);
  }
});

test("a repository nobody has written a note for is nothing, not a failed read", async () => {
  // The two have to stay different answers in both directions. A repository
  // with no row, and one whose note was cleared, are both "nobody has
  // written anything here" — which a prompt can say by saying nothing.
  const store = SqliteCoordinationStore.open(":memory:");
  try {
    await store.saveRepository({ id: "repo_1", path: "/canonical.git", branch: "main" });
    assert.equal(
      await standingContextForTask(store, { repositoryId: "repo_unknown" }),
      "",
    );

    await store.saveRepositoryContext({
      repositoryId: "repo_1",
      content: "Run `npm test` before reporting.",
      updatedBy: "user_nathan",
    });
    await store.saveRepositoryContext({
      repositoryId: "repo_1",
      content: "",
      updatedBy: "user_nathan",
    });
    assert.equal(await standingContextForTask(store, { repositoryId: "repo_1" }), "");
  } finally {
    await store.close().catch(() => undefined);
  }
});

test("a read that fails says so, and never passes for a repository with no note", async () => {
  // The guard exists so a task that cannot read the note still does the
  // work, and the shape of the answer is the whole of what the guard is
  // worth: a planning prompt that simply lacks the block is read as a
  // repository with no conventions to keep, which is a wrong answer built
  // out of a missing one.
  const store = SqliteCoordinationStore.open(":memory:");
  await store.saveRepository({ id: "repo_1", path: "/canonical.git", branch: "main" });
  await store.saveRepositoryContext({
    repositoryId: "repo_1",
    content: "The integration suite needs a database; `npm test` alone is not it.",
    updatedBy: "user_nathan",
  });
  await store.close();

  const answer = await standingContextForTask(store, { repositoryId: "repo_1" });
  assert.equal(answer, UNREADABLE_STANDING_CONTEXT);
  assert.ok(answer.startsWith(UNREADABLE_CONTEXT_HEADING), answer);
  assert.notEqual(answer, "");
  // And it cannot be mistaken for the note itself: the curated block's
  // heading is what says a named person stands behind what follows.
  assert.doesNotMatch(answer, /^## Standing context for this repository$/mu);
});

test("a store that throws before it returns a promise is a failed read like any other", async () => {
  // `standingContextForTask` promises never to throw. A `.catch` on the
  // returned promise keeps that promise only for a store that rejects; one
  // that throws on the way — a stub, a proxy, a client whose constructor
  // state went bad — would take the planning round down with it.
  const throwing = {
    getRepositoryContext(): never {
      throw new Error("no connection");
    },
  } as unknown as CoordinationStore;
  assert.equal(
    await standingContextForTask(throwing, { repositoryId: "repo_1" }),
    UNREADABLE_STANDING_CONTEXT,
  );
});

test("a row that cannot be rendered is a failed read, not an empty note", async () => {
  // A read that came back with something the renderer cannot make a block
  // out of — a `content` that is not text — has not succeeded. Reporting it
  // as "" would file a row nobody can read under "nobody wrote one".
  const broken = {
    getRepositoryContext: async () => ({
      repositoryId: "repo_1",
      content: undefined,
      updatedBy: "user_nathan",
      updatedAt: "2026-07-29T00:00:00.000Z",
      version: 2,
    }),
  } as unknown as CoordinationStore;
  assert.equal(
    await standingContextForTask(broken, { repositoryId: "repo_1" }),
    UNREADABLE_STANDING_CONTEXT,
  );
});

test("the block a consumer gets carries the version, the actor and the date it was written", async () => {
  // The note is a cache of facts about a repository, and facts go stale. A
  // consumer that needs fresh ones cannot be handed prose alone: the version
  // it can pin a write to, the person who is answerable for it, and when
  // they last touched it are what make a stale note checkable rather than
  // quietly wrong.
  const store = SqliteCoordinationStore.open(":memory:");
  try {
    await store.saveRepository({ id: "repo_1", path: "/canonical.git", branch: "main" });
    await store.saveRepositoryContext({
      repositoryId: "repo_1",
      content: "Old truth: the suite is `npm test`.",
      updatedBy: "user_nathan",
    });
    const first = await standingContextForTask(store, { repositoryId: "repo_1" });
    assert.match(first, /version 1, last updated by user_nathan at 20\d\d-\d\d-\d\d/u);

    // Read afresh every time it is asked for: nothing here caches the note
    // between planning rounds, so a note corrected while a wave is queued
    // reaches the next task rather than the one the process first saw.
    await store.saveRepositoryContext({
      repositoryId: "repo_1",
      content: "New truth: it is `npm run test:integration`, and it needs a database.",
      updatedBy: "user_other",
    });
    const second = await standingContextForTask(store, { repositoryId: "repo_1" });
    assert.match(second, /version 2, last updated by user_other/u);
    assert.match(second, /needs a database/u);
    assert.doesNotMatch(second, /Old truth/u);
  } finally {
    await store.close().catch(() => undefined);
  }
});

test("a note in any script survives to the prompt exactly as it was written", async () => {
  // The note is markdown somebody typed, in whatever language they work in,
  // and paths in a repository are not ASCII either. A block that mangled
  // them would be telling the agent to look for a directory that does not
  // exist.
  const content = "Тесты: `npm run тест`. Путь: `src/ünïcode/文件.ts` — не трогать 🚫";
  const store = SqliteCoordinationStore.open(":memory:");
  try {
    await store.saveRepository({ id: "repo_1", path: "/canonical.git", branch: "main" });
    await store.saveRepositoryContext({
      repositoryId: "repo_1",
      content,
      updatedBy: "user_nathan",
    });
    const rendered = await standingContextForTask(store, { repositoryId: "repo_1" });
    assert.ok(rendered.includes(content), rendered);
  } finally {
    await store.close().catch(() => undefined);
  }
});

test("two readers of one repository get the same block, and neither disturbs the other", async () => {
  // Two tasks in a wave plan at the same time against one store. The read is
  // a read: concurrent callers see one answer, and a save that lands between
  // them is visible to whoever reads after it rather than to nobody.
  const store = SqliteCoordinationStore.open(":memory:");
  try {
    await store.saveRepository({ id: "repo_1", path: "/canonical.git", branch: "main" });
    await store.saveRepositoryContext({
      repositoryId: "repo_1",
      content: "Prefer `npm run build` over a bare `tsc`.",
      updatedBy: "user_nathan",
    });
    const [left, right] = await Promise.all([
      standingContextForTask(store, { repositoryId: "repo_1" }),
      standingContextForTask(store, { repositoryId: "repo_1" }),
    ]);
    assert.equal(left, right);
    assert.match(left ?? "", /Prefer `npm run build`/u);
  } finally {
    await store.close().catch(() => undefined);
  }
});
