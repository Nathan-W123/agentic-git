import assert from "node:assert/strict";
import test from "node:test";

import type { McpSessionRecord } from "@coord/persistence";

import {
  McpBriefSeedCache,
  McpSessionHandle,
  MCP_SESSION_MAX_TASKS,
  capText,
  initializeParamsOf,
  initializedOk,
  newMcpSessionId,
  parseSessionHeader,
  protocolVersionAcceptable,
  renderSessionBrief,
  STANDING_INSTRUCTIONS,
} from "./mcp-session.js";

/**
 * The decisions a session makes, without a store or an HTTP server under them.
 *
 * `server-mcp.test.ts` covers the wiring — the header really travelling, the
 * row really being written. What is here is the part that has to be right when
 * a client sends something nobody planned for, which a live gateway is bad at
 * arranging on demand.
 */

function record(overrides: Partial<McpSessionRecord> = {}): McpSessionRecord {
  return {
    id: "mcps_1",
    userId: "user_nathan",
    tokenId: "tok_1",
    editorVendor: "claude",
    clientName: "Claude Code",
    clientVersion: "1.2.3",
    protocolVersion: "2025-06-18",
    focus: undefined,
    tasks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-02T00:00:00.000Z",
    endedAt: undefined,
    ...overrides,
  };
}

test("a session header is trimmed, and refused when it is not visible ASCII or too long", () => {
  assert.equal(parseSessionHeader("  mcps_abc  "), "mcps_abc");
  assert.equal(parseSessionHeader(undefined), undefined);
  assert.equal(parseSessionHeader(""), undefined);
  // The shape a repeated header really travels in: Node comma-joins every
  // duplicated header but `set-cookie`, so two ids arrive as one string and
  // the space in it is what refuses them — two ids is not one session.
  assert.equal(parseSessionHeader("mcps_a, mcps_b"), undefined);
  // The array is the caller-error case, not the HTTP one.
  assert.equal(parseSessionHeader(["mcps_a", "mcps_b"]), undefined);
  // The spec's own rule. Anything outside it cannot be a key this server
  // minted, so it is refused here rather than turned into a store lookup.
  assert.equal(parseSessionHeader("mcps a"), undefined);
  assert.equal(parseSessionHeader("mcps_é"), undefined);
  assert.equal(parseSessionHeader(`mcps_${"a".repeat(400)}`), undefined);
});

test("a protocol version newer than ours or malformed is not acceptable, and absent is", () => {
  assert.equal(protocolVersionAcceptable(undefined), true);
  assert.equal(protocolVersionAcceptable("2025-06-18"), true);
  assert.equal(protocolVersionAcceptable("2024-11-05"), true);
  assert.equal(protocolVersionAcceptable("2099-01-01"), false);
  assert.equal(protocolVersionAcceptable("latest"), false);
  assert.equal(protocolVersionAcceptable("2025-6-18"), false);
});

test("initialize params are read with their lengths capped", () => {
  const read = initializeParamsOf({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "C".repeat(500), version: "1.2.3" },
    },
  });
  assert.equal(read.protocolVersion, "2025-06-18");
  assert.equal(read.clientVersion, "1.2.3");
  // Somebody else's text, printed back into a brief, so it is bounded here.
  assert.equal(read.clientName?.length, 120);
  assert.deepEqual(initializeParamsOf({ jsonrpc: "2.0" }), {});
  assert.deepEqual(initializeParamsOf("not a message"), {});
});

test("only a 200 reply carrying a result counts as initialized", () => {
  // The whole reason a session is minted on the answer rather than on the
  // parsed method: a malformed handshake is refused before the initialize
  // branch, and handing out an id on an error reply would leave the client
  // holding one this server never recorded.
  assert.equal(
    initializedOk({ status: 200, body: { jsonrpc: "2.0", id: 1, result: {} } }),
    true,
  );
  assert.equal(initializedOk({ status: 202 }), false);
  assert.equal(
    initializedOk({
      status: 200,
      body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "no" } },
    }),
    false,
  );
});

test("a fresh session id is visible ASCII and unique", () => {
  const ids = new Set<string>();
  for (let index = 0; index < 50; index += 1) {
    const id = newMcpSessionId();
    assert.match(id, /^mcps_[!-~]+$/u);
    ids.add(id);
  }
  assert.equal(ids.size, 50);
});

