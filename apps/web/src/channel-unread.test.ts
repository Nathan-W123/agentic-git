import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The per-room badge on the sidebar.
 *
 * The count has to come off the server's room record rather than be derived
 * in the browser: only the open room's messages are in the cache, so anything
 * counted here would read zero for every room except the one already on
 * screen — which is the one room a badge is useless on.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("a room's badge is the server's count, and a mute silences it", async () => {
  const data = await publicFile("data.js");

  // Run the real function. A version that read the local per-repository cache
  // would still mention `state.subChannels` and pass any source check, while
  // reporting zero for every room the reader is not in.
  const start = data.indexOf("export function subChannelUnread");
  assert.notEqual(start, -1, "subChannelUnread was not found");
  const body = data
    .slice(start, data.indexOf("\n}", start) + 2)
    .replace("export function", "function");

  const state = {
    subChannels: {
      repo: [
        { id: "chan_general", unread: 3 },
        { id: "chan_backend", unread: 0 },
        { id: "chan_odd" },
      ],
    } as Record<string, { id: string; unread?: unknown }[]>,
    channelMuted: {} as Record<string, boolean>,
  };
  const subChannelUnread = new Function(
    "state",
    "isChannelMuted",
    `${body}; return subChannelUnread;`,
  )(state, (repositoryId: string) => state.channelMuted[repositoryId] === true) as (
    repositoryId: string,
    channelId: string,
  ) => number;

  assert.equal(subChannelUnread("repo", "chan_general"), 3);
  assert.equal(subChannelUnread("repo", "chan_backend"), 0);
  // A record from a control plane that has not learned the field yet reads as
  // no badge, never as NaN painted into the markup.
  assert.equal(subChannelUnread("repo", "chan_odd"), 0);
  assert.equal(subChannelUnread("repo", "chan_missing"), 0);
  assert.equal(subChannelUnread("", "chan_general"), 0);

  // A muted workspace raises no badge on any of its rooms — the same rule the
  // workspace rail already follows, and for the same reason.
  state.channelMuted["repo"] = true;
  assert.equal(subChannelUnread("repo", "chan_general"), 0);
});

test("opening a room clears its badge without waiting for the server", async () => {
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");

  // Cleared locally on selection, so the badge goes on the frame the room
  // opens on rather than after the next room-list read lands.
  const start = data.indexOf("export function noteSubChannelRead");
  assert.notEqual(start, -1, "noteSubChannelRead was not found");
  const body = data
    .slice(start, data.indexOf("\n}", start) + 2)
    .replace("export function", "function");
  const state = {
    subChannels: { repo: [{ id: "chan_a", unread: 7 }] },
  };
  const noteSubChannelRead = new Function(
    "state",
    `${body}; return noteSubChannelRead;`,
  )(state) as (repositoryId: string, channelId: string) => void;

  noteSubChannelRead("repo", "chan_a");
  assert.equal(state.subChannels.repo[0]!.unread, 0);
  // A room that is not there is not an error — the list may not have loaded.
  noteSubChannelRead("repo", "chan_absent");
  noteSubChannelRead("other", "chan_a");

  // And selecting a room calls it, or the clear never happens.
  const select = data.slice(data.indexOf("export function selectSubChannel"));
  assert.match(
    select.slice(0, select.indexOf("\n}\n")),
    /noteSubChannelRead\(repositoryId, channelId\)/u,
  );

  // The row draws it, and not on the row the reader is already looking at.
  assert.match(chats, /const unread = subChannelUnread\(repositoryId, channel\.id\)/u);
  assert.match(chats, /unread > 0 && !active/u);
  assert.match(chats, /chan-channel-unread/u);

  const styles = await publicFile("styles.css");
  assert.match(styles, /\.chan-channel-unread \{/u);
});
