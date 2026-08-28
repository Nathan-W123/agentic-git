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
 * were typing to an agent, sending it at all, sending a direct message with
 * the keyboard, and typing a command or a name in either of them.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

/** Enough of a textarea for the pickers: a caret, and the id it carries. */
interface ComposerBox {
  dataset?: { value: string };
  selectionStart: number;
  focus: () => void;
  setSelectionRange: () => void;
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
  assert.match(
    submitListener,
    /sendDirectMessage\(other, draft, referencedMessageId\)/u,
  );

  const clickListener = app.slice(
    app.indexOf('document.addEventListener("click"'),
    app.indexOf('document.addEventListener("submit"'),
  );
  assert.doesNotMatch(clickListener, /case "dm-submit":/u);

  // Both private composers: a bare Enter sends, Shift+Enter is left alone to
  // put in a newline, and an IME committing a candidate is not a send.
  for (const composer of ["chat-input", "dm-input"]) {
    const start = app.indexOf(`node?.dataset?.act !== "${composer}"`);
    const handler = app.slice(start, app.indexOf("});", start));
    assert.match(
      handler,
      /event\.key === "Enter" && !event\.shiftKey && !imeComposing\(event\)/u,
    );
    assert.match(handler, /closest\("form"\)\?\.requestSubmit\(\)/u);
    // And the pickers are asked first, so the Enter that takes a highlighted
    // command is not also the Enter that sends the message.
    assert.match(handler, /if \(handleComposerKeydown\(event, render\)\) \{\s*\n\s*return;/u);
  }
});

test(
  "replying in a private chat preserves the current draft and selects the source message",
  async () => {
    const app = await publicFile("app.js");
    const chats = await publicFile("screen-chats.js");
    const css = await publicFile("styles.css");

    const replyCase = app.slice(
      app.indexOf('case "dm-reply-quote":'),
      app.indexOf('case "dm-reply-clear":'),
    );
    assert.match(replyCase, /state\.dmReplyMessageId = target\?\.id;/u);
    assert.doesNotMatch(replyCase, /state\.dmDraft\s*=/u);
    assert.match(chats, /directReplyChip\(replyTarget, name\)/u);
    assert.match(
      css,
      /\.composer-thread svg \{[\s\S]*?width: 14px;[\s\S]*?height: 14px;[\s\S]*?\}/u,
      "the reply marker should stay an icon instead of using the SVG's intrinsic size",
    );
  },
);

test("cancelling a private-chat reply clears the reference without replacing the draft", async () => {
  const app = await publicFile("app.js");
  const clearCase = app.slice(
    app.indexOf('case "dm-reply-clear":'),
    app.indexOf('case "dm-reference-jump":'),
  );

  assert.match(clearCase, /state\.dmReplyMessageId = undefined;/u);
  assert.doesNotMatch(clearCase, /state\.dmDraft\s*=/u);
});

test("a private chat sends the selected reply reference and clears it after sending", async () => {
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");
  const submitCase = app.slice(
    app.indexOf('case "dm-submit":'),
    app.indexOf('case "channel-submit":'),
  );

  assert.match(
    submitCase,
    /const referencedMessageId = state\.dmReplyMessageId;/u,
  );
  assert.match(submitCase, /state\.dmReplyMessageId = undefined;/u);
  assert.match(
    submitCase,
    /sendDirectMessage\(other, draft, referencedMessageId\)/u,
  );
  assert.match(data, /referencedMessageId === undefined/u);
  assert.match(data, /\{ referencedMessageId \}/u);
  assert.match(chats, /message\.referencedMessageId/u);
  assert.match(chats, /data-act="dm-reference-jump"/u);
});

