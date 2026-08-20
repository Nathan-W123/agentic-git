import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The conveniences a chat is expected to have, pinned the way the rest of the
 * browser surface is pinned: by asserting the shape of the source, since the
 * dashboard ships as plain ES modules with no bundler and the test run has no
 * DOM. Each test here stands for one thing a reader could not previously do —
 * react with anything but a thumbs-up, see where they had got to, get back
 * down to the newest messages, keep a draft in the room it was meant for, or
 * take a message's words with them.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

/** One top-level function's source, from its declaration to the next one. */
function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.notEqual(start, -1, `${from} should exist`);
  assert.notEqual(end, -1, `${from} should end at ${to}`);
  return source.slice(start, end);
}

test("a reaction can be any emoji, not only the one the client could send", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");

  // The server has always taken an `emoji` on the reaction route. The client
  // sent the same hardcoded character every time, so every reaction in the
  // product was a thumbs-up whatever anybody meant by it.
  assert.match(chats, /const REACTION_CHOICES = \[/u);
  assert.match(chats, /export function reactionPicker\(anchor, repositoryId, messageId\)/u);
  assert.match(chats, /data-act="channel-react-choose"/u);
  assert.match(app, /case "channel-react-pick":/u);
  assert.match(app, /reactionPicker\(node, activeChannelId\(\), value\)/u);
  assert.match(app, /case "channel-react-choose":/u);
  assert.match(app, /toggleChannelReaction\(activeChannelId\(\), value, emoji\)/u);

  // A tally under a message toggles the emoji it counts. It used to carry no
  // emoji at all, so clicking somebody else's 🎉 added a 👍 beside it.
  assert.match(chats, /data-act="channel-react"[\s\S]{0,160}data-emoji="\$\{esc\(emoji\)\}"/u);
  assert.match(app, /const emoji = node\.dataset\.emoji \|\| "👍"/u);

  // The picker doubles as the way to take a reaction back, so the ones this
  // reader has already left are marked in it.
  assert.match(chats, /reactions\[emoji\]\?\.mine === true \? " mine" : ""/u);
  assert.match(css, /\.react-choice\.mine \{/u);
  assert.match(css, /\.cmsg-react-add \{/u);
});

test("the unread line is taken before opening the room marks it read", async () => {
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // The order is the whole feature. `markChannelRead` stamps the channel to
  // now, so a divider read from `channelRead` after the open would always sit
  // at the bottom — which is to say it would never be drawn.
  const open = slice(chats, "export function openChannel", "\nexport function submitComposerMessage");
  const snapshot = open.indexOf("snapshotChannelRead(repositoryId)");
  const mark = open.indexOf("markChannelRead(repositoryId)");
  assert.notEqual(snapshot, -1, "opening a channel takes the divider's position");
  assert.equal(
    snapshot < mark,
    true,
    "the boundary must be read before the read stamp moves past it",
  );

  // Two fields, because they answer different questions: one is "is there
  // anything here for me", the other is "where was I".
  assert.match(data, /channelReadMark: \{\}/u);
  assert.match(data, /export function channelUnreadMark\(repositoryId\)/u);
  // A first visit is not a backlog somebody fell behind on.
  assert.match(data, /readAt > 0 && countChannelSince\(repositoryId, readAt, false\) > 0/u);

  // Drawn once, at the first message somebody else sent after that moment,
  // and never over search results — those are scattered hits, not a
  // transcript with a boundary in it.
  assert.match(chats, /const mark = query === "" \? channelUnreadMark\(repositoryId\) : undefined/u);
  assert.match(chats, /class="chan-unread" id="chan-unread"/u);
  assert.match(chats, /!markDrawn &&[\s\S]{0,80}Date\.parse\(item\.at \?\? ""\) > mark/u);
  assert.match(css, /\.chan-unread \{/u);
});

test("a reader who has scrolled up is offered the way back down", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");

  // Shown and hidden by attribute, never by re-rendering: following changes on
  // every wheel notch, and rebuilding the transcript at that rate is the
  // latency this screen spent a lot of effort not having.
  assert.match(chats, /function jumpToLatest\(\)/u);
  assert.match(chats, /export function paintJumpToLatest\(\)/u);
  assert.match(chats, /pill\.hidden = followingChannel/u);
  const paint = slice(chats, "export function paintJumpToLatest", "\nlet leftBottomAt");
  assert.doesNotMatch(
    paint,
    /\b(?:render|rerender)\s*\(/u,
    "painting the pill must not rebuild the screen",
  );
  // The label is compared against the node, not against state: every render
  // hands back a fresh blank pill, and a count remembered elsewhere would
  // leave that blank label looking correct and never repaint it.
  assert.match(paint, /pill\.dataset\.count !== String\(count\)/u);

  // The count is measured from the visit's unread mark when there is one, and
  // otherwise from the moment the reader left the bottom — so a room they had
  // fully read still tells them what arrived behind their back.
  assert.match(paint, /channelUnreadMark\(repositoryId\) \?\? leftBottomAt/u);

  // The same flag the restore path uses to decide whether to pin the bottom,
  // so the pill is visible exactly when an arriving message would not be
  // scrolled to.
  const restore = slice(chats, "export function restoreChannelScroll", "\nexport function openChannel");
  assert.match(restore, /followingChannel = distance <= FOLLOW_SLACK_PX;\s*\n\s*paintJumpToLatest\(\)/u);

  // The unread line is the better destination of the two: somebody coming back
  // to a busy room wants the start of what they missed, not the end of it.
  assert.match(chats, /export function jumpToUnreadOrLatest\(\)/u);
  assert.match(chats, /document\.getElementById\("chan-unread"\)/u);
  assert.match(app, /case "channel-jump-latest":/u);

  // Floating over the transcript rather than taking a row: a pill that pushed
  // the conversation up by its own height would shift the very words somebody
  // scrolled up to read.
  assert.match(css, /\.chan-jump \{[\s\S]{0,120}position: absolute/u);
  assert.match(css, /\.chan-jump\[hidden\] \{\s*display: none;/u);
});

test("a half-written message stays in the channel it was meant for", async () => {
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");

  // One live draft was the only copy, so an unsent message followed the reader
  // into the next channel and waited there to be sent to the wrong people.
  assert.match(data, /chanDrafts: JSON\.parse\(window\.localStorage\.getItem\("ag\.chandrafts"\) \?\? "\{\}"\)/u);
  assert.match(data, /export function saveChannelDraft\(repositoryId, text\)/u);
  assert.match(data, /export function channelDraft\(repositoryId\)/u);

  // Parked before `state.repositoryId` moves: after that there is no longer a
  // way to tell which room the words in the composer belonged to.
  const open = slice(chats, "export function openChannel", "\nexport function submitComposerMessage");
  assert.match(open, /const leaving = state\.repositoryId/u);
  assert.match(open, /saveChannelDraft\(leaving, state\.chatDraft\)/u);
  assert.equal(
    open.indexOf("saveChannelDraft(leaving") < open.indexOf("state.repositoryId = repositoryId"),
    true,
    "the outgoing draft is parked before the channel changes under it",
  );
  assert.match(open, /state\.chatDraft = channelDraft\(repositoryId\)/u);

  // Sending empties the parked copy too, or the next visit restores a message
  // that has already gone.
  const submit = slice(chats, "export function submitComposerMessage", "\n/**");
  assert.equal(
    [...submit.matchAll(/saveChannelDraft\(repositoryId, ""\)/gu)].length,
    2,
    "both the reply and the new-message path clear the parked draft",
  );

  // Typing writes the in-memory copy; the disk mirror is held behind a timer
  // so the composer stays cheap, and flushed when the tab goes away.
  assert.match(data, /window\.setTimeout\(flushChannelDrafts, 500\)/u);
  assert.match(app, /document\.visibilityState === "visible"[\s\S]{0,360}flushChannelDrafts\(\)/u);
});

test("a message's words can be taken off the screen", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");

  assert.match(chats, /export async function copyMessageText\(repositoryId, messageId\)/u);
  assert.match(chats, /navigator\.clipboard\.writeText\(text\)/u);
  assert.match(app, /case "channel-message-copy":/u);
  assert.match(chats, /act: "channel-message-copy"/u);

  // Thread replies render through the same row, so the lookup has to reach
  // into them and not only the roots.
  const copy = slice(chats, "export async function copyMessageText", "\n/**");
  assert.match(copy, /roots\.flatMap\(\(message\) => message\.replies \?\? \[\]\)/u);
  // Attachment references are an internal address for a picture; they paste as
  // noise. Removed rather than truncated at, because a sent message can carry
  // one in the middle of a sentence.
  assert.match(copy, /\.replace\(ATTACHMENT_PATTERN, ""\)/u);
  // A denied clipboard beats a button that looks like it worked.
  assert.match(copy, /Could not reach the clipboard/u);
});

test("the transcript announces itself to a screen reader", async () => {
  const chats = await publicFile("screen-chats.js");
  // Both branches: an empty room is exactly where the first arriving message
  // matters most, and a live region declared only on the populated one would
  // miss it.
  assert.equal(
    [...chats.matchAll(/id="chan-messages" role="log"/gu)].length,
    2,
    "the empty and populated transcripts are both live regions",
  );
  assert.match(chats, /aria-live="polite" aria-relevant="additions"/u);
  // Polite, not assertive: a busy room would otherwise interrupt every other
  // announcement on the page.
  assert.doesNotMatch(chats, /id="chan-messages"[\s\S]{0,120}aria-live="assertive"/u);
});

test("the Thread label opens the thread library as the visible side panel", async () => {
  const [app, chats] = await Promise.all([
    publicFile("app.js"),
    publicFile("screen-chats.js"),
  ]);
  const kind = slice(chats, "function panelKind(", "\n/**\n * The control every");
  const panel = slice(chats, "function threadPanel(", "\nfunction planPanel(");
  const action = app.slice(
    app.indexOf('case "channel-threads-toggle":'),
    app.indexOf('case "channel-thread-delete":'),
  );

  // The category in the screenshot is a real control, not inert header text.
  assert.match(kind, /<button type="button" class="panel-kind" data-act=/u);
  assert.match(
    panel,
    /panelKind\("Thread", "channel-threads-toggle"\)/u,
  );

  // A list left open behind one of its threads is not visibly open. Pressing
  // Thread there navigates back to the list instead of toggling hidden state.
  assert.match(action, /const listVisible =/u);
  assert.match(action, /state\.activeChannelThread === undefined/u);
  assert.match(
    action,
    /if \(listVisible\) \{\s*state\.chanThreadList = false;\s*render\(\);\s*return;/u,
  );

  // Switching panels remains lossless: the discard question happens before
  // any state is cleared, then every higher-priority panel is put away before
  // the library is rendered.
  const guard = action.indexOf("if (!confirmDiscardEdit())");
  const firstClear = action.indexOf("state.activePlan = undefined");
  const open = action.indexOf("state.chanThreadList = true");
  assert.notEqual(guard, -1);
  assert.equal(guard < firstClear, true);
  assert.equal(firstClear < open, true);
  for (const field of [
    "activePlan",
    "activeAgentPanel",
    "activeDm",
    "activeChannelThread",
  ]) {
    assert.match(action, new RegExp(`state\\.${field} = undefined`, "u"));
  }
  assert.match(action, /closeChannelFile\(\);/u);
  assert.match(action, /state\.chanTree = false;/u);
});

test("mobile message actions surface only for the selected message", async () => {
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");
  const select = slice(
    app,
    "function selectMobileChannelMessage",
    '\ndocument.addEventListener("click"',
  );

  // Selection is a touch-only substitute for hover. A second tap on the same
  // row leaves `shouldSelect` false, while clearing all existing selections
  // first transfers the toolbar when a different message is tapped.
  assert.match(select, /matchMedia\("\(hover: none\)"\)\.matches/u);
  assert.match(select, /\.cmsg-row:not\(\.cmsg-system\)/u);
  assert.match(
    select,
    /row !== null && !row\.classList\.contains\("cmsg-selected"\)/u,
  );
  assert.match(select, /querySelectorAll\(\s*"\.cmsg-row\.cmsg-selected"/u);
  assert.match(select, /selected\.classList\.remove\("cmsg-selected"\)/u);
  assert.match(select, /row\.classList\.add\("cmsg-selected"\)/u);

  // A toolbar press remains a toolbar press, and the selector runs before the
  // delegated handler's no-action early return so tapping plain message text
  // can select it.
  assert.match(
    select,
    /row !== null && event\.target\.closest\?\.\("\.cmsg-actions"\) !== null/u,
  );
  assert.match(
    app,
    /document\.addEventListener\("click", \(event\) => \{[\s\S]{0,360}selectMobileChannelMessage\(event\);\s*const found = actionOf\(event\);/u,
  );

  // Touch overrides both the later desktop hover rule and mobile browsers'
  // sticky synthetic hover. Only the selected row restores the toolbar's
  // placement and hit testing; the desktop hover/focus reveal remains intact.
  assert.match(
    css,
    /@media \(hover: none\) \{[\s\S]*?\.cmsg-row \.cmsg-actions \{\s*opacity: 0 !important;\s*pointer-events: none !important;/u,
  );
  assert.match(
    css,
    /\.cmsg-row\.cmsg-selected \.cmsg-actions \{[\s\S]*?position: static !important;[\s\S]*?opacity: 1 !important;[\s\S]*?pointer-events: auto !important;/u,
  );
  assert.match(
    css,
    /\.cmsg-row:hover \.cmsg-actions,\s*\.cmsg-row:focus-within \.cmsg-actions \{\s*opacity: 1;\s*pointer-events: auto;/u,
  );
});

test("sending a message takes the command picker down with the draft", async () => {
  const chats = await publicFile("screen-chats.js");

  // Sending empties the composer, so the list of completions for the word
  // that was in it has nothing left to complete. It used to be left open:
  // only a keystroke reconsiders the pickers, so a `/` picker that was still
  // up at send hung over the emptied composer and followed the reader into
  // the next channel.
  const send = slice(
    chats,
    "export function submitComposerMessage(",
    "function pinnedBanner(",
  );
  assert.equal(
    send.match(/closeComposerAutocomplete\("channel"\)/gu)?.length,
    2,
    "both a channel message and a reply from the channel composer close it",
  );
  assert.doesNotMatch(
    send,
    /state\.mentionActive = false;/u,
    "no send path should half-close the pickers by hand",
  );
  assert.match(
    slice(
      chats,
      "export function submitThreadReply(",
      "function closeComposerAutocomplete(",
    ),
    /closeComposerAutocomplete\("thread"\)/u,
  );

  const source = slice(
    chats,
    "function closeComposerAutocomplete(",
    "function autocompleteSnapshot(",
  );
  const state = {
    composerAutocompleteTarget: "channel",
    mentionActive: true,
    mentionQuery: "ma",
    mentionIndex: 2,
    slashActive: true,
    slashQuery: "dep",
    slashIndex: 3,
  };
  const close = new Function(
    "state",
    `${source}\nreturn closeComposerAutocomplete;`,
  )(state) as (target: string) => void;

  // The composer that did not send keeps its half-typed word and its picker.
  close("thread");
  assert.equal(state.slashActive, true);

  // The query and the highlighted row go too, so the next `/` starts fresh.
  close("channel");
  assert.deepEqual(state, {
    composerAutocompleteTarget: "channel",
    mentionActive: false,
    mentionQuery: "",
    mentionIndex: 0,
    slashActive: false,
    slashQuery: "",
    slashIndex: 0,
  });
});

test("pinned messages stay available and open at their thread root", async () => {
  const [app, chats, data] = await Promise.all([
    publicFile("app.js"),
    publicFile("screen-chats.js"),
    publicFile("data.js"),
  ]);
  const action = slice(
    app,
    'case "channel-pinned-open":',
    'case "channel-pin-jump":',
  );
  assert.match(chats, /data-act="channel-pinned-open"/u);
  assert.match(action, /state\.activeChannelThread = value;/u);
  assert.match(action, /state\.scrollToThreadMessage = value;/u);
  assert.match(action, /state\.activePlan = undefined;/u);
  assert.doesNotMatch(action, /channelPins/u);
  assert.doesNotMatch(action, /entry\.kind|entry\.replies|entry\.taskId/u);

  const restore = slice(
    chats,
    "export function restoreChannelScroll(",
    'const list = document.querySelector("#chan-messages")',
  );
  assert.match(restore, /messageId === root\s*\? "\.thread-root"/u);
  assert.match(restore, /scrollIntoView\(\{ block: "center" \}\)/u);

  const deletion = slice(
    data,
    "export async function deleteChannelMessageEntry(",
    "/**\n * Removes one whole thread",
  );
  assert.match(deletion, /if \(response\?\.redacted !== true\)/u);
});
