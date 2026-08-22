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

/** What one arrival is made of, lifted out of the browser file. */
interface RevealShapes {
  make: (name: string, classes?: string[], attributes?: string[]) => unknown;
  nest: (...nodes: unknown[]) => void;
  revealIsMedia: (element: unknown) => boolean;
  revealWholeOf: (node: unknown, block: unknown) => unknown;
}

/**
 * The helpers that decide what counts as one arrival read a handful of node
 * properties and nothing else, so they can be run here against stand-in nodes
 * rather than only pattern-matched.
 */
function revealShapes(app: string): RevealShapes {
  const start = app.indexOf("function revealIsMedia(");
  const end = app.indexOf("function revealWords(block, elapsed)");
  assert.notEqual(start, -1, "media should be named");
  assert.equal(start < end, true, "and named before the pass that uses it");
  return Function(
    `"use strict";
     class Element {
       constructor(name, classes, attributes) {
         this.nodeName = name;
         this.classList = { contains: (value) => classes.includes(value) };
         this.attributes = attributes;
         this.parentNode = null;
       }
       hasAttribute(name) { return this.attributes.includes(name); }
     }
     const make = (name, classes = [], attributes = []) =>
       new Element(name, classes, attributes);
     const nest = (...nodes) => {
       nodes.reduce((parent, child) => {
         child.parentNode = parent;
         return child;
       });
     };
     ${app.slice(start, end)}
     return { make, nest, revealIsMedia, revealWholeOf };`,
  )() as RevealShapes;
}

test("an image arrives on the same schedule as the words around it", async () => {
  const app = await publicFile("app.js");
  const shapes = revealShapes(app);
  const block = shapes.make("DIV", ["cmsg-text"]);

  // A posted picture is a link around an image. Both halves answer to
  // "is this a picture", so the outer one has to win — counting the pair
  // twice would leave a gap in the message where one waits on the other.
  const link = shapes.make("A", ["cmsg-image"]);
  const image = shapes.make("IMG", [], ["data-attachment"]);
  shapes.nest(block, link, image);
  assert.equal(shapes.revealWholeOf(link, block), link);
  assert.equal(shapes.revealWholeOf(image, block), link);
  assert.equal(shapes.revealIsMedia(link), true);

  // An interface picture — a face, a vendor mark — is not part of what was
  // said, and is left alone.
  const avatar = shapes.make("IMG", ["avatar"]);
  shapes.nest(block, avatar);
  assert.equal(shapes.revealWholeOf(avatar, block), null);

  // It takes its place among the words rather than being handled after them:
  // one walk, over the text and the elements together.
  const words = app.slice(app.indexOf("function revealWords(block, elapsed)"));
  assert.match(words, /NodeFilter\.SHOW_TEXT \| NodeFilter\.SHOW_ELEMENT/u);
  assert.match(words, /revealIsMedia\(part\) \? "text-reveal-media"/u);
  assert.match(words, /revealStaggerFor\(words\.length\)/u);

  // And it settles exactly the way a word does, minus the `display` a word
  // needs: the picture's own block is what reserves its box.
  const css = await publicFile("styles.css");
  const media = /\n\.text-reveal-media \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(media, undefined, "a picture should have its own rule");
  assert.match(media ?? "", /animation: text-reveal-in 460ms/u);
  assert.match(media ?? "", /animation-delay: var\(--reveal-delay, 0ms\);/u);
  assert.doesNotMatch(media ?? "", /display:/u);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,200}\.text-reveal-media \{\n {4}animation: none;/u,
    "a picture should simply be there when motion is unwanted",
  );
});

test("an image-only message still animates in", async () => {
  const app = await publicFile("app.js");
  const words = app.slice(app.indexOf("function revealWords(block, elapsed)"));
  // Nothing here is conditional on there being any prose: an element takes a
  // place in the schedule on its own, so a message that is one picture and no
  // words arrives instead of being the one thing that snaps into the room.
  const collect = words.slice(0, words.indexOf("const revealedPings"));
  assert.match(collect, /if \(node instanceof Element\) \{/u);
  assert.match(collect, /parts\.push\(node\)/u);
  assert.match(words, /part instanceof Element[\s\S]{0,400}words\.push\(part\)/u);
});

test("a mixed text and image message reveals in reading order", async () => {
  const app = await publicFile("app.js");
  const words = app.slice(app.indexOf("function revealWords(block, elapsed)"));
  // One tree walk collects both, so the order in `parts` is the order on
  // screen and a picture between two paragraphs arrives between them.
  assert.equal(
    (words.match(/document\.createTreeWalker/gu) ?? []).length,
    1,
    "one pass, so nothing is scheduled out of order",
  );
  // Past the cap the remaining prose is left as plain text, but the pass
  // keeps going: a picture at the end of a long message still gets its slot.
  assert.match(words, /if \(words\.length >= REVEAL_MAX_WORDS\) \{\n {6}continue;/u);
  assert.doesNotMatch(
    words.slice(0, words.indexOf("const step = revealStaggerFor")),
    /\bbreak;/u,
    "nothing should stop the pass early",
  );
});

test("every part of a message arrives, not just its first block", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const shapes = revealShapes(app);
  const block = shapes.make("DIV", ["cmsg-text"]);

  // A span of code inside a sentence is part of the sentence. It is not read
  // word by word — splitting it would put a span through its spacing — so it
  // arrives whole, the way a posted ping does, rather than sitting there
  // finished while the words around it are still coming in.
  const code = shapes.make("CODE");
  shapes.nest(block, shapes.make("P"), code);
  assert.equal(shapes.revealWholeOf(code, block), code);
  assert.equal(shapes.revealIsMedia(code), false);

  // The paragraphs, lists and pictures of a message are one block with one
  // key on it, so the walk covers the message rather than its opening line.
  assert.match(chats, /function messageBody\(content, repositoryId, mentions\)/u);
  assert.match(
    chats,
    /images\.map\(\(image\) => attachmentImage\(base, image\)\)/u,
    "pictures should be part of the body, not drawn beside it",
  );
  assert.match(
    app.slice(app.indexOf("function revealWords(block, elapsed)")),
    /document\.createTreeWalker\(\n {4}block,/u,
    "the walk should be rooted at the whole block",
  );
});
