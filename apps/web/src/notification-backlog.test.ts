import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * What is being protected here is one bug: opening the app on a phone and
 * being handed a column of banners about work that finished hours ago, none
 * of which could be dismissed.
 *
 * The dashboard is served as plain ES modules with no bundler and no DOM in
 * the test run, so — as with the transcript scroll — the behaviour is pinned
 * by asserting the shape of the source.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("the replay cursor survives a reload", async () => {
  const data = await publicFile("data.js");
  // The cursor used to be read from the audit list alone, and that list is a
  // project-filtered window over the oldest events the route will return —
  // so it pointed a long way behind the head and every reconnect replayed
  // the same history. Remembering the sequence as it arrives is what stops
  // the backlog being handed over again on the next unlock.
  assert.match(data, /const after = eventCursor\(\);/u);
  assert.match(data, /export function eventCursor\(\)/u);
  assert.match(data, /export function noteEventSequence\(sequence\)/u);
  assert.match(data, /"ag\.eventCursor"/u);
  // Forward only. A cursor that can move backwards is a replay waiting to
  // happen, and one recorded against another project is not this project's.
  assert.match(data, /Math\.max\(remembered, state\.audit\.at\(-1\)\?\.sequence \?\? 0\)/u);
  assert.match(data, /sequence <= eventCursor\(\)/u);
  assert.match(data, /raw\?\.projectId === state\.projectId/u);
});

test("news already seen does not get announced again", async () => {
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");
  // Three disqualifications, all of them the same complaint: news somebody
  // has already had.
  assert.match(app, /sequence <= announcedThrough\(\)/u);
  assert.match(app, /Date\.now\(\) - at > BANNER_STALE_MS/u);
  assert.match(app, /notificationSeen\(event \?\? \{\}\)/u);
  // The watermark outlives the tab, or a reload is a fresh start and the
  // whole backlog is news again.
  assert.match(data, /export function announcedThrough\(\)/u);
  assert.match(data, /"ag\.newsThrough"/u);
  // "Already read" has to mean the same thing to the banner as it does to
  // the notifications list, so both name an event the same way.
  assert.match(data, /function notificationId\(event\)/u);
  assert.match(data, /export function notificationSeen\(event\)/u);
  assert.match(data, /id: notificationId\(event\),/u);
});

test("marking every notification read survives a rebuilt audit window", async () => {
  const data = await publicFile("data.js");
  const screen = await publicFile("screen-notifications.js");

  assert.match(data, /sequence: entry\.sequence/u);
  assert.match(data, /export function notificationIsRead\(row\)/u);
  assert.match(data, /"ag\.notificationReadThrough"/u);
  assert.match(data, /export function markAllNotificationsRead/u);
  assert.match(screen, /markAllNotificationsRead\(\);/u);
  assert.match(screen, /!notificationIsRead\(row\)/u);
});

test("a frame is recorded before it is judged", async () => {
  const app = await publicFile("app.js");
  const audit = app.indexOf('if (frame?.type === "audit") {\n      // Remembered');
  assert.notEqual(audit, -1, "the audit branch should still exist");
  const record = app.indexOf("noteEventSequence(frame.sequence)", audit);
  const judge = app.indexOf("newsLineForFrame(frame)", audit);
  assert.notEqual(record, -1, "the arriving sequence should be recorded");
  // Recording is what moves the next connection's cursor past this event.
  // Doing it only for the frames that banner would leave the cursor behind
  // on every event the filter drops, which is most of a backlog.
  assert.equal(
    record < judge,
    true,
    "the sequence is remembered whether or not it is worth announcing",
  );
});

