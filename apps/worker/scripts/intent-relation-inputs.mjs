#!/usr/bin/env node
/**
 * What does the repository actually give a pair-scoring rule to work with?
 *
 * The grounded intent signal missed the 80% bar at 70% precision, and the
 * write-up blamed the *relation* rather than the grounding: once both tasks
 * are on real modules, `total.js -> discount.js` is the same edge whether the
 * caller-side task is rewriting how inputs are combined or wrapping the result.
 * The proposed fix was to go finer — function-call reachability instead of
 * file adjacency.
 *
 * This script exists to test that proposal without measuring anything, because
 * for the decisive pairs it can be settled by inspection. It prints, for every
 * pair, the complete input any structural rule has: each side's grounded
 * files, the symbols the intent reaches inside them, and the call and import
 * edges between them. If two pairs with *opposite* labels print identical
 * inputs, then no function of those inputs separates them, and no amount of
 * tuning a rule over them will. That is a proof rather than a measurement, and
 * it costs no held-out data to establish.
 *
 * Usage (from the repository root, after `npx turbo run build`):
 *
 *   node apps/worker/scripts/intent-relation-inputs.mjs \
 *     docs/benchmarks/data/team-queue/team-queue-coordinated-live3-*.json
 *
 * `--pairs=a+b,c+d` restricts output to named scenario task pairs.
 */

import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  TEAM_QUEUE_BANDS,
  TEAM_QUEUE_SCENARIO,
  TEAM_QUEUE_TRUE_CONFLICTS,
} from "./team-queue-scenario.mjs";
import { splitOf } from "./intent-holdout.mjs";

