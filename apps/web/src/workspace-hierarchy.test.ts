import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("global, workspace, conversation, and secondary chrome have separate owners", async () => {
  const [app, chats, css] = await Promise.all([
    publicFile("app.js"),
    publicFile("screen-chats.js"),
    publicFile("styles.css"),
  ]);

  const globalChrome = app.slice(
    app.indexOf("function topbar()"),
    app.indexOf("/**\n * The screens the account menu is the way into."),
  );
  const conversationChrome = chats.slice(
    chats.indexOf("function conversationHeader(repositoryId)"),
    chats.indexOf("/** Compatibility for callers while the conversation header takes ownership. */"),
  );
  const hierarchyCss = css.slice(css.indexOf("/* ------------------------------------------------ workspace hierarchy ---- */"));
  assert.match(app, /<header class="topbar" aria-label="Global">/u);
  assert.match(globalChrome, /class="topbar-start"/u);
  assert.match(globalChrome, /class="global-search"/u);
  assert.match(globalChrome, /class="topbar-actions"/u);
  assert.match(globalChrome, /class="icon-btn topbar-icon-btn"[\s\S]*icon\("info"\)/u);
  assert.doesNotMatch(globalChrome, /topbar-account-btn|data-act="user-menu"/u);
  // Nothing of the product's own in that corner — neither the mark nor the
  // name. The switcher runs down from it, so a mark there is one logo standing
  // over a column of workspace icons and reading as another of them; this shell
  // is workspace-led, and the column below plus the crown beside it are what
  // say whose workspace this is.
  assert.doesNotMatch(globalChrome, /topbar-brand|brandMark\(/u);
  assert.doesNotMatch(globalChrome, /global-brand|>Kumi</u);
  assert.doesNotMatch(app, /const BARE = new Set\(\[[^\]]*"chats"/u);
  assert.match(chats, /<nav class="channel-rail workspace-rail" aria-label="Workspaces"/u);
  assert.match(chats, /aria-label="Switch to workspace /u);
  assert.match(chats, /function chanSidebar[\s\S]*\$\{chanCrown\(activeRepositoryId\)\}/u);
  assert.match(chats, /class="chan-brand"[\s\S]*class="brand-text"/u);
  assert.match(chats, /function chanCrown[\s\S]*act: "chan-sidebar-close"/u);
  assert.match(chats, /function conversationHeader\(repositoryId\)/u);
  assert.match(conversationChrome, /class="conversation-tools"/u);
  assert.doesNotMatch(conversationChrome, /ch-hash|icon\("chatBubble"/u);
  // The pinned shelf and the app the workspace runs are the workspace's, not
  // this row's: they were readable only as two small glyphs among controls
  // that act on whichever destination has the pane, and they act on neither.
  // They are named rows in the workspace's own navigation now, and the header
  // is left with what belongs to the conversation it names.
  // Calls, not mentions: the header keeps a comment saying where the three of
  // them went, which is the whole point of leaving one.
  assert.doesNotMatch(
    conversationChrome,
    /ch-pins-toggle|previewControl\(|previewLink\(/u,
  );
  assert.match(
    chats,
    /function chanSidebar[\s\S]*?\$\{pinsQuickLink\(\)\}[\s\S]*?\$\{previewControl\(activeRepositoryId\)\}/u,
  );
  // Open-ended: the tag carries a phone-only `aria-hidden`/`inert` pair after
  // these attributes, so pinning the closing bracket here asserted a shape the
  // markup stopped having.
  assert.match(chats, /<main class="chan-main" aria-label="Primary conversation" aria-current="page"/u);
  assert.match(chats, /function secondaryPanel\(repositoryId\)/u);
  assert.match(hierarchyCss, /\.topbar \{[^}]*display: grid;[^}]*background: color-mix\(in srgb, var\(--bg-panel\) 88%, var\(--bg\)\);[^}]*border-bottom: 0;/u);
  assert.match(hierarchyCss, /grid-template-columns: minmax\(76px, 1fr\) minmax\(240px, 640px\) minmax\(76px, 1fr\);/u);
  assert.match(hierarchyCss, /\.topbar-icon-btn \{[\s\S]*?flex: 0 0 34px;[\s\S]*?width: 34px;[\s\S]*?height: 34px;/u);
  assert.doesNotMatch(hierarchyCss, /\.topbar-account-btn/u);
  // And no box in the bar sized to the switcher underneath it, at any width.
  assert.doesNotMatch(hierarchyCss, /\.topbar-brand/u);
  assert.match(hierarchyCss, /\.channel-rail \{[^}]*background: color-mix\(in srgb, var\(--bg-panel\) 88%, var\(--bg\)\);/u);
  // The bar and the switcher are one L of chrome: same surface, and no line
  // between them or down the switcher's far side. The seam beside it belongs
  // to the navigation, which is what lets it turn the corner into the line
  // under the bar rather than run past it.
  assert.match(hierarchyCss, /\.channel-rail \{[^}]*border: 0;[^}]*border-radius: 0;/u);
  assert.doesNotMatch(hierarchyCss, /\.channel-rail \{[^}]*border-right:/u);
  // One boundary, started by the navigation's rounded corner and carried to
  // the far edge of the window by the conversation.
  assert.match(
    hierarchyCss,
    /\n\.chan-sidebar \{[^}]*border-top: 1px solid var\(--border-soft\);[^}]*border-left: 1px solid var\(--border-soft\);[^}]*border-right: 1px solid var\(--border-soft\);[^}]*border-radius: var\(--radius-xl\) 0 0 0;/u,
  );
  // And the wedge that corner is cut out of is chrome, not page background:
  // one square of the switcher's own surface, the size of the rounding, where
  // the navigation starts. Without it the two chrome edges met around a notch
  // of something else and the rounded corner read as a small hard right angle.
  assert.match(
    hierarchyCss,
    /\n\.chats-shell \{[\s\S]*?background-image: linear-gradient\(\s*color-mix\(in srgb, var\(--bg-panel\) 88%, var\(--bg\)\),\s*color-mix\(in srgb, var\(--bg-panel\) 88%, var\(--bg\)\)\s*\);\s*background-repeat: no-repeat;\s*background-position: var\(--rail-w\) 0;\s*background-size: var\(--radius-xl\) var\(--radius-xl\);/u,
  );
  assert.match(hierarchyCss, /\n\.chan-main \{[^}]*border-top: 1px solid var\(--border-soft\);[^}]*border-radius: 0;/u);
  // With no switcher the navigation is against the window, where there is
  // nothing to be rounded away from and no edge to draw.
  assert.match(
    hierarchyCss,
    /\.chats-shell\.no-rail > \.chan-sidebar,\s*\.chats-shell\.no-rail > \.chan-main \{\s*border-radius: 0;/u,
  );
  assert.match(hierarchyCss, /\.chats-shell\.no-rail > \.chan-sidebar \{\s*border-left: 0;/u);
  // The drawer on a phone slides over the conversation, so it carries none of
  // that boundary.
  assert.match(
    hierarchyCss,
    /@media \(max-width: 600px\)[\s\S]*?\.chats-shell \.chan-sidebar \{[\s\S]*?border-top: 0;[\s\S]*?border-left: 0;[\s\S]*?border-radius: 0;/u,
  );
  assert.match(css, /\.global-search svg \{[\s\S]*?width: 16px;/u);
  assert.match(css, /\.workspace-sidebar-header \{[\s\S]*?border-bottom:/u);
  assert.match(css, /\.chan-sidebar-head\.chan-quick-links \{[\s\S]*?margin: 4px 8px 2px;/u);
  assert.match(css, /\.chan-quick-link \{[\s\S]*?min-height: 32px;/u);
  assert.match(css, /\.chan-head \{[\s\S]*?position: static;/u);
});

test("a room is the workspace destination, and opening one claims the pane", async () => {
  const [data, chats, app] = await Promise.all([
    publicFile("data.js"),
    publicFile("screen-chats.js"),
    publicFile("app.js"),
  ]);

  // "Main chat" was a quick-link above a Channels list that already held
  // #general: two entries into one conversation, and only the quick-link
  // owned the pane. #general is Main chat now, so the entry is gone and
  // nothing dispatches its action any more.
  assert.doesNotMatch(chats, /data-act="workspace-main-open"/u);
  assert.doesNotMatch(chats, />Main chat<\/span>/u);
  assert.doesNotMatch(app, /case "workspace-main-open":/u);

  // The bug that removal fixes: selecting a room recorded the room and left
  // the pane wherever it was, so a room chosen from a DM or the file tree
  // looked like a click that did nothing.
  const open = app.indexOf('case "sub-channel-open":');
  assert.notEqual(open, -1, "the room-open handler was not found");
  const handler = app.slice(open, app.indexOf("return;", open));
  assert.match(handler, /selectPrimaryDestination\(\{ kind: "main" \}/u);
  assert.match(handler, /selectSubChannel\(repositoryId, value\)/u);
  assert.ok(
    handler.indexOf("selectPrimaryDestination") <
      handler.indexOf("selectSubChannel"),
    "the pane has to be claimed before the room's caches are dropped",
  );

  // The destination itself still exists and is still remembered per
  // workspace — other paths (closing a DM, opening a file) select it.
  assert.match(data, /workspaceDestinations: initialWorkspaceDestinations/u);
  assert.match(data, /persist\([\s\S]*?"ag\.workspaceDestinations"/u);
});

test("workspace marks remain distinct and expose semantic selection", async () => {
  const [chats, css] = await Promise.all([
    publicFile("screen-chats.js"),
    publicFile("styles.css"),
  ]);

  assert.match(chats, /split\(\/\[-_\\s\.\/\]\+\/u\)/u);
  assert.match(chats, /Array\.from\(parts\[0\]\)\.slice\(0, 2\)/u);
  assert.match(chats, /aria-current="page" aria-selected="true"/u);
  assert.match(chats, /destination\.kind === "agent" && destination\.id === agent\.id/u);
  assert.match(chats, /aria-current="\$\{selected \? "page" : "false"\}"/u);
  assert.match(css, /\.channel-rail-entry\.active::before \{[\s\S]*?width: 3px;/u);
  assert.match(css, /\.roster-row-main\.selected \{[\s\S]*?box-shadow: inset 2px 0 0 var\(--accent\)/u);
});

test("settings name the workspace the way the rest of the shell names it", async () => {
  const app = await publicFile("app.js");

  // A workspace renamed to Kumi read "Kumi" in the channel rail and the
  // conversation header, and "LATTICE" in its own settings — because these
  // rows printed the id, which is the handle the routes and the mirror
  // directory are keyed by and not what anybody calls the place. Every
  // surface resolves the name through the one helper now.
  const identity = app.slice(
    app.indexOf("function workspaceSection() {"),
    app.indexOf("function billingCard() {"),
  );
  assert.match(
    identity,
    /term: "Channel open",[\s\S]{0,300}repositoryLabel\(repository\.id\)/u,
  );
  assert.doesNotMatch(identity, /term: "Channel open", value: repository\?\.id/u);

  // Including the invitations beneath it, which name the one channel they
  // grant.
  const invitations = app.slice(
    app.indexOf("function invitationsCard() {"),
    app.indexOf("function workspaceSection() {"),
  );
  assert.match(invitations, /repositoryLabel\(invite\.repositoryId\)/u);
  assert.doesNotMatch(invitations, /invite\.repositoryId \?\? "every channel"/u);
});
