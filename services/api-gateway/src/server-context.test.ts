/** The gateway over HTTP: what survives a thread budget, a channel memo and an audit blob. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type ChannelMemoThread,
  elidedHistoryNotice,
  estimateTokens,
  selectChannelMemo,
  selectThreadContext,
  summariseAuditData,
  summariseChannelThread,
  truncateToTokens,
} from "./server.js";

test("estimateTokens approximates length in tokens", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("   "), 0);
  // Four characters to the token, rounded up.
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  const long = "word ".repeat(100);
  assert.ok(estimateTokens(long) > estimateTokens("word"));
});

test("truncateToTokens cuts an over-long entry at a word boundary", () => {
  const short = "already short enough";
  assert.equal(truncateToTokens(short, 50), short);

  const long = "alpha bravo charlie delta echo foxtrot golf hotel india";
  const cut = truncateToTokens(long, 6);
  assert.notEqual(cut, long);
  assert.ok(cut.endsWith("…"), cut);
  assert.ok(estimateTokens(cut) <= 7, cut);
  // Every word it kept is a whole word from the original.
  const words = cut.replace(" …", "").split(" ");
  for (const word of words) {
    assert.ok(long.split(" ").includes(word), `partial word: ${word}`);
  }
  assert.equal(truncateToTokens(long, 0), "");
});

test("selectThreadContext keeps the thread root and the newest entries within budget", () => {
  const filler = "padding ".repeat(40).trim();
  const lines = [
    "root: please make the sidebar collapsible",
    `first ${filler}`,
    `second ${filler}`,
    `third ${filler}`,
    "the newest thing anybody said",
  ];
  const selected = selectThreadContext({ lines, budgetTokens: 60 });
  assert.equal(selected.lines[0], lines[0]);
  assert.equal(selected.lines.at(-1), lines.at(-1));
  assert.ok(selected.lines.length < lines.length);
  const spent = selected.lines.reduce(
    (sum, line) => sum + estimateTokens(line),
    0,
  );
  assert.ok(spent <= 60, `spent ${String(spent)}`);
  // A thread that fits is sent whole.
  const whole = selectThreadContext({ lines: ["one", "two"] });
  assert.deepEqual(whole.lines, ["one", "two"]);
  assert.equal(whole.elided, 0);
});

test("selectThreadContext retains an older entry that is relevant to the request", () => {
  const filler = "padding ".repeat(30).trim();
  const lines = [
    "root: we are reworking the deployment pipeline",
    "we decided the migration runner must stay idempotent",
    `noise one ${filler}`,
    `noise two ${filler}`,
    "quick note",
  ];
  const focus = "is the migration runner still idempotent?";
  const selected = selectThreadContext({ lines, focus, budgetTokens: 60 });
  assert.ok(
    selected.lines.includes(
      "we decided the migration runner must stay idempotent",
    ),
    JSON.stringify(selected.lines),
  );
  // Without the request there is nothing to score it against, so recency
  // alone decides and the older decision drops off.
  const blind = selectThreadContext({ lines, budgetTokens: 60 });
  assert.ok(
    !blind.lines.includes(
      "we decided the migration runner must stay idempotent",
    ),
    JSON.stringify(blind.lines),
  );
});

test("selectThreadContext reports elided history instead of silently dropping it", () => {
  const filler = "padding ".repeat(40).trim();
  const lines = [
    "root",
    `one ${filler}`,
    `two ${filler}`,
    `three ${filler}`,
    "newest",
  ];
  const selected = selectThreadContext({ lines, budgetTokens: 40 });
  assert.equal(selected.elided, lines.length - selected.lines.length);
  assert.ok(selected.elided > 0);
  const notice = elidedHistoryNotice(selected.elided);
  assert.ok(notice.includes(String(selected.elided)), notice);
  assert.ok(elidedHistoryNotice(1).includes("1 earlier message "), "singular");
  assert.ok(elidedHistoryNotice(3).includes("3 earlier messages"), "plural");
});

test("summariseChannelThread speaks for a conversation only when it settled something", () => {
  const settled = summariseChannelThread({
    id: "one",
    kind: "user",
    content: "how should the retry loop back off?",
    replies: [
      { kind: "progress", content: "reading services/worker/src" },
      {
        kind: "outcome",
        content: "Switched retries to exponential backoff capped at a minute.",
      },
      { kind: "user", content: "nice" },
    ],
  });
  assert.ok(settled !== undefined);
  assert.ok(settled.startsWith("how should the retry loop back off?"), settled);
  assert.ok(settled.includes("exponential backoff"), settled);
  // A conversation that only chatted leaves nothing behind: carrying its
  // opening line alone is the dilution this layer exists to avoid.
  assert.equal(
    summariseChannelThread({
      id: "two",
      kind: "user",
      content: "morning all",
      replies: [{ kind: "agent", content: "looking now" }],
    }),
    undefined,
  );
  // People settling it between themselves counts, with no agent ending.
  const spoken = summariseChannelThread({
    id: "three",
    kind: "user",
    content: "which store backs the channel?",
    replies: [
      {
        kind: "user",
        content: "we decided the memory store stays the contract",
      },
    ],
  });
  assert.ok(spoken?.includes("we decided the memory store"), String(spoken));
  // An opening that decides on its own, with nobody needing to reply.
  assert.ok(
    summariseChannelThread({
      id: "four",
      kind: "user",
      content: "we are going with the queue instead of a cron",
    }) !== undefined,
  );
  // Deleted threads and the room's own machinery never speak for it.
  assert.equal(
    summariseChannelThread({
      id: "five",
      kind: "user",
      content: "we decided to drop the cache",
      deletedAt: new Date().toISOString(),
    }),
    undefined,
  );
  assert.equal(
    summariseChannelThread({
      id: "six",
      kind: "progress",
      content: "we decided to drop the cache",
    }),
    undefined,
  );
});

test("summariseChannelThread prefers the thread's ending over later chatter", () => {
  const line = summariseChannelThread({
    id: "one",
    kind: "user",
    content: "the export format",
    replies: [
      {
        kind: "outcome",
        content: "Shipped CSV export behind the same button.",
      },
      { kind: "user", content: "we will look at parquet another time" },
    ],
  });
  assert.ok(line?.includes("Shipped CSV export"), String(line));
  assert.ok(!line?.includes("parquet"), String(line));
});

test("selectChannelMemo carries the newest threads and older ones the request is about", () => {
  const thread = (
    id: string,
    content: string,
    decision: string,
  ): ChannelMemoThread => ({
    id,
    kind: "user",
    content,
    replies: [{ kind: "outcome", content: decision }],
  });
  const threads = [
    thread(
      "migration",
      "the deployment pipeline rewrite",
      "We decided the migration runner must stay idempotent.",
    ),
    thread("icons", "the icon set", "We chose the outline icons."),
    thread("copy", "the onboarding copy", "We went with the shorter blurb."),
    thread("colours", "the banner colour", "We settled on the muted teal."),
    thread("spacing", "the card spacing", "We chose eight point spacing."),
    thread("newest", "the sidebar width", "We decided on a fixed sidebar."),
  ];
  const lines = selectChannelMemo({
    threads,
    focus: "make the migration runner idempotent for the new backfill",
  });
  const joined = lines.join("\n");
  // Recency: the last thing the room settled is standing context.
  assert.ok(joined.includes("fixed sidebar"), joined);
  assert.ok(joined.includes("eight point spacing"), joined);
  // Relevance: the decision the request is actually about, from further back.
  assert.ok(joined.includes("migration runner must stay idempotent"), joined);
  // Everything unrelated in between stays out.
  assert.ok(!joined.includes("outline icons"), joined);
  assert.ok(!joined.includes("shorter blurb"), joined);
  // Read in the order the room happened.
  assert.ok(
    joined.indexOf("migration runner") < joined.indexOf("fixed sidebar"),
    joined,
  );
  // With nothing to score against, recency alone decides.
  const blind = selectChannelMemo({ threads });
  assert.ok(!blind.join("\n").includes("migration runner"), blind.join("\n"));
});

test("selectChannelMemo stays inside its budget and thread cap", () => {
  const filler = "padding ".repeat(30).trim();
  const threads = Array.from({ length: 10 }, (_, index) => ({
    id: `thread-${String(index)}`,
    kind: "user",
    content: `topic number ${String(index)} ${filler}`,
    replies: [
      {
        kind: "outcome",
        content: `We decided on option ${String(index)} ${filler}`,
      },
    ],
  }));
  const capped = selectChannelMemo({ threads, maxThreads: 1 });
  assert.equal(capped.length, 1);
  assert.ok(capped[0]?.includes("option 9"), String(capped[0]));
  const budgeted = selectChannelMemo({ threads, budgetTokens: 40 });
  const spent = budgeted.reduce((sum, line) => sum + estimateTokens(line), 0);
  assert.ok(spent <= 40, `spent ${String(spent)}`);
  assert.deepEqual(selectChannelMemo({ threads, budgetTokens: 0 }), []);
});

test("summariseAuditData keeps priority keys first and falls back to other scalar fields", () => {
  const summary = summariseAuditData({
    exitCode: 2,
    gate: "typecheck",
    status: "validation_failed",
    explanation: "the   typecheck   gate failed",
    retried: true,
    files: ["a.ts", "b.ts"],
  });
  const order = summary.split(" ").filter((part) => part.includes("="));
  assert.ok(summary.startsWith("status=validation_failed"), summary);
  assert.ok(summary.includes("explanation=the typecheck gate failed"), summary);
  assert.ok(summary.includes("files=2"), summary);
  // The fields outside the old allowlist now reach the model too.
  assert.ok(summary.includes("exitCode=2"), summary);
  assert.ok(summary.includes("gate=typecheck"), summary);
  assert.ok(summary.includes("retried=true"), summary);
  assert.ok(order.indexOf("status=validation_failed") === 0, summary);
});

test("summariseAuditData skips bulk payload fields and respects the per-event cap", () => {
  const summary = summariseAuditData({
    status: "completed",
    patch: "diff --git a/x b/x\n".repeat(200),
    stdout: "noise".repeat(500),
    taskId: "task_123",
    prompt: "the whole prompt",
    changedFiles: [{ path: "a.ts" }, { path: "b.ts" }],
  });
  assert.ok(summary.includes("status=completed"), summary);
  assert.ok(!summary.includes("patch="), summary);
  assert.ok(!summary.includes("stdout="), summary);
  assert.ok(!summary.includes("task_123"), summary);
  assert.ok(!summary.includes("prompt="), summary);
  assert.ok(summary.includes("changedFiles=2"), summary);
  assert.ok(summary.length <= 400, String(summary.length));

  const sprawling = summariseAuditData(
    Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `field${String(index)}`,
        "a value that is not especially short",
      ]),
    ),
  );
  assert.ok(sprawling.length <= 400, String(sprawling.length));
  assert.equal(summariseAuditData({}), "");
});

/** Opens an upgrade the way a shell does, and reports what came back. */
