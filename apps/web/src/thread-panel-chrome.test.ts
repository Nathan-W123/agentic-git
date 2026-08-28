import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("conversation and secondary headers align while the message pane keeps a floor", async () => {
  const [app, chats, css] = await Promise.all([
    publicFile("app.js"),
    publicFile("screen-chats.js"),
    publicFile("styles.css"),
  ]);

  assert.match(chats, /class="chan-head conversation-header"/u);
  assert.match(chats, /class="thread-head"/u);
  assert.match(css, /--thread-head-h: 48px/u);
  assert.match(css, /\.chan-head \{[\s\S]*?height: var\(--thread-head-h\)/u);
  assert.match(css, /\.thread-head \{[\s\S]*?min-height: var\(--thread-head-h\)/u);
  assert.match(app, /const MAIN_MIN = 480/u);
  assert.match(app, /available - MAIN_MIN/u);
});

test("intermediate and compact secondary contexts overlay instead of squeezing chat", async () => {
  const css = await publicFile("styles.css");
  assert.match(css, /@media \(max-width: 1180px\) and \(min-width: 601px\)[\s\S]*?\.chats-shell > \.thread-panel \{[\s\S]*?position: absolute;/u);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.chats-shell > \.thread-panel \{[\s\S]*?position: fixed;[\s\S]*?width: 100vw;/u);
  assert.match(css, /\.thread-panel\.panel-entering \{[\s\S]*?hierarchy-panel-in/u);
  assert.match(css, /translateX\(10px\)/u);
});

test("Escape closes the top secondary context and restores focus", async () => {
  const app = await publicFile("app.js");
  assert.match(app, /function closeSidePanel\(\)[\s\S]*?activeSecondaryContext\(\)/u);
  assert.match(app, /function returnFocusFromSecondaryContext\(/u);
  assert.match(app, /event\.key !== "Escape"/u);
  assert.match(app, /closeSidePanel\(\)[\s\S]*?returnFocusFromSecondaryContext\(closing, closingValue\)/u);
});

test("reduced motion removes spatial primary and secondary transitions", async () => {
  const css = await publicFile("styles.css");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.primary-entering,[\s\S]*?\.thread-panel\.panel-entering[\s\S]*?animation: none;/u);
});
