#!/usr/bin/env node
/**
 * Scores intent-level conflict signals against the team-queue corpus, on one
 * side of the registered split at a time.
 *
 * The split — `intent-holdout.mjs` — is by agent id, and this script will not
 * let you evaluate both halves in one command. That is the whole point: the
 * held-out half is worth something only for as long as nobody has seen how a
 * candidate scores on it, and a report that prints both side by side is an
 * invitation to tune until the right-hand column looks good.
 *
 * Usage:
 *
 *   node apps/worker/scripts/intent-signal-eval.mjs --split=development \
 *     docs/benchmarks/data/team-queue/*.json
 *   node apps/worker/scripts/intent-signal-eval.mjs --split=held-out \
 *     docs/benchmarks/data/team-queue/*.json
 *
 * `--json` writes the full per-pair table to stdout instead of the summary,
 * for the record kept in `docs/benchmarks/`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  TEAM_QUEUE_BANDS,
  TEAM_QUEUE_SCENARIO,
  TEAM_QUEUE_TRUE_CONFLICTS,
} from "./team-queue-scenario.mjs";
import { splitOf, TASK_AGENTS } from "./intent-holdout.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const fromDist = async (pkg, file) =>
  import(
    `file:///${path
      .join(REPO_ROOT, pkg, "dist", file)
      .replaceAll("\\", "/")}`
  );

const { analyzeIntentPair, IntentEmbedder, DEFAULT_INTENT_SIGNAL_OPTIONS } =
  await fromDist("packages/intent-analysis", "index.js");

// The split was registered against a fixed agent assignment. If the scenario
// is edited so that a task changes hands, the recorded split silently stops
// meaning what it says, so refuse rather than re-split.
for (const entry of TEAM_QUEUE_SCENARIO.tasks) {
  const expected = TASK_AGENTS[entry.task.id];
  if (expected !== entry.task.agentId) {
    throw new Error(
      `held-out split is stale: ${entry.task.id} is now owned by ` +
        `${entry.task.agentId}, registered as ${expected}`,
    );
  }
}

const args = process.argv.slice(2);
const files = args.filter((entry) => entry.endsWith(".json"));
const wantedSplit =
  args.find((entry) => entry.startsWith("--split="))?.slice("--split=".length) ??
  "development";
const asJson = args.includes("--json");
const overrides = Object.fromEntries(
  args
    .filter((entry) => entry.startsWith("--opt:"))
    .map((entry) => {
      const [name, value] = entry.slice("--opt:".length).split("=");
      return [name, value === "true" ? true : value === "false" ? false : Number(value)];
    }),
);
if (!["development", "held-out"].includes(wantedSplit)) {
  throw new Error(`--split must be development or held-out, got ${wantedSplit}`);
}
if (files.length === 0) {
  throw new Error("pass one or more team-queue run JSON files");
}

const options = { ...DEFAULT_INTENT_SIGNAL_OPTIONS, ...overrides };

const pairKey = (a, b) => [a, b].sort().join("|");

/** The lexical-only baselines, kept so the new signal is compared to something. */
const LEGACY_ACTIONS = [
  ["add", "remove"], ["allow", "deny"], ["create", "delete"],
  ["enable", "disable"], ["expand", "restrict"], ["introduce", "eliminate"],
  ["migrate", "rollback"], ["publish", "hide"], ["require", "optional"],
  ["start", "stop"],
];
const LEGACY_STOP = new Set([
  "a", "an", "and", "for", "from", "in", "of", "on", "or", "the", "to", "with",
]);
const legacyWords = (value) =>
  new Set(
    (value ?? "")
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]*/gu)
      ?.filter((word) => !LEGACY_STOP.has(word)) ?? [],
  );

/** `intent_conflict` exactly as shipped, for the before/after column. */
function shippedSignal(leftText, rightText) {
  const left = legacyWords(leftText);
  const right = legacyWords(rightText);
  const shared = [...left].filter(
    (word) =>
      right.has(word) &&
      word.length > 2 &&
      !LEGACY_ACTIONS.some(([a, b]) => word === a || word === b),
  );
  const opposed = LEGACY_ACTIONS.some(
    ([a, b]) => (left.has(a) && right.has(b)) || (left.has(b) && right.has(a)),
  );
  return shared.length > 0 && opposed;
}

/** One plan per task: the first revision, which is what first arbitration saw. */
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

/** Which pairs actually contended, from the arm with a common base. */
function observedConflicts(run) {
  if (run.arm !== "uncoordinated") {
    return undefined;
  }
  const files = new Map();
  for (const entry of run.outcome?.patchFiles ?? []) {
    if (entry.scenarioTaskId !== undefined) {
      files.set(entry.scenarioTaskId, new Set(entry.files));
    }
  }
  if (files.size === 0) {
    for (const entry of run.outcome?.merges ?? []) {
      const known = run.tasks.find((task) => task.id === entry.taskId);
      if (known?.scenarioTaskId !== undefined) {
        files.set(known.scenarioTaskId, new Set(entry.conflictedFiles ?? []));
      }
    }
  }
  const ids = [...files.keys()];
  const conflicts = new Set();
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const left = files.get(ids[i]);
      const right = files.get(ids[j]);
      if ([...left].some((file) => right.has(file))) {
        conflicts.add(pairKey(ids[i], ids[j]));
      }
    }
  }
  return conflicts;
}

const runs = [];
for (const file of files) {
  runs.push({ file: path.basename(file), ...JSON.parse(await readFile(file, "utf8")) });
}

