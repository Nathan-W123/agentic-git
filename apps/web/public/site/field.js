/**
 * The thing the page is about, drawn — as water.
 *
 * Kumi is 汲み, from 汲む: to draw water. The background is a surface of
 * water at night, and the page's argument plays out on it as the visitor
 * scrolls. Every request is a drop. At the top of the page it is raining —
 * many agents, many asks, rings spreading from every impact and passing
 * through each other without erasing one another, which is the whole claim
 * arbitration makes. As the page descends the rain thins, and by the last
 * section the surface has settled to near-glass with one slow ring
 * breathing from the centre: one history, still water.
 *
 * Drawn as a fluid, not as particles: one fullscreen pass whose fragment
 * shader casts a ray per pixel onto the surface plane, evaluates the ripple
 * height field there, differentiates it into a normal, and lights it —
 * diffuse, a tight specular glint, fresnel at grazing angles — so a ring is
 * a smooth lit undulation rather than a band of dots. The falling drops are
 * analytic capsules in the same pass: a bright streak with a glowing head,
 * and a splash flash where the ring is born.
 *
 * The ripple field itself is a small ring buffer of drops — position,
 * impact time, size — that the CPU refills on a schedule the scroll
 * position sets. On a machine with a precise pointer, moving across the
 * page drips where the pointer goes.
 *
 * Colour carries state: crests warm, troughs cool, the whole surface
 * cooling toward the lavender of settled work as the page calms. The
 * tokens are --field-warm and --field-cool.
 *
 * Raw WebGL, one draw call, additive blending, no library — the control
 * plane serves `script-src 'self'` and this repo has no bundler. Absent by
 * design under `prefers-reduced-motion`, without WebGL, and without
 * JavaScript, where the stylesheet's gradient breathes as the background.
 */

/** How many drops the surface remembers at once. */
const DROPS = 12;

/** How long a drop streaks down before its ring is born, in seconds. */
const FALL_SECONDS = 0.45;

/* --------------------------------------------------------------- shaders -- */

const VERTEX = `#version 300 es
in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAGMENT = `#version 300 es
precision highp float;

uniform float uTime;
/* Scroll progress, 0 at the hero and 1 by the last section. */
uniform float uCalmIn;
uniform vec2 uViewport;
uniform vec2 uParallax;
uniform vec2 uShift;
uniform vec3 uWarm;
uniform vec3 uCool;
/* One drop per slot: x, z, impact time, size. Size 0 is an empty slot. */
uniform vec4 uDrops[${DROPS}];

out vec4 outColour;

const float LENS = 1.34;
const float SPEED = 0.55;
const float FREQ = 24.0;
const float DAMP = 0.38;
const float RADIUS = 2.05;
const float PLANE = -0.06;
const float FALL = ${FALL_SECONDS.toFixed(2)};

/*
 * The ripple height at one point of the surface: flow-warped ambient chop
 * that dies as the page calms, plus every remembered drop's travelling
 * ring — sharp at the wavefront, trailing shorter wavelets, decaying with
 * age and with distance from its own centre.
 */
float heightAt(vec2 q, float energy) {
  vec2 w = q + 0.06 * vec2(
    sin(q.y * 1.7 + uTime * 0.32),
    cos(q.x * 1.9 + uTime * 0.27)
  );
  float h = (
    sin(w.x * 7.0 + uTime * 0.8) +
    sin(w.y * 9.0 - uTime * 1.1) +
    sin((w.x + w.y) * 5.0 + uTime * 0.6)
  ) * 0.009 * energy;
  for (int i = 0; i < ${DROPS}; i += 1) {
    vec4 drop = uDrops[i];
    if (drop.w <= 0.0) {
      continue;
    }
    float age = uTime - drop.z;
    if (age <= 0.0) {
      continue;
    }
    float away = distance(q, drop.xy);
    float front = age * SPEED;
    float band = exp(-pow((away - front) * 4.5, 2.0));
    float decay = exp(-age * DAMP) * drop.w / (1.0 + away * 1.05);
    h += cos((away - front) * FREQ) * band * decay * 0.075;
  }
  return h;
}

/* The rings' own light, kept separate from the height so it can be added
   over the shading rather than through it. */
float glowAt(vec2 q) {
  float g = 0.0;
  for (int i = 0; i < ${DROPS}; i += 1) {
    vec4 drop = uDrops[i];
    if (drop.w <= 0.0) {
      continue;
    }
    float age = uTime - drop.z;
    if (age <= 0.0) {
      continue;
    }
    float away = distance(q, drop.xy);
    float front = age * SPEED;
    float band = exp(-pow((away - front) * 4.5, 2.0));
    g += band * exp(-age * DAMP) * drop.w / (1.0 + away * 1.05);
  }
  return g;
}

