import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { StaticAsset } from "@coord/api-gateway";

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

test("every dashboard file also has a name that carries its own digest", async () => {
  const assets = await loadStaticAssets();
  // A stable name costs a phone one revalidation round trip per file on every
  // launch, because the name says nothing about which build it holds. A name
  // with a digest in it can be promised never to change, which is what turns a
  // repeat launch into zero requests.
  const digested = [...assets.keys()].filter((url) =>
    /^\/[a-z-]+\.[0-9a-f]{12}\.(?:js|css)$/u.test(url),
  );
  for (const name of ["app", "data", "ui", "screen-chats", "boot-plan"]) {
    assert.equal(
      digested.some((url) => url.startsWith(`/${name}.`)),
      true,
      `${name}.js should have a digested name`,
    );
  }
  assert.equal(
    digested.some((url) => url.startsWith("/styles.")),
    true,
    "the stylesheet should have a digested name",
  );
  for (const url of digested) {
    assert.equal(
      assets.get(url)?.immutable,
      true,
      `${url} should be cacheable forever`,
    );
  }
});

test("index.html names the digested build and is itself never cached", async () => {
  const assets = await loadStaticAssets();
  const html = assets.get("/index.html")?.body.toString("utf8") ?? "";
  // The document is the one file that still revalidates on every launch, and
  // it is what names which build the rest of the launch loads. That is the
  // whole of the old-client guarantee: a phone can hold the digested files
  // forever precisely because it re-reads this one.
  assert.equal(assets.get("/index.html")?.immutable, undefined);
  assert.equal(/src="\/app\.[0-9a-f]{12}\.js"/u.test(html), true);
  assert.equal(/href="\/styles\.[0-9a-f]{12}\.css"/u.test(html), true);
  assert.equal(html.includes('src="/app.js"'), false);
  assert.equal(html.includes('href="/styles.css"'), false);
});

test("a digested module imports its dependencies by their digested names", async () => {
  const assets = await loadStaticAssets();
  const app = [...assets.keys()].find((url) =>
    /^\/app\.[0-9a-f]{12}\.js$/u.test(url),
  );
  assert.ok(app, "app.js should be served under a digested name");
  const source = assets.get(app)?.body.toString("utf8") ?? "";
  // A module cached forever must never be able to reach a URL that has since
  // stopped existing, so its imports carry digests too — and they are the same
  // digest, because the modules import each other cyclically and are renamed
  // as one graph.
  const digest = /^\/app\.([0-9a-f]{12})\.js$/u.exec(app)?.[1];
  assert.equal(source.includes(`from "./data.${digest}.js"`), true);
  assert.equal(source.includes('from "./data.js"'), false);
  assert.equal(assets.get(`/data.${digest}.js`) !== undefined, true);
});

