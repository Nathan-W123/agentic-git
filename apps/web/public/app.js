const API_ROOT = "/api/v1";

const state = {
  principal: undefined,
  health: undefined,
  organizations: [],
  organizationId: localStorage.getItem("relay.organization") ?? "",
  projects: [],
  projectId: localStorage.getItem("relay.project") ?? "",
  project: undefined,
  repositories: [],
  tasks: [],
  runs: [],
  approvals: [],
  audit: [],
  agents: [],
  members: [],
  admin: undefined,
  route: "overview",
  socket: undefined,
  refreshTimer: undefined,
};

const routeMeta = {
  overview: [
    "Control room",
    "Overview",
    "Canonical state, active work, and decisions at a glance.",
  ],
  tasks: [
    "Work queue",
    "Tasks",
    "Submit intent, choose an agent, and control the project queue.",
  ],
  runs: [
    "Integration ledger",
    "Runs",
    "Inspect scheduling, replans, validation, and canonical promotions.",
  ],
  approvals: [
    "Human gates",
    "Approvals",
    "Review protected plans, scope expansions, and proposed changesets.",
  ],
  repositories: [
    "Canonical sources",
    "Repositories",
    "Import GitHub mirrors and start coordinated work against them.",
  ],
  team: [
    "Access control",
    "Team",
    "Manage organization membership and role-based permissions.",
  ],
  settings: [
    "Project controls",
    "Settings",
    "Update project identity, organization details, and lifecycle state.",
  ],
  admin: [
    "Host operations",
    "System admin",
    "Manage users and inspect the local control plane across organizations.",
  ],
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value, options = {}) {
  if (!value) {
    return "not yet";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat(
    undefined,
    options.short
      ? { hour: "numeric", minute: "2-digit" }
      : { dateStyle: "medium", timeStyle: "short" },
  ).format(date);
}

function shortId(value, length = 10) {
  const text = String(value ?? "");
  return text.length <= length ? text : text.slice(0, length);
}

function statusBadge(value) {
  const normalized = String(value ?? "unknown").toLowerCase();
  return `<span class="status status-${escapeHtml(normalized)}">${escapeHtml(
    normalized.replaceAll("_", " "),
  )}</span>`;
}

function csrfToken() {
  const entry = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("coord_csrf="));
  return entry?.slice("coord_csrf=".length) ?? "";
}

async function api(path, options = {}) {
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers ?? {});
  headers.set("Accept", "application/json");
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("X-CSRF-Token", csrfToken());
  }
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    credentials: "same-origin",
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      data?.error?.message ?? `Request failed with status ${response.status}`,
    );
    error.code = data?.error?.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

function toast(message, tone = "default") {
  const item = document.createElement("div");
  item.className = `toast${tone === "error" ? " error" : ""}`;
  item.textContent = message;
  $("#toast-region").append(item);
  window.setTimeout(() => item.remove(), 4_500);
}

function authMessage(message) {
  $("#auth-message").textContent = message;
}

function setAuthMode(mode) {
  $$(".auth-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.authMode === mode);
  });
  $("#login-form").hidden = mode !== "login";
  $("#bootstrap-form").hidden = mode !== "bootstrap";
  authMessage("");
}

function showAuth() {
  closeSocket();
  $("#app-shell").hidden = true;
  $("#auth-shell").hidden = false;
}

function currentOrganization() {
  return state.organizations.find(
    (organization) => organization.id === state.organizationId,
  );
}

function currentRole() {
  if (state.principal?.user?.systemAdmin) {
    return "owner";
  }
  return (
    state.principal?.memberships?.find(
      (membership) => membership.organizationId === state.organizationId,
    )?.role ?? "viewer"
  );
}

function canManageProject() {
  return ["owner", "admin"].includes(currentRole());
}

function canManageMembers() {
  return ["owner", "admin"].includes(currentRole());
}

function canReview() {
  return ["owner", "admin", "reviewer"].includes(currentRole());
}

function canRun() {
  return ["owner", "admin", "developer"].includes(currentRole());
}

function updateIdentity() {
  const user = state.principal?.user;
  $("#profile-name").textContent = user?.displayName ?? "Relay user";
  $("#profile-avatar").textContent =
    user?.displayName?.trim().charAt(0).toUpperCase() || "R";
  $("#profile-role").textContent = currentRole().replaceAll("_", " ");
  $("#admin-nav").hidden = user?.systemAdmin !== true;
}

function renderSelectors() {
  const organizationSelect = $("#organization-select");
  organizationSelect.innerHTML = state.organizations
    .map(
      (organization) =>
        `<option value="${escapeHtml(organization.id)}"${
          organization.id === state.organizationId ? " selected" : ""
        }>${escapeHtml(organization.name)}</option>`,
    )
    .join("");
  const projectSelect = $("#project-select");
  projectSelect.innerHTML =
    state.projects.length === 0
      ? '<option value="">No projects yet</option>'
      : state.projects
          .map(
            (project) =>
              `<option value="${escapeHtml(project.id)}"${
                project.id === state.projectId ? " selected" : ""
              }>${escapeHtml(project.name)}${
                project.archived ? " (archived)" : ""
              }</option>`,
          )
          .join("");
}

