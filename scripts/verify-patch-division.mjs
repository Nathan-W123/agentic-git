#!/usr/bin/env node
/**
 * Empirical check that a divided patch is a patch git will apply.
 *
 * `dividePatchByRanges` is what lets a partial admission withhold the hunks
 * that reach a contested symbol while promoting the rest of the file. Its unit
 * tests cover the arithmetic; this covers the thing the arithmetic is for.
 * Builds a real repository, produces a real `git diff --binary --full-index`,
 * divides it at a line range, and checks that:
 *   1. the granted half applies cleanly on its own,
 *   2. it leaves every withheld line exactly as the base revision had it,
 *   3. the deferred half applies cleanly on top of it,
 *   4. the result is byte-identical to applying the undivided patch.
 *
 * Run after building the coordinator:
 *   npx turbo run build --filter=@coord/coordinator
 *   node scripts/verify-patch-division.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { dividePatchByRanges } = await import(
  pathToFileURL(path.resolve("services/coordinator/dist/hunks.js")).href
);

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

const root = mkdtempSync(path.join(os.tmpdir(), "coord-divide-"));
let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

// Twelve numbered lines makes every hunk position readable at a glance.
const BASE = Array.from({ length: 24 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

function scenario(name, mutate, withheld) {
  console.log(`\n${name}`);
  const repo = path.join(root, name.replace(/\W+/gu, "-"));
  execFileSync("git", ["init", "--quiet", repo]);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.safecrlf", "false");
  writeFileSync(path.join(repo, "f.txt"), BASE);
  git(repo, "add", "f.txt");
  git(repo, "commit", "--quiet", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD").trim();

  mutate(path.join(repo, "f.txt"));
  const whole = git(
    repo,
    "diff",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-renames",
    base,
    "--",
    "f.txt",
  );
  const expected = readFileSync(path.join(repo, "f.txt"), "utf8");

  const division = dividePatchByRanges(whole, withheld);
  if (division === undefined) {
    check("divisible", false, "(returned undefined)");
    return;
  }
  console.log(
    `  granted=${division.grantedHunks} deferred=${division.deferredHunks}`,
  );
  check(
    "both halves are non-empty",
    division.grantedHunks > 0 && division.deferredHunks > 0,
  );

  // Fresh checkout at base, apply the granted half only.
  const work = path.join(root, `${name.replace(/\W+/gu, "-")}-work`);
  cpSync(repo, work, { recursive: true });
  git(work, "checkout", "--quiet", "--force", base, "--", "f.txt");
  git(work, "reset", "--quiet", base);

  const applyPatch = (text, label) => {
    const file = path.join(root, `${label}.patch`);
    writeFileSync(file, text);
    try {
      // The exact flags IntegrationService applies a changeset with, so a
      // patch that passes here is a patch that passes there.
      execFileSync(
        "git",
        [
          "-C",
          work,
          "apply",
          "--index",
          "--3way",
          "--whitespace=error-all",
          file,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return true;
    } catch (error) {
      console.log(`       ${String(error.stderr ?? error.message).trim()}`);
      return false;
    }
  };

  check(
    "granted half applies to base",
    applyPatch(division.granted, `${name}-granted`),
  );
  const afterGranted = readFileSync(path.join(work, "f.txt"), "utf8");
  check(
    "granted half changed something",
    afterGranted !== BASE,
  );
  // The point of the division: every withheld line still reads exactly as it
  // did at base after the granted half lands. Located by content rather than
  // by index, because the granted half may have shifted the window.
  const baseLines = BASE.split("\n");
  const grantedLines = afterGranted.split("\n");
  check(
    "granted half left the withheld lines alone",
    withheld.every((range) =>
      baseLines
        .slice(range.startLine - 1, range.endLine)
        .every((line) => line === "" || grantedLines.includes(line)),
    ),
  );
  check(
    "deferred half applies on top",
    applyPatch(division.deferred, `${name}-deferred`),
  );
  check(
    "both halves together equal the whole patch",
    readFileSync(path.join(work, "f.txt"), "utf8") === expected,
    `\n--- got ---\n${readFileSync(path.join(work, "f.txt"), "utf8")}\n--- want ---\n${expected}`,
  );
}

const edit = (mutations) => (file) => {
  const lines = readFileSync(file, "utf8").split("\n");
  mutations(lines);
  writeFileSync(file, lines.join("\n"));
};

// Two distant edits: one clear of the withheld window, one inside it.
scenario(
  "two distant edits",
  edit((lines) => {
    lines[1] = "line 2 CHANGED";
    lines[19] = "line 20 CHANGED";
  }),
  [{ startLine: 18, endLine: 22 }],
);

// The granted hunk deletes lines, so every later hunk's new-side start moves.
scenario(
  "granted hunk deletes lines",
  edit((lines) => {
    lines.splice(1, 3);
    lines[16] = "line 20 CHANGED";
  }),
  [{ startLine: 18, endLine: 22 }],
);

// The granted hunk inserts lines, shifting the deferred hunk the other way.
scenario(
  "granted hunk inserts lines",
  edit((lines) => {
    lines.splice(2, 0, "inserted a", "inserted b", "inserted c");
    lines[22] = "line 20 CHANGED";
  }),
  [{ startLine: 18, endLine: 22 }],
);

// Withheld window first, granted edit after it: the deferred half is the one
// that has to be renumbered when it is applied alone.
scenario(
  "withheld window comes first",
  edit((lines) => {
    lines[3] = "line 4 CHANGED";
    lines[21] = "line 22 CHANGED";
  }),
  [{ startLine: 2, endLine: 6 }],
);

// Three hunks, the middle one withheld.
scenario(
  "middle hunk withheld",
  edit((lines) => {
    lines[1] = "line 2 CHANGED";
    lines[11] = "line 12 CHANGED";
    lines[21] = "line 22 CHANGED";
  }),
  [{ startLine: 10, endLine: 14 }],
);

rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
