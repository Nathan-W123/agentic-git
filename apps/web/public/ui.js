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
 * The local subset of Basil Icons selected for Kumi's interface.
 *
 * Basil is by Zaid Bin Sayeed and published to the Figma community under
 * CC BY 4.0:
 * https://www.figma.com/community/file/1219493694635474558
 * https://creativecommons.org/licenses/by/4.0/
 *
 * It replaces the line set the interface used before, wholesale rather than
 * icon by icon: half a set is worse than either whole one, because the eye
 * reads the difference in weight long before it reads the picture. Basil's
 * marks sit large in the box with soft, generous corners and one light
 * rounded stroke, which is the friendlier register this product wanted.
 *
 * Only the geometry the product uses is kept inline, so the marks stay
 * instant and available when the control plane is offline. The shared wrapper
 * preserves Basil's 24px grid, 1.8px rounded stroke and `currentColor`
 * behaviour, while keeping every interface mark decorative to assistive
 * technology. Product-only concepts (agents and the Kumi network) use that
 * same grid and optical weight rather than introducing a second visual
 * language, and the two vendor marks here — GitHub and Google — stay their
 * owners' published artwork, because a logo redrawn in somebody else's style
 * is no longer the logo.
 */
const S = (body, extra = "") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" data-icon-style="basil" data-icon-source="basil-icons-community"${extra}>${body}</svg>`;