test("direct-message references use bubble-specific geometry on both sides", async () => {
  const [chats, css] = await Promise.all([
    publicFile("screen-chats.js"),
    publicFile("styles.css"),
  ]);
  const reference = chats.slice(
    chats.indexOf("function directMessageReference("),
    chats.indexOf("function continuesDirectMessageGroup("),
  );

  assert.match(reference, /class="cmsg-ref cmsg-ref-dm"/u);
  assert.match(reference, /replyPreviewText\(target\)/u);
  assert.doesNotMatch(
    reference,
    /cmsg-ref-elbow/u,
    "a direct message should not borrow the channel avatar connector",
  );

  const incoming = /\n\.dm-msg > \.cmsg-ref \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  const outgoing = /\n\.dm-mine > \.cmsg-ref \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(incoming ?? "", /flex: none;/u);
  assert.match(incoming ?? "", /width: fit-content;/u);
  assert.match(incoming ?? "", /border-left: 2px solid/u);
  assert.match(outgoing ?? "", /align-self: flex-end;/u);
});

test("a private chat keeps the channel's command and name pickers", async () => {
  const chat = await publicFile("chat.js");
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");

  // The agent composer is drawn by `chat.js`, which the screens import rather
  // than the other way round — so it leaves the picker an empty surface and
  // the painter in `screen-chats.js` fills it after every render.
  assert.match(chat, /class="thread-composer-wrap chat-composer-wrap"/u);
  assert.match(chat, /<div data-chat-composer-suggestions><\/div>/u);
  assert.match(chats, /composerSuggestions\(repositoryId, "chat"\)/u);
  assert.match(app, /paintComposerSuggestions\(activeChannelId\(\)\)/u);

  // The direct-message composer draws its own, the way the thread panel does.
  assert.match(chats, /data-dm-composer-suggestions/u);
  assert.match(chats, /composerSuggestions\(repositoryId, "dm"\)/u);

  // Both boxes report their keystrokes to the shared presentation helper, so
  // "/" and "@" open the same lists they open in the channel.
  assert.match(app, /updateComposerPresentation\(node, "chat"\)/u);
  assert.match(app, /updateComposerPresentation\(node, "dm"\)/u);

  // A row in either list is picked by clicking it too, into the composer it
  // was opened from.
  for (const act of [
    "chat-mention-pick",
    "chat-slash-pick",
    "dm-mention-pick",
    "dm-slash-pick",
  ]) {
    assert.match(app, new RegExp(`case "${act}":`, "u"));
  }
  // And found without knowing the syntax: the private chat's "+" offers the
  // command list beside the mention it already offered.
  const menu = /case "composer-plus": \{([\s\S]*?)\n    \}/u.exec(app)?.[1];
  assert.match(menu ?? "", /act: "chat-slash-key"/u);
  assert.match(menu ?? "", /act: "chat-mention"/u);
});

test("a private agent chat has commands before any channel is opened", async () => {
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");

  // A private chat can be the first conversation opened after sign-in. Its
  // picker therefore falls back to the catalogue carried by the session,
  // rather than requiring a channel message request to have happened first.
  assert.match(data, /slashCommands: \[\],/u);
  assert.match(
    data,
    /state\.slashCommands = Array\.isArray\(principal\.slashCommands\)/u,
  );
  assert.match(
    chats,
    /Object\.values\(state\.channelSlashCommands\)\[0\] \?\?\s*state\.slashCommands/u,
  );
});

