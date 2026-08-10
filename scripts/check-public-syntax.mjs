#!/usr/bin/env node
/**
 * Parses every browser module the web app serves.
 *
 * `apps/web/public/*.js` is shipped verbatim: nothing compiles it, typechecks
 * it, or lints it, so a syntax error there passes every build in this repo and
 * fails only in the browser — where one bad file takes down every module that
 * imports it and the app renders a blank page. A duplicate `export function`
 * did exactly that.
 *
 * `node --check` is the whole test. It parses without executing, which is all
 * that is needed: the failure being caught here is "this file cannot be read",
 * not "this file misbehaves". The copy to a `.mjs` name exists because
 * `--check` decides module vs script from the extension, and these are ES
 * modules living under `.js`.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "apps",
  "web",
  "public",
);

const scratch = mkdtempSync(path.join(tmpdir(), "coord-public-syntax-"));
const failures = [];
let checked = 0;

try {
  for (const entry of readdirSync(publicDir)) {
    if (!entry.endsWith(".js")) {
      continue;
    }
    const copy = path.join(scratch, `${entry.slice(0, -3)}.mjs`);
    copyFileSync(path.join(publicDir, entry), copy);
    try {
      execFileSync(process.execPath, ["--check", copy], { stdio: "pipe" });
      checked += 1;
    } catch (error) {
      failures.push(
        `${entry}: ${String(error.stderr ?? error.message)
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .slice(0, 3)
          .join(" | ")}`,
      );
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`Browser modules that do not parse (${failures.length}):`);
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log(`public/*.js: ${checked} browser modules parse`);