export const ICONS = {
  home: S(
    '<path d="M3.8 10.6 12 4.1l8.2 6.5v8.1a1.8 1.8 0 0 1-1.8 1.8H5.6a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M9.6 20.5v-5a2.4 2.4 0 0 1 4.8 0v5"/>',
  ),
  folder: S(
    '<path d="M3.2 8.2A2.8 2.8 0 0 1 6 5.4h2.7c.6 0 1.2.2 1.7.6l1.5 1.2h6.1a2.8 2.8 0 0 1 2.8 2.8v6.6a2.8 2.8 0 0 1-2.8 2.8H6a2.8 2.8 0 0 1-2.8-2.8z"/>',
  ),
  code: S(
    '<path d="M8.4 8.2 4.2 12l4.2 3.8"/><path d="m15.6 8.2 4.2 3.8-4.2 3.8"/><path d="m13.4 6-2.8 12"/>',
  ),
  robot: S(
    '<rect x="3.4" y="7.4" width="17.2" height="12.4" rx="4.6"/><path d="M12 7.4V4.7"/><circle cx="12" cy="3.5" r="1.2"/><circle cx="9" cy="12.8" r="1.25" fill="currentColor" stroke="none"/><circle cx="15" cy="12.8" r="1.25" fill="currentColor" stroke="none"/><path d="M9.9 16.4h4.2"/>',
  ),
  // Head and shoulders, the two of them deliberately the same silhouette so
  // the pair reads as one count of people beside one count of agents rather
  // than as two unrelated pictures. Soft-cornered head and antenna for the
  // agent, round head for the person; nothing below the shoulders in either.
  personBust: S(
    '<circle cx="12" cy="7.9" r="3.6"/><path d="M4.9 20.1c0-3.5 3.2-5.7 7.1-5.7s7.1 2.2 7.1 5.7"/>',
  ),
  robotBust: S(
    '<rect x="6.4" y="5" width="11.2" height="8.6" rx="3.2"/><path d="M12 5V3.1"/><circle cx="12" cy="2.4" r="1"/><circle cx="9.7" cy="9.2" r="1.05" fill="currentColor" stroke="none"/><circle cx="14.3" cy="9.2" r="1.05" fill="currentColor" stroke="none"/><path d="M4.9 20.1c0-3.3 3.2-5.4 7.1-5.4s7.1 2.1 7.1 5.4"/>',
  ),
  network: S(
    '<circle cx="12" cy="12" r="3.2"/><circle cx="4.8" cy="5.8" r="2.2"/><circle cx="19.2" cy="5.8" r="2.2"/><circle cx="12" cy="20.1" r="2.2"/><path d="m6.5 7.3 3.2 2.6M17.5 7.3l-3.2 2.6M12 15.2v2.7"/>',
  ),
  bell: S(
    '<path d="M6.3 10.5a5.7 5.7 0 0 1 11.4 0c0 4 1.4 5.3 2 6.1H4.3c.6-.8 2-2.1 2-6.1Z"/><path d="M9.9 19.3a2.3 2.3 0 0 0 4.2 0"/>',
  ),
  gear: S(
    '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  ),
  search: S('<circle cx="10.9" cy="10.9" r="6.5"/><path d="m15.7 15.7 3.9 3.9"/>'),
  plus: S('<path d="M12 5.4v13.2M5.4 12h13.2"/>'),
  close: S('<path d="M17.6 6.4 6.4 17.6M6.4 6.4l11.2 11.2"/>'),
  // Deleting is the one action here that destroys something, so it gets its
  // own mark rather than borrowing the close cross — the two must not be a
  // slip apart.
  trash: S(
    '<path d="M4.4 6.7h15.2"/><path d="M9.4 6.7V5.4A1.6 1.6 0 0 1 11 3.8h2a1.6 1.6 0 0 1 1.6 1.6v1.3"/><path d="m6.5 6.7.8 11.5a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-11.5"/><path d="M10.4 10.6v5.3M13.6 10.6v5.3"/>',
  ),
  chevronDown: S('<path d="m7.4 10 4.6 4.4L16.6 10"/>'),
  chevronRight: S('<path d="m10 7.4 4.4 4.6L10 16.6"/>'),
  chevronUp: S('<path d="m7.4 14 4.6-4.4L16.6 14"/>'),
  arrowRight: S('<path d="M4.4 12h15.2"/><path d="m13.4 6.2 5.8 5.8-5.8 5.8"/>'),
  arrowLeft: S('<path d="M19.6 12H4.4"/><path d="m10.6 6.2-5.8 5.8 5.8 5.8"/>'),
  branch: S(
    '<circle cx="7" cy="5.8" r="2.4"/><circle cx="7" cy="18.2" r="2.4"/><circle cx="17" cy="7.6" r="2.4"/><path d="M7 8.2v7.6"/><path d="M17 10c0 3.7-3.3 4.4-6.3 5.4"/>',
  ),
  git: S(
    '<circle cx="12" cy="12" r="3.1"/><path d="M3.6 12h5.3M15.1 12h5.3"/>',
  ),
  // GitHub and Google keep their owners' published artwork rather than being
  // redrawn in Basil's hand: a logo in somebody else's style is a drawing of
  // a logo, and these two say which account somebody is signing in with.
  github: S(
    '<path d="M9 19c-4 1.2-4-2.2-5.6-2.8M15 21v-3.3c0-.9-.1-1.3-.6-1.8 2.4-.3 4.8-1.2 4.8-5.2a4 4 0 0 0-1.1-2.8 3.7 3.7 0 0 0-.1-2.8s-.9-.3-2.9 1.1a10 10 0 0 0-5.2 0C7.9 2 7 2.3 7 2.3a3.7 3.7 0 0 0-.1 2.8A4 4 0 0 0 5.8 8c0 3.9 2.4 4.8 4.7 5.2-.3.3-.6.8-.6 1.6V21"/>',
  ),
  google: S(
    '<path d="M20.6 12.2c0-.6-.1-1.2-.2-1.8H12v3.4h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9a8.6 8.6 0 0 0 2.7-6.5z"/><path d="M12 21a8.5 8.5 0 0 0 5.9-2.2l-2.9-2.2A5.3 5.3 0 0 1 12 17.4a5.3 5.3 0 0 1-4.9-3.6H4.1v2.3A9 9 0 0 0 12 21z"/><path d="M7.1 13.8a5.3 5.3 0 0 1 0-3.4V8.1H4.1a9 9 0 0 0 0 8.1z"/><path d="M12 6.6c1.3 0 2.5.5 3.5 1.4l2.6-2.6A9 9 0 0 0 4.1 8.1l3 2.3A5.3 5.3 0 0 1 12 6.6z"/>',
  ),
  cloud: S(
    '<path d="M7.6 19.2a4.4 4.4 0 0 1-.7-8.7 5.7 5.7 0 0 1 10.8 1.1 3.8 3.8 0 0 1-.5 7.6z"/>',
  ),
  link: S(
    '<path d="M10.3 13.7a3.9 3.9 0 0 0 5.9.4l2.1-2.1a3.9 3.9 0 0 0-5.5-5.5l-1.2 1.2"/><path d="M13.7 10.3a3.9 3.9 0 0 0-5.9-.4l-2.1 2.1a3.9 3.9 0 0 0 5.5 5.5l1.2-1.2"/>',
  ),
  star: S(
    '<path d="m12 3.8 2.6 5.2 5.8.9-4.2 4 1 5.7-5.2-2.7-5.2 2.7 1-5.7-4.2-4 5.8-.9z"/>',
  ),
  dots: S(
    '<circle cx="12" cy="5.2" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="18.8" r="1.5" fill="currentColor" stroke="none"/>',
  ),
  dotsHorizontal: S(
    '<circle cx="5.2" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.8" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  ),
  filter: S('<path d="M4.4 7.2h15.2M7.2 12h9.6M10 16.8h4"/>'),
  grid: S(
    '<rect x="3.8" y="3.8" width="7.4" height="7.4" rx="2.6"/><rect x="12.8" y="3.8" width="7.4" height="7.4" rx="2.6"/><rect x="3.8" y="12.8" width="7.4" height="7.4" rx="2.6"/><rect x="12.8" y="12.8" width="7.4" height="7.4" rx="2.6"/>',
  ),
  list: S(
    '<path d="M9 6.6h10.6M9 12h10.6M9 17.4h10.6"/><circle cx="4.8" cy="6.6" r="1.15" fill="currentColor" stroke="none"/><circle cx="4.8" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="4.8" cy="17.4" r="1.15" fill="currentColor" stroke="none"/>',
  ),
  file: S(
    '<path d="M13.6 3.6H7.8a2.4 2.4 0 0 0-2.4 2.4v12a2.4 2.4 0 0 0 2.4 2.4h8.4a2.4 2.4 0 0 0 2.4-2.4V8.4z"/><path d="M13.4 3.8v2.9a1.8 1.8 0 0 0 1.8 1.8h3.1"/>',
  ),
  history: S(
    '<path d="M3.8 12a8.2 8.2 0 1 0 2.6-6"/><path d="M3.6 5.2v4.2h4.2"/><path d="M12 7.9v4.4l3 1.7"/>',
  ),
  sparkle: S(
    '<path d="M11.4 4.2c0 3.7 2.5 6.2 6.2 6.2-3.7 0-6.2 2.5-6.2 6.2 0-3.7-2.5-6.2-6.2-6.2 3.7 0 6.2-2.5 6.2-6.2Z"/><path d="M18 15.6v3M19.5 17.1h-3"/>',
  ),
  wand: S(
    '<path d="M4.4 19.6 14 10"/><path d="m16.6 3.8.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/><path d="M6.4 5.2v2.4M7.6 6.4H5.2"/><path d="M19.2 14.4v2.2M20.3 15.5h-2.2"/>',
  ),
  paperclip: S(
    '<path d="M19.4 11.4 12 18.8a4.7 4.7 0 0 1-6.6-6.6l7.5-7.5a3.2 3.2 0 0 1 4.5 4.5l-7.4 7.5a1.6 1.6 0 0 1-2.3-2.3l6.8-6.8"/>',
  ),
  at: S(
    '<circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.4a2.6 2.6 0 0 0 5.1 0V12a8.6 8.6 0 1 0-3.4 6.8"/>',
  ),
  send: S('<path d="M4.4 12h15.2"/><path d="m13.4 6.2 5.8 5.8-5.8 5.8"/>'),
  sliders: S(
    '<path d="M4.4 8.2h3.4M12.2 8.2h7.4M4.4 15.8h7.4M15.8 15.8h3.8"/><circle cx="10" cy="8.2" r="2.3"/><circle cx="13.6" cy="15.8" r="2.3"/>',
  ),
  check: S('<path d="m5.4 12.6 4.4 4.4L18.6 7.4"/>'),
  doubleCheck: S(
    '<path d="m3.4 12.6 3.9 3.9 7.8-8.2"/><path d="m11.4 15.1 2 2 7.2-8.6"/>',
  ),
  checkCircle: S(
    '<circle cx="12" cy="12" r="8.4"/><path d="m8.4 12.2 2.5 2.5 4.7-5"/>',
  ),
  closeCircle: S('<circle cx="12" cy="12" r="8.4"/><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6"/>'),
  minusCircle: S('<circle cx="12" cy="12" r="8.4"/><path d="M8.2 12h7.6"/>'),
  helpCircle: S(
    '<circle cx="12" cy="12" r="8.4"/><path d="M9.8 9.4a2.4 2.4 0 1 1 3.4 2.2c-.85.45-1.2.95-1.2 1.9"/><circle cx="12" cy="16.4" r=".9" fill="currentColor" stroke="none"/>',
  ),
  alert: S(
    '<path d="M10.3 5a2 2 0 0 1 3.4 0l6.8 11.7a2 2 0 0 1-1.7 3H5.2a2 2 0 0 1-1.7-3z"/><path d="M12 9.6v3.9"/><circle cx="12" cy="16.6" r=".9" fill="currentColor" stroke="none"/>',
  ),
  clock: S('<circle cx="12" cy="12" r="8.4"/><path d="M12 7.2V12l3.1 1.8"/>'),
  users: S(
    '<circle cx="9.4" cy="8.2" r="3.4"/><path d="M3.4 19.4a6 6 0 0 1 12 0"/><path d="M16.2 5.3a3.4 3.4 0 0 1 0 5.8"/><path d="M17.6 13.9a5.8 5.8 0 0 1 3 5.5"/>',
  ),
  lock: S(
    '<rect x="4.6" y="10.2" width="14.8" height="9.6" rx="3.2"/><path d="M8 10.2V7.7a4 4 0 0 1 8 0v2.5"/><circle cx="12" cy="15" r="1.25" fill="currentColor" stroke="none"/>',
  ),
  play: S('<path d="M8 5.5 19 12 8 18.5z"/>'),
  pause: S(
    '<rect x="7.2" y="4.8" width="3.6" height="14.4" rx="1.7"/><rect x="13.2" y="4.8" width="3.6" height="14.4" rx="1.7"/>',
  ),
  globe: S(
    '<circle cx="12" cy="12" r="8.4"/><path d="M3.7 9.6h16.6M3.7 14.4h16.6"/><path d="M12 3.6a14 14 0 0 1 0 16.8 14 14 0 0 1 0-16.8z"/>',
  ),
  shield: S(
    '<path d="M12 3.4 19 6.2v5.6c0 4.2-2.9 7.3-7 8.8-4.1-1.5-7-4.6-7-8.8V6.2z"/><path d="m9.2 12 2.1 2.1 3.5-4"/>',
  ),
  sync: S(
    '<path d="M20.2 12a8.2 8.2 0 0 1-14.1 5.7"/><path d="M3.8 12a8.2 8.2 0 0 1 14.1-5.7"/><path d="M17.6 2.9v3.7h-3.7M6.4 21.1v-3.7h3.7"/>',
  ),
  database: S(
    '<ellipse cx="12" cy="6.2" rx="7.2" ry="2.8"/><path d="M4.8 6.2v11.6c0 1.6 3.2 2.8 7.2 2.8s7.2-1.2 7.2-2.8V6.2"/><path d="M4.8 12c0 1.6 3.2 2.8 7.2 2.8s7.2-1.2 7.2-2.8"/>',
  ),
  cpu: S(
    '<rect x="6.6" y="6.6" width="10.8" height="10.8" rx="3.2"/><rect x="10.2" y="10.2" width="3.6" height="3.6" rx="1.3"/><path d="M9.8 3.4v3.2M14.2 3.4v3.2M9.8 17.4v3.2M14.2 17.4v3.2M3.4 9.8h3.2M3.4 14.2h3.2M17.4 9.8h3.2M17.4 14.2h3.2"/>',
  ),
  layers: S(
    '<path d="m12 3.6 8.2 4.3-8.2 4.3-8.2-4.3z"/><path d="m4.4 12.4 7.6 4 7.6-4"/><path d="m4.4 16.4 7.6 4 7.6-4"/>',
  ),
  terminal: S(
    '<rect x="2.8" y="4.4" width="18.4" height="15.2" rx="4.4"/><path d="m7.6 9.8 2.6 2.5-2.6 2.5"/><path d="M12.8 14.8h4.2"/>',
  ),
  refresh: S('<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20.4 4.2v4.2h-4.2"/>'),
  folderPlus: S(
    '<path d="M3.2 8.2A2.8 2.8 0 0 1 6 5.4h2.7c.6 0 1.2.2 1.7.6l1.5 1.2h6.1a2.8 2.8 0 0 1 2.8 2.8v6.6a2.8 2.8 0 0 1-2.8 2.8H6a2.8 2.8 0 0 1-2.8-2.8z"/><path d="M12 11v5M9.5 13.5h5"/>',
  ),
  columns: S(
    '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="3.6"/><path d="M12 4.6v14.8"/>',
  ),
  info: S(
    '<circle cx="12" cy="12" r="8.4"/><path d="M12 11.2v5.2"/><circle cx="12" cy="8.1" r=".9" fill="currentColor" stroke="none"/>',
  ),
  chart: S(
    '<path d="M4.2 3.8v14.4a2 2 0 0 0 2 2h13.6"/><path d="M8.6 16.6v-3.4M12.6 16.6V8.6M16.6 16.6v-5.6"/>',
  ),
  logout: S(
    '<path d="M14.2 4.4h3.4A2.4 2.4 0 0 1 20 6.8v10.4a2.4 2.4 0 0 1-2.4 2.4h-3.4"/><path d="m9.2 8.4-3.6 3.6 3.6 3.6"/><path d="M5.6 12h9"/>',
  ),
  external: S(
    '<path d="M13.6 4.4h6v6"/><path d="m19.6 4.4-8.2 8.2"/><path d="M17.8 13.8v4.2a1.8 1.8 0 0 1-1.8 1.8H6a1.8 1.8 0 0 1-1.8-1.8V8a1.8 1.8 0 0 1 1.8-1.8h4.2"/>',
  ),
  bolt: S('<path d="M13.4 3.2 5.6 13.4h5.4l-.4 7.4 7.8-10.2H13z"/>'),
  eye: S(
    '<path d="M2.8 12S6.6 6 12 6s9.2 6 9.2 6-3.8 6-9.2 6-9.2-6-9.2-6Z"/><circle cx="12" cy="12" r="3"/>',
  ),
  menu: S('<path d="M4.4 7.2h15.2M4.4 12h15.2M4.4 16.8h15.2"/>'),
  chatBubble: S(
    '<path d="M12 4.2c-4.5 0-8.1 3-8.1 6.8 0 2.1 1.1 3.9 2.8 5.2l-.7 3.4a.6.6 0 0 0 .9.6l3.7-2c.5.1.9.1 1.4.1 4.5 0 8.1-3 8.1-6.8s-3.6-7.3-8.1-7.3z"/>',
  ),
  smile: S(
    '<circle cx="12" cy="12" r="8.4"/><path d="M8.4 14.1c.9 1.3 2.2 2 3.6 2s2.7-.7 3.6-2"/><circle cx="8.9" cy="9.9" r="1.05" fill="currentColor" stroke="none"/><circle cx="15.1" cy="9.9" r="1.05" fill="currentColor" stroke="none"/>',
  ),
  reply: S(
    '<path d="M9.4 7.4 4.8 11.8l4.6 4.4"/><path d="M4.8 11.8h8.6a5.8 5.8 0 0 1 5.8 5.8v1"/>',
  ),
  // Two overlapping sheets — the clipboard glyph every surface uses for "take
  // these words with you". Drawn as one rounded rectangle behind another
  // rather than as a clipboard with a clasp: at 14px the clasp closes up into
  // a smudge and the pair of sheets stays readable.
  copy: S(
    '<rect x="8.6" y="8.6" width="11.6" height="11.6" rx="3.4"/><path d="M5.8 15.4h-.4a2 2 0 0 1-2-2V5.8a2 2 0 0 1 2-2H13a2 2 0 0 1 2 2v.4"/>',
  ),
  pin: S(
    '<path d="m14.5 3.4 6.1 6.1-2.4.6-3.3 3.3-.3 3.7-1.4 1.4-7.7-7.7 1.4-1.4 3.7-.3 3.3-3.3z"/><path d="m8.9 15.1-4.5 4.5"/>',
  ),
  hash: S('<path d="M9.9 4.2 7.7 19.8M16.3 4.2l-2.2 15.6M4.6 8.9h15M3.9 15.1h15"/>'),
  pencil: S(
    '<path d="m4.2 19.8.9-4.4L15.9 4.6a2 2 0 0 1 2.8 0l.7.7a2 2 0 0 1 0 2.8L8.6 18.9z"/><path d="m14.4 6.1 3.5 3.5"/>',
  ),
};

export function icon(name, extra = "") {
  const resolvedName = Object.hasOwn(ICONS, name) ? name : "info";
  const glyph = ICONS[resolvedName];
  const className = /\bclass="([^"]*)"/u.exec(extra)?.[1]?.trim() ?? "";
  const attributes = extra.replace(/\s*\bclass="[^"]*"/u, "").trim();
  const shared = `class="ui-icon${className === "" ? "" : ` ${className}`}" data-icon="${resolvedName}"${attributes === "" ? "" : ` ${attributes}`} `;
  return glyph.replace("<svg ", `<svg ${shared}`);
}

