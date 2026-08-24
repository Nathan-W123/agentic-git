import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * Why a message stops being new.
 *
 * "New" is a comparison between two timestamps — when a room was last read,
 * and when something in it was said — and every way that comparison could get
 * stuck said the same thing to a reader: a badge for messages they had already
 * seen, on a room they were sitting in. Pinned the way the rest of the browser
 * surface is pinned, by the shape of the source: the dashboard ships as plain
 * ES modules with no bundler and the test run has no DOM.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("reading a room covers the messages in it, whatever this browser's clock says", async () => {
  const data = await publicFile("data.js");

  // The stamp was `Date.now()` alone. Message times come from the server, so a
  // browser a second or two behind marked the room read at a moment its newest
  // messages were already after — and the badge never cleared.
  assert.match(data, /function newestChannelActivity\(repositoryId\)/u);
  assert.match(
    data,
    /noteChannelRead\(\s*repositoryId,\s*Math\.max\(Date\.now\(\), newestChannelActivity\(repositoryId\)\),\s*\)/u,
  );
});

test("a read stamp only ever moves forward", async () => {
  const data = await publicFile("data.js");

  // Two writers disagree about the clock: opening a room stamps it locally,
  // and a page of history carries the server's cursor, which is only as fresh
  // as the last read that landed. Letting the later write win outright un-read
  // everything in between.
  assert.match(data, /function noteChannelRead\(repositoryId, at\)/u);
  assert.match(
    data,
    /function noteChannelRead[\s\S]{0,400}if \(next <= \(state\.channelRead\[repositoryId\] \?\? 0\)\) \{\s*return;/u,
  );
  assert.match(data, /noteChannelRead\(repositoryId, Date\.parse\(response\.readAt\)\)/u);
  assert.doesNotMatch(data, /state\.channelRead\[repositoryId\] = Date\.parse\(/u);
});

test("a message arriving in the room on screen arrives read", async () => {
  const app = await publicFile("app.js");

  // Opening a channel was the only thing that cleared it, so anything that
  // landed while somebody sat reading raised a badge on the room they were
  // reading — and it stayed until they left and came back.
  assert.match(app, /function markChannelReadIfWatching\(repositoryId\)/u);
  assert.match(
    app,
    /function markChannelReadIfWatching[\s\S]{0,400}state\.route !== "chats"[\s\S]{0,200}document\.visibilityState !== "visible"/u,
  );
  // Both the live frame and the catch-up after the tab comes back.
  assert.match(
    app,
    /openReadyPlan\(channelRepositoryId\);\s*markChannelReadIfWatching\(channelRepositoryId\)/u,
  );
  assert.match(
    app,
    /function resumeLiveUpdates[\s\S]{0,600}markChannelReadIfWatching\(channel\)/u,
  );
});

test("a private message is read where it landed, not wherever the reader is", async () => {
  const data = await publicFile("data.js");
  const app = await publicFile("app.js");

  // The socket handler marked whichever conversation happened to be open,
  // which is not necessarily the one the message arrived in. `noteDirectMessage`
  // is the only place that knows whose conversation it is.
  assert.match(
    data,
    /function noteDirectMessage[\s\S]{0,1600}if \(open && message\.recipientId === me\) \{[\s\S]{0,200}directPath\(`\/\$\{encodeURIComponent\(other\)\}\/read`\)/u,
  );
  // An open conversation has nothing waiting in it — including whatever the
  // last inbox read reported before it was opened.
  assert.match(data, /unread: open \? 0 :/u);
  assert.doesNotMatch(app, /direct-messages\/`\s*\+\s*`\$\{encodeURIComponent\(state\.activeDm\)\}\/read`/u);
});
