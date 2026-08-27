/**
 * Every discrete animation on the marketing site, in one module.
 *
 * The library is the vendored Motion UMD bundle (vendor/motion/motion.js,
 * MIT — licence served beside it). It is loaded as a classic script before
 * this module because its ES build re-exports from a bare specifier no
 * browser can resolve without a bundler, and this repo ships none.
 *
 * The gate is checked once, here, at the top — not sprinkled per effect.
 * Reduced motion, or a missing library, means this module wires nothing and
 * instead STRIPS the `anim` class the boot script added, so no element can
 * be left waiting for a reveal that will never come. The page reads
 * perfectly with this file absent; everything below is decoration.
 *
 * The point field is the one thing here that is not decoration, and it is
 * also the one thing that can fail on its own — no WebGL, a driver that
 * refuses, a shader that will not compile on some phone. It is therefore
 * started inside its own try, after everything else is wired, so a field that
 * cannot be drawn costs the field and nothing else.
 */

import { startField } from "./field.js";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const motion = window.Motion;
const EASE = [0.32, 0.72, 0, 1];

let stopField;

function disarm() {
  document.documentElement.classList.remove("anim");
  if (stopField !== undefined) {
    stopField();
    stopField = undefined;
  }
}

if (reduceMotion.matches || motion === undefined) {
  disarm();
} else {
  // A preference flipped mid-visit is honoured immediately: the CSS block in
  // site.css stops the continuous animations, dropping the class shows
  // anything still waiting on a scroll reveal, and the field stops drawing.
  reduceMotion.addEventListener("change", () => {
    if (reduceMotion.matches) {
      disarm();
    }
  });
  wire();
  field();
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
 * The copy is not centred — the hero splits left and right, "how it works"
 * is a left column, and the last section puts a wide card on the right. A
 * form fixed at the middle of the viewport would be behind the text in two
 * of those four, so it steps aside instead, and the step is slow enough to
 * read as the field making room rather than as a jump.
 *
 * Keyed to the same scroll progress that drives the morph, so the two never
 * disagree about which section is being read.
 */
const SHIFTS = [
  [0.0, [0.0, 0.0]],
  [0.34, [0.0, -0.14]],
  [0.62, [0.0, -0.2]],
  [1.0, [0.0, -0.18]],
];

function shift() {
  const p = progress();
  for (let i = 1; i < SHIFTS.length; i += 1) {
    const [end, to] = SHIFTS[i];
    const [start, from] = SHIFTS[i - 1];
    if (p <= end || i === SHIFTS.length - 1) {
      const t = Math.max(0, Math.min(1, (p - start) / (end - start)));
      // Smoothstep rather than linear: the field should ease out of one
      // position and into the next, not slide at a constant rate.
      const e = t * t * (3 - 2 * t);
      return [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e];
    }
  }
  return [0, 0];
}

function field() {
  const canvas = document.querySelector("#field");
  if (canvas === null) {
    return;
  }
  try {
    stopField = startField(canvas, { progress, shift });
  } catch {
    // A shader that would not compile, or a context lost on creation. The
    // stylesheet's gradient is already behind the canvas and is a complete
    // background on its own, so there is nothing to clean up and nothing
    // worth telling the visitor.
    stopField = undefined;
  }
}

function wire() {
  const { animate, inView, stagger, hover, press } = motion;
  const fine =
    window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  // -- Hero: words rise out of their clipped line boxes, then the chip, the
  //    aside, and the scroll cue follow. The starting offsets came from the
  //    stylesheet (armed by `html.anim`), so the first frame never flashes.
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
        { opacity: [0, 1], transform: ["translateY(16px)", "translateY(0px)"] },
        { duration: 0.6, delay, ease: EASE },
      );
    }
  };
  follow(".hero .chip", 0.15);
  follow(".hero-aside", 0.42);
  follow(".scroll-cue", 0.62);

  // -- Scroll reveals: one behaviour for every section heading, paragraph
  //    block, and card. Card rows and step rows stagger their children as a
  //    group instead, so neighbours arrive as a family, not a queue.
  for (const group of document.querySelectorAll("[data-reveal-group]")) {
    const items = group.querySelectorAll(".reveal");
    inView(
      group,
      () => {
        animate(
          items,
          { opacity: [0, 1], transform: ["translateY(24px)", "translateY(0px)"] },
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
          { opacity: [0, 1], transform: ["translateY(24px)", "translateY(0px)"] },
          { duration: 0.6, ease: EASE },
        );
      },
      { margin: "0px 0px -12% 0px" },
    );
  }

  // -- Nav grows an edge once the page has left the hero: transparent over
  //    the field, blurred ground with a hairline after 40px.
  const nav = document.querySelector(".site-nav");
  if (nav !== null) {
    const settle = () => {
      nav.classList.toggle("lifted", window.scrollY > 40);
    };
    window.addEventListener("scroll", settle, { passive: true });
    settle();
  }

  // -- Cards: a spring lift on hover. Desktop-only by capability, not
  //    user-agent — coarse pointers never see it, because a lift that
  //    triggers on tap reads as a rendering bug.
  if (fine) {
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
  }

  // -- Primary CTAs: pressed-in feedback, and a small particle burst on
  //    activation. The burst spawns real elements rather than a canvas so it
  //    inherits the button's colours and needs nothing else.
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
}
