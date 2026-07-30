/*
 * Relay control room front-end.
 *
 * Shell model: a VS Code-style frame — activity bar on the far left, a
 * contextual sidebar, a tabbed center area, a dockable bottom panel
 * (terminal + live events), and a status bar. Content inside the frame is
 * GitHub-flavored: the task queue reads like an Issues list, a run reads
 * like a pull request (file tree, diffs, review threads), canonical history
 * reads like a commit list.
 *
 * The data layer (state, api, websocket refresh) is deliberately unchanged
 * from the previous single-page implementation; only presentation and
 * navigation were rebuilt.
 */

const API_ROOT = "/api/v1";

/** When this dashboard session began, for the HUD's uptime readout. */
const SESSION_STARTED = Date.now();

const state = {
  principal: undefined,
  health: undefined,
  /**
   * Whether `loadContext` has ever completed.
   *
   * Every "do you have a project?" branch reads `state.projectId`, which is
   * also empty before the first fetch resolves. Without this flag those
   * branches cannot tell "you have no project" from "we have not asked yet",
   * and a returning user is shown the first-run onboarding screen while their
   * context is still in flight — or whenever the socket drops. It latches on
   * once and never clears: a refresh that fails later must not re-assert
   * first-run.
   */
  contextLoaded: false,
  /** Message from the first context load, when it failed outright. */
  contextError: undefined,
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
  metrics: undefined,
  workers: [],
  /** Platform-wide count of agents executing right now, from the control plane. */
  agentsRunning: undefined,
  admin: undefined,
  socket: undefined,
  refreshTimer: undefined,

  /** Shell state. */
  activity: "overview",
  tabs: [],
  activeTabId: undefined,
  panelOpen: false,
  panelTab: "terminal",

  /**
   * Agent chat: the primary way work is prompted. Each entry tracks one task
   * this browser prompted; status and progress render live from state.tasks
   * and the audit stream. Persisted per project in localStorage.
   */
  chat: {
    open: localStorage.getItem("relay.chatOpen") !== "false",
    agentId: localStorage.getItem("relay.chatAgent") ?? "",
    repositoryId: localStorage.getItem("relay.chatRepo") ?? "",
    tracked: [],
    sending: false,
    runAttempts: new Map(),

    /** Direct provider chat (Ask mode). */
    /** Whether the panel is currently an overlay drawer (narrow viewports). */
    drawer: undefined,
    mode: localStorage.getItem("relay.chatMode") ?? "ask",
    providers: [],
    /**
     * Whether `/chat/providers` has answered yet. Probing a provider shells
     * out to its CLI, so the answer can take seconds; until it arrives the
     * icons report "connecting" rather than asserting "not connected", which
     * was a false negative for every already-connected account.
     */
    providersLoaded: false,
    activeProvider: localStorage.getItem("relay.chatProvider") ?? "anthropic",
    /** Per provider: [{role, content, thinking, thinkingHidden, usage, model, at}] */
    conversations: {},
    /** Per provider session totals, summed from real replies only. */
    totals: {},
    /** Per provider, the latest rate-limit snapshot a reply carried. */
    lastRateLimit: {},
    /** Per provider, the CLI session id for --resume continuity. */
    cliSessions: {},
    /** Per provider, the model/effort options the account reports. */
    options: {},
    /** Per provider, the consumption figures its CLI publishes. */
    usage: {},
    usageLoading: {},
    usageOpen: localStorage.getItem("relay.chatUsageOpen") === "true",
    /** Dispatch confirmation state; route null means "provider default". */
    dispatchOpen: false,
    dispatchRoute: null,
    overlayProvider: null,
    /** Which overlay screen is showing: "main" settings or "usage". */
    overlayView: "main",
  },

  /** Explorer / workspace state, keyed by the selected repository. */
  explorerRepo: localStorage.getItem("relay.explorerRepo") ?? "",
  workspace: undefined,
  workspaceFiles: [],
  expandedDirs: new Set(),
  dirtyFiles: new Set(),

  terminal: {
    lines: [],
    busy: false,
    welcomed: false,
    history: [],
    historyIndex: -1,
  },
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

function duration(milliseconds) {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) {
    return "—";
  }
  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)} ms`;
  }
  const seconds = milliseconds / 1000;
  if (seconds < 90) {
    return `${seconds.toFixed(1)} s`;
  }
  const minutes = seconds / 60;
  if (minutes < 90) {
    return `${minutes.toFixed(1)} min`;
  }
  return `${(minutes / 60).toFixed(1)} h`;
}

function percent(part, whole) {
  if (whole === 0) {
    return "—";
  }
  return `${Math.round((part / whole) * 100)}%`;
}

/* ------------------------------------------------------------- icons ---- */

/** Minimal inline icon set (16×16 outline, GitHub octicon-adjacent). */
const ICONS = {
  home: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6.906.664a1.75 1.75 0 0 1 2.187 0l5.25 4.2c.415.332.657.835.657 1.367v7.019A1.75 1.75 0 0 1 13.25 15h-3.5a.75.75 0 0 1-.75-.75V9H7v5.25a.75.75 0 0 1-.75.75h-3.5A1.75 1.75 0 0 1 1 13.25V6.23c0-.531.242-1.034.657-1.366l5.25-4.2Zm1.25 1.171a.25.25 0 0 0-.312 0l-5.25 4.2a.25.25 0 0 0-.094.196v7.019c0 .138.112.25.25.25H5.5V8.25a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 .75.75v5.25h2.75a.25.25 0 0 0 .25-.25V6.23a.25.25 0 0 0-.094-.195Z"/></svg>',
  files: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/></svg>',
  tasks: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>',
  runs: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215Z"/></svg>',
  approvals: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8.5.75a.75.75 0 0 0-1.5 0V2h-.984c-.305 0-.604.08-.869.23l-1.288.737A.25.25 0 0 1 3.735 3H1.75a.75.75 0 0 0 0 1.5h.428L.066 9.192a.75.75 0 0 0 .154.838c.187.185.376.293.557.393.19.106.411.203.65.29a4.8 4.8 0 0 0 1.598.26 4.8 4.8 0 0 0 1.597-.26c.239-.087.46-.184.651-.29.18-.1.37-.208.556-.393a.75.75 0 0 0 .154-.838L3.822 4.5h.162c.305 0 .604-.08.869-.23l1.289-.737a.25.25 0 0 1 .124-.033H7v9h-.75a.75.75 0 0 0 0 1.5h3.5a.75.75 0 0 0 0-1.5H8.5v-9h.734a.25.25 0 0 1 .124.033l1.289.737c.265.15.564.23.869.23h.162l-2.112 4.692a.75.75 0 0 0 .154.838c.187.185.376.293.556.393.191.106.412.203.651.29a4.8 4.8 0 0 0 1.597.26 4.8 4.8 0 0 0 1.598-.26 4.1 4.1 0 0 0 .65-.29c.181-.1.37-.208.557-.393a.75.75 0 0 0 .154-.838L13.822 4.5h.428a.75.75 0 0 0 0-1.5h-1.985a.25.25 0 0 1-.124-.033l-1.289-.737A1.75 1.75 0 0 0 9.984 2H8.5ZM3.025 10.184c-.242.088-.523.15-.837.18l.837-1.86.838 1.86a3.3 3.3 0 0 1-.838-.18Zm9.95 0c-.242.088-.523.15-.837.18l.837-1.86.838 1.86a3.3 3.3 0 0 1-.838-.18Z"/></svg>',
  repos: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.5 2.5 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.5 2.5 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.25.25 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/></svg>',
  board: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25H5V1.5Zm4.75 0v13h3V1.5Zm4.5 0v13h3.25a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25Z"/></svg>',
  graph: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.75V13.5h13.75a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1-.75-.75V1.75a.75.75 0 0 1 1.5 0Zm14.28 2.53-5.25 5.25a.75.75 0 0 1-1.06 0L7 7.06 4.28 9.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.25-3.25a.75.75 0 0 1 1.06 0L10 7.94l4.72-4.72a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z"/></svg>',
  people: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 5.5a3.5 3.5 0 1 1 5.898 2.549 5.5 5.5 0 0 1 3.034 4.084.75.75 0 1 1-1.482.235 4 4 0 0 0-7.9 0 .75.75 0 0 1-1.482-.236A5.5 5.5 0 0 1 3.102 8.05 3.5 3.5 0 0 1 2 5.5ZM11 4a3.001 3.001 0 0 1 2.22 5.018 5 5 0 0 1 2.56 3.012.749.749 0 0 1-.885.954.752.752 0 0 1-.549-.514 3.5 3.5 0 0 0-2.522-2.372.75.75 0 0 1-.574-.73v-.352a.75.75 0 0 1 .416-.672A1.5 1.5 0 0 0 11 5.5.75.75 0 0 1 11 4Zm-5.5-.5a2 2 0 1 0-.001 3.999A2 2 0 0 0 5.5 3.5Z"/></svg>',
  gear: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a8 8 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.9 5.9 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.2 8.2 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.9 5.9 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8 8 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.2 6.2 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a8 8 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.7 4.7 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.7 4.7 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.5 6.5 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.4 4.4 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z"/></svg>',
  shield: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M7.467.133a1.75 1.75 0 0 1 1.066 0l5.25 1.68A1.75 1.75 0 0 1 15 3.48V7c0 1.566-.32 3.182-1.303 4.682-.983 1.498-2.585 2.813-5.032 3.855a1.7 1.7 0 0 1-1.33 0c-2.447-1.042-4.049-2.357-5.032-3.855C1.32 10.182 1 8.566 1 7V3.48a1.75 1.75 0 0 1 1.217-1.667Zm.61 1.429a.25.25 0 0 0-.153 0l-5.25 1.68a.25.25 0 0 0-.174.238V7c0 1.358.275 2.666 1.057 3.86.784 1.194 2.121 2.34 4.366 3.297a.2.2 0 0 0 .154 0c2.245-.956 3.582-2.104 4.366-3.298C13.225 9.666 13.5 8.36 13.5 7V3.48a.25.25 0 0 0-.175-.238Z"/></svg>',
  terminal: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM7.25 8a.75.75 0 0 1-.22.53l-2.25 2.25a.75.75 0 1 1-1.06-1.06L5.44 8 3.72 6.28a.75.75 0 1 1 1.06-1.06l2.25 2.25c.141.14.22.331.22.53Zm1.5 1.5h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z"/></svg>',
  file: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/></svg>',
  folder: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1Z"/></svg>',
  chevronDown: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"/></svg>',
  chevronRight: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/></svg>',
  issueOpen: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>',
  issueClosed: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z"/><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z"/></svg>',
  issueFailed: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z"/></svg>',
  history: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="m.427 1.927 1.215 1.215a8.002 8.002 0 1 1-1.6 5.685.75.75 0 1 1 1.493-.154 6.5 6.5 0 1 0 1.18-4.458l1.358 1.358A.25.25 0 0 1 3.896 6H.25A.25.25 0 0 1 0 5.75V2.104a.25.25 0 0 1 .427-.177ZM7.75 4a.75.75 0 0 1 .75.75v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5A.75.75 0 0 1 7.75 4Z"/></svg>',
  close: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>',
  commit: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/></svg>',
};

function icon(name) {
  return ICONS[name] ?? "";
}

/* --------------------------------------------------------------- api ---- */

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

/**
 * A GET whose absence is not an error.
 *
 * Metrics, the worker fleet, and version history are all optional deployment
 * capabilities — a control plane without remote execution answers 501, and a
 * viewer without the scope answers 403. Neither should blank the whole page.
 */
async function apiOptional(path, fallback) {
  try {
    return await api(path);
  } catch (error) {
    if ([401, 500].includes(error.status)) {
      throw error;
    }
    return fallback;
  }
}

function toast(message, tone = "default") {
  const item = document.createElement("div");
  item.className = `toast${tone === "error" ? " error" : tone === "warn" ? " warn" : ""}`;
  item.textContent = message;
  $("#toast-region").append(item);
  window.setTimeout(() => item.remove(), 4_500);
}

/* -------------------------------------------------------------- auth ---- */

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

/* ------------------------------------------------------------ context ---- */

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
  state.contextError = undefined;
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
        metrics,
        workers,
        agentsRunning,
      ] = await Promise.all([
        api(`/projects/${projectId}/repositories`),
        api(`/projects/${projectId}/tasks`),
        api(`/projects/${projectId}/runs?limit=100`),
        api(`/projects/${projectId}/approvals`),
        api(`/projects/${projectId}/audit`),
        api(`/projects/${projectId}/agents`),
        api(`/projects/${projectId}`),
        apiOptional(`/projects/${projectId}/metrics`, { metrics: undefined }),
        apiOptional(`/workers`, { workers: [] }),
        apiOptional(`/agents/running`, { running: undefined }),
      ]);
      state.repositories = repositories.repositories;
      state.tasks = tasks.tasks;
      state.runs = runs.runs;
      state.approvals = approvals.approvals;
      state.audit = audit.events;
      state.agents = agents.agents;
      state.project = project.project;
      state.metrics = metrics.metrics;
      state.workers = workers.workers ?? [];
      state.agentsRunning =
        agentsRunning?.running === undefined ? undefined : agentsRunning;
    } else {
      state.repositories = [];
      state.tasks = [];
      state.runs = [];
      state.approvals = [];
      state.audit = [];
      state.agents = [];
      state.project = undefined;
      state.metrics = undefined;
      state.workers = [];
      state.agentsRunning = undefined;
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

    if (
      state.explorerRepo &&
      !state.repositories.some((repo) => repo.id === state.explorerRepo)
    ) {
      state.explorerRepo = state.repositories[0]?.id ?? "";
    } else if (!state.explorerRepo) {
      state.explorerRepo = state.repositories[0]?.id ?? "";
    }

    state.contextLoaded = true;
    loadChatTracked();
    loadChatTotals();
    loadRateLimits();
    maybeDrainChatRuns();
    renderSelectors();
    connectSocket();
    renderShell();
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
    // A spinner that never resolves misrepresents state just as badly as the
    // onboarding screen did. If we have never had context, say so and offer a
    // retry; once context exists, a failed refresh is only a toast — the
    // screen still holds real data.
    if (state.contextLoaded === false) {
      state.contextError = error.message;
      renderShell();
    }
    toast(error.message, "error");
  }
}

/* ------------------------------------------------------------- socket ---- */

function syncHudSocketIndicators(status) {
  const labels = {
    live: {
      top: "link established",
      compact: "live",
      detail: "LINK LIVE",
    },
    connecting: {
      top: "link connecting",
      compact: "connecting",
      detail: "LINK CONNECTING",
    },
    offline: {
      top: "link offline",
      compact: "offline",
      detail: "LINK DOWN",
    },
  }[status];
  $$("[data-hud-socket-label]").forEach((element) => {
    element.textContent =
      labels?.[element.dataset.hudSocketLabel] ?? labels?.compact ?? "offline";
  });
  $$("[data-hud-socket-ring]").forEach((element) => {
    element.classList.toggle("on", status === "live");
  });
  $$("[data-hud-socket-dot]").forEach((element) => {
    element.classList.toggle("idle", status !== "live");
  });
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
  syncHudSocketIndicators("offline");
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
  syncHudSocketIndicators("connecting");
  socket.addEventListener("open", () => {
    $("#live-dot").classList.remove("error");
    $("#live-dot").classList.add("live");
    $("#live-label").textContent = "Live";
    syncHudSocketIndicators("live");
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
    syncHudSocketIndicators("connecting");
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
    repository_created: "Repository created",
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
    (data.repositoryId ? `Repository ${data.repositoryId}` : undefined) ??
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

/* --------------------------------------------------------- shell: tabs --- */

/**
 * Activity → the sidebar it shows and the singleton tab it opens.
 *
 * Every route of the previous dashboard maps onto one of these, so old
 * `#tasks`-style links (and bookmarks) keep working.
 */
const ACTIVITIES = [
  { id: "overview", label: "Home", icon: "home", view: "overview" },
  { id: "explorer", label: "Explorer", icon: "files", view: "explorer" },
  { id: "board", label: "Board", icon: "board", view: "board", badge: "tasks" },
  { id: "runs", label: "Executions", icon: "runs", view: "runs" },
  {
    id: "approvals",
    label: "Approvals",
    icon: "approvals",
    view: "approvals",
    badge: "approvals",
  },
  { id: "repositories", label: "Repositories", icon: "repos", view: "repositories" },
  { id: "coordination", label: "Coordination", icon: "graph", view: "coordination" },
];

const FOOTER_ACTIVITIES = [
  { id: "team", label: "Team", icon: "people", view: "team" },
  { id: "admin", label: "System admin", icon: "shield", view: "admin" },
  { id: "settings", label: "Settings", icon: "gear", view: "settings" },
];

const VIEW_META = {
  overview: { title: "Home", icon: "home", activity: "overview" },
  explorer: { title: "Workspace", icon: "files", activity: "explorer" },
  board: { title: "Board", icon: "board", activity: "board" },
  runs: { title: "Executions", icon: "runs", activity: "runs" },
  approvals: { title: "Approvals", icon: "approvals", activity: "approvals" },
  repositories: { title: "Repositories", icon: "repos", activity: "repositories" },
  coordination: { title: "Coordination", icon: "graph", activity: "coordination" },
  team: { title: "Team", icon: "people", activity: "team" },
  settings: { title: "Settings", icon: "gear", activity: "settings" },
  admin: { title: "System admin", icon: "shield", activity: "admin" },
};

function findTab(id) {
  return state.tabs.find((tab) => tab.id === id);
}

function activeTab() {
  return findTab(state.activeTabId);
}

/** Opens (or focuses) a tab. Singleton ids simply match by id. */
function openTab(tab, { activate = true } = {}) {
  if (!findTab(tab.id)) {
    state.tabs.push(tab);
  } else {
    Object.assign(findTab(tab.id), tab);
  }
  if (activate) {
    state.activeTabId = tab.id;
  }
  renderShell();
}

function closeTab(id) {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) {
    return;
  }
  const [closed] = state.tabs.splice(index, 1);
  if (closed?.kind === "file") {
    state.dirtyFiles.delete(closed.data.path);
    window.relayEditor?.disposeModel?.(closed.data.repoId, closed.data.path);
  }
  if (state.activeTabId === id) {
    const next = state.tabs[Math.max(0, index - 1)];
    state.activeTabId = next?.id;
    if (next === undefined) {
      openView("overview");
      return;
    }
  }
  renderShell();
}

function openView(view, { activate = true } = {}) {
  const meta = VIEW_META[view];
  if (!meta) {
    return;
  }
  if (activate) {
    state.activity = meta.activity;
  }
  openTab(
    { id: `view:${view}`, kind: "view", view, title: meta.title, icon: meta.icon },
    { activate },
  );
}

function openRunTab(runId) {
  state.activity = "runs";
  openTab({
    id: `run:${runId}`,
    kind: "run",
    title: `Execution ${shortId(runId, 12)}`,
    icon: "runs",
    data: { runId },
  });
}

function openApprovalTab(approvalId) {
  state.activity = "approvals";
  openTab({
    id: `approval:${approvalId}`,
    kind: "approval",
    title: `Review ${shortId(approvalId, 12)}`,
    icon: "approvals",
    data: { approvalId },
  });
}

function openHistoryTab(repositoryId) {
  state.activity = "repositories";
  openTab({
    id: `history:${repositoryId}`,
    kind: "history",
    title: `${repositoryId} history`,
    icon: "history",
    data: { repositoryId },
  });
}

function openFileTab(repoId, path) {
  state.activity = "explorer";
  openTab({
    id: `file:${repoId}:${path}`,
    kind: "file",
    title: path.split("/").at(-1) ?? path,
    icon: "file",
    data: { repoId, path },
  });
}

