/**
 * The private agent conversation.
 *
 * One user, one agent. Nothing here is shared with the rest of the project:
 * a conversation is held against that person's own provider connection, and
 * the only thing collaborators ever see is the work it produces, once that
 * work has been through the coordinator. The same component serves the Code
 * screen's side panel and the My Agents detail pane.
 */

import {
  API_ROOT,
  authorizeRequest,
  contextPercentFor,
  currentUserId,
  currentUserName,
  loadProviderOptions,
  messageFoldClip as clipFoldedMessageText,
  messageFoldEligible,
  messageFoldOpen,
  messageLengthNotice,
  messageTooLong,
  myAvatar,
  providerAllowsCustomModel,
  providerEffortOptions,
  providerModelOptions,
  state,
} from "./data.js";
import {
  agentFace,
  avatar,
  bar,
  clockTime,
  contextRing,
  esc,
  icon,
  iconButton,
  miniEditable,
  miniSelect,
  toast,
} from "./ui.js";

function conversationFor(agentId) {
  state.conversations[agentId] ??= [];
  return state.conversations[agentId];
}

function messageFoldClip(foldKey, content, renderBody) {
  const text = String(content ?? "");
  if (!messageFoldEligible(text)) {
    return renderBody(text);
  }
  const open = messageFoldOpen(foldKey);
  const shown = open ? text : clipFoldedMessageText(text);
  return `<div class="message-fold${open ? " is-open" : ""}">
    <div class="message-fold-body">${renderBody(shown)}</div>
    <button type="button" class="message-fold-toggle" data-act="message-fold-toggle"
      data-value="${esc(foldKey)}" aria-expanded="${open}">
      ${open ? "Show less" : "Show more"}
    </button>
  </div>`;
}

/**
 * What is half-typed to one agent.
 *
 * The composer's textarea is rebuilt on every render, and it used to be drawn
 * empty every time — so a background refresh arriving mid-sentence took the
 * message with it. The draft lives in `state` and is written back into the
 * box here, keyed by agent so two panels cannot share one draft.
 */
export function agentChatDraft(agentId) {
  return agentId === undefined ? "" : (state.agentChatDrafts[agentId] ?? "");
}

/* --------------------------------------------------------------- view ---- */

export function chatHeader(agent, { showClose = true } = {}) {
  if (agent === undefined) {
    return "";
  }
  const presence =
    agent.presence === "online"
      ? "Online"
      : agent.presence === "idle"
        ? "Idle"
        : "Offline";
  const progress = agent.task === undefined ? undefined : agent.progress;
  return `<header class="chat-head">
    ${agentFace(agent, 34, { status: agent.status, progress })}
    <div style="min-width:0">
      <div class="ch-name">${esc(agent.name)}</div>
      <div class="ch-status" style="${
        agent.presence === "offline" ? "color:var(--text-3)" : ""
      }">${esc(presence)}</div>
    </div>
    <span class="spacer"></span>
    ${iconButton("chevronDown", { act: "agent-switch", title: "Switch agent" })}
    ${iconButton("sliders", { act: "agent-settings", title: "Agent settings" })}
    ${showClose ? iconButton("close", { act: "chat-close", title: "Close chat" }) : ""}
  </header>`;
}

/**
 * The task-progress bar.
 *
 * Just the bar and its figure: what the agent is doing is already the subject
 * of the conversation underneath it, so a sentence restating it is noise.
 */
export function chatProgress(agent) {
  if (agent?.task === undefined) {
    return "";
  }
  return `<div class="chat-progress">
    ${bar(agent.progress, "", true)}
    <span class="pct">${Math.round(agent.progress)}%</span>
  </div>`;
}

/**
 * Whether one private-chat message continues the same speaker's uninterrupted
 * run. System notices and date boundaries are transcript structure rather
 * than speech, so neither can be folded into the messages around it.
 */
function continuesPrivateChatMessageGroup(previous, current, startsNewDay) {
  if (previous === undefined || startsNewDay) {
    return false;
  }
  const role = current?.role;
  return (
    (role === "user" || role === "assistant") && previous.role === role
  );
}

