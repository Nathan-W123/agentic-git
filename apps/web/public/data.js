/**
 * State, transport, and the selectors that turn control-plane records into the
 * shapes the screens render.
 *
 * The screens never call `fetch` and never reach into raw records. Everything
 * they read is derived here, which keeps one answer to questions like "which
 * agents are mine" or "what counts as a conflict" instead of one per screen.
 */

import { toast } from "./ui.js";

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
  route: "chats",
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

  /* Chats screen — one group channel per repository, backed by
     `/channel/messages` on the server. `channelMessages` and
     `channelAgentOverrides` are seeded locally so a freshly opened channel is
     never blank, then overwritten once `ensureChannelMessages` reads the real
     ones back. See the comment on `sendChannelMessage`. */
  chatQuery: "",
  channelMessages: {},
  channelAgentOverrides: {},
  channelRead: JSON.parse(window.localStorage.getItem("ag.chanread") ?? "{}"),
  /** Repository ids whose channel has been read from the server at least once. */
  channelLoaded: new Set(),
  channelLoadingId: undefined,
  /** Every repository collaborator's connected agents, keyed by repository id
   *  and read from `/channel/agents` — see `ensureChannelRoster`. Starts empty
   *  per repository until the first fetch resolves; `channelAgentsFor` always
   *  layers this account's own agents on top from `myAgents`, so the roster
   *  is never blank for the one person definitely in the room. */
  channelRoster: {},
  channelRosterLoaded: new Set(),
  channelRosterLoadingId: undefined,
  /**
   * Whether each repository's auditor is switched off, keyed by repository
   * id. Absent means on: a repository nobody has switched off is auditing,
   * and so is one whose roster has not loaded yet — the toggle only renders
   * beside an auditor, which only appears once the roster is in.
   */
  auditorPaused: {},
  /** Repository-scoped grants, keyed by repository id — see `ensureRepositoryGrants`. */
  repositoryGrants: {},
  activeChannelThread: undefined,
  /**
   * The thread the composer is aimed at, if the reader chose one.
   *
   * Item 4 of the threading work, explicit rather than automatic: guessing
   * that two requests are the same task and merging them buries work where
   * nobody looks for it, which is worse than leaving them apart.
   */
  composerThreadId: undefined,
  // Whether the list of this channel's threads is pulled out.
  chanThreadList: false,
  // Whether the file tree is pulled out, and which folders are open in it.
  chanTree: false,
  chanTreeOpen: [],
  // Whether the channel list + roster drawer is pulled out over the
  // transcript. Only meaningful at phone widths, where `.chan-sidebar` is
  // off-canvas the way the outer app `.sidebar` already is at `navOpen`.
  chanSidebarOpen: false,
  /*
   * The two left columns, folded away on wide screens.
   *
   * Separate from `navOpen`/`chanSidebarOpen`, which are the phone's
   * off-canvas drawers: those answer "show me the thing that does not fit",
   * and these answer "I know what is there, give the conversation the room".
   * One pair of flags serving both would mean opening the drawer on a phone
   * un-collapsing the desktop layout on the next resize.
   *
   * Remembered in this browser, because a collapsed panel that reappears on
   * every reload is not collapsed, it is flickering.
   */
  navCollapsed: stored("ag.navCollapsed", "false") === "true",
  chanCollapsed: stored("ag.chanCollapsed", "false") === "true",
  // Per-provider usage reports, filled lazily by the roster's hover.
  providerUsage: {},
  // Who is typing, keyed `repositoryId|threadId` so the main channel and
  // each thread are separate surfaces — typing in a thread must not raise
  // dots in the room behind it. Values are `{ [userId]: {name, expiresAt} }`.
  typing: {},
  // Agents the server says are mid-task, keyed by task id.
  agentBusy: {},
  /**
   * Who currently has this project open, as user ids.
   *
   * Read off the server's open sockets rather than stored, so it is a fact
   * about now and goes stale the moment the tab is backgrounded — which is
   * why it is refreshed with the inbox rather than cached against a person.
   */
  presence: [],
  /** Everyone in the organization who could be written to, with their state. */
  dmPeople: [],
  /** Conversations that already exist, most recently active first. */
  dmConversations: [],
  /** Loaded threads, keyed by the other person's user id. */
  dmThreads: {},
  /** The conversation open in the side panel, if any. */
  activeDm: undefined,
  /** Any agent in the room, open in that same panel. */
  activeAgentPanel: undefined,
  /**
   * Which half of an agent's panel is showing: "history" or "chat".
   *
   * History is the default because it is the half that exists for every
   * agent — a private chat is only ever with your own, so opening straight
   * into one would show most of the roster an empty room they cannot use.
   */
  agentPanelTab: "history",
  /*
   * Whether a thread's thinking block is unfolded, keyed by thread id.
   *
   * Only holds threads the reader has actually clicked. An absent entry means
   * "no opinion", which is what lets the default (open while running, folded
   * once finished) still apply to every thread they have not touched.
   */
  thinkingOpen: {},
  /** What is half-typed to them. */
  dmDraft: "",
  /** Message/token totals per repository, for the info popover. */
  channelStats: {},
  /** Everyone in each repository's room — org members plus repo grantees. */
  channelPeople: {},
  /**
   * This repository's running app, keyed by repository id.
   *
   * `null` means asked and there is none — which is different from absent,
   * meaning nobody has asked yet, and is what stops the button flickering
   * between states on every render.
   */
  previews: {},
  /** The project whose inbox has been fetched, so it is fetched once. */
  dmLoadedProject: undefined,
  // Paths whose inline diff is expanded in the transcript. Plural because a
  // reader comparing two files should not have to close one to open the other.
  chanOpenFiles: [],
  /** The changed file open in the side panel, if any. */
  chanFileView: undefined,
  /** How the open file is being shown: its diff, or its editable text. */
  chanFileMode: "diff",
  /** The file's text as the workspace last gave it, and as it is being typed. */
  chanFileBase: undefined,
  chanFileDraft: undefined,
  chanFileLoading: false,
  chanFileSaving: false,
  chanFileError: undefined,
  /** Which repository `state.workspace` belongs to, so it is not reused wrongly. */
  workspaceRepo: undefined,
  chatRenamingId: undefined,
  chatSettingsOpenId: undefined,
  chatDraft: "",
  threadDraft: "",
  mentionActive: false,
  mentionQuery: "",
  mentionIndex: 0,
  // The command picker, mirroring the three above. Its candidates come from
  // the server with the messages, so it can never offer something the
  // channel would not recognise.
  slashActive: false,
  slashQuery: "",
  slashIndex: 0,
  channelSlashCommands: {},
  chanMsgQuery: "",
  chanMsgSearchOpen: false,

  /* The sandbox terminal drawer. `termLog` is the transcript as rendered
     blocks rather than a flat string, so a command and what it printed stay
     associated and an exit code can be shown against the line that produced
     it. `termPast` is command recall (Up/Down), newest last, and `termSeek`
     is where the caret currently sits in it -- undefined meaning "at the
     live line, not recalling". */
  termOpen: false,
  termBusy: false,
  /* Drawer height in pixels, dragged by its top edge and remembered. */
  termHeight: Number(localStorage.getItem("ag.termHeight")) || 260,
  termDraft: "",
  termLog: [],
  termPast: [],
  termSeek: undefined,

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

/**
 * What the vendor's CLI reports the signed-in account has consumed.
 *
 * Fetched once per provider and kept, because the roster asks for it on hover
 * — a figure that costs a CLI invocation server-side must not be re-fetched
 * every time a pointer crosses a row. `undefined` means "not asked yet";
 * a stored `unavailableReason` is an answer and stops further asking.
 */
export async function ensureProviderUsage(providerId, rerender) {
  if (!providerId || state.providerUsage[providerId] !== undefined) {
    return state.providerUsage[providerId];
  }
  state.providerUsage[providerId] = { loading: true };
  try {
    const response = await api(
      `/chat/providers/${encodeURIComponent(providerId)}/usage`,
    );
    state.providerUsage[providerId] = response.usage ?? {
      unavailableReason: "This deployment reported no usage.",
    };
  } catch (error) {
    state.providerUsage[providerId] = { unavailableReason: error.message };
  }
  rerender?.();
  return state.providerUsage[providerId];
}

export async function applyProviderSetting(providerId, field, value) {
  const response = await api(
    `/chat/providers/${encodeURIComponent(providerId)}/settings`,
    { method: "POST", body: { [field]: value } },
  );
  state.providers = response.providers ?? state.providers;
  return state.providers;
}

/**
 * Stores a credential of the caller's own for a provider.
 *
 * The secret goes up and nothing comes back but the ordinary provider list:
 * the server never returns it, so there is nothing here to keep or to leak
 * into a log. What changes in the response is `ownCredential` appearing and
 * `requiresAdmin` clearing, which is what the screen re-renders from.
 */
export async function connectProviderCredential(providerId, kind, secret, label, visibility) {
  const response = await api(
    `/chat/providers/${encodeURIComponent(providerId)}/credential`,
    {
      method: "POST",
      body: {
        kind,
        secret,
        ...(label === undefined || label === "" ? {} : { label }),
        // Omitted entirely rather than sent as "personal": the server
        // defaults an absent visibility to "personal" itself, so this keeps
        // the request identical to what an older client already sends.
        ...(visibility === undefined || visibility === "personal"
          ? {}
          : { visibility }),
      },
    },
  );
  state.providers = response.providers ?? state.providers;
  return state.providers;
}

