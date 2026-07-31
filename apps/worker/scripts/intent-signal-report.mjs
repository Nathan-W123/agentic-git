#!/usr/bin/env node
/**
 * How reliable is the intent-level conflict signal, really?
 *
 * `intent_conflict` is the fourth and most sophisticated evidence tier the
 * conflict detector produces — the only one that can say anything at all about
 * two plans whose declared footprints look disjoint — and it is the only one
 * with no effect whatsoever on scheduling. Whether that is the right call has
 * never been measured, because measuring it needs something no run before the
 * team-queue experiment kept: the agent-written `intent` prose that the signal
 * actually reads.
 *
 * The control plane rewrites a submitted plan's `objective` to the assigned
 * one, byte for byte, so that the plan stays bound to its task. The model's
 * own phrasing moves to `intent`, and `analyzeIntent` reads `intent` in
 * preference to `objective`. Scoring the signal against task objectives — the
 * obvious thing to do, and what the scenario files contain — therefore scores
 * a different input than the one it runs on. This script scores the real one.
 *
 * ## The two ground truths
 *
 * A pair "really conflicts" is a claim that needs evidence, so two independent
 * labels are computed and both are reported:
 *
 * - **Designed.** The scenario's own pre-registered claim about which pairs
 *   cannot both land unexamined, written down in `team-queue-scenario.mjs`
 *   before any run happened. Pre-registration is what stops the label being
 *   fitted to the result.
 * - **Observed.** Which pairs actually collided, taken from the uncoordinated
 *   arm — where every task ran from the same untouched base, so two tasks
 *   whose patches touch the same file demonstrably contended. This is the
 *   stronger label and it is available only because the control arm exists.
 *
 * ## The question that decides the answer
 *
 * A pair the detector already flags structurally does not need the intent
 * signal: file or symbol overlap is proof, and the plan is sequenced on it.
 * The intent signal can only add value on pairs where structural evidence is
 * *absent*, so the headline numbers below are restricted to those pairs. A
 * signal that fires accurately but only ever on pairs that were already caught
 * is not load-bearing, however good its confusion matrix looks.
 *
 * Usage:
 *
 *   node apps/worker/scripts/intent-signal-report.mjs \
 *     docs/benchmarks/data/team-queue/*.json
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { TEAM_QUEUE_TRUE_CONFLICTS } from "./team-queue-scenario.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const { ConflictDetector } = await import(
  `file:///${path
    .join(REPO_ROOT, "services", "coordinator", "dist", "conflict-detector.js")
    .replaceAll("\\", "/")}`
);

const files = process.argv.slice(2).filter((entry) => entry.endsWith(".json"));
if (files.length === 0) {
  throw new Error("pass one or more team-queue run JSON files");
}

const detector = new ConflictDetector({
  fileOverlapWeight: 20,
  thresholds: { concurrentMaximum: 20, notifyMaximum: 45, sequenceMaximum: 70 },
});

const pairKey = (a, b) => [a, b].sort().join("|");

/**
 * The two conditions `analyzeIntent` requires, checked separately.
 *
 * The signal fires only on their conjunction: an exact shared token between
 * the two intent strings, *and* a literal antonym pair drawn from a hardcoded
 * list of ten. When the signal turns out not to fire, "it did not fire" is not
 * a finding — which of these two conditions failed, and how often, is. The
 * lists below mirror `conflict-detector.ts`; they are duplicated rather than
 * imported because the module does not export them, and a diagnostic that
 * silently drifts from what it is diagnosing is worse than no diagnostic.
 */
const OPPOSING_ACTIONS = [
  ["add", "remove"],
  ["allow", "deny"],
  ["create", "delete"],
  ["enable", "disable"],
  ["expand", "restrict"],
  ["introduce", "eliminate"],
  ["migrate", "rollback"],
  ["publish", "hide"],
  ["require", "optional"],
  ["start", "stop"],
];
const STOP_WORDS = new Set([
  "a", "an", "and", "for", "from", "in", "of", "on", "or", "the", "to", "with",
]);

function words(value) {
  return new Set(
    (value ?? "")
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]*/gu)
      ?.filter((word) => !STOP_WORDS.has(word)) ?? [],
  );
}

