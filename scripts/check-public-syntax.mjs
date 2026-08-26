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
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
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

// The marketing site's scripts live one level down in `public/site` and ship
// just as verbatim, so they get the same parse. The vendored Motion bundle is
// included on purpose: it is served to browsers like everything else, and it
// parses cleanly as a module even though it runs as a classic script.
const roots = [publicDir, path.join(publicDir, "site")];

try {
  for (const dir of roots) {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".js")) {
        continue;
      }
      const label =
        dir === publicDir ? entry : `${path.basename(dir)}/${entry}`;
      const copy = path.join(
        scratch,
        `${label.replaceAll("/", "__").slice(0, -3)}.mjs`,
      );
      copyFileSync(path.join(dir, entry), copy);
      try {
        execFileSync(process.execPath, ["--check", copy], { stdio: "pipe" });
        checked += 1;
      } catch (error) {
        failures.push(
          `${label}: ${String(error.stderr ?? error.message)
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .slice(0, 3)
            .join(" | ")}`,
        );
      }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

/*
 * An unescaped backtick inside an HTML comment inside a template literal.
 *
 * Parsing cannot catch this, which is why it gets its own pass. The backtick
 * closes the template string, and the CSS selector the comment was quoting is
 * then read as code: `<!-- see \`.chan-sidebar\` -->` becomes a property read
 * named `chan`, a subtraction, and a bare identifier `sidebar`. That is
 * perfectly valid JavaScript, so `node --check` is happy, every test passes,
 * and the screen throws `ReferenceError: sidebar is not defined` the moment it
 * renders. It shipped twice — in a chat header and a code toolbar — before
 * anybody saw it, because neither is on the first screen you land on.
 *
 * Heuristic, deliberately: it flags any backtick between `<!--` and `-->` that
 * is not backslash-escaped. Escaping is the fix when the selector is worth
 * quoting; ordinary quotes are the fix when it is not.
 */
const commentBackticks = [];
for (const dir of roots) {
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".js")) {
      continue;
    }
    const label = dir === publicDir ? entry : `${path.basename(dir)}/${entry}`;
    const lines = readFileSync(path.join(dir, entry), "utf8").split(/\r?\n/u);
    let open = false;
    lines.forEach((line, index) => {
      const started = line.includes("<!--");
      if (started) {
        open = true;
      }
      if (open && /(^|[^\\])`/u.test(line)) {
        commentBackticks.push(`${label}:${String(index + 1)}: ${line.trim()}`);
      }
      if (open && line.includes("-->")) {
        open = false;
      }
    });
  }
}

if (failures.length > 0) {
  console.error(`Browser modules that do not parse (${failures.length}):`);
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

if (commentBackticks.length > 0) {
  console.error(
    `Unescaped backtick inside an HTML comment (${commentBackticks.length}) — ` +
      `this closes the surrounding template literal and the rest parses as code:`,
  );
  for (const hit of commentBackticks) {
    console.error(`  ${hit}`);
  }
  process.exit(1);
}

console.log(`public/*.js: ${checked} browser modules parse`);
