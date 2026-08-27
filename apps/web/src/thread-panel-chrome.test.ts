import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/*
 * The chrome an open thread is wrapped in.
 *
 * Not what a thread says — that is covered where the renderers are — but the
 * frame around it: where the panel starts, how tall its header is, and how
 * many horizontal lines a reader has to get past before the first message.
 * All three had drifted into a panel that competed with the channel it was
 * opened from, and each of them is one number in one place, so each is worth
 * pinning to the number rather than to "looks about right".
 *
 * Nothing here reads a glyph's own attributes. The shared icon set is being
 * swapped underneath these panels, and a test that asserted the stroke or the
 * source of the pin would fail on a change that has nothing to do with the
 * header's shape. What is asserted is geometry and order: how big the boxes
 * are, and which one comes after which.
 */

async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

/** One CSS rule's declarations, by its exact selector. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\n${escaped} \\{([\\s\\S]*?)\\n\\}`, "u").exec(css)?.[1] ?? "";
}

test("the thread panel opens under the channel header rather than beside it", async () => {
  const css = await publicFile("styles.css");
  const chats = await publicFile("screen-chats.js");

  // The banner belongs to the shell, not to the conversation column. Inside
  // the column it was column-width: opening a thread narrowed the column, so
  // the channel's name and its actions were dragged leftward by a panel that
  // has nothing to do with them, and the panel's own header came up level with
  // the channel's — two titles and two hairlines across one line, each naming
  // something different.
  const shell = chats.slice(
    chats.indexOf('<div class="chats-shell${'),
    chats.indexOf("${rightPanels(repositoryId)}"),
  );
  assert.notEqual(shell, "", "the chats shell markup is still there");
  assert.ok(
    shell.indexOf("${chanHeader(repositoryId)}") <
      shell.indexOf('<div class="chan-main">'),
    "the banner is drawn by the shell, ahead of the conversation column",
  );
  assert.doesNotMatch(
    shell.slice(shell.indexOf('<div class="chan-main">')),
    /chanHeader\(/u,
    "and no longer from inside the conversation column",
  );

  // One number seats everything: the banner is that tall, and the shell keeps
  // exactly that much room clear above its children — plus the gutter it
  // already has on every other edge. Nothing else may tell either of them what
  // the number turned out to be.
  const shellRule = rule(css, ".chats-shell");
  assert.match(
    shellRule,
    /--chan-head-h: calc\(56px \+ var\(--safe-top\)\);/u,
    "the shell should publish how tall the channel banner is",
  );
  assert.match(
    shellRule,
    /padding-top: calc\(var\(--chan-head-h\) \+ 8px\);/u,
    "and pay that height back, because the banner is out of its flow",
  );

  // Pinned across the top of the shell — over the rail and every open panel,
  // not merely over the transcript — and exactly as tall as it was paid for.
  const banner = rule(css, ".chan-head");
  assert.match(banner, /position: absolute;/u);
  assert.match(banner, /top: 0;/u);
  assert.match(banner, /left: 0;/u);
  assert.match(banner, /right: 0;/u);
  assert.match(
    banner,
    /height: var\(--chan-head-h, auto\);/u,
    "the banner should be exactly the height the shell published",
  );
  assert.doesNotMatch(
    banner,
    /min-height:/u,
    "a bar the shell has already reserved room for cannot be free to grow",
  );
  // The row is the height it is told to be. Vertical padding on top of that is
  // what made the old header 68px tall with a band of dead space above the
  // name, and the safe-area top-up further down the file used to add its own.
  assert.match(banner, /padding: var\(--safe-top\) 18px 0;/u);
  assert.doesNotMatch(banner, /padding: 13px/u, "the tall banner should be gone");
  const safeAreasAt = css.indexOf("------- safe areas ----");
  assert.notEqual(safeAreasAt, -1, "the safe-area section is still there");
  assert.doesNotMatch(
    css.slice(safeAreasAt),
    /\n\.chan-head \{/u,
    "the banner pays the status-bar inset inside its own height",
  );

  // And nothing compensates for it any more. Every panel is a child of the
  // shell, so the shell's own padding already starts it below the banner; a
  // margin as well would have pushed it a second bar's worth down the screen.
  assert.doesNotMatch(
    css,
    /margin-top: var\(--chan-head-h/u,
    "panels are seated by the shell's padding, not by a margin of their own",
  );
  assert.doesNotMatch(
    rule(css, ".thread-panel"),
    /margin-top:/u,
    "the panel does not place itself vertically at all",
  );
});

test("the thread header is one compact row of tools", async () => {
  const css = await publicFile("styles.css");
  const chats = await publicFile("screen-chats.js");

  // Short, and a fixed height rather than whatever its padding and its tallest
  // control happen to add up to.
  const shell = rule(css, ".chats-shell");
  assert.match(shell, /--thread-head-h: 38px;/u);
  const head = rule(css, ".thread-head");
  assert.match(head, /min-height: var\(--thread-head-h, 38px\);/u);
  assert.match(
    head,
    /padding: 0 8px 0 12px;/u,
    "no vertical padding: the row is the height it is told to be",
  );
  assert.doesNotMatch(head, /padding: 11px/u, "the tall header should be gone");

  // The tools are a cluster, not a spaced-out list — pin and reply read as one
  // pair of two, which is what the two-pixel row gap buys.
  assert.match(head, /gap: 2px;/u);
  const tools = rule(css, ".thread-head .icon-btn");
  assert.match(tools, /width: 26px;/u);
  assert.match(tools, /height: 26px;/u);
  assert.match(
    tools,
    /flex: none;/u,
    "a long title must not squeeze a tool below its own glyph",
  );

  // The label before the name and the close after the tools buy their own room
  // back, because two pixels is the space between glyphs and not the space
  // around a word or a rule.
  assert.match(rule(css, ".thread-head .panel-kind"), /margin-right: 6px;/u);
  const close = rule(css, ".thread-head .panel-close");
  assert.match(close, /margin-left: 14px;/u);
  assert.match(rule(css, ".thread-head .panel-close::before"), /left: -6px;/u);

  // A thumb cannot aim at 26px, and this row holds the panel's only close.
  const phone = /@media \(max-width: 600px\) \{[\s\S]*$/u.exec(css)?.[0] ?? "";
  assert.match(
    /\n {2}\.thread-head \.icon-btn \{([\s\S]*?)\n {2}\}/u.exec(phone)?.[1] ?? "",
    /width: 38px;/u,
    "the phone keeps its touch target",
  );

  // And the order the row is built in: the category, the name, then the tools
  // pushed right — pin, reply, and the close last, fenced off from them. Read
  // off the markup rather than off any glyph's own attributes, which are being
  // rewritten by the icon-set migration.
  const start = chats.indexOf('<aside class="thread-panel" data-thread-id=');
  const header = chats.slice(
    chats.indexOf('<header class="thread-head">', start),
    chats.indexOf("</header>", start),
  );
  assert.ok(header.length > 0, "the thread panel should have a header");
  const order = [
    'panelKind("Thread"',
    'class="thread-title"',
    'class="spacer"',
    'iconButton("pin"',
    'iconButton("reply"',
    'cls: "panel-close"',
  ].map((piece) => header.indexOf(piece));
  assert.ok(
    order.every((at) => at !== -1),
    "the header should still carry its label, name, pin, reply and close",
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    "the tools should sit after the name, with the close last",
  );
});

test("an open thread does not caption itself with a reply count", async () => {
  const css = await publicFile("styles.css");
  const chats = await publicFile("screen-chats.js");
  const rendererStart = chats.indexOf("function threadReplies");
  const renderer = chats.slice(
    rendererStart,
    chats.indexOf("\n/**\n * A plan, in the thread", rendererStart),
  );
  assert.ok(renderer.length > 0, "threadReplies should be readable");

  // "2 REPLIES" over the replies themselves, with a hairline fading off the
  // end of it. Both are gone: the replies are directly underneath and can be
  // counted by looking at them, and between that rule, the panel border and
  // the header's the panel was three lines deep before any of it was a
  // message.
  assert.doesNotMatch(renderer, /thread-replies-head/u);
  assert.doesNotMatch(
    css,
    /\.thread-replies-head/u,
    "the caption's styling should go with the caption",
  );
  assert.doesNotMatch(
    css,
    /linear-gradient\(90deg, var\(--border-soft\), transparent\)/u,
    "and so should the hairline that trailed off it",
  );

  // The count itself is not lost — it moves to where it is genuinely not
  // visible, as the section's accessible name.
  assert.match(
    renderer,
    /<section class="thread-replies" aria-label="\$\{esc\(\s*threadSaidCount\(said\.length\),\s*\)\}">/u,
    "the count should survive as the replies' accessible name",
  );
  assert.match(renderer, /class="thread-replies-flow"/u);

  // What replaced the caption is air: room above the replies for the root's
  // branch to reach into, and room between one message and the next.
  const flow = rule(css, ".thread-replies-flow");
  assert.match(flow, /padding-top: 10px;/u);
  assert.match(rule(css, ".thread-replies-flow > * + *"), /margin-top: 7px;/u);

  // The messages themselves are tighter than the room's, and only where they
  // are not part of a grouped run — a run stays as tight as the transcript
  // makes it, and its side padding is untouched because the compact rows
  // measure their own indent from it.
  const row = rule(css, ".thread-panel .cmsg-row:not(.cmsg-compact)");
  assert.match(row, /padding-top: 5px;/u);
  assert.match(row, /padding-bottom: 5px;/u);
  assert.doesNotMatch(row, /padding-left|padding-right|--cmsg-body-x/u);

  // And the reply box is one pill on the floor of the panel: rounder than
  // anything above it, edged in the solid border rather than the hairline, and
  // with no card shadow to add a soft third edge to a column that has just had
  // two hard ones taken out of it.
  const composer = rule(css, ".thread-composer-wrap .composer");
  assert.match(composer, /--composer-shape: 17px;/u);
  assert.match(composer, /border-color: var\(--border\);/u);
  assert.match(composer, /box-shadow: none;/u);
  // Its insets are the ones the picker and the staged attachments either side
  // of it are already indented to, so nothing here moves them apart.
  assert.doesNotMatch(composer, /margin/u);
});

test("a thread and the conversation beside it move as one thing", async () => {
  const css = await publicFile("styles.css");

  // The panel's width is what the transcript gives up, so growing into the
  // column is the reflow rather than something that happens a frame before
  // it. The first panel used only to translate, which meant the conversation
  // jumped to its narrow width in one frame and the panel then slid over the
  // gap that had already appeared.
  const entering = rule(css, ".thread-panel.panel-entering");
  assert.match(entering, /animation: panel-in var\(--motion-panel\) var\(--ease-motion\);/u);
  assert.match(entering, /min-width: 0;/u);
  assert.match(entering, /overflow: hidden;/u);
  assert.match(
    /@keyframes panel-in \{([\s\S]*?)\n\}\n/u.exec(css)?.[1] ?? "",
    /width: 0;/u,
  );

  // The header and the body follow a beat later — two children, not every
  // child. A panel whose every row and button arrives on its own clock is a
  // surface being assembled in front of the reader.
  const children = rule(
    css,
    ".thread-panel.panel-entering > .thread-head,\n.thread-panel.panel-entering > .thread-body",
  );
  assert.match(
    children,
    /animation: panel-content-in var\(--motion-content\) var\(--ease-motion\) 40ms\n {4}backwards;/u,
  );
  assert.match(
    /@keyframes panel-content-in \{([\s\S]*?)\n\}\n/u.exec(css)?.[1] ?? "",
    /transform: translateY\(4px\);/u,
  );

  // Out faster than in, and every exit in the app agrees about how fast.
  assert.match(
    rule(css, ".thread-panel.panel-leaving"),
    /animation: panel-out var\(--motion-panel-out\) var\(--ease-motion\) forwards;/u,
  );

  // Reduced motion resolves all of it, including the children, and takes the
  // exit to its last frame rather than turning it off — the exit is the only
  // reason the outgoing node is still in the document.
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\n {2}\.thread-panel\.panel-entering,[\s\S]*?\.thread-panel\.panel-entering > \.thread-body \{\n {4}animation: none;/u,
  );
  assert.match(
    css,
    /\.thread-panel\.panel-leaving \{\n {4}display: none;/u,
  );
});

test("dragging the panel edge is direct, and opening it is not replayed", async () => {
  const css = await publicFile("styles.css");
  const app = await publicFile("app.js");

  // A drag is direct manipulation: the edge belongs at the pixel the pointer
  // is at. Anything easing toward the dragged width arrives a whole duration
  // late, which reads as the panel being pulled on elastic.
  const dragging = rule(
    css,
    "body.resizing-panel .thread-panel,\nbody.resizing-panel .chan-main,\nbody.resizing-panel .chan-sidebar",
  );
  assert.match(dragging, /transition: none;/u);
  assert.match(dragging, /animation: none;/u);
  // Put on for the drag and taken off on release, by the same handler that
  // owns the pointer.
  assert.match(app, /document\.body\.classList\.add\("resizing-panel"\)/u);
  assert.match(app, /document\.body\.classList\.remove\("resizing-panel"\)/u);

  // The width itself lives on the document element, so a render arriving
  // mid-drag cannot lose it — and the panel is keyed, so a render arriving
  // mid-drag is not read as the panel opening again either.
  assert.match(app, /document\.documentElement\.style\.setProperty\("--panel-w"/u);
  assert.match(app, /key: \(node\) => node\.dataset\.panelKey \?\? "",/u);
});

test("closing a thread leaves the keyboard somewhere", async () => {
  const app = await publicFile("app.js");
  // The render replaces the button that was pressed, so focus fell to the
  // document body: Tab started again from the top of the page and a screen
  // reader was told nothing about where it now was. The source message is
  // both the trigger and the honest answer to "where was I".
  assert.match(app, /function focusThreadSource\(messageId\)/u);
  assert.match(
    app,
    /\[data-act="channel-thread-open"\]\[data-value="\$\{CSS\.escape\(String\(messageId\)\)\}"\]/u,
  );
  assert.match(app, /source\.focus\(\{ preventScroll: true \}\)/u);
  // And a fallback for a thread whose message has aged off the loaded page.
  assert.match(
    app,
    /function returnFocusFromThread\(messageId\) \{[\s\S]*?channel-input'\]"\)\?\.focus\(\{ preventScroll: true \}\)/u,
  );
  // Both ways out use it: the close button and Escape.
  assert.match(app, /putAwayRightPanel\(`thread:\$\{closing\}`\);[\s\S]*?returnFocusFromThread\(closing\)/u);
  assert.match(
    app,
    /if \(sidePanelOpen\(\) && closeSidePanel\(\)\) \{\n {4}render\(\);\n {4}if \(state\.activeChannelThread === undefined\) \{\n {6}returnFocusFromThread\(closing\);/u,
  );
});