/* Closest distance between the view ray and the segment ab — how a falling
   drop's streak is drawn without any geometry at all. */
float segmentDistance(vec3 origin, vec3 ray, vec3 a, vec3 b) {
  vec3 ab = b - a;
  vec3 ao = a - origin;
  float ab2 = dot(ab, ab);
  float abr = dot(ab, ray);
  float aor = dot(ao, ray);
  float denom = ab2 - abr * abr;
  float s = denom > 1e-5
    ? clamp((aor * abr - dot(ao, ab)) / denom, 0.0, 1.0)
    : 0.0;
  float t = max(aor + s * abr, 0.0);
  return length(a + ab * s - (origin + ray * t));
}

void main() {
  float calm = smoothstep(0.45, 0.95, uCalmIn);
  float energy = 1.0 - calm * 0.85;

  /* The camera pulls up and tilts down as the page calms, trading the low
     dusk view of rain for a higher look at a still mirror. */
  vec3 eye = vec3(0.0, 0.6 + 0.28 * calm, 2.02 - 0.22 * calm);
  float tilt = 0.2 + 0.16 * calm;
  float ct = cos(tilt);
  float st = sin(tilt);

  vec2 ndc = (gl_FragCoord.xy / uViewport) * 2.0 - 1.0;
  float a = ndc.x * (uViewport.x / uViewport.y) / LENS;
  float b = ndc.y / LENS;
  vec2 comp = uParallax * 0.08 + uShift;

  /* The exact inverse of the point renderer's projection, compositional
     shift included: the ray's origin carries the shift, its direction
     carries the pixel. Rotation is the inverse of the forward tilt. */
  vec3 origin = eye + vec3(
    -comp.x,
    -comp.y * ct,
    comp.y * st
  );
  vec3 dir = vec3(
    a,
    b * ct - st,
    -b * st - ct
  );
  vec3 ray = normalize(dir);

  vec3 colour = vec3(0.0);

  /* ------------------------------------------------------------ surface -- */
  if (dir.y < -0.001) {
    float travel = (PLANE - origin.y) / dir.y;
    if (travel > 0.2 && travel < 12.0) {
      vec3 hit = origin + dir * travel;
      float r = length(hit.xz);
      if (r < RADIUS) {
        vec2 q = hit.xz;
        float h0 = heightAt(q, energy);
        float eps = 0.014;
        float hx = heightAt(q + vec2(eps, 0.0), energy);
        float hz = heightAt(q + vec2(0.0, eps), energy);
        /* Slopes exaggerated: the field's amplitudes are tuned for
           composition, and honest normals from them light like glass. */
        vec3 normal = normalize(vec3(
          -(hx - h0) / eps * 1.6,
          1.0,
          -(hz - h0) / eps * 1.6
        ));

        vec3 light = normalize(vec3(-0.4, 0.85, 0.3));
        vec3 view = -ray;
        vec3 halfway = normalize(light + view);
        float diffuse = max(dot(normal, light), 0.0);
        float spec = pow(max(dot(normal, halfway), 0.0), 130.0);
        float fresnel = pow(1.0 - max(dot(normal, view), 0.0), 3.0);

        float crest = clamp(h0 * 30.0, -1.0, 1.0);
        vec3 base = mix(uCool, uWarm, 0.5 + 0.5 * crest);
        base = mix(base, uCool, calm * 0.45);

        float rim = smoothstep(RADIUS, RADIUS * 0.55, r);
        float haze = clamp(1.0 - (travel - 1.2) / 3.4, 0.45, 1.0);

        vec3 shade =
          base * (0.10 + 0.22 * diffuse) +
          base * fresnel * 0.4 +
          vec3(1.0, 0.95, 0.9) * spec * 0.85 +
          mix(uWarm, uCool, 0.5) * glowAt(q) * 1.2;
        /* The settled mirror's soft heart. */
        shade += uCool * exp(-r * r * 0.9) * 0.5 * calm;
        colour += shade * rim * haze;
      }
    }
  }

  /* -------------------------------------------------------------- drops -- */
  for (int i = 0; i < ${DROPS}; i += 1) {
    vec4 drop = uDrops[i];
    if (drop.w <= 0.0) {
      continue;
    }
    float age = uTime - drop.z;
    /* The streak: a capsule from the head back up along the fall, brighter
       at the head, born high and dying into its own splash. */
    if (age > -FALL && age < 0.04) {
      float f = clamp(1.0 + age / FALL, 0.0, 1.0);
      float y = mix(1.15, PLANE, f * f);
      vec3 head = vec3(drop.x, y, drop.y);
      vec3 tail = head + vec3(0.0, 0.20 + 0.10 * (1.0 - f), 0.0);
      float streak =
        exp(-pow(segmentDistance(origin, ray, head, tail) * 60.0, 2.0));
      float headGlow =
        exp(-pow(length(cross(ray, head - origin)) * 100.0, 2.0));
      colour += (uWarm * 0.7 + vec3(0.30)) * streak * 1.1 * drop.w;
      colour += vec3(1.0, 0.97, 0.92) * headGlow * 1.3 * drop.w;
    }
    /* The splash: a fast bright flash on the surface where the ring is
       born, so an impact is an event rather than an inference. */
    if (age >= 0.0 && age < 0.35 && dir.y < -0.001) {
      float travel = (PLANE - origin.y) / dir.y;
      if (travel > 0.2) {
        vec2 q = (origin + dir * travel).xz;
        float flash = 1.0 - age / 0.35;
        colour += (uWarm * 0.8 + vec3(0.2)) *
          exp(-pow(distance(q, drop.xy) * 11.0, 2.0)) *
          flash * flash * 0.55 * drop.w;
      }
    }
  }

  colour = colour / (1.0 + colour * 0.45);
  outColour = vec4(colour, 1.0);
}
`;

/* ------------------------------------------------------------- machinery -- */

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // Thrown rather than logged: the caller's catch leaves the CSS swell as
    // the background, and a surface that failed to build must not sit there
    // as a dead rectangle over it.
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
  const trace = (step) => {
    if (Array.isArray(window.__kumiTrace)) {
      window.__kumiTrace.push(step);
    }
  };
  trace("water-enter");
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });
  if (gl === null) {
    trace("water-noctx");
    return undefined;
  }
  trace("water-ctx");

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "water failed to link");
  }
  trace("water-linked");
  gl.useProgram(program);

  // One triangle covering the screen; every pixel of water is shaded, so
  // there is no geometry to manage at all.
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  const location = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);

  const uniform = (name) => gl.getUniformLocation(program, name);
  const uTime = uniform("uTime");
  const uCalmIn = uniform("uCalmIn");
  const uViewport = uniform("uViewport");
  const uParallax = uniform("uParallax");
  const uShift = uniform("uShift");
  const uDrops = uniform("uDrops");

  gl.uniform3fv(uniform("uWarm"), readColour("--field-warm", [0.88, 0.55, 0.42]));
  gl.uniform3fv(uniform("uCool"), readColour("--field-cool", [0.66, 0.58, 0.79]));

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  // Pure additive: the shader outputs light, and the light lands on the
  // page's own dark ground. Crossing rings brighten where they cross, which
  // is the point — interference that adds instead of destroying.
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.clearColor(0, 0, 0, 0);

  function resize() {
    // The whole cost is per-pixel now, so the backing store is capped below
    // full retina; the glow-heavy look upscales without minding, and a
    // phone stays a phone instead of a hand-warmer.
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5) * 0.85;
    const width = Math.round(canvas.clientWidth * ratio);
    const height = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uViewport, canvas.width || 1, canvas.height || 1);
  }
  resize();

  /* --------------------------------------------------------------- drops -- */

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
   * mid-page; near the end just the centre, breathing. A handful of drops
   * are already mid-flight at the first paint, so the page never opens on
   * a still pond waiting for weather.
   */
  let nextDrop = 0.4;
  for (const age of [-2.6, -1.9, -1.2, -0.6, -0.15]) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * 1.3;
    spawnDrop(
      Math.cos(angle) * radius,
      Math.sin(angle) * radius,
      0.7 + Math.random() * 0.5,
      age,
    );
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
    let x = Math.cos(angle) * radius;
    if (x > 0.6) {
      x = 0.6 - (x - 0.6);
    }
    spawnDrop(x, Math.sin(angle) * radius, 0.75 + Math.random() * 0.55);
    nextDrop = time + 0.3 + calm * 3.4 + Math.random() * 0.45;
  }

  /**
   * A precise pointer drips where it moves. The screen position is cast
   * back through the same camera the shader uses onto the resting surface —
   * parallax and shift are ignored on the way, which costs less accuracy
   * than a ripple is wide.
   */
  let lastDrip = 0;
  function drip(event) {
    const time = now();
    if (time - lastDrip < 0.18) {
      return;
    }
    const nx = (event.clientX / window.innerWidth) * 2 - 1;
    const ny = -((event.clientY / window.innerHeight) * 2 - 1);
    const calm = Math.min(1, Math.max(0, (shown - 0.45) / 0.5));
    const eye = [0, 0.6 + 0.28 * calm, 2.02 - 0.22 * calm];
    const tilt = 0.2 + 0.16 * calm;
    const aspect = window.innerWidth / window.innerHeight;
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
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  frame = requestAnimationFrame(draw);
  trace("water-loop");

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
