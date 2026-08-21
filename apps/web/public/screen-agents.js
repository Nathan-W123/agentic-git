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

import {
  api,
  cancelGitHubSignIn,
  cancelProviderSignIn,
  connectGitHub,
  connectProviderCredential,
  gitHubSignInStatus,
  loadContext,
  loadGitHub,
  loadProviders,
  myAgents,
  persist,
  providerSignInStatus,
  startGitHubSignIn,
  startProviderSignIn,
  state,
  submitProviderSignInCode,
  taskBelongsToAgent,
  taskProgress,
  taskStarted,
} from "./data.js";
import { chatComposer, chatThread } from "./chat.js";
import {
  addTile,
  agentFace,
  agentLabelOf,
  badge,
  bar,
  chipRow,
  esc,
  icon,
  iconButton,
  emptyState,
  searchBox,
  sectionRail,
  segmented,
  showModal,
  statTile,
  tabs,
  tileCard,
  toast,
} from "./ui.js";

/**
 * The statuses a task can be retried from — the ones where it has stopped.
 *
 * The rest (`submitted`, `claimed`, `planned`, `open`) all mean the work is
 * still somebody's, and the server refuses a retry on them. Exported so the
 * handler in `app.js` guards on the same set this screen draws from: two
 * copies of this rule is how a button and its refusal come to disagree.
 */