async function loadContext({ quiet = false } = {}) {
  try {
    state.principal = await api("/auth/me");
    const organizations = await api("/organizations");
    state.organizations = organizations.organizations;
    if (
      !state.organizations.some(
        (organization) => organization.id === state.organizationId,
      )
    ) {
      state.organizationId = state.organizations[0]?.id ?? "";
    }
    localStorage.setItem("relay.organization", state.organizationId);

    if (state.organizationId) {
      const [projects, members] = await Promise.all([
        api(`/organizations/${encodeURIComponent(state.organizationId)}/projects`),
        api(`/organizations/${encodeURIComponent(state.organizationId)}/members`),
      ]);
      state.projects = projects.projects;
      state.members = members.members;
    } else {
      state.projects = [];
      state.members = [];
    }

    if (!state.projects.some((project) => project.id === state.projectId)) {
      state.projectId = state.projects[0]?.id ?? "";
    }
    localStorage.setItem("relay.project", state.projectId);
    state.project = state.projects.find(
      (project) => project.id === state.projectId,
    );

    if (state.projectId) {
      const projectId = encodeURIComponent(state.projectId);
      const [
        repositories,
        tasks,
        runs,
        approvals,
        audit,
        agents,
        project,
      ] = await Promise.all([
        api(`/projects/${projectId}/repositories`),
        api(`/projects/${projectId}/tasks`),
        api(`/projects/${projectId}/runs?limit=100`),
        api(`/projects/${projectId}/approvals`),
        api(`/projects/${projectId}/audit`),
        api(`/projects/${projectId}/agents`),
        api(`/projects/${projectId}`),
      ]);
      state.repositories = repositories.repositories;
      state.tasks = tasks.tasks;
      state.runs = runs.runs;
      state.approvals = approvals.approvals;
      state.audit = audit.events;
      state.agents = agents.agents;
      state.project = project.project;
    } else {
      state.repositories = [];
      state.tasks = [];
      state.runs = [];
      state.approvals = [];
      state.audit = [];
      state.agents = [];
      state.project = undefined;
    }

    if (state.principal?.user?.systemAdmin) {
      const [overview, users] = await Promise.all([
        api("/admin/overview"),
        api("/admin/users"),
      ]);
      state.admin = { ...overview, users: users.users };
    } else {
      state.admin = undefined;
    }

    renderSelectors();
    updateIdentity();
    connectSocket();
    render();
    $("#task-count").textContent = String(
      state.tasks.filter((task) =>
        ["submitted", "claimed"].includes(task.status),
      ).length,
    );
    $("#approval-count").textContent = String(
      state.approvals.filter((approval) => approval.status === "pending").length,
    );
    $("#updated-at").textContent = `Updated ${formatDate(new Date(), {
      short: true,
    })}`;
    if (!quiet) {
      toast("Control room refreshed");
    }
  } catch (error) {
    if (error.status === 401) {
      state.principal = undefined;
      showAuth();
      return;
    }
    toast(error.message, "error");
    if (!quiet) {
      renderError(error);
    }
  }
}

function closeSocket() {
  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close();
    state.socket = undefined;
  }
  $("#live-dot")?.classList.remove("live");
  if ($("#live-label")) {
    $("#live-label").textContent = "Offline";
  }
}

function connectSocket() {
  closeSocket();
  if (!state.projectId) {
    return;
  }
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const after = state.audit.at(-1)?.sequence ?? 0;
  const socket = new WebSocket(
    `${scheme}//${location.host}${API_ROOT}/events?projectId=${encodeURIComponent(
      state.projectId,
    )}&after=${after}`,
  );
  state.socket = socket;
  socket.addEventListener("open", () => {
    $("#live-dot").classList.remove("error");
    $("#live-dot").classList.add("live");
    $("#live-label").textContent = "Live event stream";
  });
  socket.addEventListener("message", (message) => {
    try {
      const payload = JSON.parse(message.data);
      if (payload.type !== "audit") {
        return;
      }
      const existing = state.audit.some(
        (entry) => entry.sequence === payload.sequence,
      );
      if (!existing) {
        state.audit.push({
          sequence: payload.sequence,
          runId: payload.runId,
          event: payload.event,
        });
      }
      const noteworthy = [
        "approval_requested",
        "approval_decided",
        "canonical_promoted",
        "task_failed",
        "replan_requested",
        "scope_change_requested",
      ];
      if (noteworthy.includes(payload.event?.type)) {
        toast(eventTitle(payload.event));
      }
      clearTimeout(state.refreshTimer);
      state.refreshTimer = window.setTimeout(
        () => void loadContext({ quiet: true }),
        700,
      );
    } catch {
      toast("A live event could not be decoded", "error");
    }
  });
  socket.addEventListener("close", () => {
    if (state.socket !== socket) {
      return;
    }
    $("#live-dot").classList.remove("live");
    $("#live-label").textContent = "Reconnecting";
    window.setTimeout(() => {
      if (state.socket === socket) {
        connectSocket();
      }
    }, 2_500);
  });
  socket.addEventListener("error", () => {
    $("#live-dot").classList.add("error");
  });
}

function eventTitle(event) {
  const titles = {
    approval_requested: "Human review requested",
    approval_decided: "Approval decision recorded",
    canonical_promoted: "Canonical repository promoted",
    conflict_detected: "Structural conflict detected",
    plan_revised: "Agent plan revised",
    replan_requested: "Dynamic replan requested",
    scope_change_requested: "Agent requested more scope",
    scope_change_decided: "Scope change decided",
    task_failed: "Task execution failed",
    task_integrated: "Task integrated",
    task_submitted: "Task submitted",
    workspace_created: "Isolated workspace created",
  };
  return titles[event?.type] ?? String(event?.type ?? "Coordination event")
    .replaceAll("_", " ")
    .replace(/^\w/u, (letter) => letter.toUpperCase());
}

function eventDetail(event) {
  const data = event?.data ?? {};
  return (
    data.objective ??
    data.explanation ??
    data.reason ??
    data.error ??
    data.status ??
    (data.revision ? `Canonical ${shortId(data.revision, 12)}` : undefined) ??
    (event.taskId ? `Task ${shortId(event.taskId)}` : "System event")
  );
}

function timeline(events, limit = 12) {
  const selected = [...events].reverse().slice(0, limit);
  if (selected.length === 0) {
    return '<div class="empty-state"><div><h2>No events yet</h2><p>Coordination activity will appear here as tasks move through the system.</p></div></div>';
  }
  return `<ol class="timeline">${selected
    .map(
      (record) => `
        <li>
          <span class="timeline-mark"></span>
          <span>
            <strong>${escapeHtml(eventTitle(record.event))}</strong>
            <small>${escapeHtml(eventDetail(record.event))}</small>
          </span>
          <time>${escapeHtml(formatDate(record.event.occurredAt, { short: true }))}</time>
        </li>`,
    )
    .join("")}</ol>`;
}

function render() {
  const requested = location.hash.slice(1).split("/")[0] || "overview";
  state.route =
    routeMeta[requested] &&
    (requested !== "admin" || state.principal?.user?.systemAdmin)
      ? requested
      : "overview";
  const [eyebrow, title, description] = routeMeta[state.route];
  $("#page-eyebrow").textContent = eyebrow;
  $("#page-title").textContent = title;
  $("#page-description").textContent = description;
  $$(".primary-nav a").forEach((link) => {
    link.classList.toggle("active", link.dataset.route === state.route);
  });
  $("#new-task-button").hidden = state.route === "tasks" || !state.projectId;

  if (!state.projectId && state.route !== "admin") {
    renderNoProject();
    return;
  }

  const views = {
    overview: renderOverview,
    tasks: renderTasks,
    runs: renderRuns,
    approvals: renderApprovals,
    repositories: renderRepositories,
    team: renderTeam,
    settings: renderSettings,
    admin: renderAdmin,
  };
  views[state.route]();
}