/** Keeps the location hash in sync so deep links and bookmarks work. */
function tabHash(tab) {
  if (tab === undefined) {
    return "#overview";
  }
  switch (tab.kind) {
    case "view":
      return `#${tab.view}`;
    case "run":
      return `#run/${encodeURIComponent(tab.data.runId)}`;
    case "approval":
      return `#approval/${encodeURIComponent(tab.data.approvalId)}`;
    case "history":
      return `#history/${encodeURIComponent(tab.data.repositoryId)}`;
    case "file":
      return `#file/${encodeURIComponent(tab.data.repoId)}/${tab.data.path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
    default:
      return "#overview";
  }
}

let applyingHash = false;

function applyHash() {
  const raw = location.hash.slice(1);
  if (raw.length === 0) {
    openView("overview");
    return;
  }
  const [head, ...rest] = raw.split("/");
  applyingHash = true;
  try {
    if (head === "tasks") {
      // The Tasks submit-queue view was replaced by the agent chat; the
      // board remains the queue's visibility surface for old links.
      openView("board");
    } else if (head === "run" && rest[0]) {
      openRunTab(decodeURIComponent(rest[0]));
    } else if (head === "approval" && rest[0]) {
      openApprovalTab(decodeURIComponent(rest[0]));
    } else if (head === "history" && rest[0]) {
      openHistoryTab(decodeURIComponent(rest[0]));
    } else if (head === "file" && rest.length >= 2) {
      openFileTab(
        decodeURIComponent(rest[0]),
        rest.slice(1).map(decodeURIComponent).join("/"),
      );
    } else if (VIEW_META[head]) {
      openView(head);
    } else {
      openView("overview");
    }
  } finally {
    applyingHash = false;
  }
}

function syncHash() {
  if (applyingHash) {
    return;
  }
  const hash = tabHash(activeTab());
  if (location.hash !== hash) {
    history.replaceState(null, "", hash);
  }
}

/* ------------------------------------------------------ shell: render ---- */

function renderShell() {
  const tab = activeTab();
  $("#context-block").hidden = !(
    tab?.kind === "view" && tab.view === "overview"
  );
  // The Home HUD is immersive: no activity bar, no sidebar, no chat dock.
  // Navigation lives in the radial menu around the core instead.
  $("#app-shell").classList.toggle(
    "hud-immersive",
    tab?.kind === "view" && tab.view === "overview",
  );
  renderActivityBar();
  renderSidebar();
  renderTabStrip();
  renderActiveTabContent();
  renderStatusBar();
  renderEventsPanel();
  renderChat();
  syncHash();
}

function activityButton(entry) {
  const badge =
    entry.badge === "tasks"
      ? state.tasks.filter((task) => ["submitted", "claimed"].includes(task.status))
          .length
      : entry.badge === "approvals"
        ? state.approvals.filter((approval) => approval.status === "pending").length
        : 0;
  return `
    <button
      class="activity-button${state.activity === entry.id ? " active" : ""}"
      data-activity="${entry.id}"
      title="${escapeHtml(entry.label)}"
      aria-label="${escapeHtml(entry.label)}"
    >
      ${icon(entry.icon)}
      ${
        entry.badge
          ? `<span class="badge${entry.badge === "approvals" ? " hot" : ""}"${
              badge === 0 ? " data-zero" : ""
            }>${badge}</span>`
          : ""
      }
    </button>`;
}

function renderActivityBar() {
  $("#activity-items").innerHTML = ACTIVITIES.map(activityButton).join("");
  $("#activity-footer").innerHTML = FOOTER_ACTIVITIES.filter(
    (entry) => entry.id !== "admin" || state.principal?.user?.systemAdmin,
  )
    .map(activityButton)
    .join("");
}

function sideItem({ label, meta, iconName, action, active, count, indent = 0, title }) {
  return `
    <button
      class="side-item${active ? " active" : ""}"
      ${action}
      ${title ? `title="${escapeHtml(title)}"` : ""}
    >
      ${indent > 0 ? `<span class="indent" style="width:${indent * 12}px"></span>` : ""}
      ${iconName ? icon(iconName) : ""}
      <span class="grow">${label}</span>
      ${meta ? `<span class="muted">${meta}</span>` : ""}
      ${count === undefined ? "" : `<span class="count">${count}</span>`}
    </button>`;
}

function renderSidebar() {
  const title = {
    overview: "Home",
    explorer: "Explorer",
    board: "Task board",
    runs: "Agent executions",
    approvals: "Approvals",
    repositories: "Repositories",
    coordination: "Coordination",
    team: "Team",
    settings: "Settings",
    admin: "System admin",
  }[state.activity];
  $("#sidebar-title").textContent = title ?? "";
  const sidebars = {
    overview: sidebarOverview,
    explorer: sidebarExplorer,
    board: sidebarBoard,
    runs: sidebarRuns,
    approvals: sidebarApprovals,
    repositories: sidebarRepositories,
    coordination: sidebarCoordination,
    team: sidebarSimple,
    settings: sidebarSimple,
    admin: sidebarSimple,
  };
  const renderer = sidebars[state.activity] ?? sidebarSimple;
  const { body, actions = "" } = renderer();
  $("#sidebar-body").innerHTML = body;
  $("#sidebar-actions").innerHTML = actions;
}

function sidebarOverview() {
  const pending = state.tasks.filter((task) => task.status === "submitted").length;
  const active = state.tasks.filter((task) => task.status === "claimed").length;
  const reviews = state.approvals.filter(
    (approval) => approval.status === "pending",
  ).length;
  return {
    body: `
      ${sideItem({
        label: "Home",
        iconName: "home",
        action: 'data-open-view="overview"',
        active: activeTab()?.id === "view:overview",
      })}
      <div class="side-section">
        <h3>At a glance</h3>
        ${sideItem({
          label: "Queued tasks",
          iconName: "tasks",
          action: 'data-open-view="board"',
          count: pending,
        })}
        ${sideItem({
          label: "In motion",
          iconName: "runs",
          action: 'data-open-view="runs"',
          count: active,
        })}
        ${sideItem({
          label: "Awaiting review",
          iconName: "approvals",
          action: 'data-open-view="approvals"',
          count: reviews,
        })}
      </div>
      <div class="side-section">
        <h3>Recent activity</h3>
        ${timeline(state.audit, 6)}
      </div>`,
  };
}

function sidebarExplorer() {
  if (state.repositories.length === 0) {
    return {
      body: '<p class="side-empty">Import a repository to browse and edit a task workspace.</p>',
    };
  }
  const repoOptions = state.repositories
    .map(
      (repository) =>
        `<option value="${escapeHtml(repository.id)}"${
          repository.id === state.explorerRepo ? " selected" : ""
        }>${escapeHtml(repository.id)} · ${escapeHtml(repository.branch)}</option>`,
    )
    .join("");
  const workspace = state.workspace;
  const workspaceForRepo =
    workspace !== undefined && workspace.repositoryId === state.explorerRepo;
  let workspaceBlock;
  if (!canRun()) {
    workspaceBlock =
      '<p class="side-empty">Your role can view the dashboard but not open an editing workspace.</p>';
  } else if (!workspaceForRepo || !workspace.exists) {
    workspaceBlock = `
      <p class="side-empty">
        No workspace yet. Open one to get your own isolated overlay of
        canonical — edits stay yours until you submit them through the
        integration pipeline.
      </p>
      ${sideItem({
        label: "Open workspace",
        iconName: "files",
        action: 'data-action="workspace-open"',
      })}`;
  } else {
    const dirty = workspace.dirtyFiles?.length ?? 0;
    workspaceBlock = `
      <div class="side-section">
        <h3>Workspace</h3>
        <p class="side-empty">
          Base <code>${escapeHtml(shortId(workspace.baseRevision, 10))}</code>
          ${
            workspace.baseRevision === workspace.canonicalRevision
              ? "(current)"
              : `— canonical moved to <code>${escapeHtml(
                  shortId(workspace.canonicalRevision, 10),
                )}</code>`
          }
          · ${dirty} changed file${dirty === 1 ? "" : "s"}
        </p>
        <div class="row-actions" style="padding: 0 8px 8px">
          <button class="mini-button" data-action="workspace-submit" ${
            dirty === 0 ? "disabled" : ""
          }>Submit changes</button>
          <button class="mini-button" data-action="workspace-reset">Reset to canonical</button>
          <button class="mini-button danger" data-action="workspace-discard">Discard</button>
        </div>
      </div>
      <div class="side-section file-tree" id="file-tree">
        <h3>Files</h3>
        ${renderFileTree()}
      </div>`;
  }
  return {
    actions:
      '<button class="mini-button" data-action="workspace-refresh" title="Refresh workspace">↻</button>',
    body: `
      <div class="side-section">
        <label style="padding: 0 8px">
          <span>Repository</span>
          <select id="explorer-repo-select">${repoOptions}</select>
        </label>
      </div>
      ${workspaceBlock}`,
  };
}

function renderFileTree() {
  if (state.workspaceFiles.length === 0) {
    return '<p class="side-empty">The workspace is empty.</p>';
  }
  // Build a nested structure from flat paths.
  const root = { dirs: new Map(), files: [] };
  for (const file of state.workspaceFiles) {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) {
        node.dirs.set(part, { dirs: new Map(), files: [] });
      }
      node = node.dirs.get(part);
    }
    node.files.push({ name: parts.at(-1), ...file });
  }
  const dirty = new Set(state.workspace?.dirtyFiles ?? []);
  const renderNode = (node, prefix, depth) => {
    const chunks = [];
    for (const [name, child] of [...node.dirs.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      const expanded = state.expandedDirs.has(path);
      chunks.push(`
        <button class="side-item dir" data-toggle-dir="${escapeHtml(path)}">
          <span class="indent" style="width:${depth * 12}px"></span>
          ${icon(expanded ? "chevronDown" : "chevronRight")}
          ${icon("folder")}
          <span class="grow">${escapeHtml(name)}</span>
        </button>`);
      if (expanded) {
        chunks.push(renderNode(child, path, depth + 1));
      }
    }
    for (const file of [...node.files].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const isDirty = dirty.has(file.path) || state.dirtyFiles.has(file.path);
      chunks.push(`
        <button
          class="side-item"
          data-open-file="${escapeHtml(file.path)}"
          title="${escapeHtml(file.path)}"
        >
          <span class="indent" style="width:${(depth + 1) * 12}px"></span>
          ${icon("file")}
          <span class="grow${isDirty ? " file-dirty" : ""}">${escapeHtml(
            file.name,
          )}${isDirty ? " ●" : ""}</span>
        </button>`);
    }
    return chunks.join("");
  };
  return renderNode(root, "", 0);
}

function sidebarBoard() {
  const counts = {};
  for (const task of state.tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  return {
    body: `
      ${sideItem({
        label: "Board",
        iconName: "board",
        action: 'data-open-view="board"',
        active: activeTab()?.id === "view:board",
        count: state.tasks.length,
      })}
      <div class="side-section">
        <h3>By status</h3>
        ${["submitted", "claimed", "integrated", "failed", "cancelled"]
          .map((status) =>
            sideItem({
              label: status.replaceAll("_", " "),
              action: 'data-open-view="board"',
              count: counts[status] ?? 0,
            }),
          )
          .join("")}
      </div>
      <div class="side-section">
        <h3>Prompt work</h3>
        <p class="side-empty">
          New work starts in the agent chat on the right — pick an agent,
          describe the change, and that agent plans and executes it.
        </p>
        ${sideItem({
          label: "Focus the chat",
          iconName: "tasks",
          action: 'data-action="chat-focus"',
        })}
      </div>
      ${
        canRun() && state.repositories.length > 0
          ? `<div class="side-section"><h3>Execute queue</h3>${state.repositories
              .map((repository) =>
                sideItem({
                  label: `Execute ${escapeHtml(repository.id)}`,
                  iconName: "runs",
                  action: `data-run-repo="${escapeHtml(repository.id)}"`,
                }),
              )
              .join("")}</div>`
          : ""
      }`,
  };
}

function sidebarRuns() {
  const runs = state.runs.slice(0, 30);
  return {
    body: `
      ${sideItem({
        label: "All executions",
        iconName: "runs",
        action: 'data-open-view="runs"',
        active: activeTab()?.id === "view:runs",
        count: state.runs.length,
      })}
      <div class="side-section">
        <h3>Recent</h3>
        ${
          runs.length === 0
            ? '<p class="side-empty">No agent executions yet.</p>'
            : runs
                .map((run) =>
                  sideItem({
                    label: `${escapeHtml(run.repositoryId)} · ${escapeHtml(
                      run.status,
                    )}`,
                    meta: escapeHtml(formatDate(run.startedAt, { short: true })),
                    iconName: "commit",
                    action: `data-open-run="${escapeHtml(run.id)}"`,
                    active: activeTab()?.id === `run:${run.id}`,
                    title: run.id,
                  }),
                )
                .join("")
        }
      </div>`,
  };
}

function sidebarApprovals() {
  const pending = state.approvals.filter(
    (approval) => approval.status === "pending",
  );
  const decided = state.approvals.filter(
    (approval) => approval.status !== "pending",
  );
  const item = (approval) =>
    sideItem({
      label: escapeHtml(approval.reasons[0] ?? approval.kind),
      iconName: "approvals",
      action: `data-open-approval="${escapeHtml(approval.id)}"`,
      active: activeTab()?.id === `approval:${approval.id}`,
      meta: escapeHtml(approval.status),
    });
  return {
    body: `
      ${sideItem({
        label: "Review queue",
        iconName: "approvals",
        action: 'data-open-view="approvals"',
        active: activeTab()?.id === "view:approvals",
        count: pending.length,
      })}
      <div class="side-section">
        <h3>Pending</h3>
        ${
          pending.length === 0
            ? '<p class="side-empty">No decisions blocking work.</p>'
            : pending.map(item).join("")
        }
      </div>
      <div class="side-section">
        <h3>Decided</h3>
        ${
          decided.length === 0
            ? '<p class="side-empty">No decision history.</p>'
            : decided.slice(0, 15).map(item).join("")
        }
      </div>`,
  };
}

function sidebarRepositories() {
  return {
    body: `
      ${sideItem({
        label: "All repositories",
        iconName: "repos",
        action: 'data-open-view="repositories"',
        active: activeTab()?.id === "view:repositories",
        count: state.repositories.length,
      })}
      <div class="side-section">
        <h3>Canonical mirrors</h3>
        ${
          state.repositories.length === 0
            ? '<p class="side-empty">No repository linked yet.</p>'
            : state.repositories
                .map((repository) =>
                  sideItem({
                    label: escapeHtml(repository.id),
                    meta: escapeHtml(repository.branch),
                    iconName: "repos",
                    action: `data-open-history="${escapeHtml(repository.id)}"`,
                    active:
                      activeTab()?.id === `history:${repository.id}`,
                  }),
                )
                .join("")
        }
      </div>`,
  };
}

function sidebarCoordination() {
  return {
    body: `
      ${sideItem({
        label: "Coordination metrics",
        iconName: "graph",
        action: 'data-open-view="coordination"',
        active: activeTab()?.id === "view:coordination",
      })}
      <div class="side-section">
        <h3>Workers</h3>
        ${
          state.workers.length === 0
            ? '<p class="side-empty">No workers registered.</p>'
            : state.workers
                .map((worker) =>
                  sideItem({
                    label: escapeHtml(worker.name || shortId(worker.id)),
                    meta: escapeHtml(worker.version ?? ""),
                    iconName: "people",
                  }),
                )
                .join("")
        }
      </div>`,
  };
}

function sidebarSimple() {
  const items = {
    team: [["team", "Members & roles", "people"]],
    settings: [["settings", "Project & policy", "gear"]],
    admin: [["admin", "Host operations", "shield"]],
  }[state.activity] ?? [["overview", "Overview", "home"]];
  return {
    body: items
      .map(([view, label, iconName]) =>
        sideItem({
          label,
          iconName,
          action: `data-open-view="${view}"`,
          active: activeTab()?.id === `view:${view}`,
        }),
      )
      .join(""),
  };
}

function renderTabStrip() {
  $("#tab-strip").innerHTML = state.tabs
    .map(
      (tab) => `
      <button
        class="tab${tab.id === state.activeTabId ? " active" : ""}"
        data-tab-id="${escapeHtml(tab.id)}"
        role="tab"
        aria-selected="${tab.id === state.activeTabId}"
        title="${escapeHtml(tab.title)}"
      >
        ${icon(tab.icon)}
        <span class="label">${escapeHtml(tab.title)}</span>
        ${
          tab.kind === "file" && state.dirtyFiles.has(tab.data.path)
            ? '<span class="dirty-dot" title="Unsaved changes"></span>'
            : ""
        }
        <span class="close" data-close-tab="${escapeHtml(tab.id)}">${icon(
          "close",
        )}</span>
      </button>`,
    )
    .join("");
}

function renderStatusBar() {
  const docker = state.health?.docker;
  $("#status-docker").innerHTML = docker
    ? `${icon("shield")} ${
        docker.available
          ? `sandbox ${escapeHtml(docker.version ?? "ready")}`
          : "no sandbox"
      }`
    : "";
  const user = state.principal?.user;
  $("#status-user").textContent = user
    ? `${user.displayName} · ${currentRole().replaceAll("_", " ")}`
    : "";
}

function renderEventsPanel() {
  const panel = $("#events-panel");
  if (panel) {
    panel.innerHTML = timeline(state.audit, 40);
  }
}

/* -------------------------------------------------- tab content: views --- */

const viewRenderers = {
  overview: renderOverview,
  explorer: renderExplorerView,
  board: renderBoard,
  runs: renderRuns,
  approvals: renderApprovals,
  repositories: renderRepositories,
  coordination: renderCoordination,
  team: renderTeam,
  settings: renderSettings,
  admin: renderAdmin,
};

function renderActiveTabContent() {
  const container = $("#tab-content");
  const tab = activeTab();
  container.classList.toggle(
    "no-scroll",
    tab?.kind === "file" || (tab?.kind === "view" && tab.view === "explorer"),
  );
  if (tab === undefined) {
    openView("overview");
    return;
  }
  if (tab.kind === "view") {
    if (!state.projectId && !["settings", "admin", "overview"].includes(tab.view)) {
      container.innerHTML = `<div class="view">${noProjectContent()}</div>`;
      return;
    }
    container.innerHTML = viewRenderers[tab.view]?.() ?? "";
    return;
  }
  if (tab.kind === "run") {
    void renderRunTab(container, tab);
    return;
  }
  if (tab.kind === "approval") {
    void renderApprovalTab(container, tab);
    return;
  }
  if (tab.kind === "history") {
    void renderHistoryTab(container, tab);
    return;
  }
  if (tab.kind === "file") {
    void renderFileTabContent(container, tab);
  }
}

/**
 * What a project-scoped view shows before we know whether there is a project.
 *
 * Deliberately not `noProjectContent()`: telling a returning user to "create
 * your first project" while their context is still loading is a false claim
 * about their account, and it happened on every cold load and every socket
 * reconnect.
 */
function loadingContent(label = "Loading your control room") {
  return `
    <div class="loading-state" role="status" aria-live="polite" aria-busy="true">
      <div class="loading-state-head">
        <span class="loading-spinner" aria-hidden="true"></span>
        <p>${escapeHtml(label)}</p>
      </div>
      <div class="skeleton-stack" aria-hidden="true">
        <div class="skeleton skeleton-row"></div>
        <div class="skeleton skeleton-row"></div>
        <div class="skeleton skeleton-row short"></div>
      </div>
    </div>`;
}

/** True while the first context fetch is still outstanding. */
function contextPending() {
  return state.contextLoaded === false;
}

/** The failed-first-load state: an explanation and a way out, not a spinner. */
function contextErrorContent() {
  return `
    <div class="empty-state">
      <div>
        <p class="eyebrow">Control plane</p>
        <h2>Could not load your control room</h2>
        <p>${escapeHtml(state.contextError ?? "The control plane did not respond.")}</p>
        <p class="muted">Your projects are unaffected — this browser could not reach the gateway.</p>
        <button class="button button-primary" data-action="retry-context">Try again</button>
      </div>
    </div>`;
}

function noProjectContent() {
  if (state.contextLoaded === false && state.contextError !== undefined) {
    return contextErrorContent();
  }
  if (contextPending()) {
    return loadingContent();
  }
  return `
    <div class="empty-state">
      <div>
        <p class="eyebrow">Start here</p>
        <h2>Create your first project</h2>
        <p>A project scopes repositories, tasks, approvals, executions, and live events inside an organization.</p>
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

/* Overview ---------------------------------------------------------------- */

function metric(label, value, foot, glyph) {
  return `
    <article class="metric">
      <span class="metric-label">${escapeHtml(label)} <span>${glyph ?? ""}</span></span>
      <strong class="metric-value">${escapeHtml(value)}</strong>
      <span class="metric-foot">${escapeHtml(foot)}</span>
    </article>`;
}

/** Radius and sweep of every HUD dial, in the gauge SVG's own units. */
const GAUGE_RADIUS = 26;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;
/** Dials are 270° with the gap at the bottom, so a full ring reads as full. */
const GAUGE_SWEEP = 0.75;

/**
 * One HUD readout: a thin glowing arc around a count.
 *
 * `part`/`whole` are the real numbers the arc is drawn from — the sweep is
 * always a share of something the control plane actually reported, never a
 * decorative fraction. A zero or missing `whole` draws an empty track, which
 * is the honest picture of "nothing to be a share of".
 */
function gauge(label, value, foot, { part = 0, whole = 0, tone = "" } = {}) {
  const ratio =
    whole > 0 ? Math.max(0, Math.min(1, part / whole)) : 0;
  const arc = GAUGE_CIRCUMFERENCE * GAUGE_SWEEP;
  const text = String(value);
  return `
    <article class="gauge${tone ? ` ${tone}` : ""}">
      <div class="gauge-dial">
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <circle class="gauge-ticks" cx="32" cy="32" r="30"></circle>
          <g transform="rotate(135 32 32)">
            <circle class="gauge-track" cx="32" cy="32" r="${GAUGE_RADIUS}"
              stroke-dasharray="${arc} ${GAUGE_CIRCUMFERENCE}"></circle>
            <circle class="gauge-arc" cx="32" cy="32" r="${GAUGE_RADIUS}"
              stroke-dasharray="${arc * ratio} ${GAUGE_CIRCUMFERENCE}"></circle>
          </g>
        </svg>
        <span class="gauge-value${
          text.length > 3 ? " gauge-value-long" : ""
        }">${escapeHtml(text)}</span>
      </div>
      <span class="gauge-label">${escapeHtml(label)}</span>
      <span class="gauge-foot">${escapeHtml(foot)}</span>
    </article>`;
}

/**
 * The Home HUD's navigation, orbiting the core. Built from the same
 * ACTIVITIES lists the activity bar uses, so labels, badges, and admin
 * visibility stay defined in one place even though the bar itself is
 * hidden on this view.
 */
/**
 * The reference desktop's top edge: a ruler of the month's days with today
 * lit. The machine's real calendar; it re-renders with the shell.
 */
function hudCalendarStrip() {
  const now = new Date();
  const today = now.getDate();
  const daysInMonth = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
  ).getDate();
  return `<div class="hud-daystrip" aria-hidden="true">
    ${Array.from(
      { length: daysInMonth },
      (_, index) =>
        `<span${index + 1 === today ? ' class="today"' : ""}>${String(
          index + 1,
        ).padStart(2, "0")}</span>`,
    ).join("")}
  </div>`;
}

/**
 * The reference's top-left assembly: weekday and clock in a bracket line
 * above a big ringed day-of-month, the ring's arc the month's progress.
 */
function hudClock() {
  const now = new Date();
  const day = now.getDate();
  const daysInMonth = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
  ).getDate();
  const arc = GAUGE_CIRCUMFERENCE * (day / daysInMonth);
  return `<div class="hud-clock">
    <div class="hud-clock-bracket">
      <span>${escapeHtml(now.toLocaleString("en-US", { weekday: "long" }))}</span>
      <strong>${escapeHtml(
        now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
      )}</strong>
    </div>
    <div class="hud-clock-row">
      <div class="hud-clock-dial">
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <circle class="gauge-ticks" cx="32" cy="32" r="30"></circle>
          <circle class="gauge-track" cx="32" cy="32" r="${GAUGE_RADIUS}"></circle>
          <circle class="gauge-arc" cx="32" cy="32" r="${GAUGE_RADIUS}"
            stroke-dasharray="${arc.toFixed(1)} ${GAUGE_CIRCUMFERENCE.toFixed(1)}"
            transform="rotate(-90 32 32)"></circle>
        </svg>
        <span class="hud-clock-center">
          <span class="hud-clock-month">${escapeHtml(
            now.toLocaleString("en-US", { month: "short" }),
          )}</span>
          <span class="hud-clock-day">${day}</span>
        </span>
      </div>
    </div>
  </div>`;
}

/** Repository shortcuts, like the reference's games list: click opens history. */
function hudShortcuts() {
  if (state.repositories.length === 0) {
    return "";
  }
  return `<div class="hud-system hud-shortcuts">
    <span class="hud-system-title">Canonical sources</span>
    ${state.repositories
      .slice(0, 6)
      .map(
        (repository) => `<button
          class="hud-link-row"
          data-open-history="${escapeHtml(repository.id)}"
          title="Open canonical history"
        ><i></i>${escapeHtml(repository.id)}<span class="muted"> · ${escapeHtml(
          repository.branch,
        )}</span></button>`,
      )
      .join("")}
  </div>`;
}

/** The up/down circle and address line: this dashboard's own connection. */
function hudLinkCircle() {
  const sockets = state.health?.webSocketConnections ?? 0;
  const live = state.socket?.readyState === 1;
  return `<div class="hud-linkbox">
    <div class="hud-linkring${live ? " on" : ""}" data-hud-socket-ring>
      <span>${sockets}</span>
      <small>socket${sockets === 1 ? "" : "s"}</small>
    </div>
    <div class="hud-linkmeta">
      <strong data-hud-socket-label="detail">${
        live ? "LINK LIVE" : "LINK DOWN"
      }</strong>
      <span>${escapeHtml(location.host)}</span>
      <span>session ${escapeHtml(duration(Date.now() - SESSION_STARTED))}</span>
    </div>
  </div>`;
}

/** Sandbox console access, in the reference's search-box slot. */
function hudTerminalBox() {
  return `<div class="hud-termbox">
    <span class="hud-system-title">Console</span>
    <div class="hud-termbox-row">
      <button class="hud-termbtn" data-panel-tab="terminal">${icon(
        "terminal",
      )}<span>Terminal</span></button>
      <button class="hud-termbtn" data-panel-tab="events">${icon(
        "graph",
      )}<span>Events</span></button>
      <button class="hud-termbtn" data-action="hud-refresh">${icon(
        "history",
      )}<span>Refresh</span></button>
    </div>
  </div>`;
}

/** The project plate, in the reference's "Проект" slot. All real context. */
function hudProjectPlate() {
  return `<div class="hud-system hud-plate">
    <span class="hud-system-title">Project</span>
    <strong class="hud-plate-name">${escapeHtml(
      state.project?.name ?? "—",
    )}</strong>
    <span class="hud-plate-sub">${state.repositories.length} canonical source${
      state.repositories.length === 1 ? "" : "s"
    } · ${state.members.length} member${state.members.length === 1 ? "" : "s"}</span>
  </div>`;
}

/** SYSTEM with right-hand percent bars, like the reference's CPU/RAM/SWAP. */
function hudSystemBars() {
  const docker = state.health?.docker;
  const agents = state.agentsRunning;
  const integrated = state.tasks.filter(
    (task) => task.status === "integrated",
  ).length;
  const completed = state.runs.filter(
    (run) => run.status === "completed",
  ).length;
  const pct = (part, whole) =>
    whole > 0 ? Math.round((100 * part) / whole) : 0;
  const barRow = (label, value) => `<div class="hud-sysbar-row">
    <span>${escapeHtml(label)}</span>
    <div class="hud-meter"><span style="width:${value}%; background:var(--accent)"></span></div>
    <strong>${value}%</strong>
  </div>`;
  return `<div class="hud-system">
    <span class="hud-system-title">System</span>
    <div class="hud-sys-row"><span>Link</span><strong data-hud-socket-label="compact">${
      state.socket?.readyState === 1 ? "live" : "connecting"
    }</strong></div>
    <div class="hud-sys-row"><span>Sandbox</span><strong>${escapeHtml(
      docker?.available ? (docker.version ?? "ready") : "offline",
    )}</strong></div>
    ${barRow("Fleet busy", pct(agents?.busyWorkers ?? 0, agents?.workers ?? 0))}
    ${barRow("Tasks landed", pct(integrated, state.tasks.length))}
    ${barRow("Runs complete", pct(completed, state.runs.length))}
  </div>`;
}

/** The vertical view links, in the reference's site-links slot. */
function hudLinksStack() {
  const entries = [...ACTIVITIES, ...FOOTER_ACTIVITIES].filter(
    (entry) =>
      entry.view !== "overview" &&
      (entry.id !== "admin" || state.principal?.user?.systemAdmin),
  );
  return `<div class="hud-system hud-links">
    <span class="hud-system-title">Views</span>
    ${entries
      .map(
        (entry) => `<button class="hud-link-row" data-open-view="${entry.view}">
          <i></i>${escapeHtml(entry.label)}
        </button>`,
      )
      .join("")}
  </div>`;
}

