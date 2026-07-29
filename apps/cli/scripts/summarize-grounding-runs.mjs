#!/usr/bin/env node
/**
 * Summarizes grounding-experiment evidence files into one table.
 * Usage: node apps/cli/scripts/summarize-grounding-runs.mjs [dir]
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const dir = process.argv[2] ?? "docs/benchmarks/data/grounding";
const files = (await readdir(dir)).filter((entry) => entry.endsWith(".json"));

const rows = [];
for (const file of files.sort()) {
  const record = JSON.parse(await readFile(path.join(dir, file), "utf8"));
  const hallucinated = record.plans.filter(
    (plan) =>
      (plan.grounding.attached &&
        (plan.grounding.missingFiles.length > 0 ||
          plan.grounding.unresolvedSymbols.length > 0)) ||
      // Before-arm plans carry no grounding; count a plan hallucinated when
      // it declares a file outside the seeded tree (README/package/src/test).
      (!plan.grounding.attached &&
        plan.expectedFiles.some(
          (declared) =>
            !/^(?:src|test)\//u.test(declared) ||
            /checkout|order\.js$/u.test(declared),
        )),
  ).length;
  rows.push({
    label: record.label,
    run: record.run,
    flagged: record.pairFlaggedAtPlanTime,
    sequencedOrBlocked: record.conflicts.some((entry) =>
      ["sequence", "block"].includes(entry.disposition),
    ),
    hallucinatedPlans: hallucinated,
    completed: `${String(record.metrics.tasksCompleted)}/${String(record.taskIds.length)}`,
    attempts: record.metrics.integrationAttempts,
    failures: record.metrics.integrationFailures,
    scopeChanges: record.scopeChanges,
    tokens: record.metrics.tokensTotal,
    elapsedS: Math.round(record.elapsedMs / 1000),
    file,
  });
}
console.table(
  rows.map(({ file, ...rest }) => rest),
);
for (const row of rows) {
  console.log(`${row.label} run ${String(row.run)}: ${row.file}`);
}
