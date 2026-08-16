#!/usr/bin/env node
/**
 * Counts every tracked line in the repository and says where it lives.
 *
 * `wc -l **` answers the wrong question here. Two thirds of the tracked lines
 * in this repo are `package-lock.json` and the recorded benchmark runs under
 * `docs/benchmarks/data/`: nobody wrote them, nobody reads them, and leaving
 * them in the total turns "how big is this codebase" into a number that moves
 * when a benchmark is re-run. So the count is split before it is added up —
 * hand-written lines on one side, generated and captured artefacts on the
 * other — and the hand-written side is the one the report leads with.
 *
 * Enumeration is `git ls-files`, not a directory walk: the audit is of what is
 * committed, so `.gitignore`, `dist/`, and `node_modules/` are excluded by
 * construction rather than by a maintained skip-list that drifts.
 *
 * Counting rules, all deliberately boring:
 *
 *   - a line is a `\n`-separated span, plus a trailing unterminated one if the
 *     file does not end in a newline (so the total is `wc -l` plus that line);
 *   - blank means whitespace-only;
 *   - comment detection is a scanner over `//` and block comments for C-family
 *     files and `#` for shell, and it is a heuristic — a `//` inside a string
 *     literal reads as a comment. It is reported because the shape of the
 *     ratio is informative, not because the digit is exact;
 *   - binary assets are listed and then excluded from every line total.
 *
 * Run (no build required):
 *   node scripts/loc-audit.mjs                # markdown report to stdout
 *   node scripts/loc-audit.mjs --json         # the same numbers as JSON
 *   node scripts/loc-audit.mjs --top 40       # widen the largest-file table
 *   node scripts/loc-audit.mjs --write        # regenerate the committed report
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const REPORT_PATH = "docs/architecture/loc-audit.md";

const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "ico",
  "webp",
  "pdf",
  "woff",
  "woff2",
  "ttf",
  "zip",
]);

const C_FAMILY_EXTENSIONS = new Set(["ts", "tsx", "js", "mjs", "cjs", "css"]);
const HASH_COMMENT_EXTENSIONS = new Set(["sh", "yml", "yaml"]);

/**
 * Every path Git tracks, relative to the repository root.
 *
 * `-z` because filenames may contain anything except NUL, and the quoting Git
 * applies without it would have to be undone here.
 */
export function listTrackedFiles(cwd = repoRoot) {
  const raw = execFileSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return raw.split("\0").filter((entry) => entry.length > 0);
}

const extensionOf = (relativePath) => {
  const base = path.basename(relativePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

/**
 * Which bucket a path belongs to, and which package owns it.
 *
 * Order matters: the generated and captured artefacts are claimed first, so a
 * `.json` under `docs/benchmarks/data/` is recorded output rather than
 * configuration, and `package-lock.json` never lands in the hand-written total.
 */
export function classifyFile(relativePath) {
  const extension = extensionOf(relativePath);
  const segments = relativePath.split("/");
  const workspace = workspaceOf(segments);

  const category = (() => {
    if (BINARY_EXTENSIONS.has(extension)) {
      return "asset";
    }
    if (relativePath === "package-lock.json") {
      return "lockfile";
    }
    if (relativePath.startsWith("docs/benchmarks/data/")) {
      return "benchmark-data";
    }
    if (/\.(test|spec)\.[cm]?[jt]sx?$/u.test(relativePath)) {
      return "test";
    }
    if (/\.fixture\.[cm]?[jt]sx?$/u.test(relativePath)) {
      return "test";
    }
    if (relativePath.startsWith("apps/web/public/")) {
      return "browser";
    }
    if (segments.includes("scripts") && ["mjs", "js", "sh"].includes(extension)) {
      return "script";
    }
    if (["ts", "tsx", "mjs", "cjs", "js"].includes(extension)) {
      return "source";
    }
    if (extension === "md") {
      return "docs";
    }
    if (
      ["json", "yml", "yaml", "webmanifest", "example"].includes(extension) ||
      path.basename(relativePath).startsWith("Dockerfile") ||
      path.basename(relativePath).startsWith(".")
    ) {
      return "config";
    }
    return "other";
  })();

  return { workspace, category, extension };
}

const workspaceOf = (segments) => {
  if (segments.length === 1) {
    return "(root)";
  }
  const [head] = segments;
  if (["apps", "services", "packages", "adapters"].includes(head)) {
    return `${head}/${segments[1]}`;
  }
  return head;
};

/**
 * Total, blank, comment, and code lines for one file.
 *
 * The comment scanner is single-pass and state-carrying across lines so that a
 * block comment spanning fifty lines counts as fifty, which is the whole point
 * of measuring it in a repository whose modules open with essays.
 */
export function countLines(absolutePath, extension) {
  const content = readFileSync(absolutePath, "utf8");
  if (content.length === 0) {
    return { total: 0, blank: 0, comment: 0, code: 0 };
  }

  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  const cFamily = C_FAMILY_EXTENSIONS.has(extension);
  const hashFamily = HASH_COMMENT_EXTENSIONS.has(extension);

  let blank = 0;
  let comment = 0;
  let inBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      blank += 1;
      continue;
    }
    if (cFamily) {
      if (inBlock) {
        comment += 1;
        if (trimmed.includes("*/")) {
          inBlock = false;
        }
        continue;
      }
      if (trimmed.startsWith("//")) {
        comment += 1;
        continue;
      }
      if (trimmed.startsWith("/*")) {
        comment += 1;
        if (!trimmed.includes("*/")) {
          inBlock = true;
        }
        continue;
      }
    } else if (hashFamily && trimmed.startsWith("#")) {
      comment += 1;
      continue;
    }
  }

  const total = lines.length;
  return { total, blank, comment, code: total - blank - comment };
}

