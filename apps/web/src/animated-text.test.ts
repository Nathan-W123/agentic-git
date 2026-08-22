import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The arrival animation is browser-side and the dashboard ships as plain ES
 * modules with no bundler, so it is pinned the way the rest of the browser
 * surface is pinned: by asserting the shape of the source and the stylesheet.
 *
 * What is being protected is the pair of decisions that make the effect
 * readable rather than irritating — words animate only when they are new to
 * the reader, and a redraw part-way through carries on instead of starting
 * over — plus the reduced-motion escape hatch.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("new words come in one at a time, after the document is swapped", async () => {
  const app = await publicFile("app.js");
  const swap = app.indexOf('root.innerHTML = `<div class="app">');
  const reveal = app.indexOf("playTextReveal(root);");
  assert.notEqual(swap, -1, "the screen should still go through one swap");
  assert.notEqual(reveal, -1, "the render loop should play the arrival");
  assert.equal(
    swap < reveal,
    true,
    "words can only be wrapped once the new document exists",
  );
  // Beside the panel motion, which is the other thing only the render loop
  // can know: both answer "what changed in this swap".
  assert.equal(
    app.indexOf("playSurfaceMotion(root);") < reveal,
    true,
    "surfaces settle before their words arrive",
  );
});

test("text arrives once, and only in a surface already on screen", async () => {
  const app = await publicFile("app.js");
  const start = app.indexOf("function playTextReveal(root)");
  const end = app.indexOf("\n}\n", start);
  assert.notEqual(start, -1, "the arrival pass should exist");
  const body = app.slice(start, end);

  // Opening a channel, a thread or a direct message is a backlog being read,
  // not a hundred messages arriving; only the group that was already being
  // watched animates.
  assert.match(body, /revealGroups\.has\(group\)/u);
  // Remembered, so the second render of the same words does nothing.
  assert.match(body, /revealSeen\.set\(key, arriving \? now : 0\)/u);
  assert.match(body, /started === 0/u);
  // A redraw mid-arrival resumes rather than replays: the elapsed time is
  // handed to the wrapper, which turns it into a negative delay.
  assert.match(body, /const elapsed = now - started;/u);
  assert.match(body, /revealWords\(block, elapsed\)/u);

  const words = app.slice(app.indexOf("function revealWords(block, elapsed)"));
  assert.match(words, /index \* step - elapsed/u);
  // The arrival is over once the spread and the last word's own settle are
  // done, and that is what decides how long a redraw keeps resuming it.
  assert.match(body, /REVEAL_MAX_TOTAL_MS \+ REVEAL_WORD_MS/u);
  // Prose only. A diff or a code block is not read word by word, and taking
  // one apart would put a span through its whitespace.
  assert.match(app, /const REVEAL_SKIPPED = new Set\(\[[^\]]*"PRE"[^\]]*"CODE"/u);

  // `group|id`: the surface, then the block within it.
  const key = Function(
    `"use strict";\n${app.slice(
      app.indexOf("function revealGroupOf(key)"),
      app.indexOf("function motionIsUnwanted()"),
    )}\nreturn revealGroupOf;`,
  )() as (value: string) => string;
  assert.equal(key("chan:repo-1|msg-7"), "chan:repo-1");
  assert.equal(key("thread:m3|msg-7"), "thread:m3");
  assert.equal(key("nothing"), "nothing");
});

test("every conversation surface names the words it is showing", async () => {
  const chats = await publicFile("screen-chats.js");
  // The room's transcript and the thread panel render the same row, so the
  // key carries the surface: a reply read in the room must not arrive again
  // when the thread holding it is opened.
  assert.match(
    chats,
    /<div class="cmsg-text" data-reveal="\$\{esc\(/u,
    "message text should be watchable",
  );
  assert.match(chats, /thread:\$\{entry\.messageId \?\? entry\.id\}/u);
  assert.match(chats, /chan:\$\{repositoryId\}/u);
  // Direct messages are their own surface and their own group.
  assert.match(chats, /data-reveal="dm:\$\{esc\(userId\)\}\|msg-\$\{esc\(message\.id\)\}"/u);
});

test("live status copy keeps sweeping instead of arriving", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  // "Zeus is thinking" is ongoing, not new, so it takes the travelling
  // highlight the thread activity line already uses rather than the one-off.
  assert.match(chats, /<span class="typing-who text-sweep">/u);
  const sweep = /\n\.text-sweep \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(sweep ?? "", /animation: thread-activity-sweep/u);
  assert.match(sweep ?? "", /background-clip: text;/u);
});

test("a word settles from blurred and low, and holds still under reduced motion", async () => {
  const css = await publicFile("styles.css");
  const word = /\n\.text-reveal-word \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(word, undefined, "a word should have its own rule");
  assert.match(word ?? "", /display: inline-block;/u);
  assert.match(word ?? "", /animation: text-reveal-in/u);
  assert.match(word ?? "", /animation-delay: var\(--reveal-delay, 0ms\);/u);

  const frames = /@keyframes text-reveal-in \{([\s\S]*?)\n\}\n/u.exec(css)?.[1];
  assert.match(frames ?? "", /opacity: 0;/u);
  assert.match(frames ?? "", /filter: blur\(4px\);/u);
  assert.match(frames ?? "", /transform: translateY\(3px\);/u);

  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\n {2}\.text-reveal-word \{\n {4}animation: none;/u,
    "words should simply be there when motion is unwanted",
  );
});

test("a long arrival hurries rather than dragging on", async () => {
  const app = await publicFile("app.js");
  // The pace is a function of how many words there are, so it can be read
  // out of the source and exercised directly.
  const pace = Function(
    `"use strict";\n${app.slice(
      app.indexOf("const REVEAL_STAGGER_MS"),
      app.indexOf("const revealSeen = new Map()"),
    )}\nreturn { revealStaggerFor, REVEAL_STAGGER_MS, REVEAL_MAX_TOTAL_MS };`,
  )() as {
    revealStaggerFor: (count: number) => number;
    REVEAL_STAGGER_MS: number;
    REVEAL_MAX_TOTAL_MS: number;
  };
  const spread = (count: number): number =>
    (count - 1) * pace.revealStaggerFor(count);

  // A lone word has nothing to wait for.
  assert.equal(spread(1), 0);

  // A short line keeps the opening pace: a handful of words are still a beat
  // apart, which is the whole reason the effect reads as words arriving.
  assert.equal(pace.revealStaggerFor(4) <= pace.REVEAL_STAGGER_MS, true);
  assert.equal(spread(4) < 100, true, "a few words should be over at once");

  // Longer means faster per word, not merely more of the same — this is what
  // keeps a long answer from being read out at the pace of a short one.
  assert.equal(
    pace.revealStaggerFor(200) < pace.revealStaggerFor(20),
    true,
    "the gap between words should close as there are more of them",
  );
  assert.equal(
    spread(200) < 4 * spread(50),
    true,
    "four times the words should be far less than four times the wait",
  );

  // And however much was said, the reader is never left watching.
  for (const count of [200, 1_000, 10_000]) {
    assert.equal(
      spread(count) < pace.REVEAL_MAX_TOTAL_MS,
      true,
      "no arrival should outlast the ceiling",
    );
  }
});
