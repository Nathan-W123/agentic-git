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
window.__kumiSiteRev = "w6";

// Every animation failure lands here with a name and a message, and the
// ?why overlay prints them. A device this page misbehaves on is a device
// nobody can attach a debugger to; a caught exception with no record is
// how one stayed undiagnosed across four rounds of screenshots.
window.__kumiErrors = [];

function note(phase, error) {
  window.__kumiErrors.push(
    phase + ": " + (error instanceof Error ? error.message : String(error)),
  );
}

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const motion = window.Motion;
const EASE = [0.32, 0.72, 0, 1];

let stopField;
let disarmed = false;

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

if (reduceMotion.matches) {
  disarm();
} else {
  // A preference flipped mid-visit is honoured immediately: the CSS block in
  // site.css stops the continuous animations, dropping the class shows
  // anything still waiting on a scroll reveal, the undoers restore any text
  // an effect was mid-way through, and the water stops drawing.
  reduceMotion.addEventListener("change", () => {
    if (reduceMotion.matches) {
      disarm();
    }
  });
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
    // A throw anywhere in wiring forfeits the animations, never the
    // content: disarm() shows everything again and undoes any staging that
    // happened before the throw. wire() records its own failures per
    // feature; this belt catches only what escapes even that.
    try {
      wire();
    } catch (error) {
      note("wire", error);
      disarm();
    }
  }
  // The water is raw WebGL and needs no library, so it starts whether or
  // not the Motion bundle arrived — and inside its own guard, so nothing
  // that went wrong above it can cost the background. On one phone,
  // everything above succeeded except a single swallowed throw, and the
  // water never started: this call must be unskippable.
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
 * Where the form should sit on screen, section by section.
 *
 * Keyed to the same scroll progress that drives the morph, so the two never
 * disagree about which section is being read, and eased between stops so the
 * field reads as making room rather than jumping.
 */