function renderNoProject() {
  $("#route-view").innerHTML = `
    <div class="empty-state">
      <div>
        <p class="eyebrow">Start here</p>
        <h2>Create your first project</h2>
        <p>A project scopes repositories, tasks, approvals, runs, and live events inside an organization.</p>
        ${
          canManageProject()
            ? projectCreateForm()
            : "<p>Your organization administrator needs to create a project.</p>"
        }
      </div>
    </div>`;
}

function projectCreateForm() {
  return `
    <form class="form-card" data-form="project-create">
      <label>
        <span>Project name</span>
        <input name="name" placeholder="Core platform" required>
      </label>
      <label>
        <span>Slug</span>
        <input name="slug" placeholder="core-platform" pattern="[A-Za-z0-9._-]+" required>
      </label>
      <label>
        <span>Description</span>
        <textarea name="description" placeholder="What this project coordinates"></textarea>
      </label>
      <button class="button button-primary" type="submit">Create project</button>
    </form>`;
}

function renderOverview() {
  const pendingTasks = state.tasks.filter((task) => task.status === "submitted");
  const activeTasks = state.tasks.filter((task) => task.status === "claimed");
  const integratedTasks = state.tasks.filter(
    (task) => task.status === "integrated",
  );
  const pendingApprovals = state.approvals.filter(
    (approval) => approval.status === "pending",
  );
  const docker = state.health?.docker;
  const recentTasks = state.tasks.slice(-6).reverse();

  $("#route-view").innerHTML = `
    <div class="signal-banner${docker?.available === false ? " warn" : ""}">
      <span class="health-orb${docker?.available === false ? " warn" : ""}"></span>
      <div>
        <strong>${docker?.available ? "Sandbox runtime ready" : "Control plane ready"}</strong>
        <span>${escapeHtml(
          docker?.explanation ??
            "Repository, persistence, approvals, and live events are online.",
        )}</span>
      </div>
      <span class="chip">${escapeHtml(docker?.version ?? "local")}</span>
    </div>
    <section class="metric-grid">
      ${metric("Queued intent", pendingTasks.length, "Waiting for the next run", "↗")}
      ${metric("In motion", activeTasks.length, "Claimed by the coordinator", "◎")}
      ${metric("Awaiting review", pendingApprovals.length, "Human decisions required", "✓")}
      ${metric("Accepted work", integratedTasks.length, "Tasks promoted to canonical", "⌁")}
    </section>
    <div class="content-grid">
      <section class="panel">
        <header class="panel-head">
          <div><h2>Work in view</h2><p>Latest task outcomes for this project</p></div>
          <a class="mini-button" href="#tasks">Open queue</a>
        </header>
        <div class="table-wrap">
          ${taskTable(recentTasks, false)}
        </div>
      </section>
      <section class="panel">
        <header class="panel-head">
          <div><h2>Live ledger</h2><p>Append-only coordination events</p></div>
        </header>
        <div class="panel-body">${timeline(state.audit, 8)}</div>
      </section>
    </div>`;
}

function metric(label, value, foot, glyph) {
  return `
    <article class="metric">
      <span class="metric-label">${escapeHtml(label)} <span>${glyph}</span></span>
      <strong class="metric-value">${escapeHtml(value)}</strong>
      <span class="metric-foot">${escapeHtml(foot)}</span>
    </article>`;
}

function taskTable(tasks, actions = true) {
  if (tasks.length === 0) {
    return '<div class="empty-state"><div><h2>Queue is clear</h2><p>Submit an engineering objective to begin coordinated work.</p></div></div>';
  }
  return `
    <table class="data-table">
      <thead><tr><th>Task</th><th>Status</th><th>Agent</th><th>Submitted</th>${
        actions ? "<th></th>" : ""
      }</tr></thead>
      <tbody>
        ${tasks
          .map(
            (task) => `
              <tr>
                <td>
                  <span class="table-title">${escapeHtml(task.objective)}</span>
                  <span class="table-subtitle">${escapeHtml(shortId(task.id, 18))}</span>
                </td>
                <td>${statusBadge(task.status)}</td>
                <td>${escapeHtml(task.agentId)}</td>
                <td>${escapeHtml(formatDate(task.submittedAt, { short: true }))}</td>
                ${
                  actions
                    ? `<td><div class="row-actions">${taskActions(task)}</div></td>`
                    : ""
                }
              </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

function taskActions(task) {
  if (!canRun()) {
    return "";
  }
  if (["submitted", "claimed"].includes(task.status)) {
    return `<button class="mini-button" data-task-action="cancel" data-task-id="${escapeHtml(
      task.id,
    )}">Cancel</button>`;
  }
  if (["failed", "claimed"].includes(task.status)) {
    return `<button class="mini-button" data-task-action="retry" data-task-id="${escapeHtml(
      task.id,
    )}">Retry</button>`;
  }
  return "";
}

function renderTasks() {
  const repositoryOptions = state.repositories
    .map(
      (repository) =>
        `<option value="${escapeHtml(repository.id)}">${escapeHtml(
          repository.id,
        )} · ${escapeHtml(repository.branch)}</option>`,
    )
    .join("");
  const agentOptions = state.agents
    .map(
      (agent) =>
        `<option value="${escapeHtml(agent.id)}"${
          agent.default ? " selected" : ""
        }>${escapeHtml(agent.id)} · ${escapeHtml(agent.adapter)}</option>`,
    )
    .join("");
  const runButtons = state.repositories
    .map(
      (repository) => `
        <button class="button button-quiet" data-run-repo="${escapeHtml(
          repository.id,
        )}" ${canRun() ? "" : "disabled"}>
          Run ${escapeHtml(repository.id)}
        </button>`,
    )
    .join("");

  $("#route-view").innerHTML = `
    <div class="split-form">
      <form class="form-card" data-form="task-submit">
        <p class="eyebrow">Intent before edits</p>
        <h2>Submit a coordinated task</h2>
        <p>The selected agent will propose a structural plan before receiving a writable workspace.</p>
        <label>
          <span>Engineering objective</span>
          <textarea name="objective" placeholder="Add password reset without changing the public user repository contract" required></textarea>
        </label>
        <label>
          <span>Canonical repository</span>
          <select name="repositoryId" required>${repositoryOptions}</select>
        </label>
        <label>
          <span>Coding agent</span>
          <select name="agentId" required>${agentOptions}</select>
        </label>
        <button class="button button-primary" type="submit" ${
          state.repositories.length === 0 || state.agents.length === 0
            ? "disabled"
            : ""
        }>Queue task <span aria-hidden="true">↗</span></button>
        ${
          state.repositories.length === 0
            ? '<small>Import a repository before submitting work.</small>'
            : ""
        }
        ${
          state.agents.length === 0
            ? '<small>Configure at least one agent in .coordinator/config.json.</small>'
            : ""
        }
      </form>
      <section class="panel">
        <header class="panel-head">
          <div><h2>Project queue</h2><p>${state.tasks.length} total task${
            state.tasks.length === 1 ? "" : "s"
          }</p></div>
          <div class="row-actions">${runButtons}</div>
        </header>
        <div class="table-wrap">${taskTable([...state.tasks].reverse())}</div>
      </section>
    </div>`;
}

function renderRuns() {
  const cards =
    state.runs.length === 0
      ? '<div class="empty-state"><div><h2>No integration runs</h2><p>Start a repository run from the task queue. Every plan, conflict, lease, replan, validation, and promotion will be retained here.</p><a class="button button-primary" href="#tasks">Open task queue</a></div></div>'
      : `<div class="card-grid">${state.runs
          .map(
            (run) => `
              <article class="run-card">
                <div class="card-meta">${statusBadge(run.status)}<span class="chip">${escapeHtml(
                  run.mode,
                )}</span></div>
                <h3>${escapeHtml(run.repositoryId)}</h3>
                <p>Started ${escapeHtml(formatDate(run.startedAt))}<br>Base ${escapeHtml(
                  shortId(run.baseRevision, 12),
                )} → ${escapeHtml(shortId(run.finalRevision ?? "pending", 12))}</p>
                <div class="card-meta">
                  <span class="chip">${escapeHtml(shortId(run.id, 18))}</span>
                  <button class="mini-button" data-run-id="${escapeHtml(
                    run.id,
                  )}">Inspect run</button>
                </div>
              </article>`,
          )
          .join("")}</div>`;
  $("#route-view").innerHTML = cards;
}