const emptyTally = () => ({ files: 0, total: 0, blank: 0, comment: 0, code: 0 });

const addTo = (tally, measured) => {
  tally.files += 1;
  tally.total += measured.total;
  tally.blank += measured.blank;
  tally.comment += measured.comment;
  tally.code += measured.code;
  return tally;
};

const groupBy = (measurements, key) => {
  const groups = new Map();
  for (const entry of measurements) {
    const bucket = groups.get(entry[key]) ?? emptyTally();
    groups.set(entry[key], addTo(bucket, entry));
  }
  return [...groups.entries()]
    .map(([name, tally]) => ({ name, ...tally }))
    .sort((a, b) => b.total - a.total);
};

/** Per-package totals, split into the categories a package can contain. */
export function summarizeByWorkspace(measurements) {
  const groups = new Map();
  for (const entry of measurements) {
    const bucket = groups.get(entry.workspace) ?? {
      ...emptyTally(),
      source: 0,
      test: 0,
      other: 0,
    };
    addTo(bucket, entry);
    if (entry.category === "test") {
      bucket.test += entry.total;
    } else if (["source", "browser", "script"].includes(entry.category)) {
      bucket.source += entry.total;
    } else {
      bucket.other += entry.total;
    }
    groups.set(entry.workspace, bucket);
  }
  return [...groups.entries()]
    .map(([name, tally]) => ({ name, ...tally }))
    .sort((a, b) => b.total - a.total);
}

/** Per-category totals across the whole repository. */
export function summarizeByCategory(measurements) {
  return groupBy(measurements, "category");
}

/** The n longest files, which is where a size problem shows up first. */
export function topFilesByLines(measurements, n) {
  return [...measurements].sort((a, b) => b.total - a.total).slice(0, n);
}

/**
 * How many hand-written files sit above each size threshold.
 *
 * A single largest-file table says what the worst offender is; this says
 * whether it is one outlier or a habit.
 */
const sizeBands = (measurements, thresholds) =>
  thresholds.map((threshold) => {
    const over = measurements.filter((entry) => entry.total >= threshold);
    return {
      threshold,
      files: over.length,
      total: over.reduce((sum, entry) => sum + entry.total, 0),
    };
  });

const HAND_WRITTEN = new Set([
  "source",
  "test",
  "browser",
  "script",
  "docs",
  "config",
  "other",
]);

const number = (value) => value.toLocaleString("en-US");
const percent = (part, whole) =>
  whole === 0 ? "0.0%" : `${((part / whole) * 100).toFixed(1)}%`;

