/**
 * Coordinator — the one project-wide view.
 *
 * This screen is allowed to see every agent's work, because scheduling and
 * conflict prevention are exactly what it does. It is deliberately not a
 * metrics dashboard: what a person needs here is who is working, what is
 * waiting, what is held, and whether anything needs them — not a wall of
 * charts.
 */

import {
  activeTasks,
  agentColorFor,
  coordinatorActivity,
  conflictCount,
  heldFiles,
  integrations,
  myAgents,
  socketLive,
  state,
  systemHealth,
  taskProgress,
  taskStarted,
  waitingTasks,
} from "./data.js";
import {
  agentFace,
  agentLabelOf,
  bar,
  chip,
  clockTime,
  dot,
  esc,
  icon,
  emptyState,
  relativeTime,
  tabs,
} from "./ui.js";

const NODE_TONES = ["purple", "blue", "orange", "green"];

/** One connector per occupied quadrant, so an empty slot draws no line. */
const CONNECTORS = [
  "M34 38 L45 47",
  "M66 38 L55 47",
  "M34 62 L45 53",
  "M66 62 L55 53",
];

const STATUS_LABEL = {
  planning: "In Progress",
  running: "Running",
  replanning: "Replanning",
  validating: "Validating",
  queued: "Waiting",
  approved: "Waiting",
  claimed: "Running",
  awaiting_approval: "Waiting",
  submitted: "Waiting",
};

function flowDiagram() {
  const tasks = activeTasks().slice(0, 4);
  if (tasks.length === 0) {
    return `<div class="panel-body">${emptyState(
      "network",
      "Nothing executing",
      "When agents are working, their tasks appear here routed through the coordinator.",
    )}</div>`;
  }
  const nodes = tasks
    .map((task, index) => {
      const tone = NODE_TONES[index % NODE_TONES.length];
      const label = STATUS_LABEL[task.status] ?? task.status;
      // Colour by who submitted the task, not by which vendor answered it:
      // on this screen the question is whose agent is holding things up.
      const agent = {
        provider: task.agentId,
        presence: "online",
        color: agentColorFor(task.submittedBy),
      };
      return `<div class="flow-node ${tone}">
        <div class="fn-head">
          ${agentFace(agent, 28)}
          <span style="min-width:0">
            <div class="fn-name">${esc(agentLabelOf(task.agentId))}</div>
            <div class="fn-task">${esc(truncate(task.objective, 22))}</div>
          </span>
        </div>
        ${chip(label, tone === "purple" ? "purple" : tone)}
      </div>`;
    })
    .join("");

  return `<div class="panel-body">
    <div class="flow">
      <svg class="flow-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        ${CONNECTORS.slice(0, tasks.length)
          .map((path) => `<path d="${path}"/>`)
          .join("")}
      </svg>
      ${nodes}
      <div class="flow-core">
        ${agentFace({ provider: "generic", presence: "online", name: "Coordinator" }, 34)}
        <div class="fc-name">Coordinator</div>
        <div class="fc-sub">Orchestrating</div>
      </div>
    </div>
    <div class="flow-legend">
      <span>${dot("purple")}In Progress</span>
      <span>${dot("blue")}Running</span>
      <span>${dot("orange")}Waiting</span>
      <span>${dot("grey")}Idle</span>
    </div>
  </div>`;
}

function truncate(value, length) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function activityPanel() {
  const rows = coordinatorActivity(6);
  return `<section class="card">
    <div class="panel-head">
      <div><h3>Recent activity</h3><p>What the coordinator is doing</p></div>
    </div>
    <div class="panel-body">
      ${
        rows.length === 0
          ? emptyState("history", "No activity yet", "Coordinator decisions appear here as work runs.")
          : rows
              .map(
                (row) => `<div class="act-row">
                  <span class="act-time">${esc(clockTime(row.at))}</span>
                  <span class="act-icon" style="color:${activityTone(row.type)}">
                    ${icon(activityIcon(row.type))}</span>
                  <span>
                    <div class="act-title">${esc(row.title)}</div>
                    <div class="act-sub">${esc(truncate(row.detail, 54))}</div>
                  </span>
                  <span>${row.agent ? chip(agentLabelOf(row.agent)) : ""}</span>
                </div>`,
              )
              .join("")
      }
      <div style="padding-top:12px">
        <button class="link" data-act="go-notifications"
          style="color:var(--accent-bright);font-size:12px">View full activity</button>
      </div>
    </div>
  </section>`;
}

