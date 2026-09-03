/**
 * Motion: what moves when the screen is replaced, and what is left alone.
 *
 * Rendering here is whole-screen and synchronous, so nothing survives a
 * redraw to animate itself. These take a reading of the old frame, let the
 * router replace everything, and play the difference - which is why they are
 * written as capture-then-play pairs rather than as transitions on a node.
 *
 * The three memories (`revealSeen`, `entranceSeen`, `phaseSeen`) are what
 * keep a re-render from replaying an animation somebody already watched, and
 * they are pruned rather than left to grow for the life of the tab.
 */

import { state } from "./data.js";
import { motionIsUnwanted } from "./ui.js";

export const MOTION_SURFACES = [
  {
    selector: ".primary-conversation-surface",
    parent: ".chan-main",
    enter: "primary-entering",
    leave: "primary-leaving",
    key: (node) => node.dataset.primaryKey ?? "",
  },
  // Thread, thread list, DM, agent profile and the file view share one column
  // that holds up to three of them, and each of them is tracked by name
  // through `key` — so this is "which surfaces are in the column", not "is
  // the column occupied". Without the key the column was one thing that was
  // either there or not, and a second tab opening beside the first was
  // therefore not a change at all: it appeared fully formed, in one frame,
  // while the tab already open jumped aside to make room for it.
  {
    selector: ".thread-panel",
    parent: ".chats-shell",
    enter: "panel-entering",
    leave: "panel-leaving",
    key: (node) => node.dataset.panelKey ?? "",
  },
  // The file tree, which is a drawer only below 900px. Above that it is an
  // ordinary grid column and never opens or closes at all — the classes are
  // still applied there and styled to do nothing, which keeps the width test
  // in the stylesheet where the rest of the breakpoint already lives.
  //
  // Open is asked of the shell rather than of the pane, because the pane is
  // in the markup either way and it is the modifier that decides.
  {
    selector: ".tree-pane",
    parent: ".code-shell",
    enter: "tree-entering",
    leave: "tree-leaving",
    isOpen: (root) => root.querySelector(".code-shell.tree-open") !== null,
  },
  {
    selector: ".tree-scrim",
    parent: ".code-shell",
    enter: "scrim-entering",
    leave: "scrim-leaving",
  },
  // The room's live line: somebody typing, an agent thinking. It is the one
  // thing in the transcript that is *replaced* by what it was announcing, so
  // it is the one thing that needs to be seen going — dots that blink out in
  // the same frame the answer appears read as the answer having interrupted
  // something rather than as it having arrived.
  //
  // Only the channel's own copy. The thread panel has a second one at the
  // foot of its body, and a surface here is re-appended to one parent by
  // selector, so a thread's dots would leave from the bottom of the room. The
  // exit is `position: absolute` against the transcript — which is already
  // the containing block — so a row on its way out cannot change the height
  // of a conversation somebody is pinned to the bottom of.
  {
    selector: "#chan-messages > .chan-typing",
    parent: "#chan-messages",
    enter: "typing-entering",
    leave: "typing-leaving",
    // Only back into the room it belonged to. Changing channels also ends a
    // typing line, and appending that one to the transcript that has just
    // opened would fade somebody else's dots at the foot of a conversation
    // they were never in. Left unplaced it is simply dropped, which is what
    // "it went away because you left" should look like.
    place: (parent, closed) => {
      if (parent.dataset.scrollKey !== `channel:${closed.dataset.typingRoom}`) {
        return;
      }
      // Silent on the way out. The transcript is a live region that announces
      // what is added to it, and this node has already been announced once —
      // put back for its exit it would be read out a second time, over the
      // answer that replaced it, which is the one thing anybody listening
      // actually wants to hear.
      closed.removeAttribute("aria-live");
      closed.setAttribute("aria-hidden", "true");
      parent.append(closed);
    },
  },
  // Settings is redrawn with the rest of the app. An animation on the bare
  // dialog would play from opacity 0 on every control that calls render —
  // theme, section, sounds — so the panel would vanish and settle again
  // while it was already open. The class is applied only when the overlay
  // was not on the last tree.
  {
    selector: ".settings-layer",
    parent: ".app",
    enter: "settings-entering",
    leave: "settings-leaving",
  },
];

