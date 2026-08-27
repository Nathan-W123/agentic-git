/**
 * The thing the page is about, drawn.
 *
 * One point cloud behind every section, morphing between three forms as the
 * page scrolls. The forms are not decoration picked for looking expensive —
 * they are the product's three moves, and each particle keeps its identity
 * across all of them, which is the whole argument: the same work, carried
 * from many agents into one history without ever being lost or duplicated.
 *
 *   0. CONVERGE   Six strands rise from separate points on the floor, spiral
 *                 inward, and braid into a single trunk. Many agents, one
 *                 repository.
 *   1. ARBITRATE  The trunk opens into stacked rings, one arc per strand,
 *                 none of them touching. Plans granted side by side — the
 *                 gaps are the point.
 *   2. PROMOTE    Everything collapses onto the edges and interior lattice of
 *                 a cube. The canonical history, closed.
 *
 * Colour carries state rather than taste: warm for work that has not been
 * claimed, cool for work a plan holds. A particle warms and cools as it moves
 * between forms, so the palette says something true at every frame.
 *
 * WebGL because the count is the effect — forty thousand points at sixty
 * frames is a texture, four thousand is a screensaver — and one draw call
 * with additive blending is cheaper than any of the alternatives. Written
 * against raw WebGL rather than a library on purpose: the control plane
 * serves `script-src 'self'`, there is no bundler in this repository, and a
 * vendored engine would be an order of magnitude more bytes than the whole
 * rest of the site.
 *
 * Absent by design under `prefers-reduced-motion`, on a machine with no
 * WebGL, and with JavaScript off. The stylesheet paints a still gradient in
 * the same colours underneath, so the page never has a hole in it.
 */

const FORMS = 3;

/** Strand count. Six reads as "several" without any arc getting thin. */
const STRANDS = 6;

/** Points that draw the floor rings rather than the moving forms. */
const FLOOR_SHARE = 0.32;

/* --------------------------------------------------------------- shaders -- */

const VERTEX = `#version 300 es
precision highp float;

in vec3 aConverge;
in vec3 aArbitrate;
in vec3 aPromote;
/* seed.x drifts phase, seed.y drifts amplitude, seed.z twinkles. */
in vec3 aSeed;
/* 0 = a floor ring, 1 = a moving particle. Floor points ignore the morph. */
in float aMoving;
/* Which plan holds this work in the arbitrated form, as a hue position. */
in float aState;

uniform float uMorph;
uniform float uTime;
uniform vec2 uViewport;
uniform vec2 uParallax;
/* Where the form should sit on screen for the section now being read. The
   copy is left-aligned in one section and right-heavy in another, and a
   fixed centred form would be behind the text in both. */
uniform vec2 uShift;
/* Point-size multiplier only. The projection deliberately does not use it —
   a field that grew with the display's pixel ratio would be composed for one
   class of screen and wrong on every other. */
uniform float uScale;

/* How much of the scene fits across the viewport. A constant, because the
   composition is fixed: the copy is laid out around where the form lands. */
const float LENS = 1.34;

out float vGlow;
out float vState;

/* Two morphs, chained, so a particle never teleports between forms. */
vec3 formAt(float t) {
  float first = smoothstep(0.0, 1.0, clamp(t, 0.0, 1.0));
  float second = smoothstep(0.0, 1.0, clamp(t - 1.0, 0.0, 1.0));
  return mix(mix(aConverge, aArbitrate, first), aPromote, second);
}

void main() {
  vec3 p = mix(aConverge, formAt(uMorph), aMoving);

  /* Breathing. Small, seeded per particle, and never enough to blur an edge
     of the cube — the forms have to stay legible as forms. */
  float phase = uTime * 0.55 + aSeed.x * 6.2831853;
  float sway = 0.012 + aSeed.y * 0.016;
  p.x += sin(phase) * sway;
  p.z += cos(phase * 0.83) * sway;
  p.y += sin(phase * 0.61) * sway * 0.7;

  /* The floor rings travel outward forever and fade as they go, which is what
     makes the plane read as a plane rather than a set of drawn circles. */
  float ripple = 1.0;
  if (aMoving < 0.5) {
    /* seed.z holds the ring's phase, shared by every point on that ring, so a
       ring expands as one thing. Per-particle phase put every point of a ring
       at a different radius at once, which is not a ripple — it is a disc of
       dust, and that is how it drew. */
    float travel = fract(aSeed.z + uTime * 0.05);
    p.xz *= 0.34 + travel * 2.1;
    p.y -= travel * 0.03;
    /* Born at the centre, spent at the rim, so nothing pops at the loop. */
    ripple = sin(travel * 3.14159265);
  }

  /* A fixed camera: pulled back, lifted, tilted down at the floor. Written
     out rather than passed in as a matrix — it never changes, and spelling it
     here keeps the whole projection readable in one place. */
  vec3 eye = vec3(0.0, 0.60, 2.02);
  vec3 view = p - eye;
  float tilt = 0.20;
  float ct = cos(tilt);
  float st = sin(tilt);
  view = vec3(view.x, view.y * ct - view.z * st, view.y * st + view.z * ct);

  /* Pointer parallax, applied in view space so it never distorts the form. */
  view.xy += uParallax * (0.06 + 0.10 * (1.0 - aMoving)) + uShift;

  float depth = max(-view.z, 0.05);
  vec2 projected = view.xy / depth * LENS;
  gl_Position = vec4(projected * vec2(uViewport.y / uViewport.x, 1.0), 0.0, 1.0);

  float near = clamp(1.0 - (depth - 1.2) / 2.6, 0.0, 1.0);
  float twinkle = 0.75 + 0.25 * sin(uTime * 1.7 + aSeed.z * 6.2831853);
  gl_PointSize = (1.05 + 2.7 * near) * uScale;
  vGlow = near * twinkle * mix(1.25 * ripple, 1.0, aMoving);
  vState = aState;
}
`;

