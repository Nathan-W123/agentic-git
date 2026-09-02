import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { StaticAsset } from "@coord/api-gateway";

/**
 * The dashboard is served as plain ES modules — there is no bundler — so each
 * screen module is listed here individually. The list is an allowlist, not a
 * directory listing: a file that is not named is not served.
 */
const PUBLIC_FILES = [
  ["index.html", "text/html; charset=utf-8"],
  // Its own document, reached from outside the dashboard: a desktop app
  // sends somebody here to approve it.
  ["authorize.html", "text/html; charset=utf-8"],
  // Likewise its own document, and likewise reached by somebody who is not
  // signed in — a link to it is the thing people send each other to get the
  // desktop app at all.
  ["download.html", "text/html; charset=utf-8"],
  // The two standalone pages' behaviour. Separate files rather than inline
  // scripts because `script-src 'self'` carries no `'unsafe-inline'`: inline,
  // the browser silently declines to run them and both pages come up looking
  // right and doing nothing.
  ["authorize.js", "text/javascript; charset=utf-8"],
  ["download.js", "text/javascript; charset=utf-8"],
  ["styles.css", "text/css; charset=utf-8"],
  ["app.js", "text/javascript; charset=utf-8"],
  ["boot-plan.js", "text/javascript; charset=utf-8"],
  ["ui.js", "text/javascript; charset=utf-8"],
  ["data.js", "text/javascript; charset=utf-8"],
  ["chat.js", "text/javascript; charset=utf-8"],
  ["code-view.js", "text/javascript; charset=utf-8"],
  ["screen-repos.js", "text/javascript; charset=utf-8"],
  ["screen-code.js", "text/javascript; charset=utf-8"],
  ["screen-chats.js", "text/javascript; charset=utf-8"],
  ["screen-agents.js", "text/javascript; charset=utf-8"],
  ["screen-notifications.js", "text/javascript; charset=utf-8"],
  ["screen-settings.js", "text/javascript; charset=utf-8"],
  // The mark, and then the sizes of it a browser cannot derive itself. The
  // SVG is the mark; the rasters exist because an installed home-screen icon
  // and an iOS touch icon are both asked for as PNGs at a fixed size, and
  // because a handful of browsers still decline an SVG favicon.
  ["kumi-mark.svg", "image/svg+xml"],
  ["kumi-logo.png", "image/png"],
  ["apple-touch-icon.png", "image/png"],
  ["icon-192.png", "image/png"],
  ["icon-512.png", "image/png"],
  ["manifest.webmanifest", "application/manifest+json"],
] as const;


/**
 * Content types for the vendored Monaco tree. Anything not listed here is
 * deliberately not served: the vendor directory is treated as an allowlist of
 * asset kinds, not a general file server.
 */
const VENDOR_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".ttf", "font/ttf"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
]);

export function defaultPublicDirectory(): string {
  return fileURLToPath(new URL("../public/", import.meta.url));
}

/**
 * The vendored Monaco editor build (`monaco-editor/min/vs`).
 *
 * Served same-origin under /vendor/monaco/vs because the gateway's CSP allows
 * no external script or style sources — a CDN copy would simply be blocked.
 */
export function defaultMonacoDirectory(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return path.join(
      path.dirname(require.resolve("monaco-editor/package.json")),
      "min",
      "vs",
    );
  } catch {
    return undefined;
  }
}

/**
 * The compiled collaborative-editing engine (`@coord/collab/dist`).
 *
 * The same module runs in the gateway and in the browser: operational
 * transformation only converges if both sides transform identically, and
 * shipping one build is how that is guaranteed rather than hoped for. The
 * dashboard has no bundler, so it is served as plain ES modules — same-origin,
 * because the gateway's CSP allows no external scripts.
 */
export function defaultCollabDirectory(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return path.join(
      path.dirname(require.resolve("@coord/collab/package.json")),
      "dist",
    );
  } catch {
    return undefined;
  }
}

async function loadDirectory(
  assets: Map<string, StaticAsset>,
  root: string,
  urlPrefix: string,
  skip?: (relative: string) => boolean,
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }
      const filePath = path.join(entry.parentPath, entry.name);
      const relative = path.relative(root, filePath);
      if (relative.startsWith("..")) {
        throw new Error(`Vendor asset escapes its root: ${filePath}`);
      }
      const contentType = VENDOR_CONTENT_TYPES.get(
        path.extname(entry.name).toLowerCase(),
      );
      if (contentType === undefined) {
        return;
      }
      if (skip?.(relative.replaceAll(path.sep, "/")) === true) {
        return;
      }
      assets.set(`${urlPrefix}${relative.replaceAll(path.sep, "/")}`, {
        body: await readFile(filePath),
        contentType,
      });
    }),
  );
}

/**
 * How much of a digest goes in a file name. Long enough that two builds of
 * this dashboard will not collide, short enough to read in a network log.
 */
const DIGEST_LENGTH = 12;

function digestOf(...parts: readonly (string | Buffer)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest("hex").slice(0, DIGEST_LENGTH);
}

