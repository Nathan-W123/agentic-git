/**
 * State, transport, and the selectors that turn control-plane records into the
 * shapes the screens render.
 *
 * The screens never call `fetch` and never reach into raw records. Everything
 * they read is derived here, which keeps one answer to questions like "which
 * agents are mine" or "what counts as a conflict" instead of one per screen.
 */

export const API_ROOT = "/api/v1";

const stored = (key, fallback = "") =>
  window.localStorage.getItem(key) ?? fallback;

export const state = {
  /* Session */
  principal: undefined,
  health: undefined,
  loaded: false,
  loadError: undefined,

  /* Context */
  organizations: [],
  organizationId: stored("ag.org"),
  projects: [],
  projectId: stored("ag.project"),
  project: undefined,
  members: [],

  /* Project data */
  repositories: [],
  tasks: [],
  runs: [],
  approvals: [],
  audit: [],
  agents: [],
  workers: [],
  metrics: undefined,

  /* Navigation */
  route: "repositories",
  repositoryId: stored("ag.repo"),

  /* Per-user agent connections (chat providers) */
  providers: [],
  providersLoaded: false,
  providerOptions: {},
  selectedAgent: stored("ag.agent", "anthropic"),
  conversations: {},
  sending: {},

  /* Code screen */
  workspace: undefined,
  files: [],
  openTabs: [],
  activeTab: "",
  fileCache: new Map(),
  dirty: new Set(),
  expanded: new Set(["src", "src/routes", "lib", "lib/oauth", "db", "tests"]),
  diffMode: stored("ag.diffMode", "unified"),
  chatOpen: stored("ag.chatOpen", "true") !== "false",
  treeOpen: false,
  navOpen: false,

  /* Notifications */
  readNotifications: new Set(
    JSON.parse(window.localStorage.getItem("ag.read") ?? "[]"),
  ),
  notificationFilter: "all",

  /* Favourites are a personal shortcut, not shared state, so they live in
     this browser rather than on the account. */
  favourites: new Set(
    JSON.parse(window.localStorage.getItem("ag.favourites") ?? "[]"),
  ),

  invitations: [],

  /* Filters */
  repoQuery: "",
  repoSort: "recent",
  repoView: "grid",
  agentFilter: "all",
  agentQuery: "",
  coordinatorTab: "overview",

  socket: undefined,
  timer: undefined,
};

export function isFavourite(repositoryId) {
  return state.favourites.has(repositoryId);
}

export function toggleFavourite(repositoryId) {
  if (state.favourites.has(repositoryId)) {
    state.favourites.delete(repositoryId);
  } else {
    state.favourites.add(repositoryId);
  }
  window.localStorage.setItem(
    "ag.favourites",
    JSON.stringify([...state.favourites]),
  );
  return state.favourites.has(repositoryId);
}

export function persist(key, value) {
  window.localStorage.setItem(key, String(value));
}

/* ---------------------------------------------------------- transport ---- */

function csrfToken() {
  return (
    document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("coord_csrf="))
      ?.slice("coord_csrf=".length) ?? ""
  );
}