/** Landed-work headlines, in the reference's news slot. */
function hudFeed() {
  const notable = state.audit
    .filter((record) =>
      /promoted|integrated|decided|rollback|imported|created/u.test(
        String(record.event?.type ?? ""),
      ),
    )
    .slice(-5)
    .reverse();
  if (notable.length === 0) {
    return "";
  }
  return `<div class="hud-system hud-feed">
    <span class="hud-system-title">Canonical feed</span>
    ${notable
      .map(
        (record) => `<div class="hud-feed-row">
          <strong>${escapeHtml(eventTitle(record.event))}</strong>
          <span>${escapeHtml(
            formatDate(record.event.occurredAt, { short: true }),
          )}</span>
        </div>`,
      )
      .join("")}
  </div>`;
}

/** Worker fleet, in the reference's USB-devices slot. */
function hudWorkers() {
  return `<div class="hud-system hud-devices">
    <span class="hud-system-title">Workers</span>
    ${
      state.workers.length === 0
        ? `<div class="hud-sys-row"><span>No machines listening</span><strong>0</strong></div>`
        : state.workers
            .slice(0, 4)
            .map(
              (worker) => `<div class="hud-sys-row">
                <span>${escapeHtml(worker.name || shortId(worker.id, 12))}</span>
                <strong>${escapeHtml(
                  (worker.adapters ?? []).join(" · ") || "idle",
                )}</strong>
              </div>`,
            )
            .join("")
    }
  </div>`;
}

/**
 * A small activity bar-graph, in the reference's traffic-graph slot: real
 * timestamps binned over the last 24 hours.
 */
function hudGraph(title, stamps) {
  const bins = 24;
  const spanMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const counts = new Array(bins).fill(0);
  for (const stamp of stamps) {
    const at = new Date(stamp ?? "").getTime();
    if (!Number.isFinite(at)) {
      continue;
    }
    const age = now - at;
    if (age < 0 || age >= spanMs) {
      continue;
    }
    counts[bins - 1 - Math.floor(age / (spanMs / bins))] += 1;
  }
  const max = Math.max(1, ...counts);
  const total = counts.reduce((sum, value) => sum + value, 0);
  return `<div class="hud-graph">
    <div class="hud-graph-head">
      <span>${escapeHtml(title)}</span>
      <strong>${total} / 24h</strong>
    </div>
    <svg viewBox="0 0 ${bins * 8 - 3} 24" preserveAspectRatio="none" aria-hidden="true">
      ${counts
        .map((count, index) => {
          const height = ((22 * count) / max + 1).toFixed(1);
          return `<rect x="${index * 8}" y="${(24 - Number(height)).toFixed(
            1,
          )}" width="5" height="${height}"></rect>`;
        })
        .join("")}
    </svg>
  </div>`;
}

/**
 * One peripheral readout cluster: a stencilled title over label/value rows.
 * Every row rendered through here is state the dashboard already holds —
 * the HUD dramatises real data, it never invents any.
 */
function hudList(title, rows) {
  return `<div class="hud-system">
    <span class="hud-system-title">${escapeHtml(title)}</span>
    ${rows
      .map(
        ([label, value, tone]) => `<div class="hud-sys-row${
          tone ? ` ${tone}` : ""
        }">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(String(value))}</strong>
        </div>`,
      )
      .join("")}
  </div>`;
}

/**
 * Coordination telemetry, straight from the metrics endpoint the
 * Coordination view reads. Absent metrics render as an absent cluster,
 * never as zeros pretending to be measurements.
 */
function hudCoordination() {
  const metrics = state.metrics;
  if (!metrics) {
    return "";
  }
  const { conflicts, rework, throughput, cost } = metrics;
  return hudList("Coordination", [
    ["Conflicts predicted", conflicts.predictions],
    ["Confirmed", conflicts.confirmedPredictions],
    ["Missed", conflicts.unpredictedContention, conflicts.unpredictedContention > 0 ? "warn" : ""],
    ["Replans", rework.replansRequested],
    ["Mean integration", duration(throughput.averageTimeToIntegrationMs)],
    ["Lease runtime", duration(cost.leaseRuntimeMs)],
  ]);
}

/** Model subsystems: the three provider CLIs and whether each is signed in. */
function hudSubsystems() {
  const providers = CHAT_PROVIDERS.map((provider) => {
    const status = providerStatus(provider.id);
    return `<div class="hud-sys-row">
      <span><i class="hud-dot${
        status?.connected ? " on" : ""
      }"></i>${escapeHtml(provider.name)}</span>
      <strong>${status?.connected ? "online" : "offline"}</strong>
    </div>`;
  }).join("");
  return `<div class="hud-system">
    <span class="hud-system-title">Subsystems</span>
    ${providers}
  </div>`;
}

/**
 * The capacity bars under the clock, like the reference's drive gauges:
 * a segmented task-pipeline band, then completion bars for runs and gates.
 * Every width is a real share; empty wholes draw empty tracks.
 */
function hudBars() {
  const counts = [
    ["integrated", "var(--success)"],
    ["claimed", "var(--accent)"],
    ["submitted", "rgba(79, 232, 255, 0.35)"],
    ["failed", "var(--danger)"],
    ["cancelled", "var(--fg-subtle)"],
  ].map(([status, color]) => [
    status,
    color,
    state.tasks.filter((task) => task.status === status).length,
  ]);
  const total = state.tasks.length;
  const pipeline =
    total === 0
      ? ""
      : `<div class="hud-bar-row">
          <div class="hud-bar-head"><span>Tasks</span><strong>${total}</strong></div>
          <div class="hud-meter">
            ${counts
              .filter(([, , count]) => count > 0)
              .map(
                ([status, color, count]) =>
                  `<span title="${escapeHtml(status)}: ${count}" style="width:${
                    (100 * count) / total
                  }%; background:${color}"></span>`,
              )
              .join("")}
          </div>
          <div class="hud-meter-legend">
            ${counts
              .filter(([, , count]) => count > 0)
              .map(
                ([status, color, count]) =>
                  `<span><i style="background:${color}"></i>${escapeHtml(
                    status,
                  )} ${count}</span>`,
              )
              .join("")}
          </div>
        </div>`;
  const bar = (label, part, whole) => `<div class="hud-bar-row">
    <div class="hud-bar-head"><span>${escapeHtml(label)}</span>
      <strong>${part}/${whole}</strong></div>
    <div class="hud-meter">
      <span style="width:${whole > 0 ? (100 * part) / whole : 0}%; background:var(--accent)"></span>
    </div>
  </div>`;
  const completedRuns = state.runs.filter(
    (run) => run.status === "completed",
  ).length;
  const decidedGates = state.approvals.filter(
    (approval) => approval.status !== "pending",
  ).length;
  return `<div class="hud-bars">
    ${pipeline}
    ${bar("Runs completed", completedRuns, state.runs.length)}
    ${bar("Gates decided", decidedGates, state.approvals.length)}
  </div>`;
}

/** Ring-sized abbreviations; anything unlisted wears its full label. */
const SATELLITE_SHORT_LABELS = {
  repositories: "Repos",
  coordination: "Coord",
  admin: "Admin",
};

/**
 * The Home HUD's navigation: a dock of circular buttons along the bottom
 * of the view, like the reference desktop's icon row. Built from the same
 * ACTIVITIES lists the activity bar uses, so labels, badges, and admin
 * visibility stay defined in one place even though the bar itself is
 * hidden on this view.
 */
function hudDock() {
  const entries = [...ACTIVITIES, ...FOOTER_ACTIVITIES].filter(
    (entry) =>
      entry.view !== "overview" &&
      (entry.id !== "admin" || state.principal?.user?.systemAdmin),
  );
  return `<nav class="hud-dock" aria-label="Views">
    ${entries
      .map((entry) => {
        const badge =
          entry.badge === "tasks"
            ? state.tasks.filter((task) =>
                ["submitted", "claimed"].includes(task.status),
              ).length
            : entry.badge === "approvals"
              ? state.approvals.filter(
                  (approval) => approval.status === "pending",
                ).length
              : 0;
        return `<button
          class="dock-btn"
          data-open-view="${entry.view}"
          title="${escapeHtml(entry.label)}"
        >
          <span class="dock-ring">
            ${icon(entry.icon)}
            ${badge > 0 ? `<span class="dock-badge">${badge}</span>` : ""}
          </span>
          <span class="dock-label">${escapeHtml(
            SATELLITE_SHORT_LABELS[entry.id] ?? entry.label,
          )}</span>
        </button>`;
      })
      .join("")}
  </nav>`;
}

/**
 * The centerpiece: an instrument cluster around a wireframe globe.
 *
 * Nothing here invents data. The breathing period comes from real load —
 * `running + claimed` shortens it, so an idle control room drifts and a
 * busy one visibly quickens. The three scale arcs are real shares (tasks
 * integrated, runs completed, gates decided), and the four corner callouts
 * are live queue numbers. Everything else is geometry.
 */
function neuralCore({ running, claimed, awaiting }) {
  const load = running + claimed;
  // 6s at rest down to a 1.8s floor, so a busy core reads as urgent without
  // becoming a strobe in someone's peripheral vision while they work.
  const period = Math.max(1.8, 6 - load * 0.7).toFixed(2);
  const nodes = 14;
  const lattice = Array.from({ length: nodes }, (_, index) => {
    const angle = (360 / nodes) * index;
    // Two shells of nodes so the lattice reads as depth, not as a clock face.
    const radius = index % 3 === 0 ? 96 : 74;
    const delay = ((index * 7) % nodes) / nodes;
    return `<i class="core-node" style="--angle:${angle}deg; --orbit:${radius}px; --delay:${delay.toFixed(
      3,
    )}s"></i>`;
  }).join("");
  const phase =
    running > 0
      ? "executing"
      : claimed > 0
        ? "coordinating"
        : awaiting > 0
          ? "awaiting review"
          : "standing by";

  // The instrument arcs: each is a real completion share, and an empty
  // denominator draws an empty arc rather than a full one.
  const share = (part, whole) =>
    whole > 0 ? Math.max(0, Math.min(1, part / whole)) : 0;
  const integrated = state.tasks.filter(
    (task) => task.status === "integrated",
  ).length;
  const completed = state.runs.filter(
    (run) => run.status === "completed",
  ).length;
  const decided = state.approvals.filter(
    (approval) => approval.status !== "pending",
  ).length;
  const scaleArc = (radius, ratio, cls, label) => {
    const circumference = 2 * Math.PI * radius;
    return `<circle class="scale-arc ${cls}" cx="100" cy="100" r="${radius}"
      stroke-dasharray="${(circumference * 0.62 * ratio).toFixed(1)} ${circumference.toFixed(1)}"
      transform="rotate(122 100 100)"><title>${escapeHtml(label)}</title></circle>`;
  };
  const arcs = [
    scaleArc(
      86,
      share(integrated, state.tasks.length),
      "arc-tasks",
      `Tasks integrated: ${integrated}/${state.tasks.length}`,
    ),
    scaleArc(
      79,
      share(completed, state.runs.length),
      "arc-runs",
      `Runs completed: ${completed}/${state.runs.length}`,
    ),
    scaleArc(
      72,
      share(decided, state.approvals.length),
      "arc-gates",
      `Gates decided: ${decided}/${state.approvals.length}`,
    ),
  ].join("");

  const reads = [
    ["nw", running, "running"],
    ["ne", claimed, "in motion"],
    ["sw", awaiting, "review"],
    ["se", state.tasks.filter((task) => task.status === "submitted").length, "queued"],
  ]
    .map(
      ([corner, value, label]) => `<div class="core-read core-read-${corner}">
        <strong>${escapeHtml(String(value))}</strong>
        <span>${escapeHtml(label)}</span>
      </div>`,
    )
    .join("");

  return `
    <div class="neural-core" style="--pulse:${period}s" data-load="${load}">
      <div class="core-ring core-ring-a"></div>
      <div class="core-ring core-ring-b"></div>
      <div class="core-ring core-ring-c"></div>
      <div class="core-tickring"></div>
      <div class="core-sweep"></div>
      <div class="core-lattice">${lattice}</div>
      <!-- The instrument scale: fine and coarse tick rings, and the three
           data arcs riding between them. -->
      <svg class="core-scale" viewBox="0 0 200 200" aria-hidden="true">
        <circle class="scale-fine" cx="100" cy="100" r="94"></circle>
        <circle class="scale-coarse" cx="100" cy="100" r="90"></circle>
        ${arcs}
      </svg>
      ${reads}
      <div class="core-orb" aria-hidden="true">
        <!-- Wireframe graticule instead of a filled sphere: static latitude
             chords, and meridians whose widths run a cosine so the globe
             reads as slowly turning. -->
        <svg class="core-globe" viewBox="0 0 100 100">
          <circle class="globe-line" cx="50" cy="50" r="47"></circle>
          <line class="globe-line globe-faint" x1="3" y1="50" x2="97" y2="50"></line>
          <line class="globe-line globe-faint" x1="6.6" y1="32" x2="93.4" y2="32"></line>
          <line class="globe-line globe-faint" x1="6.6" y1="68" x2="93.4" y2="68"></line>
          <line class="globe-line globe-faint" x1="15.6" y1="18" x2="84.4" y2="18"></line>
          <line class="globe-line globe-faint" x1="15.6" y1="82" x2="84.4" y2="82"></line>
          <ellipse class="globe-line globe-meridian" cx="50" cy="50" rx="47" ry="47"
            style="--lon-delay: 0s"></ellipse>
          <ellipse class="globe-line globe-meridian" cx="50" cy="50" rx="47" ry="47"
            style="--lon-delay: -4s"></ellipse>
          <ellipse class="globe-line globe-meridian" cx="50" cy="50" rx="47" ry="47"
            style="--lon-delay: -8s"></ellipse>
        </svg>
      </div>
      <div class="core-caption">
        <span class="core-state">${escapeHtml(phase)}</span>
        <span class="core-sub">${escapeHtml(
          load === 1 ? "1 unit of work in flight" : `${load} units of work in flight`,
        )}</span>
      </div>
    </div>`;
}

/**
 * Live telemetry placed inside the generated diagnostic ring.
 *
 * The backdrop owns the visual geometry; this layer carries only product
 * state. That keeps the centerpiece dense without disguising decorative
 * marks as measurements.
 */
function coreSatelliteStats({ audit = [], runs = [] } = {}) {
  const auditCount = (type) =>
    audit.filter((record) => record.event?.type === type).length;

  return [
    {
      position: "nw",
      label: "Plan revisions",
      value: auditCount("plan_revised"),
      context: "audit signal",
      view: "coordination",
    },
    {
      position: "ne",
      label: "Scope requests",
      value: auditCount("scope_change_requested"),
      context: "planning",
      view: "coordination",
    },
    {
      position: "sw",
      label: "Failed runs",
      value: runs.filter((run) => run.status === "failed").length,
      context: "execution",
      view: "runs",
    },
    {
      position: "se",
      label: "Audit depth",
      value: audit.length,
      context: "retained events",
      view: "coordination",
    },
  ];
}

function hudCoreSatellites() {
  return `<div
    class="hud-core-satellites"
    role="group"
    aria-label="Extended coordination telemetry"
  >
    ${coreSatelliteStats(state)
      .map(
        ({ position, label, value, context, view }, index) =>
          `<button
            type="button"
            class="hud-mini-orb hud-mini-orb-${position}"
            data-open-view="${view}"
            data-hud-satellite="${position}"
            style="--orb-delay: ${index * 65}ms"
            aria-label="${escapeHtml(`${label}: ${value}. Open ${view}.`)}"
          >
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(String(value))}</strong>
            <small>${escapeHtml(context)}</small>
          </button>`,
      )
      .join("")}
  </div>`;
}

function hudCoreTelemetry({
  running,
  pendingTasks,
  activeTasks,
  integratedTasks,
  pendingApprovals,
}) {
  const totalTasks = state.tasks.length;
  const acceptance =
    totalTasks > 0
      ? Math.round((100 * integratedTasks.length) / totalTasks)
      : 0;
  const completedRuns = state.runs.filter(
    (run) => run.status === "completed",
  ).length;
  const runningRun = state.runs.find((run) => run.status === "running");
  const focusTask = activeTasks[0] ?? pendingTasks[0] ?? state.tasks.at(-1);
  const latestAudit = state.audit.at(-1)?.event;
  const phase =
    running > 0 || runningRun
      ? "executing"
      : activeTasks.length > 0
        ? "coordinating"
        : pendingApprovals.length > 0
          ? "review gate"
          : pendingTasks.length > 0
            ? "queue ready"
            : "standing by";
  const focus =
    focusTask?.objective ??
    (latestAudit ? eventTitle(latestAudit) : "Control plane synchronized");
  const focusMeta = runningRun
    ? `Run ${shortId(runningRun.id, 14)} is active`
    : latestAudit
      ? `Last signal ${formatDate(latestAudit.occurredAt, { short: true })}`
      : "No coordination events recorded";
  const replans = state.metrics?.rework?.replansRequested;

  const readout = (label, value, action = "") => {
    const tag = action ? "button" : "div";
    return `
    <${tag} class="hud-core-readout"${action}${
      action ? ' type="button"' : ""
    }>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value))}</strong>
    </${tag}>`;
  };

  return `<section
    class="hud-core-telemetry"
    aria-label="Live coordination core. Hover or focus to reveal extended telemetry."
    tabindex="0"
  >
    ${hudCoreSatellites()}
    <div class="hud-core-signal">
      <span class="pulse-dot${running > 0 ? "" : " idle"}"></span>
      <span>coordination core</span>
      <strong>${escapeHtml(phase)}</strong>
    </div>
    <div class="hud-core-score">
      <strong>${acceptance}<sup>%</sup></strong>
      <span>canonical acceptance</span>
    </div>
    <div class="hud-core-readouts">
      ${readout("Agents live", running)}
      ${readout("In motion", activeTasks.length, ' data-open-view="runs"')}
      ${readout("Queued", pendingTasks.length, ' data-open-view="board"')}
      ${readout(
        "Review gates",
        pendingApprovals.length,
        ' data-open-view="approvals"',
      )}
    </div>
    <div class="hud-core-focus">
      <span>Current coordination focus</span>
      <strong>${escapeHtml(focus)}</strong>
      <small>${escapeHtml(focusMeta)}</small>
    </div>
    <div class="hud-core-foot">
      <span>${completedRuns}/${state.runs.length} executions complete</span>
      <span>${
        replans === undefined ? "replans unavailable" : `${replans} replans`
      }</span>
    </div>
  </section>`;
}

function renderOverview() {
  if (!state.projectId) {
    return `<div class="view">${noProjectContent()}</div>`;
  }
  const pendingTasks = state.tasks.filter((task) => task.status === "submitted");
  const activeTasks = state.tasks.filter((task) => task.status === "claimed");
  const integratedTasks = state.tasks.filter(
    (task) => task.status === "integrated",
  );
  const pendingApprovals = state.approvals.filter(
    (approval) => approval.status === "pending",
  );
  const totalTasks = state.tasks.length;
  const completedRuns = state.runs.filter(
    (run) => run.status === "completed",
  ).length;
  // The control plane's own count of agents executing right now. Undefined
  // means it has not answered yet — which is not the same as zero, so the
  // dial says so rather than showing a confident nought.
  const agents = state.agentsRunning;
  const running = agents?.running ?? 0;

  const integratedShare =
    totalTasks > 0 ? Math.round((100 * integratedTasks.length) / totalTasks) : 0;
  const latestApproval = pendingApprovals[0];
  const latestEvent = state.audit.at(-1)?.event;

  return `<div class="view hud-home hud-home-v2">
    <div class="hud-interface-plate" aria-hidden="true"></div>
    ${hudCalendarStrip()}
    <header class="hud-v2-header">
      <div class="hud-v2-brand">
        <img src="/mark.svg" alt="" width="24" height="24">
        <span>Relay coordination network</span>
      </div>
      <div class="hud-v2-title">
        <span>Autonomous development control plane</span>
        <h1>Relay</h1>
        <p>${escapeHtml(state.project?.name ?? "")} / live operations</p>
      </div>
      <div class="hud-v2-link">
        <span class="pulse-dot${
          state.socket?.readyState === 1 ? "" : " idle"
        }" data-hud-socket-dot></span>
        <span data-hud-socket-label="top">${
          state.socket?.readyState === 1
            ? "link established"
            : "link connecting"
        }</span>
        <strong>${escapeHtml(shortId(state.projectId, 16))}</strong>
      </div>
    </header>

    <div class="hud-v2-grid">
      <aside class="hud-v2-rail hud-v2-rail-left" aria-label="Project telemetry">
        <section class="hud-v2-module hud-v2-time">
          ${hudClock()}
          ${hudBars()}
        </section>
        <section class="hud-v2-module hud-v2-acceptance">
          ${gauge("Accepted work", `${integratedShare}%`, "Promoted to canonical", {
            part: integratedTasks.length,
            whole: totalTasks,
            tone: "good",
          })}
          <div class="hud-energy-meta">
            <span>${state.repositories.length} repositories</span>
            <span>${state.members.length} member${
              state.members.length === 1 ? "" : "s"
            }</span>
            <span>${state.runs.length} execution${
              state.runs.length === 1 ? "" : "s"
            } recorded</span>
          </div>
        </section>
        <section class="hud-v2-module">${hudSubsystems()}</section>
        <section class="hud-v2-module">${hudShortcuts()}</section>
        <section class="hud-v2-module hud-v2-connection">
          ${hudLinkCircle()}
          ${hudTerminalBox()}
        </section>
      </aside>

      <main class="hud-v2-center">
        <div class="hud-reactor-rotors" aria-hidden="true">
          <img
            class="hud-reactor-rotor hud-reactor-rotor-outer"
            src="/hud-reactor-rotor.png"
            alt=""
          >
          <img
            class="hud-reactor-rotor hud-reactor-rotor-inner"
            src="/hud-reactor-rotor.png"
            alt=""
          >
        </div>
        ${hudCoreTelemetry({
          running,
          pendingTasks,
          activeTasks,
          integratedTasks,
          pendingApprovals,
        })}
        <div class="hud-v2-graphs">
          ${hudGraph(
            "Coordination signals",
            state.audit.map((record) => record.event?.occurredAt),
          )}
          ${hudGraph(
            "Executions started",
            state.runs.map((run) => run.startedAt),
          )}
        </div>
        <div class="hud-v2-coordinates">
          <span>ORG ${escapeHtml(shortId(state.organizationId, 18))}</span>
          <span>PRJ ${escapeHtml(shortId(state.projectId, 18))}</span>
          <span>${state.repositories.length} canonical source${
            state.repositories.length === 1 ? "" : "s"
          }</span>
        </div>
      </main>

      <aside class="hud-v2-rail hud-v2-rail-right" aria-label="System telemetry">
        <section class="hud-v2-module hud-v2-agent-module">
          ${gauge(
            "Agents running",
            agents === undefined ? "—" : running,
            agents === undefined
              ? "Awaiting the control plane"
              : agents.workers > 0
                ? `${agents.busyWorkers}/${agents.workers} worker${
                    agents.workers === 1 ? "" : "s"
                  } busy`
                : "No workers registered",
            {
              // Share of the fleet actually holding a lease, so an idle
              // fleet draws an empty arc instead of a full one.
              part: agents?.busyWorkers ?? 0,
              whole: agents?.workers ?? 0,
              tone: running > 0 ? "live" : "",
            },
          )}
          ${hudProjectPlate()}
        </section>
        <section class="hud-v2-module">${hudSystemBars()}</section>
        <section class="hud-v2-module">${hudCoordination()}</section>
        <section class="hud-v2-module hud-v2-gate">
          <span class="hud-system-title">Human gate</span>
          <div class="hud-gate-count">
            <strong>${pendingApprovals.length}</strong>
            <span>awaiting review</span>
          </div>
          ${
            latestApproval
              ? `<button data-open-approval="${escapeHtml(
                  latestApproval.id,
                )}" class="hud-gate-action">
                  <span>${escapeHtml(
                    latestApproval.kind ?? "approval",
                  )}</span>
                  <strong>${escapeHtml(shortId(latestApproval.id, 20))}</strong>
                </button>`
              : `<span class="hud-module-empty">No review gate is blocking work</span>`
          }
        </section>
        <section class="hud-v2-module hud-v2-feed">${hudFeed()}</section>
        <section class="hud-v2-module hud-v2-workers${
          state.workers.length === 0 ? " is-empty" : ""
        }">${hudWorkers()}</section>
      </aside>
    </div>

    <aside class="hud-v2-event-tape" aria-label="Latest coordination event">
      <span>Latest network signal</span>
      <strong>${
        latestEvent
          ? escapeHtml(eventTitle(latestEvent))
          : "No coordination events recorded"
      }</strong>
      <span>${
        latestEvent
          ? escapeHtml(formatDate(latestEvent.occurredAt, { short: true }))
          : "waiting"
      }</span>
    </aside>
    ${hudDock()}
  </div>`;
}

