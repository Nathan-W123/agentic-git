import assert from "node:assert/strict";
import test from "node:test";

import { SqliteCoordinationStore } from "@coord/persistence";
import type {
  AppendAuditInput,
  AuditEventFilter,
  CoordinationStore,
} from "@coord/persistence";
import type { ChangeSet, IntegrationResult, TaskHandoff } from "@coord/shared-types";

import {
  buildTaskHandoff,
  HANDOFF_AUDIT_TYPE,
  type HandoffInput,
} from "./handoff.js";
import {
  AUDIT_PAGE_SIZE,
  contextHandoffsUsed,
  findTaskHandoffs,
  MAX_CONTEXT_HANDOFFS,
  readTaskHandoffs,
  recordTaskHandoff,
  seedContextForTask,
} from "./handoff-store.js";

/**
 * This is the memory between agents: what one task worked out, written where
 * the next one can find it. Two failures matter more than any other here, and
 * most of what follows is about one of them.
 *
 * The first is losing a handoff — a successor that starts blind starts blind
 * silently, because nothing in a fresh context window knows what it was never
 * shown. The second is returning a stale one first: a note from the
 * repository's first week, read as the current state of the world, is worse
 * than no note at all.
 */

const AT = (minute: number): Date => new Date(Date.UTC(2026, 6, 29, 12, minute));

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

/** A run that promoted a changeset and left a gate red behind it. */
function integration(): IntegrationResult {
  const version = (revision: string, sequence: number) => ({
    sequence,
    revision,
    branch: "main",
    createdAt: "2026-07-29T00:00:00.000Z",
  });
  return {
    taskId: "task_a",
    changeSetId: "changeset_1",
    status: "integrated",
    previousVersion: version("a".repeat(40), 1),
    canonicalVersion: version("b".repeat(40), 2),
    validation: [
      {
        command: { executable: "npm", args: ["test"], label: "tests" },
        exitCode: 1,
        stdout: "",
        stderr: "AssertionError: 29 !== 26",
        startedAt: "2026-07-29T00:00:00.000Z",
        durationMs: 10,
      },
    ],
    explanation: "promoted with a failing gate",
  };
}

function input(overrides: Partial<HandoffInput> = {}): HandoffInput {
  return {
    taskId: "task_a",
    objective: "Raise the value",
    repositoryId: "repo_1",
    canonicalRevision: "b".repeat(40),
    reason: "completed",
    now: () => AT(0),
    ...overrides,
  };
}

/** A handoff projected from the usual run record, with the parts under test varied. */
const handoff = (overrides: Partial<HandoffInput> = {}) =>
  buildTaskHandoff(input(overrides));

function freshStore(): CoordinationStore {
  return SqliteCoordinationStore.open(":memory:");
}

/**
 * A real store with one method watched or replaced.
 *
 * A proxy rather than a hand-written fake: the claims below are about how this
 * module reads a log, and a fake log would let a wrong read look right.
 */
function withStore(
  store: CoordinationStore,
  overrides: Partial<CoordinationStore>,
): CoordinationStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      const override = Reflect.get(overrides, property, overrides) as unknown;
      if (override !== undefined) {
        return override;
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as CoordinationStore;
}