export function chatThread(agent) {
  if (agent === undefined) {
    return `<div class="chat-thread"></div>`;
  }
  const entries = conversationFor(agent.id);
  if (entries.length === 0) {
    return `<div class="chat-thread">
      <p class="msg system transcript-separator"><span>${
        agent.connected
          ? "This conversation is private to you."
          : `${esc(agent.name)} is not connected yet. Connect it from My Agents to start talking.`
      }</span></p>
    </div>`;
  }
  let lastDay = "";
  const rows = entries.map((entry, index) => {
    const day = new Date(entry.at ?? Date.now()).toDateString();
    let separator = "";
    const startsNewDay = day !== lastDay;
    if (startsNewDay) {
      lastDay = day;
      const isToday = day === new Date().toDateString();
      separator = `<div class="thread-day transcript-separator"><span>${
        isToday ? "Today" : esc(day)
      }</span></div>`;
    }
    if (entry.role === "system") {
      return `${separator}<p class="msg system transcript-separator"><span>${esc(entry.content)}</span></p>`;
    }
    const mine = entry.role === "user";
    const compact = continuesPrivateChatMessageGroup(
      entries[index - 1],
      entry,
      startsNewDay,
    );
    // Same shape the channel uses — face, name, time, then the words — so a
    // private turn reads like the room beside it. The only difference is
    // whose side the row sits on: yours on the right, the agent's on the left.
    const speakerName = mine ? currentUserName() : agent.name;
    const face = mine
      ? avatar(
          currentUserName(),
          32,
          currentUserId() || currentUserName(),
          myAvatar(),
        )
      : agentFace(agent, 32, {
          status: agent.status,
          progress: agent.task === undefined ? undefined : agent.progress,
        });
    return `${separator}<div class="msg ${mine ? "user" : "agent"}${
      compact ? " msg-compact" : ""
    }">${
      compact ? "" : `<span class="msg-avatar">${face}</span>`
    }<div class="msg-body">${
      compact
        ? ""
        : `<div class="msg-top">
            <span class="msg-name${mine ? "" : " agent-name"}">${esc(
              speakerName,
            )}</span>
            <span class="msg-time">${esc(clockTime(entry.at))}${
              mine
                ? `<span class="tick" title="Delivered" aria-label="Delivered">${icon(
                    "doubleCheck",
                  )}</span>`
                : ""
            }</span>
          </div>`
    }<div class="msg-text">${messageFoldClip(
      `chat:${agent.id}|${String(entry.at ?? index)}`,
      entry.content,
      (shown) => esc(shown),
    )}</div></div></div>`;
  });
  return `<div class="chat-thread" id="chat-thread">${rows.join("")}</div>`;
}

/**
 * The length counter every composer carries, on the row beside send.
 *
 * It lives here rather than in a screen because all four composers need the
 * same one — the room, a thread, a private conversation and this panel — and
 * this module is the only one each of them already imports without importing
 * each other. The span is always drawn, and hidden while there is nothing to
 * say, so `paintComposerCount` can update it on a keystroke without a render.
 */
export function composerCount(target, text) {
  const notice = messageLengthNotice(text, target);
  return `<span class="composer-count${
    notice?.over === true ? " is-over" : ""
  }" data-composer-count="${esc(target)}" aria-live="polite"${
    notice === undefined ? " hidden" : ""
  }>${esc(notice?.text ?? "")}</span>`;
}

/**
 * Puts the current count on screen, without rebuilding anything.
 *
 * A render per keystroke is what the composers deliberately avoid — it throws
 * away the textarea being typed into — so the counter is written straight to
 * the node, the same way the box's own height is.
 */
export function paintComposerCount(node, target = "channel", text) {
  const form = node?.closest?.(".composer") ?? undefined;
  const label = form?.querySelector?.("[data-composer-count]");
  if (form === undefined || label === null || label === undefined) {
    return;
  }
  const notice = messageLengthNotice(text ?? node?.value ?? "", target);
  label.textContent = notice?.text ?? "";
  label.hidden = notice === undefined;
  label.classList.toggle("is-over", notice?.over === true);
  // The form carries it too: over the limit the send arrow goes quiet, so the
  // refusal is visible before the button is pressed rather than only after.
  form.classList.toggle("is-over-limit", notice?.over === true);
}

/**
 * The composer.
 *
 * Every control sits on one row under the text box: one "+" on the left for
 * anything being added to the message, and send on the right. The context
 * indicator is drawn at icon size rather than as a chart — this panel is for
 * talking to an agent, not for reading telemetry.
 */
