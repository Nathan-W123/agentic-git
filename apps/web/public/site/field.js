/**
 * The thing the page is about, drawn — as water.
 *
 * Kumi is 汲み, from 汲む: to draw water. So the background is a surface of
 * water at night, and the page's argument plays out on it as the visitor
 * scrolls. Every request is a drop. At the top of the page it is raining —
 * many agents, many asks, rings spreading from every impact and passing
 * through each other without erasing one another, which is the whole claim
 * arbitration makes. As the page descends the rain thins, the swells widen
 * and slow, and by the last section the surface has settled to near-glass
 * with one slow ring breathing from the centre: one history, still water.
 *
 * The surface is a disc of points, and every ripple is computed in the
 * vertex shader from a small ring buffer of drops — position, impact time,
 * size — that the CPU refills on a schedule the scroll position sets. The
 * drops themselves fall: a handful of dedicated vertices streak down to
 * their own impact points just before each ring is born. On a machine with
 * a precise pointer, moving across the hero drips where the pointer goes.
 *
 * Colour carries state, as it did before the water: crests warm, troughs
 * cool, and the whole surface cools toward the lavender of settled work as
 * the page calms. The tokens are --field-warm and --field-cool.
 *
 * WebGL because the count is the effect, one draw call, additive blending,
 * no library — the control plane serves `script-src 'self'`, this repo has
 * no bundler, and a vendored engine would outweigh the site. Absent by
 * design under `prefers-reduced-motion`, without WebGL, and without
 * JavaScript, where the stylesheet's gradient stands as the background.
 */

/** How many drops the surface remembers at once. */
const DROPS = 12;

/** How long a drop streaks down before its ring is born, in seconds. */
const FALL_SECONDS = 0.45;

/* --------------------------------------------------------------- shaders -- */