export async function api(path, options = {}) {
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

/**
 * A GET whose absence is not an error. Metrics, the worker fleet, and overlay
 * workspaces are optional deployment capabilities; a control plane without
 * them answers 501 or 403 and must not blank the screen.
 */
export async function apiOptional(path, fallback) {
  try {
    return await api(path);
  } catch (error) {
    if ([401, 500].includes(error.status)) {
      throw error;
    }
    return fallback;
  }
}

/* ------------------------------------------------------------- loading ---- */

export async function loadHealth() {
  state.health = await apiOptional("/health", undefined);
  return state.health;
}

export async function loadContext() {
  state.loadError = undefined;
  state.principal = await api("/auth/me");

  const organizations = await api("/organizations");
  state.organizations = organizations.organizations ?? [];
  if (!state.organizations.some((org) => org.id === state.organizationId)) {
    state.organizationId = state.organizations[0]?.id ?? "";
  }
  persist("ag.org", state.organizationId);

  if (state.organizationId) {
    const org = encodeURIComponent(state.organizationId);
    const [projects, members] = await Promise.all([
      api(`/organizations/${org}/projects`),
      apiOptional(`/organizations/${org}/members`, { members: [] }),
    ]);
    state.projects = projects.projects ?? [];
    state.members = members.members ?? [];
  } else {
    state.projects = [];
    state.members = [];
  }

  if (!state.projects.some((project) => project.id === state.projectId)) {
    state.projectId = state.projects[0]?.id ?? "";
  }
  persist("ag.project", state.projectId);

  if (state.projectId) {
    const project = encodeURIComponent(state.projectId);
    const org = encodeURIComponent(state.organizationId);
    const [
      repositories,
      tasks,
      runs,
      approvals,
      audit,
      agents,
      detail,
      metrics,
      workers,
    ] = await Promise.all([
      api(`/projects/${project}/repositories`),
      api(`/projects/${project}/tasks`),
      api(`/projects/${project}/runs?limit=100`),
      api(`/projects/${project}/approvals`),
      api(`/projects/${project}/audit`),
      apiOptional(`/projects/${project}/agents`, { agents: [] }),
      api(`/projects/${project}`),
      apiOptional(`/projects/${project}/metrics`, { metrics: undefined }),
      apiOptional(`/workers?organizationId=${org}`, { workers: [] }),
    ]);
    state.repositories = repositories.repositories ?? [];
    state.tasks = tasks.tasks ?? [];
    state.runs = runs.runs ?? [];
    state.approvals = approvals.approvals ?? [];
    state.audit = audit.events ?? [];
    state.agents = agents.agents ?? [];
    state.project = detail.project;
    state.metrics = metrics.metrics;
    state.workers = workers.workers ?? [];
  } else {
    Object.assign(state, {
      repositories: [],
      tasks: [],
      runs: [],
      approvals: [],
      audit: [],
      agents: [],
      project: undefined,
      metrics: undefined,
      workers: [],
    });
  }

  if (
    state.repositoryId &&
    !state.repositories.some((repo) => repo.id === state.repositoryId)
  ) {
    state.repositoryId = "";
  }
  state.loaded = true;
}

export async function loadProviders() {
  const response = await apiOptional("/chat/providers", { providers: [] });
  state.providers = response.providers ?? [];
  state.providersLoaded = true;
  if (!state.providers.some((entry) => entry.id === state.selectedAgent)) {
    state.selectedAgent =
      state.providers.find((entry) => entry.connected)?.id ??
      state.providers[0]?.id ??
      "";
  }
  return state.providers;
}

export async function loadProviderOptions(providerId) {
  if (state.providerOptions[providerId] !== undefined) {
    return state.providerOptions[providerId];
  }
  const response = await apiOptional(
    `/chat/providers/${encodeURIComponent(providerId)}/options`,
    { options: null },
  );
  state.providerOptions[providerId] = response.options ?? null;
  return state.providerOptions[providerId];
}

export async function applyProviderSetting(providerId, field, value) {
  const response = await api(
    `/chat/providers/${encodeURIComponent(providerId)}/settings`,
    { method: "POST", body: { [field]: value } },
  );
  state.providers = response.providers ?? state.providers;
  return state.providers;
}

/* ------------------------------------------------------------- socket ---- */

export function connectSocket(onEvent) {
  closeSocket();
  if (!state.projectId) {
    return;
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  // The hub listens on one path and scopes the subscription by query, so a
  // single upgrade handler serves every project.
  const after = state.audit.at(-1)?.sequence ?? 0;
  const url =
    `${protocol}://${window.location.host}${API_ROOT}/events` +
    `?projectId=${encodeURIComponent(state.projectId)}&after=${after}`;
  try {
    const socket = new WebSocket(url);
    state.socket = socket;
    socket.addEventListener("message", (message) => {
      try {
        onEvent(JSON.parse(message.data));
      } catch {
        /* A frame we cannot parse is not worth breaking the stream over. */
      }
    });
    socket.addEventListener("close", () => {
      if (state.socket === socket) {
        state.socket = undefined;
      }
    });
  } catch {
    state.socket = undefined;
  }
}

export function closeSocket() {
  if (state.socket !== undefined) {
    try {
      state.socket.close();
    } catch {
      /* Already closing. */
    }
    state.socket = undefined;
  }
}

export function socketLive() {
  return state.socket?.readyState === WebSocket.OPEN;
}

/* -------------------------------------------------------- invitations ---- */

/**
 * Roles an invitation can carry.
 *
 * The server refuses a role above the inviter's own, so this list is what the
 * form offers rather than what it guarantees.
 */
export const INVITE_ROLES = [
  { value: "developer", label: "Developer", detail: "Submit and run work" },
  { value: "reviewer", label: "Reviewer", detail: "Approve changes" },
  { value: "viewer", label: "Viewer", detail: "Read-only" },
  { value: "admin", label: "Admin", detail: "Manage people and settings" },
];

export async function loadInvitations() {
  if (!state.organizationId) {
    state.invitations = [];
    return state.invitations;
  }
  const response = await apiOptional(
    `/organizations/${encodeURIComponent(state.organizationId)}/invitations`,
    { invitations: [] },
  );
  state.invitations = response.invitations ?? [];
  return state.invitations;
}

export async function createInvitation(email, role) {
  const response = await api(
    `/organizations/${encodeURIComponent(state.organizationId)}/invitations`,
    { method: "POST", body: { email, role } },
  );
  await loadInvitations();
  return response;
}

export async function revokeInvitation(invitationId) {
  await api(
    `/organizations/${encodeURIComponent(state.organizationId)}/invitations/` +
      encodeURIComponent(invitationId),
    { method: "DELETE" },
  );
  await loadInvitations();
}

/** The link a recipient opens. Built here so one place decides its shape. */
export function invitationLink(token) {
  return `${window.location.origin}/#invite/${token}`;
}

export async function readInvitation(token) {
  return await api(`/invitations/${encodeURIComponent(token)}`);
}

export async function acceptInvitation(token, displayName, password) {
  return await api(`/invitations/${encodeURIComponent(token)}/accept`, {
    method: "POST",
    body: { displayName, password },
  });
}

/* --------------------------------------------------------- appearance ---- */

export const DEFAULT_ACCENT = "#8b5cf6";

/**
 * The palette offered in settings.
 *
 * Eight widely separated hues, all legible on the dark ground. Kept short on
 * purpose: an agent colour is only useful as an identity if a team's choices
 * are easy to tell apart, and a continuous picker guarantees two people
 * eventually land on near-identical blues.
 */
export const PALETTE = [
  { value: "#8b5cf6", label: "Violet" },
  { value: "#4f8ef7", label: "Blue" },
  { value: "#2fae7f", label: "Green" },
  { value: "#e0663d", label: "Orange" },
  { value: "#e05f9e", label: "Pink" },
  { value: "#3fa8b5", label: "Teal" },
  { value: "#d7a13b", label: "Amber" },
  { value: "#a06ee0", label: "Lilac" },
];

function validColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value.trim())
    ? value.trim().toLowerCase()
    : undefined;
}

