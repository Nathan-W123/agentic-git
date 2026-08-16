import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * A thread could always show a picture and never take one.
 *
 * The channel bar has had a picker, a paste path and a staged preview since
 * attachments existed; the reply box beside it had a textarea and a send
 * button, so the one place a screenshot is most often the answer — inside the
 * thread arguing about it — was the one place it could not be put. These
 * assertions pin the parts that close that gap, in the same way the rest of
 * the browser surface is pinned: the dashboard ships as plain ES modules with
 * no bundler and no DOM in the test run, so the shape of the source is what
 * there is to check.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("the thread composer can take an image at all", async () => {
  const chats = await publicFile("screen-chats.js");
  const composer = chats.slice(chats.indexOf("function threadPanel("));
  assert.notEqual(composer, "", "screen-chats.js should still render a thread panel");
  // The picker itself, restricted to the same four raster types the store
  // allows — SVG is a document that can carry script and stays out.
  assert.match(
    composer,
    /data-act="channel-thread-attach-input"[^>]*accept="image\/png,\s*image\/jpeg,image\/gif,image\/webp"/su,
  );
  // And a control that clicks it, since a bare file input cannot be styled
  // into the bar and a label would swallow the click before the delegated
  // handler ever saw it.
  assert.match(composer, /act: "thread-attach"/u);
  // Staged images are shown above the box, each with its own remove button.
  assert.match(composer, /removeAct: "thread-attachment-remove"/u);
});

test("a staged thread image survives the next keystroke", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  // The textarea only ever holds the visible half of the draft: the reference
  // lines live after it. Writing the textarea's value straight back into
  // `state.threadDraft` — which is what the input handler used to do — would
  // drop them and post the words without the picture.
  assert.match(chats, /export function updateThreadComposerInput\(node\)/u);
  assert.match(
    chats,
    /draftAttachments\(activeChannelId\(\), state\.threadDraft\)/u,
  );
  assert.match(app, /updateThreadComposerInput\(node\);/u);
  assert.equal(
    /state\.threadDraft = node\.value;/u.test(app),
    false,
    "the raw assignment is what loses a staged image",
  );
  // What the box shows is the visible half, not the references behind it.
  assert.match(chats, /esc\(draftText\(state\.threadDraft\)\)/u);
});

test("the two composers upload by one path, into two drafts", async () => {
  const app = await publicFile("app.js");
  // One loop, one validated endpoint, one set of error messages. The only
  // thing that differs is where the reference lands, which counter the
  // "attaching…" note reads, and which textarea gets the caret back.
  assert.match(app, /const ATTACH_TARGETS = \{[^}]*channel: \{/su);
  assert.match(app, /thread: \{\s*draft: "threadDraft",/su);
  assert.match(app, /async function attachChannelImages\(files, target = "channel"\)/u);
  // Both pickers reach it, and so does a paste into either box — which is how
  // most screenshots actually arrive.
  assert.match(app, /picker\?\.dataset\?\.act === "channel-thread-attach-input"/u);
  assert.match(
    app,
    /act !== "channel-input" && act !== "channel-thread-input"/u,
  );
  assert.match(
    app,
    /attachChannelImages\(files, act === "channel-thread-input" \? "thread" : "channel"\)/u,
  );
});

test("a thread reply carries its images to the server", async () => {
  const chats = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");
  // `submitThreadReply` posts the whole draft, references included, through
  // the same reply endpoint as any other reply — the gateway rewrites those
  // references into a path an agent can open, and `messageBody` draws them.
  assert.match(
    chats,
    /postChannelReply\(activeChannelId\(\), state\.activeChannelThread, state\.threadDraft\)/u,
  );
  assert.match(data, /threadAttaching: 0,/u);
});
