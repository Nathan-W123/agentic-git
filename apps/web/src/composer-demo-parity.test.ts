import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The live message bars, held against the demo they are the product shot for.
 *
 * KUMI.WEBSITE draws two composers: `.shot-composer`, the room's bar — a 48px
 * pill with a bare plus, the line, and a bare arrow, laid out as `0 14px` with
 * a 12px gap — and `.th-composer`, the thread's, which is shorter, squarer and
 * carries no icons at all. The dashboard follows that compact shape but keeps
 * its attachment plus visible: hiding it until focus changes the text inset
 * under a person's caret. Its glyphs had also drifted into 26-30px buttons
 * with borders and hover fills, the row was padded `0 11px 10px` at a 5px gap,
 * the pill was 50px, and the thread reused the room's composer wholesale.
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
  // box around it is a smudge the size of the icon.
  const hover = /\n\.composer-bar \.composer-plus:hover \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(hover ?? "", /background: none;/u);
  assert.doesNotMatch(hover ?? "", /var\(--bg-hover\)/u);
  assert.match(
    css,
    /\.send-btn:hover:not\(:disabled\) \{[\s\S]{0,120}background: none;/u,
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

  // A finger still needs something to hit, so the phone tier puts the box
  // back — on the arrow as well, which is pressed on every message.
  assert.match(
    css,
    /@media \(max-width: 600px\) \{[\s\S]*?\.composer-bar \.icon-btn,\s*\n\s*\.send-btn \{\s*width: 34px;\s*height: 34px;/u,
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
  // and the reserve cannot be changed in one place and missed in another.
  assert.match(
    css,
    /\.composer:has\(\.composer-field\):not\(\.is-multiline\) \{\s*position: relative;\s*min-height: var\(--composer-rest-height\);/u,
  );
  assert.match(
    css,
    /\.composer:has\(\.composer-field\):not\(\.is-multiline\) \.composer-field \{\s*min-height: var\(--composer-rest-height\);/u,
  );
  assert.match(
    css,
    /\.composer:has\(\.composer-field\):not\(\.is-multiline\) \.composer-field textarea,\s*\n\.composer:has\(\.composer-field\):not\(\.is-multiline\) \.composer-mirror \{\s*min-height: var\(--composer-rest-height\);\s*padding-left: var\(--composer-side-reserve\);\s*padding-right: var\(--composer-side-reserve\);/u,
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

  // The card itself is untouched — same fill, edge, shadow and radius.
  assert.match(shape ?? "", /background: var\(--surface-3\);/u);
  assert.match(shape ?? "", /border: 1px solid var\(--border-soft\);/u);
  assert.match(shape ?? "", /box-shadow: var\(--shadow-card\);/u);
  assert.match(shape ?? "", /--composer-shape: var\(--radius-lg\);/u);
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

  // Shorter and squarer than the room's pill, with the vertical padding
  // brought down to fit 40px — set on the textarea and the mirror together,
  // since they are one string drawn twice.
  const lite = /\n\.thread-composer-wrap \.composer\.composer-lite \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(lite, undefined, "the thread box has a variant of its own");
  assert.match(lite ?? "", /--composer-rest-height: 40px;/u);
  assert.match(lite ?? "", /--composer-shape: var\(--radius\);/u);
  assert.match(lite ?? "", /--composer-side-reserve: 41px;/u);
  assert.match(lite ?? "", /--composer-pad-top: 9px;/u);
  assert.match(lite ?? "", /--composer-pad-bottom: 9px;/u);
  assert.match(
    css,
    /\.composer-field textarea,\s*\.composer-mirror \{\s*padding: var\(--composer-pad-top\) var\(--composer-pad-x\) var\(--composer-pad-bottom\);/u,
  );

  // The leading control is present before focus and the text always reserves
  // its space. A resting-state override used to hide the whole bar and cut
  // the reserve to 12px; focusing then inserted the plus under the caret and
  // moved the person's expected typing position.
  assert.doesNotMatch(
    css,
    /\.thread-composer-wrap \.composer\.composer-lite:not\(\.is-expanded\):not\(:focus-within\):has\(textarea:placeholder-shown\) \{\s*--composer-side-reserve: 12px;/u,
  );
  assert.doesNotMatch(
    css,
    /:not\(\.is-expanded\):not\(:focus-within\):has\(textarea:placeholder-shown\)\s*\n?\s*\.composer-bar \{\s*visibility: hidden;/u,
  );

  // The attachment affordance and the rest of the row remain in the markup.
  assert.match(panel, /iconButton\("plus", \{\s*act: "thread-attach"/u);
  assert.match(panel, /data-act="channel-thread-attach-input"/u);
  assert.match(panel, /<button class="send-btn" type="submit"/u);
});
