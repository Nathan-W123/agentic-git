import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The two private composers — the one-to-one panel with a person, and the
 * private chat with your own agent — pinned the way the rest of the browser
 * surface is pinned: by asserting the shape of the source, since the dashboard
 * ships as plain ES modules with no bundler and the test run has no DOM. Each
 * test here stands for one thing that used to be impossible: keeping what you
 * were typing to an agent, sending it at all, and sending a direct message
 * with the keyboard.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("what is typed to an agent survives a render", async () => {
  const chat = await publicFile("chat.js");
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");

  // The composer used to be drawn with an empty box every time, and nothing
  // wrote a keystroke anywhere but the DOM — so any background refresh took
  // the half-written message with it.
  assert.match(data, /agentChatDrafts: \{\},/u);
  assert.match(chat, /export function agentChatDraft\(agentId\)/u);
  assert.match(chat, /state\.agentChatDrafts\[agentId\] \?\? ""/u);
  assert.match(chat, />\$\{esc\(agentChatDraft\(agent\?\.id\)\)\}<\/textarea>/u);
  assert.match(app, /state\.agentChatDrafts\[agentId\] = node\.value;/u);
});

test("a private chat sends to the agent whose composer it is", async () => {
  const chat = await publicFile("chat.js");
  const app = await publicFile("app.js");

  // Resolving through `currentAgent` alone meant the panel opened from the
  // channel had no selection to read, so the send went to whichever agent came
  // first — or nowhere, when there was none.
  assert.match(chat, /data-act="chat-submit" data-value="\$\{agentId\}"/u);
  assert.match(chat, /data-act="chat-input" data-value="\$\{agentId\}"/u);
  assert.match(
    app,
    /myAgents\(\)\.find\(\(candidate\) => candidate\.id === form\.dataset\.value\) \?\?\s*\n?\s*currentAgent\(\)/u,
  );
  assert.match(app, /delete state\.agentChatDrafts\[agent\.id\];/u);
});

test("Enter sends a direct message and Shift+Enter does not", async () => {
  const app = await publicFile("app.js");

  // Enter asks the form to submit; the case answering that submission used to
  // live in the click handler only, where the keyboard could never reach it.
  const submitListener = app.slice(app.indexOf('document.addEventListener("submit"'));
  assert.match(submitListener, /case "dm-submit": \{/u);
  assert.match(submitListener, /sendDirectMessage\(other, draft\)/u);

  const clickListener = app.slice(
    app.indexOf('document.addEventListener("click"'),
    app.indexOf('document.addEventListener("submit"'),
  );
  assert.doesNotMatch(clickListener, /case "dm-submit":/u);

  // Both private composers: a bare Enter sends, Shift+Enter is left alone to
  // put in a newline, and an IME committing a candidate is not a send.
  for (const composer of ["chat-input", "dm-input"]) {
    const handler = app.slice(app.indexOf(`node?.dataset?.act !== "${composer}"`));
    assert.match(
      handler.slice(0, 400),
      /event\.key === "Enter" && !event\.shiftKey && !imeComposing\(event\)/u,
    );
    assert.match(handler.slice(0, 400), /closest\("form"\)\?\.requestSubmit\(\)/u);
  }
});
