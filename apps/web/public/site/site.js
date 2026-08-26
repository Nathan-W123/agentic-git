/**
 * Every discrete animation on the marketing site, in one module.
 *
 * The library is the vendored Motion UMD bundle (/vendor/motion/motion.js,
 * MIT — licence served beside it). It is loaded as a classic script before
 * this module because its ES build re-exports from a bare specifier no
 * browser can resolve without a bundler, and this repo ships none.
 *
 * The gate is checked once, here, at the top — not sprinkled per effect.
 * Reduced motion, or a missing library, means this module wires nothing and
 * instead STRIPS the `anim` class the boot script added, so no element can
 * be left waiting for a reveal that will never come. The page reads
 * perfectly with this file absent; everything below is decoration.
 */

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const motion = window.Motion;
const EASE = [0.32, 0.72, 0, 1];

function disarm() {
  document.documentElement.classList.remove("anim");
}

if (reduceMotion.matches || motion === undefined) {
  disarm();
} else {
  // A preference flipped mid-visit is honoured immediately: the CSS block in
  // site.css stops the continuous animations, and dropping the class shows
  // anything still waiting on a scroll reveal.
  reduceMotion.addEventListener("change", () => {
    if (reduceMotion.matches) {
      disarm();
    }
  });
  wire();
}

function wire() {
  const { animate, inView, stagger, hover, press } = motion;
  const fine =
    window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  // -- Hero: words rise out of their clipped line boxes, then the subhead,
  //    CTAs, and the channel mock follow. The starting offsets came from the
  //    stylesheet (armed by `html.anim`), so the first frame never flashes.
  const words = document.querySelectorAll(".hero h1 .w > span");
  if (words.length > 0) {
    animate(
      words,
      { transform: ["translateY(110%)", "translateY(0%)"] },
      { delay: stagger(0.06), type: "spring", stiffness: 120, damping: 18 },
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
  follow(".hero .sub", 0.4);
  follow(".hero-cta", 0.5);
  follow(".hero-shot", 0.65);

  // -- Scroll reveals: one behaviour for every section heading, paragraph
  //    block, and card. Bento grids and step rows stagger their children as
  //    a group instead, so neighbours arrive as a family, not a queue.
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

  // -- Nav condenses once the page has moved: transparent over the hero,
  //    blurred ground with a hairline after 40px.
  const nav = document.querySelector(".site-nav");
  if (nav !== null) {
    const settle = () => {
      nav.classList.toggle("scrolled", window.scrollY > 40);
    };
    window.addEventListener("scroll", settle, { passive: true });
    settle();
  }

  // -- Bento cards: a spring lift on hover, and a cursor-following glow fed
  //    by one pointermove listener per grid. Desktop-only by capability, not
  //    user-agent — coarse pointers never see either.
  if (fine) {
    hover(".bento-card", (el) => {
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
    for (const grid of document.querySelectorAll(".bento")) {
      grid.addEventListener("pointermove", (event) => {
        for (const card of grid.querySelectorAll(".bento-card")) {
          const box = card.getBoundingClientRect();
          card.style.setProperty("--mx", `${event.clientX - box.left}px`);
          card.style.setProperty("--my", `${event.clientY - box.top}px`);
        }
      });
    }
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
