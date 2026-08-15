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
  contextPercentFor,
  loadProviderOptions,
  providerEffortOptions,
  providerModelOptions,
  state,
} from "./data.js";
import {
  agentFace,
  bar,
  clockTime,
  contextRing,
  esc,
  icon,
  iconButton,
  miniSelect,
  toast,
} from "./ui.js";

function conversationFor(agentId) {
  state.conversations[agentId] ??= [];
  return state.conversations[agentId];
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
  return `<header class="chat-head">
    ${agentFace(agent, 34)}
    <div style="min-width:0">
      <div class="ch-name">${esc(agent.name)}</div>
      <div class="ch-status" style="${
        agent.presence === "offline" ? "color:var(--text-3)" : ""
      }">${
        agent.presence === "offline"
          ? ""
          : '<span class="dot green"></span>'
      }${esc(presence)}</div>
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

export function chatThread(agent) {
  if (agent === undefined) {
    return `<div class="chat-thread"></div>`;
  }
  const entries = conversationFor(agent.id);
  if (entries.length === 0) {
    return `<div class="chat-thread">
      <p class="msg system">${
        agent.connected
          ? "This conversation is private to you."
          : `${esc(agent.name)} is not connected yet. Connect it from My Agents to start talking.`
      }</p>
    </div>`;
  }
  let lastDay = "";
  const rows = entries.map((entry) => {
    const day = new Date(entry.at ?? Date.now()).toDateString();
    let separator = "";
    if (day !== lastDay) {
      lastDay = day;
      const isToday = day === new Date().toDateString();
      separator = `<div class="thread-day">${isToday ? "Today" : esc(day)}</div>`;
    }
    if (entry.role === "system") {
      return `${separator}<p class="msg system">${esc(entry.content)}</p>`;
    }
    const mine = entry.role === "user";
    return `${separator}<div class="msg ${mine ? "user" : "agent"}">${esc(
      entry.content,
    )}<span class="msg-time">${esc(clockTime(entry.at))}${
      mine ? '<span class="tick">✓✓</span>' : ""
    }</span></div>`;
  });
  return `<div class="chat-thread" id="chat-thread">${rows.join("")}</div>`;
}

/**
 * The composer.
 *
 * Every control sits on one row under the text box, and the context indicator
 * is drawn at icon size beside the paperclip rather than as a chart — this
 * panel is for talking to an agent, not for reading telemetry.
 */
export function chatComposer(agent, placeholder = "Ask your agent to do anything...") {
  // Nothing can be sent to an agent that is not connected, so the composer
  // says so and stays out of the way rather than accepting a message and
  // failing it into a toast a moment later.
  if (agent !== undefined && agent.connected !== true) {
    return `<div class="composer composer-blocked">
      <p>${esc(agent.name)} is not connected, so it cannot be messaged yet.</p>
      <button class="btn btn-sm" data-act="agent-connect"
        data-value="${esc(agent.id)}">Connect ${esc(
          agent.name.split(" ")[0],
        )}</button>
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

  return `<form class="composer" data-act="chat-submit">
    <textarea data-act="chat-input" rows="1" spellcheck="true"
      enterkeyhint="send"
      placeholder="${esc(placeholder)}"${busy || !ready ? " disabled" : ""}></textarea>
    <div class="composer-bar">
      <button type="button" class="icon-btn" disabled
        title="Attachments are not available on this deployment">${icon("paperclip")}</button>
      ${iconButton("at", { act: "chat-mention", title: "Mention a file or agent" })}
      ${contextRing(contextPercentFor(agent?.id), true)}
      <span class="spacer"></span>
      ${miniSelect("chat-model", models, agent?.model ?? "", "Model")}
      ${miniSelect("chat-effort", efforts, agent?.effort ?? "", "Reasoning effort")}
      <button class="send-btn" type="submit" title="Send"${
        busy || !ready ? " disabled" : ""
      }>
        ${busy ? icon("clock") : icon("send")}
      </button>
    </div>
  </form>`;
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
  const response = await fetch(`${API_ROOT}/chat/stream`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson",
      "X-CSRF-Token": csrf(),
    },
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
  const response = await fetch(`${API_ROOT}/chat/complete`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-CSRF-Token": csrf(),
    },
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

function csrf() {
  return (
    document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("coord_csrf="))
      ?.slice("coord_csrf=".length) ?? ""
  );
}

/** Loads the model/effort lists the account reports, once per provider. */
export async function ensureAgentOptions(agentId, rerender) {
  if (agentId === undefined || state.providerOptions[agentId] !== undefined) {
    return;
  }
  await loadProviderOptions(agentId);
  rerender();
}
