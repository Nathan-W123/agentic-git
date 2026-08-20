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

/**
 * Whether this keydown is an IME committing a composition, not a keystroke
 * aimed at the app.
 *
 * Japanese, Chinese and Korean keyboards — and some Android predictive
 * ones — accept their current candidate with Enter. That press belongs to
 * the composition; an "Enter sends" handler that acts on it posts the
 * half-composed message mid-word. Every such handler checks here first.
 * `keyCode === 229` is the legacy spelling of the same fact, still what
 * some mobile engines report on every composing keystroke.
 */
export function imeComposing(event) {
  return event.isComposing === true || event.keyCode === 229;
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
  // Head and shoulders, the two of them deliberately the same silhouette so
  // the pair reads as one count of people beside one count of agents rather
  // than as two unrelated pictures. Square head and antenna for the agent,
  // round head for the person; nothing below the shoulders in either.
  personBust: S(
    '<circle cx="12" cy="8" r="3.4"/><path d="M5.5 19.5c0-3.3 2.9-5.6 6.5-5.6s6.5 2.3 6.5 5.6"/>',
  ),
  robotBust: S(
    '<rect x="6.6" y="5.2" width="10.8" height="8.4" rx="2.4"/><path d="M12 5.2V3"/><circle cx="12" cy="2.3" r="1"/><circle cx="9.8" cy="9.2" r="0.95" fill="currentColor" stroke="none"/><circle cx="14.2" cy="9.2" r="0.95" fill="currentColor" stroke="none"/><path d="M5.5 19.5c0-3.1 2.9-5.3 6.5-5.3s6.5 2.2 6.5 5.3"/>',
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
  // Deleting is the one action here that destroys something, so it gets its
  // own mark rather than borrowing the close cross — the two must not be a
  // slip apart.
  trash: S(
    '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/>',
  ),
  chevronDown: S('<path d="m6 9 6 6 6-6"/>'),
  chevronRight: S('<path d="m9 6 6 6-6 6"/>'),
  chevronUp: S('<path d="m6 15 6-6 6 6"/>'),
  arrowRight: S('<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>'),
  arrowLeft: S('<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>'),
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
  wand: S(
    '<path d="M4 20 13.5 10.5"/><path d="m16.5 4 .9 2.6L20 7.5l-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/><path d="M6 5.5v2.6M7.3 6.8H4.7"/><path d="M19 14.5v2.2M20.1 15.6h-2.2"/>',
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
  terminal: S(
    '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m6.5 9 3 3-3 3"/><path d="M13 15h4.5"/>',
  ),
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
  chatBubble: S(
    '<path d="M4 5.5h16v10.5H9l-4.5 4V16H4z" stroke-linejoin="round"/>',
  ),
  smile: S(
    '<circle cx="12" cy="12" r="9"/><path d="M8.3 14.2c1 1.3 2.3 2 3.7 2s2.7-.7 3.7-2"/><circle cx="8.7" cy="9.8" r="1" fill="currentColor" stroke="none"/><circle cx="15.3" cy="9.8" r="1" fill="currentColor" stroke="none"/>',
  ),
  reply: S('<path d="M9 8 4.5 12 9 16"/><path d="M4.5 12h9a6 6 0 0 1 6 6v1"/>'),
  // Two overlapping sheets — the clipboard glyph every surface uses for "take
  // these words with you". Drawn as one rounded rectangle behind another
  // rather than as a clipboard with a clasp: at 14px the clasp closes up into
  // a smudge and the pair of sheets stays readable.
  copy: S(
    '<rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5.5 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v.5"/>',
  ),
  pin: S(
    '<path d="M9.3 3.5h5.4l-.6 5.2 3.2 3.6H6.7l3.2-3.6z"/><path d="M12 12.3V20"/>',
  ),
  hash: S(
    '<path d="M9.5 3.5 6.8 20.5M17.2 3.5l-2.7 17M4 8.5h16M3 15.5h16"/>',
  ),
  pencil: S(
    '<path d="M4 20l.9-4.2L15.6 5.1a1.5 1.5 0 0 1 2.1 0l1.2 1.2a1.5 1.5 0 0 1 0 2.1L8.2 19.1z"/><path d="M14.3 6.4l3.3 3.3"/>',
  ),
};

export function icon(name, extra = "") {
  const glyph = ICONS[name] ?? ICONS.info;
  return extra === "" ? glyph : glyph.replace("<svg ", `<svg ${extra} `);
}

/**
 * The product mark: two loops woven through each other.
 *
 * A lattice is the interlocking, so the mark is the interlocking and nothing
 * else — no face, no badge, no enclosing shape. Two identical rounded loops
 * crossed at a right angle read as four lobes and a weave, which is the whole
 * idea in the fewest possible strokes.
 *
 * The weave is cut with a mask rather than drawn with a background-coloured
 * halo under the crossing strand. A halo has to know what colour it is sitting
 * on, and this mark sits on four different surfaces — the sidebar, the sign-in
 * card, the mobile header, a favicon — so it would be wrong on three of them.
 * The mask removes the pixels instead, which is true against anything.
 *
 * `currentColor` for the same reason: the mark takes the colour of the text
 * beside it, so it is white on dark and near-black on light without a second
 * definition, and carries no hue of its own.
 */
export function brandMark(size = 34) {
  return `<svg class="brand-mark" width="${size}" height="${size}"
    viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <defs>
      <mask id="brand-weave" maskUnits="userSpaceOnUse"
        x="0" y="0" width="48" height="48">
        <rect width="48" height="48" fill="#fff"/>
        <rect x="6" y="15.5" width="36" height="17" rx="8.5"
          transform="rotate(-45 24 24)" fill="none" stroke="#000"
          stroke-width="7.6"/>
      </mask>
    </defs>
    <rect x="6" y="15.5" width="36" height="17" rx="8.5"
      transform="rotate(45 24 24)" mask="url(#brand-weave)"
      stroke="currentColor" stroke-width="3.4"/>
    <rect x="6" y="15.5" width="36" height="17" rx="8.5"
      transform="rotate(-45 24 24)" stroke="currentColor" stroke-width="3.4"/>
  </svg>`;
}

/**
 * The vendor a given agent runs on, drawn as that vendor's own mark.
 *
 * These are the real marks, not drawings of them. Every entry but `generic` is
 * the official path data as published for third-party use — Simple Icons under
 * CC0 for Claude, OpenAI, Gemini, DeepSeek and Cursor, and LobeHub's AI-vendor
 * set under MIT for Grok. Vendored rather than linked: the dashboard has a
 * strict CSP and loads nothing from another host, and a logo that fails to
 * arrive is worse than one that is simply here.
 *
 * The trademarks belong to their owners. Their only use here is saying which
 * vendor an agent runs on, which is what published brand assets are for.
 *
 * Drawing them by hand was tried first and was wrong in the way approximation
 * is always wrong about a logo: the shapes were plausible and not one of them
 * was the mark. Anthropic's is not a sunburst; OpenAI's is not a rosette. When
 * a vendor is added, take its published SVG rather than sketching one.
 *
 * Monochrome and `currentColor` throughout, which is the one deliberate
 * departure from the official artwork: the face is drawn in its owner's
 * colour, so one glyph carries both facts — the shape says which vendor, the
 * colour says whose agent. Brand colours would spend the only channel that
 * can carry ownership.
 */
const VENDOR_MARKS = {
  // Claude — Simple Icons (CC0)
  anthropic: `<path fill="currentColor"
      d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l
      -.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255
      h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l
      -2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194
      c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l
      .9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255
      h.1579v-.1457l
      .1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429
      h.2125l
      .2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311
      h1.0321l
      .759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364
      h1.621l
      3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279
      h-.1822v.1093l
      1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621
      h-.1275v.17l
      .4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246
      L14.38 17.959l
      -1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579
      h-.0546l
      -6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114
      Z"/>`,
  // OpenAI — Simple Icons (CC0)
  openai: `<path fill="currentColor"
      d="M22.2819 9.8211a
      5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A
      6.0651 6.0651 0 0 0 4.9807 4.1818a
      5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001
      A5.9847 5.9847 0 0 0 13.2599 24a
      6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729
      zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l
      .1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l
      2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a
      4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a
      4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a
      .7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a
      .0804.0804 0 0 1-.0332.0615L9.74 19.9502a
      4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a
      4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l
      5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865
      A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L
      13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a
      4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm
      2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L
      9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a
      4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a
      .0804.0804 0 0 1-.038-.0567V6.0742a
      4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a
      .7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l
      2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>`,
  // Google Gemini — Simple Icons (CC0)
  google: `<path fill="currentColor"
      d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t
      3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a
      12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q
      0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q
      2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/>`,
  // Grok / xAI — LobeHub icons (MIT)
  xai: `<path fill-rule="evenodd" fill="currentColor"
      d="M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l
      2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L
      22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z"/>`,
  // DeepSeek — Simple Icons (CC0)
  deepseek: `<path fill="currentColor"
      d="M23.748 4.651c
      -.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14
      a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a
      12 12 0 0 0-.689-.47c
      -.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685
      a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c
      -1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c
      .403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257
      a4.2 4.2 0 0 0 1.545-.475c
      1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M
      11.58 18.168c
      -2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592
      a4.7 4.7 0 0 1 1.53-.038c
      2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615
      zm1.001-6.44a
      .306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c
      0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c
      -.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c
      -.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c
      .07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a
      .6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c
      .356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45"/>`,
  // Cursor — Simple Icons (CC0)
  cursor: `<path fill="currentColor"
      d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c
      0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a
      .84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a
      1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L
      12.23 22.918c-.062.107-.229.064-.229-.06V12.335a
      .59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"/>`,
  // Anything this deployment can run but has no mark for. Ours to draw,
  // because there is no vendor to be faithful to.
  generic: `<g stroke="currentColor" stroke-width="1.7" fill="none"
      stroke-linecap="round" stroke-linejoin="round">
      <rect x="4.5" y="8" width="15" height="11" rx="3"/>
      <path d="M12 8V4.8"/><circle cx="12" cy="3.7" r="1.2"/>
      <circle cx="9.4" cy="13" r="1.05" fill="currentColor" stroke="none"/>
      <circle cx="14.6" cy="13" r="1.05" fill="currentColor" stroke="none"/>
    </g>`,
};

/** One vendor's mark, sized by whatever contains it. */
export function vendorMark(kind) {
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">${
    VENDOR_MARKS[kind] ?? VENDOR_MARKS.generic
  }</svg>`;
}

/* -------------------------------------------------------- colour wheel ---- */

/**
 * Hex to HSL, and back.
 *
 * The wheel works in HSL because that is what a wheel *is* — angle is hue,
 * radius is saturation — and everything the app stores is hex, because that
 * is what a colour input and a CSS variable both understand. These two are
 * the only translation between the picker and the record.
 */
export function hexToHsl(hex) {
  const value = /^#([0-9a-f]{6})$/iu.exec(String(hex ?? "").trim());
  if (value === null) {
    return { h: 0, s: 0, l: 0.5 };
  }
  const int = Number.parseInt(value[1], 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const span = max - min;
  if (span === 0) {
    return { h: 0, s: 0, l };
  }
  const s = span / (l > 0.5 ? 2 - max - min : max + min);
  const h =
    max === r
      ? (g - b) / span + (g < b ? 6 : 0)
      : max === g
        ? (b - r) / span + 2
        : (r - g) / span + 4;
  return { h: h * 60, s, l };
}

export function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(Math.max(s, 0), 1);
  const light = Math.min(Math.max(l, 0), 1);
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];
  const byte = (value) =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/**
 * A colour wheel, and the lightness the wheel cannot show.
 *
 * A disc rather than a row of swatches, because eight presets are somebody
 * else's taste and the question "what colour is yours" has more than eight
 * answers. Hue around, saturation out from the middle: the two things a
 * wheel is for, drawn with a conic gradient and a radial white wash rather
 * than a canvas, so it costs no script to paint and scales to any size.
 *
 * Lightness is a slider under it, because a flat disc has no third axis and
 * pretending otherwise — the usual trick of dimming the whole wheel — makes
 * the same click mean different things at different times.
 *
 * The native input stays, small, beside them. It is the only control here
 * that can be typed into, pasted into, or driven by a screen reader, and a
 * wheel that cannot accept "#3fa8b5" from somebody's brand guide is a toy.
 */
export function colorWheel(act, current) {
  const { h, s, l } = hexToHsl(current);
  // Marker position: hue is the angle, saturation the distance out. Measured
  // from twelve o'clock to match the gradient's own zero.
  const angle = ((h - 90) * Math.PI) / 180;
  const left = 50 + Math.cos(angle) * s * 50;
  const top = 50 + Math.sin(angle) * s * 50;
  return `<div class="wheel-row">
    <div class="wheel" data-act="${esc(act)}-wheel" role="presentation">
      <span class="wheel-mark" style="left:${left.toFixed(2)}%;top:${top.toFixed(
        2,
      )}%;background:${esc(current)}"></span>
    </div>
    <div class="wheel-side">
      <input type="range" class="wheel-light" min="12" max="88"
        value="${Math.round(l * 100)}" data-act="${esc(act)}-light"
        style="accent-color:${esc(current)}"
        aria-label="Lightness">
      <label class="wheel-exact">
        <input type="color" value="${esc(current)}" data-act="${esc(act)}-exact"
          aria-label="Exact colour">
        <code>${esc(current)}</code>
      </label>
    </div>
  </div>`;
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

export function avatar(name, size = 26, seed = name, picture) {
  // A picture replaces the initials rather than sitting beside them: the
  // initials only exist because there is no picture.
  // The size travels inline as well as in the class, for the same reason
  // `agentFace` stopped relying on the class alone: `sz-${size}` only ever
  // worked for the sizes somebody had hand-written a rule for — 20, 26, 32 and
  // 38 — while callers ask for 20, 30, 32 and 40. The two without a rule had no
  // dimensions at all, so a person's avatar collapsed next to an agent's face
  // of the nominal same size, which is the mismatch this fixes. Inline wins
  // over the class, so the existing rules stay correct where they apply.
  const box = `width:${Number(size)}px;height:${Number(size)}px`;
  if (typeof picture === "string" && picture !== "") {
    return `<span class="avatar sz-${size} has-photo" style="${box}" title="${esc(
      name,
    )}"><img src="${esc(picture)}" alt=""></span>`;
  }
  return `<span class="avatar sz-${size}" style="${box};background:${hueFor(seed)}" title="${esc(
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
  copilot: { label: "Copilot", doodle: "generic" },
  kiro: { label: "Kiro", doodle: "generic" },
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
  copilot: "copilot",
  kiro: "kiro",
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
  // The vendor's own mark rather than a drawn character: an agent running on
  // Claude shows Claude's, one running on Codex shows Codex's, and a reader
  // recognises them without having to learn anything. The owner's colour still
  // carries the mark, so one glyph says both things — the shape says which
  // vendor, the colour says whose.
  //
  // The size travels as a custom property rather than as an `sz-${size}`
  // class. The class only ever worked for sizes somebody had hand-written a
  // rule for — 28, 34 and 40 — and callers ask for 20, 24, 30 and 32 as well.
  // Those had no rule at all, so the SVG had nothing bounding it and grew to
  // fill its container: a 30px face rendered 300px wide and made the chats
  // roster unnavigable. A number that has to be mirrored in a stylesheet to
  // mean anything is not a size argument, it is a trap.
  return `<span class="agent-face" data-kind="${kind}"
    data-presence="${presence}" style="color:${color};--face-size:${Number(size)}px"
    title="${esc(
      agent?.name ?? AGENTS[kind].label,
    )}">${vendorMark(kind)}<i class="presence presence-${presence}"></i></span>`;
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
  /* A conversational task whose turn landed, waiting for the next message —
     live rather than finished, so blue like the working states. */
  open: "blue",
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
  // A setting the list does not contain still has to show as itself. A
  // `<select>` whose options match nothing displays the first one, so an agent
  // configured `xhigh` against a list that stopped at `high` rendered as
  // "Low" — the control quietly misreporting the one thing it exists to
  // report, and turning a glance at it into a silent downgrade on the next
  // save. Shown at the top, marked, so the value is visible and still
  // replaceable.
  const known = options.some((option) => option.value === current);
  const shown =
    current === "" || current === undefined || known
      ? options
      : [{ value: current, label: `${current} (set)` }, ...options];
  const body = shown
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

