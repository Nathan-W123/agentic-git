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

test("switching rooms clears every cache it names, and cannot half-finish", async () => {
  const data = await publicFile("data.js");

  // Run the real function rather than read it. This file pins the browser by
  // the shape of its source, which is right for markup — and is exactly what
  // let this one ship: `selectSubChannel` deleted `state.channelPinned`, and
  // the state it meant is `channelPins`. Every regex here passed while
  // `delete undefined[repositoryId]` threw in the browser.
  //
  // The throw was costly out of proportion to the pins it dropped. It came
  // after four caches were already cleared and before
  // `channelLoaded.delete`, so the transcript read as loaded and empty and
  // nothing refetched it; `sub-channel-open` never reached its `render()`, so
  // a room click did nothing; and `createSubChannel`, which calls this last,
  // reported failure for a channel the server had already created.
  const start = data.indexOf("export function selectSubChannel");
  assert.notEqual(start, -1, "selectSubChannel was not found");
  const body = data
    .slice(start, data.indexOf("\n}", start) + 2)
    .replace("export function", "function");

  const state = {
    activeSubChannel: {} as Record<string, string>,
    channelMessages: { repo: ["stale"] } as Record<string, unknown>,
    channelEarlier: { repo: 1 } as Record<string, unknown>,
    channelHasMore: { repo: true } as Record<string, unknown>,
    channelFailed: { repo: "boom" } as Record<string, unknown>,
    channelPins: { repo: ["pinned"] } as Record<string, unknown>,
    channelLoaded: new Set(["repo"]),
    channelRosterLoaded: new Set(["repo"]),
  };
  const selectSubChannel = new Function(
    "state",
    `${body}; return selectSubChannel;`,
  )(state) as (repositoryId: string, channelId: string) => void;

  selectSubChannel("repo", "chan_backend");

  assert.equal(state.activeSubChannel["repo"], "chan_backend");
  for (const key of [
    "channelMessages",
    "channelEarlier",
    "channelHasMore",
    "channelFailed",
    "channelPins",
  ] as const) {
    assert.equal(
      state[key]["repo"],
      undefined,
      `${key} still holds the previous room's data`,
    );
  }
  // The one that matters most: left set, the new room reads as already
  // loaded and its transcript never arrives.
  assert.equal(state.channelLoaded.has("repo"), false);
  assert.equal(state.channelRosterLoaded.has("repo"), false);

  // Every name it clears has to be somewhere `state` actually declares.
  const names = /for \(const key of \[([\s\S]*?)\]\)/u.exec(data.slice(start));
  assert.ok(names !== null, "the cleared-cache list was not found");
  for (const quoted of (names[1] ?? "").match(/"[a-zA-Z]+"/gu) ?? []) {
    const key = quoted.slice(1, -1);
    assert.match(
      data,
      new RegExp(`^  ${key}: `, "mu"),
      `selectSubChannel clears ${key}, which state never declares`,
    );
  }
});