export const TERMINAL_TASK_STATUS = new Set([
  "integrated",
  "failed",
  "cancelled",
]);

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
    <span class="ar-prog">${
      task !== undefined && !taskStarted(task)
        ? `<span class="mt-stage">Queued</span>`
        : `${bar(agent.progress, agent.status === "working" ? "" : "grey")}
           <span class="ar-pct">${Math.round(agent.progress)}%</span>`
    }</span>
    <span class="ar-more">${iconButton("dots", {
      act: "agent-menu",
      value: agent.id,
      title: "Agent actions",
      small: true,
    })}</span>
  </div>`;
}

/** What an agent is doing, in one line, for a card or a row. */
function taskLine(agent) {
  return (
    agent.task?.objective ??
    (agent.connected
      ? "No task assigned"
      : agent.detail !== undefined && agent.detail !== ""
        ? agent.detail
        : "Not connected")
  );
}

/**
 * One connection as a card.
 *
 * The same facts the row carries, arranged so they can be taken in without
 * reading across: face and name first, what it is doing under them, and the
 * state — badge and progress — along the bottom edge of every card at the
 * same height, so a deck of them compares at a glance.
 */
function agentCard(agent, active) {
  const task = agent.task;
  const queued = task !== undefined && !taskStarted(task);
  return tileCard({
    glyph: `<span class="tile-face">${agentFace(agent, 36)}</span>`,
    trailing: iconButton("dots", {
      act: "agent-menu",
      value: agent.id,
      title: "Agent actions",
      small: true,
    }),
    title: agent.name,
    subtitle: `${icon(task === undefined ? "pause" : "file")}<span>${esc(taskLine(agent))}</span>`,
    foot: `${badge(agent.status)}${
      task === undefined
        ? ""
        : queued
          ? `<span class="tile-pct">Queued</span>`
          : `${bar(agent.progress, agent.status === "working" ? "" : "grey")}
             <span class="tile-pct">${Math.round(agent.progress)}%</span>`
    }`,
    act: "agent-pick",
    value: agent.id,
    active,
  });
}

/** The deck of connections, with the tile that adds another one last. */
function connectionGrid(agents, selected) {
  return `<div class="tile-grid agent-deck">
    ${agents.map((agent) => agentCard(agent, agent.id === selected?.id)).join("")}
    ${addTile({
      title: "Add agent",
      subtitle: "Connect a coding agent",
      act: "agent-add",
    })}
  </div>`;
}

/** The selected agent, at the size of the thing the panel is about. */
function agentHero(agent) {
  const presence =
    agent.presence === "offline"
      ? "Offline"
      : agent.presence === "idle"
        ? "Idle"
        : "Online";
  // The dot has to agree with the word beside it: green is working, amber is
  // connected and doing nothing. One green dot for both is how an idle agent
  // came to read as a busy one.
  const tone =
    agent.presence === "offline"
      ? ""
      : agent.presence === "idle"
        ? "orange"
        : "green";
  return `<header class="agent-hero">
    <span class="ah-face">${agentFace(agent, 52)}</span>
    <div class="ah-id">
      <div class="ah-name">${esc(agent.name)}${badge(agent.status)}</div>
      <div class="ah-meta">${
        tone === "" ? "" : `<span class="dot ${tone}"></span>`
      }<span>${esc(presence)}</span><span>·</span><span>${esc(
        agent.visibility === "org" ? "Shared with the project" : "Yours only",
      )}</span></div>
    </div>
    <span class="spacer"></span>
    ${iconButton("info", { act: "agent-info", title: "Connection details" })}
    ${iconButton("chart", { act: "agent-usage", title: "Usage" })}
    ${iconButton("dots", { act: "agent-menu", value: agent.id, title: "More" })}
  </header>`;
}

/**
 * The changeset belonging to the agent on screen, or nothing.
 *
 * Resolved through the per-task cache (`state.changeSets`, keyed by taskId —
 * see `ensureChangeSetForTask`) so this answers for *this* agent's work. The
 * global is deliberately not the fallback: falling back to it is exactly the
 * behaviour that put another agent's files under this agent's name.
 */
function agentChangeSet(agent) {
  const own = state.tasks.filter((task) =>
    taskBelongsToAgent(task, agent),
  );
  for (const task of own) {
    const changeSet = state.changeSets[task.id];
    if (changeSet !== undefined) {
      return changeSet;
    }
  }
  return undefined;
}

/**
 * The connection's properties, as labelled rails rather than as a paragraph
 * of dot-separated fragments. Three lines that each answer one question:
 * what it thinks with, what it is on, and what it has touched.
 */
function agentRails(agent) {
  const task = agent.task;
  const patches = agentChangeSet(agent)?.patches ?? [];
  return `<div class="agent-rails">
    ${sectionRail(
      "Model",
      chipRow([
        {
          label: agent.model === "" ? "Model unset" : agent.model,
          iconName: "cpu",
          title: "The model this agent answers with",
        },
        agent.effort === "" ? undefined : { label: `${agent.effort} effort`, iconName: "bolt" },
        agent.contextPercent > 0
          ? {
              label: `${agent.contextPercent}% context`,
              iconName: "layers",
              tone: agent.contextPercent > 80 ? "orange" : undefined,
              title: "How full the last exchange left the context window",
            }
          : undefined,
      ]),
    )}
    ${sectionRail(
      "Task",
      chipRow(
        task === undefined
          ? [
              {
                label: agent.connected ? "No task assigned" : "Not connected",
                iconName: "pause",
              },
            ]
          : [
              {
                label: task.objective,
                iconName: "file",
                tone: "purple",
                title: task.objective,
              },
              taskStarted(task)
                ? { label: `${taskProgress(task)}% done`, iconName: "clock", tone: "blue" }
                : { label: "Queued", iconName: "clock", tone: "orange" },
              task.repositoryId === undefined || task.repositoryId === ""
                ? undefined
                : { label: task.repositoryId, iconName: "folder" },
            ],
      ),
    )}
    ${sectionRail(
      "Files",
      chipRow([
        patches.length === 0
          ? { label: "Nothing touched yet", iconName: "file" }
          : {
              label: `${patches.length} file${patches.length === 1 ? "" : "s"} in the changeset`,
              iconName: "file",
              tone: "green",
            },
      ]),
    )}
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
  return `<section class="card agent-panel">
    ${agentHero(agent)}
    ${agentRails(agent)}

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
      <div class="ar-prog">${
        taskStarted(task)
          ? `${bar(taskProgress(task))}
             <span class="ar-pct">${taskProgress(task)}%</span>`
          : `<span class="mt-stage">Queued — waiting for a free slot</span>`
      }</div>
      <div class="sum-actions">
        ${
          // Cancel only while there is something to stop, and Retry only once
          // there is not. The two used to be offered side by side whatever
          // state the task was in, so one of them was always the one the
          // server would refuse. Both now go through the same confirm and the
          // same guard in `app.js`.
          TERMINAL_TASK_STATUS.has(task.status)
            ? `<button class="btn btn-sm" data-act="task-retry" data-value="${esc(task.id)}">
                Retry
              </button>`
            : `<button class="btn btn-sm" data-act="task-cancel" data-value="${esc(task.id)}">
                Cancel task
              </button>`
        }
      </div>
    </div>`;
  }
  if (tab === "files") {
    // Only this agent's work. `state.changeSet` is one global filled from
    // whichever run `ensureCodeData` found first for the repository, so this
    // panel showed whatever the Code screen was holding under the heading
    // "Files this agent changes" — including, routinely, another agent's
    // files. Until the per-task cache has an entry for work belonging to the
    // agent on screen, the honest answer is the empty state: an empty panel
    // is a smaller lie than somebody else's changes.
    const files = agentChangeSet(agent)?.patches ?? [];
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
  // The deck is the default; the list stays for the reader who wants density
  // rather than cards, and which one somebody chose is kept across sessions.
  const view = state.agentView === "list" ? "list" : "grid";

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
      ${
        // Counted on `connected`, so this is how many agents this account has
        // a working sign-in for — not how many are doing anything, which is
        // the Working tile beside it. It was labelled "Active agents", and a
        // row that opens by calling four idle connections active is the first
        // thing a reader believes about the screen.
        statTile({
          value: agents.filter((agent) => agent.connected).length,
          label: "Connected agents",
          foot: `<span class="dot green"></span> ${
            offline === 0 ? "All systems go" : `${offline} offline`
          }`,
          iconName: "robot",
          tone: "green",
        })
      }
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

    <div class="agent-section-head">
      <h2>Your connections</h2>
      <span class="ash-count">${esc(
        `${agents.filter((agent) => agent.connected).length} of ${agents.length} connected`,
      )}</span>
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
          <span class="agent-deck-tools">${segmented(
            "agent-view",
            [
              { value: "grid", label: "▦" },
              { value: "list", label: "☰" },
            ],
            view,
          )}</span>
          <span class="agent-search-wrap">${searchBox(
            "Search agents...",
            state.agentQuery,
            "agent-search",
          )}</span>
        </div>
        ${
          shown.length === 0
            ? `${emptyState(
                "robot",
                agents.length === 0 ? "No agents connected" : "No agents match",
                agents.length === 0
                  ? "Connect Cursor, Copilot, Kiro, Gemini, Claude, or Codex to give yourself an agent on this project."
                  : "Try another filter or search term.",
                agents.length === 0
                  ? `<button class="btn btn-primary" data-act="agent-add">${icon(
                      "plus",
                    )} Add Agent</button>`
                  : "",
              )}`
            : view === "grid"
              ? connectionGrid(shown, selected)
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

/** How somebody gets a credential we can accept, per provider. */
const CREDENTIAL_HELP = {
  anthropic: {
    hint: "Run <code>claude setup-token</code> on your own machine and finish the browser sign-in. It prints a token starting <code>sk-ant-oat</code> that spends your own Claude subscription.",
    placeholder: "sk-ant-oat-…",
    kinds: [
      ["oauth_token", "Subscription token (claude setup-token)"],
      ["api_key", "API key from console.anthropic.com"],
    ],
  },
  google: {
    // Google retired the Gemini CLI's browser sign-in for personal accounts,
    // so for most people a key is now the only way in.
    hint: "Create a key at <a class=\"link\" target=\"_blank\" rel=\"noopener noreferrer\" href=\"https://aistudio.google.com/apikey\">aistudio.google.com/apikey</a>. It bills per request rather than against a subscription. Browser sign-in still works on a paid Gemini Code Assist plan.",
    placeholder: "AIza…",
    kinds: [["api_key", "API key from Google AI Studio"]],
  },
  openai: {
    // Codex has no `setup-token` equivalent, so a ChatGPT subscription can
    // only be brought over as the session file the CLI itself wrote.
    hint: "On a ChatGPT subscription, sign in with <code>codex</code> on your own machine and paste the contents of <code>~/.codex/auth.json</code>. On API credits, paste a key from platform.openai.com instead.",
    placeholder: "sk-… or the contents of auth.json",
    kinds: [
      ["session_file", "ChatGPT subscription (contents of ~/.codex/auth.json)"],
      ["api_key", "API key from platform.openai.com"],
    ],
  },
};

/**
 * Said once, on the kinds it is true of.
 *
 * A copied session file shares a rotating refresh token with the machine it
 * came from, so the two can revoke each other by refreshing. That is a real
 * consequence of using it and belongs in front of somebody about to paste
 * one, not in a comment they will never read.
 */
const SESSION_FILE_WARNING =
  "A copied session file shares a refresh token with the machine it came " +
  "from: signing out there, or a refresh on either side, can invalidate the " +
  "other. An API key or subscription token does not do this.";

/**
 * Connecting means handing over a credential of your own — not borrowing the
 * host's.
 *
 * This used to POST straight to the CLI sign-in, which authenticates as
 * whoever owns the machine. That is the wrong default for everyone except the
 * person who set the host up: it spends their account, and for anybody else it
 * fails outright with an administrator error. So the credential is the default
 * and the only path offered here; the CLI remains available to system
 * administrators through the provider's own settings.
 */
/** Waits, so a sign-in can be polled without spinning the browser. */
function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Signing in through the browser, where the vendor allows it.
 *
 * This is what "connect" should have meant all along: the deployment runs the
 * vendor's own sign-in, the user approves it on their own machine, and no
 * long-lived credential has to be found or copied from another machine.
 *
 * Two shapes, and the server says which. `approve` shows a code the user
 * confirms in the browser and the CLI polls for the answer. `code_exchange`
 * shows a link and takes a code back — the vendor's page issues it, and the
 * waiting CLI needs it before it can finish.
 *
 * Returns `true` when connected, `false` when retry should be offered, and
 * `null` when the user walked away.
 */
async function signInAgent(providerId, mode, rerender) {
  // Opened now, empty, and pointed at the vendor once the URL is known.
  // A tab opened after the `await` below is a popup as far as the browser is
  // concerned — the click that authorised it is long over — so it gets
  // blocked. Claiming it during the gesture and navigating it later is what
  // makes "press Connect and the sign-in page appears" actually happen.
  //
  // Claude looked like it worked without this only because its CLI opens a
  // browser itself — on the *server*, which is the user's own machine here
  // and somebody else's everywhere else. Codex's CLI prints the URL and opens
  // nothing, which is how the difference showed up.
  // Deliberately without `noopener`: that feature makes `window.open` return
  // null, and a null handle cannot be navigated — the tab opens and sits on
  // about:blank forever. The opener reference is dropped below instead, which
  // gets the same protection while keeping the handle.
  const tab = window.open("", "_blank");
  if (tab !== null && tab !== undefined) {
    // Starting the CLI can take a few seconds. Leaving the claimed tab as
    // about:blank during that wait made a working sign-in look broken before
    // its URL had even arrived.
    tab.document.title = `Opening ${agentLabelOf(providerId)} sign-in`;
    tab.document.body.style.cssText =
      "margin:0;display:grid;min-height:100vh;place-items:center;" +
      "font:16px system-ui,sans-serif;color:#334155;background:#f8fafc";
    tab.document.body.textContent =
      `Preparing the ${agentLabelOf(providerId)} sign-in page…`;
  }
  let flow;
  try {
    flow = await startProviderSignIn(providerId);
  } catch (error) {
    tab?.close();
    // The caller offers a fresh attempt, and saying why beats silently
    // showing a credential form the user did not ask for.
    toast(`${agentLabelOf(providerId)} sign-in unavailable — ${error.message}`, "error");
    return false;
  }

  // If the tab was blocked anyway, the link in the dialog is still there and
  // still works — this is a shortcut, not the only route.
  if (tab !== null && tab !== undefined) {
    // Cut the back-reference before navigating, so the vendor's page cannot
    // reach back into this one.
    tab.opener = null;
    tab.location.replace(flow.verificationUrl);
  }

  const exchange = (flow.mode ?? mode) === "code_exchange";
  const link =
    `<p class="modal-hint"><a class="link" target="_blank" rel="noopener noreferrer"
       href="${esc(flow.verificationUrl)}">Open the ${esc(agentLabelOf(providerId))} sign-in page</a>
     — it opens in a new tab, on your own account.</p>`;
  // Whether the browser hands back a code varies by vendor and by how the
  // sign-in page resolves: approving in the browser is often enough on its
  // own, and the CLI exits without ever prompting. So the flow is polled
  // while the dialog is open, and the code box is a fallback rather than a
  // requirement — asking for a code that was never issued is a dead end.
  let settledWhileOpen;
  let modalOpen = true;
  void (async () => {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      await pause(1500);
      if (!modalOpen) {
        return undefined;
      }
      let current;
      try {
        current = await providerSignInStatus(providerId, flow.flowId);
      } catch {
        return undefined;
      }
      if (!modalOpen) {
        return current;
      }
      if (current.status !== "pending") {
        settledWhileOpen = current;
        document.querySelector("#modal")?.close();
        return current;
      }
    }
    return undefined;
  })();

  const values = await showModal({
    title: `Sign in to ${agentLabelOf(providerId)}`,
    subtitle: "Your account, not this machine's.",
    confirm: exchange ? "Connect" : "I've approved it",
    body: exchange
      ? `${link}
         ${
           flow.userCode
             ? `<p class="modal-code">${esc(flow.userCode)}</p>
                <p class="modal-hint">Enter that code on the sign-in page if it asks for one.</p>`
             : ""
         }
         <label class="field"><span>Code from that page
             <span class="field-optional">only if it shows one</span></span>
           <input class="input" name="code" autocomplete="one-time-code"
             placeholder="Paste it here if you were given one"></label>
         <p class="modal-hint">Approve the sign-in in that tab. Most of the
           time that is all it takes and this will finish on its own; if the
           page shows you a code instead, paste it above. This deployment
           never sees your password.</p>`
      : `${link}
         <p class="modal-code">${esc(flow.userCode ?? "")}</p>
         <p class="modal-hint">Enter that code on the page, approve it, then
           come back here.</p>`,
  });
  // Stop the dialog watcher before the submit path starts polling. A terminal
  // status is intentionally readable only once, so two pollers can otherwise
  // race and turn a successful code exchange into an "unknown sign-in" error.
  modalOpen = false;

  if (settledWhileOpen !== undefined) {
    const settled = settledWhileOpen;
    if (settled.status !== "completed") {
      toast(
        settled.detail ?? `${agentLabelOf(providerId)} sign-in did not complete`,
        "error",
      );
      return false;
    }
    toast(
      `${agentLabelOf(providerId)} connected as ${settled?.account ?? "your account"}`,
    );
    await loadProviders();
    rerender();
    return true;
  }

  if (values === undefined) {
    await cancelProviderSignIn(providerId, flow.flowId);
    return null;
  }

  try {
    const code = exchange ? String(values.code ?? "").trim() : "";
    if (code !== "") {
      await submitProviderSignInCode(providerId, flow.flowId, code);
    }
    // The CLI finishes on its own clock — it has a browser round trip to wait
    // on either way — so the outcome is polled rather than assumed.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const state_ = await providerSignInStatus(providerId, flow.flowId);
      if (state_.status === "completed") {
        toast(`${agentLabelOf(providerId)} connected as ${state_.account ?? "your account"}`);
        // `loadProviders`, not `loadContext`: the context call reads
        // organizations, projects and repositories and never touches
        // `state.providers`. Refreshing the wrong thing is why a sign-in
        // could report success — the credential really was stored — while
        // the screen went on showing the provider as unconnected and it
        // never appeared in the agent list. The paste path did not have this
        // fault because storing a credential returns the new provider list
        // in its own response.
        await loadProviders();
        rerender();
        return true;
      }
      if (state_.status !== "pending") {
        toast(state_.detail ?? `${agentLabelOf(providerId)} sign-in did not complete`, "error");
        return false;
      }
      await pause(1000);
    }
    toast(`${agentLabelOf(providerId)} sign-in timed out`, "error");
    await cancelProviderSignIn(providerId, flow.flowId);
    return false;
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
}

export async function connectAgent(providerId, rerender) {
  // Sign-in first where the vendor supports it, because the alternative is
  // asking somebody to go and find a secret. The server reports which
  // providers can, so this does not have to know.
  const entry = (state.providers ?? []).find(
    (item) => item.id === providerId,
  );
  const signInFlow = entry?.signInFlow;
  // What the server says this provider will accept by hand. Asked rather than
  // assumed: which providers have a paste route changes when a vendor changes
  // its mind, as Google did when it closed the Gemini CLI's browser sign-in to
  // personal accounts, and a list hardcoded here goes stale silently.
  const pasteable = (entry?.acceptedCredentialKinds ?? []).length > 0;
  if (signInFlow !== undefined) {
    // A failed sign-in used to fall through to the paste box, which answered
    // "that did not work" by asking somebody to go and find an OAuth token on
    // another machine. That is a harder job than the one that just failed, and
    // it arrived unasked — so the commonest reason a connection failed (a
    // mistimed tab, a closed window, a slow vendor) turned into a research
    // task instead of a second press of the button.
    //
    // Offering the retry in a loop, because retrying is what actually fixes
    // it. Closing the dialog is how somebody says they are done.
    for (;;) {
      const outcome = await signInAgent(providerId, signInFlow, rerender);
      if (outcome === true || outcome === null) {
        return;
      }
      // Retrying fixes a mistimed tab. It cannot fix a vendor that has
      // withdrawn the flow — Gemini's refusal for personal accounts is
      // permanent, and looping "Try again" on it is a trap. So where a
      // pasted credential is accepted, that is offered as the other way out.
      const again = await showModal({
        title: "Connection failed",
        subtitle: `${agentLabelOf(providerId)} did not finish signing in.`,
        confirm: "Try again",
        cancel: pasteable ? "Use a credential instead" : "Not now",
        body: `<p class="modal-hint">Nothing was saved, and nothing on your
          account changed. This is usually the sign-in tab being closed or
          taking too long — starting it again is normally all it needs.${
            pasteable
              ? " If the message above says this account is not eligible, " +
                "signing in again will not help — connect a credential instead."
              : ""
          }</p>`,
      });
      if (again === undefined) {
        if (!pasteable) {
          return;
        }
        break;
      }
    }
  }
  // A provider that accepts nothing by hand is browser-only, and saying so is
  // the whole answer for it. Decided from what the server accepts rather than
  // from a list here, so a vendor gaining or losing a paste route does not
  // need this file changed to match.
  if (!pasteable) {
    toast(`${agentLabelOf(providerId)} browser sign-in is unavailable`, "error");
    return;
  }

  const help = CREDENTIAL_HELP[providerId] ?? {
    hint: "Paste a credential for this provider.",
    placeholder: "",
    kinds: [["api_key", "API key"]],
  };
  const values = await showModal({
    title: `Connect ${agentLabelOf(providerId)}`,
    subtitle: "Your credential, used only for you.",
    confirm: "Connect",
    body: `
      <p class="modal-hint">${help.hint}</p>
      ${
        help.kinds.length > 1
          ? `<label class="field"><span>Credential type</span>
               <select class="input" name="kind">
                 ${help.kinds
                   .map(([id, label]) => `<option value="${id}">${esc(label)}</option>`)
                   .join("")}
               </select></label>`
          : `<input type="hidden" name="kind" value="${help.kinds[0][0]}">`
      }
      <label class="field"><span>Credential</span>
        ${
          // A session file is a whole JSON document, so a one-line masked
          // input cannot hold one legibly. Providers that accept a file get a
          // textarea, which takes a pasted key just as well.
          help.kinds.some(([id]) => id === "session_file")
            ? `<textarea class="input cred-paste" name="secret" rows="4"
                 autocomplete="off" placeholder="${esc(help.placeholder)}"
                 required></textarea>`
            : `<input class="input" name="secret" type="password" autocomplete="off"
                 placeholder="${esc(help.placeholder)}" required>`
        }</label>
      <label class="field"><span>Label <span class="field-optional">optional</span></span>
        <input class="input" name="label" autocomplete="off"
          placeholder="Which account this is"></label>
      <label class="field"><span>Who can task it</span>
        <select class="input" name="visibility">
          <option value="personal" selected>Personal — only you can task it</option>
          <option value="org">Org-wide — anyone with access to a repository
            it works in can @mention it there</option>
        </select></label>
      ${
        help.kinds.some(([id]) => id === "session_file")
          ? `<p class="modal-hint">${esc(SESSION_FILE_WARNING)}</p>`
          : ""
      }
      <p class="modal-hint">Stored encrypted, never shown again, and never
        shared with anyone else on this deployment. "Org-wide" only changes
        who may @mention this agent to submit work — the credential itself is
        still never shared.</p>`,
  });
  if (values === undefined) {
    return;
  }
  const secret = String(values.secret ?? "").trim();
  if (secret === "") {
    toast("A credential is required", "error");
    return;
  }
  try {
    await connectProviderCredential(
      providerId,
      String(values.kind ?? "api_key"),
      secret,
      String(values.label ?? "").trim(),
      values.visibility === "org" ? "org" : "personal",
    );
    toast(`${providerId} connected`, "ok");
    rerender();
  } catch (error) {
    toast(error.message, "error");
  }
}

/**
 * The GitHub device sign-in, shaped like `signInAgent`'s approve mode:
 * GitHub issues a short code, the person enters it at github.com in a tab
 * of their own, and the poll finishes the moment they approve. Returns
 * true when connected, false to fall back to the paste box, null when the
 * person walked away.
 */
async function signInGitHub(rerender) {
  // Claimed during the click, navigated once the URL is known — the same
  // popup-blocker reasoning as `signInAgent`.
  const tab = window.open("", "_blank");
  let flow;
  try {
    flow = await startGitHubSignIn();
  } catch (error) {
    tab?.close();
    toast(`GitHub sign-in unavailable — ${error.message}`, "error");
    return false;
  }
  if (tab !== null && tab !== undefined) {
    tab.opener = null;
    tab.location.replace(flow.verificationUrl);
  }

  let finishedWhileOpen = false;
  const watch = (async () => {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      await pause(1500);
      let current;
      try {
        current = await gitHubSignInStatus(flow.flowId);
      } catch {
        return undefined;
      }
      if (current.status !== "pending") {
        if (current.status === "granted") {
          finishedWhileOpen = true;
          document.querySelector("#modal")?.close();
        }
        return current;
      }
    }
    return undefined;
  })();

  const values = await showModal({
    title: "Sign in to GitHub",
    subtitle: "Your account; this deployment never sees your password.",
    confirm: "I've approved it",
    body: `<p class="modal-hint"><a class="link" target="_blank"
        rel="noopener noreferrer" href="${esc(flow.verificationUrl)}">Open
        the GitHub sign-in page</a> — it opens in a new tab.</p>
      <p class="modal-code">${esc(flow.userCode ?? "")}</p>
      <p class="modal-hint">Enter that code on the page, approve the
        access, then come back here. Pushes an agent runs for you will
        authenticate as this account.</p>`,
  });

  if (finishedWhileOpen) {
    const settled = await watch;
    toast(`GitHub connected as ${settled?.login ?? "you"}`, "ok");
    await loadGitHub();
    rerender();
    return true;
  }
  if (values === undefined) {
    await cancelGitHubSignIn(flow.flowId);
    return null;
  }
  try {
    // "I've approved it" — give the grant a moment to land, polling the
    // same status the background watch reads.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const current = await gitHubSignInStatus(flow.flowId);
      if (current.status === "granted") {
        toast(`GitHub connected as ${current.login ?? "you"}`, "ok");
        await loadGitHub();
        rerender();
        return true;
      }
      if (current.status !== "pending") {
        toast(current.detail ?? "GitHub sign-in did not complete", "error");
        return false;
      }
      await pause(1000);
    }
    toast("GitHub sign-in timed out", "error");
    await cancelGitHubSignIn(flow.flowId);
    return false;
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
}