function renderApprovals() {
  const pending = state.approvals.filter(
    (approval) => approval.status === "pending",
  );
  const history = state.approvals.filter(
    (approval) => approval.status !== "pending",
  );
  $("#route-view").innerHTML = `
    ${
      pending.length > 0
        ? `<div class="signal-banner warn"><span class="health-orb warn"></span><div><strong>${pending.length} decision${
            pending.length === 1 ? "" : "s"
          } blocking work</strong><span>Review reasons and diff evidence before canonical can advance.</span></div><span class="chip">action needed</span></div>`
        : ""
    }
    <section class="panel">
      <header class="panel-head"><div><h2>Pending review</h2><p>Durable gates survive worker and browser restarts</p></div></header>
      <div class="panel-body">${approvalCards(pending, true)}</div>
    </section>
    <section class="panel panel-spaced">
      <header class="panel-head"><div><h2>Decision history</h2><p>Approved, rejected, expired, and cancelled gates</p></div></header>
      <div class="panel-body">${approvalCards(history, false)}</div>
    </section>`;
}

function approvalCards(approvals, actionable) {
  if (approvals.length === 0) {
    return `<div class="empty-state"><div><h2>${
      actionable ? "No work is blocked" : "No decisions recorded"
    }</h2><p>${
      actionable
        ? "Protected plans and changesets will wait here for a reviewer."
        : "Completed reviews will remain available as audit evidence."
    }</p></div></div>`;
  }
  return `<div class="card-grid">${approvals
    .map(
      (approval) => `
        <article class="approval-card">
          <div class="card-meta">${statusBadge(approval.status)}<span class="chip">${escapeHtml(
            approval.kind.replaceAll("_", " "),
          )}</span></div>
          <h3>${escapeHtml(approval.reasons[0] ?? "Human review required")}</h3>
          <p>${escapeHtml(approval.reasons.slice(1).join(" · ") || `Task ${shortId(approval.taskId, 16)}`)}</p>
          <div class="card-meta">
            <span class="chip">expires ${escapeHtml(formatDate(approval.expiresAt, { short: true }))}</span>
            <button class="mini-button" data-approval-id="${escapeHtml(
              approval.id,
            )}">${actionable ? "Review" : "Inspect"}</button>
          </div>
        </article>`,
    )
    .join("")}</div>`;
}