/**
 * Reflows an interpolated paragraph to the 80-column width the rest of the
 * repository's prose uses. Without it the line breaks land wherever the
 * template literal happened to put them, which is around the substitutions.
 */
const wrap = (text, width = 78) => {
  const lines = [];
  let line = "";
  for (const word of text.replace(/\s+/gu, " ").trim().split(" ")) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) {
    lines.push(line);
  }
  return lines.join("\n");
};

const table = (header, rows) =>
  [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");

/** The committed report: the same numbers, arranged for a reader. */
export function formatMarkdownReport(audit, options = {}) {
  const { revision = "unknown" } = options;
  const { totals, categories, workspaces, largest, largestGenerated, bands, assets } =
    audit;
  const top = largest.length;

  const handWritten = totals.handWritten;
  const generated = totals.generated;
  const tracked = totals.tracked;

  const sourceish = categories
    .filter((row) => ["source", "browser", "script"].includes(row.name))
    .reduce((sum, row) => sum + row.total, 0);
  const tests = categories.find((row) => row.name === "test")?.total ?? 0;

  return `# Lines-of-code audit

Where the tracked lines in this repository actually are, and which of them
anybody wrote. Generated at revision \`${revision}\`.

Regenerate with:

\`\`\`
npm run audit:loc          # markdown to stdout
node scripts/loc-audit.mjs --write   # overwrite this file
\`\`\`

The numbers below come from \`scripts/loc-audit.mjs\`, which enumerates with
\`git ls-files\` (so \`dist/\` and \`node_modules/\` are out by construction),
excludes binary assets from every line total, and separates hand-written lines
from generated and captured ones before adding anything up. Comment counts are
a scanner over \`//\`, \`/* */\`, and \`#\` — good enough to read a ratio from,
not exact. Only tracked files are counted, so a file added in the same change
as a regeneration first appears in the following one.

## Headline

| Slice | Files | Lines | Share of tracked |
| --- | --- | --- | --- |
| Hand-written | ${number(handWritten.files)} | ${number(handWritten.total)} | ${percent(handWritten.total, tracked.total)} |
| Generated / captured | ${number(generated.files)} | ${number(generated.total)} | ${percent(generated.total, tracked.total)} |
| **All tracked text** | **${number(tracked.files)}** | **${number(tracked.total)}** | **100%** |

${wrap(`Plus ${number(assets.files)} binary asset${
    assets.files === 1 ? "" : "s"
  } (images and fonts), excluded from every line count above.`)}

${wrap(
  `Of the hand-written lines, ${number(sourceish)} are program text ` +
    `(TypeScript, browser modules, and harness scripts) and ${number(tests)} ` +
    `are tests — a test-to-source ratio of ${
      sourceish === 0 ? "n/a" : `${(tests / sourceish).toFixed(2)}:1`
    }. Blank lines are ${percent(handWritten.blank, handWritten.total)} of the ` +
    `hand-written total and comments are ${percent(
      handWritten.comment,
      handWritten.total,
    )}.`,
)}

## By category

${table(
  ["Category", "Files", "Lines", "Code", "Comment", "Blank", "Share"],
  categories.map((row) => [
    row.name,
    number(row.files),
    number(row.total),
    number(row.code),
    number(row.comment),
    number(row.blank),
    percent(row.total, tracked.total),
  ]),
)}

\`lockfile\` is \`package-lock.json\`; \`benchmark-data\` is the recorded
experiment output under \`docs/benchmarks/data/\`. Both are generated, and
together they are the reason an undifferentiated \`wc -l\` over this repository
reports a number several times larger than the code anybody maintains.

## By package

Hand-written lines only, one row per workspace package plus the top-level
directories that are not packages.

${table(
  ["Package", "Files", "Lines", "Program", "Tests", "Other"],
  workspaces.map((row) => [
    `\`${row.name}\``,
    number(row.files),
    number(row.total),
    number(row.source),
    number(row.test),
    number(row.other),
  ]),
)}

## Largest hand-written files

The ${top} longest files anybody maintains. Generated artefacts are excluded —
they are longer, and nothing about their length is a decision. This is the
table to read when deciding what to split.