/**
 * Connecting GitHub is connecting an identity, not enabling a feature: a
 * push an agent runs for you authenticates as this token, as you, and
 * reaches only what you can reach. There is deliberately no deployment-wide
 * token for it to borrow — until this is connected, an asked-for push is
 * refused by name.
 *
 * Sign-in first when the deployment offers it, exactly like the agents: a
 * browser approval beats sending somebody off to mint a secret. The paste
 * box remains for deployments without an OAuth App, and for anyone who
 * wants a fine-grained token scoped tighter than the sign-in's `repo`
 * grant.
 */
export async function connectGitHubAccount(rerender) {
  if (state.github?.signInAvailable === true) {
    for (;;) {
      const outcome = await signInGitHub(rerender);
      if (outcome === true || outcome === null) {
        return;
      }
      // Confirm retries; anything else — the paste button, Escape — falls
      // through to the paste box below, which is also the way out of the
      // loop for somebody done with dialogs (the paste box closes too).
      const again = await showModal({
        title: "Sign-in did not finish",
        subtitle: "Nothing was saved, and nothing on your account changed.",
        confirm: "Try again",
        cancel: "Paste a token instead",
        body: `<p class="modal-hint">This is usually the sign-in tab being
          closed or the code expiring — starting again is normally all it
          needs. A pasted personal access token works too, and can be
          scoped to single repositories where the sign-in cannot.</p>`,
      });
      if (again === undefined) {
        break;
      }
    }
  }
  const values = await showModal({
    title: "Connect GitHub",
    subtitle: "Your token, spent only on pushes your own tasks ask for.",
    confirm: "Connect",
    body: `
      <p class="modal-hint">Create a personal access token on github.com
        (Settings &rarr; Developer settings) with write access to the
        repositories you want published to, and paste it here. It is
        verified against GitHub before it is stored.</p>
      <label class="field"><span>Personal access token</span>
        <input class="input" name="token" type="password" autocomplete="off"
          placeholder="ghp_&hellip; or github_pat_&hellip;" required></label>
      <p class="modal-hint">Stored encrypted, never shown again, and never
        shared with anyone else on this deployment. Pushes run as this token
        and reach only what it can.</p>`,
  });
  if (values === undefined) {
    return;
  }
  const token = String(values.token ?? "").trim();
  if (token === "") {
    toast("A token is required", "error");
    return;
  }
  try {
    const status = await connectGitHub(token);
    toast(`GitHub connected as ${status.login ?? "you"}`, "ok");
    rerender();
  } catch (error) {
    toast(error.message, "error");
  }
}

/**
 * The old behaviour, kept for whoever owns the host.
 *
 * Signing in through the vendor CLI authenticates as the host account, so it
 * is useful exactly once — for the administrator who wants this deployment to
 * have a shared login — and is refused for everybody else by the server.
 */
export async function connectAgentViaCli(providerId, rerender) {
  try {
    const response = await api(
      `/chat/providers/${encodeURIComponent(providerId)}`,
      { method: "POST", body: {} },
    );
    state.providers = response.providers ?? state.providers;
    toast(`${providerId} connected on the host account`, "ok");
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
