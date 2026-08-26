import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";
import { AttachmentStore, AttachmentTypeError } from "./attachments.js";

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
  // handler ever saw it. Its icon matches the group-channel composer while
  // retaining the thread's direct attachment action.
  assert.match(composer, /iconButton\("plus", \{\s*act: "thread-attach"/u);
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
  // The guard and the target choice have since grown a direct-message arm, so
  // both are matched across the lines they now span. What is being pinned is
  // unchanged: a paste into either channel composer reaches the one uploader,
  // and the thread box is the arm that stages into the thread draft.
  assert.match(
    app,
    /act !== "channel-input" &&\s*act !== "channel-thread-input"/u,
  );
  assert.match(
    app,
    /attachChannelImages\(\s*files,\s*act === "channel-thread-input"\s*\? "thread"/u,
  );
});

test("a thread reply carries its images to the server", async () => {
  const chats = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");
  // `submitThreadReply` posts the whole draft, references included, through
  // the same reply endpoint as any other reply — the gateway rewrites those
  // references into a path an agent can open, and `messageBody` draws them.
  // The call moved inside `submitThreadReply` and grew two arguments — a
  // reply address, and a callback for a command result — so the channel and
  // the thread hoist their ids the same way. Matched on the hoisted locals
  // rather than loosened to a bare `postChannelReply`: what is being pinned
  // is that `state.threadDraft` reaches the reply endpoint *whole*, since a
  // draft trimmed of its reference lines would drop the images with them.
  const submit = chats.slice(chats.indexOf("export function submitThreadReply("));
  const body = submit.slice(0, submit.indexOf("\n}\n"));
  assert.match(
    body,
    /const repositoryId = activeChannelId\(\);\s*const threadId = state\.activeChannelThread;/u,
  );
  assert.match(
    body,
    /postChannelReply\(\s*repositoryId,\s*threadId,\s*state\.threadDraft,/u,
  );
  assert.match(data, /threadAttaching: 0,/u);
});

test("attachment clicks open the image over the conversation", async () => {
  const app = await publicFile("app.js");
  const action = app.slice(app.indexOf("function actionOf("));
  assert.match(action, /closest\("\.cmsg-image"\)/u);
  assert.match(action, /querySelector\("img\[data-attachment\]"\)/u);
  assert.match(action, /act: "image-preview"/u);
  assert.match(action, /case "image-preview": \{/u);
  assert.match(action, /event\.preventDefault\(\);[\s\S]*?void showModal\(\{/u);
});

test("the image modal is escaped and bounded by the viewport", async () => {
  const ui = await publicFile("ui.js");
  const styles = await publicFile("styles.css");
  const modal = ui.slice(ui.indexOf("export function showModal("));
  assert.match(modal, /image,[\s\S]*?class="modal-card modal-image-card"/u);
  assert.match(modal, /src="\$\{esc\(image\.src\)\}"/u);
  assert.match(modal, /alt="\$\{esc\(image\.alt\)\}"/u);
  assert.match(styles, /\.modal-image \{[\s\S]*?max-width: calc\(100vw - 32px\);/u);
  assert.match(styles, /\.modal-image \{[\s\S]*?max-height: calc\(100vh - 32px\);/u);
});

test("the image modal closes from its edge, Escape, or close control", async () => {
  const ui = await publicFile("ui.js");
  const modal = ui.slice(ui.indexOf("export function showModal("));
  assert.match(modal, /<form method="dialog" class="modal-card modal-image-card"/u);
  assert.match(modal, /class="icon-btn modal-image-close"[^>]*value="cancel"/u);
  assert.match(modal, /event\.target === dialog[\s\S]*?dialog\.close\("cancel"\)/u);
  assert.match(modal, /returnFocus\.focus\(\);/u);
  assert.match(modal, /dialog\.showModal\(\);/u);
});

test("ordinary modal confirmation still returns its form values", async () => {
  const ui = await publicFile("ui.js");
  const modal = ui.slice(ui.indexOf("export function showModal("));
  assert.match(modal, /dialog\.returnValue !== "confirm"/u);
  assert.match(modal, /for \(const field of \$\$\("\[name\]", dialog\)\)/u);
  assert.match(modal, /field\.type === "checkbox" \? field\.checked : field\.value/u);
  assert.match(modal, /value="confirm" type="submit"/u);
});

test("an attachment has to be the image it says it is", async (t) => {
  // The stored extension used to come from the uploader's declared
  // `Content-Type` and nothing else, so anything at all could be kept as a
  // `.png` and served back from this origin. The read path already refuses to
  // let a browser execute it — allowlisted extension, `nosniff`, no SVG — but
  // hosting attacker-chosen bytes on a trusted origin is worth refusing on its
  // own.
  const directory = await mkdtemp(path.join(os.tmpdir(), "coord-attachment-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const store = new AttachmentStore(directory);

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32),
  ]);
  assert.match(await store.save(png, "image/png"), /^[0-9a-f]{32}\.png$/u);

  await assert.rejects(
    store.save(Buffer.from("<svg onload=\"alert(1)\"></svg>"), "image/png"),
    AttachmentTypeError,
  );

  // Only the signature is checked, so a genuine file whose header differs
  // after it — a JPEG that opens with an EXIF segment rather than JFIF — is
  // still an image and still stored.
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
    Buffer.alloc(32),
  ]);
  assert.match(await store.save(jpeg, "image/jpeg"), /^[0-9a-f]{32}\.jpg$/u);
});
