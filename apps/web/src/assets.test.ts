import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadStaticAssets } from "./assets.js";
import { AGENT_CALL_SIGNS } from "./providers.js";

/* ------------------------------------------------------------- assets ---- */

test("loads every control-room asset with an explicit content type", async () => {
  const assets = await loadStaticAssets();
  assert.equal(assets.get("/index.html")?.contentType, "text/html; charset=utf-8");
  assert.equal(assets.get("/styles.css")?.contentType, "text/css; charset=utf-8");
  assert.equal(assets.get("/mark.svg")?.contentType, "image/svg+xml");
  assert.equal(
    assets.get("/manifest.webmanifest")?.contentType,
    "application/manifest+json",
  );
  // The home-screen icons: iOS reads only the apple-touch link, Android's
  // maskable shape comes from the manifest, and both need real PNGs.
  for (const icon of ["/apple-touch-icon.png", "/icon-192.png", "/icon-512.png"]) {
    assert.equal(
      assets.get(icon)?.contentType,
      "image/png",
      `${icon} should be served`,
    );
    // A PNG that is not a PNG (a stray text file, a bad regeneration) would
    // ship silently; the signature is cheap to pin.
    const body = assets.get(icon)?.body;
    assert.equal(Buffer.isBuffer(body), true, `${icon} should be bytes`);
    assert.equal(
      Buffer.isBuffer(body)
        ? body.subarray(0, 8).toString("hex")
        : undefined,
      "89504e470d0a1a0a",
      `${icon} should be a real PNG`,
    );
  }
  for (const module of [
    "/app.js",
    "/ui.js",
    "/data.js",
    "/chat.js",
    "/code-view.js",
    "/screen-repos.js",
    "/screen-code.js",
    "/screen-agents.js",
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

test("navigation is the four product routes and nothing invented", async () => {
  const source = await browserSource();
  const routes = /const ROUTES = new Set\(\[([\s\S]*?)\]\)/u.exec(source)?.[1];
  assert.notEqual(routes, undefined);
  const parsed = [...(routes ?? "").matchAll(/"([a-z]+)"/gu)].map(
    (match) => match[1],
  );
  assert.deepEqual(parsed, ["chats", "agents", "notifications", "settings"]);
  // Code is read where it is discussed — files and diffs render inline in the
  // channel transcript — so neither it nor the coordinator is a page of its
  // own, and tasks still belong to the agent that owns them.
  assert.equal(
    /"my-tasks"|"activity"|"files"|"changes"|"code"|"coordinator"/u.test(
      routes ?? "",
    ),
    false,
  );
});

test("the sidebar collapses to an icon rail with account controls at its foot", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  const sidebar = chats.slice(
    chats.indexOf("function chanSidebar"),
    chats.indexOf("/* ---------------------------------------------------------- chan main"),
  );
  const header = chats.slice(
    chats.indexOf("function chanHeader"),
    chats.indexOf("function chanSearchRow"),
  );

  // The control stays with the surface it changes; the conversation header
  // keeps only the phone button that opens the off-canvas drawer.
  assert.match(sidebar, /class="chan-sidebar-top"/u);
  assert.match(sidebar, /data-act="chan-collapse-toggle"/u);
  assert.doesNotMatch(header, /data-act="chan-collapse-toggle"/u);
  assert.match(header, /data-act="chan-sidebar-toggle"/u);

  // Settings and profile/account are stable footer rows and reuse the same
  // delegated actions as the rest of the app.
  assert.match(sidebar, /class="chan-sidebar-foot"/u);
  assert.match(
    sidebar,
    /class="chan-foot-action" data-act="nav"\s*data-value="settings"/u,
  );
  assert.match(sidebar, /class="chan-account" data-act="user-menu"/u);

  // Compact means narrow, never absent. The labels fold away while the links,
  // channel icons, Settings and account avatar remain real controls.
  assert.match(
    css,
    /\.chats-shell\.chan-collapsed > \.chan-sidebar \{\s*width: 64px;/u,
  );
  assert.doesNotMatch(
    css,
    /\.chats-shell\.chan-collapsed > \.chan-sidebar \{[^}]*display: none;/u,
  );
  assert.match(css, /\.chats-shell\.chan-collapsed \.chan-row \{/u);
  assert.match(
    css,
    /\.chats-shell\.chan-collapsed :is\(\.chan-foot-action, \.chan-account\)/u,
  );
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
    "composer-plus",
    "contextRing",
    "chat-model",
    "chat-effort",
    "send-btn",
  ]) {
    assert.match(bar ?? "", new RegExp(control, "u"), `${control} belongs on the row`);
  }
  // One control on the left, not a row of them: the "@" and the paperclip are
  // reached from the "+" menu, the way the chat apps this bar is modelled on
  // reach them. A permanent "@" is an instruction to address somebody, offered
  // before there is a message to address.
  assert.equal(/data-act="chat-mention"/u.test(bar ?? ""), false);
  assert.equal(/paperclip/u.test(bar ?? ""), false);
  // The ring is an indicator beside the icons, not a chart: same optical size.
  const css = await publicFile("styles.css");
  assert.match(css, /\.ctx svg \{\s*width: 15px;\s*height: 15px;/u);
});

test("an empty, unfocused composer collapses to one lean row", async () => {
  const css = await publicFile("styles.css");
  // The collapse is driven by the textarea's own emptiness rather than by a
  // flag in state, because every render replaces the whole app's markup and a
  // flag would have to be carried across it.
  const collapsed =
    /\.composer:not\(\.is-expanded\):not\(:focus-within\):has\(textarea:placeholder-shown\)/gu;
  assert.ok(
    (css.match(collapsed) ?? []).length >= 2,
    "the lean bar should be selected off :placeholder-shown",
  );
  // Every metric the lean bar changes goes through a variable. Two copies of
  // these paddings — one for the textarea and one for the mirror painted
  // under it — is how the highlight slides off the name it belongs to.
  assert.match(
    css,
    /\.composer-field textarea,\s*\.composer-mirror \{\s*padding: var\(--composer-pad-top\) var\(--composer-pad-x\) var\(--composer-pad-bottom\);/u,
  );
  assert.match(css, /--composer-shape: var\(--radius-lg\);/u);
  assert.match(css, /--composer-bar-layout: contents;/u);
  // Nothing on the folded row is dropped from the markup: it is unpainted, so
  // focusing the composer brings it back without waiting for a render.
  const hidden = /:has\(textarea:placeholder-shown\)\s*:is\(([\s\S]*?)\)\s*\{\s*display: none;/u
    .exec(css)?.[1];
  assert.notEqual(hidden, undefined, "the folded controls should be one list");
  for (const control of ["mini-select", "ctx", "composer-note", "spacer"]) {
    assert.match(hidden ?? "", new RegExp(control, "u"), `${control} folds away, not out`);
  }
  // The two controls the bar exists for stay: one "+" and one send.
  assert.equal(/composer-plus/u.test(hidden ?? ""), false);
  assert.equal(/send-btn/u.test(hidden ?? ""), false);
});

test("the composer is one lean floating bar with a + and a send", async () => {
  const chats = await publicFile("screen-chats.js");
  const chat = await publicFile("chat.js");
  const css = await publicFile("styles.css");
  // Both composers open the same menu from the same control, so "add something
  // to this message" is one idea in one place rather than two rows of icons.
  for (const source of [chats, chat]) {
    assert.match(source, /act: "composer-plus"/u);
    assert.match(source, /cls: "composer-plus"/u);
  }
  // Nothing surfaces the "@" permanently any more — it is typed, or picked
  // from the menu, which is what the apps this bar follows do.
  assert.equal(/act: "channel-mention-key"/u.test(chats), false);
  assert.equal(/act: "chat-mention"/u.test(chat), false);
  // Attaching, commands and mentions all hang off the one control.
  const menu = /case "composer-plus": \{([\s\S]*?)\n    \}/u.exec(await publicFile("app.js"))?.[1];
  assert.notEqual(menu, undefined, "the + opens a menu");
  for (const entry of ["channel-attach", "channel-slash-key", "channel-mention-key", "chat-mention"]) {
    assert.match(menu ?? "", new RegExp(entry, "u"), `${entry} belongs behind the +`);
  }
  // It opens upward: the bar sits on the floor of the window, and a menu hung
  // below its anchor would be off the bottom of the screen.
  assert.match(menu ?? "", /box\.top - menu\.offsetHeight/u);
  // Raised off the conversation rather than bolted to the bottom of it.
  const shape = /\n\.composer \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(shape, undefined, "the composer has a shape rule");
  assert.match(shape ?? "", /box-shadow: var\(--shadow-pop\);/u);
  assert.match(shape ?? "", /--composer-shape: var\(--radius-lg\);/u);
  // The elastic gap is off while every control is on the compact bar, or it takes
  // half the width of the box away from the sentence being written in it.
  assert.match(shape ?? "", /--composer-spacer-layout: none;/u);
  assert.match(css, /\.composer-bar \.spacer \{\s*display: var\(--composer-spacer-layout/u);
});

test("the composer stays open over a decision the textarea cannot see", async () => {
  const source = await publicFile("screen-chats.js");
  const start = source.indexOf("function composer(repositoryId)");
  const body = source.slice(start, source.indexOf("\n}", start));
  // Staged images, an upload in flight and a thread the next message is aimed
  // at all live outside the form, so an empty box would otherwise collapse the
  // bar carrying the controls that answer them.
  assert.match(body, /is-expanded/u);
  for (const pending of [
    /state\.attaching > 0/u,
    /state\.composerThreadId !== undefined/u,
    /draftAttachments\(repositoryId\)\.length > 0/u,
  ]) {
    assert.match(body, pending);
  }
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

test("a user's agent colour is one they chose, not one they were dealt", async () => {
  const data = await publicFile("data.js");
  const start = data.indexOf("export function agentColorFor");
  const body = data.slice(start, data.indexOf("\n}", start));
  // Their explicit choice first, then their accent — both are "a colour for
  // this person", and falling to the accent second is what stopped somebody
  // whose interface was purple from having an orange agent beside it.
  assert.match(body, /agentColor/u);
  assert.match(body, /accent/u);
  // Then one shared default, deliberately, rather than a hash of the user id.
  // The hash gave everybody a different colour for free, which sounds useful
  // and reads as decoration: nothing in the interface means "orange", so an
  // orange agent next to a purple highlight is two colours disagreeing.
  // Distinct colours are still one click away in Appearance — the difference
  // is that somebody chose them.
  assert.match(body, /DEFAULT_ACCENT/u);
  assert.equal(/charCodeAt/u.test(body), false);
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

/**
 * The accent tints were derived once, for a dark ground, and used on both
 * themes — so switching to light left the highlights sitting on top of cream
 * at a ratio nobody could read. The numbers below are the point: a source-text
 * check that the branch exists would pass just as happily on a branch that
 * darkens by the wrong amount, and "the wrong amount" is exactly how the
 * default accent read at 2:1 and a chosen yellow at 1.1:1.
 */
test("accent text is legible on the light theme's own paper, whatever the accent", async () => {
  const app = await browserSource();
  const start = app.indexOf("function channels");
  const end = app.indexOf("\nfunction currentAgent", start);
  assert.notEqual(start, -1, "the colour helpers were not found in app.js");
  assert.notEqual(end, -1, "currentAgent no longer follows the colour helpers");
  const block = app.slice(start, end);
  const lift = <T>(name: string): T =>
    new Function(`${block}\nreturn ${name};`)() as T;
  const readableOn = lift<(a: string, g: string, t: number) => string>(
    "readableOn",
  );
  const contrastRatio = lift<(a: string, b: string) => number>("contrastRatio");
  const mix = lift<(a: string, b: string, amount: number) => string>("mix");

  // The light theme's surfaces, from `:root[data-theme="light"]` in
  // styles.css: the page ground, the cards, and the conversation column.
  const surfaces = ["#e8e2d4", "#efeadd", "#f6f2e8", "#fdfbf5"];
  // A deep purple, a bright cyan, a green, a yellow and a pink — the range
  // somebody can actually pick, not just the default.
  for (const accent of ["#8b5cf6", "#16bfff", "#4ade80", "#fbbf24", "#f472b6"]) {
    const bright = readableOn(accent, "#e8e2d4", 4.5);
    for (const surface of surfaces) {
      assert.ok(
        contrastRatio(bright, surface) >= 4.5,
        `${accent} on ${surface} reads at ${contrastRatio(bright, surface).toFixed(2)}:1`,
      );
    }
    // What the dark theme derives, which is what light used to inherit.
    // Asserted so this test fails if somebody quietly points light back at it.
    assert.ok(
      contrastRatio(mix(accent, "#ffffff", 0.32), "#e8e2d4") < 4.5,
      `${accent} lightened for dark should not be legible on light`,
    );
  }
  // An accent that is already dark enough is left as it is: darkening past
  // legibility only costs the colour somebody chose.
  assert.equal(readableOn("#111111", "#e8e2d4", 4.5), "#111111");
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
  const app = await browserSource();
  // Attachments need a backend that is not there. Since the "+" menu is where
  // attaching now lives, that is where the refusal lives: a visibly disabled
  // entry carrying its reason is honest; a live one that toasts an excuse is
  // not.
  assert.match(
    app,
    /label: "Photos & files",\s*hint: "Not available on this deployment",\s*iconName: "paperclip",\s*disabled: true,/u,
  );
  // Sign-in providers this control plane does not implement are absent
  // entirely rather than present and refusing.
  assert.equal(/data-act="oauth"/u.test(app), false);
});

test("slash and mention filtering does not rebuild the app while typing", async () => {
  const chats = await publicFile("screen-chats.js");
  const start = chats.indexOf("export function updateComposerInput");
  const end = chats.indexOf("\nexport function pickSlashCommand", start);
  assert.notEqual(start, -1, "the channel composer input handler should exist");
  assert.notEqual(end, -1, "the composer input handler should have a boundary");
  const handler = chats.slice(start, end);

  assert.match(handler, /suggestions\.innerHTML = composerSuggestions/u);
  assert.equal(
    /\brerender\s*\(/u.test(handler),
    false,
    "filtering / and @ suggestions must not trigger a full-app render",
  );
});

test("channel @mentions include repository guests and surface directed unread pings", async () => {
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");

  const participants = data.slice(
    data.indexOf("export function channelParticipants"),
    data.indexOf("\nfunction seedMessages", data.indexOf("export function channelParticipants")),
  );
  assert.match(participants, /state\.channelPeople\[repositoryId\]/u);
  assert.match(participants, /member\.user\?\.displayName/u);
  assert.match(chats, /entry\.kind === "agent"[\s\S]{0,100}"person"/u);

  const unread = data.slice(
    data.indexOf("export function channelUnreadCount"),
    data.indexOf("\n}\n", data.indexOf("export function channelUnreadCount")) + 2,
  );
  assert.match(unread, /mentionsOnly/u);
  assert.match(unread, /mention\.kind === "user" && mention\.id === mine/u);
  assert.match(chats, /mentions > 0 \? "@"/u);
});

test("the channel composer highlights mentions and previews pasted images", async () => {
  const app = await browserSource();
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  assert.match(app, /addEventListener\("paste"/u);
  assert.match(app, /clipboardData\?\.items/u);
  assert.match(app, /item\.getAsFile\(\)/u);
  assert.match(app, /event\.preventDefault\(\);[\s\S]{0,80}attachChannelImages/u);
  assert.match(app, /case "channel-attachment-remove"/u);
  assert.match(chats, /function draftAttachmentPreviews/u);
  assert.match(chats, /class="composer-attachments"/u);
  assert.match(chats, /state\.mentionActive \? " mention-active"/u);
  assert.match(chats, /classList\.toggle\("mention-active", state\.mentionActive\)/u);
  assert.match(css, /\.chan-composer-wrap\.mention-active::before/u);
  assert.match(css, /\.composer-attachment img/u);
});

test("thread composer characters stay visible without a painted text layer", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // Thread replies are a plain textarea, not a transparent control laid over
  // a mirror. The shared composer rule must therefore paint both ordinary CSS
  // text and WebKit's separate text fill rather than relying on inheritance.
  assert.match(
    chats,
    /<form class="composer" data-act="channel-thread-submit"[\s\S]{0,240}<textarea data-act="channel-thread-input"/u,
  );
  const rule = /\.composer textarea \{([\s\S]*?)\n\}/u.exec(css);
  assert.ok(rule !== null, "the shared composer textarea rule exists");
  assert.match(rule[1] ?? "", /\n\s*color: var\(--text\);/u);
  assert.match(rule[1] ?? "", /\n\s*-webkit-text-fill-color: var\(--text\);/u);
  assert.doesNotMatch(rule[1] ?? "", /transparent/u);
});

test("a posted ping highlights its full name with a quiet static treatment", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  const start = chats.indexOf("function mentionMarkup");
  const end = chats.indexOf("\n/**\n * A narrow, safe subset", start);
  assert.notEqual(start, -1, "screen-chats.js declares mentionMarkup");
  assert.notEqual(end, -1, "mentionMarkup has a testable boundary");
  const createMarkup = new Function(
    `${chats.slice(start, end)}\nreturn mentionMarkup;`,
  );
  const mentionMarkup = createMarkup() as (
    value: string,
    names: string[],
  ) => string;
  const wrap = (text: string, names: string[]) =>
    mentionMarkup(text, names).replace(
      /<span class="mention-ping">@([^<]+)<\/span>/gu,
      "[$1]",
    );

  assert.equal(
    wrap("ping @Claude (Owner) now", ["Claude (Owner)"]),
    "ping [Claude (Owner)] now",
  );
  assert.equal(
    wrap("@Mary Jane ask @Claude (Owner), please", [
      "Mary",
      "Mary Jane",
      "Claude (Owner)",
    ]),
    "[Mary Jane] ask [Claude (Owner)], please",
  );
  assert.equal(
    wrap("@Mary Jane then @Mary Jane", ["Mary Jane"]),
    "[Mary Jane] then [Mary Jane]",
  );
  // An address and a path are not pings, and neither is an at sign inside a
  // word — only what the picker writes.
  assert.equal(
    wrap("mail nate@example.com", ["example.com"]),
    "mail nate@example.com",
  );
  assert.equal(wrap("see docs/@notes", ["notes"]), "see docs/@notes");
  assert.equal(wrap("<code>@agent</code>", ["agent"]), "<code>@agent</code>");
  assert.match(
    chats,
    /messageBody\(\s*entry\.content,\s*repositoryId,\s*entry\.mentions,/u,
  );

  // One readable accent on its light wash, shared with the live composer and
  // with no changing gradient. The rules are separate because posted tokens
  // may be bold while mirror tokens must keep the textarea's glyph widths.
  for (const selector of [
    ".cmsg-text .mention-ping {",
    ".composer-mirror .mention-ping {",
  ]) {
    const start = css.indexOf(selector);
    const rule = css.slice(start, css.indexOf("}", start) + 1);
    assert.notEqual(start, -1);
    assert.match(rule, /color: var\(--accent-bright\);/u);
    assert.match(rule, /background: var\(--accent-wash\);/u);
    assert.match(rule, /border-radius:/u);
    assert.doesNotMatch(rule, /gradient|animation|background-clip|text-fill/iu);
  }
  assert.match(
    css,
    /\.cmsg-text \.mention-ping \{[\s\S]{0,180}padding: 1px 4px;/u,
  );
  assert.doesNotMatch(css, /mention-wave/u);

  // A command keeps the colour it had in the composer once it is posted:
  // `richText` runs the same `slashMarkup` the mirror does, and the posted
  // token gets the same inline padding a posted ping does.
  assert.match(chats, /function slashMarkup/u);
  assert.match(chats, /const inline = \(value\) =>\s*\n\s*slashMarkup\(/u);
  assert.match(
    css,
    /\.cmsg-text \.slash-ping \{[\s\S]{0,180}padding: 1px 4px;/u,
  );
});

test("the invite screen names the product, not only the team", async () => {
  const app = await browserSource();
  const start = app.indexOf("function renderInvite");
  const body = app.slice(start, app.indexOf("\nfunction renderAuth", start));
  // The headline is whatever the organization is called, which is a name
  // somebody chose — an organization named after some product reads as that
  // product unless this screen says which one it actually is.
  assert.match(body, /organizationName/u);
  assert.match(body, /on Lattice/u);
});

/**
 * An invitation sent to somebody who is already on Lattice — a second team, a
 * second repository — must not dead-end on a form that cannot succeed.
 *
 * The address is taken, so "choose a password" can only ever be refused with
 * `account_exists`. The screen therefore reads `accountExists` from the
 * preview to open on the sign-in form instead, keeps both forms reachable
 * from the footer link, and falls back to sign-in if an accept is refused
 * that way anyway — a preview read before the account existed.
 */
test("the invite screen lets an existing account sign in instead", async () => {
  const app = await browserSource();
  const start = app.indexOf("function renderInvite");
  const body = app.slice(start, app.indexOf("\nfunction renderAuth", start));
  assert.match(body, /accountExists/u);
  assert.match(body, /"invite-signin"/u);
  assert.match(body, /data-act="invite-mode" data-value="signin"/u);
  assert.match(body, /data-act="invite-mode" data-value="join"/u);
  // The sign-in field is the password they already have, so the browser must
  // not be told to offer a new one.
  assert.match(body, /current-password/u);
  // Both forms are wired up, and a refusal on the join form moves the person
  // to the one that can work rather than repeating itself.
  assert.match(app, /case "invite-signin":/u);
  assert.match(app, /account_exists/u);
});

/**
 * A call sign has one job: to be the only thing it could refer to.
 *
 * Mentions are matched with `content.includes("@" + name)` against every
 * candidate, so a name that is a prefix of another name matches inside it —
 * "@Poseidon" would carry "@Pos" with it, and both agents would be dispatched
 * from one sentence. Nothing about adding a name to the list makes that
 * visible, so it is asserted here rather than left to be noticed in a channel.
 */
test("no agent call sign is a prefix of another", () => {
  const names = [...AGENT_CALL_SIGNS];
  assert.ok(names.length >= 30, `only ${names.length} call signs`);
  assert.equal(new Set(names).size, names.length, "call signs must be unique");
  const collisions = names.flatMap((shorter) =>
    names
      .filter((longer) => longer !== shorter && longer.startsWith(shorter))
      .map((longer) => `${shorter} is a prefix of ${longer}`),
  );
  assert.deepEqual(collisions, []);
});

/**
 * One pantheon, one code path.
 *
 * The browser used to keep its own copy of the list and name an agent as it
 * was added to a channel, on top of the name the server had already given the
 * account at connect. That made the name a property of the room: the same
 * agent was Athena in one channel and Vesta in the next, and the copies could
 * drift apart besides. Naming lives on the server alone now, so the browser
 * holding any list of gods at all is the regression.
 */
test("the browser does not name agents", async () => {
  const data = await publicFile("data.js");
  assert.equal(data.includes("AGENT_CODE_NAMES"), false);
  assert.equal(data.includes("freeAgentCodeName"), false);
  const app = await publicFile("app.js");
  assert.equal(app.includes("freeAgentCodeName"), false);
  // Adding an agent to a channel adds it and nothing else. A rename from the
  // roster is still a thing somebody can choose to do.
  const start = app.indexOf('case "channel-agent-add-to"');
  assert.notEqual(start, -1);
  const handler = app.slice(start, app.indexOf("\n    }", start));
  assert.equal(handler.includes("renameChannelAgent"), false);
  assert.ok(app.includes("renameChannelAgent("), "manual rename must remain");
});

test("an agent's reply to a person is shown, not folded into the thinking block", async () => {
  // Reported as "they start on the task but they don't respond and confirm".
  // The server does post an acknowledgement when work is asked for inside a
  // thread — before the task is even submitted — but it is a reply carrying
  // the default `agent` kind, and the transcript treated any such reply as run
  // chatter and hoisted it into a fold that renders closed once a thread has
  // an ending. The reader saw their request and then nothing.
  const source = await publicFile("screen-chats.js");
  const start = source.indexOf("function isThreadThinking");
  const body = source.slice(start, source.indexOf("\n}", start));
  // The server's own mark, and nothing else. Guessing from the kind is what
  // swallowed every sentence an agent addresses to a person.
  assert.match(body, /reply\.kind === "progress"/u);
  assert.equal(
    /reply\.kind === "agent"/u.test(body),
    false,
    "an `agent` reply is the agent talking to a person and must stay visible",
  );
});

test("each task turn puts its own thinking below its prompt", async () => {
  const source = await publicFile("screen-chats.js");
  const groupingStart = source.indexOf("function threadReplyTurns");
  const thinkingStart = source.indexOf("function threadThinkingBlock");
  const rendererStart = source.indexOf(
    "function threadReplies",
    thinkingStart,
  );
  const rendererEnd = source.indexOf(
    "\n/**\n * How much summary",
    rendererStart,
  );
  assert.notEqual(
    groupingStart,
    -1,
    "thread replies should be grouped into turns",
  );
  assert.notEqual(thinkingStart, -1, "each turn should render its own thinking");
  assert.notEqual(rendererStart, -1, "the thread reply renderer should exist");

  const grouping = source.slice(groupingStart, thinkingStart);
  assert.match(grouping, /reply\.kind === "user"/u);
  assert.match(grouping, /ended = reply\.kind === "outcome"/u);
  assert.match(
    grouping,
    /prompt: reply\.kind === "user" \? reply : undefined/u,
  );

  const renderer = source.slice(rendererStart, rendererEnd);
  const promptAt = renderer.indexOf("summaryBlock(turn.prompt, repositoryId)");
  const thinkingAt = renderer.indexOf("${thinking.html}");
  assert.ok(promptAt >= 0, "the turn's prompt should be rendered");
  assert.ok(
    thinkingAt > promptAt,
    "the turn's Thinking disclosure must follow the prompt that caused it",
  );
  assert.match(
    renderer,
    /threadReplyTurns\(replies\)[\s\S]*\.map\(\(turn, index\)/u,
  );

  const thinking = source.slice(thinkingStart, rendererStart);
  assert.match(thinking, /const key = `\$\{rootId\}:thinking:\$\{index\}`/u);
  assert.match(thinking, /state\.thinkingOpen\[key\] \?\? !done/u);
});

test("the working dots come back for the next turn in a finished thread", async () => {
  // The same turn, silent twice: a thread whose earlier turn ended is exactly
  // where the next request is made, and asking whether the thread had *ever*
  // ended meant the dots never returned for it.
  const source = await publicFile("screen-chats.js");
  const start = source.indexOf("function threadTyping");
  const body = source.slice(start, source.indexOf("\n}", start));
  assert.equal(
    /replies\.some\(\(reply\) => isThreadEnding\(reply\)\)/u.test(body),
    false,
    "the dots must key on the last reply, not on any reply ever",
  );
  assert.match(body, /replies\[replies\.length - 1\]/u);

  // A new turn gets its own disclosure key. It therefore opens from its live
  // default without reopening the completed turn above it or needing a
  // thread-global reset before submit.
  const thinkingStart = source.indexOf("function threadThinkingBlock");
  const thinkingEnd = source.indexOf("\nfunction threadReplies", thinkingStart);
  const thinking = source.slice(thinkingStart, thinkingEnd);
  assert.match(thinking, /const key = `\$\{rootId\}:thinking:\$\{index\}`/u);
  assert.match(thinking, /state\.thinkingOpen\[key\] \?\? !done/u);

  const app = await browserSource();
  assert.equal(
    app.includes("function beginThreadTurn"),
    false,
    "submitting a turn must not reopen a thread-global Thinking block",
  );
});

test("the colour wheel's marker and its click land on the same colour", async () => {
  // The wheel draws a position from a colour and reads a colour from a
  // position, in two different files. If those disagree the marker sits
  // somewhere the click would not produce, which looks like a wheel that
  // ignores you — so the two are held to being exact inverses.
  const ui = (await import(
    pathToFileURL(path.join(packageRoot, "public", "ui.js")).href
  )) as {
    hexToHsl: (hex: string) => { h: number; s: number; l: number };
    hslToHex: (h: number, s: number, l: number) => string;
    colorWheel: (act: string, current: string) => string;
  };
  // The inverse as `wheelColorAt` computes it, in app.js.
  const colorAt = (left: number, top: number, l: number): string => {
    const x = left / 100 - 0.5;
    const y = top / 100 - 0.5;
    return ui.hslToHex(
      (Math.atan2(y, x) * 180) / Math.PI + 90,
      Math.min(Math.hypot(x, y) * 2, 1),
      l,
    );
  };
  for (const hex of [
    "#8b5cf6",
    "#2fae7f",
    "#e0663d",
    "#4f8ef7",
    "#3fa8b5",
    "#ff0000",
    "#00ff00",
    "#0000ff",
  ]) {
    const marker = /left:([\d.]+)%;top:([\d.]+)%/u.exec(ui.colorWheel("x", hex));
    assert.ok(marker, `no marker drawn for ${hex}`);
    const back = colorAt(Number(marker[1]), Number(marker[2]), ui.hexToHsl(hex).l);
    assert.equal(back, hex, `${hex} draws a marker that reads back as ${back}`);
  }
  // Red at twelve o'clock, which is where the conic gradient starts.
  const red = /left:([\d.]+)%;top:([\d.]+)%/u.exec(ui.colorWheel("x", "#ff0000"));
  assert.equal(Number(red![1]).toFixed(0), "50");
  assert.equal(Number(red![2]).toFixed(0), "0");
});

test("the composer paints its mentions on a layer that matches the textarea", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // A textarea has one colour for all of its text, so the ping is painted by
  // a div underneath holding the same string.
  assert.match(chats, /class="composer-mirror" data-composer-mirror/u);
  assert.match(chats, /function composerMirror/u);
  assert.match(chats, /function paintComposerMirror/u);
  // Repainted on the keystroke path itself. Going through `render()` would
  // put the whole-app rebuild that handler exists to avoid back in the way of
  // every character typed.
  assert.match(chats, /paintComposerMirror\(node\);/u);
  assert.match(css, /\.composer-mirror \.mention-ping/u);

  // Mentions only — none of richText's markdown. Exercise the actual mirror,
  // including the live participant list that the merge accidentally omitted.
  const start = chats.indexOf("function mentionMarkup");
  const end = chats.indexOf("\n/** Repaints the layer", start);
  assert.notEqual(start, -1, "screen-chats.js declares mentionMarkup");
  assert.notEqual(end, -1, "composerMirror has a testable boundary");
  const createMirror = new Function(
    "esc",
    `${chats.slice(start, end)}\nreturn composerMirror;`,
  );
  const composerMirror = createMirror((value: unknown) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return String(value ?? "").replace(
      /[&<>"']/gu,
      (character) => entities[character] ?? character,
    );
  }) as (value: string, participants: Array<{ name: string }>) => string;
  const wrap = (value: string, names: string[]) =>
    composerMirror(
      value,
      names.map((name) => ({ name })),
    )
      .replace(/<span class="mention-ping">@([^<]*)<\/span>/gu, "[$1]")
      .replace(/<span class="slash-ping">\/([^<]*)<\/span>/gu, "{$1}");
  assert.equal(
    wrap("ask @Mary Jane and @Claude (Owner)", [
      "Mary",
      "Mary Jane",
      "Claude (Owner)",
    ]),
    "ask [Mary Jane] and [Claude (Owner)]\n",
  );
  assert.equal(
    wrap("mail nate@example.com; see docs/@notes", ["example.com", "notes"]),
    "mail nate@example.com; see docs/@notes\n",
  );
  assert.equal(
    wrap("<code>@agent</code>", ["agent"]),
    "&lt;code&gt;@agent&lt;/code&gt;\n",
  );
  assert.equal(wrap("@agents review", []), "[agents] review\n");

  // The point of the mirror is that it colours what is being typed *now*. A
  // ping only lit up once its last character landed, and a name that never
  // resolved never lit up at all, so the composer looked broken next to the
  // transcript above it. The half-typed token is a ping too.
  assert.equal(wrap("ask @Mar", ["Mary Jane"]), "ask [Mar]\n");
  assert.equal(wrap("@", []), "[]\n");
  // ...and a command is coloured from the first character after the slash,
  // wherever in the message it was written.
  assert.equal(wrap("/plan the migration", []), "{plan} the migration\n");
  assert.equal(wrap("@agents /plan it", []), "[agents] {plan} it\n");
  // A path is not a command, and neither is a slash inside a word — the same
  // boundary the picker itself opens on.
  assert.equal(wrap("edit src/retry.ts", []), "edit src/retry.ts\n");
  assert.equal(wrap("ls /usr/bin", []), "ls /usr/bin\n");
  // The markup the passes before it produced is not re-read by the ones
  // after: a resolved multi-word name stays whole, and no closing tag is
  // mistaken for a command.
  assert.equal(
    wrap("/plan with @Mary Jane", ["Mary Jane"]),
    "{plan} with [Mary Jane]\n",
  );

  // The metrics the two share. Declared once, for both selectors, because a
  // single pixel of difference between them wraps the mirror at a different
  // word than the textarea and the caret stops landing on the letters.
  const shared = /\.composer-field textarea,\s*\.composer-mirror \{([\s\S]*?)\}/u
    .exec(css);
  assert.ok(shared !== null, "the textarea and its mirror share one rule");
  for (const property of [
    "padding",
    "font-size",
    "font-family",
    "line-height",
    "white-space",
    "overflow-wrap",
  ]) {
    assert.match(
      shared[1] ?? "",
      new RegExp(`\\n\\s*${property}:`, "u"),
      `${property} is shared`,
    );
  }

  // The caret is the one part of the textarea that must stay visible.
  assert.match(css, /caret-color: var\(--text\)/u);
  const composerPing = /\.composer-mirror \.mention-ping \{([\s\S]*?)\n\}/u
    .exec(css);
  assert.ok(composerPing !== null, "the composer mention rule exists");
  assert.doesNotMatch(
    composerPing[1] ?? "",
    /\b(?:font-weight|letter-spacing|margin|padding):/u,
    "painting a mention must not change glyph advances or spacing",
  );
  // The command token is painted under the same constraint, in the second
  // accent so a command and a ping are not the same colour.
  assert.match(css, /\.composer-mirror \.slash-ping \{[\s\S]{0,120}accent-2-wash/u);
  const composerSlash = /\.composer-mirror \.slash-ping \{([\s\S]*?)\n\}/u.exec(css);
  assert.ok(composerSlash !== null, "the composer command rule exists");
  assert.doesNotMatch(
    composerSlash[1] ?? "",
    /\b(?:font-weight|letter-spacing|margin|padding):/u,
    "painting a command must not change glyph advances or spacing",
  );
});

test("a phone's caret sits on its own letters, and a backlog arrives as one line", async () => {
  const app = await browserSource();
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // A phone bumps every field to 16px so iOS does not zoom on focus. The
  // mirror is a div, so that rule never reached it: the textarea grew and the
  // layer painting its text did not, which put the caret off the letters it
  // sat in. Whatever size the textarea is told to be, its mirror is told too.
  const zoomAt = css.indexOf(".app textarea,");
  assert.notEqual(zoomAt, -1, "the phone anti-zoom rule is still there");
  const zoomRule = css.slice(zoomAt, css.indexOf("}", zoomAt));
  assert.match(zoomRule, /\.app \.composer-mirror,/u);
  assert.match(zoomRule, /font-size: 16px;/u);
  // And it is the phone rule, not some other block that happens to match.
  assert.match(
    css.slice(css.lastIndexOf("@media", zoomAt), zoomAt),
    /max-width: 600px/u,
  );

  // The channel box grows without swapping layout modes underneath the
  // caret. Its textarea supplies the animated height while the two edge
  // controls stay in one flex row; reduced-motion still short-circuits it.
  assert.match(
    css,
    /\.chan-composer-wrap \.composer \{[\s\S]{0,360}--composer-layout: flex;[\s\S]{0,220}--composer-bar-layout: contents;/u,
  );
  assert.match(
    css,
    /\.chan-composer-wrap \.composer-field textarea \{\s*min-height: 64px;\s*transition: min-height 0\.22s ease, padding 0\.2s ease;/u,
  );
  assert.match(
    css,
    /:has\(textarea:placeholder-shown\)[\s\S]{0,100}\.composer-field\s*textarea \{\s*min-height: 36px;/u,
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,180}transition-duration: 0\.01ms !important;/u,
  );

  // The header counted the whole organization — and, before that had loaded,
  // only the reader. Both it and the sidebar now count this room.
  assert.match(chats, /function channelPeopleFor/u);
  assert.match(chats, /const people = channelPeopleFor\(repositoryId\)/u);
  assert.match(chats, /const people = channelPeopleFor\(activeRepositoryId\)/u);
  assert.doesNotMatch(
    /function chanHeader[\s\S]*?\n\}/u.exec(chats)?.[0] ?? "",
    /collaborators\(\)/u,
    "the channel header no longer counts the organization",
  );

  // Reconnecting delivers everything that happened while the browser was
  // closed. One banner each, five seconds each, was a wall of them; one
  // reconcile each was a full app rebuild each.
  assert.match(app, /function announceNews/u);
  assert.match(app, /announceNews\(line\)/u);
  assert.match(app, /lines\.length === 1 \? latest :/u);
  assert.match(app, /clearTimeout\(channelFrameTimer\)/u);
  assert.match(app, /CHANNEL_FRAME_COALESCE_MS/u);
  // The burst collapses, it is not dropped: the count is still reported.
  assert.match(app, /\$\{lines\.length\} updates/u);
});

test("a roster row carries one button, and one settings panel behind it", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await browserSource();
  const ui = await publicFile("ui.js");
  const css = await publicFile("styles.css");

  const row = chats.slice(
    chats.indexOf("function rosterRow(agent)"),
    chats.indexOf("/**\n * What the \"...\" on a roster row offers"),
  );
  assert.notEqual(row, "", "the roster row should still be drawn here");
  // The four controls the row used to carry — a switch, rename, model &
  // effort, and a close button one mis-click from removing the agent —
  // collapse into the same "..." the channel rows above already use.
  assert.match(row, /act: "roster-agent-menu"/u);
  for (const gone of [
    "rr-switch",
    'act: "channel-rename-toggle"',
    'act: "channel-settings-toggle"',
    'act: "channel-agent-remove"',
  ]) {
    assert.equal(
      row.includes(gone),
      false,
      `${gone} should live in the menu, not on the row`,
    );
  }
  // The row's only expandable is the one panel; the separate rename form it
  // used to grow instead is gone.
  assert.match(row, /settingsOpen \? rosterSettings\(agent\) : ""/u);
  assert.equal(row.includes("chatRenamingId"), false);

  // The menu is now short on purpose: editing the agent at all is one entry,
  // beside the two things that are not edits.
  const menu = chats.slice(
    chats.indexOf("export function rosterMenuItems"),
    chats.indexOf("function chanSidebar"),
  );
  assert.match(menu, /"channel-settings-toggle"/u);
  assert.match(menu, /label: "Settings"/u);
  assert.match(menu, /"auditor-toggle"/u);
  assert.match(menu, /"agent-chat-open"/u);
  // Rename, model and removal are no longer three ways into the same
  // question — the panel holds all of them.
  for (const gone of [
    "channel-rename-toggle",
    "channel-agent-remove",
    "separator: true",
  ]) {
    assert.equal(
      menu.includes(gone),
      false,
      `${gone} belongs to the settings panel, not the menu`,
    );
  }

  // And the panel is where they went: the name and role in a form that
  // commits them, the model and effort as dropdowns, removal last and red.
  const settings = chats.slice(
    chats.indexOf("function rosterSettings(agent)"),
    chats.indexOf("/**\n * The hover card for one roster entry"),
  );
  assert.notEqual(settings, "", "the settings panel is drawn here");
  assert.match(settings, /data-act="channel-rename-form"/u);
  assert.match(settings, /data-act="channel-rename-input"/u);
  assert.match(settings, /data-act="channel-role-input"/u);
  assert.match(settings, /settingRow\("Model", "channel-agent-model"/u);
  assert.match(settings, /"channel-agent-effort"/u);
  assert.match(settings, /class="rs-remove" data-act="\$\{removeAct\}"/u);
  // A teammate's agent may only be removed by somebody the server would let,
  // and one's own is unconditional — the same rule the menu applied before.
  assert.match(
    settings,
    /agent\.mine === true \|\| canManageRepository\(activeChannelId\(\)\)/u,
  );
  assert.match(
    settings,
    /agent\.mine === true\s*\?\s*"channel-agent-remove"\s*:\s*"channel-agent-remove-any"/u,
  );
  // Red, and the only red thing in the panel.
  assert.match(css, /\.rs-remove \{[\s\S]{0,240}color: var\(--red\)/u);
  assert.match(css, /\.rs-remove:hover \{[\s\S]{0,80}background: var\(--red-wash\)/u);

  // `danger` is still the flag the shared menu paints its destructive entries
  // with, so anything that goes back into a menu is the same red.
  assert.match(ui, /item\.danger === true \? " menu-item-danger"/u);
  assert.match(css, /\.menu-item-danger[\s\S]{0,120}color: var\(--red\)/u);

  // The menu is dismissed by everything it dispatches: `render()` rebuilds
  // the row underneath it, and a popover anchored to a button that no longer
  // exists is left floating over the result.
  assert.match(app, /case "roster-agent-menu":[\s\S]{0,160}rosterMenuItems\(value\)/u);
  assert.match(app, /case "channel-agent-remove":\s*\n\s*closePopover\(\);/u);
  assert.match(
    app,
    /case "channel-settings-toggle":\s*\n\s*closePopover\(\);/u,
  );
  // Opening the panel puts the cursor in the field somebody most often came
  // for, and a commit that changes nothing must not rebuild the panel around
  // the picker they were reaching for.
  assert.match(app, /channel-rename-input'\]"\);\s*\n\s*input\?\.focus\(\)/u);
  assert.match(app, /input\.value !== input\.defaultValue/u);
  assert.match(app, /nameInput\.value !== nameInput\.defaultValue/u);
  assert.match(app, /state\.chatSettingsOpenId === agentId/u);
});

test("a slash command is offered wherever it is typed, not only at the start", async () => {
  const chats = await publicFile("screen-chats.js");

  // It used to have to be the first thing in the message, on both sides.
  // Nothing on screen said so, and somebody who typed the mention first got
  // a slash that opened nothing.
  const mentionState = chats.slice(
    chats.indexOf("function updateMentionState"),
    chats.indexOf("export function updateComposerInput"),
  );
  assert.match(mentionState, /\/\(\^\|\\s\)\\\/\(\[a-z0-9-\]\*\)\$\/iu/u);
  assert.equal(
    /\^\\s\*\\\//u.test(mentionState),
    false,
    "the picker is no longer anchored to the start of the message",
  );
  // Completing the command keeps whatever was already written before it —
  // the capture is put back, so the picker no longer eats the sentence.
  const pick = chats.slice(
    chats.indexOf("export function pickSlashCommand"),
    chats.indexOf("export function pickMention"),
  );
  assert.match(pick, /`\$1\/\$\{name\} `/u);
});
