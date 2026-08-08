/**
 * My Agents — the signed-in user's own agent connections, and their private
 * detail pane.
 *
 * Scoped to one person on purpose. An agent connection is a personal
 * credential and a personal conversation; two people working the same
 * repository each bring their own Claude or Codex, and neither should appear
 * in the other's list. Everything genuinely shared — what the agents are
 * doing to the codebase — lives on the Coordinator screen instead.
 */

import { api, myAgents, persist, state, taskProgress } from "./data.js";
import { chatComposer, chatThread } from "./chat.js";
import {
  agentFace,
  badge,
  bar,
  esc,
  icon,
  iconButton,
  emptyState,
  searchBox,
  statTile,
  tabs,
  toast,
} from "./ui.js";

function filtered(agents) {
  const query = state.agentQuery.trim().toLowerCase();
  return agents.filter((agent) => {
    if (state.agentFilter === "working" && agent.status !== "working") {
      return false;
    }
    if (state.agentFilter === "idle" && agent.status !== "idle") {
      return false;
    }
    if (state.agentFilter === "offline" && agent.status !== "offline") {
      return false;
    }
    return query === "" || agent.name.toLowerCase().includes(query);
  });
}

function agentRow(agent, active) {
  const task = agent.task;
  // A div, not a button: the row carries its own menu button, and a nested
  // <button> makes the parser close the outer one and hoist the inner out of
  // the row entirely.
  return `<div class="agent-row${active ? " active" : ""}" role="button" tabindex="0"
    data-act="agent-pick" data-value="${esc(agent.id)}">
    <span class="ar-face">${agentFace(agent, 34)}</span>
    <span class="ar-id">
      <div class="ar-name">${esc(agent.name)}</div>
      <div class="ar-role">${esc(agent.role)}</div>
    </span>
    <span class="ar-badge">${badge(agent.status)}</span>
    <span class="ar-task">
      <div class="ar-task-name">${icon(task === undefined ? "pause" : "file")}
        ${esc(task?.objective ?? (agent.connected ? "No task assigned" : "Connection unavailable"))}</div>
      <div class="ar-task-path">${esc(
        task === undefined
          ? agent.connected
            ? "Ready for new assignment"
            : (agent.detail ?? "Not connected")
          : `${task.repositoryId ?? ""}`,
      )}</div>
    </span>
    <span class="ar-prog">${bar(agent.progress, agent.status === "working" ? "" : "grey")}
      <span class="ar-pct">${Math.round(agent.progress)}%</span></span>
    <span class="ar-more">${iconButton("dots", {
      act: "agent-menu",
      value: agent.id,
      title: "Agent actions",
      small: true,
    })}</span>
  </div>`;
}

function detailPane(agent) {
  if (agent === undefined) {
    return `<section class="card agent-panel">${emptyState(
      "robot",
      "No agent selected",
      "Connect an agent to start a private conversation about this repository.",
    )}</section>`;
  }
  const tab = state.agentTab ?? "chat";
  const window = agent.contextPercent > 0 ? `${agent.contextPercent}% context` : "";
  return `<section class="card agent-panel">
    <header class="agent-panel-head">
      ${agentFace(agent, 40)}
      <div style="min-width:0">
        <div class="aph-name">${esc(agent.name)}
          <span class="ch-status" style="font-weight:400">${
            agent.presence === "offline" ? "" : '<span class="dot green"></span>'
          }${esc(agent.presence === "offline" ? "Offline" : agent.presence === "idle" ? "Idle" : "Online")}</span>
        </div>
        <div class="aph-meta">${esc(
          [agent.model || "Model unset", window].filter(Boolean).join(" · "),
        )}</div>
      </div>
      <span class="spacer"></span>
      ${iconButton("info", { act: "agent-info", title: "Connection details" })}
      ${iconButton("chart", { act: "agent-usage", title: "Usage" })}
      ${iconButton("dots", { act: "agent-menu", value: agent.id, title: "More" })}
    </header>

    ${tabs(
      "agent-tab",
      [
        { value: "chat", label: "Chat" },
        { value: "task", label: "Task" },
        { value: "files", label: "Files" },
        { value: "metrics", label: "Metrics" },
      ],
      tab,
    )}

    ${tab === "chat" ? chatThread(agent) : `<div class="scroll">${tabBody(tab, agent)}</div>`}
    ${tab === "chat" ? chatComposer(agent, `Message ${agent.name.split(" ")[0]}...`) : ""}
  </section>`;
}