/**
 * A crude stem, for asking whether exact-token matching is what costs the
 * signal its reach.
 *
 * `analyzeIntent` compares tokens byte for byte, so "order" and "orders" —
 * the single most common way two pricing tasks talk about the same thing —
 * do not match. Trimming a trailing plural or gerund is the smallest change
 * that would fix that, and the point of computing it here is to find out
 * whether it would fix anything worth fixing before proposing it.
 */
function stem(word) {
  return word
    .replace(/(ies)$/u, "y")
    .replace(/(sses|shes|ches|xes)$/u, (match) => match.slice(0, -2))
    .replace(/([^s])s$/u, "$1")
    .replace(/(ing|ed)$/u, "");
}

/**
 * The signal variants scored side by side.
 *
 * `related` is not hypothetical: `relatedObjectives` already gates scheduling
 * for plans verification could not ground, so it is the project's own working
 * example of an intent-level signal with teeth, and the right yardstick for
 * whether `intent_conflict` should get any. `widened` is the proposal — the
 * same conjunction with stemmed matching and a longer antonym list.
 */
const WIDER_ACTIONS = [
  ...[
    ["add", "remove"],
    ["allow", "deny"],
    ["create", "delete"],
    ["enable", "disable"],
    ["expand", "restrict"],
    ["introduce", "eliminate"],
    ["migrate", "rollback"],
    ["publish", "hide"],
    ["require", "optional"],
    ["start", "stop"],
  ],
  ["increase", "decrease"],
  ["raise", "lower"],
  ["add", "drop"],
  ["charge", "waive"],
  ["include", "exclude"],
  ["apply", "skip"],
  ["grant", "revoke"],
  ["show", "hide"],
  ["extend", "shorten"],
  ["widen", "narrow"],
];

function variants(leftText, rightText) {
  const left = words(leftText);
  const right = words(rightText);
  const leftStems = new Set([...left].map(stem));
  const rightStems = new Set([...right].map(stem));

  const sharedExact = [...left].filter(
    (word) =>
      right.has(word) &&
      word.length > 2 &&
      !OPPOSING_ACTIONS.some(([a, b]) => word === a || word === b),
  );
  const sharedStemmed = [...leftStems].filter(
    (word) =>
      rightStems.has(word) &&
      word.length > 2 &&
      !WIDER_ACTIONS.some(([a, b]) => word === stem(a) || word === stem(b)),
  );
  const antonymExact = OPPOSING_ACTIONS.some(
    ([a, b]) => (left.has(a) && right.has(b)) || (left.has(b) && right.has(a)),
  );
  const antonymWide = WIDER_ACTIONS.some(
    ([a, b]) =>
      (leftStems.has(stem(a)) && rightStems.has(stem(b))) ||
      (leftStems.has(stem(b)) && rightStems.has(stem(a))),
  );

  return {
    // What `relatedObjectives` already does, and already schedules on for
    // ungrounded plans: any shared content word at all.
    related: [...left].some((word) => word.length > 2 && right.has(word)),
    current: sharedExact.length > 0 && antonymExact,
    widened: sharedStemmed.length > 0 && antonymWide,
  };
}

function conditions(leftText, rightText) {
  const left = words(leftText);
  const right = words(rightText);
  const shared = [...left].filter(
    (word) =>
      right.has(word) &&
      word.length > 2 &&
      !OPPOSING_ACTIONS.some(([a, b]) => word === a || word === b),
  );
  const antonym = OPPOSING_ACTIONS.find(
    ([a, b]) =>
      (left.has(a) && right.has(b)) || (left.has(b) && right.has(a)),
  );
  return {
    sharedTerm: shared.length > 0,
    sharedTerms: shared,
    antonymPair: antonym !== undefined,
    antonym,
  };
}

const runs = [];
for (const file of files) {
  runs.push(JSON.parse(await readFile(file, "utf8")));
}

/**
 * Which pairs actually contended, from the arm where every task ran from the
 * same base. Two tasks whose patches name a file in common collided in fact,
 * whatever anybody's plan declared.
 */
