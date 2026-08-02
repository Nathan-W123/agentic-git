#!/usr/bin/env node
/**
 * The grounding recall floor: does one task's intent land on one module?
 *
 * The team-queue evaluation asks whether two *different* tasks collide. This
 * asks the easiest question that still uses real agent writing, so a failure
 * on the hard one can be attributed to the hard part.
 *
 * `docs/benchmarks/data/grounding/*replan-substitution*` holds forty runs of
 * the same request, `task_checkout_fee`, each carrying the intent sentence a
 * real agent wrote for it that time. Every one of them is the same work
 * described differently, so a grounding that is doing its job puts all forty
 * on the same file.
 *
 * This corpus is the interesting case for grounding specifically, because it
 * is the recorded hallucination. Those agents declared `src/checkout.js` and
 * `calculateTotal`; the repository contains neither, and `orderTotal` in
 * `src/pricing/total.js` is what they meant. Plan grounding recovers that from
 * the *symbol*. Nothing here reads a declaration at all — the question is
 * whether the sentence alone reaches the same file.
 *
 * There are no negatives here, so this measures recall and nothing else, and
 * nothing was tuned against it.
 *
 * Only files git is tracking are read. Sample files land in that directory
 * while other experiments run, and a measurement whose denominator depends on
 * what happened to be on disk is not reproducible.
 *
 * Usage (from the repository root, after `npx turbo run build`):
 *
 *   node apps/worker/scripts/intent-grounding-recall-floor.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const fromDist = async (pkg, file) =>
  import(
    `file:///${path.join(REPO_ROOT, pkg, "dist", file).replaceAll("\\", "/")}`
  );

const { RepositoryService } = await fromDist(
  "services/repository-service",
  "index.js",
);
const { CodeIntelligenceService, groundIntent } = await fromDist(
  "services/code-intelligence",
  "index.js",
);
const { LIVE_CHECKOUT_TRIO_SCENARIO } = await fromDist(
  "apps/cli",
  "live-scenario.js",
);

const directory =
  process.argv[2] ??
  path.join(REPO_ROOT, "docs", "benchmarks", "data", "grounding");

const tracked = execFileSync("git", ["ls-files", "--", directory], {
  cwd: REPO_ROOT,
  encoding: "utf8",
})
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

const intents = [];
for (const relative of tracked) {
  const name = path.basename(relative);
  if (!name.includes("replan-substitution") || !name.endsWith(".json")) {
    continue;
  }
  const run = JSON.parse(await readFile(path.join(REPO_ROOT, relative), "utf8"));
  const intent = run.firstPlan?.intent;
  if (typeof intent === "string" && intent.length > 0) {
    intents.push({
      sample: `${run.label}#${run.sample}`,
      taskId: run.taskId,
      intent,
      declaredFiles: run.firstPlan?.expectedFiles ?? [],
    });
  }
}
if (intents.length < 2) {
  throw new Error(`found ${intents.length} intents; need at least two`);
}
const tasks = new Set(intents.map((entry) => entry.taskId));
if (tasks.size !== 1) {
  throw new Error(
    `expected one task, found ${[...tasks].join(", ")} — the "same work" ` +
      "premise no longer holds and this is not a recall floor",
  );
}

/** An index over the seed these runs were executed against. */
const root = await mkdtemp(path.join(tmpdir(), "intent-grounding-floor-"));
const sourcePath = path.join(root, "src-repo");
const repositories = new RepositoryService();
await repositories.initializeWorkingRepository(sourcePath);
for (const [file, contents] of Object.entries(LIVE_CHECKOUT_TRIO_SCENARIO.seed)) {
  const target = path.join(sourcePath, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}
await repositories.commitAll(sourcePath, "seed");
const canonical = await repositories.importLocalRepository(
  sourcePath,
  path.join(root, "canon.git"),
  "repo_checkout_trio_grounding_floor",
  "main",
);
const index = await new CodeIntelligenceService(repositories).index(
  canonical,
  canonical.branch,
);
await rm(root, { recursive: true, force: true });

const byTarget = new Map();
let grounded = 0;
// Split by whether the plan declared a file that exists. The subgroup that
// did not is the one structural evidence has nothing to arbitrate on, and it
// is the whole reason to want this signal, so its rate is reported separately
// rather than folded into the total.
const withRealFile = { total: 0, grounded: 0, onTotalJs: 0 };
const withoutRealFile = { total: 0, grounded: 0, onTotalJs: 0 };
const TRUE_TARGET = "src/pricing/total.js";
for (const entry of intents) {
  const grounding = groundIntent(entry.intent, index);
  const top = grounding.targets[0]?.file;
  if (top !== undefined) {
    grounded += 1;
    byTarget.set(top, (byTarget.get(top) ?? 0) + 1);
  } else {
    byTarget.set("(none)", (byTarget.get("(none)") ?? 0) + 1);
  }
  const real = entry.declaredFiles.some((file) => index.paths.includes(file));
  const bucket = real ? withRealFile : withoutRealFile;
  bucket.total += 1;
  bucket.grounded += top === undefined ? 0 : 1;
  bucket.onTotalJs += top === TRUE_TARGET ? 1 : 0;
}
const declaredFileExists = withRealFile.total;
const share = (part, whole) =>
  whole === 0 ? " n/a" : `${((part / whole) * 100).toFixed(0)}%`;

/** Do two phrasings of the same work ground to a shared target? */
let pairs = 0;
let agreeing = 0;
const groundings = intents.map((entry) => groundIntent(entry.intent, index));
for (let i = 0; i < groundings.length; i += 1) {
  for (let j = i + 1; j < groundings.length; j += 1) {
    pairs += 1;
    const left = new Set(groundings[i].targets.map((target) => target.file));
    const right = groundings[j].targets.map((target) => target.file);
    if (right.some((file) => left.has(file))) {
      agreeing += 1;
    }
  }
}

console.log(`task under test          ${[...tasks][0]}`);
console.log(`repository revision      ${index.revision} (${index.paths.length} paths)`);
console.log(`distinct agent intents   ${intents.length}`);
console.log(
  `intents naming a real file  ${declaredFileExists} ` +
    `(${((declaredFileExists / intents.length) * 100).toFixed(0)}% — the ` +
    "declarations this signal never reads)",
);
console.log(
  `grounded                 ${grounded} ` +
    `(${((grounded / intents.length) * 100).toFixed(0)}%)`,
);
console.log(
  `same-work pairs agreeing ${agreeing} of ${pairs} ` +
    `(${((agreeing / pairs) * 100).toFixed(0)}%)`,
);
console.log(`\nby whether the plan declared a file that exists:`);
for (const [name, bucket] of [
  ["declared a real file", withRealFile],
  ["declared none that exist", withoutRealFile],
]) {
  console.log(
    `  ${name.padEnd(26)} n=${String(bucket.total).padStart(3)}  ` +
      `grounded ${share(bucket.grounded, bucket.total).padStart(4)}  ` +
      `on ${TRUE_TARGET} ${share(bucket.onTotalJs, bucket.total).padStart(4)}`,
  );
}
console.log("\ntop target by intent:");
for (const [file, count] of [...byTarget].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}  ${file}`);
}
