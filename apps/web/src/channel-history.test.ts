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
 * permanently the newest fifty roots with no way to reach anything older —
 * and the in-channel search, which reads only what is loaded, reported that
 * limit as an answer: "nothing matches that search".
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

test("search reads the replies too, and says what it could not see", async () => {
  const chats = await publicFile("screen-chats.js");

  // Nearly everything an agent says lives in a thread, so searching only the
  // roots was searching past the answers.
  const matcher = slice(chats, "function matchesQuery(entry, query) {", "\nfunction messageList(");
  assert.match(matcher, /entry\.content/u);
  assert.match(matcher, /\(entry\.replies \?\? \[\]\)\.some/u);

  // And the empty state names the boundary instead of reporting a limit as an
  // answer — with the way past it offered in the same breath.
  const list = slice(chats, "function messageList(repositoryId) {", "  // A person's reply is a message in the room");
  assert.match(list, /Nothing in the messages loaded so far/u);
  assert.match(list, /state\.channelHasMore\[repositoryId\] === true/u);
  assert.match(list, /loadEarlierControl\(\s*repositoryId,?\s*\)/u);
});
