/**
 * Every discrete animation on the marketing site, in one module.
 *
 * The library is the vendored Motion UMD bundle (vendor/motion/motion.js,
 * MIT — licence served beside it). It is loaded as a classic script before
 * this module because its ES build re-exports from a bare specifier no
 * browser can resolve without a bundler, and this repo ships none.
 *
 * The gate is checked once, here, at the top — not sprinkled per effect.
 * The `anim` class that hides reveal targets is added here too, and only
 * here, after the gate passes: the file that hides content is the file that
 * animates it, so a failure to load anywhere in this module's graph leaves
 * the page fully visible rather than waiting on a reveal that will never
 * come. The page reads perfectly with this file absent; everything below is
 * decoration.
 *
 * Some effects here restyle real content — they empty a paragraph to retype
 * it, split a heading into word spans, zero a price to count it up. Every
 * one of those registers an undoer, and disarm() runs them all, so a motion
 * preference flipped mid-visit restores the page to exactly what the HTML
 * says rather than leaving it half-played.
 *
 * The point field is the one thing here that is not decoration, and it is
 * also the one thing that can fail on its own — no WebGL, a driver that
 * refuses, a shader that will not compile on some phone. It is therefore
 * started inside its own try, after everything else is wired, so a field that
 * cannot be drawn costs the field and nothing else.
 */

import { startField } from "./field.js";

// Read by the boot script's ?why diagnostics: proof this module's graph
// loaded, and which revision of it.
window.__kumiSiteRev = "w11";

// A breadcrumb per top-level step, printed by the ?why panel. On one phone
// the module provably ran its first statement and provably reached none of
// its later effects, with no error recorded anywhere — which means the
// engine stops somewhere in between, and this trace is how the somewhere
// gets a name.
window.__kumiTrace = ["module"];
function mark(step) {
  // The trace is diagnostics; losing a breadcrumb must never cost the page.
  try {
    window.__kumiTrace.push(step);
  } catch (error) {
    // A clobbered ledger is itself a finding the global error net reports.
  }
}

// Every animation failure lands here with a name and a message, and the
// ?why overlay prints them. A device this page misbehaves on is a device
// nobody can attach a debugger to; a caught exception with no record is
// how one stayed undiagnosed across four rounds of screenshots.
window.__kumiErrors = [];
mark("ledger");

function note(phase, error) {
  window.__kumiErrors.push(
    phase + ": " + (error instanceof Error ? error.message : String(error)),
  );
}

// Belt on the very first API call: a WebView with a broken matchMedia gets
// a stand-in that reports motion as welcome and accepts no listeners,
// rather than aborting the module three lines in.
let reduceMotion = {
  matches: false,
  addEventListener() {},
};
try {
  reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  mark("mql");
} catch (error) {
  note("matchMedia", error);
  mark("mql-threw");
}
const motion = window.Motion;
mark("motion:" + typeof motion);
const EASE = [0.32, 0.72, 0, 1];

let stopField;
let disarmed = false;

/**
 * Every scroll-armed reveal, until it fires. The IntersectionObserver is
 * the normal trigger, but it only reports elements that intersect on some
 * frame — and a smooth programmatic scroll being retargeted mid-glide can
 * carry an element straight past the viewport without one. Anything the
 * reader has already scrolled beyond is owed its content immediately, so a
 * sweep on every scroll fires whatever the observer missed. Content can be
 * late to the party; it cannot fail to arrive.
 */
const pendingReveals = new Map();

function fireReveal(el) {
  const fire = pendingReveals.get(el);
  if (fire === undefined || disarmed) {
    return;
  }
  pendingReveals.delete(el);
  try {
    fire();
  } catch (error) {
    note("reveal", error);
  }
}

/** What wire() changed and started, so disarm() can put all of it back. */
const undoers = [];
const timers = [];
const intervals = [];

function stage(el, style) {
  const names = Object.keys(style);
  for (const name of names) {
    el.style[name] = style[name];
  }
  undoers.push(() => {
    for (const name of names) {
      el.style[name] = "";
    }
  });
}

function later(ms) {
  return new Promise((resolve) => {
    timers.push(setTimeout(resolve, ms));
  });
}

function disarm() {
  disarmed = true;
  pendingReveals.clear();
  document.documentElement.classList.remove("anim");
  document.documentElement.classList.remove("field-live");
  for (const timer of timers) {
    clearTimeout(timer);
  }
  for (const interval of intervals) {
    clearInterval(interval);
  }
  for (const undo of undoers) {
    undo();
  }
  if (stopField !== undefined) {
    stopField();
    stopField = undefined;
  }
}