const FRAGMENT = `#version 300 es
precision highp float;

in float vGlow;
in float vState;

uniform vec3 uWarm;
uniform vec3 uCool;
uniform float uMorph;

out vec4 outColour;

void main() {
  /* A round, soft point. Squares are the tell that something was drawn with
     GL_POINTS and not thought about. */
  float d = length(gl_PointCoord - 0.5);
  float mask = smoothstep(0.5, 0.05, d);
  if (mask <= 0.001) {
    discard;
  }
  /* Warm until a plan holds it, cool once one does. The transition is the
     arbitration step, so it tracks the morph rather than being a gradient. */
  float claimed = clamp(uMorph, 0.0, 1.0) * vState;
  vec3 colour = mix(uWarm, uCool, claimed);
  outColour = vec4(colour * vGlow * mask, mask * vGlow * 0.85);
}
`;

/* ----------------------------------------------------------------- forms -- */

/** A deterministic generator, so a reload draws the same field. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Six strands leaving the floor, spiralling in, braiding into one trunk.
 *
 * The merge height is the whole read: below it the strands are visibly
 * separate and countable, above it they are one thing. Placed at a third of
 * the way up so both halves get room.
 */
function converge(index, count, strand, random) {
  const along = index / count;
  const merge = 0.34;
  const turn = strand * ((Math.PI * 2) / STRANDS);

  if (along < merge) {
    // Spiralling inward. Radius closes as height rises; a little scatter so
    // the strand is a rope rather than a wire.
    const t = along / merge;
    const radius = (1.05 - t * 0.98) * (0.85 + random() * 0.3);
    const angle = turn + t * 2.4 + random() * 0.16;
    return [
      Math.cos(angle) * radius,
      -0.34 + t * 0.72 + (random() - 0.5) * 0.05,
      Math.sin(angle) * radius,
    ];
  }

  // The trunk, and the flare at the top where the work spreads out again.
  const t = (along - merge) / (1 - merge);
  const flare = Math.pow(t, 2.4) * 0.78;
  const angle = turn + t * 3.1 + random() * Math.PI * 2 * Math.pow(t, 2);
  const radius = (0.055 + flare) * (0.4 + random() * 0.8);
  return [
    Math.cos(angle) * radius,
    0.38 + t * 0.82 + (random() - 0.5) * 0.06,
    Math.sin(angle) * radius,
  ];
}

/**
 * Stacked concentric rings, one long arc per strand, with deliberate gaps.
 *
 * The gaps are the argument. Arbitration is not a queue and it is not a free
 * for all — it is several plans holding several parts of the same repository
 * at once, and the picture has to show them not touching. Two strands share
 * each ring and take half of it apiece, so an arc is long enough to read as
 * an arc rather than as a smudge.
 *
 * Radius falls as height rises, which makes the set read as one stepped cone
 * rather than three unrelated hoops, and echoes the floor rings underneath.
 */
