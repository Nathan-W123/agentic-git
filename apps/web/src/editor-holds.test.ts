/**
 * The editor's side of a hold: taken on the first keystroke, drawn where it
 * is, and refused with a way through.
 *
 * The three things that make this either useful or hostile, and all three are
 * easy to get backwards. A hold taken on *open* locks a file somebody only
 * wanted to read. A repaint that renders the screen throws away the textarea
 * and the caret on every key. A refusal with no way past it sends the work to
 * a terminal where nothing can see it at all.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("reading a file takes nothing; the first keystroke takes the hold", async () => {
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");

  // Opening asks who is here and holds nothing. A dozen files opened to look
  // at them must not be a dozen locked files.
  const open = app.slice(app.indexOf('case "chan-file-open":'));
  const opened = open.slice(0, open.indexOf("case ", 10));
  assert.match(opened, /loadFileHolds\(value, render\)/u);
  assert.doesNotMatch(opened, /holdChannelFile/u);

  // The keystroke handler is where it is taken, and that handler deliberately
  // does not render — a source file rebuilt on every key would throw away the
  // textarea and the caret with it. So the repaint is the narrow one.
  const typed = app.slice(app.indexOf('if (act === "chan-file-edit")'));
  const keystroke = typed.slice(0, typed.indexOf("\n  }"));
  assert.match(keystroke, /holdChannelFile\(state\.chanFileView, paintFileHolders\)/u);
  assert.doesNotMatch(keystroke, /holdChannelFile\([^)]*render\)/u);

  // And the client is idempotent, so every keystroke after the first costs
  // nothing.
  const held = data.slice(data.indexOf("export async function holdChannelFile"));
  assert.match(
    held.slice(0, held.indexOf("\n}")),
    /state\.chanFileHeld === path\)\s*\{\s*\n\s*return;/u,
  );
});

test("a hold is renewed on the server's schedule and given back on close", async () => {
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");

  // The interval comes from the answer, not from a number the browser picked.
  // Two sides guessing separately is how a hold lapses under a live editor.
  assert.match(data, /Number\(answer\.renewAfterMs\)/u);
  // A renewal that cannot reach the control plane lets it lapse rather than
  // pretending: a lock nobody can release is worse than no lock.
  const renewing = data.slice(data.indexOf("const renew = async () => {"));
  assert.match(
    renewing.slice(0, renewing.indexOf("\n  };")),
    /catch \{[\s\S]*?state\.chanFileHeld = undefined;/u,
  );

  for (const act of ['case "chan-file-close":', 'case "chan-file-back":']) {
    const closing = app.slice(app.indexOf(act));
    assert.match(
      closing.slice(0, closing.indexOf("return;")),
      /releaseChannelFile\(\)/u,
      act,
    );
  }
});

test("somebody else's lines are drawn where they are, and named once", async () => {
  const chats = await publicFile("screen-chats.js");
  const styles = await publicFile("styles.css");

  // A textarea has one colour for all of its text, so the blocks are a layer
  // underneath positioned in pixels. Line height is measured rather than
  // assumed: it comes from a rem and a unitless multiplier, and the only
  // honest source is what the browser computed.
  const paint = chats.slice(
    chats.indexOf("export function paintFileHolds"),
    chats.indexOf("export function paintFileHolds") + 2400,
  );
  assert.match(paint, /getComputedStyle\(editor\)/u);
  assert.match(paint, /Number\.parseFloat\(style\.lineHeight\)/u);
  assert.match(paint, /\(start - 1\) \* lineHeight/u);
  assert.match(paint, /\(end - start\) \* lineHeight/u);
  // A hold with no ranges is the whole file, and drawing nothing for it would
  // be the strongest statement this layer can make going unmade.
  assert.match(paint, /hold\.ranges\.length === 0/u);
  // Scrolls with the text, and the listener is assigned rather than added, so
  // a repaint per render cannot pile them up on the one surviving element.
  assert.match(paint, /editor\.onscroll = \(\) =>/u);

  // Named above the file as well. A colour with nobody attached is a thing to
  // wonder about; it is also the only way to see a hold over a whole file
  // that has no block worth hovering.
  assert.match(chats, /function fileHoldBanner\(/u);
  assert.match(chats, /agentLabelOf\(hold\.principalId\)/u);
  assert.match(chats, /memberName\(hold\.principalId\)/u);

  for (const rule of [
    /\.fp-hold-layer \{/u,
    /\.fp-hold \{/u,
    /\.fp-holder \{/u,
    /\.fp-holder-0 \{/u,
  ]) {
    assert.match(styles, rule);
  }
  // The layer must never take a click or a caret from the textarea over it.
  const layer = styles.slice(styles.indexOf(".fp-hold-layer {"));
  assert.match(layer.slice(0, layer.indexOf("}")), /pointer-events: none/u);
});

test("a refused save names who is in the way and offers a way through", async () => {
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");

  // The refusal is an answer, not an error: it carries the holders, so the
  // editor names somebody the reader has already seen rather than printing a
  // sentence out of nowhere.
  assert.match(data, /error\.code === "file_held"/u);
  assert.match(data, /state\.chanFileHolds = error\.details\?\.holds/u);
  assert.match(data, /error\.details = data\?\.error;/u);

  // Two ways out, and one of them is through. A hard refusal relocates the
  // problem — the terminal and a local clone are both one step away, and work
  // done there is invisible rather than merely contended.
  assert.match(chats, /data-act="chan-file-override"/u);
  assert.match(chats, /data-act="chan-file-blocked-dismiss"/u);
  assert.match(chats, /Save anyway/u);
  const override = app.slice(app.indexOf('case "chan-file-override":'));
  assert.match(
    override.slice(0, override.indexOf("return;")),
    /saveChannelFile\(render, true\)/u,
  );
  // And the override is sent as one, so the server can record it.
  assert.match(data, /\.\.\.\(override \? \{ override: true \} : \{\}\)/u);
});