/**
 * The whole gate runs inside one guard, and the guard's failure path still
 * starts the water. On one phone the ?why panel read: module loaded, Motion
 * present, WebGL2 available, nothing 404ed, reduced motion off — and no
 * classes, no water, no recorded error. The only code that could produce
 * that exact panel was an unguarded line here, before the arming and before
 * the water, aborting the module's evaluation with nothing to note it. No
 * line in this gate is allowed to be that line again.
 */
mark("gate-call");
try {
  gate();
  mark("gate-done");
} catch (error) {
  note("gate", error);
  disarm();
  try {
    field();
  } catch (fieldError) {
    note("field", fieldError);
  }
}

function gate() {
  mark("gate-run");
  if (reduceMotion.matches) {
    mark("gate-reduced");
    disarm();
    return;
  }
  // A preference flipped mid-visit is honoured immediately: the CSS block
  // in site.css stops the continuous animations, dropping the class shows
  // anything still waiting on a scroll reveal, the undoers restore any text
  // an effect was mid-way through, and the water stops drawing. Some WebKit
  // builds only ship the legacy listener API on MediaQueryList; the flip is
  // an accessibility promise, so both forms are tried before giving up —
  // and giving up costs the flip, never the page.
  const onFlip = () => {
    if (reduceMotion.matches) {
      disarm();
    }
  };
  try {
    reduceMotion.addEventListener("change", onFlip);
    mark("listener");
  } catch (error) {
    try {
      reduceMotion.addListener(onFlip);
    } catch (legacyError) {
      note("reduce-flip", legacyError);
    }
  }
  if (motion !== undefined) {
    // The `anim` class is added HERE, by the file that will animate what it
    // hides — never by the boot script, and never on the promise that some
    // other file will follow through. A 404 anywhere in this module's graph
    // means this line never runs and nothing was ever hidden; the page
    // simply appears, complete and unanimated. That invariant is the fix
    // for a blank page that shipped twice, and it is load-bearing: do not
    // move the arming anywhere earlier than the module that owns the
    // animations.
    document.documentElement.classList.add("anim");
    mark("armed");
    // A throw anywhere in wiring forfeits the animations, never the
    // content: disarm() shows everything again and undoes any staging that
    // happened before the throw. wire() records its own failures per
    // feature; this belt catches only what escapes even that.
    try {
      wire();
      mark("wired");
    } catch (error) {
      note("wire", error);
      disarm();
    }
  }
  // The water is raw WebGL and needs no library, so it starts whether or
  // not the Motion bundle arrived — and inside its own guard, so nothing
  // that went wrong above it can cost the background.
  mark("field-call");
  try {
    field();
  } catch (error) {
    note("field", error);
  }
}

/**
 * How far through the field's three forms the page has scrolled, 0 to 1.
 *
 * Measured against the top of the last section rather than the whole
 * document, so the final form is fully assembled while it is still on screen
 * — running the morph to the very bottom of the page would finish it under
 * the footer, where nobody is looking.
 */
function progress() {
  const end = document.querySelector("#channel");
  const last =
    end === null
      ? document.body.scrollHeight - window.innerHeight
      : end.offsetTop - window.innerHeight * 0.4;
  if (last <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, window.scrollY / last));
}

/**
 * The compositional shift is retired: the camera itself now flies from a
 * side-on view of the rain to a top-down view of the still pool as the page
 * is read, inside field.js, so the water never leaves the frame. The stops
 * here are kept at zero rather than deleted because the uniform is part of
 * the shader's contract and a future section may still want a nudge.
 */
const SHIFTS = [
  [0.0, [0.0, 0.0]],
  [1.0, [0.0, 0.0]],
];

function shift() {
  const p = progress();
  for (let i = 1; i < SHIFTS.length; i += 1) {
    const [end, to] = SHIFTS[i];
    const [start, from] = SHIFTS[i - 1];
    if (p <= end || i === SHIFTS.length - 1) {
      const t = Math.max(0, Math.min(1, (p - start) / (end - start)));
      const e = t * t * (3 - 2 * t);
      return [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e];
    }
  }
  return [0, 0];
}

