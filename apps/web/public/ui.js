/**
 * Shared UI primitives.
 *
 * Every screen composes from this file rather than hand-rolling its own
 * markup, so a badge, a progress bar, or an agent avatar looks identical
 * wherever it appears. Everything here returns an HTML string and stays
 * stateless; behaviour is bound by the screen that renders it, through
 * delegated `data-act` handlers.
 */

/* ------------------------------------------------------------- motion ---- */

/**
 * Whether this reader has asked the system for less movement.
 *
 * The one place the question is asked. The stylesheet answers it for
 * everything CSS owns; this is for the two things it cannot — the render
 * loop, which decides whether a message arriving is allowed to move at all
 * (`playMessageEntrance`, `playTextReveal`, `playPhaseSlots` in app.js), and
 * the transcript, which decides whether following the bottom eases or snaps
 * (`settleFollowToBottom` in screen-chats.js). Neither may keep its own copy
 * of the test: a reader who has turned motion off and still gets some of it
 * is worse served than one who never had it.
 */
export function motionIsUnwanted() {
  return (
    window.matchMedia !== undefined &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The stylesheet's one curve, for the movements CSS cannot express.
 *
 * Motion's `animate` from `motion/mini` is the shape this is written to, and
 * it is a thin wrapper over exactly this API. The dashboard ships as plain ES
 * modules straight from `public/` with no bundler and no vendored packages,
 * so there is nowhere to import it from that would not mean adding one — and
 * the values are the same either way.
 *
 * The string is `--ease-motion`, written out because a keyframe timing cannot
 * read a custom property. Nothing else in the browser code may hold a second
 * curve; this is the one place it is spelled.
 */
export const EASE_MOTION = "cubic-bezier(0.32, 0.72, 0, 1)";

/**
 * One movement on that curve, or nothing at all.
 *
 * Nothing at all is the point of the helper: a reader who has asked for less
 * movement gets no animation object back, and every caller is written so that
 * the element is already where it belongs when this returns `undefined`.
 * `fill: "none"` is what makes that true — the animation only ever plays over
 * a state the document is already in, so an interrupted or unplayed one
 * leaves nothing stuck.
 */
export function animateMotion(node, keyframes, duration, options = {}) {
  if (
    node === null ||
    node === undefined ||
    typeof node.animate !== "function" ||
    motionIsUnwanted()
  ) {
    return undefined;
  }
  return node.animate(keyframes, {
    duration,
    easing: EASE_MOTION,
    fill: "none",
    ...options,
  });
}

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
 * The local subset of Basil Solid Bold selected for Kumi's interface.
 *
 * Basil is Craftwork's open icon set:
 * https://craftwork.design/product/basil
 *
 * Basil ships in several weights, and this is the solid one: every mark is a
 * filled silhouette rather than a traced outline. The set was drawn as
 * outlines first and that was the wrong register for this product — beside
 * bold labels on a dense panel, a 2px line reads as a hairline sketch and
 * thins into a smudge at 14px. Filled, the same picture holds its shape at
 * any size a control uses it at, which is the whole point of the bold cut.
 *
 * Solid Bold's rules are followed rather than approximated: shapes are drawn
 * large inside the 24px box, corners are rounded far more generously than a
 * geometric set would allow, the details inside a mark are cut out of the
 * fill with `evenodd` instead of being drawn on top of it, and lines that
 * remain lines — a slash, a tick, a chevron — are heavy rounded bars, not
 * strokes. Nothing in this file strokes anything: a stroked path beside a
 * filled one is the one difference the eye reads before it reads the
 * picture, and half a set is worse than either whole one.
 *
 * Only the geometry the product uses is kept inline, so the marks stay
 * instant and available when the control plane is offline, and nothing here
 * fetches artwork at runtime. The shared wrapper carries the 24px grid and
 * `currentColor` behaviour, while keeping every interface mark decorative to
 * assistive technology. This is the interface's only icon language:
 * attribution pills draw from the same set rather than standing up a second
 * one beside it. Product-only concepts (agents and the Kumi network) use
 * that same grid and optical weight, and the two vendor marks here — GitHub
 * and Google — stay their owners' published artwork, which both publish
 * filled, because a logo redrawn in somebody else's style is no longer the
 * logo.
 */
const S = (body, extra = "") =>
  `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true" focusable="false" data-icon-style="basil-solid" data-icon-source="craftwork-basil"${extra}>${body}</svg>`;

export const ICONS = {
  // Basil's house is squarer and sits lower than a drawn-to-a-point roof:
  // the eaves and the ridge share one generous radius, and the doorway is a
  // notch cut out of the silhouette rather than a line drawn on it.
  home: S(
    '<path d="M10.34 3.13a2.7 2.7 0 0 1 3.32 0l5.7 4.42A2.7 2.7 0 0 1 20.4 9.68V17.2a3.2 3.2 0 0 1-3.2 3.2h-2.3v-3.8a2.9 2.9 0 0 0-5.8 0v3.8H6.8a3.2 3.2 0 0 1-3.2-3.2V9.68' +
      'a2.7 2.7 0 0 1 1.04-2.13z"/>',
  ),
  // One closed shape with the tab drawn into it. Solid Bold leaves the body
  // unbroken: a rule across it would read as a drawer front, not a folder.
  folder: S(
    '<path d="M6.8 5.6h2.1c.7 0 1.38.22 1.94.63l1.86 1.37h4.5a3.3 3.3 0 0 1 3.3 3.3v5.6a3.3 3.3 0 0 1-3.3 3.3H6.8a3.3 3.3 0 0 1-3.3-3.3V8.9a3.3 3.3 0 0 1 3.3-3.3z"/>',
  ),
  code: S(
    '<path d="M7.79 6.75L3.69 11.15A1.25 1.25 0 0 0 3.69 12.85L7.79 17.25A1.25 1.25 0 0 0 9.61 15.55L6.31 12 9.61 8.45A1.25 1.25 0 0 0 7.79 6.75Z"/>' +
      '<path d="M14.39 8.45L17.69 12 14.39 15.55A1.25 1.25 0 0 0 16.21 17.25L20.31 12.85A1.25 1.25 0 0 0 20.31 11.15L16.21 6.75A1.25 1.25 0 0 0 14.39 8.45Z"/>' +
      '<path d="M12.28 5.12L9.28 18.32A1.25 1.25 0 0 0 11.72 18.88L14.72 5.68A1.25 1.25 0 0 0 12.28 5.12Z"/>',
  ),
  robot: S(
    '<path fill-rule="evenodd" d="M8.6 7.4h6.8a5.2 5.2 0 0 1 5.2 5.2v2a5.2 5.2 0 0 1-5.2 5.2h-6.8a5.2 5.2 0 0 1-5.2-5.2v-2a5.2 5.2 0 0 1 5.2-5.2Z' +
      'M7.7 13a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0ZM13.3 13a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0Z' +
      'M11.05 15.8h1.9a.95.95 0 0 1 .95.95.95.95 0 0 1-.95.95h-1.9a.95.95 0 0 1-.95-.95.95.95 0 0 1 .95-.95Z"/>' +
      '<path d="M10.9 4.9L10.9 7.8A1.1 1.1 0 0 0 13.1 7.8L13.1 4.9A1.1 1.1 0 0 0 10.9 4.9Z"/>' +
      '<circle cx="12" cy="3.5" r="1.7"/>',
  ),
  // Head and shoulders, the two of them deliberately the same silhouette so
  // the pair reads as one count of people beside one count of agents rather
  // than as two unrelated pictures. Soft-cornered head and antenna for the
  // agent, round head for the person; nothing below the shoulders in either.
  personBust: S(
    '<circle cx="12" cy="7.8" r="4.3"/>' +
      '<path d="M4.4 20.9C4.4 16.44 8.58 13.7 12 13.7 15.42 13.7 19.6 16.44 19.6 20.9Z"/>',
  ),
  robotBust: S(
    '<path fill-rule="evenodd" d="M9.8 4.9h4.4a3.8 3.8 0 0 1 3.8 3.8v1.6a3.8 3.8 0 0 1-3.8 3.8h-4.4a3.8 3.8 0 0 1-3.8-3.8v-1.6a3.8 3.8 0 0 1 3.8-3.8Z' +
      'M8.35 9.3a1.35 1.35 0 1 0 2.7 0 1.35 1.35 0 1 0-2.7 0ZM12.95 9.3a1.35 1.35 0 1 0 2.7 0 1.35 1.35 0 1 0-2.7 0Z"/>' +
      '<path d="M11.05 2.9L11.05 5.2A.95.95 0 0 0 12.95 5.2L12.95 2.9A.95.95 0 0 0 11.05 2.9Z"/>' +
      '<circle cx="12" cy="2.2" r="1.45"/>' +
      '<path d="M4.5 20.9C4.5 16.99 8.62 14.6 12 14.6 15.38 14.6 19.5 16.99 19.5 20.9Z"/>',
  ),
  network: S(
    '<circle cx="12" cy="12" r="3.5"/>' +
      '<circle cx="4.8" cy="5.6" r="2.7"/>' +
      '<circle cx="19.2" cy="5.6" r="2.7"/>' +
      '<circle cx="12" cy="20" r="2.7"/>' +
      '<path d="M6.16 8.52L9.16 11.22A1.1 1.1 0 0 0 10.64 9.58L7.64 6.88A1.1 1.1 0 0 0 6.16 8.52Z"/>' +
      '<path d="M16.36 6.88L13.36 9.58A1.1 1.1 0 0 0 14.84 11.22L17.84 8.52A1.1 1.1 0 0 0 16.36 6.88Z"/>' +
      '<path d="M10.9 15.3L10.9 17.5A1.1 1.1 0 0 0 13.1 17.5L13.1 15.3A1.1 1.1 0 0 0 10.9 15.3Z"/>',
  ),
  // A flat-bottomed bell whose skirt is squared off by two soft curls rather
  // than a rim line, so the mark keeps its weight low and stays legible in a
  // topbar.
  bell: S(
    '<path d="M12 2.4a6.9 6.9 0 0 0-6.9 6.9c0 1.47-.15 2.44-.46 3.27-.32.86-.82 1.54-1.5 2.29A1.8 1.8 0 0 0 4.47 17.9h15.06a1.8 1.8 0 0 0 1.33-3.04' +
      'c-.68-.75-1.18-1.43-1.5-2.29-.31-.83-.46-1.8-.46-3.27A6.9 6.9 0 0 0 12 2.4Z"/>' +
      '<path d="M9.4 19.4h5.2a2.6 2.6 0 0 1-5.2 0Z"/>',
  ),
  // The same bell struck through, deliberately: a muted room is the
  // notification mark negated, and inventing a second unrelated picture for
  // it would make the pair harder to read than the one crossed-out one. The
  // bar is cut out of the bell and redrawn over the gap, so the slash reads
  // at 14px instead of disappearing into the silhouette.
  bellOff: S(
    '<path fill-rule="evenodd" d="M12 2.4a6.9 6.9 0 0 0-6.9 6.9c0 1.47-.15 2.44-.46 3.27-.32.86-.82 1.54-1.5 2.29A1.8 1.8 0 0 0 4.47 17.9h15.06a1.8 1.8 0 0 0 1.33-3.04' +
      'c-.68-.75-1.18-1.43-1.5-2.29-.31-.83-.46-1.8-.46-3.27A6.9 6.9 0 0 0 12 2.4ZM9.4 19.4h5.2a2.6 2.6 0 0 1-5.2 0Z' +
      'M.97 4.23L19.77 23.03A2.3 2.3 0 0 0 23.03 19.77L4.23.97A2.3 2.3 0 0 0 .97 4.23Z"/>' +
      '<path d="M2.82 4.58L19.42 21.18A1.25 1.25 0 0 0 21.18 19.42L4.58 2.82A1.25 1.25 0 0 0 2.82 4.58Z"/>',
  ),
  // Six chunky teeth around a hub knocked clean out of the middle. The eight
  // soft lobes this replaced were drawn for a thin line: filled, their
  // valleys close up and the cog silhouettes into a blob.
  gear: S(
    '<path fill-rule="evenodd" d="M9.7 5.9 10.1 3h3.8l.4 2.9 1.8 1 2.7-1.1 1.9 3.4-2.3 1.8v2l2.3 1.8-1.9 3.4-2.7-1.1-1.8 1-.4 2.9h-3.8l-.4-2.9-1.8-1-2.7 1.1-1.9-3.4L5.6 13v-2L3.3 9.2l1.9-3.4 2.7 1.1z' +
      'M8.8 12a3.2 3.2 0 1 0 6.4 0 3.2 3.2 0 1 0-6.4 0Z"/>',
  ),
  search: S(
    '<path fill-rule="evenodd" d="M2.8 10.8a8 8 0 1 0 16 0 8 8 0 1 0-16 0ZM5.6 10.8a5.2 5.2 0 1 0 10.4 0 5.2 5.2 0 1 0-10.4 0Z"/>' +
      '<path d="M14.98 16.82L19.48 21.32A1.3 1.3 0 0 0 21.32 19.48L16.82 14.98A1.3 1.3 0 0 0 14.98 16.82Z"/>',
  ),
  plus: S(
    '<path d="M13.35 5.75A1.35 1.35 0 0 0 10.65 5.75L10.65 10.65 5.75 10.65A1.35 1.35 0 0 0 5.75 13.35L10.65 13.35 10.65 18.25A1.35 1.35 0 0 0 13.35 18.25L13.35 13.35 18.25 13.35' +
      'A1.35 1.35 0 0 0 18.25 10.65L13.35 10.65Z"/>',
  ),
  close: S(
    '<path d="M5.45 7.35L16.65 18.55A1.35 1.35 0 0 0 18.55 16.65L7.35 5.45A1.35 1.35 0 0 0 5.45 7.35Z"/>' +
      '<path d="M16.65 5.45L5.45 16.65A1.35 1.35 0 0 0 7.35 18.55L18.55 7.35A1.35 1.35 0 0 0 16.65 5.45Z"/>',
  ),
  // Deleting is the one action here that destroys something, so it gets its
  // own mark rather than borrowing the close cross — the two must not be a
  // slip apart. The bin tapers toward its base and carries two cut-out
  // slots, which is what keeps a filled bin from reading as a plain block.
  trash: S(
    '<path fill-rule="evenodd" d="M6.28 8.8h11.44l-.42 9.42a2.6 2.6 0 0 1-2.6 2.48H9.3a2.6 2.6 0 0 1-2.6-2.48z' +
      'M9.55 11.7L9.55 17.2A.75.75 0 0 0 11.05 17.2L11.05 11.7A.75.75 0 0 0 9.55 11.7ZM12.95 11.7L12.95 17.2A.75.75 0 0 0 14.45 17.2L14.45 11.7A.75.75 0 0 0 12.95 11.7Z"/>' +
      '<path d="M3.9 7.55L20.1 7.55A1.25 1.25 0 0 0 20.1 5.05L3.9 5.05A1.25 1.25 0 0 0 3.9 7.55Z"/>' +
      '<path d="M7.85 6.3A4.15 4.15 0 0 1 16.15 6.3L13.75 6.3A1.75 1.75 0 0 0 10.25 6.3Z"/>',
  ),
  chevronDown: S(
    '<path d="M5.48 10.22L11.08 15.82A1.3 1.3 0 0 0 12.92 15.82L18.52 10.22A1.3 1.3 0 0 0 16.68 8.38L12 13.06 7.32 8.38A1.3 1.3 0 0 0 5.48 10.22Z"/>',
  ),
  chevronRight: S(
    '<path d="M8.38 7.32L13.06 12 8.38 16.68A1.3 1.3 0 0 0 10.22 18.52L15.82 12.92A1.3 1.3 0 0 0 15.82 11.08L10.22 5.48A1.3 1.3 0 0 0 8.38 7.32Z"/>',
  ),
  chevronUp: S(
    '<path d="M7.32 15.62L12 10.94 16.68 15.62A1.3 1.3 0 0 0 18.52 13.78L12.92 8.18A1.3 1.3 0 0 0 11.08 8.18L5.48 13.78A1.3 1.3 0 0 0 7.32 15.62Z"/>',
  ),
  arrowRight: S(
    '<path d="M4.2 13.3L19.2 13.3A1.3 1.3 0 0 0 19.2 10.7L4.2 10.7A1.3 1.3 0 0 0 4.2 13.3Z"/>' +
      '<path d="M12.38 6.62L17.76 12 12.38 17.38A1.3 1.3 0 0 0 14.22 19.22L20.52 12.92A1.3 1.3 0 0 0 20.52 11.08L14.22 4.78A1.3 1.3 0 0 0 12.38 6.62Z"/>',
  ),
  arrowLeft: S(
    '<path d="M19.8 10.7L4.8 10.7A1.3 1.3 0 0 0 4.8 13.3L19.8 13.3A1.3 1.3 0 0 0 19.8 10.7Z"/>' +
      '<path d="M9.78 4.78L3.48 11.08A1.3 1.3 0 0 0 3.48 12.92L9.78 19.22A1.3 1.3 0 0 0 11.62 17.38L6.24 12 11.62 6.62A1.3 1.3 0 0 0 9.78 4.78Z"/>',
  ),
  branch: S(
    '<circle cx="7" cy="5.6" r="3.05"/>' +
      '<circle cx="7" cy="18.4" r="3.05"/>' +
      '<circle cx="17" cy="7.4" r="3.05"/>' +
      '<path d="M5.8 7.9L5.8 16.1A1.2 1.2 0 0 0 8.2 16.1L8.2 7.9A1.2 1.2 0 0 0 5.8 7.9Z"/>' +
      '<path d="M18.2 10.6A8.2 8.2 0 0 1 9.29 18.77L9.49 16.38A5.8 5.8 0 0 0 15.8 10.6Z"/>',
  ),
  git: S(
    '<circle cx="12" cy="12" r="3.5"/>' +
      '<path d="M3.6 13.2L8.6 13.2A1.2 1.2 0 0 0 8.6 10.8L3.6 10.8A1.2 1.2 0 0 0 3.6 13.2Z"/>' +
      '<path d="M15.4 13.2L20.4 13.2A1.2 1.2 0 0 0 20.4 10.8L15.4 10.8A1.2 1.2 0 0 0 15.4 13.2Z"/>',
  ),
  // GitHub and Google keep their owners' published artwork rather than being
  // redrawn in Basil's hand: a logo in somebody else's style is a drawing of
  // a logo, and these two say which account somebody is signing in with.
  // Both are published as filled marks, so they were already in this
  // register before the set moved to it.
  github: S(
    '<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61' +
      'C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 ' +
      '3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 ' +
      '1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 ' +
      '5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12z"/>',
  ),
  google: S(
    '<path d="M12.48 10.92v3.28h7.84c-.24 1.84-.85 3.19-1.79 4.14-1.14 1.14-2.93 2.4-6.05 2.4-4.83 0-8.6-3.9-8.6-8.72s3.77-8.72 8.6-8.72c2.6 0 4.51 1.03 5.91 2.35l2.3-2.31' +
      'C18.75 1.44 16.13 0 12.48 0 5.87 0 .31 5.39.31 12s5.56 12 12.17 12c3.57 0 6.27-1.17 8.37-3.36 2.16-2.16 2.84-5.21 2.84-7.67 0-.76-.05-1.47-.17-2.05z"/>',
  ),
  cloud: S(
    '<path d="M7.6 19.4a4.7 4.7 0 0 1-.55-9.36 6.1 6.1 0 0 1 11.55.87 4.4 4.4 0 0 1-.6 8.49z"/>',
  ),
  // Two filled links with their eyes cut out, set on the diagonal every
  // chain glyph uses. The bar between them is what stops the pair from
  // reading as two unrelated pills.
  link: S(
    '<g transform="rotate(45 12 12)">' +
      '<path fill-rule="evenodd" d="M12 2.6a3.2 3.2 0 0 1 3.2 3.2v2.6a3.2 3.2 0 0 1-3.2 3.2 3.2 3.2 0 0 1-3.2-3.2v-2.6a3.2 3.2 0 0 1 3.2-3.2Z' +
      'M12 4.35a1.45 1.45 0 0 1 1.45 1.45v2.6a1.45 1.45 0 0 1-1.45 1.45 1.45 1.45 0 0 1-1.45-1.45v-2.6a1.45 1.45 0 0 1 1.45-1.45Z"/>' +
      '<path fill-rule="evenodd" d="M12 12.4a3.2 3.2 0 0 1 3.2 3.2v2.6a3.2 3.2 0 0 1-3.2 3.2 3.2 3.2 0 0 1-3.2-3.2v-2.6a3.2 3.2 0 0 1 3.2-3.2Z' +
      'M12 14.15a1.45 1.45 0 0 1 1.45 1.45v2.6a1.45 1.45 0 0 1-1.45 1.45 1.45 1.45 0 0 1-1.45-1.45v-2.6a1.45 1.45 0 0 1 1.45-1.45Z"/>' +
      '<path d="M10.7 10.6L10.7 13.4A1.3 1.3 0 0 0 13.3 13.4L13.3 10.6A1.3 1.3 0 0 0 10.7 10.6Z"/>' +
      '</g>',
  ),
  star: S(
    '<path d="M12.9 3.5 15.1 8a1 1 0 0 0 .76.55l4.94.72c.84.12 1.17 1.15.57 1.74l-3.58 3.49a1 1 0 0 0-.29.89l.85 4.92c.14.84-.74 1.48-1.49 1.08l-4.4-2.32a1 1 0 0 0-.94 0l-4.4 2.32' +
      'c-.75.4-1.63-.24-1.49-1.08l.85-4.92a1 1 0 0 0-.29-.89L2.63 11.01c-.6-.59-.27-1.62.57-1.74l4.94-.72A1 1 0 0 0 8.9 8l2.2-4.5a1 1 0 0 1 1.8 0z"/>',
  ),
  dots: S(
    '<circle cx="12" cy="4.8" r="1.9"/>' +
      '<circle cx="12" cy="12" r="1.9"/>' +
      '<circle cx="12" cy="19.2" r="1.9"/>',
  ),
  dotsHorizontal: S(
    '<circle cx="4.8" cy="12" r="1.9"/>' +
      '<circle cx="12" cy="12" r="1.9"/>' +
      '<circle cx="19.2" cy="12" r="1.9"/>',
  ),
  // A funnel rather than three stacked rules: the rules read as a list at
  // small sizes, which is the one thing a filter control must not be
  // mistaken for.
  filter: S(
    '<path d="M4.1 4.9h15.8a1 1 0 0 1 .78 1.63l-6.28 7.7v5.05a1 1 0 0 1-.55.9l-3.6 1.8a1 1 0 0 1-1.45-.9v-6.85L3.32 6.53A1 1 0 0 1 4.1 4.9z"/>',
  ),
  grid: S(
    '<rect x="3.2" y="3.2" width="7.9" height="7.9" rx="2.9"/>' +
      '<rect x="12.9" y="3.2" width="7.9" height="7.9" rx="2.9"/>' +
      '<rect x="3.2" y="12.9" width="7.9" height="7.9" rx="2.9"/>' +
      '<rect x="12.9" y="12.9" width="7.9" height="7.9" rx="2.9"/>',
  ),
  list: S(
    '<path d="M9.5 7.75L19.8 7.75A1.15 1.15 0 0 0 19.8 5.45L9.5 5.45A1.15 1.15 0 0 0 9.5 7.75Z"/>' +
      '<path d="M9.5 13.15L19.8 13.15A1.15 1.15 0 0 0 19.8 10.85L9.5 10.85A1.15 1.15 0 0 0 9.5 13.15Z"/>' +
      '<path d="M9.5 18.55L19.8 18.55A1.15 1.15 0 0 0 19.8 16.25L9.5 16.25A1.15 1.15 0 0 0 9.5 18.55Z"/>' +
      '<circle cx="4.7" cy="6.6" r="1.6"/>' +
      '<circle cx="4.7" cy="12" r="1.6"/>' +
      '<circle cx="4.7" cy="17.4" r="1.6"/>',
  ),
  // Two written lines cut out of the page, which is what tells a document
  // apart from a blank card at 14px, and a bevelled corner where the fold
  // would be.
  file: S(
    '<path fill-rule="evenodd" d="M14.3 2.6H8A3.4 3.4 0 0 0 4.6 6v12A3.4 3.4 0 0 0 8 21.4h8a3.4 3.4 0 0 0 3.4-3.4V7.7z' +
      'M8.9 17.25L14.3 17.25A.85.85 0 0 0 14.3 15.55L8.9 15.55A.85.85 0 0 0 8.9 17.25ZM8.9 13.45L12.4 13.45A.85.85 0 0 0 12.4 11.75L8.9 11.75A.85.85 0 0 0 8.9 13.45Z"/>',
  ),
  history: S(
    '<path d="M4.75 6.92A8.85 8.85 0 1 1 3.28 10.46L5.75 10.9A6.35 6.35 0 1 0 6.8 8.36Z"/>' +
      '<path d="M3.9 6.33L7.65 8.95 4.49 10.81Z"/>' +
      '<path d="M10.9 7.4L10.9 12A1.1 1.1 0 0 0 11.49 12.97L14.89 14.77A1.1 1.1 0 0 0 15.91 12.83L13.1 11.34 13.1 7.4A1.1 1.1 0 0 0 10.9 7.4Z"/>',
  ),
  sparkle: S(
    '<path d="M11.2 3.4c0 4.2 2.8 7 7 7-4.2 0-7 2.8-7 7 0-4.2-2.8-7-7-7 4.2 0 7-2.8 7-7Z"/>' +
      '<path d="M17.45 14.9L17.45 18.9A.85.85 0 0 0 19.15 18.9L19.15 14.9A.85.85 0 0 0 17.45 14.9Z"/>' +
      '<path d="M16.3 17.75L20.3 17.75A.85.85 0 0 0 20.3 16.05L16.3 16.05A.85.85 0 0 0 16.3 17.75Z"/>',
  ),
  wand: S(
    '<path d="M5.22 20.62L15.02 10.82A1.3 1.3 0 0 0 13.18 8.98L3.38 18.78A1.3 1.3 0 0 0 5.22 20.62Z"/>' +
      '<path d="M16.9 2.7Q17.78 6.22 21.3 7.1 17.78 7.98 16.9 11.5 16.02 7.98 12.5 7.1 16.02 6.22 16.9 2.7Z"/>' +
      '<path d="M6.2 3.7Q6.64 5.46 8.4 5.9 6.64 6.34 6.2 8.1 5.76 6.34 4 5.9 5.76 5.46 6.2 3.7Z"/>' +
      '<path d="M19.9 13Q20.34 14.76 22.1 15.2 20.34 15.64 19.9 17.4 19.46 15.64 17.7 15.2 19.46 14.76 19.9 13Z"/>',
  ),
  paperclip: S(
    '<g transform="rotate(45 12 12)">' +
      '<path d="M18.6 13A6.6 6.6 0 0 1 5.4 13L7.8 13A4.2 4.2 0 0 0 16.2 13Z"/>' +
      '<path d="M5.4 5.6L5.4 13A1.2 1.2 0 0 0 7.8 13L7.8 5.6A1.2 1.2 0 0 0 5.4 5.6Z"/>' +
      '<path d="M16.2 8L16.2 13A1.2 1.2 0 0 0 18.6 13L18.6 8A1.2 1.2 0 0 0 16.2 8Z"/>' +
      '<path d="M9.4 8A4.6 4.6 0 0 1 18.6 8L16.2 8A2.2 2.2 0 0 0 11.8 8Z"/>' +
      '<path d="M9.4 8L9.4 12.6A1.2 1.2 0 0 0 11.8 12.6L11.8 8A1.2 1.2 0 0 0 9.4 8Z"/>' +
      '</g>',
  ),
  // The ring is left open on the lower right and the tail stops inside that
  // opening: joined up, the mark closes into a copyright sign.
  at: S(
    '<path d="M18.05 18.05A8.55 8.55 0 1 1 19 7.1L16.96 8.53A6.05 6.05 0 1 0 16.28 16.28Z"/>' +
      '<circle cx="11.6" cy="12" r="3.1"/>' +
      '<path d="M14.13 13.86L19.53 16.06A1.25 1.25 0 0 0 20.47 13.74L15.07 11.54A1.25 1.25 0 0 0 14.13 13.86Z"/>',
  ),
  // A paper plane in two halves with the fold left open between them — the
  // arrow this used to be was the same picture as "next", and the composer's
  // primary action should not be a navigation mark. The crease closes to a
  // point at the nose and opens toward the tail, because a gap in the fill is
  // the only fold a solid mark can carry: a line drawn over the silhouette
  // would be the stroke this set does not have.
  send: S(
    '<path d="M19.17 3.82A0.29 0.29 0 0 1 19.44 4.32L10.5 12.11A1.63 1.63 0 0 1 8.57 12.26L4.8 9.95A0.91 0.91 0 0 1 5.01 8.3L19.17 3.82Z"/>' +
      '<path d="M19.58 4.46A0.23 0.23 0 0 1 19.97 4.7L14.03 19.16A0.8 0.8 0 0 1 12.53 19.1L11.4 15.55A2.31 2.31 0 0 1 11.86 13.33L19.58 4.46Z"/>',
  ),
  sliders: S(
    '<path d="M4.3 9.2L7.6 9.2A1.2 1.2 0 0 0 7.6 6.8L4.3 6.8A1.2 1.2 0 0 0 4.3 9.2Z"/>' +
      '<path d="M12.8 9.2L19.7 9.2A1.2 1.2 0 0 0 19.7 6.8L12.8 6.8A1.2 1.2 0 0 0 12.8 9.2Z"/>' +
      '<circle cx="10.2" cy="8" r="2.75"/>' +
      '<path d="M4.3 17.2L11.4 17.2A1.2 1.2 0 0 0 11.4 14.8L4.3 14.8A1.2 1.2 0 0 0 4.3 17.2Z"/>' +
      '<path d="M16.6 17.2L19.7 17.2A1.2 1.2 0 0 0 19.7 14.8L16.6 14.8A1.2 1.2 0 0 0 16.6 17.2Z"/>' +
      '<circle cx="14" cy="16" r="2.75"/>',
  ),
  check: S(
    '<path d="M4.05 13.35L8.95 18.25A1.35 1.35 0 0 0 10.92 18.19L20.02 7.79A1.35 1.35 0 0 0 17.98 6.01L9.83 15.33 5.95 11.45A1.35 1.35 0 0 0 4.05 13.35Z"/>',
  ),
  doubleCheck: S(
    '<path d="M2.12 13.48L6.32 17.68A1.25 1.25 0 0 0 8.12 17.65L16.12 9.05A1.25 1.25 0 0 0 14.28 7.35L7.17 15 3.88 11.72A1.25 1.25 0 0 0 2.12 13.48Z"/>' +
      '<path d="M10.72 16.08L12.52 17.88A1.25 1.25 0 0 0 14.36 17.81L21.96 8.81A1.25 1.25 0 0 0 20.04 7.19L13.32 15.15 12.48 14.32A1.25 1.25 0 0 0 10.72 16.08Z"/>',
  ),
  checkCircle: S(
    '<path fill-rule="evenodd" d="M3.1 12a8.9 8.9 0 1 0 17.8 0 8.9 8.9 0 1 0-17.8 0Z' +
      'M7.49 13.01L10.19 15.71A1 1 0 0 0 11.65 15.66L16.65 9.96A1 1 0 0 0 15.15 8.64L10.85 13.54 8.91 11.59A1 1 0 0 0 7.49 13.01Z"/>',
  ),
  closeCircle: S(
    '<path fill-rule="evenodd" transform="rotate(45 12 12)" d="M3.1 12a8.9 8.9 0 1 0 17.8 0 8.9 8.9 0 1 0-17.8 0Z' +
      'M13.05 8.35A1.05 1.05 0 0 0 10.95 8.35L10.95 10.95 8.35 10.95A1.05 1.05 0 0 0 8.35 13.05L10.95 13.05 10.95 15.65A1.05 1.05 0 0 0 13.05 15.65L13.05 13.05 15.65 13.05' +
      'A1.05 1.05 0 0 0 15.65 10.95L13.05 10.95Z"/>',
  ),
  minusCircle: S(
    '<path fill-rule="evenodd" d="M3.1 12a8.9 8.9 0 1 0 17.8 0 8.9 8.9 0 1 0-17.8 0ZM8.3 13L15.7 13A1 1 0 0 0 15.7 11L8.3 11A1 1 0 0 0 8.3 13Z"/>',
  ),
  helpCircle: S(
    '<path fill-rule="evenodd" d="M3.1 12a8.9 8.9 0 1 0 17.8 0 8.9 8.9 0 1 0-17.8 0Z' +
      'M10.26 10.22L10.73 8.43 12 7.85 13.27 8.43 13.62 9.75 12.53 11.11 11.43 11.94A.95.95 0 0 0 11.05 12.7L11.05 13.9A.95.95 0 0 0 12.95 13.9L12.95 13.18 13.77 12.56' +
      'A.95.95 0 0 0 13.94 12.39L15.4 10.56A.95.95 0 0 0 15.58 9.72L14.99 7.51A.95.95 0 0 0 14.47 6.9L12.4 5.94A.95.95 0 0 0 11.6 5.94L9.53 6.9A.95.95 0 0 0 9.01 7.51' +
      'L8.42 9.72A.95.95 0 0 0 10.26 10.22ZM10.8 16.4a1.2 1.2 0 1 0 2.4 0 1.2 1.2 0 1 0-2.4 0Z"/>',
  ),
  alert: S(
    '<path fill-rule="evenodd" d="M10.2 4.5a2.05 2.05 0 0 1 3.6 0l6.9 11.9a2.05 2.05 0 0 1-1.78 3.08H5.08a2.05 2.05 0 0 1-1.78-3.08z' +
      'M11.05 9.4L11.05 13.4A.95.95 0 0 0 12.95 13.4L12.95 9.4A.95.95 0 0 0 11.05 9.4ZM10.85 16.4a1.15 1.15 0 1 0 2.3 0 1.15 1.15 0 1 0-2.3 0Z"/>',
  ),
  clock: S(
    '<path fill-rule="evenodd" d="M3.1 12a8.9 8.9 0 1 0 17.8 0 8.9 8.9 0 1 0-17.8 0Z' +
      'M11.05 7.2L11.05 12.2A.95.95 0 0 0 11.56 13.04L15.16 14.94A.95.95 0 0 0 16.04 13.26L12.95 11.63 12.95 7.2A.95.95 0 0 0 11.05 7.2Z"/>',
  ),
  // Two of the same bust, the one behind bitten back where the one in front
  // would touch it. Without that cut the pair fills in and reads as a single
  // wide shoulder.
  users: S(
    '<circle cx="9.3" cy="8.1" r="3.9"/>' +
      '<path d="M2.4 20.9C2.4 16.68 6.2 14.1 9.3 14.1 12.41 14.1 16.2 16.68 16.2 20.9Z"/>' +
      '<circle cx="17.4" cy="7.6" r="3.1"/>' +
      '<path fill-rule="evenodd" d="M12.2 20.4C12.2 16.37 15.06 13.9 17.4 13.9 19.74 13.9 22.6 16.37 22.6 20.4ZM1.2 22C1.2 16.42 5.66 13 9.3 13 12.95 13 17.4 16.42 17.4 22Z"/>',
  ),
  lock: S(
    '<path d="M6.65 9.9A5.35 5.35 0 0 1 17.35 9.9L14.95 9.9A2.95 2.95 0 0 0 9.05 9.9Z"/>' +
      '<path fill-rule="evenodd" d="M8.2 9.9h7.6a3.9 3.9 0 0 1 3.9 3.9v2.6a3.9 3.9 0 0 1-3.9 3.9h-7.6a3.9 3.9 0 0 1-3.9-3.9v-2.6a3.9 3.9 0 0 1 3.9-3.9Z' +
      'M10.35 15.1a1.65 1.65 0 1 0 3.3 0 1.65 1.65 0 1 0-3.3 0Z"/>',
  ),
  play: S(
    '<path d="M8.2 5.8a1.15 1.15 0 0 1 1.75-.98l8.5 6.2a1.15 1.15 0 0 1 0 1.96l-8.5 6.2A1.15 1.15 0 0 1 8.2 18.2z"/>',
  ),
  pause: S(
    '<rect x="6.8" y="4.4" width="4.1" height="15.2" rx="2.05"/>' +
      '<rect x="13.1" y="4.4" width="4.1" height="15.2" rx="2.05"/>',
  ),
  // A filled world with its graticule cut out. The cuts are laid out so that
  // no two of them cross: an overlap would fill itself back in and leave a
  // blot where a meridian meets a parallel.
  globe: S(
    '<path fill-rule="evenodd" d="M3.1 12a8.9 8.9 0 1 0 17.8 0 8.9 8.9 0 1 0-17.8 0ZM3.86 8.4L20.14 8.4A8.9 8.9 0 0 1 20.75 10.4L3.25 10.4A8.9 8.9 0 0 1 3.86 8.4Z' +
      'M3.25 13.6L20.75 13.6A8.9 8.9 0 0 1 20.14 15.6L3.86 15.6A8.9 8.9 0 0 1 3.25 13.6ZM8.43 8.4A3.9 8.9 0 0 1 15.57 8.4L14.15 8.4A2.35 8.9 0 0 0 9.85 8.4Z' +
      'M15.57 15.6A3.9 8.9 0 0 1 8.43 15.6L9.85 15.6A2.35 8.9 0 0 0 14.15 15.6ZM15.84 10.4A3.9 8.9 0 0 1 15.84 13.6L14.31 13.6A2.35 8.9 0 0 0 14.31 10.4Z' +
      'M8.16 10.4A3.9 8.9 0 0 0 8.16 13.6L9.69 13.6A2.35 8.9 0 0 1 9.69 10.4Z"/>',
  ),
  shield: S(
    '<path fill-rule="evenodd" d="M12 21c-4.4-1.6-7.4-4.9-7.4-9.3V6.3c0-.62.38-1.17.96-1.4l6-2.24a1.5 1.5 0 0 1 1.04 0l6 2.24c.58.23.96.78.96 1.4v5.4c0 4.4-3 7.7-7.4 9.3z' +
      'M8.53 12.57L10.53 14.57A.95.95 0 0 0 11.93 14.51L15.63 10.11A.95.95 0 0 0 14.17 8.89L11.14 12.5 9.87 11.23A.95.95 0 0 0 8.53 12.57Z"/>',
  ),
  sync: S(
    '<path d="M21.1 12A9.1 9.1 0 0 1 3.45 15.11L5.7 14.29A6.7 6.7 0 0 0 18.7 12Z"/>' +
      '<path d="M2.5 15.46L6.65 13.95 4.14 11.17Z"/>' +
      '<path d="M2.9 12A9.1 9.1 0 0 1 20.55 8.89L18.3 9.71A6.7 6.7 0 0 0 5.3 12Z"/>' +
      '<path d="M21.5 8.54L17.35 10.05 19.86 12.83Z"/>',
  ),
  // Three stacked slabs with air between them rather than one filled
  // cylinder with its bands cut out: the gaps are the drum, and they survive
  // being drawn at 14px where a cut-out hairline would not.
  database: S(
    '<ellipse cx="12" cy="6" rx="7.4" ry="3"/>' +
      '<path d="M4.6 7.7A7.4 3 0 0 0 19.4 7.7V11.9A7.4 3 0 0 1 4.6 11.9Z"/>' +
      '<path d="M4.6 13.6A7.4 3 0 0 0 19.4 13.6V17.8A7.4 3 0 0 1 4.6 17.8Z"/>',
  ),
  cpu: S(
    '<path fill-rule="evenodd" d="M9.8 6.4h4.4a3.4 3.4 0 0 1 3.4 3.4v4.4a3.4 3.4 0 0 1-3.4 3.4h-4.4a3.4 3.4 0 0 1-3.4-3.4v-4.4a3.4 3.4 0 0 1 3.4-3.4Z' +
      'M11.3 9.7h1.4a1.6 1.6 0 0 1 1.6 1.6v1.4a1.6 1.6 0 0 1-1.6 1.6h-1.4a1.6 1.6 0 0 1-1.6-1.6v-1.4a1.6 1.6 0 0 1 1.6-1.6Z"/>' +
      '<path d="M8.62 3.6L8.62 6.8A.97.97 0 0 0 10.57 6.8L10.57 3.6A.97.97 0 0 0 8.62 3.6Z"/>' +
      '<path d="M13.43 3.6L13.43 6.8A.97.97 0 0 0 15.38 6.8L15.38 3.6A.97.97 0 0 0 13.43 3.6Z"/>' +
      '<path d="M8.62 17.2L8.62 20.4A.97.97 0 0 0 10.57 20.4L10.57 17.2A.97.97 0 0 0 8.62 17.2Z"/>' +
      '<path d="M13.43 17.2L13.43 20.4A.97.97 0 0 0 15.38 20.4L15.38 17.2A.97.97 0 0 0 13.43 17.2Z"/>' +
      '<path d="M3.6 10.57L6.8 10.57A.97.97 0 0 0 6.8 8.62L3.6 8.62A.97.97 0 0 0 3.6 10.57Z"/>' +
      '<path d="M3.6 15.38L6.8 15.38A.97.97 0 0 0 6.8 13.43L3.6 13.43A.97.97 0 0 0 3.6 15.38Z"/>' +
      '<path d="M17.2 10.57L20.4 10.57A.97.97 0 0 0 20.4 8.62L17.2 8.62A.97.97 0 0 0 17.2 10.57Z"/>' +
      '<path d="M17.2 15.38L20.4 15.38A.97.97 0 0 0 20.4 13.43L17.2 13.43A.97.97 0 0 0 17.2 15.38Z"/>',
  ),
  layers: S(
    '<path d="m12 2.6 9.4 4.9-9.4 4.9-9.4-4.9z"/>' +
      '<path d="M2.85 11.87L11.45 16.27A1.2 1.2 0 0 0 12.55 16.27L21.15 11.87A1.2 1.2 0 0 0 20.05 9.73L12 13.85 3.95 9.73A1.2 1.2 0 0 0 2.85 11.87Z"/>' +
      '<path d="M2.85 15.97L11.45 20.37A1.2 1.2 0 0 0 12.55 20.37L21.15 15.97A1.2 1.2 0 0 0 20.05 13.83L12 17.95 3.95 13.83A1.2 1.2 0 0 0 2.85 15.97Z"/>',
  ),
  terminal: S(
    '<path fill-rule="evenodd" d="M7.4 4.4h9.2a4.6 4.6 0 0 1 4.6 4.6v6a4.6 4.6 0 0 1-4.6 4.6h-9.2a4.6 4.6 0 0 1-4.6-4.6v-6a4.6 4.6 0 0 1 4.6-4.6Z' +
      'M6.93 10.37L8.86 12.3 6.93 14.23A.95.95 0 0 0 8.27 15.57L10.87 12.97A.95.95 0 0 0 10.87 11.63L8.27 9.03A.95.95 0 0 0 6.93 10.37Z' +
      'M13 15.85L16.8 15.85A.95.95 0 0 0 16.8 13.95L13 13.95A.95.95 0 0 0 13 15.85Z"/>',
  ),
  refresh: S(
    '<path d="M16.58 4.08A9.15 9.15 0 1 1 9.63 3.16L10.28 5.58A6.65 6.65 0 1 0 15.33 6.24Z"/>' +
      '<path d="M9.36 2.16L10.55 6.58 13.24 4.2Z"/>',
  ),
  folderPlus: S(
    '<path fill-rule="evenodd" d="M6.8 5.6h2.1c.7 0 1.38.22 1.94.63l1.86 1.37h4.5a3.3 3.3 0 0 1 3.3 3.3v5.6a3.3 3.3 0 0 1-3.3 3.3H6.8a3.3 3.3 0 0 1-3.3-3.3V8.9a3.3 3.3 0 0 1 3.3-3.3z' +
      'M12.95 11.55A.95.95 0 0 0 11.05 11.55L11.05 12.65 9.95 12.65A.95.95 0 0 0 9.95 14.55L11.05 14.55 11.05 15.65A.95.95 0 0 0 12.95 15.65L12.95 14.55 14.05 14.55' +
      'A.95.95 0 0 0 14.05 12.65L12.95 12.65Z"/>',
  ),
  columns: S(
    '<path fill-rule="evenodd" d="M7.8 4.6h8.4a4.4 4.4 0 0 1 4.4 4.4v6a4.4 4.4 0 0 1-4.4 4.4h-8.4a4.4 4.4 0 0 1-4.4-4.4v-6a4.4 4.4 0 0 1 4.4-4.4ZM11.05 4.6h1.9v14.8h-1.9Z"/>',
  ),
  info: S(
    '<path fill-rule="evenodd" d="M3.1 12a8.9 8.9 0 1 0 17.8 0 8.9 8.9 0 1 0-17.8 0ZM11.05 11.6L11.05 16.3A.95.95 0 0 0 12.95 16.3L12.95 11.6A.95.95 0 0 0 11.05 11.6Z' +
      'M10.75 7.9a1.25 1.25 0 1 0 2.5 0 1.25 1.25 0 1 0-2.5 0Z"/>',
  ),
  chart: S(
    '<path d="M3.15 3.6L3.15 17.8A1.25 1.25 0 0 0 4.4 19.05L19.8 19.05A1.25 1.25 0 0 0 19.8 16.55L5.65 16.55 5.65 3.6A1.25 1.25 0 0 0 3.15 3.6Z"/>' +
      '<path d="M10.2 17L10.2 13A1.2 1.2 0 0 0 7.8 13L7.8 17A1.2 1.2 0 0 0 10.2 17Z"/>' +
      '<path d="M14.2 17L14.2 8.6A1.2 1.2 0 0 0 11.8 8.6L11.8 17A1.2 1.2 0 0 0 14.2 17Z"/>' +
      '<path d="M18.2 17L18.2 11A1.2 1.2 0 0 0 15.8 11L15.8 17A1.2 1.2 0 0 0 18.2 17Z"/>',
  ),
  logout: S(
    '<path d="M15.3 3.4h1.9a3.3 3.3 0 0 1 3.3 3.3v10.6a3.3 3.3 0 0 1-3.3 3.3h-1.9a1.3 1.3 0 0 1 0-2.6h1.9a.7.7 0 0 0 .7-.7V6.7a.7.7 0 0 0-.7-.7h-1.9a1.3 1.3 0 0 1 0-2.6z"/>' +
      '<path d="M14.2 10.75L5.6 10.75A1.25 1.25 0 0 0 5.6 13.25L14.2 13.25A1.25 1.25 0 0 0 14.2 10.75Z"/>' +
      '<path d="M8.32 6.32L3.52 11.12A1.25 1.25 0 0 0 3.52 12.88L8.32 17.68A1.25 1.25 0 0 0 10.08 15.92L6.17 12 10.08 8.08A1.25 1.25 0 0 0 8.32 6.32Z"/>',
  ),
  external: S(
    '<path d="M10.4 4H6a3.8 3.8 0 0 0-3.8 3.8V18A3.8 3.8 0 0 0 6 21.8h9.2a3.8 3.8 0 0 0 3.8-3.8v-4.4a1.3 1.3 0 0 0-2.6 0V18a1.2 1.2 0 0 1-1.2 1.2H6A1.2 1.2 0 0 1 4.8 18V7.8' +
      'A1.2 1.2 0 0 1 6 6.6h4.4a1.3 1.3 0 0 0 0-2.6z"/>' +
      '<path d="M12.38 13.38L20.28 5.48A1.25 1.25 0 0 0 18.52 3.72L10.62 11.62A1.25 1.25 0 0 0 12.38 13.38Z"/>' +
      '<path d="M13.6 4.65L19.35 4.65 19.35 10.4A1.25 1.25 0 0 0 21.85 10.4L21.85 3.4A1.25 1.25 0 0 0 20.6 2.15L13.6 2.15A1.25 1.25 0 0 0 13.6 4.65Z"/>',
  ),
  bolt: S('<path d="M13.6 2.4 5.1 13.5h5.7l-.4 8.1 8.5-11.1h-5.7z"/>'),
  // A filled almond with the iris cut out and the pupil dropped back inside
  // it, so the eye still has a middle at the sizes this control is used at.
  eye: S(
    '<path fill-rule="evenodd" d="M2.2 12c1.6-2.9 5.3-6.6 9.8-6.6s8.2 3.7 9.8 6.6c-1.6 2.9-5.3 6.6-9.8 6.6S3.8 14.9 2.2 12zM8.5 12a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0Z' +
      'M10.5 12a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0Z"/>',
  ),
  menu: S(
    '<path d="M4 8.15L20 8.15A1.25 1.25 0 0 0 20 5.65L4 5.65A1.25 1.25 0 0 0 4 8.15Z"/>' +
      '<path d="M4 13.25L20 13.25A1.25 1.25 0 0 0 20 10.75L4 10.75A1.25 1.25 0 0 0 4 13.25Z"/>' +
      '<path d="M4 18.35L20 18.35A1.25 1.25 0 0 0 20 15.85L4 15.85A1.25 1.25 0 0 0 4 18.35Z"/>',
  ),
  chatBubble: S(
    '<path d="M12 3.6c-4.75 0-8.6 3.5-8.6 7.8 0 2.06.89 3.94 2.34 5.34l-.72 3.42a.8.8 0 0 0 1.16.88l3.66-1.94c.7.13 1.42.2 2.16.2 4.75 0 8.6-3.5 8.6-7.9s-3.85-7.8-8.6-7.8z"/>',
  ),
  smile: S(
    '<path fill-rule="evenodd" d="M3.1 12a8.9 8.9 0 1 0 17.8 0 8.9 8.9 0 1 0-17.8 0ZM7.75 10a1.35 1.35 0 1 0 2.7 0 1.35 1.35 0 1 0-2.7 0Z' +
      'M13.55 10a1.35 1.35 0 1 0 2.7 0 1.35 1.35 0 1 0-2.7 0ZM15.98 14.6A4.6 4.6 0 0 1 8.02 14.6L9.58 13.7A2.8 2.8 0 0 0 14.42 13.7Z"/>',
  ),
  reply: S(
    '<path d="M8.58 5.58L3.48 10.68A1.3 1.3 0 0 0 3.48 12.52L8.58 17.62A1.3 1.3 0 0 0 10.42 15.78L6.24 11.6 10.42 7.42A1.3 1.3 0 0 0 8.58 5.58Z"/>' +
      '<path d="M4.4 12.9L13.2 12.9A1.3 1.3 0 0 0 13.2 10.3L4.4 10.3A1.3 1.3 0 0 0 4.4 12.9Z"/>' +
      '<path d="M13.2 10.3A7.7 7.7 0 0 1 20.9 18L18.3 18A5.1 5.1 0 0 0 13.2 12.9Z"/>' +
      '<path d="M18.3 18L18.3 19.4A1.3 1.3 0 0 0 20.9 19.4L20.9 18A1.3 1.3 0 0 0 18.3 18Z"/>',
  ),
  // Two overlapping sheets — the clipboard glyph every surface uses for
  // "take these words with you". The sheet behind is cut back to an L so the
  // two do not merge into one block; a clasp would close up into a smudge at
  // 14px, so there isn't one.
  copy: S(
    '<path fill-rule="evenodd" d="M6.8 3.2h4.8a3.6 3.6 0 0 1 3.6 3.6v4.8a3.6 3.6 0 0 1-3.6 3.6h-4.8a3.6 3.6 0 0 1-3.6-3.6v-4.8a3.6 3.6 0 0 1 3.6-3.6Z' +
      'M12 7.4h1.4a4.6 4.6 0 0 1 4.6 4.6v1.4a4.6 4.6 0 0 1-4.6 4.6h-1.4a4.6 4.6 0 0 1-4.6-4.6v-1.4a4.6 4.6 0 0 1 4.6-4.6Z"/>' +
      '<rect x="8.6" y="8.6" width="12" height="12" rx="3.8"/>',
  ),
  pin: S(
    '<path d="m14.6 2.9 6.5 6.5-2.6.65-3.45 3.45-.3 3.85-1.5 1.5L4.9 10.4l1.5-1.53.85-.3 3.45-3.45z"/>' +
      '<path d="M7.77 14.67L3.12 19.32A1.1 1.1 0 0 0 4.68 20.88L9.33 16.23A1.1 1.1 0 0 0 7.77 14.67Z"/>',
  ),
  hash: S(
    '<path d="M9.31 3.67L7.51 20.07A1.2 1.2 0 0 0 9.89 20.33L11.69 3.93A1.2 1.2 0 0 0 9.31 3.67Z"/>' +
      '<path d="M15.11 3.67L13.31 20.07A1.2 1.2 0 0 0 15.69 20.33L17.49 3.93A1.2 1.2 0 0 0 15.11 3.67Z"/>' +
      '<path d="M4.1 10.4L19.7 10.4A1.2 1.2 0 0 0 19.7 8L4.1 8A1.2 1.2 0 0 0 4.1 10.4Z"/>' +
      '<path d="M3.7 16L19.3 16A1.2 1.2 0 0 0 19.3 13.6L3.7 13.6A1.2 1.2 0 0 0 3.7 16Z"/>',
  ),
  // The three answers the theme control offers, drawn on the same grid as
  // everything else here: a filled sun, a filled crescent, and a display for
  // "whatever this device is doing".
  sun: S(
    '<path fill-rule="evenodd" d="M12 6.4a5.6 5.6 0 1 1 0 11.2 5.6 5.6 0 0 1 0-11.2Z"/>' +
      '<path d="M10.8 2.6v1.9a1.2 1.2 0 0 0 2.4 0V2.6a1.2 1.2 0 0 0-2.4 0Z"/>' +
      '<path d="M10.8 19.5v1.9a1.2 1.2 0 0 0 2.4 0v-1.9a1.2 1.2 0 0 0-2.4 0Z"/>' +
      '<path d="M2.6 13.2h1.9a1.2 1.2 0 0 0 0-2.4H2.6a1.2 1.2 0 0 0 0 2.4Z"/>' +
      '<path d="M19.5 13.2h1.9a1.2 1.2 0 0 0 0-2.4h-1.9a1.2 1.2 0 0 0 0 2.4Z"/>' +
      '<path d="M4.93 6.63L6.27 7.97A1.2 1.2 0 0 0 7.97 6.27L6.63 4.93A1.2 1.2 0 0 0 4.93 6.63Z"/>' +
      '<path d="M16.03 17.73L17.37 19.07A1.2 1.2 0 0 0 19.07 17.37L17.73 16.03A1.2 1.2 0 0 0 16.03 17.73Z"/>' +
      '<path d="M17.73 7.97L19.07 6.63A1.2 1.2 0 0 0 17.37 4.93L16.03 6.27A1.2 1.2 0 0 0 17.73 7.97Z"/>' +
      '<path d="M6.27 19.07L7.97 17.37A1.2 1.2 0 0 0 6.27 16.03L4.93 17.37A1.2 1.2 0 0 0 6.27 19.07Z"/>',
  ),
  moon: S(
    '<path d="M20.1 14.6a8.6 8.6 0 0 1-10.7-10.7 1.2 1.2 0 0 0-1.6-1.4A9.9 9.9 0 1 0 21.5 16.2a1.2 1.2 0 0 0-1.4-1.6Z"/>',
  ),
  display: S(
    '<path fill-rule="evenodd" d="M5.4 3.9h13.2a3.1 3.1 0 0 1 3.1 3.1v6.6a3.1 3.1 0 0 1-3.1 3.1H5.4a3.1 3.1 0 0 1-3.1-3.1V7a3.1 3.1 0 0 1 3.1-3.1Z' +
      'M4.7 7.4a.9.9 0 0 1 .9-.9h12.8a.9.9 0 0 1 .9.9v5.8a.9.9 0 0 1-.9.9H5.6a.9.9 0 0 1-.9-.9z"/>' +
      '<path d="M8.2 18.9h7.6a1.2 1.2 0 0 0 0-2.4H8.2a1.2 1.2 0 0 0 0 2.4Z"/>',
  ),
  pencil: S(
    '<path fill-rule="evenodd" d="M3.8 20.2l1-4.6L15.6 4.8a2.2 2.2 0 0 1 3.1 0l.7.7a2.2 2.2 0 0 1 0 3.1L8.4 19.2z' +
      'M14.27 7.63L16.27 9.63A.75.75 0 0 0 17.33 8.57L15.33 6.57A.75.75 0 0 0 14.27 7.63Z"/>',
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
 * A row of attribution, written the way a source pill is: the things that did
 * or hold the work, then a few plain words about it.
 *
 * Prose is the wrong shape for "this agent, these files, that long ago" — it
 * costs a whole sentence to say what three chips say instantly, and a reader
 * skimming a digest never reaches the end of the sentence. Each pill takes an
 * optional `title` for the detail that would have bloated the label, so the
 * long version is a hover away rather than gone.
 *
 * Pills with no label are dropped rather than drawn empty: callers assemble
 * these from record fields that are often missing.
 *
 * The marks come from {@link ICONS}, the same set as every other glyph in the
 * interface. Pills used to carry small glossy rendered objects from a second
 * set, on the theory that colour and depth pick a chip out of a paragraph —
 * but a row that puts a rendered blue folder next to a flat drawn agent mark
 * reads as a mistake before it reads as a distinction, and the second set was
 * a whole extra icon language shipped for eight drawings. The pill's own
 * border and background do the picking-out; the mark inside it only has to
 * say which kind of thing this is.
 *
 * A pill that names an agent — `icon: "agent"`, with or without the record
 * itself — is drawn as that agent's own mark. There used to be a bot glyph
 * beside the file and the clock, and it was what a digest showed for Zeus:
 * the same anonymous robot on every row, in a panel whose whole job is saying
 * *who* did the work. The mark carries the vendor in its shape and the owner
 * in its colour, which is the thing a reader is actually looking for, so the
 * stand-in is gone rather than left as a fallback something could reach.
 */
export function pillBar(pills, note = "") {
  const chips = pills
    .filter((pill) => pill !== undefined && String(pill.label ?? "").trim() !== "")
    .map(
      (pill) =>
        `<span class="pill"${
          pill.title ? ` title="${esc(pill.title)}"` : ""
        }>${
          pill.agent === undefined && pill.icon !== "agent"
            ? icon(pill.icon)
            : agentFace(pill.agent, 18, { showPresence: false })
        }<span class="pill-label">${esc(
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
 * The full Kumi wordmark used on the auth shell.
 *
 * The letters are stroked polylines rather than filled outlines, because that
 * is what they are — one constant weight, flat cuts, no curves anywhere. The
 * letters use `currentColor`, so they remain right on dark and light.
 */
const BRAND_LETTERS = `<path d="M8.3 8V40"/>
    <path d="M42 11 13.5 24 42 37"/>
    <path d="M54.3 8v22.7l6.3 6.3h20.8l6.3-6.3V8"/>
    <path d="M102.3 8V40"/>
    <path d="M143.7 8V40"/>
    <path d="M102.3 10.5 123 30l20.7-19.5"/>
    <path d="M158.3 8V40"/>`;

/**
 * The mark itself: an isometric cube, drawn rather than photographed.
 *
 * The three visible faces meet at one interior vertex, and each carries a
 * short facet stroke that catches the light — enough to read as a solid,
 * without shading that would have to be redrawn for every theme.
 *
 * Every part of it is a stroked path in `currentColor`, so the whole mark is
 * one colour the surface around it chooses. The previous mark was a 280 kB
 * photograph of artwork with an opaque black field, keyed out at render time
 * by using its own luminance as a mask. That worked, but it cost a network
 * request before the first paint, it rasterised differently at different
 * sizes, and the keying could only ever approximate the edge it was cutting.
 * Paths have none of those problems: no request, no mask, and the same shape
 * at 16px and 1024px.
 */
const MARK_SHELL =
  "M29.92 9.08A4.16 4.16 0 0 1 34.08 9.08L50.92 18.8" +
  "A4.16 4.16 0 0 1 53 22.4L53 41.6A4.16 4.16 0 0 1 50.92 45.2" +
  "L34.08 54.92A4.16 4.16 0 0 1 29.92 54.92L13.08 45.2" +
  "A4.16 4.16 0 0 1 11 41.6L11 22.4A4.16 4.16 0 0 1 13.08 18.8Z";

/** Where the three faces meet — two arms up, one stem down. */
const MARK_SEAM = ["M12.25 20.72L32 32.12L51.75 20.72", "M32 32.12L32 54.68"];

/** One facet stroke per face, each parallel to that face's outer edge. */
const MARK_FACETS = [
  "M24.16 19.07L30.39 15.47",
  "M17.3 28.6L17.3 35.8",
  "M39.38 45.13L45.62 41.53",
];

/**
 * The stroke weight the mark is drawn at, as a share of its own box.
 *
 * Held here rather than in the stylesheet because it is geometry, not
 * styling: the facet strokes are spaced to clear this weight, and a heavier
 * one closes those gaps up rather than simply looking bolder.
 */
const MARK_STROKE = 3.52;

export function brandMark(size = 34) {
  return `<svg class="brand-mark" width="${size}" height="${size}"
    viewBox="0 0 64 64" fill="none" stroke="currentColor"
    stroke-width="${MARK_STROKE}" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true">
    ${[MARK_SHELL, ...MARK_SEAM, ...MARK_FACETS]
      .map((d) => `<path d="${d}"/>`)
      .join("\n    ")}
  </svg>`;
}

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
  // Copilot and Kiro are providers this deployment connects to whose own
  // marks are not vendored here. Drawn rather than left to fall through to
  // `generic`: the fallback is the one shape that says nothing about which
  // vendor an agent runs on, and an agent that lands on it reads as the
  // anonymous bot this panel was drawing before. Each is a filled silhouette
  // with its features cut out (`evenodd`), so it sits in the same family as
  // the vendor marks above and the fallback below.
  copilot: `<path fill-rule="evenodd" fill="currentColor"
      d="M12 3.1c-4.6 0-8.4 3.1-8.4 6.9v4.4c0 3.8 3.8 6.5 8.4 6.5s
      8.4-2.7 8.4-6.5V10c0-3.8-3.8-6.9-8.4-6.9m-3.4 7.5c1.2 0 2.1 1.1
      2.1 2.4s-.9 2.4-2.1 2.4-2.1-1.1-2.1-2.4.9-2.4 2.1-2.4m6.8 0c1.2 0
      2.1 1.1 2.1 2.4s-.9 2.4-2.1 2.4-2.1-1.1-2.1-2.4.9-2.4 2.1-2.4"/>`,
  kiro: `<path fill-rule="evenodd" fill="currentColor"
      d="M6.4 3.9h11.2A2.5 2.5 0 0 1 20.1 6.4v11.2a2.5 2.5 0 0 1-2.5
      2.5H6.4a2.5 2.5 0 0 1-2.5-2.5V6.4a2.5 2.5 0 0 1 2.5-2.5m2.9
      5.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5m5.4 0a1.75 1.75 0
      1 0 0 3.5 1.75 1.75 0 0 0 0-3.5M8.5 15.2a.95.95 0 0 0 0 1.9h7a
      .95.95 0 0 1 0-1.9z"/>`,
  // Anything this deployment can run but has no mark for. Ours to draw,
  // because there is no vendor to be faithful to — so it is drawn the way
  // the interface's own icons are: one filled silhouette with its eyes cut
  // out, in the same solid register as every mark above and beside it.
  generic: `<path fill-rule="evenodd" fill="currentColor"
      d="M11 2.4a1.3 1.3 0 0 1 2 0V7h3.9A4.1 4.1 0 0 1 21 11.1v4.6a4.1 4.1 0
      0 1-4.1 4.1H7.1A4.1 4.1 0 0 1 3 15.7v-4.6A4.1 4.1 0 0 1 7.1 7H11zm-1.6
      8.8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3m5.2 0a1.5 1.5 0 1 0 0 3 1.5
      1.5 0 0 0 0-3"/>`,
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
 * The dot a face carries for each status the roster can compute.
 *
 * The badge on a face and the badge in a roster row are the same statement
 * about the same agent, so they carry the same colours: green working, amber
 * idle, red for an agent only its owner can task, grey for one whose account
 * has no usage left (see `.status-*` in styles.css, which these mirror).
 * Anything unrecognised is offline, which is the honest answer for a face
 * drawn from a connection record rather than from a computed status.
 */
const FACE_PRESENCE = {
  working: "online",
  online: "online",
  idle: "idle",
  personal: "personal",
  exhausted: "exhausted",
  // Mapped explicitly even though the fall-through below already lands here.
  // An owner with no machine listening and an unrecognised status are not the
  // same thing, and a table that only works because of its own default is one
  // edit away from not working.
  offline: "offline",
};

/**
 * One agent, as its owner's colour.
 *
 * `agent.color` is the owner's identity colour; callers pass the colour of
 * whoever the agent belongs to, which is what makes a shared view legible.
 */
export function agentFace(agent, size = 34, indicator = {}) {
  const kind = agentKindOf(agent?.provider ?? agent?.id);
  const status = indicator.status ?? agent?.presence ?? "offline";
  // `Object.hasOwn` rather than a bare lookup: `status` reaches here from a
  // server-supplied record, and a name off the prototype ("constructor") would
  // otherwise be stringified straight into the class and the attribute.
  const presence = Object.hasOwn(FACE_PRESENCE, status)
    ? FACE_PRESENCE[status]
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
    )}">${vendorMark(kind)}${
      indicator.showPresence === false
        ? ""
        : `<i class="presence presence-${presence}"></i>`
    }${
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

/* ------------------------------------------------------- panel shapes ---- */

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
  // A confirmation whose Confirm removes something says so in the button, not
  // only in the sentence above it. Red before the press is the whole point.
  danger = false,
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
            <button class="btn ${danger ? "btn-danger" : "btn-primary"}" value="confirm" type="submit">${esc(confirm)}</button>
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
        // A radio group is several fields sharing one name, and only the
        // checked one is the answer. Assigning every match in turn left the
        // last in document order winning whatever the person picked — so a
        // three-way choice always returned its bottom option, and a dialog
        // that compared the result against the current value decided nothing
        // had changed and did nothing at all.
        if (field.type === "radio") {
          if (field.checked) {
            values[field.name] = field.value;
          } else if (!(field.name in values)) {
            // Recorded so a group with nothing checked resolves to a field
            // that exists and is empty, rather than to `undefined`.
            values[field.name] = "";
          }
          continue;
        }
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

/** Anchored information surface, with semantics chosen by its caller. */
export function showPopover(
  anchor,
  html,
  {
    width = 400,
    role = "dialog",
    className = "",
    scrim = true,
    modal = false,
  } = {},
) {
  closePopover();
  // Remembered so focus can go back where it came from: a popover that dumps
  // focus at the top of the document strands anyone navigating by keyboard.
  popoverReturn = anchor instanceof HTMLElement ? anchor : undefined;
  const layer = document.createElement("div");
  layer.className = `pop-layer${scrim ? "" : " pop-layer-clear"}`;
  layer.id = "pop-layer";
  layer.innerHTML = `<div class="pop-scrim" data-act="pop-close"></div>
    <div class="popover${className ? ` ${esc(className)}` : ""}"
      role="${esc(role)}"${modal ? ' aria-modal="true"' : ""}
      style="width:${width}px">${html}</div>`;
  $("#layer-root").append(layer);

  const pop = $(".popover", layer);
  const box = anchor.getBoundingClientRect();
  const margin = 10;
  const popWidth = pop.getBoundingClientRect().width;
  let left = box.right - popWidth;
  left = Math.max(
    margin,
    Math.min(left, window.innerWidth - popWidth - margin),
  );
  pop.style.left = `${left}px`;
  pop.style.setProperty(
    "--popover-origin-x",
    `${Math.max(12, Math.min(popWidth - 12, box.left + box.width / 2 - left))}px`,
  );
  const gap = 6;
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
  pop.classList.toggle("popover-above", top < box.top);

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
      event.preventDefault();
      closePopover();
      return;
    }
    if (role === "menu" && event.key === "Tab") {
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
 * Hints stay available as native titles rather than growing a command into a
 * two-line card. `meta` is the concise right slot for a count or shortcut.
 */
export function showMenu(anchor, items, { width } = {}) {
  const longestLabel = items.reduce(
    (length, item) => Math.max(length, String(item.label ?? "").length),
    0,
  );
  const menuWidth =
    width ?? (longestLabel > 24 ? 224 : longestLabel > 16 ? 196 : 176);
  const body = items
    .map((item) =>
      item.separator === true
        ? `<div class="menu-sep" role="separator"></div>`
        : item.group === true
          ? `<div class="menu-label" role="presentation">${esc(item.label)}</div>`
        : `<button type="button" class="menu-item${
            item.danger === true ? " menu-item-danger" : ""
          }" role="menuitem" tabindex="-1" data-act="${item.act}"${
            item.value === undefined ? "" : ` data-value="${esc(item.value)}"`
          }${item.hint === undefined ? "" : ` title="${esc(item.hint)}"`}${
            item.disabled === true ? ' disabled aria-disabled="true"' : ""
          }>${
            item.iconName === undefined ? "" : icon(item.iconName)
          }<span class="menu-item-text"><span class="menu-item-label">${esc(
            item.label,
          )}</span></span>${
            item.meta === undefined
              ? ""
              : `<span class="menu-item-meta">${esc(item.meta)}</span>`
          }</button>`,
    )
    .join("");
  const pop = showPopover(anchor, `<div class="menu">${body}</div>`, {
    width: menuWidth,
    role: "menu",
    className: "action-menu",
    scrim: false,
  });
  anchor.setAttribute("aria-haspopup", "menu");
  anchor.setAttribute("aria-expanded", "true");
  pop.setAttribute("aria-label", "Actions");
  const menu = $(".menu", pop);
  const choices = () => $$(".menu-item:not(:disabled)", menu);
  const focusAt = (index) => {
    const nodes = choices();
    if (nodes.length === 0) {
      return;
    }
    const target = nodes[(index + nodes.length) % nodes.length];
    for (const node of nodes) {
      node.tabIndex = node === target ? 0 : -1;
    }
    target.focus();
  };
  let typeahead = "";
  let typeaheadTimer;
  menu.addEventListener("keydown", (event) => {
    const nodes = choices();
    const current = nodes.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(current + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusAt(event.key === "Home" ? 0 : nodes.length - 1);
      return;
    }
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    typeahead += event.key.toLocaleLowerCase();
    window.clearTimeout(typeaheadTimer);
    typeaheadTimer = window.setTimeout(() => {
      typeahead = "";
    }, 500);
    const match = nodes.findIndex((node) =>
      node.textContent.trim().toLocaleLowerCase().startsWith(typeahead),
    );
    if (match >= 0) {
      event.preventDefault();
      focusAt(match);
    }
  });
  focusAt(0);
  return pop;
}

/**
 * How long `.pop-closing` is given before the layer is dropped, in ms.
 *
 * `--motion-panel-out` plus a frame. The stylesheet owns the exit and this
 * only owns the node, so it has to outlast the animation rather than match
 * it: dropping the layer on the same number races the last frame, and a
 * popover that disappears one frame early is the blink the exit exists to
 * prevent. If the token moves, this moves with it.
 */
const POP_EXIT_MS = 120;

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
  popoverReturn?.setAttribute("aria-expanded", "false");
  popoverReturn?.focus();
  popoverReturn = undefined;
}

/* ----------------------------------------------------------------- sound ---- */

/**
 * The small set of sounds the control room uses for meaningful feedback.
 *
 * Synthesised rather than played from a file: the page's CSP allows no
 * external asset, and a few oscillator notes cost nothing to ship or load.
 * `armChime` creates the context on the first real interaction so a later
 * message can sound too; browsers usually refuse to start audio from an
 * unsolicited socket callback.
 *
 * Failure is silent on purpose. A blocked or unavailable audio device is not
 * a reason to interrupt somebody with an error about sound.
 */
let toneContext;
let lastChimeAt = 0;

const CHIME_NOTES = {
  // Up confirms an action; down says something came back.
  sent: [523.25, 784],
  received: [660, 495],
  // A resolved run gets a complete chord, while attention is a restrained
  // repeated note rather than an alarm.
  success: [523.25, 659.25, 783.99],
  attention: [440, 440],
};

/** Several messages arriving in one socket burst are one interruption. */
const CHIME_COOLDOWN_MS = 300;

function soundEffectsEnabled() {
  return window.localStorage.getItem("ag.messageSounds") !== "false";
}

function contextForChime() {
  if (!soundEffectsEnabled()) {
    return undefined;
  }
  const Context = window.AudioContext ?? window.webkitAudioContext;
  if (Context === undefined) {
    return undefined;
  }
  toneContext ??= new Context();
  return toneContext;
}

/**
 * Gives later incoming sounds a browser-approved audio context, without
 * making a sound merely because somebody clicked or pressed a key.
 */
export function armChime() {
  try {
    void contextForChime()?.resume?.();
  } catch {
    /* Audio is an enhancement; an unavailable device changes nothing. */
  }
}

export function chime(kind = "sent") {
  try {
    const context = contextForChime();
    if (context === undefined) {
      return;
    }
    const now = Date.now();
    if (now - lastChimeAt < CHIME_COOLDOWN_MS) {
      return;
    }
    lastChimeAt = now;
    void context.resume?.();
    const at = context.currentTime;
    const notes = CHIME_NOTES[kind] ?? CHIME_NOTES.sent;
    for (const [index, frequency] of notes.entries()) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      // Quiet, and shaped: a square-edged tone at full volume is a beep
      // somebody will turn off within the hour.
      const start = at + index * 0.07;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.055, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.14);
    }
  } catch {
    /* No audio device, or a policy that forbids it. Not worth reporting. */
  }
}