test("a recorded handoff comes back out of the log exactly as it went in", async () => {
  // The whole point of the record is that a successor reads what the earlier
  // task actually left, not a lossy projection of it. Anything dropped in the
  // round trip is something nobody will ever know was there — so the handoff
  // written here has something in every section, and the comparison is the
  // whole object rather than the fields somebody remembered to name.
  const store = freshStore();
  const written = handoff({
    projectId: "project_1",
    runId: "run_1",
    reason: "partially_completed",
    integration: integration(),
    changeSet: changeSet(["src/pricing/total.ts"]),
    admission: {
      status: "approved_with_constraints",
      taskId: "task_a",
      planRevision: 1,
      baseRevision: "a".repeat(40),
      ownershipGrants: [],
      constraints: [],
      blockedBy: [],
      conflicts: [],
      deferredResources: [
        {
          resourceType: "file",
          resourceId: "src/shared.ts",
          heldBy: ["task_b"],
          reason: "owned by task_b in exclusive mode",
        },
      ],
      explanation: "admitted without the shared file",
      decidedAt: "2026-07-29T00:00:00.000Z",
    },
    followUpTaskIds: ["task_followup"],
    withheldFiles: ["src/shared.ts"],
    failure: "the shared file was never reached",
  });
  // Guards the comparison itself: a handoff with empty sections would
  // round-trip even if whole sections were being dropped.
  for (const section of [
    written.completed,
    written.open,
    written.decisions,
    written.gotchas,
    written.nextSteps,
  ]) {
    assert.ok(section.length > 0, JSON.stringify(written));
  }

  await recordTaskHandoff(store, written);

  assert.deepEqual(await findTaskHandoffs(store, { taskId: "task_a" }), [
    written,
  ]);
});

test("the audit row repeats the fields the log can be filtered on", async () => {
  // The handoff itself is opaque JSON to the log. Task, project, repository
  // and reason are lifted out beside it so a query can narrow without every
  // reader parsing every payload — and `reason` in particular is what the
  // context budget is counted from.
  const store = freshStore();
  await recordTaskHandoff(store, handoff({ projectId: "project_1" }));

  const [row] = await store.listAuditEvents({ types: [HANDOFF_AUDIT_TYPE] });
  assert.equal(row?.event.type, HANDOFF_AUDIT_TYPE);
  assert.equal(row?.event.taskId, "task_a");
  assert.deepEqual(Object.keys(row?.event.data ?? {}).sort(), [
    "handoff",
    "projectId",
    "reason",
    "repositoryId",
  ]);
  assert.equal(row?.event.data["repositoryId"], "repo_1");
  assert.equal(row?.event.data["reason"], "completed");
});

test("a handoff with no project is not stamped with an empty one", async () => {
  // The audit filter matches the stamped project id. A handoff recorded
  // outside a project has to carry no key at all rather than a key holding
  // nothing, which a store is free to read as a project of its own. Asserted
  // on what is handed to the log rather than on what comes back out of it:
  // one store drops an empty value on the way in and the next one keeps it,
  // and the caller has to be right for both.
  const store = freshStore();
  const written: AppendAuditInput[] = [];
  const watched = withStore(store, {
    appendAudit: async (runId: string | undefined, entry: AppendAuditInput) => {
      written.push(entry);
      return await store.appendAudit(runId, entry);
    },
  });

  await recordTaskHandoff(watched, handoff());
  await recordTaskHandoff(watched, handoff({ projectId: "project_1" }));

  assert.equal(written.length, 2);
  assert.equal("projectId" in (written[0]?.data ?? {}), false);
  assert.equal(written[1]?.data?.["projectId"], "project_1");
});

test("a handoff is attributed to the run that recorded it", async () => {
  // Usually its own run, so the handoff travels with that run's export. The
  // override exists for the requeue path, where the run doing the writing is
  // not the run the handoff describes.
  const store = freshStore();
  await recordTaskHandoff(store, handoff({ runId: "run_of_the_task" }));
  await recordTaskHandoff(store, handoff({ taskId: "task_b", runId: "run_of_the_task" }), {
    runId: "run_doing_the_writing",
  });

  const rows = await store.listAuditEvents({ types: [HANDOFF_AUDIT_TYPE] });
  assert.deepEqual(
    rows.map((row) => [row.event.taskId, row.runId]),
    [
      ["task_a", "run_of_the_task"],
      ["task_b", "run_doing_the_writing"],
    ],
  );
});

test("handoffs come back newest first", async () => {
  // A successor reads from the top and may never reach the bottom. The most
  // recent state of the world has to be the first thing it sees.
  const store = freshStore();
  for (const [index, taskId] of ["task_first", "task_second", "task_third"].entries()) {
    await recordTaskHandoff(
      store,
      handoff({ taskId, now: () => AT(index) }),
    );
  }

  assert.deepEqual(
    (await findTaskHandoffs(store)).map((entry) => entry.taskId),
    ["task_third", "task_second", "task_first"],
  );
});