/* Tasks (GitHub Issues-flavored) ------------------------------------------ */

function taskStatusIcon(status) {
  if (["submitted", "claimed"].includes(status)) {
    return `<span class="issue-icon ${status === "claimed" ? "progress" : "open"}">${icon(
      "issueOpen",
    )}</span>`;
  }
  if (status === "integrated") {
    return `<span class="issue-icon closed">${icon("issueClosed")}</span>`;
  }
  if (status === "failed") {
    return `<span class="issue-icon failed">${icon("issueFailed")}</span>`;
  }
  return `<span class="issue-icon neutral">${icon("issueClosed")}</span>`;
}

function taskActions(task) {
  if (!canRun()) {
    return "";
  }
  const actions = [];
  if (["submitted", "claimed"].includes(task.status)) {
    actions.push(
      `<button class="mini-button" data-task-action="cancel" data-task-id="${escapeHtml(
        task.id,
      )}">Cancel</button>`,
    );
  }
  if (["failed", "claimed"].includes(task.status)) {
    actions.push(
      `<button class="mini-button" data-task-action="retry" data-task-id="${escapeHtml(
        task.id,
      )}">Retry</button>`,
    );
  }
  return actions.join("");
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

/* Board ------------------------------------------------------------------- */

/**
 * Columns of the board.
 *
 * A projection of `SubmittedTaskStatus`, not a workflow of its own: the
 * coordinator moves tasks between these states and the board only groups what
 * it finds. Adding a column here without a matching status would invent a
 * stage the platform does not have.
 */
const BOARD_COLUMNS = [
  ["submitted", "Queued", "Waiting for a runner or a worker"],
  ["claimed", "In flight", "Held by an execution or a remote lease"],
  ["integrated", "Landed", "Promoted into canonical"],
  ["failed", "Failed", "Ended without landing"],
  ["cancelled", "Cancelled", "Withdrawn before landing"],
];

function renderBoard() {
  const columns = BOARD_COLUMNS.map(([status, title, description]) => {
    const tasks = state.tasks.filter((task) => task.status === status);
    return `
      <section class="board-column">
        <header class="board-head">
          <div>
            <h2>${escapeHtml(title)}</h2>
            <p class="muted">${escapeHtml(description)}</p>
          </div>
          <span class="chip">${tasks.length}</span>
        </header>
        <div class="board-cards">
          ${
            tasks.length === 0
              ? '<p class="muted board-empty">Nothing here.</p>'
              : tasks
                  .map(
                    (task) => `
              <article class="board-card" data-task-id="${escapeHtml(task.id)}">
                <p class="board-objective">${escapeHtml(task.objective)}</p>
                <div class="board-meta">
                  <span class="chip">${escapeHtml(task.agentId)}</span>
                  <span class="muted">${escapeHtml(
                    formatDate(task.submittedAt, { short: true }),
                  )}</span>
                </div>
                <div class="row-actions">
                  ${
                    task.runId
                      ? `<button class="mini-button" data-open-run="${escapeHtml(
                          task.runId,
                        )}">Open execution</button>`
                      : ""
                  }
                  ${taskActions(task)}
                </div>
              </article>`,
                  )
                  .join("")
          }
        </div>
      </section>`;
  }).join("");

  return `<div class="view wide">
    <header class="view-head">
      <p class="eyebrow">Queue projection</p>
      <h1>Board</h1>
      <p>The same task queue, arranged by where each task has got to.</p>
    </header>
    <div class="board-grid">${columns}</div>
    <p class="muted panel-note">
      This is a view of the task queue, not a separate tracker. A card moves
      when the coordinator moves the task.
    </p>
    <section class="panel panel-spaced">
      <header class="panel-head">
        <div><h2>Work in view</h2><p>Latest task outcomes, newest first</p></div>
      </header>
      <div class="table-wrap">
        ${taskTable(state.tasks.slice(-8).reverse(), false)}
      </div>
    </section>
  </div>`;
}

/* Executions (GitHub Actions-flavored list) ------------------------------- */

function runStatusIcon(status) {
  if (status === "completed") {
    return `<span class="issue-icon closed">${icon("issueClosed")}</span>`;
  }
  if (status === "failed") {
    return `<span class="issue-icon failed">${icon("issueFailed")}</span>`;
  }
  return `<span class="issue-icon progress">${icon("issueOpen")}</span>`;
}

function renderRuns() {
  return `<div class="view">
    <header class="view-head">
      <p class="eyebrow">Coordination history</p>
      <h1>Executions</h1>
      <p>Each execution is one coordinated attempt from a base revision through planning, agent work, validation, and promotion. Git commits remain in Repository History.</p>
    </header>
    ${
      state.runs.length === 0
        ? '<div class="empty-state"><div><h2>No agent executions</h2><p>Prompt an agent in the chat to start coordinated work. Every plan, conflict, lease, replan, validation, and promotion will be retained here.</p><button class="button button-primary" data-action="chat-focus">Prompt an agent</button></div></div>'
        : `<section class="issue-list">
            <header class="issue-list-head">
              <span class="muted">${state.runs.length} execution${
                state.runs.length === 1 ? "" : "s"
              } · newest first</span>
            </header>
            ${state.runs
              .map(
                (run) => `
                <div class="issue-row">
                  ${runStatusIcon(run.status)}
                  <div class="issue-main">
                    <button class="issue-title" data-open-run="${escapeHtml(run.id)}">
                      ${escapeHtml(run.repositoryId)}
                      <span class="muted">·</span>
                      ${escapeHtml(shortId(run.baseRevision, 10))} → ${escapeHtml(
                        shortId(run.finalRevision ?? "pending", 10),
                      )}
                    </button>
                    <div class="issue-meta">
                      <span>${escapeHtml(shortId(run.id, 20))}</span>
                      <span>started ${escapeHtml(formatDate(run.startedAt))}</span>
                      <span class="chip">${escapeHtml(run.mode)}</span>
                    </div>
                  </div>
                  <div class="issue-side">
                    ${statusBadge(run.status)}
                  </div>
                </div>`,
              )
              .join("")}
          </section>`
    }
    <section class="panel panel-spaced">
      <header class="panel-head">
        <div><h2>Live ledger</h2><p>Append-only coordination events</p></div>
      </header>
      <div class="panel-body">${timeline(state.audit, 12)}</div>
    </section>
  </div>`;
}

/* Approvals ---------------------------------------------------------------- */

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
            <button class="mini-button" data-open-approval="${escapeHtml(
              approval.id,
            )}">${actionable ? "Review" : "Inspect"}</button>
          </div>
        </article>`,
    )
    .join("")}</div>`;
}

function renderApprovals() {
  const pending = state.approvals.filter(
    (approval) => approval.status === "pending",
  );
  const history = state.approvals.filter(
    (approval) => approval.status !== "pending",
  );
  return `<div class="view">
    <header class="view-head">
      <p class="eyebrow">Human gates</p>
      <h1>Approvals</h1>
      <p>Review protected plans, scope expansions, and proposed changesets.</p>
    </header>
    ${
      pending.length > 0
        ? `<div class="signal-banner warn"><span class="health-orb warn"></span><div><strong>${pending.length} decision${
            pending.length === 1 ? "" : "s"
          } blocking work</strong><span>Review reasons and diff evidence before canonical can advance.</span></div><span class="chip warn">action needed</span></div>`
        : ""
    }
    <section class="panel">
      <header class="panel-head"><div><h2>Pending review</h2><p>Durable gates survive worker and browser restarts</p></div></header>
      <div class="panel-body">${approvalCards(pending, true)}</div>
    </section>
    <section class="panel panel-spaced">
      <header class="panel-head"><div><h2>Decision history</h2><p>Approved, rejected, expired, and cancelled gates</p></div></header>
      <div class="panel-body">${approvalCards(history, false)}</div>
    </section>
  </div>`;
}

/* Repositories ------------------------------------------------------------- */

function renderRepositories() {
  const repositoryActions = canRun()
    ? `<div class="repository-action-grid">
        <form class="form-card" data-form="repository-create">
          <p class="eyebrow">Greenfield source</p>
          <h2>Create repository</h2>
          <p>Start with a new canonical Git repository and an empty initial commit. It is immediately available to agent workspaces.</p>
          <label>
            <span>Repository ID</span>
            <input
              name="id"
              placeholder="new-product"
              pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
              maxlength="80"
              autocomplete="off"
              required
            >
          </label>
          <label>
            <span>Initial branch</span>
            <input name="branch" value="main" maxlength="240" required>
          </label>
          <button class="button button-primary" type="submit">Create repository</button>
        </form>
        <form class="form-card" data-form="github-import">
          <p class="eyebrow">Existing source</p>
          <h2>Import from GitHub</h2>
          <p>Relay creates an internal bare mirror. Private tokens are passed only to Git and are never persisted.</p>
          <label>
            <span>Repository</span>
            <input name="repository" placeholder="owner/repository" required>
          </label>
          <div class="field-pair">
            <label><span>Local ID (optional)</span><input name="id" placeholder="core-api"></label>
            <label><span>Branch (auto-detect)</span><input name="branch" placeholder="main"></label>
          </div>
          <label>
            <span>Fine-grained token (private repositories only)</span>
            <input name="token" type="password" autocomplete="off" placeholder="github_pat_...">
          </label>
          <button class="button button-primary" type="submit">Import repository</button>
        </form>
      </div>`
    : '<div class="signal-banner"><span class="health-orb"></span><div><strong>Repository access is read-only</strong><span>A developer, admin, or owner can create and import canonical repositories.</span></div></div>';

  return `<div class="view">
    <header class="view-head">
      <p class="eyebrow">Canonical sources</p>
      <h1>Repositories</h1>
      <p>Create a fresh canonical source or import an existing GitHub repository.</p>
    </header>
    ${repositoryActions}
    <section class="panel panel-spaced">
      <header class="panel-head"><div><h2>Linked repositories</h2><p>${state.repositories.length} canonical mirror${
        state.repositories.length === 1 ? "" : "s"
      }</p></div></header>
      <div class="panel-body">
        ${
          state.repositories.length === 0
            ? '<div class="empty-state"><div><h2>No repository linked</h2><p>Create a new repository here or import a public or private GitHub repository.</p></div></div>'
            : `<div class="card-grid">${state.repositories
                .map(
                  (repository) => `
                    <article class="repo-card">
                      <h3>${escapeHtml(repository.id)}</h3>
                      <p>${escapeHtml(repository.remoteUrl ?? "Relay-created repository")}</p>
                      <div class="card-meta">
                        <span class="chip">${escapeHtml(repository.provider ?? "local")}</span>
                        <span class="chip">${escapeHtml(repository.branch)}</span>
                        ${
                          canRun()
                            ? `<button class="mini-button" data-run-repo="${escapeHtml(
                                repository.id,
                              )}">Execute queue</button>`
                            : ""
                        }
                        <button class="mini-button" data-open-history="${escapeHtml(
                          repository.id,
                        )}">History</button>
                      </div>
                    </article>`,
                )
                .join("")}</div>`
        }
      </div>
    </section>
  </div>`;
}

/* Coordination -------------------------------------------------------------- */

function workerTable(workers) {
  if (workers.length === 0) {
    return '<div class="empty-state"><div><h2>No workers registered</h2><p>A worker registers itself with a scoped API token. Until one does, tasks run on the control plane.</p></div></div>';
  }
  return `
    <table class="data-table">
      <thead><tr><th>Worker</th><th>Adapters</th><th>Version</th><th>Last seen</th></tr></thead>
      <tbody>
        ${workers
          .map(
            (worker) => `
          <tr>
            <td><strong>${escapeHtml(worker.name || shortId(worker.id))}</strong>
              <div class="muted">${escapeHtml(shortId(worker.id, 16))}</div></td>
            <td>${(worker.adapters ?? [])
              .map((adapter) => `<span class="chip">${escapeHtml(adapter)}</span>`)
              .join(" ")}</td>
            <td>${escapeHtml(worker.version ?? "—")}</td>
            <td>${escapeHtml(formatDate(worker.lastSeenAt))}</td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

/**
 * Prediction quality, rework, and spend, straight from the audit chain.
 *
 * The numbers are deliberately shown with their denominators. A conflict
 * prediction count means nothing on its own; what matters is how many were
 * confirmed by contention that actually happened and how many were false
 * alarms, because that ratio is the argument for the whole scheduler.
 */
function renderCoordination() {
  const metrics = state.metrics;
  const head = `
    <header class="view-head">
      <p class="eyebrow">Measured outcomes</p>
      <h1>Coordination</h1>
      <p>How well scheduling predicted contention, what it cost, and who is executing.</p>
    </header>`;
  if (!metrics) {
    return `<div class="view">${head}
      <div class="empty-state">
        <div>
          <h2>Coordination metrics are unavailable</h2>
          <p>This deployment does not expose the metrics endpoint, or your role cannot view it.</p>
        </div>
      </div>
    </div>`;
  }

  const { conflicts, rework, throughput, approvals, cost, window } = metrics;
  const decided = conflicts.confirmedPredictions + conflicts.falsePositives;

  return `<div class="view">${head}
    <section class="metric-grid">
      ${metric(
        "Conflicts predicted",
        conflicts.predictions,
        `${conflicts.openPredictions} still open`,
        "◈",
      )}
      ${metric(
        "Predictions confirmed",
        conflicts.confirmedPredictions,
        `${percent(conflicts.confirmedPredictions, decided)} of decided predictions`,
        "✓",
      )}
      ${metric(
        "False alarms",
        conflicts.falsePositives,
        "Predicted pairs that both landed cleanly",
        "○",
      )}
      ${metric(
        "Missed conflicts",
        conflicts.unpredictedContention,
        "Contention no prediction covered",
        "!",
      )}
    </section>
    <div class="content-grid">
      <section class="panel">
        <header class="panel-head">
          <div><h2>Rework</h2><p>Work repeated, and work avoided before it ran</p></div>
        </header>
        <div class="table-wrap">
          <table class="data-table">
            <tbody>
              <tr><td>Replans requested</td><td><strong>${rework.replansRequested}</strong></td>
                <td class="muted">Canonical moved under a task</td></tr>
              <tr><td>Integration failures</td><td><strong>${rework.integrationFailures}</strong></td>
                <td class="muted">Validation or conflict at promotion</td></tr>
              <tr><td>Task restarts</td><td><strong>${rework.taskRestarts}</strong></td>
                <td class="muted">Executions that had to be repeated</td></tr>
              <tr><td>Deferred at plan time</td><td><strong>${rework.planTimeDeferrals ?? 0}</strong></td>
                <td class="muted">Refused before any editing — rework avoided</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="panel">
        <header class="panel-head">
          <div><h2>Throughput</h2><p>Queue to canonical</p></div>
        </header>
        <div class="table-wrap">
          <table class="data-table">
            <tbody>
              <tr><td>Submitted</td><td><strong>${throughput.tasksSubmitted}</strong></td><td></td></tr>
              <tr><td>Integrated</td><td><strong>${throughput.tasksIntegrated}</strong></td>
                <td class="muted">${percent(throughput.tasksIntegrated, throughput.tasksSubmitted)} of submitted</td></tr>
              <tr><td>Failed</td><td><strong>${throughput.tasksFailed}</strong></td><td></td></tr>
              <tr><td>Mean time to integration</td>
                <td><strong>${duration(throughput.averageTimeToIntegrationMs)}</strong></td><td></td></tr>
              <tr><td>Approvals decided</td>
                <td><strong>${approvals.decided} / ${approvals.requested}</strong></td>
                <td class="muted">Mean wait ${duration(approvals.averageDecisionMs)}</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
    <section class="panel panel-spaced">
      <header class="panel-head">
        <div><h2>Remote execution</h2><p>Lease runtime is the platform's one directly measured spend signal</p></div>
        <span class="chip">${window.events} events to sequence ${window.toSequence}</span>
      </header>
      <div class="panel-body">
        <section class="metric-grid">
          ${metric("Lease runtime", duration(cost.leaseRuntimeMs), "Total across all leases", "◷")}
          ${metric("Active leases", cost.activeLeases, "Executing right now", "◎")}
          ${metric("Settled leases", cost.settledLeases, "Completed, failed, or released", "⌁")}
          ${metric("Registered workers", state.workers.length, "Visible to your account", "⌗")}
        </section>
        <div class="table-wrap">${workerTable(state.workers)}</div>
        <p class="muted panel-note">
          Runtime is wall-clock lease time, not model cost. Token accounting is not
          available from the agent adapters today.
        </p>
      </div>
    </section>
  </div>`;
}

/* Team ---------------------------------------------------------------------- */

function renderTeam() {
  const manageable = canManageMembers();
  const roles = ["owner", "admin", "developer", "reviewer", "viewer"];
  return `<div class="view">
    <header class="view-head">
      <p class="eyebrow">Access control</p>
      <h1>Team</h1>
      <p>Manage organization membership and role-based permissions.</p>
    </header>
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
    </div>
  </div>`;
}

/* Settings ------------------------------------------------------------------ */

const RISK_LEVELS = ["low", "medium", "high", "critical"];

/**
 * Turns the policy form's raw values into a PATCH body.
 *
 * Self-contained and free of DOM access so a test can exercise it directly.
 * The rules it encodes are easy to get subtly wrong: an empty field means
 * "use the built-in default" rather than zero, a risk selection identical to
 * the default is not worth storing (it would pin the project against a future
 * change to that default), and a form with nothing set at all clears the
 * policy rather than storing an empty one.
 */
function policyPayload(input) {
  const defaultRiskLevels = ["high", "critical"];
  const approvalsEnabled = input.approvalsEnabled !== false;
  const requireSchemaReview = input.requireSchemaReview !== false;
  const minutes = (raw, label) => {
    const text = String(raw ?? "").trim();
    if (text === "") {
      return undefined;
    }
    const parsed = Number.parseInt(text, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error(`${label} must be a whole number of minutes above zero`);
    }
    return parsed * 60000;
  };

  const riskLevels = [...new Set(input.riskLevels ?? [])];
  const protectedPaths = String(input.protectedPaths ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const approvalTimeoutMs = minutes(
    input.approvalTimeoutMinutes,
    "Approval timeout",
  );
  const maxTaskRuntimeMs = minutes(
    input.maxTaskRuntimeMinutes,
    "Max runtime per task",
  );
  const maxProjectRuntimeMsPerDay = minutes(
    input.maxProjectRuntimeMinutesPerDay,
    "Max runtime per day",
  );

  const sameAsDefault =
    riskLevels.length === defaultRiskLevels.length &&
    defaultRiskLevels.every((level) => riskLevels.includes(level));
  const approvals = approvalsEnabled
    ? {
        ...(!requireSchemaReview ? { requireSchemaReview: false } : {}),
        ...(input.requireChangesetReview
          ? { requireChangesetReview: true }
          : {}),
        ...(riskLevels.length > 0 && !sameAsDefault ? { riskLevels } : {}),
        ...(protectedPaths.length > 0 ? { protectedPaths } : {}),
        ...(approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs }),
      }
    : { enabled: false };
  const budgets = {
    ...(maxTaskRuntimeMs === undefined ? {} : { maxTaskRuntimeMs }),
    ...(maxProjectRuntimeMsPerDay === undefined
      ? {}
      : { maxProjectRuntimeMsPerDay }),
  };
  const policy = {
    version: 1,
    ...(Object.keys(approvals).length > 0 ? { approvals } : {}),
    ...(Object.keys(budgets).length > 0 ? { budgets } : {}),
  };
  return Object.keys(policy).length === 1 ? { policy: null } : { policy };
}

/** Milliseconds are the stored unit; minutes are the one people reason in. */
function minutesValue(milliseconds) {
  return typeof milliseconds === "number" && Number.isFinite(milliseconds)
    ? String(Math.round(milliseconds / 60000))
    : "";
}

/**
 * The declarative project policy, as a form.
 *
 * Every field is optional in the stored policy, and an absent field means "use
 * the built-in default" — so the form has to distinguish empty from zero, and
 * clearing everything must send `null` rather than an empty policy object.
 */
function policyForm(manageable) {
  const policy = state.project?.policy ?? {};
  const approvals = policy.approvals ?? {};
  const budgets = policy.budgets ?? {};
  const reviewed = approvals.riskLevels ?? ["high", "critical"];
  const disabled = manageable ? "" : "disabled";
  return `
    <form class="form-card" data-form="project-policy">
      <p class="eyebrow">Coordination policy</p>
      <h2>Approvals and budgets</h2>
      <p class="muted">
        Empty fields fall back to the built-in defaults. Saving with everything
        empty clears the policy entirely.
      </p>
      <label><span><input name="approvalsEnabled" type="checkbox" ${
        approvals.enabled === false ? "" : "checked"
      } ${disabled}> Pause work when human approval is required</span>
        <small class="muted">Turn this off for unattended execution. Isolation, ownership, validation, audit, and atomic promotion remain enforced.</small>
      </label>
      <label><span><input name="requireChangesetReview" type="checkbox" ${
        approvals.requireChangesetReview ? "checked" : ""
      } ${disabled}> Require human review of every changeset</span></label>
      <label><span><input name="requireSchemaReview" type="checkbox" ${
        approvals.requireSchemaReview === false ? "" : "checked"
      } ${disabled}> Require human review for declared schema changes</span>
        <small class="muted">Turn this off when protected migration paths already define the database boundary.</small>
      </label>
      <fieldset class="field-group">
        <legend>Risk levels requiring review</legend>
        ${RISK_LEVELS.map(
          (level) => `
          <label class="inline"><span><input name="riskLevel" type="checkbox" value="${level}" ${
            reviewed.includes(level) ? "checked" : ""
          } ${disabled}> ${level}</span></label>`,
        ).join("")}
      </fieldset>
      <label>
        <span>Protected paths (one glob per line)</span>
        <textarea name="protectedPaths" rows="3" placeholder="secrets/**" ${disabled}>${escapeHtml(
          (approvals.protectedPaths ?? []).join("\n"),
        )}</textarea>
      </label>
      <label>
        <span>Approval timeout (minutes)</span>
        <input name="approvalTimeoutMinutes" type="number" min="1" placeholder="default" value="${escapeHtml(
          minutesValue(approvals.approvalTimeoutMs),
        )}" ${disabled}>
      </label>
      <label>
        <span>Max runtime per task (minutes)</span>
        <input name="maxTaskRuntimeMinutes" type="number" min="1" placeholder="unlimited" value="${escapeHtml(
          minutesValue(budgets.maxTaskRuntimeMs),
        )}" ${disabled}>
        <small class="muted">A lease past this age is failed at heartbeat, not extended.</small>
      </label>
      <label>
        <span>Max runtime per day, whole project (minutes)</span>
        <input name="maxProjectRuntimeMinutesPerDay" type="number" min="1" placeholder="unlimited" value="${escapeHtml(
          minutesValue(budgets.maxProjectRuntimeMsPerDay),
        )}" ${disabled}>
        <small class="muted">An exhausted project stops receiving workers. Tasks stay queued, never failed.</small>
      </label>
      ${
        manageable
          ? '<button class="button button-primary" type="submit">Save policy</button>'
          : '<p class="muted">Your role cannot change project policy.</p>'
      }
    </form>`;
}

function renderSettings() {
  const organization = currentOrganization();
  const manageable = canManageProject();
  if (!state.projectId) {
    return `<div class="view">
      <header class="view-head">
        <p class="eyebrow">Project controls</p>
        <h1>Settings</h1>
      </header>
      ${noProjectContent()}
      <div class="stack" style="margin-top:16px; max-width:420px">
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
  return `<div class="view">
    <header class="view-head">
      <p class="eyebrow">Project controls</p>
      <h1>Settings</h1>
      <p>Policy, budgets, project identity, and lifecycle state.</p>
    </header>
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
        ${policyForm(manageable)}
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
    </div>
  </div>`;
}

/* Admin --------------------------------------------------------------------- */

