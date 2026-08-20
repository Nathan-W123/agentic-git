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
 * agents; and a notification, once clicked, marked itself read and left
 * finding the failure to you.
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

test("the account menu is the door into every screen that had none", async () => {
  const app = await publicFile("app.js");

  // The three destinations that were live and unreachable. One list, because
  // the topbar avatar and the channel sidebar's foot open the same menu — a
  // single change point for all three.
  const destinations = slice(
    app,
    "function accountDestinations() {",
    "\n/**",
  );
  assert.match(destinations, /act: "go-notifications"/u);
  assert.match(destinations, /act: "dm-list"/u);
  assert.match(destinations, /label: "My agents"/u);

  // The counts are read at the moment the menu is built, not carried in
  // state: a number that can disagree with the list under it is worse than no
  // number, and both are cheap.
  assert.match(destinations, /const unread = unreadCount\(\);/u);
  assert.match(destinations, /const dms = dmUnreadTotal\(\);/u);

  const menu = slice(app, 'case "user-menu":', 'case "switch-close":');
  assert.match(menu, /\.\.\.accountDestinations\(\)/u);
  assert.match(menu, /value: "settings", label: "Settings"/u);
  assert.match(menu, /act: "logout"/u);

  // "Connect an agent first" stays exactly as it was. It is a good empty
  // state; what it was not is a navigation strategy, since it is offered only
  // while this account has connected nothing.
  assert.match(app, /label: "Connect an agent first"/u);
});

test("the notifications bell is on screen wherever the reader is", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // The route, the screen, the filters, `unreadCount()` and even the
  // `go-notifications` case all existed; the button did not.
  assert.match(app, /function notificationBell\(\)/u);
  assert.match(app, /data-act="go-notifications"/u);
  assert.match(app, /case "go-notifications":/u);
  assert.match(app, /const unread = unreadCount\(\);/u);

  // The Chats screen draws no topbar — see `BARE` — so the one screen people
  // are actually on would otherwise be the one screen with no bell.
  assert.match(app, /const BARE = new Set\(\["code", "coordinator", "chats"\]\)/u);
  assert.match(chats, /class="icon-btn bell chan-bell"/u);
  assert.match(chats, /data-act="go-notifications"/u);

  // The badge is a count, and it is drawn only when there is something to
  // count.
  assert.match(app, /unread === 0\s*\n?\s*\? ""/u);
  assert.match(css, /\.bell \.dot-badge,/u);
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

  assert.match(app, /function dmBadge\(\)/u);
  assert.match(chats, /countBadge\(dmUnreadTotal\(\)\)/u);

  // The menu row opens the conversations themselves, each with its own count.
  const list = slice(app, 'case "dm-list": {', 'case "repo-menu":');
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