const VERTEX = `#version 300 es
precision highp float;

/* Where this point rests on the surface (x, z). */
in vec2 aPos;
/* seed.x drifts chop phase, seed.y drifts amplitude, seed.z twinkles. */
in vec3 aSeed;
/* 0 = surface; n > 0 = the falling droplet for drop slot n - 1. */
in float aRole;

uniform float uTime;
/* Scroll progress, 0 at the hero and 1 by the last section. */
uniform float uCalmIn;
uniform vec2 uViewport;
uniform vec2 uParallax;
uniform vec2 uShift;
uniform float uScale;
/* One drop per slot: x, z, impact time, size. Size 0 is an empty slot. */
uniform vec4 uDrops[${DROPS}];

out float vMix;
out float vGlow;

const float LENS = 1.34;
const float SPEED = 0.55;
const float FREQ = 24.0;
const float DAMP = 0.38;

void main() {
  float calm = smoothstep(0.45, 0.95, uCalmIn);
  float energy = 1.0 - calm * 0.85;

  vec3 p = vec3(aPos.x, -0.06, aPos.y);
  float height = 0.0;
  float ringGlow = 0.0;

  if (aRole < 0.5) {
    /* The ambient chop: small crossing swells that keep the surface alive
       between drops, dying away as the page calms. */
    float chop =
      sin(p.x * 7.0 + uTime * 0.8 + aSeed.x * 6.2831853) +
      sin(p.z * 9.0 - uTime * 1.1) +
      sin((p.x + p.z) * 5.0 + uTime * 0.6);
    height += chop * 0.009 * energy * (0.7 + aSeed.y * 0.6);

    /* Every remembered drop, summed. A ring is a travelling band: sharp at
       the wavefront, trailing shorter wavelets, decaying with age and with
       distance from its own centre. */
    for (int i = 0; i < ${DROPS}; i += 1) {
      vec4 drop = uDrops[i];
      if (drop.w <= 0.0) {
        continue;
      }
      float age = uTime - drop.z;
      if (age <= 0.0) {
        continue;
      }
      float away = distance(p.xz, drop.xy);
      float front = age * SPEED;
      float band = exp(-pow((away - front) * 4.5, 2.0));
      float decay = exp(-age * DAMP) * drop.w / (1.0 + away * 1.05);
      height += cos((away - front) * FREQ) * band * decay * 0.075;
      ringGlow += band * decay;
    }
    p.y += height;
  } else {
    /* A falling drop: visible only in the moment before its own impact,
       streaking from above the surface down to the point its ring will
       spread from. */
    vec4 drop = uDrops[int(aRole - 0.5)];
    float age = uTime - drop.z;
    if (drop.w <= 0.0 || age < -${FALL_SECONDS.toFixed(2)} || age >= 0.05) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vGlow = 0.0;
      vMix = 0.0;
      return;
    }
    float t = 1.0 + age / ${FALL_SECONDS.toFixed(2)};
    p = vec3(drop.x, mix(1.1, -0.05, t * t), drop.y);
  }

  /* The camera pulls up and tilts down as the page calms, trading the low
     dusk view of rain for a higher look at a still mirror. */
  vec3 eye = vec3(0.0, 0.6 + 0.28 * calm, 2.02 - 0.22 * calm);
  vec3 view = p - eye;
  float tilt = 0.2 + 0.16 * calm;
  float ct = cos(tilt);
  float st = sin(tilt);
  view = vec3(view.x, view.y * ct - view.z * st, view.y * st + view.z * ct);
  view.xy += uParallax * 0.08 + uShift;

  float depth = max(-view.z, 0.05);
  vec2 projected = view.xy / depth * LENS;
  gl_Position = vec4(projected * vec2(uViewport.y / uViewport.x, 1.0), 0.0, 1.0);

  float near = clamp(1.0 - (depth - 1.2) / 2.6, 0.0, 1.0);
  float twinkle = 0.8 + 0.2 * sin(uTime * 1.7 + aSeed.z * 6.2831853);

  if (aRole < 0.5) {
    /* Flat water is dim; the light lives on the rings and crests, with a
       soft bloom at the centre once the surface has stilled. */
    float bloom = exp(-dot(p.xz, p.xz) * 0.9) * 0.85 * calm;
    gl_PointSize = (1.05 + 2.5 * near) * uScale;
    vGlow = (0.3 + 0.14 * calm + ringGlow * 2.6 + abs(height) * 11.0 + bloom) * twinkle * near;
    /* Crests warm, troughs cool, and the whole surface cools as it settles. */
    float crest = clamp(height * 34.0, -1.0, 1.0);
    vMix = mix(0.5 - crest * 0.42, 0.8, calm * 0.55);
  } else {
    gl_PointSize = (2.2 + 1.6 * near) * uScale;
    vGlow = 1.1;
    vMix = 0.18;
  }
}
`;

const FRAGMENT = `#version 300 es
precision highp float;

in float vMix;
in float vGlow;

uniform vec3 uWarm;
uniform vec3 uCool;

out vec4 outColour;

void main() {
  /* A round, soft point. Squares are the tell that something was drawn with
     GL_POINTS and not thought about. */
  float d = length(gl_PointCoord - 0.5);
  float mask = smoothstep(0.5, 0.05, d);
  if (mask <= 0.001 || vGlow <= 0.001) {
    discard;
  }
  vec3 colour = mix(uWarm, uCool, clamp(vMix, 0.0, 1.0));
  outColour = vec4(colour * vGlow * mask, mask * min(vGlow, 1.0) * 0.85);
}
`;

/* ------------------------------------------------------------- machinery -- */

/** A deterministic generator, so a reload lays out the same surface. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // Thrown rather than logged: the caller's catch leaves the CSS gradient
    // as the background, and a surface that failed to build must not sit
    // there as a dead rectangle over it.
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
 * Builds the water and starts it.
 *
 * Returns a stop function, or undefined when this machine cannot draw it —
 * the caller treats undefined as "leave the CSS backdrop alone", which is a
 * complete and reasonable version of the page.
 */
