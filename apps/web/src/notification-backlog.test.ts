import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/** The dashboard ships as plain ES modules, so these behaviours are pinned by
 * asserting the shape of the source. */
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

test("audit updates do not interrupt the current screen with a popup", async () => {
  const app = await publicFile("app.js");
  const ui = await publicFile("ui.js");

  assert.doesNotMatch(app, /popupBanner|announceNews|newsLineForFrame/u);
  assert.doesNotMatch(ui, /export function banner\(message\)/u);
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

test("every audit frame advances the replay cursor", async () => {
  const app = await publicFile("app.js");
  const audit = app.indexOf('if (frame?.type === "audit") {');
  assert.notEqual(audit, -1, "the audit branch should still exist");
  const record = app.indexOf("noteEventSequence(frame.sequence)", audit);
  assert.notEqual(record, -1, "the arriving sequence should be recorded");
  assert.match(app.slice(record, record + 100), /extendCatchUp\(\)/u);
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
  assert.match(app, /state\.catchUps = Object\.fromEntries/u);
  assert.match(app, /task\.repositoryId === repository\.id/u);
  assert.match(app, /state\.catchUp = state\.catchUps\[activeChannelId\(\)\]/u);

  // It is the same resizable, mobile-aware column as a plan, not a modal that
  // blocks the channel. Each row reads the local model's short outcome built
  // from the request and completion explanation, rather than echoing either.
  assert.match(data, /catchUp: undefined/u);
  assert.match(chats, /function catchUpPanel\(\)/u);
  assert.match(chats, /<aside class="thread-panel catch-up-panel"/u);
  assert.match(chats, /class="catch-up-task-list"/u);
  assert.match(data, /catchUps: \{\}/u);
  assert.match(app, /const serverOutcomes = new Map/u);
  assert.match(app, /outcome\?\.summary/u);
  // A row the server wrote no account of is left out rather than captioned
  // with the request somebody typed. Echoing the prompt back made the panel
  // a list of what the reader had already asked for instead of what was done.
  assert.match(app, /serverOutcomes\.has\(task\.id\)/u);
  assert.doesNotMatch(app, /briefObjective\(task\.objective\)/u);
  assert.doesNotMatch(app, /function catchUpTaskOutcome\(task\)/u);
  assert.doesNotMatch(app, /Implemented: \$\{objective\}/u);
  // The digest is skimmed, so each row is one condensed claim with the who
  // and the how-much moved into attribution pills rather than spelled out in
  // prose. The file count keeps the old compact attribution, while the paths
  // themselves become direct controls below it.
  assert.match(chats, /function catchUpLead\(summary\)/u);
  assert.match(chats, /class="catch-up-task-lead"/u);
  assert.match(chats, /pillBar\(/u);
  assert.match(chats, /icon: "agent"/u);
  // The who is that agent's own mark, drawn in its owner's colour. A shared
  // bot glyph on every row said only "an agent did this", which is the one
  // thing a reader of this panel already knows.
  assert.match(chats, /agent: worker/u);
  assert.match(chats, /label: agentPillName\(worker\)/u);
  assert.match(chats, /changedFiles\.join\(", "\)/u);
  assert.doesNotMatch(chats, /catch-up-file-names/u);
  assert.match(chats, /state\.catchUp = state\.catchUps\?\.\[repositoryId\]/u);
  assert.match(chats, /String\(task\.summary \?\? ""\)/u);
  assert.doesNotMatch(
    chats.slice(
      chats.indexOf("function catchUpPanel()"),
      chats.indexOf("function chanTreeNode("),
    ),
    /task\.objective/u,
  );
  assert.doesNotMatch(app, /catch-up-card/u);
  assert.match(styles, /\.catch-up-task-list \{/u);

  // A completed-work summary is a native control carrying the stable task
  // identity. It resolves that task's channel root, including older pages,
  // and opens the existing thread surface rather than a generic destination.
  assert.match(
    chats,
    /<button type="button" class="catch-up-task-open"/u,
  );
  assert.match(
    chats,
    /data-act="catch-up-task-open" data-value="\$\{esc\(task\.id\)\}"/u,
  );
  assert.match(chats, /data-repository="\$\{esc\(taskRepositoryId\)\}"/u);
  assert.match(chats, /export function channelMessageHasTaskThread\(entry\)/u);
  assert.match(app, /case "catch-up-task-open": \{/u);
  assert.match(
    app,
    /entry\.taskId === value && channelMessageHasTaskThread\(entry\)/u,
  );
  assert.match(app, /loadEarlierChannelMessages\(taskRepositoryId, render\)/u);
  assert.match(app, /openThreadPanel\(taskMessage\.id\)/u);

  // Every reported path is its own native control. The established channel
  // file action receives both the path and the task it came from so the file
  // panel opens the matching contents and changeset.
  assert.match(
    chats,
    /<button type="button" class="pill catch-up-file"/u,
  );
  assert.match(
    chats,
    /data-act="chan-file-open" data-value="\$\{esc\(path\)\}"/u,
  );
  assert.match(chats, /data-task="\$\{esc\(task\.id\)\}"/u);
  assert.match(
    app,
    /state\.chanFileTaskId = node\?\.dataset\?\.task \?\? undefined/u,
  );
  assert.match(app, /void loadChannelFile\(value, render\)/u);
  assert.match(
    styles,
    /\.catch-up-task-open:hover,\s*\.catch-up-task-open:focus-visible/u,
  );
  assert.match(
    styles,
    /\.catch-up-file:hover,\s*\.catch-up-file:focus-visible/u,
  );

  // Closing from the button, Escape, or a swipe advances the same personal
  // watermark only after the list has actually been shown.
  assert.match(app, /if \(showing === "catch-up"\) \{\s*dismissSinceYouLeft\(\);/u);
  assert.match(app, /case "catch-up-close":\s*dismissSinceYouLeft\(\);/u);
  assert.match(app, /catch-up\/seen/u);
});

test("work seen live is not reported again as an away notification", async () => {
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");

  // The away window begins when the visible visit actually ends, including a
  // tab close. A still-open catch-up is not consumed behind the reader's back.
  assert.match(app, /function markCatchUpSeenWhilePresent\(\)/u);
  assert.match(app, /Object\.keys\(state\.catchUps \?\? \{\}\)\.length > 0/u);
  assert.match(
    app,
    /document\.visibilityState === "visible"[\s\S]*?markCatchUpSeenWhilePresent\(\);/u,
  );
  assert.match(
    app,
    /addEventListener\("pagehide", \(\) => markCatchUpSeenWhilePresent\(\)\)/u,
  );
  assert.match(
    app,
    /!catchingUp[\s\S]*?document\.visibilityState === "visible"[\s\S]*?"canonical_promoted"[\s\S]*?markCatchUpSeenWhilePresent\(\);/u,
  );
  // A normal request is liable to be cancelled as the page is frozen; this
  // one explicitly survives long enough to advance the personal cursor.
  assert.match(app, /method: "POST", body: \{\}, keepalive: true/u);
  assert.match(data, /options\.keepalive === true \? \{ keepalive: true \} : \{\}/u);
});