/**
 * Signing a provider in through the browser, rather than fetching a secret.
 *
 * Four calls on one route, because the flow is a conversation: start it, poll
 * it, sometimes answer it with a code the vendor's page gave the user, and
 * abandon it if they close the dialog. The flow id is opaque and scoped to
 * the caller server-side, so it travels in the query string.
 */
export async function startProviderSignIn(providerId) {
  const response = await api(
    `/chat/providers/${encodeURIComponent(providerId)}/device-auth`,
    { method: "POST" },
  );
  return response.deviceAuth;
}

export async function providerSignInStatus(providerId, flowId) {
  const response = await api(
    `/chat/providers/${encodeURIComponent(providerId)}/device-auth` +
      `?flow=${encodeURIComponent(flowId)}`,
  );
  return response.deviceAuth;
}

/** Hands the waiting CLI the code the vendor's page showed the user. */
export async function submitProviderSignInCode(providerId, flowId, code) {
  const response = await api(
    `/chat/providers/${encodeURIComponent(providerId)}/device-auth` +
      `?flow=${encodeURIComponent(flowId)}`,
    { method: "POST", body: { code } },
  );
  return response.deviceAuth;
}

/**
 * Abandons a sign-in. Deliberately swallows its own failure: this runs when
 * somebody closes the dialog, and a dead flow they have already walked away
 * from is not worth an error toast.
 */
