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

/**
 * The product mark: a small character rather than a geometric logo.
 *
 * Lattice's whole subject is agents working alongside people, so the mark is
 * one of the same doodles the agents are drawn with — the lattice it sits in
 * is the coordination, and the face is what is being coordinated.
 */
export function brandMark(size = 34) {
  return `<svg class="brand-mark" width="${size}" height="${size}" viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <path d="M20 3.2 34 11v18l-14 7.8L6 29V11z" fill="var(--accent-wash)"
      stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M13.5 15.5h13a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z"
      fill="none" stroke="var(--accent)" stroke-width="1.6"/>
    <path d="M20 11.4v4.1" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="20" cy="10.4" r="1.5" fill="var(--accent-bright)"/>
    <circle cx="16.6" cy="19.9" r="1.5" fill="var(--accent-bright)"/>
    <circle cx="23.4" cy="19.9" r="1.5" fill="var(--accent-bright)"/>
    <path d="M17.4 23.2c1.6 1 3.6 1 5.2 0" stroke="var(--accent-bright)"
      stroke-width="1.5" stroke-linecap="round"/>
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
 * Agent identity is two independent signals.
 *
 * The **doodle** says which agent it is — Claude, Codex, Gemini, Grok,
 * DeepSeek, or an unrecognised one. The **colour** says whose agent it is, and
 * is the owner's chosen colour, not the vendor's. On a shared view that means
 * every blue doodle belongs to one person and every pink doodle to another,
 * while the faces still tell you what kind of agent each one is. Tying colour
 * to the vendor instead would waste the only channel that can answer "whose?".
 */
export const AGENTS = {
  anthropic: { label: "Claude", doodle: "claude" },
  cursor: { label: "Cursor", doodle: "cursor" },
  openai: { label: "Codex", doodle: "codex" },
  google: { label: "Gemini", doodle: "gemini" },
  xai: { label: "Grok", doodle: "grok" },
  deepseek: { label: "DeepSeek", doodle: "deepseek" },
  generic: { label: "Agent", doodle: "generic" },
};

/** Aliases, so a task's free-form agent id still finds the right face. */
const AGENT_ALIASES = {
  claude: "anthropic",
  cursor: "cursor",
  codex: "openai",
  gpt: "openai",
  gemini: "google",
  grok: "xai",
  deepseek: "deepseek",
};

export function agentKindOf(id) {
  const text = String(id ?? "").toLowerCase();
  if (AGENTS[text] !== undefined) {
    return text;
  }
  for (const [needle, kind] of Object.entries(AGENT_ALIASES)) {
    if (text.includes(needle)) {
      return kind;
    }
  }
  return "generic";
}

export function agentLabelOf(id) {
  return AGENTS[agentKindOf(id)].label;
}

/**
 * The agent characters, as 16x16 pixel sprites.
 *
 * Written as pixel maps rather than as paths because that is what they are:
 * the grid is the drawing, and editing a face means editing a character in a
 * string rather than nudging bezier handles.
 *
 * Three tones, all of them the *same* colour at different opacities, which is
 * what lets one sprite be re-tinted to any owner colour without going muddy.
 * Features are cut out to transparency rather than painted dark, so a face
 * reads correctly on whatever surface it sits on.
 *
 *   `+` highlight   `#` base   `-` shadow   `.` transparent
 */
const SPRITES = {
  claude: [
    "......^..^......",
    ".......^^.......",
    ".......^^.......",
    "....++++++++....",
    "...##########...",
    "..############..",
    "#####..##..#####",
    "################",
    "..############..",
    "..####....####..",
    "...##########...",
    "....--------....",
    "..############..",
    ".~~.########.~~.",
    "..############..",
    "....##....##....",
  ],
  cursor: [
    ".......^^.......",
    ".......^^.......",
    ".......^^.......",
    "..++++++++++++..",
    "..#..........#..",
    "..#..!!..!!..#..",
    "..#..!!..!!..#..",
    "..#..........#..",
    "..############..",
    "....--------....",
    ".#..########..#.",
    ".#.##########.#.",
    ".#.###....###.#.",
    "...##########...",
    "...##------##...",
    "...##......##...",
  ],
  codex: [
    ".......^^.......",
    ".......^^.......",
    ".......^^.......",
    "..############..",
    "..############..",
    "..############..",
    "#####..##..#####",
    "#####..##..#####",
    "..############..",
    "..###......###..",
    "..############..",
    "....--------....",
    "..############..",
    "~.##..####..##.~",
    "~.##..####..##.~",
    "...##......##...",
  ],
  gemini: [
    ".......##.......",
    ".......##.......",
    "..*...####...*..",
    "......####......",
    ".....######.....",
    "....########....",
    "..###..##..###..",
    "#####..##..#####",
    "################",
    "..####....####..",
    "....########....",
    ".....######.....",
    "..*...####...*..",
    "......####......",
    ".......##.......",
    ".......##.......",
  ],
  grok: [
    ".......^........",
    ".......^........",
    ".......^........",
    "....########....",
    "...##########...",
    "..############..",
    "..##.######.##..",
    "..###.####.###..",
    "..##.######.##..",
    "..############..",
    "...##########...",
    "....--------....",
    "..#######!!###..",
    "..#####!!#####..",
    "..###!!#######..",
    "...##......##...",
  ],
  deepseek: [
    "......^...**....",
    "......^....*....",
    "......^.........",
    "....++++++++....",
    "..############..",
    ".##############.",
    "################",
    "###..######..###",
    "################",
    "..####....####..",
    ".##############.",
    "..############..",
    "..~..~.~~.~..~..",
    "..~..~.~~.~..~..",
    "..~..~....~..~..",
    ".....~....~.....",
  ],
  generic: [
    "................",
    ".......^^.......",
    ".......^^.......",
    "...++++++++++...",
    "..############..",
    "..############..",
    "#####..##..#####",
    "################",
    "..############..",
    "..###......###..",
    "...##########...",
    "....--------....",
    "..############..",
    ".##.########.##.",
    "..############..",
    "....##....##....",
  ],
};

/**
 * What each glyph paints, and whether it moves.
 *
 * Motion is declared in the drawing rather than bolted on afterwards: the
 * antenna pixels are the ones that bob, so a character's movement can never
 * drift out of step with its shape.
 */
const PIXELS = {
  "+": { alpha: 1 },
  "#": { alpha: 0.85 },
  "-": { alpha: 0.5 },
  "^": { alpha: 0.85, part: "bob" },
  "*": { alpha: 1, part: "twinkle" },
  "~": { alpha: 0.85, part: "sway" },
  "!": { alpha: 1, part: "glow" },
};

/**
 * Where each character's eyes are, so a lid can be drawn over them.
 *
 * Eyes are holes in the sprite, not marks on it, which means a blink cannot be
 * animated directly — there is nothing there to move. A lid in the body colour
 * flashed over the hole closes the eye instead. Cursor is absent on purpose:
 * its eyes are lit rectangles, so they flicker rather than blink.
 */
const EYELIDS = {
  claude: [5, 6, 6, 1],
  codex: [5, 6, 6, 2],
  gemini: [5, 6, 6, 2],
  grok: [4, 6, 8, 3],
  deepseek: [3, 7, 10, 1],
  generic: [5, 6, 6, 1],
};

/**
 * Turns a pixel map into rects, merging horizontal runs of one glyph.
 *
 * A naive rect-per-pixel sprite is 150-odd nodes and these render at every row
 * of every list, so merging cuts that by roughly four without changing a
 * pixel. Moving parts are grouped, so one animation drives a whole limb
 * instead of each of its pixels separately.
 */
function spriteSvg(name) {
  const rows = SPRITES[name] ?? SPRITES.generic;
  const still = [];
  const parts = new Map();
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const glyph = row[x];
      const pixel = PIXELS[glyph];
      if (pixel === undefined) {
        x += 1;
        continue;
      }
      let width = 1;
      while (row[x + width] === glyph) {
        width += 1;
      }
      const rect =
        `<rect x="${x}" y="${y}" width="${width}" height="1" fill="currentColor"` +
        (pixel.alpha === 1 ? "" : ` fill-opacity="${pixel.alpha}"`) +
        "/>";
      if (pixel.part === undefined) {
        still.push(rect);
      } else {
        parts.set(pixel.part, (parts.get(pixel.part) ?? "") + rect);
      }
      x += width;
    }
  });

  const moving = [...parts]
    .map(([part, body]) => `<g class="sp-${part}">${body}</g>`)
    .join("");
  const lid = EYELIDS[name];
  const blink =
    lid === undefined
      ? ""
      : `<rect class="sp-blink" x="${lid[0]}" y="${lid[1]}" width="${lid[2]}"` +
        ` height="${lid[3]}" fill="currentColor" fill-opacity="0.85"/>`;
  return still.join("") + moving + blink;
}

