import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.notEqual(start, -1, `${from} should exist`);
  assert.notEqual(end, -1, `${from} should end at ${to}`);
  return source.slice(start, end);
}

test("long messages fold behind a remembered show-more control", async () => {
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");
  const chat = await publicFile("chat.js");
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");

  assert.match(data, /export const MESSAGE_FOLD_MIN_BLOCKS = \d+/u);
  assert.match(data, /export const MESSAGE_FOLD_MIN_CHARS = \d+/u);
  assert.match(data, /export function messageFoldEligible\(text\)/u);
  assert.match(data, /export function messageFoldClip\(text\)/u);
  assert.match(data, /export function messageFoldOpen\(key\)/u);
  assert.match(data, /messageFoldOpen: rememberedMessageFoldOpen\(\)/u);
  assert.match(data, /blocks\.length >= MESSAGE_FOLD_MIN_BLOCKS/u);
  assert.match(data, /raw\.length >= MESSAGE_FOLD_MIN_CHARS/u);

  const foldFrame = slice(chats, "function messageFoldClip(", "\n}");
  assert.match(foldFrame, /messageFoldEligible\(text\)/u);
  assert.match(foldFrame, /messageFoldOpen\(foldKey\)/u);
  assert.match(foldFrame, /clipFoldedMessageText\(text\)/u);
  assert.match(foldFrame, /data-act="message-fold-toggle"/u);
  assert.match(foldFrame, /Show more/u);
  assert.match(foldFrame, /Show less/u);

  const messageRow = slice(chats, "function messageRow(", "\nfunction ");
  assert.match(messageRow, /messageFoldClip\(/u);
  assert.match(messageRow, /cmsg:\$\{repositoryId\}\|\$\{entry\.id\}/u);

  const dmPanel = slice(chats, "function dmPanel()", "\nfunction threadPanel(");
  assert.match(dmPanel, /messageFoldClip\(/u);
  assert.match(dmPanel, /dm:\$\{userId\}\|\$\{message\.id\}/u);

  const chatThread = slice(chat, "export function chatThread(", "\nexport function ");
  assert.match(chatThread, /messageFoldClip\(/u);
  assert.match(chatThread, /chat:\$\{agent\.id\}/u);

  assert.match(app, /case "message-fold-toggle":/u);
  assert.match(app, /state\.messageFoldOpen\[value\] = open/u);
  assert.match(app, /persist\("ag\.messageFoldOpen", JSON\.stringify\(state\.messageFoldOpen\)\)/u);
  assert.match(app, /messageFoldOpen\(value\)/u);

  assert.match(css, /\.message-fold \{/u);
  assert.match(css, /\.message-fold-toggle \{/u);
  assert.match(css, /\.message-fold:not\(\.is-open\) \.message-fold-body::after/u);
});