export function startField(canvas, options = {}) {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    // Redrawn every frame and never read back; not preserving the buffer
    // lets the driver throw it away between frames.
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });
  if (gl === null) {
    return undefined;
  }

  // Density scaled to the surface actually being filled. A phone drawing a
  // desktop's point count is a hot phone showing the same picture.
  const area = window.innerWidth * window.innerHeight;
  const surfaceCount = Math.round(Math.max(14000, Math.min(46000, area * 0.028)));
  const count = surfaceCount + DROPS;

  const positions = new Float32Array(count * 2);
  const seeds = new Float32Array(count * 3);
  const roles = new Float32Array(count);

  // A jittered polar disc: rings of points, more per ring as radius grows,
  // each nudged off its lattice. Even density without the moiré a square
  // grid throws when a ripple crosses it.
  const random = makeRandom(0x9e3779b9);
  const RADIUS = 2.05;
  const RINGS = Math.round(Math.sqrt(surfaceCount / 3.2));
  let placed = 0;
  for (let ring = 0; ring < RINGS && placed < surfaceCount; ring += 1) {
    const r = ((ring + 0.5) / RINGS) * RADIUS;
    const around = Math.max(6, Math.round((surfaceCount * 2 * (ring + 0.5)) / (RINGS * RINGS)));
    for (let step = 0; step < around && placed < surfaceCount; step += 1) {
      const angle =
        (step / around) * Math.PI * 2 + (random() - 0.5) * (2.4 / around);
      const radius = r + (random() - 0.5) * (RADIUS / RINGS);
      positions[placed * 2] = Math.cos(angle) * radius;
      positions[placed * 2 + 1] = Math.sin(angle) * radius;
      seeds.set([random(), random(), random()], placed * 3);
      roles[placed] = 0;
      placed += 1;
    }
  }
  // However rounding fell out, every remaining surface slot gets a point.
  for (; placed < surfaceCount; placed += 1) {
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * RADIUS;
    positions[placed * 2] = Math.cos(angle) * radius;
    positions[placed * 2 + 1] = Math.sin(angle) * radius;
    seeds.set([random(), random(), random()], placed * 3);
    roles[placed] = 0;
  }
  // The falling drops: one vertex per slot, positioned by the shader.
  for (let i = 0; i < DROPS; i += 1) {
    const at = surfaceCount + i;
    positions[at * 2] = 0;
    positions[at * 2 + 1] = 0;
    seeds.set([random(), random(), random()], at * 3);
    roles[at] = i + 1;
  }

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "water failed to link");
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
  bind("aPos", positions, 2);
  bind("aSeed", seeds, 3);
  bind("aRole", roles, 1);

  const uniform = (name) => gl.getUniformLocation(program, name);
  const uTime = uniform("uTime");
  const uCalmIn = uniform("uCalmIn");
  const uViewport = uniform("uViewport");
  const uParallax = uniform("uParallax");
  const uShift = uniform("uShift");
  const uScale = uniform("uScale");
  const uDrops = uniform("uDrops");

  gl.uniform3fv(uniform("uWarm"), readColour("--field-warm", [0.88, 0.55, 0.42]));
  gl.uniform3fv(uniform("uCool"), readColour("--field-cool", [0.66, 0.58, 0.79]));

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  // Additive: overlapping rings brighten where they cross, which is exactly
  // the point — interference that adds instead of destroying.
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.clearColor(0, 0, 0, 0);

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(canvas.clientWidth * ratio);
    const height = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uViewport, canvas.width || 1, canvas.height || 1);
    gl.uniform1f(uScale, ratio);
  }
  resize();

  /* ------------------------------------------------------------- drops -- */

  const drops = new Float32Array(DROPS * 4);
  let dropAt = 0;
  const started = performance.now();
  const now = () => (performance.now() - started) / 1000;

  function spawnDrop(x, z, size, delay = FALL_SECONDS) {
    drops[dropAt * 4] = x;
    drops[dropAt * 4 + 1] = z;
    // Impact lands after the streak has had time to fall.
    drops[dropAt * 4 + 2] = now() + delay;
    drops[dropAt * 4 + 3] = size;
    dropAt = (dropAt + 1) % DROPS;
  }

  /**
   * The weather, set by the scroll. Rain at the hero; occasional drops
   * mid-page; near the end just the centre, breathing.
   */
  let nextDrop = 0.4;
  for (const age of [-2.6, -1.9, -1.2, -0.6, -0.15]) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * 1.3;
    spawnDrop(Math.cos(angle) * radius, Math.sin(angle) * radius, 0.7 + Math.random() * 0.5, age);
  }
  function weather(calm, time) {
    if (time < nextDrop) {
      return;
    }
    if (calm > 0.9) {
      spawnDrop(
        (Math.random() - 0.5) * 0.2,
        (Math.random() - 0.5) * 0.2,
        0.85,
      );
      nextDrop = time + 3.6 + Math.random() * 0.8;
      return;
    }
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * 1.35;
    spawnDrop(
      Math.cos(angle) * radius,
      Math.sin(angle) * radius,
      0.75 + Math.random() * 0.55,
    );
    nextDrop = time + 0.3 + calm * 3.4 + Math.random() * 0.45;
  }

  /**
   * A precise pointer drips where it moves. The screen position is cast
   * back through the same fixed camera the shader uses onto the resting
   * surface — parallax and shift are ignored on the way, which costs less
   * accuracy than a ripple is wide.
   */
  let lastDrip = 0;
  function drip(event) {
    const time = now();
    if (time - lastDrip < 0.18) {
      return;
    }
    const nx = (event.clientX / window.innerWidth) * 2 - 1;
    const ny = -((event.clientY / window.innerHeight) * 2 - 1);
    const calm = Math.min(1, Math.max(0, (shownCalm - 0.45) / 0.5));
    const eye = [0, 0.6 + 0.28 * calm, 2.02 - 0.22 * calm];
    const tilt = 0.2 + 0.16 * calm;
    const aspect = window.innerWidth / window.innerHeight;
    // The ray in tilted view space, untilted, then run to the surface.
    const direction = [(nx * aspect) / 1.34, ny / 1.34, -1];
    const ct = Math.cos(-tilt);
    const st = Math.sin(-tilt);
    const dy = direction[1] * ct - direction[2] * st;
    const dz = direction[1] * st + direction[2] * ct;
    if (Math.abs(dy) < 0.001) {
      return;
    }
    const t = (-0.06 - eye[1]) / dy;
    if (t <= 0) {
      return;
    }
    const x = eye[0] + direction[0] * t;
    const z = eye[2] + dz * t;
    if (x * x + z * z > 2.05 * 2.05) {
      return;
    }
    lastDrip = time;
    spawnDrop(x, z, 0.3, 0.1);
  }

  /* -------------------------------------------------------------- frame -- */

  let shown = 0;
  let shownCalm = 0;
  let pointer = [0, 0];
  let pointerTarget = [0, 0];
  let shift = [0, 0];
  let running = true;
  let frame = 0;

  const readProgress = options.progress ?? (() => 0);
  const readShift = options.shift ?? (() => [0, 0]);

  function draw() {
    if (!running) {
      return;
    }
    frame = requestAnimationFrame(draw);
    const time = now();
    // Damped rather than pinned to the scrollbar: a trackpad fling should
    // change the weather, not teleport it.
    shown += (readProgress() - shown) * 0.075;
    shownCalm = shown;
    pointer[0] += (pointerTarget[0] - pointer[0]) * 0.06;
    pointer[1] += (pointerTarget[1] - pointer[1]) * 0.06;
    const wanted = readShift();
    shift[0] += (wanted[0] - shift[0]) * 0.05;
    shift[1] += (wanted[1] - shift[1]) * 0.05;

    weather(Math.min(1, Math.max(0, (shown - 0.45) / 0.5)), time);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uTime, time);
    gl.uniform1f(uCalmIn, shown);
    gl.uniform2f(uParallax, pointer[0], pointer[1]);
    gl.uniform2f(uShift, shift[0], shift[1]);
    gl.uniform4fv(uDrops, drops);
    gl.drawArrays(gl.POINTS, 0, count);
  }
  frame = requestAnimationFrame(draw);

  function onPointer(event) {
    pointerTarget = [
      (event.clientX / window.innerWidth) * 2 - 1,
      -((event.clientY / window.innerHeight) * 2 - 1),
    ];
    drip(event);
  }
  const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (fine) {
    window.addEventListener("pointermove", onPointer, { passive: true });
  }
  window.addEventListener("resize", resize, { passive: true });

  // Water drawn behind a hidden tab is a laptop fan and nothing else.
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