/**
 * The colour a user's agents are drawn in.
 *
 * Falls back to a stable colour derived from the user id rather than to one
 * shared default, so two people who never opened settings still read as two
 * people. Chosen values always win.
 */
export function agentColorFor(userId) {
  const appearance = appearanceFor(userId);
  const chosen = validColor(appearance?.agentColor);
  if (chosen !== undefined) {
    return chosen;
  }
  const text = String(userId ?? "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length].value;
}

function appearanceFor(userId) {
  if (userId === currentUserId() || userId === undefined) {
    return state.principal?.user?.appearance;
  }
  const member = state.members.find(
    (entry) => (entry.user?.id ?? entry.userId) === userId,
  );
  return member?.user?.appearance;
}

export function myAgentColor() {
  return agentColorFor(currentUserId());
}

export function myAccent() {
  return (
    validColor(state.principal?.user?.appearance?.accent) ?? DEFAULT_ACCENT
  );
}

/** Saves an appearance choice and re-reads the principal it now belongs to. */
export async function saveAppearance(patch) {
  const response = await api("/auth/me/appearance", {
    method: "PATCH",
    body: patch,
  });
  if (state.principal?.user !== undefined && response.user !== undefined) {
    state.principal = {
      ...state.principal,
      user: { ...state.principal.user, ...response.user },
    };
  }
  return response.user;
}

/* ---------------------------------------------------------- selectors ---- */

export function currentRepository() {
  return (
    state.repositories.find((repo) => repo.id === state.repositoryId) ??
    state.repositories[0]
  );
}

export function currentUserName() {
  return (
    state.principal?.user?.displayName ??
    state.principal?.user?.email ??
    "Signed in"
  );
}

export function currentUserId() {
  return state.principal?.user?.id ?? "";
}

export function memberName(userId) {
  const member = state.members.find((entry) => entry.userId === userId || entry.id === userId);
  return member?.displayName ?? member?.email ?? userId ?? "Unknown";
}

/** Everyone with a seat on this project — the collaborator avatars. */
export function collaborators() {
  const names = state.members
    .map((member) => member.displayName ?? member.email)
    .filter(Boolean);
  return names.length > 0 ? names : [currentUserName()];
}

/**
 * Work the coordinator currently owns.
 *
 * A submitted task is already the coordinator's problem — it is queued for
 * scheduling — so it belongs here. Only a finished task, or one parked on a
 * person, is excluded.
 */
const ACTIVE_TASK_STATUS = new Set([
  "submitted",
  "planning",
  "running",
  "replanning",
  "validating",
  "queued",
  "approved",
  "claimed",
]);

export function activeTasks() {
  return state.tasks.filter((task) => ACTIVE_TASK_STATUS.has(task.status));
}

/** Work stopped on a person rather than on a resource. */
export function waitingTasks() {
  return state.tasks.filter((task) => task.status === "awaiting_approval");
}

export function completedToday() {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  return state.tasks.filter(
    (task) =>
      task.status === "integrated" &&
      task.completedAt !== undefined &&
      new Date(task.completedAt).getTime() >= dayStart.getTime(),
  ).length;
}

/**
 * How far along a task is.
 *
 * The pipeline has fixed stages, so the honest progress signal is which stage
 * the task has reached — not a number an agent invented. A task that has not
 * started reads 0, an integrated one reads 100.
 */
const STAGE_PROGRESS = {
  submitted: 4,
  planning: 18,
  approved: 30,
  queued: 26,
  claimed: 34,
  running: 62,
  replanning: 48,
  awaiting_approval: 78,
  validating: 88,
  integrated: 100,
  failed: 100,
  cancelled: 100,
};

export function taskProgress(task) {
  return STAGE_PROGRESS[task?.status] ?? 0;
}

/**
 * Whether a task has actually started.
 *
 * Queued work has no meaningful progress, and drawing it as a nearly-empty bar
 * made every waiting task look identically stuck. The stage name is the
 * honest readout until an agent is running.
 */
const NOT_STARTED = new Set(["submitted", "queued", "approved", "awaiting_approval"]);

export function taskStarted(task) {
  return !NOT_STARTED.has(task?.status);
}

/** Files an executing plan declared — the resources it currently holds. */
export function heldFiles() {
  const active = new Map(activeTasks().map((task) => [task.id, task]));
  const held = [];
  const seen = new Set();
  for (const entry of [...state.audit].reverse()) {
    const event = entry.event ?? entry;
    if (event.type !== "plan_received" || !active.has(event.taskId)) {
      continue;
    }
    const files = event.data?.expectedFiles;
    if (!Array.isArray(files)) {
      continue;
    }
    for (const file of files) {
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      held.push({
        path: file,
        taskId: event.taskId,
        agentId: active.get(event.taskId)?.agentId ?? "agent",
        since: event.occurredAt,
      });
    }
  }
  return held;
}

export function conflictCount() {
  const active = new Set(activeTasks().map((task) => task.id));
  return state.audit.filter((entry) => {
    const event = entry.event ?? entry;
    return event.type === "conflict_detected" && active.has(event.taskId);
  }).length;
}

export function systemHealth() {
  if (state.approvals.some((approval) => approval.status === "pending")) {
    return { label: "Review", tone: "orange" };
  }
  const failing = state.tasks.filter((task) => task.status === "failed").length;
  if (failing > 0 && conflictCount() > 0) {
    return { label: "Degraded", tone: "red" };
  }
  if (failing > 0) {
    return { label: "Fair", tone: "orange" };
  }
  return { label: "Good", tone: "green" };
}

/* ------------------------------------------------------------- agents ---- */

const ROLE_BY_PROVIDER = {
  anthropic: "Lead Developer",
  openai: "Code Generator",
  google: "Researcher",
  deepseek: "Backend Engineer",
};

/** People say "Claude", not "Anthropic", when they mean the agent. */
const AGENT_LABEL = {
  anthropic: "Claude",
  openai: "Codex",
  google: "Gemini",
};

/**
 * The signed-in user's own agents.
 *
 * Deliberately not a project-wide roster: an agent connection is a personal
 * credential, and two people on one repository each bring their own. What is
 * shared is the work those agents produce, which the Coordinator screen shows.
 */
export function myAgents() {
  const mine = currentUserId();
  const tasks = state.tasks.filter(
    (task) => task.submittedBy === undefined || task.submittedBy === mine,
  );
  return state.providers.map((provider) => {
    const running = tasks.find(
      (task) =>
        ACTIVE_TASK_STATUS.has(task.status) &&
        String(task.agentId ?? "").includes(provider.adapter ?? provider.id),
    );
    const presence = provider.connected
      ? running === undefined
        ? "idle"
        : "online"
      : "offline";
    return {
      id: provider.id,
      provider: provider.id,
      name: `${AGENT_LABEL[provider.id] ?? provider.name ?? provider.id} (${shortUser()})`,
      role: ROLE_BY_PROVIDER[provider.id] ?? "Agent",
      model: provider.model ?? "",
      effort: provider.effort ?? "",
      connected: provider.connected === true,
      presence,
      status: provider.connected ? (running ? "working" : "idle") : "offline",
      task: running,
      progress: running === undefined ? 0 : taskProgress(running),
      contextPercent: contextPercentFor(provider.id),
      color: myAgentColor(),
      detail: provider.explanation ?? "",
    };
  });
}

function shortUser() {
  const name = state.principal?.user?.displayName ?? "";
  return name.split(/\s+/u)[0] || "you";
}

/** How full the last exchange left this provider's window, when it says. */
export function contextPercentFor(providerId) {
  const conversation = state.conversations[providerId] ?? [];
  const last = [...conversation].reverse().find((entry) => entry.usage);
  const usage = last?.usage;
  if (usage === undefined) {
    return 0;
  }
  const used = Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0);
  const window = Number(last.contextWindow ?? 0);
  if (!Number.isFinite(used) || !Number.isFinite(window) || window <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((used / window) * 100));
}

