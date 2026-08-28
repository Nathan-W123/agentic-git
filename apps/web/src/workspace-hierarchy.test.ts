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

  assert.match(app, /<header class="topbar" aria-label="Global">/u);
  assert.match(app, /class="global-brand"[\s\S]*?<span>Kumi<\/span>/u);
  assert.doesNotMatch(app, /const BARE = new Set\(\[[^\]]*"chats"/u);
  assert.match(chats, /<nav class="channel-rail workspace-rail" aria-label="Workspaces"/u);
  assert.match(chats, /aria-label="Switch to workspace /u);
  assert.match(chats, /function chanSidebar[\s\S]*\$\{chanCrown\(activeRepositoryId\)\}/u);
  assert.match(chats, /function conversationHeader\(repositoryId\)/u);
  assert.match(chats, /<main class="chan-main" aria-label="Primary conversation" aria-current="page">/u);
  assert.match(chats, /function secondaryPanel\(repositoryId\)/u);
  assert.match(css, /\.workspace-sidebar-header \{[\s\S]*?border-bottom:/u);
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
