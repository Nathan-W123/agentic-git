/**
 * Shared UI primitives.
 *
 * Every screen composes from this file rather than hand-rolling its own
 * markup, so a badge, a progress bar, or an agent avatar looks identical
 * wherever it appears. Everything here returns an HTML string and stays
 * stateless; behaviour is bound by the screen that renders it, through
 * delegated `data-act` handlers.
 */

/* ---------------------------------------------------------------- dom ---- */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [
  ...root.querySelectorAll(selector),
];

export function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/gu,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

export function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

/* -------------------------------------------------------------- icons ---- */

/**
 * A single stroked icon set at 24×24, so every glyph shares one weight and
 * optical size. Mixing icon families is the fastest way to make a dark UI
 * look assembled rather than designed.
 */
const S = (body, extra = "") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"${extra}>${body}</svg>`;

export const ICONS = {
  home: S('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'),
  folder: S(
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  ),
  code: S('<path d="m9 17-5-5 5-5"/><path d="m15 7 5 5-5 5"/>'),
  robot: S(
    '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4.5"/><circle cx="12" cy="3.4" r="1.3"/><circle cx="9.2" cy="13.4" r="1.15" fill="currentColor" stroke="none"/><circle cx="14.8" cy="13.4" r="1.15" fill="currentColor" stroke="none"/><path d="M9.6 16.8h4.8"/>',
  ),
  network: S(
    '<circle cx="12" cy="12" r="3"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="m6.6 6.6 3 3M17.4 6.6l-3 3M6.6 17.4l3-3M17.4 17.4l-3-3"/>',
  ),
  bell: S(
    '<path d="M18 9a6 6 0 0 0-12 0c0 5-2 6-2 6h16s-2-1-2-6"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/>',
  ),
  gear: S(
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 14.5a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.46V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.46-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 9 4.72 1.6 1.6 0 0 0 10 3.26V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.46 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 19.28 9a1.6 1.6 0 0 0 1.46 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  ),
  search: S('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  close: S('<path d="M18 6 6 18M6 6l12 12"/>'),
  chevronDown: S('<path d="m6 9 6 6 6-6"/>'),
  chevronRight: S('<path d="m9 6 6 6-6 6"/>'),
  chevronUp: S('<path d="m6 15 6-6 6 6"/>'),
  arrowRight: S('<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>'),
  branch: S(
    '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="8" r="2.4"/><path d="M6 8.4v7.2"/><path d="M18 10.4c0 4-4.2 3.4-6.6 4.6"/>',
  ),
  git: S(
    '<circle cx="12" cy="6" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M12 8.2v7.6"/>',
  ),
  github: S(
    '<path d="M9 19c-4 1.2-4-2.2-5.6-2.8M15 21v-3.3c0-.9-.1-1.3-.6-1.8 2.4-.3 4.8-1.2 4.8-5.2a4 4 0 0 0-1.1-2.8 3.7 3.7 0 0 0-.1-2.8s-.9-.3-2.9 1.1a10 10 0 0 0-5.2 0C7.9 2 7 2.3 7 2.3a3.7 3.7 0 0 0-.1 2.8A4 4 0 0 0 5.8 8c0 3.9 2.4 4.8 4.7 5.2-.3.3-.6.8-.6 1.6V21"/>',
  ),
  google: S(
    '<path d="M20.6 12.2c0-.6-.1-1.2-.2-1.8H12v3.4h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9a8.6 8.6 0 0 0 2.7-6.5z"/><path d="M12 21a8.5 8.5 0 0 0 5.9-2.2l-2.9-2.2A5.3 5.3 0 0 1 12 17.4a5.3 5.3 0 0 1-4.9-3.6H4.1v2.3A9 9 0 0 0 12 21z"/><path d="M7.1 13.8a5.3 5.3 0 0 1 0-3.4V8.1H4.1a9 9 0 0 0 0 8.1z"/><path d="M12 6.6c1.3 0 2.5.5 3.5 1.4l2.6-2.6A9 9 0 0 0 4.1 8.1l3 2.3A5.3 5.3 0 0 1 12 6.6z"/>',
  ),
  cloud: S(
    '<path d="M17.5 19a4.5 4.5 0 0 0 .3-9 6 6 0 0 0-11.6 1.6A3.7 3.7 0 0 0 7 19z"/>',
  ),
  link: S(
    '<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7L12.7 18"/>',
  ),
  star: S('<path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z"/>'),
  dots: S(
    '<circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none"/>',
  ),
  filter: S('<path d="M3 5h18l-7 8v6l-4 2v-8z"/>'),
  grid: S(
    '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
  ),
  list: S('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
  file: S(
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  ),
  history: S(
    '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 5v4h4"/><path d="M12 8v4.4l3 1.7"/>',
  ),
  sparkle: S(
    '<path d="M12 3.5 13.7 9l5.3 1.7L13.7 12.4 12 18l-1.7-5.6L5 10.7 10.3 9z"/><path d="M18.5 3.5v3M20 5h-3"/>',
  ),
  paperclip: S(
    '<path d="M20 11.5 12.4 19a4.6 4.6 0 0 1-6.5-6.5l7.7-7.7a3.1 3.1 0 0 1 4.3 4.3l-7.6 7.7a1.5 1.5 0 0 1-2.2-2.2l7-7"/>',
  ),
  at: S(
    '<circle cx="12" cy="12" r="3.6"/><path d="M15.6 12v1.4a2.6 2.6 0 0 0 5.2 0V12a8.8 8.8 0 1 0-3.5 7"/>',
  ),
  send: S('<path d="M4.5 12 20 4.5 15.5 20l-3.6-5.6z"/><path d="m11.9 14.4 8.1-9.9"/>'),
  sliders: S(
    '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  ),
  check: S('<path d="m5 12.5 4.5 4.5L19 7"/>'),
  checkCircle: S('<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>'),
  alert: S(
    '<path d="M12 4.5 21 20H3z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>',
  ),
  clock: S('<circle cx="12" cy="12" r="9"/><path d="M12 7v5.3l3.2 1.9"/>'),
  users: S(
    '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16.5 5.2a3.2 3.2 0 0 1 0 5.6"/><path d="M18 14.4a5.5 5.5 0 0 1 3 5.6"/>',
  ),
  lock: S(
    '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  ),
  play: S('<path d="M7 4.8 19 12 7 19.2z"/>'),
  pause: S('<path d="M9 5v14M15 5v14"/>'),
  globe: S(
    '<circle cx="12" cy="12" r="9"/><path d="M3.2 9.5h17.6M3.2 14.5h17.6"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>',
  ),
  shield: S('<path d="M12 3.2 19 6v6c0 4.3-3 7.4-7 8.8-4-1.4-7-4.5-7-8.8V6z"/>'),
  sync: S(
    '<path d="M20.5 12a8.5 8.5 0 0 1-14.6 6"/><path d="M3.5 12a8.5 8.5 0 0 1 14.6-6"/><path d="M18.5 2.5V6h-3.4M5.5 21.5V18h3.4"/>',
  ),
  database: S(
    '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6"/><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
  ),
  cpu: S(
    '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
  ),
  layers: S(
    '<path d="m12 3 8.5 4.5L12 12 3.5 7.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5"/>',
  ),
  terminal: S('<path d="m5 8 4 4-4 4"/><path d="M12 16h7"/>'),
  refresh: S(
    '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20.5 4v4h-4"/>',
  ),
  folderPlus: S(
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11.5v5M9.5 14h5"/>',
  ),
  columns: S(
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M12 4.5v15"/>',
  ),
  info: S('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none"/>'),
  chart: S('<path d="M4 19.5V13M10 19.5V6M16 19.5v-4M22 19.5H2"/>'),
  logout: S(
    '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M9 8 5 12l4 4"/><path d="M5 12h9"/>',
  ),
  external: S('<path d="M13.5 4.5H19V10"/><path d="m19 4.5-8 8"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>'),
  bolt: S('<path d="M13.5 3 5 13.5h5.5L10 21l8.5-10.5H13z"/>'),
  eye: S('<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  menu: S('<path d="M4 7h16M4 12h16M4 17h16"/>'),
};

export function icon(name, extra = "") {
  const glyph = ICONS[name] ?? ICONS.info;
  return extra === "" ? glyph : glyph.replace("<svg ", `<svg ${extra} `);
}

/** The product mark: a hexagon node with its three coordination links. */
export function brandMark(size = 34) {
  return `<svg class="brand-mark" width="${size}" height="${size}" viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <path d="M20 2.6 34.6 11v18L20 37.4 5.4 29V11z" fill="#12111f" stroke="#8b5cf6" stroke-width="1.6"/>
    <circle cx="20" cy="20" r="4" fill="#8b5cf6"/>
    <circle cx="20" cy="9.6" r="2.2" fill="#a78bfa"/>
    <circle cx="29.4" cy="25.4" r="2.2" fill="#a78bfa"/>
    <circle cx="10.6" cy="25.4" r="2.2" fill="#a78bfa"/>
    <path d="M20 12v4M22.6 22.4l4.6 2.2M17.4 22.4l-4.6 2.2" stroke="#8b5cf6" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`;
}

/* ------------------------------------------------------------ avatars ---- */

const AVATAR_HUES = [
  "#7c5cff",
  "#4f8ef7",
  "#2fae7f",
  "#d9713c",
  "#c8508f",
  "#3f9ea8",
  "#8a6de9",
  "#b8813a",
];

/** Stable per-identity colour, so the same person keeps the same swatch. */
export function hueFor(seed) {
  const text = String(seed ?? "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return AVATAR_HUES[hash % AVATAR_HUES.length];
}

export function initials(name) {
  const parts = String(name ?? "")
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .split(/[\s._-]+/u)
    .filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function avatar(name, size = 26, seed = name) {
  return `<span class="avatar sz-${size}" style="background:${hueFor(seed)}" title="${esc(
    name,
  )}">${esc(initials(name))}</span>`;
}

export function avatarStack(names, max = 4, size = 26) {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return `<span class="avatar-stack">${shown
    .map((name) => avatar(name, size))
    .join("")}${rest > 0 ? `<span class="more">+${rest}</span>` : ""}</span>`;
}

/* ------------------------------------------------------ agent identity ---- */

/**
 * Provider identity. Marks are original shapes, evocative of each vendor
 * rather than reproductions of their trademarks.
 */
export const PROVIDERS = {
  anthropic: { label: "Claude", tint: "#c98a63", mark: "claude" },
  openai: { label: "Codex", tint: "#8fa3bf", mark: "codex" },
  google: { label: "Gemini", tint: "#5b8dd9", mark: "gemini" },
  deepseek: { label: "DeepSeek", tint: "#d98a4a", mark: "spark" },
  perplexity: { label: "Perplexity", tint: "#3fa8b5", mark: "spark" },
  scribe: { label: "Scribe", tint: "#6cc27a", mark: "spark" },
  generic: { label: "Agent", tint: "#8b5cf6", mark: "spark" },
};

const FACE_MARKS = {
  claude:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8.6" cy="10.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="15.4" cy="10.5" r="1.5" fill="currentColor" stroke="none"/><path d="M9 15.2c1.8 1.3 4.2 1.3 6 0"/></svg>',
  codex:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m9.4 9.6-2.6 2.6 2.6 2.6"/><path d="m14.6 9.6 2.6 2.6-2.6 2.6"/></svg>',
  gemini:
    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 4c.5 4.3 3.7 7.5 8 8-4.3.5-7.5 3.7-8 8-.5-4.3-3.7-7.5-8-8 4.3-.5 7.5-3.7 8-8z"/></svg>',
  spark:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8.6" cy="10.8" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.4" cy="10.8" r="1.3" fill="currentColor" stroke="none"/><path d="M9.4 15h5.2"/></svg>',
};

export function providerOf(id) {
  return PROVIDERS[id] ?? PROVIDERS.generic;
}

/**
 * The agent mascot: a tinted ring with a small face and a presence dot.
 * Restrained on purpose — playful at a glance, invisible when scanning.
 */
export function agentFace(agent, size = 34) {
  const provider = providerOf(agent?.provider);
  const presence = agent?.presence ?? "offline";
  return `<span class="agent-face sz-${size}" style="color:${provider.tint}" title="${esc(
    agent?.name ?? provider.label,
  )}">${FACE_MARKS[provider.mark] ?? FACE_MARKS.spark}<i class="presence presence-${presence}"></i></span>`;
}

/* ------------------------------------------------------------- status ---- */

const BADGE_TONES = {
  working: "blue",
  running: "blue",
  planning: "blue",
  validating: "blue",
  idle: "orange",
  waiting: "orange",
  awaiting_approval: "orange",
  queued: "orange",
  submitted: "orange",
  offline: "grey",
  cancelled: "grey",
  completed: "green",
  integrated: "green",
  online: "green",
  approved: "green",
  failed: "red",
  rejected: "red",
  blocked: "red",
};

export function toneFor(status) {
  return BADGE_TONES[String(status ?? "").toLowerCase()] ?? "grey";
}

export function badge(label, tone = toneFor(label)) {
  return `<span class="badge ${tone}">${esc(String(label).replace(/_/gu, " "))}</span>`;
}

export function chip(label, tone = "purple") {
  const cls = tone === "purple" ? "" : ` ${tone}`;
  return `<span class="chip${cls}">${esc(label)}</span>`;
}

export function dot(tone = "green", pulse = false) {
  return `<span class="dot ${tone}${pulse ? " pulse" : ""}"></span>`;
}

/* ----------------------------------------------------------- progress ---- */

export function bar(percent, tone = "", thin = false) {
  const value = Math.max(0, Math.min(100, Math.round(percent || 0)));
  return `<span class="bar${thin ? " thin" : ""}"><i class="${tone}" style="width:${value}%"></i></span>`;
}

/**
 * Context usage, drawn at icon size.
 *
 * Deliberately a 15px ring and a percentage — the chat panel is for talking to
 * an agent, not for reading token analytics, so this is the whole of it.
 */
export function contextRing(percent, label = true) {
  const value = Math.max(0, Math.min(100, Math.round(percent || 0)));
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - value / 100);
  return `<span class="ctx" title="Context used: ${value}%">
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle class="track" cx="8" cy="8" r="${radius}" fill="none" stroke-width="2.4"/>
      <circle class="fill" cx="8" cy="8" r="${radius}" fill="none" stroke-width="2.4"
        stroke-linecap="round" stroke-dasharray="${circumference.toFixed(2)}"
        stroke-dashoffset="${offset.toFixed(2)}"/>
    </svg>${label ? `${value}%` : ""}</span>`;
}

/* ------------------------------------------------------------ controls ---- */

export function searchBox(placeholder, value = "", act = "search") {
  return `<label class="search">${icon("search")}
    <input type="search" data-act="${act}" placeholder="${esc(placeholder)}"
      value="${esc(value)}" aria-label="${esc(placeholder)}">
  </label>`;
}

export function selectBox(act, options, current, { title = "" } = {}) {
  const body = options
    .map(
      (option) =>
        `<option value="${esc(option.value)}"${
          option.value === current ? " selected" : ""
        }>${esc(option.label)}</option>`,
    )
    .join("");
  return `<span class="select"${title ? ` title="${esc(title)}"` : ""}>
    <select data-act="${act}">${body}</select>${icon("chevronDown")}</span>`;
}

export function miniSelect(act, options, current, title = "") {
  if (options.length === 0) {
    return "";
  }
  const body = options
    .map(
      (option) =>
        `<option value="${esc(option.value)}"${
          option.value === current ? " selected" : ""
        }>${esc(option.label)}</option>`,
    )
    .join("");
  return `<span class="mini-select" title="${esc(title)}">
    <select data-act="${act}">${body}</select>${icon("chevronDown")}</span>`;
}

export function segmented(act, options, current) {
  return `<span class="seg">${options
    .map(
      (option) =>
        `<button type="button" data-act="${act}" data-value="${esc(option.value)}"
          class="${option.value === current ? "active" : ""}">${esc(option.label)}</button>`,
    )
    .join("")}</span>`;
}

export function tabs(act, items, current) {
  return `<div class="tabs">${items
    .map(
      (item) =>
        `<button type="button" class="tab${
          item.value === current ? " active" : ""
        }" data-act="${act}" data-value="${esc(item.value)}">${esc(item.label)}${
          item.count === undefined ? "" : ` (${item.count})`
        }</button>`,
    )
    .join("")}</div>`;
}

export function iconButton(name, { act = "", title = "", value = "", small = false } = {}) {
  return `<button type="button" class="icon-btn${small ? " sm" : ""}"${
    act ? ` data-act="${act}"` : ""
  }${value ? ` data-value="${esc(value)}"` : ""} title="${esc(title)}" aria-label="${esc(
    title,
  )}">${icon(name)}</button>`;
}

export function statTile({ value, label, foot, iconName, tone = "purple" }) {
  const colors = {
    purple: "var(--accent-bright)",
    green: "var(--green)",
    blue: "var(--blue)",
    orange: "var(--orange)",
    red: "var(--red)",
  };
  return `<div class="card stat-tile">
    <span class="st-icon" style="color:${colors[tone]}">${icon(iconName)}</span>
    <span>
      <span class="st-value">${esc(value)}</span>
      <div class="st-label">${esc(label)}</div>
      ${foot === undefined ? "" : `<div class="st-foot">${foot}</div>`}
    </span>
  </div>`;
}

export function emptyState(iconName, title, body, action = "") {
  return `<div class="empty">${icon(iconName)}<b>${esc(title)}</b>
    <p>${esc(body)}</p>${action}</div>`;
}

/* -------------------------------------------------------------- time ---- */

export function relativeTime(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) {
    return "just now";
  }
  const units = [
    [60, "min"],
    [3600, "hour"],
    [86_400, "day"],
    [604_800, "week"],
    [2_592_000, "month"],
  ];
  let amount = seconds;
  let label = "sec";
  for (const [size, name] of units) {
    if (seconds >= size) {
      amount = Math.floor(seconds / size);
      label = name;
    }
  }
  return `${amount} ${label}${amount === 1 ? "" : "s"} ago`;
}

export function clockTime(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function elapsed(milliseconds) {
  const total = Math.max(0, Math.round((milliseconds || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/* ------------------------------------------------------------- toasts ---- */

export function toast(message, tone = "") {
  const host = $("#toasts");
  if (host === null) {
    return;
  }
  const node = document.createElement("div");
  node.className = cx("toast", tone);
  node.textContent = message;
  host.append(node);
  window.setTimeout(() => node.remove(), 4200);
}

/* -------------------------------------------------------------- modal ---- */

/** One application modal, as a native <dialog> so focus and Esc are free. */
export function showModal({ title, subtitle = "", body = "", confirm = "Confirm", cancel = "Cancel" }) {
  const dialog = $("#modal");
  return new Promise((resolve) => {
    dialog.innerHTML = `<form method="dialog" class="modal-card">
      <div>
        <h3>${esc(title)}</h3>
        ${subtitle ? `<p class="modal-sub">${esc(subtitle)}</p>` : ""}
      </div>
      ${body}
      <div class="modal-actions">
        <button class="btn" value="cancel" type="submit">${esc(cancel)}</button>
        <button class="btn btn-primary" value="confirm" type="submit">${esc(confirm)}</button>
      </div>
    </form>`;
    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      if (dialog.returnValue !== "confirm") {
        resolve(undefined);
        return;
      }
      const values = {};
      for (const field of $$("[name]", dialog)) {
        values[field.name] =
          field.type === "checkbox" ? field.checked : field.value;
      }
      resolve(values);
    };
    dialog.addEventListener("close", onClose);
    dialog.showModal();
  });
}

/** Anchored popover, used by the Code screen's Summary. */
export function showPopover(anchor, html, { width = 400 } = {}) {
  closePopover();
  const layer = document.createElement("div");
  layer.className = "pop-layer";
  layer.id = "pop-layer";
  layer.innerHTML = `<div class="pop-scrim" data-act="pop-close"></div>
    <div class="popover" role="dialog" style="width:${width}px">${html}</div>`;
  $("#layer-root").append(layer);

  const pop = $(".popover", layer);
  const box = anchor.getBoundingClientRect();
  const margin = 12;
  let left = box.right - width;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.min(box.bottom + 8, window.innerHeight - 80)}px`;

  layer.addEventListener("click", (event) => {
    if (event.target.closest("[data-act='pop-close']")) {
      closePopover();
    }
  });
  const onKey = (event) => {
    if (event.key === "Escape") {
      closePopover();
    }
  };
  document.addEventListener("keydown", onKey, { once: true });
  return pop;
}

export function closePopover() {
  $("#pop-layer")?.remove();
}