test("the seed is five handoffs unless a caller asks for another number", async () => {
  // A seed, not an archive dump: it is going into somebody's context window,
  // and the older half of a long list costs the tokens the new work needs.
  const store = freshStore();
  for (let index = 0; index < 7; index += 1) {
    await recordTaskHandoff(
      store,
      handoff({ taskId: `task_${index}`, now: () => AT(index) }),
    );
  }

  assert.deepEqual(
    (await findTaskHandoffs(store)).map((entry) => entry.taskId),
    ["task_6", "task_5", "task_4", "task_3", "task_2"],
  );
  assert.deepEqual(
    (await findTaskHandoffs(store, { limit: 2 })).map((entry) => entry.taskId),
    ["task_6", "task_5"],
  );
});

test("a handoff recorded past the first page of the log is still the newest one found", async () => {
  // The log answers a page at a time, oldest first. Read once and unsized, a
  // repository busy enough to fill a page would seed every later task with
  // the handoffs it wrote when it was new — the newest note invisible, and no
  // sign anywhere that it was left out. This is the failure this module
  // cannot have, so the read walks to the end of the log.
  const store = freshStore();
  for (let index = 0; index < AUDIT_PAGE_SIZE; index += 1) {
    await store.appendAudit(undefined, {
      type: HANDOFF_AUDIT_TYPE,
      taskId: `task_old_${index}`,
      data: { handoff: handoff({ taskId: `task_old_${index}` }) },
    });
  }
  await recordTaskHandoff(store, handoff({ taskId: "task_newest" }));

  const found = await findTaskHandoffs(store, { limit: 1 });
  assert.deepEqual(
    found.map((entry) => entry.taskId),
    ["task_newest"],
    "the note written last is the one a successor needs first",
  );
});

test("handoffs are narrowed to the repository asked for", async () => {
  // One deployment coordinates many repositories, and a note about another
  // repository is not context, it is a distraction with a plausible shape.
  const store = freshStore();
  await recordTaskHandoff(store, handoff({ taskId: "task_here", repositoryId: "repo_1" }));
  await recordTaskHandoff(
    store,
    handoff({ taskId: "task_elsewhere", repositoryId: "repo_2", now: () => AT(1) }),
  );

  assert.deepEqual(
    (await findTaskHandoffs(store, { repositoryId: "repo_1" })).map(
      (entry) => entry.taskId,
    ),
    ["task_here"],
  );
});

test("handoffs are narrowed to the project asked for, and an unstamped one is not guessed at", async () => {
  // A handoff written with no project is not evidence that it belongs to the
  // project doing the asking. It is excluded rather than assumed in.
  const store = freshStore();
  await recordTaskHandoff(
    store,
    handoff({ taskId: "task_in_project", projectId: "project_1" }),
  );
  await recordTaskHandoff(
    store,
    handoff({ taskId: "task_no_project", now: () => AT(1) }),
  );

  assert.deepEqual(
    (await findTaskHandoffs(store, { projectId: "project_1" })).map(
      (entry) => entry.taskId,
    ),
    ["task_in_project"],
  );
});

test("a resource list narrows to the handoffs that touched one of them", async () => {
  // Relatedness is a file two tasks both touched, which a reader can check —
  // not two objectives that share a word.
  const store = freshStore();
  await recordTaskHandoff(
    store,
    handoff({ taskId: "task_pricing", changeSet: changeSet(["src/pricing/total.ts"]) }),
  );
  await recordTaskHandoff(
    store,
    handoff({
      taskId: "task_docs",
      changeSet: changeSet(["docs/readme.md"]),
      now: () => AT(1),
    }),
  );

  assert.deepEqual(
    (
      await findTaskHandoffs(store, { resources: ["src/pricing/total.ts"] })
    ).map((entry) => entry.taskId),
    ["task_pricing"],
  );
});