/** Rendered once per character; the markup never changes, only its colour. */
const SPRITE_CACHE = new Map();

export function providerOf(id) {
  const kind = agentKindOf(id);
  return { label: AGENTS[kind].label, doodle: kind };
}

/**
 * The doodle alone, at whatever colour the caller sets on it.
 *
 * The lookup goes through `AGENTS[...].doodle` rather than indexing `DOODLES`
 * by the agent key: the two are deliberately named differently (`anthropic`
 * the provider, `claude` the character), and indexing one with the other's key
 * silently yields the fallback face for every agent.
 */
export function agentDoodle(kind) {
  const name = AGENTS[agentKindOf(kind)].doodle;
  if (!SPRITE_CACHE.has(name)) {
    SPRITE_CACHE.set(name, spriteSvg(name));
  }
  // crispEdges keeps the pixels square at every size; without it the browser
  // smooths the grid away and the sprite reads as a blurry blob.
  return `<svg viewBox="0 0 16 16" shape-rendering="crispEdges"
    aria-hidden="true">${SPRITE_CACHE.get(name)}</svg>`;
}

/**
 * One agent, as its owner's colour.
 *
 * `agent.color` is the owner's identity colour; callers pass the colour of
 * whoever the agent belongs to, which is what makes a shared view legible.
 */
