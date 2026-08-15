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
  ["styles.css", "text/css; charset=utf-8"],
  ["app.js", "text/javascript; charset=utf-8"],
  ["ui.js", "text/javascript; charset=utf-8"],
  ["data.js", "text/javascript; charset=utf-8"],
  ["chat.js", "text/javascript; charset=utf-8"],
  ["code-view.js", "text/javascript; charset=utf-8"],
  ["screen-repos.js", "text/javascript; charset=utf-8"],
  ["screen-code.js", "text/javascript; charset=utf-8"],
  ["screen-chats.js", "text/javascript; charset=utf-8"],
  ["screen-agents.js", "text/javascript; charset=utf-8"],
  ["screen-notifications.js", "text/javascript; charset=utf-8"],
  ["mark.svg", "image/svg+xml"],
  // The same mark as PNG, for the surfaces that cannot read the SVG: iOS
  // home screens and Android maskable icons. Rendered by
  // scripts/render-brand-icons.mjs, never edited by hand.
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

export async function loadStaticAssets(
  directory = defaultPublicDirectory(),
  /** `false` disables the vendored editor entirely (used by tests). */
  monacoDirectory: string | false | undefined = defaultMonacoDirectory(),
  /** `false` disables live collaborative editing (used by tests). */
  collabDirectory: string | false | undefined = defaultCollabDirectory(),
): Promise<ReadonlyMap<string, StaticAsset>> {
  const root = path.resolve(directory);
  const assets = new Map<string, StaticAsset>();
  await Promise.all(
    PUBLIC_FILES.map(async ([name, contentType]) => {
      const filePath = path.resolve(root, name);
      if (path.dirname(filePath) !== root) {
        throw new Error(`Static asset escapes the public directory: ${name}`);
      }
      assets.set(`/${name}`, {
        body: await readFile(filePath),
        contentType,
      });
    }),
  );
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
