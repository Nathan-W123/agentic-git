import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { StaticAsset } from "@coord/api-gateway";

import { defaultPublicDirectory, loadStaticAssets } from "./assets.js";
import { AGENT_CALL_SIGNS } from "./providers.js";

/* ------------------------------------------------------------- assets ---- */

test("loads every control-room asset with an explicit content type", async () => {
  const assets = await loadStaticAssets();
  assert.equal(assets.get("/index.html")?.contentType, "text/html; charset=utf-8");
  assert.equal(assets.get("/styles.css")?.contentType, "text/css; charset=utf-8");
  assert.equal(
    assets.get("/manifest.webmanifest")?.contentType,
    "application/manifest+json",
  );
  assert.equal(assets.get("/kumi-logo.png")?.contentType, "image/png");
  // Narrowed rather than asserted through: `StaticAsset.body` is
  // `Buffer | string` because text assets are served as text, and a PNG that
  // arrived as a string is already corrupt before its header can be read. So
  // "is it bytes" is the first half of "is it a PNG", not a type-checker
  // formality.
  const logo = assets.get("/kumi-logo.png")?.body;
  assert.ok(
    Buffer.isBuffer(logo),
    "the Kumi artwork should be served as bytes, not decoded text",
  );
  assert.equal(
    logo.subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
    "the served Kumi artwork should be a PNG",
  );
  // The icon set the mark is installed as: the SVG is the mark, and each PNG
  // exists because something asks for a raster at a fixed size — an iOS home
  // screen, an installed web app, a browser that declines an SVG favicon.
  assert.equal(assets.get("/kumi-mark.svg")?.contentType, "image/svg+xml");
  for (const icon of [
    "/apple-touch-icon.png",
    "/icon-192.png",
    "/icon-512.png",
  ]) {
    const body = assets.get(icon)?.body;
    assert.ok(Buffer.isBuffer(body), `${icon} should be served as bytes`);
    assert.equal(
      body.subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a",
      `${icon} should be a PNG`,
    );
  }
  // Still an allowlist and not a directory listing: a name nobody registered
  // is not reachable just because it looks like it belongs to the set.
  assert.equal(assets.get("/mark.svg"), undefined);
  assert.equal(assets.get("/icon-1024.png"), undefined);
  for (const module of [
    "/app.js",
    "/ui.js",
    "/data.js",
    "/chat.js",
    "/code-view.js",
    "/screen-repos.js",
    "/screen-code.js",
    "/screen-chats.js",
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

test("offers the mark as the favicon in both a vector and a raster, and as an iOS touch icon", async () => {
  const assets = await loadStaticAssets();
  const html = assets.get("/index.html")?.body.toString("utf8") ?? "";

  // The vector is declared first: a browser that understands an SVG icon
  // should take the mark itself rather than one baked size of it.
  const svg = html.indexOf('<link rel="icon" type="image/svg+xml" href="/kumi-mark.svg">');
  const png = html.indexOf('<link rel="icon" type="image/png" href="/kumi-logo.png">');
  assert.notEqual(svg, -1, "the SVG favicon was not declared");
  assert.notEqual(png, -1, "the PNG favicon fallback was not declared");
  assert.ok(svg < png, "the vector icon should be declared before the raster");
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/u);

  // The mark carries both themes itself, because an <img> cannot inherit a
  // colour from the page that placed it.
  const mark = assets.get("/kumi-mark.svg")?.body.toString("utf8") ?? "";
  assert.match(mark, /prefers-color-scheme: dark/u);
  assert.match(mark, /#D88973/u);
  assert.match(mark, /#9A4C33/u);
});

test("the installable app declares the mark at the sizes a home screen asks for", async () => {
  const assets = await loadStaticAssets();
  const manifest = JSON.parse(
    assets.get("/manifest.webmanifest")?.body.toString("utf8") ?? "{}",
  ) as { icons?: { src: string; sizes: string; purpose: string }[] };

  const icons = manifest.icons ?? [];
  assert.ok(icons.length >= 3, "the manifest should declare an icon set");
  for (const icon of icons) {
    assert.notEqual(
      assets.get(icon.src),
      undefined,
      `${icon.src} is declared in the manifest but not served`,
    );
  }
  // `maskable` is what stops Android from drawing the mark inside a second
  // shape of its own; the tiles are padded for it.
  for (const size of ["192x192", "512x512"]) {
    const icon = icons.find((candidate) => candidate.sizes === size);
    assert.ok(icon !== undefined, `no ${size} icon was declared`);
    assert.match(icon.purpose, /maskable/u);
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

test("the initial document paints an accessible loading shell", async () => {
  const html = await publicFile("index.html");
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");

  assert.match(html, /id="app-root" aria-busy="true"/u);
  assert.doesNotMatch(html, /id="app-root"[^>]* hidden/u);
  assert.match(
    html,
    /class="boot-shell" role="status" aria-live="polite"[\s\S]{0,100}aria-label="Loading Kumi"/u,
  );
  assert.match(html, /class="sr-only">Loading Kumi…<\/span>/u);
  assert.doesNotMatch(html, /boot-skeleton-mark/u);

  // The script owns the same shape after the document paint, then clears the
  // busy state only when it has a real application or signed-out surface.
  assert.match(app, /function renderLoadingShell\(root = \$\("#app-root"\)\) \{/u);
  assert.match(app, /root\.setAttribute\("aria-busy", "true"\);/u);
  assert.match(app, /root\.removeAttribute\("aria-busy"\);/u);
  assert.match(app, /appRoot\.removeAttribute\("aria-busy"\);/u);
  assert.doesNotMatch(app, /boot-skeleton-mark/u);

  assert.match(css, /\.boot-shell \{/u);
  assert.doesNotMatch(css, /boot-skeleton-mark/u);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.skeleton \{\s*animation: none;/u,
  );

  // Rewriting module and stylesheet names for immutable delivery must leave
  // the immediate document body intact.
  const assets = await loadStaticAssets();
  const served = assets.get("/index.html")?.body.toString("utf8") ?? "";
  assert.match(served, /id="app-root" aria-busy="true"/u);
  assert.match(served, /class="boot-shell" role="status"/u);
  assert.doesNotMatch(served, /boot-skeleton-mark/u);
  assert.match(served, /src="\/app\.[0-9a-f]{12}\.js"/u);
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

test("dashboard interface glyphs all use the shared icon set", async () => {
  const assets = await loadStaticAssets();
  const uiPath = path.join(defaultPublicDirectory(), "ui.js");
  const ui = (await import(pathToFileURL(uiPath).href)) as {
    ICONS: Record<string, string>;
    vendorMark: (kind: string) => string;
  };
  const iconNames = new Set<string>();

  for (const [url, asset] of assets) {
    if (!/^\/[a-z-]+\.js$/u.test(url) || url === "/ui.js") {
      continue;
    }
    const source = asset.body.toString("utf8");
    // Product glyphs belong in ui.js. Logos, vendor marks, agent portraits and
    // the context meter live there too, where their deliberate exceptions are
    // documented instead of becoming one-off drawings in a screen module.
    assert.doesNotMatch(source, /<svg\b/u, `${url} draws an icon outside ui.js`);
    for (const match of source.matchAll(
      /\bicon(?:Button)?\(\s*"([A-Za-z][A-Za-z0-9]*)"/gu,
    )) {
      iconNames.add(match[1] ?? "");
    }
    for (const match of source.matchAll(
      /\biconName:\s*"([A-Za-z][A-Za-z0-9]*)"/gu,
    )) {
      iconNames.add(match[1] ?? "");
    }
  }

  for (const name of iconNames) {
    assert.equal(
      Object.hasOwn(ui.ICONS, name),
      true,
      `${name} should exist in the shared icon set`,
    );
  }

  // Basil Solid Bold is filled geometry on a 24px grid, not a traced line.
  // Pin the shared wrapper here so adding a glyph cannot quietly introduce a
  // second optical weight, lose its theme colour, or become visible to a
  // screen reader as meaningless content — and so the outline cut this set
  // replaced cannot creep back one icon at a time. A single stroked glyph in
  // a solid row is the difference the eye reads before it reads the picture,
  // which is why `stroke-width` is forbidden outright rather than pinned to
  // an agreed value.
  for (const [name, glyph] of Object.entries(ui.ICONS)) {
    assert.match(
      glyph,
      /^<svg viewBox="0 0 24 24"/u,
      `${name} keeps the 24px grid`,
    );
    assert.match(glyph, /fill="currentColor"/u, `${name} follows text colour`);
    assert.match(glyph, /stroke="none"/u, `${name} is filled, not stroked`);
    assert.doesNotMatch(
      glyph,
      /stroke-width|stroke-linecap|stroke-linejoin|stroke="(?!none)/u,
      `${name} draws no stroked geometry`,
    );
    assert.doesNotMatch(
      glyph,
      /fill="none"/u,
      `${name} leaves no shape unfilled`,
    );
    assert.match(glyph, /aria-hidden="true"/u, `${name} is decorative`);
    assert.match(glyph, /focusable="false"/u, `${name} cannot take focus`);
    assert.match(
      glyph,
      /data-icon-style="basil-solid"/u,
      `${name} identifies the selected icon treatment`,
    );
    assert.match(
      glyph,
      /data-icon-source="craftwork-basil"/u,
      `${name} keeps the source attribution`,
    );
    assert.doesNotMatch(
      glyph,
      /ui-icon-(?:underlay|ink)|translate\(\.3 \.35\)/u,
      `${name} has one clean geometry pass`,
    );
  }

  // The fallback vendor mark is the one glyph outside ICONS that the panels
  // draw beside them at the same size, so it has to be cut the same way. It
  // was the last outlined drawing in this file.
  const fallback = ui.vendorMark("a-vendor-with-no-mark");
  assert.match(fallback, /fill="currentColor"/u, "the fallback mark is filled");
  assert.doesNotMatch(
    fallback,
    /stroke-width|stroke-linecap|stroke-linejoin/u,
    "the fallback mark draws no stroked geometry",
  );

  const chats = assets.get("/screen-chats.js")?.body.toString("utf8") ?? "";
  const styles = assets.get("/styles.css")?.body.toString("utf8") ?? "";
  const uiSource = assets.get("/ui.js")?.body.toString("utf8") ?? "";

  // One icon language, not two. Attribution pills used to carry small glossy
  // rendered objects from a set of their own, so a digest row put a shaded
  // blue folder beside a flat drawn agent mark — a difference the eye reads
  // as a mistake long before it reads it as a distinction. Everything except
  // the vendor logos, the agent sprites and the product mark now comes from
  // the one set above, and the second one is gone rather than unreferenced.
  assert.doesNotMatch(
    uiSource,
    /PILL_ART|pillIcon|3dicons/u,
    "attribution pills draw from the shared icon set",
  );
  assert.doesNotMatch(
    styles,
    /pill-3d/u,
    "the second icon set left no styling behind",
  );
  assert.match(styles, /\.pill \.ui-icon \{/u);

  assert.doesNotMatch(
    chats,
    /&times;/u,
    "remove controls use the shared close icon",
  );
  assert.match(chats, /const CHANGED_FILE_ICON/u);
  assert.doesNotMatch(
    styles,
    /\.thread-(?:summary|thinking)\s*>\s*summary::before/u,
  );
  assert.match(styles, /\.tt-caret \.ui-icon/u);
});

test("pinned messages can be hidden and shown without being unpinned", async () => {
  const data = await publicFile("data.js");
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const styles = await publicFile("styles.css");
  const header = chats.slice(
    chats.indexOf("function conversationHeader(repositoryId)"),
    chats.indexOf("/** Compatibility for callers while the conversation header"),
  );

  // The workspace owns the shortcut, in its own list of destinations beside
  // Threads and Files — what it opens is the main transcript's shelf whatever
  // has the conversation pane, so it is not the conversation header's to
  // carry. It owns it directly, so a hierarchy change cannot strand it behind
  // a selector for markup that no longer exists.
  const pins = chats.slice(
    chats.indexOf("function pinsQuickLink()"),
    chats.indexOf("function chanSidebar(activeRepositoryId)"),
  );
  assert.notEqual(pins, "", "the pins quick link should exist");
  assert.match(pins, /const pinsOpen = activeSecondaryContext\(\) === "pins";/u);
  assert.match(pins, /class="chan-quick-link ch-pins-toggle/u);
  assert.match(pins, /data-act="channel-pins-toggle"/u);
  assert.match(pins, /pinsOpen \? "Hide pinned messages" : "Show pinned messages"/u);
  assert.match(pins, /aria-pressed="\$\{pinsOpen\}"/u);
  assert.match(pins, /\$\{icon\("pin"\)\}<span>Pins<\/span>/u);
  // Drawn in the group the other two destinations are in, and nowhere else.
  assert.match(chats, /function chanSidebar[\s\S]*?\$\{pinsQuickLink\(\)\}/u);
  assert.doesNotMatch(header, /ch-pins-toggle|channel-pins-toggle/u);
  // The banner repaints the control's pressed state without a render, so the
  // class it looks for has to be the one the quick link carries.
  assert.match(
    app,
    /function paintPinnedMessagesShortcut\(open\)[\s\S]{0,200}querySelector\("\.ch-pins-toggle"\)/u,
  );

  // The delegated action uses the one secondary slot and never calls the
  // pin/unpin operation.
  const toggle = app.slice(
    app.indexOf('case "channel-pins-toggle"'),
    app.indexOf('case "channel-pinned-open"'),
  );
  assert.match(toggle, /activeSecondaryContext\(\) === "pins"/u);
  assert.match(toggle, /moveRightPanel\("pins", "right"\)/u);
  assert.match(toggle, /closeSecondaryContext\(\)/u);
  assert.match(toggle, /render\(\)/u);
  assert.doesNotMatch(toggle, /toggleChannelMessagePin/u);
  // Pins are drawn in the same secondary surface as threads and profiles,
  // rather than taking another strip out of the primary transcript.
  assert.match(chats, /function pinnedMessagesPanel\(repositoryId\)/u);
  assert.match(chats, /aria-label="Pinned messages"/u);
  assert.match(chats, /panelClose\("secondary-context-close"/u);
  assert.match(
    chats,
    /pins\.length === 0 \|\| state\.pinsOpen !== true/u,
  );
  assert.match(chats, /class="chan-pins open" aria-hidden="false"/u);
  assert.match(chats, /class="chan-pins-surface"/u);
  assert.match(chats, /chan-pins-list-frame" aria-hidden="false"/u);
  assert.match(styles, /\.pins-panel \.chan-pins \{[\s\S]*display: block/u);
  // The compact transcript shelf stays bounded, but the dedicated panel lets
  // its existing body scroller own the full list instead of nesting a short
  // scroller above unused space.
  assert.match(styles, /\.chan-pins-list \{[\s\S]*?max-height: 132px;/u);
  assert.match(
    styles,
    /\.pins-panel \.chan-pins-list \{[\s\S]*?max-height: none;[\s\S]*?overflow-y: visible;/u,
  );
  assert.match(styles, /\.thread-panel\.panel-entering \{[\s\S]*hierarchy-panel-in/u);
  assert.match(styles, /prefers-reduced-motion: reduce/u);

  // Fresh sessions start with the banner folded; readers unfold it when they
  // want to see pins, and the toggle remembers only for this visit.
  assert.match(data, /pinsOpen: false/u);
});

test("one play control beside the pin runs whatever the channel's app is", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");
  const css = await publicFile("styles.css");

  // Beside the pin, in the workspace's own list of destinations — and drawn
  // as a quick link rather than a tool button, because that is what every row
  // around it is and an unlabelled glyph among named rows would read as a
  // control that arrived by accident.
  const navStart = chats.indexOf(
    '<nav class="chan-sidebar-head chan-quick-links"',
  );
  assert.notEqual(navStart, -1, "the workspace destinations should exist");
  const nav = chats.slice(navStart, chats.indexOf("</nav>", navStart));
  assert.match(nav, /\$\{previewControl\(activeRepositoryId\)\}/u);
  assert.match(
    nav,
    /\$\{pinsQuickLink\(\)\}[\s\S]*?\$\{previewControl\(activeRepositoryId\)\}/u,
    "the pin and the play control are neighbours in the workspace's own list",
  );
  // The address follows the control that started it rather than sitting on
  // the conversation's row, where it was the one thing that grew without
  // limit.
  assert.match(
    nav,
    /\$\{previewControl\(activeRepositoryId\)\}[\s\S]*?\$\{previewLink\(activeRepositoryId\)\}/u,
  );
  const headerStart = chats.indexOf("function conversationHeader(repositoryId)");
  assert.notEqual(headerStart, -1, "the channel header should exist");
  // The whole function, not the stretch before the spacer — the muted mark
  // sits after it, so the old boundary cut away the part this looks at.
  const header = chats.slice(headerStart, chats.indexOf("\n}", headerStart));
  // And the header calls neither. It names the destination that has the pane
  // and carries what acts on that; the app a workspace runs is neither. The
  // comment left behind naming where they went is the point of leaving one,
  // so this looks for the calls rather than the words.
  assert.doesNotMatch(header, /previewControl\(|previewLink\(/u);
  // Nothing stands between the rows either. The separator existed to hold the
  // two roster counts apart from these controls; with the counts on the lists
  // they count, it divided the controls from nothing at all.
  assert.doesNotMatch(header, /<span aria-hidden="true">\|<\/span>/u);
  const control = chats.slice(
    chats.indexOf("function previewControl(repositoryId)"),
    chats.indexOf("function previewLink(repositoryId)"),
  );
  // The running state carries the "on" class; a build that did not finish
  // adds " warn" after it, so the class list does not end there.
  assert.match(control, /class="chan-quick-link ch-preview-toggle on/u);
  // Every state says which one it is in a word, so the row is readable
  // without hovering it.
  assert.match(control, /<span>Run app<\/span>/u);
  assert.match(control, /<span>Stop app<\/span>/u);
  assert.match(control, /<span>Starting…<\/span>/u);
  assert.match(control, /data-act="preview-stop"/u);
  assert.match(control, /data-act="preview-start"/u);
  assert.match(control, /icon\("play"\)/u);
  assert.doesNotMatch(control, /icon-btn/u);
  assert.match(css, /\.ch-preview-toggle \{/u);
  assert.match(css, /\.ch-preview-toggle\.on \{/u);
  assert.match(css, /\.ch-preview-toggle\.warn \{/u);

  // A preview that died on its own is not the same as one that was never
  // started, and the control is the only place that difference is reported.
  const stopped = chats.slice(
    chats.indexOf("function previewStopped(repositoryId)"),
    chats.indexOf("function previewControl(repositoryId)"),
  );
  assert.match(stopped, /preview\.exited !== undefined/u);
  assert.match(control, /stopped\.recentOutput/u);
  assert.match(control, /stopped === undefined \? "" : " warn"/u);
  assert.match(css, /\.ch-preview-toggle\.warn \{/u);

  // Nothing in the page decides how an app boots: it asks the control plane,
  // which reads the checkout. The one case detection cannot cover is asked
  // about and remembered, so a repository in any language starts from the
  // same button.
  assert.match(data, /export async function startPreview\(repositoryId\)/u);
  assert.match(data, /export async function stopPreview\(repositoryId\)/u);
  assert.match(
    data,
    /export async function setPreviewCommand\(repositoryId, command\)[\s\S]{0,200}method: "PUT"/u,
  );
  const start = app.slice(
    app.indexOf("async function startPreviewAction"),
    app.indexOf("async function stopPreviewAction"),
  );
  // Both refusals — nothing detectable, and something detected that died —
  // reach the same question. Matching only the second left every repository
  // the detector has never heard of with no way in at all.
  assert.match(start, /could\(\?: not\)\? be started/u);
  assert.match(start, /askPreviewCommand\(repositoryId, message\)/u);
  assert.match(start, /await setPreviewCommand\(repositoryId, command\)/u);
  assert.match(start, /startPreviewAction\(repositoryId, true\)/u);

  // A cold start installs dependencies and then builds, which is a minute of
  // a button that looks untouched — so it was pressed again, and the second
  // press replaced the attempt in flight: the build was killed and its death
  // reported as the repository exiting immediately. The second press is
  // refused, the control says it is busy, and the flag is cleared before the
  // question is asked so the answer can still be started.
  assert.match(start, /previewsStarting\.has\(repositoryId\)/u);
  assert.match(start, /previewsStarting\.add\(repositoryId\)/u);
  assert.match(start, /previewsStarting\.delete\(repositoryId\)/u);
  assert.ok(
    app.indexOf("previewsStarting.delete(repositoryId)") <
      app.indexOf("askPreviewCommand(repositoryId, message)"),
    "the in-flight flag must be cleared before the question is asked",
  );
  // Shared through `state`, because the control is drawn in screen-chats.js
  // and that file cannot import app.js back.
  assert.match(app, /state\.previewsStarting = previewsStarting/u);
  assert.match(control, /state\.previewsStarting\?\.has\(repositoryId\)/u);
  assert.match(control, /ch-preview-toggle starting/u);
  assert.match(control, /disabled/u);
  assert.match(css, /\.ch-preview-toggle\.starting \{/u);
  const ask = app.slice(
    app.indexOf("async function askPreviewCommand"),
    app.indexOf("async function startPreviewAction"),
  );
  assert.match(ask, /name="command"/u);
  assert.match(ask, /maxlength="500"/u);

  // Running but not answering yet is a real state and it settles by itself,
  // so the header stops saying "starting…" without anyone navigating away.
  const watch = app.slice(
    app.indexOf("async function watchPreviewReady"),
    app.indexOf("async function askPreviewCommand"),
  );
  assert.match(watch, /previewsWatched\.has\(repositoryId\)/u);
  assert.match(watch, /await loadPreview\(repositoryId\)/u);
  assert.match(watch, /preview\.ready !== false/u);
  assert.match(watch, /preview\.exited !== undefined/u);
  assert.match(app, /case "preview-start":\s*void startPreviewAction\(value\);/u);
  assert.match(app, /case "preview-stop":\s*void stopPreviewAction\(value\);/u);

  // A build the control plane guessed at is allowed to fail without stopping
  // the start, which is right and quietly produced the worst version of this:
  // a server serving a stale or missing bundle, a link that opens, and a
  // white page with nothing saying why. The reason is carried on the status,
  // so all three places that report on a preview say it.
  assert.match(start, /preview\?\.buildFailure/u);
  assert.match(start, /build did not finish/u);
  assert.match(control, /running\.buildFailure/u);
  assert.match(control, /partial === undefined \? "" : " warn"/u);
  const link = chats.slice(
    chats.indexOf("function previewLink(repositoryId)"),
    chats.indexOf("function conversationHeader(repositoryId)"),
  );
  assert.match(link, /preview\.buildFailure/u);
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
  return new Function(
    `${sourceOf(source, name, nextName)}\nreturn ${name};`,
  )() as T;
}

/**
 * One function's text, for the assertions that are about what it *says*
 * rather than what it returns.
 *
 * A function that reaches for `api`, `state` and `render` cannot be lifted
 * out and called — but its URL and its form field names are readable, and
 * those are exactly the halves nothing else checks.
 */
function sourceOf(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`\nfunction ${nextName}`, start);
  assert.notEqual(start, -1, `${name} was not found in app.js`);
  assert.notEqual(end, -1, `${nextName} was not found after ${name}`);
  return source.slice(start, end);
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

test("the admissions form saves to a route that exists, with every field on it", async () => {
  // Two failures nothing here could see, because every policy test lifted
  // `policyPayload` out and checked the body it builds.
  //
  // The body was always right. It was PATCHed to `/projects/{id}/policy`,
  // and there is no such route — every project sub-pattern in the gateway is
  // anchored, so it fell through to "Route was not found" and the entire
  // Admissions card saved nothing. And `savePolicy` read a
  // `requireChangesetReview` field the card never rendered, so the one
  // control that could have been set was submitted as `false` on every save.
  const source = await browserSource();
  const save = sourceOf(source, "savePolicy", "applyTheme");
  // Read out of the call rather than matched against the whole function, so
  // prose about the bug cannot satisfy the assertion about the fix.
  const url = /api\(\s*`([^`]*)`/u.exec(save)?.[1];
  assert.equal(
    url,
    "/projects/${encodeURIComponent(state.projectId)}",
    "the policy goes to the project route itself; no sub-route exists",
  );

  // Every field the save reads has to be a field the form renders, or it is
  // submitted as its empty value however the person set it.
  const card = sourceOf(source, "admissionsCard", "repositoryCard");
  const read = [...save.matchAll(/data\.get\("([^"]+)"\)/gu)].map(
    (match) => match[1],
  );
  assert.ok(read.length >= 7, `expected the whole form, saw ${String(read.length)}`);
  for (const field of read) {
    assert.match(
      card,
      new RegExp(`name="${String(field)}"`, "u"),
      `savePolicy reads ${String(field)}, which the form never renders`,
    );
  }
});

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

test("settings floats above the product routes", async () => {
  const source = await browserSource();
  const agentConnections = await publicFile("screen-agents.js");
  const styles = await publicFile("styles.css");
  const routes = /const ROUTES = new Set\(\[([\s\S]*?)\]\)/u.exec(source)?.[1];
  assert.notEqual(routes, undefined);
  const parsed = [...(routes ?? "").matchAll(/"([a-z]+)"/gu)].map(
    (match) => match[1],
  );
  // Settings and Advanced are categories in one modal, so neither can replace
  // the conversation as a router screen.
  assert.deepEqual(parsed, ["chats", "notifications"]);
  assert.match(source, /state\.settingsOpen === true \? settingsDialog\(\) : ""/u);
  assert.match(source, /role="dialog"[\s\S]{0,80}aria-modal="true"/u);
  assert.match(source, /data-act="settings-section"/u);
  // Code is read where it is discussed — files and diffs render inline in the
  // channel transcript — so neither it nor the coordinator is a page of its
  // own, and tasks still belong to the agent that owns them.
  assert.equal(
    /"my-tasks"|"activity"|"files"|"changes"|"code"|"coordinator"/u.test(
      routes ?? "",
    ),
    false,
  );
  // The retired roster route is neither renderable nor accepted by the
  // router. Old programmatic destinations therefore take the existing chats
  // fallback instead of preserving a hidden copy of the page.
  const productScreen = sourceOf(source, "screen", "billingBanner");
  assert.doesNotMatch(productScreen, /case "agents":/u);
  assert.doesNotMatch(source, /renderAgents|route: "agents"/u);
  assert.doesNotMatch(agentConnections, /renderAgents|<h1>My Agents<\/h1>/iu);
  assert.doesNotMatch(styles, /\.agents-split|\.agent-list-head/u);
  assert.match(source, /if \(!ROUTES\.has\(route\)\) \{\s*route = "chats";/u);
});

test("settings exposes theme and sound effect preferences", async () => {
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");
  const ui = await publicFile("ui.js");

  assert.match(app, /data-act="settings-theme"/u);
  assert.match(app, /\["system", "System"\]/u);
  assert.match(data, /export function myThemePreference\(\)/u);
  assert.match(data, /prefers-color-scheme: light/u);

  assert.match(app, /data-act="settings-sounds"/u);
  assert.match(app, /Quiet cues for sent and incoming messages/u);
  assert.match(app, /localStorage\.setItem\("ag\.messageSounds"/u);
  // The inline `=== "false"` early return inside `chime` became the
  // `soundEffectsEnabled()` predicate behind `contextForChime`, so arming and
  // playing both go through one reading of the preference. Opposite polarity,
  // same fact: sounds are on unless the browser was told otherwise. Both
  // halves are pinned, because a predicate nothing consults would still read
  // the preference while playing over a reader who asked for silence.
  assert.match(
    ui,
    /function soundEffectsEnabled\(\) \{\s*return window\.localStorage\.getItem\("ag\.messageSounds"\) !== "false";/u,
  );
  assert.match(ui, /function contextForChime\(\) \{\s*if \(!soundEffectsEnabled\(\)\)/u);
});

test("sound effects confirm real sends and reserve interruptions for live arrivals", async () => {
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");
  const ui = await publicFile("ui.js");

  // Incoming cues can play after the initial gesture, are coalesced when a
  // socket burst contains several messages, and still honour the one browser
  // preference that controls every sound.
  assert.match(ui, /export function armChime\(\)/u);
  assert.match(ui, /const CHIME_COOLDOWN_MS = 300/u);
  assert.match(ui, /received: \[660, 495\]/u);
  assert.match(ui, /success: \[523\.25, 659\.25, 783\.99\]/u);
  assert.match(app, /"pointerdown", armChime/u);

  // A duplicate direct-message socket echo is silent, as is this account's
  // outgoing copy. A newly added incoming copy is the only one that sounds.
  assert.match(data, /thread\.some\([\s\S]{0,100}return false;/u);
  assert.match(data, /return true;\s*\n\}/u);
  assert.match(app, /const added = noteDirectMessage\(frame\);/u);
  assert.match(
    app,
    /added && frame\.message\?\.recipientId === currentUserId\(\)/u,
  );

  // Channel history, edits, progress narration, and replayed frames stay
  // visual. Only a new conversational id found by a live reconcile cues once.
  assert.match(app, /const AUDIBLE_CHANNEL_KINDS = new Set/u);
  assert.doesNotMatch(
    app.slice(
      app.indexOf("const AUDIBLE_CHANNEL_KINDS"),
      app.indexOf("function audibleChannelEntryKeys"),
    ),
    /"progress"/u,
  );
  assert.match(app, /const canSound = !catchingUp;/u);
  assert.match(app, /\(key\) => !audibleBefore\.has\(key\)/u);
  assert.match(app, /canonical_promoted: "success"/u);
  assert.match(app, /approval_requested: "attention"/u);

  // The send cue follows validation/optimistic creation rather than firing on
  // an empty composer or a missing thread.
  const channelSubmit = chats.slice(
    chats.indexOf("export function submitComposerMessage"),
    chats.indexOf("function pinnedBanner"),
  );
  assert.doesNotMatch(channelSubmit, /submitComposerMessage\(rerender\) \{\s*chime/u);
  assert.match(channelSubmit, /if \(sent === undefined\) \{[\s\S]{0,80}chime\("sent"\)/u);
  const threadSubmit = chats.slice(
    chats.indexOf("export function submitThreadReply"),
    chats.indexOf("export function closeComposerAutocomplete"),
  );
  assert.match(threadSubmit, /if \(posted === undefined\) \{[\s\S]{0,80}chime\("sent"\)/u);
  assert.match(app, /text\.trim\(\) === "" \|\| state\.sending\[agent\.id\] === true/u);
  assert.match(app, /entry\.role === "assistant" && entry\.pending !== true/u);
});

test("the workspace rail stays visible when workspace navigation collapses", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");
  const sidebar = chats.slice(
    chats.indexOf("function chanSidebar"),
    chats.indexOf("/* ---------------------------------------------------------- chan main"),
  );
  const crown = chats.slice(
    chats.indexOf("function chanCrown"),
    chats.indexOf("function chanSidebar"),
  );
  const rail = chats.slice(
    chats.indexOf("function workspaceRail"),
    chats.indexOf("function channelRail"),
  );
  const header = chats.slice(
    chats.indexOf("function conversationHeader"),
    chats.indexOf("function threadParticipants"),
  );

  // The crown owns the desktop control while the sidebar is open. In a
  // multi-workspace layout that whole panel becomes zero-width when folded,
  // so a synchronized copy in the persistent rail is revealed as the way
  // back. A single-workspace layout has no rail and keeps the crown itself at
  // icon width; the phone keeps its separate off-canvas drawer button.
  assert.match(crown, /class="chan-crown workspace-sidebar-header"/u);
  assert.match(crown, /data-act="chan-collapse-toggle"/u);
  assert.match(rail, /class="icon-btn channel-rail-collapse"/u);
  assert.match(rail, /data-act="chan-collapse-toggle"/u);
  assert.match(rail, /aria-pressed="\$\{state\.chanCollapsed === true\}"/u);
  assert.match(rail, /aria-label="\$\{fold\}"/u);
  assert.match(sidebar, /\$\{chanCrown\(activeRepositoryId\)\}/u);
  assert.equal(
    chats.split('data-act="chan-collapse-toggle"').length - 1,
    2,
    "the crown and persistent workspace rail share the collapse action",
  );
  assert.match(header, /data-act="chan-sidebar-toggle"/u);

  // Account actions stay together behind the avatar; Settings is not repeated
  // as an adjacent icon.
  assert.match(sidebar, /class="chan-sidebar-foot"/u);
  assert.doesNotMatch(sidebar, /class="icon-btn chan-settings"/u);
  assert.match(sidebar, /class="chan-account" data-act="user-menu"/u);
  const userMenu = app.slice(
    app.indexOf('case "user-menu":'),
    app.indexOf('case "switch-close":'),
  );
  assert.match(app, /value: "settings", label: "Settings"/u);
  assert.match(userMenu, /\{ width: 184 \}/u);
  assert.match(css, /\.chats-shell\.chan-collapsed \.chan-sidebar-foot \{[\s\S]{0,120}grid-template-columns: 40px;/u);
  // The whole sidebar is one scroller: its crown, destinations, lists, and
  // account control travel together instead of leaving fixed fragments.
  assert.match(css, /::-webkit-scrollbar-corner \{\s*background: transparent;/u);
  assert.match(
    css,
    /\.chan-sidebar \{\s*width: var\(--chan-sidebar-w\);[\s\S]{0,500}display: block;[\s\S]{0,900}overflow-y: auto;/u,
  );
  assert.match(css, /\.chan-scroll \{\s*overflow: visible;/u);
  assert.match(css, /\.chan-sec \{\s*position: static;/u);
  assert.match(sidebar, /section\("People", "invite-repo"/u);
  assert.doesNotMatch(
    sidebar,
    />Profile<\/span>/u,
    "the account action should not repeat its destination as a subtitle",
  );

  // Workspaces and their pictures live in the dedicated rail. Collapsing the
  // adjacent tool/roster sidebar cannot hide that navigation surface.
  assert.match(chats, /function channelPictureMarkup/u);
  assert.match(
    chats,
    /function channelPictureMarkup[\s\S]*?const label = repositoryLabel\(repositoryId\);[\s\S]*?const initials = channelInitials\(label\);/u,
    "an unset channel picture should follow the repository's current display name",
  );
  assert.match(chats, /function workspaceRail/u);
  assert.match(chats, /class="channel-rail workspace-rail" aria-label="Workspaces"/u);
  assert.match(chats, /data-act="channel-picture-pick"/u);
  assert.match(chats, /\$\{rail \? channelRail\(repositoryId\) : ""\}/u);
  assert.match(
    css,
    /\.chats-shell\.chan-collapsed > \.chan-sidebar \{\s*width: 0;/u,
  );
  assert.match(
    css,
    /\.channel-rail-collapse \{\s*display: none;[\s\S]{0,160}width: 40px;[\s\S]{0,80}height: 40px;/u,
  );
  assert.match(
    css,
    /@media \(min-width: 601px\) \{\s*\.chats-shell\.chan-collapsed \.channel-rail-collapse \{\s*display: inline-grid;/u,
  );
  assert.match(
    css,
    /\.chats-shell\.no-rail\.chan-collapsed > \.chan-sidebar \{\s*width: var\(--rail-w\);/u,
  );
  assert.doesNotMatch(
    css,
    /\.chats-shell\.chan-collapsed[^}]*\.channel-rail[^}]*display: none;/u,
  );
  // And the room the reader is in is said three ways, because a rail of
  // near-identical marks cannot answer "which one am I in" with a hairline
  // and a tenth of an accent: a longer, thicker bar, a stronger wash, and a
  // ring around the mark itself.
  assert.match(
    css,
    /\.channel-rail-entry\.active::before \{[\s\S]{0,180}width: 3px;[\s\S]{0,140}background: var\(--salmon\);/u,
  );
  assert.match(
    css,
    /\.channel-rail-entry\.active \.channel-rail-button \{[\s\S]{0,200}var\(--salmon\) 16%[\s\S]{0,120}box-shadow: inset 0 0 0 1px/u,
  );
  assert.match(
    css,
    /\.chats-shell\.chan-collapsed \.chan-brand \{[\s\S]{0,260}opacity: 0;[\s\S]{0,80}visibility: hidden;/u,
  );
  assert.match(css, /\.chan-collapse-btn \{\s*flex: none;\s*margin-left: auto;/u);
  const sidebarRule = /\n\.chan-sidebar \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(sidebarRule, undefined, "the sidebar has a base layout rule");
  assert.match(
    sidebarRule ?? "",
    /transition: width var\(--motion-content\) var\(--ease-motion\);/u,
  );
  assert.doesNotMatch(
    css,
    /\.chan-sec \{\s*position: sticky;/u,
    "section headings should not remain behind when their lists scroll away",
  );

  // Changing the class on the existing shell gives the width transition an
  // actual before/after. Persistence and accessible state still update, but
  // this action must not replace the app with render().
  const collapseAction = app.slice(
    app.indexOf('case "chan-collapse-toggle"'),
    app.indexOf('case "roster-section-toggle"'),
  );
  assert.match(collapseAction, /classList\.toggle\(\s*"chan-collapsed"/u);
  assert.match(collapseAction, /persist\("ag\.chanCollapsed"/u);
  assert.match(collapseAction, /querySelectorAll\('\[data-act="chan-collapse-toggle"\]'\)/u);
  assert.match(collapseAction, /setAttribute\("aria-pressed"/u);
  assert.match(collapseAction, /setAttribute\("aria-label", label\)/u);
  assert.match(collapseAction, /setAttribute\("title", label\)/u);
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
  assert.match(chats, /class="chan-roster chan-roster-people/u);
  assert.match(chats, /class="chan-roster chan-roster-agents/u);
  assert.match(chats, /class="chan-roster-inner"/u);
  assert.match(chats, /section\("People",[^)]*"chan-sec-people"/u);
  assert.match(chats, /section\("Agents",[^)]*"chan-sec-agents"/u);

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
  assert.match(
    css,
    /\.chan-roster \{[\s\S]{0,320}grid-template-rows var\(--motion-content\)/u,
  );

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
    app.indexOf('case "roster-section-toggle"'),
  );
  assert.match(collapseAction, /markChanFolding\(shell\)/u);
  assert.match(app, /function markChanFolding\(/u);
  assert.match(app, /classList\.remove\("chan-folding"\)/u);
});

test("each roster is compact, unlabelled when empty, and folds on its heading", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");
  const css = await publicFile("styles.css");

  // People and agents are drawn at the same, smaller face — the two rosters
  // must not disagree about how big somebody in the room is.
  assert.match(chats, /avatar\(name, 22, name, me \? myAvatar\(\) : undefined\)/u);
  assert.match(chats, /agentFace\(agent, 22\)/u);
  assert.match(css, /\.roster-row \.status-dot \{[\s\S]{0,80}width: 6px;/u);
  assert.match(css, /\.roster-row-main \{[\s\S]{0,120}padding: 4px 8px;/u);

  // A role is shown when there is one and nothing is shown when there is
  // not: no row says that nothing has been said about it.
  assert.doesNotMatch(chats, /: "No role set"/u);
  assert.doesNotMatch(chats, /Your agent · no role set/u);
  assert.doesNotMatch(chats, /rr-role-empty/u);
  assert.doesNotMatch(css, /rr-role-empty/u);
  assert.match(chats, /agent\.role[\s\S]{0,80}<div class="rr-role">/u);

  // The heading is the control, the "+" beside it is still the one that adds,
  // and the fold reuses the collapse's own grid-row animation.
  assert.match(chats, /class="chan-sec-toggle"\s*\n?\s*data-act="roster-section-toggle"/u);
  assert.match(chats, /aria-expanded="\$\{open\}"/u);
  assert.match(chats, /class="chan-sec-add" data-act="\$\{act\}"/u);

  // "People · 3": the length of the list, on its heading. Outside the fold
  // button, because that button carries an explicit accessible name and
  // anything put inside it would never be read out; the separator beside the
  // figure is hidden from the accessibility tree because it says nothing.
  const heading = chats.slice(
    chats.indexOf("function section(label, act, value, title, cls, key, count)"),
    chats.indexOf("function chanCrown"),
  );
  assert.notEqual(heading, "", "section still takes a count");
  assert.match(heading, /class="chan-sec-count" title="\$\{count\} \$\{esc\(/u);
  assert.match(heading, /class="chan-sec-dot" aria-hidden="true"/u);
  assert.ok(
    heading.indexOf("</button>") < heading.indexOf("${tally}"),
    "the count is read as its own text, not swallowed by the fold button",
  );
  assert.match(
    heading,
    /count === undefined \|\| count === null\s*\?\s*""/u,
    "a section with nothing to count draws no figure",
  );
  assert.match(css, /\.chan-sec-count \{[\s\S]{0,220}margin-right: auto;/u);
  assert.match(css, /\.chan-sec-toggle \{[\s\S]{0,300}flex: 0 1 auto;/u);
  assert.match(
    css,
    /\.chan-roster\.chan-roster-closed \{[\s\S]{0,160}grid-template-rows: 0fr;/u,
  );
  assert.match(
    css,
    /\.chan-sec-closed \.chan-sec-toggle svg \{\s*transform: rotate\(-90deg\);/u,
  );

  // Remembered in this browser, and applied in place so the fold has a
  // before and an after to animate between.
  assert.match(data, /rosterSectionsOpen: rememberedRosterSections\(\)/u);
  assert.match(data, /stored\("ag\.rosterSectionsOpen", "\{\}"\)/u);
  const foldAction = app.slice(
    app.indexOf('case "roster-section-toggle"'),
    app.indexOf('case "chan-sidebar-close"'),
  );
  assert.match(foldAction, /persist\("ag\.rosterSectionsOpen"/u);
  assert.match(foldAction, /classList\.toggle\("chan-roster-closed"/u);
  assert.match(foldAction, /setAttribute\("aria-expanded"/u);
  assert.doesNotMatch(foldAction, /\brender\(\)/u);
});

test("channel message search and its empty tool tray are absent", async () => {
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  for (const source of [app, data, chats]) {
    assert.doesNotMatch(source, /chanMsgQuery|chanMsgSearchOpen/u);
  }
  assert.doesNotMatch(app, /channel-msg-search|chan-tools-toggle|ag\.chantools/u);
  assert.doesNotMatch(app, /Search the messages in this channel/u);
  assert.doesNotMatch(chats, /channel-msg-search|chan-search|chan-tools/u);
  assert.doesNotMatch(chats, /function matchesQuery|function chanSearchRow/u);
  assert.doesNotMatch(data, /chanToolsOpen|ag\.chantools/u);
  assert.doesNotMatch(css, /\.chan-search|\.chan-tools|chan-tool-(?:in|out)/u);

  // The transcript still renders every loaded message and keeps its ordinary
  // empty state now that no query can narrow the list.
  assert.match(chats, /const entries = channelMessagesFor\(repositoryId\);/u);
  assert.match(chats, /"No messages yet"/u);
  assert.match(chats, /\$\{messageList\(repositoryId\)\}/u);
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
    /\.chan-sidebar \{[^}]*transition: transform var\(--motion-panel\) var\(--ease-motion\);/u,
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
  // Both statements moved out of the case and into `openUserDirectMessage`,
  // which the case now delegates to so an agent panel is cleared on the same
  // path. Pinned in two halves rather than loosened: the case must still go
  // through the helper before it renders, and the helper must still forget the
  // reply target and shut the drawer — a shell that stayed open over the
  // conversation it just opened is the failure this guards.
  assert.match(dm, /openUserDirectMessage\(value\);\s*render\(\);/u);
  const openDm = app.slice(
    app.indexOf("function openUserDirectMessage"),
    app.indexOf("function showDirectMessageMenu"),
  );
  assert.match(openDm, /state\.dmReplyMessageId = undefined;[\s\S]{0,80}setChanDrawer\(false\);/u);
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
  assert.match(renderer, /class="thread-replies-flow"/u);
  // The panel never borrows the channel's avatar-to-thread path classes —
  // those belong to the room transcript only. Kept from the test this one
  // replaced, which is the only thing in it that was not already covered here.
  assert.doesNotMatch(renderer, /cmsg-thread-path/u);
  assert.doesNotMatch(renderer, /cmsg-thread-route/u);
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
  const channelEndCap =
    /\n\.cmsg-row\.cmsg-thread-path-end \.cmsg-thread-link::after \{([\s\S]*?)\n\}/u.exec(
      css,
    )?.[1];
  const panelBranch = /\n\.thread-root\.has-replies::after \{([\s\S]*?)\n\}/u.exec(
    css,
  )?.[1];
  assert.notEqual(channelStem, undefined, "the shared channel stem should exist");
  assert.notEqual(channelEnd, undefined, "the channel stem should end at its route");
  assert.notEqual(channelElbow, undefined, "each thread should branch from the stem");
  assert.notEqual(channelEndCap, undefined, "the final branch should close the path");
  assert.notEqual(panelBranch, undefined, "the open thread branch should exist");
  assert.match(channelElbow ?? "", /border-bottom-right-radius: 2px;/u);
  assert.match(channelElbow ?? "", /border-bottom-left-radius: 12px;/u);
  assert.match(panelBranch ?? "", /border-bottom-right-radius: 2px;/u);
  assert.match(panelBranch ?? "", /border-bottom-left-radius: 11px;/u);
  // The channel's line is drawn in pieces that overlap on purpose, so it can
  // only be painted in an opaque colour: `--border-strong` is translucent, and
  // every doubled pixel — each row join, each hook — showed as a darker patch
  // in a line that is meant to read as one continuous stroke. The panel's
  // branch is a single stroke that crosses nothing, so it keeps the token.
  for (const piece of [channelStem, channelEnd, channelElbow]) {
    assert.match(piece ?? "", /border-left: 2px solid var\(--cmsg-stem\);/u);
    assert.doesNotMatch(piece ?? "", /--border-strong/u);
  }
  assert.match(channelElbow ?? "", /border-bottom: 2px solid var\(--cmsg-stem\);/u);
  assert.match(panelBranch ?? "", /border-left: 3px solid var\(--border-strong\);/u);
  assert.match(panelBranch ?? "", /border-bottom: 3px solid var\(--border-strong\);/u);
  // Flattened against the surface the stroke is drawn on rather than given a
  // translucent value of its own, so overlaps keep one shade and the line
  // follows the row when hovering lightens it.
  assert.match(
    css,
    /--cmsg-stem: color-mix\(in srgb, var\(--muted\) 18%, var\(--room-tint\)\);/u,
  );
  assert.match(
    css,
    /--cmsg-stem: color-mix\(in srgb, var\(--muted\) 18%, var\(--bg-hover\)\);/u,
  );
  assert.match(channelStem ?? "", /top: -1px;/u);
  assert.match(channelStem ?? "", /bottom: -1px;/u);
  assert.match(
    channelEnd ?? "",
    /bottom: calc\(var\(--cmsg-face\) \/ 2 \+ 2px \+ 11px\);/u,
    "the stem's foot should be measured from the face it turns into",
  );
  assert.match(
    css,
    /\.cmsg-row\.cmsg-thread-path-start\.cmsg-thread-path-through::before \{\n  top: 48px;/u,
    "the connector should leave a small gap beneath the avatar",
  );
  assert.match(
    css,
    /\.cmsg-row\.cmsg-thread-path-start\.cmsg-thread-path-end\s+\.cmsg-thread-route::before \{\n  top: 39px;/u,
    "a single-task connector should use the same separated start",
  );
  // Written from the column variables rather than as the 12px they work out
  // to, which is what keeps the stem, the elbow and the final segment from
  // drifting apart when any of those three numbers moves.
  assert.match(
    channelElbow ?? "",
    /right: calc\(100% \+ var\(--cmsg-body-x\) - var\(--cmsg-stem-x\) - 20px\);/u,
  );
  assert.match(channelElbow ?? "", /width: 20px;/u);
  // The elbow turns out of the stem, so its own upright has to stand in the
  // stem's column. It is placed from its right edge, which means the gap plus
  // its width must land on the stem's offset — and it must be measured by the
  // border box, or the stroke hangs outside that width and the
  // turn steps sideways where it should read as one line.
  assert.match(channelElbow ?? "", /box-sizing: border-box;/u);
  const bodyX = Number(/--cmsg-body-x: (\d+)px;/u.exec(css)?.[1]);
  const stemX = Number(/--cmsg-stem-x: (\d+)px;/u.exec(css)?.[1]);
  const elbowWidth = Number(/width: (\d+)px;/u.exec(channelElbow ?? "")?.[1]);
  assert.equal(bodyX, 52, "the body column stays the avatar gutter");
  assert.equal(stemX, 20, "the stem sits a little further left for spacing");
  assert.equal(
    bodyX - stemX - elbowWidth,
    12,
    "the elbow should leave twelve pixels between the stem and the link",
  );
  assert.equal(
    bodyX - stemX,
    elbowWidth + 12,
    "the elbow's upright should sit in the stem's own column",
  );
  assert.match(channelEndCap ?? "", /width: 2px;/u);
  assert.match(channelEndCap ?? "", /height: 2px;/u);
  assert.match(channelEndCap ?? "", /border-radius: 50%;/u);
  assert.match(channelEndCap ?? "", /background: var\(--cmsg-stem\);/u);
  assert.match(channelEndCap ?? "", /right: calc\(100% \+ 10px\);/u);
  // The hook is only the quarter turn: a straight upright here would be
  // painted on top of the shared stem and make every branch visibly thicker.
  // Every piece of the join is measured from the replier's face — the one
  // part of the summary whose height never changes — rather than from a line
  // box that gains a second line whenever an agent is working.
  const faceSize = Number(/--cmsg-face: (\d+)px;/u.exec(css)?.[1]);
  assert.equal(faceSize, 20, "the branch turns into the 20px replier face");
  const stemEnd = Number(
    /bottom: calc\(var\(--cmsg-face\) \/ 2 \+ 2px \+ (\d+)px\);/u.exec(
      channelEnd ?? "",
    )?.[1],
  );
  const elbowTop = Number(
    /top: calc\(50% - (\d+)px\);/u.exec(channelElbow ?? "")?.[1],
  );
  const elbowHeight = Number(/height: (\d+)px;/u.exec(channelElbow ?? "")?.[1]);
  const elbowRadius = Number(
    /border-bottom-left-radius: (\d+)px;/u.exec(channelElbow ?? "")?.[1],
  );
  assert.equal(elbowHeight, 12, "the hook should stay a compact turn");
  assert.equal(
    elbowHeight,
    elbowRadius,
    "the hook should be a circular corner like the open thread panel",
  );
  assert.equal(
    stemEnd,
    elbowTop,
    "the final stem should stop at the hook's tangent",
  );
  // A two-pixel stroke whose lower pixel is the link's middle is a stroke
  // centred on it, and the faces are the only thing that middle is measured
  // from — so the line crosses the replier's face on its own centre rather
  // than leaving the face hanging below it.
  assert.equal(
    elbowHeight - elbowTop,
    1,
    "the elbow's horizontal run should be centred on the replier's face",
  );
  assert.match(
    channelEndCap ?? "",
    /top: calc\(50% - 1px\);/u,
    "the round cap should close the run on that same centre line",
  );
  assert.doesNotMatch(css, /\.cmsg-row\.cmsg-threaded::before/u);
  assert.match(panelBranch ?? "", /left: 15px;/u);
  assert.match(panelBranch ?? "", /top: 48px;/u);
  assert.match(panelBranch ?? "", /width: 11px;/u);
  // And the foot of that branch reaches into the air the replies keep above
  // themselves rather than into a caption that no longer exists.
  assert.match(panelBranch ?? "", /bottom: -8px;/u);
  const repliesFlow = /\n\.thread-replies-flow \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(repliesFlow ?? "", /padding-top: 10px;/u);
});

test("a thread says what it is without a connector drawn to it", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  const rendererStart = chats.indexOf("function threadReplies");
  const rendererEnd = chats.indexOf("\n/**\n * How much summary", rendererStart);
  const renderer = chats.slice(rendererStart, rendererEnd);

  // Inside the open thread panel the conversation is a named section holding a
  // flow of replies, and nothing else. That panel never borrows the channel's
  // avatar-to-thread path classes — those belong to the room transcript only.
  assert.match(renderer, /class="thread-replies"/u);
  assert.match(renderer, /class="thread-replies-flow"/u);
  assert.doesNotMatch(renderer, /cmsg-thread-path/u);
  assert.doesNotMatch(renderer, /cmsg-thread-route/u);

  // The panel keeps its own single branch. It crosses nothing, joins nothing,
  // and is drawn once — it was never the channel bracket.
  const panelBranch = /\n\.thread-root\.has-replies::after \{([\s\S]*?)\n\}/u.exec(
    css,
  )?.[1];
  assert.notEqual(panelBranch, undefined, "the open thread branch should exist");
  assert.match(panelBranch ?? "", /border-left: 3px solid var\(--border-strong\);/u);
  assert.match(panelBranch ?? "", /border-bottom: 3px solid var\(--border-strong\);/u);
  assert.match(panelBranch ?? "", /border-bottom-left-radius: 11px;/u);
  assert.match(panelBranch ?? "", /left: 15px;/u);
  assert.match(panelBranch ?? "", /top: 48px;/u);
  assert.match(panelBranch ?? "", /width: 11px;/u);
  // The caption the branch used to end at is gone, and so is the hairline that
  // trailed off the end of it — see the reply-count test in
  // thread-panel-chrome.test.ts.
  assert.doesNotMatch(css, /\.thread-replies-head/u);
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
  // The old anchor was a `threadedTasks` Set at the top of `messageList`,
  // which was about drawing one changed-file summary per task rather than
  // about the timeline; it went with the room's changed-files bar. The rule
  // this line has always meant lives in the loop that folds replies into the
  // flat transcript: a user root that has been promoted to a thread does not
  // spill its replies back into the room.
  assert.match(
    list,
    /entry\.kind !== "user" \|\|\s*\(entry\.taskId !== undefined && \(entry\.replies \?\? \[\]\)\.length > 0\)/u,
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

test("the thread library shows its creator, participants, and latest activity", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  const panel = chats.slice(
    chats.indexOf("function threadListPanel("),
    chats.indexOf("function threadPanel("),
  );

  assert.match(panel, /const creator = channelAuthor\(repositoryId, entry\);/u);
  assert.match(
    panel,
    /threadParticipants\(\[entry, \.\.\.replies\], repositoryId\)/u,
    "the participant stack should include every unique author in the thread",
  );
  assert.match(panel, /class="ti-creator"/u);
  assert.match(panel, /class="avatar-stack ti-participants"/u);
  assert.match(panel, /const updated = relativeTime\(lastActivity\(entry\)\);/u);
  assert.match(panel, /class="ti-count"[\s\S]*class="ti-time"/u);
  assert.doesNotMatch(panel, /ti-done|icon\("check"\)/u);
  assert.match(css, /\.thread-item \.ti-participants \{[\s\S]*?margin-left: auto;/u);
  assert.doesNotMatch(css, /\.thread-item-ended \.ti-done/u);
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
  // than shrinking under the name. That box is now also given a size of its
  // own — see the compact-header test in thread-panel-chrome.test.ts — so it
  // is the declaration that is pinned here, not the whole rule.
  const tools = /\n\.thread-head \.icon-btn \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(tools ?? "", /flex: none;/u);
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

test("Settings Agents rows show the provider, then Connected as the call sign", async () => {
  const app = await publicFile("app.js");
  const start = app.indexOf("function agentsCard()");
  assert.notEqual(start, -1);
  const body = app.slice(start, app.indexOf("\nfunction commitAgentRename", start));
  // Title is the vendor label (Claude), not the kumi name that used to sit
  // there and hide which provider the row was for.
  assert.match(body, /sr-title.*\$\{esc\(agentLabelOf\(agent\.id\)\)\}/u);
  // A named connection says who it is connected as — the call sign — rather
  // than the opaque "you".
  assert.match(
    body,
    /agent\.hasName === true\s*\?\s*`Connected as \$\{agent\.name\}`\s*:\s*"Connected as you"/u,
  );
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

test("connect buttons show a busy state until the server answers or a modal opens", async () => {
  const app = await publicFile("app.js");
  const agents = await publicFile("screen-agents.js");
  const chat = await publicFile("chat.js");
  const css = await publicFile("styles.css");

  assert.match(app, /const providerConnecting = new Set\(\)/u);
  assert.match(app, /state\.providerConnecting = providerConnecting/u);
  assert.match(agents, /providerConnecting\?\.add\(providerId\)/u);
  assert.match(agents, /providerConnecting\?\.delete\(providerId\)/u);
  assert.match(agents, /providerConnecting\?\.add\("github"\)/u);
  assert.match(agents, /providerConnecting\?\.delete\("github"\)/u);

  const agentsCard = app.slice(
    app.indexOf("function agentsCard()"),
    app.indexOf("function commitAgentRename"),
  );
  assert.match(agentsCard, /providerConnecting\?\.has\(agent\.id\)/u);
  assert.match(agentsCard, /connecting/u);
  assert.match(agentsCard, /disabled/u);
  assert.match(agentsCard, /aria-busy="true"/u);

  const githubCard = app.slice(
    app.indexOf("function githubCard()"),
    app.indexOf("function agentsCard()"),
  );
  assert.match(githubCard, /providerConnecting\?\.has\("github"\)/u);
  assert.match(githubCard, /connecting/u);

  const composer = chat.slice(
    chat.indexOf("export function chatComposer"),
    chat.indexOf("export function chatPanel"),
  );
  assert.match(composer, /providerConnecting\?\.has\(agent\.id\)/u);
  assert.match(composer, /connecting/u);

  assert.match(css, /\.btn\.connecting \{/u);
  assert.match(css, /animation: pulse 2\.4s ease-in-out infinite/u);
});

test("adding another agent always begins with a provider choice", async () => {
  const app = await publicFile("app.js");
  const agents = await publicFile("screen-agents.js");
  const css = await publicFile("styles.css");

  // Every Add Agent control reaches the same modal instead of an anchored
  // menu whose available rows can be exhausted by the first connection.
  assert.match(agents, /export async function startAddAgentFlow/u);
  assert.match(agents, /title: "Add an agent"/u);
  assert.match(agents, /name="providerChoice"/u);
  assert.match(agents, /name="providerId"/u);
  assert.match(agents, /await connectAgent\(providerId, rerender\)/u);
  assert.match(
    app,
    /case "agent-add":\s*\n\s*closePopover\(\);\s*\n\s*void startAddAgentFlow\(render\);/u,
  );

  // A connection belongs to this account. A host CLI login (`connected`) is
  // not a reason to hide it, and an existing account credential remains in
  // the stable list as a disabled Connected row.
  assert.match(agents, /provider\.ownCredential !== undefined/u);
  assert.match(agents, /connected \? "Connected"/u);
  assert.doesNotMatch(
    agents,
    /available = providers\.filter\([\s\S]{0,160}provider\.connected/u,
  );

  // The channel sidebar plus must keep a live way to connect another provider
  // even when its only current agent is the disabled "already here" row.
  const channelMenuStart = app.indexOf('case "channel-agent-menu"');
  const channelMenu = app.slice(
    channelMenuStart,
    app.indexOf('case "channel-agent-pick"', channelMenuStart),
  );
  assert.notEqual(channelMenuStart, -1);
  assert.match(
    channelMenu,
    /agent\.mine === true && agent\.connected === true/u,
  );
  assert.match(channelMenu, /disabled: inChannel\.has\(agent\.id\)/u);
  assert.match(channelMenu, /act: "agent-add"/u);
  assert.match(channelMenu, /Connect another agent/u);

  assert.match(css, /\.agent-provider-picker \{/u);
  assert.match(css, /\.agent-provider-choice:has\(input:checked\)/u);
  assert.match(css, /\.agent-provider-choice\.is-connected/u);
  assert.match(
    css,
    /@media \(max-width: 520px\) \{\s*\.agent-provider-picker \{\s*grid-template-columns: 1fr;/u,
  );
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

test("an empty, unfocused composer keeps the same card layout", async () => {
  const css = await publicFile("styles.css");
  const shape = /\n\.composer \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(shape, undefined, "the composer has a shared card rule");
  assert.match(shape ?? "", /--composer-layout: block;/u);
  assert.match(shape ?? "", /--composer-bar-layout: flex;/u);
  assert.match(shape ?? "", /background: var\(--surface-3\);/u);
  assert.match(shape ?? "", /border: 1px solid var\(--border-soft\);/u);
  assert.match(shape ?? "", /border-radius: var\(--composer-shape\);/u);
  // The empty state only mutes the arrow. It does not swap display modes or
  // hide utilities, so focus never moves the caret or controls.
  assert.doesNotMatch(
    css,
    /\.composer:not\(\.is-expanded\):not\(:focus-within\):has\(textarea:placeholder-shown\)[\s\S]{0,180}(?:--composer-layout|display: none)/u,
  );
  assert.doesNotMatch(css, /--composer-bar-layout: contents;/u);
  // Textarea and mirror still read the exact same padding variables.
  assert.match(
    css,
    /\.composer-field textarea,\s*\.composer-mirror \{\s*padding: var\(--composer-pad-top\) var\(--composer-pad-x\) var\(--composer-pad-bottom\);/u,
  );
  assert.match(css, /--composer-shape: var\(--radius-lg\);/u);
  assert.match(css, /\.composer-bar \.spacer \{\s*display: var\(--composer-spacer-layout/u);
});

test("the composer is one card with bottom utilities and a send arrow", async () => {
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
  // A lighter surface and subtle edge make one structured card; the utility
  // row stays at its foot and the send action is a simple salmon arrow.
  const shape = /\n\.composer \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(shape, undefined, "the composer has a shape rule");
  assert.match(shape ?? "", /background: var\(--surface-3\);/u);
  assert.match(shape ?? "", /box-shadow: var\(--shadow-card\);/u);
  assert.match(shape ?? "", /--composer-shape: var\(--radius-lg\);/u);
  assert.match(shape ?? "", /--composer-spacer-layout: block;/u);
  // Focus only firms the edge; it must not paint the pink wash that used to
  // ring the card. Mention-active salmon rings stay on their own wrappers.
  const focus = /\n\.composer:focus-within \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(focus, undefined, "focused composer has an active rule");
  assert.match(focus ?? "", /border-color: var\(--border-strong\);/u);
  assert.match(focus ?? "", /box-shadow: var\(--shadow-card\);/u);
  assert.doesNotMatch(focus ?? "", /--accent-line|--accent-wash/u);
  assert.match(css, /\.composer-bar \.spacer \{\s*display: var\(--composer-spacer-layout/u);
  assert.match(
    css,
    /\.send-btn \{[\s\S]{0,260}background: transparent;[\s\S]{0,80}color: var\(--salmon\);/u,
  );
  // A paper plane, not an arrow. The arrow was the same picture as "next",
  // and the composer's primary action should not read as a navigation mark —
  // ui.js says so where the icon is defined. Asserted as the two closed
  // halves and the fold left open between them, loosely enough that the
  // plane may be redrawn and tightly enough that a bar-and-chevron arrow put
  // back here fails. The fold is that gap rather than a drawn crease,
  // because a stroke beside these fills would be the only one in the set.
  const icons = await publicFile("ui.js");
  const send = /\n {2}send: S\(\n([\s\S]*?)\n {2}\),/u.exec(icons)?.[1];
  assert.notEqual(send, undefined, "the send icon is still drawn inline");
  assert.equal(
    (send ?? "").match(/<path d="M[\d.]+ [\d.]+A[^"]+Z"\/>/gu)?.length,
    2,
    "the plane is two closed halves with the fold open between them",
  );
  assert.doesNotMatch(send ?? "", /stroke|d="M[\d.]+ 12h[\d.]+"/u);
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

test("the composer placeholder names the room it will post into", async () => {
  const source = await publicFile("screen-chats.js");
  const start = source.indexOf("function composer(repositoryId)");
  const body = source.slice(start, source.indexOf("\n}", start));

  // It used to say "Message Main chat", which stopped being a place when
  // rooms arrived: the composer posts into whichever room is open, and a
  // placeholder naming a destination that no longer exists is a lie about
  // where the message is going.
  assert.doesNotMatch(body, /Message Main chat/u);
  assert.match(
    body,
    /Message \$\{subChannelLabel\(\s*repositoryId,\s*activeSubChannelId\(repositoryId\),?\s*\)\}/u,
  );
  // Including when the repository has only one room. That case used to fall
  // back to the workspace's own name, so an undivided repository read exactly
  // as it did before rooms existed — which was right until the header started
  // naming the room. A reader then saw "#general" above the transcript and
  // "#acme-app" in the box below it: two names for one place.
  assert.doesNotMatch(body, /Message #\$\{repositoryLabel\(repositoryId\)\}/u);
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
});

/**
 * The bug: two people each with a Codex connected opened two agent panels and
 * saw one identical history, down to the timestamp.
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

  // Both halves live in one place so every caller agrees about who did what.
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

test("several agents at work are one sentence, not one sentence each", async () => {
  const chats = await publicFile("screen-chats.js");
  const nameList = extract<(names: string[]) => string>(
    chats,
    "nameList",
    "typingIndicator",
  );

  assert.equal(nameList(["Zeus"]), "Zeus");
  assert.equal(nameList(["Zeus", "Athena"]), "Zeus & Athena");
  assert.equal(
    nameList(["Zeus", "Athena", "Hermes"]),
    "Zeus, Athena, & Hermes",
  );

  // Three busy agents used to read "Zeus is thinking · Athena is thinking ·
  // Hermes is thinking" — one clause per name, announced three times over.
  const indicator = chats.slice(
    chats.indexOf("function typingIndicator("),
    chats.indexOf("\nfunction loadEarlierControl("),
  );
  assert.match(
    indicator,
    /\$\{nameList\(busy\)\} \$\{busy\.length === 1 \? "is" : "are"\} thinking/u,
  );
  assert.equal(
    /busy\.map\(/u.test(indicator),
    false,
    "the busy names should not each carry their own verb",
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
    providerUsage: Record<
      string,
      {
        loading?: boolean;
        unavailableReason?: string;
        windows?: { label?: string; percentUsed?: number }[];
      }
    >;
  };
  agentStatus: (
    agent: {
      id: string;
      provider: string;
      userId: string;
      visibility: string;
      mine?: boolean;
    },
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

test("a teammate's busy frame leaves this account's same-provider agent idle", async () => {
  const data = await liveness();
  data.state.tasks = [];
  data.state.agentBusy = {};
  data.noteAgentBusy({
    repositoryId: "repo",
    userId: "u2",
    provider: "openai",
    taskId: "task-u2",
  });

  assert.equal(
    data.agentStatus({ ...LIVENESS_AGENT, mine: true }, "repo"),
    "idle",
    "the viewer's Codex must not inherit a teammate's busy frame",
  );
  assert.equal(
    data.agentStatus(
      {
        id: "u2:openai",
        provider: "openai",
        userId: "u2",
        visibility: "org",
      },
      "repo",
    ),
    "working",
  );
});

test("red is a private agent and grey is an account with nothing left", async () => {
  const data = await liveness();
  data.state.tasks = [];
  data.state.agentBusy = {};
  data.state.providerUsage = {};

  const mine = { ...LIVENESS_AGENT, mine: true, visibility: "personal" };
  assert.equal(data.agentStatus(mine, "repo"), "personal");

  // Grey is a spent limit, read from the report the profile card fetches and
  // filed under the same key: the bare vendor for one's own agent.
  data.state.providerUsage = {
    openai: { windows: [{ label: "Weekly", percentUsed: 100 }] },
  };
  assert.equal(data.agentStatus(mine, "repo"), "exhausted");

  // A teammate's agent of the same vendor reads its owner's figures, not
  // this account's — the key carries the owner for exactly that reason.
  assert.equal(data.agentStatus(LIVENESS_AGENT, "repo"), "idle");
  data.state.providerUsage["u1:openai"] = {
    windows: [
      { label: "5-hour", percentUsed: 42 },
      { label: "Weekly", percentUsed: 100 },
    ],
  };
  assert.equal(
    data.agentStatus(LIVENESS_AGENT, "repo"),
    "exhausted",
    "any one window at its ceiling stops the work",
  );

  // A question that has not been answered is not an answer: a report still
  // in flight, or one that could not be read, must not grey the dot.
  data.state.providerUsage = { openai: { loading: true } };
  assert.equal(data.agentStatus(mine, "repo"), "personal");
  data.state.providerUsage = {
    openai: { unavailableReason: "No usage reported." },
  };
  assert.equal(data.agentStatus(mine, "repo"), "personal");

  // Working still wins over both. What is happening now is the thing the
  // reader cannot find out any other way.
  data.state.providerUsage = {
    "u1:openai": { windows: [{ percentUsed: 100 }] },
  };
  data.state.tasks = [livenessTask()];
  assert.equal(data.agentStatus(LIVENESS_AGENT, "repo"), "working");
});

test("a face and a roster row agree on what each dot colour means", async () => {
  const ui = await publicFile("ui.js");
  const css = await publicFile("styles.css");

  // The face's badge is looked up from the status rather than folded into
  // "offline", which is what used to paint a private agent grey.
  assert.match(
    ui,
    /const presence = Object\.hasOwn\(FACE_PRESENCE, status\)\s*\n\s*\? FACE_PRESENCE\[status\]\s*\n\s*: "offline";/u,
  );
  assert.match(ui, /personal: "personal",/u);
  assert.match(ui, /exhausted: "exhausted",/u);

  // Red for private, grey for out of usage — in both dot vocabularies.
  assert.match(
    css,
    /\.status-personal,\s*\n\.status-away \{\s*\n\s*background: var\(--danger/u,
  );
  assert.match(
    css,
    /\.status-exhausted \{\s*\n\s*background: var\(--text-4/u,
  );
  assert.match(
    css,
    /\.presence-personal \{\s*\n\s*background: var\(--danger/u,
  );
  assert.match(
    css,
    /\.presence-exhausted \{\s*\n\s*background: var\(--text-4\);/u,
  );

  // Neither new state moves, the way both did while they were drawn offline.
  assert.match(
    css,
    /\.agent-face\[data-presence="personal"\] svg,[\s\S]{0,200}\.agent-face\[data-presence="exhausted"\] svg \* \{\s*\n\s*animation: none;/u,
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

  // The private chat uses the avatar's single indicator; it must not add a
  // second coloured dot beside the status word.
  const chatHeader = chat.slice(
    chat.indexOf("export function chatHeader"),
    chat.indexOf("export function chatProgress"),
  );
  assert.match(chatHeader, /agentFace\(agent, 34, \{ status: agent\.status, progress \}\)/u);
  assert.doesNotMatch(chatHeader, /<span class="dot/u);

  // The full agents screen still writes a separate status word and dot, and
  // an idle connection remains amber there rather than green.
  assert.match(agents, /agent\.presence === "idle"\s*\?\s*"orange"/u);

  // And the count that opens the agents screen says what it counts.
  assert.match(agents, /label: "Connected agents",/u);
  assert.equal(
    /label: "Active agents",/u.test(agents),
    false,
    "a stored credential is not an active agent",
  );
});

test("working agent faces fill the mark itself with the run's progress", async () => {
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");
  const ui = await publicFile("ui.js");
  const css = await publicFile("styles.css");
  const row = chats.slice(
    chats.indexOf("function rosterRow(agent)"),
    chats.indexOf('/**\n * What the "..." on a roster row offers'),
  );

  assert.match(row, /statusAgentFace\(agent, 22, activeChannelId\(\)\)/u);
  assert.doesNotMatch(row, /statusDot\(/u);

  // One run, one mark, wherever it is met. The sidebar roster above, the room's
  // thread summary and the thread list all hand the same face the same reading
  // of the same run, so the answer to "how far along" does not change shape
  // between the three places somebody looks for it.
  const runMark = chats.slice(
    chats.indexOf("function threadRunMark(entry, repositoryId, fallbackAuthor)"),
    chats.indexOf("function threadListPanel(repositoryId)"),
  );
  assert.notEqual(runMark, "", "a thread row should draw a run of its own");
  assert.match(runMark, /threadWorkingAuthor\(entry, repositoryId\) \?\? fallbackAuthor/u);
  assert.match(runMark, /threadProgress\(entry\) \?\? 0/u);
  assert.match(
    runMark,
    /agentFace\(author\.agent, 16, \{\s*status: "working",\s*progress,\s*\}\)/u,
    "a running thread row fills the agent's own mark, not a dot of its own",
  );
  // The bare dot is the fallback for a run whose agent is not known yet, and
  // nothing else: the row markup reaches it only through the mark above.
  const list = chats.slice(
    chats.indexOf("function threadListPanel(repositoryId)"),
    chats.indexOf("function threadPanel(repositoryId, selectedMessageId)"),
  );
  assert.doesNotMatch(list, /ti-live/u);
  assert.match(list, /threadRunMark\(entry, repositoryId, author\)/u);

  // The status badge is drawn whether or not a run is going: progress moved
  // off it, so it is no longer the thing being replaced while work happens.
  assert.match(ui, /<i class="presence presence-\$\{presence\}"><\/i>/u);
  // The sweep carries a second copy of the same mark, which is the only way
  // the fill can be the logo rather than a shape beside it.
  assert.match(
    ui,
    /working\s*\n?\s*\? `<i class="agent-run" aria-label="Working">\$\{vendorMark\(kind\)\}<\/i>`/u,
  );

  const faceFillLayer = /\.agent-face \.agent-run \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(faceFillLayer, undefined, "a working face should carry a fill layer");
  // A pie chart clipped out of the mark itself: the sector the run has reached
  // is kept and the rest of the bright copy is cut away.
  assert.match(
    faceFillLayer ?? "",
    /mask: conic-gradient\(#000 calc\(var\(--run, 0\) \* 1%\), transparent 0\);/u,
  );
  assert.match(faceFillLayer ?? "", /inset: 0;/u);
  // Nothing is drawn around the mark any more — no ring, no disc behind it.
  assert.doesNotMatch(faceFillLayer ?? "", /background:|border-radius: 50%;/u);
  assert.doesNotMatch(faceFillLayer ?? "", /radial-gradient\(/u);
  assert.doesNotMatch(css, /\.agent-face \.agent-run::after \{/u);

  // The unfilled mark glimmers the way live status copy does: the same
  // travelling band on the same clock, held back over part of the dark mark so
  // the shimmer runs across what is still unbrightened rather than the fill.
  const faceFillSweep = /\.agent-face-working > svg \{([\s\S]*?)\n\}/u
    .exec(css)?.[1];
  assert.notEqual(faceFillSweep, undefined, "a live unfilled mark should carry a sweep");
  assert.match(faceFillSweep ?? "", /mask-size: 250% 100%;/u);
  assert.equal(
    (faceFillSweep ?? "").match(
      /#000 0 38%,\s+rgba\(0, 0, 0, 0\.4\) 48%,\s+#000 58% 100%/gu,
    )?.length,
    2,
    "both mask forms should dim the travelling band instead of brightening it",
  );
  assert.match(
    faceFillSweep ?? "",
    /animation: agent-run-sweep 2\.4s ease-in-out infinite;/u,
  );
  assert.match(css, /@keyframes agent-run-sweep \{/u);
  // The bright fill itself no longer carries the sweep — that belongs on the
  // dim base mark underneath.
  assert.doesNotMatch(css, /\.agent-face \.agent-run > svg \{/u);

  // The mark below stays dark and low, lifting a little as the fill grows.
  const faceFill = /\.agent-face-working > svg \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(faceFill, undefined, "an unfilled mark should read as dark");
  assert.match(faceFill ?? "", /opacity: calc\(0\.24 \+ var\(--run, 0\) \* 0\.0016\);/u);
  assert.match(faceFill ?? "", /filter: saturate\(0\.6\) brightness\(0\.8\);/u);

  // The ordinary status dot keeps the roster's size, and the transcript keeps
  // its smaller one — none of that moved when progress left the badge.
  const idleDot = /\.agent-face \.presence \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(idleDot ?? "", /width: 9px;/u);
  assert.match(idleDot ?? "", /height: 9px;/u);

  const roomDot = /\.cmsg-row \.cmsg-avatar \.agent-face \.presence \{([\s\S]*?)\n\}/u
    .exec(css)?.[1];
  assert.notEqual(roomDot, undefined, "a face in a room sizes its own dot");
  assert.match(roomDot ?? "", /width: 7\.5px;/u);
  assert.match(roomDot ?? "", /height: 7\.5px;/u);
  assert.match(roomDot ?? "", /border-width: 1px;/u);

  // The fill is the mark, so a smaller face needs no rule of its own for it.
  assert.doesNotMatch(
    css,
    /\.cmsg-row \.cmsg-avatar \.agent-face \.agent-run \{/u,
  );

  // Threads reuse the room transcript markup and now want the same badge the
  // room does, so the panel no longer sizes one of its own — the override that
  // used to lift a halved room dot back up would be a rule restating what it
  // inherits.
  assert.doesNotMatch(
    css,
    /\.thread-panel \.cmsg-row \.cmsg-avatar \.agent-face \.presence \{/u,
    "a face in a thread should inherit the room's badge size",
  );

  assert.doesNotMatch(
    css,
    /\.thread-panel \.cmsg-row \.cmsg-avatar \.agent-face \.agent-run \{/u,
  );

  const progress = data.slice(
    data.indexOf("export function agentWorkingProgress"),
    data.indexOf("function agentIsWorking"),
  );
  assert.match(progress, /return task === undefined \? 0 : taskProgress\(task\);/u);
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
  assert.equal(pairs.length, 9, "eight named agents plus a fallback");

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

test("catch-up pills use each named agent's actual mark", async () => {
  const ui = await publicFile("ui.js");
  const chats = await publicFile("screen-chats.js");
  const pillStart = ui.indexOf("export function pillBar");
  const pillBody = ui.slice(pillStart, ui.indexOf("\n}\n", pillStart));
  const catchUpStart = chats.indexOf("function catchUpPanel()");
  const catchUpBody = chats.slice(
    catchUpStart,
    chats.indexOf("\n/**", catchUpStart),
  );

  assert.match(
    pillBody,
    /agentFace\(pill\.agent, 18, \{ showPresence: false \}\)/u,
  );
  assert.match(catchUpBody, /agent: worker/u);
  assert.doesNotMatch(catchUpBody, /workers\.values|touched/u);

  // Naming an agent is enough: a pill that says it is an agent's takes the
  // agent's mark even where the record behind it is missing, so there is no
  // path left that draws a stand-in bot under somebody's name.
  assert.match(pillBody, /pill\.icon !== "agent"/u);

  // Every other pill draws from the shared interface set, so there is no
  // second set left holding a stand-in bot for something to reach by name.
  assert.match(pillBody, /icon\(pill\.icon\)/u);
  assert.doesNotMatch(ui, /PILL_ART|pillIcon/u);

  // The row's agent comes from the task, not from a roster scan that answers
  // "nobody" until the roster has been fetched.
  assert.match(catchUpBody, /agentForTask\(task, taskRepositoryId\)/u);
  const data = await publicFile("data.js");
  assert.match(data, /export function agentForTask\(/u);
});

test("catch-up digest keeps changed-file lists compact until expanded", async () => {
  const chats = await publicFile("screen-chats.js");
  const styles = await publicFile("styles.css");
  const catchUpStart = chats.indexOf("function catchUpPanel()");
  const catchUpBody = chats.slice(
    catchUpStart,
    chats.indexOf("\n/**", catchUpStart),
  );

  assert.match(catchUpBody, /changedFilePills\.slice\(0, 2\)/u);
  assert.match(catchUpBody, /changedFilePills\.slice\(2\)/u);
  assert.match(catchUpBody, /state\.changesOpen\[task\.id\]/u);
  assert.match(catchUpBody, /data-act="changed-files-toggle"/u);
  assert.match(catchUpBody, /data-act="chan-file-open"/u);
  assert.match(catchUpBody, /data-task="\$\{esc\(task\.id\)\}"/u);
  assert.match(
    catchUpBody,
    /data-repository="\$\{esc\(taskRepositoryId\)\}"/u,
  );
  assert.match(styles, /\.catch-up-file-more\[open\]/u);
});

test("every provider this deployment connects to has its own mark", async () => {
  const ui = await publicFile("ui.js");
  const marksStart = ui.indexOf("const VENDOR_MARKS = {");
  const marks = ui.slice(marksStart, ui.indexOf("\n};", marksStart));
  // `generic` is for a vendor this build has never heard of. A provider it
  // ships a connection for landing there is the anonymous robot showing up
  // under a name somebody chose, which is the whole complaint these marks
  // answer.
  for (const provider of [
    "anthropic",
    "openai",
    "google",
    "cursor",
    "copilot",
    "kiro",
  ]) {
    assert.match(marks, new RegExp(`^ {2}${provider}: \``, "mu"));
  }
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
  // Their stored agent colour, when it is not the shared default. A hash of
  // the id or a fall-through to the interface accent would be a colour they
  // never picked; distinct colours stay one click away in Appearance.
  assert.match(body, /agentColor/u);
  assert.match(body, /chosen/u);
  assert.equal(/charCodeAt/u.test(body), false);
  assert.equal(/DEFAULT_ACCENT/u.test(body), false);
});

test("the default agent colour is black on the light theme", async () => {
  const data = await publicFile("data.js");
  const start = data.indexOf("export function agentColorFor");
  const body = data.slice(start, data.indexOf("\n}", start));
  assert.match(body, /myTheme\(\) === "light"/u);
  assert.match(body, /#000000/u);
  assert.match(body, /DEFAULT_AGENT_COLOR/u);

  const css = await publicFile("styles.css");
  const face =
    /:root\[data-theme="light"\] \.agent-face \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(face ?? "", /background: #f3efe8;/u);
  assert.equal(/#33322f/u.test(face ?? ""), false);
  const chip =
    /:root\[data-theme="light"\] \.doodle-chip \.doodle \{([\s\S]*?)\n\}/u.exec(
      css,
    )?.[1];
  assert.match(chip ?? "", /background: #f3efe8;/u);
});

test("the theme is driven by custom properties rather than per-component colour", async () => {
  const app = await browserSource();
  const css = await publicFile("styles.css");
  for (const [token, value] of [
    ["--bg", "#121110"],
    ["--surface-1", "#1A1817"],
    ["--surface-2", "#24211F"],
    ["--surface-3", "#2C2926"],
    ["--text", "#F3EFE8"],
    ["--muted", "#B5AEA5"],
    ["--salmon", "#D88973"],
    ["--lavender", "#A894B6"],
  ]) {
    assert.match(css, new RegExp(`${token}: ${value};`, "u"));
  }
  for (const [alias, token] of [
    ["--bg-panel", "--surface-1"],
    ["--bg-card", "--surface-2"],
    ["--bg-card-2", "--surface-3"],
    ["--text-2", "--muted"],
    ["--accent", "--salmon"],
    ["--accent-2", "--lavender"],
  ]) {
    assert.match(css, new RegExp(`${alias}: var\\(${token}\\);`, "u"));
  }
  assert.match(css, /--radius-sm: 10px;/u);
  assert.match(css, /--radius-lg: 12px;/u);
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

test("the user icon defaults to salmon", async () => {
  const ui = await publicFile("ui.js");
  const start = ui.indexOf("export function avatar");
  const end = ui.indexOf("\n}", start);
  assert.notEqual(start, -1, "the avatar helper was not found in ui.js");
  assert.match(ui.slice(start, end), /background:#D88973/u);
});

test("the product is named Kumi throughout the browser surface", async () => {
  // The auth wordmark names the image for assistive technology.
  assert.match(
    await publicFile("ui.js"),
    /role="img" aria-label="Kumi"/u,
  );
  assert.match(await publicFile("index.html"), /<title>Kumi<\/title>/u);
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
    assert.equal(/Lattice/u.test(source), false, `${file} still says Lattice`);
    // The earlier spelling was one letter short, which is exactly the kind of
    // rename a search-and-replace leaves half-finished.
    assert.equal(
      /Lattic(?!e)/u.test(source),
      false,
      `${file} still has the old spelling`,
    );
  }
});

test("the standalone logo follows the theme without changing the wordmark or appearing in the channel rail", async () => {
  const ui = await publicFile("ui.js");
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  assert.match(app, /brandMark/u);
  assert.match(app, /brandWordmark\(\d+\)/u);

  const markStart = ui.indexOf("export function brandMark");
  assert.notEqual(
    markStart,
    -1,
    "the standalone mark helper was not found in ui.js",
  );
  const mark = ui.slice(markStart, ui.indexOf("\n}", markStart));
  // Drawn, not photographed. The mark used to be a PNG keyed out by its own
  // luminance, which cost a request before first paint and rasterised
  // differently at every size; these assertions are what stop it coming back.
  assert.doesNotMatch(mark, /kumi-logo|<image|mask/u);
  assert.match(mark, /stroke="currentColor"/u);
  assert.match(mark, /viewBox="0 0 64 64"/u);
  assert.match(mark, /aria-hidden="true"/u);
  assert.match(mark, /MARK_SHELL/u);
  assert.match(mark, /MARK_SEAM/u);
  assert.match(mark, /MARK_FACETS/u);

  // The three visible faces of a cube: one silhouette, the seam where they
  // meet, and one facet stroke per face.
  const shell = ui.slice(ui.indexOf("const MARK_SHELL"), ui.indexOf("const MARK_SEAM"));
  assert.match(shell, /M29\.92 9\.08/u);
  assert.match(shell, /Z";/u);
  const seam = ui.slice(ui.indexOf("const MARK_SEAM"), ui.indexOf("/** One facet"));
  assert.equal(seam.match(/"M/gu)?.length, 2, "the seam is two strokes");
  const facets = ui.slice(ui.indexOf("const MARK_FACETS"), ui.indexOf("const MARK_STROKE"));
  assert.equal(facets.match(/"M/gu)?.length, 3, "one facet stroke per face");

  // It draws in `currentColor`, and the stylesheet is what points that at the
  // accent — so a surface that needs it to match its own ink still can.
  assert.match(css, /\.brand-mark \{\n {2}color: var\(--accent\);\n\}/u);

  // The corner of the global bar is one such surface: there the mark leads a
  // row of plain ink, so it is white with it. A literal white would be a hole
  // on the light theme, which is why this is the theme's own text token — the
  // point of drawing in `currentColor` in the first place.
  assert.match(css, /\.topbar-brand \.brand-mark \{\n {2}color: var\(--text\);\n\}/u);
  assert.match(css, /--text: #F3EFE8;/u);

  assert.doesNotMatch(chats, /channel-rail-brand|brandMark/u);
  assert.doesNotMatch(css, /channel-rail-brand/u);

  const start = ui.indexOf("export function brandWordmark");
  assert.notEqual(start, -1, "the wordmark helper was not found in ui.js");
  const wordmark = ui.slice(start, ui.indexOf("\n}", start));
  assert.match(wordmark, /preserveAspectRatio="xMidYMid meet"/u);
  assert.doesNotMatch(wordmark, /kumi-logo/u);
  assert.match(wordmark, /\$\{BRAND_LETTERS\}/u);

  const lettersStart = ui.indexOf("const BRAND_LETTERS");
  const letters = ui.slice(lettersStart, ui.indexOf("`;", lettersStart));
  assert.match(letters, /M8\.3 8V40/u);
  assert.match(letters, /M42 11 13\.5 24 42 37/u);

  const width = Number(/brandWordmark\((\d+)\)/u.exec(app)?.[1]);
  assert.ok(width > 0 && width <= 160, `the auth wordmark is ${width}px wide`);
});

test("every surface that draws the mark draws the same one", async () => {
  const assets = await loadStaticAssets();
  const read = (name: string): string =>
    assets.get(name)?.body.toString("utf8") ?? "";

  // The mark is drawn in four places rather than fetched into them. The
  // dashboard could share one helper, but `authorize.html` and
  // `download.html` are their own documents with no bundler between them and
  // the browser, and `kumi-mark.svg` is what a favicon and a home-screen
  // install ask for as a file. Four copies is the honest cost of that; this
  // is what stops them becoming four different cubes.
  const shell =
    "M29.92 9.08A4.16 4.16 0 0 1 34.08 9.08L50.92 18.8" +
    "A4.16 4.16 0 0 1 53 22.4L53 41.6A4.16 4.16 0 0 1 50.92 45.2" +
    "L34.08 54.92A4.16 4.16 0 0 1 29.92 54.92L13.08 45.2" +
    "A4.16 4.16 0 0 1 11 41.6L11 22.4A4.16 4.16 0 0 1 13.08 18.8Z";
  const paths = [
    shell,
    "M12.25 20.72L32 32.12L51.75 20.72",
    "M32 32.12L32 54.68",
    "M24.16 19.07L30.39 15.47",
    "M17.3 28.6L17.3 35.8",
    "M39.38 45.13L45.62 41.53",
  ];

  for (const name of [
    "/ui.js",
    "/authorize.html",
    "/download.html",
    "/kumi-mark.svg",
  ]) {
    const source = read(name);
    assert.notEqual(source, "", `${name} was not served`);
    // The dashboard names the weight and interpolates it; the three documents
    // that cannot run code write it out.
    assert.match(
      source,
      name === "/ui.js" ? /const MARK_STROKE = 3\.52;/u : /stroke-width="3\.52"/u,
      `${name}: wrong weight`,
    );
    for (const path of paths) {
      // ui.js holds the shell as a concatenation, so its copy is compared
      // with the quotes and joins taken out rather than as one literal.
      const haystack = name === "/ui.js" ? source.replaceAll('" +\n  "', "") : source;
      assert.ok(
        haystack.includes(path),
        `${name} draws a different mark: missing ${path.slice(0, 24)}…`,
      );
    }
  }

  // The two standalone documents take the accent through the theme the app
  // set, not through the desktop's own light/dark preference — those two
  // disagree the moment a light app runs on a dark desktop.
  assert.match(read("/authorize.html"), /\.authorize-mark \{[^}]*var\(--accent\)/u);
  assert.match(read("/download.html"), /\.dl-logo \{[^}]*var\(--accent\)/u);
  assert.doesNotMatch(read("/download.html"), /<img class="dl-logo"/u);

  // The file, though, is the one copy nothing can hand a theme to: a favicon
  // and an installed icon are drawn outside any page.
  assert.match(read("/kumi-mark.svg"), /prefers-color-scheme/u);
});

test("sign-in uses the standalone Kumi mark without the live-codebase punchline while other authentication modes retain their branding and copy", async () => {
  const app = await publicFile("app.js");
  const start = app.indexOf("function renderAuth");
  const auth = app.slice(start, app.indexOf("\nfunction renderPasswordReset", start));

  assert.notEqual(start, -1, "the auth renderer was not found in app.js");
  assert.match(
    auth,
    /bootstrap \|\| register \? brandWordmark\(120\) : brandMark\(54\)/u,
  );
  assert.doesNotMatch(auth, /One live codebase/u);
  assert.match(auth, /Create the first owner for this control plane\./u);
  assert.match(auth, /You get your own team and project to start building in\./u);
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

test("a push sync collision asks which side wins and resumes the push", async () => {
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");
  const repos = await publicFile("screen-repos.js");

  assert.match(data, /\.then\(\(result\) => onResponse\?\.\(result\)\)/u);
  assert.match(chats, /handleChannelCommandResult/u);
  assert.match(repos, /push\?\.detail\?\.syncConflict !== true/u);
  assert.match(repos, /confirm: "Take GitHub's version"/u);
  assert.match(repos, /cancel: "Keep Kumi's version"/u);
  assert.match(repos, /"prefer-remote"[\s\S]*afterSync/u);
  assert.match(repos, /"prefer-local"[\s\S]*afterSync/u);
  assert.match(
    repos,
    /repositories\/\$\{encodeURIComponent\(repositoryId\)\}\/push`/u,
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
  // The mirror repaint now lives in resizeComposer, which the painter calls.
  assert.match(handler, /resizeComposer\(node\)/u);
  const resize = chats.slice(
    chats.indexOf("function resizeComposer(node)"),
    chats.indexOf("\n/** Sizes every newly rendered composer"),
  );
  assert.match(resize, /paintComposerMirror\(node\)/u);
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
    data.indexOf(
      "\nexport function channelMessagesFor",
      data.indexOf("export function channelParticipants"),
    ),
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
  const participantEnd = data.indexOf(
    "\nexport function channelMessagesFor",
    participantStart,
  );
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
  const submitEnd = app.indexOf('\n    case "channel-submit"', submitStart);
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
  assert.match(submit, /sendDirectMessage\(other, draft, referencedMessageId\)/u);
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
      "\nconst previewsWatched",
      attachStart,
    );
    const attach = app.slice(attachStart, attachEnd);
    const removeStart = app.indexOf('case "channel-attachment-remove"');
    const removeEnd = app.indexOf('case "thread-attach"', removeStart);
    const remove = app.slice(removeStart, removeEnd);
    const submitStart = app.indexOf('case "dm-submit"');
    // The old boundary comment sits *above* this case, so `indexOf` returned
    // -1 and the slice was silently the whole rest of the file — every
    // assertion below would have passed on a match anywhere in the bundle.
    // The next case is a real end.
    const submitEnd = app.indexOf('\n    case "channel-submit"', submitStart);
    const submit = app.slice(submitStart, submitEnd);

    assert.match(remove, /case "dm-attachment-remove"/u);
    assert.match(remove, /ATTACH_TARGETS\.dm/u);
    assert.match(remove, /state\[where\.draft\]/u);
    assert.match(attach, /const dmUserId = target === "dm" \? state\.activeDm/u);
    assert.match(attach, /target === "dm" && state\.activeDm !== dmUserId/u);
    // Still the same block: the draft is cleared and the screen repainted
    // before the send is even attempted, so the composer empties immediately
    // rather than after the round trip. Capturing the reply address and
    // closing the autocomplete moved in between, which is why the two are no
    // longer 80 characters apart; the autocomplete close is named so the
    // window cannot quietly swallow something else later.
    assert.match(
      submit,
      /state\.dmDraft = "";[\s\S]{0,200}closeComposerAutocomplete\("dm"\);\s*render\(\);/u,
    );
    assert.match(
      app,
      /case "dm-open":[\s\S]{0,180}openUserDirectMessage\(value\)/u,
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
    /\.composer-mirror \.mention-ping \{[\s\S]{0,160}color: var\(--salmon\);[\s\S]{0,180}background: color-mix\(in srgb, var\(--salmon\)/u,
  );
  assert.match(
    css,
    /\.composer-mirror \.slash-ping \{[\s\S]{0,160}color: var\(--lavender\);[\s\S]{0,180}background: color-mix\(in srgb, var\(--lavender\)/u,
  );
});

test("the thread slash picker orders its thread commands first and truncates nothing", async () => {
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
    ["plan", "queue", "ask", "dnc", "simple", "push", "retry", "cancel", "stop", "help"],
    "the channel keeps the server's general command order",
  );
  // Was the first six only. The cut is gone: an empty query is what the picker
  // opens on, and ten commands behind a six-row cut hid `stop` and `help` —
  // including the one command whose entire job is to list the others. The
  // ordering is what remains under test, and the cut is asserted absent below
  // so it cannot come back unnoticed.
  assert.deepEqual(
    candidates("repo", "thread").map((entry) => entry.name),
    ["retry", "cancel", "push", "ask", "dnc", "simple", "plan", "queue", "stop", "help"],
    "thread actions are ordered first and nothing is truncated away",
  );
  assert.doesNotMatch(
    chats.slice(start, end),
    /\.slice\(0, ?\d+\)/u,
    "the candidate builder keeps no fixed row cap",
  );

  state.slashQuery = "pl";
  assert.deepEqual(
    candidates("repo", "thread").map((entry) => entry.name),
    ["plan"],
    "typing a specific command still narrows to it",
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
  // The transcript's inline `messageBody(entry.content, repositoryId,
  // entry.mentions)` became `messageBodyWithIcons`, a wrapper that draws the
  // icon for a protocol notice. What has to survive that indirection is the
  // server-resolved `entry.mentions` reaching `messageBody` on *both* of its
  // branches — a branch that let the argument fall away would highlight
  // against the live roster instead, so a ping would stop being highlighted
  // the moment the person it named left the room.
  const bodyWithIcons = chats.slice(
    chats.indexOf("function messageBodyWithIcons"),
    chats.indexOf("const AGENT_AUTHORED_ROOT_KINDS"),
  );
  assert.match(bodyWithIcons, /messageBody\(content, repositoryId, entry\.mentions\)/u);
  assert.match(
    bodyWithIcons,
    /messageBody\(\s*content\.slice\([^)]*\),\s*repositoryId,\s*entry\.mentions,/u,
  );
  assert.match(chats, /messageBodyWithIcons\(entry, repositoryId\)/u);

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
    assert.match(rule, /color: var\(--salmon\);/u);
    assert.match(rule, /background: color-mix\(in srgb, var\(--salmon\)/u);
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

  // While a message is arriving, a posted ping or command is one reveal
  // unit so its coloured wash does not sit empty ahead of the letters.
  const app = await publicFile("app.js");
  const revealWords = app.slice(app.indexOf("function revealWords(block, elapsed)"));
  assert.match(revealWords, /function revealPingOf\(node, block\)/u);
  assert.match(revealWords, /classList\.contains\("mention-ping"\)/u);
  assert.match(revealWords, /classList\.contains\("slash-ping"\)/u);
  assert.match(
    css,
    /\.cmsg-text \.mention-ping \{[\s\S]{0,320}text-reveal-word/u,
    "posted ping styling should note the shared arrival class",
  );
});

test("pasted web addresses are safe clickable message links", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  const start = chats.indexOf("function mentionMarkup");
  const end = chats.indexOf("\nfunction messageBody", start);
  assert.notEqual(start, -1, "screen-chats.js declares inline message markup");
  assert.notEqual(end, -1, "inline message markup has a testable boundary");

  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  const richText = new Function(
    "esc",
    `${chats.slice(start, end)}\nreturn richText;`,
  )((value: unknown) =>
    String(value ?? "").replace(
      /[&<>"']/gu,
      (character) => entities[character] ?? character,
    ),
  ) as (value: string, mentions: Array<{ name: string }>) => string;

  assert.equal(
    richText("Visit https://kokonutui.com/.", []),
    '<p>Visit <a class="message-link" href="https://kokonutui.com/" target="_blank" rel="noopener noreferrer">https://kokonutui.com/</a>.</p>',
  );
  assert.equal(
    richText("(https://example.com/docs?q=a&lang=en)", []),
    '<p>(<a class="message-link" href="https://example.com/docs?q=a&amp;lang=en" target="_blank" rel="noopener noreferrer">https://example.com/docs?q=a&amp;lang=en</a>)</p>',
  );
  assert.equal(
    richText('https://example.com/path") <script>alert(1)</script>', []),
    '<p><a class="message-link" href="https://example.com/path" target="_blank" rel="noopener noreferrer">https://example.com/path</a>&quot;) &lt;script&gt;alert(1)&lt;/script&gt;</p>',
  );
  assert.equal(richText("javascript:alert(1)", []), "<p>javascript:alert(1)</p>");
  assert.match(css, /\.cmsg-text \.message-link \{/u);
  assert.match(
    css,
    /\.cmsg-text \.message-link \{[\s\S]{0,260}overflow-wrap: anywhere;/u,
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
    `${chats.slice(start, end).replace(/^export /gmu, "")}\nreturn continuesUserMessageGroup;`,
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

test("desktop channel messages use the sidebar's ordinary row hover", async () => {
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");

  assert.doesNotMatch(app, /ChannelMessageHoverHighlight/u);
  assert.doesNotMatch(css, /\.cmsg-hover-highlight/u);

  const row = /\.cmsg-row \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(row ?? "", /transition: background 0\.13s ease;/u);
  assert.match(
    css,
    /@media \(hover: hover\) \{\s*\.cmsg-row:not\(\.cmsg-system\):hover \{[\s\S]*?background: var\(--bg-hover\);/u,
    "each message should paint the same simple hover ground as a sidebar row",
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.cmsg-row \{\s*transition: none;/u,
  );
});

test("a grouped run of prompts keeps one avatar and no connector", async () => {
  const chats = await publicFile("screen-chats.js");
  const start = chats.indexOf("function continuesUserMessageGroup");
  const end = chats.indexOf("\n/**\n * The three dots", start);
  const createPaths = new Function(
    `${chats.slice(start, end).replace(/^export /gmu, "")}\nreturn messageThreadPaths;`,
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

  // An uninterrupted run from one person still shares one face. With no task
  // in the group there is nothing for a connector to point at, so the path
  // table leaves every row unmarked.
  assert.deepEqual(
    paths([item("alice"), item("alice"), item("alice")], true),
    [undefined, undefined, undefined],
    "a plain grouped run keeps one avatar and draws no connector",
  );
  assert.match(
    chats,
    /compact \? " cmsg-compact" : ""/u,
    "grouped continuations stay compact under the first face",
  );
});

test("channel task branches share the compact group's visible avatar", async () => {
  const chats = await publicFile("screen-chats.js");
  const start = chats.indexOf("function continuesUserMessageGroup");
  const end = chats.indexOf("\n/**\n * The three dots", start);
  const createPaths = new Function(
    `${chats.slice(start, end).replace(/^export /gmu, "")}\nreturn messageThreadPaths;`,
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
  // Was `color: #fff`. The one-off white was retired in favour of
  // `--accent-ink`, which is what keeps text legible on the yellows and limes
  // the accent wheel allows; the claim — your own bubble is filled with the
  // accent, not with the greys around it — is the same one.
  assert.match(
    css,
    /\.msg\.user \.msg-text \{[^}]*background: var\(--accent\);[^}]*color: var\(--accent-ink\);/su,
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
  assert.match(body, /on Kumi/u);
});

test("an invite link opened in a running session enters the invitation flow", async () => {
  const app = await browserSource();
  const start = app.indexOf("function applyHash");
  const body = app.slice(start, app.indexOf("\n/* ---", start));
  const invitation = body.indexOf("handleInviteLink");
  const signedOutShell = body.indexOf('const authRoot = $("#auth-root")');
  const ordinaryRoute = body.indexOf("const route = window.location.hash");

  assert.match(app, /addEventListener\("hashchange", applyHash\)/u);
  assert.match(body, /\^#invite\\\/\.\+\$/u);
  assert.notEqual(invitation, -1);
  assert.ok(invitation < signedOutShell);
  assert.ok(invitation < ordinaryRoute);
});

/**
 * An invitation sent to somebody who is already on Kumi — a second team, a
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

test("a signed-in returning member can accept an invitation directly", async () => {
  const app = await browserSource();
  const start = app.indexOf("function renderInvite");
  const body = app.slice(start, app.indexOf("\nfunction renderAuth", start));
  assert.match(body, /invite\.signedIn === true/u);
  assert.match(body, /Accept and rejoin/u);
  assert.match(body, /restore your access/u);
});

test("settings only lists invitations that are still pending", async () => {
  const app = await browserSource();
  const start = app.indexOf("function invitationsCard");
  const body = app.slice(start, app.indexOf("\nasync function savePolicy", start));
  assert.match(body, /\.filter\(\s*\(invitation\) => invitation\.status === "pending"/u);
  assert.match(body, /No pending invitations/u);
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

test("each task turn puts its own compact thinking below its prompt and starts closed", async () => {
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
  assert.equal(
    thinking.includes('class="tt-task"'),
    false,
    "the disclosure should not repeat the task already shown by the thread",
  );
  assert.equal(
    /\bstep\$\{/u.test(thinking),
    false,
    "the compact summary should not count narration lines",
  );
});

test("thinking disclosures show only useful status and deduplicated milestones", async () => {
  const source = await publicFile("screen-chats.js");
  const styles = await publicFile("styles.css");
  const activityStart = source.indexOf("function threadActivityLabel(entry)");
  const activityEnd = source.indexOf("\n/**", activityStart);
  const thinkingStart = source.indexOf("function thinkingLineHtml");
  const thinkingEnd = source.indexOf("\n/**", source.indexOf("function threadThinkingBlock"));
  assert.notEqual(activityStart, -1);
  assert.notEqual(activityEnd, -1);
  assert.notEqual(thinkingStart, -1);
  assert.notEqual(thinkingEnd, -1);
  assert.doesNotMatch(
    styles,
    /\.thread-thinking\s*\{[^}]*border-left:/u,
    "thinking must stay unboxed — no disclosure rail",
  );
  assert.doesNotMatch(
    styles,
    /\.thread-thinking\s+\.tt-body\s*\{[^}]*border-left:/u,
    "the open stream must not grow a second left border",
  );
  assert.match(styles, /\.tt-line\.?|\.tt-cue|\.tt-thought/u);

  type Reply = {
    kind: string;
    content: string;
    at?: string | undefined;
  };
  const renderThinking = Function(
    "state",
    "esc",
    "icon",
    "isThreadThinking",
    "isThreadEnding",
    "threadReplyTurns",
    `"use strict";\n${source.slice(activityStart, activityEnd)}\n${source.slice(
      thinkingStart,
      thinkingEnd,
    )}\nreturn threadThinkingBlock;`,
  )(
    { thinkingOpen: {} },
    (value: unknown) => String(value),
    () => "",
    (reply: Reply) => reply.kind === "progress",
    (reply: Reply) =>
      reply.kind === "outcome" || /^Done —/u.test(reply.content),
    (replies: Reply[]) => [{ replies }],
  ) as (
    rootId: string,
    turn: { prompt?: Reply; replies: Reply[] },
    index: number,
  ) => { html: string; visible: Reply[] };

  const active = renderThinking(
    "root",
    {
      replies: [
        {
          kind: "progress",
          content: "Finished editing. Validating…",
          at: "2026-08-22T12:00:00.000Z",
        },
      ],
    },
    0,
  );
  assert.match(active.html, /class="tt-label">Thinking<\/span>/u);
  assert.doesNotMatch(active.html, /class="tt-count"/u);
  assert.match(active.html, /class="tt-line tt-cue"/u);

  const completed = renderThinking(
    "root",
    {
      replies: [
        {
          kind: "progress",
          content: "Reading the repository and working out a plan…",
          at: "2026-08-22T12:00:00.000Z",
        },
        {
          kind: "outcome",
          content: "The work is complete.",
          at: "2026-08-22T12:01:05.000Z",
        },
      ],
    },
    1,
  );
  assert.match(completed.html, /class="tt-label">Thought for 1m 5s<\/span>/u);
  assert.doesNotMatch(completed.html, /class="tt-count"/u);

  for (const at of [undefined, "not-a-timestamp"]) {
    const withoutDuration = renderThinking(
      "root",
      {
        replies: [
          { kind: "progress", content: "Planning changes", at },
          { kind: "outcome", content: "The work is complete.", at },
        ],
      },
      2,
    );
    assert.match(withoutDuration.html, /class="tt-label">Thought<\/span>/u);
    assert.doesNotMatch(withoutDuration.html, /Thought for/u);
  }

  const compact = renderThinking(
    "root",
    {
      replies: [
        { kind: "agent", content: "Task: Keep the thread concise" },
        {
          kind: "progress",
          content: "Reading the repository and working out a plan…",
        },
        {
          kind: "progress",
          content: "Reading the repository and working out a plan…",
        },
        { kind: "progress", content: "Planning changes" },
        { kind: "progress", content: "Planning changes" },
        {
          kind: "progress",
          content: "Working on apps/web/public/screen-chats.js…",
        },
        {
          kind: "progress",
          content: "Checking an unfamiliar reply shape",
        },
        { kind: "progress", content: "Finished editing. Validating…" },
        { kind: "progress", content: "Finished editing. Validating…" },
        { kind: "agent", content: "Here is the conversational reply." },
        { kind: "plan", content: "Open plan" },
        { kind: "outcome", content: "The compact flow is ready." },
      ],
    },
    3,
  );
  const milestones = [
    "Reading code",
    "Planning",
    "Editing screen-chats.js",
    "Checking an unfamiliar reply shape",
    "Testing",
  ];
  let previous = -1;
  for (const milestone of milestones) {
    const position = compact.html.indexOf(milestone);
    assert.ok(position > previous, `${milestone} should stay in order`);
    assert.equal(
      compact.html.split(milestone).length - 1,
      1,
      `${milestone} should appear once`,
    );
    previous = position;
  }
  assert.match(
    compact.html,
    /class="tt-line tt-cue"><span>Reading code<\/span>/u,
  );
  assert.match(
    compact.html,
    /class="tt-line tt-thought">Checking an unfamiliar reply shape<\/p>/u,
  );
  assert.equal(compact.html.includes("Task: Keep the thread concise"), false);
  assert.deepEqual(
    compact.visible.map((reply) => reply.kind),
    ["agent", "plan", "outcome"],
    "conversation, plans, and outcomes must remain outside the thinking fold",
  );

  const titleOnly = renderThinking(
    "root",
    { replies: [{ kind: "agent", content: "Task: Already visible above" }] },
    4,
  );
  assert.equal(titleOnly.html, "", "an empty disclosure should be omitted");
  assert.deepEqual(titleOnly.visible, []);
});

test("the progress bar restarts for each task turn in a thread", async () => {
  const source = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");
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

  const stageStart = data.indexOf("const STAGE_PROGRESS");
  const stageEnd = data.indexOf("\n/** Lifecycle order", stageStart);
  assert.notEqual(stageStart, -1, "lifecycle stage floors should exist");
  assert.notEqual(stageEnd, -1, "lifecycle stage floors should have a boundary");
  const STAGE_PROGRESS = Function(
    `"use strict";\n${data.slice(stageStart, stageEnd)}\nreturn STAGE_PROGRESS;`,
  )() as Record<string, number>;

  const progress = Function(
    "state",
    "THREAD_FINISHED_RE",
    "STAGE_PROGRESS",
    "taskProgress",
    `"use strict";\n${source.slice(turnsStart, turnsEnd)}\n${source.slice(
      progressStart,
      progressEnd,
    )}\nreturn threadProgress;`,
  )(
    { tasks: [{ id: "task-1", status: "claimed" }] },
    /^(Done —|I could not|This was cancelled)/u,
    STAGE_PROGRESS,
    (task: { status?: string }) => STAGE_PROGRESS[task?.status ?? ""] ?? 0,
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
    STAGE_PROGRESS.claimed,
    "an earlier ending must not hide the active turn's progress",
  );
  assert.equal(
    progress({
      ...thread,
      replies: thread.replies.filter((reply) => reply.kind !== "user"),
    }),
    STAGE_PROGRESS.claimed,
    "a task added without a copied prompt must restart progress too",
  );
  thread.replies.push({ kind: "outcome", content: "The follow-up is complete" });
  assert.equal(
    progress(thread),
    undefined,
    "the bar should still disappear when the current turn ends",
  );
});

test("thread progress uses live task progress when the current turn has no recognized narration markers", async () => {
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
    "STAGE_PROGRESS",
    "taskProgress",
    `"use strict";\n${source.slice(turnsStart, turnsEnd)}\n${source.slice(
      progressStart,
      progressEnd,
    )}\nreturn threadProgress;`,
  )(
    { tasks: [{ id: "task-1", status: "claimed" }] },
    /^(Done —|I could not|This was cancelled)/u,
    { submitted: 4, planning: 18, planned: 30, claimed: 44, validating: 88 },
    () => 53,
  ) as (entry: {
    taskId: string;
    replies: Array<{ kind: string; content: string }>;
  }) => number | undefined;

  assert.equal(
    progress({ taskId: "task-1", replies: [] }),
    53,
    "a live task should supply progress before its turn says anything",
  );
  assert.equal(
    progress({
      taskId: "task-1",
      replies: [{ kind: "progress", content: "Reading the repository" }],
    }),
    53,
    "unrecognized narration should keep the live task's progress",
  );
  assert.equal(
    progress({
      taskId: "missing",
      replies: [{ kind: "progress", content: "Reading the repository" }],
    }),
    undefined,
    "an ordinary thread without run narration should not gain a progress bar",
  );
});

test("task progress is monotonic and progress bars animate between keyed values", async () => {
  const data = await publicFile("data.js");
  const ui = await publicFile("ui.js");
  const styles = await publicFile("styles.css");

  const progressStart = data.indexOf("const STAGE_PROGRESS");
  const progressEnd = data.indexOf("\n/**\n * Whether a task", progressStart);
  assert.notEqual(progressStart, -1, "task progress stages should exist");
  assert.notEqual(progressEnd, -1, "task progress should have a boundary");
  const progressSource = data
    .slice(progressStart, progressEnd)
    .replace("export function taskProgress", "function taskProgress");
  assert.match(
    progressSource,
    /STAGE_INTERPOLATE[\s\S]*codingFileShare[\s\S]*codingTimeShare/u,
    "coding stages should interpolate from files touched and time on the run",
  );
  const taskProgress = Function(
    "state",
    `"use strict";\n${progressSource}\nreturn taskProgress;`,
  )({
    audit: [
      {
        event: {
          type: "plan_received",
          taskId: "task-coding",
          data: { expectedFiles: ["a.js", "b.js"] },
        },
      },
    ],
    changeSets: {
      "task-coding": { patches: [{ path: "a.js" }] },
    },
    agentBusy: {},
  }) as (task: {
    id?: string;
    status: string;
    claimedAt?: string;
  }) => number;
  const stages = [
    "submitted",
    "planning",
    "planned",
    "approved",
    "queued",
    "claimed",
    "running",
    "replanning",
    "awaiting_approval",
    "validating",
    "integrated",
  ];
  const lifecycle = stages.map((status) => taskProgress({ status }));
  assert.deepEqual(
    lifecycle,
    [...lifecycle].sort((left, right) => left - right),
    "moving to a later lifecycle stage must not move progress backwards",
  );
  assert.equal(lifecycle.at(-1), 100, "terminal work should be complete");

  const claimedFloor = taskProgress({ status: "claimed" });
  const claimedMid = taskProgress({
    id: "task-coding",
    status: "claimed",
    claimedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const runningFloor = taskProgress({ status: "running" });
  const waitingFloor = taskProgress({ status: "awaiting_approval" });
  // An agent picking a task up is the start of the work, so it has to read as
  // the start of the bar. A bar already near half full before anything had
  // been done was the whole complaint.
  assert.ok(
    claimedFloor <= 10 && runningFloor <= 12,
    "an agent starting work should read as barely begun",
  );
  const prelude = lifecycle.slice(0, stages.indexOf("running") + 1);
  const steps = prelude.slice(1).map((value, index) => value - prelude[index]!);
  assert.ok(
    Math.max(...steps) <= 5,
    "reaching execution should step in small increments, not leap",
  );
  assert.ok(
    claimedMid > claimedFloor,
    "coding should advance inside its stage when planned files are touched",
  );
  assert.ok(
    claimedMid < waitingFloor,
    "within-stage coding progress must stay inside the executing band",
  );

  const barStart = ui.indexOf("export function bar(percent");
  const barEnd = ui.indexOf("\n}\n\n/**", barStart) + 2;
  assert.notEqual(barStart, -1, "the shared progress bar should exist");
  assert.ok(barEnd > 1, "the shared progress bar should have a boundary");
  const bar = Function(
    `"use strict";\n${ui
      .slice(barStart, barEnd)
      .replace("export function bar", "function bar")}\nreturn bar;`,
  )() as (percent: number, tone?: string, thin?: boolean, key?: string) => string;
  assert.doesNotMatch(
    bar(44, "", false, "row:task-1"),
    /bar-progress-fill/u,
    "a newly observed bar should start at its current value",
  );
  const moving = bar(62, "", false, "row:task-1");
  assert.match(moving, /bar-progress-fill/u);
  assert.match(moving, /--bar-progress-from:44%/u);
  assert.match(moving, /--bar-progress-to:62%/u);
  assert.doesNotMatch(
    bar(62, "", false, "card:task-1"),
    /bar-progress-fill/u,
    "each dashboard surface should keep independent progress history",
  );

  assert.match(styles, /@keyframes bar-progress-fill/u);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.bar > i\.bar-progress-fill \{\s*animation: none;/u,
  );
});

test("the run fills the agent working, at the front of the stack", async () => {
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
    "planTranscriptReplies",
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
    )}\n${slice("function threadActivityLabel(entry", "\n/**")}\n${slice(
      "function threadSummaryLink(entry",
      "\n/**",
    )}\nreturn threadSummaryLink;`,
  )(
    () => undefined,
    () => false,
    (said: number) => `${said} replies`,
    () => false,
    (_entry: unknown, replies: unknown[]) => replies,
    (replies: unknown[]) => [{ replies }],
    (_repositoryId: string, reply: { author: string; agent?: boolean }) => ({
      name: reply.author,
      agent: reply.agent === true ? { id: reply.author } : undefined,
    }),
    (
      agent: { id: string },
      _size: number,
      indicator?: { progress?: number },
    ) =>
      indicator?.progress === undefined
        ? `<face>${agent.id}</face>`
        : `<face run="${indicator.progress}">${agent.id}</face>`,
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
    "the stack should carry the run's position",
  );
  assert.match(
    running,
    /<span class="ctl-activity phase-slot"\s*data-phase-slot="thread-link:m1">Starting<\/span>/u,
    "a live thread should say what the agent is doing, in a slot it keeps",
  );
  assert.match(
    running.slice(running.indexOf("ctl-faces")),
    /ctl-working[\s\S]*?<face run="45">claude<\/face>[\s\S]*?<avatar>Ada<\/avatar>/u,
    "the agent still working should fill with the run and lead the stack",
  );
  assert.equal(
    running.match(/<face[^>]*>claude<\/face>/gu)?.length,
    1,
    "moving a participant to the front must not duplicate them",
  );
  assert.doesNotMatch(
    running,
    /<face run="[^"]*">codex<\/face>/u,
    "only the agent being measured carries the run",
  );

  // Nothing running, nothing drawn: the stack goes back to being the order
  // people spoke in.
  const idle = summary({ id: "m1", replies }, replies, "repo-1", undefined);
  assert.doesNotMatch(idle, /ctl-working/u);
  assert.doesNotMatch(idle, /ctl-activity/u);
  assert.match(idle.slice(idle.indexOf("ctl-faces")), /<avatar>Ada<\/avatar>/u);

  // Nothing is drawn around the face in the stack: the mark fills itself, the
  // same reading the roster gives.
  assert.doesNotMatch(
    css,
    /\.cmsg-thread-link \.ctl-faces \.ctl-working::after \{/u,
    "the run should fill the mark rather than ring it",
  );

  // A person has no mark to fill, so a portrait keeps the plain ramp.
  const fill =
    /\n\.cmsg-thread-link \.ctl-faces \.ctl-working > \.avatar \{([\s\S]*?)\n\}/u
      .exec(css)?.[1];
  assert.notEqual(fill, undefined, "a working portrait in a stack should brighten");
  assert.match(fill ?? "", /opacity: calc\(0\.5 \+ var\(--run, 0\) \* 0\.005\);/u);

  // The badge on a filling face is the one `agentFace` already draws, halved
  // for the stack — not a second dot painted beside it, which was the same
  // colour and size but static while every other live mark breathed.
  assert.doesNotMatch(
    css,
    /\.cmsg-thread-link \.ctl-faces \.ctl-working::before \{/u,
    "the stack should reuse the face's own badge rather than draw its own",
  );
  const dot =
    /\n\.cmsg-thread-link \.ctl-faces \.ctl-working \.presence \{([\s\S]*?)\n\}/u
      .exec(css)?.[1];
  assert.notEqual(dot, undefined, "a filling face still carries its coding dot");
  assert.match(dot ?? "", /display: block;/u);
  assert.match(dot ?? "", /width: 5px;/u);
  assert.match(dot ?? "", /height: 5px;/u);
  assert.match(dot ?? "", /border-width: 1px;/u);
  assert.match(dot ?? "", /border-color: var\(--bg-chat\);/u);

  // Every kind of participant gets the same surface-coloured cutout. Agent
  // marks are not `.avatar`s, so putting the ring on portraits alone lets two
  // agent icons collapse into one shape when the stack overlaps.
  const stackedFace =
    /\n\.cmsg-thread-link \.ctl-faces > \* \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(stackedFace, undefined, "stacked faces should share a ring");
  assert.match(stackedFace ?? "", /border-radius: 50%;/u);
  assert.match(stackedFace ?? "", /background: var\(--bg-chat\);/u);
  assert.match(
    stackedFace ?? "",
    /box-shadow: 0 0 0 2px var\(--bg-chat\);/u,
    "the chat surface should visibly separate overlapping reply icons",
  );
});

test("working thread summaries carry a concise activity that holds still", async () => {
  const source = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  const start = source.indexOf("function threadActivityLabel(entry)");
  const end = source.indexOf("\n/**", start);
  assert.notEqual(start, -1, "the activity selector should exist");
  assert.notEqual(end, -1, "the activity selector should have a boundary");
  const activity = Function(
    "threadReplyTurns",
    `"use strict";\n${source.slice(start, end)}\nreturn threadActivityLabel;`,
  )((replies: unknown[]) => [{ replies }]) as (entry: {
    replies: Array<{ kind: string; content: string }>;
  }) => string;

  assert.equal(
    activity({
      replies: [{ kind: "progress", content: "Reading the repository and working out a plan…" }],
    }),
    "Reading code",
  );
  assert.equal(
    activity({
      replies: [{ kind: "progress", content: "Working on apps/web/public/styles.css…" }],
    }),
    "Editing styles.css",
  );
  assert.equal(
    activity({
      replies: [{ kind: "progress", content: "Finished editing. Validating…" }],
    }),
    "Testing",
  );

  const listStart = source.indexOf("function threadListPanel(repositoryId)");
  const list = source.slice(
    listStart,
    source.indexOf("\n/**\n * Your own agent", listStart),
  );
  // A slot the render loop can recognise between redraws, so "this task now
  // says something else" can be told from "a different task".
  assert.match(list, /class="ti-activity phase-slot"/u);
  assert.match(list, /data-phase-slot="thread-item:\$\{esc\(entry\.id\)\}"/u);

  // And the phrase itself is still. What travels is the mark beside it: one
  // running task carries one continuous signal, and a phrase sweeping next to
  // a mark sweeping was the same fact said twice, in two rhythms, on one row.
  const phrase = /\n\.cmsg-thread-link \.ctl-activity \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(phrase, undefined, "a live thread still says what it is doing");
  assert.doesNotMatch(phrase ?? "", /animation/u);
  assert.doesNotMatch(phrase ?? "", /background-clip: text;/u);
  assert.doesNotMatch(
    css,
    /\n\.text-sweep \{/u,
    "the second live-text treatment should be gone, not merely unused",
  );
  // Gone from the words, not from the app: the travelling highlight is what a
  // running bar and a working agent's mark are still drawn with.
  assert.match(css, /@keyframes thread-activity-sweep/u);
});

test("ended threads stay compact without live activity motion", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  const listStart = chats.indexOf("function threadListPanel(repositoryId)");
  const list = chats.slice(
    listStart,
    chats.indexOf("\n/**\n * Your own agent", listStart),
  );

  assert.match(list, /finished \? " thread-item-ended"/u);
  assert.doesNotMatch(list, /ti-done|icon\("check"\)/u);
  assert.match(list, /class="ti-main"/u);
  assert.match(list, /class="ti-meta"/u);
  assert.match(list, /class="ti-go"/u);
  assert.match(list, /class="ti-count"/u);
  assert.match(list, /!finished && working \? threadRunMark/u);
  const finished = /\n\.thread-list-finished \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  const active = /\n\.thread-list-active \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(finished ?? "", /display: grid;/u);
  assert.match(active ?? "", /display: grid;/u);
  assert.doesNotMatch(finished ?? "", /flex-wrap:/u);
  const card = /\n\.thread-item \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(card ?? "", /border-radius: var\(--radius\);/u);
  const ended = /\n\.thread-item-ended \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(ended ?? "", /background: var\(--bg-inset\);/u);
  assert.doesNotMatch(ended ?? "", /border-radius:\s*999px/u);
  assert.doesNotMatch(ended ?? "", /max-width:\s*260px/u);
  assert.doesNotMatch(css, /\.thread-item-ended \.ti-who::before/u);
});

test("long thread titles stay on one compact line", async () => {
  const css = await publicFile("styles.css");
  const title = /\n\.thread-item \.ti-text \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(title ?? "", /min-width: 0;/u);
  assert.match(title ?? "", /overflow: hidden;/u);
  assert.match(title ?? "", /text-overflow: ellipsis;/u);
  assert.match(title ?? "", /white-space: nowrap;/u);
  assert.doesNotMatch(title ?? "", /line-clamp/u);
  const row = /\n\.thread-item-row \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(row ?? "", /max-width: 100%;/u);
});

test("thread list keeps unfinished work ahead of ended threads", async () => {
  const chats = await publicFile("screen-chats.js");
  const listStart = chats.indexOf("function threadListPanel(repositoryId)");
  const list = chats.slice(
    listStart,
    chats.indexOf("\n/**\n * Your own agent", listStart),
  );

  assert.match(list, /const working = threadIsWorking\(entry\);/u);
  assert.match(list, /const waiting = threadAwaitsGoAhead\(entry\);/u);
  assert.match(list, /const ended =\s*!working &&\s*!waiting &&/u);
  assert.match(list, /\(entry\.replies \?\? \[\]\)\.some\(isThreadEnding\)/u);
  assert.match(
    list,
    /const active = summaries\.filter\(\(summary\) => !summary\.ended\);/u,
  );
  assert.match(
    list,
    /const ended = summaries\.filter\(\(summary\) => summary\.ended\);/u,
  );
  assert.ok(
    list.indexOf('class="thread-list-active"') <
      list.indexOf('class="thread-list-finished"'),
    "unfinished summaries should render before the completed threads",
  );
  assert.match(list, /: "Pending";/u);
});

test("compact thread summaries keep accessible thread navigation", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const listStart = chats.indexOf("function threadListPanel(repositoryId)");
  const list = chats.slice(
    listStart,
    chats.indexOf("\n/**\n * Your own agent", listStart),
  );
  const openCase = app.slice(
    app.indexOf('case "channel-thread-open"'),
    app.indexOf('case "thread-composer-focus"'),
  );

  assert.equal(
    list.match(/data-act="channel-thread-open"/gu)?.length,
    1,
    "active and ended rows share one open control that opens their thread",
  );
  // The separate active and ended row renderers were merged into one, so the
  // two labels are now the two arms of a single `esc(finished ? ... : ...)`
  // rather than two `esc()` calls. Both are still pinned: a merged row that
  // announced every thread as "Open thread" would take from a screen reader
  // the one fact the grey styling gives everybody else.
  assert.match(list, /aria-label="\$\{esc\(\s*finished\s*\?\s*`Open completed thread: /u);
  assert.match(list, /: `Open thread: \$\{title\}\. \$\{status\}\./u);
  assert.match(openCase, /openThreadPanel\(value\);/u);
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
  assert.match(css, /\.composer-mirror \.slash-ping \{[\s\S]{0,180}var\(--lavender\)/u);
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

  // The phone keeps the same card and bottom utility row as desktop. The
  // textarea grows inside it without swapping layout modes under the caret.
  assert.match(
    css,
    /@media \(max-width: 600px\) \{[\s\S]{0,1600}\.composer \{[\s\S]{0,300}--composer-layout: block;[\s\S]{0,160}--composer-bar-layout: flex;/u,
  );
  assert.doesNotMatch(css, /--composer-bar-layout: contents;/u);
  assert.match(
    css,
    /@media \(max-width: 600px\) \{[\s\S]{0,1800}\.composer textarea \{\s*min-height: 60px;/u,
  );
  assert.match(
    css,
    /\.composer-bar \{\s*flex-wrap: nowrap;/u,
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
    /function conversationHeader[\s\S]*?\n\}/u.exec(chats)?.[0] ?? "",
    /collaborators\(\)/u,
    "the channel header no longer counts the organization",
  );

  // Reconnecting delivers everything that happened while the browser was
  // closed. One reconcile per event used to cause a full app rebuild each.
  // Timers are per repository so a burst that names two rooms still refreshes
  // both — a single shared timer dropped every room but the last.
  assert.match(app, /clearTimeout\(channelFrameTimers\.get\(channelRepositoryId\)\)/u);
  assert.match(app, /CHANNEL_FRAME_COALESCE_MS/u);
  assert.match(app, /function scheduleChannelReconcile\(channelRepositoryId\)/u);
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
    chats.indexOf("function conversationHeader"),
    chats.indexOf("function threadParticipants"),
  );

  assert.match(sidebar, /section\("People", "invite-repo"/u);
  assert.match(sidebar, /section\("Agents", "channel-agent-menu"/u);
  assert.ok(
    sidebar.indexOf('section("People"') < sidebar.indexOf('section("Agents"'),
    "people and agents are direct, ordered sidebar sections",
  );
  assert.doesNotMatch(header, /repository\?\.branch/u);
  assert.doesNotMatch(header, /class="ch-sep"/u);

  // How many of each is said on the heading of the list it is the length of,
  // not as a chip in a header three hundred pixels away from both lists. The
  // header no longer counts anything, and neither figure is read from there.
  assert.match(sidebar, /"chan-sec-people", "people", people\.length\)/u);
  assert.match(sidebar, /"chan-sec-agents", "agents", roster\.length\)/u);
  assert.doesNotMatch(header, /icon\("personBust"\)|icon\("robotBust"\)/u);
  assert.doesNotMatch(header, /people\.length|roster\.length/u);
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
  // The label travels with the profile now, so the sidebar and the transcript
  // announce the same face the same way.
  assert.match(chats, /label: `Open details for \$\{agent\.name\}`/u);
  assert.doesNotMatch(row, /data-act="agent-chat-open"/u);

  assert.match(open, /state\.activeAgentPanel = value;/u);
  assert.match(open, /state\.agentPanelTab = "spec";/u);
  assert.doesNotMatch(open, /notifications/u);
  assert.match(panel, /const requestedTab = state\.agentPanelTab \?\? "spec";/u);
  assert.match(panel, /: agentSpec\(agent, repositoryId\)/u);
  // This compact header face is the panel's one presence indicator.
  assert.match(panel, /\$\{statusAgentFace\(agent, 20, repositoryId\)\}/u);
  assert.doesNotMatch(panel, /statusDot\(/u);

  // The alternate destinations still exist, but only behind controls that
  // name what they do instead of changing the result of clicking the agent.
  assert.match(menu, /act: "agent-chat-open"/u);
  assert.match(menu, /label: `Message \$\{agent\.name\}`/u);
  assert.match(panel, /const headerAction = \(view, iconName, title\)/u);
  assert.match(
    panel,
    /act: "agent-chat-open",[\s\S]*?title: "Open as primary conversation"/u,
  );
  assert.match(panel, /headerAction\("history", "history", "Task history"\)/u);
});

test("agent history is a dense active-then-finished task list", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  const app = await browserSource();
  const historyStart = chats.indexOf("const TASK_ICON = {");
  const historyEnd = chats.indexOf(
    "/** Every loaded room this exact agent belongs to",
    historyStart,
  );
  assert.notEqual(historyStart, -1);
  assert.notEqual(historyEnd, -1);
  const history = chats.slice(historyStart, historyEnd);
  assert.match(history, /function agentHistorySections\(rows\)/u);
  assert.match(
    history,
    /function agentHistoryRow\(\{ task, message \}, agent, repositoryId\)/u,
  );
  assert.match(history, /FINISHED_HISTORY_STATUS/u);
  assert.match(history, /"integrated"/u);
  assert.match(history, /"failed"/u);
  assert.match(history, /"cancelled"/u);
  // Still one line of summary, status, and a way into the thread.
  assert.match(history, /taskSummaryLine\(task, message\)/u);
  assert.match(history, /data-act="channel-thread-open"/u);
  assert.match(history, /class="agent-history-row \$\{esc\(task\.status\)\}"/u);
  assert.match(history, /class="ah-objective"/u);
  assert.match(history, /class="ah-when"/u);
  // Active work above finished work, each half named rather than merely ruled
  // off from the other.
  assert.match(history, /agentHistorySections\(shown\)/u);
  assert.match(history, /class="agent-history-active"/u);
  assert.match(history, /class="agent-history-finished"/u);
  assert.match(history, /aria-label="Active"/u);
  assert.match(history, /aria-label="Finished"/u);
  assert.match(history, /class="ah-section-label"/u);
  assert.match(css, /\.agent-history-active \+ \.agent-history-finished/u);
  assert.match(css, /\.agent-history-finished \.agent-history-row/u);

  // A row, not a card. Five columns of which one was this agent's own face
  // repeated down the list came to 74px an entry; the row is 56px and its
  // facts share one line under the request.
  assert.match(
    css,
    /\.agent-history-row \{[^}]*min-height: 56px;/su,
  );
  assert.doesNotMatch(history, /statusAgentFace\(agent, 26, repositoryId\)/u);
  assert.doesNotMatch(history, /class="ah-face"/u);
  assert.doesNotMatch(history, /class="ah-preview-label"/u);
  assert.match(history, /class="ah-meta"/u);
  // File count is optional and only stated when there is one.
  assert.match(history, /const changed = Array\.isArray\(task\.changedFiles\)/u);
  assert.match(history, /class="ah-files"/u);

  // The outcome is a word in a tinted pill, not a coloured ring a reader has
  // to already know the palette to decode.
  assert.match(history, /function historyStatusPill\(status\)/u);
  assert.match(history, /function historyStatusLabel\(status\)/u);
  assert.match(history, /function historyStatusTone\(status\)/u);
  assert.match(history, /return "Completed";/u);
  assert.match(
    history,
    /class="ah-status ah-status-\$\{esc\(historyStatusTone\(status\)\)\}"/u,
  );
  assert.match(css, /\.agent-history-row \.ah-status-ok/u);
  assert.match(css, /\.agent-history-row \.ah-status-bad/u);

  // A clock reading, because this list is scanned for the run from yesterday
  // afternoon and "2 days ago" cannot answer that.
  assert.match(history, /function historyWhen\(value\)/u);
  assert.match(history, /Today at \$\{time\}/u);
  assert.match(history, /Yesterday at \$\{time\}/u);
  assert.match(history, /historyWhen\(task\.submittedAt\)/u);

  // What came back, still shown — as the tail of the row's own line of facts
  // rather than as a bordered column of prose beside it.
  assert.match(history, /function taskOutputPreview\(task\)/u);
  assert.match(history, /task\?\.summary/u);
  assert.match(history, /class="ah-preview-text"/u);

  // The two things a reader does next, as controls a touch reader can find
  // rather than a row-wide click alone. Retry only where the server takes it.
  assert.match(history, /iconButton\("eye", \{[\s\S]*?act: "channel-thread-open"/u);
  assert.match(
    history,
    /FINISHED_HISTORY_STATUS\.has\(task\.status\)\s*\?\s*iconButton\("refresh", \{[\s\S]*?act: "task-retry"/u,
  );
  // Secondary until wanted: hover, keyboard focus, or a device with no hover
  // at all. They take no layout either way, so revealing them moves nothing.
  assert.match(
    css,
    /\.agent-history-row \.ah-actions \{[^}]*opacity: 0;/su,
  );
  assert.match(css, /\.agent-history-row:focus-within \.ah-actions/u);
  assert.match(css, /@media \(hover: none\) \{\s*\.agent-history-row \.ah-actions/u);

  // Search and filter above the list, held in state so a background poll
  // rebuilding the panel cannot widen it back to everything.
  assert.match(history, /function agentHistoryHead\(\)/u);
  assert.match(history, /searchBox\(\s*"Search recent tasks\.\.\.",/u);
  assert.match(history, /segmented\(\s*"agent-history-filter",/u);
  assert.match(history, /const HISTORY_FILTERS = \[/u);
  assert.match(history, /\{ value: "all", label: "All tasks" \}/u);
  assert.match(history, /\{ value: "completed", label: "Completed" \}/u);
  assert.match(history, /\{ value: "processing", label: "Processing" \}/u);
  assert.match(history, /\{ value: "errors", label: "Errors" \}/u);
  assert.match(history, /const HISTORY_FILTER_STATUS = \{/u);
  assert.match(history, /function agentHistoryFiltered\(rows\)/u);
  assert.match(history, /function historyMatchesQuery\(\{ task, message \}, query\)/u);
  assert.match(
    app,
    /case "agent-history-filter":\s*\n\s*state\.agentHistoryFilter = value;/u,
  );
  assert.match(
    app,
    /if \(act === "agent-history-search"\) \{\s*\n\s*state\.agentHistoryQuery = node\.value;/u,
  );
  // Filtering rebuilds the list, so a row that animated in would replay that
  // entrance on every keystroke in the search box.
  assert.match(css, /\.agent-history-row \{[^}]*animation: none;/su);
  assert.match(css, /\.agent-history-head/u);
  assert.match(css, /\.agent-history-list/u);
});

test("the spec tab is where an agent is made org-wide or kept personal", async () => {
  const app = await browserSource();
  const chats = await publicFile("screen-chats.js");
  const spec = chats.slice(
    chats.indexOf("function specPill(text,"),
    chats.indexOf("function agentPanel()"),
  );
  const handlerStart = app.indexOf('case "channel-agent-visibility"');
  const handler = app.slice(handlerStart, app.indexOf("default:", handlerStart));

  // The one control that decides whether teammates may task this agent. It
  // was only offered while pasting a credential, which left an agent
  // connected as personal personal forever.
  assert.notEqual(handlerStart, -1);
  assert.match(spec, /nativeSelect\(\s*"channel-agent-visibility"/u);
  assert.match(spec, /\{ value: "personal", label: "Only me" \}/u);
  assert.match(spec, /\{ value: "org", label: "Anyone in the org" \}/u);

  // Only the owner of the credential picks who may spend it; a teammate
  // reads the answer, the same way model and reasoning already degrade.
  assert.match(spec, /agent\.mine === true\s*\?\s*nativeSelect\(\s*"channel-agent-visibility"/u);
  assert.match(spec, /: readOnly\(visibility === "org" \? "Organization" : "Owner only"\)/u);

  // The select lives inside the chip group the handler resolves the agent
  // from, so the control and its handler cannot drift apart again.
  assert.match(spec, /<div class="aspec-settings" data-agent="\$\{esc\(agent\.id\)\}">/u);
  assert.match(handler, /node\.closest\("\[data-agent\]"\)\?\.dataset\.agent/u);
  assert.match(
    handler,
    /applyProviderSetting\(agentId, "visibility", node\.value\)/u,
  );
});

test("agent details use the reference profile with supported controls", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  const spec = chats.slice(
    chats.indexOf("function specPill(text,"),
    chats.indexOf("function agentPanel()"),
  );
  const panel = chats.slice(
    chats.indexOf("function agentPanel()"),
    chats.indexOf("function dmPanel()"),
  );

  // Four zones on one surface, in the order the reference profiles order
  // them: who it is, what it is doing, what it runs on, where it works. The
  // banner-topped identity card beside a column of five outlined panes came
  // to about 744px of content in a 523px panel, so the settings this panel
  // exists for were below the fold at the size it is normally read at.
  assert.match(spec, /function agentIdentityZone\(agent, repositoryId,/u);
  assert.match(spec, /function agentCurrentWorkZone\(agent, repositoryId,/u);
  assert.match(spec, /function agentRuntimeZone\(agent, repositoryId,/u);
  assert.match(spec, /function agentContextZone\(agent, repositoryId,/u);
  assert.match(
    spec,
    /agentIdentityZone\([\s\S]*?agentCurrentWorkZone\([\s\S]*?agentRuntimeZone\([\s\S]*?agentContextZone\(/u,
  );
  assert.match(spec, /class="aspec-zone aspec-identity"/u);
  assert.match(spec, /class="aspec-zone aspec-work/u);
  assert.match(spec, /class="aspec-zone aspec-runtime"/u);
  assert.match(spec, /class="aspec-zone aspec-context"/u);
  // The large identity face still receives live progress, but does not repeat
  // the header presence dot; the status text does not add another dot either.
  assert.match(
    spec,
    /statusAgentFace\(agent, 52, repositoryId, \{\s*showPresence: false,\s*\}\)/u,
  );
  assert.match(spec, /const facts = \[\s*\{ text: statusText \},/u);
  assert.doesNotMatch(spec, /\{ text: statusText, dot:/u);
  assert.match(panel, /<aside class="thread-panel agent-detail-panel">/u);
  assert.match(css, /\.agent-detail-panel\s*\{[^}]*min\(820px, 76vw\)/su);

  // The tall banner, the nested cards and the repeated outlines are gone: one
  // outer boundary, zones separated by space, and exactly one tinted surface
  // — the work, because it is the only part of the page that changes on its
  // own.
  assert.doesNotMatch(spec, /class="aspec-banner"/u);
  assert.doesNotMatch(css, /\.agent-spec \.aspec-banner/u);
  assert.doesNotMatch(spec, /class="aspec-identity-card"/u);
  assert.doesNotMatch(spec, /class="aspec-pane/u);
  assert.doesNotMatch(css, /\.agent-spec \.aspec-pane\b/u);
  assert.match(css, /\.agent-spec \.aspec-content\s*\{[^}]*gap: 18px;/su);

  // Reserved height, so a phase arriving or a percentage moving never shifts
  // the controls underneath it.
  assert.match(css, /\.agent-spec \.aspec-work\s*\{[^}]*min-height: 56px;/su);
  assert.match(css, /\.agent-spec \.aspec-work\.is-active\s*\{[^}]*min-height: 72px;/su);
  // And the phase itself is an ordinary phase slot, so the render loop's
  // coalescing owns the crossfade rather than a second mechanism here.
  assert.match(spec, /data-phase-slot="agent-profile:\$\{esc\(agent\.id\)\}"/u);
  assert.match(spec, /class="aspec-work-phase phase-slot"/u);

  // Continuing the work is the primary action. History is a secondary control
  // beside it — it used to be the full-width button that opened the page.
  assert.match(
    spec,
    /class="aspec-action aspec-action-primary"[\s\S]*?data-act="channel-thread-open"[\s\S]*?<span>Open thread<\/span>/u,
  );
  assert.match(
    spec,
    /class="aspec-action aspec-action-primary"[\s\S]*?data-act="agent-panel-tab" data-value="chat">[\s\S]*?<span>Message \$\{esc\(first\)\}<\/span>/u,
  );
  assert.match(
    spec,
    /class="aspec-action aspec-action-quiet"\s*\n\s*data-act="agent-panel-tab" data-value="history">[\s\S]*?<span>History<\/span>/u,
  );
  assert.match(css, /\.agent-spec \.aspec-action-quiet\s*\{/u);
  assert.match(
    css,
    /\.agent-spec \.aspec-action:focus-visible[^{]*\{[^}]*outline: 2px solid var\(--accent-line\);/su,
  );

  // Identity states status, connection, ownership and room once each, as one
  // line of text without repeating the header's presence dot. The duplicate
  // pill strip that repeated the header is gone.
  assert.match(spec, /class="aspec-identity-facts"/u);
  assert.match(spec, /\{ text: statusText \}/u);
  assert.match(spec, /text: `#\$\{repositoryLabel\(repositoryId\)\}`/u);
  assert.doesNotMatch(spec, /class="aspec-pills"/u);
  assert.doesNotMatch(css, /\.agent-spec \.aspec-pills/u);
  assert.doesNotMatch(spec, /class="aspec-(?:status|profile-facts)"/u);
  assert.match(css, /\.agent-spec \.aspec-identity\s*\{[^}]*min-height: 88px;/su);

  // Rename, delete and the rest of the rare actions are the roster row's own
  // menu rather than a second answer to the same question.
  assert.match(spec, /act: "roster-agent-menu"/u);
  assert.match(spec, /cls: "aspec-more"/u);

  // One caption per control, doubling the settings block's height to repeat
  // its own labels, is a title attribute now.
  assert.doesNotMatch(spec, /class="aspec-field-hint"/u);
  assert.doesNotMatch(css, /\.agent-spec \.aspec-field-hint/u);
  assert.match(
    spec,
    /const field = \(label, control, hint = "", aside = ""\)[\s\S]*?title="\$\{esc\(hint\)\}"/u,
  );
  // "Editable" said what the presence of a dropdown already says.
  assert.doesNotMatch(spec, /aspec-editing/u);
  assert.doesNotMatch(css, /\.agent-spec \.aspec-editing/u);

  // The provider's caveat is a 32px "i" beside the field it is about, not a
  // paragraph under the whole block on every visit. A deployment that could
  // not report at all is a fault and stays on the page.
  assert.match(spec, /function specInfoButton\(act, value, title\)/u);
  assert.match(spec, /specInfoButton\(\s*"agent-provider-note",/u);
  assert.match(spec, /export function agentProviderNotePopoverHtml\(agent, providerId\)/u);
  assert.match(
    spec,
    /const blocking =\s*\n\s*agent\.mine === true && state\.providerOptions\[providerId\] === null;/u,
  );
  assert.match(spec, /class="aspec-alert" role="status"/u);
  assert.match(css, /\.agent-spec \.aspec-info\s*\{[^}]*width: 32px;/su);
  assert.doesNotMatch(spec, /class="aspec-settings-pane"/u);

  // Channels and usage sit side by side, and the rooms that do not fit are a
  // popover rather than a clipped strip.
  assert.match(spec, /export function agentChannelsPopoverHtml\(agent, repositoryId\)/u);
  assert.match(spec, /data-act="agent-channels-more" data-value="\$\{esc\(agent\.id\)\}"/u);
  assert.match(
    css,
    /\.agent-spec \.aspec-context\s*\{[^}]*grid-template-columns: minmax\(0, 0\.8fr\) minmax\(0, 1\.2fr\);/su,
  );
  assert.match(css, /@container \(max-width: 430px\)/u);

  // The retired wrapper was the stray centred hairline/box above the profile.
  assert.doesNotMatch(panel, /class="agent-panel-head"/u);
  assert.doesNotMatch(css, /^\.agent-panel-head\s*\{/mu);

  // Editing uses ordinary selects with native option menus inside clearly
  // labelled fields, rather than tiny composer pills transplanted into the
  // profile. Unknown current values are still shown before reported options.
  assert.match(spec, /const nativeSelect = \(act, options, current, label\)/u);
  assert.match(spec, /class="aspec-native-select" data-act="\$\{esc\(act\)\}"/u);
  assert.match(
    css,
    /\.agent-spec \.aspec-native-select\s*\{[^}]*appearance: auto;/su,
  );
  assert.match(css, /\.agent-spec \.aspec-field-label\s*\{/u);
  // 36-40px controls, and a border that strengthens on hover and focus.
  assert.match(
    css,
    /\.agent-spec \.aspec-native-select,\n\.agent-spec \.aspec-field-value \{[^}]*height: 36px;/su,
  );
  assert.match(
    css,
    /\.agent-spec \.aspec-native-select:hover,\n\.agent-spec \.aspec-native-select:focus \{[^}]*border-color: var\(--border-strong\);/su,
  );
  assert.doesNotMatch(spec, /class="aspec-chip"/u);
  assert.doesNotMatch(css, /\.agent-spec \.aspec-nav/u);
  assert.doesNotMatch(spec, /class="aspec-nav"/u);
  assert.doesNotMatch(spec, /title="Task history"/u);

  // The remaining interactive and informative parts stay on the single
  // scrolling surface, including owner-only and read-only paths.
  for (const action of [
    "channel-agent-visibility",
    "channel-agent-model",
    "channel-agent-effort",
    "agent-panel-tab",
    "agent-usage-refresh",
  ]) {
    assert.match(spec, new RegExp(`data-act="${action}"|"${action}"`, "u"));
  }
  assert.match(spec, /taskSummaryLine\(task, taskMessage\)/u);
  assert.match(spec, /agentUsage\(agent\)/u);
  assert.match(spec, /agent\.mine === true/u);
  assert.match(spec, /const readOnly =/u);

  // Every way of opening the specification asks for a current native usage
  // snapshot: both the roster entry and returning from chat/history.
  const app = await browserSource();
  const openSpec = app.slice(
    app.indexOf('case "agent-panel-open"'),
    app.indexOf('case "agent-panel-tab"'),
  );
  const returnToSpec = app.slice(
    app.indexOf('case "agent-panel-tab"'),
    app.indexOf('case "agent-panel-close"'),
  );
  assert.match(
    openSpec,
    /refreshProviderUsage\(\s*usageProviderId\(opened\),\s*render,\s*usageOwner\(opened\),\s*\)/u,
  );
  assert.doesNotMatch(openSpec, /ensureProviderUsage/u);
  assert.match(returnToSpec, /if \(value === "spec"\)/u);
  assert.match(
    returnToSpec,
    /refreshProviderUsage\(\s*usageProviderId\(opened\),\s*render,\s*usageOwner\(opened\),\s*\)/u,
  );
});

test("agent details omit roles while keeping channel membership", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");
  const spec = chats.slice(
    chats.indexOf("function specPill(text,"),
    chats.indexOf("function agentPanel()"),
  );
  for (const source of [spec, app]) {
    assert.doesNotMatch(source, /agent-role-(?:form|input|menu|pick|custom)/u);
  }
  assert.doesNotMatch(chats, /roleMenuItems|RESERVED_ROLES|INVESTIGATOR_ROLE/u);
  assert.doesNotMatch(css, /\.agent-spec \.aspec-role/u);

  assert.match(spec, /const channels =/u);
  assert.match(spec, /class="aspec-channel-list"/u);
  assert.match(
    spec,
    /assignments\.map\(\(\{ repository \}\) => repository\)/u,
  );
});

test("repository role overrides survive roster refreshes", async () => {
  // Roles still affect task dispatch and roster presentation outside agent
  // details, so a local override must continue to beat stale roster data.
  const data = await publicFile("data.js");
  const body = data.slice(
    data.indexOf("export function channelAgentsFor"),
    data.indexOf("/** Agents and people who can be @mentioned"),
  );
  assert.match(body, /role: local\?\.role \?\? server\.role/u);
  assert.match(body, /model: local\?\.model \?\? server\.model \?\? agent\.model/u);
  assert.match(body, /effort: local\?\.effort \?\? server\.effort \?\? agent\.effort/u);
});

test("a call sign outranks a legacy vendor-wide channel name", async () => {
  // Same order the gateway resolves in: a bare-provider row names a vendor and
  // must not shadow the name the account holds, or a room that carries one
  // goes on showing the old name after an account-wide rename. A row naming
  // one agent still wins, and the vendor-wide row is never dropped locally —
  // it belongs to every agent on that vendor that has no name of its own.
  const data = await publicFile("data.js");
  const resolve = data.slice(
    data.indexOf("function overrideFor(overrides, agent)"),
    data.indexOf("function withOverride(agent, override)"),
  );
  assert.match(resolve, /agent\.hasName === true \? undefined : legacy\?\.name/u);
  assert.match(resolve, /name: specific\?\.name \?\? legacyName/u);

  const rename = data.slice(
    data.indexOf("function applyAgentRenameLocally(providerId, name)"),
    data.indexOf("export async function renameAgent"),
  );
  assert.match(rename, /const key = `\$\{myId\}:\$\{providerId\}`/u);
  assert.doesNotMatch(rename, /\[providerId, `\$\{myId\}:\$\{providerId\}`\]/u);
});

test("a roster row offers rename and delete only for the viewer's agent", async () => {
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
  // A teammate's agent has nothing in that menu, so the "…" is not drawn at
  // all — the same rule `personRow` follows. Offering a button that opens an
  // empty popover is worse than offering nothing.
  assert.match(
    row,
    /const hasMenu = rosterMenuItems\(agent\.id\)\.length > 0;/u,
  );
  assert.match(row, /hasMenu\s*\? `<span class="rr-more">/u);
  assert.match(
    row,
    /const settingsOpen =\s*agent\.mine === true && state\.chatSettingsOpenId === agent\.id;/u,
  );
  assert.match(row, /settingsOpen\s*\? `<form class="roster-rename"/u);
  assert.match(row, /: `<div class="rr-name">\$\{esc\(agent\.name\)\}<\/div>`/u);
  assert.match(row, /class="rr-name-input" data-act="channel-rename-input"/u);
  assert.doesNotMatch(row, /rosterSettings|channel-role-input/u);

  assert.match(
    menu,
    /if \(agent\.mine === true\) \{\s*items\.push\(\{\s*act: "channel-settings-toggle",[\s\S]*?label: "Rename"/u,
  );
  assert.match(menu, /iconName: "pencil"/u);
  assert.match(
    menu,
    /if \(agent\.mine === true\) \{[\s\S]*?items\.push\(\{ separator: true \}\);[\s\S]*?act: "channel-agent-remove",[\s\S]*?label: "Delete"/u,
  );
  assert.match(menu, /danger: true/u);
  assert.doesNotMatch(menu, /channel-agent-remove-any/u);
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
  const data = await publicFile("data.js");
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
  assert.match(remove, /agent\?\.mine !== true/u);
  assert.match(remove, /removeChannelAgent\(repositoryId, agentId\)/u);
  assert.match(app, /case "channel-agent-remove":\s*\n\s*closePopover\(\);/u);
  assert.doesNotMatch(app, /channel-agent-remove-any|removeChannelAgentForUser/u);
  // The shared popover closes on its scrim or Escape, covering dismissal as
  // well as either menu selection above.
  assert.match(ui, /data-act="pop-close"/u);
  assert.match(ui, /event\.key === "Escape"[\s\S]{0,60}closePopover\(\)/u);

  assert.match(submit, /agent\.mine === true/u);
  assert.match(submit, /if \(renamed && ownAgent\) \{\s*renameChannelAgent\(/u);
  assert.match(submit, /state\.chatSettingsOpenId = undefined;/u);
  assert.match(submit, /render\(\);/u);
  const escape = /if \(act === "channel-rename-input" && event\.key === "Escape"\) \{([\s\S]*?)\n  \}/u.exec(
    renameKeys,
  )?.[1];
  assert.notEqual(escape, undefined, "Escape has an inline-rename branch");
  assert.match(escape ?? "", /state\.chatSettingsOpenId = undefined;/u);
  assert.doesNotMatch(escape ?? "", /renameChannelAgent/u);
  assert.match(renameKeys, /event\.key === "Enter"[\s\S]{0,240}requestSubmit\(\)/u);
  assert.match(renameBlur, /agent\.mine === true/u);
  assert.match(renameBlur, /renameChannelAgent\(activeChannelId\(\), agentId, node\.value\)/u);
  assert.match(renameBlur, /state\.chatSettingsOpenId = undefined;\s*\n\s*render\(\);/u);
  assert.match(
    app,
    /event\.target\.closest\?\.\("button, input, select, textarea, a\[href\]"\)[\s\S]{0,80}return;/u,
  );

  const rename = data.slice(
    data.indexOf("export function renameChannelAgent"),
    data.indexOf("export function setChannelAgentSetting"),
  );
  const removal = data.slice(
    data.indexOf("export function removeChannelAgent"),
    data.indexOf("const repositoryPath"),
  );
  for (const operation of [rename, removal]) {
    assert.match(operation, /const providerId = ownProviderId\(agentId\);/u);
    assert.match(operation, /if \(providerId === undefined\) \{\s*return;/u);
  }
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

  // Same amber on the channel's dot, and — unlike the live marker it is
  // shaped like — completely still. A thread held for somebody's go-ahead is
  // not working, it is stopped until they answer, and a stopped thing that
  // keeps moving tells the reader something is happening when nothing is. The
  // colour is the whole of the difference, so there is nothing to reduce.
  const dot = /\n\.cmsg-thread-link \.ctl-held \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(dot, undefined, "the channel's held mark has a shape rule");
  assert.match(dot ?? "", /var\(--orange\)/u);
  assert.doesNotMatch(dot ?? "", /animation/u);
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

test("completed-work responses use an accessible inline pill while ordinary references stay quiet", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  const row = chats.slice(
    chats.indexOf("function messageRow("),
    chats.indexOf("\nfunction typingIndicator", chats.indexOf("function messageRow(")),
  );

  assert.match(chats, /const CHANNEL_COMPLETED_WORK_PREFIX = "Already handled —"/u);
  assert.match(chats, /function completedWorkReference\(entry, repositoryId\)/u);
  assert.match(chats, /class="cmsg-completed-ref"/u);
  assert.match(chats, /aria-label="\$\{esc\(/u);
  assert.match(chats, /data-act="channel-pin-jump" data-value="\$\{esc\(entry\.referencedMessageId\)\}"/u);
  assert.match(row, /const completedReference =/u);
  assert.match(row, /completedReference === ""/u);
  assert.match(row, /messageReference\(referencedRoot, repositoryId\)/u);
  assert.match(row, /messageBodyWithIcons\(entry, repositoryId\)\}\$\{completedReference\}/u);

  const pill = /\n\.cmsg-completed-ref \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(pill, undefined, "completed work has its own inline treatment");
  assert.match(pill ?? "", /display: inline-flex/u);
  assert.match(pill ?? "", /border-radius: 999px/u);
  // The existing reply reference remains its own full-width, low-emphasis
  // path above the message instead of inheriting the completed-work pill.
  const ordinary = /\n\.cmsg-ref \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(ordinary ?? "", /flex: 0 0 100%/u);
  assert.doesNotMatch(ordinary ?? "", /border-radius: 999px/u);
});

test("one profile card describes people and agents wherever a face is drawn", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  const browser = await browserSource();

  // One description, two subjects, and the same shape for both: a roster in
  // which only half the faces answer "who is this" is a roster that has to be
  // learned twice.
  assert.match(chats, /function agentProfile\(agent, repositoryId\)/u);
  assert.match(chats, /function personProfile\(userId, name, repositoryId\)/u);
  assert.match(chats, /function profileCard\(profile\)/u);
  assert.match(
    chats,
    /function profileAnchor\(profile, cls, direction, content, options = \{\}\)/u,
  );

  const identityStart = chats.indexOf("function authorIdentity(");
  const identity = chats.slice(
    identityStart,
    chats.indexOf("\nfunction identityWrap(", identityStart),
  );
  assert.notEqual(identityStart, -1, "a message author resolves to a profile");
  assert.match(identity, /return agentProfile\(author\.agent, repositoryId\)/u);
  assert.match(identity, /return personProfile\(userId, author\.name, repositoryId\)/u);
  // An agent the roster could not resolve is left alone rather than read as a
  // person — its author id is `<userId>:<provider>`, which is a direct message
  // to an id nobody has.
  assert.match(
    identity,
    /userId === "you" \|\| AGENT_AUTHORED_KINDS\.has\(entry\.kind\)/u,
  );
  assert.match(
    chats,
    /const AGENT_AUTHORED_KINDS = new Set\(\["agent", "progress", "outcome"\]\)/u,
  );

  // Both rosters hang the card off the face rather than the whole row: a
  // row-wide trigger opens it while somebody is reaching for rename or remove.
  const person = chats.slice(
    chats.indexOf("function personRow(person)"),
    chats.indexOf("/** The role the roster acts on."),
  );
  const agentRow = chats.slice(
    chats.indexOf("function rosterRow(agent)"),
    chats.indexOf('/**\n * What the "..." on a roster row offers'),
  );
  assert.match(person, /profileAnchor\(\s*personProfile\(userId, name, repositoryId\),\s*"rr-avatar",\s*"down",/u);
  assert.match(agentRow, /profileAnchor\(\s*agentProfile\(agent, activeChannelId\(\)\),\s*"rr-avatar",\s*"down",/u);
  // The agent popout is intentionally only identity, live status and real
  // quota windows. Execution settings and account diagnostics belong to the
  // full profile and do not turn a hover into a settings card.
  const agentCard = chats.slice(
    chats.indexOf("function agentProfile(agent, repositoryId)"),
    chats.indexOf("function personProfile(userId, name, repositoryId)"),
  );
  assert.match(agentCard, /facts: \[\],/u);
  assert.match(agentCard, /subtitle: agentLabelOf\(providerId\)/u);
  assert.match(agentCard, /usage: usageBlock\(agent\)/u);
  assert.doesNotMatch(
    agentCard,
    /agent\.model|agent\.effort|label: "Model"|label: "Reasoning"|Role here|Who may task it|Working on|Waiting to start/u,
  );
  assert.doesNotMatch(agentRow, /class="roster-row-main"[^>]*data-hover/u);

  // A conversation opened from a search or a notification is the one place
  // somebody is read without the sidebar row that would otherwise explain them.
  assert.match(
    chats,
    /profileAnchor\(\s*personProfile\(userId, name, repositoryId\),\s*"dm-head-face",\s*"down",/u,
  );

  // The transcript draws this markup once per message and twice per author
  // line, so the card hangs off the face and the name keeps the press alone.
  assert.match(chats, /function identityWrap\(identity, content, withCard = false\)/u);
  assert.match(
    chats,
    /\? profileAnchor\(identity, "cmsg-identity", "up", content, attributes\)\s*: plainAnchor\(identity, "cmsg-identity", content, attributes\)/u,
  );

  // What the card actually says: who they are and the way through to
  // everything it intentionally left out. The decorative colour banner and
  // duplicated status dot are gone from the neutral surface.
  assert.match(chats, /class="pcard-head"/u);
  assert.match(chats, /class="pcard-name"/u);
  assert.match(chats, /class="pcard-meta"/u);
  assert.match(chats, /class="pcard-section-label"/u);
  assert.doesNotMatch(chats, /class="pcard-banner"|--pcard-accent/u);
  const profile = chats.slice(
    chats.indexOf("function profileCard(profile)"),
    chats.indexOf("function profileAnchor(", chats.indexOf("function profileCard(profile)")),
  );
  assert.doesNotMatch(profile, /status-dot status-/u);
  assert.match(chats, /label: "View full profile"/u);
  assert.match(chats, /label: unread > 0 \? `Message · \$\{unread\} unread` : "Message"/u);
  assert.match(chats, /class="pcard pcard-\$\{esc\(profile\.kind\)\}"/u);
  assert.match(chats, /<button type="button" class="pcard-open"/u);
  assert.doesNotMatch(chats, /class="pcard-open" role="button"/u);
  assert.match(browser, /case "agent-panel-open":/u);
  assert.match(browser, /case "dm-open":/u);
  // The card lives inside its own anchor and carries the gap as padding, which
  // is what makes it reachable at all: a pointer moving from the face to the
  // card never leaves the thing the hover is on.
  const anchor = /\n\.pcard-anchor \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(anchor ?? "", /position: relative/u);
  const pop = /\n\.pcard-pop \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(pop, undefined, "the card has a shape rule");
  assert.match(pop ?? "", /position: fixed/u);
  assert.match(pop ?? "", /top: -10000px/u);
  assert.match(pop ?? "", /left: -10000px/u);
  assert.match(pop ?? "", /padding: 7px 0/u);
  assert.doesNotMatch(pop ?? "", /opacity:/u);
  assert.match(pop ?? "", /visibility: hidden/u);
  assert.match(pop ?? "", /pointer-events: none/u);
  // The delay may keep accidental passes quiet, but a visible profile is
  // always fully opaque rather than fading through the transcript beneath it.
  assert.match(pop ?? "", /visibility 0s linear 0\.1s/u);
  assert.match(
    css,
    /\.pcard-anchor:hover > \.pcard-pop,\n\.pcard-anchor:focus-within > \.pcard-pop \{[\s\S]*?visibility: visible;\s*pointer-events: auto;[\s\S]*?transition-delay/u,
  );
  // Fixed cards outlive their hover for a beat; exclusivity snaps every other
  // one shut the instant a new face is held open, so two identities cannot
  // stack as a single garbled card.
  assert.match(
    css,
    /body:has\(\.pcard-anchor:is\(:hover, :focus-within\)\)\s*\.pcard-anchor:not\(:hover\):not\(:focus-within\)\s*>\s*\.pcard-pop \{[\s\S]*?visibility: hidden;[\s\S]*?transition-duration: 0s;/u,
  );
  assert.match(/\n\.pcard \{([\s\S]*?)\n\}/u.exec(css)?.[1] ?? "", /isolation: isolate/u);
  const card = /\n\.pcard \{([\s\S]*?)\n\}/u.exec(css)?.[1] ?? "";
  assert.match(card, /background(-color)?: var\(--surface-1\)/u);
  assert.match(card, /opacity: 1/u);
  const body = /\n\.pcard-body \{([\s\S]*?)\n\}/u.exec(css)?.[1] ?? "";
  assert.match(body, /background: var\(--surface-1\)/u);
  assert.doesNotMatch(css, /\n\.pcard-banner \{/u);
  const open = /\n\.pcard-open \{([\s\S]*?)\n\}/u.exec(css)?.[1] ?? "";
  assert.match(open, /background: transparent/u);
  assert.match(open, /border-top: 1px solid var\(--border-soft\)/u);
  assert.match(
    css,
    /\.cmsg-row:has\(\.pcard-anchor:is\(:hover, :focus-within\)\) \{[\s\S]*?z-index: 2;/u,
  );
  assert.match(
    css,
    /\.roster-row:has\(\.pcard-anchor:is\(:hover, :focus-within\)\) \{[\s\S]*?z-index: 2;/u,
  );
  // The list is itself a transformed stacking context (fold animation), so a
  // person card that opens over the Agents heading would otherwise be painted
  // through by that later sibling. Lift the open roster the same way.
  assert.match(
    css,
    /\.chan-roster:has\(\.pcard-anchor:is\(:hover, :focus-within\)\) \{[\s\S]*?z-index: 2;/u,
  );
  // No ring drawn round the face at the same time: the card opening is the
  // answer to the hover, and the outline was the same news twice.
  assert.match(
    css,
    /\.pcard-anchor:hover \.avatar,\n\.pcard-anchor:hover \.agent-face \{\n {2}outline: none;/u,
  );
  assert.doesNotMatch(css, /\.cmsg-identity:hover \.(avatar|agent-face)/u);

  // Placement is measured in both axes and fixed outside scroll clipping. It
  // follows the visual viewport, intersects every clipping ancestor, clamps
  // its size and coordinates, and is refreshed if that geometry changes.
  assert.doesNotMatch(css, /\.pcard-anchor\[data-profile-dir=/u);
  assert.match(
    css,
    /width: min\(236px, var\(--profile-max-width, calc\(100vw - 20px\)\)\);/u,
  );
  assert.match(css, /max-height: var\(--profile-max-height/u);
  assert.match(css, /overflow-y: auto/u);
  assert.match(browser, /function positionProfileCard\(event\)/u);
  assert.match(browser, /function placeProfileCard\(card, left, top\)/u);
  assert.match(
    browser,
    /const placed = card\.getBoundingClientRect\(\);[\s\S]{0,160}left - placed\.left[\s\S]{0,100}top - placed\.top/u,
  );
  assert.match(browser, /placeProfileCard\(\s*card,\s*desiredLeft,/u);
  assert.match(browser, /clip\.right - PROFILE_CARD_MARGIN - width/u);
  assert.match(browser, /clip\.bottom - PROFILE_CARD_MARGIN - height/u);
  assert.match(
    browser,
    /anchor\.toggleAttribute\("data-profile-flip", opensDown !== prefersDown\)/u,
  );
  assert.match(browser, /function clippingBoundsFor\(node\)/u);
  assert.match(browser, /const viewport = window\.visualViewport;/u);
  assert.match(browser, /style\.overflowX/u);
  assert.match(browser, /style\.overflowY/u);
  assert.match(browser, /document\.addEventListener\("mouseover", positionProfileCard\)/u);
  assert.match(browser, /document\.addEventListener\("focusin", positionProfileCard\)/u);
  assert.match(browser, /document\.addEventListener\("scroll", positionProfileCard, true\)/u);
  assert.match(browser, /window\.addEventListener\("resize", positionProfileCard\)/u);
  assert.match(browser, /window\.visualViewport\?\.addEventListener\("resize", positionProfileCard\)/u);
  assert.match(browser, /window\.visualViewport\?\.addEventListener\("scroll", positionProfileCard\)/u);

  // On a touch screen the tap on a message face is already the action; the
  // roster keeps its card and only loses the width that assumed a sidebar.
  assert.match(
    css,
    /@media \(hover: none\) \{[\s\S]*?\.cmsg-identity \.pcard-pop \{\n {4}display: none;/u,
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

  // A hold has a deadline, and one that runs out is cancelled rather than
  // started. The panel has to say which of the two happened: falling through
  // to "this plan has been started" is the one answer that is certainly
  // wrong, and it is what leaves somebody waiting on a run nobody authorised.
  assert.match(chats, /const PLAN_LAPSED_PREFIX = "⌛ Plan expired";/u);
  assert.match(chats, /const lapsed =\s*!held &&/u);
  assert.match(chats, /Nobody started this in time, so it was let go\./u);

  // The panel is the approval record people act on, so agent workflow markers
  // do not also pose as conversation. They stay in the stored reply list for
  // the gateway; only the three visible transcript surfaces use this view.
  // Exact user "go ahead" replies stay visible — they were said on purpose.
  const transcriptStart = chats.indexOf("function planTranscriptReplies(");
  const transcriptEnd = chats.indexOf(
    "\n/**\n * How a plan nobody started",
    transcriptStart,
  );
  assert.notEqual(transcriptStart, -1, "plan replies should have a visible view");
  assert.notEqual(transcriptEnd, -1, "the visible plan reply view has a boundary");
  assert.match(
    chats,
    /const PLAN_LIFECYCLE_REPLY_PREFIXES = \[\s*HOLD_NOTICE_PREFIX,\s*"Starting now\.",\s*"▶ Go-ahead received",\s*\];/u,
  );
  assert.doesNotMatch(
    chats.slice(transcriptStart, transcriptEnd),
    /content\.toLowerCase\(\) === "go ahead"/u,
  );
  const planTranscriptReplies = Function(
    "planReplyOf",
    "PLAN_LIFECYCLE_REPLY_PREFIXES",
    `"use strict";\n${chats.slice(transcriptStart, transcriptEnd)}\nreturn planTranscriptReplies;`,
  )(
    (entry: { replies?: Array<{ kind?: string }> }) =>
      entry?.replies?.find((reply) => reply.kind === "plan"),
    ["⏸ Waiting on you", "Starting now.", "▶ Go-ahead received"],
  ) as <T extends { kind: string; content: string }>(entry: {
    replies: T[];
  }) => T[];
  const planReplies = [
    { kind: "plan", content: "# A short plan" },
    { kind: "outcome", content: "⏸ Waiting on you — read the plan." },
    { kind: "user", content: "go ahead" },
    { kind: "progress", content: "Starting now." },
    {
      kind: "outcome",
      content: "▶ Go-ahead received — picking this back up now.",
    },
    { kind: "agent", content: "The ordinary answer stays visible." },
    { kind: "outcome", content: "⌛ Plan expired — nobody started this." },
    { kind: "user", content: "go ahead with the documentation too" },
  ];
  assert.deepEqual(
    planTranscriptReplies({ replies: planReplies }).map(
      (reply) => reply.content,
    ),
    [
      "# A short plan",
      "go ahead",
      "The ordinary answer stays visible.",
      "⌛ Plan expired — nobody started this.",
      "go ahead with the documentation too",
    ],
    "only agent lifecycle markers should disappear; exact go-ahead stays",
  );
  const reviewReplies = [
    { kind: "outcome", content: "⏸ Waiting on you — this needs a review." },
    { kind: "user", content: "go ahead" },
    {
      kind: "outcome",
      content: "▶ Go-ahead received — picking this back up now.",
    },
  ];
  assert.deepEqual(
    planTranscriptReplies({ replies: reviewReplies }),
    reviewReplies,
    "a review gate without a plan keeps its lifecycle conversation",
  );
  const summary = chats.slice(
    chats.indexOf("function threadSummaryLink("),
    chats.indexOf(
      "\n/**\n * How the room's own hold line",
      chats.indexOf("function threadSummaryLink("),
    ),
  );
  const list = chats.slice(
    chats.indexOf("function threadListPanel("),
    chats.indexOf("\n/**\n * Your own agent", chats.indexOf("function threadListPanel(")),
  );
  const renderer = chats.slice(
    chats.indexOf("function threadReplies("),
    chats.indexOf("\n/**\n * A plan, in the thread", chats.indexOf("function threadReplies(")),
  );
  assert.match(
    summary,
    /const visibleReplies = planTranscriptReplies\(entry, replies\)/u,
  );
  assert.match(summary, /const said = visibleReplies\.filter/u);
  assert.match(
    summary,
    /threadParticipants\(visibleReplies, repositoryId\)/u,
  );
  assert.match(list, /const replies = planTranscriptReplies\(entry\)/u);
  assert.match(list, /const count = replies\.filter/u);
  assert.match(renderer, /const replies = planTranscriptReplies\(root\)/u);
  assert.match(renderer, /const said = replies\.filter/u);
  assert.match(renderer, /threadReplyTurns\(replies\)/u);

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
  // Escape and a swipe close the one active secondary context.
  assert.match(
    app,
    /function closeSidePanel\(\) \{[\s\S]*?activeSecondaryContext\(\)/u,
  );
  assert.match(app, /closeSecondaryContext\(\)/u);

  assert.match(css, /\n\.plan-link \{/u);
  assert.doesNotMatch(css, /\n\.plan-card \{/u);
  assert.match(css, /\n\.plan-actions \{/u);
});

test("channel stats live in settings and people rows own co-owner actions", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  const header = chats.slice(
    chats.indexOf("function conversationHeader"),
    chats.indexOf("function threadParticipants"),
  );
  // Search and the info / exclamation control are gone; channel info is still
  // reached from the sidebar brand.
  assert.doesNotMatch(header, /channel-msg-search|icon\("search"\)/u);
  assert.doesNotMatch(header, /iconButton\("info"/u);
  assert.doesNotMatch(header, /act: "channel-info"/u);
  assert.match(chats, /data-act="channel-info"/u);

  const info = chats.slice(
    chats.indexOf("export function channelInfoPopoverHtml"),
    chats.indexOf("/* -------------------------------------------------------------- screen ---- */"),
  );
  assert.doesNotMatch(info, /<h4>Stats<\/h4>/u);
  assert.doesNotMatch(info, /coOwnerPanelHtml\(/u);
  assert.doesNotMatch(info, /channel-grant-promote/u);

  assert.match(app, /function channelStatsCard\(/u);
  assert.match(app, /\$\{channelStatsCard\(\)\}/u);
  assert.match(app, /class="channel-wrapped"/u);
  assert.match(css, /\n\.channel-wrapped \{/u);
  assert.match(app, /loadChannelStats\(repositoryId\)/u);

  const person = chats.slice(
    chats.indexOf("function personRow(person)"),
    chats.indexOf("/** The role the roster acts on."),
  );
  assert.match(person, /data-act="person-profile-open"/u);
  assert.doesNotMatch(person, /roster-person-menu|iconButton\("dots"/u);
  assert.match(chats, /export function personManagementItems\(/u);
  assert.match(chats, /act: "channel-grant-promote"/u);
  assert.match(chats, /act: "channel-grant-revoke"/u);
  assert.match(chats, /label: "Promote to co-owner"/u);
  assert.match(chats, /label: "Demote from co-owner"/u);

  assert.doesNotMatch(app, /case "roster-person-menu":/u);
  assert.match(chats, /const management = personManagementItems\(userId\);/u);
  assert.match(app, /ensureRepositoryGrants\(activeChannelId\(\)/u);
});

test("a phone shows stable global chrome and an in-flow conversation header", async () => {
  const css = await publicFile("styles.css");
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");

  assert.match(app, /<header class="topbar" aria-label="Global">/u);
  assert.match(app, /class="global-search"/u);
  assert.match(
    css,
    /@media \(max-width: 600px\) \{[\s\S]*?\.topbar \{[\s\S]*?height: calc\(54px \+ var\(--safe-top\)\)/u,
  );
  assert.match(
    css,
    /@media \(max-width: 600px\) \{[\s\S]*?\.chats-shell \.chan-head \{[\s\S]*?position: static;/u,
  );
  const header = chats.slice(
    chats.indexOf("function conversationHeader"),
    chats.indexOf("function threadParticipants"),
  );
  assert.match(header, /class="ch-name">\$\{esc\(label\)\}<\/div>/u);
  assert.ok(
    header.indexOf('act: "channel-menu"') >
      header.indexOf('class="icon-btn chan-sidebar-btn"'),
    "conversation actions follow the workspace-navigation button",
  );
  assert.ok(
    header.indexOf('act: "channel-menu"') > header.indexOf('<span class="spacer">'),
    "the spacer pushes conversation actions to the right",
  );

  const topbar = app.slice(
    app.indexOf("function topbar"),
    app.indexOf("The screens the account menu is the way into"),
  );
  assert.doesNotMatch(
    topbar,
    /notificationBell|data-act="go-notifications"|icon\("bell"\)/u,
  );
  assert.match(app, /case "go-notifications":/u);
});

test("a phone combines workspace selection and navigation in one inert drawer", async () => {
  const css = await publicFile("styles.css");
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");

  assert.match(
    css,
    /\.workspace-rail \{[\s\S]*?top: calc\(54px \+ var\(--safe-top\)\);[\s\S]*?transform: translateX\(-100%\)/u,
  );
  assert.match(
    css,
    /\.chats-shell \.chan-sidebar \{[\s\S]*?top: calc\(54px \+ var\(--safe-top\)\);[\s\S]*?left: 52px;[\s\S]*?width: calc\(100vw - 52px\)/u,
  );
  assert.match(
    chats,
    /phoneLayout\(\) && state\.chanSidebarOpen !== true[\s\S]*?' aria-hidden="true" inert'/u,
  );
  assert.match(
    app,
    /navigation\.toggleAttribute\("inert", !next\)[\s\S]*?navigation\.setAttribute\("aria-hidden", String\(!next\)\)/u,
  );
  assert.match(
    chats,
    /primaryHidden \? ' aria-hidden="true" inert' : ""/u,
  );
  assert.match(
    app,
    /conversation\?\.toggleAttribute\("inert", conversationHidden\)/u,
  );
  assert.match(css, /\.chats-shell > \.thread-panel \{[\s\S]*?position: fixed;[\s\S]*?width: 100vw/u);
});

test("a provider with no model list still lets a model be named", async () => {
  // Codex reports its models from a cache its own CLI writes on this machine.
  // Where that file is absent the server sends no list and sets
  // `allowCustomModel` — "nothing to choose from, but a name typed here is
  // passed through". The browser read the list, ignored the flag, and drew a
  // read-only "Default", so on the one provider that most needed a model
  // named, the model could not be changed anywhere in the UI.
  const ui = await publicFile("ui.js");
  const data = await publicFile("data.js");
  const chat = await publicFile("chat.js");
  const chats = await publicFile("screen-chats.js");
  const styles = await publicFile("styles.css");

  // The control exists, commits on change like the select beside it, and
  // carries the same action so it reaches the same handler.
  assert.match(ui, /export function miniEditable\(/u);
  assert.match(ui, /<input data-act="\$\{esc\(act\)\}" type="text"/u);
  // The flag the server has always sent and nothing read.
  assert.match(data, /export function providerAllowsCustomModel\(/u);
  assert.match(data, /loaded\.allowCustomModel === true/u);

  // Both places a model is picked fall back to typing it, rather than to a
  // dead control: the channel roster's chip and the agent composer.
  // The agent panel's chips became labelled fields in the profile redesign, so
  // the slice is anchored on `field("Model", ...)` now. Same control, same
  // action, same question: what happens on a provider that lists nothing.
  const chip = chats.slice(
    chats.indexOf('field(\n      "Model"'),
    chats.indexOf('field(\n      "Reasoning"'),
  );
  assert.match(chip, /customModel/u);
  assert.match(chip, /miniEditable\(\s*"channel-agent-model"/u);
  assert.match(chat, /providerAllowsCustomModel\(agent\?\.id\)/u);
  assert.match(chat, /miniEditable\(\s*"chat-model"/u);

  // And it is styled as the control beside it rather than as a raw input.
  assert.match(styles, /\.mini-select\.mini-editable input/u);
});

test("Codex offers its documented ids when the account reports none", async () => {
  // The list existed and was wired to nothing: SUGGESTED_MODELS.openai was
  // read by no branch, so an account whose CLI had cached nothing got an
  // empty control. A guess that fails at planning with the CLI's own words is
  // recoverable; a control with nothing in it is not even wrong.
  const providers = await readFile(
    path.join(packageRoot, "src", "providers.ts"),
    "utf8",
  );

  assert.match(providers, /suggestedModels: \[\.\.\.SUGGESTED_MODELS\.openai\]/u);
  for (const id of [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.3-codex",
  ]) {
    assert.match(providers, new RegExp(`id: "${id}"`, "u"));
  }
  // The levels the CLI takes, both ends included.
  assert.match(
    providers,
    /openai: \["none", "low", "medium", "high", "xhigh", "max"\]/u,
  );
  // And never presented as the account's own answer: a reported list and a
  // suggested one are mutually exclusive, so the note can say which it is.
  assert.match(
    providers,
    /Codex has not cached a model list on this machine/u,
  );
});

/* ------------------------------------------------------- the front door -- */

test("the origin's front door is the application, not a page about it", async () => {
  const assets = await loadStaticAssets();
  // The marketing site used to register itself under the bare "/" key, which
  // is what made this deployment answer its own address with an advertisement
  // instead of the product. The site now lives in the Kumi-Website repository
  // and this build serves none of it, so "/" has no key of its own and
  // `serveStatic` falls through to the dashboard document — the behaviour it
  // has always had for every other extensionless path under /app.
  assert.equal(
    assets.has("/"),
    false,
    'a "/" key here means something has claimed the front door again',
  );
  const document = assets.get("/index.html");
  assert.ok(document, "the dashboard document is what / falls back to");
  const body = Buffer.isBuffer(document.body)
    ? document.body.toString("utf8")
    : document.body;
  assert.match(body, /id="app-root"/u);
});

test("no marketing address is served from this build", async () => {
  const assets = await loadStaticAssets();
  // Naming them individually rather than pattern-matching: these are the
  // addresses the site actually held, and a re-added page would land on one
  // of them. /download stays — it is the dashboard's own page, served from
  // public/download.html, and the site links to it from the other repository.
  for (const gone of [
    "/",
    "/pricing",
    "/about",
    "/faq",
    "/security",
    "/waitlist",
    "/privacy",
    "/terms",
    "/site.css",
    "/site.js",
    "/site-boot.js",
    "/field.js",
    "/vendor/motion/motion.js",
    "/fonts/inter.woff2",
  ]) {
    assert.equal(assets.has(gone), false, `${gone} is served again`);
  }
  assert.ok(assets.has("/download"), "the dashboard still serves /download");
});

/* ------------------------------------------------- room presentation ---- */

test("the workspace rail is drawn only when there is a workspace to switch to", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // A switcher between one thing is furniture. It held sixty pixels of the
  // window permanently, and it held them from the conversation.
  assert.match(
    chats,
    /function showsWorkspaceRail\(\) \{\s*return state\.repositories\.length > 1;/u,
  );
  assert.match(chats, /const rail = showsWorkspaceRail\(\);/u);
  assert.match(chats, /\$\{rail \? "" : " no-rail"\}/u);
  assert.match(css, /--rail-w: 60px;/u);
  assert.match(css, /--chan-sidebar-w: 256px;/u);
  assert.match(css, /\.channel-rail \{\s*width: var\(--rail-w\);/u);
  assert.match(css, /\.chan-sidebar \{\s*width: var\(--chan-sidebar-w\);/u);

  // Nothing may only be reachable from a surface that can be absent. The rail
  // owned two controls of its own, so the crown carries them while the rail
  // is away.
  assert.match(
    chats,
    /showsChannelRail\(\)\s*\?\s*""\s*:\s*`<label class="icon-btn chan-crown-picture"/u,
  );
  assert.match(chats, /act: "channel-new",[\s\S]{0,120}cls: "chan-crown-new"/u);
  assert.doesNotMatch(
    chats,
    /class="icon-btn desk-only chan-crown-picture"|cls: "desk-only chan-crown-new"/u,
    "the stand-in controls must survive the phone, where the rail also would not be drawn",
  );

  // And the sidebar cannot fold to nothing when it is the only column left:
  // the control that brings it back is inside it.
  assert.match(
    css,
    /\.chats-shell\.no-rail\.chan-collapsed > \.chan-sidebar \{\s*width: var\(--rail-w\);/u,
  );
  assert.match(
    css,
    /\.chats-shell\.chan-collapsed :is\(\.chan-crown-picture, \.chan-crown-new\) \{\s*display: none;/u,
  );
});

test("inactive channel rail icons show a live unread count", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");

  // The badge is already drawn from `channelUnreadCount`. What was missing was
  // a transcript to count: only the open room was loaded, and only its
  // `channel_*` events were reconciled, so every other icon stayed blank.
  assert.match(chats, /class="channel-rail-unread"/u);
  assert.match(chats, /const unread = channelUnreadCount\(repo\.id\)/u);
  assert.match(app, /function scheduleChannelReconcile\(channelRepositoryId\)/u);
  assert.match(
    app,
    /channelRepositoryId !== undefined\) \{\s*scheduleChannelReconcile\(channelRepositoryId\);/u,
  );
  assert.doesNotMatch(
    app,
    /channelRepositoryId === activeChannelId\(\)\s*&&\s*state\.route === "chats"/u,
    "every room with a channel event must reconcile, not only the open one",
  );
  assert.match(
    app,
    /if \(showsChannelRail\(\)\) \{\s*for \(const repo of state\.repositories\)/u,
  );
  assert.match(
    data,
    /channelLoading: new Set\(\)/u,
    "several rooms load at once for the rail, so loading cannot be a single id",
  );
  // Watching still clears the open room; inactive reconciles must not.
  assert.match(
    app,
    /function markChannelReadIfWatching[\s\S]{0,400}activeChannelId\(\) !== repositoryId/u,
  );
});

test("reply previews collapse multiline content and omit hidden attachment references", async () => {
  const chats = await publicFile("screen-chats.js");
  const start = chats.indexOf("function replyPreviewText(");
  const end = chats.indexOf("\n/** The compact address above an inline reply.", start);
  assert.notEqual(start, -1, "the shared reply preview helper should exist");
  assert.notEqual(end, -1, "the reply preview helper should have a boundary");

  const preview = new Function(
    "ATTACHMENT_PATTERN",
    `${chats.slice(start, end)}\nreturn replyPreviewText;`,
  )(
    /!\[([^\]]*)\]\(attachment:([0-9a-f]{32}\.(?:png|jpg|gif|webp))\)/gu,
  ) as (entry: { content?: string; deletedAt?: string }) => string;
  const attachment =
    "![Attached image](attachment:0123456789abcdef0123456789abcdef.png)";

  assert.equal(
    preview({ content: `First line\n  second line\n${attachment}` }),
    "First line second line",
  );
  assert.equal(preview({ content: attachment }), "Attached image");
  assert.equal(
    preview({ content: "words that are replaced", deletedAt: "now" }),
    "This message was deleted",
  );
});

test("a reply's reference keeps clear of the avatar it sits above", async () => {
  const [chats, css] = await Promise.all([
    publicFile("screen-chats.js"),
    publicFile("styles.css"),
  ]);
  const row = chats.slice(
    chats.indexOf("function messageRow("),
    chats.indexOf("function typingIndicator("),
  );
  const block = (selector: string): string => {
    const start = css.indexOf(`\n${selector} {`);
    assert.notEqual(start, -1, `${selector} is missing`);
    return css.slice(start, css.indexOf("}", start));
  };

  assert.match(
    row,
    /messageReference\(inlineReplyTo, repositoryId\)[\s\S]*<span class="cmsg-avatar">[\s\S]*<div class="cmsg-body">/u,
  );
  assert.match(block(".cmsg-row"), /flex-wrap: wrap;/u);
  assert.match(block(".cmsg-ref"), /flex: 0 0 100%;/u);
  assert.doesNotMatch(block(".cmsg-ref"), /margin: 0 0 2px -28px;/u);
  assert.match(block(".cmsg-ref-elbow"), /margin-left: 16px;/u);
});

test("a message keeps react and reply, and puts the rest behind one menu", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await browserSource();

  const actions = chats.slice(
    chats.indexOf('    <span class="cmsg-actions">'),
    chats.indexOf("function continuesUserMessageGroup"),
  );
  // Seven icons over every row the pointer crossed made a toolbar out of a
  // message, and gave "delete" the same weight as "react".
  for (const gone of ["copy", "pin", "trash", "history", "pencil"]) {
    assert.doesNotMatch(
      actions,
      new RegExp(`iconButton\\("${gone}"`, "u"),
      `${gone} belongs in the overflow menu, not on the row`,
    );
  }
  assert.match(actions, /iconButton\("smile"/u);
  assert.match(actions, /iconButton\("reply"/u);
  assert.match(actions, /act: "channel-message-menu"/u);
  assert.match(actions, /iconButton\("dotsHorizontal"/u);
  // A button that opens an empty menu is a button that does nothing.
  assert.match(actions, /messageOverflowMenuItems\([\s\S]{0,80}\.length === 0/u);

  // The items come from the row's own conditions rather than being rebuilt at
  // the click: split across two files is how a menu ends up offering what the
  // row would not.
  assert.match(chats, /export function messageOverflowMenuItems\(/u);
  const menu = chats.slice(
    chats.indexOf("export function messageOverflowMenuItems("),
    chats.indexOf("function messageRow("),
  );
  assert.match(menu, /entry === undefined \|\| entry\.deletedAt !== undefined/u);
  assert.match(menu, /const isReplyRow = entry\.messageId !== undefined;/u);
  assert.match(menu, /act: "channel-message-copy"/u);
  // A pin lives on `channel_messages`; a reply is a row in another table, so
  // offering it there sends a POST that can only 404.
  assert.match(menu, /if \(!isReplyRow\) \{[\s\S]{0,200}act: "channel-pin"/u);
  assert.match(menu, /canEditChannelEntry\(repositoryId, entry\)/u);
  assert.match(menu, /canDeleteChannelEntry\(repositoryId, entry\)/u);
  assert.match(menu, /canManageRepository\(repositoryId\)/u);
  assert.match(menu, /danger: true,/u);

  assert.match(app, /case "channel-message-menu":\s*\n\s*showMenu\(node, messageOverflowMenuItems\(value\), \{ width: 156 \}\);/u);
  // Every one of those actions can now be taken from inside a popover, and a
  // menu still standing after its item was taken reads as a click that did
  // nothing.
  for (const act of [
    "channel-message-copy",
    "channel-pin",
    "channel-message-edit",
    "channel-message-delete",
    "chan-revert-task",
  ]) {
    assert.match(
      app,
      new RegExp(`case "${act}":(?:\\s*//[^\\n]*\\n)*\\s*closePopover\\(\\);`, "u"),
      `${act} should dismiss the menu it can be taken from`,
    );
  }
});

test("compact action menus share accessible behavior without sharing one width", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const ui = await publicFile("ui.js");
  const css = await publicFile("styles.css");

  assert.match(ui, /role: "menu"/u);
  assert.match(ui, /role="menuitem" tabindex="-1"/u);
  assert.match(ui, /role="separator"/u);
  assert.match(ui, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/u);
  assert.match(ui, /event\.key === "Home" \|\| event\.key === "End"/u);
  assert.match(ui, /typeahead \+=/u);
  assert.match(ui, /popoverReturn\?\.focus\(\)/u);
  assert.match(app, /rosterMenuItems\(value\), \{ width: 184 \}/u);
  assert.match(app, /messageOverflowMenuItems\(value\), \{ width: 156 \}/u);
  assert.match(chats, /items\.push\(\{ separator: true \}\);[\s\S]*?label: "Delete"/u);
  assert.match(css, /\.action-menu \{[\s\S]*?min-width: 156px;[\s\S]*?max-width: 224px;/u);
  assert.match(css, /@media \(pointer: coarse\) \{\s*\.menu-item \{\s*min-height: 44px;/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?pop-fade-in 80ms/u);
});

test("the transcript reads in a column rather than across the window", async () => {
  const css = await publicFile("styles.css");

  // A message run edge to edge on a wide screen is a message read twice: the
  // eye leaves the end of one line with nowhere to land on the next. Day
  // separators still span the panel so "Today" is not left-shifted short.
  assert.match(css, /--room-column: 940px;/u);
  assert.match(css, /--message-max: 100%;/u);
  assert.match(
    css,
    /\.chan-messages \{[\s\S]{0,400}padding: 12px 18px 20px;/u,
    "the scroller matches the header inset so day rules span the panel",
  );
  assert.match(
    css,
    /\.chan-day \{[\s\S]{0,200}width: 100%;[\s\S]{0,80}max-width: none;/u,
    "the Today bar spans the chat panel rather than the message column",
  );
  assert.match(
    css,
    /\.cmsg-row \{[\s\S]{0,500}max-width: var\(--room-column\);/u,
    "message rows keep the conversation column",
  );
  assert.match(
    css,
    /\.cmsg-row \.cmsg-text \{[\s\S]{0,320}max-width: var\(--message-max\);/u,
  );
  // The phone tier keeps its own tighter padding rather than inheriting a
  // desktop measure.
  assert.match(css, /\.chan-messages \{\s*padding: 6px 12px 14px;/u);
});
