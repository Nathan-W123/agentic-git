#!/usr/bin/env node
/**
 * Reduces team-queue runs to the comparison the experiment exists to make.
 *
 * Four things decide whether coordinating a queue is worth what it costs, and
 * they are reported in the order they should be read:
 *
 * 1. **Correctness.** Whether any task's work was destroyed. If the
 *    uncoordinated arm silently loses changes, no amount of speed on the other
 *    side of the ledger makes the two arms comparable — they did different
 *    amounts of work, and only one of them shipped what was asked for.
 * 2. **Wall clock.** Measured machine time, and — for the uncoordinated arm
 *    only — measured time plus the simulated cost of repairing what the merge
 *    could not. Both are shown, because the second contains an assumption and
 *    the first does not.
 * 3. **Tokens.** What the models were paid, split by phase where the adapter
 *    reports it. This is where coordination overhead shows up: replans are
 *    planning rounds bought twice.
 * 4. **Churn.** Replans, requeues and deferrals — the mechanism by which the
 *    coordinated arm converts tokens into the correctness in row one.
 *
 * Usage:
 *
 *   node apps/worker/scripts/team-queue-report.mjs \
 *     docs/benchmarks/data/team-queue/*.json
 */

import { readFile } from "node:fs/promises";

const files = process.argv.slice(2).filter((entry) => entry.endsWith(".json"));
if (files.length === 0) {
  throw new Error("pass one or more team-queue run JSON files");
}

const runs = [];
for (const file of files) {
  runs.push(JSON.parse(await readFile(file, "utf8")));
}
runs.sort((a, b) => a.arm.localeCompare(b.arm));

const seconds = (ms) => `${Math.round(ms / 1000).toLocaleString()} s`;
const thousands = (value) =>
  value === undefined ? "n/a" : value.toLocaleString();

const row = (label, values) =>
  `| ${label.padEnd(38)} | ${values
    .map((value) => String(value).padStart(20))
    .join(" | ")} |`;

const header = runs.map((run) => `${run.arm} (${run.label})`);
console.log(row("", header));
console.log(
  `| ${"-".repeat(38)} | ${runs.map(() => "-".repeat(20)).join(" | ")} |`,
);

const lost = (run) =>
  run.outcome.survival.filter(
    (entry) => entry.whollyOverwritten || entry.partiallyOverwritten,
  );

console.log(
  row(
    "tasks integrated",
    runs.map((r) => `${r.metrics.tasksIntegrated} of ${r.metrics.tasksTotal}`),
  ),
);
console.log(row("tasks failed", runs.map((r) => r.metrics.tasksFailed)));
console.log(
  row(
    "**tasks losing work**",
    runs.map((r) => lost(r).length),
  ),
);
console.log(
  row(
    "  of those, wholly overwritten",
    runs.map((r) => r.outcome.survival.filter((e) => e.whollyOverwritten).length),
  ),
);
console.log(
  row(
    "final tree tests",
    runs.map((r) => (r.outcome.validation.passed ? "pass" : "FAIL")),
  ),
);
console.log(
  row(
    "merge conflicts to repair by hand",
    runs.map((r) => r.outcome.conflictedFiles ?? "n/a (none arise)"),
  ),
);

console.log(row("", runs.map(() => "")));
console.log(row("wall clock (measured)", runs.map((r) => seconds(r.elapsedMs))));
console.log(
  row(
    "wall clock (with repair penalty)",
    runs.map((r) =>
      r.wallClockMs === r.elapsedMs ? "—" : seconds(r.wallClockMs),
    ),
  ),
);
// Prefer whatever the worker path reported; fall back to what the harness
// observed at the adapter's process boundary, which is the only source on a
// branch without the remote-path usage plumbing.
const tokens = (run) => run.metrics.tokensTotal ?? run.metrics.observedTokensTotal;
const tokensByPhase = (run, phase) =>
  run.metrics.tokensByPhase?.[phase] ?? run.metrics.observedTokensByPhase?.[phase];

console.log(row("tokens total", runs.map((r) => thousands(tokens(r)))));
for (const phase of ["planning", "execution"]) {
  console.log(
    row(`  ${phase}`, runs.map((r) => thousands(tokensByPhase(r, phase)))),
  );
}
console.log(
  row(
    "tokens per integrated task",
    runs.map((r) =>
      r.metrics.tasksIntegrated === 0
        ? "n/a"
        : Math.round(tokens(r) / r.metrics.tasksIntegrated).toLocaleString(),
    ),
  ),
);
console.log(
  row(
    "seconds per integrated task",
    runs.map((r) =>
      r.metrics.tasksIntegrated === 0
        ? "n/a"
        : Math.round(r.elapsedMs / 1000 / r.metrics.tasksIntegrated).toLocaleString(),
    ),
  ),
);
console.log(
  row(
    "transport failures (harness)",
    runs.map((r) => r.metrics.transportFailures ?? "n/a"),
  ),
);
console.log(
  row("budget exhausted", runs.map((r) => (r.budgetExhausted ? "YES" : "no"))),
);

console.log(row("", runs.map(() => "")));
console.log(
  row("conflicts detected", runs.map((r) => r.metrics.conflictsDetected)),
);
console.log(
  row("replans (plan-time requeue)", runs.map((r) => r.metrics.planTimeRequeues)),
);
console.log(
  row(
    "replans (result-time requeue)",
    runs.map((r) => r.metrics.resultTimeRequeues),
  ),
);
console.log(
  row("deferrals", runs.map((r) => r.metrics.deferredIterations)),
);
console.log(
  row("lease iterations", runs.map((r) => r.metrics.leaseIterations)),
);
console.log(
  row("validation runs", runs.map((r) => r.metrics.validationRuns)),
);

// Per-band detail: the whole point of the scenario is that the three bands
// should behave differently, and an aggregate hides exactly that.
console.log("\n\nBy band (tasks losing work / tasks in band):\n");
const bands = ["deep", "partial", "independent"];
console.log(row("band", header));
console.log(
  `| ${"-".repeat(38)} | ${runs.map(() => "-".repeat(20)).join(" | ")} |`,
);
for (const band of bands) {
  console.log(
    row(
      band,
      runs.map((run) => {
        const inBand = run.outcome.survival.filter((e) => e.band === band);
        const damaged = inBand.filter(
          (e) => e.whollyOverwritten || e.partiallyOverwritten,
        );
        return `${damaged.length} / ${inBand.length}`;
      }),
    ),
  );
}

for (const run of runs) {
  const damaged = lost(run);
  if (damaged.length === 0) {
    continue;
  }
  console.log(`\n\n${run.arm}: work that did not survive\n`);
  for (const entry of damaged) {
    console.log(
      `  ${String(entry.scenarioTaskId).padEnd(26)} ${String(entry.band).padEnd(12)} ` +
        `${entry.survivingLines}/${entry.addedLines} added lines survived ` +
        `${entry.whollyOverwritten ? "(wholly overwritten)" : "(partially overwritten)"}`,
    );
  }
}