function renderAdmin() {
  if (!state.admin) {
    return '<div class="view"><div class="empty-state"><div><h2>System administrator required</h2></div></div></div>';
  }
  const counts = state.admin.counts;
  return `<div class="view">
    <header class="view-head">
      <p class="eyebrow">Host operations</p>
      <h1>System admin</h1>
      <p>Manage users and inspect the local control plane across organizations.</p>
    </header>
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
    </div>
  </div>`;
}

/* ------------------------------------------- tab content: detail tabs ---- */

/**
 * Render a unified diff with a line-number gutter.
 *
 * Old and new line numbers are tracked separately from the `@@` hunk headers,
 * the way a code host does it: a removed line numbers only on the left, an
 * added line only on the right, context on both. Without the gutter there was
 * no way to cite a line, which is the first thing review needs.
 *
 * Git's own header lines (`diff --git`, `index`, `---`, `+++`) carry no line
 * number and are marked so they can wrap instead of being clipped — the
 * `index` blob pair is wider than the container in the narrower of the two
 * places this component renders.
 */
function diffHtml(patch) {
  if (!patch) {
    return '<div class="detail-item">No textual diff was recorded.</div>';
  }
  let oldLine = 0;
  let newLine = 0;
  const gutter = (value) =>
    `<span class="diff-num">${value === null ? "" : value}</span>`;
  const rows = String(patch)
    .split("\n")
    .map((line) => {
      const isHeader =
        line.startsWith("diff ") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("new file") ||
        line.startsWith("deleted file") ||
        line.startsWith("similarity index") ||
        line.startsWith("rename ");
      if (isHeader) {
        return `<span class="diff-line diff-meta diff-header">${gutter(null)}${gutter(
          null,
        )}<span class="diff-text">${escapeHtml(line)}</span></span>`;
      }
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        return `<span class="diff-line diff-hunk">${gutter(null)}${gutter(
          null,
        )}<span class="diff-text">${escapeHtml(line)}</span></span>`;
      }
      if (line.startsWith("+")) {
        const at = newLine++;
        return `<span class="diff-line diff-add">${gutter(null)}${gutter(
          at,
        )}<span class="diff-text">${escapeHtml(line)}</span></span>`;
      }
      if (line.startsWith("-")) {
        const at = oldLine++;
        return `<span class="diff-line diff-remove">${gutter(at)}${gutter(
          null,
        )}<span class="diff-text">${escapeHtml(line)}</span></span>`;
      }
      if (line.startsWith("\\")) {
        // "\ No newline at end of file" belongs to the previous line.
        return `<span class="diff-line diff-meta">${gutter(null)}${gutter(
          null,
        )}<span class="diff-text">${escapeHtml(line)}</span></span>`;
      }
      const oldAt = oldLine++;
      const newAt = newLine++;
      return `<span class="diff-line">${gutter(oldAt)}${gutter(
        newAt,
      )}<span class="diff-text">${escapeHtml(line || " ")}</span></span>`;
    })
    .join("");
  return `<pre class="diff has-gutter">${rows}</pre>`;
}

/**
 * A review thread, anchored to one file or to the changeset as a whole.
 *
 * Rendered inline under the diff it is about rather than in a separate tab:
 * a remark about a hunk is only useful next to the hunk.
 */
function commentThread(comments, changeSetId, filePath, runId, options = {}) {
  const { allowCompose = true } = options;
  const entries = comments
    .map(
      (comment) => `
      <article class="comment${comment.resolvedAt ? " resolved" : ""}">
        <p class="comment-author">${escapeHtml(
          comment.author ?? comment.authorId ?? "Reviewer",
        )}</p>
        <p class="comment-body">${escapeHtml(comment.body)}</p>
        <div class="comment-meta">
          <span class="muted">${escapeHtml(formatDate(comment.createdAt))}</span>
          ${
            comment.resolvedAt
              ? '<span class="chip">resolved</span>'
              : canReview()
                ? `<button class="mini-button" data-action="resolve-comment" data-comment-id="${escapeHtml(
                    comment.id,
                  )}" data-run-id="${escapeHtml(runId)}">Resolve</button>`
                : ""
          }
        </div>
      </article>`,
    )
    .join("");
  const form =
    canReview() && allowCompose
      ? `<form class="comment-form" data-form="comment-add"
         data-run-id="${escapeHtml(runId)}"
         data-changeset-id="${escapeHtml(changeSetId)}"
         ${filePath === undefined ? "" : `data-file-path="${escapeHtml(filePath)}"`}>
        <p class="comment-form-label">${
          filePath === undefined
            ? "Comment on this changeset"
            : `Comment on <code>${escapeHtml(filePath)}</code>`
        }</p>
        <textarea name="body" rows="2" placeholder="Leave a review comment" required></textarea>
        <button class="mini-button" type="submit">Comment</button>
      </form>`
      : "";
  if (entries.length === 0 && form.length === 0) {
    return "";
  }
  const count = comments.length;
  const heading =
    count === 0
      ? ""
      : `<p class="comment-thread-head">${count} comment${count === 1 ? "" : "s"}${
          filePath === undefined ? " on this changeset" : ""
        }</p>`;
  return `<div class="comment-thread">${heading}${entries}${form}</div>`;
}

async function renderRunTab(container, tab) {
  container.innerHTML =
    '<div class="view"><div class="skeleton skeleton-tall"></div></div>';
  try {
    const response = await api(`/runs/${encodeURIComponent(tab.data.runId)}`);
    if (activeTab() !== tab) {
      return;
    }
    container.innerHTML = `<div class="view wide">${renderRunDetail(
      response.run,
    )}</div>`;
  } catch (error) {
    container.innerHTML = `<div class="view"><div class="empty-state"><div><h2>Execution unavailable</h2><p>${escapeHtml(
      error.message,
    )}</p></div></div></div>`;
  }
}

function renderRunDetail(detail) {
  const run = detail.run;
  const runId = run.id;
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
        ${
          // IntegrationResult carries `validation`, one CommandResult per
          // configured command.
          (integration.validation ?? [])
            .map(
              (result) =>
                `${escapeHtml(result.command.label)}: ${
                  result.exitCode === 0 ? "passed" : `exit ${result.exitCode}`
                }`,
            )
            .join("<br>") || "No validation commands configured"
        }
      </div>`,
    )
    .join("");
  const comments = detail.comments ?? [];
  const patchEntries = detail.changeSets.flatMap((changeSet) =>
    changeSet.patches.map((patch) => ({ changeSet, patch })),
  );
  const fileTree = patchEntries
    .map(
      ({ patch }, index) => `
      <a class="side-item" href="#diff-${index}" onclick="document.getElementById('diff-${index}')?.scrollIntoView({behavior:'smooth'});return false;">
        ${icon("file")}
        <span class="grow" title="${escapeHtml(patch.path)}">${escapeHtml(
          patch.path,
        )}</span>
        <span class="muted">${escapeHtml(patch.status)}</span>
      </a>`,
    )
    .join("");
  const diffs = patchEntries
    .map(
      ({ changeSet, patch }, index) => `
      <div class="diff-file" id="diff-${index}">
        <div class="diff-file-head">
          ${icon("file")}
          <span class="path">${escapeHtml(patch.path)}</span>
          ${statusBadge(patch.status)}
        </div>
        ${diffHtml(patch.patch)}
        ${commentThread(
          comments.filter((comment) => comment.filePath === patch.path),
          changeSet.id,
          patch.path,
          runId,
        )}
      </div>`,
    )
    .join("");
  // One composer per screen. Every file already carries its own anchored
  // form; a second, identically styled "Comment on this changeset" box 40px
  // below it was indistinguishable and easy to post to by mistake. The
  // changeset-level composer is offered only when there is no file to anchor
  // to — otherwise that section shows existing changeset comments as a thread.
  const generalComments = detail.changeSets
    .map((changeSet) =>
      commentThread(
        comments.filter(
          (comment) =>
            comment.changeSetId === changeSet.id &&
            comment.filePath === undefined,
        ),
        changeSet.id,
        undefined,
        runId,
        { allowCompose: patchEntries.length === 0 },
      ),
    )
    .join("");
  return `
    <header class="pr-head">
      <p class="eyebrow">Agent execution</p>
      <h1>${escapeHtml(run.repositoryId)}
        <span class="muted">${escapeHtml(shortId(run.id, 16))}</span></h1>
      <p class="muted">
        ${statusBadge(run.status)}
        <span class="chip">${escapeHtml(run.mode)}</span>
        base <code>${escapeHtml(shortId(run.baseRevision, 12))}</code>
        → <code>${escapeHtml(shortId(run.finalRevision ?? "pending", 12))}</code>
        · started ${escapeHtml(formatDate(run.startedAt))}
      </p>
    </header>
    <div class="pr-columns">
      <nav class="pr-file-tree">
        <h3 class="side-section-title muted" style="margin:4px 6px">Files changed (${
          patchEntries.length
        })</h3>
        ${fileTree || '<p class="side-empty">No changeset diff recorded.</p>'}
      </nav>
      <div>
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
        <section class="detail-section"><h3>Files changed</h3>${
          diffs || '<div class="detail-item">No changeset diff recorded.</div>'
        }</section>
        ${
          generalComments.trim().length === 0
            ? ""
            : `<section class="detail-section"><h3>Review</h3>${generalComments}</section>`
        }
        <section class="detail-section"><h3>Execution audit</h3>${timeline(
          detail.audit.map((event, index) => ({
            sequence: index,
            runId: run.id,
            event,
          })),
          100,
        )}</section>
      </div>
    </div>`;
}

async function renderApprovalTab(container, tab) {
  container.innerHTML =
    '<div class="view"><div class="skeleton skeleton-tall"></div></div>';
  try {
    const response = await api(
      `/approvals/${encodeURIComponent(tab.data.approvalId)}`,
    );
    if (activeTab() !== tab) {
      return;
    }
    container.innerHTML = `<div class="view">${renderApprovalDetail(
      response.approval,
      response.changeSet,
    )}</div>`;
  } catch (error) {
    container.innerHTML = `<div class="view"><div class="empty-state"><div><h2>Approval unavailable</h2><p>${escapeHtml(
      error.message,
    )}</p></div></div></div>`;
  }
}

function renderApprovalDetail(approval, changeSet) {
  const reasons = approval.reasons
    .map((reason) => `<div class="detail-item">${escapeHtml(reason)}</div>`)
    .join("");
  const patches =
    changeSet?.patches
      ?.map(
        (patch) => `
        <div class="diff-file">
          <div class="diff-file-head">
            ${icon("file")}
            <span class="path">${escapeHtml(patch.path)}</span>
            ${statusBadge(patch.status)}
          </div>
          ${diffHtml(patch.patch)}
        </div>`,
      )
      .join("") ?? "";
  const decision =
    approval.status === "pending" && canReview()
      ? `<form class="decision-form" data-form="approval-decision" data-approval-id="${escapeHtml(
          approval.id,
        )}">
          <label><span>Reviewer comment</span><textarea name="comment" placeholder="Explain the decision for the audit record"></textarea></label>
          <div class="decision-actions">
            <button class="button button-danger" type="submit" name="status" value="rejected">Reject</button>
            <button class="button button-primary" type="submit" name="status" value="approved">Approve</button>
          </div>
        </form>`
      : `<div class="detail-item"><strong>${escapeHtml(
          approval.status,
        )}</strong>${escapeHtml(
          approval.decisionComment ?? "No reviewer comment",
        )}</div>`;
  return `
    <header class="pr-head">
      <p class="eyebrow">Human gate</p>
      <h1>${escapeHtml(approval.kind.replaceAll("_", " "))}</h1>
      <p class="muted">
        ${statusBadge(approval.status)}
        Task <code>${escapeHtml(shortId(approval.taskId, 18))}</code>
        · Execution <button class="text-button" data-open-run="${escapeHtml(
          approval.runId,
        )}">${escapeHtml(shortId(approval.runId, 16))}</button>
        · expires ${escapeHtml(formatDate(approval.expiresAt))}
      </p>
    </header>
    <div class="signal-banner${approval.status === "pending" ? " warn" : ""}">
      <span class="health-orb${approval.status === "pending" ? " warn" : ""}"></span>
      <div><strong>${
        approval.status === "pending"
          ? "This gate is blocking work"
          : "Decision recorded"
      }</strong><span>Durable across worker and browser restarts.</span></div>
    </div>
    <section class="detail-section"><h3>Why review is required</h3><div class="detail-list">${reasons}</div></section>
    ${
      changeSet
        ? `<section class="detail-section"><h3>Agent explanation</h3><div class="detail-item">${escapeHtml(
            changeSet.agentExplanation,
          )}</div></section>`
        : ""
    }
    ${
      patches
        ? `<section class="detail-section"><h3>Proposed changes</h3>${patches}</section>`
        : ""
    }
    <section class="detail-section"><h3>Decision</h3>${decision}</section>`;
}

/**
 * Canonical history for one repository, with rollback offered per revision.
 *
 * The rollback control sits here rather than on a settings page because the
 * decision is always "back to *this* revision", and the only way to make that
 * choice well is with the history in front of you.
 */
async function renderHistoryTab(container, tab) {
  container.innerHTML =
    '<div class="view"><div class="skeleton skeleton-tall"></div></div>';
  const repositoryId = tab.data.repositoryId;
  try {
    const response = await api(
      `/projects/${encodeURIComponent(state.projectId)}/repositories/` +
        `${encodeURIComponent(repositoryId)}/versions?limit=50`,
    );
    if (activeTab() !== tab) {
      return;
    }
    const versions = response.versions ?? [];
    const canRollback = canManageProject();
    container.innerHTML = `<div class="view">
      <header class="view-head">
        <p class="eyebrow">Canonical history</p>
        <h1>${escapeHtml(repositoryId)}</h1>
        <p>
          Newest first. A rollback does not rewrite this history — it submits
          the revert as an ordinary change, so the record keeps moving forward.
        </p>
      </header>
      ${
        versions.length === 0
          ? '<div class="empty-state"><div><h2>No history</h2></div></div>'
          : `<ol class="version-list">${versions
              .map(
                (version, index) => `
          <li class="version-entry">
            <div>
              <p class="version-subject">${escapeHtml(version.subject)}</p>
              <p class="muted">
                <code>${escapeHtml(shortId(version.revision, 12))}</code>
                · #${version.sequence}
                · ${escapeHtml(version.author)}
                <!-- Full date, not the short time-only form: this view is
                     chronology, and "3:06 PM" against "9:42 PM" gave no way
                     to tell today's commit from one three weeks old. -->
                · ${escapeHtml(formatDate(version.createdAt))}
              </p>
            </div>
            ${
              index === 0
                ? '<span class="chip">current</span>'
                : canRollback
                  ? `<button class="mini-button" data-action="rollback"
                       data-repo-id="${escapeHtml(repositoryId)}"
                       data-revision="${escapeHtml(version.revision)}">Roll back to here</button>`
                  : ""
            }
          </li>`,
              )
              .join("")}</ol>`
      }
    </div>`;
  } catch (error) {
    container.innerHTML = `<div class="view"><div class="empty-state"><div><h2>History unavailable</h2><p>${escapeHtml(
      error.message,
    )}</p></div></div></div>`;
  }
}

/**
 * The application's modal dialog.
 *
 * Replaces `window.prompt` for consequential actions. A browser prompt is
 * chrome from a different product, it cannot carry the app's tone or an
 * explanation, and it renders the most destructive action in the product —
 * rollback — as an unstyled OS box.
 *
 * Resolves to an object of the field values, or `null` if the user backed
 * out (Cancel, Esc, or the backdrop). Built on `<dialog>`, so focus trapping,
 * Esc handling, and page inertness come from the platform rather than from
 * bespoke key handlers.
 */
function showDialog({
  eyebrow,
  title,
  description,
  tone = "default",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  field,
}) {
  const dialog = $("#app-dialog");
  const form = $("#app-dialog-form");
  if (!dialog || !form || typeof dialog.showModal !== "function") {
    return Promise.resolve(null);
  }
  const inputId = "app-dialog-field";
  form.innerHTML = `
    ${eyebrow ? `<p class="eyebrow">${escapeHtml(eyebrow)}</p>` : ""}
    <h2>${escapeHtml(title)}</h2>
    ${description ? `<p class="muted">${escapeHtml(description)}</p>` : ""}
    ${
      field
        ? `<label for="${inputId}"><span>${escapeHtml(field.label)}</span>
             ${
               field.multiline
                 ? `<textarea id="${inputId}" name="${escapeHtml(field.name)}" rows="3"
                      placeholder="${escapeHtml(field.placeholder ?? "")}"
                      ${field.required ? "required" : ""}></textarea>`
                 : `<input id="${inputId}" name="${escapeHtml(field.name)}" type="text"
                      placeholder="${escapeHtml(field.placeholder ?? "")}"
                      ${field.required ? "required" : ""}>`
             }
           </label>`
        : ""
    }
    <div class="app-dialog-actions">
      <button type="button" class="button" value="cancel" data-dialog-cancel>${escapeHtml(cancelLabel)}</button>
      <button type="submit" class="button ${
        tone === "destructive" ? "button-danger" : "button-primary"
      }" value="confirm">${escapeHtml(confirmLabel)}</button>
    </div>`;
  dialog.classList.toggle("destructive", tone === "destructive");

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      form.removeEventListener("submit", onSubmit);
      dialog.removeEventListener("close", onClose);
      dialog.removeEventListener("click", onBackdrop);
      cancel?.removeEventListener("click", onCancel);
      if (dialog.open) {
        dialog.close();
      }
      resolve(value);
    };
    const onSubmit = (event) => {
      // `method="dialog"` closes on submit; read the values first.
      const data = new FormData(form);
      const values = {};
      for (const [key, value] of data.entries()) {
        values[key] = String(value).trim();
      }
      void event;
      finish(values);
    };
    // Esc, and any close that did not come through submit.
    const onClose = () => finish(null);
    const onCancel = () => finish(null);
    // A click on the dialog element itself is a click on its backdrop; the
    // form fills the dialog, so anything inside hits the form instead.
    const onBackdrop = (event) => {
      if (event.target === dialog) {
        finish(null);
      }
    };
    const cancel = form.querySelector("[data-dialog-cancel]");
    form.addEventListener("submit", onSubmit);
    dialog.addEventListener("close", onClose);
    dialog.addEventListener("click", onBackdrop);
    cancel?.addEventListener("click", onCancel);
    dialog.showModal();
    form.querySelector(`#${inputId}`)?.focus();
  });
}

async function requestRollback(repositoryId, revision) {
  const answer = await showDialog({
    eyebrow: "Canonical history",
    title: `Roll ${repositoryId} back to ${shortId(revision, 12)}?`,
    description:
      "The revert goes through validation and approval like any other change, " +
      "so this does not rewrite history — it moves the record forward.",
    tone: "destructive",
    confirmLabel: "Submit rollback",
    field: {
      name: "reason",
      label: "Reason for the record",
      placeholder: "Why this revert is needed",
      required: true,
      multiline: true,
    },
  });
  if (answer === null) {
    return;
  }
  const reason = answer.reason;
  toast("Rollback submitted; it may wait for approval", "default");
  try {
    const response = await api(
      `/projects/${encodeURIComponent(state.projectId)}/repositories/` +
        `${encodeURIComponent(repositoryId)}/rollback`,
      { method: "POST", body: { targetRevision: revision, reason } },
    );
    const result = response.rollback ?? {};
    toast(
      `Rollback ${result.status}: ${result.explanation ?? ""}`.trim(),
      result.status === "integrated" ? "default" : "warn",
    );
    await loadContext({ quiet: true });
  } catch (error) {
    toast(error.message, "warn");
  }
}

/* --------------------------------------------- explorer + editor tabs ---- */

function renderExplorerView() {
  return `<div class="editor-frame">
    <div class="editor-placeholder">
      <div>
        <h2>Task workspace</h2>
        <p>
          ${
            state.repositories.length === 0
              ? "Import a repository, then open a workspace from the Explorer sidebar."
              : state.workspace?.exists
                ? "Pick a file from the Explorer sidebar to edit it here."
                : "Open a workspace from the Explorer sidebar to browse and edit files."
          }
        </p>
        <p class="muted">
          Edits live in your own isolated overlay and only reach canonical
          through the integration pipeline (validation, conflict check,
          promotion) when you submit them.
        </p>
      </div>
    </div>
  </div>`;
}

async function renderFileTabContent(container, tab) {
  container.innerHTML =
    '<div class="view"><div class="skeleton skeleton-tall"></div></div>';
  try {
    const editor = await loadEditorModule();
    if (activeTab() !== tab) {
      return;
    }
    await editor.openFile(container, tab);
  } catch (error) {
    container.innerHTML = `<div class="view"><div class="empty-state"><div><h2>Editor unavailable</h2><p>${escapeHtml(
      error.message,
    )}</p></div></div></div>`;
  }
}

let editorModulePromise;

function loadEditorModule() {
  editorModulePromise ??= import("/editor.js").then((module) => {
    module.init({
      state,
      api,
      toast,
      escapeHtml,
      icon,
      shortId,
      canEdit: () => canRun(),
      markDirty: (path, dirty) => {
        if (dirty) {
          state.dirtyFiles.add(path);
        } else {
          state.dirtyFiles.delete(path);
        }
        renderTabStrip();
        renderSidebar();
      },
      onSaved: () => void refreshWorkspace({ quiet: true }),
      activeTab,
    });
    window.relayEditor = module;
    return module;
  });
  return editorModulePromise;
}

/* ------------------------------------------------- workspace plumbing ---- */

function workspaceBase() {
  return (
    `/projects/${encodeURIComponent(state.projectId)}` +
    `/repositories/${encodeURIComponent(state.explorerRepo)}/workspace`
  );
}

async function refreshWorkspace({ quiet = false } = {}) {
  if (!state.projectId || !state.explorerRepo) {
    state.workspace = undefined;
    state.workspaceFiles = [];
    renderSidebar();
    return;
  }
  try {
    const status = await api(workspaceBase());
    state.workspace = { ...status.workspace, repositoryId: state.explorerRepo };
    if (state.workspace.exists) {
      const files = await api(`${workspaceBase()}/files`);
      state.workspaceFiles = files.files ?? [];
    } else {
      state.workspaceFiles = [];
    }
  } catch (error) {
    state.workspace = undefined;
    state.workspaceFiles = [];
    if (!quiet && error.status !== 501) {
      toast(error.message, "error");
    }
  }
  renderSidebar();
  renderTerminalContext();
}

async function workspaceAction(action) {
  try {
    if (action === "workspace-open") {
      await api(workspaceBase(), { method: "POST", body: {} });
      toast("Workspace opened — an isolated overlay of canonical");
    } else if (action === "workspace-reset") {
      if (
        !window.confirm(
          "Reset the workspace to current canonical? Unsubmitted edits are discarded.",
        )
      ) {
        return;
      }
      await api(`${workspaceBase()}/reset`, { method: "POST", body: {} });
      toast("Workspace reset to canonical");
    } else if (action === "workspace-discard") {
      if (
        !window.confirm(
          "Discard this workspace and all unsubmitted edits in it?",
        )
      ) {
        return;
      }
      await api(workspaceBase(), { method: "DELETE", body: {} });
      toast("Workspace discarded");
    } else if (action === "workspace-submit") {
      const objective = window.prompt(
        "Submit workspace changes through the integration pipeline?\n\n" +
          "The change is validated and conflict-checked like any agent's " +
          "work, and may wait for approval. Describe the change:",
      );
      if (objective === null || objective.trim().length === 0) {
        return;
      }
      toast("Submitting through the integration pipeline…");
      const response = await api(`${workspaceBase()}/submit`, {
        method: "POST",
        body: { objective: objective.trim() },
      });
      const result = response.result ?? {};
      toast(
        `Submission ${result.status}: ${result.explanation ?? ""}`.trim(),
        result.status === "integrated" ? "default" : "warn",
      );
      await loadContext({ quiet: true });
    } else if (action === "workspace-refresh") {
      // fallthrough to the shared refresh below
    }
    await refreshWorkspace({ quiet: false });
  } catch (error) {
    toast(error.message, "error");
  }
}

/* ---------------------------------------------------------- agent chat --- */

/**
 * The agent chat is how work is prompted: pick an agent, describe the change,
 * and that agent plans and executes it through the ordinary pipeline. Under
 * the hood a prompt is still a coordinated task — submitted with the chosen
 * agentId, run, admitted, validated, promoted — so everything the platform
 * guarantees about parallel work still holds; the queue just stopped being
 * the thing you look at.
 */

function chatStorageKey() {
  return `relay.chat.${state.projectId}`;
}

