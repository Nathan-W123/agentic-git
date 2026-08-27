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

/*
 * Brace balance in every stylesheet served.
 *
 * The same argument as the modules above — nothing compiles or lints these —
 * but the failure is quieter still. A stray `}` at the top level is not an
 * error a browser reports: the parser treats it as the start of a bad rule,
 * swallows everything up to and including the NEXT block, and carries on.
 * One extra brace therefore deletes exactly one innocent rule, somewhere
 * below where it was typed, with no warning anywhere.
 *
 * That is not hypothetical. An edit that removed a component left its closing
 * brace behind, which ate `.belt-defs { position: absolute; width: 0 }` — the
 * rule that folds the symbol defs out of the layout. The defs SVG fell back
 * to its intrinsic 300x150, and a 198px hole opened in the middle of a
 * section. Everything still "worked"; it just looked wrong, and nothing but
 * measuring the page could say why.
 *
 * Comments are blanked line-for-line so the reported line number is the real
 * one, and quoted strings are blanked so a brace inside `content:` cannot
 * count.
 */
const cssFailures = [];
let sheets = 0;
for (const dir of roots) {
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".css")) {
      continue;
    }
    const label = dir === publicDir ? entry : `${path.basename(dir)}/${entry}`;
    const source = readFileSync(path.join(dir, entry), "utf8")
      .replaceAll(/\/\*[\s\S]*?\*\//gu, (block) =>
        "\n".repeat((block.match(/\n/gu) ?? []).length),
      )
      .replaceAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/gu, '""');
    let depth = 0;
    let line = 1;
    const opened = [];
    for (const character of source) {
      if (character === "\n") {
        line += 1;
      } else if (character === "{") {
        depth += 1;
        opened.push(line);
      } else if (character === "}") {
        depth -= 1;
        if (depth < 0) {
          cssFailures.push(
            `${label}:${String(line)}: a closing brace with nothing open — ` +
              `this silently deletes the next rule`,
          );
          depth = 0;
        } else {
          opened.pop();
        }
      }
    }
    for (const at of opened) {
      cssFailures.push(`${label}:${String(at)}: this block is never closed`);
    }
    sheets += 1;
  }
}

if (cssFailures.length > 0) {
  console.error(`Stylesheets that do not balance (${cssFailures.length}):`);
  for (const failure of cssFailures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
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

console.log(
  `public/*.js: ${checked} browser modules parse; ` +
    `${sheets} stylesheets balance`,
);
