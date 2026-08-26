import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * Asking an agent for something used to end in a wait with nothing to look at.
 *
 * The request sat in the room, the agent went away and worked, and when it
 * came back it narrated into a thread — which arrives in the transcript
 * collapsed to a single summary line. The person who prompted it had to spot
 * that line and click it before they saw any of the work they had asked for.
 * These assertions pin the two halves that close that gap: data.js noticing
 * the moment a thread appears under one of this account's own requests, and
 * app.js deciding whether the desktop panel is free to show it.
 *
 * Pinned by the shape of the source, the way the rest of the browser surface
 * is: the dashboard ships as plain ES modules with no bundler, and the test
 * run has no DOM to render them into.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("a thread appearing under this account's own request is noticed", async () => {
  const data = await publicFile("data.js");

  // Whose thread it is decides everything here: a thread growing under
  // somebody else's request is not this reader's to be shown.
  const own = data.slice(
    data.indexOf("function ownTaskThread("),
    data.indexOf("function notePromptedThread("),
  );
  assert.notEqual(own, "", "data.js should name the account's own task threads");
  assert.match(own, /entry\.kind === "user"/u);
  assert.match(own, /entry\.taskId !== undefined/u);
  assert.match(own, /String\(entry\.authorId \?\? ""\) === currentUserId\(\)/u);
  assert.match(own, /\(entry\.replies \?\? \[\]\)\.length > 0/u);

  // The transition, not the state: a root that had no replies a moment ago
  // and has some now. Comparing the timeline being replaced against the one
  // replacing it keeps this out of guessing which reply started a thread.
  const note = data.slice(
    data.indexOf("function notePromptedThread("),
    data.indexOf("export function takePromptedThread("),
  );
  assert.match(note, /if \(before === undefined\) \{\s*return;/u);
  assert.match(note, /const already = new Set\(before\.filter\(ownTaskThread\)/u);
  assert.match(note, /!already\.has\(entry\.id\)/u);
  // The newest one wins — two agents starting to narrate in the same
  // reconcile is still one panel with one occupant.
  assert.match(note, /\.at\(-1\)/u);
  assert.match(note, /state\.promptedThread = \{ repositoryId, messageId: opened\.id \}/u);

  // Read once and cleared, so a reconcile that produces a thread gets exactly
  // one chance to open it rather than ambushing a later unrelated refresh.
  const take = data.slice(data.indexOf("export function takePromptedThread("));
  assert.match(take, /pending\.repositoryId !== repositoryId/u);
  assert.match(take, /state\.promptedThread = undefined;\s*return pending\.messageId;/u);
});

test("the channel reconcile is what takes the timeline before it replaces it", async () => {
  const data = await publicFile("data.js");
  const load = data.slice(
    data.indexOf("async function loadChannel("),
    data.indexOf("export async function ensureChannelMessages("),
  );

  // A channel's first read has no before-timeline: every thread in the room
  // is equally new there and none of them is news.
  assert.match(load, /const before = state\.channelLoaded\.has\(repositoryId\)/u);
  assert.match(load, /: undefined;/u);
  // Order matters — the snapshot has to be taken above the assignment.
  assert.ok(
    load.indexOf("const before =") <
      load.indexOf("state.channelMessages[repositoryId] = (response.messages"),
    "the previous timeline should be read before it is replaced",
  );
  assert.match(load, /notePromptedThread\(repositoryId, before\);/u);
});

test("the thread opens itself on desktop, and only into a free place in the column", async () => {
  const app = await publicFile("app.js");
  const open = app.slice(
    app.indexOf("function openPromptedThread("),
    app.indexOf("function openPromptedThread(") + 1200,
  );
  assert.notEqual(open, "", "app.js should decide whether to open a prompted thread");

  assert.match(open, /const messageId = takePromptedThread\(repositoryId\);/u);
  // Desktop only. The panel sits beside the transcript here; on a phone it is
  // a full-screen surface dropped over the room mid-sentence.
  assert.match(open, /phoneLayout\(\)/u);
  assert.match(open, /state\.route !== "chats"/u);
  // A file tree or a direct message no longer means there is nowhere to put a
  // prompted thread — the right-hand column keeps up to three surfaces, and
  // this one takes a free place in it rather than somebody else's.
  //
  // A thread the reader opened themselves is never taken off them. The only
  // thing this replaces is a thread it opened the same way, so a second task
  // prompted while the first one's thread is up moves on to the newer work.
  assert.match(
    open,
    /state\.activeChannelThread !== undefined &&\s*state\.activeChannelThread !== state\.autoOpenedThread/u,
  );
  assert.match(open, /state\.activeChannelThread = messageId;\s*state\.autoOpenedThread = messageId;/u);
});

test("both channel reconciles get the chance, and a chosen thread is never taken over", async () => {
  const app = await publicFile("app.js");

  // The event socket's reconcile — an agent's first reply arriving while the
  // reader watches — and the one a tab coming back from the background runs.
  assert.match(
    app,
    /refreshChannelMessages\(channelRepositoryId\)\.then\(\(\) => \{\s*openPromptedThread\(channelRepositoryId\);/u,
  );
  assert.match(
    app,
    /refreshChannelMessages\(channel\)\.then\(\(\) => \{\s*openPromptedThread\(channel\);/u,
  );

  // Opening a thread by hand — from the transcript or from a pin — hands the
  // panel to the reader, and this is what stops the app taking it back.
  const byHand = app.split("state.activeChannelThread = value;").slice(1);
  // Was two. Opening a pinned message and jumping from a pin, and opening or
  // approving a plan, are three more deliberate ways in. The count is here so
  // a *new* doorway cannot be added without somebody visiting the loop below,
  // which is the assertion that carries the meaning.
  assert.equal(byHand.length, 5, "every deliberate way into a thread is checked");
  for (const after of byHand) {
    assert.match(after.slice(0, 200), /state\.autoOpenedThread = undefined;/u);
  }
});
