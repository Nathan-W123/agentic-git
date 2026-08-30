#!/usr/bin/env node
/**
 * Bundles the remote worker into one file the desktop app can ship.
 *
 * ### Why a bundle and not a dependency
 *
 * `apps/desktop` declares no dependencies at all, deliberately: the monorepo
 * build *is* the control plane's Docker build, so a workspace that required
 * Electron to compile would put a desktop dependency in front of production.
 * A bundle keeps that invariant — it is a build artifact produced beside the
 * app, never an edge in the dependency graph. This is the same reason CI
 * installs Electron itself with `--no-save`.
 *
 * ### Why CJS
 *
 * The worker reaches `pg` through `@coord/cli` → `@coord/persistence`, and
 * `pg` is CommonJS that calls `require` at runtime. An ESM bundle turns those
 * into `Dynamic require of "events" is not supported` the moment the module
 * graph loads. CJS output handles them natively. The worker is a leaf
 * executable, so nothing downstream cares which module system it ships as.
 *
 * The bundle is smoke-tested before this script will call it good: a bundle
 * that cannot load is worth catching here rather than on a user's machine,
 * where the symptom is an agent that silently never starts.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ESBUILD = "esbuild@0.25.0";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "apps/worker/dist/index.js");
const outDir = path.join(root, "apps/desktop/resources");
const outFile = path.join(outDir, "worker.cjs");

if (!statSync(entry, { throwIfNoEntry: false })?.isFile()) {
  console.error(
    `No built worker at ${entry}. Run \`npm run build\` before bundling.`,
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

execFileSync(
  "npx",
  [
    "--yes",
    ESBUILD,
    entry,
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node24",
    `--outfile=${outFile}`,
  ],
  { stdio: "inherit", cwd: root },
);

// Loading the whole module graph is the part that breaks, and it breaks the
// same way every time: an unbundleable `require` throws before `main` runs.
// With no environment set the worker must reach its own argument check, so
// that specific error is the proof the graph loaded.
const smoke = spawnSync(process.execPath, [outFile], {
  encoding: "utf8",
  timeout: 60_000,
  env: {
    ...process.env,
    COORD_SERVER: "",
    COORD_TOKEN: "",
    COORD_ORGANIZATION: "",
  },
});
const output = `${smoke.stdout ?? ""}${smoke.stderr ?? ""}`;
if (!output.includes("COORD_SERVER is required")) {
  console.error("Bundle did not load. Output was:\n" + output.slice(0, 4000));
  process.exit(1);
}

const megabytes = (statSync(outFile).size / 1024 ** 2).toFixed(1);
console.log(`Bundled worker: ${path.relative(root, outFile)} (${megabytes} MB)`);
