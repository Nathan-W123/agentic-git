#!/usr/bin/env node
/**
 * Which recorded corpora can measure an intent signal's precision?
 *
 * The grounded intent signal cannot be improved further without data nobody
 * has looked at, and "construct a fresh held-out set" turned out to be the
 * binding constraint rather than a formality. This enumerates every recorded
 * corpus in the repository against the three things such a set needs:
 *
 * 1. **Real agent intent prose.** Sentences a person or a model wrote to
 *    describe work, not sentences written by whoever is evaluating the signal.
 *    Prose authored alongside the rule it is testing measures the author.
 * 2. **More than two distinct tasks.** Precision is a property of pairs, and
 *    two tasks make one pair.
 * 3. **Both labels.** A corpus where every pair conflicts measures recall and
 *    nothing else. This is the one most corpora here fail: the checkout
 *    scenarios were *built* to be uniformly contended, which was the right
 *    design for what they were built to measure and makes them useless here.
 *
 * Only files git tracks are read, so the answer does not depend on what
 * happened to be on disk.
 *
 * Usage (from the repository root):
 *
 *   node apps/worker/scripts/intent-corpus-audit.mjs
 */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  TEAM_QUEUE_BANDS,
  TEAM_QUEUE_TRUE_CONFLICTS,
} from "./team-queue-scenario.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const DATA = path.join(REPO_ROOT, "docs", "benchmarks", "data");

const tracked = execFileSync("git", ["ls-files", "--", DATA], {
  cwd: REPO_ROOT,
  encoding: "utf8",
})
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.endsWith(".json"));

/**
 * Scenarios whose every task necessarily contends with every other, by their
 * own declared design. Taken from the scenario definitions rather than
 * inferred, because "no negatives observed" and "no negatives possible" are
 * different claims and only the second disqualifies a corpus.
 */
const UNIFORMLY_CONTENDED = new Map([
  [
    "live-checkout",
    "both requests must change how an order total is computed",
  ],
  [
    "live-checkout-trio",
    "all three requests must change how an order total is computed or shown",
  ],
  ["live-pricing", "three requests that all pass through orderTotal"],
]);

const corpora = new Map();

for (const relative of tracked) {
  const contents = JSON.parse(
    await readFile(path.join(REPO_ROOT, relative), "utf8"),
  );
  const runs = Array.isArray(contents.runs) ? contents.runs : [contents];
  for (const run of runs) {
    const scenario = run.scenario ?? contents.scenario ?? "(unlabelled)";
    const entry = corpora.get(scenario) ?? {
      files: new Set(),
      tasks: new Set(),
      intents: 0,
    };
    entry.files.add(path.basename(relative));
    for (const plan of run.plans ?? []) {
      const id = plan.scenarioTaskId ?? plan.taskId;
      if (id !== undefined) {
        entry.tasks.add(id);
      }
      if (typeof plan.plan?.intent === "string") {
        entry.intents += 1;
      }
    }
    if (typeof run.taskId === "string") {
      entry.tasks.add(run.taskId);
      if (typeof run.firstPlan?.intent === "string") {
        entry.intents += 1;
      }
    }
    corpora.set(scenario, entry);
  }
}

const verdicts = [];
for (const [scenario, entry] of [...corpora].sort()) {
  const tasks = entry.tasks.size;
  const pairs = (tasks * (tasks - 1)) / 2;
  let positives;
  let negatives;
  let labelSource;
  if (scenario === "team-queue") {
    labelSource = "TEAM_QUEUE_TRUE_CONFLICTS, pre-registered";
    const ids = [...entry.tasks].filter((id) => TEAM_QUEUE_BANDS[id] !== undefined);
    let conflict = 0;
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        if (TEAM_QUEUE_TRUE_CONFLICTS.has([ids[i], ids[j]].sort().join("|"))) {
          conflict += 1;
        }
      }
    }
    positives = conflict;
    negatives = pairs - conflict;
  } else if (UNIFORMLY_CONTENDED.has(scenario)) {
    labelSource = `scenario design: ${UNIFORMLY_CONTENDED.get(scenario)}`;
    positives = pairs;
    negatives = 0;
  } else {
    labelSource = "none recorded";
    positives = undefined;
    negatives = undefined;
  }

  const blockers = [];
  if (entry.intents === 0) {
    blockers.push("no agent intent prose");
  }
  if (tasks < 3) {
    blockers.push(`only ${tasks} distinct task(s)`);
  }
  if (negatives === 0) {
    blockers.push("no negative pairs — recall only");
  }
  if (negatives === undefined) {
    blockers.push("no conflict labels");
  }
  verdicts.push({ scenario, entry, tasks, pairs, positives, negatives, labelSource, blockers });
}

console.log("recorded corpora, against what a precision measurement needs\n");
for (const verdict of verdicts) {
  console.log(`${verdict.scenario}`);
  console.log(`  files                ${verdict.entry.files.size}`);
  console.log(`  distinct tasks       ${verdict.tasks}`);
  console.log(`  agent intents        ${verdict.entry.intents}`);
  console.log(`  pairs per full run   ${verdict.pairs}`);
  console.log(
    `  labels               ${verdict.labelSource}` +
      (verdict.positives === undefined
        ? ""
        : ` (${verdict.positives} positive, ${verdict.negatives} negative)`),
  );
  console.log(
    `  usable for precision ${verdict.blockers.length === 0 ? "yes" : `no — ${verdict.blockers.join("; ")}`}`,
  );
  console.log();
}

const usable = verdicts.filter((verdict) => verdict.blockers.length === 0);
console.log("-".repeat(78));
if (usable.length === 0) {
  console.log("No corpus can measure precision.");
} else {
  console.log(
    `Usable: ${usable.map((verdict) => verdict.scenario).join(", ")}. ` +
      "Note separately whether each has already been read.",
  );
}
console.log(
  "\nA fresh held-out set has to supply all three at once: prose written by\n" +
    "agents rather than by the evaluator, at least three tasks so pairs exist,\n" +
    "and a scenario whose bands are not uniformly contended. Nothing recorded\n" +
    "here supplies the third except team-queue, which has been read.",
);