function field() {
  const canvas = document.querySelector("#field");
  if (canvas === null) {
    window.__kumiFieldState = "no canvas in the page";
    return;
  }
  try {
    stopField = startField(canvas, { progress, shift });
    if (stopField !== undefined) {
      // Tells the stylesheet the real water is running, so the CSS-only
      // swell that stands in for it on machines without WebGL steps aside.
      document.documentElement.classList.add("field-live");
      window.__kumiFieldState = "running";
    } else {
      window.__kumiFieldState = "webgl2 unavailable — CSS swell instead";
    }
  } catch (error) {
    // A shader that would not compile, or a context lost on creation. The
    // stylesheet's swell is already behind the canvas and is a complete,
    // living background on its own — but the reason is kept for the ?why
    // overlay, because a silent catch is how this stayed undiagnosable.
    stopField = undefined;
    window.__kumiFieldState =
      "crashed: " + (error instanceof Error ? error.message : String(error));
  }
}

/* ------------------------------------------------------------- helpers -- */

/** The last text node with content in an element — the part worth typing. */
function textNodeOf(el) {
  return [...el.childNodes]
    .reverse()
    .find(
      (node) =>
        node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0,
    );
}

/**
 * Retypes one line character by character, with a caret that leaves when the
 * line is done. The full text came from the HTML and goes back to the HTML:
 * an undoer restores it, and a disarm mid-type completes instantly.
 */
function typeInto(p) {
  const node = textNodeOf(p);
  if (node === undefined) {
    return later(400);
  }
  const full = node.textContent;
  undoers.push(() => {
    node.textContent = full;
  });
  node.textContent = "";
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.setAttribute("aria-hidden", "true");
  p.append(caret);
  undoers.push(() => {
    caret.remove();
  });
  return new Promise((resolve) => {
    let shown = 0;
    const interval = setInterval(() => {
      shown += 2;
      node.textContent = full.slice(0, shown);
      if (disarmed || shown >= full.length) {
        clearInterval(interval);
        node.textContent = full;
        caret.remove();
        resolve();
      }
    }, 18);
    intervals.push(interval);
  });
}

/* ---------------------------------------------------------------- wire -- */