test("a pick lands in the private composer it was opened from", async () => {
  const chats = await publicFile("screen-chats.js");
  const start = chats.indexOf("function composerTarget");
  const end = chats.indexOf("\nexport function handleComposerKeydown", start);
  assert.notEqual(start, -1, "the composer target resolver should exist");
  assert.notEqual(end, -1, "the picker helpers should have a boundary");

  const state: {
    chatDraft: string;
    dmDraft: string;
    agentChatDrafts: Record<string, string>;
  } = {
    chatDraft: "channel stays put",
    dmDraft: "hi /pl",
    agentChatDrafts: { zeus: "look at @Mar" },
  };
  const boxes: Record<string, ComposerBox> = {
    "[data-act='chat-input']": {
      dataset: { value: "zeus" },
      selectionStart: 12,
      focus: () => undefined,
      setSelectionRange: () => undefined,
    },
    "[data-act='dm-input']": {
      selectionStart: 6,
      focus: () => undefined,
      setSelectionRange: () => undefined,
    },
  };
  const pickers = new Function(
    "state",
    "document",
    "draftText",
    `${chats
      .slice(start, end)
      .replaceAll("export function", "function")}\nreturn { pickMention, pickSlashCommand };`,
  )(
    state,
    { querySelector: (selector: string) => boxes[selector] ?? null },
    (value: string) => value,
  ) as {
    pickMention: (name: string, rerender: () => void, target: string) => void;
    pickSlashCommand: (name: string, rerender: () => void, target: string) => void;
  };

  // The agent's draft is one per agent rather than one field of `state`, so
  // the completion has to be written back through the box that names it.
  pickers.pickMention("Mary Jane", () => undefined, "chat");
  assert.equal(state.agentChatDrafts.zeus, "look at @Mary Jane ");
  assert.equal(state.chatDraft, "channel stays put");

  pickers.pickSlashCommand("plan", () => undefined, "dm");
  assert.equal(state.dmDraft, "hi /plan ");
  assert.equal(state.chatDraft, "channel stays put");
});

test("an open picker takes Enter in a private chat; a closed one leaves it to send", async () => {
  const chats = await publicFile("screen-chats.js");
  const source = chats
    .slice(chats.indexOf("export function handleComposerKeydown"))
    .replace("export function", "function");

  const state = {
    composerAutocompleteTarget: "chat",
    slashActive: true,
    slashIndex: 0,
    mentionActive: false,
    mentionIndex: 0,
  };
  const picks: Array<[string, string]> = [];
  let sent = 0;
  const handler = new Function(
    "state",
    "imeComposing",
    "channelSlashCandidates",
    "activeChannelId",
    "pickSlashCommand",
    "channelMentionCandidates",
    "pickMention",
    "submitThreadReply",
    "submitComposerMessage",
    `${source}\nreturn handleComposerKeydown;`,
  )(
    state,
    () => false,
    () => [{ name: "plan" }, { name: "ask" }],
    () => "repository",
    (name: string, _rerender: () => void, target: string) => {
      picks.push([name, target]);
    },
    () => [{ name: "Mary Jane" }],
    (name: string, _rerender: () => void, target: string) => {
      picks.push([name, target]);
    },
    () => {
      sent += 1;
    },
    () => {
      sent += 1;
    },
  ) as (
    event: {
      key: string;
      shiftKey?: boolean;
      target: { dataset: { act: string } };
      preventDefault: () => void;
    },
    rerender: () => void,
  ) => boolean;

  const press = (act: string, key: string) =>
    handler(
      { key, target: { dataset: { act } }, preventDefault: () => undefined },
      () => undefined,
    );

  // A list open over the agent's box: the arrows walk it and Enter takes the
  // row, exactly as in the channel.
  assert.equal(press("chat-input", "ArrowDown"), true);
  assert.equal(state.slashIndex, 1);
  assert.equal(press("chat-input", "Enter"), true);
  assert.deepEqual(picks.pop(), ["ask", "chat"]);
  assert.equal(sent, 0, "picking a command is not also sending the message");

  // Nothing open: the handler claims nothing, and the composer's own listener
  // submits the form it is in.
  state.slashActive = false;
  assert.equal(press("chat-input", "Enter"), false);
  assert.equal(press("dm-input", "Enter"), false);
  assert.equal(sent, 0, "a private composer sends through its own form");

  // The direct-message box steers its own list rather than the channel's.
  state.composerAutocompleteTarget = "dm";
  state.mentionActive = true;
  state.mentionIndex = 0;
  assert.equal(press("dm-input", "Tab"), true);
  assert.deepEqual(picks.pop(), ["Mary Jane", "dm"]);
});