test("an empty resource list is no filter at all, not a filter that matches nothing", async () => {
  // A caller that plans no file changes yet still deserves the repository's
  // recent notes. Reading an empty list as "matches nothing" would silently
  // seed those tasks with an empty memory.
  const store = freshStore();
  await recordTaskHandoff(store, handoff({ changeSet: changeSet(["src/a.ts"]) }));

  assert.deepEqual(
    (await findTaskHandoffs(store, { resources: [] })).map(
      (entry) => entry.taskId,
    ),
    ["task_a"],
  );
});

test("a handoff compacted out of the live log is still found in the archive", async () => {
  // Archiving is housekeeping, not deletion, and a successor has no other
  // source for what an archived task learned. Only an operator pruning a
  // segment loses one, which is the trade this module states out loud.
  const store = freshStore();
  await recordTaskHandoff(store, handoff({ taskId: "task_archived" }));
  const archived = await store.archiveAuditEvents({ throughSequence: 1 });

  assert.equal(archived?.checkpoint.events, 1);
  assert.deepEqual(await store.listAuditEvents({ types: [HANDOFF_AUDIT_TYPE] }), []);
  assert.deepEqual(
    (await findTaskHandoffs(store, { taskId: "task_archived" })).map(
      (entry) => entry.taskId,
    ),
    ["task_archived"],
  );
});

test("the archive is read only when the live log did not already answer", async () => {
  // The archive is indexed by checkpoint rather than by task, so that leg is
  // a filtered scan. The common call — one or two recent notes — must not pay
  // for it.
  const store = freshStore();
  await recordTaskHandoff(store, handoff());
  let archiveReads = 0;
  const counted = withStore(store, {
    listArchivedAuditEvents: async (filter?: AuditEventFilter) => {
      archiveReads += 1;
      return await store.listArchivedAuditEvents(filter);
    },
  });

  assert.equal((await findTaskHandoffs(counted, { limit: 1 })).length, 1);
  assert.equal(archiveReads, 0, "the live log already had enough");

  await findTaskHandoffs(counted, { limit: 5 });
  assert.equal(archiveReads, 1, "short of the limit, the archive is worth a look");
});

test("an archive that cannot be read does not hide the live log", async () => {
  // Seeding is an advantage, not a gate: a task that cannot reach the archive
  // should still be handed the notes that are in front of it. Every caller
  // reads a thrown seed as "no handoffs at all", so throwing here would cost
  // the live log too.
  const store = freshStore();
  await recordTaskHandoff(store, handoff());
  const broken = withStore(store, {
    listArchivedAuditEvents: async () => {
      throw new Error("archive storage is offline");
    },
  });

  assert.deepEqual(
    (await findTaskHandoffs(broken)).map((entry) => entry.taskId),
    ["task_a"],
  );
});

test("a handoff sitting in both the live log and the archive is reported once", async () => {
  // The two legs are read and merged, and a store that keeps an archived copy
  // beside the live row would otherwise spend a successor's seed showing it
  // the same note twice.
  const store = freshStore();
  await recordTaskHandoff(store, handoff());
  const doubled = withStore(store, {
    listArchivedAuditEvents: async (filter?: AuditEventFilter) =>
      await store.listAuditEvents(filter),
  });

  const found = await findTaskHandoffs(doubled);
  assert.deepEqual(
    found.map((entry) => entry.taskId),
    ["task_a"],
  );
});