test("a session remembers at most twenty tasks, newest last, without duplicates", () => {
  const handle = new McpSessionHandle(record());
  for (let index = 0; index < 25; index += 1) {
    handle.noteTask({
      taskId: `task_${index}`,
      objective: "o".repeat(500),
      repositoryId: "payments",
      channel: undefined,
      via: "submit_task",
    });
  }
  // The same task twice is one entry, moved to the end: a client that re-files
  // the same work has just touched it again.
  handle.noteTask({
    taskId: "task_7",
    objective: "again",
    repositoryId: "payments",
    channel: undefined,
    via: "submit_task",
  });
  assert.equal(handle.tasks.length, MCP_SESSION_MAX_TASKS);
  assert.equal(handle.tasks.at(-1)?.taskId, "task_7");
  assert.equal(handle.newNotes.length, 25);
  // The objective is a reminder, not a second copy of the task.
  assert.equal(handle.newNotes[0]?.objective.length, 200);

  const patch = handle.patch(new Date("2026-01-01T06:00:00.000Z"), 3_600_000);
  assert.equal(patch.lastSeenAt, "2026-01-01T06:00:00.000Z");
  assert.equal(patch.expiresAt, "2026-01-01T07:00:00.000Z");
  assert.equal(patch.noteTasks?.max, MCP_SESSION_MAX_TASKS);
  // Only what this request added: the store does the merge, because two
  // parallel calls each writing a whole list would lose one of them.
  assert.equal(patch.noteTasks?.tasks.length, 25);
  // No `focus` key at all until somebody sets one, so a request that only
  // read cannot clear the focus an earlier one wrote.
  assert.equal("focus" in patch, false);

  handle.setFocus({
    projectId: "project_local",
    repositoryId: "payments",
    channel: "general",
  });
  assert.equal(handle.focusChanged, true);
  assert.deepEqual(
    handle.patch(new Date("2026-01-01T06:00:00.000Z"), 3_600_000).focus,
    { projectId: "project_local", repositoryId: "payments", channel: "general" },
  );
});

test("the seed cache answers from memory inside the window and reloads after it", async () => {
  let clock = 1_000;
  const cache = new McpBriefSeedCache(() => clock);
  let loads = 0;
  const load = async () => {
    loads += 1;
    return { handoffContext: "handoffs", standingContext: "" };
  };
  assert.equal((await cache.get("user_1", "payments", load)).handoffContext, "handoffs");
  await cache.get("user_1", "payments", load);
  assert.equal(loads, 1);
  // Somebody else's brief is somebody else's read: the key carries the person
  // as well as the repository, because a brief is authorized for whoever asked.
  await cache.get("user_2", "payments", load);
  assert.equal(loads, 2);
  clock += 60_001;
  await cache.get("user_1", "payments", load);
  assert.equal(loads, 3);
});

test("two briefs gathered at once share one read", async () => {
  const cache = new McpBriefSeedCache(() => 1_000);
  let loads = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = async () => {
    loads += 1;
    await gate;
    return { handoffContext: "handoffs", standingContext: "" };
  };
  const both = Promise.all([
    cache.get("user_1", "payments", load),
    cache.get("user_1", "payments", load),
  ]);
  release?.();
  const [first, second] = await both;
  assert.equal(loads, 1);
  assert.equal(first?.handoffContext, "handoffs");
  assert.equal(second?.handoffContext, "handoffs");
});

test("a brief with nothing on record is the standing instructions alone", () => {
  assert.equal(
    renderSessionBrief({
      standing: STANDING_INSTRUCTIONS,
      recentTasks: [],
      handoffContext: "",
      maxChars: 6_000,
    }),
    STANDING_INSTRUCTIONS,
  );
});