/**
 * What each surface was showing before the swap: its keys, and the element
 * each one was.
 *
 * A map rather than a flag because a surface can be on screen more than once
 * — the right-hand column holds up to three panels — and "one of them opened"
 * is a different event from "the column opened". Surfaces that only ever have
 * one of themselves file it under the empty key and read exactly as they did.
 */
export const surfaceNodes = new Map();

/**
 * The live element for a surface, never the one a close is still fading out.
 *
 * The distinction is the whole reason this is a function. A closing surface is
 * put back into the shell and is, for those few frames, a perfectly ordinary
 * match for its own selector — so the next render would read it as "open
 * again", the render after that as "closed again", and the panel would sit
 * there fading out on a loop for as long as anything kept redrawing.
 */
export function liveNode(root, surface) {
  return root.querySelector(`${surface.selector}:not(.${surface.leave})`);
}

export function surfaceIsOpen(root, surface) {
  return surface.isOpen === undefined
    ? liveNode(root, surface) !== null
    : surface.isOpen(root);
}

/**
 * Every live copy of a surface, by key.
 *
 * A surface with no `key` has at most one copy and gets the empty key, which
 * is the whole of the old behaviour. A surface that decides whether it is
 * open from something other than its own element — the file tree, which is a
 * grid column above 900px — keeps answering that question, and files its one
 * element under the same empty key.
 */
export function liveNodes(root, surface) {
  const found = new Map();
  if (surface.isOpen !== undefined) {
    if (surfaceIsOpen(root, surface)) {
      found.set("", liveNode(root, surface));
    }
    return found;
  }
  for (const node of root.querySelectorAll(
    `${surface.selector}:not(.${surface.leave})`,
  )) {
    found.set(surface.key === undefined ? "" : surface.key(node), node);
  }
  return found;
}

/** Reads the outgoing document. Must run before `innerHTML` throws it away. */
export function captureSurfaceMotion(root) {
  for (const surface of MOTION_SURFACES) {
    surfaceNodes.set(surface.selector, liveNodes(root, surface));
  }
}

/** Plays whatever the swap turned out to be: an opening, a closing, or nothing. */
export function playSurfaceMotion(root) {
  for (const surface of MOTION_SURFACES) {
    const before = surfaceNodes.get(surface.selector) ?? new Map();
    const now = liveNodes(root, surface);
    for (const [key, node] of now) {
      if (before.has(key) || node === null) {
        continue;
      }
      animateOnce(node, surface.enter, false);
    }
    for (const [key, closed] of before) {
      if (now.has(key) || closed === null || closed === undefined) {
        continue;
      }
      const parent = root.querySelector(surface.parent);
      if (parent === null) {
        continue;
      }
      // Back in the document, but not back in the interface: it answers to
      // nothing, takes no focus, and is gone before the animation is cold.
      closed.inert = true;
      if (surface.place === undefined) {
        parent.append(closed);
      } else {
        surface.place(parent, closed);
      }
      animateOnce(closed, surface.leave, true);
    }
  }
}

/**
 * Wears a class for exactly one animation, then cleans up after itself.
 *
 * The timer is not a belt-and-braces second try at `animationend` — it is the
 * only guarantee. That event never fires at all when reduced motion has taken
 * the animation away, and browsers hold it back while a tab is in the
 * background, either of which would otherwise leave a closing panel pinned
 * over the screen until the next render happened to notice.
 */
export function animateOnce(node, className, drop) {
  node.classList.add(className);
  let done = false;
  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    node.removeEventListener("animationend", onEnd);
    node.classList.remove(className);
    if (drop) {
      node.remove();
    }
  };
  // `animationend` bubbles, and a panel is full of small animations of its
  // own — a status dot finishing a breath, a skeleton row shimmering. Without
  // this test the first of them to reach the top would end the panel's
  // animation on the panel's behalf, a frame or two in.
  const onEnd = (event) => {
    if (event.target === node) {
      finish();
    }
  };
  node.addEventListener("animationend", onEnd);
  window.setTimeout(finish, 400);
}

/* -------------------------------------------------------- text arrival ---- */

/**
 * The pace an answer opens at: how far apart the first few words start, and
 * how long each one takes to settle.
 *
 * Deliberately short. The effect is meant to be noticed at the edge of
 * attention and then be over — a line or two should read as one soft settle
 * rather than as a sentence being spelled out. Anything slower and the reader
 * is waiting on words they can already half-see.
 *
 * The word's own duration is stated here as well as in `.text-reveal-word`,
 * because this is what decides when an arrival is over and stops being
 * resumed; the stylesheet is what actually plays it.
 */