export function agentFace(agent, size = 34) {
  const kind = agentKindOf(agent?.provider ?? agent?.id);
  const presence = agent?.presence ?? "offline";
  const color = safeColor(agent?.color) ?? "var(--accent)";
  // The kind and presence are on the element so the stylesheet can give each
  // character its own tempo and hold a disconnected one perfectly still.
  return `<span class="agent-face sz-${size}" data-kind="${kind}"
    data-presence="${presence}" style="color:${color}" title="${esc(
      agent?.name ?? AGENTS[kind].label,
    )}">${agentDoodle(kind)}<i class="presence presence-${presence}"></i></span>`;
}

/**
 * Colours reaching a `style` attribute are validated here as well as at the
 * API: this module also renders values that never made a round trip.
 */
export function safeColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value.trim())
    ? value.trim().toLowerCase()
    : undefined;
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

/**
 * A transient message — except when it is an error.
 *
 * A failure that erases itself after four seconds is a failure nobody can act
 * on, so errors stay until dismissed and are announced assertively. Anything
 * else is incidental and clears itself.
 */
export function toast(message, tone = "") {
  const host = $(tone === "error" ? "#toasts-alert" : "#toasts");
  if (host === null) {
    return;
  }
  const node = document.createElement("div");
  node.className = cx("toast", tone);
  node.textContent = message;
  if (tone === "error") {
    const dismiss = document.createElement("button");
    dismiss.className = "toast-close";
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", () => node.remove());
    node.append(dismiss);
  } else {
    window.setTimeout(() => node.remove(), 4200);
  }
  host.append(node);
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

/** Where focus goes when the popover closes. */
let popoverReturn;

/** Anchored popover, used by the Code screen's Summary. */
export function showPopover(anchor, html, { width = 400 } = {}) {
  closePopover();
  // Remembered so focus can go back where it came from: a popover that dumps
  // focus at the top of the document strands anyone navigating by keyboard.
  popoverReturn = anchor instanceof HTMLElement ? anchor : undefined;
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
  // Focus moves into the popover, and Tab is kept inside it while it is open.
  const focusable = () =>
    $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', pop)
      .filter((node) => !node.disabled);
  focusable()[0]?.focus();
  layer.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closePopover();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const nodes = focusable();
    if (nodes.length === 0) {
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  return pop;
}

/**
 * A short menu, anchored to the control that opened it.
 *
 * Exists so a "..." button has somewhere real to go. Items are ordinary
 * delegated actions, so a menu entry behaves exactly like the button it
 * stands in for.
 */
export function showMenu(anchor, items) {
  const body = items
    .map((item) =>
      item.separator === true
        ? `<div class="menu-sep"></div>`
        : `<button type="button" class="menu-item" data-act="${item.act}"${
            item.value === undefined ? "" : ` data-value="${esc(item.value)}"`
          }${item.disabled === true ? " disabled" : ""}>${
            item.iconName === undefined ? "" : icon(item.iconName)
          }<span>${esc(item.label)}</span></button>`,
    )
    .join("");
  return showPopover(anchor, `<div class="menu">${body}</div>`, { width: 216 });
}

export function closePopover() {
  const open = $("#pop-layer");
  if (open === null) {
    return;
  }
  open.remove();
  popoverReturn?.focus();
  popoverReturn = undefined;
}