test("a stored record that is not a whole handoff is skipped, not half-read", async () => {
  // Recognising a record on a partial match does not read it half-well. The
  // renderer slices `canonicalRevision`, the deduplication keys on
  // `createdAt`, a heading is built from `reason` — so a record missing one of
  // them is accepted and then throws part-way through seeding, and every
  // caller reads a throw from the seed as "this repository has no handoffs".
  // One damaged row would take the whole memory down with it. Skipping it
  // costs that row and nothing else, so one row is damaged here in each of
  // the ways that matters.
  const store = freshStore();
  const whole = handoff({ taskId: "task_damaged" }) as unknown as Record<
    string,
    unknown
  >;
  for (const missing of [
    "version",
    "taskId",
    "objective",
    "repositoryId",
    "reason",
    "canonicalRevision",
    "createdAt",
    "completed",
    "open",
    "decisions",
    "gotchas",
    "nextSteps",
  ]) {
    const damaged = { ...whole };
    delete damaged[missing];
    await store.appendAudit(undefined, {
      type: HANDOFF_AUDIT_TYPE,
      taskId: "task_damaged",
      data: { handoff: damaged },
    });
  }
  await recordTaskHandoff(
    store,
    handoff({ taskId: "task_intact", now: () => AT(1) }),
  );

  assert.deepEqual(
    (await findTaskHandoffs(store)).map((entry) => entry.taskId),
    ["task_intact"],
  );
  assert.match(await seedContextForTask(store), /task_intact/u);
});

test("nothing on record seeds nothing at all", async () => {
  // Callers concatenate the seed unconditionally, so an empty record has to
  // render as the empty string rather than a heading with nothing under it.
  const store = freshStore();
  assert.equal(await seedContextForTask(store), "");
  assert.equal(await seedContextForTask(store, { taskId: "task_a" }), "");
});

test("the seed renders the handoffs the query selected, newest first", async () => {
  const store = freshStore();
  await recordTaskHandoff(store, handoff({ taskId: "task_older" }));
  await recordTaskHandoff(
    store,
    handoff({ taskId: "task_newer", now: () => AT(1) }),
  );
  await recordTaskHandoff(
    store,
    handoff({ taskId: "task_other_repo", repositoryId: "repo_2", now: () => AT(2) }),
  );

  const seeded = await seedContextForTask(store, { repositoryId: "repo_1" });
  assert.equal(seeded.includes("task_other_repo"), false);
  assert.ok(
    seeded.indexOf("task_newer") < seeded.indexOf("task_older"),
    seeded,
  );
});

test("only a stop for context pressure spends the context budget", async () => {
  // The budget is counted off the log rather than a column, so the count is
  // exactly as trustworthy as the handoffs themselves. A task that completed
  // or failed for any other reason has spent none of it.
  const store = freshStore();
  await recordTaskHandoff(store, handoff({ reason: "long_running" }));
  await recordTaskHandoff(store, handoff({ reason: "completed", now: () => AT(1) }));
  await recordTaskHandoff(store, handoff({ reason: "failed", now: () => AT(2) }));
  await recordTaskHandoff(
    store,
    handoff({ taskId: "task_b", reason: "long_running" }),
  );

  assert.equal(await contextHandoffsUsed(store, "task_a"), 1);
  assert.equal(
    await contextHandoffsUsed(store, "task_b"),
    1,
    "another task's stops are not this task's",
  );
  assert.equal(
    await contextHandoffsUsed(store, "task_never_seen"),
    0,
    "a task with no record has spent nothing",
  );
});

test("two stops spend the budget a task is given", async () => {
  // Two is a task that twice filled a window and was twice reseeded with
  // everything the control plane knows. The third stop is the honest failure.
  const store = freshStore();
  assert.equal(MAX_CONTEXT_HANDOFFS, 2);

  for (let attempt = 0; attempt < MAX_CONTEXT_HANDOFFS; attempt += 1) {
    assert.ok((await contextHandoffsUsed(store, "task_a")) < MAX_CONTEXT_HANDOFFS);
    await recordTaskHandoff(
      store,
      handoff({ reason: "long_running", now: () => AT(attempt) }),
    );
  }

  assert.equal(await contextHandoffsUsed(store, "task_a"), MAX_CONTEXT_HANDOFFS);
});