export const REVEAL_STAGGER_MS = 18;
export const REVEAL_WORD_MS = 220;

/**
 * The longest an arrival is ever spread over, however much was said.
 *
 * A reader takes the effect in from the first line; after that every extra
 * moment is spent watching text that is already written appear at walking
 * pace. So a long answer is not simply the opening pace repeated — it is the
 * same words, much closer together: the more there is to say, the quicker it
 * is said, and the ceiling here plus one word's settle is the longest any
 * message can hold the reader.
 */
export const REVEAL_MAX_TOTAL_MS = 420;

/**
 * How far apart consecutive words start, given how many there are.
 *
 * A short line is barely staggered at all: a handful of words are a fraction
 * of a beat apart, which is enough to read as arriving and little enough to
 * be finished before it can be studied. From there the gap closes off
 * smoothly — the spread approaches `REVEAL_MAX_TOTAL_MS` without ever
 * reaching it — so a paragraph lands in under half a second and a wall of
 * text is done inside two thirds of one. Nothing is truncated and there is no
 * cliff where a longer message suddenly stops animating; it just arrives
 * faster the more of it there is.
 */
export function revealStaggerFor(count) {
  if (count <= 1) {
    return 0;
  }
  return (
    REVEAL_MAX_TOTAL_MS /
    (count - 1 + REVEAL_MAX_TOTAL_MS / REVEAL_STAGGER_MS)
  );
}

/**
 * How many words are taken apart at all. Past this the remainder is left as
 * plain text: by then it is far below the fold, and at the pace a message
 * this long arrives at, the tail is landing within a few milliseconds of
 * itself anyway — a span apiece costs more than the effect is worth.
 */
export const REVEAL_MAX_WORDS = 120;

/** How many arrivals are remembered before the oldest are let go. */
export const REVEAL_MEMORY = 800;

/**
 * What this tab has already watched arrive, and when each one started.
 *
 * The screen is redrawn by replacing the whole document — see
 * `MOTION_SURFACES` — so "is this element new" is never the question CSS can
 * answer on its own. Every block that can animate carries a stable
 * `data-reveal` key, and this map is the only thing that knows whether the
 * words under that key are new to the reader or have been on screen for a
 * while.
 *
 * The timestamp is kept rather than a bare flag because a redraw lands in the
 * middle of most arrivals — somebody typing in the room is enough — and the
 * words have to pick the animation back up where the last frame left it
 * instead of starting over or snapping to the end.
 */
export const revealSeen = new Map();

/**
 * The surfaces that were on screen a moment ago, by the group half of the key.
 *
 * This is what separates "a message arrived" from "you opened a conversation
 * that already had a hundred of them". Only text belonging to a surface the
 * reader was already looking at animates; opening a channel, a thread or a
 * direct message shows its backlog the way it has always been shown, whole.
 */
export let revealGroups = new Set();

/** `group|id` — the group is the surface, the id is the block within it. */
export function revealGroupOf(key) {
  const cut = key.indexOf("|");
  return cut === -1 ? key : key.slice(0, cut);
}

/**
 * Plays whatever arrived in this render, and only what arrived.
 *
 * Runs after the swap, beside `playSurfaceMotion` and for the same reason:
 * the outgoing document is gone by then, and the render loop is the only
 * thing left that remembers what it was showing.
 */
export function playTextReveal(root) {
  const quiet = motionIsUnwanted();
  const now = Date.now();
  const groups = new Set();
  for (const block of root.querySelectorAll("[data-reveal]")) {
    const key = block.dataset.reveal ?? "";
    if (key === "") {
      continue;
    }
    const group = revealGroupOf(key);
    groups.add(group);
    const started = revealSeen.get(key);
    if (started === undefined) {
      // New to the document. Whether it is new to the *reader* is the
      // question the group answers: text in a surface that was not on screen
      // last time is a backlog being opened, not an answer coming in.
      const arriving = !quiet && revealGroups.has(group);
      revealSeen.set(key, arriving ? now : 0);
      if (arriving) {
        revealWords(block, 0);
      }
      continue;
    }
    // Zero means "was already here", which never animates. Anything else is
    // an arrival still in flight until its last word has landed.
    if (started === 0 || quiet) {
      continue;
    }
    const elapsed = now - started;
    if (elapsed < REVEAL_MAX_TOTAL_MS + REVEAL_WORD_MS) {
      revealWords(block, elapsed);
    }
  }
  revealGroups = groups;
  forgetOldReveals(groups);
}