function wire() {
  const { animate, inView, stagger, hover, press } = motion;
  const fine =
    window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  /*
   * Every feature wires inside its own guard, and a failure is recorded by
   * name — so one feature a particular browser objects to costs that
   * feature's animation, is named in the ?why overlay, and cannot silently
   * take the rest of the page's motion with it. If anything at all broke,
   * the whole page disarms afterwards: some features hide content they then
   * reveal, and a partial wiring must never leave part of the page waiting
   * on a reveal that died. The disarm is safe because every feature stages
   * through undoers; what matters is that the failure is no longer silent.
   */
  const broke = [];
  const attempt = (name, run) => {
    try {
      run();
    } catch (error) {
      broke.push(name);
      note("wire/" + name, error);
    }
  };

  // -- Section headings: split into words that arrive out of a blur, each a
  //    beat behind its neighbour. Split here rather than in the HTML so the
  //    markup stays one readable sentence; the undoer joins it back.
  //    Runs before the reveal groups are collected, because a split heading
  //    leaves the group — two animators fighting over one element is how a
  //    heading ends up permanently translated.
  attempt("headings", () => {
    for (const heading of document.querySelectorAll(
      ".section-title h2, .cta-band h2",
    )) {
      const original = heading.textContent;
      heading.classList.remove("reveal");
      heading.textContent = "";
      const words = [];
      for (const word of original.split(/\s+/u).filter((w) => w.length > 0)) {
        const span = document.createElement("span");
        span.className = "wd";
        span.textContent = word;
        heading.append(span, " ");
        words.push(span);
      }
      undoers.push(() => {
        heading.textContent = original;
      });
      for (const span of words) {
        span.style.opacity = "0";
        span.style.filter = "blur(10px)";
        span.style.transform = "translateY(14px)";
      }
      pendingReveals.set(heading, () => {
        animate(
          words,
          {
            opacity: [0, 1],
            filter: ["blur(10px)", "blur(0px)"],
            transform: ["translateY(14px)", "translateY(0px)"],
          },
          { delay: stagger(0.05), duration: 0.55, ease: EASE },
        );
      });
      inView(heading, () => fireReveal(heading), {
        margin: "0px 0px -12% 0px",
      });
    }
  });

  // -- The mono labels decode into place, left to right. The characters
  //    come from and return to the HTML; only the journey is scrambled.
  attempt("labels", () => {
    const GLYPHS = "abcdefghijklmnopqrstuvwxyz#=+/";
    for (const chip of document.querySelectorAll(".chip")) {
      const node = textNodeOf(chip);
      if (node === undefined) {
        continue;
      }
      const full = node.textContent;
      inView(chip, () => {
        undoers.push(() => {
          node.textContent = full;
        });
        let frame = 0;
        const total = Math.max(12, full.length * 2);
        const interval = setInterval(() => {
          if (disarmed) {
            clearInterval(interval);
            return;
          }
          frame += 1;
          const settled = Math.floor((frame / total) * full.length);
          node.textContent =
            full.slice(0, settled) +
            [...full.slice(settled)]
              .map((ch) =>
                ch === " "
                  ? " "
                  : GLYPHS[Math.floor(Math.random() * GLYPHS.length)],
              )
              .join("");
          if (settled >= full.length) {
            clearInterval(interval);
            node.textContent = full;
          }
        }, 34);
        intervals.push(interval);
      });
    }
  });

  // -- Hero: words rise out of their clipped line boxes, then the chip, the
  //    aside, and the scroll cue follow. The starting offsets came from the
  //    stylesheet (armed by `html.anim`), so the first frame never flashes.
  attempt("hero", () => {
    const words = document.querySelectorAll(".hero h1 .w > span");
    if (words.length > 0) {
      animate(
        words,
        { transform: ["translateY(110%)", "translateY(0%)"] },
        { delay: stagger(0.07), type: "spring", stiffness: 120, damping: 18 },
      );
    }
    const follow = (selector, delay) => {
      const el = document.querySelector(selector);
      if (el !== null) {
        animate(
          el,
          {
            opacity: [0, 1],
            transform: ["translateY(16px)", "translateY(0px)"],
          },
          { duration: 0.6, delay, ease: EASE },
        );
      }
    };
    follow(".hero-aside", 0.42);
  });

  // -- Scroll reveals: one behaviour for every section heading, paragraph
  //    block, and card. Card rows and step rows stagger their children as a
  //    group instead, so neighbours arrive as a family, not a queue.
  attempt("reveals", () => {
    for (const group of document.querySelectorAll("[data-reveal-group]")) {
      const items = group.querySelectorAll(".reveal");
      /*
       * The card rows arrive with a spring — risen and slightly scaled, each
       * a beat behind its neighbour — because a row of surfaces landing has
       * weight in a way a paragraph fading in should not. The orbit pills
       * get the bounciest version; everything else keeps the quiet fade.
       */
      const springy = group.matches(".moves, .cards");
      const bouncy = group.matches(".orbit");
      pendingReveals.set(group, () => {
        {
          if (springy) {
            animate(
              items,
              {
                opacity: [0, 1],
                transform: [
                  "translateY(48px) scale(0.94)",
                  "translateY(0px) scale(1)",
                ],
              },
              { delay: stagger(0.1), type: "spring", stiffness: 150, damping: 19 },
            );
          } else if (bouncy) {
            animate(
              items,
              {
                opacity: [0, 1],
                transform: [
                  "translateY(20px) scale(0.75)",
                  "translateY(0px) scale(1)",
                ],
              },
              { delay: stagger(0.06), type: "spring", stiffness: 260, damping: 15 },
            );
          } else {
            animate(
              items,
              {
                opacity: [0, 1],
                transform: ["translateY(24px)", "translateY(0px)"],
              },
              { duration: 0.6, delay: stagger(0.08), ease: EASE },
            );
          }
        }
      });
      inView(group, () => fireReveal(group), { margin: "0px 0px -12% 0px" });
    }
    for (const el of document.querySelectorAll(".reveal")) {
      if (el.closest("[data-reveal-group]") !== null) {
        continue;
      }
      pendingReveals.set(el, () => {
        animate(
          el,
          {
            opacity: [0, 1],
            transform: ["translateY(24px)", "translateY(0px)"],
          },
          { duration: 0.6, ease: EASE },
        );
      });
      inView(el, () => fireReveal(el), { margin: "0px 0px -12% 0px" });
    }

    /*
     * The sweep: whatever the reader has already scrolled past is revealed
     * on the spot, observer or no observer. Fast retargeted smooth scrolls
     * can carry an element through the viewport without one intersecting
     * frame, and an enter-only observer never looks back.
     */
    const sweep = () => {
      if (disarmed) {
        return;
      }
      for (const el of [...pendingReveals.keys()]) {
        if (el.getBoundingClientRect().top < window.innerHeight * 0.4) {
          fireReveal(el);
        }
      }
    };
    window.addEventListener("scroll", sweep, { passive: true });
    sweep();
  });

  // -- Nav grows an edge once the page has left the hero, and carries the
  //    scroll's own position on that edge.
  attempt("nav", () => {
    const nav = document.querySelector(".site-nav");
    const bar = document.querySelector(".nav-progress");
    if (nav !== null) {
      const settle = () => {
        nav.classList.toggle("lifted", window.scrollY > 40);
        if (bar !== null && !disarmed) {
          const max = document.body.scrollHeight - window.innerHeight;
          bar.style.transform = `scaleX(${max > 0 ? window.scrollY / max : 0})`;
        }
      };
      if (bar !== null) {
        undoers.push(() => {
          bar.style.transform = "";
        });
      }
      window.addEventListener("scroll", settle, { passive: true });
      settle();
    }
  });

  // -- Cards: a spring lift on hover, and a spotlight that follows the
  //    cursor across the row. Desktop-only by capability, not user-agent.
  attempt("cards", () => {
    if (!fine) {
      return;
    }
    hover(".card", (el) => {
      animate(
        el,
        { transform: "translateY(-4px)" },
        { type: "spring", stiffness: 300, damping: 24 },
      );
      return () => {
        animate(
          el,
          { transform: "translateY(0px)" },
          { type: "spring", stiffness: 300, damping: 24 },
        );
      };
    });
    for (const grid of document.querySelectorAll(".cards")) {
      grid.addEventListener("pointermove", (event) => {
        for (const card of grid.querySelectorAll(".card")) {
          const box = card.getBoundingClientRect();
          card.style.setProperty("--mx", `${event.clientX - box.left}px`);
          card.style.setProperty("--my", `${event.clientY - box.top}px`);
        }
      });
    }
  });

  // -- Primary CTAs: pressed-in feedback, and a small particle burst on
  //    activation.
  attempt("cta", () => {
    press(".btn-primary", (el) => {
      animate(el, { scale: 0.97 }, { duration: 0.14, ease: EASE });
      return () => {
        animate(
          el,
          { scale: 1 },
          { type: "spring", stiffness: 400, damping: 20 },
        );
      };
    });
    for (const el of document.querySelectorAll(".btn-primary")) {
      el.addEventListener("click", () => {
        for (let i = 0; i < 12; i += 1) {
          const spark = document.createElement("span");
          spark.className = "spark";
          el.append(spark);
          animate(
            spark,
            {
              x: (Math.random() - 0.5) * 80,
              y: (Math.random() - 0.5) * 80,
              opacity: [1, 0],
              scale: [1, 0],
            },
            { duration: 0.6, ease: "easeOut" },
          ).finished.then(() => {
            spark.remove();
          });
        }
      });
    }
  });

  attempt("channel", () => {
    channelStory(animate, inView);
  });
  attempt("price", () => {
    priceCounter(inView);
  });

  // Some of the features above hide content they then reveal. If any of
  // them broke, a partial wiring must not leave part of the page waiting on
  // a reveal that died — everything disarms, and the overlay says which
  // feature to blame.
  if (broke.length > 0) {
    disarm();
  }
}