export function selectedAgent() {
  const agents = myAgents();
  return (
    agents.find((agent) => agent.id === state.selectedAgent) ?? agents[0]
  );
}

/* ------------------------------------------------------ notifications ---- */

const NOTIFY = {
  canonical_promoted: {
    kind: "completed",
    tone: "green",
    iconName: "checkCircle",
    title: "Agent completed a task",
  },
  approval_requested: {
    kind: "approval",
    tone: "orange",
    iconName: "alert",
    title: "Approval required",
  },
  approval_decided: {
    kind: "approval",
    tone: "purple",
    iconName: "checkCircle",
    title: "Approval decided",
  },
  conflict_detected: {
    kind: "conflict",
    tone: "orange",
    iconName: "layers",
    title: "Coordinator delayed a task",
  },
  scope_granted: {
    kind: "conflict",
    tone: "green",
    iconName: "layers",
    title: "Conflict resolved automatically",
  },
  task_failed: {
    kind: "failure",
    tone: "red",
    iconName: "alert",
    title: "Task failed",
  },
  validation_completed: {
    kind: "tests",
    tone: "blue",
    iconName: "checkCircle",
    title: "Validation finished",
  },
  worker_expired: {
    kind: "offline",
    tone: "grey",
    iconName: "cpu",
    title: "Agent went offline",
  },
  // A plan being submitted is ordinary pipeline traffic, not something a
  // person needs told; it stays on the coordinator's activity feed instead.
};

