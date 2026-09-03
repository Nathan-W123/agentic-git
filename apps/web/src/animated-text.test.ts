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
/**
 * The dashboard shell, which is three files.
 *
 * `app.js` used to hold the router, the motion system and the accent colour
 * arithmetic together. Motion moved to `motion.js` and the colour maths to
 * `colour.js`; what these tests pin - that the behaviour is there and has
 * the shape it is meant to have - never cared which of the three a line sat
 * in, so asking for "app.js" here still means the whole shell.
 */
const SHELL_MODULES = ["app.js", "motion.js", "colour.js"];

async function publicFile(name: string): Promise<string> {
  const wanted = name === "app.js" ? SHELL_MODULES : [name];
  const parts = await Promise.all(
    wanted.map(async (file) =>
      readFile(path.join(defaultPublicDirectory(), file), "utf8"),
    ),
  );
  if (name !== "app.js") {
    return parts.join("\n");
  }
  // Only the shell, and only because several tests below slice a function out
  // of it and run it: `export` is a syntax error outside a module, and the
  // shell's own functions carry it now that two of its three files are
  // imported rather than inlined.
  return parts.join("\n").replaceAll(/^export /gmu, "");
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
      app.indexOf("function playTextReveal(root)"),
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

test("live status copy is still, because the dots beside it are not", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  // "Zeus is thinking" is one thing happening, so it is said once. The dots
  // are the motion; the words used to travel as well, which was the same fact
  // announced twice on one line in two different rhythms.
  assert.match(chats, /<span class="typing-who">/u);
  assert.doesNotMatch(chats, /text-sweep/u);
  assert.doesNotMatch(
    css,
    /\n\.text-sweep \{/u,
    "the second live-text treatment should be gone, not merely unused",
  );
  // The dots keep their own clock, and it is the only one on that row.
  const dots = /\n\.typing-dots i \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(dots ?? "", /animation: typing-bounce 1\.2s ease-in-out infinite;/u);
});

test("a message takes its place once, and the words in it own the fading", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // The shell is keyed the same way the words in it are: surface, then
  // message. A backlog being opened is a surface nobody was watching, and
  // neither half may animate for it — so the key comes from one function and
  // both halves call it. Two copies of a rule that must agree is how a thread
  // ends up throwing its replies up the screen while their words sit still.
  assert.match(
    chats,
    /function messageMotionKey\(entry, repositoryId, isReply\) \{[\s\S]*?`\$\{group\}\|msg-\$\{entry\.id\}`/u,
    "one function should name the arrival a message belongs to",
  );
  assert.match(
    chats,
    /data-entrance="\$\{esc\(messageMotionKey\(entry, repositoryId, isReply\)\)\}"/u,
  );
  assert.match(
    chats,
    /data-reveal="\$\{esc\(\n[\s\S]*?messageMotionKey\(entry, repositoryId, isReply\),\n {6}\)\}"/u,
    "the words take the key their shell takes",
  );
  assert.match(
    chats,
    /data-entrance="dm:\$\{esc\(userId\)\}\|msg-\$\{esc\(message\.id\)\}"/u,
  );

  const start = app.indexOf("function playMessageEntrance(root)");
  assert.notEqual(start, -1, "the render loop should place arriving messages");
  const body = app.slice(start, app.indexOf("\n}\n", start));
  // The same three decisions the words go through: only a surface already on
  // screen, remembered so a redraw does not replay it, and resumed rather
  // than restarted when a redraw lands mid-arrival.
  assert.match(body, /entranceGroups\.has\(group\)/u);
  assert.match(body, /entranceSeen\.set\(key, arriving \? now : 0\)/u);
  assert.match(body, /started === 0 \|\| quiet/u);
  assert.match(body, /const elapsed = now - started;/u);
  assert.match(body, /elapsed < ENTRANCE_MS/u);

  // Position only. The word reveal owns opacity, and a parent fading over a
  // hundred fading words is the same message arriving twice.
  const shell = /\n\.msg-entering \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(shell ?? "", /animation: message-enter var\(--motion-content\) var\(--ease-motion\);/u);
  assert.match(shell ?? "", /animation-delay: var\(--entrance-delay, 0ms\);/u);
  const frames = /@keyframes message-enter \{([\s\S]*?)\n\}\n/u.exec(css)?.[1];
  assert.match(frames ?? "", /transform: translateY\(6px\);/u);
  assert.doesNotMatch(
    frames ?? "",
    /opacity/u,
    "the shell moves; it does not fade, because its words already do",
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.msg-entering,\n {2}\.cmsg-final\.msg-entering \{\n {4}animation: none;/u,
  );
});

test("the artifact at the end of a run is the one message given weight", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  assert.match(chats, /entry\.kind === "outcome" \? " cmsg-final" : ""/u);
  const final = /\n\.cmsg-final\.msg-entering \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(final ?? "", /animation: message-enter-final var\(--motion-emphasis\)/u);
  const frames = /@keyframes message-enter-final \{([\s\S]*?)\n\}\n/u.exec(css)?.[1];
  assert.match(frames ?? "", /transform: translateY\(5px\) scale\(0\.98\);/u);
  // Reserved: an ordinary remark, a progress line and a system notice all
  // take the plain content entrance. If everything is emphasised, nothing is.
  assert.equal(
    (chats.match(/" cmsg-final"/gu) ?? []).length,
    1,
    "only one kind of message should claim the emphasis",
  );
});

test("a word settles from faint and low, and holds still under reduced motion", async () => {
  const css = await publicFile("styles.css");
  const word = /\n\.text-reveal-word \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(word, undefined, "a word should have its own rule");
  assert.match(word ?? "", /display: inline-block;/u);
  assert.match(word ?? "", /animation: text-reveal-in/u);
  assert.match(word ?? "", /animation-delay: var\(--reveal-delay, 0ms\);/u);

  const frames = /@keyframes text-reveal-in \{([\s\S]*?)\n\}\n/u.exec(css)?.[1];
  assert.match(frames ?? "", /opacity: 0;/u);
  assert.match(frames ?? "", /transform: translateY\(2px\);/u);
  // Opacity and transform are the two things a browser can animate without
  // touching the glyphs. A filter is not: blurring a word forces it to be
  // redrawn every frame, and a long message has a hundred of them going at
  // once, which is both the cost and the mushiness this leaves behind.
  assert.doesNotMatch(frames ?? "", /filter:/u);

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
    )}\nreturn { revealStaggerFor, REVEAL_STAGGER_MS, REVEAL_MAX_TOTAL_MS, REVEAL_WORD_MS };`,
  )() as {
    revealStaggerFor: (count: number) => number;
    REVEAL_STAGGER_MS: number;
    REVEAL_MAX_TOTAL_MS: number;
    REVEAL_WORD_MS: number;
  };
  const spread = (count: number): number =>
    (count - 1) * pace.revealStaggerFor(count);
  // What the reader actually waits through: the last word starts at the end
  // of the spread and still has its own settle to play.
  const whole = (count: number): number => spread(count) + pace.REVEAL_WORD_MS;

  // A lone word has nothing to wait for.
  assert.equal(spread(1), 0);

  // A short line is as near to nothing as it can be while still reading as
  // words arriving: the handful of words are a fraction of a beat apart and
  // the whole thing is done before it can be studied.
  assert.equal(pace.revealStaggerFor(4) <= pace.REVEAL_STAGGER_MS, true);
  assert.equal(spread(4) < 60, true, "a few words should be over at once");
  assert.equal(
    whole(24) < 450,
    true,
    "a short-to-middling message should be finished in a glance",
  );

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
    assert.equal(
      whole(count) < 700,
      true,
      "even the longest answer should be there in well under a second",
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
  assert.match(
    media ?? "",
    /animation: text-reveal-in var\(--motion-content\) var\(--ease-motion\) both;/u,
  );
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