function loadChatTracked() {
  try {
    const raw = localStorage.getItem(chatStorageKey());
    state.chat.tracked = raw === null ? [] : JSON.parse(raw);
  } catch {
    state.chat.tracked = [];
  }
}

function saveChatTracked() {
  state.chat.tracked = state.chat.tracked.slice(-50);
  localStorage.setItem(chatStorageKey(), JSON.stringify(state.chat.tracked));
}

/**
 * The most informative audit event about one task, for progress lines.
 *
 * A failure at run start is recorded against the repository rather than a
 * task id, so for a failed task a repository-level task_failed event beats
 * an older task-scoped "submitted" breadcrumb.
 */
function latestTaskEvent(taskId, repositoryId, status) {
  let taskScoped;
  for (let index = state.audit.length - 1; index >= 0; index -= 1) {
    const record = state.audit[index];
    const event = record.event;
    if (event?.taskId === taskId) {
      taskScoped ??= event;
      if (event.type === "task_failed" || event.type === "canonical_promoted") {
        return event;
      }
    }
    if (
      status === "failed" &&
      taskScoped === undefined &&
      event?.type === "task_failed" &&
      event.taskId === undefined &&
      event.data?.repositoryId === repositoryId
    ) {
      return event;
    }
  }
  return taskScoped;
}

function chatAgentBubble(entry) {
  const task = state.tasks.find((candidate) => candidate.id === entry.taskId);
  const status = task?.status ?? "submitted";
  const event = latestTaskEvent(entry.taskId, entry.repositoryId, status);
  const messages = {
    submitted:
      entry.route === "remote"
        ? "Queued for a remote worker to lease. It plans first, then executes in its own sandbox."
        : "Queued. I plan first, then execute in an isolated workspace.",
    claimed: "Working on it — planning, then editing in my own workspace.",
    integrated:
      "Done. The change passed validation and was promoted to canonical.",
    failed: "That didn't land.",
    cancelled: "Cancelled before landing.",
  };
  const runId = task?.runId;
  return `
    <div class="chat-msg agent">
      <span class="who">${escapeHtml(entry.agentId)}</span>
      ${escapeHtml(messages[status] ?? status)}
      ${
        event !== undefined
          ? `<div class="meta">${taskStatusIcon(status)} ${escapeHtml(
              eventTitle(event),
            )} · ${escapeHtml(String(eventDetail(event)).slice(0, 120))}</div>`
          : `<div class="meta">${taskStatusIcon(status)} ${statusBadge(status)}</div>`
      }
      <div class="meta">
        ${runId ? `<button class="mini-button" data-open-run="${escapeHtml(runId)}">Open execution</button>` : ""}
        ${taskActions(task ?? { id: entry.taskId, status })}
      </div>
    </div>`;
}

/* Provider identity: names, marks, and the Build-mode adapter mapping. ----- */

const CHAT_PROVIDERS = [
  { id: "anthropic", name: "Claude", company: "Anthropic", adapter: "claude" },
  { id: "openai", name: "OpenAI", company: "OpenAI", adapter: "codex" },
  { id: "google", name: "Gemini", company: "Google", adapter: "gemini" },
];

/** Simplified original marks — evocative, not the trademarked artwork. */
const PROVIDER_MARKS = {
  anthropic:
    '<svg viewBox="0 0 24 24" fill="none" stroke="#d97757" stroke-width="2.4" stroke-linecap="round"><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/></svg>',
  openai:
    '<svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.9" stroke-linejoin="round"><path d="M12 3.2l7.6 4.4v8.8L12 20.8l-7.6-4.4V7.6z"/><path d="M12 8.1l4.2 2.4v4.9M12 8.1L7.8 10.5v4.9M12 15.9l4.2-2.4M12 15.9l-4.2-2.4"/></svg>',
  google:
    '<svg viewBox="0 0 24 24" fill="#3d8bff"><path d="M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10z"/></svg>',
};

function providerMeta(id) {
  return CHAT_PROVIDERS.find((provider) => provider.id === id);
}

function providerStatus(id) {
  return state.chat.providers.find((provider) => provider.id === id);
}

async function loadChatProviders() {
  try {
    const response = await api("/chat/providers");
    state.chat.providers = response.providers ?? [];
  } catch {
    state.chat.providers = [];
  } finally {
    state.chat.providersLoaded = true;
  }
}

/** Model/effort choices the connected account reports, cached per provider. */
async function loadProviderOptions(provider) {
  if (state.chat.options[provider] !== undefined) {
    return state.chat.options[provider];
  }
  try {
    const response = await api(`/chat/providers/${provider}/options`);
    state.chat.options[provider] = response.options ?? null;
  } catch {
    state.chat.options[provider] = null;
  }
  return state.chat.options[provider];
}

/**
 * The compact model/effort pickers above the message box. Only what the
 * connected account reports is offered: OpenAI's list comes from its account
 * cache with per-model efforts, Anthropic's from what Claude Code itself
 * caches and documents, plus that CLI's effort enum.
 */
function renderChatQuickbar() {
  const quickbar = $("#chat-quickbar");
  if (!quickbar) {
    return;
  }
  const provider = state.chat.activeProvider;
  const status = providerStatus(provider);
  if (status?.connected !== true) {
    quickbar.hidden = true;
    return;
  }
  const options = state.chat.options[provider];
  if (options === undefined) {
    quickbar.hidden = true;
    void loadProviderOptions(provider).then(() => renderChatQuickbar());
    return;
  }
  const modelSelect = $("#chat-model-select");
  const effortSelect = $("#chat-effort-select");
  const currentModel = status.model ?? "";
  const currentEffort = status.effort ?? "";

  const hasModels = options !== null && options.models !== null;
  modelSelect.hidden = !hasModels;
  if (hasModels) {
    // A model set elsewhere (free text, or the CLI's own default) may not be
    // in the reported list; show it rather than silently displaying another.
    const listed = options.models.some((model) => model.id === currentModel);
    const entries =
      listed || currentModel === ""
        ? options.models
        : [{ id: currentModel, label: currentModel }, ...options.models];
    modelSelect.innerHTML = entries
      .map(
        (model) =>
          `<option value="${escapeHtml(model.id)}"${
            model.id === currentModel ? " selected" : ""
          }>${escapeHtml(shortModelLabel(model.label))}</option>`,
      )
      .join("");
  }
  const effortValues =
    options === null
      ? []
      : (options.efforts ??
          options.models?.find((model) => model.id === currentModel)?.efforts ??
          []);
  effortSelect.hidden = effortValues.length === 0;
  if (effortValues.length > 0) {
    effortSelect.innerHTML = effortValues
      .map(
        (effort) =>
          `<option value="${escapeHtml(effort)}"${
            effort === currentEffort ? " selected" : ""
          }>${escapeHtml(effort)}</option>`,
      )
      .join("");
  }
  quickbar.hidden = !hasModels && effortValues.length === 0;
}

/**
 * Drops the vendor prefix from a model name for the picker. You already
 * picked the provider, so "claude-sonnet-5" reads as "sonnet-5" here. Only
 * the label is shortened — the value sent to the CLI is untouched.
 */
function shortModelLabel(label) {
  return label.replace(/^(claude|gpt|gemini|codex)[-\s]/iu, "");
}

/** Applies a quickbar change immediately; the server validates the value. */
async function applyQuickSetting(field, value) {
  const provider = state.chat.activeProvider;
  try {
    const response = await api(
      `/chat/providers/${encodeURIComponent(provider)}/settings`,
      { method: "POST", body: { [field]: value } },
    );
    state.chat.providers = response.providers ?? state.chat.providers;
    renderChat();
  } catch (error) {
    toast(error.message, "error");
    renderChat();
  }
}

/* Ask-mode conversation persistence: real replies only, per project+provider. */

function conversationKey(provider) {
  return `relay.pchat.${state.projectId}.${provider}`;
}

function loadConversation(provider) {
  if (state.chat.conversations[provider] === undefined) {
    try {
      const raw = localStorage.getItem(conversationKey(provider));
      state.chat.conversations[provider] = raw === null ? [] : JSON.parse(raw);
    } catch {
      state.chat.conversations[provider] = [];
    }
  }
  return state.chat.conversations[provider];
}

function saveConversation(provider) {
  const conversation = (state.chat.conversations[provider] ?? []).slice(-60);
  state.chat.conversations[provider] = conversation;
  localStorage.setItem(conversationKey(provider), JSON.stringify(conversation));
}

function totalsKey() {
  return `relay.pchatTotals.${state.projectId}`;
}

function loadChatTotals() {
  try {
    const raw = localStorage.getItem(totalsKey());
    state.chat.totals = raw === null ? {} : JSON.parse(raw);
  } catch {
    state.chat.totals = {};
  }
}

function rateLimitKey() {
  return `relay.pchatWindow.${state.projectId}`;
}

/**
 * The subscription window outlives a page load, so the last one the CLI
 * reported is kept — but only until its own reset time, after which the
 * figure would no longer describe anything real.
 */
function loadRateLimits() {
  let stored = {};
  try {
    const raw = localStorage.getItem(rateLimitKey());
    stored = raw === null ? {} : JSON.parse(raw);
  } catch {
    stored = {};
  }
  const now = Date.now();
  state.chat.lastRateLimit = Object.fromEntries(
    Object.entries(stored).filter(([, rate]) => {
      const resets = Date.parse(rate?.windowResetsAt ?? "");
      return !Number.isNaN(resets) && resets > now;
    }),
  );
}

function saveRateLimits() {
  localStorage.setItem(
    rateLimitKey(),
    JSON.stringify(state.chat.lastRateLimit),
  );
}

function addToTotals(provider, usage) {
  const totals = state.chat.totals[provider] ?? {
    input: 0,
    output: 0,
    thinking: 0,
    costUsd: 0,
    turns: 0,
  };
  totals.input += usage.inputTokens ?? 0;
  totals.output += usage.outputTokens ?? 0;
  totals.thinking += usage.thinkingTokens ?? 0;
  totals.costUsd += usage.costUsd ?? 0;
  totals.turns += 1;
  state.chat.totals[provider] = totals;
  localStorage.setItem(totalsKey(), JSON.stringify(state.chat.totals));
}

/** Records one reply's real numbers for the Usage and limits view. */
function recordTurn(provider, reply) {
  addToTotals(provider, reply.usage ?? {});
  const totals = state.chat.totals[provider];
  totals.last = {
    usage: reply.usage ?? {},
    model: reply.model,
    at: new Date().toISOString(),
    ...(typeof reply.contextWindow === "number"
      ? { contextWindow: reply.contextWindow }
      : {}),
  };
  localStorage.setItem(totalsKey(), JSON.stringify(state.chat.totals));
}

function formatTokens(count) {
  if (typeof count !== "number") {
    return "—";
  }
  return count >= 10_000
    ? `${(count / 1000).toFixed(1)}k`
    : String(count);
}

