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

  assert.match(
    row,
    /inlineReply \|\| \(entry\.kind === "user" && !hasTaskThread\)/u,
  );
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

test("replying inside a thread selects the message without rewriting the draft", async () => {
  const [app, chats, data] = await Promise.all([
    publicFile("app.js"),
    publicFile("screen-chats.js"),
    publicFile("data.js"),
  ]);
  const action = app.slice(
    app.indexOf('case "thread-reply-quote":'),
    app.indexOf('case "dm-reply-quote":'),
  );

  assert.match(action, /state\.threadReplyMessageId = target\?\.id;/u);
  assert.doesNotMatch(action, /state\.threadDraft\s*=/u);
  assert.match(chats, /threadReplyChip\(threadReplyTarget, repositoryId\)/u);
  assert.match(chats, /state\.threadReplyMessageId = undefined;/u);
  assert.match(
    chats,
    /postChannelReply\([\s\S]*referencedMessageId,[\s\S]*\);/u,
  );
  assert.match(data, /\{ referencedMessageId \}/u);
});

test("the thread header reply button keeps the open thread in place", async () => {
  const [app, chats] = await Promise.all([
    publicFile("app.js"),
    publicFile("screen-chats.js"),
  ]);
  const action = app.slice(
    app.indexOf('case "thread-composer-focus":'),
    app.indexOf('case "composer-thread-clear":'),
  );

  assert.match(chats, /act: "thread-composer-focus"/u);
  assert.match(action, /channel-thread-input/u);
  assert.doesNotMatch(action, /activeChannelThread\s*=\s*undefined/u);
  assert.doesNotMatch(action, /composerThreadId\s*=/u);
});

