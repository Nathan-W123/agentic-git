import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadStaticAssets } from "./assets.js";

/* ------------------------------------------------------------- assets ---- */

test("loads every control-room asset with an explicit content type", async () => {
  const assets = await loadStaticAssets();
  assert.equal(assets.get("/index.html")?.contentType, "text/html; charset=utf-8");
  assert.equal(assets.get("/styles.css")?.contentType, "text/css; charset=utf-8");
  assert.equal(assets.get("/mark.svg")?.contentType, "image/svg+xml");
  for (const module of [
    "/app.js",
    "/ui.js",
    "/data.js",
    "/chat.js",
    "/code-view.js",
    "/screen-repos.js",
    "/screen-code.js",
    "/screen-agents.js",
    "/screen-coordinator.js",
    "/screen-notifications.js",
  ]) {
    assert.equal(
      assets.get(module)?.contentType,
      "text/javascript; charset=utf-8",
      `${module} should be served`,
    );
  }
});

test("the retired HUD assets are no longer served", async () => {
  const assets = await loadStaticAssets();
  // They were several megabytes of decoration for a shell that no longer
  // exists. Leaving them in the allowlist would keep shipping them.
  for (const asset of [
    "/jarvis.css",
    "/editor.js",
    "/hud-interface-bg.png",
    "/hud-reactor-rotor.png",
  ]) {
    assert.equal(assets.get(asset), undefined, `${asset} should not be served`);
  }
});

/**
 * The dashboard has no bundler: the browser resolves every import itself
 * against the same allowlist the gateway serves from. A module that imports a
 * file nobody registered fails at load time in the browser and nowhere else,
 * which is exactly the kind of break a test should catch instead of a user.
 */
test("every module the dashboard imports is itself served", async () => {
  const assets = await loadStaticAssets();
  const served = new Set([...assets.keys()]);
  for (const [url, asset] of assets) {
    if (!url.endsWith(".js") || url.startsWith("/vendor/")) {
      continue;
    }
    const source = asset.body.toString("utf8");
    for (const match of source.matchAll(
      /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+"([^"]+)"/gu,
    )) {
      const specifier = match[1] ?? "";
      assert.equal(
        specifier.startsWith("./"),
        true,
        `${url} imports a non-relative specifier ${specifier}; there is no bundler to resolve it`,
      );
      assert.equal(
        served.has(specifier.replace(/^\./u, "")),
        true,
        `${url} imports ${specifier}, which is not in the served allowlist`,
      );
    }
  }
});

