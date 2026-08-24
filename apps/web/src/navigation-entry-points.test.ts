import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * Ways back into the screens that were already there.
 *
 * Three of the friction audit's findings were the same shape: a route, a
 * screen, its state and even its action handler all existed and shipped, and
 * nothing anywhere on any screen navigated to them. Notifications could only
 * be reached by typing its hash; My Agents was offered only while you had no
 * agents (it is reached by name from the quick switcher now, and no longer
 * sits in the account menu); and a notification, once clicked, marked itself
 * read and left finding the failure to you.
 *
 * Pinned the way the rest of the browser surface is pinned — by the shape of
 * the source — because the dashboard ships as plain ES modules with no
 * bundler and the test run has no DOM.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

/** One region of a file, from its opening marker to the next one. */
function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.notEqual(start, -1, `${from} should exist`);
  assert.notEqual(end, -1, `${from} should end at ${to}`);
  return source.slice(start, end);
}

test("the account menu carries account destinations", async () => {
  const app = await publicFile("app.js");

  // The destinations that were live and unreachable. One list, because the
  // topbar avatar and the channel sidebar's foot open the same menu — a
  // single change point for both.
  const destinations = slice(
    app,
    "function accountDestinations() {",
    "\n/**",
  );
  assert.match(destinations, /act: "dm-list"/u);
  // Notifications is not one of them. Pressing your own name is how you reach
  // your own things, and the backlog of everything every agent has done is not
  // that — it keeps the topbar bell and the quick switcher.
  assert.doesNotMatch(destinations, /act: "go-notifications"/u);
  // My Agents is not one of them either: this menu is who is writing to you,
  // not a roster of agent connections.
  assert.doesNotMatch(destinations, /value: "agents"/u);

  // The count is read at the moment the menu is built, not carried in state:
  // a number that can disagree with the list under it is worse than no
  // number, and it is cheap.
  assert.match(destinations, /const dms = dmUnreadTotal\(\);/u);

  const menu = slice(app, 'case "user-menu":', 'case "switch-close":');
  assert.match(menu, /\.\.\.accountDestinations\(\)/u);
  assert.doesNotMatch(menu, /value: "settings"|label: "Settings"/u);
  assert.match(menu, /act: "logout"/u);

  // Empty Agents-plus: connect goes to Settings, where agent credentials live.
  // Offered only while this account has connected nothing — that is still an
  // empty-state affordance, not a second door into a roster screen.
  const agentMenu = slice(app, 'case "channel-agent-menu":', 'case "channel-agent-pick":');
  assert.match(agentMenu, /label: "Connect agents"/u);
  assert.match(agentMenu, /value: "settings"/u);
  assert.doesNotMatch(agentMenu, /value: "agents"/u);
});

test("the Chats sidebar has no notification shortcut", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");

  // Notifications remain reachable from the topbar on secondary screens and
  // by name in the quick switcher.
  assert.match(app, /function notificationBell\(\)/u);
  assert.match(app, /case "go-notifications":/u);

  // The always-visible control at the lower left is deliberately gone.
  const sidebar = slice(
    chats,
    "function chanSidebar(",
    "/* ---------------------------------------------------------- chan main",
  );
  assert.doesNotMatch(sidebar, /chan-bell/u);
  assert.doesNotMatch(sidebar, /data-act="go-notifications"/u);
});

test("an unread direct message has a number somewhere on screen", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");

  // The conversation list has carried per-person unread counts all along and
  // they were only ever drawn beside somebody already in this channel's
  // roster — so a message from anyone else was invisible.
  assert.match(data, /export function dmUnreadTotal\(\)/u);
  const total = slice(data, "export function dmUnreadTotal()", "\n/** Unread messages waiting from one person. */");
  assert.match(total, /state\.dmConversations\.reduce/u);
  assert.match(total, /conversation\.unread/u);
  // Agent private-chat threads do not count toward the account badge.
  assert.match(total, /isDirectMessagePerson\(conversation\.userId\)/u);

  assert.match(app, /function dmBadge\(\)/u);
  assert.match(chats, /countBadge\(dmUnreadTotal\(\)\)/u);

  // The menu row opens the conversations themselves, each with its own count.
  const list = slice(app, "function showDirectMessageMenu(node) {", "\n/**\n * Opens the already-cached");
  assert.match(list, /act: "dm-open"/u);
  assert.match(list, /hint: `\$\{conversation\.unread\} unread`/u);
});