test("the budget is counted from the whole log, not from its first page", async () => {
  // Same page boundary as the seed, with a worse ending: a count read off one
  // page comes back low, and the task is handed a third window it was never
  // entitled to instead of the failure that says the objective does not fit.
  const store = freshStore();
  for (let index = 0; index < AUDIT_PAGE_SIZE; index += 1) {
    await store.appendAudit(undefined, {
      type: HANDOFF_AUDIT_TYPE,
      taskId: "task_a",
      data: { reason: "completed" },
    });
  }
  await recordTaskHandoff(store, handoff({ reason: "long_running" }));

  assert.equal(await contextHandoffsUsed(store, "task_a"), 1);
});

test("a record that could not be read is seeded as an unknown, not as nothing", async () => {
  // The rule the whole module is written to. A damaged record is skipped so
  // the rest of the log still reaches the successor — but a successor handed
  // the survivors alone cannot tell this log from a log that never held the
  // damaged note, and those two call for opposite behaviour: one starts from
  // a clean sheet, the other goes and looks. The count of what could not be
  // read therefore travels with the read and is stated in the seed.
  const store = freshStore();
  await store.appendAudit(undefined, {
    type: HANDOFF_AUDIT_TYPE,
    taskId: "task_damaged",
    data: { repositoryId: "repo_1", handoff: { version: 1, taskId: "task_damaged" } },
  });
  await recordTaskHandoff(store, handoff({ taskId: "task_intact" }));

  const read = await readTaskHandoffs(store, { repositoryId: "repo_1" });
  assert.deepEqual(
    read.handoffs.map((entry) => entry.taskId),
    ["task_intact"],
  );
  assert.equal(read.unreadable, 1);
  assert.equal(read.incomplete, false);

  const seeded = await seedContextForTask(store, { repositoryId: "repo_1" });
  assert.match(seeded, /Unknown:/u);
  assert.match(seeded, /1 handoff record[^s]/u);
  assert.match(seeded, /task_intact/u);
});

test("a log that cannot be read at all seeds an unknown rather than an empty note", async () => {
  // The failure this module must never have. Seeding cannot fail a run, so
  // the read is caught somewhere — and a caught read that renders as "" tells
  // the next agent, in the only words it will ever get, that nothing was
  // handed over. It then plans as though the repository were new.
  const store = withStore(freshStore(), {
    listAuditEvents: async () => {
      throw new Error("the audit log is unreachable");
    },
  });

  const seeded = await seedContextForTask(store, { repositoryId: "repo_1" });
  assert.notEqual(seeded, "");
  assert.match(seeded, /part of the log could not be read at all/u);
  assert.match(seeded, /incomplete record rather than an empty one/u);
  // And the plain read still throws, so a caller that can handle a failure is
  // not handed a quietly empty answer instead.
  await assert.rejects(findTaskHandoffs(store, { repositoryId: "repo_1" }));
});

test("an archive that could not be reached is reported beside what was read", async () => {
  // The live log in hand is worth more than the read that failed, so the
  // archive leg is caught rather than thrown. Caught is not the same as
  // forgotten: a seed short of the notes an unreachable archive held must not
  // read as a repository that never wrote them.
  const store = freshStore();
  await recordTaskHandoff(store, handoff());
  const broken = withStore(store, {
    listArchivedAuditEvents: async () => {
      throw new Error("archive storage is offline");
    },
  });

  const read = await readTaskHandoffs(broken);
  assert.deepEqual(
    read.handoffs.map((entry) => entry.taskId),
    ["task_a"],
  );
  assert.equal(read.incomplete, true);
  assert.match(await seedContextForTask(broken), /part of the log could not be read/u);
});

