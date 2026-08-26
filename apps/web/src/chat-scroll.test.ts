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
  const capture = app.indexOf("const savedScroll = captureChannelScroll()");
  // Matched on the assignment rather than on the markup that follows it: the
  // opening tag has been rewritten twice by work that had nothing to do with
  // scrolling — once by the sidebar removal, which is how this assertion came
  // to be looking for a `${classes` interpolation that no longer existed —
  // and a guard that silently stops guarding is worse than no guard.
  const swap = app.indexOf("root.innerHTML = `<div class=\"app\"", capture);
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
  const follow = app.indexOf("restoreChannelScroll(savedScroll);", swap);
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

test("settings interactions keep their place without carrying it to another screen", async () => {
  const app = await publicFile("app.js");
  // A Settings click re-renders the whole app, so its ordinary `.scroll`
  // element needs an identity that exists on both sides of a same-screen
  // render and on only one side of navigation to or from Settings.
  assert.match(app, /class="scroll" data-scroll-key="settings"/u);

  const capture = app.indexOf(
    "const savedSettingsScroll = captureSettingsScroll();",
  );
  const swap = app.indexOf('root.innerHTML = `<div class="app"', capture);
  const restore = app.indexOf(
    "restoreSettingsScroll(savedSettingsScroll);",
    swap,
  );
  assert.notEqual(capture, -1, "Settings scroll should be captured");
  assert.notEqual(swap, -1, "the screen-wide innerHTML swap should still exist");
  assert.notEqual(restore, -1, "Settings scroll should be restored");
  assert.equal(capture < swap, true, "capture must precede DOM replacement");
  assert.equal(restore > swap, true, "restore needs the replacement DOM");

  const helpers = app.slice(
    app.indexOf("function captureSettingsScroll"),
    app.indexOf("\n/**\n * Where focus", app.indexOf("function captureSettingsScroll")),
  );
  assert.equal(
    [...helpers.matchAll(/\[data-scroll-key="settings"\]/gu)].length,
    2,
    "capture and restore must require the same Settings-only surface",
  );
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

test("sending in every composer lands on the latest message", async () => {
  const [app, chats, chat] = await Promise.all([
    publicFile("app.js"),
    publicFile("screen-chats.js"),
    publicFile("chat.js"),
  ]);
  const channelSubmit = chats.slice(
    chats.indexOf("export function submitComposerMessage("),
    chats.indexOf("function pinnedBanner("),
  );
  const threadSubmit = chats.slice(
    chats.indexOf("export function submitThreadReply("),
    chats.indexOf("export function closeComposerAutocomplete("),
  );
  const threadScroll = chats.slice(
    chats.indexOf("function scrollChannelThreadToLatest("),
    chats.indexOf("export function jumpToUnreadOrLatest("),
  );
  const dmSubmit = app.slice(
    app.indexOf('case "dm-submit":'),
    app.indexOf('case "channel-submit":'),
  );
  const privateSend = chat.slice(
    chat.indexOf("export async function sendChat("),
    chat.indexOf("async function streamChat("),
  );

  const channelRenders = [...channelSubmit.matchAll(/rerender\(\);/gu)];
  const channelScrolls = [...channelSubmit.matchAll(/scrollChannel\(\);/gu)];
  assert.equal(channelRenders.length, 2);
  assert.equal(channelScrolls.length, 2);
  assert.deepEqual(
    channelScrolls.map((scroll, index) =>
      Boolean(
        (scroll.index ?? -1) > (channelRenders[index]?.index ?? Infinity),
      ),
    ),
    [true, true],
    "channel messages and thread-targeted continuations scroll after rendering",
  );
  assert.match(
    threadSubmit,
    /rerender\(\);\s*scrollChannelThreadToLatest\(\);/u,
  );
  assert.match(threadScroll, /\.thread-panel\[data-thread-id\]/u);
  assert.match(threadScroll, /requestAnimationFrame\(\(\) => \{/u);
  assert.equal(
    [...dmSubmit.matchAll(/scrollDirectMessageToLatest\(\);/gu)].length,
    2,
    "direct messages stay at the latest line before and after the send settles",
  );
  assert.match(
    dmSubmit,
    /render\(\);\s*scrollDirectMessageToLatest\(\);[\s\S]*\.then\(\(\) => \{[\s\S]*render\(\);\s*if \(state\.activeDm === other\) \{\s*scrollDirectMessageToLatest\(\);/u,
  );
  assert.match(privateSend, /rerender\(\);\s*scrollThread\(\);/u);
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
  // Pinned once synchronously, when a picture nobody has measured is still
  // holding a guessed box, then again once the frame settles and again once
  // the bytes arrive.
  assert.match(chats, /requestAnimationFrame\(\(\) => \{/u);
  assert.match(chats, /list\.addEventListener\(\s*"load",/u);
  // And the box is reserved up front, so the shift is bounded rather than
  // being the picture's whole height.
  assert.match(styles, /\.cmsg-image img \{[^}]*aspect-ratio: auto 4 \/ 3;/su);
});

test("an image is only ever measured once", async () => {
  const chats = await publicFile("screen-chats.js");
  // The screen is one `innerHTML` assignment, so a decoded `<img>` is thrown
  // away and rebuilt by every background render — a poll tick, somebody
  // else's typing indicator — and laid out again at the stylesheet's guessed
  // 4/3 box until it decodes a second time. Per picture, per render. That is
  // the conversation teleporting under a reader who is only typing.
  //
  // So the first decode is measured and kept, and every render after it
  // states the real ratio in the markup. Attachment ids address immutable
  // bytes, which is what makes a remembered size safe to reuse.
  assert.match(chats, /const IMAGE_SIZE_KEY = "ag\.image-sizes";/u);
  assert.match(chats, /function rememberImageSize\(node\)/u);
  assert.match(chats, /node\?\.naturalWidth/u);
  assert.match(chats, /node\?\.naturalHeight/u);
  assert.match(chats, /persist\(IMAGE_SIZE_KEY, JSON\.stringify\(\[\.\.\.imageSizes\]\)\)/u);
  // Anything on this origin can write that key, and the value goes straight
  // into a `style` attribute, so it is checked on the way back in.
  assert.match(chats, /RATIO_PATTERN\.test\(entry\[1\]\)/u);
  // The measured ratio is inline, and carries no `auto` — the numbers *are*
  // the natural ratio, so letting the decode restate them is the shift being
  // removed. An image nobody has measured gets no inline ratio at all, and
  // keeps the stylesheet's fallback and its lazy load.
  assert.match(chats, /style="aspect-ratio: \$\{esc\(ratio\)\}"/u);
  assert.match(chats, /ratio === undefined \? ' loading="lazy"' : ""/u);
  assert.match(chats, /decoding="async"/u);
  // The id has to reach the measuring handler, on the transcript image and on
  // the composer thumbnail — staging an image before posting it is what makes
  // the very first render of the posted message the right size.
  assert.match(chats, /data-attachment="\$\{esc\(image\.id\)\}"/u);
  assert.match(chats, /data-attachment="\$\{esc\(attachment\.id\)\}"/u);
});

test("a first decode holds a reader who is not following", async () => {
  const chats = await publicFile("screen-chats.js");
  // The follow pin is bound to `#chan-messages` and answers for the reader at
  // the bottom of a live conversation. Everyone else — reading history, or
  // reading a thread, where there is no follow at all — used to get nothing:
  // an unmeasured picture above them took its real height and slid the
  // message they were on down the screen.
  //
  // Re-applying the anchor is the whole correction. It is a message id and a
  // distance from the top of the scroller, so it survives anything growing
  // above it. Bound once, on `document`, because `load` does not bubble and
  // the composer thumbnail is not inside any scroller.
  assert.match(chats, /function watchImageSizes\(\)/u);
  assert.match(chats, /document\.addEventListener\(\s*"load",/u);
  assert.match(chats, /if \(imageWatchBound\) \{/u);
  assert.match(chats, /restoreChannelAnchor\(\[held\.entry\]\)/u);
  // Only while the scroller is still where the restore left it. If it has
  // moved, the reader moved it — or the follow pin did — and reaching in
  // would be the yank this is here to prevent.
  assert.match(chats, /scroller\.scrollTop !== held\.applied/u);
  assert.match(chats, /heldAnchors\.set\(\s*entry\.selector/u);
});