function tabBody(tab, agent) {
  if (tab === "task") {
    const task = agent.task;
    if (task === undefined) {
      return `<div style="padding:18px">${emptyState(
        "pause",
        "No task assigned",
        "This agent is connected and waiting for work.",
      )}</div>`;
    }
    return `<div style="padding:16px 18px;display:grid;gap:14px">
      <div>
        <div class="ar-name">${esc(task.objective)}</div>
        <div class="ar-role">${esc(task.repositoryId ?? "")} · ${esc(task.status)}</div>
      </div>
      <div class="ar-prog">${bar(taskProgress(task))}
        <span class="ar-pct">${taskProgress(task)}%</span></div>
      <div class="sum-actions">
        <button class="btn btn-sm" data-act="task-cancel" data-value="${esc(task.id)}">
          Cancel task
        </button>
        <button class="btn btn-sm" data-act="task-retry" data-value="${esc(task.id)}">
          Retry
        </button>
      </div>
    </div>`;
  }
  if (tab === "files") {
    const files = state.changeSet?.patches ?? [];
    if (files.length === 0) {
      return `<div style="padding:18px">${emptyState(
        "file",
        "No files touched yet",
        "Files this agent changes appear here once a changeset is collected.",
      )}</div>`;
    }
    return `<div style="padding:12px 18px">${files
      .map(
        (patch) =>
          `<div class="sum-file"><b class="flag-${
            patch.status === "added" ? "A" : patch.status === "deleted" ? "D" : "M"
          }">${patch.status === "added" ? "A" : patch.status === "deleted" ? "D" : "M"}</b>
          <span class="sf-name">${esc(patch.path)}</span></div>`,
      )
      .join("")}</div>`;
  }
  const conversation = state.conversations[agent.id] ?? [];
  const replies = conversation.filter((entry) => entry.role === "assistant");
  const totals = replies.reduce(
    (sum, entry) => ({
      input: sum.input + Number(entry.usage?.inputTokens ?? 0),
      output: sum.output + Number(entry.usage?.outputTokens ?? 0),
      cost: sum.cost + Number(entry.usage?.costUsd ?? 0),
    }),
    { input: 0, output: 0, cost: 0 },
  );
  return `<div style="padding:16px 18px;display:grid;gap:11px">
    <div class="set-row" style="padding:0 0 11px">
      <span class="sr-body"><div class="sr-title">Replies this session</div></span>
      <span class="sr-ctl">${replies.length}</span>
    </div>
    <div class="set-row" style="padding:0 0 11px">
      <span class="sr-body"><div class="sr-title">Tokens in / out</div></span>
      <span class="sr-ctl">${totals.input.toLocaleString()} / ${totals.output.toLocaleString()}</span>
    </div>
    <div class="set-row" style="padding:0">
      <span class="sr-body"><div class="sr-title">Context used</div></span>
      <span class="sr-ctl">${agent.contextPercent}%</span>
    </div>
    ${
      totals.cost > 0
        ? `<div class="set-row" style="padding:11px 0 0"><span class="sr-body">
            <div class="sr-title">Reported spend</div></span>
            <span class="sr-ctl">$${totals.cost.toFixed(2)}</span></div>`
        : ""
    }
  </div>`;
}

