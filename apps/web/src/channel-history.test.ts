import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The transcript window, and the two things that were wrong with it.
 *
 * The GET route has read `limit` (1–200, default 50) and a `before` cursor
 * since it was written, and both store implementations honour the cursor
 * against `bumpedAt ?? createdAt`. The client sent neither, so a channel was
 * permanently the newest fifty roots with no way to reach anything older.
 *
 * Pinned by the shape of the source, like the rest of the browser surface.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.notEqual(start, -1, `${from} should exist`);
  assert.notEqual(end, -1, `${from} should end at ${to}`);
  return source.slice(start, end);
}

test("channel history distinguishes loading, empty, and loaded transcripts", async () => {
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  const skeleton = slice(
    chats,
    "function channelMessageSkeleton(repositoryId) {",
    "\nfunction messageList(repositoryId) {",
  );
  assert.match(skeleton, /role="status" aria-live="polite" aria-busy="true"/u);
  assert.match(skeleton, /class="sr-only">Loading channel messages…/u);
  assert.equal((skeleton.match(/class="channel-skeleton-row"/gu) ?? []).length, 3);

  const list = slice(
    chats,
    "function messageList(repositoryId) {",
    "\n/**\n * The emoji the picker offers",
  );
  const loadingGuard = list.indexOf("!state.channelLoaded.has(repositoryId)");
  const historyRead = list.indexOf("channelMessagesFor(repositoryId)");
  assert.notEqual(loadingGuard, -1);
  assert.equal(loadingGuard < historyRead, true, "loading wins before an empty array");
  assert.match(list, /return channelMessageSkeleton\(repositoryId\);/u);

  // Once the request settles, zero rows is a real empty state and non-zero
  // rows continue through the ordinary message renderer.
  assert.match(list, /entries\.length === 0/u);
  // The empty branch used to choose between "No messages yet" and "Nothing
  // matches that search" off the search query. In-channel search was removed
  // and the query went with it, so the empty state is unconditional now —
  // same string, same branch, one fewer thing deciding it.
  assert.match(
    list,
    /emptyState\(\s*"chatBubble",\s*"No messages yet",\s*"Say hello/u,
  );
  assert.match(list, /messageRow\(entry, repositoryId/u);
  assert.match(list, /role="log"[\s\S]{0,120}aria-label="Channel messages"/u);

  const messages = slice(
    data,
    "export function channelMessagesFor(repositoryId) {",
    "\n/**\n * The reply that names a thread",
  );
  assert.match(messages, /state\.channelMessages\[repositoryId\] = \[\];/u);
  assert.doesNotMatch(data, /seedMessages|-seed-1|-seed-2|Reviewed the last changeset/u);
  assert.match(css, /\.chan-messages-loading \{/u);
  assert.match(css, /\.channel-skeleton-row \{/u);
});

test("the first page asks for a size, and records whether there is more", async () => {
  const data = await publicFile("data.js");
  const load = slice(
    data,
    "async function loadChannel(repositoryId) {",
    "/**\n * Loads a channel's real messages once per repository visit.",
  );

  assert.match(load, /\/messages\?limit=\$\{CHANNEL_PAGE\}/u);
  // A full page means the cursor has somewhere left to go; a short one is the
  // beginning of the room. This is what the control is gated on, so it can
  // never be a button whose only possible answer is "nothing".
  assert.match(
    load,
    /state\.channelHasMore\[repositoryId\] = page\.length >= CHANNEL_PAGE;/u,
  );
});

test("opening a direct-message history starts at its newest messages", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");

  const scroll = slice(
    chats,
    "export function scrollDirectMessageToLatest() {",
    "\n/**\n * The first message this visit had not seen",
  );
  assert.match(scroll, /document\.querySelector\("\.dm-body"\)/u);
  assert.match(scroll, /list\.scrollTop = list\.scrollHeight/u);
  assert.match(scroll, /settled === list/u);
  assert.match(scroll, /settled\.scrollTop = settled\.scrollHeight/u);

  const load = slice(
    app,
    "function loadOpenedDirectMessage(userId) {",
    "\nfunction navigate(route)",
  );
  assert.equal(
    (load.match(/scrollDirectMessageToLatest\(\)/gu) ?? []).length,
    2,
    "cached and freshly loaded history should both land at the bottom",
  );
  assert.match(load, /loadDmThread\(userId\)/u);
  assert.match(load, /state\.activeDm !== userId/u);

  for (const action of [
    slice(app, 'case "switch-person":', '\n    case "switch-screen":'),
    slice(app, 'case "dm-open":', '\n    case "mention-agents-insert":'),
  ]) {
    assert.match(action, /render\(\);\s*loadOpenedDirectMessage\(value\);/u);
  }
});

test("direct-message state is reset and stale loads are discarded when projects change", async () => {
  const data = await publicFile("data.js");
  const reset = slice(
    data,
    "export function resetDirectMessageState() {",
    "\n}\n\n/**\n * Loads the context",
  );
  for (const empty of [
    "state.presence = [];",
    "state.dmPeople = [];",
    "state.dmConversations = [];",
    "state.dmThreads = {};",
    'state.dmDraft = "";',
  ]) {
    assert.match(
      reset,
      new RegExp(empty.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
  }
  for (const cleared of [
    "state.activeDm = undefined;",
    "state.dmReplyMessageId = undefined;",
    "state.dmSelectedMessageId = undefined;",
    "state.dmLoadedProject = undefined;",
  ]) {
    assert.match(
      reset,
      new RegExp(cleared.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
  }
  assert.match(reset, /state\.dmLoadedAt = 0;/u);
  assert.match(reset, /state\.dmAttaching = 0;/u);

  const context = slice(
    data,
    "export async function loadContext({ defer = false } = {}) {",
    "\n}\n\n/**\n * The rest of the project",
  );
  assert.match(context, /const previousProjectId = state\.projectId;/u);
  assert.match(
    context,
    /if \(state\.projectId !== previousProjectId\) \{\s*resetDirectMessageState\(\);/u,
  );

  const inbox = slice(
    data,
    "export async function loadDirectMessages() {",
    "\n}\n\n/** One conversation",
  );
  const inboxScope = inbox.indexOf("const projectId = state.projectId;");
  const inboxGuard = inbox.indexOf("state.projectId !== projectId");
  const inboxWrite = inbox.indexOf("state.dmConversations =");
  assert.notEqual(inboxScope, -1);
  assert.notEqual(inboxGuard, -1);
  assert.equal(inboxGuard < inboxWrite, true, "a stale inbox is refused before state changes");

  const thread = slice(
    data,
    "export async function loadDmThread(userId) {",
    "\n}\n\nexport async function sendDirectMessage",
  );
  const threadScope = thread.indexOf("const projectId = state.projectId;");
  const threadGuard = thread.indexOf("state.projectId !== projectId");
  const threadWrite = thread.indexOf("state.dmThreads[userId] =");
  assert.notEqual(threadScope, -1);
  assert.notEqual(threadGuard, -1);
  assert.equal(threadGuard < threadWrite, true, "a stale thread is refused before it is cached");

  for (const [from, to] of [
    ["export function noteDirectMessage(frame) {", "/** Applies a private-message correction"],
    ["export function noteDirectMessageEdited(frame) {", "/**\n * A message the other side unsent"],
    ["export function noteDirectMessageDeleted(frame) {", "/** Whether somebody has this project"],
  ] as const) {
    const handler = slice(data, from, to);
    assert.match(handler, /projectId[^\n]*state\.projectId|state\.projectId[^\n]*projectId/u);
  }
});

test("a pending direct-message attachment cannot finish in a different project", async () => {
  const app = await publicFile("app.js");
  const attach = slice(
    app,
    'async function attachChannelImages(files, target = "channel") {',
    "\n}\n\n/**\n * Repositories whose preview",
  );
  assert.match(attach, /const projectId = state\.projectId;/u);
  assert.match(
    attach,
    /target === "dm" &&\s*\(state\.projectId !== projectId \|\| state\.activeDm !== dmUserId\)/u,
  );
  const guard = attach.indexOf("state.projectId !== projectId");
  const write = attach.indexOf("state[where.draft] =", guard);
  assert.notEqual(guard, -1);
  assert.notEqual(write, -1);
  assert.equal(guard < write, true, "the workspace is checked before the draft changes");
});

test("a private message keeps its place when another panel is open", async () => {
  const chats = await publicFile("screen-chats.js");

  // The right-hand column holds several panels at once and every one of them
  // wears `.thread-body`, so asking the document for one of those answered
  // with whichever happened to be first. A direct message opens as the newest
  // panel — last in the document — so with a thread or the file editor
  // already beside it, its position was never taken and every render put the
  // reader back at the top of the history.
  const surfaces = slice(
    chats,
    "function scrollSurfaceNodes(selector) {",
    "\nexport function restoreChannelAnchor(saved) {",
  );
  assert.match(surfaces, /document\.querySelectorAll\(selector\)/u);
  assert.doesNotMatch(
    surfaces,
    /document\.querySelector\(/u,
    "capture must not stop at the first panel wearing the class",
  );
  assert.match(surfaces, /SCROLL_SURFACES\.flatMap\(\(selector\) =>/u);
  assert.match(surfaces, /scrollSurfaceNodes\(selector\)\.map\(\(scroller\) => \{/u);

  // Which makes order meaningless, so the restore pairs a captured position
  // with its panel by identity: the same kind of surface, showing the same
  // conversation.
  const restore = slice(
    chats,
    "export function restoreChannelAnchor(saved) {",
    "\n/**\n * The anchor each surface is currently sitting on",
  );
  assert.match(restore, /for \(const scroller of scrollSurfaceNodes\(entry\.selector\)\)/u);
  assert.match(restore, /scroller\.className !== entry\.shape/u);
  assert.match(restore, /scroller\.dataset\.scrollKey !== entry\.key/u);
  // And the hold is remembered per panel rather than per selector, or two
  // open `.thread-body` panels would share — and overwrite — one anchor.
  assert.match(
    restore,
    /heldAnchors\.set\(entry\.selector \+ "\|" \+ entry\.shape \+ "\|" \+ entry\.key/u,
  );

  // The late-decode hold reaches the same panels the same way.
  const watch = slice(
    chats,
    "function watchImageSizes() {",
    "\n/**\n * Puts the transcript back where the reader had it",
  );
  assert.match(watch, /scrollSurfaceNodes\(held\.entry\.selector\)/u);
  assert.match(watch, /scroller\.dataset\.scrollKey !== held\.entry\.key/u);
  assert.match(watch, /scroller\.scrollTop !== held\.applied/u);

  // Every panel that can share the class carries an identity to be paired on.
  for (const key of ["dm:", "thread:", "thread-list:", "file:", "tree:", "catch-up:"]) {
    assert.match(chats, new RegExp(`data-scroll-key="${key}`, "u"), `${key} has an identity`);
  }
});

test("earlier pages are read through the cursor, deduped, and survive a reconcile", async () => {
  const data = await publicFile("data.js");
  const loader = slice(
    data,
    "export async function loadEarlierChannelMessages(",
    "\n/**",
  );

  // The cursor is the field the server orders and filters by. Paging on
  // anything else steps over roots whose thread was replied to later.
  assert.match(data, /function channelCursor\(entry\) \{/u);
  assert.match(data, /entry\?\.bumpedAt \?\? entry\?\.createdAt \?\? entry\?\.at/u);
  assert.match(loader, /const cursor = channelCursor\(loaded\[0\]\);/u);
  assert.match(loader, /before=\$\{encodeURIComponent\(cursor\)\}/u);

  // Ids already loaded are dropped rather than drawn twice.
  assert.match(loader, /const known = new Set\(loaded\.map/u);
  assert.match(loader, /!known\.has\(message\.id\)/u);

  // Nothing new behind the cursor stops the offer, rather than letting the
  // control be pressed forever against the same page.
  assert.match(loader, /state\.channelHasMore\[repositoryId\] = false;/u);

  // In flight only once.
  assert.match(loader, /state\.channelLoadingEarlier === repositoryId/u);
  assert.match(loader, /state\.channelLoadingEarlier = repositoryId;/u);

  // The page describes the page. The read cursor, the pins and the command
  // list describe the *channel*, and replacing them from a page of history
  // would move the unread line to a boundary in last month's transcript.
  assert.doesNotMatch(loader, /channelRead|channelPins|channelSlashCommands/u);

  // Pages read back this way are kept apart from `channelMessages`, because
  // `loadChannel` replaces that array on every socket reconcile — so without
  // this they would be dropped by the next thing anybody said.
  assert.match(loader, /state\.channelEarlier\[repositoryId\] = \[/u);
  const load = slice(
    data,
    "async function loadChannel(repositoryId) {",
    "/**\n * Loads a channel's real messages once per repository visit.",
  );
  assert.match(load, /const earlier = \(state\.channelEarlier\[repositoryId\] \?\? \[\]\)/u);
  assert.match(load, /state\.channelMessages\[repositoryId\] = \[\.\.\.earlier, \.\.\.page\];/u);
});

test("reference navigation pages backward until its thread is found or history ends", async () => {
  const data = await publicFile("data.js");
  const app = await publicFile("app.js");
  const loader = slice(
    data,
    "export async function loadChannelMessage(",
    "\n/**",
  );

  assert.match(loader, /let found = findChannelMessage\(repositoryId, messageId\);/u);
  assert.match(loader, /while \(/u);
  assert.match(loader, /state\.channelHasMore\[repositoryId\] !== false/u);
  assert.match(loader, /const cursor = channelCursor\(loaded\[0\]\);/u);
  assert.match(loader, /await loadEarlierChannelMessages\(repositoryId, rerender\);/u);
  assert.match(loader, /found = findChannelMessage\(repositoryId, messageId\);/u);
  // A repeated cursor is a malformed or exhausted page, and must not turn a
  // reference click into an infinite request loop.
  assert.match(loader, /const visited = new Set\(\);/u);
  assert.match(loader, /visited\.has\(cursor\)/u);

  const action = slice(app, 'case "channel-pin-jump": {', "\n    case ");
  assert.match(action, /loadChannelMessage\(repositoryId, value, render\)/u);
  assert.match(action, /entry\.taskId !== undefined/u);
  assert.match(action, /state\.scrollToThreadMessage = value;/u);
  assert.match(action, /state\.scrollToMessage = value;/u);
});

test("the control is offered only when there is more, and holds the reader's place", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");

  const control = slice(
    chats,
    "function loadEarlierControl(repositoryId) {",
    "\n/**",
  );
  assert.match(control, /state\.channelHasMore\[repositoryId\] !== true/u);
  assert.match(control, /data-act="channel-load-earlier"/u);
  assert.match(control, /loading \? "Loading…" : "Load earlier messages"/u);
  assert.match(css, /\.chan-earlier \{/u);

  // Content is being added *above* the viewport, so the offset captured for
  // the ordinary poll-render means nothing here: the `scrollHeight` delta is
  // what has to be applied to keep the same words under the reader's eye.
  const action = slice(app, 'case "channel-load-earlier": {', "\n    case ");
  assert.match(action, /height: list\.scrollHeight/u);
  assert.match(
    action,
    /next\.scrollTop = anchor\.top \+ \(next\.scrollHeight - anchor\.height\)/u,
  );
});