/**
 * The audit stream reduced to the events a person actually needs to see.
 *
 * Everything the coordinator records is available on the run detail; this is
 * the far smaller set that warrants interrupting someone.
 */
export function notifications() {
  const rows = [];
  for (const entry of state.audit) {
    const event = entry.event ?? entry;
    const meta = NOTIFY[event.type];
    if (meta === undefined) {
      continue;
    }
    if (event.type === "validation_completed" && event.data?.status === "integrated") {
      continue;
    }
    const task = state.tasks.find((candidate) => candidate.id === event.taskId);
    rows.push({
      id: event.id ?? `${event.type}-${event.occurredAt}-${event.taskId ?? ""}`,
      ...meta,
      at: event.occurredAt,
      body: notificationBody(event, task),
      taskId: event.taskId,
      agentId: task?.agentId,
    });
  }
  rows.sort((left, right) => String(right.at).localeCompare(String(left.at)));
  return rows.slice(0, 60);
}

function notificationBody(event, task) {
  const objective = task?.objective ?? "";
  switch (event.type) {
    case "canonical_promoted":
      return `${objective || "A change"} was validated and promoted to canonical${
        event.data?.revision
          ? ` at ${String(event.data.revision).slice(0, 8)}`
          : ""
      }.`;
    case "approval_requested":
      return `${objective || "A change"} needs a decision: ${
        Array.isArray(event.data?.reasons)
          ? event.data.reasons.join("; ")
          : "policy gate"
      }.`;
    case "approval_decided":
      return `Approval ${String(event.data?.status ?? "")} ${
        event.data?.decidedBy ? `by ${memberName(event.data.decidedBy)}` : ""
      }.`;
    case "conflict_detected":
      return String(
        event.data?.explanation ??
          "Overlapping scope with work already executing; the task was sequenced behind it.",
      );
    case "scope_granted":
      return "Scope was widened and granted without displacing another agent.";
    case "task_failed":
      return String(event.data?.explanation ?? event.data?.error ?? "The run did not complete.");
    case "validation_completed":
      return `Validation reported ${String(event.data?.status ?? "a result")}.`;
    default:
      return objective || "Coordinator activity.";
  }
}

