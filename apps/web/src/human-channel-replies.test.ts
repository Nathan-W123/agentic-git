import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("replying to a person aims the channel composer", async () => {
  const [app, chats] = await Promise.all([
    publicFile("app.js"),
    publicFile("screen-chats.js"),
  ]);
  const row = chats.slice(
    chats.indexOf("function messageRow("),
    chats.indexOf("function typingIndicator("),
  );

  assert.match(row, /inlineReply \|\| entry\.kind === "user"/u);
  assert.match(row, /act: "channel-message-reply"/u);
  assert.match(row, /act: "channel-thread-open"/u);
  assert.match(row, /act: "thread-reply-quote"/u);

  const action = app.slice(
    app.indexOf('case "channel-message-reply":'),
    app.indexOf('case "channel-thread-open":'),
  );
  assert.match(action, /state\.composerThreadId = value;/u);
  assert.match(action, /state\.activeChannelThread = undefined;/u);
  assert.match(action, /\$\("\[data-act='channel-input'\]"\)\?\.focus\(\);/u);
});

test("a person's response renders inline with the message it answers", async () => {
  const [chats, data, css] = await Promise.all([
    publicFile("screen-chats.js"),
    publicFile("data.js"),
    publicFile("styles.css"),
  ]);
  const list = chats.slice(
    chats.indexOf("function messageList("),
    chats.indexOf("function isThreadEnding("),
  );

  assert.match(
    list,
    /entry\.kind === "user"[\s\S]*messageRow\(reply, repositoryId, \{ inlineReplyTo: entry \}\)/u,
  );
  assert.match(
    chats,
    /const hasTaskThread = entry\.kind !== "user" && replies\.length > 0;/u,
  );
  assert.match(chats, /messageReference\(inlineReplyTo, repositoryId\)/u);
  assert.match(chats, /cmsg-inline-reply/u);
  assert.match(css, /\.cmsg-row\.cmsg-inline-reply \{/u);
  assert.match(
    data,
    /const reply = \{\s*id: [^\n]+,\s*messageId,\s*kind: "user",/u,
  );
});

test("person-to-person replies stay out of task thread navigation", async () => {
  const [app, chats] = await Promise.all([
    publicFile("app.js"),
    publicFile("screen-chats.js"),
  ]);
  const panel = chats.slice(
    chats.indexOf("function threadListPanel("),
    chats.indexOf("function threadPanel("),
  );
  const pinJump = app.slice(
    app.indexOf('case "channel-pin-jump":'),
    app.indexOf('case "chan-tree-toggle":'),
  );

  assert.match(
    panel,
    /entry\.kind !== "user" && \(entry\.replies \?\? \[\]\)\.length > 0/u,
  );
  assert.match(pinJump, /entry\.kind !== "user"/u);
  assert.match(pinJump, /state\.scrollToMessage = value;/u);
});

test("the direct-reply composer names its target and resets after sending", async () => {
  const chats = await publicFile("screen-chats.js");
  const chip = chats.slice(
    chats.indexOf("function composerThreadChip("),
    chats.indexOf("export function submitThreadReply("),
  );
  const submit = chats.slice(
    chats.indexOf("export function submitComposerMessage("),
    chats.indexOf("function pinnedBanner("),
  );

  assert.match(chip, /directReply \? "Replying to" : "Continuing in"/u);
  assert.match(chip, /directReply \? `\$\{author\.name\}: ` : ""/u);
  assert.match(chip, /title\.slice\(0, 70\)/u);
  assert.match(submit, /if \(target\?\.kind === "user"\)/u);
  assert.match(submit, /state\.composerThreadId = undefined;/u);
  assert.match(submit, /state\.scrollToMessage = continuing;/u);
});

test("a reply's reference keeps clear of the avatar it sits above", async () => {
  const [chats, css] = await Promise.all([
    publicFile("screen-chats.js"),
    publicFile("styles.css"),
  ]);
  const row = chats.slice(
    chats.indexOf("function messageRow("),
    chats.indexOf("function typingIndicator("),
  );
  // Anchored on the line start, so `.cmsg-ref` does not match the tail of
  // `.cmsg-row.cmsg-inline-reply .cmsg-ref`.
  const block = (selector: string): string => {
    const start = css.indexOf(`\n${selector} {`);
    assert.notEqual(start, -1, `${selector} is missing`);
    return css.slice(start, css.indexOf("}", start));
  };

  // The reference is drawn before the avatar and outside the body, so it wraps
  // onto a line of its own instead of leaning back across the picture.
  assert.match(
    row,
    /messageReference\(inlineReplyTo, repositoryId\)[\s\S]*<span class="cmsg-avatar">[\s\S]*<div class="cmsg-body">/u,
  );
  assert.match(block(".cmsg-row"), /flex-wrap: wrap;/u);
  assert.match(block(".cmsg-ref"), /flex: 0 0 100%;/u);
  // No pull left out of the body: that pull is what put the elbow on the face.
  assert.doesNotMatch(block(".cmsg-ref"), /margin: 0 0 2px -28px;/u);
  assert.match(block(".cmsg-ref-elbow"), /margin-left: 16px;/u);
});