test("a backlog collapses into one banner", async () => {
  const app = await publicFile("app.js");
  // The hub drains from the cursor in batches of five hundred, one poll —
  // 500ms — apart. A coalesce window shorter than that gap flushes between
  // batches, which is one banner per batch rather than one banner.
  const settle = /const BACKLOG_SETTLE_MS = ([\d_]+);/u.exec(app);
  const live = /const NEWS_COALESCE_MS = ([\d_]+);/u.exec(app);
  assert.notEqual(settle, null, "the backlog window should be named");
  assert.notEqual(live, null, "the live window should be named");
  const settleMs = Number((settle?.[1] ?? "0").replaceAll("_", ""));
  const liveMs = Number((live?.[1] ?? "0").replaceAll("_", ""));
  assert.equal(
    settleMs > 500,
    true,
    "the backlog window has to outlast the hub's poll interval",
  );
  assert.equal(
    settleMs > liveMs,
    true,
    "a live event should still read as immediate",
  );
  // Which window applies is decided by whether the stream is still catching
  // up, and the hub's handshake is what says a replay is starting.
  assert.match(app, /catchingUp \? BACKLOG_SETTLE_MS : NEWS_COALESCE_MS/u);
  assert.match(app, /if \(frame\?\.type === "connected"\) \{\s*beginCatchUp\(\);/u);
});

test("a replay settles before it redraws the screen", async () => {
  const app = await publicFile("app.js");

  // Replays arrive in batches roughly 500ms apart. Both redraw paths have to
  // use the longer replay window, or the timer fires between every batch and
  // a phone appears to reload once a second until all history is delivered.
  assert.match(
    app,
    /function replayAwareDelay\(liveDelay\) \{\s*return catchingUp \? BACKLOG_SETTLE_MS : liveDelay;\s*\}/u,
  );
  assert.match(
    app,
    /replayAwareDelay\(CHANNEL_FRAME_COALESCE_MS\)/u,
    "the channel should reconcile once after replay",
  );
  assert.match(
    app,
    /replayAwareDelay\(CONTEXT_REFRESH_MS\)/u,
    "the app context should refresh once after replay",
  );
  assert.match(
    app,
    /if \(frame\?\.type === "connected"\) \{\s*beginCatchUp\(\);\s*return;/u,
    "a handshake without any changed data should not redraw the app",
  );
});

test("a banner can be closed, and only one is up at a time", async () => {
  const ui = await publicFile("ui.js");
  const styles = await publicFile("styles.css");
  // Whatever gets through, it replaces the banner before it rather than
  // stacking under it.
  assert.match(
    ui,
    /for \(const previous of host\.querySelectorAll\("\.toast\.banner"\)\) \{\s*previous\.remove\(\);/u,
  );
  // And it takes a tap to close, the same dismiss the error toast has.
  assert.match(ui, /dismiss\.className = "toast-close";/u);
  assert.match(ui, /dismiss\.setAttribute\("aria-label", "Dismiss"\);/u);
  // The toast host is click-through so it never swallows a tap meant for the
  // page — a banner with a button in it has to take its own taps back, or
  // the button is decoration.
  assert.match(styles, /\.toast\.banner \{[^}]*pointer-events: auto;/su);
});

test("returning users see completed work in the side panel", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");
  const styles = await publicFile("styles.css");

  // Conversational work stays open for follow-ups after it lands, so both
  // terminal integrations and open landed turns belong in the completed list.
  assert.match(app, /\["integrated", "open"\]\.includes\(task\.status\)/u);
  assert.match(app, /task\.completedAt \?\? task\.openedAt/u);
  assert.match(app, /completedAt > sinceAt/u);
  assert.match(app, /state\.catchUp = \{\s*projectId,\s*since: catchUp\.since,\s*tasks,/u);

  // It is the same resizable, mobile-aware column as a plan, not a modal that
  // blocks the channel, and it renders the task objectives as actual rows.
  assert.match(data, /catchUp: undefined/u);
  assert.match(chats, /function catchUpPanel\(\)/u);
  assert.match(chats, /<aside class="thread-panel catch-up-panel"/u);
  assert.match(chats, /class="catch-up-task-list"/u);
  assert.match(chats, /withoutRolePreamble\(task\.objective\)/u);
  assert.doesNotMatch(app, /catch-up-card/u);
  assert.match(styles, /\.catch-up-task-list \{/u);

  // Closing from the button, Escape, or a swipe advances the same personal
  // watermark only after the list has actually been shown.
  assert.match(app, /if \(state\.catchUp !== undefined\) \{\s*dismissSinceYouLeft\(\);/u);
  assert.match(app, /case "catch-up-close":\s*dismissSinceYouLeft\(\);/u);
  assert.match(app, /catch-up\/seen/u);
});
