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

test("the secondary panel is a rounded card with its own gutter", async () => {
  const css = await publicFile("styles.css");
  const panel = css.slice(css.indexOf("\n.chats-shell > .thread-panel {"));

  // The frame around the conversation gave up its gutters and its rounding to
  // become one continuous surface. A thread did not: it arrives, it is dragged
  // wider and it is closed again, so it stays a card in front of that surface.
  assert.match(panel, /^\n\.chats-shell > \.thread-panel \{[\s\S]*?margin: 8px;/u);
  assert.match(panel, /^\n\.chats-shell > \.thread-panel \{[\s\S]*?border: 1px solid var\(--border-soft\);/u);
  assert.match(panel, /^\n\.chats-shell > \.thread-panel \{[\s\S]*?border-radius: var\(--radius-xl\);/u);
  // One gutter between two cards, not one from each of them.
  assert.match(css, /\.chats-shell > \.thread-panel \+ \.thread-panel \{\s*margin-left: 0;/u);
  // Both overlay tiers cover the conversation edge to edge instead, where a
  // gutter would crop the card against the window and the corners with it.
  assert.match(
    css,
    /@media \(max-width: 1180px\) and \(min-width: 601px\)[\s\S]*?\.chats-shell > \.thread-panel \{[\s\S]*?margin: 0;[\s\S]*?border-radius: 0;/u,
  );
  assert.match(
    css,
    /@media \(max-width: 600px\)[\s\S]*?\.chats-shell > \.thread-panel \{[\s\S]*?margin: 0;[\s\S]*?border-radius: 0;/u,
  );
});

test("the thread's reply box stands on the same floor as the room's", async () => {
  const [chats, css] = await Promise.all([
    publicFile("screen-chats.js"),
    publicFile("styles.css"),
  ]);

  // The two boxes are read side by side, so how high above the window they
  // end is one number rather than one each.
  assert.match(css, /:root \{\s*--composer-floor: 12px;\s*\}/u);
  assert.match(
    css,
    /\.chan-composer-wrap \{\s*margin-bottom: calc\(var\(--composer-floor\) \+ var\(--safe-bottom\)\);/u,
  );
  assert.match(
    css,
    /\.composer:not\(\.chan-composer-wrap \.composer\) \{\s*margin-bottom: calc\(var\(--composer-floor\) \+ var\(--safe-bottom\)\);/u,
  );

  // The room's composer measures that floor from a column which reaches the
  // bottom of the window; the thread's measures it from a card set 8px inside
  // the shell and edged with a hairline. Without giving those nine pixels
  // back, the reply box ended nine pixels above the box beside it.
  assert.match(css, /\.chats-shell > \.thread-panel \{[\s\S]*?--panel-gutter: 9px;/u);
  assert.match(
    css,
    /\.chats-shell > \.thread-panel \.thread-composer-wrap \.composer \{\s*margin-bottom: calc\(\s*var\(--composer-floor\) - var\(--panel-gutter, 0px\) \+ var\(--safe-bottom\)\s*\);/u,
  );

  // Both overlay tiers cover the conversation edge to edge, so there is no
  // gutter to hand back and the plain floor is the right one again.
  assert.match(
    css,
    /@media \(max-width: 1180px\) and \(min-width: 601px\)[\s\S]*?\.chats-shell > \.thread-panel \{[\s\S]*?--panel-gutter: 0px;/u,
  );
  assert.match(
    css,
    /@media \(max-width: 600px\)[\s\S]*?\.chats-shell > \.thread-panel \{[\s\S]*?--panel-gutter: 0px;/u,
  );

  // And the box the rules above are aiming at is still the last row of the
  // panel's grid, under the transcript rather than floating over it.
  assert.match(css, /\.thread-panel \{[\s\S]*?grid-template-rows: auto 1fr auto;/u);
  assert.match(
    chats,
    /<div class="thread-composer-wrap[\s\S]*?placeholder="Add to this thread\.\.\."/u,
  );
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