/**
 * Gives the dashboard's own files content-addressed names.
 *
 * Stable names cost every launch a revalidation round trip per file — the
 * gateway cannot let a phone reuse `app.js` from cache without asking,
 * because the name says nothing about which build it holds, and pairing an
 * old client with a new API is the one outcome worth a slow start. A name
 * that carries its own digest removes the question: the bytes at that URL can
 * never change, so a repeat launch reads them out of local cache and makes no
 * request at all. Only `index.html` still revalidates, and it is the document
 * that names which build the rest of the launch loads.
 *
 * The modules share one digest, taken over the whole graph, rather than one
 * each. They import each other — several of them cyclically — so per-file
 * digests would have to be computed in an order that does not exist, and the
 * first stale import specifier would be a 404 on a phone that had cached the
 * importer forever. One digest for the graph means any change to any module
 * renames all of them together, which is the property that makes `immutable`
 * safe to promise.
 */
function withDigestedNames(
  sources: ReadonlyMap<string, { body: Buffer; contentType: string }>,
): Map<string, StaticAsset> {
  const assets = new Map<string, StaticAsset>();
  const modules = [...sources.entries()]
    .filter(([name]) => name.endsWith(".js"))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const graphDigest = digestOf(
    ...modules.flatMap(([name, source]) => [name, source.body]),
  );
  const digested = new Map<string, string>(
    modules.map(([name]) => [
      name,
      `${name.slice(0, -".js".length)}.${graphDigest}.js`,
    ]),
  );
  const styles = sources.get("styles.css");
  if (styles !== undefined) {
    digested.set("styles.css", `styles.${digestOf(styles.body)}.css`);
  }

  const rewrite = (name: string, body: Buffer): Buffer => {
    if (name.endsWith(".js")) {
      let source = body.toString("utf8");
      for (const [from, to] of digested) {
        if (from.endsWith(".js")) {
          source = source.replaceAll(`"./${from}"`, `"./${to}"`);
        }
      }
      return Buffer.from(source, "utf8");
    }
    if (name === "index.html") {
      let source = body.toString("utf8");
      for (const [from, to] of digested) {
        source = source.replaceAll(`"/${from}"`, `"/${to}"`);
      }
      return Buffer.from(source, "utf8");
    }
    return body;
  };

  for (const [name, source] of sources) {
    const body = rewrite(name, source.body);
    // The stable name keeps answering — a bookmark, a test, anything that
    // learned the old URL — but it revalidates, because it is still a name
    // that says nothing about its contents.
    assets.set(`/${name}`, { body, contentType: source.contentType });
    if (name === "authorize.html") {
      // Registered at the extensionless path too. `serveStatic` falls back to
      // the dashboard for anything without a dot, so `/authorize` would
      // otherwise render the control room instead of the question.
      assets.set("/authorize", { body, contentType: source.contentType });
    }
    if (name === "download.html") {
      // Same reason, and this one is the address people paste into messages:
      // `https://your-kumi/download` has to be a link, not a filename.
      assets.set("/download", { body, contentType: source.contentType });
    }
    const alias = digested.get(name);
    if (alias !== undefined) {
      assets.set(`/${alias}`, {
        body,
        contentType: source.contentType,
        immutable: true,
      });
    }
  }
  return assets;
}

export async function loadStaticAssets(
  directory = defaultPublicDirectory(),
  /** `false` disables the vendored editor entirely (used by tests). */
  monacoDirectory: string | false | undefined = defaultMonacoDirectory(),
  /** `false` disables live collaborative editing (used by tests). */
  collabDirectory: string | false | undefined = defaultCollabDirectory(),
): Promise<ReadonlyMap<string, StaticAsset>> {
  const root = path.resolve(directory);
  const sources = new Map<string, { body: Buffer; contentType: string }>();
  await Promise.all(
    PUBLIC_FILES.map(async ([name, contentType]) => {
      const filePath = path.resolve(root, name);
      if (path.dirname(filePath) !== root) {
        throw new Error(`Static asset escapes the public directory: ${name}`);
      }
      sources.set(name, { body: await readFile(filePath), contentType });
    }),
  );
  const assets = withDigestedNames(sources);
  // A deployment without the vendored editor still serves the dashboard; the
  // editor tab reports that its assets are unavailable.
  if (monacoDirectory !== undefined && monacoDirectory !== false) {
    await loadDirectory(assets, path.resolve(monacoDirectory), "/vendor/monaco/vs/");
  }
  if (collabDirectory !== undefined && collabDirectory !== false) {
    try {
      await loadDirectory(
        assets,
        path.resolve(collabDirectory),
        "/vendor/collab/",
        // The package's test scaffolding compiles alongside its sources and
        // imports node builtins; it has no business being served.
        (relative) => relative.endsWith(".test.js") || relative === "random.js",
      );
    } catch {
      // An unbuilt or missing engine costs live collaboration, not the
      // dashboard: the editor falls back to the single-user save path.
    }
  }
  return assets;
}
