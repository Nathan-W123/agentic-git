import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The dashboard is served as plain ES modules with no bundler and no DOM in
 * the test run, so the scroll behaviour is pinned the way the rest of the
 * browser surface is pinned: by asserting the shape of the source. What is
 * being protected is one bug — a render the reader did not ask for putting
 * them back at the first message ever sent — and the handful of lines that
 * stop it happening again.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("a render nobody asked for does not move the reader", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  // The whole screen goes through one `innerHTML` swap, which drops the
  // transcript's scroll on the floor. Taking the position has to happen
  // before that line, not after it.
  const capture = app.indexOf("captureChannelScroll()");
  const swap = app.indexOf("root.innerHTML = `<div class=\"${classes");
  assert.notEqual(capture, -1, "app.js should capture the transcript position");
  assert.notEqual(swap, -1, "the screen-wide innerHTML swap should still exist");
  assert.equal(
    capture < swap,
    true,
    "the position must be read before the DOM holding it is replaced",
  );
  // And putting it back has to happen before the follow pin, or a reader at
  // the bottom of a live conversation would be left mid-history instead.
  const anchor = app.indexOf("restoreChannelAnchor(savedScroll)");
  const follow = app.indexOf("restoreChannelScroll();", swap);
  assert.notEqual(anchor, -1, "app.js should restore the captured position");
  assert.equal(anchor > swap, true, "the restore needs the new DOM in place");
  assert.equal(
    anchor < follow,
    true,
    "following the bottom outranks standing still, so it runs last",
  );
  // The restore is anchored to a message, not to a pixel offset: history
  // loading in above the reader moves every offset but not their place.
  assert.match(chats, /export function captureChannelScroll\(\)/u);
  assert.match(chats, /export function restoreChannelAnchor\(saved\)/u);
  assert.match(chats, /document\.getElementById\(entry\.id\)/u);
});

test("the open thread is restored too, not only the channel", async () => {
  const chats = await publicFile("screen-chats.js");
  // The thread panel is fullscreen on a phone and had no restore of any kind,
  // so reading a thread meant being thrown to the top on every poll tick.
  assert.match(chats, /const SCROLL_SURFACES = \[[^\]]*"\.thread-body"/su);
  assert.match(chats, /const SCROLL_SURFACES = \[[^\]]*"#chan-messages"/su);
  // `.thread-body` is worn by several panels; one panel's offset is not
  // another's, so the restore checks it is putting the position back into
  // the surface it came from.
  assert.match(chats, /scroller\.className !== entry\.shape/u);
});

test("a keyboard opening is not the reader scrolling away", async () => {
  const chats = await publicFile("screen-chats.js");
  // The follow flag is recomputed from `scrollHeight - scrollTop -
  // clientHeight`. The soft keyboard and the collapsing address bar change
  // `clientHeight` and make the browser fire `scroll` on a container nobody
  // touched, which used to read as "scrolled a long way up" and silently
  // stopped the conversation following itself.
  assert.match(chats, /let followHeight = 0;/u);
  assert.match(chats, /if \(height !== followHeight\) \{/u);
  assert.match(chats, /const distance = list\.scrollHeight - list\.scrollTop - height;/u);
});

test("a picture that decodes late does not drift the conversation", async () => {
  const chats = await publicFile("screen-chats.js");
  const styles = await publicFile("styles.css");
  // Pinned once synchronously, when a lazy attachment is still a zero-tall
  // box, then again once the frame settles and again once the bytes arrive.
  assert.match(chats, /requestAnimationFrame\(\(\) => \{/u);
  assert.match(chats, /list\.addEventListener\(\s*"load",/u);
  // And the box is reserved up front, so the shift is bounded rather than
  // being the picture's whole height.
  assert.match(styles, /\.cmsg-image img \{[^}]*aspect-ratio: auto 4 \/ 3;/su);
});