test("a brief lists the instructions, then focus, then tasks, then handoffs, then standing context", () => {
  // Ordered so the tail is what truncation cuts: what a model cannot work out
  // for itself first, background it can live without last.
  const brief = renderSessionBrief({
    standing: STANDING_INSTRUCTIONS,
    focus: {
      projectId: "project_local",
      repositoryId: "payments",
      channel: "general",
    },
    resumedFrom: { clientName: "Claude Code", lastSeenAt: "2026-01-01T00:00:00.000Z" },
    recentTasks: [
      {
        taskId: "task_1",
        objective: "raise the retry ceiling",
        repositoryId: "payments",
        state: "running",
        outcome: "Landed as a1b2c3.",
      },
    ],
    handoffContext: "## Handoff from earlier work on this repository",
    standingContext: "## Standing context for this repository",
    maxChars: 6_000,
  });
  const at = (needle: string) => {
    const index = brief.indexOf(needle);
    assert.ok(index >= 0, `${needle} missing from:\n${brief}`);
    return index;
  };
  assert.ok(at("You are connected to Kumi") < at("You were last working in payments (#general)"));
  assert.ok(at("You were last working in payments (#general)") < at("task_1"));
  assert.ok(at("task_1") < at("## Handoff from earlier work"));
  assert.ok(at("## Handoff from earlier work") < at("## Standing context"));
  assert.match(brief, /raise the retry ceiling/u);
  assert.match(brief, /running/u);
  assert.match(brief, /Landed as a1b2c3\./u);
  assert.match(brief, /Last seen 2026-01-01T00:00:00\.000Z from Claude Code\./u);
});

test("a brief longer than the cap is cut from the tail and says so", () => {
  const brief = renderSessionBrief({
    standing: STANDING_INSTRUCTIONS,
    recentTasks: [
      {
        taskId: "task_1",
        objective: "raise the retry ceiling",
        repositoryId: "payments",
        state: "running",
      },
    ],
    handoffContext: Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n"),
    maxChars: 1_000,
  });
  assert.ok(brief.length <= 1_000, String(brief.length));
  // The half a model cannot recover on its own survives; the background is
  // what goes, and the marker names the tool that still has it.
  assert.match(brief, /task_1/u);
  assert.equal(
    brief.split("\n").at(-1),
    "… (cut short — call session_context for the rest)",
  );
});

test("text that fits is left exactly as it is, and a cut lands on a line", () => {
  assert.equal(capText("short", 100), "short");
  const marker = "\n… (cut short — call session_context for the rest)";
  const text = Array.from(
    { length: 20 },
    (_unused, index) => `line ${index}`,
  ).join("\n");
  // Room for three whole lines *and* the marker, so the cut really falls on
  // the newline. A cap too small to hold the marker never reaches that branch
  // at all, which is what made the old assertion here pass on nothing
  // surviving rather than on a boundary being found.
  const room = "line 0\nline 1\nline 2\n".length;
  const cut = capText(text, marker.length + room);
  assert.ok(cut.length <= marker.length + room, String(cut.length));
  assert.ok(cut.startsWith("line 0\nline 1\nline 2"), cut);
  assert.equal(cut.includes("line 3"), false);
  assert.ok(cut.endsWith(marker), cut);
  // And a cap the marker cannot fit inside cuts flat instead of overrunning:
  // a bound that hands back more than it was asked for is not a bound, and
  // this one exists to limit what a handshake injects into a model's context.
  assert.equal(capText(text, 12), "line 0\nline ");
  assert.equal(capText(text, 0), "");
});

test("the row a handshake writes carries what the brief adopted", () => {
  // `initialize` creates its row instead of patching one, so the focus the
  // brief inherited from the last session has to travel on the handle. Without
  // this the client is told its tools default to a repository and the row that
  // lands has no focus at all.
  const opened = record();
  const handle = new McpSessionHandle(opened);
  handle.setFocus({
    projectId: "project_default",
    repositoryId: "payments",
    channel: "general",
  });
  handle.noteTask(
    {
      taskId: "task_1",
      objective: "cap the retries",
      repositoryId: "payments",
      channel: "general",
      via: "submit_task",
    },
    "2026-01-01T00:00:01.000Z",
  );
  assert.equal(handle.row.focus?.repositoryId, "payments");
  assert.deepEqual(
    handle.row.tasks.map((task) => task.taskId),
    ["task_1"],
  );
  // The record it was handed is left as it was: the handle reports what this
  // request changed, and the caller decides what to do with it.
  assert.equal(opened.focus, undefined);
  assert.deepEqual(opened.tasks, []);
});