// Embed every intent in the corpus in one batch. Embedding is not selective:
// the vectors are the same whichever split a pair lands in, and computing them
// per-split would only make the two runs of this script incomparable.
const embedder = new IntentEmbedder({
  cacheDirectory: path.join(REPO_ROOT, ".model-cache"),
});
const texts = new Set();
for (const run of runs) {
  for (const entry of initialPlans(run).values()) {
    texts.add(entry.plan.intent ?? entry.plan.objective);
  }
}
const ordered = [...texts];
const vectors = await embedder.embed(ordered);
if (vectors === undefined) {
  // Not fatal: the lexical half of the signal, and the shipped-signal
  // baseline it is compared against, both still run. The continuous score
  // does not, so every "corroborated + embedding" row will read as silent —
  // which is a missing dependency, not a result.
  console.error(
    `embeddings unavailable (${embedder.unavailableReason()});\n` +
      "the continuous score cannot be computed and the new signal will " +
      "report zero firings. Install the model with:\n" +
      "  npm install --no-save @xenova/transformers",
  );
}
const embeddings = new Map(
  ordered.map((text, index) => [text, vectors?.[index]]),
);

function matrix(rows, fires) {
  const tp = rows.filter((r) => fires(r) && r.truth).length;
  const fp = rows.filter((r) => fires(r) && !r.truth).length;
  const fn = rows.filter((r) => !fires(r) && r.truth).length;
  const tn = rows.filter((r) => !fires(r) && !r.truth).length;
  return {
    pairs: rows.length,
    positives: tp + fn,
    fired: tp + fp,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    precision: tp + fp === 0 ? undefined : tp / (tp + fp),
    recall: tp + fn === 0 ? undefined : tp / (tp + fn),
  };
}

const format = (m) =>
  `pairs=${String(m.pairs).padStart(3)} pos=${String(m.positives).padStart(2)} ` +
  `fired=${String(m.fired).padStart(2)} TP=${String(m.truePositives).padStart(2)} ` +
  `FP=${String(m.falsePositives).padStart(2)} FN=${String(m.falseNegatives).padStart(2)} ` +
  `precision=${m.precision === undefined ? " n/a" : `${(m.precision * 100).toFixed(0)}%`.padStart(4)} ` +
  `recall=${m.recall === undefined ? " n/a" : `${(m.recall * 100).toFixed(0)}%`.padStart(4)}`;

const pooled = { designed: [], observed: [] };

for (const run of runs) {
  const plans = initialPlans(run);
  const observed = observedConflicts(run);
  const ids = [...plans.keys()].sort();
  const rows = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      if (splitOf(ids[i], ids[j]) !== wantedSplit) {
        continue;
      }
      const left = plans.get(ids[i]).plan;
      const right = plans.get(ids[j]).plan;
      const leftText = left.intent ?? left.objective;
      const rightText = right.intent ?? right.objective;
      const result = analyzeIntentPair(
        { text: leftText, embedding: embeddings.get(leftText) },
        { text: rightText, embedding: embeddings.get(rightText) },
        options,
      );
      rows.push({
        run: run.file,
        pair: pairKey(ids[i], ids[j]),
        left: ids[i],
        right: ids[j],
        bands: [TEAM_QUEUE_BANDS[ids[i]], TEAM_QUEUE_BANDS[ids[j]]],
        truth: TEAM_QUEUE_TRUE_CONFLICTS.has(pairKey(ids[i], ids[j])),
        observed: observed?.has(pairKey(ids[i], ids[j])),
        shipped: shippedSignal(leftText, rightText),
        fires: result.fires,
        probability: Number(result.probability.toFixed(3)),
        similarity:
          result.similarity === undefined
            ? undefined
            : Number(result.similarity.toFixed(3)),
        sharedTerms: result.sharedTerms,
        opposition: result.opposition,
        leftText,
        rightText,
      });
    }
  }
  pooled.designed.push(...rows);
  if (observed !== undefined && observed.size > 0) {
    pooled.observed.push(...rows.map((row) => ({ ...row, truth: row.observed })));
  }

  if (asJson) {
    continue;
  }
  console.log(`\n${"=".repeat(78)}`);
  console.log(`${run.arm} / ${run.label}  —  ${wantedSplit} split`);
  console.log("=".repeat(78));
  console.log(`  shipped intent_conflict  ${format(matrix(rows, (r) => r.shipped))}`);
  console.log(`  corroborated + embedding ${format(matrix(rows, (r) => r.fires))}`);
}

if (asJson) {
  console.log(JSON.stringify({ split: wantedSplit, options, rows: pooled.designed }, undefined, 2));
} else {
  for (const [name, rows] of Object.entries(pooled)) {
    if (rows.length === 0) {
      continue;
    }
    console.log(`\n${"-".repeat(78)}`);
    console.log(`pooled over ${runs.length} runs — ground truth: ${name} — ${wantedSplit} split`);
    console.log("-".repeat(78));
    console.log(`  shipped intent_conflict  ${format(matrix(rows, (r) => r.shipped))}`);
    console.log(`  corroborated + embedding ${format(matrix(rows, (r) => r.fires))}`);
  }
  console.log(`\noptions: ${JSON.stringify(options)}`);
  console.log("\nfirings (corroborated + embedding):");
  for (const row of pooled.designed.filter((r) => r.fires)) {
    console.log(
      `  ${row.truth ? "TP" : "FP"} ${row.left} + ${row.right} ` +
        `[${row.bands.join("/")}] p=${row.probability} cos=${row.similarity} ` +
        `terms=${row.sharedTerms.join(",")}` +
        (row.opposition ? ` opposed=${row.opposition.join("/")}` : ""),
    );
  }
  console.log("\nmissed real conflicts:");
  for (const row of pooled.designed.filter((r) => !r.fires && r.truth)) {
    console.log(
      `  FN ${row.left} + ${row.right} [${row.bands.join("/")}] ` +
        `p=${row.probability} cos=${row.similarity} terms=${row.sharedTerms.join(",")}`,
    );
  }
}