/**
 * Keeps the map from growing for as long as the tab is open.
 *
 * Only keys from surfaces nobody is looking at are dropped: forgetting a
 * message still on screen would make it arrive a second time on the next
 * redraw, which is the one thing this whole mechanism exists to prevent.
 */
export function forgetOldReveals(groups) {
  if (revealSeen.size <= REVEAL_MEMORY) {
    return;
  }
  for (const key of revealSeen.keys()) {
    if (!groups.has(revealGroupOf(key))) {
      revealSeen.delete(key);
    }
  }
}

/** Text that is not prose, and is not taken apart. */
export const REVEAL_SKIPPED = new Set([
  "PRE",
  "CODE",
  "SCRIPT",
  "STYLE",
  "TEXTAREA",
  "SVG",
]);

/**
 * Text that is not a message either: it is a running task saying where it has
 * got to, and it will say something else in a moment.
 *
 * An arrival is a one-time event — a sentence landing in the room, word after
 * word — and live status copy is the opposite of that. Wrapping its words
 * would also cut the travelling highlight into one gradient per word, because
 * `.glimmer-text` paints itself across the whole line. See `threadLiveStatus`
 * in screen-chats.js for the line this is describing.
 */
export const REVEAL_SKIPPED_CLASS = "glimmer-text";

export function insideSkipped(node, root) {
  let parent = node.parentNode;
  while (parent !== null && parent !== root) {
    if (REVEAL_SKIPPED.has(String(parent.nodeName).toUpperCase())) {
      return true;
    }
    if (
      parent instanceof Element &&
      parent.classList.contains(REVEAL_SKIPPED_CLASS)
    ) {
      return true;
    }
    parent = parent.parentNode;
  }
  return false;
}

/**
 * A picture posted with the message.
 *
 * An attachment is part of the body rather than something beside it —
 * `messageBody` in screen-chats.js puts it inside the very block the words
 * are in — so it belongs to the same arrival. The link is what carries the
 * picture's box; the bare image is the fallback for anywhere one is written
 * without it.
 */
export function revealIsMedia(element) {
  return (
    element.classList.contains("cmsg-image") ||
    (String(element.nodeName).toUpperCase() === "IMG" &&
      element.hasAttribute("data-attachment"))
  );
}

/**
 * The outermost thing around this node that arrives in one piece, if any.
 *
 * A picture is not read word by word, and neither is a span of code inside a
 * sentence: each is one thing that appears, so each takes a single place in
 * the schedule instead of being split or — as both were — left out of it
 * altogether and shown whole while the words around them were still coming
 * in.
 *
 * Outermost, because a picture is a link around an image: counting it twice
 * would leave one copy waiting on the other in the middle of the message.
 */
export function revealWholeOf(node, block) {
  let found = null;
  for (
    let step = node;
    step !== null && step !== block;
    step = step.parentNode
  ) {
    if (
      step instanceof Element &&
      (revealIsMedia(step) || String(step.nodeName).toUpperCase() === "CODE")
    ) {
      found = step;
    }
  }
  return found;
}

/**
 * Wraps each piece of a block in its own element so it can come in on its own
 * delay, resuming `elapsed` milliseconds into the sequence.
 *
 * A negative delay is what does the resuming: the browser starts an animation
 * that far through rather than waiting, so a redraw two hundred milliseconds
 * into an arrival carries on from two hundred milliseconds instead of
 * replaying the opening. Whitespace is left as it was, which is what keeps
 * wrapping, selection and copied text identical to the markup underneath.
 *
 * A piece is usually a word, but the message is what arrives, not only its
 * prose: a picture posted with it takes a place in the same schedule, which
 * is also what gives a message of nothing but a picture an arrival at all.
 *
 * The block is the body and stops there. The quoted line above a reply, the
 * reactions under it and the buttons beside it are the room's furniture
 * rather than anything that was said, so they stay where they are — see the
 * `data-reveal` key in screen-chats.js for what a block is.
 */
