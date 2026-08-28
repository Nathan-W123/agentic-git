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
  assert.match(globalChrome, /class="account-btn topbar-account-btn"/u);
  // The mark leads the bar from the corner the workspace switcher runs down.
  // What must not come back beside it is the product's *name*: this shell is
  // workspace-led, and the crown below is what says whose workspace this is.
  assert.match(globalChrome, /class="topbar-brand">\$\{brandMark\(\d+\)\}/u);
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
  assert.match(chats, /<main class="chan-main" aria-label="Primary conversation" aria-current="page">/u);
  assert.match(chats, /function secondaryPanel\(repositoryId\)/u);
  assert.match(hierarchyCss, /\.topbar \{[^}]*display: grid;[^}]*background: color-mix\(in srgb, var\(--bg-panel\) 88%, var\(--bg\)\);[^}]*border-bottom: 0;/u);
  assert.match(hierarchyCss, /grid-template-columns: minmax\(76px, 1fr\) minmax\(240px, 640px\) minmax\(76px, 1fr\);/u);
  assert.match(hierarchyCss, /\.topbar-icon-btn,[\s\S]*?\.topbar-account-btn \{[\s\S]*?flex: 0 0 34px;[\s\S]*?width: 34px;[\s\S]*?height: 34px;/u);
  // Sized and offset to the rail rather than to the bar's padding, so the mark
  // stands on the switcher's centre line instead of near it.
  assert.match(hierarchyCss, /\.topbar-brand \{[\s\S]*?width: var\(--rail-w\);[\s\S]*?margin-inline-start: -12px;/u);
  assert.match(hierarchyCss, /\.channel-rail \{[^}]*background: color-mix\(in srgb, var\(--bg-panel\) 88%, var\(--bg\)\);/u);
  assert.match(css, /\.global-search svg \{[\s\S]*?width: 16px;/u);
  assert.match(css, /\.workspace-sidebar-header \{[\s\S]*?border-bottom:/u);
  assert.match(css, /\.chan-sidebar-head\.chan-quick-links \{[\s\S]*?margin: 4px 8px 2px;/u);
  assert.match(css, /\.chan-quick-link \{[\s\S]*?min-height: 32px;/u);
  assert.match(css, /\.chan-head \{[\s\S]*?position: static;/u);
});

test("Main chat is a persistent selectable workspace destination", async () => {
  const [data, chats, app] = await Promise.all([
    publicFile("data.js"),
    publicFile("screen-chats.js"),
    publicFile("app.js"),
  ]);

  assert.match(chats, /data-act="workspace-main-open"/u);
  assert.match(chats, />Main chat<\/span>/u);
  assert.match(chats, /destination\.kind === "main" \? " on"/u);
  assert.match(chats, /aria-current="\$\{destination\.kind === "main" \? "page" : "false"\}"/u);
  assert.match(app, /case "workspace-main-open":[\s\S]*?selectPrimaryDestination\(\{ kind: "main" \}/u);
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