/** The split a recorded `left|right [run]` bucket entry belongs to. */
const splitOfPair = (entry) => {
  const [left, right] = entry.split(" ")[0].split("|");
  return splitOf(left, right);
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const fromDist = async (pkg, file) =>
  import(
    `file:///${path.join(REPO_ROOT, pkg, "dist", file).replaceAll("\\", "/")}`
  );

const { RepositoryService } = await fromDist(
  "services/repository-service",
  "index.js",
);
const { CodeIntelligenceService, groundIntent, assessGroundedIntent } =
  await fromDist("services/code-intelligence", "index.js");

const args = process.argv.slice(2);
const files = args.filter((entry) => entry.endsWith(".json"));
const only = args
  .find((entry) => entry.startsWith("--pairs="))
  ?.slice("--pairs=".length)
  .split(",")
  .map((entry) => entry.split("+").sort().join("|"));
if (files.length === 0) {
  throw new Error("pass one or more team-queue run JSON files");
}

const root = await mkdtemp(path.join(tmpdir(), "intent-relations-"));
const sourcePath = path.join(root, "src-repo");
const repositories = new RepositoryService();
await repositories.initializeWorkingRepository(sourcePath);
for (const [file, contents] of Object.entries(TEAM_QUEUE_SCENARIO.seed)) {
  const target = path.join(sourcePath, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}
await repositories.commitAll(sourcePath, "seed");
const canonical = await repositories.importLocalRepository(
  sourcePath,
  path.join(root, "canon.git"),
  "repo_team_queue_relations",
  "main",
);
const index = await new CodeIntelligenceService(repositories).index(
  canonical,
  canonical.branch,
);
await rm(root, { recursive: true, force: true });

console.log("call graph, as the index records it:");
for (const file of index.files) {
  const internal = file.symbolCalls.filter((call) =>
    index.files.some(
      (other) => other.path !== file.path && other.symbols.includes(call.to),
    ),
  );
  for (const call of internal) {
    console.log(`  ${file.path}#${call.from} -> ${call.to}`);
  }
}

const pairKey = (a, b) => [a, b].sort().join("|");

function initialPlans(run) {
  const byTask = new Map();
  for (const entry of run.plans ?? []) {
    if (entry.scenarioTaskId === undefined) {
      continue;
    }
    const current = byTask.get(entry.scenarioTaskId);
    if (current === undefined || entry.revision < current.revision) {
      byTask.set(entry.scenarioTaskId, entry);
    }
  }
  return byTask;
}

/** The complete structural input for one pair, as a comparable string. */
function fingerprint(left, right, edges) {
  const side = (grounding) =>
    grounding.targets
      .map((target) => `${target.file}{${target.symbols.join(",")}}`)
      .sort()
      .join(" ");
  return [
    `L=${side(left) || "-"}`,
    `R=${side(right) || "-"}`,
    `E=${edges.join(";") || "-"}`,
  ].join("  ");
}

/** Call and import edges between two groundings, in either direction. */
function edgesBetween(left, right) {
  const reached = (grounding) =>
    new Set(
      grounding.targets.flatMap((target) =>
        target.symbols.map((symbol) => `${target.file}#${symbol}`),
      ),
    );
  const leftFiles = new Set(left.targets.map((target) => target.file));
  const rightFiles = new Set(right.targets.map((target) => target.file));
  const leftSymbols = reached(left);
  const rightSymbols = reached(right);
  const declaring = new Map();
  for (const file of index.files) {
    for (const symbol of file.symbols) {
      declaring.set(symbol, [...(declaring.get(symbol) ?? []), file.path]);
    }
  }
  const found = new Set();
  for (const file of index.files) {
    for (const call of file.symbolCalls) {
      const from = `${file.path}#${call.from}`;
      for (const target of declaring.get(call.to) ?? []) {
        const to = `${target}#${call.to}`;
        if (
          (leftSymbols.has(from) && rightSymbols.has(to)) ||
          (rightSymbols.has(from) && leftSymbols.has(to))
        ) {
          found.add(`call ${from} -> ${to}`);
        }
      }
    }
  }
  for (const edge of index.edges) {
    if (edge.kind !== "import" || edge.toFile === undefined) {
      continue;
    }
    if (
      (leftFiles.has(edge.fromFile) && rightFiles.has(edge.toFile)) ||
      (rightFiles.has(edge.fromFile) && leftFiles.has(edge.toFile))
    ) {
      found.add(`import ${edge.fromFile} -> ${edge.toFile}`);
    }
  }
  return [...found].sort();
}

const byFingerprint = new Map();
/** The same pairs bucketed by what a *rule* consumes, not by their full input. */
const byTier = new Map();

for (const file of files) {
  const run = { file: path.basename(file), ...JSON.parse(await readFile(file, "utf8")) };
  const plans = initialPlans(run);
  const ids = [...plans.keys()].sort();
  const grounded = new Map();
  for (const id of ids) {
    const plan = plans.get(id).plan;
    grounded.set(id, groundIntent(plan.intent ?? plan.objective, index));
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log(`${run.arm} / ${run.label}`);
  console.log("=".repeat(78));
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const key = pairKey(ids[i], ids[j]);
      if (only !== undefined && !only.includes(key)) {
        continue;
      }
      const left = grounded.get(ids[i]);
      const right = grounded.get(ids[j]);
      const edges = edgesBetween(left, right);
      const print = fingerprint(left, right, edges);
      const truth = TEAM_QUEUE_TRUE_CONFLICTS.has(key);
      const bands = `${TEAM_QUEUE_BANDS[ids[i]]}/${TEAM_QUEUE_BANDS[ids[j]]}`;
      console.log(
        `${truth ? "CONFLICT    " : "non-conflict"} ${ids[i]} + ${ids[j]} [${bands}]`,
      );
      console.log(`             ${print}`);
      const bucket = byFingerprint.get(print) ?? { conflict: [], other: [] };
      (truth ? bucket.conflict : bucket.other).push(`${key} [${run.file}]`);
      byFingerprint.set(print, bucket);

      const leftPlan = plans.get(ids[i]).plan;
      const rightPlan = plans.get(ids[j]).plan;
      const assessment = assessGroundedIntent(
        { text: leftPlan.intent ?? leftPlan.objective, grounding: left },
        { text: rightPlan.intent ?? rightPlan.objective, grounding: right },
        index,
      );
      // The structural tier, read off the edge sets rather than off
      // `relation` — which is only assigned once corroboration has passed, and
      // so would file a vetoed pair under "none" and hide the veto's cost.
      const structural =
        assessment.sharedTargets.length > 0
          ? "shared"
          : assessment.callTargets.length > 0
            ? "calls"
            : assessment.adjacentTargets.length > 0
              ? "adjacent"
              : "none";
      const tier =
        `${structural}` +
        `/${assessment.corroboration.length > 0 ? "corroborated" : "bare"}`;
      const tierBucket = byTier.get(tier) ?? { conflict: [], other: [] };
      (truth ? tierBucket.conflict : tierBucket.other).push(
        `${key} [${run.file}]`,
      );
      byTier.set(tier, tierBucket);
    }
  }
}

console.log(`\n${"-".repeat(78)}`);
console.log("structural inputs shared by pairs with opposite labels");
console.log("-".repeat(78));
let collisions = 0;
for (const [print, bucket] of byFingerprint) {
  if (bucket.conflict.length === 0 || bucket.other.length === 0) {
    continue;
  }
  collisions += 1;
  console.log(`\n  ${print}`);
  console.log(`    labelled CONFLICT:     ${bucket.conflict.join(", ")}`);
  console.log(`    labelled non-conflict: ${bucket.other.join(", ")}`);
}
if (collisions === 0) {
  console.log("\n  none — every distinct input has one label");
} else {
  console.log(
    `\n${collisions} input(s) carry both labels. No rule that reads only ` +
      "grounded targets,\nreached symbols and the repository graph can " +
      "separate these, at any operating point.",
  );
}

/**
 * The ceiling: how well could the *best possible* such rule do?
 *
 * An oracle that has already seen every label picks, for each distinct
 * structural input, whether to fire — and picks correctly, firing exactly when
 * conflicts outnumber non-conflicts among the pairs sharing that input. No
 * real rule can beat this, because a real rule cannot distinguish two pairs
 * this one cannot distinguish either, and this one gets every remaining choice
 * right by construction.
 *
 * This is a bound, not a score. It is computed *with* the labels and is not an
 * operating point anyone could reach without them. Its only use is the
 * negative one: if the ceiling is below the bar, no amount of further work on
 * rules of this class clears the bar on this corpus.
 */
/**
 * How much of the ceiling is memorisation?
 *
 * An oracle over sufficiently fine inputs is not measuring signal, it is
 * looking each pair up. If most inputs occur once, the ceiling is near 100% by
 * construction and means nothing. The ceiling is only informative to the
 * extent that inputs *repeat* and the oracle still gets them right.
 */
console.log(`\n${"-".repeat(78)}`);
console.log("input multiplicity — is the ceiling memorisation?");
console.log("-".repeat(78));
{
  const sizes = [...byFingerprint.values()].map(
    (bucket) => bucket.conflict.length + bucket.other.length,
  );
  const pairs = sizes.reduce((total, size) => total + size, 0);
  const singletons = sizes.filter((size) => size === 1).length;
  const inSingletons = singletons;
  console.log(`  distinct inputs            ${sizes.length}`);
  console.log(`  pairs                      ${pairs}`);
  console.log(
    `  inputs occurring once      ${singletons} ` +
      `(covering ${inSingletons} of ${pairs} pairs, ` +
      `${((inSingletons / pairs) * 100).toFixed(0)}%)`,
  );
  console.log(
    `  mean pairs per input       ${(pairs / sizes.length).toFixed(2)}`,
  );
}

console.log(`\n${"-".repeat(78)}`);
console.log("oracle ceiling for any rule over these inputs");
console.log("-".repeat(78));
ceiling("full structural input (fine — see multiplicity above)", byFingerprint);

/**
 * The ceiling over what a rule actually reads.
 *
 * `assessGroundedIntent` reduces every pair to a relation tier and whether it
 * is lexically corroborated. That is the real input class: a handful of
 * buckets, each covering many pairs, which an oracle cannot memorise its way
 * through. If the best achievable precision over *these* is below the bar,
 * then no choice of weights, thresholds or veto over this relation vocabulary
 * clears it, and the next move has to widen the vocabulary rather than tune it.
 */
for (const split of ["development", "held-out"]) {
  console.log(`\n${"-".repeat(78)}`);
  console.log(`conflict rate per relation tier — ${split} pairs`);
  console.log("-".repeat(78));
  for (const [tier, bucket] of [...byTier].sort()) {
    const side = (list) =>
      list.filter((entry) => splitOfPair(entry) === split).length;
    const conflicts = side(bucket.conflict);
    const others = side(bucket.other);
    if (conflicts + others === 0) {
      continue;
    }
    console.log(
      `  ${tier.padEnd(24)} conflicts=${String(conflicts).padStart(2)} ` +
        `non-conflicts=${String(others).padStart(2)}  ` +
        `purity=${((Math.max(conflicts, others) / (conflicts + others)) * 100).toFixed(0)}%`,
    );
  }
}
ceiling("relation tier (coarse — what a rule can actually use)", byTier);

function ceiling(title, buckets) {
console.log(`\n${"-".repeat(78)}`);
console.log(`oracle ceiling — ${title}`);
console.log("-".repeat(78));
for (const [name, keep] of [
  ["all pairs", () => true],
  ["development", (split) => split === "development"],
  ["held-out", (split) => split === "held-out"],
]) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const bucket of buckets.values()) {
    const conflicts = bucket.conflict.filter((entry) =>
      keep(splitOfPair(entry)),
    ).length;
    const others = bucket.other.filter((entry) =>
      keep(splitOfPair(entry)),
    ).length;
    if (conflicts === 0 && others === 0) {
      continue;
    }
    if (conflicts > others) {
      tp += conflicts;
      fp += others;
    } else {
      fn += conflicts;
    }
  }
  const precision = tp + fp === 0 ? undefined : tp / (tp + fp);
  const recall = tp + fn === 0 ? undefined : tp / (tp + fn);
  console.log(
    `  ${name.padEnd(12)} TP=${String(tp).padStart(3)} FP=${String(fp).padStart(3)} ` +
      `FN=${String(fn).padStart(3)}  ` +
      `precision=${precision === undefined ? "n/a" : `${(precision * 100).toFixed(0)}%`} ` +
      `recall=${recall === undefined ? "n/a" : `${(recall * 100).toFixed(0)}%`}`,
  );
}
}