export function revealWords(block, elapsed) {
  // One pass in reading order over the text and the elements together, so a
  // picture between two paragraphs arrives between them rather than before or
  // after everything else.
  const walker = document.createTreeWalker(
    block,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  );
  const parts = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Element) {
      if (revealWholeOf(node, block) === node && !insideSkipped(node, block)) {
        parts.push(node);
      }
      continue;
    }
    const text = node.nodeValue ?? "";
    if (
      text.trim() !== "" &&
      !insideSkipped(node, block) &&
      revealWholeOf(node, block) === null
    ) {
      parts.push(node);
    }
  }
  // Wrapped first and timed second: the stagger depends on how many pieces
  // there turned out to be, and that is only known once the last one is in
  // hand.
  const revealedPings = new Set();
  const words = [];
  for (const part of parts) {
    if (part instanceof Element) {
      // Kept however long the message runs to. A picture or a piece of code
      // is a handful of nodes at most, and one of them standing at full
      // strength beside a sentence that is still arriving is the whole thing
      // this is here to prevent.
      part.classList.add(
        revealIsMedia(part) ? "text-reveal-media" : "text-reveal-word",
      );
      words.push(part);
      continue;
    }
    if (words.length >= REVEAL_MAX_WORDS) {
      continue;
    }
    const ping = revealPingOf(part, block);
    if (ping !== null) {
      if (revealedPings.has(ping)) {
        continue;
      }
      revealedPings.add(ping);
      ping.classList.add("text-reveal-word");
      words.push(ping);
      continue;
    }
    const pieces = String(part.nodeValue).split(/(\s+)/u);
    const holder = document.createDocumentFragment();
    for (const piece of pieces) {
      if (piece === "") {
        continue;
      }
      if (piece.trim() === "" || words.length >= REVEAL_MAX_WORDS) {
        holder.append(piece);
        continue;
      }
      const word = document.createElement("span");
      word.className = "text-reveal-word";
      word.textContent = piece;
      holder.append(word);
      words.push(word);
    }
    part.replaceWith(holder);
  }
  const step = revealStaggerFor(words.length);
  for (const [index, word] of words.entries()) {
    word.style.setProperty(
      "--reveal-delay",
      `${Math.round(index * step - elapsed)}ms`,
    );
  }
}

/**
 * A posted ping or slash command, if this text node belongs to one.
 *
 * Those spans carry a coloured wash. Splitting them word by word would leave
 * the box visible while each piece faded in, so the whole token is tagged as
 * one arrival instead.
 */
export function revealPingOf(node, block) {
  let parent = node.parentNode;
  while (parent !== null && parent !== block) {
    if (
      parent instanceof Element &&
      (parent.classList.contains("mention-ping") ||
        parent.classList.contains("slash-ping"))
    ) {
      return parent;
    }
    parent = parent.parentNode;
  }
  return null;
}

/* ---------------------------------------------------- message arrival ---- */

/**
 * How long a message may still be settling into its place.
 *
 * The longest of the shell entrances rather than the common one: an ordinary
 * message takes `--motion-content`, and the artifact at the end of a run
 * takes `--motion-emphasis`. This is only the window in which a redraw
 * resumes an arrival instead of ignoring it, so the longer of the two is the
 * safe number — a resume that overshoots lands on an animation that has
 * already finished, which is where the message belongs anyway.
 */
export const ENTRANCE_MS = 300;

/** How many arrivals are remembered before the oldest are let go. */
export const ENTRANCE_MEMORY = 800;

/**
 * What this tab has already watched arrive, and when each one started.
 *
 * The twin of `revealSeen`, for the message rather than for the words in it,
 * and separate from it on purpose: the shell owns where a message is and the
 * reveal owns whether its text is legible yet, so each has to be able to
 * decide on its own that it has already played. Sharing one record would mean
 * a message whose words were skipped — a picture, a tombstone, a system line —
 * could never be given a position either.
 */
export const entranceSeen = new Map();

/** The surfaces that were on screen a moment ago, by the group half of the key. */
export let entranceGroups = new Set();

/**
 * Moves a message that is genuinely new into its place, once.
 *
 * The same test the words go through, for the same reason: the document is
 * replaced on every keystroke, every poll tick and every event off the
 * stream, so "is this element new" is not a question CSS can answer. A key
 * that was not in the map is new to the document; a key whose surface was not
 * on screen last time is a backlog being opened rather than a message
 * arriving, and a backlog is still.
 *
 * Position only. The words inside are already coming in on their own opacity,
 * and the one thing this must never do is fade a parent while every word
 * inside it fades too.
 */
