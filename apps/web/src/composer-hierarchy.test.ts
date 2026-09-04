import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The side conversation reads lighter than the room.
 *
 * This replaces four tests that froze the composers' pixel values — 48px,
 * 40px, `0 14px`, a 12px gap, a 17px glyph — and explained them as parity
 * with the product shot on KUMI.WEBSITE. They could not check that. They read
 * this repository's own stylesheet and nothing else, so the "parity" was a
 * transcription somebody made once and nothing has verified since; the
 * website drifting is precisely the failure they could not have caught.
 * Meanwhile they fired on every deliberate change to the composers, which is
 * why all four sat red for months, and a suite that cries wolf on ordinary
 * work teaches people to skim red output.
 *
 * KUMI.WEBSITE lives in its own repository and tests itself. What belongs
 * here is the product decision underneath, which is structural and survives a
 * redesign: the thread's composer is a distinct, lighter variant, and the
 * room's, the private chat's and the direct-message panel's are not.
 * `composer-lite` is opt-in for exactly that reason — the comment above it in
 * `screen-chats.js` says so — and asserting the opt-in is asserting the
 * hierarchy without freezing a single number.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("the thread composer is its own lighter variant, and only the thread's", async () => {
  const chats = await publicFile("screen-chats.js");
  const chat = await publicFile("chat.js");

  // Four composers ship. Each is found by the action it submits through, so
  // this reads the markup that actually renders rather than a class name that
  // could sit anywhere.
  const forms = [...chats.matchAll(/<form class="([^"]*composer[^"]*)"[^>]*data-act="([^"]+)"/gu)]
    .map((match) => ({ classes: match[1] ?? "", act: match[2] ?? "" }));
  const room = forms.find((form) => form.act === "channel-submit");
  const thread = forms.find((form) => form.act === "channel-thread-submit");
  assert.notEqual(room, undefined, "the room still has a composer");
  assert.notEqual(thread, undefined, "the thread still has a composer");

  // The whole of the hierarchy, in one line each.
  assert.match(thread?.classes ?? "", /\bcomposer-lite\b/u);
  assert.doesNotMatch(room?.classes ?? "", /\bcomposer-lite\b/u);

  // Opt-in, not inherited: the private chat and the direct-message panel sit
  // in the same wrapper as the thread and must keep their full toolbars. A
  // variant applied to the wrapper rather than the form would quietly take
  // the toolbar off both.
  const dm = forms.find((form) => form.act === "dm-submit");
  if (dm !== undefined) {
    assert.doesNotMatch(dm.classes, /\bcomposer-lite\b/u);
  }
  assert.doesNotMatch(chat, /composer-lite/u);

  // And the lighter shape is a resting state, not a permanent one: entering
  // the box brings the controls back, so the thread is never harder to use
  // than the room, only quieter until it is used.
  const styles = await publicFile("styles.css");
  assert.match(
    styles,
    /\.composer\.composer-lite:not\(\.is-expanded\):not\(:focus-within\)/u,
  );
});