function observedConflicts(run) {
  if (run.arm !== "uncoordinated") {
    return undefined;
  }
  const touched = new Map();
  for (const entry of run.outcome.merges ?? []) {
    const known = run.tasks.find((task) => task.id === entry.taskId);
    if (known?.scenarioTaskId === undefined) {
      continue;
    }
    touched.set(known.scenarioTaskId, new Set(entry.conflictedFiles ?? []));
  }
  // Conflicted files alone under-count: the *first* task to touch a file
  // never conflicts, because there was nothing there to conflict with. So the
  // set of files each task's patch writes is the real basis, recovered from
  // the survival record's file-level view where available and from the merge
  // record otherwise.
  const files = new Map();
  for (const entry of run.outcome.patchFiles ?? []) {
    if (entry.scenarioTaskId !== undefined) {
      files.set(entry.scenarioTaskId, new Set(entry.files));
    }
  }
  const source = files.size > 0 ? files : touched;
  const ids = [...source.keys()];
  const conflicts = new Set();
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const left = source.get(ids[i]);
      const right = source.get(ids[j]);
      if ([...left].some((file) => right.has(file))) {
        conflicts.add(pairKey(ids[i], ids[j]));
      }
    }
  }
  return conflicts;
}

/** One plan per task: the first one, which is what first arbitration saw. */
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

function classify(run, truth, label) {
  const plans = initialPlans(run);
  const ids = [...plans.keys()].sort();
  const rows = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const left = plans.get(ids[i]);
      const right = plans.get(ids[j]);
      const assessment = detector.assess(left.plan, right.plan);
      const evidence = assessment?.evidence ?? [];
      const intent = evidence.find((entry) => entry.kind === "intent_conflict");
      const structural = evidence.some(
        (entry) => entry.advisory !== true && entry.score > 0,
      );
      const text = (plan) => plan.intent ?? plan.objective;
      rows.push({
        pair: pairKey(ids[i], ids[j]),
        left: ids[i],
        right: ids[j],
        conditions: conditions(text(left.plan), text(right.plan)),
        variants: variants(text(left.plan), text(right.plan)),
        intentFired: intent !== undefined,
        intentResources: intent?.resources ?? [],
        intentExplanation: intent?.explanation,
        structural,
        reallyConflicts: truth.has(pairKey(ids[i], ids[j])),
        leftIntent: left.plan.intent,
        rightIntent: right.plan.intent,
      });
    }
  }

  const matrix = (subset, fires = (r) => r.intentFired) => {
    const tp = subset.filter((r) => fires(r) && r.reallyConflicts).length;
    const fp = subset.filter((r) => fires(r) && !r.reallyConflicts).length;
    const fn = subset.filter((r) => !fires(r) && r.reallyConflicts).length;
    const tn = subset.filter((r) => !fires(r) && !r.reallyConflicts).length;
    return {
      pairs: subset.length,
      firings: tp + fp,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      trueNegatives: tn,
      falsePositiveRate: tp + fp === 0 ? undefined : fp / (tp + fp),
      recall: tp + fn === 0 ? undefined : tp / (tp + fn),
    };
  };

  const invisible = rows.filter((r) => !r.structural);
  return {
    label,
    all: matrix(rows),
    // The only pairs where the signal could add anything: structural evidence
    // already sequences the rest.
    structurallyInvisible: matrix(invisible),
    variants: Object.fromEntries(
      ["related", "current", "widened"].map((name) => [
        name,
        {
          all: matrix(rows, (r) => r.variants[name]),
          structurallyInvisible: matrix(invisible, (r) => r.variants[name]),
        },
      ]),
    ),
    rows,
  };
}