export async function cancelProviderSignIn(providerId, flowId) {
  try {
    await api(
      `/chat/providers/${encodeURIComponent(providerId)}/device-auth` +
        `?flow=${encodeURIComponent(flowId)}`,
      { method: "DELETE" },
    );
  } catch {
    // Nothing to do about it, and nothing the user needs to see.
  }
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

/* ------------------------------------------------------------- typing ---- */

const TYPING_TTL_MS = 4_000;
const TYPING_SEND_EVERY_MS = 2_000;
const typingLastSent = new Map();

/** One surface: the channel itself, or one thread inside it. */
const typingKey = (repositoryId, threadId) =>
  `${repositoryId}|${threadId ?? ""}`;

/**
 * Tells the server this account is typing, at most every couple of seconds.
 *
 * Throttled rather than sent per keystroke: the signal only has to outlive
 * its own TTL to read as continuous, and a frame per character would be a
 * fan-out per character to every other subscriber.
 */
export function sendTyping(repositoryId, threadId, draft) {
  if (!repositoryId || !state.projectId) {
    return;
  }
  // Clearing the box is not typing. Without this, deleting a draft kept
  // renewing the signal on every keystroke of the deletion, so the dots
  // outlived the intent by a full TTL after somebody changed their mind.
  if (typeof draft === "string" && draft.trim() === "") {
    return;
  }
  const key = typingKey(repositoryId, threadId);
  const now = Date.now();
  if (now - (typingLastSent.get(key) ?? 0) < TYPING_SEND_EVERY_MS) {
    return;
  }
  typingLastSent.set(key, now);
  void api(channelPath(repositoryId, "/typing"), {
    method: "POST",
    body: { ...(threadId === undefined ? {} : { threadId }) },
  }).catch(() => {
    /* A dropped typing frame is not worth a toast. */
  });
}

/** How long after the last frame a surface should be swept for expiry. */
export const TYPING_SWEEP_MS = TYPING_TTL_MS + 250;

/* ---------------------------------------------------------- code names ---- */

/**
 * Call signs for agents in a channel.
 *
 * "Claude (Nathan)" says which vendor and whose account, which is exactly
 * what nobody needs while reading a conversation — and it collides the moment
 * one person brings two agents. A call sign is short, distinct, and
 * pronounceable, which is what a name in a chat is actually for. Deliberately
 * a flat list rather than generated syllables: every one of these reads as a
 * name, and none of them will ever come out unpronounceable or unfortunate.
 */
export const AGENT_CODE_NAMES = [
  // The NATO alphabet, which exists precisely to stay unambiguous over a bad
  // connection — the same job a name has in a busy channel.
  "Alfa", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel",
  "India", "Juliett", "Kilo", "Lima", "Mike", "November", "Oscar", "Papa",
  "Quebec", "Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey",
  "Xray", "Yankee", "Zulu",
  // Greek myth, for the same reason call signs have always borrowed from it:
  // one word, already known, and nothing like a username.
  "Achilles", "Aegis", "Ajax", "Andromeda", "Apollo", "Argus", "Artemis",
  "Atlas", "Boreas", "Calypso", "Cassandra", "Castor", "Chiron", "Daedalus",
  "Eos", "Erebus", "Gaia", "Hecate", "Helios", "Hermes", "Hestia", "Hydra",
  "Hyperion", "Icarus", "Iris", "Kratos", "Leto", "Medea", "Morpheus",
  "Nemesis", "Nereus", "Nike", "Notus", "Odysseus", "Orion", "Orpheus",
  "Pallas", "Pandora", "Perseus", "Phoenix", "Pollux", "Poseidon",
  "Prometheus", "Rhea", "Selene", "Thalia", "Theseus", "Triton", "Zephyrus",
];

/** Names already spoken for in this channel, however they were set. */
function takenChannelNames(repositoryId) {
  return new Set(channelAgentsFor(repositoryId).map((agent) => agent.name));
}

/**
 * A call sign nobody in this channel is using.
 *
 * Uniqueness is per channel because that is the scope a name has to be
 * unambiguous in: `@Vesper` is resolved against this channel's roster, so two
 * Vespers here would make a mention ambiguous, while a Vesper in another
 * channel is no trouble at all. `undefined` when the list is exhausted, which
 * is the caller's cue to ask rather than to invent something.
 */
export function freeAgentCodeName(repositoryId, avoid = []) {
  const taken = takenChannelNames(repositoryId);
  for (const name of avoid) {
    taken.add(name);
  }
  const free = AGENT_CODE_NAMES.filter((name) => !taken.has(name));
  if (free.length === 0) {
    return undefined;
  }
  return free[Math.floor(Math.random() * free.length)];
}

/** Whether this name would collide with somebody already in the channel. */
export function agentNameTaken(repositoryId, name, exceptAgentId) {
  const trimmed = String(name ?? "").trim();
  if (trimmed === "") {
    return false;
  }
  return channelAgentsFor(repositoryId).some(
    (agent) => agent.id !== exceptAgentId && agent.name === trimmed,
  );
}

/* ------------------------------------------------------- agents working ---- */

/**
 * Statuses that still mean the agent has the work.
 *
 * Deliberately excludes `submitted`, `queued`, `approved` and
 * `awaiting_approval`, which appear in `ACTIVE_TASK_STATUS` but mean waiting
 * for a runner or a person. A task parked awaiting review is not thinking,
 * and treating it as such left the dots up long after a prompt finished.
 */
// The statuses the tasks API actually emits are `submitted`, `claimed`,
// `integrated`, `failed` and `cancelled`. This set used to hold five values of
// which four never occur — run-level statuses from a different type — and not
// `claimed`, which is the one a task holds for the whole time an agent is
// actually working on it. So the dots retired the moment real work began and
// persisted while a task merely sat in the queue: backwards on both ends.
const WORKING_STATUS = new Set(["submitted", "claimed"]);

/** Backstop only — the task's own status is what really retires an entry. */
const BUSY_TTL_MS = 10 * 60_000;
/** Matches `PENDING_BUSY_PREFIX` on the server; see `noteAgentBusy`. */
const PENDING_BUSY_PREFIX = "pending:";
/** How long a placeholder holds the dots up on its own. */
const PENDING_BUSY_TTL_MS = 30_000;

/**
 * Records that an agent picked up work in a channel.
 *
 * The server sends this because the browser cannot work it out: a task's
 * `agentId` is this deployment's own name for a configured agent, and the
 * record carries no vendor, so there is nothing in it to match a roster entry
 * against. The frame names the owner and the provider outright.
 */
export function noteAgentBusy(frame) {
  if (!frame?.repositoryId || !frame?.taskId) {
    return;
  }
  // The first frame of a request arrives before its task exists: it is what
  // makes an agent start typing the moment it is mentioned, instead of once
  // the acknowledgement and the coordinator have both answered. It is keyed on
  // the agent, so the frame that follows with a real task id replaces it here
  // — otherwise both would sit in the table, and the placeholder, matching no
  // task and so never retired by status, would hold the dots up for its whole
  // TTL after the work had finished.
  const pending = String(frame.taskId).startsWith(PENDING_BUSY_PREFIX);
  if (!pending) {
    delete state.agentBusy[
      `${PENDING_BUSY_PREFIX}${frame.userId}:${frame.provider}`
    ];
  }
  state.agentBusy[frame.taskId] = {
    repositoryId: frame.repositoryId,
    userId: frame.userId,
    provider: frame.provider,
    // A placeholder has nothing but this to retire it. A question is answered
    // without ever becoming a task, and a dispatch can fail before it submits;
    // in both cases no status arrives to take the dots down. Long enough to
    // cover the model calls it is bridging, and no longer.
    expiresAt: Date.now() + (pending ? PENDING_BUSY_TTL_MS : BUSY_TTL_MS),
  };
}

/**
 * Agents mid-task in one repository, by the name this channel shows them as.
 *
 * An entry retires when its task is no longer in a working state — the task
 * list is re-read on every audit frame, so that arrives on its own. The TTL
 * is only for a task that vanishes without ever reaching a status, which
 * would otherwise leave dots up forever.
 */
export function agentsThinkingIn(repositoryId) {
  if (!repositoryId) {
    return [];
  }
  const now = Date.now();
  const names = [];
  for (const [taskId, entry] of Object.entries(state.agentBusy)) {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    const finished = task !== undefined && !WORKING_STATUS.has(task.status);
    if (finished || entry.expiresAt <= now) {
      delete state.agentBusy[taskId];
      continue;
    }
    if (entry.repositoryId !== repositoryId) {
      continue;
    }
    // Roster ids are two shapes: one's own agents are the bare provider id,
    // a teammate's are `${userId}:${provider}` (see `channelAgentsFor`). Both
    // have to be matched, or a teammate's agent working would either go
    // unnamed or be shown as your own.
    const agent = channelAgentsFor(repositoryId).find((candidate) => {
      if ((candidate.provider ?? candidate.id) !== entry.provider) {
        return false;
      }
      return candidate.mine === true
        ? true
        : String(candidate.id) === `${entry.userId}:${entry.provider}`;
    });
    names.push(agent?.name ?? "An agent");
  }
  return [...new Set(names)];
}

/** Records a `channel-typing` frame from somebody else. */
export function noteTyping(frame) {
  const key = typingKey(frame.repositoryId, frame.threadId);
  const surface = state.typing[key] ?? {};
  surface[frame.userId] = {
    name: frame.userName ?? "Someone",
    expiresAt: Date.now() + TYPING_TTL_MS,
  };
  state.typing[key] = surface;
}

/** Whoever is still within their TTL on one surface, newest state only. */
export function typingOn(repositoryId, threadId) {
  const surface = state.typing[typingKey(repositoryId, threadId)];
  if (surface === undefined) {
    return [];
  }
  const now = Date.now();
  const live = [];
  for (const [userId, entry] of Object.entries(surface)) {
    if (entry.expiresAt > now) {
      live.push(entry.name);
    } else {
      delete surface[userId];
    }
  }
  return live;
}

/** A message of theirs arriving means they are done typing, not still at it. */
export function clearTyping(repositoryId, threadId, userId) {
  const surface = state.typing[typingKey(repositoryId, threadId)];
  if (surface !== undefined && userId !== undefined) {
    delete surface[userId];
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

/**
 * Invites somebody.
 *
 * A repository id narrows the invitation to that one repository; without it
 * the invitation admits the person to every repository the organization has,
 * which is a different and much larger thing to hand out.
 */
export async function createInvitation(email, role, repositoryId) {
  const response = await api(
    `/organizations/${encodeURIComponent(state.organizationId)}/invitations`,
    {
      method: "POST",
      body: {
        email,
        role,
        ...(repositoryId === undefined || repositoryId === ""
          ? {}
          : { repositoryId, projectId: state.projectId }),
      },
    },
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
  // Their accent before a hash of their id. Both are "a colour for this
  // person", and one of them they actually picked — falling to the hash first
  // meant somebody whose interface was purple had an orange agent, and the two
  // colours sat next to each other in the same list looking like a mistake.
  //
  // And the shared default when they have chosen neither, rather than a hash
  // of their id. The hash gave everybody a different colour for free, which
  // sounds useful and reads as decoration: nothing in the interface means
  // "orange", so an orange agent beside a purple highlight is just two colours
  // disagreeing. Distinct colours are still available — they are one click in
  // Appearance — but they are now something somebody chose rather than
  // something their user id happened to hash to.
  return validColor(appearance?.accent) ?? DEFAULT_ACCENT;
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

/**
 * The accent this browser last saw somebody signed in with.
 *
 * Kept for the signed-out screens, which have no principal to read a colour
 * off and so painted themselves the default purple for everybody — including
 * the person who had just spent time choosing something else, and who sees
 * that screen every time their session lapses. The theme has been remembered
 * here for the same reason since light mode existed; this is the other half
 * of the same idea.
 *
 * Deliberately not cleared on sign-out: "the colour this machine is" is the
 * whole point, and a machine with one user — which is most of them — should
 * not flash purple on the way back in. On a shared machine it does reveal
 * that the last person preferred green, which is the same thing the theme
 * already reveals and about as consequential.
 */
function rememberAccent(accent) {
  try {
    localStorage.setItem("ag.accent", accent);
  } catch {
    // Storage can be full or blocked outright. A colour is not worth failing
    // a sign-in over; the default is a perfectly good colour.
  }
}

export function myAccent() {
  const chosen = validColor(state.principal?.user?.appearance?.accent);
  if (chosen !== undefined) {
    rememberAccent(chosen);
    return chosen;
  }
  // Only while signed out. Somebody who *is* signed in and has chosen no
  // accent gets the default, not whatever the last person on this machine
  // picked — that would be showing them somebody else's preference and
  // calling it theirs.
  if (state.principal === undefined) {
    const remembered = validColor(localStorage.getItem("ag.accent"));
    if (remembered !== undefined) {
      return remembered;
    }
  }
  return DEFAULT_ACCENT;
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

/**
 * The repository whose channel is on screen.
 *
 * Not the same as `state.repositoryId`, and that difference was a silent bug:
 * `currentRepository` falls back to the first repository when nothing has been
 * picked, so the Chats screen rendered "#demo" and addressed it, while
 * `state.repositoryId` was still empty. Every action that read the raw field
 * — send, reply, mentions — saw no repository and returned without doing
 * anything or saying why. Typing a message and pressing send simply did
 * nothing.
 *
 * Render and actions have to agree on which channel is open, so both ask
 * here.
 */
export function activeChannelId() {
  return currentRepository()?.id ?? state.repositoryId ?? "";
}

/**
 * Whether the signed-in user can administer this repository directly —
 * delete it, or manage who holds a repository-scoped grant on it.
 *
 * Mirrors the server's `authorizeRepositoryOwnerAction`: the repository's
 * own creator, or an organization role of admin/owner (where
 * `manage_project`/`manage_members` come from — see `ROLE_PERMISSIONS` in
 * `authorization.ts`). What this does *not* account for is a repository
 * grant elevating someone who holds neither role nor creatorship — the
 * server still enforces that correctly; this only decides which controls
 * the interface offers, and that narrower case can still act through a
 * direct API call even when a button here would not show.
 */
export function canManageRepository(repositoryId) {
  const repository = state.repositories.find((repo) => repo.id === repositoryId);
  if (repository === undefined) {
    return false;
  }
  if (
    repository.createdBy !== undefined &&
    repository.createdBy === currentUserId()
  ) {
    return true;
  }
  const role = state.principal?.memberships?.find(
    (membership) => membership.organizationId === state.project?.organizationId,
  )?.role;
  return role === "admin" || role === "owner";
}

/**
 * Whether "leave this chat" means anything for the signed-in user on this
 * repository.
 *
 * An organization role reaches every repository the organization owns, so
 * there is nothing a per-repository "leave" could remove — the server
 * refuses that case with `org_membership_reaches_repository` (see
 * {@link leaveRepository}). Only the shape a grant-only guest has — no
 * organization role reaching this project at all — can actually leave.
 */
export function canLeaveRepository() {
  const role = state.principal?.memberships?.find(
    (membership) => membership.organizationId === state.project?.organizationId,
  )?.role;
  return role === undefined;
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

/**
 * A person's name, from whichever shape the record arrived in.
 *
 * There are two, and reading only one of them is why a name showed up as a
 * raw `user_…` id everywhere except the one screen that happened to read the
 * other. The organization member list nests the account under `user`; the
 * room's people list flattens it to `id`/`name`. Both are legitimate — one is
 * a membership carrying an account, the other is a list of who can be written
 * to — so this reads either rather than picking a winner.
 *
 * The id is the last resort and not a name at all. It is kept because showing
 * something is better than showing "Unknown", but seeing one means the record
 * for that person never arrived, which is a loading problem rather than a
 * naming one.
 */
export function memberName(userId) {
  // The org member list first, then every room list and the DM roster: a
  // repository-invited teammate is in the latter and not the former, and
  // falling straight through to the raw id printed "user_9f2…" as a name in
  // every message they sent.
  const rooms = Object.values(state.channelPeople ?? {}).flat();
  const member =
    state.members.find(
      (entry) =>
        entry.userId === userId ||
        entry.id === userId ||
        entry.user?.id === userId,
    ) ??
    rooms.find((entry) => entry.userId === userId || entry.user?.id === userId) ??
    state.dmPeople.find((entry) => entry.id === userId);
  return (
    member?.user?.displayName ??
    member?.user?.email ??
    member?.displayName ??
    member?.name ??
    member?.email ??
    userId ??
    "Unknown"
  );
}

/** Everyone with a seat on this project — the collaborator avatars. */
export function collaborators() {
  const names = state.members
    .map(
      (member) =>
        // Same two shapes as `memberName`; reading only the flat one left the
        // collaborator avatars blank for everybody the server nested.
        member.user?.displayName ??
        member.user?.email ??
        member.displayName ??
        member.name ??
        member.email,
    )
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
    // A credential the server has seen fail to authenticate. Stored is not
    // the same as working, and only the first was ever visible here.
    const expired = provider.ownCredential?.unusableReason;
    const presence = provider.connected
      ? running === undefined
        ? "idle"
        : "online"
      : "offline";
    return {
      id: provider.id,
      provider: provider.id,
      name: `${AGENT_LABEL[provider.id] ?? provider.name ?? provider.id} (${shortUser()})`,
      // No default label. An agent is unlabeled until someone in a given
      // channel actually names its role there — see `withOverride` — rather
      // than inheriting a vendor-guessed title like "Lead Developer" it never
      // earned.
      role: "",
      model: provider.model ?? "",
      effort: provider.effort ?? "",
      // An expired sign-in is not a connection. `provider.connected` is true
      // whenever the *host machine's* CLI is logged in, so an agent whose own
      // credential has stopped authenticating still read as connected here —
      // which is what made the screen keep saying so while every task it was
      // given failed to sign in.
      connected: expired === undefined && provider.connected === true,
      needsReconnect: expired !== undefined,
      presence: expired === undefined ? presence : "offline",
      status:
        expired === undefined && provider.connected
          ? running
            ? "working"
            : "idle"
          : "offline",
      task: running,
      progress: running === undefined ? 0 : taskProgress(running),
      contextPercent: contextPercentFor(provider.id),
      color: myAgentColor(),
      detail: expired ?? provider.explanation ?? "",
      // "personal" (only I can task it via @mention) or "org" (anyone with
      // access to a repository this agent works in can). Chosen at connect
      // time; absent on a provider this account has never connected reads as
      // "personal", the same default the store itself falls back to.
      visibility: provider.ownCredential?.visibility ?? "personal",
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

/* ---------------------------------------------------------- channels ---- */

/**
 * Chats — one group channel per repository, with that repository's agents
 * sitting in the roster as participants alongside the people on the project.
 *
 * Messages, reactions, threads, renames, and per-agent model/effort read and
 * write through `/channel/...` on the server (see `loadChannel` and
 * `sendChannelMessage` below). The roster below is real too, as of the
 * `/channel/agents` route: it is every user with access to this repository —
 * the same access `authorizeRepository` checks server-side, organization role
 * or per-repository grant — and the vendors each of them has actually
 * connected, not a name invented from the repository id.
 */

/**
 * This agent's override, under the one key that identifies it — falling back
 * to the legacy bare-provider key that names every agent on the vendor.
 *
 * The order mirrors `resolveChannelAgentPresentation` in server.ts, and has
 * to: the name drawn here is the name somebody types after "@", and the
 * server matches that against its own resolution. Reading only the bare key
 * meant your own rename showed on screen while the server still answered to
 * the older per-agent name — so mentioning what you could see did nothing,
 * and mentioning a name nobody could see worked.
 *
 * Only for the moments before the roster has resolved. Once it has, the
 * server's own resolved name is used instead (see `channelAgentsFor`), which
 * is the single authority.
 */
function overrideFor(overrides, agent) {
  const specific = overrides[`${agent.userId}:${agent.provider}`];
  const legacy = overrides[agent.provider];
  if (specific === undefined && legacy === undefined) {
    return undefined;
  }
  return {
    name: specific?.name ?? legacy?.name,
    role: specific?.role ?? legacy?.role,
    model: specific?.model ?? legacy?.model,
    effort: specific?.effort ?? legacy?.effort,
  };
}

function withOverride(agent, override) {
  if (override === undefined) {
    return agent;
  }
  return {
    ...agent,
    name: override.name ?? agent.name,
    // No vendor-guessed default to fall back to: `agent.role` is "" unless
    // this channel has actually named the role, so an agent reads as
    // unlabeled until someone does. `??` rather than `||` — an override that
    // explicitly sets role to "" (clearing a previously-set label) must win
    // over `agent.role`, not fall through it, since both sides are already
    // "no label" in that case and either reads the same.
    role: override.role ?? agent.role,
    model: override.model ?? agent.model,
    effort: override.effort ?? agent.effort,
  };
}

function firstWord(name) {
  return String(name ?? "").trim().split(/\s+/u)[0] || "Teammate";
}

/**
 * The roster for one channel: this account's own connected agents (from
 * `myAgents`, which carries live task/progress data no cross-account read
 * could), plus every *other* repository collaborator's connected agents, read
 * from the real roster `ensureChannelRoster` fetches from `/channel/agents`.
 * Renames and model/effort choices made in the channel are layered on top
 * from `channelAgentOverrides`, which is why a rename shows up on every past
 * message instead of only new ones — messages resolve the current name at
 * render time rather than freezing one in.
 *
 * Synchronous by contract, the same as `channelMessagesFor`: `screen-chats.js`
 * and `app.js` call this inline while rendering, so it reads whatever
 * `state.channelRoster` already holds rather than fetching. A freshly opened
 * channel therefore shows this account's own agents immediately and gains
 * everyone else's the moment `ensureChannelRoster`'s request resolves and
 * triggers a re-render — "paint something immediately, then reconcile with
 * the network," the same shape `ensureChannelMessages` uses for messages.
 */
export function channelAgentsFor(repositoryId) {
  if (!repositoryId) {
    return [];
  }
  const overrides = state.channelAgentOverrides[repositoryId] ?? {};
  const myId = currentUserId();
  const roster = state.channelRoster[repositoryId] ?? [];
  // Membership is opt-in and server-authoritative (`channelAgentConnections`
  // in server.ts) — the roster GET route already filters by it, including
  // this account's own entries, which is what lets this reuse the same
  // fetch instead of a second membership-only request. Before that fetch has
  // ever resolved for this repository there is nothing to filter *by* yet,
  // so every connected agent shows provisionally, the same "paint
  // immediately" floor `myAgents` already gave every caller of this function
  // before membership existed; the first successful `ensureChannelRoster`
  // narrows it down to the real membership set and never widens it back.
  const myMemberProviders = state.channelRosterLoaded.has(repositoryId)
    ? new Set(
        roster
          .filter((entry) => entry.userId === myId)
          .map((entry) => entry.provider),
      )
    : undefined;
  const mine = myAgents()
    .filter(
      (agent) =>
        agent.connected &&
        (myMemberProviders === undefined || myMemberProviders.has(agent.provider)),
    )
    .map((agent) => ({ ...agent, mine: true, userId: myId }));
  const others = roster
    .filter((entry) => entry.userId !== myId)
    .map((entry) => {
      const id = `${entry.userId}:${entry.provider}`;
      return {
        id,
        userId: entry.userId,
        provider: entry.provider,
        name: `${AGENT_LABEL[entry.provider] ?? entry.provider} (${firstWord(entry.userName)})`,
        // Unlabeled until this channel gives it a role — see `withOverride`.
        role: "",
        model: "",
        effort: "",
        connected: true,
        // The server has no live presence signal to read yet (see the
        // `channel/agents` route in api-gateway) — a real, connected
        // teammate's agent reads as online rather than as an invented
        // idle/offline, which is the honest floor until presence is real.
        presence: "online",
        // The same colour this person's avatar uses everywhere else
        // (`agentColorFor` already treats a member's chosen colour as public
        // within the organization); falls back to the same hash-based colour
        // for someone with no explicit choice.
        color: agentColorFor(entry.userId),
        mine: false,
        // Whether this teammate's agent is actually pingable here (@mention
        // dispatches for real) or merely visible ("personal": only they can
        // task it). Absent on an older server response reads as "personal",
        // same default the store itself uses.
        visibility: entry.visibility ?? "personal",
      };
    });
  // What the server resolved, keyed the one way that identifies an agent.
  // Its answer wins wherever it has given one, because it is the same
  // resolution a mention is matched against — the screen and the matcher must
  // not be able to disagree.
  const resolved = new Map(
    roster
      .filter((entry) => typeof entry.name === "string" && entry.name.length > 0)
      .map((entry) => [
        `${entry.userId}:${entry.provider}`,
        { name: entry.name, role: entry.role ?? "" },
      ]),
  );
  return [...mine, ...others].map((raw) => {
    // The face's own presence dot tracks the same working-state the roster's
    // status dot reads, or the transcript disagrees with the sidebar about
    // whether an agent is busy — the exact disagreement that gets reported
    // as "the icons in the chat don't update". Working wins over whatever
    // the connection records said; everything else keeps its floor.
    const agent =
      agentStatus(raw, repositoryId) === "working"
        ? { ...raw, presence: "online" }
        : raw;
    const server = resolved.get(`${agent.userId}:${agent.provider}`);
    if (server !== undefined) {
      // Model and effort are not part of the roster's answer, so they still
      // come from the local override.
      const local = overrideFor(overrides, agent);
      return {
        ...agent,
        name: server.name,
        role: server.role,
        model: local?.model ?? agent.model,
        effort: local?.effort ?? agent.effort,
      };
    }
    // Before the roster resolves — the "paint immediately" floor — and for an
    // older server that sends no resolved name.
    return withOverride(agent, overrideFor(overrides, agent));
  });
}

/** Agents and people who can be @mentioned in this channel. */
export function channelParticipants(repositoryId) {
  const agents = channelAgentsFor(repositoryId).map((agent) => ({
    id: agent.id,
    name: agent.name,
    kind: "agent",
    agent,
  }));
  const humans =
    state.members.length > 0
      ? state.members.map((member) => ({
          id: member.userId ?? member.id,
          name: member.displayName ?? member.email,
          kind: "human",
        }))
      : [{ id: currentUserId(), name: currentUserName(), kind: "human" }];
  return [...agents, ...humans];
}

function seedMessages(repositoryId) {
  const agents = channelAgentsFor(repositoryId);
  const now = Date.now();
  const rows = [
    {
      id: `${repositoryId}-seed-1`,
      kind: "user",
      authorId: currentUserId() || "you",
      content: `Opened #${repositoryId} as a channel — everyone working this repository, human or agent, is in here now.`,
      at: new Date(now - 1000 * 60 * 60 * 26).toISOString(),
    },
  ];
  if (agents[0] !== undefined) {
    rows.push({
      id: `${repositoryId}-seed-2`,
      kind: "agent",
      authorId: agents[0].id,
      content:
        "Picked up the outstanding tasks on this repository and started on the highest-priority one. I'll post here once there's a changeset to review.",
      at: new Date(now - 1000 * 60 * 60 * 20).toISOString(),
    });
  }
  if (agents[1] !== undefined) {
    rows.push({
      id: `${repositoryId}-seed-3`,
      kind: "agent",
      authorId: agents[1].id,
      content:
        "Reviewed the last changeset — looks clean. Flagged one file that might need a second pass on error handling.",
      at: new Date(now - 1000 * 60 * 60 * 3).toISOString(),
      replies: [
        {
          id: `${repositoryId}-seed-3-r1`,
          kind: "user",
          authorId: currentUserId() || "you",
          content: "Good catch, I'll take a look this afternoon.",
          at: new Date(now - 1000 * 60 * 60 * 2).toISOString(),
        },
      ],
    });
  }
  return rows;
}

/** This channel's timeline, seeded once on first visit so it is never blank. */
export function channelMessagesFor(repositoryId) {
  if (!repositoryId) {
    return [];
  }
  if (state.channelMessages[repositoryId] === undefined) {
    state.channelMessages[repositoryId] = seedMessages(repositoryId);
  }
  return state.channelMessages[repositoryId];
}

const channelPath = (repositoryId, suffix = "") =>
  `/projects/${encodeURIComponent(state.projectId)}/repositories/${encodeURIComponent(repositoryId)}/channel${suffix}`;

/** Channel stats for the info popover, keyed by repository id. */
export async function loadChannelStats(repositoryId) {
  const stats = await apiOptional(channelPath(repositoryId, "/stats"), undefined);
  if (stats !== undefined) {
    state.channelStats[repositoryId] = stats;
  }
}

/**
 * The banner sentence for one audit event, or nothing.
 *
 * Named after the agent as this channel knows it, because "Zeus's task
 * failed" is the sentence a person acts on and "task_failed" is not. Only
 * endings and questions banner — starts and progress are what the room
 * itself is for.
 */
export function bannerLineForAudit(event) {
  const type = event?.type;
  const data = event?.data ?? {};
  const repositoryId = data.repositoryId;
  if (typeof repositoryId !== "string") {
    return undefined;
  }
  const task = state.tasks.find((candidate) => candidate.id === event.taskId);
  const agentId = String(task?.agentId ?? "").toLowerCase();
  const named = channelAgentsFor(repositoryId).find((agent) => {
    const vendor = VENDOR_FOR_PROVIDER[agent.provider ?? agent.id];
    return vendor !== undefined && agentId.includes(vendor);
  });
  const name = named?.name?.split(" (")[0] ?? "An agent";
  switch (type) {
    case "canonical_promoted":
      return `${name} completed a task in #${repositoryId}`;
    case "task_reported":
      return `${name} finished a report in #${repositoryId}`;
    case "task_failed":
      return `${name}'s task failed in #${repositoryId}`;
    case "task_cancelled":
      return `${name}'s task was cancelled in #${repositoryId}`;
    case "question_asked":
      return `${name} is waiting on an answer in #${repositoryId}`;
    default:
      return undefined;
  }
}

const directPath = (suffix = "") =>
  `/projects/${encodeURIComponent(state.projectId)}/direct-messages${suffix}`;

/**
 * The inbox and the roster, which arrive together because the screen that
 * shows one always shows the other: a list of conversations is no use without
 * the people you have not written to yet.
 *
 * Also where presence comes from. It is deliberately not pushed: a dot that
 * says somebody is here is only ever approximately true, and refreshing it
 * alongside something the screen already needed is cheaper than maintaining a
 * second live signal to keep it honest.
 */
export async function loadDirectMessages() {
  if (!state.projectId) {
    return;
  }
  const response = await apiOptional(directPath(), undefined);
  if (response === undefined) {
    return false;
  }
  state.dmConversations = response.conversations ?? [];
  state.dmPeople = response.people ?? [];
  state.presence = (response.people ?? [])
    .filter((person) => person.online === true)
    .map((person) => person.id);
  return true;
}

/** One conversation, and marking it read because it is now on screen. */
export async function loadDmThread(userId) {
  if (!state.projectId || !userId) {
    return;
  }
  const path = directPath(`/${encodeURIComponent(userId)}`);
  const response = await apiOptional(path, undefined);
  if (response === undefined) {
    return;
  }
  state.dmThreads[userId] = response.messages ?? [];
  // Opening a conversation is reading it. Done after the fetch rather than
  // before, so a failed load does not clear a badge for messages that are
  // still unseen.
  await api(`${path}/read`, { method: "POST" }).catch(() => undefined);
  await loadDirectMessages();
}

export async function sendDirectMessage(userId, content) {
  const body = String(content ?? "").trim();
  if (body.length === 0 || !userId) {
    return;
  }
  const response = await api(directPath(`/${encodeURIComponent(userId)}`), {
    method: "POST",
    body: { content: body },
  });
  // The socket frame echoes to the sender too, so this only has to cover the
  // case where it does not arrive — appending twice is prevented by id.
  noteDirectMessage({ message: response.message });
}

/**
 * A message that arrived over the socket, for either side of a conversation.
 *
 * Keyed on whoever is not the reader, which is what makes one handler serve
 * both the copy sent to the recipient and the copy echoed back to the sender.
 */
export function noteDirectMessage(frame) {
  const message = frame?.message;
  if (message === undefined) {
    return;
  }
  const me = currentUserId();
  const other = message.authorId === me ? message.recipientId : message.authorId;
  const thread = state.dmThreads[other] ?? [];
  if (thread.some((existing) => existing.id === message.id)) {
    return;
  }
  state.dmThreads[other] = [...thread, message];
  // The badge would otherwise wait for the next inbox refresh. Not counted
  // when the conversation is already open, because it is being read.
  const unreadHere = message.recipientId === me && state.activeDm !== other;
  const existing = state.dmConversations.find(
    (conversation) => conversation.userId === other,
  );
  const updated = {
    userId: other,
    lastMessage: message,
    unread: (existing?.unread ?? 0) + (unreadHere ? 1 : 0),
  };
  state.dmConversations = [
    updated,
    ...state.dmConversations.filter(
      (conversation) => conversation.userId !== other,
    ),
  ];
}

/** Whether somebody has this project open right now. */
export function personOnline(userId) {
  return state.presence.includes(userId);
}

/** Unread messages waiting from one person. */
export function dmUnreadFrom(userId) {
  return (
    state.dmConversations.find(
      (conversation) => conversation.userId === userId,
    )?.unread ?? 0
  );
}

/**
 * What an agent's dot should say: working, idle, or personal.
 *
 * Working wins over personal. Both are true of a personal agent that is
 * mid-task, and which one to show is a question of what the reader is looking
 * for — "is anything happening" is the more urgent of the two, and the one
 * they cannot find out any other way. Personal is visible in the role line
 * regardless.
 */
export function agentStatus(agent, repositoryId) {
  if (agentIsWorking(agent, repositoryId)) {
    return "working";
  }
  return agent.visibility === "personal" ? "personal" : "idle";
}

function agentIsWorking(agent, repositoryId) {
  const now = Date.now();
  for (const [taskId, entry] of Object.entries(state.agentBusy)) {
    if (entry.repositoryId !== repositoryId || entry.expiresAt <= now) {
      continue;
    }
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (task !== undefined && !WORKING_STATUS.has(task.status)) {
      continue;
    }
    // Matched the way `agentsThinkingIn` matches, so the dot and the typing
    // line can never disagree about who is working.
    if (
      entry.provider === (agent.provider ?? agent.id) &&
      (agent.mine === true || String(agent.id) === `${entry.userId}:${entry.provider}`)
    ) {
      return true;
    }
  }
  // The durable half. Busy frames are transient by design — a browser opened
  // after the dispatch never received one, so an agent mid-run showed idle
  // until its next frame, which for a long plan is minutes of a green dot
  // that should be on and is not. The task list is durable and re-read on
  // every audit frame, so it answers for the whole run: a claimed task naming
  // this agent's vendor is this agent working, no frame required.
  //
  // Own agents only. A task's `agentId` names a vendor, not an owner, so with
  // two people's Codex in one room the task alone cannot say whose is
  // working — the frames still carry that, and a teammate's dot keeps
  // depending on them rather than lighting both.
  if (agent.mine === true) {
    const vendor =
      VENDOR_FOR_PROVIDER[agent.provider ?? agent.id] ??
      String(agent.provider ?? agent.id);
    return state.tasks.some(
      (task) =>
        task.repositoryId === repositoryId &&
        WORKING_STATUS.has(task.status) &&
        String(task.agentId ?? "")
          .toLowerCase()
          .includes(vendor),
    );
  }
  return false;
}

/** The vendor CLI each chat provider drives, as task `agentId`s name it. */
export const VENDOR_FOR_PROVIDER = {
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
};

/**
 * Reads one channel back from the server, replacing whatever local or seeded
 * content was showing. Returns `false` without throwing when this deployment
 * has no channel endpoint yet, so the seeded demo content keeps working.
 */
/**
 * A stored message in the shape the screens read.
 *
 * The store timestamps records as `createdAt`; everything on this side —
 * `clockTime`, the day separators, the unread count — reads `at`, which is
 * what a locally-posted message carries. Untranslated, every message the
 * server sent arrived with no `at` at all, and `clockTime` fell back to the
 * current time: a transcript where every line claimed to have been written
 * just now, and moved forward again on every render.
 *
 * Translated here, at the one place server records enter, rather than at each
 * place one is read.
 */
function withSentTime(message) {
  return {
    ...message,
    at: message.at ?? message.createdAt,
    replies: (message.replies ?? []).map((reply) => ({
      ...reply,
      at: reply.at ?? reply.createdAt,
    })),
  };
}

async function loadChannel(repositoryId) {
  const response = await apiOptional(channelPath(repositoryId, "/messages"), undefined);
  if (response === undefined) {
    return false;
  }
  state.channelMessages[repositoryId] = (response.messages ?? []).map(withSentTime);
  state.channelAgentOverrides[repositoryId] = {
    ...state.channelAgentOverrides[repositoryId],
    ...response.agentOverrides,
  };
  // Only replaced when the server actually sent a list: an older server, or
  // a response that failed to include it, should leave the picker with what
  // it had rather than emptying it.
  if (Array.isArray(response.slashCommands)) {
    state.channelSlashCommands[repositoryId] = response.slashCommands;
  }
  if (response.readAt !== undefined) {
    state.channelRead[repositoryId] = Date.parse(response.readAt);
    window.localStorage.setItem("ag.chanread", JSON.stringify(state.channelRead));
  }
  return true;
}

/**
 * Loads a channel's real messages once per repository visit.
 *
 * The channel already reads as non-empty on the very first render, from the
 * local seed `channelMessagesFor` falls back to — this call is what replaces
 * that seed with the server's actual history, the same "paint something
 * immediately, then reconcile with the network" shape `ensureCodeData` and
 * `ensureAgentOptions` use for the Code and My Agents screens.
 */
export async function ensureChannelMessages(repositoryId, rerender) {
  if (
    !repositoryId ||
    !state.projectId ||
    state.channelLoaded.has(repositoryId) ||
    state.channelLoadingId === repositoryId
  ) {
    return;
  }
  state.channelLoadingId = repositoryId;
  try {
    if (await loadChannel(repositoryId)) {
      state.channelLoaded.add(repositoryId);
    }
  } finally {
    state.channelLoadingId = undefined;
  }
  rerender();
}

/**
 * Reads one repository's real agent roster from the server, replacing
 * whatever it held before.
 */
async function loadChannelRoster(repositoryId) {
  const response = await apiOptional(channelPath(repositoryId, "/agents"), undefined);
  if (response === undefined) {
    return false;
  }
  state.channelPeople[repositoryId] = response.people ?? [];
  state.channelRoster[repositoryId] = response.agents ?? [];
  // Sent with the roster because the switch it draws sits on the roster. See
  // the route's own comment for why it is not a separate request.
  state.auditorPaused[repositoryId] = response.auditorPaused === true;
  return true;
}

/**
 * Loads a channel's real agent roster once per repository visit — the same
 * "paint this account's own agents immediately, then reconcile everyone
 * else's in from the network" shape `ensureChannelMessages` above uses for
 * message history. `channelAgentsFor` already reads `state.channelRoster`
 * synchronously, so this only ever needs to populate it and ask for a
 * re-render.
 */
/**
 * The inbox, fetched once per project rather than on every render.
 *
 * `renderNow` calls this, so it has to be idempotent and quiet: an
 * unconditional fetch that re-renders on completion is an infinite loop.
 * Presence does go stale under this, which is the trade — a socket frame or
 * reopening a conversation refreshes it, and neither is worth a poll.
 */
export async function ensureDirectMessages(rerender) {
  if (!state.projectId || state.dmLoadedProject === state.projectId) {
    return;
  }
  // Marked loaded only on success: claiming it before the fetch meant one
  // failed request silenced every unread badge until the next full reload,
  // because nothing ever asked again.
  if ((await loadDirectMessages()) === true) {
    state.dmLoadedProject = state.projectId;
  }
  rerender();
}

export async function ensureChannelRoster(repositoryId, rerender) {
  if (
    !repositoryId ||
    !state.projectId ||
    state.channelRosterLoaded.has(repositoryId) ||
    state.channelRosterLoadingId === repositoryId
  ) {
    return;
  }
  state.channelRosterLoadingId = repositoryId;
  try {
    if (await loadChannelRoster(repositoryId)) {
      state.channelRosterLoaded.add(repositoryId);
    }
  } finally {
    state.channelRosterLoadingId = undefined;
  }
  rerender();
}

/**
 * Loads the repository-scoped grants the co-owner panel shows, straight into
 * `state.repositoryGrants` — unconditionally, unlike `ensureChannelRoster`'s
 * once-per-repository cache, since the panel that reads them only opens
 * when the channel info popover does and grants change rarely enough that a
 * fresh read each time is simpler than inventing invalidation for it.
 *
 * Skipped for anyone who cannot manage the repository: the fetch would
 * succeed (the route only requires `view`) but nothing would render it, so
 * asking is wasted work for the common case of an ordinary collaborator
 * opening channel info.
 */
export async function ensureRepositoryGrants(repositoryId, rerender) {
  if (!repositoryId || !canManageRepository(repositoryId)) {
    return;
  }
  state.repositoryGrants[repositoryId] = await loadRepositoryGrants(repositoryId);
  rerender();
}

/**
 * Re-reads a channel that has already loaded once.
 *
 * This is the reconcile half of every channel write below: `connectSocket`'s
 * handler in app.js calls it whenever the event socket reports a
 * `channel_*` audit event for the open repository, including the echo of
 * this browser's own posts. The store stays the source of truth, so a
 * fresh-and-correct read replaces local guesses rather than patching them.
 */
export async function refreshChannelMessages(repositoryId) {
  if (!repositoryId || !state.channelLoaded.has(repositoryId)) {
    return false;
  }
  return await loadChannel(repositoryId);
}

/**
 * Appends one message to a channel's local timeline, then persists it.
 *
 * The push happens synchronously, before any network round trip, so the
 * sender sees their own message the instant they hit enter — the same
 * optimistic-then-reconcile shape `chat.js`'s `sendChat` uses for the
 * private one-to-one panel. This function's signature has to stay
 * synchronous, because `screen-chats.js` reads its return value immediately
 * to clear the composer, so the POST below is fire-and-forget: reconciliation
 * happens out of band, when this message's own broadcast comes back over the
 * event socket and `refreshChannelMessages` re-reads the channel from the
 * server (see `connectSocket` in app.js).
 *
 * Only ordinary human posts reach the server today. Agent- and
 * system-authored entries stay local until a coordinator-side writer posts
 * through the store directly — the HTTP route never lets a signed-in person
 * author a message as somebody else's agent.
 */
export function sendChannelMessage(repositoryId, text, kind = "user", authorId) {
  const trimmed = String(text ?? "").trim();
  if (!repositoryId || trimmed === "") {
    return undefined;
  }
  const message = {
    id: `${repositoryId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    authorId: authorId ?? currentUserId() ?? "you",
    content: trimmed,
    at: new Date().toISOString(),
  };
  channelMessagesFor(repositoryId).push(message);
  if (kind === "user" && state.projectId) {
    void api(channelPath(repositoryId, "/messages"), {
      method: "POST",
      body: { content: trimmed },
    }).catch((error) => {
      message.failed = true;
      toast(`Message did not send: ${error.message}`, "error");
    });
  }
  return message;
}

function findChannelMessage(repositoryId, messageId) {
  for (const message of channelMessagesFor(repositoryId)) {
    if (message.id === messageId) {
      return message;
    }
    const reply = (message.replies ?? []).find((entry) => entry.id === messageId);
    if (reply !== undefined) {
      return reply;
    }
  }
  return undefined;
}

/**
 * A server-assigned message id never starts with its own repository id —
 * `sendChannelMessage` mints local ones as `${repositoryId}-...` precisely so
 * this is a cheap, reliable check. A local id belongs to the demo seed or to
 * an optimistic post whose POST has not resolved yet; threading a reply or a
 * reaction onto one would 404, so those wait for the next reconcile instead
 * of racing the network.
 */
function isServerChannelId(repositoryId, id) {
  return typeof id === "string" && !id.startsWith(`${repositoryId}-`);
}

/** A reply, appended to the thread hanging off one channel message. */
export function postChannelReply(repositoryId, messageId, text) {
  const trimmed = String(text ?? "").trim();
  const message = findChannelMessage(repositoryId, messageId);
  if (message === undefined || trimmed === "") {
    return undefined;
  }
  message.replies ??= [];
  const reply = {
    id: `${messageId}-r${message.replies.length + 1}-${Date.now()}`,
    kind: "user",
    authorId: currentUserId() || "you",
    content: trimmed,
    at: new Date().toISOString(),
  };
  message.replies.push(reply);
  if (state.projectId && isServerChannelId(repositoryId, messageId)) {
    void api(channelPath(repositoryId, `/messages/${encodeURIComponent(messageId)}/replies`), {
      method: "POST",
      body: { content: trimmed },
    }).catch((error) => {
      reply.failed = true;
      toast(`Reply did not send: ${error.message}`, "error");
    });
  }
  return reply;
}

/** A single-emoji toggle, same idea as a Slack reaction — on, then off. */
export function toggleChannelReaction(repositoryId, messageId, emoji = "👍") {
  const message = findChannelMessage(repositoryId, messageId);
  if (message === undefined) {
    return;
  }
  message.reactions ??= {};
  const current = message.reactions[emoji];
  if (current?.mine === true) {
    const count = current.count - 1;
    if (count <= 0) {
      delete message.reactions[emoji];
    } else {
      message.reactions[emoji] = { count, mine: false };
    }
  } else {
    message.reactions[emoji] = { count: (current?.count ?? 0) + 1, mine: true };
  }
  if (state.projectId && isServerChannelId(repositoryId, messageId)) {
    void api(channelPath(repositoryId, `/messages/${encodeURIComponent(messageId)}/reactions`), {
      method: "POST",
      body: { emoji },
    }).catch((error) => toast(`Reaction did not save: ${error.message}`, "error"));
  }
}

/**
 * Renames an agent as it appears in one channel.
 *
 * Scoped to the channel rather than to the agent's account-wide connection:
 * this is how the agent presents itself in this room, which two different
 * channels are free to disagree about, the same way a person can pick a
 * different display name per Slack workspace. Persisted server-side keyed by
 * (repository, agent), not by the agent's global identity.
 */
export function renameChannelAgent(repositoryId, agentId, name) {
  const trimmed = String(name ?? "").trim();
  if (!repositoryId || !agentId || trimmed === "") {
    return;
  }
  // Guarded here rather than at each caller because a rename commits from two
  // places — the form and losing focus — and a duplicate from either would
  // make `@name` ambiguous for everyone in the channel. Refused out loud, so
  // the person can pick another or take a fresh call sign.
  if (agentNameTaken(repositoryId, trimmed, agentId)) {
    toast(
      `${trimmed} is already taken in this channel — pick another name.`,
      "error",
    );
    return;
  }
  state.channelAgentOverrides[repositoryId] ??= {};
  state.channelAgentOverrides[repositoryId][agentId] = {
    ...state.channelAgentOverrides[repositoryId][agentId],
    name: trimmed,
  };
  if (state.projectId) {
    void api(channelPath(repositoryId, `/agents/${encodeURIComponent(agentId)}`), {
      method: "POST",
      body: { name: trimmed },
    }).catch((error) => toast(`Rename did not save: ${error.message}`, "error"));
  }
}

export function setChannelAgentSetting(repositoryId, agentId, field, value) {
  if (!repositoryId || !agentId) {
    return;
  }
  state.channelAgentOverrides[repositoryId] ??= {};
  state.channelAgentOverrides[repositoryId][agentId] = {
    ...state.channelAgentOverrides[repositoryId][agentId],
    [field]: value,
  };
  if (state.projectId && (field === "model" || field === "effort" || field === "role")) {
    void api(channelPath(repositoryId, `/agents/${encodeURIComponent(agentId)}`), {
      method: "POST",
      body: { [field]: value },
    }).catch((error) => toast(`Setting did not save: ${error.message}`, "error"));
  }
}

/**
 * Adds one of this account's own connected agents to a channel's opt-in
 * membership, so it starts appearing in `channelAgentsFor` and can be
 * @mentioned there. `agentId` is the bare provider id (`myAgents`'s `id`),
 * matching what the server's `.../channel/agents/:agentId/membership` route
 * expects — membership is always managed for the caller's own agents, never
 * a teammate's, so there is no `${userId}:${provider}` form to handle here.
 *
 * Updates `state.channelRoster` optimistically with a self entry shaped like
 * the ones `loadChannelRoster` fetches, so `channelAgentsFor`'s membership
 * check picks the addition up immediately rather than waiting on a refetch.
 */
export function addChannelAgent(repositoryId, agentId) {
  if (!repositoryId || !agentId) {
    return;
  }
  const myId = currentUserId();
  const roster = state.channelRoster[repositoryId] ?? [];
  if (!roster.some((entry) => entry.userId === myId && entry.provider === agentId)) {
    const agent = myAgents().find((candidate) => candidate.id === agentId);
    state.channelRoster[repositoryId] = [
      ...roster,
      {
        userId: myId,
        userName: currentUserName(),
        provider: agentId,
        visibility: agent?.visibility ?? "personal",
        connected: true,
      },
    ];
  }
  if (state.projectId) {
    void api(
      channelPath(repositoryId, `/agents/${encodeURIComponent(agentId)}/membership`),
      { method: "POST" },
    ).catch((error) => toast(`Could not add agent to this chat: ${error.message}`, "error"));
  }
}

/** The membership-removing counterpart to {@link addChannelAgent}. */
export function removeChannelAgent(repositoryId, agentId) {
  if (!repositoryId || !agentId) {
    return;
  }
  const myId = currentUserId();
  state.channelRoster[repositoryId] = (state.channelRoster[repositoryId] ?? []).filter(
    (entry) => !(entry.userId === myId && entry.provider === agentId),
  );
  if (state.projectId) {
    void api(
      channelPath(repositoryId, `/agents/${encodeURIComponent(agentId)}/membership`),
      { method: "DELETE" },
    ).catch((error) => toast(`Could not remove agent from this chat: ${error.message}`, "error"));
  }
}

/**
 * Removes another member's agent from a channel — moderation, gated
 * server-side on `manage_project` (loosened from `agent.mine`-only in
 * `screen-chats.js`'s `rosterRow`), unlike {@link removeChannelAgent}'s
 * self-service path which only ever needs `submit_task`.
 */
export function removeChannelAgentForUser(repositoryId, userId, provider) {
  if (!repositoryId || !userId || !provider) {
    return;
  }
  state.channelRoster[repositoryId] = (state.channelRoster[repositoryId] ?? []).filter(
    (entry) => !(entry.userId === userId && entry.provider === provider),
  );
  if (state.projectId) {
    void api(
      `${channelPath(repositoryId, `/agents/${encodeURIComponent(provider)}/membership`)}` +
        `?userId=${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    ).catch((error) => toast(`Could not remove that agent: ${error.message}`, "error"));
  }
}

const repositoryPath = (repositoryId, suffix = "") =>
  `/projects/${encodeURIComponent(state.projectId)}/repositories/${encodeURIComponent(repositoryId)}${suffix}`;

/**
 * Deletes a repository outright.
 *
 * Irreversible — cascades the repository's own channel and grants, and is
 * refused server-side while a task or run still references it (see
 * `removeRepository` in `@coord/persistence`). The caller is expected to
 * have already confirmed with the user; see `deleteRepositoryAction` in
 * app.js for the confirmation this always needs.
 */
export async function deleteRepository(repositoryId) {
  await api(repositoryPath(repositoryId), { method: "DELETE" });
  delete state.repositoryGrants[repositoryId];
  await loadContext();
}

/**
 * Removes the signed-in user's own access to a repository held through a
 * grant. Throws with `error.code === "org_membership_reaches_repository"`
 * when access instead comes from an organization role — see
 * {@link canLeaveRepository}, which is what keeps the interface from
 * offering this in that case in the first place.
 */
export async function leaveRepository(repositoryId) {
  await api(
    repositoryPath(repositoryId, `/grants/${encodeURIComponent(currentUserId())}`),
    { method: "DELETE" },
  );
  await loadContext();
}

/**
 * Switches this repository's auditing off, or back on.
 *
 * Turning it back on audits everything merged while it was off before it
 * resumes waiting — that is the server's doing, not this call's, but it is
 * why this returns what happened: "on" and "on, and it is auditing right
 * now" are different things to tell somebody.
 */
export async function setAuditorPaused(repositoryId, paused) {
  const response = await api(repositoryPath(repositoryId, "/auditor"), {
    method: "POST",
    body: { paused },
  });
  state.auditorPaused[repositoryId] = response?.paused === true;
  return response?.resumed;
}

/**
 * Returns this repository to the state it was in before one task landed.
 *
 * The task id travels rather than a revision: the channel knows which task a
 * message belongs to and nothing about revisions, and the server is the only
 * side that can say authoritatively which advance that task made. It is also
 * the side that can refuse — a refusal is a considered answer here, not a
 * failure, so it arrives as a normal response and is returned for the caller
 * to report.
 */
/**
 * Whether this repository's app is running, and where.
 *
 * Fetched rather than assumed, because the preview outlives the page: a
 * reload, or a second tab, must find the one that is already up instead of
 * offering to start a second.
 */
export async function loadPreview(repositoryId) {
  try {
    const response = await api(repositoryPath(repositoryId, "/preview"));
    state.previews[repositoryId] = response?.preview ?? null;
  } catch {
    // A deployment that cannot run previews answers 501, and a reader who
    // never asked for one should not see an error about it. Absent is the
    // same as "no button", which is the right outcome either way.
    state.previews[repositoryId] = null;
  }
  return state.previews[repositoryId];
}

export async function startPreview(repositoryId) {
  const response = await api(repositoryPath(repositoryId, "/preview"), {
    method: "POST",
  });
  state.previews[repositoryId] = response?.preview ?? null;
  return state.previews[repositoryId];
}

export async function stopPreview(repositoryId) {
  await api(repositoryPath(repositoryId, "/preview"), { method: "DELETE" });
  state.previews[repositoryId] = null;
}

export async function rollbackTask(repositoryId, taskId) {
  const response = await api(repositoryPath(repositoryId, "/rollback"), {
    method: "POST",
    body: { taskId },
  });
  return response?.rollback;
}

/**
 * Removes one thread, or every thread in the channel.
 *
 * Local state is updated only once the server has agreed. An optimistic
 * delete that failed would leave the reader believing something is gone while
 * it is still there for everybody else — the wrong way round for an action
 * that cannot be undone.
 */
export async function deleteChannelThread(repositoryId, messageId) {
  await api(
    channelPath(repositoryId, `/messages/${encodeURIComponent(messageId)}`),
    { method: "DELETE" },
  );
  state.channelMessages[repositoryId] = (
    state.channelMessages[repositoryId] ?? []
  ).filter((entry) => entry.id !== messageId);
}

export async function deleteAllChannelThreads(repositoryId) {
  const response = await api(channelPath(repositoryId, "/messages"), {
    method: "DELETE",
  });
  state.channelMessages[repositoryId] = [];
  return response?.removed ?? 0;
}

/** Every repository-scoped grant on this repository, for the co-owner panel. */
export async function loadRepositoryGrants(repositoryId) {
  const response = await apiOptional(repositoryPath(repositoryId, "/grants"), {
    grants: [],
  });
  return response.grants ?? [];
}

/**
 * Grants (or changes) a repository-scoped role for an existing organization
 * member — "co-owner" when `role` is `"owner"`, the same capabilities the
 * repository's creator has there.
 */
export async function setRepositoryGrant(repositoryId, userId, role) {
  return await api(
    repositoryPath(repositoryId, `/grants/${encodeURIComponent(userId)}`),
    { method: "POST", body: { role } },
  );
}

/**
 * Revokes a repository-scoped grant on someone else's behalf — moderation;
 * see {@link leaveRepository} for the self-service counterpart.
 */
export async function revokeRepositoryGrant(repositoryId, userId) {
  await api(
    repositoryPath(repositoryId, `/grants/${encodeURIComponent(userId)}`),
    { method: "DELETE" },
  );
}

export function markChannelRead(repositoryId) {
  if (!repositoryId) {
    return;
  }
  state.channelRead[repositoryId] = Date.now();
  window.localStorage.setItem("ag.chanread", JSON.stringify(state.channelRead));
  if (state.projectId) {
    // Best-effort: the badge is already correct from the local write above,
    // and the server's copy of "read" catches up next time this succeeds.
    void api(channelPath(repositoryId, "/read"), { method: "POST" }).catch(() => undefined);
  }
}

export function channelUnreadCount(repositoryId) {
  const readAt = state.channelRead[repositoryId] ?? 0;
  const mine = currentUserId() || "you";
  return channelMessagesFor(repositoryId).filter(
    (message) => message.authorId !== mine && new Date(message.at).getTime() > readAt,
  ).length;
}

/** Resolves who sent a message right now, so a rename reaches old messages. */
export function channelAuthor(repositoryId, entry) {
  if (entry.kind === "system") {
    // Coordinator-authored lines — @mention dispatch confirmations and
    // refusals today — never a real member, so `memberName` must not be
    // asked to explain an id it has never heard of.
    return { name: "Coordinator", agent: undefined };
  }
  // `progress` and `outcome` are agents too — one narrating its own run, one
  // saying how it ended — and both are authored the same way. Left out, the
  // thread's opening line resolved through `memberName`, which has never
  // heard of `<userId>:<provider>`, so the agent's first words appeared under
  // a raw composite id instead of its call sign. The ending would have read
  // the same way, which is a poor place for it: it is the line most people
  // scroll to.
  if (
    entry.kind === "agent" ||
    entry.kind === "progress" ||
    entry.kind === "outcome"
  ) {
    // The server names an agent author `<userId>:<provider>`, because that is
    // the only form meaningful to everybody. The viewer's *own* agents are
    // keyed by bare provider id in this list, so both spellings have to
    // resolve or a person's own agent shows up in their channel as a raw
    // composite id.
    const roster = channelAgentsFor(repositoryId);
    const [ownerId, provider] = String(entry.authorId ?? "").split(":");
    const agent =
      roster.find((candidate) => candidate.id === entry.authorId) ??
      (provider !== undefined && ownerId === currentUserId()
        ? roster.find((candidate) => candidate.id === provider)
        : undefined);
    return { name: agent?.name ?? entry.authorId, agent };
  }
  if (entry.authorId === currentUserId() || entry.authorId === "you") {
    return { name: currentUserName(), agent: undefined };
  }
  return { name: memberName(entry.authorId), agent: undefined };
}

/* ------------------------------------------------------- channel files ---- */

/**
 * The overlay workspace backing the open channel.
 *
 * Cached against the repository it was opened for rather than globally: the
 * Code screen keeps a workspace too, and handing the wrong repository's
 * workspace to a read would quietly return somebody else's file.
 */
async function ensureChannelWorkspace() {
  const repositoryId = activeChannelId();
  if (repositoryId === undefined || state.projectId === "") {
    throw new Error("No channel is open.");
  }
  const project = encodeURIComponent(state.projectId);
  const repo = encodeURIComponent(repositoryId);
  if (state.workspace === undefined || state.workspaceRepo !== repositoryId) {
    const opened = await api(
      `/projects/${project}/repositories/${repo}/workspace`,
      { method: "POST", body: {} },
    );
    state.workspace = opened.workspace;
    state.workspaceRepo = repositoryId;
  }
  return { project, repo };
}

/**
 * Read a file into the side panel for editing.
 *
 * The diff already on screen is a record of what changed, which is not the
 * same thing as what the file says now — so editing reads the working copy
 * fresh rather than reconstructing it from the patch.
 */
export async function loadChannelFile(path, rerender) {
  state.chanFileLoading = true;
  state.chanFileError = undefined;
  rerender();
  try {
    const { project, repo } = await ensureChannelWorkspace();
    const result = await api(
      `/projects/${project}/repositories/${repo}/workspace/file?path=${encodeURIComponent(
        path,
      )}`,
    );
    const file = result.file ?? {};
    if (file.binary === true) {
      throw new Error("This file is binary and has no text to edit.");
    }
    state.chanFileBase = file.content ?? "";
    state.chanFileDraft = state.chanFileBase;
  } catch (error) {
    state.chanFileError = error.message;
    state.chanFileBase = undefined;
    state.chanFileDraft = undefined;
  } finally {
    state.chanFileLoading = false;
    rerender();
  }
}

/**
 * Write the edited text back to the workspace.
 *
 * The saved text becomes the new baseline, so the panel stops calling itself
 * unsaved without having to re-read the file to find that out.
 */
export async function saveChannelFile(rerender) {
  const path = state.chanFileView;
  const content = state.chanFileDraft;
  if (path === undefined || content === undefined || state.chanFileSaving) {
    return false;
  }
  let saved = false;
  state.chanFileSaving = true;
  state.chanFileError = undefined;
  rerender();
  try {
    const { project, repo } = await ensureChannelWorkspace();
    await api(`/projects/${project}/repositories/${repo}/workspace/file`, {
      method: "POST",
      body: { path, content },
    });
    state.chanFileBase = content;
    saved = true;
    toast(`Saved ${path}`, "ok");
  } catch (error) {
    state.chanFileError = error.message;
    toast(error.message, "error");
  } finally {
    state.chanFileSaving = false;
    rerender();
  }
  return saved;
}

/**
 * Moves a file to another directory in the workspace overlay.
 *
 * The overlay is the same staging area an edit goes into, so this needs no
 * separate review path: the move shows up in the changeset as a deletion and
 * an addition and is submitted, validated and promoted like anything else.
 *
 * Returns the new path on success so the caller can follow the file if it was
 * the one on screen; `undefined` means nothing moved and the toast has said
 * why.
 */
export async function moveChannelFile(from, directory) {
  const name = String(from).split("/").pop();
  const to = directory === "" ? name : `${directory}/${name}`;
  if (to === from) {
    return undefined;
  }
  try {
    const { project, repo } = await ensureChannelWorkspace();
    await api(`/projects/${project}/repositories/${repo}/workspace/move`, {
      method: "POST",
      body: { from, to },
    });
    toast(`Moved to ${to}`, "ok");
    return to;
  } catch (error) {
    toast(error.message, "error");
    return undefined;
  }
}

/** Forget an open file, and the draft that went with it. */
export function closeChannelFile() {
  state.chanFileView = undefined;
  state.chanFileMode = "diff";
  state.chanFileBase = undefined;
  state.chanFileDraft = undefined;
  state.chanFileError = undefined;
  state.chanFileLoading = false;
}

/* -------------------------------------------------------- look and feel ---- */

/**
 * A profile picture, kept in this browser.
 *
 * The account has no field for one — `/auth/me/appearance` takes two hex
 * colours and nothing else — so putting it on the server would mean a schema
 * change, a size limit and an upload path. Held locally until that exists,
 * which is at least honest about what it is rather than looking like it
 * follows the account and then not doing so on another machine.
 */
export function myAvatar() {
  const stored = localStorage.getItem("ag.avatar");
  return stored === null || stored === "" ? undefined : stored;
}

export function setMyAvatar(dataUrl) {
  if (dataUrl === undefined) {
    localStorage.removeItem("ag.avatar");
    return;
  }
  localStorage.setItem("ag.avatar", dataUrl);
}

/** "dark" or "light". Dark is what every colour here was chosen against. */
export function myTheme() {
  return localStorage.getItem("ag.theme") === "light" ? "light" : "dark";
}

export function setMyTheme(theme) {
  localStorage.setItem("ag.theme", theme === "light" ? "light" : "dark");
}
