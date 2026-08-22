import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCatchUpDigest,
  catchUpSince,
  formatCatchUpDocument,
  sanitiseSummary,
  summariseCatchUpLines,
  CATCH_UP_MAX_LINES,
  CATCH_UP_MAX_LOOKBACK_MS,
  CATCH_UP_SUMMARY_MAX_CHARS,
  type CatchUpInput,
} from "./catch-up.js";

const NOW = "2026-03-10T09:00:00.000Z";
const SINCE = "2026-03-09T18:00:00.000Z";

function digest(overrides: Partial<CatchUpInput> = {}) {
  return buildCatchUpDigest({
    since: SINCE,
    now: NOW,
    landed: [],
    failed: [],
    messages: [],
    direct: 0,
    ...overrides,
  });
}

test("a quiet interval produces no document at all", () => {
  const quiet = digest();
  assert.equal(quiet.empty, true);
  assert.deepEqual(quiet.lines, []);
  // Formatting an empty digest gives nothing, so a caller can test the text
  // rather than the flag and then the lines.
  assert.equal(formatCatchUpDocument(quiet), "");
});

test("somebody's first visit has no while-you-were-away", () => {
  assert.equal(catchUpSince(undefined, NOW), undefined);
});

test("a stale watermark is clamped to the lookback rather than honoured", () => {
  const floor = new Date(Date.parse(NOW) - CATCH_UP_MAX_LOOKBACK_MS)
    .toISOString();
  assert.equal(catchUpSince("2020-01-01T00:00:00.000Z", NOW), floor);
  // A recent one is left exactly as it was.
  assert.equal(catchUpSince(SINCE, NOW), SINCE);
});

test("landed work is named newest first and the rest is counted", () => {
  const built = digest({
    landed: [
      { objective: "Fix the retry loop", at: "2026-03-09T19:00:00.000Z" },
      { objective: "Add the export button", at: "2026-03-10T08:00:00.000Z" },
      { objective: "Rename the roster panel", at: "2026-03-09T22:00:00.000Z" },
      { objective: "Tidy the settings page", at: "2026-03-09T20:00:00.000Z" },
      { objective: "Speed up the search", at: "2026-03-09T18:30:00.000Z" },
    ],
  });
  assert.equal(built.empty, false);
  assert.equal(built.headline, "5 changes landed while you were away");
  assert.deepEqual(
    built.lines.map((line) => line.text),
    [
      "Add the export button",
      "Rename the roster panel",
      "Tidy the settings page",
      "and 2 more changes",
    ],
  );
  assert.equal(built.counts.landed, 5);
});

test("everything that is not landed work is collapsed to one line each", () => {
  const built = digest({
    landed: [{ objective: "Fix the retry loop", at: "2026-03-09T19:00:00.000Z" }],
    failed: [
      { objective: "Upgrade the toolchain", at: "2026-03-09T20:00:00.000Z" },
      { objective: "Rebuild the index", at: "2026-03-09T21:00:00.000Z" },
    ],
    messages: ["2026-03-09T19:30:00.000Z", "2026-03-09T23:00:00.000Z"],
    direct: 3,
  });
  assert.deepEqual(
    built.lines.map((line) => `${line.source}:${line.text}`),
    [
      "landed:Fix the retry loop",
      "failed:2 tasks didn't finish",
      "messages:2 new messages",
      "direct:3 unread direct messages",
    ],
  );
  assert.deepEqual(built.counts, {
    landed: 1,
    failed: 2,
    messages: 2,
    direct: 3,
  });
  // A single failure is worth naming; a pile of them is not.
  assert.match(
    digest({ failed: [{ objective: "Rebuild the index", at: NOW }] }).lines[0]
      ?.text ?? "",
    /^Didn't finish: Rebuild the index$/u,
  );
});