/* ------------------------------------------------------- channel replay -- */

/**
 * The channel mock replays the day it depicts, in order: two people each
 * type a request at an agent, both agents go busy, the coordinator's
 * conflict card orders their overlapping plans, and the deliveries arrive in
 * exactly the order that card promised. Then it holds, fades, and plays
 * again — the conversation is a demonstration, and a demonstration you
 * missed the start of should come back around.
 *
 * The HTML holds the finished conversation, so the page without JavaScript
 * (or with reduced motion) reads as the story's ending: statuses resolved,
 * typing row hidden. Everything this player changes is either restored by an
 * undoer or was hidden in the markup to begin with.
 */
function channelStory(animate, inView) {
  const shot = document.querySelector(".app-shot");
  if (shot === null) {
    return;
  }
  const feed = shot.querySelector(".shot-feed");
  const steps = [...shot.querySelectorAll("[data-step]")].sort(
    (a, b) => Number(a.dataset.step) - Number(b.dataset.step),
  );
  if (feed === null || steps.length === 0) {
    return;
  }

  // The status chips under the threaded asks: "Done" in the HTML, "Writing
  // code" while the replay is mid-flight.
  const statuses = new Map();
  for (const el of shot.querySelectorAll(".a-status[data-agent]")) {
    statuses.set(el.dataset.agent, { el, done: el.textContent });
  }
  undoers.push(() => {
    for (const { el, done } of statuses.values()) {
      el.textContent = done;
      el.classList.remove("busy");
    }
  });

  // The typing row is hidden markup until the player owns it, and hidden
  // markup again if the player disarms.
  const typing = shot.querySelector(".typing");
  if (typing !== null) {
    typing.hidden = false;
    undoers.push(() => {
      typing.hidden = true;
      typing.style.opacity = "";
    });
  }

  const reset = () => {
    for (const el of steps) {
      el.style.opacity = "0";
      el.style.transform = "";
    }
    for (const { el } of statuses.values()) {
      el.textContent = el.dataset.busy;
      el.classList.add("busy");
    }
  };
  reset();
  undoers.push(() => {
    for (const el of steps) {
      el.style.opacity = "";
      el.style.transform = "";
    }
    feed.style.opacity = "";
  });

  // The loop only restarts while somebody could be watching it.
  let onScreen = false;
  inView(shot, () => {
    onScreen = true;
    return () => {
      onScreen = false;
    };
  });

  pendingReveals.set(feed, () => {
    void run();
  });
  inView(feed, () => fireReveal(feed), { margin: "0px 0px -15% 0px" });

  async function run() {
    for (;;) {
      await play();
      if (disarmed) {
        return;
      }
      await later(4600);
      if (disarmed) {
        return;
      }
      animate(feed, { opacity: [1, 0] }, { duration: 0.45, ease: "easeOut" });
      await later(500);
      if (disarmed) {
        return;
      }
      reset();
      animate(feed, { opacity: [0, 1] }, { duration: 0.3, ease: "easeOut" });
      while (!onScreen && !disarmed) {
        await later(700);
      }
      if (disarmed) {
        return;
      }
    }
  }

  async function play() {
    for (const el of steps) {
      if (disarmed) {
        return;
      }
      if (el.dataset.clearsTyping !== undefined && typing !== null) {
        animate(typing, { opacity: [1, 0] }, { duration: 0.3, ease: "easeOut" });
      }
      // One step can settle several chips at once — the channel's and the
      // thread panel's copy of the same agent going quiet together.
      for (const key of (el.dataset.resolves ?? "").split(" ")) {
        const resolves = statuses.get(key);
        if (resolves !== undefined) {
          resolves.el.textContent = resolves.done;
          resolves.el.classList.remove("busy");
        }
      }
      const card = el.classList.contains("arb-card");
      animate(
        el,
        card
          ? { opacity: [0, 1], transform: ["scale(0.92)", "scale(1)"] }
          : {
              opacity: [0, 1],
              transform: ["translateY(10px)", "translateY(0px)"],
            },
        { duration: card ? 0.5 : 0.4, ease: EASE },
      );
      if (el.dataset.type !== undefined) {
        await typeInto(el.querySelector(".m-text"));
        await later(260);
      } else {
        await later(card ? 1100 : 640);
      }
    }
  }
}

/* ------------------------------------------------------- price counter -- */

/**
 * The price counts up to itself when it arrives on screen.
 *
 * The number in the HTML is the number — the seat-price test holds this site
 * to writing it exactly once — so the counter reads its target out of the
 * text it is animating and never knows the amount itself. Manual rAF rather
 * than the library: it is one eased value, and the undoer must be able to
 * restore the text exactly.
 */
function priceCounter(inView) {
  const line = document.querySelector(".price-line");
  if (line === null) {
    return;
  }
  const node = line.firstChild;
  if (node === null || node.nodeType !== Node.TEXT_NODE) {
    return;
  }
  const full = node.textContent;
  const target = Number(full.replace(/[^0-9]/gu, ""));
  if (!Number.isFinite(target) || target <= 0) {
    return;
  }
  undoers.push(() => {
    node.textContent = full;
  });
  node.textContent = full.replace(/\d+/u, "0");
  pendingReveals.set(line, () => {
    const started = performance.now();
    const duration = 1100;
    const tick = () => {
      if (disarmed) {
        return;
      }
      const t = Math.min(1, (performance.now() - started) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      node.textContent = full.replace(/\d+/u, String(Math.round(target * eased)));
      if (t < 1) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });
  inView(line, () => fireReveal(line));
}