function activityIcon(type) {
  return (
    {
      canonical_promoted: "git",
      conflict_detected: "layers",
      scope_granted: "lock",
      approval_requested: "alert",
      approval_decided: "checkCircle",
      task_failed: "alert",
      validation_completed: "checkCircle",
      plan_received: "clock",
      lease_released: "lock",
    }[type] ?? "info"
  );
}

function activityTone(type) {
  return (
    {
      canonical_promoted: "var(--green)",
      conflict_detected: "var(--orange)",
      task_failed: "var(--red)",
      approval_requested: "var(--orange)",
      scope_granted: "var(--green)",
    }[type] ?? "var(--blue)"
  );
}

function tasksPanel() {
  const tasks = activeTasks();
  return `<section class="card">
    <div class="panel-head">
      <div><h3>Active tasks</h3><p>${tasks.length} in progress</p></div>
      <span class="spacer"></span>
      <button class="link" data-act="go-code">View all</button>
    </div>
    <div class="panel-body">
      ${
        tasks.length === 0
          ? `<p style="color:var(--text-3);font-size:12.5px">Nothing is executing right now.</p>`
          : `<div class="mini-list">${tasks
              .slice(0, 6)
              .map((task, index) => {
                const tone = NODE_TONES[index % NODE_TONES.length];
                return `<div class="mini-task">
                  ${dot(tone === "purple" ? "purple" : tone)}
                  <span class="mt-name" title="${esc(task.objective)}">${esc(
                    task.objective,
                  )}</span>
                  ${
                    taskStarted(task)
                      ? `${bar(taskProgress(task), tone === "purple" ? "" : tone)}
                         <span class="mt-pct">${taskProgress(task)}%</span>`
                      : `<span class="mt-stage">${esc(
                          STATUS_LABEL[task.status] ?? task.status,
                        )}</span>`
                  }
                </div>`;
              })
              .join("")}</div>`
      }
    </div>
  </section>`;
}

function locksPanel() {
  const locks = heldFiles();
  return `<section class="card">
    <div class="panel-head">
      <div><h3>Locks</h3><p>${locks.length} active lock${
        locks.length === 1 ? "" : "s"
      }</p></div>
      <span class="spacer"></span>
      <button class="link" data-act="coord-tab" data-value="locks">View all</button>
    </div>
    <div class="panel-body">
      ${
        locks.length === 0
          ? `<p style="color:var(--text-3);font-size:12.5px">No file is held right now.</p>`
          : locks
              .slice(0, 4)
              .map(
                (lock) => `<div class="lock-row">
                  <span class="act-icon" style="color:var(--text-3)">${icon("file")}</span>
                  <span class="lr-body">
                    <div class="lr-file">${esc(lock.path)}</div>
                    <div class="lr-state">Editing</div>
                  </span>
                  <span class="lr-right">
                    ${chip(agentLabelOf(lock.agentId))}
                    <div class="lr-time">${esc(clockTime(lock.since))}</div>
                  </span>
                </div>`,
              )
              .join("")
      }
    </div>
  </section>`;
}

function integrationsPanel() {
  const rows = integrations();
  const connected = rows.filter((row) => row.connected).length;
  return `<section class="card">
    <div class="panel-head">
      <div><h3>Integrations</h3><p>${connected} connected</p></div>
      <span class="spacer"></span>
      <button class="link" data-act="go-settings">View all</button>
    </div>
    <div class="panel-body">
      ${rows
        .map(
          (row) => `<div class="integ-row">
            <span class="ir-icon">${icon(row.iconName)}</span>
            <span class="ir-name" title="${esc(row.detail)}">${esc(row.name)}</span>
            <span class="ir-state">${esc(
              row.connected ? "Connected" : "Not configured",
            )}${dot(row.connected ? "green" : "grey")}</span>
          </div>`,
        )
        .join("")}
    </div>
  </section>`;
}