const SHIFTS = [
  [0.0, [0.0, 0.0]],
  [0.34, [0.0, 0.62]],
  [0.62, [0.0, 0.8]],
  [1.0, [0.0, 0.78]],
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
      inView(
        heading,
        () => {
          animate(
            words,
            {
              opacity: [0, 1],
              filter: ["blur(10px)", "blur(0px)"],
              transform: ["translateY(14px)", "translateY(0px)"],
            },
            { delay: stagger(0.05), duration: 0.55, ease: EASE },
          );
        },
        { margin: "0px 0px -12% 0px" },
      );
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
    follow(".hero .chip", 0.15);
    follow(".hero-aside", 0.42);
    follow(".scroll-cue", 0.62);
  });

  // -- Scroll reveals: one behaviour for every section heading, paragraph
  //    block, and card. Card rows and step rows stagger their children as a
  //    group instead, so neighbours arrive as a family, not a queue.
  attempt("reveals", () => {
    for (const group of document.querySelectorAll("[data-reveal-group]")) {
      const items = group.querySelectorAll(".reveal");
      inView(
        group,
        () => {
          animate(
            items,
            {
              opacity: [0, 1],
              transform: ["translateY(24px)", "translateY(0px)"],
            },
            { duration: 0.6, delay: stagger(0.08), ease: EASE },
          );
        },
        { margin: "0px 0px -12% 0px" },
      );
    }
    for (const el of document.querySelectorAll(".reveal")) {
      if (el.closest("[data-reveal-group]") !== null) {
        continue;
      }
      inView(
        el,
        () => {
          animate(
            el,
            {
              opacity: [0, 1],
              transform: ["translateY(24px)", "translateY(0px)"],
            },
            { duration: 0.6, ease: EASE },
          );
        },
        { margin: "0px 0px -12% 0px" },
      );
    }
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
  attempt("board", () => {
    admissionBoard(animate, inView);
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
 * The channel mock plays as the conversation it is, in the order it
 * happened: the request types itself, the plan and arbitration lines stamp
 * in, the agent answers, the commit lands. Once, when it scrolls into view —
 * a chat that loops is a screensaver, and this one is evidence.
 */
function channelStory(animate, inView) {
  const body = document.querySelector(".hero-shot .shot-body");
  if (body === null) {
    return;
  }
  const steps = [...body.children];
  for (const el of steps) {
    stage(el, { opacity: "0" });
  }
  inView(
    body,
    () => {
      void play();
    },
    { margin: "0px 0px -15% 0px" },
  );
  async function play() {
    for (const el of steps) {
      if (disarmed) {
        return;
      }
      animate(
        el,
        { opacity: [0, 1], transform: ["translateY(10px)", "translateY(0px)"] },
        { duration: 0.4, ease: EASE },
      );
      if (el.classList.contains("msg")) {
        await typeInto(el.querySelector("p"));
      } else {
        await later(560);
      }
    }
    const code = body.querySelector("code");
    if (code !== null && !disarmed) {
      animate(
        code,
        { opacity: [0.1, 1], transform: ["scale(1.15)", "scale(1)"] },
        { duration: 0.5, ease: EASE },
      );
    }
  }
}

/* ----------------------------------------------------- admission board -- */

/**
 * Partial admission as physics.
 *
 * The file pills are real elements, and a claim is a journey: a pill leaves
 * the repository row and lands in a plan's tray on a spring. The move is a
 * FLIP — measure where it was, reparent it, measure where it is, start from
 * the difference — which is what lets the layout stay ordinary responsive
 * flow while the pill appears to fly between rows. The contested file
 * wobbles when the second plan asks for it, a dashed ghost holds its place
 * in plan B's tray, and the moment plan A's commit chip lands the pill
 * crosses over and the ghost pops away.
 *
 * It loops while it is on screen and stops when it is not. Without
 * JavaScript every pill sits in the repository row and the status line is
 * the diagram's caption.
 */
function admissionBoard(animate, inView) {
  const figure = document.querySelector("[data-admission]");
  if (figure === null) {
    return;
  }
  const tray = (name) => figure.querySelector(`[data-adm-tray="${name}"]`);
  const repo = tray("repo");
  const trayA = tray("a");
  const trayB = tray("b");
  const held = figure.querySelector("[data-adm-held]");
  const commitA = figure.querySelector('[data-adm-commit="a"]');
  const commitB = figure.querySelector('[data-adm-commit="b"]');
  const status = figure.querySelector("[data-adm-status]");
  if ([repo, trayA, trayB, held, commitA, commitB].some((el) => el === null)) {
    return;
  }
  const pills = [...repo.querySelectorAll(".adm-pill")];
  const pill = (file) =>
    pills.find((el) => el.dataset.admFile === file) ?? pills[0];
  const auth = pill("auth.ts");
  const retry = pill("retry.ts");
  const webhooks = pill("webhooks.ts");

  // Everything this board moves goes back exactly where the HTML put it.
  const restingStatus = status === null ? "" : status.textContent;
  undoers.push(() => {
    for (const el of pills) {
      el.className = "adm-pill";
      el.removeAttribute("style");
      repo.append(el);
    }
    for (const el of [held, commitA, commitB]) {
      el.removeAttribute("style");
    }
    if (status !== null) {
      status.textContent = restingStatus;
    }
  });
  stage(commitA, { opacity: "0" });
  stage(commitB, { opacity: "0" });

  /**
   * Reinserts a pill into the repository row where it started, so a return
   * journey never shuffles the order of the files still at home.
   */
  const home = (el) => {
    const after = pills.slice(pills.indexOf(el) + 1);
    const anchor = after.find((sibling) => sibling.parentElement === repo);
    if (anchor === undefined) {
      repo.append(el);
    } else {
      repo.insertBefore(el, anchor);
    }
  };

  /** The FLIP move: reparent, then spring from where it used to be. */
  const fly = (el, place) => {
    const first = el.getBoundingClientRect();
    place(el);
    const last = el.getBoundingClientRect();
    el.style.transform = `translate(${first.left - last.left}px, ${
      first.top - last.top
    }px)`;
    animate(
      el,
      { transform: "translate(0px, 0px)" },
      { type: "spring", stiffness: 220, damping: 24 },
    );
  };

  const chipIn = (chip) => {
    animate(
      chip,
      {
        opacity: [0, 1],
        transform: ["translateY(8px) scale(0.85)", "translateY(0px) scale(1)"],
      },
      { type: "spring", stiffness: 260, damping: 20 },
    );
  };

  const say = (text) => {
    if (status !== null && !disarmed) {
      status.textContent = text;
      animate(status, { opacity: [0, 1] }, { duration: 0.35 });
    }
  };

  let visible = false;
  let playing = false;
  inView(figure, () => {
    visible = true;
    if (!playing) {
      playing = true;
      void loop();
    }
    return () => {
      visible = false;
    };
  });

  async function loop() {
    while (visible && !disarmed) {
      // Everything springs home rather than snapping, so the loop reads as
      // the next request arriving instead of a video restarting.
      for (const el of pills) {
        el.classList.remove("claimed-a", "claimed-b", "dim");
        if (el.parentElement !== repo) {
          fly(el, home);
        }
      }
      animate(commitA, { opacity: 0 }, { duration: 0.3 });
      animate(commitB, { opacity: 0 }, { duration: 0.3 });
      held.style.opacity = "0";
      await later(1000);
      if (!visible || disarmed) break;

      say("plan A claims retry.ts and webhooks.ts");
      retry.classList.add("claimed-a");
      fly(retry, (el) => trayA.append(el));
      await later(160);
      webhooks.classList.add("claimed-a");
      fly(webhooks, (el) => trayA.append(el));
      await later(1100);
      if (!visible || disarmed) break;

      say("plan B wants auth.ts and webhooks.ts — granted auth.ts now, webhooks.ts held");
      auth.classList.add("claimed-b");
      fly(auth, (el) => trayB.append(el));
      animate(
        webhooks,
        {
          transform: [
            "translate(0px, 0px)",
            "translate(-4px, 0px)",
            "translate(4px, 0px)",
            "translate(-2px, 0px)",
            "translate(0px, 0px)",
          ],
        },
        { duration: 0.5, ease: EASE },
      );
      animate(
        held,
        { opacity: [0, 1], transform: ["scale(0.7)", "scale(1)"] },
        { type: "spring", stiffness: 260, damping: 20 },
      );
      await later(1900);
      if (!visible || disarmed) break;

      say("plan A promoted — webhooks.ts released to plan B");
      chipIn(commitA);
      retry.classList.add("dim");
      retry.classList.remove("claimed-a");
      fly(retry, home);
      await later(350);
      animate(
        held,
        { opacity: 0, transform: "scale(0.6)" },
        { duration: 0.25, ease: EASE },
      );
      webhooks.classList.remove("claimed-a");
      webhooks.classList.add("claimed-b");
      fly(webhooks, (el) => trayB.append(el));
      await later(1000);
      if (!visible || disarmed) break;

      say("both plans ran the whole time — nothing waited that did not have to");
      chipIn(commitB);
      await later(3400);
    }
    playing = false;
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
  inView(line, () => {
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
}