export function unreadCount() {
  return notifications().filter((row) => !state.readNotifications.has(row.id))
    .length;
}

export function markRead(ids) {
  for (const id of ids) {
    state.readNotifications.add(id);
  }
  window.localStorage.setItem(
    "ag.read",
    JSON.stringify([...state.readNotifications].slice(-400)),
  );
}

/* --------------------------------------------------- coordinator feed ---- */

const ACTIVITY_LABEL = {
  plan_received: "Plan received",
  conflict_detected: "Task delayed",
  scope_granted: "Lock granted",
  scope_rejected: "Scope refused",
  changeset_collected: "Changes collected",
  validation_completed: "Validation finished",
  canonical_promoted: "Merge completed",
  approval_requested: "Approval requested",
  approval_decided: "Approval decided",
  task_failed: "Task failed",
  lease_released: "Lock released",
};

export function coordinatorActivity(limit = 6) {
  const rows = [];
  for (const entry of state.audit) {
    const event = entry.event ?? entry;
    const label = ACTIVITY_LABEL[event.type];
    if (label === undefined) {
      continue;
    }
    const task = state.tasks.find((candidate) => candidate.id === event.taskId);
    rows.push({
      at: event.occurredAt,
      title: label,
      detail: activityDetail(event, task),
      agent: task?.agentId,
      type: event.type,
    });
  }
  rows.sort((left, right) => String(right.at).localeCompare(String(left.at)));
  return rows.slice(0, limit);
}

function activityDetail(event, task) {
  const files = event.data?.expectedFiles ?? event.data?.files;
  if (Array.isArray(files) && files.length > 0) {
    return `${files[0]}${files.length > 1 ? ` +${files.length - 1} more` : ""}`;
  }
  if (event.data?.explanation) {
    return String(event.data.explanation);
  }
  return task?.objective ?? "";
}

/** The connected external systems, read from what the project really has. */
export function integrations() {
  const rows = [];
  const remote = state.repositories.find((repo) => repo.remoteUrl);
  rows.push({
    name: remote?.remoteUrl?.includes("github") ? "GitHub" : "Git remote",
    iconName: "github",
    connected: remote !== undefined,
    detail: remote?.remoteUrl ?? "No remote recorded",
  });
  // Validation is configured on the control-plane host, not in the project
  // record, so the honest signal is whether it has actually run.
  const validated = state.audit.filter((entry) => {
    const event = entry.event ?? entry;
    return event.type === "validation_completed";
  }).length;
  rows.push({
    name: "CI/CD Pipeline",
    iconName: "sync",
    connected: validated > 0,
    detail:
      validated > 0
        ? `${validated} validation run${validated === 1 ? "" : "s"} recorded`
        : "No validation has run yet",
  });
  rows.push({
    name: "Database",
    iconName: "database",
    connected: true,
    detail: "Coordination store",
  });
  return rows;
}