export function chatComposer(agent, placeholder = "Ask your agent to do anything...") {
  // Nothing can be sent to an agent that is not connected, so the composer
  // says so and stays out of the way rather than accepting a message and
  // failing it into a toast a moment later.
  if (agent !== undefined && agent.connected !== true) {
    const connecting = state.providerConnecting?.has(agent.id) === true;
    return `<div class="composer composer-blocked">
      <p>${esc(agent.name)} is not connected, so it cannot be messaged yet.</p>
      <button class="btn btn-sm${connecting ? " connecting" : ""}" data-act="agent-connect"
        data-value="${esc(agent.id)}"${
          connecting
            ? ' disabled aria-busy="true" title="Connecting…" aria-label="Connecting…"'
            : ""
        }>${
          connecting
            ? "Connecting…"
            : `Connect ${esc(agent.name.split(" ")[0])}`
        }</button>
    </div>`;
  }
  // The same two helpers the channel roster's pickers read. They used to be
  // two independent readings of the same state, and the other one had drifted
  // — it never learned that Codex hangs its reasoning levels off each model
  // rather than off the provider, which this one has always handled.
  const models = providerModelOptions(agent?.id).map((model) => ({
    value: model.value,
    label: shortModel(model.label),
  }));
  const efforts = providerEffortOptions(agent?.id, agent?.model);
  const busy = state.sending[agent?.id] === true;
  const ready = agent !== undefined;

  // The agent is named on the form and on the box itself. `currentAgent` reads
  // the Code screen's selection, which nothing sets when this composer is the
  // one in the channel's agent panel — so a message sent from there went to
  // whichever agent happened to be first, or to none at all. The id on the box
  // is also what tells a keystroke which draft it belongs to.
  const agentId = esc(agent?.id ?? "");
  // Wrapped, because the "/" and "@" pickers open upward out of the box and
  // need something positioned to open out of — the same wrapper the thread's
  // reply box uses, so the two look and sit identically. The surface inside
  // it is left empty here and filled by `paintComposerSuggestions` after
  // every render: this module is imported by the screens rather than the
  // other way round, so it cannot ask them for that markup.
  return `<div class="thread-composer-wrap chat-composer-wrap">
    <div data-chat-composer-suggestions></div>
    <form class="composer" data-act="chat-submit" data-value="${agentId}">
      <textarea data-act="chat-input" data-value="${agentId}" rows="1"
        spellcheck="true" enterkeyhint="send"
        placeholder="${esc(placeholder)}"${
          busy || !ready ? " disabled" : ""
        }>${esc(agentChatDraft(agent?.id))}</textarea>
      <div class="composer-bar">
        ${iconButton("plus", {
          act: "composer-plus",
          value: "chat",
          title: "Add to this message",
          cls: "composer-plus",
        })}
        ${contextRing(contextPercentFor(agent?.id), true)}
        <span class="spacer"></span>
        ${
          models.length > 0
            ? miniSelect("chat-model", models, agent?.model ?? "", "Model")
            : providerAllowsCustomModel(agent?.id)
              ? miniEditable(
                  "chat-model",
                  agent?.model ?? "",
                  "Model",
                  "Nothing lists what this account may use, so a model id " +
                    "typed here is passed through as given; empty runs the " +
                    "CLI's own default.",
                )
              : ""
        }
        ${miniSelect("chat-effort", efforts, agent?.effort ?? "", "Reasoning effort")}
        ${composerCount("chat", agentChatDraft(agent?.id))}
        <button class="send-btn" type="submit" title="Send"${
          busy || !ready ? " disabled" : ""
        }>
          ${busy ? icon("clock") : icon("send")}
        </button>
      </div>
    </form>
  </div>`;
}

function shortModel(label) {
  return String(label).replace(/^(claude|gpt|gemini|codex)[-\s]/iu, "");
}

/** The whole panel, as used by the Code screen. */
export function chatPanel(agent) {
  return `<aside class="chat-pane" id="chat-pane">
    ${chatHeader(agent)}
    <div style="display:grid;grid-template-rows:auto 1fr;min-height:0">
      ${chatProgress(agent)}
      ${chatThread(agent)}
    </div>
    ${chatComposer(agent, `Ask ${agent?.name?.split(" ")[0] ?? "your agent"} to do anything...`)}
  </aside>`;
}