function renderRepositories() {
  $("#route-view").innerHTML = `
    <div class="split-form">
      <form class="form-card" data-form="github-import">
        <p class="eyebrow">Canonical mirror</p>
        <h2>Import from GitHub</h2>
        <p>Relay creates an internal bare mirror. Private tokens are passed only to Git and are never persisted.</p>
        <label>
          <span>Repository</span>
          <input name="repository" placeholder="owner/repository" required>
        </label>
        <div class="inline-fields">
          <label><span>Local ID (optional)</span><input name="id" placeholder="core-api"></label>
          <label><span>Branch (auto-detect)</span><input name="branch" placeholder="main"></label>
        </div>
        <label>
          <span>Fine-grained token (private repositories only)</span>
          <input name="token" type="password" autocomplete="off" placeholder="github_pat_...">
        </label>
        <button class="button button-primary" type="submit">Import repository</button>
      </form>
      <section class="panel">
        <header class="panel-head"><div><h2>Linked repositories</h2><p>${state.repositories.length} canonical mirror${
          state.repositories.length === 1 ? "" : "s"
        }</p></div></header>
        <div class="panel-body">
          ${
            state.repositories.length === 0
              ? '<div class="empty-state"><div><h2>No repository linked</h2><p>Import a public or private GitHub repository to create the first canonical source.</p></div></div>'
              : `<div class="repo-grid">${state.repositories
                  .map(
                    (repository) => `
                      <article class="repo-card">
                        <h3>${escapeHtml(repository.id)}</h3>
                        <p>${escapeHtml(repository.remoteUrl ?? "Local repository mirror")}</p>
                        <div class="card-meta">
                          <span class="chip">${escapeHtml(repository.provider ?? "local")}</span>
                          <span class="chip">${escapeHtml(repository.branch)}</span>
                          ${
                            canRun()
                              ? `<button class="mini-button" data-run-repo="${escapeHtml(
                                  repository.id,
                                )}">Run queue</button>`
                              : ""
                          }
                        </div>
                      </article>`,
                  )
                  .join("")}</div>`
          }
        </div>
      </section>
    </div>`;
}

function renderTeam() {
  const manageable = canManageMembers();
  const roles = ["owner", "admin", "developer", "reviewer", "viewer"];
  $("#route-view").innerHTML = `
    <div class="split-form">
      ${
        manageable
          ? `<form class="form-card" data-form="member-add">
              <p class="eyebrow">Organization access</p>
              <h2>Add a team member</h2>
              <p>The account must already exist on this Relay host. System administrators can create accounts.</p>
              <label><span>User email</span><input name="email" type="email" required></label>
              <label><span>Role</span><select name="role">${roles
                .filter((role) => currentRole() === "owner" || role !== "owner")
                .map((role) => `<option value="${role}">${role}</option>`)
                .join("")}</select></label>
              <button class="button button-primary" type="submit">Add member</button>
            </form>`
          : `<div class="form-card"><p class="eyebrow">Read only</p><h2>Organization team</h2><p>An owner or administrator manages membership and roles.</p></div>`
      }
      <section class="panel">
        <header class="panel-head"><div><h2>${escapeHtml(
          currentOrganization()?.name ?? "Team",
        )}</h2><p>${state.members.length} member${
          state.members.length === 1 ? "" : "s"
        }</p></div></header>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Member</th><th>Role</th><th>Joined</th><th></th></tr></thead>
            <tbody>${state.members
              .map((member) => {
                const allowedRoles =
                  currentRole() === "owner"
                    ? roles
                    : roles.filter((role) => role !== "owner");
                return `<tr>
                  <td><span class="table-title">${escapeHtml(
                    member.user?.displayName ?? member.userId,
                  )}</span><span class="table-subtitle">${escapeHtml(
                    member.user?.email ?? member.userId,
                  )}</span></td>
                  <td>${
                    manageable
                      ? `<select data-member-role="${escapeHtml(
                          member.userId,
                        )}">${allowedRoles
                          .map(
                            (role) =>
                              `<option value="${role}"${
                                role === member.role ? " selected" : ""
                              }>${role}</option>`,
                          )
                          .join("")}</select>`
                      : statusBadge(member.role)
                  }</td>
                  <td>${escapeHtml(formatDate(member.createdAt, { short: true }))}</td>
                  <td><div class="row-actions">${
                    manageable
                      ? `<button class="mini-button" data-member-remove="${escapeHtml(
                          member.userId,
                        )}">Remove</button>`
                      : ""
                  }</div></td>
                </tr>`;
              })
              .join("")}</tbody>
          </table>
        </div>
      </section>
    </div>`;
}

function renderSettings() {
  const organization = currentOrganization();
  const manageable = canManageProject();
  $("#route-view").innerHTML = `
    <div class="card-grid">
      <form class="form-card" data-form="project-update">
        <p class="eyebrow">Project identity</p>
        <h2>${escapeHtml(state.project?.name ?? "Project")}</h2>
        <label><span>Name</span><input name="name" value="${escapeHtml(
          state.project?.name,
        )}" ${manageable ? "" : "disabled"}></label>
        <label><span>Slug</span><input name="slug" value="${escapeHtml(
          state.project?.slug,
        )}" ${manageable ? "" : "disabled"}></label>
        <label><span>Description</span><textarea name="description" ${
          manageable ? "" : "disabled"
        }>${escapeHtml(state.project?.description)}</textarea></label>
        <label><span><input name="archived" type="checkbox" ${
          state.project?.archived ? "checked" : ""
        } ${manageable ? "" : "disabled"}> Archive project and make it read-only</span></label>
        ${
          manageable
            ? '<button class="button button-primary" type="submit">Save project</button>'
            : ""
        }
      </form>
      <div class="stack">
        ${
          currentRole() === "owner"
            ? `<form class="form-card" data-form="organization-update">
                <p class="eyebrow">Organization</p>
                <h2>${escapeHtml(organization?.name ?? "Organization")}</h2>
                <label><span>Name</span><input name="name" value="${escapeHtml(
                  organization?.name,
                )}"></label>
                <label><span>Slug</span><input name="slug" value="${escapeHtml(
                  organization?.slug,
                )}"></label>
                <button class="button button-quiet" type="submit">Save organization</button>
              </form>`
            : ""
        }
        ${
          manageable
            ? `<div class="form-card"><p class="eyebrow">New workspace</p><h2>Add another project</h2>${projectCreateForm()}</div>`
            : ""
        }
        <form class="form-card" data-form="organization-create">
          <p class="eyebrow">Separate tenant</p>
          <h2>Create organization</h2>
          <label><span>Name</span><input name="name" required></label>
          <label><span>Slug</span><input name="slug" pattern="[A-Za-z0-9._-]+" required></label>
          <button class="button button-quiet" type="submit">Create organization</button>
        </form>
      </div>
    </div>`;
}

