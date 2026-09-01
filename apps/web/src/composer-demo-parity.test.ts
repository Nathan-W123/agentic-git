import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The live message bars, held against the demo they are the product shot for.
 *
 * KUMI.WEBSITE draws two composers, and the point of them is that they are
 * not the same component twice. The room's bar is a 48px pill on a 14px
 * corner, laid out `0 14px` at a 12px gap, carrying a bare plus and a bare
 * arrow and lifted off the page by a soft shadow. The thread's is 40px on a
 * 10px corner, 12px in from its own edges, flat, and at rest it is nothing
 * but the words — no plus, no arrow, no shadow, no second surface. That
 * difference is the hierarchy: the side conversation has to read as lighter
 * than the room, and it does not if both boxes are the same height, the same
 * radius, the same type and the same permanently-armed row of controls.
 *
 * Asserted against the source, the way the rest of this browser surface is:
 * the dashboard ships as plain ES modules with no bundler, and the test run
 * has no DOM to measure.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("composer icon buttons are bare 17px glyphs with no button chrome", async () => {
  const css = await publicFile("styles.css");

  // The "+" and every other `.icon-btn` on the row lose the box: no width or
  // height of their own, no border, no radius, no fill — the button is the
  // glyph. `.icon-btn` on its own still carries all of that, everywhere else.
  const plus = /\n\.composer-bar \.composer-plus \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(plus, undefined, "the + still has a rule of its own");
  for (const declaration of [
    /width: auto;/u,
    /height: auto;/u,
    /border: 0;/u,
    /border-radius: 0;/u,
    /background: none;/u,
  ]) {
    assert.match(plus ?? "", declaration);
  }

  const iconButton = /\n\.composer-bar \.icon-btn \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(iconButton, undefined, "the row's icon buttons have a rule");
  assert.match(iconButton ?? "", /width: auto;/u);
  assert.match(iconButton ?? "", /height: auto;/u);
  assert.match(iconButton ?? "", /border: 0;/u);
  assert.doesNotMatch(iconButton ?? "", /width: 26px|height: 26px/u);

  // Hovering paints colour and nothing else. A fill behind a glyph with no
  // box around it is a smudge the size of the icon — and the same is true of
  // a press, which is answered by the scale in `playComposerPress` instead.
  const hover = /\n\.composer-bar \.composer-plus:hover \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(hover ?? "", /background: none;/u);
  assert.doesNotMatch(hover ?? "", /var\(--bg-hover\)/u);
  assert.match(
    css,
    /\.send-btn:hover:not\(:disabled\) \{[\s\S]{0,120}background: none;/u,
  );
  assert.match(
    css,
    /\.composer-bar \.icon-btn:active,\s*\n\.composer-bar \.composer-plus:active,\s*\n\.composer-bar \.send-btn:active \{\s*background: none;/u,
  );

  // 17px, the demo's measure, for the plus and the arrow alike.
  assert.match(
    css,
    /\.composer-bar \.icon-btn svg,\s*\n\.composer-bar \.composer-plus svg \{\s*width: 17px;\s*height: 17px;/u,
  );
  assert.match(css, /\.send-btn svg \{\s*width: 17px;\s*height: 17px;/u);

  // The send arrow is a glyph too, so its 32px square goes with the rest.
  const send = /\n\.send-btn \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(send ?? "", /width: auto;/u);
  assert.match(send ?? "", /height: auto;/u);

  // A 17px mark is a small thing to hit with a mouse, so what a press lands
  // on is a 32px square drawn around it rather than a 32px button: sizing the
  // button would push every glyph off the pill's own 14px edge and take the
  // same width back out of the line beside it.
  assert.match(
    css,
    /\.composer-bar \.icon-btn::after,\s*\n\.composer-bar \.composer-plus::after,\s*\n\.composer-bar \.send-btn::after \{[\s\S]{0,220}width: var\(--composer-hit, 32px\);\s*height: var\(--composer-hit, 32px\);/u,
  );

  // A finger needs 44, and it is that same square that grows — not the box,
  // which stayed off so the phone row is still the row the demo draws.
  const phone = css.slice(
    css.indexOf("@media (max-width: 600px) {", css.indexOf(".chan-composer-wrap {")),
  );
  assert.match(
    css,
    /@media \(max-width: 600px\) \{[\s\S]*?\.composer-bar \.icon-btn,\s*\n\s*\.composer-bar \.composer-plus,\s*\n\s*\.composer-bar \.send-btn \{\s*width: auto;\s*height: auto;\s*\}\s*\n\s*\.composer \{\s*--composer-hit: 44px;/u,
  );
  assert.doesNotMatch(
    phone,
    /\.composer-bar \.icon-btn,\s*\n\s*\.send-btn \{\s*width: 34px;/u,
    "a 34px target is under the floor a thumb needs",
  );

  // Nothing here reached outside the composer: the shared control keeps its
  // own box, and the context dial keeps the optical size it is measured at.
  assert.match(
    css,
    /\n\.icon-btn \{[\s\S]{0,200}width: 30px;\s*height: 30px;[\s\S]{0,200}border-radius: 8px;/u,
  );
  assert.match(css, /\.ctx svg \{\s*width: 15px;\s*height: 15px;/u);
});

test("the channel composer rests as a 48px pill with a 0 14px, gap 12px row", async () => {
  const css = await publicFile("styles.css");
  const chats = await publicFile("screen-chats.js");

  // The demo's pill height and the room its two glyphs take out of the line
  // beside them, both named once so the thread's shorter box can restate them.
  const shape = /\n\.composer \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(shape ?? "", /--composer-rest-height: 48px;/u);
  assert.match(shape ?? "", /--composer-side-reserve: 43px;/u);
  const compact = css.slice(
    css.indexOf(".composer:has(.composer-field):not(.is-multiline) {"),
    css.indexOf("\n.composer:focus-within {"),
  );
  assert.notEqual(compact, "", "the resting-row rules are still a block of their own");
  assert.doesNotMatch(compact, /min-height: 50px;/u, "the pill was 50px and is now 48");
  assert.doesNotMatch(compact, /54px/u, "the reserve was cut for buttons, not glyphs");

  // Every measure of the resting row reads those two variables, so the height
  // and the reserve cannot be changed in one place and missed in another. The
  // field inside gives up the box's own two border pixels, so 48 is what a
  // ruler held against the bar reads rather than what the field inside it is.
  assert.match(
    css,
    /\.composer:has\(\.composer-field\):not\(\.is-multiline\) \{\s*position: relative;\s*min-height: var\(--composer-rest-height\);/u,
  );
  assert.match(
    css,
    /\.composer:has\(\.composer-field\):not\(\.is-multiline\) \.composer-field \{\s*min-height: calc\(var\(--composer-rest-height\) - 2px\);/u,
  );
  assert.match(
    css,
    /\.composer:has\(\.composer-field\):not\(\.is-multiline\) \.composer-field textarea,\s*\n\.composer:has\(\.composer-field\):not\(\.is-multiline\) \.composer-mirror \{\s*min-height: calc\(var\(--composer-rest-height\) - 2px\);\s*padding-left: var\(--composer-side-reserve\);\s*padding-right: var\(--composer-side-reserve\);/u,
  );

  // One row, one padding: the bar lies over the whole pill and takes the
  // `0 14px` from the shared rule rather than insetting itself a second time.
  const bar = /\n\.composer-bar \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(bar, undefined, "the utility row has a rule");
  assert.match(bar ?? "", /gap: 12px;/u);
  assert.match(bar ?? "", /padding: 0 14px;/u);
  assert.doesNotMatch(bar ?? "", /padding: 0 11px 10px;/u);
  const overlay = /\.composer:has\(\.composer-field\):not\(\.is-multiline\) \.composer-bar \{([\s\S]*?)\n\}/u.exec(
    css,
  )?.[1];
  assert.match(overlay ?? "", /inset: 0;/u);
  assert.doesNotMatch(overlay ?? "", /inset: 4px 8px;/u);
  assert.doesNotMatch(overlay ?? "", /padding: 0;/u);
  // Still a pass-through surface: the pill is typed into, and only its
  // controls take a press.
  assert.match(overlay ?? "", /pointer-events: none;/u);

  // The card itself: same warm fill and the same structural hairline, with
  // the shadow moved behind a variable so the thread can turn it off without
  // reaching for `box-shadow` a second time.
  assert.match(shape ?? "", /background: var\(--surface-3\);/u);
  assert.match(shape ?? "", /border: 1px solid var\(--border-soft\);/u);
  assert.match(shape ?? "", /box-shadow: var\(--composer-shadow\);/u);
  assert.match(shape ?? "", /--composer-shadow: var\(--shadow-card\);/u);
  assert.match(shape ?? "", /--composer-shape: var\(--radius-lg\);/u);
  // Only what changes on focus, and on the shared curve. `all` would animate
  // whatever a rule happens to set next year.
  assert.match(
    shape ?? "",
    /transition:\s*\n\s*border-color var\(--motion-pop\) var\(--ease-motion\),\s*\n\s*box-shadow var\(--motion-pop\) var\(--ease-motion\);/u,
  );

  // The room's own density, held on its wrapper so the private-agent and
  // direct-message boxes sharing the foundation are untouched: a 14px corner,
  // 13.5px words on a 14px edge, and one soft lift with a faint line along
  // its top. No gradient, no glass, no glow, no second outline.
  const room = /\n\.chan-composer-wrap \.composer \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(room, undefined, "the room's bar has a variant of its own");
  assert.match(room ?? "", /--composer-shape: 14px;/u);
  assert.match(room ?? "", /--composer-pad-x: 14px;/u);
  assert.match(room ?? "", /--composer-font-size: 13\.5px;/u);
  assert.match(room ?? "", /--composer-line-height: 21\.9px;/u);
  assert.match(
    room ?? "",
    /--composer-shadow:\s*\n?\s*inset 0 1px 0 rgb\(255 255 255 \/ 4%\), 0 18px 44px rgb\(0 0 0 \/ 34%\);/u,
  );
  for (const banned of [/gradient/u, /backdrop-filter/u, /outline:/u]) {
    assert.doesNotMatch(room ?? "", banned);
  }
  // 12px in from the pane it sits in, which is the wrapper's own margin.
  assert.match(css, /\n\.chan-composer-wrap \{[\s\S]{0,120}margin: 0 12px 12px;/u);

  // The right-hand glyph is the icon set's paper plane — not a second
  // drawing of one, and not the arrow that doubles as "next" — and the
  // placeholder names the channel the way everything else does.
  const room_markup = chats.slice(
    chats.indexOf("function composer(repositoryId)"),
    chats.indexOf("/**\n * The edge you drag"),
  );
  assert.match(room_markup, /`Message \$\{subChannelLabel\(/u);
  assert.doesNotMatch(room_markup, /Message Main chat/u);
  assert.match(room_markup, /<button class="send-btn" type="submit"[\s\S]{0,120}icon\("send"\)/u);
  assert.doesNotMatch(room_markup, /icon\("arrowRight"\)/u);
});

test("the private-agent and DM composers keep the full toolbar layout", async () => {
  const chats = await publicFile("screen-chats.js");
  const chat = await publicFile("chat.js");
  const css = await publicFile("styles.css");

  // The compact single-row pill is keyed off `.composer-field`, which only the
  // two mirrored composers have. Neither private box grows one, so both keep
  // the field above and the toolbar below it — where their selects live.
  const dmAt = chats.indexOf('data-act="dm-submit"');
  assert.notEqual(dmAt, -1, "the direct-message composer is still rendered");
  const dm = chats.slice(dmAt, chats.indexOf("</form>", dmAt));
  assert.doesNotMatch(dm, /composer-field/u);
  assert.doesNotMatch(chat, /composer-field/u);

  // And neither opts into the thread's lighter shape.
  assert.doesNotMatch(chat, /composer-lite/u);
  assert.doesNotMatch(dm, /composer-lite/u);

  // They share the thread's wrapper, so the lighter shape has to be scoped
  // past it — a rule on the wrapper alone would catch all three.
  assert.match(css, /\.thread-composer-wrap \.composer\.composer-lite \{/u);
  assert.match(chat, /class="thread-composer-wrap chat-composer-wrap"/u);
  assert.match(chats, /class="thread-composer-wrap dm-composer-wrap/u);

  // Their text metrics are the ones the shared block declares, which this
  // change left where they were: the density variants are the two rooms'.
  const shape = /\n\.composer \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(shape ?? "", /--composer-font-size: 14px;/u);
  assert.match(shape ?? "", /--composer-pad-x: 16px;/u);
  assert.match(shape ?? "", /--composer-max-height: 164px;/u);
  // And their send button is still the one their own code enables — the
  // helper that arms the room's arrow leaves anything without a mirror alone.
  const chats_sync = chats.slice(chats.indexOf("export function syncComposerControls("));
  assert.match(chats_sync, /const field = composer\?\.querySelector\?\.\("\.composer-field"\)/u);
});

test("the thread composer uses its own shorter 40px composer-lite variant with a persistent plus", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // The class is on the thread's form, and only on it.
  const panel = chats.slice(chats.indexOf("function threadPanel("));
  assert.match(
    panel,
    /<form class="composer composer-lite\$\{threadPending \? " is-expanded" : ""\}" data-act="channel-thread-submit"/u,
  );
  assert.equal(
    (chats.match(/class="composer composer-lite/gu) ?? []).length,
    1,
    "the thread's form is the only one that opts in",
  );

  // Shorter, squarer, tighter and quieter than the room's pill, with the
  // vertical padding brought down to fit 40px — set on the textarea and the
  // mirror together, since they are one string drawn twice.
  const lite = /\n\.thread-composer-wrap \.composer\.composer-lite \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(lite, undefined, "the thread box has a variant of its own");
  assert.match(lite ?? "", /--composer-rest-height: 40px;/u);
  assert.match(lite ?? "", /--composer-shape: var\(--radius\);/u);
  assert.match(lite ?? "", /--composer-side-reserve: 41px;/u);
  assert.match(lite ?? "", /--composer-pad-x: 12px;/u);
  assert.match(lite ?? "", /--composer-font-size: 12\.5px;/u);
  assert.match(lite ?? "", /--composer-line-height: 20\.25px;/u);
  // A tighter ceiling than the room's 164: five lines in a column this narrow
  // is a message that belongs in the room.
  assert.match(lite ?? "", /--composer-max-height: 120px;/u);
  assert.match(
    css,
    /\.composer-field textarea,\s*\.composer-mirror \{\s*padding: var\(--composer-pad-top\) var\(--composer-pad-x\) var\(--composer-pad-bottom\);/u,
  );
  // Flat. The card shadow is a third line inside an already-bordered panel.
  assert.match(css, /\n\.thread-composer-wrap \.composer \{[\s\S]{0,140}--composer-shadow: none;/u);
  // Its own 12px edge, not the room's 14.
  assert.match(
    css,
    /\.thread-composer-wrap \.composer\.composer-lite \.composer-bar \{\s*padding: 0 12px;/u,
  );

  // At rest — empty, unfocused, nothing staged — the box is the words and
  // nothing else, which is the demo's resting thread bar. Focus brings the
  // row back and takes the reserve on both sides with it, so the arrival of
  // the arrow on the first character never moves the caret a second time.
  assert.match(
    css,
    /\.thread-composer-wrap \.composer\.composer-lite:not\(\.is-expanded\):not\(:focus-within\):has\(textarea:placeholder-shown\) \{\s*--composer-side-reserve: 12px;/u,
  );
  assert.match(
    css,
    /:not\(\.is-expanded\):not\(:focus-within\):has\(textarea:placeholder-shown\)\s*\n\s*\.composer-bar \{\s*visibility: hidden;/u,
  );
  assert.match(
    css,
    /:not\(\.is-expanded\):has\(textarea:placeholder-shown\)\s*\n\s*\.send-btn \{\s*visibility: hidden;/u,
  );

  // Persistent in the markup, which is the part that mattered: the plus is
  // never inserted on focus and never taken out again, so nothing is ever
  // built underneath somebody's caret — it is revealed and hidden in place,
  // and it stays reachable from the keyboard because focusing the box is what
  // brings it back before the tab that lands on it.
  assert.match(panel, /iconButton\("plus", \{\s*act: "thread-attach"/u);
  assert.match(panel, /data-act="channel-thread-attach-input"/u);
  assert.match(panel, /<button class="send-btn" type="submit"/u);
  assert.match(panel, /placeholder="Add to this thread\.\.\."/u);
  assert.doesNotMatch(panel, /placeholder="Reply in thread\.\.\."/u);
});
