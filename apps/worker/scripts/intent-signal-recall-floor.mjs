#!/usr/bin/env node
/**
 * The recall floor: can the intent signal recognise one task as itself?
 *
 * The team-queue evaluation asks a hard question — whether two *different*
 * tasks collide — and the answer there is bounded by something intent prose
 * does not contain. This asks the easiest question that still uses real agent
 * writing, so that a failure on the hard one can be attributed.
 *
 * `docs/benchmarks/data/grounding/*replan-substitution*` holds forty runs of
 * the same request, `task_checkout_fee`, each with the intent sentence a real
 * agent wrote for it that time. Every pairing of two of those is the same work
 * described twice. A signal that cannot see that has nothing to say about
 * anything harder; one that can, and still fails on team-queue, is failing for
 * a reason other than not understanding English.
 *
 * There are no negatives here, so this measures recall and nothing else. It is
 * held out in the same sense as the rest: no parameter was chosen with
 * reference to it.
 *
 * Only files git is tracking are read. Sample files land in this directory
 * while other experiments are running, and a measurement whose denominator
 * depends on what happened to be on disk at the time is not reproducible.
 *
 * Usage:
 *
 *   node apps/worker/scripts/intent-signal-recall-floor.mjs \
 *     docs/benchmarks/data/grounding
 */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const { analyzeIntentPair, IntentEmbedder, DEFAULT_INTENT_SIGNAL_OPTIONS } =
  await import(
    `file:///${path
      .join(REPO_ROOT, "packages", "intent-analysis", "dist", "index.js")
      .replaceAll("\\", "/")}`
  );

const directory =
  process.argv[2] ?? path.join(REPO_ROOT, "docs", "benchmarks", "data", "grounding");

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
    intents.push({ sample: `${run.label}#${run.sample}`, taskId: run.taskId, intent });
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

const embedder = new IntentEmbedder({
  cacheDirectory: path.join(REPO_ROOT, ".model-cache"),
});
const vectors = await embedder.embed(intents.map((entry) => entry.intent));
if (vectors === undefined) {
  // Unlike the split evaluation, this script measures nothing without the
  // model: its whole question is what the continuous score does. Say what to
  // install rather than reporting an empty table.
  throw new Error(
    `embeddings unavailable: ${embedder.unavailableReason()}\n` +
      "The embedding model is not a declared dependency — see " +
      "docs/benchmarks/intent-signal.md. Install it with:\n" +
      "  npm install --no-save @xenova/transformers",
  );
}

let fired = 0;
let pairs = 0;
let corroborated = 0;
const similarities = [];
for (let i = 0; i < intents.length; i += 1) {
  for (let j = i + 1; j < intents.length; j += 1) {
    const result = analyzeIntentPair(
      { text: intents[i].intent, embedding: vectors[i] },
      { text: intents[j].intent, embedding: vectors[j] },
      DEFAULT_INTENT_SIGNAL_OPTIONS,
    );
    pairs += 1;
    fired += result.fires ? 1 : 0;
    corroborated += result.sharedTerms.length > 0 ? 1 : 0;
    similarities.push(result.similarity ?? 0);
  }
}
similarities.sort((a, b) => a - b);
const at = (q) => similarities[Math.floor(q * (similarities.length - 1))];

console.log(`task under test        ${[...tasks][0]}`);
console.log(`distinct agent intents ${intents.length}`);
console.log(`same-work pairs        ${pairs}`);
console.log(
  `corroborated           ${corroborated} (${((corroborated / pairs) * 100).toFixed(0)}%)`,
);
console.log(`recall                 ${fired} (${((fired / pairs) * 100).toFixed(0)}%)`);
console.log(
  `cosine  min ${at(0).toFixed(2)}  p25 ${at(0.25).toFixed(2)}  ` +
    `median ${at(0.5).toFixed(2)}  p75 ${at(0.75).toFixed(2)}  max ${at(1).toFixed(2)}`,
);
console.log(`options: ${JSON.stringify(DEFAULT_INTENT_SIGNAL_OPTIONS)}`);