test("changing one module renames the whole graph", async (t) => {
  const original = await loadStaticAssets();
  const digestOfApp = (assets: ReadonlyMap<string, StaticAsset>): string =>
    /^\/app\.([0-9a-f]{12})\.js$/u.exec(
      [...assets.keys()].find((url) => /^\/app\.[0-9a-f]{12}\.js$/u.test(url)) ??
        "",
    )?.[1] ?? "";

  // A second copy of the public directory with one module edited: the digest
  // has to move, or a phone told to cache forever would keep serving the old
  // bytes after a deploy.
  const scratch = await mkdtemp(path.join(tmpdir(), "coord-assets-"));
  t.after(async () => {
    await rm(scratch, { recursive: true, force: true });
  });
  await cp(path.join(packageRoot, "public"), scratch, { recursive: true });
  await writeFile(
    path.join(scratch, "boot-plan.js"),
    `${await readFile(path.join(scratch, "boot-plan.js"), "utf8")}\n// edited\n`,
  );
  const edited = await loadStaticAssets(scratch, false, false);

  assert.notEqual(digestOfApp(original), "");
  assert.notEqual(digestOfApp(original), digestOfApp(edited));
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
  const app = await publicFile("app.js");
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

  // The account is the sole footer action. Its existing menu is the route to
  // Settings, so the sidebar does not duplicate that destination with a gear.
  assert.match(sidebar, /class="chan-sidebar-foot"/u);
  assert.doesNotMatch(
    sidebar,
    /class="chan-foot-action" data-act="nav"\s*data-value="settings"/u,
  );
  assert.match(sidebar, /class="chan-account" data-act="user-menu"/u);
  assert.match(
    app,
    /case "user-menu":[\s\S]{0,180}value: "settings", label: "Settings"/u,
  );
  assert.match(sidebar, /section\("People", "invite-repo"/u);
  assert.doesNotMatch(
    sidebar,
    />Profile<\/span>/u,
    "the account action should not repeat its destination as a subtitle",
  );

  // Compact means narrow, never absent. The logo fades out, the collapse
  // control remains in the crown, and the account avatar stays at the foot.
  assert.match(
    css,
    /\.chats-shell\.chan-collapsed > \.chan-sidebar \{\s*width: 64px;/u,
  );
  assert.doesNotMatch(
    css,
    /\.chats-shell\.chan-collapsed > \.chan-sidebar \{[^}]*display: none;/u,
  );
  assert.match(css, /\.chats-shell\.chan-collapsed \.chan-row \{/u);
  assert.match(css, /\.chan-row\.active::before \{/u);
  assert.match(
    css,
    /\.chats-shell\.chan-collapsed \.chan-brand \{[\s\S]{0,260}opacity: 0;[\s\S]{0,80}visibility: hidden;/u,
  );
  assert.match(css, /\.chan-collapse-btn \{\s*flex: none;\s*margin-left: auto;/u);
  const sidebarRule = /\.chan-sidebar \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(sidebarRule, undefined, "the sidebar has a base layout rule");
  assert.match(sidebarRule ?? "", /transition: width 0\.18s cubic-bezier/u);
  assert.match(
    css,
    /grid-template-rows: auto auto minmax\(0, 1fr\) auto;/u,
  );

  // Changing the class on the existing shell gives the width transition an
  // actual before/after. Persistence and accessible state still update, but
  // this action must not replace the app with render().
  const collapseAction = app.slice(
    app.indexOf('case "chan-collapse-toggle"'),
    app.indexOf('case "chan-sidebar-close"'),
  );
  assert.match(collapseAction, /classList\.toggle\(\s*"chan-collapsed"/u);
  assert.match(collapseAction, /persist\("ag\.chanCollapsed"/u);
  assert.match(collapseAction, /setAttribute\("aria-pressed"/u);
  assert.doesNotMatch(collapseAction, /\brender\(\)/u);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,180}transition-duration: 0\.01ms !important;/u,
  );
});

test("people and agents only animate downward when the sidebar expands", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");

  // Each list is a clipping box around one block. Without the inner block
  // there is no height for the row to shrink away from, and the fold becomes
  // the cut it used to be.
  assert.match(chats, /class="chan-roster chan-roster-people"/u);
  assert.match(chats, /class="chan-roster chan-roster-agents"/u);
  assert.match(chats, /class="chan-roster-inner"/u);
  assert.match(chats, /section\("People",[^)]*"chan-sec-people"\)/u);
  assert.match(chats, /section\("Agents",[^)]*"chan-sec-agents"\)/u);

  // Folded, not switched off: the collapsed rail must no longer name the two
  // lists in its `display: none` set, and must give them somewhere to travel.
  const railRules = css.slice(css.indexOf(".chats-shell.chan-collapsed :is("));
  assert.doesNotMatch(
    railRules.slice(0, railRules.indexOf("display: none;")),
    /\.chan-roster,/u,
  );
  assert.match(
    css,
    /\.chats-shell\.chan-collapsed \.chan-roster \{\s*grid-template-rows: 0fr;/u,
  );
  assert.match(
    css,
    /\.chats-shell\.chan-collapsed :is\(\.chan-sec-people, \.chan-sec-agents\),[\s\S]{0,120}transform: translateY\(-10px\);/u,
  );
  assert.match(css, /\.chan-roster \{[\s\S]{0,320}grid-template-rows 0\.22s/u);

  // The lists stagger on the way down, but closing suppresses their transitions
  // so people and agents do not visibly slide upward into the channels.
  assert.match(css, /\.chan-roster-agents \{\s*transition-delay: 0\.09s;/u);
  assert.match(
    css,
    /\.chats-shell\.chan-collapsed \.chan-sec-people \{\s*transition-delay: 0\.09s/u,
  );
  assert.match(
    css,
    /\.chats-shell\.chan-folding\.chan-collapsed :is\([\s\S]{0,160}\.chan-roster[\s\S]{0,80}transition: none;/u,
  );

  // Clipping only while the fold runs. An agent's usage card hangs below its
  // row, so a list that clipped at rest would swallow it.
  assert.match(
    css,
    /\.chats-shell\.chan-folding \.chan-roster,[\s\S]{0,80}overflow: hidden;/u,
  );
  const collapseAction = app.slice(
    app.indexOf('case "chan-collapse-toggle"'),
    app.indexOf('case "chan-sidebar-close"'),
  );
  assert.match(collapseAction, /markChanFolding\(shell\)/u);
  assert.match(app, /function markChanFolding\(/u);
  assert.match(app, /classList\.remove\("chan-folding"\)/u);
});

test("the pink tools toggle animates without replacing its node", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  const action = app.slice(
    app.indexOf('case "chan-tools-toggle"'),
    app.indexOf('case "preview-start"'),
  );

  assert.match(
    chats,
    /class="icon-btn chan-tools-toggle\$\{[\s\S]{0,100}state\.chanToolsOpen === true \? " on" : ""/u,
  );
  assert.match(
    css,
    /\.icon-btn \{[\s\S]{0,260}transition: background 0\.15s ease, color 0\.15s ease;/u,
  );
  assert.match(
    css,
    /\.icon-btn\.on \{\s*background: var\(--accent-wash\);\s*color: var\(--accent-bright\);/u,
  );
  assert.match(
    css,
    /\.chan-tools-toggle svg \{\s*transition: transform 0\.15s ease;/u,
  );
  assert.match(
    css,
    /\.chan-tools-toggle\.on svg \{\s*transform: rotate\(-90deg\);/u,
  );

  // The header itself must redraw because opening the fold adds its tools.
  // Reattaching the clicked button in its old state before applying `on`
  // gives both the pink treatment and the arrow a real before/after to tween.
  assert.match(action, /const toggle = node;/u);
  assert.match(action, /state\.chanToolsOpen = open;[\s\S]*?\brender\(\);/u);
  assert.match(action, /replacement\.replaceWith\(toggle\);/u);
  assert.match(action, /void toggle\.offsetWidth;/u);
  assert.match(action, /toggle\.classList\.toggle\("on", open\);/u);
  assert.match(action, /toggle\.setAttribute\("aria-expanded", String\(open\)\);/u);
  assert.match(
    action,
    /toggle\.setAttribute\("title", open \? "Hide tools" : "Show tools"\);/u,
  );
});

test("the header tools come out of the arrow and fold back into it", async () => {
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");

  // A screen is one `innerHTML` assignment, so the tray is a new element on
  // every render and a bare CSS animation would replay the reveal whenever
  // anything redrew. It joins the surfaces the render loop decides for.
  const surfaces = app.slice(
    app.indexOf("const MOTION_SURFACES = ["),
    app.indexOf("/** Whether each surface was on screen"),
  );
  assert.match(
    surfaces,
    /selector: "\.chan-tools",\s*parent: "\.chan-head",\s*enter: "tools-entering",\s*leave: "tools-leaving",/u,
  );

  // A tray on its way out has to go back beside the arrow it is retreating
  // into, not appended past it on the far side.
  assert.match(surfaces, /place: \(parent, node\) => \{[\s\S]{0,200}toggle\.before\(node\);/u);
  const play = app.slice(
    app.indexOf("function playSurfaceMotion"),
    app.indexOf("function animateOnce"),
  );
  assert.match(
    play,
    /if \(surface\.place === undefined\) \{\s*parent\.append\(closed\);\s*\} else \{\s*surface\.place\(parent, closed\);/u,
  );

  // Out of the arrow rather than in place: each icon starts the distance it
  // sits from the arrow away from itself, and the row is staggered so it
  // unfolds from that one point.
  assert.match(
    css,
    /\.chan-tools\.tools-entering > \* \{\s*--tool-shift: 42px;\s*animation: chan-tool-out/u,
  );
  assert.match(
    css,
    /\.chan-tools\.tools-entering > \*:nth-last-child\(2\) \{\s*--tool-shift: 74px;\s*animation-delay: 0\.03s;/u,
  );
  assert.match(
    css,
    /\.chan-tools\.tools-leaving > \*:nth-child\(2\) \{\s*animation-delay: 0\.03s;/u,
  );
  assert.match(
    css,
    /@keyframes chan-tool-out \{\s*from \{[\s\S]{0,120}transform: translateX\(var\(--tool-shift\)\) scale\(0\.6\);/u,
  );
  assert.match(
    css,
    /@keyframes chan-tool-in \{\s*to \{[\s\S]{0,120}transform: translateX\(var\(--tool-shift\)\) scale\(0\.6\);/u,
  );

  // The stagger has to finish inside the fallback timer that drops a closing
  // surface, or the tray outlives its own exit.
  assert.match(css, /animation: chan-tool-in 0\.18s/u);
  assert.match(css, /\.chan-tools\.tools-leaving > \*:nth-child\(n \+ 5\) \{\s*animation-delay: 0\.12s;/u);

  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.chan-tools\.tools-entering > \* \{\s*animation: none;\s*\}[\s\S]{0,320}\.chan-tools\.tools-leaving \{\s*display: none;/u,
  );
});

test("the phone drawer is dragged out under the finger, not toggled", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // The drag tracks: a move sets how far out the drawer is, the stylesheet
  // reads that number, and the transition is off while the finger is down so
  // the panel is where the hand is rather than easing toward it.
  const move = app.slice(
    app.indexOf('"touchmove",', app.indexOf("function endDrawerDrag")),
    app.indexOf('"touchcancel",'),
  );
  assert.notEqual(move, "", "the drawer has a touchmove handler");
  assert.match(move, /setProperty\("--chan-drawer-x", `\$\{drag\.offset\}px`\)/u);
  assert.match(move, /setProperty\(\s*"--chan-drawer-p",/u);
  assert.match(move, /classList\.add\("chan-dragging"\)/u);
  assert.match(
    css,
    /\.chats-shell\.chan-dragging \.chan-sidebar \{\s*transform: translateX\(calc\(-100% \+ var\(--chan-drawer-x, 0px\)\)\);\s*transition: none;/u,
  );
  assert.match(
    css,
    /\.chats-shell\.chan-dragging \.chan-sidebar-scrim \{\s*opacity: var\(--chan-drawer-p, 0\);/u,
  );

  // Non-passive, because a drawer moving with the finger cannot have the
  // transcript scrolling underneath it — but only once the gesture is the
  // drawer's, which is what the slop decides.
  assert.match(move, /\{ passive: false \}/u);
  assert.match(move, /event\.preventDefault\(\)/u);
  assert.match(move, /Math\.abs\(dx\) <= Math\.abs\(dy\)/u);

  // Letting go hands the rest of the distance back to CSS: the modifier comes
  // off, which restores both the transition and the class's own transform, and
  // the drawer finishes from wherever it was. A render here would replace the
  // shell and leave the new element nothing to animate from.
  const settle = app.slice(
    app.indexOf("function endDrawerDrag"),
    app.indexOf('"touchstart",'),
  );
  assert.match(settle, /classList\.remove\("chan-dragging"\)/u);
  assert.match(settle, /removeProperty\("--chan-drawer-x"\)/u);
  assert.match(settle, /setChanDrawer\(open\)/u);
  assert.doesNotMatch(settle, /\brender\(\)/u);
  const setter = app.slice(
    app.indexOf("function setChanDrawer"),
    app.indexOf("function closeSidePanel"),
  );
  assert.match(setter, /classList\.toggle\("roster-open", next\)/u);
  assert.doesNotMatch(setter, /\brender\(\)/u);
  assert.match(
    css,
    /\.chan-sidebar \{[^}]*transition: transform 0\.28s cubic-bezier\(0\.32, 0\.72, 0, 1\);/u,
  );

  // The button is not the only route any more, and equally is not gone: a
  // gesture leaves nothing on screen, so it cannot be the sole way to a
  // surface. Both now go through the same non-rendering setter.
  assert.match(chats, /class="icon-btn chan-sidebar-btn" data-act="chan-sidebar-toggle"/u);
  assert.match(chats, /aria-expanded="\$\{state\.chanSidebarOpen === true\}"/u);
  assert.match(
    app,
    /case "chan-sidebar-toggle":\s*setChanDrawer\(state\.chanSidebarOpen !== true\);/u,
  );
  assert.match(app, /case "chan-sidebar-close":\s*setChanDrawer\(false\);/u);

  // The scrim is always in the markup — a drawer a third of the way out wants
  // a scrim a third of the way dark, which an element that only exists once it
  // is fully open cannot be. Transparent and untouchable until then.
  assert.match(
    chats,
    /`<div class="chan-sidebar-scrim" data-act="chan-sidebar-close"><\/div>`\s*\}/u,
  );
  assert.doesNotMatch(
    chats,
    /state\.chanSidebarOpen === true\s*\?\s*`<div class="chan-sidebar-scrim"/u,
  );
  assert.match(
    css,
    /\.chan-sidebar-scrim \{[^}]*opacity: 0;[^}]*pointer-events: none;/u,
  );
  assert.match(
    css,
    /\.chats-shell\.roster-open \.chan-sidebar-scrim \{\s*opacity: 1;\s*pointer-events: auto;/u,
  );
});

test("the phone drawer closes when a sidebar destination opens", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const action = (start: string, end: string) =>
    app.slice(app.indexOf(`case "${start}"`), app.indexOf(`case "${end}"`));

  // A channel already owns this behaviour in its screen helper. Keep that
  // route as the reference while the other destinations use the drawer's
  // shared setter before their render replaces the shell.
  assert.match(action("channel-open", "composer-plus"), /openChannel\(value, render\)/u);
  const channel = chats.slice(
    chats.indexOf("export function openChannel"),
    chats.indexOf("export function submitComposerMessage"),
  );
  assert.match(channel, /state\.chanSidebarOpen = false;[\s\S]*?rerender\(\);/u);

  const dm = action("dm-open", "mention-agents-insert");
  assert.match(dm, /state\.dmReplyMessageId = undefined;\s*setChanDrawer\(false\);\s*render\(\);/u);
  assert.match(
    action("agent-chat-open", "summary-toggle"),
    /setChanDrawer\(false\);\s*render\(\);/u,
  );
  assert.match(
    action("agent-panel-open", "agent-panel-tab"),
    /setChanDrawer\(false\);\s*render\(\);/u,
  );
});

test("a reply carries a quiet visual path back to its root", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  const rendererStart = chats.indexOf("function threadReplies");
  const rendererEnd = chats.indexOf("\n/**\n * How much summary", rendererStart);
  const renderer = chats.slice(rendererStart, rendererEnd);

  assert.match(
    chats,
    /channelThread \? " cmsg-threaded" : ""/u,
    "only channel roots with replies should grow a branch",
  );
  assert.match(
    chats,
    /channelThread\s*\? threadSummaryLink\(entry, replies, repositoryId, progress\)\s*: changedBlock/u,
    "the open thread root should not repeat the channel's reply link",
  );
  assert.match(
    chats,
    /channelThread \? `<div class="cmsg-thread-route">` : ""/u,
    "the route should wrap the message through its thread link",
  );
  assert.match(
    chats,
    /channelThread \? `<\/div>\$\{changedBlock\}` : ""/u,
    "the changed files should sit after the route endpoint",
  );
  assert.match(renderer, /class="thread-replies"/u);
  assert.match(renderer, /class="thread-replies-head"/u);
  assert.match(renderer, /class="thread-replies-flow"/u);
  const channelStem =
    /\n\.cmsg-row\.cmsg-thread-path-through::before \{([\s\S]*?)\n\}/u.exec(
      css,
    )?.[1];
  const channelEnd =
    /\n\.cmsg-row\.cmsg-thread-path-end \.cmsg-thread-route::before \{([\s\S]*?)\n\}/u.exec(
      css,
    )?.[1];
  const channelElbow =
    /\n\.cmsg-row\.cmsg-threaded \.cmsg-thread-link::before \{([\s\S]*?)\n\}/u.exec(
      css,
    )?.[1];
  const panelBranch = /\n\.thread-root\.has-replies::after \{([\s\S]*?)\n\}/u.exec(
    css,
  )?.[1];
  assert.notEqual(channelStem, undefined, "the shared channel stem should exist");
  assert.notEqual(channelEnd, undefined, "the channel stem should end at its route");
  assert.notEqual(channelElbow, undefined, "each thread should branch from the stem");
  assert.notEqual(panelBranch, undefined, "the open thread branch should exist");
  for (const branch of [channelElbow, panelBranch]) {
    assert.match(branch ?? "", /border-left: 3px solid var\(--border-strong\);/u);
    assert.match(branch ?? "", /border-bottom: 3px solid var\(--border-strong\);/u);
    assert.match(branch ?? "", /border-bottom-right-radius: 2px;/u);
    assert.match(branch ?? "", /border-bottom-left-radius: 11px;/u);
  }
  assert.match(channelStem ?? "", /top: -1px;/u);
  assert.match(channelStem ?? "", /bottom: -1px;/u);
  assert.match(channelEnd ?? "", /bottom: 23px;/u);
  // Written from the column variables rather than as the 13px they work out
  // to, which is what keeps the stem, the elbow and the final segment from
  // drifting apart when any of those three numbers moves.
  assert.match(
    channelElbow ?? "",
    /right: calc\(100% \+ var\(--cmsg-body-x\) - var\(--cmsg-stem-x\) - 16px\);/u,
  );
  // The elbow turns out of the stem, so its own upright has to stand in the
  // stem's column. It is placed from its right edge, which means the gap plus
  // its width must land on the stem's offset — and it must be measured by the
  // border box, or the three-pixel stroke hangs outside that width and the
  // turn steps sideways where it should read as one line.
  assert.match(channelElbow ?? "", /box-sizing: border-box;/u);
  const stemLeft = Number(/left: (-?\d+)px;/u.exec(channelEnd ?? "")?.[1]);
  const elbowGap = Number(
    /right: calc\(100% \+ (\d+)px\);/u.exec(channelElbow ?? "")?.[1],
  );
  const elbowWidth = Number(/width: (\d+)px;/u.exec(channelElbow ?? "")?.[1]);
  assert.equal(
    elbowGap + elbowWidth,
    -stemLeft,
    "the elbow's upright should sit in the stem's own column",
  );
  // And it has to stop *inside* that upright. The route's foot sits fourteen
  // pixels below the middle of the link, so `bottom` minus fourteen is how far
  // above that middle the stem ends; the elbow's upright runs straight from
  // its own top down to where the corner's arc begins, and an end below the
  // arc leaves a tail poking past the swoosh while an end above the upright
  // breaks the line in two.
  const stemEnd = Number(/bottom: (\d+)px;/u.exec(channelEnd ?? "")?.[1]) - 14;
  const elbowTop = Number(
    /top: calc\(50% - (\d+)px\);/u.exec(channelElbow ?? "")?.[1],
  );
  const elbowHeight = Number(/height: (\d+)px;/u.exec(channelElbow ?? "")?.[1]);
  const arcStart = 11 - (elbowHeight - elbowTop);
  assert.ok(
    stemEnd >= arcStart && stemEnd <= elbowTop,
    `the stem should end within the elbow's straight upright (${arcStart}..${elbowTop}), not at ${stemEnd}`,
  );
  assert.equal(
    elbowHeight - elbowTop,
    3,
    "the elbow's horizontal run should stay three pixels below the link's middle",
  );
  assert.doesNotMatch(css, /\.cmsg-row\.cmsg-threaded::before/u);
  assert.match(panelBranch ?? "", /left: 15px;/u);
  assert.match(panelBranch ?? "", /width: 11px;/u);
  assert.match(css, /\.thread-replies-head::after \{/u);
});

test("user-rooted tasks promote when their first reply arrives", async () => {
  const chats = await publicFile("screen-chats.js");
  const row = chats.slice(
    chats.indexOf("function messageRow("),
    chats.indexOf("function typingIndicator("),
  );
  const list = chats.slice(
    chats.indexOf("function messageList("),
    chats.indexOf("function isThreadEnding("),
  );
  const panel = chats.slice(
    chats.indexOf("function threadListPanel("),
    chats.indexOf("function threadPanel("),
  );
  const chip = chats.slice(
    chats.indexOf("function composerThreadChip("),
    chats.indexOf("export function submitThreadReply("),
  );

  assert.match(
    row,
    /entry\.kind !== "user" \|\|\s*entry\.taskId !== undefined/u,
  );
  assert.match(
    row,
    /inlineReply \|\| \(entry\.kind === "user" && !hasTaskThread\)/u,
    "a task stays inline until the agent acknowledges it",
  );
  assert.match(
    list,
    /entry\.taskId !== undefined &&\s*channelMessageHasTaskThread\(entry\)/u,
    "a promoted task keeps its replies out of the flat room timeline",
  );
  assert.match(
    panel,
    /entry\.kind !== "user" \|\| entry\.taskId !== undefined/u,
    "the thread list accepts new user roots and legacy agent roots",
  );
  assert.match(
    chip,
    /root\.kind === "user" && root\.taskId === undefined/u,
    "a user-rooted task remains a task when the channel composer continues it",
  );
});

test("a long thread name cannot push the panel's close out of reach", async () => {
  const css = await publicFile("styles.css");
  const chats = await publicFile("screen-chats.js");
  const head = /\n\.thread-head \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(head, undefined, "the shared panel header should exist");
  // The header is a row of `.thread-panel`'s grid and its title never wraps,
  // so without this the row's automatic minimum is the whole title and the
  // controls after it — including the close — leave the panel entirely.
  assert.match(head ?? "", /min-width: 0;/u);
  // And once the row is the panel's width, the tools hold their box rather
  // than shrinking under the name.
  assert.match(css, /\.thread-head \.icon-btn \{\s*flex: none;\s*\}/u);
  // The title is the one thing in the row that gives way, by ellipsis.
  const title = /\n\.thread-head \.thread-title \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(title ?? "", /min-width: 0;/u);
  assert.match(title ?? "", /overflow: hidden;/u);
  assert.match(title ?? "", /text-overflow: ellipsis;/u);
  // Every panel that names something shares the one header, so the fix is the
  // same fix for all of them.
  assert.ok(
    (chats.match(/<header class="thread-head">/gu) ?? []).length >= 5,
    "the panels should share one header",
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

/**
 * Browser sign-in stays the first offer, because it beats sending somebody to
 * find a secret. What changed is that it can no longer be the *only* offer:
 * Google withdrew the Gemini CLI's sign-in from personal accounts, so a
 * screen that only ever signed in left Gemini with no route at all — and
 * looped "Try again" on a refusal that retrying cannot fix.
 *
 * Nobody should still be asked for a copied `oauth_creds.json`: that is a
 * sign-in artefact, not something to go and find.
 */
test("agent settings sign in first, but can fall back to a credential", async () => {
  const source = await publicFile("screen-agents.js");
  assert.match(source, /window\.open\("", "_blank"\)/u);
  assert.match(source, /Code from that page/u);
  assert.match(source, /submitProviderSignInCode/u);
  assert.equal(source.includes("oauth_creds.json"), false);
  // Which providers take a pasted credential is the server's answer, not a
  // list here that goes stale when a vendor changes its mind.
  assert.match(source, /acceptedCredentialKinds/u);
  assert.equal(
    /\["google", "cursor", "copilot", "kiro"\]\.includes/u.test(source),
    false,
    "a hardcoded browser-only list cannot track a vendor withdrawing a flow",
  );
  // And the way out of a permanent refusal is offered on the failure itself.
  assert.match(source, /Use a credential instead/u);
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

test("agent news is one compact banner, not a stack of cards", async () => {
  const ui = await publicFile("ui.js");
  const css = await publicFile("styles.css");
  const start = ui.indexOf("export function banner");
  const end = ui.indexOf("\nexport function toast", start);
  assert.notEqual(start, -1, "the agent-news banner was not found");
  assert.notEqual(end, -1, "the toast function no longer follows the banner");
  const banner = ui.slice(start, end);

  // New news replaces the old line instead of building an alert stack, and
  // the only chrome left beside that line is its accessible dismiss button.
  assert.match(banner, /querySelectorAll\("\.toast\.banner"\)/u);
  assert.match(banner, /previous\.remove\(\)/u);
  assert.match(banner, /dismiss\.setAttribute\("aria-label", "Dismiss"\)/u);

  const bannerRule = /\.toast\.banner \{([\s\S]*?)\n\}/u.exec(css)?.[1] ?? "";
  assert.match(bannerRule, /max-width: min\(320px, calc\(100vw - 24px\)\)/u);
  // Restyled by request: the glow went, and the accent moved to a left edge
  // — the quiet "this is news" marker — instead of a border all round.
  assert.match(bannerRule, /border-left-color: var\(--accent\)/u);
  assert.doesNotMatch(bannerRule, /box-shadow/u);
  assert.match(bannerRule, /overflow-wrap: anywhere/u);
  assert.match(bannerRule, /animation: none/u);
  assert.equal(/accent-line/u.test(bannerRule), false, "news should not look selected");

  const exitRule = /\.toast\.banner\.banner-out \{([\s\S]*?)\n\}/u.exec(css)?.[1] ?? "";
  assert.match(exitRule, /opacity: 0/u);
  assert.equal(/transform/u.test(exitRule), false, "dismissal should not move the banner");

  assert.match(
    css,
    /@media \(max-width: 600px\)[\s\S]*?\.toast\.banner \{\s*width: calc\(100vw - 24px\);/u,
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.toast\.banner \{\s*transition: none;/u,
  );
});

/**
 * The bug: two people each with a Codex connected opened two agent panels and
 * saw one identical history, down to the timestamp — and the news banner named
 * whichever of them the roster happened to list first.
 *
 * The cause is that `task.agentId` is the *vendor* CLI. Every Codex in the
 * deployment submits under the same configured agent id, so a filter written
 * as `agentId.includes("codex")` selects every Codex task there has ever been.
 * The owner is the half that separates them, and the task already carries it
 * as `submittedBy`.
 */
test("one agent's work is not every agent of that vendor's work", async () => {
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");

  // Both halves in one place, so the panel, the banner and the dot cannot
  // drift into three different answers about who did what.
  assert.match(data, /export function taskBelongsToAgent\(task, agent\)/u);
  assert.match(data, /String\(task\.agentId \?\? ""\)\.toLowerCase\(\)\.includes\(vendor\)/u);
  assert.match(
    data,
    /task\.submittedBy === undefined \|\| task\.submittedBy === agentOwnerId\(agent\)/u,
  );
  // A bare provider id is `myAgents`'s shape and means this account — the
  // same rule `normalizeChannelAgentId` applies server-side.
  assert.match(
    data,
    /id\.includes\(":"\) \? id\.slice\(0, id\.indexOf\(":"\)\) : currentUserId\(\)/u,
  );

  // Every caller goes through it. A surviving bare vendor comparison is the
  // bug coming back on whichever surface kept it.
  assert.match(chats, /taskBelongsToAgent\(task, agent\)/u);
  assert.equal(
    /includes\(vendor\)/u.test(chats),
    false,
    "the agent history should not match on the vendor alone",
  );
  assert.equal(
    /VENDOR_FOR_PROVIDER/u.test(chats),
    false,
    "the vendor map is an implementation detail of the matcher now",
  );

  // The banner picks out of a list holding every agent in the room, so an
  // unqualified `find` there is what named the wrong person's agent.
  const banner = data.slice(data.indexOf("export function bannerLineForAudit"));
  assert.match(
    banner.slice(0, banner.indexOf("\n}")),
    /channelAgentsFor\(repositoryId\)\.find\(\(agent\) =>\s*taskBelongsToAgent\(task, agent\),?\s*\)/u,
  );
});

test("the thinking indicator names the busy agent, not the first agent of its vendor", async () => {
  const data = await publicFile("data.js");
  const start = data.indexOf("export function agentsThinkingIn(repositoryId)");
  assert.notEqual(start, -1, "the thinking-agent selector should still exist");
  const body = data.slice(start, data.indexOf("\n}\n", start));

  // The busy frame carries both halves of the agent's identity. Accepting any
  // of the viewer's own agents after only the provider matched made their
  // Codex name win even when a teammate's Codex was the one actually running.
  assert.match(
    body,
    /\(candidate\.provider \?\? candidate\.id\) !== entry\.provider/u,
  );
  assert.match(body, /candidate\.userId === entry\.userId/u);
  assert.equal(
    /candidate\.mine === true\s*\?\s*true/u.test(body),
    false,
    "a same-provider agent from another owner must not claim the busy frame",
  );
});

test("a notification says which agent, not which vendor", async () => {
  const data = await publicFile("data.js");
  const screen = await publicFile("screen-notifications.js");
  // `agentId` is "codex" for everybody's Codex, so the chip labelled three
  // people's work identically. The roster resolves the (owner, vendor) pair
  // to the name the room has been using.
  assert.match(data, /function agentNameForTask\(task, rosters\)/u);
  assert.match(data, /agentName: agentNameForTask\(task, rosters\),/u);
  assert.match(screen, /String\(row\.agentName \?\? row\.agentId \?\? "task"\)/u);
  // `unreadCount` asks for this list on every render and `channelAgentsFor`
  // rebuilds a roster each call, so the lookup is memoised across the pass
  // rather than run once per notification.
  assert.match(data, /const rosters = new Map\(\);/u);
});

test("the working dot reads the task list for teammates too", async () => {
  const data = await publicFile("data.js");
  const start = data.indexOf("function agentIsWorking(agent, repositoryId)");
  assert.notEqual(start, -1, "the working check should still exist");
  const body = data.slice(start, data.indexOf("\n}\n", start));
  // The durable half used to be gated on `agent.mine` because the vendor
  // alone could not say whose Codex was running, so reading it for everybody
  // lit both agents on one person's task. With the owner checked, the gate is
  // what was costing a teammate's dot minutes of a long run.
  assert.match(body, /taskBelongsToAgent\(task, agent\)/u);
  assert.equal(
    /if \(agent\.mine === true\) \{/u.test(body),
    false,
    "the durable half no longer needs to exclude teammates",
  );
});

type LivenessTask = {
  id: string;
  repositoryId: string;
  status: string;
  agentId: string;
  submittedBy: string;
  submittedAt: string;
};

type LivenessModule = {
  state: {
    tasks: LivenessTask[];
    agentBusy: Record<string, { expiresAt: number; at: number }>;
  };
  agentStatus: (
    agent: { id: string; provider: string; userId: string; visibility: string },
    repositoryId: string,
  ) => string;
  noteAgentBusy: (frame: {
    repositoryId: string;
    userId: string;
    provider: string;
    taskId: string;
  }) => void;
  agentsThinkingIn: (repositoryId: string) => string[];
  threadIsWorking: (entry: { taskId: string }) => boolean;
};

/**
 * The liveness selectors, run rather than read.
 *
 * Whether an agent is working is arithmetic over the task list and the busy
 * table, and every way of asserting it by pattern has let the arithmetic be
 * wrong while the shape stayed right. `data.js` reads `window.localStorage`
 * as it loads, which is the whole of what it needs from a browser.
 */
async function liveness(): Promise<LivenessModule> {
  const scope = globalThis as unknown as { window?: unknown };
  scope.window ??= {
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  };
  return (await import(
    pathToFileURL(path.join(packageRoot, "public", "data.js")).href
  )) as LivenessModule;
}

const LIVENESS_AGENT = {
  id: "u1:openai",
  provider: "openai",
  userId: "u1",
  visibility: "org",
};

/** A task of `LIVENESS_AGENT`'s, as the tasks route actually reports one. */
function livenessTask(over: Partial<LivenessTask> = {}): LivenessTask {
  return {
    id: "task-1",
    repositoryId: "repo",
    status: "submitted",
    agentId: "codex",
    submittedBy: "u1",
    submittedAt: new Date().toISOString(),
    ...over,
  };
}

test("a task nobody has picked up stops reading as an agent working", async () => {
  const data = await liveness();
  data.state.agentBusy = {};

  // `submitted` is "queued, not started yet" in the server's own words. It
  // counts for the seconds before a worker claims it, because that is when
  // somebody is watching for the dots.
  data.state.tasks = [livenessTask()];
  assert.equal(data.agentStatus(LIVENESS_AGENT, "repo"), "working");

  // And stops counting once the queue plainly is not moving. This is the
  // state a run whose worker died lands in — lease expiry puts the task back
  // to `submitted` — so before this it was an agent shown as thinking, with
  // nothing behind it, for as long as the tab stayed open.
  data.state.tasks = [
    livenessTask({ submittedAt: new Date(Date.now() - 10 * 60_000).toISOString() }),
  ];
  assert.equal(data.agentStatus(LIVENESS_AGENT, "repo"), "idle");

  // A claimed task is a worker holding a heartbeat; nothing about it expires
  // on the clock here.
  data.state.tasks = [livenessTask({ status: "claimed" })];
  assert.equal(data.agentStatus(LIVENESS_AGENT, "repo"), "working");
  data.state.tasks = [livenessTask({ status: "integrated" })];
  assert.equal(data.agentStatus(LIVENESS_AGENT, "repo"), "idle");
});

test("a busy frame whose task never arrives is not ten minutes of dots", async () => {
  const data = await liveness();
  data.state.tasks = [];
  data.state.agentBusy = {};
  data.noteAgentBusy({
    repositoryId: "repo",
    userId: "u1",
    provider: "openai",
    taskId: "task-nobody-lists",
  });

  // The frame is the fastest signal there is, and until the task list has
  // caught up with it, it is the only one.
  assert.equal(data.agentStatus(LIVENESS_AGENT, "repo"), "working");
  assert.equal(data.agentsThinkingIn("repo").length, 1);
  assert.equal(data.threadIsWorking({ taskId: "task-nobody-lists" }), true);

  // The list is re-read within a second of any frame and every thirty seconds
  // besides, so an id it still does not know is not work in progress. It used
  // to hold every indicator up for the ten-minute backstop instead — the
  // longest an agent could claim to be busy having never started.
  const entry = data.state.agentBusy["task-nobody-lists"];
  assert.notEqual(entry, undefined, "the frame should have been recorded");
  if (entry !== undefined) {
    entry.at = Date.now() - 90_000;
  }
  assert.equal(data.agentStatus(LIVENESS_AGENT, "repo"), "idle");
  assert.equal(data.threadIsWorking({ taskId: "task-nobody-lists" }), false);
  assert.equal(data.agentsThinkingIn("repo").length, 0);
  assert.equal(
    Object.keys(data.state.agentBusy).length,
    0,
    "a lapsed frame should be swept, not merely ignored",
  );
});

test("a connected agent is not painted as a working one", async () => {
  const data = await publicFile("data.js");
  const chat = await publicFile("chat.js");
  const agents = await publicFile("screen-agents.js");

  // The roster route reports connections, not presence, so the browser used
  // to call every teammate's agent online — and online is what the face
  // breathes on. Connected is idle until something says otherwise.
  const roster = data.slice(data.indexOf("const others = roster"));
  assert.match(roster.slice(0, roster.indexOf("\n  });")), /presence: "idle",/u);
  assert.equal(
    /presence: "online",/u.test(roster.slice(0, roster.indexOf("\n  });"))),
    false,
    "presence must be derived, not asserted",
  );

  // Both places that write the word beside a dot must agree with it: green is
  // working, amber is connected and doing nothing.
  for (const [name, source] of [
    ["chat.js", chat],
    ["screen-agents.js", agents],
  ] as const) {
    assert.match(
      source,
      /agent\.presence === "idle"\s*\?\s*"orange"/u,
      `${name} should mark an idle agent amber, not green`,
    );
  }

  // And the count that opens the agents screen says what it counts.
  assert.match(agents, /label: "Connected agents",/u);
  assert.equal(
    /label: "Active agents",/u.test(agents),
    false,
    "a stored credential is not an active agent",
  );
});

test("an account's own agent is seen running at all", async () => {
  const data = await publicFile("data.js");
  const start = data.indexOf("export function myAgents()");
  const body = data.slice(start, data.indexOf("\n  return {", start));
  // `provider.adapter` is not a field the providers payload has, so this
  // compared a task's vendor id ("codex") against an account provider id
  // ("openai") — never equal, for any provider, so nothing was ever running.
  assert.equal(
    /provider\.adapter/u.test(body),
    false,
    "a provider id is not a vendor id; the matcher maps between them",
  );
  assert.match(body, /taskBelongsToAgent\(\s*task,/u);
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
  // The wordmark sits in the chat sidebar's crown, which is rendered by the
  // chats screen rather than the shell.
  assert.match(await publicFile("screen-chats.js"), /<b>Lattice<\/b>/u);
  assert.match(await publicFile("index.html"), /<title>Lattice<\/title>/u);
  for (const file of [
    "app.js",
    "screen-chats.js",
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

test("a first repository can be created or imported from GitHub", async () => {
  const chats = await publicFile("screen-chats.js");
  const repos = await publicFile("screen-repos.js");
  const app = await browserSource();

  const emptyStart = chats.indexOf("if (state.repositories.length === 0)");
  const emptyEnd = chats.indexOf(
    "\n  const repositoryId = activeChannelId()",
    emptyStart,
  );
  assert.notEqual(emptyStart, -1, "the zero-repository state should exist");
  assert.notEqual(
    emptyEnd,
    -1,
    "the zero-repository state should have a boundary",
  );
  const empty = chats.slice(emptyStart, emptyEnd);

  assert.match(empty, /data-act="repo-create"[\s\S]*Create new repository/u);
  assert.match(empty, /data-act="repo-connect"[\s\S]*Import from GitHub/u);
  assert.match(
    app,
    /case "repo-connect":\s*void connectRepository\(render\);/u,
  );

  const connectStart = repos.indexOf(
    "export async function connectRepository",
  );
  const connectEnd = repos.indexOf(
    "\nexport async function syncRepositoryFromGitHub",
    connectStart,
  );
  assert.notEqual(connectStart, -1, "the GitHub import handler should exist");
  assert.notEqual(
    connectEnd,
    -1,
    "the GitHub import handler should have a boundary",
  );
  const connect = repos.slice(connectStart, connectEnd);

  assert.match(connect, /title: "Import from GitHub"/u);
  assert.match(
    connect,
    /\/repositories\/github`,\s*\{\s*method: "POST"/u,
  );
  assert.doesNotMatch(
    connect,
    /\/repositories`,\s*\{\s*method: "POST"/u,
  );
});

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
  const start = chats.indexOf("function updateComposerPresentation");
  const end = chats.indexOf("\n/**\n * A keystroke", start);
  assert.notEqual(start, -1, "the shared composer painter should exist");
  assert.notEqual(end, -1, "the shared composer painter should have a boundary");
  const handler = chats.slice(start, end);

  assert.match(handler, /paintComposerSuggestions\(activeChannelId\(\)\)/u);
  assert.match(handler, /paintComposerMirror\(node\)/u);
  assert.equal(
    /\brerender\s*\(/u.test(handler),
    false,
    "filtering / and @ suggestions must not trigger a full-app render",
  );
});

test("composer keystrokes stay on their existing DOM nodes", async () => {
  const chats = await publicFile("screen-chats.js");
  const threadStart = chats.indexOf("export function updateThreadComposerInput");
  const threadEnd = chats.indexOf("\nfunction updateMentionState", threadStart);
  assert.notEqual(threadStart, -1, "the thread composer input handler should exist");
  assert.notEqual(threadEnd, -1, "the thread composer input handler should have a boundary");

  const threadHandler = chats.slice(threadStart, threadEnd);
  assert.match(threadHandler, /state\.threadDraft =/u);
  assert.doesNotMatch(
    threadHandler,
    /\b(?:render|rerender)\s*\(/u,
    "typing a thread reply must not rebuild the transcript",
  );

  const channelStart = chats.indexOf("export function updateComposerInput");
  const channelEnd = chats.indexOf("\nexport function pickSlashCommand", channelStart);
  assert.notEqual(channelStart, -1, "the channel composer input handler should exist");
  assert.notEqual(channelEnd, -1, "the channel composer input handler should have a boundary");
  assert.doesNotMatch(
    chats.slice(channelStart, channelEnd),
    /\b(?:render|rerender)\s*\(/u,
    "typing in the channel must only repaint the local composer",
  );
});

test("conversation restores cannot overrule a newer scroll", async () => {
  const app = await browserSource();
  const chats = await publicFile("screen-chats.js");
  const capture = chats.slice(
    chats.indexOf("export function captureChannelScroll"),
    chats.indexOf("\nexport function restoreChannelAnchor"),
  );
  const restore = chats.slice(
    chats.indexOf("export function restoreChannelScroll"),
    chats.indexOf("\nexport function openChannel"),
  );

  // A render snapshots whether this exact channel was at the bottom from the
  // live geometry. Relying on the previous scroll event leaves a race where a
  // wheel/touch move has happened but its event has not updated the old flag.
  assert.match(capture, /key: scroller\.dataset\.scrollKey/u);
  assert.match(
    capture,
    /scroller\.scrollHeight - scroller\.scrollTop - scroller\.clientHeight <=\s*FOLLOW_SLACK_PX/u,
  );
  assert.match(app, /restoreChannelScroll\(savedScroll\);/u);
  assert.match(restore, /entry\.key === list\.dataset\.scrollKey/u);

  // Every replaceable scroll surface carries an identity. A raw offset from
  // one thread, DM, file, or channel must never be restored into another one
  // merely because both nodes use `.thread-body`.
  for (const key of ["channel:", "thread:", "thread-list:", "dm:", "file:", "tree:"]) {
    assert.match(chats, new RegExp(`data-scroll-key="${key}`, "u"), `${key} has a scroll identity`);
  }
  assert.match(
    chats,
    /scroller\.dataset\.scrollKey !== entry\.key/u,
    "anchor restoration is scoped to the same surface",
  );

  // The next-frame settle belongs only to the node that scheduled it. An old
  // render must not query a replacement transcript and pull that one down.
  assert.match(restore, /settled === list && followingChannel/u);
  // On mobile a drag and a viewport resize may share one scroll event. User
  // intent turns following off before the resize branch can pin the bottom.
  assert.match(restore, /"wheel"[\s\S]*event\.deltaY < 0[\s\S]*followingChannel = false/u);
  assert.match(restore, /"touchmove"[\s\S]*y > touchStartY \+ 4[\s\S]*followingChannel = false/u);
});

test("composer refocus never moves the conversation", async () => {
  const app = await browserSource();
  const chats = await publicFile("screen-chats.js");
  const typeInto = app.slice(
    app.indexOf("function typeIntoComposer"),
    app.indexOf("\nfunction actionOf", app.indexOf("function typeIntoComposer")),
  );
  const pickers = chats.slice(
    chats.indexOf("export function pickSlashCommand"),
    chats.indexOf("\nexport function handleComposerKeydown"),
  );
  assert.match(typeInto, /focus\(\{ preventScroll: true \}\)/u);
  assert.equal(
    [...pickers.matchAll(/focus\(\{ preventScroll: true \}\)/gu)].length,
    2,
    "slash and mention insertion both restore the caret without scrolling",
  );
});

test("a composer refresh keeps rapid edits, whitespace, and the caret's value", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await browserSource();
  const start = chats.indexOf("const ATTACHMENT_PATTERN");
  const end = chats.indexOf("\nfunction draftAttachmentPreviews", start);
  assert.notEqual(start, -1, "the attachment suffix pattern should exist");
  assert.notEqual(end, -1, "draftText should have a testable boundary");

  const state: { chatDraft?: string } = {};
  const createDraftText = new Function(
    "state",
    `${chats.slice(start, end)}\nreturn draftText;`,
  );
  const draftText = createDraftText(state) as () => string;

  // Background channel, typing, and task frames rebuild the textarea from
  // this value. The last input event must therefore survive exactly; trimming
  // here used to make a just-typed Space disappear and move the restored
  // caret backward, which felt intermittent because it needed a frame to land.
  for (const value of [
    "rapid  letters backspace ",
    "two trailing spaces  ",
    "Shift+Enter keeps this line\n",
    "日本語の変換 ",
  ]) {
    state.chatDraft = value;
    assert.equal(draftText(), value, JSON.stringify(value));
  }

  // Attachment references remain outside the textarea. Only their structural
  // separator is removed; whitespace immediately before it is user input.
  const reference = "![diagram](attachment:0123456789abcdef0123456789abcdef.png)";
  state.chatDraft = `keep both spaces  \n${reference}\n`;
  assert.equal(draftText(), "keep both spaces  ");
  state.chatDraft = `keep the entered newline\n\n${reference}\n`;
  assert.equal(draftText(), "keep the entered newline\n");

  // The render path already captures and restores focus. Keeping the stored
  // value exact is what makes those saved offsets meaningful after a refresh.
  assert.match(app, /const focusedField = captureFocus\(\);/u);
  assert.match(app, /restoreFocus\(focusedField\);/u);
  const restoreStart = app.indexOf("function restoreFocus");
  const restoreEnd = app.indexOf("\nfunction confirmDiscardEdit", restoreStart);
  assert.match(
    app.slice(restoreStart, restoreEnd),
    /next\.setSelectionRange\(saved\.start, saved\.end\)/u,
  );
});

test("the composer keyboard leaves Space, Shift+Enter, and IME to native input", async () => {
  const chats = await publicFile("screen-chats.js");
  const start = chats.indexOf("export function handleComposerKeydown");
  assert.notEqual(start, -1, "the channel composer key handler should exist");
  const source = chats.slice(start).replace("export function", "function");
  const state = { slashActive: false, mentionActive: false };
  let submitted = 0;
  const createHandler = new Function(
    "state",
    "imeComposing",
    "channelSlashCandidates",
    "activeChannelId",
    "pickSlashCommand",
    "channelMentionCandidates",
    "pickMention",
    "submitComposerMessage",
    `${source}\nreturn handleComposerKeydown;`,
  );
  const handler = createHandler(
    state,
    (event: { isComposing?: boolean; keyCode?: number }) =>
      event.isComposing === true || event.keyCode === 229,
    () => [],
    () => "repository",
    () => undefined,
    () => [],
    () => undefined,
    () => {
      submitted += 1;
    },
  ) as (
    event: {
      key: string;
      shiftKey?: boolean;
      isComposing?: boolean;
      keyCode?: number;
      preventDefault: () => void;
    },
    rerender: () => void,
  ) => void;

  const press = (
    key: string,
    options: { shiftKey?: boolean; isComposing?: boolean } = {},
  ) => {
    let prevented = 0;
    handler(
      {
        key,
        ...options,
        preventDefault: () => {
          prevented += 1;
        },
      },
      () => undefined,
    );
    return prevented;
  };

  assert.equal(press(" "), 0, "Space stays a native textarea edit");
  assert.equal(press("Enter", { shiftKey: true }), 0, "Shift+Enter inserts a newline");
  assert.equal(
    press("Enter", { isComposing: true }),
    0,
    "composition Enter accepts the candidate",
  );
  assert.equal(submitted, 0);
  assert.equal(press("Enter"), 1, "plain Enter is the only send gesture here");
  assert.equal(submitted, 1);
});

test("thread composer suggestions navigate, dismiss, and insert into the thread draft", async () => {
  const chats = await publicFile("screen-chats.js");
  const pickStart = chats.indexOf("function composerTarget");
  const pickEnd = chats.indexOf("\nexport function handleComposerKeydown", pickStart);
  assert.notEqual(pickStart, -1, "the composer target resolver should exist");
  assert.notEqual(pickEnd, -1, "the picker helpers should have a boundary");

  const state: Record<string, unknown> = {
    chatDraft: "channel stays put",
    threadDraft: "ask @Mar",
  };
  const input = {
    selectionStart: 8,
    focus: () => undefined,
    setSelectionRange: () => undefined,
  };
  const createPickers = new Function(
    "state",
    "document",
    "draftText",
    `${chats
      .slice(pickStart, pickEnd)
      .replaceAll("export function", "function")}\nreturn { pickMention, pickSlashCommand };`,
  );
  const pickers = createPickers(
    state,
    { querySelector: () => input },
    (value: string) => value,
  ) as {
    pickMention: (name: string, rerender: () => void, target: string) => void;
    pickSlashCommand: (name: string, rerender: () => void, target: string) => void;
  };

  pickers.pickMention("Mary Jane", () => undefined, "thread");
  assert.equal(state.threadDraft, "ask @Mary Jane ");
  assert.equal(state.chatDraft, "channel stays put");
  state.threadDraft = "/pl";
  input.selectionStart = 3;
  pickers.pickSlashCommand("plan", () => undefined, "thread");
  assert.equal(state.threadDraft, "/plan ");
  assert.equal(state.chatDraft, "channel stays put");

  const handlerSource = chats
    .slice(chats.indexOf("export function handleComposerKeydown"))
    .replace("export function", "function");
  const picks: Array<[string, string]> = [];
  const createHandler = new Function(
    "state",
    "imeComposing",
    "channelSlashCandidates",
    "activeChannelId",
    "pickSlashCommand",
    "channelMentionCandidates",
    "pickMention",
    "submitThreadReply",
    "submitComposerMessage",
    `${handlerSource}\nreturn handleComposerKeydown;`,
  );
  const handler = createHandler(
    state,
    () => false,
    () => [{ name: "plan" }, { name: "review" }],
    () => "repository",
    (name: string, _rerender: () => void, target: string) => {
      picks.push([name, target]);
    },
    () => [{ name: "Mary Jane" }, { name: "Claude" }],
    (name: string, _rerender: () => void, target: string) => {
      picks.push([name, target]);
    },
    () => undefined,
    () => undefined,
  ) as (
    event: {
      key: string;
      target: { dataset: { act: string } };
      preventDefault: () => void;
    },
    rerender: () => void,
  ) => void;
  const press = (key: string) =>
    handler(
      {
        key,
        target: { dataset: { act: "channel-thread-input" } },
        preventDefault: () => undefined,
      },
      () => undefined,
    );

  Object.assign(state, {
    composerAutocompleteTarget: "thread",
    slashActive: true,
    slashIndex: 0,
    mentionActive: false,
  });
  press("ArrowDown");
  assert.equal(state.slashIndex, 1);
  press("Enter");
  assert.deepEqual(picks.pop(), ["review", "thread"]);
  press("Escape");
  assert.equal(state.slashActive, false);

  Object.assign(state, {
    mentionActive: true,
    mentionIndex: 0,
  });
  press("ArrowUp");
  assert.equal(state.mentionIndex, 1);
  press("Tab");
  assert.deepEqual(picks.pop(), ["Claude", "thread"]);
  press("Escape");
  assert.equal(state.mentionActive, false);
});

test("every message composer sends on Enter and opens a line on Shift+Enter", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");

  // The composers without suggestions keep their small native-submit blocks.
  for (const act of ["chat-input", "dm-input"]) {
    const start = app.indexOf(`if (node?.dataset?.act !== "${act}")`);
    assert.notEqual(start, -1, `${act} has an Enter handler`);
    const block = app.slice(start, app.indexOf("});", start));
    assert.match(
      block,
      /event\.key === "Enter" && !event\.shiftKey && !imeComposing\(event\)/u,
      `${act} sends on plain Enter only`,
    );
    assert.match(
      block,
      /event\.preventDefault\(\);\s*\n\s*node\.closest\("form"\)\?\.requestSubmit\(\)/u,
      `${act} submits its own form`,
    );
  }

  // Channel and thread Enter are steered by their @mention and slash pickers,
  // so both route through the shared handler rather than racing a second
  // plain-submit listener.
  assert.match(
    app,
    /event\.target\?\.dataset\?\.act === "channel-input" \|\|\s*event\.target\?\.dataset\?\.act === "channel-thread-input"[\s\S]{0,80}handleComposerKeydown\(event, render\)/u,
  );
  assert.match(chats, /if \(event\.key === "Enter" && !event\.shiftKey\) \{/u);
  assert.match(
    chats,
    /if \(target === "thread"\) \{\s*submitThreadReply\(rerender\);\s*\} else \{\s*submitComposerMessage\(rerender\);/u,
  );

  // Mobile keyboards need the hint to label the return key "send"; without it
  // the same Enter is offered as a newline before it is pressed.
  for (const act of ["channel-input", "dm-input", "channel-thread-input"]) {
    const textarea = chats.slice(
      chats.indexOf(`<textarea data-act="${act}"`),
      chats.indexOf("</textarea>", chats.indexOf(`<textarea data-act="${act}"`)),
    );
    assert.match(textarea, /enterkeyhint="send"/u, `${act} labels its return key`);
  }
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
  // The count delegates; the mention matching itself lives in the helper it
  // calls, so that is where the "only pings addressed to me" rule is pinned.
  const counting = data.slice(
    data.indexOf("function countChannelSince"),
    data.indexOf("\n}\n", data.indexOf("function countChannelSince")) + 2,
  );
  assert.match(counting, /mention\.kind === "user" && mention\.id === mine/u);
  assert.match(chats, /mentions > 0 \? "@"/u);
});

test("mention suggestions narrow agents and people by name or email", async () => {
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");
  const participantStart = data.indexOf("export function channelParticipants");
  const participantEnd = data.indexOf("\nfunction seedMessages", participantStart);
  assert.notEqual(participantStart, -1, "the participant resolver should exist");
  assert.notEqual(participantEnd, -1, "the participant resolver should have a boundary");

  const participantState = {
    channelPeople: {
      repo: [
        {
          userId: "mary",
          user: { displayName: "Mary Jane", email: "mary@example.com" },
        },
      ],
    },
    members: [],
  };
  const participants = new Function(
    "state",
    "channelAgentsFor",
    "currentUserId",
    "currentUserName",
    `${data
      .slice(participantStart, participantEnd)
      .replace("export function", "function")}\nreturn channelParticipants;`,
  )(
    participantState,
    () => [
      { id: "zeus", name: "Zeus" },
      { id: "athena", name: "Athena" },
    ],
    () => "current-user",
    () => "Current User",
  ) as (repositoryId: string) => Array<{
    id: string;
    name: string;
    email?: string;
    kind: string;
  }>;
  const roster = participants("repo");
  assert.equal(
    roster.find((entry) => entry.id === "mary")?.email,
    "mary@example.com",
    "a person's email remains available as a search term",
  );

  const candidateStart = chats.indexOf("function channelMentionCandidates");
  const candidateEnd = chats.indexOf("\n/**", candidateStart);
  assert.notEqual(candidateStart, -1, "the mention candidate filter should exist");
  assert.notEqual(candidateEnd, -1, "the mention candidate filter should have a boundary");
  const mentionState = { mentionQuery: "" };
  const candidates = new Function(
    "state",
    "channelParticipants",
    `${chats.slice(candidateStart, candidateEnd)}\nreturn channelMentionCandidates;`,
  )(mentionState, () => roster) as (repositoryId: string) => Array<{
    name: string;
    kind: string;
  }>;

  assert.deepEqual(
    candidates("repo").map((entry) => entry.name),
    ["agents", "everyone", "Zeus", "Athena", "Mary Jane"],
    "an empty @ keeps both agents and people visible",
  );

  mentionState.mentionQuery = "zeu";
  assert.deepEqual(
    candidates("repo").map((entry) => entry.name),
    ["Zeus"],
    "typing an agent name removes unrelated agents and people",
  );

  mentionState.mentionQuery = "jane";
  assert.deepEqual(
    candidates("repo").map((entry) => entry.name),
    ["Mary Jane"],
    "people remain searchable by display name",
  );

  mentionState.mentionQuery = "mary@";
  assert.deepEqual(
    candidates("repo").map((entry) => entry.name),
    ["Mary Jane"],
    "people remain searchable by email",
  );
});

test("@everyone is offered, highlighted, and pinged to every person in the room", async () => {
  const chats = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");
  const app = await browserSource();

  // Offered from the same "@" that reveals every other name, beside the
  // agent broadcast, and labelled so the two are told apart at a glance.
  const candidates = chats.slice(
    chats.indexOf("function channelMentionCandidates"),
    chats.indexOf("\nfunction ", chats.indexOf("function channelMentionCandidates") + 1),
  );
  assert.match(candidates, /name: "agents", kind: "broadcast"/u);
  assert.match(candidates, /name: "everyone", kind: "broadcast"/u);
  assert.match(candidates, /hint: "everyone here"/u);
  assert.match(chats, /entry\.hint \?\? "everyone"/u);

  // Coloured in a posted message and in the composer's mirror alike, without
  // waiting for a roster to carry a person called "everyone".
  const highlighted = [...chats.matchAll(/\[\s*\n\s*"agents",\s*\n\s*"everyone",/gu)];
  assert.equal(highlighted.length, 2, "both name lists carry the broadcasts");

  // The optimistic copy of a sent message names the same people the server
  // will, so the sender's own "@" badge does not flicker while it arrives.
  const send = data.slice(
    data.indexOf("export function sendChannelMessage"),
    data.indexOf("\n}\n", data.indexOf("export function sendChannelMessage")),
  );
  assert.match(send, /const everyone = \/@everyone\\b\/iu\.test\(trimmed\)/u);
  assert.match(send, /everyone && participant\.kind !== "agent"/u);

  // And the shortcut that writes the address into the composer handles it the
  // same way it handles "@agents".
  assert.match(app, /case "mention-everyone-insert":/u);
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
  assert.match(chats, /mentionActiveFor\("channel"\) \? " mention-active"/u);
  assert.match(
    chats,
    /classList\.toggle\("mention-active", mentionActiveFor\("channel"\)\)/u,
  );
  assert.match(css, /\.chan-composer-wrap\.mention-active::before/u);
  assert.match(css, /\.composer-attachment img/u);
});

test("the direct-message composer previews pasted images like the channel composer", async () => {
  const app = await browserSource();
  const chats = await publicFile("screen-chats.js");
  const dmStart = chats.indexOf("function dmPanel()");
  const dmEnd = chats.indexOf("\nfunction threadPanel", dmStart);
  const dmPanel = chats.slice(dmStart, dmEnd);
  const pasteStart = app.indexOf('document.addEventListener("paste"');
  const pasteEnd = app.indexOf('document.addEventListener("input"', pasteStart);
  const paste = app.slice(pasteStart, pasteEnd);
  const changeStart = app.indexOf('document.addEventListener("change"');
  const changeEnd = app.indexOf('document.addEventListener("paste"', changeStart);
  const change = app.slice(changeStart, changeEnd);

  assert.notEqual(dmStart, -1, "screen-chats.js declares the DM panel");
  assert.notEqual(dmEnd, -1, "the DM panel has a testable boundary");
  assert.match(dmPanel, /draftAttachmentPreviews\(repositoryId, \{/u);
  assert.match(dmPanel, /draft: state\.dmDraft/u);
  assert.match(dmPanel, /removeAct: "dm-attachment-remove"/u);
  assert.match(dmPanel, /data-act="dm-attach-input"/u);
  assert.match(dmPanel, /act: "dm-attach"/u);
  assert.match(change, /picker\?\.dataset\?\.act === "dm-attach-input"/u);
  assert.match(change, /picker\.dataset\.act === "dm-attach-input"/u);
  assert.match(paste, /act !== "dm-input"/u);
  assert.match(paste, /act === "dm-input"\s*\?\s*"dm"/u);
});

test("a direct message can send image-only and mixed text/image content", async () => {
  const app = await browserSource();
  const chats = await publicFile("screen-chats.js");
  const targetsStart = app.indexOf("const ATTACH_TARGETS");
  const targetsEnd = app.indexOf("\n};", targetsStart) + 3;
  const targets = app.slice(targetsStart, targetsEnd);
  const submitStart = app.indexOf('case "dm-submit"');
  const submitEnd = app.indexOf("\n    // Expanding a file", submitStart);
  const submit = app.slice(submitStart, submitEnd);
  const inputStart = app.indexOf('if (act === "dm-input")');
  const inputEnd = app.indexOf('if (act === "channel-thread-input")', inputStart);
  const input = app.slice(inputStart, inputEnd);
  const dmStart = chats.indexOf("function dmPanel()");
  const dmEnd = chats.indexOf("\nfunction threadPanel", dmStart);
  const dmPanel = chats.slice(dmStart, dmEnd);

  assert.match(
    targets,
    /dm: \{[\s\S]*draft: "dmDraft",[\s\S]*counter: "dmAttaching",[\s\S]*input: "dm-input"/u,
  );
  assert.match(dmPanel, /draftText\(state\.dmDraft\)/u);
  assert.match(dmPanel, /messageBody\([\s\S]{0,100}message\.content/u);
  assert.match(submit, /const draft = state\.dmDraft\.trim\(\)/u);
  assert.match(submit, /draft\.length === 0/u);
  assert.match(submit, /sendDirectMessage\(other, draft\)/u);
  assert.match(input, /const attachments = String\(state\.dmDraft/u);
  assert.match(input, /attachments\.join\("\\n"\)/u);
  assert.match(input, /state\.dmDraft = `\$\{node\.value\}/u);
});

test(
  "direct-message attachment removal and successful sends clear previews without leaking drafts between conversations",
  async () => {
    const app = await browserSource();
    const attachStart = app.indexOf("async function attachChannelImages");
    const attachEnd = app.indexOf(
      "\nasync function startPreviewAction",
      attachStart,
    );
    const attach = app.slice(attachStart, attachEnd);
    const removeStart = app.indexOf('case "channel-attachment-remove"');
    const removeEnd = app.indexOf('case "thread-attach"', removeStart);
    const remove = app.slice(removeStart, removeEnd);
    const submitStart = app.indexOf('case "dm-submit"');
    const submitEnd = app.indexOf("\n    // Expanding a file", submitStart);
    const submit = app.slice(submitStart, submitEnd);

    assert.match(remove, /case "dm-attachment-remove"/u);
    assert.match(remove, /ATTACH_TARGETS\.dm/u);
    assert.match(remove, /state\[where\.draft\]/u);
    assert.match(attach, /const dmUserId = target === "dm" \? state\.activeDm/u);
    assert.match(attach, /target === "dm" && state\.activeDm !== dmUserId/u);
    assert.match(submit, /state\.dmDraft = "";[\s\S]{0,80}render\(\)/u);
    assert.match(
      app,
      /case "dm-open":[\s\S]{0,120}state\.activeDm = value;[\s\S]{0,120}state\.dmDraft = "";/u,
    );
  },
);

test("thread composer paints pings and commands and opens their suggestion lists", async () => {
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  const panelStart = chats.indexOf("function threadPanel");
  const panelEnd = chats.indexOf("\n/**", panelStart);
  const panel = chats.slice(panelStart, panelEnd);

  assert.notEqual(panelStart, -1, "the thread panel should exist");
  assert.notEqual(panelEnd, -1, "the thread panel should have a boundary");
  assert.match(panel, /data-thread-composer-suggestions/u);
  assert.match(panel, /composerSuggestions\(repositoryId, "thread"\)/u);
  assert.match(panel, /class="composer-field"/u);
  assert.match(panel, /class="composer-mirror" data-composer-mirror/u);
  assert.match(
    panel,
    /composerMirror\(\s*draftText\(state\.threadDraft\),\s*channelParticipants\(repositoryId\)/u,
  );
  assert.match(data, /composerAutocompleteTarget: undefined/u);

  const threadInput = chats.slice(
    chats.indexOf("export function updateThreadComposerInput"),
    chats.indexOf("\nfunction updateMentionState", chats.indexOf("export function updateThreadComposerInput")),
  );
  assert.match(threadInput, /updateComposerPresentation\(node, "thread"\)/u);
  const mentionState = chats.slice(
    chats.indexOf("function updateMentionState"),
    chats.indexOf("\nexport function updateComposerInput"),
  );
  assert.match(mentionState, /state\.composerAutocompleteTarget = target/u);
  assert.match(mentionState, /state\.slashActive = slash !== null/u);
  assert.match(mentionState, /const match = \/\(\^\|\\s\)@/u);
  assert.match(mentionState, /state\.mentionActive = true/u);

  const suggestions = chats.slice(
    chats.indexOf("function composerSuggestions"),
    chats.indexOf("\nfunction mentionActiveFor"),
  );
  assert.match(suggestions, /state\.composerAutocompleteTarget !== target/u);
  assert.match(suggestions, /state\.slashActive[\s\S]*slashPopover/u);
  assert.match(suggestions, /state\.mentionActive[\s\S]*mentionPopover/u);

  assert.match(app, /case "thread-mention-pick"/u);
  assert.match(app, /pickMention\(value, render, "thread"\)/u);
  assert.match(app, /case "thread-slash-pick"/u);
  assert.match(app, /pickSlashCommand\(value, render, "thread"\)/u);
  assert.match(css, /\.thread-composer-wrap \{[\s\S]{0,80}position: relative/u);
  assert.match(css, /\.thread-composer-wrap \.mention-pop/u);
  assert.match(
    css,
    /\.composer-mirror \.mention-ping \{[\s\S]{0,160}color: var\(--accent-bright\);[\s\S]{0,160}background: var\(--accent-wash\)/u,
  );
  assert.match(
    css,
    /\.composer-mirror \.slash-ping \{[\s\S]{0,160}color: var\(--accent-2-bright\);[\s\S]{0,160}background: var\(--accent-2-wash\)/u,
  );
});

test("the thread slash picker surfaces its thread commands before the six-row limit", async () => {
  const chats = await publicFile("screen-chats.js");
  const start = chats.indexOf("function channelSlashCandidates");
  const end = chats.indexOf("\nfunction slashPopover", start);
  assert.notEqual(start, -1, "the slash candidate filter should exist");
  assert.notEqual(end, -1, "the slash candidate filter should have a boundary");

  const state = {
    slashQuery: "",
    channelSlashCommands: {
      repo: [
        "plan",
        "queue",
        "ask",
        "dnc",
        "simple",
        "push",
        "retry",
        "cancel",
        "stop",
        "help",
      ].map((name) => ({ name })),
    },
  };
  const candidates = new Function(
    "state",
    `${chats.slice(start, end)}\nreturn channelSlashCandidates;`,
  )(state) as (repositoryId: string, target?: string) => Array<{ name: string }>;

  assert.deepEqual(
    candidates("repo").map((entry) => entry.name),
    ["plan", "queue", "ask", "dnc", "simple", "push"],
    "the channel keeps the server's general command order",
  );
  assert.deepEqual(
    candidates("repo", "thread").map((entry) => entry.name),
    ["retry", "cancel", "push", "ask", "dnc", "simple"],
    "thread actions remain visible instead of being truncated",
  );

  state.slashQuery = "pl";
  assert.deepEqual(
    candidates("repo", "thread").map((entry) => entry.name),
    ["plan"],
    "typing a specific command still finds commands outside the first six",
  );

  const suggestions = chats.slice(
    chats.indexOf("function composerSuggestions"),
    chats.indexOf("\nfunction mentionActiveFor"),
  );
  assert.match(
    suggestions,
    /channelSlashCandidates\(repositoryId, target\)/u,
    "the rendered picker asks for the order of its own composer",
  );
  const keys = chats.slice(chats.indexOf("export function handleComposerKeydown"));
  assert.match(
    keys,
    /channelSlashCandidates\(activeChannelId\(\), target\)/u,
    "keyboard selection uses the same contextual order as the visible list",
  );
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

test("channel messages compact only an uninterrupted run from one person", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  const start = chats.indexOf("function continuesUserMessageGroup");
  const end = chats.indexOf("\n/**\n * The three dots", start);
  assert.notEqual(start, -1, "screen-chats.js declares the grouping rule");
  assert.notEqual(end, -1, "the grouping rule has a testable boundary");
  const createGroupingRule = new Function(
    `${chats.slice(start, end)}\nreturn continuesUserMessageGroup;`,
  );
  const continues = createGroupingRule() as (
    previous: unknown,
    current: unknown,
    startsNewDay: boolean,
  ) => boolean;
  const item = (
    authorId: string,
    options: { kind?: string; reply?: boolean } = {},
  ) => ({
    entry: { kind: options.kind ?? "user", authorId },
    inlineReplyTo: options.reply === true ? { id: "root" } : undefined,
  });

  assert.equal(continues(item("alice"), item("alice"), false), true);
  assert.equal(continues(item("alice"), item("bob"), false), false);
  assert.equal(continues(item("alice"), item("alice"), true), false);
  assert.equal(
    continues(item("alice", { reply: true }), item("alice"), false),
    false,
  );
  assert.equal(
    continues(item("alice"), item("alice", { reply: true }), false),
    false,
  );
  assert.equal(
    continues(item("alice", { kind: "system" }), item("alice"), false),
    false,
  );

  // Compaction changes only the repeated identity chrome. The body and the
  // action rail stay outside those conditionals, so every message remains
  // independently interactive.
  assert.match(
    chats,
    /compact\s*\?\s*""\s*:\s*`<span class="cmsg-avatar">/u,
  );
  assert.match(chats, /compact\s*\?\s*""\s*:\s*`<div class="cmsg-top">/u);
  assert.match(chats, /<span class="cmsg-actions">/u);
  assert.match(css, /\.cmsg-row\.cmsg-compact \{/u);
  assert.match(
    css,
    /\.cmsg-row\.cmsg-compact \.cmsg-body \{[\s\S]{0,80}margin-left: calc\(var\(--cmsg-body-x\) - 8px\);/u,
  );
});

test("channel task branches share the compact group's visible avatar", async () => {
  const chats = await publicFile("screen-chats.js");
  const start = chats.indexOf("function continuesUserMessageGroup");
  const end = chats.indexOf("\n/**\n * The three dots", start);
  const createPaths = new Function(
    `${chats.slice(start, end)}\nreturn messageThreadPaths;`,
  );
  const paths = createPaths() as (
    timeline: unknown[],
    groupConsecutive: boolean,
  ) => Array<
    { start: boolean; through: boolean; end: boolean } | undefined
  >;
  const item = (
    authorId: string,
    options: {
      at?: string;
      kind?: string;
      reply?: boolean;
      task?: boolean;
    } = {},
  ) => ({
    entry: {
      kind: options.kind ?? "user",
      authorId,
      taskId: options.task === true ? `task-${authorId}` : undefined,
      replies: options.task === true ? [{}, {}] : [],
    },
    inlineReplyTo: options.reply === true ? { id: "root" } : undefined,
    at: options.at ?? "2026-08-19T10:00:00.000Z",
  });
  const shared = [
    { start: true, through: true, end: false },
    { start: false, through: false, end: true },
  ];

  // A task on the compact second prompt starts at the first prompt's avatar.
  assert.deepEqual(
    paths([item("alice"), item("alice", { task: true })], true),
    shared,
  );
  // Two task prompts use that same stem; each threaded row supplies an elbow.
  assert.deepEqual(
    paths(
      [item("alice", { task: true }), item("alice", { task: true })],
      true,
    ),
    shared,
  );

  const standalone = { start: true, through: false, end: true };
  assert.deepEqual(
    paths(
      [item("alice", { task: true }), item("bob", { task: true })],
      true,
    ),
    [standalone, standalone],
    "another author starts another path",
  );
  assert.deepEqual(
    paths(
      [
        item("alice", { task: true }),
        item("alice", { at: "2026-08-20T10:00:00.000Z", task: true }),
      ],
      true,
    ),
    [standalone, standalone],
    "a new day starts another path",
  );
  assert.deepEqual(
    paths(
      [
        item("alice", { task: true }),
        item("alice", { reply: true }),
        item("alice", { task: true }),
      ],
      true,
    ),
    [standalone, undefined, standalone],
    "an inline reply breaks the prompt group",
  );
  assert.deepEqual(
    paths(
      [item("alice", { task: true }), item("alice", { task: true })],
      false,
    ),
    [standalone, standalone],
    "search hits never invent a shared path",
  );

  assert.match(chats, /threadPath: threadPaths\[index\]/u);
  assert.match(chats, /path\?\.through === true \? " cmsg-thread-path-through"/u);
  assert.match(chats, /path\?\.end === true \? " cmsg-thread-path-end"/u);
});

test("private-chat messages compact only an uninterrupted run from one speaker", async () => {
  const app = await browserSource();
  const chat = await publicFile("chat.js");
  const css = await publicFile("styles.css");

  const start = chat.indexOf("function continuesPrivateChatMessageGroup");
  const end = chat.indexOf("\nexport function chatThread", start);
  assert.notEqual(start, -1, "chat.js declares the private grouping rule");
  assert.notEqual(end, -1, "the private grouping rule has a testable boundary");
  const createGroupingRule = new Function(
    `${chat.slice(start, end)}\nreturn continuesPrivateChatMessageGroup;`,
  );
  const continues = createGroupingRule() as (
    previous: { role: string } | undefined,
    current: { role: string },
    startsNewDay: boolean,
  ) => boolean;

  assert.equal(continues({ role: "user" }, { role: "user" }, false), true);
  assert.equal(
    continues({ role: "assistant" }, { role: "assistant" }, false),
    true,
  );
  assert.equal(continues({ role: "user" }, { role: "assistant" }, false), false);
  assert.equal(continues({ role: "assistant" }, { role: "user" }, false), false);
  assert.equal(continues({ role: "system" }, { role: "user" }, false), false);
  assert.equal(continues({ role: "user" }, { role: "system" }, false), false);
  assert.equal(continues({ role: "user" }, { role: "user" }, true), false);
  assert.equal(continues(undefined, { role: "user" }, false), false);

  // Continuations lose only repeated chrome (face, name, clock). They remain
  // individual rows and keep the conversation semantics unchanged.
  assert.match(chat, /compact \? " msg-compact" : ""/u);
  assert.match(
    chat,
    /compact\s*\?\s*""\s*:\s*`<div class="msg-top">/u,
  );
  assert.doesNotMatch(chat, /chat-msg-delete/u);
  assert.doesNotMatch(app, /chat-msg-delete/u);
  assert.doesNotMatch(css, /chat-msg-delete/u);
  assert.doesNotMatch(chat, /truncateConversationFrom/u);
  // Yours on the right, the agent's on the left — the one difference from the
  // channel's single-sided transcript.
  assert.match(chat, /mine \? "user" : "agent"/u);
  assert.match(css, /\.msg\.user \{\s*align-self: flex-end;/u);
  assert.match(css, /\.msg\.agent \{\s*align-self: flex-start;/u);
  assert.match(
    css,
    /\.msg\.user \.msg-text \{[^}]*background: var\(--accent\);[^}]*color: #fff;/su,
  );
  // A short outgoing bubble hugs the right edge below the speaker name. As
  // the words get longer, the bubble grows back into the available space
  // instead of stretching a one-word message across the whole metadata row.
  assert.match(
    css,
    /\.msg\.user \.msg-body \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*align-items: flex-end;/su,
  );
  assert.match(
    css,
    /\.msg\.msg-compact \.msg-body \{\s*margin-left: calc\(var\(--msg-body-x\) - 8px\);/u,
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
  // Historical acknowledgements and current conversational answers both carry
  // the default `agent` kind. Neither is run narration, so neither belongs in
  // the thinking fold.
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

test("each task turn puts its own thinking below its prompt and starts closed", async () => {
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
  assert.match(
    thinking,
    /state\.thinkingOpen\[key\] === true/u,
    "only an explicit reader choice should open a Thinking block",
  );
  assert.equal(
    thinking.includes("?? !done"),
    false,
    "an active turn should start closed just like a finished turn",
  );
});

test("the progress bar restarts for each task turn in a thread", async () => {
  const source = await publicFile("screen-chats.js");
  const progressStart = source.indexOf("function threadProgress(entry)");
  const progressEnd = source.indexOf("\n/*", progressStart);
  const turnsStart = source.indexOf("function threadReplyTurns(replies)");
  const turnsEnd = source.indexOf(
    "\n/** One turn's narration",
    turnsStart,
  );
  assert.notEqual(progressStart, -1, "thread progress should still be derived");
  assert.notEqual(progressEnd, -1, "thread progress should have a boundary");
  assert.notEqual(turnsStart, -1, "thread turns should still be grouped");
  assert.notEqual(turnsEnd, -1, "thread turn grouping should have a boundary");

  const progress = Function(
    "state",
    "THREAD_FINISHED_RE",
    `"use strict";\n${source.slice(turnsStart, turnsEnd)}\n${source.slice(
      progressStart,
      progressEnd,
    )}\nreturn threadProgress;`,
  )(
    { tasks: [{ id: "task-1", status: "claimed" }] },
    /^(Done —|I could not|This was cancelled)/u,
  ) as (entry: {
    taskId: string;
    replies: Array<{ kind: string; content: string }>;
  }) => number | undefined;

  const thread = {
    taskId: "task-1",
    replies: [
      { kind: "progress", content: "Planning workspace prepared" },
      { kind: "progress", content: "Done — the first task landed" },
      { kind: "outcome", content: "The first task is complete" },
      { kind: "user", content: "Please do one more task in this thread" },
      { kind: "progress", content: "Planning workspace prepared" },
      { kind: "progress", content: "Execution started" },
    ],
  };

  assert.equal(
    progress(thread),
    20,
    "an earlier ending must not hide the active turn's progress",
  );
  assert.equal(
    progress({
      ...thread,
      replies: thread.replies.filter((reply) => reply.kind !== "user"),
    }),
    20,
    "a task added without a copied prompt must restart progress too",
  );
  thread.replies.push({ kind: "outcome", content: "The follow-up is complete" });
  assert.equal(
    progress(thread),
    undefined,
    "the bar should still disappear when the current turn ends",
  );
});

test("the run is a ring on the agent working, at the front of the stack", async () => {
  const source = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // The bar under the thread is gone: it said something was moving without
  // ever saying who, which is the whole reason it moved onto a face.
  assert.doesNotMatch(css, /\.thread-progress\b/u);
  assert.doesNotMatch(source, /class="thread-progress"/u);

  const slice = (from: string, to: string) => {
    const start = source.indexOf(from);
    assert.notEqual(start, -1, `${from} should still exist`);
    const end = source.indexOf(to, start + from.length);
    assert.notEqual(end, -1, `${from} should have a boundary`);
    return source.slice(start, end);
  };
  const summary = Function(
    "threadTitleReply",
    "isThreadThinking",
    "threadSaidCount",
    "threadAwaitsGoAhead",
    "threadReplyTurns",
    "channelAuthor",
    "agentFace",
    "avatar",
    "currentUserName",
    "myAvatar",
    "esc",
    `"use strict";\n${slice("function threadParticipants(replies", "\n/**")}\n${slice(
      "function threadWorkingAuthor(entry",
      "\n/*",
    )}\n${slice("function threadSummaryLink(entry", "\n/**")}\nreturn threadSummaryLink;`,
  )(
    () => undefined,
    () => false,
    (said: number) => `${said} replies`,
    () => false,
    (replies: unknown[]) => [{ replies }],
    (_repositoryId: string, reply: { author: string; agent?: boolean }) => ({
      name: reply.author,
      agent: reply.agent === true ? { id: reply.author } : undefined,
    }),
    (agent: { id: string }) => `<face>${agent.id}</face>`,
    (name: string) => `<avatar>${name}</avatar>`,
    () => "Ada",
    () => undefined,
    (value: string) => String(value),
  ) as (
    entry: unknown,
    replies: unknown[],
    repositoryId: string,
    progress: number | undefined,
  ) => string;

  const replies = [
    { author: "Ada" },
    { author: "codex", agent: true },
    { author: "Bo" },
    { author: "claude", agent: true },
  ];
  const running = summary({ id: "m1", replies }, replies, "repo-1", 45);
  assert.match(
    running,
    /<span class="ctl-working" style="--run:45"/u,
    "the ring should carry the run's position",
  );
  assert.match(
    running.slice(running.indexOf("ctl-faces")),
    /ctl-working[\s\S]*?<face>claude<\/face>[\s\S]*?<avatar>Ada<\/avatar>/u,
    "the agent still working should be ringed and first in the stack",
  );
  assert.equal(
    running.match(/<face>claude<\/face>/gu)?.length,
    1,
    "moving a participant to the front must not duplicate them",
  );

  // Nothing running, nothing drawn: the stack goes back to being the order
  // people spoke in.
  const idle = summary({ id: "m1", replies }, replies, "repo-1", undefined);
  assert.doesNotMatch(idle, /ctl-working/u);
  assert.match(idle.slice(idle.indexOf("ctl-faces")), /<avatar>Ada<\/avatar>/u);

  // A pie over the whole face rather than a badge in its corner: the wedge
  // still to come is darker than the wedge already travelled, which is the
  // entire read.
  const ring = /\n\.cmsg-thread-link \.ctl-faces \.ctl-working::after \{([\s\S]*?)\n\}/u
    .exec(css)?.[1];
  assert.notEqual(ring, undefined, "the pie should be drawn on the face");
  assert.match(ring ?? "", /border-radius: 50%;/u);
  assert.match(
    ring ?? "",
    /conic-gradient\(\s*color-mix\(in srgb, var\(--accent\) 42%, transparent\) calc\(var\(--run, 0\) \* 1%\)/u,
  );
  // Undone is the darker of the two, and it is what the rest of the circle is
  // filled with.
  assert.match(ring ?? "", /rgba\(0, 0, 0, 0\.55\) 0\s*\);/u);
  // It covers the icon rather than sitting in a corner of it, so nothing may
  // pin it to one edge or cut a hole in its middle.
  assert.match(ring ?? "", /inset: -1px;/u);
  assert.doesNotMatch(ring ?? "", /mask:/u);
  assert.doesNotMatch(ring ?? "", /width:/u);
  assert.doesNotMatch(ring ?? "", /height:/u);
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

  // A new turn gets its own disclosure key. It therefore stays closed without
  // changing the completed turn above it or needing a thread-global reset
  // before submit.
  const thinkingStart = source.indexOf("function threadThinkingBlock");
  const thinkingEnd = source.indexOf("\nfunction threadReplies", thinkingStart);
  const thinking = source.slice(thinkingStart, thinkingEnd);
  assert.match(thinking, /const key = `\$\{rootId\}:thinking:\$\{index\}`/u);
  assert.match(thinking, /state\.thinkingOpen\[key\] === true/u);

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
  const app = await browserSource();
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
  assert.equal(
    wrap("keep  repeated and trailing spaces  ", []),
    "keep  repeated and trailing spaces  \n",
  );

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
    // Width is a shared metric as well, and the only one that used to change
    // on its own: a draft past `max-height` gave the textarea a scrollbar and
    // took its 10px out of the line the caret is measured against, while the
    // `overflow: hidden` mirror kept them. Reserved on both, it cannot drift.
    "scrollbar-gutter",
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

  // The other two ways the caret got away from the letters, both of which
  // needed something outside the keystroke path to happen first — which is
  // why it read as intermittent, and why staging an image (a render each)
  // was where it was noticed.
  //
  // A render rebuilds the mirror at the top of its own scroll while the
  // textarea is put back where it was, so the restore has to move both.
  const restore = app.slice(
    app.indexOf("function restoreFocus"),
    app.indexOf("\nfunction confirmDiscardEdit"),
  );
  assert.match(restore, /next\.scrollTop = saved\.top;/u);
  assert.match(restore, /\[data-composer-mirror\]/u);
  assert.match(restore, /mirror\.scrollTop = next\.scrollTop;/u);

  // And nothing writes the textarea's value behind the mirror's back: an
  // assignment fires no input event, so the painted text stays a token short
  // of the caret until the next keystroke. It goes through the draft instead.
  const insert = app.slice(
    app.indexOf('case "mention-agents-insert"'),
    app.indexOf('case "dm-close"'),
  );
  assert.notEqual(insert, "", "the @agents shortcut should still be there");
  assert.doesNotMatch(insert, /input\.value =/u);
  assert.match(insert, /state\.chatDraft = /u);
  assert.match(insert, /render\(\);/u);
  // ...carrying any staged image across, the same as `typeIntoComposer`.
  assert.match(insert, /attachment:\[0-9a-f\]\{32\}/u);
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

test("a channel transcript reads down one side at every width", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // The room is a log, not a two-sided conversation: the reader's own lines
  // are placed exactly like everybody else's, so the avatar gutter and the
  // name are the only things that say who is speaking. Nothing marks a row
  // as the reader's, and nothing mirrors one on a phone.
  const rendererStart = chats.indexOf("function messageRow");
  assert.notEqual(rendererStart, -1, "messageRow is still the channel row");
  const renderer = chats.slice(
    rendererStart,
    chats.indexOf("\nfunction continuesUserMessageGroup", rendererStart),
  );
  assert.ok(
    !renderer.includes("cmsg-mine"),
    "the channel row no longer marks the reader's own messages",
  );
  assert.ok(
    !css.includes("cmsg-mine"),
    "no width mirrors a channel row onto the right",
  );
});

test("people and agents render directly without a main branch node", async () => {
  const chats = await publicFile("screen-chats.js");
  const sidebar = chats.slice(
    chats.indexOf("function chanSidebar"),
    chats.indexOf("/* ---------------------------------------------------------- chan main"),
  );
  const header = chats.slice(
    chats.indexOf("function chanHeader"),
    chats.indexOf("function chanSearchRow"),
  );

  assert.match(sidebar, /section\("People", "invite-repo"/u);
  assert.match(sidebar, /section\("Agents", "channel-agent-menu"/u);
  assert.ok(
    sidebar.indexOf('section("People"') < sidebar.indexOf('section("Agents"'),
    "people and agents are direct, ordered sidebar sections",
  );
  assert.doesNotMatch(header, /repository\?\.branch/u);
  assert.doesNotMatch(header, /class="ch-sep"/u);
  assert.match(header, /class="ch-count" title="\$\{people\.length\}/u);
  assert.match(header, /class="ch-count" title="\$\{roster\.length\}/u);
});

test("clicking an agent opens its details while chat and history stay explicit", async () => {
  const app = await browserSource();
  const chats = await publicFile("screen-chats.js");
  const row = chats.slice(
    chats.indexOf("function rosterRow(agent)"),
    chats.indexOf("/**\n * What the \"...\" on a roster row offers"),
  );
  const menu = chats.slice(
    chats.indexOf("export function rosterMenuItems"),
    chats.indexOf("function chanSidebar"),
  );
  const panel = chats.slice(
    chats.indexOf("function agentPanel()"),
    chats.indexOf("function dmPanel()"),
  );
  const open = app.slice(
    app.indexOf('case "agent-panel-open"'),
    app.indexOf('case "agent-panel-tab"'),
  );

  // The avatar is part of the primary row target. It must not shadow the row
  // with the private-chat action and bypass the profile-like landing surface.
  assert.match(row, /data-act="agent-panel-open"/u);
  assert.match(row, /aria-label="Open details for \$\{esc\(agent\.name\)\}"/u);
  assert.doesNotMatch(row, /data-act="agent-chat-open"/u);

  assert.match(open, /state\.activeAgentPanel = value;/u);
  assert.match(open, /state\.agentPanelTab = "spec";/u);
  assert.doesNotMatch(open, /notifications/u);
  assert.match(panel, /const requestedTab = state\.agentPanelTab \?\? "spec";/u);
  assert.match(panel, /: agentSpec\(agent, repositoryId\)/u);
  assert.match(panel, /\$\{agentFace\(agent, 20\)\}/u);
  assert.doesNotMatch(panel, /statusDot\(/u);

  // The alternate destinations still exist, but only behind controls that
  // name what they do instead of changing the result of clicking the agent.
  assert.match(menu, /act: "agent-chat-open"/u);
  assert.match(menu, /label: `Message \$\{agent\.name\}`/u);
  assert.match(panel, /const headerAction = \(view, iconName, title\)/u);
  assert.match(
    panel,
    /canChatPrivately \? headerAction\("chat", "chatBubble", "Private chat"\) : ""/u,
  );
  assert.match(panel, /headerAction\("history", "history", "Task history"\)/u);
});

test("the spec tab is where an agent is made org-wide or kept personal", async () => {
  const app = await browserSource();
  const chats = await publicFile("screen-chats.js");
  const spec = chats.slice(
    chats.indexOf("function agentSpec(agent, repositoryId)"),
    chats.indexOf("function agentPanel()"),
  );
  const handlerStart = app.indexOf('case "channel-agent-visibility"');
  const handler = app.slice(handlerStart, app.indexOf("default:", handlerStart));

  // The one control that decides whether teammates may task this agent. It
  // was only offered while pasting a credential, which left an agent
  // connected as personal personal forever.
  assert.notEqual(handlerStart, -1);
  assert.match(spec, /miniSelect\(\s*"channel-agent-visibility"/u);
  assert.match(spec, /\{ value: "personal", label: "Only me" \}/u);
  assert.match(spec, /\{ value: "org", label: "Anyone in the org" \}/u);

  // Only the owner of the credential picks who may spend it; a teammate
  // reads the answer, the same way model and reasoning already degrade.
  assert.match(spec, /agent\.mine === true\s*\?\s*miniSelect\(\s*"channel-agent-visibility"/u);
  assert.match(spec, /: readOnly\(\s*visibility === "org" \? "Anyone in the org" : "Only its owner",/u);

  // The select lives inside the chip group the handler resolves the agent
  // from, so the control and its handler cannot drift apart again.
  assert.match(spec, /<div class="aspec-chip-grid" data-agent="\$\{esc\(agent\.id\)\}">/u);
  assert.match(handler, /node\.closest\("\[data-agent\]"\)\?\.dataset\.agent/u);
  assert.match(
    handler,
    /applyProviderSetting\(agentId, "visibility", node\.value\)/u,
  );
});

test("agent details use the reference profile without dropping existing controls", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  const spec = chats.slice(
    chats.indexOf("function agentSpec(agent, repositoryId)"),
    chats.indexOf("function agentPanel()"),
  );
  const panel = chats.slice(
    chats.indexOf("function agentPanel()"),
    chats.indexOf("function dmPanel()"),
  );

  // The visual hierarchy follows the supplied agent profile: a large identity,
  // introductory copy, connected-setting pills, and checked capability rows.
  assert.match(spec, /agentFace\(agent, 68\)/u);
  assert.match(spec, /class="aspec-description"/u);
  assert.match(spec, /<h3 class="aspec-label">Works with<\/h3>/u);
  assert.match(spec, /<h3 class="aspec-label">Capabilities<\/h3>/u);
  assert.match(spec, /class="aspec-chip"/u);
  assert.match(
    spec,
    /class="aspec-capability aspec-current-task\$\{\s*task === undefined \? "" : " aspec-current-task-active"\s*\}"/u,
  );
  assert.match(panel, /<aside class="thread-panel agent-detail-panel">/u);
  assert.match(css, /\.agent-detail-panel\s*\{[^}]*min\(680px, 64vw\)/su);
  assert.match(css, /\.agent-spec \.aspec-chip\s*\{/u);
  assert.match(css, /\.agent-spec \.aspec-capability\s*\{/u);

  // Only a real assignment becomes the primary-colour bubble. Its own copy,
  // state line, mark, and history control remain legible on that solid surface.
  const activeTask = /\n\.agent-spec \.aspec-current-task-active \{([\s\S]*?)\n\}/u.exec(
    css,
  )?.[1];
  assert.notEqual(activeTask, undefined, "an active task has a shape rule");
  assert.match(activeTask ?? "", /background: var\(--accent\);/u);
  assert.match(activeTask ?? "", /border-radius: 14px;/u);
  for (const child of [
    "aspec-capability-mark",
    "aspec-capability-title",
    "aspec-capability-meta",
    "aspec-nav",
  ]) {
    assert.match(
      css,
      new RegExp(`\\.aspec-current-task-active \\.${child}`, "u"),
    );
  }
  assert.match(
    css,
    /\.aspec-current-task-active \.aspec-capability-mark,[\s\S]*?\.aspec-current-task-active \.aspec-nav \{\s*color: #fff;/u,
  );
  assert.match(
    css,
    /\.aspec-current-task-active \.aspec-nav \{[\s\S]*?background: rgba\(0, 0, 0, 0\.14\);/u,
  );

  // Every interactive or informative part of the former details page remains
  // on the single scrolling surface, including owner-only and read-only paths.
  for (const action of [
    "channel-agent-visibility",
    "channel-agent-model",
    "channel-agent-effort",
    "agent-role-form",
    "agent-role-input",
    "agent-panel-tab",
    "agent-usage-refresh",
  ]) {
    assert.match(spec, new RegExp(`data-act="${action}"|"${action}"`, "u"));
  }
  assert.match(spec, /taskSummaryLine\(task, taskMessage\)/u);
  assert.match(spec, /data-value="history" title="Task history"/u);
  assert.match(spec, /elsewhere[\s\S]*\.map\(\(\{ repository, member \}\)/u);
  assert.match(spec, /agentUsage\(agent\)/u);
  assert.match(spec, /agent\.mine === true/u);
  assert.match(spec, /const readOnly =/u);
});

test("the role field offers the two reserved roles without stopping anyone typing one", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");
  const spec = chats.slice(
    chats.indexOf("function agentSpec(agent, repositoryId)"),
    chats.indexOf("function agentPanel()"),
  );
  const menu = chats.slice(
    chats.indexOf("const RESERVED_ROLES = ["),
    chats.indexOf("const AGENT_STATUS_TITLE"),
  );

  // The field is still a field: free text, same commit contract as before.
  assert.match(spec, /class="aspec-role" data-act="agent-role-input"/u);
  // With a picker beside it, drawn only where the server would accept one.
  assert.match(spec, /canManageRepository\(repository\.id\)/u);
  assert.match(spec, /data-act="agent-role-menu"/u);
  assert.match(css, /\.agent-spec \.aspec-role-field\s*\{/u);
  assert.match(css, /\.agent-spec \.aspec-role-pick\s*\{/u);

  // Both reserved names, spelled the way the server compares them.
  assert.match(chats, /const INVESTIGATOR_ROLE = "investigator"/u);
  assert.match(menu, /value: AUDITOR_ROLE/u);
  assert.match(menu, /value: INVESTIGATOR_ROLE/u);
  // A personal agent cannot hold either, so the entry says so rather than
  // waiting for the server to refuse it.
  assert.match(menu, /agent\.visibility !== "org"/u);
  assert.match(menu, /disabled: personal \|\| current === role\.value/u);
  // And the menu always leaves a way back to plain typing.
  assert.match(menu, /act: "agent-role-custom"/u);
  assert.match(menu, /export function roleMenuItems\(agentId, repositoryId\)/u);

  // Picking one writes through the same setting path a typed role does.
  assert.match(app, /case "agent-role-menu":/u);
  assert.match(app, /roleMenuItems\(value, node\.dataset\.repo\)/u);
  assert.match(app, /showMenu\(node, items\)/u);
  assert.match(
    app,
    /setChannelAgentSetting\(target\.repositoryId, target\.agentId, "role", role, render\)/u,
  );
  // Opening the picker must not commit-and-redraw the field out from under
  // the click that opens it.
  assert.match(
    app,
    /event\.relatedTarget\?\.dataset\?\.act === "agent-role-menu"/u,
  );
});

test("a typed role survives the redraw that commits it", async () => {
  // Once the roster has resolved, `channelAgentsFor` used to take role only
  // from that answer. Committing a typed role writes the local override and
  // redraws before the roster is fetched again — so the field went blank
  // on Enter unless the override is read here the same way model and effort
  // already are.
  const data = await publicFile("data.js");
  const body = data.slice(
    data.indexOf("export function channelAgentsFor"),
    data.indexOf("/** Agents and people who can be @mentioned"),
  );
  assert.match(body, /role: local\?\.role \?\? server\.role/u);
  assert.match(body, /model: local\?\.model \?\? agent\.model/u);
});

test("a roster row carries one ellipsis and a compact rename delete menu", async () => {
  const chats = await publicFile("screen-chats.js");
  const ui = await publicFile("ui.js");
  const css = await publicFile("styles.css");
  const row = chats.slice(
    chats.indexOf("function rosterRow(agent)"),
    chats.indexOf("/**\n * What the \"...\" on a roster row offers"),
  );
  const menu = chats.slice(
    chats.indexOf("export function rosterMenuItems"),
    chats.indexOf("function chanSidebar"),
  );

  assert.equal(row.match(/act: "roster-agent-menu"/gu)?.length, 1);
  assert.match(row, /settingsOpen\s*\? `<form class="roster-rename"/u);
  assert.match(row, /: `<div class="rr-name">\$\{esc\(agent\.name\)\}<\/div>`/u);
  assert.match(row, /class="rr-name-input" data-act="channel-rename-input"/u);
  assert.doesNotMatch(row, /rosterSettings|channel-role-input/u);

  assert.match(menu, /label: "Rename"/u);
  assert.match(menu, /iconName: "pencil"/u);
  assert.match(menu, /label: "Delete"/u);
  assert.match(menu, /danger: true/u);
  assert.match(
    menu,
    /agent\.mine === true\s*\?\s*"channel-agent-remove"\s*:\s*"channel-agent-remove-any"/u,
  );
  assert.doesNotMatch(menu, /label: "Settings"|iconName: "sliders"/u);
  assert.doesNotMatch(chats, /function rosterSettings|function settingRow/u);

  assert.match(css, /\.roster-rename \{\s*min-width: 0;\s*width: 100%;/u);
  assert.match(css, /\.roster-rename input \{[\s\S]{0,400}font-size: 12\.5px;/u);
  assert.doesNotMatch(css, /\.roster-settings|\.rs-remove/u);
  assert.match(ui, /item\.danger === true \? " menu-item-danger"/u);
  assert.match(css, /\.menu-item-danger[\s\S]{0,120}color: var\(--red\)/u);
});

test("inline rename and delete finish without retaining extra UI", async () => {
  const app = await browserSource();
  const ui = await publicFile("ui.js");
  const remove = app.slice(
    app.indexOf("async function removeChannelAgentAction"),
    app.indexOf("async function leaveRepositoryAction"),
  );
  const submit = app.slice(
    app.indexOf('case "channel-rename-form"'),
    app.indexOf("default:", app.indexOf('case "channel-rename-form"')),
  );
  const renameKeys = app.slice(
    app.indexOf("/** Enter or Escape finishes the inline agent-name edit."),
    app.indexOf("/** The inline rename also saves and closes on blur."),
  );
  const renameBlur = app.slice(
    app.indexOf("/** The inline rename also saves and closes on blur."),
    app.indexOf('window.addEventListener("hashchange"'),
  );

  assert.match(remove, /await showModal\(/u);
  assert.match(remove, /if \(confirmed === undefined\) \{\s*return;/u);
  assert.match(remove, /removeChannelAgent\(repositoryId, agentId\)/u);
  assert.match(remove, /removeChannelAgentForUser\(/u);
  assert.match(app, /case "channel-agent-remove":\s*\n\s*closePopover\(\);/u);
  assert.match(app, /case "channel-agent-remove-any":\s*\n\s*closePopover\(\);/u);
  // The shared popover closes on its scrim or Escape, covering dismissal as
  // well as either menu selection above.
  assert.match(ui, /data-act="pop-close"/u);
  assert.match(ui, /event\.key === "Escape"[\s\S]{0,60}closePopover\(\)/u);

  assert.match(submit, /renameChannelAgent\(/u);
  assert.match(submit, /state\.chatSettingsOpenId = undefined;/u);
  assert.match(submit, /render\(\);/u);
  const escape = /if \(act === "channel-rename-input" && event\.key === "Escape"\) \{([\s\S]*?)\n  \}/u.exec(
    renameKeys,
  )?.[1];
  assert.notEqual(escape, undefined, "Escape has an inline-rename branch");
  assert.match(escape ?? "", /state\.chatSettingsOpenId = undefined;/u);
  assert.doesNotMatch(escape ?? "", /renameChannelAgent/u);
  assert.match(renameKeys, /event\.key === "Enter"[\s\S]{0,240}requestSubmit\(\)/u);
  assert.match(renameBlur, /renameChannelAgent\(activeChannelId\(\), agentId, node\.value\)/u);
  assert.match(renameBlur, /state\.chatSettingsOpenId = undefined;\s*\n\s*render\(\);/u);
  assert.match(
    app,
    /event\.target\.closest\?\.\("button, input, select, textarea, a\[href\]"\)[\s\S]{0,80}return;/u,
  );
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

test("a run waiting on a person is marked as waiting, not as finished", async () => {
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // The two holds this product has, read off the task the same way the typing
  // dots read the working ones — so a task is in exactly one of the two sets
  // and the two marks can never both be on.
  assert.match(data, /const HELD_STATUS = new Set\(\["planned", "awaiting_approval"\]\)/u);
  assert.match(data, /export function threadAwaitsGoAhead\(/u);
  assert.match(data, /export function channelAwaitsGoAhead\(/u);

  // The sidebar answers from the tasks rather than the messages: only the open
  // channel has its messages loaded, so a badge read from those would be right
  // for the room already on screen and absent for every other.
  const channelHeld = data.slice(
    data.indexOf("export function channelAwaitsGoAhead"),
    data.indexOf("/** Records a `channel-typing` frame from somebody else. */"),
  );
  assert.match(channelHeld, /state\.tasks\.some/u);
  assert.equal(/channelMessagesFor/u.test(channelHeld), false);

  // Three surfaces, because a reader meets a held run at whichever of them
  // they happen to be looking at: the room list, the message in the channel,
  // and the thread list.
  assert.match(chats, /class="cr-held"/u);
  assert.match(chats, /class="ctl-held"/u);
  assert.match(chats, /class="ti-held"/u);
  // The channel's mark is a dot beside the reply count, not a bordered banner
  // repeating in full the sentence the room's own hold line already says one
  // message below it. The words survive where colour and motion cannot be
  // read.
  assert.equal(/class="thread-held"/u.test(chats), false);
  assert.match(chats, /class="sr-only">Waiting for your go-ahead/u);

  // Amber, not the accent: "moving" and "stopped until you answer" are the two
  // states this list exists to tell apart, and one colour for both is no answer.
  const held = /\n\.thread-item-held \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(held, undefined, "a held thread has a shape rule");
  assert.match(held ?? "", /var\(--orange\)/u);
  assert.equal(/var\(--accent\)/u.test(held ?? ""), false);

  // Same amber on the channel's dot, and the same clock every other live
  // signal in the app breathes on — with the motion reducible, because the
  // fade is the whole of what it says.
  const dot = /\n\.cmsg-thread-link \.ctl-held \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(dot, undefined, "the channel's held mark has a shape rule");
  assert.match(dot ?? "", /var\(--orange\)/u);
  assert.match(dot ?? "", /animation: status-breathe/u);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\n {2}\.cmsg-thread-link \.ctl-held \{\n {4}animation: none;/u,
  );
});

test("the room's hold line carries a way back to the thread it is about", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // The line says "the plan is in the thread" and the thread is somewhere
  // above, collapsed. Recognised by the prefix the gateway writes, resolved to
  // the nearest held thread before it, and drawn as a reference back to it.
  assert.match(chats, /const HOLD_NOTICE_PREFIX = "⏸ Waiting on you"/u);
  assert.match(chats, /function holdNoticeTarget\(/u);
  assert.match(chats, /class="cmsg-ref" data-act="channel-pin-jump"/u);
  // New agent roots use their durable reference first; the hold parser stays
  // as the fallback for notices written before references were persisted.
  assert.match(chats, /entry\.referencedMessageId !== undefined/u);
  assert.match(chats, /messageReference\(referencedRoot, repositoryId\)/u);
  assert.match(chats, /holdNoticeRef\(entry, repositoryId\)/u);
  // Not invented navigation: `channel-pin-jump` already opens a target that
  // has a thread and scrolls to one that does not.
  assert.match(await browserSource(), /case "channel-pin-jump":/u);

  // The elbow is the channel's own thread branch, turned upward — same gutter,
  // same hairline, a rounded corner instead of a straight drop.
  const elbow = /\n\.cmsg-ref-elbow \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(elbow, undefined, "the reference draws a line back");
  assert.match(elbow ?? "", /border-top-left-radius/u);
  assert.match(elbow ?? "", /border-left: 2px solid/u);
  assert.match(elbow ?? "", /border-top: 2px solid/u);
});

test("a message's face and name open the person and describe them on hover", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  const identityStart = chats.indexOf("function authorIdentity(");
  const identityEnd = chats.indexOf("\nfunction identityWrap(", identityStart);
  const identity = chats.slice(identityStart, identityEnd);
  assert.notEqual(identityStart, -1, "a message author resolves to an identity");
  assert.notEqual(identityEnd, -1, "the identity resolver has a boundary");

  // The two destinations the roster already uses, so a face means the same
  // thing in the transcript as it does in the sidebar.
  assert.match(identity, /act: "agent-panel-open"/u);
  assert.match(identity, /act: "dm-open"/u);
  const browser = await browserSource();
  assert.match(browser, /case "dm-open":/u);
  assert.match(browser, /case "agent-panel-open":/u);

  // Nobody presses their own name into a conversation with themselves, and an
  // agent the roster could not resolve is left alone rather than read as a
  // person — its author id is `<userId>:<provider>`, which is a direct message
  // to an id nobody has.
  assert.match(
    identity,
    /userId === "you" \|\|\s*userId === currentUserId\(\) \|\|\s*AGENT_AUTHORED_KINDS\.has\(entry\.kind\)/u,
  );
  assert.match(
    chats,
    /const AGENT_AUTHORED_KINDS = new Set\(\["agent", "progress", "outcome"\]\)/u,
  );

  // Both the picture and the name carry the button, and both carry the card.
  // Wrapped from inside, so the avatar and the header line keep the markup
  // the rest of the transcript's layout is written against.
  const rowStart = chats.indexOf("function messageRow(");
  const row = chats.slice(rowStart, chats.indexOf("\nfunction typingIndicator", rowStart));
  assert.match(row, /const identity = authorIdentity\(repositoryId, entry, author\)/u);
  assert.match(
    row,
    /<span class="cmsg-avatar">\$\{identityWrap\(\s*identity,\s*authorFace\(author, 32\),/u,
  );
  assert.match(
    row,
    /class="cmsg-name\$\{[^}]*\}">\$\{identityWrap\(\s*identity,\s*esc\(author\.name\),/u,
  );
  // Nobody to open means the face and the name are handed back as they were:
  // a tab stop that does nothing is worse than no tab stop.
  assert.match(
    chats,
    /function identityWrap\(identity, content\) \{\s*if \(identity === undefined\) \{\s*return content;/u,
  );
  assert.match(chats, /\$\{content\}\$\{profileCard\(identity\)\}/u);

  // A span answers the keyboard only because `role=button` plus `data-act` is
  // the pair app.js's delegated handler looks for.
  assert.match(chats, /class="cmsg-identity" role="button" tabindex="0"/u);
  assert.match(chats, /data-act="\$\{esc\(identity\.act\)\}" data-value="\$\{esc\(identity\.value\)\}"/u);
  assert.match(chats, /aria-label="\$\{esc\(identity\.label\)\}"/u);
  assert.match(
    await browserSource(),
    /const row = event\.target\.closest\?\.\('\[role="button"\]\[data-act\]'\)/u,
  );

  // Revealed by CSS the way the roster's usage card is, so reading one costs
  // no request — but delayed, because a pointer crosses many names on its way
  // down a transcript and an instant card would flash open the whole way.
  const card = /\n\.profile-card \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(card, undefined, "the hover card has a shape rule");
  assert.match(card ?? "", /visibility: hidden/u);
  assert.match(card ?? "", /pointer-events: none/u);
  assert.match(
    css,
    /\.cmsg-identity:hover \.profile-card,\n\.cmsg-identity:focus-within \.profile-card \{[\s\S]*?visibility: visible;[\s\S]*?transition-delay/u,
  );
  // On a touch screen the tap is the action; a card under the finger only
  // covers what it describes.
  assert.match(
    css,
    /@media \(hover: none\) \{\n {2}\.profile-card \{\n {4}display: none;/u,
  );
});

/* --------------------------------------------------- account boundary ---- */

/**
 * What the browser remembers has to belong to whoever is signed in.
 *
 * Signing out cleared the session and reloaded, and left every stored pointer
 * behind: the selected organization, project and room, the drafts, the read
 * markers. Signing in as somebody else then inherited all of it — and because
 * the deployment's first account administers every organization on it, the
 * inherited selection was perfectly reachable and nothing reset it. The owner
 * signed back in and was shown a newer account's empty workspace, which is
 * indistinguishable from having lost everything.
 */
type Forget = (
  storage: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
  },
  userId: string,
) => boolean;

function fakeStorage(seed: Record<string, string>) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

async function forgetOtherAccount(): Promise<Forget> {
  return extract<Forget>(
    await publicFile("data.js"),
    "forgetOtherAccount",
    "csrfToken",
  );
}

test("a different account does not inherit the last one's workspace", async () => {
  const forget = await forgetOtherAccount();
  const storage = fakeStorage({
    "ag.user": "user_owner",
    "ag.org": "org_someone_else",
    "ag.project": "proj_someone_else",
    "ag.repo": "repo_someone_else",
    "ag.chandrafts": '{"chan_1":"half-written message"}',
    "ag.chanread": '{"chan_1":42}',
    "ag.favourites": '["repo_a"]',
  });

  assert.equal(forget(storage, "user_newcomer"), true);

  // The selection is what produced the report. A room pointer that survives a
  // change of account sends the arriving one to a tenant it has no business
  // opening — or, for an administrator, to an empty one that is not theirs.
  assert.equal(storage.getItem("ag.org"), null);
  assert.equal(storage.getItem("ag.project"), null);
  assert.equal(storage.getItem("ag.repo"), null);
  // And a draft is somebody's unsent words. Leaving it is a leak, not a
  // convenience.
  assert.equal(storage.getItem("ag.chandrafts"), null);
  assert.equal(storage.getItem("ag.chanread"), null);
  assert.equal(storage.getItem("ag.favourites"), null);
  assert.equal(storage.getItem("ag.user"), "user_newcomer");
});

test("signing back in as the same account keeps where you were", async () => {
  const forget = await forgetOtherAccount();
  const storage = fakeStorage({
    "ag.user": "user_owner",
    "ag.org": "org_local",
    "ag.repo": "repo_greeter",
    "ag.chandrafts": '{"chan_1":"half-written message"}',
  });

  // No reload, and nothing dropped: reopening the tab is not a change of
  // account, and losing an unsent draft to a page refresh would be its own
  // small betrayal.
  assert.equal(forget(storage, "user_owner"), false);
  assert.equal(storage.getItem("ag.org"), "org_local");
  assert.equal(storage.getItem("ag.repo"), "repo_greeter");
  assert.equal(
    storage.getItem("ag.chandrafts"),
    '{"chan_1":"half-written message"}',
  );
});

test("this browser's own preferences survive a change of account", async () => {
  const forget = await forgetOtherAccount();
  const storage = fakeStorage({
    "ag.user": "user_owner",
    "ag.org": "org_local",
    "ag.theme": "dark",
    "ag.accent": "#7c5cff",
    "ag.navCollapsed": "true",
    "ag.panelWidth": "420",
    "ag.diffMode": "split",
  });

  assert.equal(forget(storage, "user_newcomer"), true);

  // These describe the machine, not the person. A shared laptop changing
  // colour scheme because a colleague signed in would be a bug of its own.
  assert.equal(storage.getItem("ag.theme"), "dark");
  assert.equal(storage.getItem("ag.accent"), "#7c5cff");
  assert.equal(storage.getItem("ag.navCollapsed"), "true");
  assert.equal(storage.getItem("ag.panelWidth"), "420");
  assert.equal(storage.getItem("ag.diffMode"), "split");
});

test("a browser that has never been signed in is not reloaded", async () => {
  const forget = await forgetOtherAccount();
  const storage = fakeStorage({});

  // Nothing was inherited, so there is nothing to start clean from — a reload
  // here would be a visible stutter on every first sign-in for no reason.
  assert.equal(forget(storage, "user_owner"), false);
  assert.equal(storage.getItem("ag.user"), "user_owner");
});


/**
 * Every dashboard module has to parse, before anything subtler is worth
 * asking about it.
 *
 * These files are plain browser JS — no bundler, no tsc — so nothing else in
 * the build ever parses them. A bad merge left `loadContext` in data.js with
 * the same constant declared twice, which is a SyntaxError: one unparseable
 * module fails every module that imports it, and data.js is imported by all
 * of them, so the deployed app rendered as a black screen with the only
 * diagnostic sitting in the browser console of whoever hit it.
 */
test("every dashboard module parses before it is served", async () => {
  const dir = path.join(packageRoot, "public");
  const modules = (await readdir(dir)).filter((name) => name.endsWith(".js"));
  assert.ok(modules.length >= 5, `expected several modules, saw ${modules.length}`);
  for (const name of modules) {
    const checked = spawnSync(
      process.execPath,
      ["--check", path.join(dir, name)],
      { encoding: "utf8" },
    );
    assert.equal(checked.status, 0, `${name} does not parse:\n${checked.stderr}`);
  }
});

test("a held plan auto-opens with a simple link back to its panel", async () => {
  const chats = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");
  const app = await browserSource();
  const css = await publicFile("styles.css");

  // The gateway marks the plan as its own kind of reply. The thread renders
  // that mark as a link, never as the document — a page of headings pasted
  // into the reply column buries everything said after it.
  assert.match(chats, /reply\.kind === "plan"\s*\?\s*planLink\(root\)/u);
  assert.match(chats, /function planLink\(/u);
  assert.match(chats, /data-act="plan-open"/u);
  assert.match(chats, />\s*\$\{open \? "Plan open" : "Open plan"\}\s*<\/button>/u);
  assert.doesNotMatch(chats, /class="plan-card/u);

  // The panel itself is the thread panel's column, so it inherits the grip,
  // the width the reader dragged and the phone behaviour.
  assert.match(chats, /function planPanel\(/u);
  assert.match(chats, /<aside class="thread-panel plan-panel">/u);
  assert.match(chats, /\$\{panelKind\("Plan"\)\}/u);
  // Nothing in the plan is markdown-rendered: it is escaped first and only
  // then given structure.
  assert.match(chats, /function planDocument\(/u);
  assert.match(chats, /const inline = \(line\) =>\s*esc\(line\)/u);

  // Approving from the panel is the same event as typing it, so a plan let go
  // from here leaves the same record in the thread.
  assert.match(chats, /export function startPlannedWork\(/u);
  assert.match(chats, /postChannelReply\(repositoryId, messageId, "go ahead"\)/u);
  assert.match(app, /case "plan-approve":/u);
  assert.match(app, /case "plan-open":/u);
  assert.match(app, /case "plan-close":/u);

  // And it pops open by itself when the plan lands, on the same terms a
  // prompted thread does: desktop only, and never over something the reader
  // deliberately put in the panel.
  assert.match(data, /export function takeReadyPlan\(/u);
  assert.match(data, /export function planReplyOf\(/u);
  assert.match(
    data,
    /export function takeReadyPlan\([^)]*\) \{[\s\S]*?state\.readyPlan = undefined;[\s\S]*?return pending\.messageId;/u,
  );
  assert.match(app, /function openReadyPlan\(repositoryId\)/u);
  assert.match(app, /openReadyPlan\(channelRepositoryId\);/u);
  assert.match(app, /state\.activePlan = messageId;/u);
  // Escape and the swipe close it when it is the panel's visible occupant.
  // The login catch-up may temporarily sit above it, and is put away first.
  assert.match(
    app,
    /function closeSidePanel\(\) \{[\s\S]*?if \(state\.activePlan !== undefined\)/u,
  );

  assert.match(css, /\n\.plan-link \{/u);
  assert.doesNotMatch(css, /\n\.plan-card \{/u);
  assert.match(css, /\n\.plan-actions \{/u);
});