function arbitrate(index, count, strand, random) {
  const ring = strand % 3;
  const side = Math.floor(strand / 3);
  const gap = 0.34;
  const angle =
    side * Math.PI +
    Math.PI * 0.5 +
    ring * 0.7 +
    gap * 0.5 +
    random() * (Math.PI - gap);
  const radius = (1.26 - ring * 0.32) * (0.985 + random() * 0.03);
  const height = 0.24 + ring * 0.30 + (random() - 0.5) * 0.03;
  // A thin skirt under each arc, so a ring reads as a disc seen near
  // edge-on rather than as a wire floating in the dark.
  const drop = random() < 0.3 ? random() * 0.075 : 0;
  return [
    Math.cos(angle) * radius,
    height - drop,
    Math.sin(angle) * radius,
  ];
}

/**
 * The cube: twelve edges, dense, with a sparse interior lattice.
 *
 * Closed and countable on purpose. Everything before it is in motion and
 * partially claimed; this is the state where a change is a commit and there
 * is exactly one of it.
 */
function promote(index, count, strand, random) {
  const half = 0.44;
  const lift = 0.54;
  const jitter = () => (random() - 0.5) * 0.012;

  if (random() < 0.72) {
    // On an edge. Pick an axis, then a corner of the face it runs along.
    const axis = index % 3;
    const a = random() < 0.5 ? -half : half;
    const b = random() < 0.5 ? -half : half;
    const t = (random() * 2 - 1) * half;
    const point =
      axis === 0 ? [t, a, b] : axis === 1 ? [a, t, b] : [a, b, t];
    return [
      point[0] + jitter(),
      point[1] + lift + jitter(),
      point[2] + jitter(),
    ];
  }

  // Interior lattice, on a coarse grid so it reads as structure rather than
  // as fog inside a box.
  const step = half / 2;
  const snap = (v) => Math.round(v / step) * step;
  return [
    snap((random() * 2 - 1) * half) + jitter(),
    snap((random() * 2 - 1) * half) + lift + jitter(),
    snap((random() * 2 - 1) * half) + jitter(),
  ];
}

/**
 * A ring on the floor.
 *
 * These never morph — they are the ground everything else stands on, and the
 * only thing in the picture that is the same in all three forms. The shader
 * pushes each one outward on a loop and fades it as it goes, so the plane
 * reads as a plane rather than as a set of drawn circles.
 */
const FLOOR_RINGS = 7;

function floorRing(random) {
  const angle = random() * Math.PI * 2;
  const ring = Math.floor(random() * FLOOR_RINGS);
  const radius = 0.30 + ring * 0.05 + (random() - 0.5) * 0.008;
  return {
    at: [Math.cos(angle) * radius, -0.42, Math.sin(angle) * radius],
    // Evenly spaced phases, so the rings leave the centre one after another
    // rather than all at once.
    phase: ring / FLOOR_RINGS,
  };
}

/* ------------------------------------------------------------- machinery -- */

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // Thrown rather than logged: the caller's catch removes the canvas, and a
    // field that failed to build must not sit there as a black rectangle over
    // the gradient the stylesheet already drew.
    throw new Error(gl.getShaderInfoLog(shader) ?? "shader failed to compile");
  }
  return shader;
}

function readColour(name, fallback) {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  const hex = /^#([0-9a-f]{6})$/iu.exec(raw);
  if (hex === null) {
    return fallback;
  }
  const value = parseInt(hex[1], 16);
  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ];
}

/**
 * Builds the field and starts it.
 *
 * Returns a stop function, or undefined when this machine cannot draw it —
 * the caller treats undefined as "leave the CSS backdrop alone", which is a
 * complete and reasonable version of the page.
 */