test("the document never grows past what fits on a phone", () => {
  const built = digest({
    landed: Array.from({ length: 40 }, (_, index) => ({
      objective: `Change ${index}`,
      at: `2026-03-09T19:${String(index).padStart(2, "0")}:00.000Z`,
    })),
    failed: [{ objective: "Rebuild the index", at: NOW }],
    messages: ["2026-03-09T19:30:00.000Z"],
    direct: 2,
  });
  assert.ok(built.lines.length <= CATCH_UP_MAX_LINES);
  assert.equal(
    formatCatchUpDocument(built).split("\n").length,
    built.lines.length + 1,
  );
});

test("a long objective is clipped on a word, not mid-word", () => {
  const built = digest({
    landed: [
      {
        objective:
          "Rework the notification banner so a backlog of finished work " +
          "cannot pile up unread on a phone",
        at: NOW,
      },
    ],
  });
  const text = built.lines[0]?.text ?? "";
  assert.ok(text.endsWith("…"), text);
  assert.ok(!text.includes(" …"), text);
  assert.ok(text.length < 80, text);
});

test("the headline says the most important thing that happened", () => {
  assert.equal(
    digest({ failed: [{ objective: "Rebuild the index", at: NOW }] }).headline,
    "Nothing landed, and 1 task stopped",
  );
  assert.equal(
    digest({ messages: ["2026-03-09T19:30:00.000Z"] }).headline,
    "1 new message while you were away",
  );
  assert.equal(digest({ direct: 2 }).headline, "2 unread direct messages");
});

/** One landed change, which is the smallest digest worth summarising. */
function oneChange() {
  return digest({
    landed: [{ objective: "Add a preview button", at: NOW }],
  });
}

test("without a local model the digest still reads as prose", async () => {
  const built = oneChange();
  // The deterministic wording is present before any model is consulted, so a
  // deployment without one shows the same document it always did.
  assert.equal(built.summary, formatCatchUpDocument(built));
  assert.ok(built.summary.includes("Add a preview button"));
  const unchanged = await summariseCatchUpLines(built, undefined);
  assert.equal(unchanged.summary, built.summary);
});

test("the local model's sentence replaces the wording, not the facts", async () => {
  const built = digest({
    landed: [{ objective: "Add a preview button", at: NOW }],
    direct: 2,
  });
  const summarised = await summariseCatchUpLines(
    built,
    async () => "A preview button landed, and two direct messages are waiting.",
  );
  assert.equal(
    summarised.summary,
    "A preview button landed, and two direct messages are waiting.",
  );
  // Presentation only: the list and the counts are exactly what was measured.
  assert.deepEqual(summarised.lines, built.lines);
  assert.deepEqual(summarised.counts, built.counts);
  assert.equal(summarised.headline, built.headline);
});

test("the model is given the facts it is meant to rewrite", async () => {
  const prompts: string[] = [];
  await summariseCatchUpLines(oneChange(), async (prompt) => {
    prompts.push(prompt);
    return "ok";
  });
  const prompt = prompts[0] ?? "";
  assert.ok(prompt.includes("Add a preview button"), prompt);
  // Told not to invent, because a small model asked for prose about six
  // bullet points will otherwise supply detail nobody measured.
  assert.ok(prompt.includes("Do not invent details"), prompt);
});

test("each completed task is named from the request and the agent result", async () => {
  const change = {
    id: "task-1",
    repositoryId: "repo-1",
    objective: "Move GitHub settings below agent settings",
    agentResponse:
      "Reordered the settings sections and kept their controls intact.",
    changedFiles: ["settings.js"],
    at: NOW,
  };
  const prompts: string[] = [];
  const built = digest({ landed: [change] });
  const summarised = await summariseCatchUpLines(
    built,
    async (prompt) => {
      prompts.push(prompt);
      return prompt.includes("User request:")
        ? "Moved GitHub settings directly below agent settings."
        : "One settings change landed.";
    },
    [change],
  );
  assert.equal(
    summarised.tasks[0]?.summary,
    "Moved GitHub settings directly below agent settings.",
  );
  assert.equal(summarised.tasks[0]?.repositoryId, "repo-1");
  assert.deepEqual(summarised.tasks[0]?.changedFiles, ["settings.js"]);
  const taskPrompt =
    prompts.find((prompt) => prompt.includes("User request:")) ?? "";
  assert.match(taskPrompt, /Move GitHub settings below agent settings/u);
  assert.match(taskPrompt, /Reordered the settings sections/u);
});