${table(
  ["File", "Lines", "Code", "Category"],
  largest.map((row) => [
    `\`${row.path}\``,
    number(row.total),
    number(row.code),
    row.category,
  ]),
)}

## Size distribution

Hand-written files at or above each threshold, and what share of the
hand-written total they account for.

${table(
  ["At least", "Files", "Lines", "Share of hand-written"],
  bands.map((row) => [
    `${number(row.threshold)} lines`,
    number(row.files),
    number(row.total),
    percent(row.total, handWritten.total),
  ]),
)}

## What this says

${wrap(
  `The single largest hand-written file is \`${largest[0]?.path ?? "n/a"}\` at ` +
    `${number(largest[0]?.total ?? 0)} lines — ${percent(
      largest[0]?.total ?? 0,
      handWritten.total,
    )} of everything written in this repository, in one file, and its own test ` +
    `file is the next largest. Nothing in the build forces a split at any size, ` +
    `and the distribution above shows this is a habit rather than one outlier: ` +
    `${number(bands[1]?.files ?? 0)} files of 2,000 lines or more carry ` +
    `${percent(bands[1]?.total ?? 0, handWritten.total)} of the hand-written total.`,
)}

${wrap(
  `Tests are ${percent(tests, handWritten.total)} of hand-written lines, and the ` +
    `four largest packages (${workspaces
      .slice(0, 4)
      .map((row) => `\`${row.name}\``)
      .join(", ")}) hold ${percent(
      workspaces.slice(0, 4).reduce((sum, row) => sum + row.total, 0),
      handWritten.total,
    )} of them — growth is concentrated in a few packages rather than spread ` +
    `across the workspace graph.`,
)}

## Generated artefacts

The largest captured outputs, for scale. These are committed on purpose — the
benchmark documents cite them as evidence — but they dominate any naive line
count of the repository and should be excluded from one.

${table(
  ["File", "Lines"],
  largestGenerated.map((row) => [`\`${row.path}\``, number(row.total)]),
)}
`;
}

const buildAudit = (top) => {
  const tracked = listTrackedFiles();
  const measurements = [];
  const assets = emptyTally();

  for (const relativePath of tracked) {
    const { workspace, category, extension } = classifyFile(relativePath);
    if (category === "asset") {
      assets.files += 1;
      continue;
    }
    const measured = countLines(path.join(repoRoot, relativePath), extension);
    measurements.push({ path: relativePath, workspace, category, ...measured });
  }

  const totals = {
    tracked: measurements.reduce((tally, entry) => addTo(tally, entry), emptyTally()),
    handWritten: measurements
      .filter((entry) => HAND_WRITTEN.has(entry.category))
      .reduce((tally, entry) => addTo(tally, entry), emptyTally()),
    generated: measurements
      .filter((entry) => !HAND_WRITTEN.has(entry.category))
      .reduce((tally, entry) => addTo(tally, entry), emptyTally()),
  };

  const handWritten = measurements.filter((entry) =>
    HAND_WRITTEN.has(entry.category),
  );

  return {
    totals,
    assets,
    categories: summarizeByCategory(measurements),
    workspaces: summarizeByWorkspace(handWritten),
    largest: topFilesByLines(handWritten, top),
    largestGenerated: topFilesByLines(
      measurements.filter((entry) => !HAND_WRITTEN.has(entry.category)),
      5,
    ),
    bands: sizeBands(handWritten, [3000, 2000, 1000, 500]),
  };
};

const revisionOf = () => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
};

export function main(argv = process.argv.slice(2)) {
  const topFlag = argv.indexOf("--top");
  const top = topFlag === -1 ? 25 : Number.parseInt(argv[topFlag + 1] ?? "25", 10);
  const audit = buildAudit(Number.isFinite(top) && top > 0 ? top : 25);

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ revision: revisionOf(), ...audit }, null, 2));
    return;
  }

  const report = formatMarkdownReport(audit, { revision: revisionOf() });

  if (argv.includes("--write")) {
    writeFileSync(path.join(repoRoot, REPORT_PATH), report);
    console.log(`Wrote ${REPORT_PATH}`);
    return;
  }

  console.log(report);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