/**
 * `cls` is for the handful of icon buttons that are not one of a row.
 *
 * A panel's close button is the example: it does the same thing every icon
 * button does, but it is the one control a reader looks for when a surface is
 * covering what they were reading, and it earns a treatment the tools beside
 * it do not get. Cheaper than a second near-identical helper.
 */
export function iconButton(
  name,
  { act = "", title = "", value = "", small = false, cls = "" } = {},
) {
  return `<button type="button" class="icon-btn${small ? " sm" : ""}${
    cls ? ` ${cls}` : ""
  }"${act ? ` data-act="${act}"` : ""}${
    value ? ` data-value="${esc(value)}"` : ""
  } title="${esc(title)}" aria-label="${esc(title)}">${icon(name)}</button>`;
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

/* ------------------------------------------------------- panel shapes ---- */

/**
 * A labelled rail: a quiet label on the left, its content beside it.
 *
 * The shape a page reaches for when a row needs saying what it *is* without
 * spending a heading on it. The labels stack into one narrow column down the
 * left, so the eye reads the contents as a list of properties rather than as
 * a stack of unrelated widgets, and nothing has to be bordered off to be
 * legible.
 */
export function sectionRail(label, body, { stacked = false } = {}) {
  return `<div class="rail${stacked ? " stacked" : ""}">
    <span class="rail-label">${esc(label)}</span>
    <span class="rail-body">${body}</span>
  </div>`;
}

/**
 * A run of chips on one line, wrapping, with anything trailing kept last.
 *
 * Each item is either a plain string or `{label, iconName, tone, title, act,
 * value}`; an item with an `act` is a control rather than a label, and is
 * rendered as a real button so it is reachable from the keyboard. `trailing`
 * is for the "+ Add" affordance that belongs at the end of the run.
 */
export function chipRow(items, trailing = "") {
  const body = items
    .filter((item) => item !== undefined && item !== null && item !== "")
    .map((item) => {
      if (typeof item === "string") {
        return `<span class="chip lg"><span>${esc(item)}</span></span>`;
      }
      const tone = item.tone === undefined ? "" : ` ${item.tone}`;
      const glyph = item.iconName === undefined ? "" : icon(item.iconName);
      const title = item.title === undefined ? "" : ` title="${esc(item.title)}"`;
      const inner = `${glyph}<span>${esc(item.label)}</span>`;
      return item.act === undefined
        ? `<span class="chip lg${tone}"${title}>${inner}</span>`
        : `<button type="button" class="chip lg${tone}" data-act="${esc(item.act)}"${
            item.value === undefined ? "" : ` data-value="${esc(item.value)}"`
          }${title}>${inner}</button>`;
    })
    .join("");
  return `<span class="chip-row">${body}${trailing}</span>`;
}

/**
 * One tile in a grid of them: a glyph, a title, a line about it, and a foot.
 *
 * `title` is escaped here; `subtitle`, `foot` and `trailing` are markup, so
 * whatever a caller puts in them escapes its own text. A div rather than a
 * button, for the same reason the agent rows are: a tile carries its own
 * controls, and a nested `<button>` is hoisted out of the outer one by the
 * parser — taking the tile's own click target with it.
 */
export function tileCard({
  glyph = "",
  iconName,
  title,
  subtitle = "",
  foot = "",
  trailing = "",
  tone = "",
  act,
  value = "",
  active = false,
}) {
  const head =
    glyph !== ""
      ? glyph
      : iconName === undefined
        ? ""
        : `<span class="tile-icon${tone === "" ? "" : ` ${tone}`}">${icon(iconName)}</span>`;
  return `<div class="tile${active ? " active" : ""}"${
    act === undefined
      ? ""
      : ` role="button" tabindex="0" data-act="${esc(act)}" data-value="${esc(value)}"`
  }>
    ${
      head === "" && trailing === ""
        ? ""
        : `<div class="tile-head">${head}<span class="tile-spacer"></span>${trailing}</div>`
    }
    <div class="tile-title">${esc(title)}</div>
    ${subtitle === "" ? "" : `<div class="tile-sub">${subtitle}</div>`}
    ${foot === "" ? "" : `<div class="tile-foot">${foot}</div>`}
  </div>`;
}

/**
 * The last tile in a grid — the one that adds another of whatever the grid
 * holds. `compact` renders it as the chip-sized version, for the end of a
 * `chipRow` rather than the end of a grid.
 */
export function addTile({ title, subtitle = "", act, value = "", compact = false }) {
  const target = `data-act="${esc(act)}"${value === "" ? "" : ` data-value="${esc(value)}"`}`;
  if (compact) {
    return `<button type="button" class="chip lg add" ${target}>${icon("plus")}<span>${esc(
      title,
    )}</span></button>`;
  }
  return `<button type="button" class="tile add" ${target}>
    <span class="tile-icon">${icon("plus")}</span>
    <span class="tile-title">${esc(title)}</span>
    ${subtitle === "" ? "" : `<span class="tile-sub">${esc(subtitle)}</span>`}
  </button>`;
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
/**
 * A top-right banner for something that just happened — "Zeus completed a
 * task" — that says its sentence and leaves. Reuses the alert host's corner
 * because that is where eyes already look for news; unlike an error it holds
 * no focus and clears itself after five seconds and a fade.
 *
 * There is only ever one. News that arrives while a banner is up replaces it
 * rather than queueing beneath it: a column of them covered the screen of the
 * phone it was meant to inform, and the notifications tab is where the whole
 * list belongs anyway. It closes on a tap as well, because five seconds is a
 * long time to have something in front of the thing you opened the app for.
 */
export function banner(message) {
  const host = $("#toasts-alert");
  if (host === null) {
    return;
  }
  for (const previous of host.querySelectorAll(".toast.banner")) {
    previous.remove();
  }
  const node = document.createElement("div");
  node.className = "toast banner";
  const line = document.createElement("span");
  line.textContent = message;
  node.append(line);
  const dismiss = document.createElement("button");
  dismiss.className = "toast-close";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.textContent = "×";
  dismiss.addEventListener("click", () => node.remove());
  node.append(dismiss);
  host.append(node);
  window.setTimeout(() => {
    node.classList.add("banner-out");
    window.setTimeout(() => node.remove(), 600);
  }, 5000);
}

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
        <button class="btn" value="cancel" type="submit" formnovalidate>${esc(cancel)}</button>
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
  const gap = 8;
  const popHeight = pop.getBoundingClientRect().height;
  const below = box.bottom + gap;
  const above = box.top - popHeight - gap;
  const maxTop = Math.max(margin, window.innerHeight - popHeight - margin);
  // Prefer the usual position below the control, but flip the popover above
  // controls near the bottom of the viewport. Clamping only the top edge left
  // most of a bottom-anchored menu outside the screen because its own height
  // was never part of the calculation.
  const top =
    below + popHeight <= window.innerHeight - margin
      ? below
      : above >= margin
        ? above
        : Math.max(margin, Math.min(below, maxTop));
  pop.style.top = `${top}px`;

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
 *
 * `danger: true` marks the one item in a menu that destroys something. It is
 * a flag rather than a caller-supplied class so that every destructive entry
 * in the app is the same red — the colour is what tells somebody, before they
 * click, that this item is not like the others.
 *
 * A `hint` is the second line under a label, for the menus that offer a
 * choice rather than a command and would otherwise need the reader to already
 * know the difference.
 */
export function showMenu(anchor, items) {
  const body = items
    .map((item) =>
      item.separator === true
        ? `<div class="menu-sep"></div>`
        : `<button type="button" class="menu-item${
            item.danger === true ? " menu-item-danger" : ""
          }" data-act="${item.act}"${
            item.value === undefined ? "" : ` data-value="${esc(item.value)}"`
          }${item.disabled === true ? " disabled" : ""}>${
            item.iconName === undefined ? "" : icon(item.iconName)
          }<span class="menu-item-text"><span class="menu-item-label">${esc(
            item.label,
          )}</span>${
            item.hint === undefined
              ? ""
              : `<span class="menu-item-hint">${esc(item.hint)}</span>`
          }</span></button>`,
    )
    .join("");
  return showPopover(anchor, `<div class="menu">${body}</div>`, { width: 216 });
}

/** How long `.pop-closing` is given before the layer is dropped, in ms. */
const POP_EXIT_MS = 200;

export function closePopover() {
  const open = $("#pop-layer");
  if (open === null) {
    return;
  }
  // Held for the length of its exit rather than removed on the spot. A popup
  // that eases in over a handful of frames and then vanishes between two of
  // them reads as a glitch rather than as a dismissal, and there is nothing
  // the stylesheet can do about it once the element is gone.
  //
  // The id goes first, which is what takes the layer out of circulation: this
  // function finds the open popover by id, and so does the code that refreshes
  // a live one, so a second Escape — or the `closePopover()` at the top of
  // `showPopover`, opening the next menu straight from this one — finds
  // nothing and starts nothing. `inert` does the same for the reader: a
  // surface that is on its way out should not still be holding focus or
  // answering to a stray Tab.
  open.removeAttribute("id");
  open.classList.add("pop-closing");
  open.inert = true;
  window.setTimeout(() => open.remove(), POP_EXIT_MS);
  popoverReturn?.focus();
  popoverReturn = undefined;
}

/* ----------------------------------------------------------------- sound ---- */

/**
 * A short tone when a message goes out.
 *
 * Synthesised rather than played from a file: the page's CSP allows no
 * external asset, and two oscillator notes cost nothing to ship and nothing
 * to load. The context is created on first use, which is always inside a
 * click or a keypress — a browser refuses to start audio any earlier, and
 * building it at import time would leave it permanently suspended.
 *
 * Failure is silent on purpose. A blocked or unavailable audio device is not
 * a reason to interrupt somebody who was only sending a message.
 */
let toneContext;

export function chime(kind = "sent") {
  try {
    const Context = window.AudioContext ?? window.webkitAudioContext;
    if (Context === undefined) {
      return;
    }
    toneContext ??= new Context();
    void toneContext.resume?.();
    const at = toneContext.currentTime;
    // Sent rises, received falls, so the two are told apart without looking.
    const notes = kind === "received" ? [660, 495] : [523.25, 784];
    for (const [index, frequency] of notes.entries()) {
      const oscillator = toneContext.createOscillator();
      const gain = toneContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      // Quiet, and shaped: a square-edged tone at full volume is a beep
      // somebody will turn off within the hour.
      const start = at + index * 0.07;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.055, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
      oscillator.connect(gain).connect(toneContext.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.14);
    }
  } catch {
    /* No audio device, or a policy that forbids it. Not worth reporting. */
  }
}
