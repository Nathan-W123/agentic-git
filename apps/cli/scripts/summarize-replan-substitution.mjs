#!/usr/bin/env node
/**
 * Tabulates the paired replan-substitution samples.
 *
 * Pairing is the point: both arms replan from the *same* first plan, so each
 * sample is its own control and the interesting counts are the discordant
 * pairs — samples where exactly one arm re-hallucinated. Those are what
 * McNemar's exact test reads, and they are the only samples that carry any
 * information about a difference between the arms.
 *
 * Usage: node apps/cli/scripts/summarize-replan-substitution.mjs [dir]
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const directory = process.argv[2] ?? "docs/benchmarks/data/grounding";
const entries = (await readdir(directory))
  .filter((name) => name.includes("replan-substitution") && name.endsWith(".json"))
  .sort();

const samples = [];
for (const name of entries) {
  samples.push(JSON.parse(await readFile(path.join(directory, name), "utf8")));
}

const complete = samples.filter(
  (sample) =>
    sample.arms?.control?.error === undefined &&
    sample.arms?.treatment?.error === undefined,
);

/**
 * Samples where the intervention had anything to do.
 *
 * Substitution only acts on a declaration grounding could map to a real name.
 * A first plan with nothing to correct produces an identical prompt in both
 * arms, so including those pairs dilutes the comparison with samples that
 * could not possibly differ.
 */
const corrigible = complete.filter(
  (sample) =>
    (sample.firstPlan.grounding.fileReferents ?? []).length > 0 ||
    (sample.firstPlan.grounding.symbolReferents ?? []).length > 0,
);

const only = process.argv.includes("--all") ? complete : corrigible;
const usable = only;

function rate(arm, predicate) {
  const hits = usable.filter((sample) => predicate(sample.arms[arm])).length;
  return `${String(hits)}/${String(usable.length)}` +
    (usable.length === 0
      ? ""
      : ` (${String(Math.round((hits / usable.length) * 100))}%)`);
}

/** Two-sided McNemar exact test on the discordant pairs. */
function mcnemar(onlyControl, onlyTreatment) {
  const n = onlyControl + onlyTreatment;
  if (n === 0) {
    return 1;
  }
  const choose = (total, k) => {
    let value = 1;
    for (let i = 0; i < k; i += 1) {
      value = (value * (total - i)) / (i + 1);
    }
    return value;
  };
  const smaller = Math.min(onlyControl, onlyTreatment);
  let tail = 0;
  for (let k = 0; k <= smaller; k += 1) {
    tail += choose(n, k);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

const hallucinated = (entry) => entry.anyHallucination === true;
const repeated = (entry) => entry.repeated.length > 0;

for (const [name, predicate] of [
  ["declared any name that does not exist", hallucinated],
  ["repeated a name it was already corrected on", repeated],
  ["adopted every real name the coordinator resolved", (e) => e.adoptedAll],
]) {
  const onlyControl = usable.filter(
    (sample) => predicate(sample.arms.control) && !predicate(sample.arms.treatment),
  ).length;
  const onlyTreatment = usable.filter(
    (sample) => !predicate(sample.arms.control) && predicate(sample.arms.treatment),
  ).length;
  console.log(`\n${name}`);
  console.log(`  control   ${rate("control", predicate)}`);
  console.log(`  treatment ${rate("treatment", predicate)}`);
  console.log(
    `  discordant pairs: control-only ${String(onlyControl)}, ` +
      `treatment-only ${String(onlyTreatment)}; ` +
      `McNemar exact p=${mcnemar(onlyControl, onlyTreatment).toFixed(4)}`,
  );
}

const withHallucinatedFirstPlan = samples.filter(
  (sample) =>
    sample.firstPlan.grounding.missingFiles.length > 0 ||
    sample.firstPlan.grounding.unresolvedSymbols.length > 0,
).length;
console.log(
  `\nsamples ${String(samples.length)}; both arms completed ` +
    `${String(complete.length)}; first plan had a name to correct ` +
    `${String(corrigible.length)} (the set scored above; --all to widen)`,
);
console.log(
  `first plans naming something that does not exist: ` +
    `${String(withHallucinatedFirstPlan)}/${String(samples.length)}`,
);