test("a person's response takes its place at the end of the transcript", async () => {
  const [chats, data, css] = await Promise.all([
    publicFile("screen-chats.js"),
    publicFile("data.js"),
    publicFile("styles.css"),
  ]);
  const list = chats.slice(
    chats.indexOf("function messageList("),
    chats.indexOf("function isThreadEnding("),
  );

  // Replies are collected, ordered by when they were written, and merged into
  // the one timeline — not printed straight after the row they answer, which
  // is what put a just-sent message back up in the middle of history.
  assert.match(
    list,
    /entry\.kind !== "user" \|\|[\s\S]{0,120}entry\.taskId !== undefined[\s\S]*inlineReplyTo: entry,/u,
  );
  assert.match(list, /pending\.sort\(\(a, b\) => stamp\(a\.at\) - stamp\(b\.at\)\)/u);
  assert.match(
    list,
    /stamp\(pending\[next\]\.at\) < stamp\(entry\.at\)[\s\S]*timeline\.push\(pending\[next\]\)/u,
  );
  assert.match(list, /timeline\.push\(\.\.\.pending\.slice\(next\)\)/u);
  assert.doesNotMatch(
    list,
    /messageRow\(entry, repositoryId, \{ hideChanges \}\) \+\s*inlineReplies/u,
  );
  // The relationship is still drawn — the quoted reference above the reply.
  assert.match(
    list,
    /messageRow\(entry, repositoryId, \{ inlineReplyTo: item\.inlineReplyTo \}\)/u,
  );
  // A message that carries a task keeps its replies in its own thread rather
  // than spilling them into the timeline — from the first one now, not the
  // second: one reply under a task is already that thread's narration.
  assert.match(
    chats,
    /entry\.taskId !== undefined && \(entry\.replies \?\? \[\]\)\.length > 0/u,
  );
  assert.match(chats, /messageReference\(inlineReplyTo, repositoryId\)/u);
  assert.match(chats, /cmsg-inline-reply/u);
  // No inset: a reply that can sit far below what it answers should read as a
  // normal line of the room, not a stray indent.
  assert.match(css, /\.cmsg-row\.cmsg-inline-reply \{\s*margin-left: 0;/u);
  assert.match(
    data,
    /const reply = \{\s*id: [^\n]+,\s*messageId,\s*kind: "user",/u,
  );
});

test("a person's response renders inline with the message it answers", async () => {
  const chats = await publicFile("screen-chats.js");
  const row = chats.slice(
    chats.indexOf("function messageRow("),
    chats.indexOf("function typingIndicator("),
  );

  assert.match(row, /const inlineReply = inlineReplyTo !== undefined;/u);
  assert.match(row, /messageReference\(inlineReplyTo, repositoryId\)/u);
  assert.match(row, /inlineReply \? " cmsg-inline-reply" : ""/u);
  assert.match(
    row,
    /entry\.kind !== "user" \|\| entry\.taskId !== undefined/u,
    "a human reply must not become task-thread navigation",
  );
});

test("an agent root keeps its chronological place while referencing the request", async () => {
  const chats = await publicFile("screen-chats.js");
  const row = chats.slice(
    chats.indexOf("function messageRow("),
    chats.indexOf("function typingIndicator("),
  );
  const list = chats.slice(
    chats.indexOf("function messageList("),
    chats.indexOf("function isThreadEnding("),
  );

  assert.match(row, /entry\.referencedMessageId !== undefined/u);
  assert.match(row, /AGENT_AUTHORED_ROOT_KINDS\.has\(entry\.kind\)/u);
  assert.match(row, /message\.id === entry\.referencedMessageId/u);
  assert.match(row, /messageReference\(referencedRoot, repositoryId\)/u);
  assert.match(
    row,
    /entry\.kind !== "user" \|\| entry\.taskId !== undefined/u,
    "the persisted reference must not replace an agent root's task thread",
  );
  assert.match(
    list,
    /timeline\.push\(\{ entry, inlineReplyTo: undefined, at: entry\.at \}\)/u,
    "agent roots stay in the canonical root timeline",
  );
});

test("task-bearing user messages join thread navigation without capturing person-to-person replies", async () => {
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
    /entry\.kind !== "user" \|\| entry\.taskId !== undefined/u,
  );
  assert.match(
    chats,
    /entry\.kind === "user" && !hasTaskThread/u,
    "a task request should switch from a direct reply to thread navigation only after substantive narration",
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
  assert.match(
    chip,
    /const preview = directReply[\s\S]*replyPreviewText\(root\)[\s\S]*replyPreviewText\(\{ content: threadTitle\(root\) \}\);/u,
  );
  assert.match(chip, /directReply \? `\$\{author\.name\}: ` : ""/u);
  assert.match(chip, /title\.slice\(0, 70\)/u);
  assert.match(
    submit,
    /target\?\.kind === "user" && target\.taskId === undefined/u,
    "task-bearing user roots keep the composer in task-continuation mode",
  );
  assert.match(submit, /state\.composerThreadId = undefined;/u);
  // Every successful channel-composer send ends at the bottom, including a
  // continuation aimed at an existing task thread.
  assert.equal([...submit.matchAll(/scrollChannel\(\);/gu)].length, 2);
  assert.doesNotMatch(
    submit,
    /if \(directReply\) \{\s*scrollChannel\(\);/u,
  );
  assert.doesNotMatch(submit, /state\.scrollToMessage = continuing;/u);
});

test("reply previews collapse multiline content and omit hidden attachment references", async () => {
  const chats = await publicFile("screen-chats.js");
  const start = chats.indexOf("function replyPreviewText(");
  const end = chats.indexOf("\n/** The compact address above an inline reply.", start);
  assert.notEqual(start, -1, "the shared reply preview helper should exist");
  assert.notEqual(end, -1, "the reply preview helper should have a boundary");

  const preview = new Function(
    "ATTACHMENT_PATTERN",
    `${chats.slice(start, end)}\nreturn replyPreviewText;`,
  )(
    /!\[([^\]]*)\]\(attachment:([0-9a-f]{32}\.(?:png|jpg|gif|webp))\)/gu,
  ) as (entry: { content?: string; deletedAt?: string }) => string;
  const attachment =
    "![Attached image](attachment:0123456789abcdef0123456789abcdef.png)";

  assert.equal(
    preview({ content: `First line\n  second line\n${attachment}` }),
    "First line second line",
  );
  assert.equal(preview({ content: attachment }), "Attached image");
  assert.equal(
    preview({ content: "words that are replaced", deletedAt: "now" }),
    "This message was deleted",
  );
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