test("an unusable task rewrite falls back to the agent result, not the prompt", async () => {
  const change = {
    id: "task-1",
    repositoryId: "repo-1",
    objective: "A very long user request that should not become the title",
    agentResponse: "Moved the connection panel beneath the agent controls.",
    at: NOW,
  };
  const built = digest({ landed: [change] });
  const summarised = await summariseCatchUpLines(
    built,
    async (prompt) =>
      prompt.includes("User request:")
        ? "Implemented your role in this repo"
        : "One change landed.",
    [change],
  );
  assert.equal(
    summarised.tasks[0]?.summary,
    "Moved the connection panel beneath the agent controls.",
  );

  // Boilerplate that only says an agent ran is worth less than the request
  // it ran on, so the row describes the task rather than announcing that
  // something happened.
  const legacy = digest({
    landed: [{
      ...change,
      agentResponse:
        "Implemented: Your role in this repository: Backend. Move the panel.",
    }],
  });
  assert.equal(
    legacy.tasks[0]?.summary,
    "A very long user request that should not become the title.",
  );
});

test("a task with no account of itself is described by what it was asked", () => {
  const built = digest({
    landed: [{
      id: "task-1",
      repositoryId: "repo-1",
      objective: "move the github settings below the agent settings",
      at: NOW,
    }],
  });
  assert.equal(
    built.tasks[0]?.summary,
    "Move the github settings below the agent settings.",
  );

  // Only work with nothing to describe it at all falls back to the wording
  // that says nothing.
  const blank = digest({
    landed: [{ id: "task-2", repositoryId: "repo-1", objective: "", at: NOW }],
  });
  assert.equal(blank.tasks[0]?.summary, "Completed the requested work.");
});

test("a quiet interval never reaches the model at all", async () => {
  let asked = 0;
  const quiet = await summariseCatchUpLines(digest(), async () => {
    asked += 1;
    return "there is nothing to say but here is a sentence anyway";
  });
  assert.equal(asked, 0);
  assert.equal(quiet.summary, "");
  assert.equal(quiet.empty, true);
});

test("a reply with nothing usable in it leaves the wording alone", async () => {
  const built = oneChange();
  for (const answer of [undefined, null, "", "   ", "```\n```"]) {
    const summarised = await summariseCatchUpLines(built, async () => answer);
    assert.equal(summarised.summary, built.summary, JSON.stringify(answer));
  }
});

test("a model that throws is not a failed request", async () => {
  const built = oneChange();
  const threw = await summariseCatchUpLines(built, async () => {
    throw new Error("no onnx binary for this platform");
  });
  assert.equal(threw.summary, built.summary);
});

test("a rambling reply is clipped on a whole word", () => {
  const rambling = `${"a readable sentence ".repeat(40)}`;
  const clipped = sanitiseSummary(rambling) ?? "";
  assert.ok(clipped.length <= CATCH_UP_SUMMARY_MAX_CHARS + 1, clipped);
  assert.ok(clipped.endsWith("…"), clipped);
  assert.ok(!clipped.includes(" …"), clipped);
});

test("fencing and bullets the prompt asked against are taken off", () => {
  assert.equal(
    sanitiseSummary("```text\nThree changes landed.\n```"),
    "Three changes landed.",
  );
  assert.equal(
    sanitiseSummary("- Three changes landed."),
    "Three changes landed.",
  );
  assert.equal(
    sanitiseSummary("Three   changes\nlanded."),
    "Three changes landed.",
  );
});