export function renderAgents() {
  const agents = myAgents();
  const shown = filtered(agents);
  const selected =
    agents.find((agent) => agent.id === state.selectedAgent) ?? agents[0];
  const working = agents.filter((agent) => agent.status === "working").length;
  const idle = agents.filter((agent) => agent.status === "idle").length;
  const offline = agents.filter((agent) => agent.status === "offline").length;
  const done = state.tasks.filter((task) => task.status === "integrated").length;

  return `<div class="scroll"><div class="page">
    <div class="page-head">
      <span class="ph-icon">${icon("robot")}</span>
      <div>
        <h1>My Agents</h1>
        <p>Manage your agents, their assignments, and performance.</p>
      </div>
      <span class="spacer"></span>
      <button class="btn btn-primary" data-act="agent-add">${icon("plus")} Add Agent</button>
    </div>

    <div class="stat-row">
      ${statTile({
        value: agents.filter((agent) => agent.connected).length,
        label: "Active agents",
        foot: `<span class="dot green"></span> ${
          offline === 0 ? "All systems go" : `${offline} offline`
        }`,
        iconName: "robot",
        tone: "green",
      })}
      ${statTile({
        value: working,
        label: "Working",
        foot: `<span class="dot blue"></span> On current tasks`,
        iconName: "clock",
        tone: "blue",
      })}
      ${statTile({
        value: idle,
        label: "Idle",
        foot: `<span class="dot orange"></span> Ready for tasks`,
        iconName: "users",
        tone: "orange",
      })}
      ${statTile({
        value: done,
        label: "Completed",
        foot: `<span class="dot grey"></span> Across all agents`,
        iconName: "checkCircle",
        tone: "purple",
      })}
    </div>

    <div class="agents-split">
      <section class="card">
        <div class="agent-list-head">
          ${tabs(
            "agent-filter",
            [
              { value: "all", label: "All Agents", count: agents.length },
              { value: "working", label: "Working", count: working },
              { value: "idle", label: "Idle", count: idle },
              { value: "offline", label: "Offline", count: offline },
            ],
            state.agentFilter,
          )}
          <span class="spacer" style="flex:1"></span>
          <span style="width:190px">${searchBox(
            "Search agents...",
            state.agentQuery,
            "agent-search",
          )}</span>
          ${iconButton("filter", { act: "agent-filter-more", title: "Filter" })}
        </div>
        ${
          shown.length === 0
            ? emptyState(
                "robot",
                agents.length === 0 ? "No agents connected" : "No agents match",
                agents.length === 0
                  ? "Connect Claude, Codex, or Gemini to give yourself an agent on this project."
                  : "Try another filter or search term.",
              )
            : `<div class="agent-rows">
                ${shown
                  .map((agent) => agentRow(agent, agent.id === selected?.id))
                  .join("")}
              </div>
              <div class="agent-list-foot">
                <button data-act="agent-all">View all agents ${icon("arrowRight")}</button>
              </div>`
        }
      </section>

      ${detailPane(selected)}
    </div>
  </div></div>`;
}

/* ------------------------------------------------------------ actions ---- */

export function selectAgent(agentId, rerender) {
  state.selectedAgent = agentId;
  persist("ag.agent", agentId);
  rerender();
}

/** Connecting an agent is a sign-in against that provider's own CLI. */
export async function connectAgent(providerId, rerender) {
  try {
    const response = await api(
      `/chat/providers/${encodeURIComponent(providerId)}`,
      { method: "POST", body: {} },
    );
    state.providers = response.providers ?? state.providers;
    toast(`${providerId} connected`, "ok");
    rerender();
  } catch (error) {
    toast(error.message, "error");
  }
}

export async function cancelTask(taskId, rerender) {
  try {
    await api(`/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
      body: {},
    });
    toast("Task cancelled", "ok");
    rerender();
  } catch (error) {
    toast(error.message, "error");
  }
}

export async function retryTask(taskId, rerender) {
  try {
    await api(`/tasks/${encodeURIComponent(taskId)}/retry`, {
      method: "POST",
      body: {},
    });
    toast("Task requeued", "ok");
    rerender();
  } catch (error) {
    toast(error.message, "error");
  }
}