/* ------------------------------------------------------------ sending ---- */

export function scrollThread() {
  const thread = document.querySelector("#chat-thread");
  if (thread !== null) {
    thread.scrollTop = thread.scrollHeight;
  }
}

/**
 * Sends one turn.
 *
 * Streaming first, because a CLI-backed agent can take a while and a silent
 * panel reads as a hang. If the deployment has no streaming operation the
 * one-shot completion is used instead; either way the reply is appended once.
 */
export async function sendChat(agentId, text, rerender) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "" || state.sending[agentId]) {
    return;
  }
  // Before the turn is pushed into the conversation, so an over-long message
  // never becomes a row the panel then has to fail: the provider would refuse
  // it anyway, and the caller keeps the draft to shorten.
  const tooLong = messageTooLong(trimmed, "chat");
  if (tooLong !== undefined) {
    toast(tooLong, "error");
    return;
  }
  const conversation = conversationFor(agentId);
  conversation.push({ role: "user", content: trimmed, at: new Date().toISOString() });
  state.sending[agentId] = true;
  rerender();
  scrollThread();

  const messages = conversation
    .filter((entry) => entry.role === "user" || entry.role === "assistant")
    .map((entry) => ({ role: entry.role, content: entry.content }));
  const body = {
    provider: agentId,
    messages,
    ...(state.cliSessions?.[agentId]
      ? { cliSessionId: state.cliSessions[agentId] }
      : {}),
  };

  try {
    const reply = await streamChat(body, rerender);
    state.cliSessions ??= {};
    if (reply.cliSessionId) {
      state.cliSessions[agentId] = reply.cliSessionId;
    }
    const pending = conversation.find((entry) => entry.pending);
    const record = {
      role: "assistant",
      content: reply.text ?? "",
      at: new Date().toISOString(),
      usage: reply.usage,
      contextWindow: reply.contextWindow,
      model: reply.model,
    };
    if (pending === undefined) {
      conversation.push(record);
    } else {
      Object.assign(pending, record, { pending: false });
    }
  } catch (error) {
    const index = conversation.findIndex((entry) => entry.pending);
    if (index >= 0) {
      conversation.splice(index, 1);
    }
    conversation.push({
      role: "system",
      content: error.message,
      at: new Date().toISOString(),
    });
    toast(error.message, "error");
  } finally {
    state.sending[agentId] = false;
    rerender();
    scrollThread();
  }
}

async function streamChat(body, rerender) {
  const conversation = conversationFor(body.provider);
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/x-ndjson",
  });
  const response = await fetch(`${API_ROOT}/chat/stream`, {
    method: "POST",
    credentials: authorizeRequest(headers, "POST"),
    headers,
    body: JSON.stringify(body),
  });

  if (response.status === 501 || response.status === 404) {
    return await completeChat(body);
  }
  if (!response.ok || response.body === null) {
    const failure = await response.json().catch(() => ({}));
    throw new Error(
      failure?.error?.message ?? `Chat failed with status ${response.status}`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pending;
  let finished;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") {
        continue;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "error") {
        throw new Error(event.message ?? "The agent could not reply");
      }
      if (event.type === "done") {
        finished = event.reply;
        continue;
      }
      const delta = event.text ?? event.delta ?? "";
      if (delta === "") {
        continue;
      }
      if (pending === undefined) {
        pending = {
          role: "assistant",
          content: "",
          at: new Date().toISOString(),
          pending: true,
        };
        conversation.push(pending);
      }
      pending.content += delta;
      rerender();
      scrollThread();
    }
  }
  if (finished !== undefined) {
    return finished;
  }
  if (pending !== undefined) {
    return { text: pending.content, usage: {} };
  }
  return await completeChat(body);
}

async function completeChat(body) {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  const response = await fetch(`${API_ROOT}/chat/complete`, {
    method: "POST",
    credentials: authorizeRequest(headers, "POST"),
    headers,
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      data?.error?.message ?? `Chat failed with status ${response.status}`,
    );
  }
  return data.reply ?? { text: "", usage: {} };
}


/** Loads the model/effort lists the account reports, once per provider. */
export async function ensureAgentOptions(agentId, rerender) {
  if (agentId === undefined || state.providerOptions[agentId] !== undefined) {
    return;
  }
  await loadProviderOptions(agentId);
  rerender();
}