test("the dashboard modules are browser-safe", async () => {
  const assets = await loadStaticAssets();
  for (const [url, asset] of assets) {
    if (!url.endsWith(".js") || url.startsWith("/vendor/")) {
      continue;
    }
    const source = asset.body.toString("utf8");
    assert.equal(
      /from\s+"node:/u.test(source),
      false,
      `${url} imports a node builtin`,
    );
    assert.equal(/\brequire\(/u.test(source), false, `${url} is not an ES module`);
  }
});

test("serves the vendored Monaco build same-origin under /vendor", async () => {
  const assets = await loadStaticAssets();
  // CSP allows no CDN, so a deployment that wants a full editor must have
  // these locally. They are served whether or not the current screens use
  // them.
  for (const asset of [
    "/vendor/monaco/vs/loader.js",
    "/vendor/monaco/vs/editor/editor.main.js",
    "/vendor/monaco/vs/editor/editor.main.css",
    "/vendor/monaco/vs/base/worker/workerMain.js",
  ]) {
    assert.equal(
      assets.get(asset)?.contentType?.startsWith("text/"),
      true,
      `${asset} should be served`,
    );
  }
});

test("a missing vendor directory degrades to dashboard-only assets", async () => {
  const assets = await loadStaticAssets(undefined, false, false);
  assert.equal(assets.get("/app.js") !== undefined, true);
  assert.equal(assets.get("/vendor/monaco/vs/loader.js"), undefined);
  assert.equal(assets.get("/vendor/collab/index.js"), undefined);
});

test("serves the collaboration engine the gateway itself runs", async () => {
  const assets = await loadStaticAssets();
  // Operational transformation only converges if both ends transform
  // identically, so the browser loads the very same compiled module the
  // gateway imports rather than a second implementation of it.
  for (const asset of [
    "/vendor/collab/index.js",
    "/vendor/collab/client.js",
    "/vendor/collab/text-operation.js",
  ]) {
    assert.equal(
      assets.get(asset)?.contentType,
      "text/javascript; charset=utf-8",
      `${asset} should be served`,
    );
  }
});

test("does not serve the collaboration package's test scaffolding", async () => {
  const assets = await loadStaticAssets();
  for (const asset of [
    "/vendor/collab/random.js",
    "/vendor/collab/client.test.js",
    "/vendor/collab/text-operation.test.js",
    "/vendor/collab/convergence.test.js",
  ]) {
    assert.equal(assets.get(asset), undefined, `${asset} should not be served`);
  }
});

test("the collaboration engine is browser-safe", async () => {
  const assets = await loadStaticAssets();
  // A single `node:` import anywhere in the served graph breaks the editor at
  // load time, and only in a browser — no test that runs under node would
  // catch it.
  for (const [url, asset] of assets) {
    if (!url.startsWith("/vendor/collab/")) {
      continue;
    }
    const source = asset.body.toString("utf8");
    assert.equal(
      /from\s+"node:/u.test(source),
      false,
      `${url} imports a node builtin`,
    );
    assert.equal(/\brequire\(/u.test(source), false, `${url} is not an ES module`);
  }
});

/* ------------------------------------------------------ browser source ---- */

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function browserSource(): Promise<string> {
  return await readFile(path.join(packageRoot, "public", "app.js"), "utf8");
}

async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(packageRoot, "public", name), "utf8");
}

/** Lifts one self-contained top-level function out of the browser bundle. */
function extract<T>(source: string, name: string, nextName: string): T {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`\nfunction ${nextName}`, start);
  assert.notEqual(start, -1, `${name} was not found in app.js`);
  assert.notEqual(end, -1, `${nextName} was not found after ${name}`);
  return new Function(`${source.slice(start, end)}\nreturn ${name};`)() as T;
}

/* -------------------------------------------------------- policy form ---- */

type PolicyInput = {
  approvalsEnabled?: boolean;
  requireSchemaReview?: boolean;
  requireChangesetReview?: boolean;
  riskLevels?: string[];
  protectedPaths?: string;
  approvalTimeoutMinutes?: string;
  maxTaskRuntimeMinutes?: string;
  maxProjectRuntimeMinutesPerDay?: string;
};
type PolicyBody = { policy: Record<string, unknown> | null };

async function policyForm(): Promise<(input: PolicyInput) => PolicyBody> {
  return extract<(input: PolicyInput) => PolicyBody>(
    await browserSource(),
    "policyPayload",
    "minutesValue",
  );
}

test("an untouched policy form clears the policy rather than storing an empty one", async () => {
  const policyPayload = await policyForm();
  // Storing `{version: 1}` would look identical in the UI but would pin the
  // project against future changes to the built-in defaults.
  assert.deepEqual(policyPayload({}), { policy: null });
  assert.deepEqual(policyPayload({ riskLevels: [], protectedPaths: "\n  \n" }), {
    policy: null,
  });
});