function usageLine(message) {
  const usage = message.usage ?? {};
  const parts = [];
  if (usage.inputTokens !== undefined) parts.push(`in ${formatTokens(usage.inputTokens)}`);
  if (usage.outputTokens !== undefined) parts.push(`out ${formatTokens(usage.outputTokens)}`);
  if (usage.thinkingTokens !== undefined) parts.push(`think ${formatTokens(usage.thinkingTokens)}`);
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(4)}`);
  if (parts.length === 0) {
    return "";
  }
  return `<div class="usage-line">${escapeHtml(parts.join(" · "))}${
    message.model ? escapeHtml(` · ${message.model}`) : ""
  }</div>`;
}

function askBubble(message) {
  if (message.role === "user") {
    return `
      <div class="chat-msg user">${escapeHtml(message.content)}
        <div class="meta"><span>${escapeHtml(formatDate(message.at, { short: true }))}</span></div>
      </div>`;
  }
  // A dispatched task keeps its card in the conversation that produced it,
  // tracking the same coordinator state the Executions view shows.
  if (message.role === "task") {
    return `
      <div class="chat-msg user">${escapeHtml(message.objective)}
        <div class="meta">
          <span class="chip">${escapeHtml(message.agentId ?? "")}</span>
          <span class="chip">${escapeHtml(message.repositoryId ?? "")}</span>
          <span class="chip">${
            message.route === "remote" ? "remote worker" : "run here"
          }</span>
          <span>${escapeHtml(formatDate(message.at, { short: true }))}</span>
        </div>
      </div>
      ${chatAgentBubble(message)}`;
  }
  if (message.pending) {
    // Everything here is relayed from the CLI's own event stream: the status
    // word it announced, its reasoning-token count, its reasoning summary,
    // and the answer text so far. Nothing is simulated.
    const status = escapeHtml(message.status ?? "working");
    const tokens =
      message.reasoningTokens > 0
        ? ` · ${formatTokens(message.reasoningTokens)} reasoning tokens`
        : "";
    const reasoning =
      typeof message.reasoning === "string" && message.reasoning.length > 0
        ? `<div class="live-reasoning">${escapeHtml(message.reasoning)}</div>`
        : message.reasoningHidden === true
          ? `<div class="live-reasoning muted">Reasoning in progress — this CLI does not expose the text${tokens}.</div>`
          : "";
    const partial =
      typeof message.content === "string" && message.content.length > 0
        ? `<div class="answer">${escapeHtml(message.content)}</div>`
        : "";
    return `<div class="chat-msg agent pending">
      <span class="live-status"><span class="live-dot"></span>${status}${
        reasoning === "" ? escapeHtml(tokens) : ""
      }</span>
      ${reasoning}
      ${partial}
    </div>`;
  }
  const meta = providerMeta(message.provider) ?? { name: message.provider };
  const thinkingBlock = message.thinking
    ? `<details class="thinking"><summary>Reasoning</summary><div class="thinking-body">${escapeHtml(
        message.thinking,
      )}</div></details>`
    : message.thinkingHidden
      ? // The summary reads the same either way; the detail inside says why
        // there is nothing to show, so the label stays uncluttered.
        `<details class="thinking"><summary>Reasoning</summary><div class="thinking-body">${escapeHtml(
          `${meta.name} used ${formatTokens(message.usage?.thinkingTokens)} reasoning tokens but does not return the content.`,
        )}</div></details>`
      : "";
  return `
    <div class="chat-msg agent">
      <span class="who">${escapeHtml(meta.name)}</span>
      ${thinkingBlock}
      <div class="answer">${escapeHtml(message.content)}</div>
      ${usageLine(message)}
    </div>`;
}

function renderProviderIcons() {
  // Before the probe answers, connection is unknown rather than absent.
  const pending = state.chat.providersLoaded === false;
  $("#provider-icons").innerHTML = CHAT_PROVIDERS.map((provider) => {
    const status = providerStatus(provider.id);
    const connected = status?.connected === true;
    const stateClass = pending ? " connecting" : connected ? " connected" : "";
    const stateLabel = pending
      ? " · checking connection"
      : connected
        ? " · connected"
        : " · not connected";
    return `
      <button
        class="provider-icon${provider.id === state.chat.activeProvider ? " active" : ""}${stateClass}"
        data-chat-provider="${provider.id}"
        title="${escapeHtml(provider.company)}${stateLabel}"
      >
        <span class="dot"></span>
        ${PROVIDER_MARKS[provider.id]}
        <span>${escapeHtml(provider.name)}</span>
      </button>`;
  }).join("");
}

/**
 * The context-window dial beside Send: a ring that fills as the last exchange
 * approaches the window size the CLI reported. Hover carries the real numbers.
 */
function renderContextDial() {
  const target = $("#context-dial");
  if (target === null) {
    return;
  }
  const provider = state.chat.activeProvider;
  const totals = state.chat.totals[provider];
  const last = totals?.last;
  const tokens =
    (last?.usage?.inputTokens ?? 0) +
    (last?.usage?.outputTokens ?? 0) +
    (last?.usage?.thinkingTokens ?? 0);
  if (
    providerStatus(provider)?.connected !== true ||
    last?.contextWindow === undefined ||
    tokens === 0
  ) {
    target.innerHTML = "";
    target.removeAttribute("title");
    return;
  }
  const fraction = Math.min(1, tokens / last.contextWindow);
  const percent = fraction * 100;
  const shown = percent < 1 ? "<1%" : `${Math.round(percent)}%`;
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  target.title = `Context window · ${formatTokens(tokens)} / ${formatTokens(
    last.contextWindow,
  )} tokens (${shown})${
    last.model === undefined ? "" : ` · ${last.model}`
  }, as reported by the CLI`;
  target.innerHTML = `<svg viewBox="0 0 22 22" role="img" aria-label="${escapeHtml(
    target.title,
  )}">
    <circle class="dial-track" cx="11" cy="11" r="${radius}"></circle>
    <circle
      class="dial-fill"
      cx="11"
      cy="11"
      r="${radius}"
      stroke-dasharray="${circumference.toFixed(2)}"
      stroke-dashoffset="${(circumference * (1 - fraction)).toFixed(2)}"
      transform="rotate(-90 11 11)"
    ></circle>
  </svg>`;
}

/**
 * The consumption meter under the message box. Every percentage here is one
 * the provider's own CLI reported; when a CLI publishes none, that is stated
 * rather than substituted with something derived.
 */
function usageMeter(report, { compact = false } = {}) {
  if (report === undefined) {
    return "";
  }
  if (report.windows.length === 0) {
    return `<div class="usage-row"><span class="muted">${escapeHtml(
      report.unavailableReason ?? "No usage figures reported",
    )}</span><span></span></div>`;
  }
  const windows = compact ? report.windows.slice(0, 2) : report.windows;
  return windows
    .map((window) => {
      const percent = Math.max(0, Math.min(100, window.percentUsed));
      return `<div class="usage-block">
        <div class="usage-title"><span>${escapeHtml(window.label)}</span>
          <strong>${percent}% used</strong></div>
        <div class="usage-meter"><span class="seg-fill${
          percent >= 90 ? " warn" : ""
        }" style="width:${Math.max(1, percent)}%"></span></div>
        ${
          window.resetsAt === undefined
            ? ""
            : `<div class="usage-legend"><span>resets ${escapeHtml(
                window.resetsAt,
              )}</span></div>`
        }
      </div>`;
    })
    .join("");
}

function renderChatUsage() {
  const target = $("#chat-usage");
  const panel = $("#chat-usage-panel");
  const provider = state.chat.activeProvider;
  if (providerStatus(provider)?.connected !== true) {
    target.innerHTML = "";
    panel.hidden = true;
    return;
  }
  const report = state.chat.usage[provider];
  if (report === undefined) {
    void loadProviderUsage(provider);
  }
  panel.hidden = false;
  panel.open = state.chat.usageOpen;
  // The headline figure stays visible while collapsed; expanding shows every
  // window the CLI reported.
  const headline = report?.windows?.[0];
  $("#chat-usage-summary").textContent =
    headline === undefined
      ? "Usage"
      : `Usage · ${headline.label} ${headline.percentUsed}% used`;
  // Real consumption only; the context window is the dial by Send and the
  // per-turn token breakdown lives in Usage and limits.
  target.innerHTML = usageMeter(report);
}

/** Fetches what the provider CLI reports about consumption, once per view. */
async function loadProviderUsage(provider) {
  if (state.chat.usageLoading[provider] === true) {
    return;
  }
  state.chat.usageLoading[provider] = true;
  try {
    const response = await api(
      `/chat/providers/${encodeURIComponent(provider)}/usage`,
    );
    state.chat.usage[provider] = response.usage ?? { windows: [] };
  } catch {
    state.chat.usage[provider] = {
      windows: [],
      unavailableReason: "Usage could not be read from the CLI.",
    };
  } finally {
    state.chat.usageLoading[provider] = false;
    renderChatUsage();
  }
}

/**
 * Below this width the chat panel cannot sit beside the view without starving
 * it, so it becomes an overlay drawer instead. Kept in sync with the matching
 * breakpoint in styles.css.
 */
const CHAT_DRAWER_QUERY = window.matchMedia("(max-width: 1100px)");

/**
 * Reconcile the chat panel with the viewport.
 *
 * As a drawer it covers the view, so it must not be open by default — the
 * panel used to stay open across the breakpoint and hide the right 380px of
 * every screen, including the controls needed to close it. Crossing back into
 * the wide layout restores whatever the user last chose there.
 */
function syncChatToViewport() {
  const drawer = CHAT_DRAWER_QUERY.matches;
  if (drawer === state.chat.drawer) {
    return;
  }
  state.chat.drawer = drawer;
  state.chat.open = drawer
    ? false
    : localStorage.getItem("relay.chatOpen") !== "false";
  // Before sign-in the panel's contents do not exist yet; renderShell paints
  // it once the app shell is revealed.
  if ($("#app-shell")?.hidden === false) {
    renderChat();
  }
}

function renderChat() {
  const shell = $("#app-shell");
  if (!shell) {
    return;
  }
  shell.classList.toggle("chat-collapsed", !state.chat.open);
  shell.classList.toggle(
    "chat-drawer-open",
    state.chat.open && state.chat.drawer === true,
  );
  if (!$("#provider-icons")) {
    return;
  }
  renderProviderIcons();
  renderChatQuickbar();
  renderChatUsage();
  renderContextDial();
  renderDispatchPanel();

  const mode = state.chat.mode;
  $$("#chat-mode-toggle .mode-option").forEach((option) => {
    option.classList.toggle("active", option.dataset.chatMode === mode);
  });
  const repoSelect = $("#chat-repo-select");
  repoSelect.hidden = mode !== "build";
  if (
    !state.repositories.some((repo) => repo.id === state.chat.repositoryId)
  ) {
    state.chat.repositoryId = state.repositories[0]?.id ?? "";
  }
  repoSelect.innerHTML =
    state.repositories.length === 0
      ? '<option value="">No repository</option>'
      : state.repositories
          .map(
            (repo) =>
              `<option value="${escapeHtml(repo.id)}"${
                repo.id === state.chat.repositoryId ? " selected" : ""
              }>${escapeHtml(repo.id)}</option>`,
          )
          .join("");

  const thread = $("#chat-thread");
  const provider = state.chat.activeProvider;
  const status = providerStatus(provider);
  const meta = providerMeta(provider);

  if (mode === "ask") {
    const conversation = loadConversation(provider);
    if (status?.connected !== true) {
      thread.innerHTML = `<p class="chat-empty">
        ${escapeHtml(meta?.company ?? provider)} is not connected.
        Click its icon above and sign in with your
        ${escapeHtml(meta?.company ?? provider)} account.
      </p>`;
    } else if (conversation.length === 0) {
      thread.innerHTML = `<p class="chat-empty">
        Connected to ${escapeHtml(meta?.name ?? provider)}
        (${escapeHtml(status.model ?? "")}). Ask anything — token usage and,
        where the model exposes it, reasoning appear with each reply.
      </p>`;
    } else {
      thread.innerHTML = conversation.map(askBubble).join("");
      thread.scrollTop = thread.scrollHeight;
    }
  } else {
    const entries = state.chat.tracked;
    const buildAgent = buildAgentFor(provider);
    if (entries.length === 0) {
      thread.innerHTML = `<p class="chat-empty">${
        buildAgent === undefined
          ? `No configured agent matches ${escapeHtml(
              meta?.name ?? provider,
            )} (adapter "${escapeHtml(meta?.adapter ?? "?")}") in .coordinator/config.json.`
          : state.repositories.length === 0
            ? "Import a repository, then tell your agent what to build."
            : `Describe a change and the ${escapeHtml(
                buildAgent.id,
              )} agent will plan it, execute it in an isolated workspace, and submit it through validation into canonical.`
      }</p>`;
    } else {
      thread.innerHTML = entries
        .map(
          (entry) => `
          <div class="chat-msg user">${escapeHtml(entry.objective)}
            <div class="meta"><span class="chip">${escapeHtml(entry.agentId)}</span>
              <span class="chip">${escapeHtml(entry.repositoryId)}</span>
              <span>${escapeHtml(formatDate(entry.at, { short: true }))}</span></div>
          </div>
          ${chatAgentBubble(entry)}`,
        )
        .join("");
      thread.scrollTop = thread.scrollHeight;
    }
  }

  const disabled =
    state.chat.sending ||
    (mode === "ask"
      ? status?.connected !== true
      : !canRun() ||
        buildAgentFor(provider) === undefined ||
        state.repositories.length === 0);
  $("#chat-input").disabled = disabled && !state.chat.sending;
  $("#chat-send").disabled = disabled;
  $("#chat-input").placeholder =
    mode === "ask"
      ? status?.connected === true
        ? "Ask the model anything…"
        : `Connect ${meta?.company ?? provider} to chat`
      : !canRun()
        ? "Your role can watch work but not prompt it"
        : "Tell the agent what to build…";
}

/** The configured coordination agent matching a chat provider, if any. */
function buildAgentFor(provider) {
  const adapter = providerMeta(provider)?.adapter;
  return state.agents.find((agent) => agent.adapter === adapter);
}

/**
 * Decides what dispatching the current conversation would actually do.
 *
 * Both routes are the coordinator's own: `local` submits the task and asks
 * the control plane to drain the repository in process, while `remote`
 * submits it and leaves it for a registered worker to lease through the
 * worker protocol — plan first, its own sandbox, lease-bound. The two share
 * one queue, so the only real difference is who executes.
 *
 * Pure so it can be tested without a browser.
 */
function dispatchPlan(input) {
  const objective = (
    input.draft?.trim().length > 0 ? input.draft : (input.lastUserMessage ?? "")
  ).trim();
  const adapter = input.adapter ?? "";
  const agent = (input.agents ?? []).find(
    (candidate) => candidate.adapter === adapter,
  );
  const workers = (input.workers ?? []).filter((worker) =>
    (worker.adapters ?? []).includes(adapter),
  );
  // The point of a worker fleet is that the machine with the vendor logins
  // does the work while you are somewhere else. So whenever a worker
  // advertises this adapter, that is the default; running inside the control
  // plane is the fallback for when nobody is listening. An explicit choice
  // always wins.
  const route = input.route ?? (workers.length > 0 ? "remote" : "local");
  const base = {
    objective,
    route,
    adapter,
    agentId: agent?.id,
    repositoryId: input.repositoryId ?? "",
    workerCount: workers.length,
  };
  if (objective.length === 0) {
    return { ...base, ok: false, reason: "Type or send something to dispatch." };
  }
  if (base.repositoryId.length === 0) {
    return {
      ...base,
      ok: false,
      reason: "Choose a repository to dispatch against.",
    };
  }
  if (agent === undefined) {
    return {
      ...base,
      ok: false,
      reason: `No agent with adapter "${adapter}" is configured in .coordinator/config.json.`,
    };
  }
  // A remote route with nobody listening is legitimate — the task waits in
  // the queue — but it must never look like it started.
  const warning =
    route === "remote" && workers.length === 0
      ? `No remote worker advertising "${adapter}" is connected. The task will sit queued until one registers.`
      : undefined;
  return {
    ...base,
    ok: true,
    ...(warning === undefined ? {} : { warning }),
  };
}

/** The dispatch plan for what is currently on screen. */
function currentDispatchPlan() {
  const provider = state.chat.activeProvider;
  const conversation = loadConversation(provider);
  const lastUser = [...conversation]
    .reverse()
    .find((message) => message.role === "user");
  return dispatchPlan({
    adapter: providerMeta(provider)?.adapter,
    agents: state.agents,
    workers: state.workers,
    repositoryId: state.chat.repositoryId,
    draft: $("#chat-input")?.value ?? "",
    lastUserMessage: lastUser?.content ?? "",
    ...(state.chat.dispatchRoute === null
      ? {}
      : { route: state.chat.dispatchRoute }),
  });
}

function renderDispatchPanel() {
  const panel = $("#dispatch-panel");
  const button = $("#chat-dispatch");
  if (panel === null || button === null) {
    return;
  }
  const connected = providerStatus(state.chat.activeProvider)?.connected;
  // Dispatch does not need a chat connection — it submits to the
  // coordinator — but it is only meaningful in a conversation view.
  button.hidden = state.chat.mode !== "ask";
  if (!state.chat.dispatchOpen || state.chat.mode !== "ask") {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const plan = currentDispatchPlan();
  const repositories = state.repositories
    .map(
      (repository) =>
        `<option value="${escapeHtml(repository.id)}"${
          repository.id === plan.repositoryId ? " selected" : ""
        }>${escapeHtml(repository.id)}</option>`,
    )
    .join("");
  const routeOption = (value, label, detail) => `
    <button
      class="dispatch-route${plan.route === value ? " active" : ""}"
      data-action="dispatch-route"
      data-route="${value}"
      type="button"
    >
      <strong>${label}</strong>
      <span>${detail}</span>
    </button>`;
  panel.hidden = false;
  panel.innerHTML = `
    <div class="dispatch-head">
      <strong>Dispatch as a task</strong>
      <button class="mini-button" data-action="dispatch-close">×</button>
    </div>
    <p class="dispatch-objective">${escapeHtml(
      plan.objective.length > 0 ? plan.objective : "Nothing to dispatch yet.",
    )}</p>
    <label class="dispatch-field">
      <span>Repository</span>
      <select id="dispatch-repo">${
        repositories === "" ? "<option value=''>None</option>" : repositories
      }</select>
    </label>
    <div class="dispatch-routes">
      ${routeOption(
        "local",
        "Run here",
        "The control plane plans, executes, validates and promotes in process.",
      )}
      ${routeOption(
        "remote",
        "Remote worker",
        `Leased through the worker protocol — plan first, its own sandbox. ${
          plan.workerCount > 0
            ? `${plan.workerCount} worker${plan.workerCount === 1 ? "" : "s"} advertising "${escapeHtml(plan.adapter)}".`
            : "None connected right now."
        }`,
      )}
    </div>
    ${
      plan.ok
        ? plan.warning === undefined
          ? `<p class="dispatch-note">${escapeHtml(
              `${plan.agentId} · ${plan.repositoryId}`,
            )}</p>`
          : `<p class="dispatch-note warn">${escapeHtml(plan.warning)}</p>`
        : `<p class="dispatch-note warn">${escapeHtml(plan.reason)}</p>`
    }
    <div class="dispatch-actions">
      <button class="button button-primary" data-action="dispatch-confirm"${
        plan.ok ? "" : " disabled"
      }>Dispatch</button>
      <button class="button button-quiet" data-action="dispatch-close">Cancel</button>
    </div>
    ${
      connected === true
        ? ""
        : `<p class="dispatch-note">This provider is not connected for chat, but dispatch runs through the coordinator, so it still works.</p>`
    }`;
}

/** Submits the planned task and, for the local route, starts the run. */
async function performDispatch() {
  const plan = currentDispatchPlan();
  if (!plan.ok) {
    toast(plan.reason, "error");
    return;
  }
  const provider = state.chat.activeProvider;
  try {
    const response = await api(
      `/projects/${encodeURIComponent(state.projectId)}/tasks`,
      {
        method: "POST",
        body: {
          repositoryId: plan.repositoryId,
          objective: plan.objective,
          agentId: plan.agentId,
        },
      },
    );
    const entry = {
      taskId: response.task.id,
      objective: plan.objective,
      agentId: plan.agentId,
      repositoryId: plan.repositoryId,
      route: plan.route,
      at: new Date().toISOString(),
    };
    state.chat.tracked.push(entry);
    saveChatTracked();
    // The task card lives in the conversation it came from.
    loadConversation(provider).push({ role: "task", ...entry });
    saveConversation(provider);
    if (plan.route === "local") {
      await ensureRepositoryRun(plan.repositoryId);
    }
    if ($("#chat-input") !== null) {
      $("#chat-input").value = "";
    }
    state.chat.dispatchOpen = false;
    toast(
      plan.route === "local"
        ? "Dispatched — the coordinator is running it here."
        : plan.warning === undefined
          ? "Queued for a remote worker."
          : "Queued. No remote worker is connected yet.",
      plan.warning === undefined ? "default" : "warn",
    );
    await loadContext({ quiet: true });
  } catch (error) {
    toast(error.message, "error");
  } finally {
    renderChat();
  }
}

/**
 * Kicks the coordinator for a repository so a prompted task starts without a
 * separate "run" click. A run already in flight is fine — the task is queued
 * behind it and picked up when the coordinator next drains the repository.
 */
async function ensureRepositoryRun(repositoryId, { quiet = true } = {}) {
  state.chat.runAttempts.set(repositoryId, Date.now());
  try {
    await api(
      `/projects/${encodeURIComponent(state.projectId)}/repositories/${encodeURIComponent(
        repositoryId,
      )}/run`,
      { method: "POST", body: {} },
    );
  } catch (error) {
    if (error.code !== "run_in_progress" && !quiet) {
      toast(error.message, "error");
    }
  }
}

/** Restarts the run loop for chat tasks that are still waiting. */
function maybeDrainChatRuns() {
  if (!canRun()) {
    return;
  }
  const waitingRepos = new Set(
    state.chat.tracked
      .filter(
        (entry) =>
          // A task routed to a remote worker is waiting for a lease, not for
          // this control plane. Draining it here would execute it in process
          // and defeat the route the user chose.
          entry.route !== "remote" &&
          state.tasks.some(
            (task) => task.id === entry.taskId && task.status === "submitted",
          ),
      )
      .map((entry) => entry.repositoryId),
  );
  for (const repositoryId of waitingRepos) {
    const runActive = state.runs.some(
      (run) => run.repositoryId === repositoryId && run.status === "running",
    );
    const lastAttempt = state.chat.runAttempts.get(repositoryId) ?? 0;
    if (!runActive && Date.now() - lastAttempt > 20_000) {
      void ensureRepositoryRun(repositoryId);
    }
  }
}

async function sendChatPrompt() {
  if (state.chat.mode === "ask") {
    await sendAskMessage();
  } else {
    await sendBuildPrompt();
  }
}

/**
 * Repaints only the message list. Streaming updates arrive many times a
 * second, and a full chat re-render would fight the input and the pickers.
 */
function renderChatThread() {
  const thread = $("#chat-thread");
  if (thread === null || state.chat.mode !== "ask") {
    return;
  }
  const conversation = loadConversation(state.chat.activeProvider);
  if (conversation.length === 0) {
    return;
  }
  const pinned =
    thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
  thread.innerHTML = conversation.map(askBubble).join("");
  if (pinned) {
    thread.scrollTop = thread.scrollHeight;
  }
}

/** Folds one CLI event into the pending bubble's live state. */
function applyStreamEvent(pending, event) {
  if (event.type === "status") {
    pending.status = event.status;
  } else if (event.type === "reasoning_start") {
    pending.status = "reasoning";
    pending.reasoningHidden = event.hidden === true;
  } else if (event.type === "reasoning") {
    pending.reasoning = `${pending.reasoning ?? ""}${event.text}`;
    pending.reasoningHidden = false;
  } else if (event.type === "reasoning_tokens") {
    pending.reasoningTokens = event.tokens;
  } else if (event.type === "text") {
    pending.status = "responding";
    pending.content = `${pending.content ?? ""}${event.delta}`;
  }
}

/**
 * Streams a completion as newline-delimited JSON. Each line is one event the
 * provider CLI emitted; the last one carries the finished reply.
 */
async function streamCompletion(body, onEvent) {
  const response = await fetch(`${API_ROOT}/chat/stream`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson",
      "X-CSRF-Token": csrfToken(),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok || response.body === null) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(
      detail?.error?.message ?? `Request failed with status ${response.status}`,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply;
  let failure;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "done") {
        reply = event.reply ?? {};
      } else if (event.type === "error") {
        failure = event.message ?? "The provider CLI failed";
      } else {
        onEvent(event);
      }
    }
  }
  if (failure !== undefined) {
    throw new Error(failure);
  }
  if (reply === undefined) {
    throw new Error("The provider stream ended without a reply");
  }
  return reply;
}

/** Ask mode: a real completion against the connected provider. */
async function sendAskMessage() {
  const input = $("#chat-input");
  const content = input.value.trim();
  const provider = state.chat.activeProvider;
  if (
    content.length === 0 ||
    state.chat.sending ||
    providerStatus(provider)?.connected !== true
  ) {
    return;
  }
  const conversation = loadConversation(provider);
  conversation.push({ role: "user", content, at: new Date().toISOString() });
  const pending = {
    role: "assistant",
    pending: true,
    provider,
    status: "sending",
    reasoningTokens: 0,
    content: "",
  };
  conversation.push(pending);
  state.chat.sending = true;
  input.value = "";
  renderChat();
  try {
    const history = conversation
      .filter((message) => !message.pending && message.content)
      .slice(-12)
      .map((message) => ({ role: message.role, content: message.content }));
    const reply = await streamCompletion(
      {
        provider,
        messages: history,
        ...(state.chat.cliSessions[provider] === undefined
          ? {}
          : { cliSessionId: state.chat.cliSessions[provider] }),
      },
      (event) => {
        applyStreamEvent(pending, event);
        renderChatThread();
      },
    );
    const index = conversation.indexOf(pending);
    conversation[index === -1 ? conversation.length - 1 : index] = {
      role: "assistant",
      provider,
      content: reply.text ?? "",
      ...(reply.thinking === undefined ? {} : { thinking: reply.thinking }),
      ...(reply.thinkingHidden === true ? { thinkingHidden: true } : {}),
      usage: reply.usage ?? {},
      model: reply.model,
      at: new Date().toISOString(),
    };
    recordTurn(provider, reply);
    if (reply.rateLimit !== undefined) {
      state.chat.lastRateLimit[provider] = reply.rateLimit;
      saveRateLimits();
    }
    if (reply.cliSessionId !== undefined) {
      state.chat.cliSessions[provider] = reply.cliSessionId;
    }
    saveConversation(provider);
  } catch (error) {
    const index = conversation.indexOf(pending);
    if (index !== -1) {
      conversation.splice(index, 1);
    }
    saveConversation(provider);
    toast(error.message, "error");
  } finally {
    state.chat.sending = false;
    renderChat();
    input.focus();
  }
}

/** Build mode: the prompt becomes a coordinated task, as before. */
async function sendBuildPrompt() {
  const input = $("#chat-input");
  const objective = input.value.trim();
  const agent = buildAgentFor(state.chat.activeProvider);
  if (
    objective.length === 0 ||
    state.chat.sending ||
    agent === undefined ||
    !state.chat.repositoryId
  ) {
    return;
  }
  state.chat.sending = true;
  $("#chat-send").disabled = true;
  try {
    const response = await api(
      `/projects/${encodeURIComponent(state.projectId)}/tasks`,
      {
        method: "POST",
        body: {
          repositoryId: state.chat.repositoryId,
          objective,
          agentId: agent.id,
        },
      },
    );
    state.chat.tracked.push({
      taskId: response.task.id,
      objective,
      agentId: agent.id,
      repositoryId: state.chat.repositoryId,
      at: new Date().toISOString(),
    });
    saveChatTracked();
    input.value = "";
    await ensureRepositoryRun(state.chat.repositoryId);
    await loadContext({ quiet: true });
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.chat.sending = false;
    renderChat();
    input.focus();
  }
}

/* ------------------------------------------ provider connection screen --- */

function openConnectOverlay(provider) {
  state.chat.overlayProvider = provider;
  state.chat.overlayView = "main";
  void renderConnectOverlay();
  $("#connect-overlay").hidden = false;
}

function closeConnectOverlay() {
  state.chat.overlayProvider = null;
  $("#connect-overlay").hidden = true;
}

const SIGN_IN_LABELS = {
  anthropic: "Sign in with Claude",
  openai: "Sign in with ChatGPT",
  google: "Sign in with Google",
};

/** One row of a settings card: icon, label, right-dim value, chevron. */
function settingsRow({ iconName, label, value, chevron, danger, action }) {
  const tag = action ? "button" : "div";
  return `<${tag} class="settings-row${danger ? " danger" : ""}" ${action ?? ""} ${
    action ? 'type="button"' : ""
  }>
    ${iconName ? icon(iconName) : ""}
    <span class="row-label">${label}</span>
    ${value !== undefined ? `<span class="row-value">${value}</span>` : ""}
    ${chevron ? `<span class="row-chevron">${icon("chevronRight")}</span>` : ""}
  </${tag}>`;
}

function userInitials() {
  return (state.principal?.user?.displayName ?? "R")
    .split(/\s+/u)
    .map((word) => word.charAt(0))
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * The context-window meter. Both the always-visible chat strip and the
 * settings screen draw this, so the numbers can never disagree.
 */
function contextMeter(totals, { compact = false } = {}) {
  const last = totals?.last;
  const lastTokens =
    (last?.usage?.inputTokens ?? 0) +
    (last?.usage?.outputTokens ?? 0) +
    (last?.usage?.thinkingTokens ?? 0);
  if (last?.contextWindow === undefined || lastTokens === 0) {
    return compact
      ? ""
      : `<div class="usage-block"><div class="usage-legend"><span>
          No context-window figure yet — the CLI reports it with each reply,
          so send a message first.
        </span></div></div>`;
  }
  const percent = (lastTokens / last.contextWindow) * 100;
  return `<div class="usage-block">
    <div class="usage-title"><span>${compact ? "Context window" : "Last exchange"}</span>
      <strong>${escapeHtml(formatTokens(lastTokens))} / ${escapeHtml(
        formatTokens(last.contextWindow),
      )} tokens (${Math.max(1, Math.round(percent))}%)</strong></div>
    <div class="usage-meter"><span class="seg-fill" style="width:${Math.max(
      1,
      Math.min(100, Math.round(percent)),
    )}%"></span></div>
    ${
      compact
        ? ""
        : `<div class="usage-legend"><span>${escapeHtml(last.model ?? "")} · context window ${escapeHtml(
            formatTokens(last.contextWindow),
          )} tokens, as reported by the CLI</span></div>`
    }
  </div>`;
}

/** Window lengths implied by the rate-limit kinds the CLI actually names. */
const RATE_WINDOW_MS = {
  five_hour: 5 * 60 * 60 * 1000,
  seven_day: 7 * 24 * 60 * 60 * 1000,
};

/**
 * The subscription-window meter. The CLI reports the window's kind, status,
 * and reset time — never a consumed or remaining figure — so this tracks
 * position in time, and says so rather than implying a usage percentage.
 */
function windowMeter(rate, { compact = false } = {}) {
  if (rate?.source !== "cli-window" || rate.windowResetsAt === undefined) {
    return "";
  }
  const label = compact
    ? "Usage"
    : `${(rate.windowKind ?? "window").replaceAll("_", " ")} window`;
  const resets = Date.parse(rate.windowResetsAt);
  const span = RATE_WINDOW_MS[rate.windowKind];
  const status = rate.windowStatus ?? "unknown";
  const resetLabel = `resets ${formatDate(rate.windowResetsAt, { short: true })}`;
  if (span === undefined || Number.isNaN(resets)) {
    return `<div class="usage-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(
      `${status} · ${resetLabel}`,
    )}</span></div>`;
  }
  const remaining = Math.max(0, Math.min(span, resets - Date.now()));
  const elapsed = Math.round(((span - remaining) / span) * 100);
  const minutesLeft = Math.round(remaining / 60_000);
  const left =
    minutesLeft >= 60
      ? `${Math.floor(minutesLeft / 60)}h ${minutesLeft % 60}m left`
      : `${minutesLeft}m left`;
  return `<div class="usage-block">
    <div class="usage-title"><span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(left)}</strong></div>
    <div class="usage-meter"><span class="seg-window" style="width:${Math.max(
      1,
      Math.min(100, elapsed),
    )}%"></span></div>
    <div class="usage-legend"><span>${escapeHtml(
      compact
        ? `${(rate.windowKind ?? "window").replaceAll("_", " ")} window · ${status} · ${resetLabel} · time elapsed, not usage`
        : `${status} · ${resetLabel} · elapsed time in the window; this CLI reports no usage figure`,
    )}</span></div>
  </div>`;
}

/** The stacked input/output/reasoning meter for the session so far. */
function mixMeter(totals) {
  const mixTotal =
    (totals?.input ?? 0) + (totals?.output ?? 0) + (totals?.thinking ?? 0);
  if (mixTotal === 0) {
    return "";
  }
  return `<div class="usage-block">
    <div class="usage-title"><span>Session token mix</span>
      <strong>${escapeHtml(formatTokens(mixTotal))} total</strong></div>
    <div class="usage-meter">
      <span class="seg-input" style="width:${(100 * (totals.input ?? 0)) / mixTotal}%"></span>
      <span class="seg-output" style="width:${(100 * (totals.output ?? 0)) / mixTotal}%"></span>
      <span class="seg-thinking" style="width:${(100 * (totals.thinking ?? 0)) / mixTotal}%"></span>
    </div>
    <div class="usage-legend">
      <span><span class="dot" style="background:var(--accent)"></span>input ${escapeHtml(formatTokens(totals.input))}</span>
      <span><span class="dot" style="background:var(--success)"></span>output ${escapeHtml(formatTokens(totals.output))}</span>
      <span><span class="dot" style="background:var(--purple)"></span>reasoning ${escapeHtml(formatTokens(totals.thinking))}</span>
    </div>
  </div>`;
}

/** The dedicated Usage and limits screen inside the settings overlay. */
function renderUsageSheet(provider, meta, status) {
  const totals = state.chat.totals[provider];
  const rate = state.chat.lastRateLimit[provider];
  const contextBlock = contextMeter(totals);
  const mixBlock = mixMeter(totals);
  const windowBlock = windowMeter(rate);
  const usageBlock = usageMeter(state.chat.usage[provider]);
  return `<div class="settings-sheet">
    <button class="sheet-close" data-action="connect-close">×</button>
    <button class="sheet-back" data-action="settings-back">‹ ${escapeHtml(meta.name)} settings</button>
    <div>
      <p class="eyebrow">${escapeHtml(meta.company)}</p>
      <h2>Usage and limits</h2>
    </div>
    <div class="settings-card">
      ${settingsRow({ iconName: "graph", label: "Session turns", value: String(totals?.turns ?? 0) })}
      ${settingsRow({ iconName: "runs", label: "Input tokens", value: escapeHtml(formatTokens(totals?.input ?? 0)) })}
      ${settingsRow({ iconName: "commit", label: "Output tokens", value: escapeHtml(formatTokens(totals?.output ?? 0)) })}
      ${settingsRow({ iconName: "tasks", label: "Reasoning tokens", value: escapeHtml(formatTokens(totals?.thinking ?? 0)) })}
      ${
        (totals?.costUsd ?? 0) > 0
          ? settingsRow({ iconName: "approvals", label: "Reported cost", value: `$${totals.costUsd.toFixed(4)}` })
          : ""
      }
    </div>
    <p class="settings-section-label">Context window</p>
    <div class="settings-card">${contextBlock}</div>
    ${
      mixBlock
        ? `<p class="settings-section-label">Composition</p><div class="settings-card">${mixBlock}</div>`
        : ""
    }
    ${
      usageBlock === ""
        ? windowBlock === ""
          ? ""
          : `<p class="settings-section-label">Subscription window</p>
            <div class="settings-card">${windowBlock}</div>`
        : `<p class="settings-section-label">Plan usage</p>
          <div class="settings-card">${usageBlock}</div>`
    }
    <p class="settings-footnote">
      Every figure comes from the provider CLI's own events — token counts and
      cost from replies, the context window from the ${escapeHtml(meta.name)}
      account's own reporting. Neither subscription CLI publishes a numeric
      quota, so none is shown.
    </p>
  </div>`;
}

async function renderConnectOverlay() {
  const provider = state.chat.overlayProvider;
  if (provider === null) {
    return;
  }
  const meta = providerMeta(provider);
  const status = providerStatus(provider);
  const connected = status?.connected === true;
  const cli = status?.cli ?? { detected: false, loggedIn: false };

  if (connected && state.chat.overlayView === "usage") {
    $("#connect-card").innerHTML = renderUsageSheet(provider, meta, status);
    return;
  }

  let optionsHtml = "";
  let options;
  if (connected) {
    try {
      options = (await api(`/chat/providers/${provider}/options`)).options;
    } catch {
      options = undefined;
    }
    if (state.chat.overlayProvider !== provider) {
      return;
    }
    if (options !== undefined && options !== null) {
      // The pill dropdown offers what the account reports; this stays for
      // anything it doesn't list, which the CLI still accepts.
      const customModelField = options.allowCustomModel
        ? `<form data-form="provider-settings" data-provider="${provider}" class="stack" style="gap:10px">
              <label><span>${
                options.models === null ? "Model (free text)" : "Other model"
              }</span>
                <input name="model" value="${escapeHtml(status.model ?? "")}" placeholder="CLI default">
              </label>
              <p class="connect-error" id="connect-error"></p>
              <button class="button button-quiet" type="submit">Save model</button>
            </form>`
        : "";
      optionsHtml = `
        ${customModelField}
        ${
          options.modelListSource
            ? `<p class="settings-footnote">${escapeHtml(options.modelListSource)}</p>`
            : ""
        }
        ${options.notes
          .map((note) => `<p class="settings-footnote">${escapeHtml(note)}</p>`)
          .join("")}`;
    }
  }

  $("#connect-card").innerHTML = connected
    ? `<div class="settings-sheet">
        <button class="sheet-close" data-action="connect-close">×</button>
        <div class="sheet-identity">
          <div class="sheet-avatar">${escapeHtml(userInitials())}</div>
          <div class="sheet-name">${escapeHtml(state.principal?.user?.displayName ?? "Relay user")}</div>
          <div class="sheet-sub">${escapeHtml(meta.company)} · connected</div>
        </div>
        <p class="settings-section-label">Account</p>
        <div class="settings-card">
          ${settingsRow({ iconName: "people", label: "Signed in as", value: escapeHtml(cli.account ?? "account") })}
          ${settingsRow({ iconName: "shield", label: "Plan", value: escapeHtml(cli.plan ?? "not reported by the CLI") })}
          ${settingsRow({ iconName: "gear", label: "Model", value: escapeHtml(status.model ?? "CLI default") })}
          ${settingsRow({ iconName: "tasks", label: "Reasoning effort", value: escapeHtml(status.effort ?? "CLI default") })}
        </div>
        <p class="settings-section-label">Usage</p>
        <div class="settings-card">
          ${settingsRow({
            iconName: "graph",
            label: "Usage and limits",
            chevron: true,
            action: 'data-action="settings-open-usage"',
          })}
        </div>
        <p class="settings-section-label">Connection</p>
        <div class="settings-card">
          ${settingsRow({
            iconName: "close",
            label: `Disconnect ${escapeHtml(meta.name)}`,
            danger: true,
            action: `data-action="provider-disconnect" data-provider="${provider}"`,
          })}
        </div>
        ${optionsHtml}
      </div>`
    : `<div class="provider-mark">${PROVIDER_MARKS[provider]}</div>
    <div>
      <p class="eyebrow">${escapeHtml(meta.company)}</p>
      <h2>Connect ${escapeHtml(meta.name)}</h2>
    </div>
    <p>
            Uses your ${escapeHtml(meta.company)} account through its own
            sign-in — no API keys. The browser flow runs on the Relay host and
            spends the host owner's account, so connecting is restricted to
            system administrators.
          </p>
          <p class="muted" style="font-size:12px">
            ${
              cli.detected
                ? cli.loggedIn
                  ? `✓ CLI detected · already signed in${cli.account ? ` as ${escapeHtml(cli.account)}` : ""}`
                  : "CLI detected · not signed in yet"
                : `The ${escapeHtml(meta.name)} CLI was not found on this host.`
            }
          </p>
          ${
            cli.blockedReason
              ? `<p class="connect-error">${escapeHtml(cli.blockedReason)}</p>`
              : ""
          }
          <p class="connect-error" id="connect-error"></p>
          ${
            cli.loggedIn
              ? `<button class="button button-primary button-wide" data-action="provider-connect-account">
                  Connect ${escapeHtml(meta.name)}
                </button>`
              : `<button class="button button-primary button-wide" data-action="provider-signin" ${
                  cli.detected ? "" : "disabled"
                }>
                  ${escapeHtml(SIGN_IN_LABELS[provider])}
                </button>
                <button class="button button-quiet button-wide" data-action="provider-check-again">
                  Check again
                </button>`
          }
          <div class="row-actions">
            <button class="button button-quiet" data-action="connect-close">Cancel</button>
          </div>`;
}

async function connectProvider(provider) {
  const errorTarget = $("#connect-error");
  try {
    const response = await api(
      `/chat/providers/${encodeURIComponent(provider)}`,
      { method: "POST", body: {} },
    );
    state.chat.providers = response.providers ?? state.chat.providers;
    state.chat.activeProvider = provider;
    localStorage.setItem("relay.chatProvider", provider);
    closeConnectOverlay();
    toast(`${providerMeta(provider).company} connected`);
    renderChat();
    $("#chat-input")?.focus();
  } catch (error) {
    if (errorTarget) {
      errorTarget.textContent = error.message;
    } else {
      toast(error.message, "error");
    }
  }
}

function focusChat() {
  state.chat.open = true;
  localStorage.setItem("relay.chatOpen", "true");
  renderChat();
  $("#chat-input")?.focus();
}

/* ------------------------------------------------------------ terminal --- */

/**
 * Product commands remain useful when the optional Docker sandbox is offline.
 * Unknown commands deliberately fall through to the workspace executor.
 */
function terminalProductCommand(command, snapshot = state) {
  const tokens = String(command ?? "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (tokens[0]?.toLowerCase() === "relay") {
    tokens.shift();
  }
  const verb = tokens.shift()?.toLowerCase() ?? "";
  const statusCounts = (items = []) => {
    const counts = new Map();
    for (const item of items) {
      const status = String(item?.status ?? "unknown");
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => `${status} ${count}`)
      .join(" | ");
  };
  const output = (...lines) => ({
    handled: true,
    lines: lines.map((text) => ({ kind: "out", text })),
  });

  if (verb === "help" || verb === "?") {
    return output(
      "Relay commands: status, tasks, runs, agents, approvals, repos, whoami, open <view>, clear",
      "Other commands run inside the selected repository workspace when its sandbox is online.",
    );
  }
  if (verb === "status") {
    const socketLive = snapshot.socket?.readyState === 1;
    const sandboxReady = snapshot.health?.docker?.available === true;
    return output(
      `Project: ${snapshot.project?.name ?? "none selected"}`,
      `Control link: ${socketLive ? "live" : "connecting"}`,
      `Sandbox: ${sandboxReady ? "ready" : "offline"}`,
      `Tasks: ${snapshot.tasks?.length ?? 0} | Executions: ${
        snapshot.runs?.length ?? 0
      } | Pending approvals: ${
        snapshot.approvals?.filter((approval) => approval.status === "pending")
          .length ?? 0
      }`,
    );
  }
  if (verb === "tasks") {
    return output(
      snapshot.tasks?.length > 0
        ? `Tasks: ${statusCounts(snapshot.tasks)}`
        : "Tasks: none recorded",
    );
  }
  if (verb === "runs" || verb === "executions") {
    return output(
      snapshot.runs?.length > 0
        ? `Executions: ${statusCounts(snapshot.runs)}`
        : "Executions: none recorded",
    );
  }
  if (verb === "agents") {
    const agents = snapshot.agentsRunning;
    return output(
      agents === undefined
        ? "Agents: control-plane count unavailable"
        : `Agents: ${agents.running ?? 0} running | ${
            agents.busyWorkers ?? 0
          }/${agents.workers ?? 0} workers busy`,
    );
  }
  if (verb === "approvals") {
    return output(
      snapshot.approvals?.length > 0
        ? `Approvals: ${statusCounts(snapshot.approvals)}`
        : "Approvals: none recorded",
    );
  }
  if (verb === "repos" || verb === "repositories") {
    return output(
      snapshot.repositories?.length > 0
        ? snapshot.repositories
            .map(
              (repository) =>
                `${repository.id} (${repository.branch ?? "default branch"})`,
            )
            .join("\n")
        : "Repositories: none connected",
    );
  }
  if (verb === "whoami") {
    const user = snapshot.principal?.user;
    return output(
      user
        ? `${user.email ?? user.name ?? user.id} | ${
            user.systemAdmin ? "system admin" : "member"
          }`
        : "Identity unavailable",
    );
  }
  if (verb === "clear" || verb === "cls") {
    return { handled: true, clear: true, lines: [] };
  }
  if (verb === "open") {
    const aliases = {
      tasks: "board",
      executions: "runs",
      reviews: "approvals",
      repos: "repositories",
    };
    const requested = (tokens[0] ?? "").toLowerCase();
    const view = aliases[requested] ?? requested;
    const allowed = new Set([
      "overview",
      "board",
      "runs",
      "approvals",
      "repositories",
      "coordination",
      "explorer",
      "settings",
    ]);
    if (!allowed.has(view)) {
      return output(
        "Open requires one of: overview, board, runs, approvals, repositories, coordination, explorer, settings",
      );
    }
    return {
      handled: true,
      view,
      lines: [{ kind: "sys", text: `Opening ${view}...` }],
    };
  }
  return { handled: false, lines: [] };
}

function renderTerminalContext() {
  const target = $("#terminal-context");
  if (!target) {
    return;
  }
  const sandbox = state.workspace?.sandbox;
  const input = $("#terminal-input");
  const productContext = state.project?.name ?? "no project selected";
  const workspaceContext = !state.explorerRepo
    ? "product commands"
    : state.workspace?.exists
      ? sandbox?.available
        ? `sandboxed bash (${sandbox.image})`
        : "sandbox offline"
      : "workspace closed";
  target.textContent = `${productContext} | ${workspaceContext}`;
  if (input) {
    input.placeholder = sandbox?.available
      ? "Run a sandbox command or type help"
      : "Type help, status, tasks, runs, agents...";
    input.setAttribute(
      "aria-label",
      sandbox?.available
        ? "Relay terminal and sandbox command input"
        : "Relay product command input; workspace sandbox offline",
    );
  }
}

function terminalPrint(kind, text) {
  const scroll = $("#terminal-scroll");
  if (!scroll) {
    return;
  }
  for (const line of String(text ?? "").split("\n")) {
    const element = document.createElement("span");
    element.className = `terminal-line ${kind}`;
    element.textContent = line;
    scroll.append(element);
  }
  scroll.scrollTop = scroll.scrollHeight;
}

function ensureTerminalIntro() {
  if (state.terminal.welcomed) {
    return;
  }
  state.terminal.welcomed = true;
  terminalPrint("sys", "RELAY COMMAND CONSOLE | live product telemetry");
  terminalPrint(
    "out",
    "Type help for Relay commands. Workspace commands are isolated in the repository sandbox.",
  );
  if (state.health?.docker?.available === false) {
    terminalPrint(
      "err",
      "Sandbox offline. Product telemetry commands remain available.",
    );
  }
}

async function runTerminalCommand(command) {
  if (state.terminal.busy) {
    return;
  }
  terminalPrint("cmd", command);
  const productCommand = terminalProductCommand(command);
  if (productCommand.handled) {
    if (productCommand.clear) {
      $("#terminal-scroll")?.replaceChildren();
    }
    for (const line of productCommand.lines) {
      terminalPrint(line.kind, line.text);
    }
    if (productCommand.view) {
      setPanel(false);
      openView(productCommand.view);
    }
    return;
  }
  if (state.health?.docker?.available === false) {
    terminalPrint(
      "err",
      "Sandbox runtime is offline, so repository shell commands cannot run.",
    );
    terminalPrint(
      "sys",
      "Relay commands still work. Type help to list them.",
    );
    return;
  }
  if (!state.projectId || !state.explorerRepo) {
    terminalPrint("sys", "Select a repository in the Explorer first.");
    return;
  }
  if (!state.workspace?.exists) {
    terminalPrint(
      "sys",
      "No workspace is open. Open one from the Explorer sidebar first.",
    );
    return;
  }
  state.terminal.busy = true;
  const input = $("#terminal-input");
  if (input) {
    input.readOnly = true;
    input.setAttribute("aria-busy", "true");
  }
  try {
    const response = await api(`${workspaceBase()}/exec`, {
      method: "POST",
      body: { command },
    });
    const result = response.result ?? {};
    if (result.stdout) {
      terminalPrint("out", result.stdout.replace(/\n$/u, ""));
    }
    if (result.stderr) {
      terminalPrint("err", result.stderr.replace(/\n$/u, ""));
    }
    terminalPrint(
      "sys",
      `exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""} · ${duration(
        result.durationMs,
      )}`,
    );
    void refreshWorkspace({ quiet: true });
  } catch (error) {
    terminalPrint("err", error.message);
  } finally {
    state.terminal.busy = false;
    if (input) {
      input.readOnly = false;
      input.removeAttribute("aria-busy");
      input.focus();
    }
  }
}

function setPanel(open, tab) {
  state.panelOpen = open;
  if (tab) {
    state.panelTab = tab;
  }
  $("#bottom-panel").hidden = !open;
  $$(".panel-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.panelTab === state.panelTab);
  });
  $$(".panel-view").forEach((view) => {
    view.hidden = view.dataset.panelView !== state.panelTab;
  });
  if (open && state.panelTab === "terminal") {
    ensureTerminalIntro();
    renderTerminalContext();
    const input = $("#terminal-input");
    if (input) {
      input.readOnly = state.terminal.busy;
    }
    window.requestAnimationFrame(() => input?.focus());
  }
}

/* -------------------------------------------------------------- forms ---- */

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
      case "repository-create":
        await mutate(
          `/projects/${encodeURIComponent(state.projectId)}/repositories`,
          {
            id: value("id"),
            ...(value("branch") ? { branch: value("branch") } : {}),
          },
          "Canonical repository created",
        );
        form.reset();
        break;
      case "provider-settings": {
        const response = await api(
          `/chat/providers/${encodeURIComponent(form.dataset.provider)}/settings`,
          {
            method: "POST",
            body: {
              ...(value("model") ? { model: value("model") } : {}),
              ...(value("effort") ? { effort: value("effort") } : {}),
            },
          },
        );
        state.chat.providers = response.providers ?? state.chat.providers;
        toast("Provider settings saved");
        void renderConnectOverlay();
        renderChat();
        break;
      }
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
      case "project-policy": {
        const body = policyPayload({
          approvalsEnabled: data.get("approvalsEnabled") === "on",
          requireSchemaReview: data.get("requireSchemaReview") === "on",
          requireChangesetReview: data.get("requireChangesetReview") === "on",
          riskLevels: data.getAll("riskLevel").map((level) => String(level)),
          protectedPaths: value("protectedPaths"),
          approvalTimeoutMinutes: value("approvalTimeoutMinutes"),
          maxTaskRuntimeMinutes: value("maxTaskRuntimeMinutes"),
          maxProjectRuntimeMinutesPerDay: value(
            "maxProjectRuntimeMinutesPerDay",
          ),
        });
        await api(`/projects/${encodeURIComponent(state.projectId)}`, {
          method: "PATCH",
          body,
        });
        toast(
          body.policy === null
            ? "Policy cleared; built-in defaults apply"
            : "Coordination policy saved",
        );
        await loadContext({ quiet: true });
        break;
      }
      case "comment-add": {
        const runId = form.dataset.runId;
        await api(`/runs/${encodeURIComponent(runId)}/comments`, {
          method: "POST",
          body: {
            changeSetId: form.dataset.changesetId,
            body: value("body"),
            ...(form.dataset.filePath === undefined
              ? {}
              : { filePath: form.dataset.filePath }),
          },
        });
        toast("Comment added");
        renderActiveTabContent();
        break;
      }
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
        renderActiveTabContent();
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

/* -------------------------------------------------------------- clicks ---- */

async function handleClick(event) {
  const target = event.target.closest("button, a");
  if (!target) {
    return;
  }
  if (target.dataset.authMode) {
    setAuthMode(target.dataset.authMode);
    return;
  }
  if (target.dataset.activity) {
    const activity = target.dataset.activity;
    if (state.activity === activity) {
      // VS Code behavior: clicking the active icon toggles the sidebar.
      $("#app-shell").classList.toggle("sidebar-collapsed");
      $("#app-shell").classList.toggle("sidebar-open");
      return;
    }
    state.activity = activity;
    $("#app-shell").classList.remove("sidebar-collapsed");
    $("#app-shell").classList.add("sidebar-open");
    const entry = [...ACTIVITIES, ...FOOTER_ACTIVITIES].find(
      (candidate) => candidate.id === activity,
    );
    if (entry) {
      openView(entry.view);
    }
    if (activity === "explorer") {
      void refreshWorkspace({ quiet: true });
    }
    return;
  }
  if (target.dataset.closeTab !== undefined) {
    event.stopPropagation();
    const tab = findTab(target.dataset.closeTab);
    if (
      tab?.kind === "file" &&
      state.dirtyFiles.has(tab.data.path) &&
      !window.confirm("Close this file and lose unsaved changes?")
    ) {
      return;
    }
    closeTab(target.dataset.closeTab);
    return;
  }
  if (target.dataset.tabId) {
    state.activeTabId = target.dataset.tabId;
    const tab = activeTab();
    if (tab?.kind === "view") {
      state.activity = VIEW_META[tab.view]?.activity ?? state.activity;
    } else if (tab?.kind === "file") {
      state.activity = "explorer";
    }
    renderShell();
    return;
  }
  if (target.dataset.action === "hud-refresh") {
    await loadContext({ quiet: true });
    toast("Control room refreshed");
    return;
  }
  if (target.dataset.openView) {
    openView(target.dataset.openView);
    return;
  }
  if (target.dataset.openRun) {
    openRunTab(target.dataset.openRun);
    return;
  }
  if (target.dataset.openApproval) {
    openApprovalTab(target.dataset.openApproval);
    return;
  }
  if (target.dataset.openHistory) {
    openHistoryTab(target.dataset.openHistory);
    return;
  }
  if (target.dataset.openFile) {
    openFileTab(state.explorerRepo, target.dataset.openFile);
    return;
  }
  if (target.dataset.toggleDir !== undefined) {
    const path = target.dataset.toggleDir;
    if (state.expandedDirs.has(path)) {
      state.expandedDirs.delete(path);
    } else {
      state.expandedDirs.add(path);
    }
    renderSidebar();
    return;
  }
  if (
    target.dataset.action?.startsWith("workspace-")
  ) {
    await workspaceAction(target.dataset.action);
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
  if (target.dataset.action === "chat-focus") {
    focusChat();
    return;
  }
  if (target.dataset.chatProvider) {
    const provider = target.dataset.chatProvider;
    if (providerStatus(provider)?.connected === true) {
      state.chat.activeProvider = provider;
      localStorage.setItem("relay.chatProvider", provider);
      renderChat();
    } else {
      openConnectOverlay(provider);
    }
    return;
  }
  if (target.dataset.chatMode) {
    state.chat.mode = target.dataset.chatMode;
    localStorage.setItem("relay.chatMode", state.chat.mode);
    renderChat();
    return;
  }
  if (target.id === "chat-dispatch") {
    state.chat.dispatchOpen = !state.chat.dispatchOpen;
    renderDispatchPanel();
    return;
  }
  if (target.dataset.action === "dispatch-close") {
    state.chat.dispatchOpen = false;
    renderDispatchPanel();
    return;
  }
  if (target.dataset.action === "dispatch-route") {
    state.chat.dispatchRoute = target.dataset.route;
    renderDispatchPanel();
    return;
  }
  if (target.dataset.action === "dispatch-confirm") {
    await performDispatch();
    return;
  }
  if (target.id === "chat-manage") {
    openConnectOverlay(state.chat.activeProvider);
    return;
  }
  if (target.dataset.action === "connect-close") {
    closeConnectOverlay();
    return;
  }
  if (target.dataset.action === "settings-open-usage") {
    state.chat.overlayView = "usage";
    void renderConnectOverlay();
    return;
  }
  if (target.dataset.action === "settings-back") {
    state.chat.overlayView = "main";
    void renderConnectOverlay();
    return;
  }
  if (target.dataset.action === "provider-connect-account") {
    await connectProvider(state.chat.overlayProvider);
    return;
  }
  if (target.dataset.action === "provider-signin") {
    try {
      const response = await api(
        `/chat/providers/${encodeURIComponent(state.chat.overlayProvider)}/signin`,
        { method: "POST", body: {} },
      );
      toast(response.signIn?.note ?? "Sign-in started on the host");
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  if (target.dataset.action === "provider-check-again") {
    await loadChatProviders();
    void renderConnectOverlay();
    renderChat();
    return;
  }
  if (target.dataset.action === "provider-disconnect") {
    try {
      await api(`/chat/providers/${encodeURIComponent(target.dataset.provider)}`, {
        method: "DELETE",
        body: {},
      });
      await loadChatProviders();
      renderConnectOverlay();
      renderChat();
      toast("Provider disconnected");
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  if (target.id === "chat-toggle") {
    state.chat.open = !state.chat.open;
    localStorage.setItem("relay.chatOpen", String(state.chat.open));
    renderChat();
    return;
  }
  if (target.id === "chat-collapse") {
    state.chat.open = false;
    localStorage.setItem("relay.chatOpen", "false");
    renderChat();
    return;
  }
  if (target.dataset.action === "retry-context") {
    renderShell();
    await loadContext({ quiet: true });
    return;
  }
  if (target.id === "chat-scrim") {
    // Dismissing the drawer is a viewport-local gesture, not a preference:
    // the wide layout should still open the panel next time.
    state.chat.open = false;
    renderChat();
    return;
  }
  if (target.id === "panel-toggle") {
    setPanel(!state.panelOpen);
    return;
  }
  if (target.id === "panel-close") {
    setPanel(false);
    return;
  }
  if (target.dataset.panelTab) {
    setPanel(true, target.dataset.panelTab);
    return;
  }
  if (target.dataset.runRepo) {
    target.setAttribute("disabled", "");
    try {
      await mutate(
        `/projects/${encodeURIComponent(
          state.projectId,
        )}/repositories/${encodeURIComponent(target.dataset.runRepo)}/run`,
        {},
        "Coordinator accepted the repository execution",
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
  if (target.dataset.action === "resolve-comment") {
    try {
      await api(
        `/comments/${encodeURIComponent(target.dataset.commentId)}/resolve`,
        { method: "POST", body: {} },
      );
      toast("Comment resolved");
      renderActiveTabContent();
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  if (target.dataset.action === "rollback") {
    await requestRollback(target.dataset.repoId, target.dataset.revision);
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
  if (target.id === "explorer-repo-select") {
    state.explorerRepo = target.value;
    localStorage.setItem("relay.explorerRepo", state.explorerRepo);
    await refreshWorkspace();
    return;
  }
  if (target.id === "chat-model-select") {
    await applyQuickSetting("model", target.value);
    return;
  }
  if (target.id === "chat-effort-select") {
    await applyQuickSetting("effort", target.value);
    return;
  }
  if (target.id === "chat-repo-select" || target.id === "dispatch-repo") {
    state.chat.repositoryId = target.value;
    localStorage.setItem("relay.chatRepo", state.chat.repositoryId);
    renderDispatchPanel();
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

/* ---------------------------------------------------------------- boot ---- */

async function enterApp() {
  const me = await api("/auth/me");
  state.principal = me;
  $("#auth-shell").hidden = true;
  $("#app-shell").hidden = false;
  authMessage("");
  applyHash();
  // Provider probing shells out to each CLI and can take seconds. It used to
  // be awaited here, which held the whole control room on an empty shell — and
  // an empty shell renders as first-run onboarding. It is not on the critical
  // path for showing the app, so it runs alongside and repaints when it lands.
  void loadChatProviders().then(() => {
    renderProviderIcons();
    renderChatQuickbar();
  });
  await loadContext({ quiet: true });
  if (state.activity === "explorer") {
    void refreshWorkspace({ quiet: true });
  }
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
  $("#chat-usage-panel").addEventListener("toggle", (event) => {
    state.chat.usageOpen = event.currentTarget.open;
    localStorage.setItem(
      "relay.chatUsageOpen",
      String(state.chat.usageOpen),
    );
  });
  window.addEventListener("hashchange", () => {
    applyHash();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "`" && event.ctrlKey) {
      event.preventDefault();
      setPanel(!state.panelOpen);
    }
    if (event.key === "Escape" && state.chat.drawer === true && state.chat.open) {
      state.chat.open = false;
      renderChat();
    }
  });
  CHAT_DRAWER_QUERY.addEventListener("change", syncChatToViewport);
  syncChatToViewport();
  $("#chat-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void sendChatPrompt();
  });
  $("#chat-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendChatPrompt();
    }
  });
  $("#terminal-input").addEventListener("keydown", (event) => {
    const input = event.target;
    if (event.key === "Enter") {
      const command = input.value.trim();
      if (command.length === 0) {
        return;
      }
      state.terminal.history.push(command);
      state.terminal.historyIndex = state.terminal.history.length;
      input.value = "";
      void runTerminalCommand(command);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (state.terminal.historyIndex > 0) {
        state.terminal.historyIndex -= 1;
        input.value = state.terminal.history[state.terminal.historyIndex] ?? "";
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (state.terminal.historyIndex < state.terminal.history.length) {
        state.terminal.historyIndex += 1;
        input.value = state.terminal.history[state.terminal.historyIndex] ?? "";
      }
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
    const bootstrapTab = $('[data-auth-mode="bootstrap"]');
    bootstrapTab.hidden = !state.health.setupRequired;
    if (state.health.setupRequired) {
      setAuthMode("bootstrap");
    } else {
      setAuthMode("login");
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

export { policyPayload };

void boot();