function renderAdmin() {
  if (!state.admin) {
    $("#route-view").innerHTML =
      '<div class="empty-state"><div><h2>System administrator required</h2></div></div>';
    return;
  }
  const counts = state.admin.counts;
  $("#route-view").innerHTML = `
    <section class="metric-grid">
      ${metric("Users", counts.users, "Accounts on this host", "◇")}
      ${metric("Organizations", counts.organizations, "Tenant boundaries", "△")}
      ${metric("Projects", counts.projects, "Active project records", "⌁")}
      ${metric("Live sockets", counts.webSocketConnections, "Connected dashboards", "◎")}
    </section>
    <div class="split-form">
      <form class="form-card" data-form="admin-user-create">
        <p class="eyebrow">Host account</p>
        <h2>Create a user</h2>
        <label><span>Display name</span><input name="displayName" required></label>
        <label><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
        <label><span>Temporary password</span><input name="password" type="password" autocomplete="new-password" minlength="12" required></label>
        <label><span><input name="systemAdmin" type="checkbox"> System administrator</span></label>
        <button class="button button-primary" type="submit">Create user</button>
      </form>
      <section class="panel">
        <header class="panel-head"><div><h2>User accounts</h2><p>Disabling or resetting a password revokes sessions</p></div></header>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>User</th><th>Access</th><th>Status</th><th></th></tr></thead>
            <tbody>${state.admin.users
              .map(
                (user) => `<tr>
                  <td><span class="table-title">${escapeHtml(
                    user.displayName,
                  )}</span><span class="table-subtitle">${escapeHtml(
                    user.email,
                  )}</span></td>
                  <td>${user.systemAdmin ? statusBadge("admin") : statusBadge("user")}</td>
                  <td>${statusBadge(user.disabled ? "disabled" : "active")}</td>
                  <td><div class="row-actions">
                    <button class="mini-button" data-admin-toggle="systemAdmin" data-user-id="${escapeHtml(
                      user.id,
                    )}" data-next="${String(!user.systemAdmin)}">${
                      user.systemAdmin ? "Remove admin" : "Make admin"
                    }</button>
                    <button class="mini-button" data-admin-toggle="disabled" data-user-id="${escapeHtml(
                      user.id,
                    )}" data-next="${String(!user.disabled)}">${
                      user.disabled ? "Enable" : "Disable"
                    }</button>
                  </div></td>
                </tr>`,
              )
              .join("")}</tbody>
          </table>
        </div>
      </section>
    </div>`;
}

function renderError(error) {
  $("#route-view").innerHTML = `
    <div class="empty-state">
      <div><h2>Control room could not load</h2><p>${escapeHtml(
        error.message,
      )}</p><button class="button button-primary" id="inline-retry">Try again</button></div>
    </div>`;
  $("#inline-retry")?.addEventListener("click", () => {
    void loadContext();
  });
}

function diffHtml(patch) {
  if (!patch) {
    return '<div class="detail-item">No textual diff was recorded.</div>';
  }
  return `<pre class="diff">${String(patch)
    .split("\n")
    .map((line) => {
      const kind = line.startsWith("+++") || line.startsWith("---")
        ? "diff-meta"
        : line.startsWith("+")
          ? "diff-add"
          : line.startsWith("-")
            ? "diff-remove"
            : line.startsWith("@@") || line.startsWith("diff ")
              ? "diff-meta"
              : "";
      return `<span class="diff-line ${kind}">${escapeHtml(line || " ")}</span>`;
    })
    .join("")}</pre>`;
}