test("the policy form distinguishes an empty field from a configured one", async () => {
  const policyPayload = await policyForm();
  assert.deepEqual(
    policyPayload({
      requireChangesetReview: true,
      riskLevels: ["medium", "high", "critical"],
      protectedPaths: "secrets/**\n\n  infra/*.tf  \n",
      approvalTimeoutMinutes: "30",
      maxTaskRuntimeMinutes: "15",
      maxProjectRuntimeMinutesPerDay: "600",
    }),
    {
      policy: {
        version: 1,
        approvals: {
          requireChangesetReview: true,
          riskLevels: ["medium", "high", "critical"],
          protectedPaths: ["secrets/**", "infra/*.tf"],
          approvalTimeoutMs: 30 * 60_000,
        },
        budgets: {
          maxTaskRuntimeMs: 15 * 60_000,
          maxProjectRuntimeMsPerDay: 600 * 60_000,
        },
      },
    },
  );

  // Budgets alone must not drag an empty approvals object along with them.
  assert.deepEqual(policyPayload({ maxTaskRuntimeMinutes: "5" }), {
    policy: { version: 1, budgets: { maxTaskRuntimeMs: 300_000 } },
  });
});

test("the policy form can explicitly enable unattended execution", async () => {
  const policyPayload = await policyForm();
  assert.deepEqual(
    policyPayload({
      approvalsEnabled: false,
      requireChangesetReview: true,
      riskLevels: ["low", "medium", "high", "critical"],
      protectedPaths: "package.json",
    }),
    { policy: { version: 1, approvals: { enabled: false } } },
  );
});

test("the policy form can keep critical gates without generic schema pauses", async () => {
  const policyPayload = await policyForm();
  assert.deepEqual(
    policyPayload({
      requireSchemaReview: false,
      riskLevels: ["critical"],
      protectedPaths: "authentication/**\ndatabase/migrations/**\nsecrets/**",
    }),
    {
      policy: {
        version: 1,
        approvals: {
          requireSchemaReview: false,
          riskLevels: ["critical"],
          protectedPaths: [
            "authentication/**",
            "database/migrations/**",
            "secrets/**",
          ],
        },
      },
    },
  );
});

test("selecting exactly the default risk levels stores nothing", async () => {
  const policyPayload = await policyForm();
  // Order must not matter; the default is a set, not a sequence.
  assert.deepEqual(policyPayload({ riskLevels: ["critical", "high"] }), {
    policy: null,
  });
  assert.deepEqual(policyPayload({ riskLevels: ["high"] }), {
    policy: { version: 1, approvals: { riskLevels: ["high"] } },
  });
});

test("the policy form refuses a runtime budget that is not a positive integer", async () => {
  const policyPayload = await policyForm();
  // Zero would be silently accepted by a truthiness check and would mean
  // "every task is instantly over budget".
  assert.throws(
    () => policyPayload({ maxTaskRuntimeMinutes: "0" }),
    /whole number of minutes/u,
  );
  assert.throws(
    () => policyPayload({ approvalTimeoutMinutes: "-5" }),
    /whole number of minutes/u,
  );
  assert.throws(
    () => policyPayload({ maxProjectRuntimeMinutesPerDay: "soon" }),
    /whole number of minutes/u,
  );
});