for (const run of runs) {
  const observed = observedConflicts(run);
  console.log(`\n${"=".repeat(72)}`);
  console.log(`${run.arm} / ${run.label} (${run.scenario})`);
  console.log("=".repeat(72));
  if ((run.plans ?? []).length === 0) {
    console.log("no plans recorded");
    continue;
  }

  const labels = [["designed", TEAM_QUEUE_TRUE_CONFLICTS]];
  if (observed !== undefined && observed.size > 0) {
    labels.push(["observed", observed]);
  }

  for (const [name, truth] of labels) {
    const result = classify(run, truth, name);
    console.log(`\nground truth: ${name} (${truth.size} conflicting pairs)`);
    for (const [scope, m] of [
      ["all pairs", result.all],
      ["structurally invisible pairs", result.structurallyInvisible],
    ]) {
      console.log(
        `  ${scope.padEnd(30)} pairs=${String(m.pairs).padStart(3)} ` +
          `fired=${String(m.firings).padStart(2)} ` +
          `TP=${String(m.truePositives).padStart(2)} ` +
          `FP=${String(m.falsePositives).padStart(2)} ` +
          `FN=${String(m.falseNegatives).padStart(2)} ` +
          `FPR=${
            m.falsePositiveRate === undefined
              ? "n/a"
              : `${(m.falsePositiveRate * 100).toFixed(0)}%`
          } ` +
          `recall=${
            m.recall === undefined ? "n/a" : `${(m.recall * 100).toFixed(0)}%`
          }`,
      );
    }
    if (name === labels[0][0]) {
      // Why the signal fires as rarely as it does, condition by condition.
      const invisible = result.rows.filter((r) => !r.structural);
      const count = (rows, predicate) => rows.filter(predicate).length;
      console.log("\n  reachability (all pairs / structurally invisible):");
      console.log(
        `    shared exact term        ${String(
          count(result.rows, (r) => r.conditions.sharedTerm),
        ).padStart(3)} / ${String(count(invisible, (r) => r.conditions.sharedTerm)).padStart(3)}`,
      );
      console.log(
        `    antonym pair present     ${String(
          count(result.rows, (r) => r.conditions.antonymPair),
        ).padStart(3)} / ${String(count(invisible, (r) => r.conditions.antonymPair)).padStart(3)}`,
      );
      console.log(
        `    both (signal fires)      ${String(
          count(result.rows, (r) => r.conditions.sharedTerm && r.conditions.antonymPair),
        ).padStart(3)} / ${String(
          count(invisible, (r) => r.conditions.sharedTerm && r.conditions.antonymPair),
        ).padStart(3)}`,
      );

      // Three intent-level signals scored on one corpus: the one that already
      // schedules ungrounded plans, the one under review, and the proposal.
      console.log("\n  signal variants (structurally invisible pairs only):");
      for (const [name, note] of [
        ["related", "shared term only — what already gates ungrounded plans"],
        ["current", "shared term + antonym — intent_conflict as shipped"],
        ["widened", "stemmed term + longer antonym list — proposal"],
      ]) {
        const m = result.variants[name].structurallyInvisible;
        console.log(
          `    ${name.padEnd(9)} fired=${String(m.firings).padStart(3)}/${String(
            m.pairs,
          ).padStart(3)} ` +
            `TP=${String(m.truePositives).padStart(2)} ` +
            `FP=${String(m.falsePositives).padStart(2)} ` +
            `FPR=${
              m.falsePositiveRate === undefined
                ? " n/a"
                : `${(m.falsePositiveRate * 100).toFixed(0)}%`.padStart(4)
            } ` +
            `recall=${
              m.recall === undefined
                ? " n/a"
                : `${(m.recall * 100).toFixed(0)}%`.padStart(4)
            }   ${note}`,
        );
      }

      const fired = result.rows.filter((r) => r.intentFired);
      if (fired.length > 0) {
        console.log("\n  firings:");
        for (const row of fired) {
          console.log(
            `    ${row.reallyConflicts ? "TP" : "FP"} ${row.left} + ${row.right}` +
              `${row.structural ? " (already structural)" : ""}`,
          );
          console.log(`       left  intent: ${JSON.stringify(row.leftIntent)}`);
          console.log(`       right intent: ${JSON.stringify(row.rightIntent)}`);
          console.log(`       ${row.intentExplanation ?? ""}`);
        }
      }
      const missed = result.rows.filter(
        (r) => !r.intentFired && r.reallyConflicts && !r.structural,
      );
      console.log(
        `\n  real conflicts invisible to both structural and intent evidence: ${String(missed.length)}`,
      );
      for (const row of missed) {
        console.log(`    MISS ${row.left} + ${row.right}`);
        console.log(`       left  intent: ${JSON.stringify(row.leftIntent)}`);
        console.log(`       right intent: ${JSON.stringify(row.rightIntent)}`);
      }
    }
  }
}
