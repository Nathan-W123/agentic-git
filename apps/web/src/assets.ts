import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { StaticAsset } from "@coord/api-gateway";

const PUBLIC_FILES = [
  ["index.html", "text/html; charset=utf-8"],
  ["styles.css", "text/css; charset=utf-8"],
  ["app.js", "text/javascript; charset=utf-8"],
  ["mark.svg", "image/svg+xml"],
  ["manifest.webmanifest", "application/manifest+json"],
] as const;

export function defaultPublicDirectory(): string {
  return fileURLToPath(new URL("../public/", import.meta.url));
}

export async function loadStaticAssets(
  directory = defaultPublicDirectory(),
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
  return assets;
}
