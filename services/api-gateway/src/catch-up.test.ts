import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCatchUpDigest,
  catchUpSince,
  formatCatchUpDocument,
  CATCH_UP_MAX_LINES,
  CATCH_UP_MAX_LOOKBACK_MS,
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