test("the browser date formatter supports full and compact timestamps", async () => {
  const source = await browserSource();
  const start = source.indexOf("function formatDate");
  const end = source.indexOf("\nfunction shortId", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const createFormatter = new Function(
    `${source.slice(start, end)}\nreturn formatDate;`,
  );
  const formatDate = createFormatter() as (
    value: string,
    options?: { short?: boolean },
  ) => string;
  const timestamp = "2026-07-27T12:34:00.000Z";

  assert.doesNotThrow(() => formatDate(timestamp));
  assert.doesNotThrow(() => formatDate(timestamp, { short: true }));
  assert.equal(formatDate("invalid"), "invalid");
});

/* ---------------------------------------------------------- structure ---- */

test("first-run setup is exposed only while the control plane needs an owner", async () => {
  const source = await browserSource();
  // Offering "create the first owner" on a control plane that already has one
  // invites a confusing failure; offering it nowhere strands a fresh install.
  assert.match(source, /state\.health\?\.setupRequired === true/u);
  assert.match(source, /authMode = "bootstrap"/u);
  assert.match(source, /data-act="auth-mode" data-value="bootstrap"/u);
});

test("navigation is the six product routes and nothing invented", async () => {
  const source = await browserSource();
  const routes = /const ROUTES = new Set\(\[([\s\S]*?)\]\)/u.exec(source)?.[1];
  assert.notEqual(routes, undefined);
  const parsed = [...(routes ?? "").matchAll(/"([a-z]+)"/gu)].map(
    (match) => match[1],
  );
  assert.deepEqual(parsed, [
    "repositories",
    "code",
    "agents",
    "coordinator",
    "notifications",
    "settings",
  ]);
  // Files, changes, and the editor are one Code view; tasks belong to the
  // agent that owns them rather than to a page of their own.
  assert.equal(/"my-tasks"|"activity"|"files"|"changes"/u.test(routes ?? ""), false);
});

test("the summary opens over the editor instead of navigating away", async () => {
  const source = await browserSource();
  assert.match(source, /case "code-summary":[\s\S]{0,120}showPopover\(/u);
  // It must not become a route, or "do not navigate away" is unenforceable.
  assert.equal(/"summary"/u.test(source), false);
});

test("an agent roster is personal, not a project-wide list", async () => {
  const source = await publicFile("data.js");
  const start = source.indexOf("export function myAgents");
  assert.notEqual(start, -1);
  const body = source.slice(start, source.indexOf("\n}", start));
  // Providers are per-authenticated-user connections. `state.agents` is the
  // project's registered adapter list and would leak other people's agents
  // into this screen.
  assert.match(body, /state\.providers\.map/u);
  assert.equal(/state\.agents/u.test(body), false);
});

test("a conversation is scoped to one user's own provider connection", async () => {
  const source = await publicFile("chat.js");
  // Both chat endpoints are per-principal on the gateway; nothing here may
  // address a project-wide or another user's thread.
  assert.match(source, /\/chat\/stream/u);
  assert.match(source, /\/chat\/complete/u);
  assert.equal(/projects\/\$\{[^}]*\}\/chat/u.test(source), false);
});

test("every composer control sits on one row with an icon-sized context dial", async () => {
  const source = await publicFile("chat.js");
  const bar = /<div class="composer-bar">([\s\S]*?)<\/div>/u.exec(source)?.[1];
  assert.notEqual(bar, undefined, "the composer toolbar should be one row");
  for (const control of [
    "paperclip",
    "at",
    "contextRing",
    "chat-model",
    "chat-effort",
    "send-btn",
  ]) {
    assert.match(bar ?? "", new RegExp(control, "u"), `${control} belongs on the row`);
  }
  // The ring is an indicator beside the icons, not a chart: same optical size.
  const css = await publicFile("styles.css");
  assert.match(css, /\.ctx svg \{\s*width: 15px;\s*height: 15px;/u);
});

test("the chat panel shows a bare progress bar and no token statistics", async () => {
  const source = await publicFile("chat.js");
  const start = source.indexOf("export function chatProgress");
  const body = source.slice(start, source.indexOf("\n}", start));
  assert.match(body, /chat-progress/u);
  // A percentage is the whole readout; any prose would restate the
  // conversation directly underneath it.
  assert.equal(/tokens|context window|input|output/iu.test(body), false);
});

test("the diff shown is the patch the coordinator recorded", async () => {
  const source = await publicFile("screen-code.js");
  // Re-deriving a diff in the browser would let the review disagree with what
  // validation and promotion actually acted on.
  assert.match(source, /changeSets\[changeSets\.length - 1\]/u);
  assert.match(source, /parsePatch\(patch\.patch\)/u);
});

/* ------------------------------------------------------ agent identity ---- */

function spriteTable(source: string): Map<string, string[]> {
  const block = /const SPRITES = \{([\s\S]*?)\n\};/u.exec(source)?.[1] ?? "";
  const table = new Map<string, string[]>();
  for (const entry of block.matchAll(/(\w+): \[([\s\S]*?)\n  \]/gu)) {
    table.set(
      entry[1] ?? "",
      [...(entry[2] ?? "").matchAll(/"([^"]*)"/gu)].map((row) => row[1] ?? ""),
    );
  }
  return table;
}

test("every character is a well-formed 16x16 pixel grid", async () => {
  const sprites = spriteTable(await publicFile("ui.js"));
  assert.deepEqual(
    [...sprites.keys()],
    ["claude", "cursor", "codex", "gemini", "grok", "deepseek", "generic"],
  );
  for (const [name, rows] of sprites) {
    // A ragged row shifts every pixel after it, which reads as a corrupt
    // sprite rather than as an obvious mistake.
    assert.equal(rows.length, 16, `${name} should have 16 rows`);
    for (const [index, row] of rows.entries()) {
      assert.equal(row.length, 16, `${name} row ${index} is not 16 wide`);
      assert.match(
        row,
        /^[.#+\-^*~!]{16}$/u,
        `${name} row ${index} has a stray glyph`,
      );
    }
  }
});

test("no two characters are the same drawing", async () => {
  const sprites = spriteTable(await publicFile("ui.js"));
  const drawings = [...sprites.values()].map((rows) => rows.join("\n"));
  assert.equal(
    new Set(drawings).size,
    drawings.length,
    "each agent should look like itself",
  );
});

test("a character is one colour at three opacities, so any tint works", async () => {
  const source = await publicFile("ui.js");
  // Hard-coded per-character colours would survive re-tinting as stubborn
  // patches, which is exactly what the owner colour must not have to fight.
  const block = /const SPRITES = \{([\s\S]*?)\n\};/u.exec(source)?.[1] ?? "";
  assert.equal(/#[0-9a-f]{3,8}\b/iu.test(block), false, "sprites carry no colour");
  assert.match(source, /fill="currentColor"/u);
  const alphas = [...source.matchAll(/alpha: (0?\.\d+|1)/gu)].map((m) => m[1]);
  assert.deepEqual(new Set(alphas), new Set(["1", "0.85", "0.5"]));
});

test("motion is declared by the drawing, not bolted on beside it", async () => {
  const source = await publicFile("ui.js");
  // The antenna pixels are the ones that bob. Keeping that in the pixel map
  // means a character's movement cannot drift out of step with its shape.
  const sprites = spriteTable(source);
  const moving = new Map([
    ["^", "bob"],
    ["*", "twinkle"],
    ["~", "sway"],
    ["!", "glow"],
  ]);
  const used = new Set(
    [...sprites.values()].flatMap((rows) =>
      [...rows.join("")].filter((glyph) => moving.has(glyph)),
    ),
  );
  assert.deepEqual(used, new Set(moving.keys()), "every motion glyph is in use");
  for (const part of moving.values()) {
    assert.match(source, new RegExp(`part: "${part}"`, "u"));
  }
});

test("a blink is a lid over the eye, because the eye is a hole", async () => {
  const source = await publicFile("ui.js");
  // There is nothing in an eye socket to animate — the pixels are absent — so
  // a lid in the body colour is flashed over it instead.
  assert.match(source, /const EYELIDS = \{/u);
  const block = /const EYELIDS = \{([\s\S]*?)\n\};/u.exec(source)?.[1] ?? "";
  assert.equal(
    /cursor:/u.test(block),
    false,
    "Cursor's eyes are drawn, so they flicker rather than blink",
  );
  const sprites = spriteTable(source);
  for (const name of [...sprites.keys()].filter((key) => key !== "cursor")) {
    assert.match(block, new RegExp(`${name}:`, "u"), `${name} needs a lid`);
  }
});

test("motion is restrained, reducible, and off when an agent is not there", async () => {
  const css = await publicFile("styles.css");
  // Only transform and opacity, so none of this can touch layout.
  const keyframes = [...css.matchAll(/@keyframes sp-[\w-]+ \{([\s\S]*?)\n\}/gu)]
    .map((match) => match[1] ?? "")
    .join("");
  assert.notEqual(keyframes.length, 0);
  for (const property of [...keyframes.matchAll(/^\s{4}([a-z-]+):/gmu)].map(
    (match) => match[1],
  )) {
    assert.equal(
      ["transform", "opacity"].includes(property ?? ""),
      true,
      `${property} is animated; only transform and opacity are compositor-safe`,
    );
  }
  // Every translation is sub-pixel at the size these actually render.
  for (const distance of [...keyframes.matchAll(/translate[XY]\((-?[\d.]+)px\)/gu)]) {
    assert.equal(Math.abs(Number(distance[1])) <= 0.5, true, "movement stays slight");
  }
  // Stillness is a status signal: a disconnected agent does not fidget.
  assert.match(
    css,
    /\.agent-face\[data-presence="offline"\] svg,\s*\.agent-face\[data-presence="offline"\] svg \* \{\s*animation: none;/u,
  );
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
});

test("every agent kind resolves to its own character", async () => {
  const source = await publicFile("ui.js");
  // The agent keys and the doodle names are deliberately different words
  // (`anthropic` the provider, `claude` the character). Indexing the drawings
  // with the provider key yields the fallback face for every agent, which
  // looks like a styling bug and is really a lookup bug — so assert the whole
  // path from key to drawing, not just that the table has six entries.
  const agents = /export const AGENTS = \{([\s\S]*?)\n\};/u.exec(source)?.[1] ?? "";
  const pairs = [...agents.matchAll(/(\w+): \{ label: "[^"]+", doodle: "(\w+)" \}/gu)];
  assert.equal(pairs.length, 7, "six named agents plus a fallback");

  const drawings = spriteTable(source);
  const resolved = new Set();
  for (const [key, doodle] of pairs.map((m) => [m[1], m[2]])) {
    const drawing = drawings.get(doodle ?? "");
    assert.notEqual(drawing, undefined, `${key} resolves to a missing sprite`);
    resolved.add((drawing ?? []).join("\n"));
  }
  assert.equal(resolved.size, 7, "each agent kind should look different");

  // And the accessor must go through that mapping rather than index directly.
  const start = source.indexOf("export function agentDoodle");
  assert.match(
    source.slice(start, source.indexOf("\n}", start)),
    /AGENTS\[agentKindOf\(kind\)\]\.doodle/u,
  );
});

test("a doodle is tinted by its owner, never by its vendor", async () => {
  const ui = await publicFile("ui.js");
  const start = ui.indexOf("export function agentFace");
  const body = ui.slice(start, ui.indexOf("\n}", start));
  // The shape answers "which agent"; the colour answers "whose agent". A
  // per-vendor tint would spend the only channel that can carry ownership.
  assert.match(body, /agent\?\.color/u);
  assert.equal(/tint/u.test(body), false);

  const coordinator = await publicFile("screen-coordinator.js");
  // The shared view is the whole reason the colour is an identity, so it must
  // colour by who submitted the work rather than by the signed-in user.
  assert.match(coordinator, /agentColorFor\(task\.submittedBy\)/u);
});

test("an agent colour is stored on the account, not in the browser", async () => {
  const data = await publicFile("data.js");
  const start = data.indexOf("export async function saveAppearance");
  const body = data.slice(start, data.indexOf("\n}", start));
  // localStorage would make the choice invisible to the colleagues it exists
  // to inform.
  assert.match(body, /\/auth\/me\/appearance/u);
  assert.equal(/localStorage/u.test(body), false);
});

test("a user with no chosen colour still reads as themselves", async () => {
  const data = await publicFile("data.js");
  const start = data.indexOf("export function agentColorFor");
  const body = data.slice(start, data.indexOf("\n}", start));
  // Falling back to one shared default would draw every unconfigured team
  // member's agents identically, which is the confusion the feature removes.
  assert.match(body, /charCodeAt/u);
  assert.match(body, /PALETTE\[/u);
});

test("the theme is driven by custom properties rather than per-component colour", async () => {
  const app = await browserSource();
  const start = app.indexOf("function applyTheme");
  const body = app.slice(start, app.indexOf("\n}", start));
  for (const token of [
    "--accent",
    "--accent-bright",
    "--accent-wash",
    "--accent-line",
  ]) {
    assert.match(body, new RegExp(token, "u"), `${token} should be re-themed`);
  }
});

test("a colour that reaches a style attribute is validated first", async () => {
  const ui = await publicFile("ui.js");
  // `red;background:url(...)` is a valid CSS colour prefix, so anything looser
  // than an exact hex triple is an injection point.
  assert.match(ui, /\/\^#\[0-9a-f\]\{6\}\$\/iu/u);
  const start = ui.indexOf("export function agentFace");
  assert.match(ui.slice(start, ui.indexOf("\n}", start)), /safeColor\(/u);
});

test("the product is named Lattice throughout the browser surface", async () => {
  assert.match(await browserSource(), /<b>Lattice<\/b>/u);
  assert.match(await publicFile("index.html"), /<title>Lattice<\/title>/u);
  for (const file of [
    "app.js",
    "ui.js",
    "styles.css",
    "index.html",
    "manifest.webmanifest",
  ]) {
    const source = await publicFile(file);
    assert.equal(/Agentic/u.test(source), false, `${file} still says Agentic`);
    // The earlier spelling was one letter short, which is exactly the kind of
    // rename a search-and-replace leaves half-finished.
    assert.equal(
      /Lattic(?!e)/u.test(source),
      false,
      `${file} still has the old spelling`,
    );
  }
});

/* ------------------------------------------------------------ controls ---- */

test("anything the interface can hide, it can also bring back", async () => {
  const code = await publicFile("screen-code.js");
  const app = await browserSource();
  // The chat panel's open state is persisted, so a close with no matching
  // open is not a session-long annoyance — it is permanent.
  const closers = [...code.matchAll(/data-act="chat-(close|toggle)"/gu)].map(
    (match) => match[1],
  );
  assert.equal(
    closers.includes("toggle"),
    true,
    "the Code toolbar needs a control that reopens the chat",
  );
  assert.match(app, /case "chat-toggle":/u);
});

test("a control that claims to remember something actually does", async () => {
  const data = await publicFile("data.js");
  const repos = await publicFile("screen-repos.js");
  const app = await browserSource();
  // The star used to announce that favourites were stored while storing
  // nothing and never filling in — a control asserting an effect it does not
  // have is worse than no control.
  assert.match(data, /export function toggleFavourite/u);
  assert.match(data, /localStorage\.setItem\(\s*"ag\.favourites"/u);
  assert.match(repos, /isFavourite\(repo\.id\)/u);
  assert.match(repos, /aria-pressed="\$\{isFavourite\(repo\.id\)\}"/u);
  assert.match(app, /case "star":\s*toggleFavourite\(value\);/u);
});

test("no control's whole behaviour is an apology", async () => {
  const app = await browserSource();
  // A button that only raises a toast saying it does nothing is worse than no
  // button: it costs a click to learn there is nothing there. Each case in the
  // delegated handler must do something beyond toasting.
  const cases = [
    ...app.matchAll(/case "([a-z-]+)":\s*\n\s*(toast\([^;]*\);)\s*\n\s*return;/gu),
  ].map((match) => match[1]);
  assert.deepEqual(
    cases,
    [],
    `these controls only toast: ${cases.join(", ")}`,
  );
});

test("controls the deployment cannot honour are disabled, not chatty", async () => {
  const chat = await publicFile("chat.js");
  // Attachments need a backend that is not there. A visibly disabled control
  // with a reason is honest; a live one that toasts an excuse is not.
  assert.match(chat, /<button type="button" class="icon-btn" disabled[\s\S]{0,120}paperclip/u);
  const app = await browserSource();
  // Sign-in providers this control plane does not implement are absent
  // entirely rather than present and refusing.
  assert.equal(/data-act="oauth"/u.test(app), false);
});
