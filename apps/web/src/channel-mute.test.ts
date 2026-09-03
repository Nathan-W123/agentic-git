import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * What muting a channel actually switches off, and what it must not.
 *
 * A mute is the one channel setting that belongs to the person rather than to
 * the repository: renaming, syncing and deleting change what everybody sees,
 * and this changes only who gets interrupted. Every way that distinction could
 * be lost is pinned here — a mute that reached other people's badges, or one
 * that stopped messages arriving at all, would both be the wrong feature.
 *
 * Pinned by the shape of the source, the way the rest of the browser surface
 * is: the dashboard ships as plain ES modules with no bundler, and the test
 * run has no DOM to render them into.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("a mute is stored per person and mirrored for the next cold start", async () => {
  const data = await publicFile("data.js");

  // Read back from storage at import time, like the read cursors beside it:
  // the badge, the notification list and the chime are all consulted before
  // any request can answer, so a mute that only lived on the server would let
  // a muted room shout once on every reload.
  assert.match(
    data,
    /channelMuted: JSON\.parse\(window\.localStorage\.getItem\("ag\.chanmute"\) \?\? "\{\}"\)/u,
  );
  assert.match(data, /export function isChannelMuted\(repositoryId\)/u);
  assert.match(data, /export async function loadChannelMutes\(\)/u);
  assert.match(data, /export async function setChannelMuted\(repositoryId, muted\)/u);

  // The server's list replaces the mirror rather than merging into it, or a
  // room unmuted from another browser could never become loud again here.
  assert.match(
    data,
    /export async function loadChannelMutes\(\)[\s\S]{0,900}state\.channelMuted = muted;/u,
  );
  // Signing in as somebody else must not inherit the last account's mutes.
  assert.match(data, /"ag\.chanmute",\s*\n\s*"ag\.chanread",/u);
});

test("a failed mute is put back rather than left looking as if it worked", async () => {
  const data = await publicFile("data.js");

  // Written locally first so the switcher answers immediately — which means
  // the catch has to restore exactly what was there before.
  assert.match(
    data,
    /export async function setChannelMuted[\s\S]{0,300}const previous = state\.channelMuted\[repositoryId\] === true;/u,
  );
  assert.match(
    data,
    /export async function setChannelMuted[\s\S]{0,1200}catch \(error\) \{\s*if \(previous\) \{/u,
  );
  assert.match(
    data,
    /export async function setChannelMuted[\s\S]{0,1500}throw error;/u,
  );
});

test("muting stops the badge, the notification row and the sound", async () => {
  const data = await publicFile("data.js");
  const app = await publicFile("app.js");

  // The badge.
  assert.match(
    data,
    /export function channelUnreadCount\([\s\S]{0,600}if \(isChannelMuted\(repositoryId\)\) \{\s*return 0;/u,
  );
  // The notification list — silencing a room and then finding all of its work
  // in the bell would be the mute not having done anything.
  assert.match(
    data,
    /\.filter\(\(row\) => !isChannelMuted\(row\.repositoryId\)\)/u,
  );
  // The arrival sound.
  assert.match(
    app,
    /if \(received && !isChannelMuted\(channelRepositoryId\)\) \{\s*chime\("received"\);/u,
  );
});

test("muting changes nothing about the messages themselves", async () => {
  const data = await publicFile("data.js");

  // The count is suppressed, not the history: `countChannelSince` is still
  // what draws the "New messages" divider, and nothing about loading or
  // storing a channel's messages consults the mute.
  assert.match(data, /function countChannelSince\(repositoryId, since, mentionsOnly = false\)/u);
  assert.doesNotMatch(
    data,
    /function channelMessagesFor[\s\S]{0,600}isChannelMuted/u,
  );
});

test("mute sits with the other channel settings, and asks nobody's permission", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");

  // In the channel's own menu, beside rename / sync / delete. The menu is a
  // list `conversationMenuItems` returns now rather than markup built inside
  // a `case`, so mute is an entry in it — same menu, same neighbours.
  const menu = app.slice(
    app.indexOf("function conversationMenuItems(repositoryId) {"),
    app.indexOf("function copyConversationLink"),
  );
  assert.notEqual(menu, "", "the conversation menu should still be built");
  assert.match(menu, /act: "channel-mute",/u);
  assert.match(menu, /act: "channel-info",/u);
  // And in the info popover, which is the other place those three live.
  assert.match(chats, /data-act="channel-mute"/u);
  assert.match(chats, /Mute this channel/u);
  assert.match(chats, /Unmute this channel/u);

  // No role gate. Renaming asks for management and deleting asks for
  // ownership because both change what everybody sees; deciding you would
  // rather not be pinged is nobody else's business.
  assert.doesNotMatch(
    app,
    /canManageRepository\(value\)[\s\S]{0,200}act: "channel-mute"/u,
  );
  assert.match(app, /async function muteChannelAction\(repositoryId\)/u);
  assert.match(
    app,
    /case "channel-mute":\s*\n\s*closePopover\(\);\s*\n\s*void muteChannelAction\(value\);/u,
  );
});

test("a muted room still says so where somebody would wonder", async () => {
  const chats = await publicFile("screen-chats.js");
  const styles = await publicFile("styles.css");

  // The switcher dims it rather than hiding or reordering it: a channel that
  // never raises a badge is otherwise indistinguishable from a quiet one.
  assert.match(chats, /const muted = isChannelMuted\(repo\.id\);/u);
  assert.match(chats, /\$\{muted \? " muted" : ""\}/u);
  assert.match(styles, /\.channel-rail-entry\.muted:not\(\.active\) \.channel-rail-button/u);
  // And the header of the room itself carries the reason it is quiet.
  assert.match(chats, /ch-count ch-muted/u);
});

test("the server is asked for the mutes after the screen is already up", async () => {
  const app = await publicFile("app.js");
  const plan = await publicFile("boot-plan.js");

  // Deliberately not a first-paint load: the local mirror already answers
  // every badge drawn on the way in, so an extra request in the cold-start
  // wave would cost the wait it saves.
  assert.match(app, /void loadChannelMutes\(\)\.then\(\(\) => render\(\)\);/u);
  assert.doesNotMatch(plan, /mute/iu);
});