function openDrawer(eyebrow, title, content) {
  $("#drawer-eyebrow").textContent = eyebrow;
  $("#drawer-title").textContent = title;
  $("#drawer-body").innerHTML = content;
  $("#detail-drawer").classList.add("open");
  $("#detail-drawer").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeDrawer() {
  $("#detail-drawer").classList.remove("open");
  $("#detail-drawer").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

async function inspectRun(runId) {
  openDrawer(
    "Integration ledger",
    `Run ${shortId(runId, 12)}`,
    '<div class="skeleton skeleton-tall"></div>',
  );
  try {
    const response = await api(`/runs/${encodeURIComponent(runId)}`);
    const detail = response.run;
    $("#drawer-body").innerHTML = renderRunDetail(detail);
  } catch (error) {
    $("#drawer-body").innerHTML = `<div class="empty-state"><div><h2>Run unavailable</h2><p>${escapeHtml(
      error.message,
    )}</p></div></div>`;
  }
}

function renderRunDetail(detail) {
  const run = detail.run;
  const taskItems = detail.tasks
    .map(
      (task) => `<div class="detail-item"><strong>${escapeHtml(
        task.objective,
      )}</strong>${statusBadge(task.status)} · ${escapeHtml(
        task.agentId,
      )}<br>${escapeHtml(task.explanation ?? "No additional explanation")}</div>`,
    )
    .join("");
  const conflicts = detail.conflicts
    .map(
      (conflict) => `<div class="detail-item"><strong>Score ${escapeHtml(
        conflict.score,
      )} · ${escapeHtml(conflict.disposition)}</strong>${escapeHtml(
        conflict.explanation,
      )}</div>`,
    )
    .join("");
  const revisions = detail.planRevisions
    .map(
      (revision) => `<div class="detail-item"><strong>Plan r${escapeHtml(
        revision.revision,
      )} · ${escapeHtml(revision.reason.replaceAll("_", " "))}</strong>
        Canonical ${escapeHtml(shortId(revision.canonicalRevision, 12))}<br>
        Files: ${escapeHtml(revision.plan.expectedFiles.join(", ") || "none")}<br>
        Dependencies: ${escapeHtml(revision.plan.dependencies.join(", ") || "none")}
      </div>`,
    )
    .join("");
  const scopes = detail.scopeChanges
    .map(
      (scope) => `<div class="detail-item"><strong>${escapeHtml(
        scope.decision?.decision ?? "pending",
      )} scope request</strong>${escapeHtml(scope.request.reason)}<br>
        Files: ${escapeHtml(scope.request.additionalFiles.join(", ") || "none")}
      </div>`,
    )
    .join("");
  const integrations = detail.integrations
    .map(
      (integration) => `<div class="detail-item"><strong>${escapeHtml(
        integration.status,
      )}</strong>${escapeHtml(integration.explanation)}<br>
        ${integration.testResults
          .map(
            (result) =>
              `${escapeHtml(result.name)}: ${result.passed ? "passed" : "failed"}`,
          )
          .join("<br>")}
      </div>`,
    )
    .join("");
  const diffs = detail.changeSets
    .flatMap((changeSet) =>
      changeSet.patches.map(
        (patch) => `<div class="detail-section"><h3>${escapeHtml(
          patch.path,
        )} · ${escapeHtml(patch.status)}</h3>${diffHtml(patch.patch)}</div>`,
      ),
    )
    .join("");
  return `
    <div class="signal-banner">
      <span class="health-orb"></span>
      <div><strong>${escapeHtml(run.repositoryId)}</strong><span>${escapeHtml(
        shortId(run.baseRevision, 12),
      )} → ${escapeHtml(shortId(run.finalRevision ?? "pending", 12))}</span></div>
      ${statusBadge(run.status)}
    </div>
    <section class="detail-section"><h3>Tasks</h3><div class="detail-list">${
      taskItems || '<div class="detail-item">No task records.</div>'
    }</div></section>
    <section class="detail-section"><h3>Conflict evidence</h3><div class="detail-list">${
      conflicts || '<div class="detail-item">No structural conflicts recorded.</div>'
    }</div></section>
    <section class="detail-section"><h3>Plan history</h3><div class="detail-list">${
      revisions || '<div class="detail-item">No plan revisions recorded.</div>'
    }</div></section>
    <section class="detail-section"><h3>Scope changes</h3><div class="detail-list">${
      scopes || '<div class="detail-item">No scope expansion requested.</div>'
    }</div></section>
    <section class="detail-section"><h3>Integration</h3><div class="detail-list">${
      integrations || '<div class="detail-item">Integration has not completed.</div>'
    }</div></section>
    <section class="detail-section"><h3>Changes</h3>${
      diffs || '<div class="detail-item">No changeset diff recorded.</div>'
    }</section>
    <section class="detail-section"><h3>Run audit</h3>${timeline(
      detail.audit.map((event, index) => ({
        sequence: index,
        runId: run.id,
        event,
      })),
      100,
    )}</section>`;
}

async function inspectApproval(approvalId) {
  openDrawer(
    "Human gate",
    `Approval ${shortId(approvalId, 12)}`,
    '<div class="skeleton skeleton-tall"></div>',
  );
  try {
    const response = await api(`/approvals/${encodeURIComponent(approvalId)}`);
    $("#drawer-body").innerHTML = renderApprovalDetail(
      response.approval,
      response.changeSet,
    );
  } catch (error) {
    $("#drawer-body").innerHTML = `<div class="empty-state"><div><h2>Approval unavailable</h2><p>${escapeHtml(
      error.message,
    )}</p></div></div>`;
  }
}

function renderApprovalDetail(approval, changeSet) {
  const reasons = approval.reasons
    .map((reason) => `<div class="detail-item">${escapeHtml(reason)}</div>`)
    .join("");
  const patches =
    changeSet?.patches
      ?.map(
        (patch) => `<div class="detail-section"><h3>${escapeHtml(
          patch.path,
        )} · ${escapeHtml(patch.status)}</h3>${diffHtml(patch.patch)}</div>`,
      )
      .join("") ?? "";
  const decision =
    approval.status === "pending" && canReview()
      ? `<form class="decision-form" data-form="approval-decision" data-approval-id="${escapeHtml(
          approval.id,
        )}">
          <label><span>Reviewer comment</span><textarea name="comment" placeholder="Explain the decision for the audit record"></textarea></label>
          <button class="button button-danger" type="submit" name="status" value="rejected">Reject</button>
          <button class="button button-primary" type="submit" name="status" value="approved">Approve</button>
        </form>`
      : `<div class="detail-item"><strong>${escapeHtml(
          approval.status,
        )}</strong>${escapeHtml(
          approval.decisionComment ?? "No reviewer comment",
        )}</div>`;
  return `
    <div class="signal-banner${approval.status === "pending" ? " warn" : ""}">
      <span class="health-orb${approval.status === "pending" ? " warn" : ""}"></span>
      <div><strong>${escapeHtml(
        approval.kind.replaceAll("_", " "),
      )}</strong><span>Task ${escapeHtml(shortId(approval.taskId, 18))}</span></div>
      ${statusBadge(approval.status)}
    </div>
    <section class="detail-section"><h3>Why review is required</h3><div class="detail-list">${reasons}</div></section>
    ${
      changeSet
        ? `<section class="detail-section"><h3>Agent explanation</h3><div class="detail-item">${escapeHtml(
            changeSet.agentExplanation,
          )}</div></section>`
        : ""
    }
    ${patches}
    <section class="detail-section"><h3>Decision</h3>${decision}</section>`;
}

async function mutate(path, body, success) {
  await api(path, { method: "POST", body });
  toast(success);
  await loadContext({ quiet: true });
}

async function handleSubmit(event) {
  const form = event.target.closest("form[data-form]");
  if (!form) {
    return;
  }
  event.preventDefault();
  const submitter = event.submitter;
  submitter?.setAttribute("disabled", "");
  const data = new FormData(form);
  const value = (name) => String(data.get(name) ?? "").trim();
  try {
    switch (form.dataset.form) {
      case "login": {
        await api("/auth/login", {
          method: "POST",
          body: { email: value("email"), password: value("password") },
        });
        await enterApp();
        break;
      }
      case "bootstrap": {
        await api("/auth/bootstrap", {
          method: "POST",
          headers: { "X-Bootstrap-Token": value("token") },
          body: {
            email: value("email"),
            displayName: value("displayName"),
            password: value("password"),
            organizationName: value("organizationName"),
          },
        });
        await enterApp();
        break;
      }
      case "task-submit":
        await mutate(
          `/projects/${encodeURIComponent(state.projectId)}/tasks`,
          {
            repositoryId: value("repositoryId"),
            objective: value("objective"),
            agentId: value("agentId"),
          },
          "Task added to the coordinated queue",
        );
        form.reset();
        break;
      case "github-import":
        await mutate(
          `/projects/${encodeURIComponent(
            state.projectId,
          )}/repositories/github`,
          {
            repository: value("repository"),
            ...(value("id") ? { id: value("id") } : {}),
            ...(value("branch") ? { branch: value("branch") } : {}),
            ...(value("token") ? { token: value("token") } : {}),
          },
          "Canonical GitHub mirror imported",
        );
        form.reset();
        break;
      case "project-create": {
        const response = await api(
          `/organizations/${encodeURIComponent(state.organizationId)}/projects`,
          {
            method: "POST",
            body: {
              name: value("name"),
              slug: value("slug"),
              ...(value("description")
                ? { description: value("description") }
                : {}),
            },
          },
        );
        state.projectId = response.project.id;
        localStorage.setItem("relay.project", state.projectId);
        toast("Project created");
        await loadContext({ quiet: true });
        break;
      }
      case "project-update":
        await api(`/projects/${encodeURIComponent(state.projectId)}`, {
          method: "PATCH",
          body: {
            name: value("name"),
            slug: value("slug"),
            description: value("description"),
            archived: data.get("archived") === "on",
          },
        });
        toast("Project settings saved");
        await loadContext({ quiet: true });
        break;
      case "organization-update":
        await api(`/organizations/${encodeURIComponent(state.organizationId)}`, {
          method: "PATCH",
          body: { name: value("name"), slug: value("slug") },
        });
        toast("Organization updated");
        await loadContext({ quiet: true });
        break;
      case "organization-create": {
        const response = await api("/organizations", {
          method: "POST",
          body: { name: value("name"), slug: value("slug") },
        });
        state.organizationId = response.organization.id;
        state.projectId = "";
        toast("Organization created");
        await loadContext({ quiet: true });
        break;
      }
      case "member-add":
        await mutate(
          `/organizations/${encodeURIComponent(state.organizationId)}/members`,
          { email: value("email"), role: value("role") },
          "Team member added",
        );
        form.reset();
        break;
      case "admin-user-create":
        await mutate(
          "/admin/users",
          {
            displayName: value("displayName"),
            email: value("email"),
            password: value("password"),
            systemAdmin: data.get("systemAdmin") === "on",
          },
          "User account created",
        );
        form.reset();
        break;
      case "approval-decision": {
        const status = submitter?.value;
        await mutate(
          `/approvals/${encodeURIComponent(form.dataset.approvalId)}`,
          { status, comment: value("comment") },
          `Approval ${status}`,
        );
        closeDrawer();
        break;
      }
      default:
        throw new Error("Unknown form action");
    }
  } catch (error) {
    if (form.closest(".auth-panel")) {
      authMessage(error.message);
    } else {
      toast(error.message, "error");
    }
  } finally {
    submitter?.removeAttribute("disabled");
  }
}

async function handleClick(event) {
  const target = event.target.closest("button, a");
  if (!target) {
    return;
  }
  if (target.matches("[data-close-drawer]")) {
    closeDrawer();
    return;
  }
  if (target.dataset.authMode) {
    setAuthMode(target.dataset.authMode);
    return;
  }
  if (target.id === "refresh-button") {
    await loadContext();
    return;
  }
  if (target.id === "logout-button") {
    try {
      await api("/auth/logout", { method: "POST", body: {} });
    } finally {
      state.principal = undefined;
      showAuth();
    }
    return;
  }
  if (target.id === "menu-button") {
    const open = $("#rail").classList.toggle("open");
    target.setAttribute("aria-expanded", String(open));
    return;
  }
  if (target.closest(".primary-nav")) {
    $("#rail").classList.remove("open");
    $("#menu-button").setAttribute("aria-expanded", "false");
  }
  if (target.dataset.runRepo) {
    target.setAttribute("disabled", "");
    try {
      await mutate(
        `/projects/${encodeURIComponent(
          state.projectId,
        )}/repositories/${encodeURIComponent(target.dataset.runRepo)}/run`,
        {},
        "Coordinator accepted the repository run",
      );
    } catch (error) {
      toast(error.message, "error");
    } finally {
      target.removeAttribute("disabled");
    }
    return;
  }
  if (target.dataset.taskAction) {
    try {
      await mutate(
        `/tasks/${encodeURIComponent(target.dataset.taskId)}/${encodeURIComponent(
          target.dataset.taskAction,
        )}`,
        {},
        target.dataset.taskAction === "retry"
          ? "Task returned to the queue"
          : "Task cancelled",
      );
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  if (target.dataset.runId) {
    await inspectRun(target.dataset.runId);
    return;
  }
  if (target.dataset.approvalId) {
    await inspectApproval(target.dataset.approvalId);
    return;
  }
  if (target.dataset.memberRemove) {
    if (!window.confirm("Remove this member from the organization?")) {
      return;
    }
    try {
      await api(
        `/organizations/${encodeURIComponent(
          state.organizationId,
        )}/members/${encodeURIComponent(target.dataset.memberRemove)}`,
        { method: "DELETE", body: {} },
      );
      toast("Member removed");
      await loadContext({ quiet: true });
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  if (target.dataset.adminToggle) {
    try {
      await api(`/admin/users/${encodeURIComponent(target.dataset.userId)}`, {
        method: "PATCH",
        body: {
          [target.dataset.adminToggle]: target.dataset.next === "true",
        },
      });
      toast("User account updated");
      await loadContext({ quiet: true });
    } catch (error) {
      toast(error.message, "error");
    }
  }
}

async function handleChange(event) {
  const target = event.target;
  if (target.id === "organization-select") {
    state.organizationId = target.value;
    state.projectId = "";
    localStorage.setItem("relay.organization", state.organizationId);
    await loadContext({ quiet: true });
    return;
  }
  if (target.id === "project-select") {
    state.projectId = target.value;
    localStorage.setItem("relay.project", state.projectId);
    await loadContext({ quiet: true });
    return;
  }
  if (target.dataset.memberRole) {
    try {
      await api(
        `/organizations/${encodeURIComponent(
          state.organizationId,
        )}/members/${encodeURIComponent(target.dataset.memberRole)}`,
        { method: "PATCH", body: { role: target.value } },
      );
      toast("Member role updated");
      await loadContext({ quiet: true });
    } catch (error) {
      toast(error.message, "error");
      await loadContext({ quiet: true });
    }
  }
}

async function enterApp() {
  const me = await api("/auth/me");
  state.principal = me;
  $("#auth-shell").hidden = true;
  $("#app-shell").hidden = false;
  authMessage("");
  await loadContext({ quiet: true });
}

async function boot() {
  document.addEventListener("submit", (event) => {
    void handleSubmit(event);
  });
  document.addEventListener("click", (event) => {
    void handleClick(event);
  });
  document.addEventListener("change", (event) => {
    void handleChange(event);
  });
  window.addEventListener("hashchange", render);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDrawer();
      $("#rail").classList.remove("open");
    }
  });

  try {
    const response = await fetch(`${API_ROOT}/health`, {
      credentials: "same-origin",
    });
    state.health = await response.json();
    $("#gateway-status").textContent = state.health.setupRequired
      ? "Ready for first-run setup"
      : "Local control plane online";
    $("#gateway-status").previousElementSibling.classList.add("live");
    if (state.health.setupRequired) {
      setAuthMode("bootstrap");
    }
  } catch {
    $("#gateway-status").textContent = "Control plane unavailable";
    $("#gateway-status").previousElementSibling.classList.add("error");
  }

  try {
    await enterApp();
  } catch (error) {
    if (error.status !== 401) {
      authMessage(error.message);
    }
    showAuth();
  }
}

void boot();