test("a notification opens what it is about", async () => {
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");

  // The rows have carried a `taskId` since they were written; the repository
  // beside it is what makes a destination resolvable without a new route.
  const rows = slice(data, "export function notifications() {", "function notificationBody(");
  assert.match(rows, /repositoryId: task\?\.repositoryId,/u);

  const open = slice(app, 'case "notif-open": {', 'case "invite":');
  // Read first and unconditionally: a row that cannot be opened should still
  // stop nagging.
  assert.ok(
    open.indexOf("readOne(value, render)") < open.indexOf("navigate(\"chats\")"),
    "the row is marked read before anywhere is navigated to",
  );
  assert.match(open, /const row = notifications\(\)\.find/u);
  assert.match(open, /if \(repositoryId === undefined\) \{\s*\n\s*return;/u);
  assert.match(open, /openChannel\(repositoryId, render\)/u);
  // The thread the failure happened in, matched on the same field the revert
  // button acts on. No match means the root is older than the loaded page,
  // and the channel is still the right place to have landed.
  assert.match(open, /entry\.taskId === row\.taskId/u);
  assert.match(open, /state\.activeChannelThread = root\.id;/u);
});

test("the keyboard can reach a room, a person, or a screen", async () => {
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");

  assert.match(app, /function openSwitcher\(\)/u);
  assert.match(app, /event\.key\.toLowerCase\(\) === "k"/u);
  assert.match(app, /function switcherEntries\(query\)/u);
  const entries = slice(app, "function switcherEntries(query) {", "function paintSwitcher()");
  assert.match(entries, /state\.repositories\.map/u);
  assert.match(entries, /state\.dmPeople/u);
  assert.match(entries, /route: "notifications"/u);

  // Drawn in `#layer-root`, outside the shell the poll replaces — an overlay
  // inside the app root would be swept away mid-search.
  assert.match(app, /document\.querySelector\("#layer-root"\)\.append\(layer\)/u);
  assert.match(css, /\.qs-layer \{/u);

  // The single-key shortcuts must never eat a character out of somebody's
  // sentence.
  assert.match(app, /function typingSomewhere\(target\)/u);
  assert.match(app, /input, textarea, select, \[contenteditable='true'\]/u);
  assert.match(app, /if \(event\.key === "\?"\)/u);
  assert.match(app, /function openShortcutSheet\(\)/u);
});

test("settings is visible beside the account menu", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");

  // Settings is an explicit control at the bottom-right of the sidebar rather
  // than another destination hidden behind the account avatar.
  assert.match(chats, /class="chan-account" data-act="user-menu"/u);
  assert.match(
    chats,
    /class="icon-btn chan-settings" data-act="nav"\s*data-value="settings"/u,
  );
  assert.match(chats, /class="icon-btn chan-settings"[\s\S]{0,160}icon\("gear"\)/u);
  const menu = slice(app, 'case "user-menu":', 'case "switch-close":');
  assert.match(menu, /\.\.\.accountDestinations\(\)/u);
  assert.doesNotMatch(menu, /value: "settings"|label: "Settings"/u);

  // Direct messages comes from the shared list, so both account buttons offer
  // the same door — and neither offers Notifications or My Agents.
  const destinations = slice(app, "function accountDestinations() {", "\n/**");
  assert.match(destinations, /act: "dm-list"/u);
  assert.doesNotMatch(destinations, /act: "go-notifications"/u);
  assert.doesNotMatch(destinations, /value: "agents"/u);
});

test("direct messages are offered with people and with nobody else", async () => {
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");

  // An agent is not somebody you send private mail to: your own is reached by
  // `agent-chat-open` beside the channel, and an org agent works in the room.
  // Filtered by the full set of agent correspondent ids rather than only
  // `state.agents` (project adapter configs), because personal and roster
  // agents carry provider ids and `${userId}:${provider}` composites.
  assert.match(data, /export function agentCorrespondentIds\(\)/u);
  assert.match(data, /export function isDirectMessagePerson\(userId\)/u);
  const person = slice(
    data,
    "export function isDirectMessagePerson(userId) {",
    "\n/**\n * Everything waiting from people",
  );
  assert.match(person, /agentCorrespondentIds\(\)\.has\(id\)/u);
  assert.match(person, /currentUserId\(\)/u);
  // A historical conversation is not a contact. Requiring the current DM
  // roster also guarantees there is a real name to render instead of a raw
  // internal user id.
  assert.match(person, /state\.dmPeople\.some/u);
  assert.match(person, /String\(person\?\.id/u);

  const list = slice(
    app,
    "function showDirectMessageMenu(node) {",
    "\n/**\n * Opens the already-cached",
  );
  assert.match(list, /isDirectMessagePerson\(conversation\.userId\)/u);
  assert.match(list, /isDirectMessagePerson\(person\.id\)/u);

  // Opening a person closes any agent private-chat panel that was beside it.
  const open = slice(
    app,
    "function openUserDirectMessage(userId) {",
    "\n/**\n * Who this account can write to privately",
  );
  assert.match(open, /state\.activeAgentPanel = undefined/u);
  assert.match(open, /clearRightPanel\("agent"\)/u);

  // The half that makes it a way to start one: everybody reachable who is not
  // already in a thread with this account. "No conversations yet" used to be
  // the whole menu for anyone who had not written to somebody first.
  assert.match(list, /state\.dmPeople\.filter/u);
  assert.match(list, /!talking\.has\(person\.id\)/u);
  assert.match(list, /label: "Nobody else on this project yet"/u);

  // The account menu still reaches the same door.
  const destinations = slice(app, "function accountDestinations() {", "\n/**");
  assert.match(destinations, /act: "dm-list"/u);
  assert.match(app, /case "dm-list": \{\s*\n\s*showDirectMessageMenu\(node\);/u);
  assert.match(
    app,
    /case "dm-open":\s*\n\s*state\.activeDm = value;\s*\n\s*state\.dmDraft = "";\s*\n\s*openUserDirectMessage\(value\);/u,
  );
});

test("settings dialog enter animation only plays when the dialog opens", async () => {
  const app = await publicFile("app.js");
  const dialog = slice(
    app,
    "function settingsDialog() {",
    "\n/**\n * The user's own GitHub",
  );

  // The overlay is a new node on every render, so an animation on the bare
  // class would replay from opacity 0 whenever a settings control called
  // render — the panel going away and coming back while it was still open.
  assert.doesNotMatch(
    dialog,
    /\.settings-layer\{[^}]*animation:scrim-in/u,
  );
  assert.doesNotMatch(
    dialog,
    /\.settings-dialog\{[^}]*animation:settings-in/u,
  );
  assert.match(
    dialog,
    /\.settings-layer\.settings-entering\{[^}]*animation:scrim-in/u,
  );
  assert.match(
    dialog,
    /\.settings-layer\.settings-entering \.settings-dialog\{[^}]*animation:settings-in/u,
  );

  const motion = slice(app, "const MOTION_SURFACES = [", "const surfaceNodes");
  assert.match(motion, /selector:\s*"\.settings-layer"/u);
  assert.match(motion, /enter:\s*"settings-entering"/u);
  assert.match(motion, /leave:\s*"settings-leaving"/u);
});

test("Advanced is a category in the settings dialog", async () => {
  const app = await publicFile("app.js");

  const dialog = slice(app, "const SETTINGS_SECTIONS = [", "\n/**\n * The user's own GitHub");
  assert.match(dialog, /id: "advanced"/u);
  assert.match(dialog, /case "advanced":\s*\n\s*return `\$\{repositoryCard\(\)\}\$\{admissionsCard\(\)\}`/u);
  assert.match(dialog, /data-act="settings-close"/u);
  assert.match(dialog, /data-act="settings-section"/u);
  assert.doesNotMatch(app, /function advancedScreen|function settingsScreen/u);
  assert.match(
    app,
    /if \(route === "settings" \|\| route === "advanced"\)[\s\S]{0,220}openSettings/u,
  );
});
