import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const packageRoot = path.resolve(import.meta.dirname, "..");

type ThreadTask = {
  id: string;
  repositoryId: string;
  status: string;
  agentId: string;
  submittedBy: string;
  submittedAt: string;
  conversationId?: string;
};

type ThreadLiveness = {
  state: {
    tasks: ThreadTask[];
    agentBusy: Record<string, { expiresAt: number; at: number }>;
  };
  threadTask: (entry: { id?: string; taskId?: string }) =>
    | ThreadTask
    | undefined;
  threadIsWorking: (entry: { id?: string; taskId?: string }) => boolean;
};

async function threadLiveness(): Promise<ThreadLiveness> {
  const scope = globalThis as unknown as { window?: unknown };
  scope.window ??= {
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  };
  return (await import(
    pathToFileURL(path.join(packageRoot, "public", "data.js")).href
  )) as ThreadLiveness;
}

function task(
  id: string,
  status: string,
  conversationId?: string,
): ThreadTask {
  return {
    id,
    repositoryId: "repo",
    status,
    agentId: "codex",
    submittedBy: "user-1",
    submittedAt: new Date().toISOString(),
    ...(conversationId === undefined ? {} : { conversationId }),
  };
}

test("re-tasked thread resolves the active task sharing its conversationId while preserving original taskId fallback", async () => {
  const data = await threadLiveness();
  data.state.agentBusy = {};
  data.state.tasks = [
    task("first-task", "integrated", "thread-1"),
    task("follow-up-task", "claimed", "thread-1"),
  ];

  const thread = { id: "thread-1", taskId: "first-task" };
  assert.equal(data.threadTask(thread)?.id, "follow-up-task");
  assert.equal(data.threadIsWorking(thread), true);

  data.state.tasks = [task("first-task", "claimed")];
  assert.equal(data.threadTask(thread)?.id, "first-task");
  assert.equal(data.threadIsWorking(thread), true);
});

test("collapsed thread progress uses the active conversation turn instead of the completed original task", async () => {
  const source = await readFile(
    path.join(packageRoot, "public", "screen-chats.js"),
    "utf8",
  );
  const progressStart = source.indexOf("function threadProgress(entry)");
  const progressEnd = source.indexOf("\n/*", progressStart);
  const turnsStart = source.indexOf("function threadReplyTurns(replies)");
  const turnsEnd = source.indexOf("\n/** One turn's narration", turnsStart);

  assert.notEqual(progressStart, -1, "thread progress should still exist");
  assert.notEqual(progressEnd, -1, "thread progress should have a boundary");
  assert.notEqual(turnsStart, -1, "thread turns should still be grouped");
  assert.notEqual(turnsEnd, -1, "thread turn grouping should have a boundary");

  const progress = Function(
    "state",
    "THREAD_FINISHED_RE",
    "STAGE_PROGRESS",
    "taskProgress",
    `"use strict";\n${source.slice(turnsStart, turnsEnd)}\n${source.slice(
      progressStart,
      progressEnd,
    )}\nreturn threadProgress;`,
  )(
    {
      tasks: [
        {
          id: "first-task",
          conversationId: "thread-1",
          status: "integrated",
        },
        {
          id: "follow-up-task",
          conversationId: "thread-1",
          status: "claimed",
        },
      ],
    },
    /^(Done —|I could not|This was cancelled)/u,
    { submitted: 4, planning: 18, planned: 30, claimed: 44, validating: 88 },
    (candidate: { id: string }) =>
      candidate.id === "follow-up-task" ? 53 : 100,
  ) as (entry: {
    id: string;
    taskId: string;
    replies: Array<{ kind: string; content: string }>;
  }) => number | undefined;

  assert.equal(
    progress({ id: "thread-1", taskId: "first-task", replies: [] }),
    53,
  );
});