export function startField(canvas, options = {}) {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    // The field is redrawn every frame and never read back; not preserving it
    // lets the driver throw the buffer away between frames.
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });
  if (gl === null) {
    return undefined;
  }

  // Density scaled to the surface actually being filled. A phone drawing a
  // desktop's particle count is a hot phone showing the same picture.
  const area = window.innerWidth * window.innerHeight;
  const count = Math.round(
    Math.max(14000, Math.min(46000, area * 0.028)),
  );

  const converged = new Float32Array(count * 3);
  const arbitrated = new Float32Array(count * 3);
  const promoted = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 3);
  const moving = new Float32Array(count);
  const states = new Float32Array(count);

  const random = makeRandom(0x9e3779b9);
  const movingCount = Math.round(count * (1 - FLOOR_SHARE));

  for (let i = 0; i < count; i += 1) {
    const strand = i % STRANDS;
    const isMoving = i < movingCount;
    let a;
    if (isMoving) {
      const along = i / movingCount;
      a = converge(Math.floor(along * movingCount), movingCount, strand, random);
      const b = arbitrate(i, movingCount, strand, random);
      const c = promote(i, movingCount, strand, random);
      arbitrated.set(b, i * 3);
      promoted.set(c, i * 3);
      seeds.set([random(), random(), random()], i * 3);
    } else {
      const ring = floorRing(random);
      a = ring.at;
      arbitrated.set(a, i * 3);
      promoted.set(a, i * 3);
      // seed.z is the ring's travel phase here rather than a twinkle offset.
      seeds.set([random(), random(), ring.phase], i * 3);
    }
    converged.set(a, i * 3);
    moving[i] = isMoving ? 1 : 0;
    // Two of every three strands end up held by a plan, which keeps the
    // arbitrated form visibly mixed rather than uniformly recoloured.
    states[i] = strand % 3 === 0 ? 0 : 0.6 + random() * 0.4;
  }

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "field program failed to link");
  }
  gl.useProgram(program);

  const bind = (name, data, size) => {
    const location = gl.getAttribLocation(program, name);
    if (location < 0) {
      return;
    }
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
  };
  bind("aConverge", converged, 3);
  bind("aArbitrate", arbitrated, 3);
  bind("aPromote", promoted, 3);
  bind("aSeed", seeds, 3);
  bind("aMoving", moving, 1);
  bind("aState", states, 1);

  const uniform = (name) => gl.getUniformLocation(program, name);
  const uMorph = uniform("uMorph");
  const uTime = uniform("uTime");
  const uViewport = uniform("uViewport");
  const uParallax = uniform("uParallax");
  const uShift = uniform("uShift");
  const uScale = uniform("uScale");

  const warm = readColour("--field-warm", [0.88, 0.55, 0.42]);
  const cool = readColour("--field-cool", [0.66, 0.58, 0.79]);
  gl.uniform3fv(uniform("uWarm"), warm);
  gl.uniform3fv(uniform("uCool"), cool);

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  // Additive. Overlapping points build brightness, which is what makes a
  // dense region read as a solid mass and a sparse one as dust.
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.clearColor(0, 0, 0, 0);

  let pixelRatio = 1;
  function resize() {
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(canvas.clientWidth * pixelRatio);
    const height = Math.round(canvas.clientHeight * pixelRatio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uViewport, canvas.width || 1, canvas.height || 1);
    gl.uniform1f(uScale, pixelRatio);
  }
  resize();

  let target = 0;
  let shown = 0;
  let pointer = [0, 0];
  let pointerTarget = [0, 0];
  let shift = [0, 0];
  let running = true;
  let frame = 0;
  const started = performance.now();

  const readProgress = options.progress ?? (() => 0);
  const readShift = options.shift ?? (() => [0, 0]);

  function draw(now) {
    if (!running) {
      return;
    }
    frame = requestAnimationFrame(draw);
    target = readProgress();
    // Damped rather than pinned to the scrollbar: a trackpad fling would
    // otherwise snap the form from one to the next in a single frame, and the
    // morph is the thing worth watching.
    shown += (target - shown) * 0.075;
    pointer[0] += (pointerTarget[0] - pointer[0]) * 0.06;
    pointer[1] += (pointerTarget[1] - pointer[1]) * 0.06;
    const wanted = readShift();
    shift[0] += (wanted[0] - shift[0]) * 0.05;
    shift[1] += (wanted[1] - shift[1]) * 0.05;

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uMorph, shown * (FORMS - 1));
    gl.uniform1f(uTime, (now - started) / 1000);
    gl.uniform2f(uParallax, pointer[0], pointer[1]);
    gl.uniform2f(uShift, shift[0], shift[1]);
    gl.drawArrays(gl.POINTS, 0, count);
  }
  frame = requestAnimationFrame(draw);

  function onPointer(event) {
    pointerTarget = [
      (event.clientX / window.innerWidth) * 2 - 1,
      -((event.clientY / window.innerHeight) * 2 - 1),
    ];
  }
  const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (fine) {
    window.addEventListener("pointermove", onPointer, { passive: true });
  }
  window.addEventListener("resize", resize, { passive: true });

  // A field drawing sixty frames a second behind a hidden tab is a laptop fan
  // and nothing else.
  function onVisibility() {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(frame);
    } else if (!running) {
      running = true;
      frame = requestAnimationFrame(draw);
    }
  }
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    running = false;
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", resize);
    window.removeEventListener("pointermove", onPointer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