test("a record damaged in another repository is not reported against this one", async () => {
  // The count is shown to an agent working in one repository, and every line
  // it is shown has to be about that repository. The row mirrors the
  // repository beside the payload, so a damaged record that says where it
  // belongs can be attributed; one that does not is still counted, because a
  // record that might be this repository's and cannot be read is precisely
  // what an unknown is for.
  const store = freshStore();
  await store.appendAudit(undefined, {
    type: HANDOFF_AUDIT_TYPE,
    taskId: "task_elsewhere",
    data: { repositoryId: "repo_2", handoff: { version: 1 } },
  });
  await recordTaskHandoff(store, handoff());

  assert.equal((await readTaskHandoffs(store, { repositoryId: "repo_1" })).unreadable, 0);
  assert.equal((await readTaskHandoffs(store, { repositoryId: "repo_2" })).unreadable, 1);
  assert.equal((await readTaskHandoffs(store)).unreadable, 1, "unscoped, every damaged row counts");
});

test("a handoff written without the mirrored reason still spends the context budget", async () => {
  // `reason` beside the payload is a copy kept so the log can be filtered;
  // the handoff itself is the original. A row that carries only the original
  // — written before the copy existed, or by anything else that puts a
  // handoff on this log — counted for nothing, and a budget counted low hands
  // a task another window it has already proved it cannot use. That is the
  // loop the budget exists to end.
  const store = freshStore();
  const written = handoff({ reason: "long_running" });
  await store.appendAudit(undefined, {
    type: HANDOFF_AUDIT_TYPE,
    taskId: written.taskId,
    data: { handoff: written },
  });

  assert.equal(await contextHandoffsUsed(store, "task_a"), 1);
});

test("a handoff archived while the log is being read is still found, exactly once", async () => {
  // Compaction runs against a live system, so it can land between the two
  // legs of one read. The row moves out of the live log after it was read and
  // into the archive before that was read, which is the arrangement that
  // could report it twice; the other order would drop it. It is one handoff
  // either way.
  const store = freshStore();
  await recordTaskHandoff(store, handoff());
  const compacting = withStore(store, {
    listAuditEvents: async (filter?: AuditEventFilter) => {
      const page = await store.listAuditEvents(filter);
      await store.archiveAuditEvents({ throughSequence: 1 });
      return page;
    },
  });

  const read = await readTaskHandoffs(compacting);
  assert.deepEqual(
    read.handoffs.map((entry) => entry.taskId),
    ["task_a"],
  );
  assert.equal(read.unreadable, 0);
});

test("two tasks handing off at the same moment both keep their note", async () => {
  // Deduplication keys on task and timestamp, and two workers finishing in
  // the same millisecond is ordinary rather than exotic. Collapsing them
  // would lose one task's memory to another task's clock.
  const store = freshStore();
  await Promise.all([
    recordTaskHandoff(store, handoff({ taskId: "task_one" })),
    recordTaskHandoff(store, handoff({ taskId: "task_two" })),
  ]);

  assert.deepEqual(
    (await findTaskHandoffs(store)).map((entry) => entry.taskId).sort(),
    ["task_one", "task_two"],
  );
});

test("a record whose open items are damaged is reported, not rendered", async () => {
  // The predicate that says "this is a handoff" is what licenses everything
  // downstream to walk it, and the lists are the part a truncated payload
  // damages without changing the shape of the record. Rendering one throws
  // where the open items are joined — in the coordinator that happens outside
  // the guard the read is wrapped in, so it costs the run and not just the
  // seed. Skipped and counted is the whole of what this module can honestly
  // do with it.
  const store = freshStore();
  const written = handoff({ taskId: "task_damaged" });
  await store.appendAudit(undefined, {
    type: HANDOFF_AUDIT_TYPE,
    taskId: "task_damaged",
    data: {
      repositoryId: "repo_1",
      handoff: {
        ...written,
        open: [{ item: "the shared file was not reached", reason: "held" }],
      },
    },
  });
  await recordTaskHandoff(store, handoff({ taskId: "task_intact", now: () => AT(1) }));

  const read = await readTaskHandoffs(store, { repositoryId: "repo_1" });
  assert.deepEqual(
    read.handoffs.map((entry) => entry.taskId),
    ["task_intact"],
  );
  assert.equal(read.unreadable, 1);
  assert.match(await seedContextForTask(store, { repositoryId: "repo_1" }), /Unknown:/u);
});