function locksTab() {
  const locks = heldFiles();
  return `<section class="card">
    <div class="panel-head"><div><h3>Held resources</h3>
      <p>Files claimed by plans the coordinator has admitted</p></div></div>
    <div class="panel-body">
      ${
        locks.length === 0
          ? emptyState("lock", "Nothing held", "Resource leases appear here while agents execute.")
          : locks
              .map(
                (lock) => `<div class="lock-row">
                  <span class="act-icon" style="color:var(--text-3)">${icon("lock")}</span>
                  <span class="lr-body">
                    <div class="lr-file">${esc(lock.path)}</div>
                    <div class="lr-state">Task ${esc(String(lock.taskId).slice(0, 10))}</div>
                  </span>
                  <span class="lr-right">${chip(agentLabelOf(lock.agentId))}
                    <div class="lr-time">${esc(relativeTime(lock.since))}</div></span>
                </div>`,
              )
              .join("")
      }
    </div>
  </section>`;
}

function activityTab() {
  const rows = coordinatorActivity(40);
  return `<section class="card">
    <div class="panel-head"><div><h3>Coordinator activity</h3>
      <p>Every scheduling decision, newest first</p></div></div>
    <div class="panel-body">
      ${
        rows.length === 0
          ? emptyState("history", "No activity yet", "Decisions appear here as work runs.")
          : rows
              .map(
                (row) => `<div class="act-row">
                  <span class="act-time">${esc(clockTime(row.at))}</span>
                  <span class="act-icon" style="color:${activityTone(row.type)}">
                    ${icon(activityIcon(row.type))}</span>
                  <span><div class="act-title">${esc(row.title)}</div>
                  <div class="act-sub">${esc(row.detail)}</div></span>
                  <span>${row.agent ? chip(agentLabelOf(row.agent)) : ""}</span>
                </div>`,
              )
              .join("")
      }
    </div>
  </section>`;
}

export function renderCoordinator() {
  const agents = myAgents();
  const online = agents.filter((agent) => agent.connected).length;
  const active = activeTasks().length;
  const health = systemHealth();
  const tab = state.coordinatorTab;

  return `<div class="scroll">
    <div class="coord-head">
      <button type="button" class="icon-btn menu-btn" data-act="nav-toggle"
        title="Menu" aria-label="Menu">${icon("menu")}</button>
      <div class="coord-title">
        <h1>Coordinator
          <span class="live-badge">${dot("green", true)}${
            socketLive() ? "Live" : "Polling"
          }</span>
        </h1>
        <p>Real-time coordination between agents</p>
      </div>
      <div class="coord-stats">
        <div class="coord-stat">
          <div class="cs-label">Active tasks</div>
          <div class="cs-value">${active}<small>/ ${state.tasks.length}</small></div>
        </div>
        <div class="coord-stat">
          <div class="cs-label">Agents online</div>
          <div class="cs-value">${online}<small>/ ${agents.length}</small></div>
        </div>
        <div class="coord-stat">
          <div class="cs-label">Conflicts</div>
          <div class="cs-value">${conflictCount()}</div>
        </div>
        <div class="coord-stat">
          <div class="cs-label">System health</div>
          <div class="cs-value good" style="color:var(--${health.tone})">
            ${esc(health.label)} ${icon("checkCircle")}
          </div>
        </div>
      </div>
    </div>

    <div style="padding:0 34px">
      ${tabs(
        "coord-tab",
        [
          { value: "overview", label: "Overview" },
          { value: "activity", label: "Activity" },
          { value: "locks", label: "Locks" },
        ],
        tab,
      )}
    </div>

    <div class="coord-body">
      ${
        tab === "overview"
          ? `<div class="coord-grid">
              <section class="card">
                <div class="panel-head">
                  <div><h3>System flow</h3><p>How agents are working together</p></div>
                </div>
                ${flowDiagram()}
              </section>
              ${activityPanel()}
            </div>
            <div class="coord-cols-3">
              ${tasksPanel()}
              ${locksPanel()}
              ${integrationsPanel()}
            </div>`
          : tab === "activity"
            ? activityTab()
            : locksTab()
      }
      ${
        waitingTasks().length > 0 && tab === "overview"
          ? `<p style="color:var(--text-3);font-size:12px">
              ${waitingTasks().length} task${waitingTasks().length === 1 ? "" : "s"}
              waiting on a decision or a free resource.
            </p>`
          : ""
      }
    </div>
  </div>`;
}