/* ------------------------------------------------- attribution pills ---- */

/**
 * The little rendered objects that ride inside an attribution pill.
 *
 * These are the one place in the interface that is deliberately *not* a flat
 * line mark: they follow 3dicons, Vijay Verma's open 3D set
 * (https://3dicons.co, CC0), which is what the small glossy objects in a
 * ChatGPT source pill are doing too. A pill says who or what a piece of work
 * came from, and it has to be picked out of a paragraph at a glance; colour
 * and depth do in one look what a fourth grey line icon could not do at all.
 *
 * Each is built from the same three parts a rendered icon has — a body under
 * a top-lit gradient, a soft specular highlight, and the subject itself in
 * white — so the family looks like one set rather than a bag of stickers.
 * The interface set in {@link ICONS} stays flat Basil everywhere else, and
 * these appear only inside {@link pillBar}.
 */
const PILL_ART = {
  agent: {
    from: "#b7a7ff",
    to: "#5b3df5",
    glyph:
      '<rect x="6.6" y="7.4" width="10.8" height="8.6" rx="3" fill="#fff"/><path d="M12 7.4V5.2" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="4.5" r="1.1" fill="#fff"/><circle cx="9.7" cy="11.6" r="1.15" fill="#4c31d8"/><circle cx="14.3" cy="11.6" r="1.15" fill="#4c31d8"/>',
  },
  file: {
    from: "#8fd0ff",
    to: "#2b6ef5",
    glyph:
      '<path d="M9 5.6h4.4l3.4 3.4v8.2a1.4 1.4 0 0 1-1.4 1.4H9a1.4 1.4 0 0 1-1.4-1.4V7a1.4 1.4 0 0 1 1.4-1.4z" fill="#fff"/><path d="M13.3 5.8v2.6a1 1 0 0 0 1 1h2.5" fill="#cfe4ff"/><path d="M10 12.4h4M10 15h2.8" stroke="#2b6ef5" stroke-width="1.3" stroke-linecap="round"/>',
  },
  folder: {
    from: "#ffd98a",
    to: "#f0961d",
    glyph:
      '<path d="M6.4 8.4a1.4 1.4 0 0 1 1.4-1.4h2.4l1.5 1.5h4.1a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H7.8a1.4 1.4 0 0 1-1.4-1.4z" fill="#fff"/>',
  },
  clock: {
    from: "#8ef0da",
    to: "#0f9b86",
    glyph:
      '<circle cx="12" cy="12" r="5.6" fill="#fff"/><path d="M12 8.7V12l2.3 1.4" stroke="#0f9b86" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  done: {
    from: "#9df3b4",
    to: "#12a150",
    glyph:
      '<path d="m8.4 12.3 2.6 2.6 5-5.4" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  },
  code: {
    from: "#b6c0ff",
    to: "#4338ca",
    glyph:
      '<path d="m9.6 9.6-2.8 2.4 2.8 2.4M14.4 9.6l2.8 2.4-2.8 2.4M13.2 8.4l-2.4 7.2" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  },
  branch: {
    from: "#ffc39a",
    to: "#ee6c1f",
    glyph:
      '<circle cx="9" cy="8.4" r="1.9" fill="#fff"/><circle cx="9" cy="15.6" r="1.9" fill="#fff"/><circle cx="15.4" cy="9.4" r="1.9" fill="#fff"/><path d="M9 10.3v3.4M15.4 11.3c0 2.4-2.2 2.6-4 3.2" stroke="#fff" stroke-width="1.5" stroke-linecap="round" fill="none"/>',
  },
  message: {
    from: "#ffb6dc",
    to: "#e0409a",
    glyph:
      '<path d="M12 6.6c-3.2 0-5.8 2-5.8 4.6 0 1.4.8 2.7 2 3.5l-.5 2.3a.5.5 0 0 0 .7.5l2.6-1.3h1c3.2 0 5.8-2 5.8-4.6S15.2 6.6 12 6.6z" fill="#fff"/>',
  },
  person: {
    from: "#9be8ff",
    to: "#0d8bd8",
    glyph:
      '<circle cx="12" cy="9.8" r="2.7" fill="#fff"/><path d="M6.9 17.6c0-2.6 2.3-4.2 5.1-4.2s5.1 1.6 5.1 4.2z" fill="#fff"/>',
  },
};

/**
 * Gradient ids have to be unique per drawing, because a `fill="url(#id)"`
 * resolves against the whole document: two pills sharing an id are one pill
 * whose gradient disappears the moment the other is removed from the DOM.
 * A counter is enough — nothing here is server-rendered or compared across
 * renders.
 */
let pillArtSerial = 0;

/** One rendered object, sized by the pill that contains it. */
export function pillIcon(name) {
  const art = PILL_ART[name] ?? PILL_ART.done;
  pillArtSerial += 1;
  const body = `pill3d-b${pillArtSerial}`;
  const gloss = `pill3d-g${pillArtSerial}`;
  return `<svg class="pill-3d" viewBox="0 0 24 24" aria-hidden="true" focusable="false"
    data-icon-style="3dicons" data-pill-icon="${esc(name)}">
    <defs>
      <linearGradient id="${body}" x1="5" y1="3" x2="19" y2="21"
        gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="${art.from}"/>
        <stop offset="1" stop-color="${art.to}"/>
      </linearGradient>
      <radialGradient id="${gloss}" cx="0.34" cy="0.26" r="0.62">
        <stop offset="0" stop-color="#fff" stop-opacity="0.55"/>
        <stop offset="1" stop-color="#fff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <circle cx="12" cy="12" r="10.4" fill="url(#${body})"/>
    <circle cx="12" cy="12" r="10.4" fill="url(#${gloss})"/>
    ${art.glyph}
  </svg>`;
}

/**
 * A row of attribution, written the way a source pill is: the objects that
 * did or hold the work, then a few plain words about it.
 *
 * Prose is the wrong shape for "this agent, these files, that long ago" — it
 * costs a whole sentence to say what three chips say instantly, and a reader
 * skimming a digest never reaches the end of the sentence. Each pill takes an
 * optional `title` for the detail that would have bloated the label, so the
 * long version is a hover away rather than gone.
 *
 * Pills with no label are dropped rather than drawn empty: callers assemble
 * these from record fields that are often missing.
 */
export function pillBar(pills, note = "") {
  const chips = pills
    .filter((pill) => pill !== undefined && String(pill.label ?? "").trim() !== "")
    .map(
      (pill) =>
        `<span class="pill"${
          pill.title ? ` title="${esc(pill.title)}"` : ""
        }>${pillIcon(pill.icon)}<span class="pill-label">${esc(
          pill.label,
        )}</span></span>`,
    )
    .join("");
  if (chips === "" && note === "") {
    return "";
  }
  return `<div class="pill-bar">${chips}${
    note === "" ? "" : `<span class="pill-note">${esc(note)}</span>`
  }</div>`;
}

/**
 * Adds the pinned-message shortcut beside the channel's people and agent
 * counts. The channel header is redrawn as live room state arrives, so this
 * small shared enhancement follows those redraws rather than owning a second
 * copy of the header.
 *
 * The button deliberately emits the banner's existing delegated action. A
 * pin remains a pin when its shelf is hidden; this control changes only
 * whether that shelf is open.
 */
S.showPinnedMessages = (root = document) => {
  const sync = () => {
    const counts = root.querySelector(".chan-head .ch-desc");
    if (counts === null || counts.querySelector(".ch-pins-toggle") !== null) {
      return;
    }
    const open =
      root.querySelector('.chan-pins-head[aria-expanded="true"]') !== null;
    const separator = root.createElement("span");
    separator.className = "ch-pins-separator";
    separator.setAttribute("aria-hidden", "true");
    separator.textContent = "|";

    const button = root.createElement("button");
    button.type = "button";
    button.className = `ch-count ch-pins-toggle${open ? " on" : ""}`;
    button.dataset.act = "channel-pins-toggle";
    button.title = open ? "Hide pinned messages" : "Show pinned messages";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(open));
    button.setAttribute(
      "style",
      "border:0;background:none;padding:0;color:inherit;font:inherit;cursor:pointer",
    );
    button.innerHTML = icon("pin");
    counts.append(separator, button);
  };

  sync();
  const observer = new MutationObserver(sync);
  observer.observe(root.documentElement, { childList: true, subtree: true });
};

if (typeof document !== "undefined") {
  S.showPinnedMessages();
}

/**
 * The letters of the full KUMI wordmark used on the auth shell.
 *
 * The letters are stroked polylines rather than filled outlines, because that
 * is what they are — one constant weight, flat cuts, no curves anywhere. The
 * K's arms run past the vertex into the stem so their ends are hidden under
 * it.
 *
 * `currentColor` throughout: the wordmark takes the colour of the text beside
 * it, so it is right on dark and light without a second definition.
 */
const BRAND_LETTERS = `<path d="M8.3 8V40"/>
    <path d="M42 11 13.5 24 42 37"/>
    <path d="M54.3 8v22.7l6.3 6.3h20.8l6.3-6.3V8"/>
    <path d="M102.3 8V40"/>
    <path d="M143.7 8V40"/>
    <path d="M102.3 10.5 123 30l20.7-19.5"/>
    <path d="M158.3 8V40"/>`;

/**
 * The whole word, for the surfaces with room for it — the sign-in card and
 * everything else on the auth shell.
 *
 * The height is derived from the width rather than left to CSS. Asking for a
 * width here is enough to preserve the 3.5:1 aspect ratio the letters were
 * drawn at, and `meet` means the word is never cropped if something else
 * sizes the box. `aria-label` rather than `aria-hidden`: read out, this one is
 * the product's name, not decoration beside a heading that already says it.
 */
export function brandWordmark(width = 120) {
  const height = Math.round((width / 3.5) * 100) / 100;
  return `<svg class="brand-wordmark" width="${width}" height="${height}"
    viewBox="0 0 168 48" preserveAspectRatio="xMidYMid meet"
    fill="none" stroke="currentColor" stroke-width="6.6"
    stroke-linecap="butt" stroke-linejoin="miter" role="img" aria-label="Kumi">
    ${BRAND_LETTERS}
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
  return `<span class="avatar sz-${size}" style="${box};background:#D88973" title="${esc(
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
export function agentFace(agent, size = 34, indicator = {}) {
  const kind = agentKindOf(agent?.provider ?? agent?.id);
  const status = indicator.status ?? agent?.presence ?? "offline";
  const presence =
    status === "working" || status === "online"
      ? "online"
      : status === "idle"
        ? "idle"
        : "offline";
  const progress = Number(indicator.progress);
  const working = Number.isFinite(progress);
  const color = safeColor(agent?.color) ?? "var(--accent)";
  // The vendor's own mark rather than a drawn character: an agent running on
  // Claude shows Claude's, one running on Codex shows Codex's, and a reader
  // recognises them without having to learn anything. The owner's colour still
  // carries the mark, so one glyph says both things — the shape says which
  // vendor, the colour says whose.
  //
  // A run is drawn as the mark filling up rather than as anything travelling
  // around it: the mark below is left dark and low, and the same mark is drawn
  // again on top, clipped to the sector the run has reached, so the logo
  // itself brightens clockwise until it is whole at 100%.
  //
  // The size travels as a custom property rather than as an `sz-${size}`
  // class. The class only ever worked for sizes somebody had hand-written a
  // rule for — 28, 34 and 40 — and callers ask for 20, 24, 30 and 32 as well.
  // Those had no rule at all, so the SVG had nothing bounding it and grew to
  // fill its container: a 30px face rendered 300px wide and made the chats
  // roster unnavigable. A number that has to be mirrored in a stylesheet to
  // mean anything is not a size argument, it is a trap.
  return `<span class="agent-face${working ? " agent-face-working" : ""}" data-kind="${kind}"
    data-presence="${presence}" style="color:${color};--face-size:${Number(size)}px${
      working ? `;--run:${Math.max(0, Math.min(100, progress))}` : ""
    }"
    title="${esc(
      agent?.name ?? AGENTS[kind].label,
    )}">${vendorMark(kind)}<i class="presence presence-${presence}"></i>${
      working
        ? `<i class="agent-run" aria-label="Working">${vendorMark(kind)}</i>`
        : ""
    }</span>`;
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

export function bar(percent, tone = "", thin = false, progressKey = undefined) {
  const numeric = Number(percent);
  const value = Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0;
  const history = bar.progressByKey ?? (bar.progressByKey = new Map());
  const previous = progressKey === undefined ? undefined : history.get(progressKey);
  if (progressKey !== undefined) {
    history.set(progressKey, value);
  }
  const changing = previous !== undefined && previous !== value;
  const from = changing ? previous : value;
  return `<span class="bar${thin ? " thin" : ""}"><i class="${tone}${
    changing ? " bar-progress-fill" : ""
  }" style="--bar-progress-from:${from}%;--bar-progress-to:${value}%;width:${value}%"></i></span>`;
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

/**
 * A model nobody can enumerate, typed instead of picked.
 *
 * {@link miniSelect} renders nothing at all with no options, which is right
 * for a list still loading and wrong for a provider that will never have one.
 * Codex reports its models from a cache its own CLI writes on this machine;
 * where that cache does not exist the server sends no list and sets
 * `allowCustomModel` — "there is nothing to choose from, and a name typed here
 * is passed through unaltered". Nothing in the browser read that flag, so the
 * one provider that most needed a way to name a model showed a read-only
 * "Default" and the choice the backend was ready to accept could not be made
 * anywhere.
 *
 * Commits on `change`, so it saves on blur or Enter rather than per keystroke,
 * and reaches the same handler the select does. Emptying it clears the choice,
 * which is how every one of these controls returns to the default.
 */
export function miniEditable(act, current, placeholder, title = "") {
  return `<span class="mini-select mini-editable" title="${esc(title)}">
    <input data-act="${esc(act)}" type="text" value="${esc(current ?? "")}"
      placeholder="${esc(placeholder)}" spellcheck="false"
      autocapitalize="off" autocorrect="off" autocomplete="off" /></span>`;
}

export function segmented(act, options, current) {
  return `<span class="seg">${options
    .map(
      (option) => {
        const iconOnly = option.iconName !== undefined;
        return `<button type="button" data-act="${act}" data-value="${esc(option.value)}"
          class="${option.value === current ? "active" : ""}"
          aria-pressed="${option.value === current}"${
            iconOnly
              ? ` title="${esc(option.label)}" aria-label="${esc(option.label)}"`
              : ""
          }>${iconOnly ? icon(option.iconName) : esc(option.label)}</button>`;
      },
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
  { act = "", title = "", value = "", small = false, cls = "", data = {} } = {},
) {
  return `<button type="button" class="icon-btn${small ? " sm" : ""}${
    cls ? ` ${cls}` : ""
  }"${act ? ` data-act="${act}"` : ""}${
    value ? ` data-value="${esc(value)}"` : ""
  }${
    // Extra data attributes, for a button whose action needs more than one
    // value. The usage refresh needs to say whose account it is asking about
    // as well as which vendor, and anything passed here used to be dropped
    // on the floor by this destructure.
    Object.entries(data)
      .filter(([, attribute]) => attribute !== undefined && attribute !== "")
      .map(([attribute, attributeValue]) =>
        ` data-${attribute}="${esc(String(attributeValue))}"`,
      )
      .join("")
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
    dismiss.innerHTML = icon("close");
    dismiss.addEventListener("click", () => node.remove());
    node.append(dismiss);
  } else {
    window.setTimeout(() => node.remove(), 4200);
  }
  host.append(node);
}

/* -------------------------------------------------------------- modal ---- */

/** One application modal, as a native <dialog> so focus and Esc are free. */
export function showModal({
  title,
  subtitle = "",
  body = "",
  confirm = "Confirm",
  cancel = "Cancel",
  image,
}) {
  const dialog = $("#modal");
  const returnFocus = document.activeElement;
  return new Promise((resolve) => {
    dialog.returnValue = "";
    if (image) {
      dialog.setAttribute("aria-labelledby", "modal-image-title");
    } else {
      dialog.removeAttribute("aria-labelledby");
    }
    dialog.innerHTML = image
      ? `<form method="dialog" class="modal-card modal-image-card">
          <h3 class="sr-only" id="modal-image-title">${esc(title)}</h3>
          <button class="icon-btn modal-image-close" value="cancel" type="submit" aria-label="Close image preview">${icon("close")}</button>
          <img class="modal-image" src="${esc(image.src)}" alt="${esc(image.alt)}">
        </form>`
      : `<form method="dialog" class="modal-card">
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
    const onBackdropClick = (event) => {
      if (image && event.target === dialog) {
        dialog.close("cancel");
      }
    };
    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      dialog.removeEventListener("click", onBackdropClick);
      if (image && returnFocus instanceof HTMLElement && returnFocus.isConnected) {
        returnFocus.focus();
      }
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
    dialog.addEventListener("click", onBackdropClick);
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
