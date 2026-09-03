import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The message length cap, and the two places it has to be visible.
 *
 * A cap nobody is told about is met as a failed send: the composer used to
 * say only that the message could not be sent, with no number, no idea how
 * much was over, and the words often gone with it. So this pins both halves
 * of the fix — the browser counting down to the same limit the gateway
 * enforces, and every refusal naming that limit and the overage — the same
 * way the rest of the dashboard is pinned, by asserting the shape of the
 * source: it ships as plain ES modules with no bundler and the test run has
 * no DOM.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

/**
 * The gateway's own source, which is where the caps are enforced.
 *
 * Two files, joined: the caps and the field readers that refuse against them
 * live in `field-validation.ts`, while the routes that name a cap when they
 * call one live in `server.ts`. What this test pins is that the numbers agree
 * and that a refusal says which number it hit - neither of which cares which
 * file a declaration sits in, so a later split must not read as a failure.
 */
const GATEWAY_SOURCES = [
  "../../../services/api-gateway/src/server.ts",
  "../../../services/api-gateway/src/field-validation.ts",
];

async function gatewaySource(): Promise<string> {
  const parts = await Promise.all(
    GATEWAY_SOURCES.map(async (relative) =>
      readFile(path.join(defaultPublicDirectory(), relative), "utf8"),
    ),
  );
  return parts.join("\n");
}

/** The value of one `NAME = 1_234` constant, whichever file it is declared in. */
function constantValue(source: string, name: string): number {
  const match = new RegExp(`${name} = ([0-9_]+);`, "u").exec(source);
  assert.ok(match !== null, `${name} is not declared`);
  return Number(String(match[1]).replaceAll("_", ""));
}

test("the browser counts down to the same caps the gateway enforces", async () => {
  const [server, data] = await Promise.all([gatewaySource(), publicFile("data.js")]);

  // Two copies of three numbers, deliberately: the composer has to know the
  // limit while somebody is typing, and cannot ask for it mid-keystroke. The
  // copies drifting apart is the failure this test exists to catch.
  for (const name of [
    "CHANNEL_MESSAGE_MAX_CHARS",
    "DIRECT_MESSAGE_MAX_CHARS",
    "AGENT_CHAT_MAX_CHARS",
  ]) {
    assert.equal(
      constantValue(data, name),
      constantValue(server, name),
      `${name} disagrees between the dashboard and the gateway`,
    );
  }

  // And the routes validate against the names rather than repeating a number.
  assert.match(server, /max: CHANNEL_MESSAGE_MAX_CHARS,/u);
  assert.match(server, /max: DIRECT_MESSAGE_MAX_CHARS,/u);
  assert.match(server, /AGENT_CHAT_MAX_MESSAGES = /u);
  assert.match(server, /const messages = chatMessagesField\(body\["messages"\]\);/u);
});

test("a refusal from the gateway names the limit and the overage", async () => {
  const server = await gatewaySource();
  const field = server.slice(
    server.indexOf("function stringField("),
    server.indexOf("function emailField("),
  );

  // "has an invalid length" was the whole of what a sender used to be told.
  assert.doesNotMatch(server, /has an invalid length/u);
  assert.match(field, /countedChars\(trimmed\.length - max\)\} characters over the/u);
  assert.match(field, /\$\{countedChars\(max\)\}-character limit/u);
  assert.match(field, /this one is \$\{countedChars\(trimmed\.length\)\}/u);
  assert.match(field, /cannot be empty/u);
});

test("every composer carries a live counter", async () => {
  const [chat, chats] = await Promise.all([
    publicFile("chat.js"),
    publicFile("screen-chats.js"),
  ]);

  // One counter, drawn by the module all four composers already import.
  assert.match(chat, /export function composerCount\(target, text\)/u);
  assert.match(chat, /export function paintComposerCount\(node, target = "channel", text\)/u);
  assert.match(chat, /data-composer-count="\$\{esc\(target\)\}"/u);
  assert.match(chat, /\$\{composerCount\("chat", agentChatDraft\(agent\?\.id\)\)\}/u);

  // The room, the thread and the private conversation.
  assert.match(chats, /\$\{composerCount\("channel", state\.chatDraft\)\}/u);
  assert.match(chats, /\$\{composerCount\("thread", state\.threadDraft\)\}/u);
  assert.match(chats, /\$\{composerCount\("dm", state\.dmDraft\)\}/u);

  // Repainted on the keystroke, not by a render: rebuilding the screen would
  // throw away the textarea being typed into.
  const presentation = chats.slice(
    chats.indexOf("export function updateComposerPresentation("),
    chats.indexOf("export function updateThreadComposerInput("),
  );
  assert.match(
    presentation,
    /paintComposerCount\(node, target, composerDraft\(target, node\)\);/u,
  );
});

test("the notice is silent until the allowance is nearly gone", async () => {
  const data = await publicFile("data.js");
  const notice = data.slice(
    data.indexOf("export function messageLengthNotice("),
    data.indexOf("export function messageTooLong("),
  );

  assert.match(data, /export function messageLimitFor\(target\)/u);
  assert.match(notice, /remaining < 0/u);
  assert.match(notice, /over the \$\{countedChars\(limit\)\}-character limit/u);
  assert.match(notice, /remaining <= Math\.round\(limit \/ 10\)/u);
  assert.match(notice, /characters left/u);
  // Trimmed, because that is what the server measures.
  assert.match(notice, /String\(text \?\? ""\)\.trim\(\)\.length/u);
});

test("an over-long message is refused with its draft left on screen", async () => {
  const [app, data, chat] = await Promise.all([
    publicFile("app.js"),
    publicFile("data.js"),
    publicFile("chat.js"),
  ]);

  // The channel and its threads: no optimistic row, so nothing to fail and
  // the composer keeps what was typed.
  const send = data.slice(
    data.indexOf("export function sendChannelMessage("),
    data.indexOf("export function resendChannelMessage("),
  );
  assert.match(send, /messageTooLong\(trimmed, "channel"\)/u);
  assert.match(send, /toast\(tooLong, "error"\);\n\s*return undefined;/u);
  assert.match(data, /messageTooLong\(entry\.content, "channel"\)/u);

  // Direct messages: thrown, because the caller awaits this one and has to
  // know not to clear the draft it is holding.
  const direct = data.slice(data.indexOf("export async function sendDirectMessage("));
  assert.match(direct.slice(0, 900), /throw new Error\(tooLong\);/u);

  // Both private composers clear their box on submit, so both check first.
  const submit = app.slice(app.indexOf('document.addEventListener("submit"'));
  assert.match(submit, /messageTooLong\(text, "chat"\)/u);
  assert.match(submit, /messageTooLong\(draft, "dm"\)/u);
  assert.match(chat, /messageTooLong\(trimmed, "chat"\)/u);
});

test("the edit dialog says the cap it enforces", async () => {
  const app = await publicFile("app.js");
  const editor = app.slice(
    app.indexOf("async function messageEditValue("),
    app.indexOf("async function editChannelMessageAction("),
  );

  // `maxlength` alone stops typing dead and silently drops the tail of a long
  // paste, which reads as the editor breaking rather than as a rule.
  assert.match(editor, /maxLength = CHANNEL_MESSAGE_MAX_CHARS/u);
  assert.match(editor, /Up to \$\{maxLength\.toLocaleString\("en-US"\)\} characters\./u);
  assert.match(app, /maxLength: DIRECT_MESSAGE_MAX_CHARS,/u);
});