export function playMessageEntrance(root) {
  const quiet = motionIsUnwanted();
  const now = Date.now();
  const groups = new Set();
  for (const shell of root.querySelectorAll("[data-entrance]")) {
    const key = shell.dataset.entrance ?? "";
    if (key === "") {
      continue;
    }
    const group = revealGroupOf(key);
    groups.add(group);
    const started = entranceSeen.get(key);
    if (started === undefined) {
      const arriving = !quiet && entranceGroups.has(group);
      entranceSeen.set(key, arriving ? now : 0);
      if (arriving) {
        startEntrance(shell, 0);
      }
      continue;
    }
    // Zero means "was already here", which never animates again.
    if (started === 0 || quiet) {
      continue;
    }
    const elapsed = now - started;
    if (elapsed < ENTRANCE_MS) {
      startEntrance(shell, elapsed);
    }
  }
  entranceGroups = groups;
  forgetOldEntrances(groups);
}

/**
 * A negative delay is what resumes an arrival a redraw landed in the middle
 * of, exactly as it does for a word. The animation has no fill mode, so a
 * message that is interrupted, or one whose animation never runs at all under
 * reduced motion, is simply where it belongs — there is no state it can be
 * left stuck in.
 */
export function startEntrance(shell, elapsed) {
  shell.style.setProperty("--entrance-delay", `${-Math.round(elapsed)}ms`);
  shell.classList.add("msg-entering");
}

/** Keeps the map from growing for as long as the tab is open. See `forgetOldReveals`. */
export function forgetOldEntrances(groups) {
  if (entranceSeen.size <= ENTRANCE_MEMORY) {
    return;
  }
  for (const key of entranceSeen.keys()) {
    if (!groups.has(revealGroupOf(key))) {
      entranceSeen.delete(key);
    }
  }
}

/* ------------------------------------------------------- phase changes ---- */

/**
 * How close together two phase reports have to be to count as one.
 *
 * A run narrates in bursts — planned, claimed, working on a file, working on
 * the next — and several can land in the same tick or a frame apart. Played
 * one after another that is a status line flickering through states nobody
 * could read, ending on the only one that mattered. Inside this window the
 * latest is simply written into the slot without a second swap: the reader
 * sees the current phase immediately, and sees it move once.
 */
export const PHASE_COALESCE_MS = 280;

/** How many slots are remembered before the oldest are let go. */
export const PHASE_MEMORY = 400;

/** What each phase slot last said, and when it last changed. */
export const phaseSeen = new Map();

/**
 * Swaps a live status line for the next phase, once per real change.
 *
 * Nothing here delays or withholds data: the render has already written the
 * current phase into the document, and this only decides whether the change
 * is allowed to be *seen* moving. An unchanged phase — which is what almost
 * every render carries — plays nothing at all, which is what keeps a
 * background redraw silent.
 */
export function playPhaseSlots(root) {
  const quiet = motionIsUnwanted();
  const now = Date.now();
  const live = new Set();
  for (const slot of root.querySelectorAll("[data-phase-slot]")) {
    const key = slot.dataset.phaseSlot ?? "";
    if (key === "") {
      continue;
    }
    live.add(key);
    const text = slot.textContent.trim();
    const last = phaseSeen.get(key);
    if (last === undefined) {
      // First sight of this task's status line. It arrived with its row.
      phaseSeen.set(key, { text, at: 0 });
      continue;
    }
    if (last.text === text) {
      continue;
    }
    // Coalesced: the newest text is on screen either way, and the swap that
    // is already playing is the one the reader is watching.
    const coalesce = last.at !== 0 && now - last.at < PHASE_COALESCE_MS;
    phaseSeen.set(key, { text, at: coalesce ? last.at : now });
    if (!quiet && !coalesce) {
      animateOnce(slot, "phase-changing", false);
    }
  }
  if (phaseSeen.size > PHASE_MEMORY) {
    for (const key of phaseSeen.keys()) {
      if (!live.has(key)) {
        phaseSeen.delete(key);
      }
    }
  }
}

/** A coalesced render waiting for the next frame, if one is waiting. */
