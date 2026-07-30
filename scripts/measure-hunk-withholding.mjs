#!/usr/bin/env node
/**
 * How much of a contested file a partial admission has to give up.
 *
 * When an admission withholds a symbol inside a file it granted, the
 * enforcement pass has to decide what happens to a patch that reached into
 * that symbol. It used to lose the whole file; it now loses only the hunks
 * that reached. This measures the difference on real diffs rather than
 * constructed ones: every commit in a window of this repository's own history,
 * every source file it changed, and — for each symbol the patch actually
 * touches — what a withholding of that symbol would have cost.
 *
 * One symbol contested inside a file the plan otherwise owns is exactly the
 * case `contestedSymbols` produces, so the corpus is the shape the code meets.
 *
 * Usage:
 *   npx turbo run build
 *   node scripts/measure-hunk-withholding.mjs --commits=40
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

function flag(name, fallback) {
  const raw = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return raw === undefined ? fallback : raw.slice(name.length + 3);
}

const commits = Number(flag("commits", "40"));
const asJson = process.argv.includes("--json");

const load = async (relative) =>
  import(pathToFileURL(path.resolve(relative)).href);

const { dividePatchByRanges, namesTouchedByPatch, patchedLineRanges } =
  await load("services/coordinator/dist/hunks.js");
const { CodeIntelligenceService } = await load(
  "services/code-intelligence/dist/index.js",
);
const { RepositoryService } = await load(
  "services/repository-service/dist/index.js",
);

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

const base = git("rev-parse", `HEAD~${String(commits)}`).trim();
const head = git("rev-parse", "HEAD").trim();

// Every source file the window changed, diffed against one common base — the
// same shape the coordinator sees, where every patch in a changeset is written
// against the revision the agent started from.
const changed = git(
  "diff",
  "--name-only",
  "--no-renames",
  base,
  head,
  "--",
  "*.ts",
  "*.js",
  "*.mjs",
)
  .split("\n")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0 && !entry.endsWith(".d.ts"));

const repositories = new RepositoryService();
const intelligence = new CodeIntelligenceService(repositories);
const index = await intelligence.index(
  { id: "self", path: path.resolve(".git"), branch: "main" },
  base,
);

/** Changed base-revision lines a patch claims, deduplicated. */
function changedLineCount(patch) {
  const seen = new Set();
  for (const range of patchedLineRanges(patch)) {
    for (let line = range.startLine; line <= range.endLine; line += 1) {
      seen.add(line);
    }
  }
  return seen.size;
}

const cases = [];
let filesConsidered = 0;
let filesWithoutRanges = 0;

for (const file of changed) {
  const patch = git(
    "diff",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-renames",
    base,
    head,
    "--",
    file,
  );
  if (patch.trim().length === 0) {
    continue;
  }
  const ranges = intelligence.symbolRangesInFile(index, file);
  filesConsidered += 1;
  if (ranges === undefined || ranges.length === 0) {
    // Either the file is new at HEAD or its language is not parsed. Neither is
    // a case symbol withholding can ever apply to, so neither belongs here.
    filesWithoutRanges += 1;
    continue;
  }

  const totalHunks = (patch.match(/^@@ -/gmu) ?? []).length;
  const totalLines = changedLineCount(patch);
  const touched = namesTouchedByPatch(
    patch,
    ranges,
    ranges.map((entry) => entry.name),
  );

  for (const symbol of touched) {
    const withheld = ranges.filter((entry) => entry.name === symbol);
    const division = dividePatchByRanges(patch, withheld);
    if (division === undefined) {
      cases.push({
        file,
        symbol,
        totalHunks,
        totalLines,
        outcome: "indivisible",
        promotedHunks: 0,
        promotedLines: 0,
      });
      continue;
    }
    const promotedLines =
      division.granted === undefined ? 0 : changedLineCount(division.granted);
    cases.push({
      file,
      symbol,
      totalHunks,
      totalLines,
      outcome:
        division.granted === undefined
          ? "nothing_clear"
          : division.deferred === undefined
            ? "nothing_withheld"
            : "divided",
      promotedHunks: division.grantedHunks,
      promotedLines,
    });
  }
}

// `nothing_withheld` cases never reached the old code path either: the patch
// did not touch the symbol, so it was promoted whole before and after. They
// are excluded from the comparison, which is only about patches that *did*
// trespass and therefore used to lose the whole file.
const trespassing = cases.filter((entry) => entry.outcome !== "nothing_withheld");
const divided = trespassing.filter((entry) => entry.outcome === "divided");
const sum = (entries, key) =>
  entries.reduce((total, entry) => total + entry[key], 0);

const summary = {
  window: { base, head, commits },
  filesConsidered,
  filesWithoutSymbolRanges: filesWithoutRanges,
  trespassingCases: trespassing.length,
  dividedCases: divided.length,
  indivisibleCases: trespassing.filter((e) => e.outcome === "indivisible").length,
  nothingClearCases: trespassing.filter((e) => e.outcome === "nothing_clear")
    .length,
  // The headline: of the changed lines that a whole-file withholding would
  // have discarded, how many now reach canonical instead.
  linesTotal: sum(trespassing, "totalLines"),
  linesPromotedBefore: 0,
  linesPromotedAfter: sum(trespassing, "promotedLines"),
  hunksTotal: sum(trespassing, "totalHunks"),
  hunksPromotedAfter: sum(trespassing, "promotedHunks"),
};
summary.lineRecoveryRate =
  summary.linesTotal === 0
    ? 0
    : Number((summary.linesPromotedAfter / summary.linesTotal).toFixed(4));
summary.hunkRecoveryRate =
  summary.hunksTotal === 0
    ? 0
    : Number((summary.hunksPromotedAfter / summary.hunksTotal).toFixed(4));
summary.divisibleShare =
  trespassing.length === 0
    ? 0
    : Number((divided.length / trespassing.length).toFixed(4));

if (asJson) {
  console.log(JSON.stringify({ summary, cases }, undefined, 2));
} else {
  console.log(
    `window ${base.slice(0, 8)}..${head.slice(0, 8)} (${String(commits)} commits)`,
  );
  console.log(
    `files with symbol ranges: ${String(filesConsidered - filesWithoutRanges)}` +
      ` of ${String(filesConsidered)} changed`,
  );
  console.log(
    `trespassing cases: ${String(trespassing.length)}` +
      ` (divided ${String(divided.length)},` +
      ` nothing clear ${String(summary.nothingClearCases)},` +
      ` indivisible ${String(summary.indivisibleCases)})`,
  );
  console.log(
    `changed lines promoted: ${String(summary.linesPromotedAfter)}` +
      ` of ${String(summary.linesTotal)}` +
      ` (${String(Math.round(summary.lineRecoveryRate * 100))}%, was 0%)`,
  );
  console.log(
    `hunks promoted: ${String(summary.hunksPromotedAfter)}` +
      ` of ${String(summary.hunksTotal)}` +
      ` (${String(Math.round(summary.hunkRecoveryRate * 100))}%, was 0%)`,
  );
}
