import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The browser half of sub-channels.
 *
 * A repository used to be a channel outright, and the one property that must
 * survive dividing it is that an undivided repository is unchanged: no
 * heading it did not have, the same URL, the same composer. Everything below
 * pins one of the places that could quietly stop being true.
 *
 * Pinned by the shape of the source, the way the rest of the browser surface
 * is: the dashboard ships as plain ES modules with no bundler, and the test
 * run has no DOM to render them into.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("every read and write says which room it means", async () => {
  const data = await publicFile("data.js");

  assert.match(data, /const scopedChannelPath = \(repositoryId, suffix/u);
  assert.match(data, /channelId=\$\{encodeURIComponent\(channelId\)\}/u);

  // The per-room surfaces. A message list, a post, a roster, a read cursor
  // and a typing ping all have to be scoped, or a second room shows the
  // first one's transcript and marks it read.
  for (const call of [
    /scopedChannelPath\(repositoryId, `\/messages\?limit=/u,
    /scopedChannelPath\(repositoryId, "\/messages"\)/u,
    /scopedChannelPath\(repositoryId, "\/agents"\)/u,
    /scopedChannelPath\(repositoryId, "\/read"\)/u,
    /scopedChannelPath\(repositoryId, "\/typing"\)/u,
  ]) {
    assert.match(data, call);
  }
});

test("switching rooms drops what was keyed by repository alone", async () => {
  const data = await publicFile("data.js");
  const selector = data.slice(data.indexOf("export function selectSubChannel"));
  const body = selector.slice(0, selector.indexOf("\n}"));

  // Every one of these is keyed by repository id, so without clearing them
  // the new room opens showing the old room's messages.
  for (const cleared of [
    "state.channelMessages",
    "state.channelEarlier",
    "state.channelPinned",
    "state.channelLoaded",
    "state.channelRosterLoaded",
  ]) {
    assert.ok(
      body.includes(cleared),
      `${cleared} should be cleared when the open room changes`,
    );
  }
});

test("an undivided repository keeps the interface it always had", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");

  // The heading and list only appear once there is a second room to pick, or
  // for somebody who can create one.
  assert.match(
    chats,
    /channels\.length > 1 \|\| canManageSubChannels\(activeRepositoryId\)/u,
  );
  // The composer placeholder falls back to the workspace name.
  assert.match(chats, /subChannelsFor\(repositoryId\)\.length > 1/u);
  assert.match(chats, /Message #\$\{repositoryLabel\(repositoryId\)\}/u);
  // And the URL gains no query parameter it did not have.
  assert.match(app, /subChannelsFor\(workspaceId\)\.length > 1/u);
  assert.match(app, /query\.set\("channel", channelId\)/u);
});

test("a room somebody may read but not post in replaces the composer", async () => {
  const chats = await publicFile("screen-chats.js");

  assert.match(chats, /canPostInActiveSubChannel\(repositoryId\)/u);
  assert.match(chats, /chan-composer-locked/u);
  // Replaced, not disabled: the note has to say who may fix it.
  assert.match(chats, /Ask an admin to add you/u);

  const styles = await publicFile("styles.css");
  assert.match(styles, /\.chan-composer-locked \{/u);
});

test("only an administrator is offered the settings a room has", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");

  assert.match(chats, /export function subChannelManagePopoverHtml/u);
  assert.match(chats, /manage\s*\?\s*`<button type="button" class="icon-btn chan-channel-menu"/u);
  for (const act of [
    "sub-channel-rename",
    "sub-channel-visibility",
    "sub-channel-delete",
    "sub-channel-member-toggle",
  ]) {
    assert.ok(chats.includes(act), `${act} should be offered in the popover`);
    assert.ok(app.includes(`case "${act}"`), `${act} should be handled`);
  }
  // #general is the fallback room for every unaddressed message, so it is
  // not renamed, hidden or removed from here.
  assert.match(chats, /Everybody in the project is in #general/u);
});

test("a private room is drawn as private, and a typing ping stays in its room", async () => {
  const chats = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");

  assert.match(chats, /channel\.visibility === "private" \? icon\("lock"\)/u);
  const noteTyping = data.slice(data.indexOf("export function noteTyping"));
  assert.match(
    noteTyping.slice(0, noteTyping.indexOf("\n}")),
    /frame\.channelId !== open/u,
  );
});
