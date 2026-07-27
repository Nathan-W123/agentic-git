#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  SqliteCoordinationStore,
  type CoordinationStore,
} from "@coord/persistence";

import { runBenchmark, runCoordinatedFixture } from "./benchmark.js";
import {
  createBenchmarkFixture,
  createLiveBenchmarkFixture,
  readLiveAgentConfig,
  type BenchmarkFixture,
  type LiveAgentConfig,
} from "./fixture.js";
import {
  DEFAULT_SCENARIO,
  SCENARIOS,
  findScenario,
  type BenchmarkScenario,
} from "./scenarios.js";

/** Kept beside the repository so a run's history travels with the checkout. */
const DEFAULT_DATABASE_PATH = path.join(".coordinator", "coordination.db");

/** Reads `--flag=value`, returning `fallback` when the flag carries no value. */
function flagValue(
  flags: readonly string[],
  name: string,
  fallback?: string,
): string | undefined {
  const prefix = `--${name}`;
  const match = flags.find(
    (entry) => entry === prefix || entry.startsWith(`${prefix}=`),
  );
  if (match === undefined) {
    return undefined;
  }
  const value = match.slice(prefix.length + 1).trim();
  return value.length === 0 ? fallback : value;
}

function openStore(flags: readonly string[], name: string): CoordinationStore {
  return SqliteCoordinationStore.open(
    flagValue(flags, name, DEFAULT_DATABASE_PATH) ?? DEFAULT_DATABASE_PATH,
  );
}

function printHelp(): void {
  const scenarios = SCENARIOS.map(
    (entry) =>
      `  ${entry.name.padEnd(12)} ${entry.tasks.length} tasks. ${entry.description}`,
  ).join("\n");

  console.log(`AI-Native Development Coordinator

Usage:
  coord demo [--live] [--scenario=<name>] [--persist[=<path>]]
  coord benchmark [--json] [--live] [--scenario=<name>] [--repeat=<n>]
  coord history [--json] [--db=<path>]
  coord history <run-id> [--json] [--db=<path>]
  coord verify-audit [--db=<path>]
  coord help

Commands:
  demo          Run one scenario through coordinated execution.
  benchmark     Compare coordinated and uncoordinated execution.
  history       List recorded runs, or show one run in detail.
  verify-audit  Check the audit chain for tampering.

Options:
  --live         Drive selected tasks with a real agent process instead of the
                 deterministic scripted behavior.
  --persist[=<path>]  Record the run to a durable store. Defaults to
                 ${DEFAULT_DATABASE_PATH}.
  --db=<path>    Store to read from. Defaults to ${DEFAULT_DATABASE_PATH}.
  --scenario=<name>  Task set to run. Defaults to "${DEFAULT_SCENARIO.name}".
  --repeat=<n>   Run the benchmark n times and report each run. Scripted
                 scenarios are deterministic, so this only varies timing;
                 it is meaningful with --live.

Scenarios:
${scenarios}

Live agent environment:
  COORD_AGENT_CMD      Agent executable. Required by --live.
  COORD_AGENT_ARGS     JSON array of arguments, or a whitespace-separated list.
  COORD_AGENT_TASKS    Tasks to run live: "cap" (default), "normalize", a
                       comma-separated list of task ids, or "all".
  COORD_AGENT_SANDBOX  "docker" to confine the agent process, "none" by default.
  COORD_AGENT_IMAGE    Container image. Required by COORD_AGENT_SANDBOX=docker.
  COORD_AGENT_NETWORK  Docker network mode. Defaults to "none".
`);
}

function printBenchmarkTable(
  report: Awaited<ReturnType<typeof runBenchmark>>,
  run?: number,
): void {
  const rows = [report.coordinated, report.uncoordinated];
  console.log(
    `\nScenario: ${report.scenario}${run === undefined ? "" : ` (run ${run})`}` +
      `\n${report.scenarioDescription}\n`,
  );
  console.log(
    [
      "Mode".padEnd(16),
      "Completed".padEnd(12),
      "Warnings".padEnd(10),
      "Attempts".padEnd(10),
      "Failed".padEnd(8),
      "Rework".padEnd(8),
      "Missed".padEnd(8),
      "Elapsed",
    ].join(""),
  );
  for (const row of rows) {
    console.log(
      [
        row.mode.padEnd(16),
        `${row.tasksCompleted}/${row.tasksPlanned}`.padEnd(12),
        String(row.conflictWarnings).padEnd(10),
        String(row.integrationAttempts).padEnd(10),
        String(row.integrationFailures).padEnd(8),
        `${row.reworkCount} (${row.reworkRate})`.padEnd(8),
        String(row.undetectedConflicts).padEnd(8),
        `${row.elapsedMs} ms`,
      ].join(""),
    );
  }
  console.log(
    `\nRework avoided by coordination: ${report.reworkAvoided} ` +
      `(${report.reworkRateAvoided} per task)`,
  );
  if (report.coordinated.undetectedConflicts > 0) {
    console.log(
      `Conflicts coordination did not predict: ` +
        `${report.coordinated.undetectedConflicts}. Phase 0 scores file overlap only.`,
    );
  }
}

/** Reads `--scenario=<name>`, falling back to the default task set. */
function selectScenario(flags: readonly string[]): BenchmarkScenario {
  const flag = flags.find((entry) => entry.startsWith("--scenario="));
  return flag === undefined
    ? DEFAULT_SCENARIO
    : findScenario(flag.slice("--scenario=".length).trim());
}

function selectRepeat(flags: readonly string[]): number {
  const flag = flags.find((entry) => entry.startsWith("--repeat="));
  if (flag === undefined) {
    return 1;
  }
  const value = Number.parseInt(flag.slice("--repeat=".length), 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--repeat must be a positive integer`);
  }
  return value;
}

async function runDemo(
  live: boolean,
  scenario: BenchmarkScenario,
  store: CoordinationStore | undefined,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-demo-"));
  try {
    const fixture: BenchmarkFixture = live
      ? await createLiveBenchmarkFixture(root, "demo", undefined, scenario)
      : await createBenchmarkFixture(root, "demo", { scenario });
    const result = await runCoordinatedFixture(
      fixture,
      store === undefined ? {} : { store },
    );
    const source = await fixture.repositories.readFile(
      fixture.repository,
      result.run.canonicalVersion.revision,
      "src/counter.js",
    );

    console.log(`Phase 0 coordination demo: ${scenario.name}`);
    console.log(`${scenario.description}\n`);
    for (const conflict of result.run.conflicts) {
      console.log(
        `Conflict warning: ${conflict.taskIds.join(" <-> ")} ` +
          `(score ${conflict.score})`,
      );
      console.log(`  ${conflict.explanation}`);
    }
    for (const task of result.run.tasks) {
      console.log(
        `${task.task.id}: ${task.status}; initial decision=${task.decision.decision}` +
          (task.status === "integrated" ? "" : `; ${task.explanation}`),
      );
    }
    console.log(
      `\nCanonical version ${result.run.canonicalVersion.sequence} ` +
        `(${result.run.canonicalVersion.revision.slice(0, 12)})`,
    );
    console.log(`Audit events: ${result.run.audit.length}`);
    if (store !== undefined) {
      const runs = await store.listRuns(1);
      console.log(
        `Recorded run: ${runs[0]?.id ?? "unknown"} ` +
          `(coord history ${runs[0]?.id ?? ""})`,
      );
    }
    console.log(
      fixture.sandbox === undefined
        ? "Workspace isolation: git-worktree (local proof only)"
        : "Workspace isolation: git-worktree on the host, agent process in Docker",
    );
    if (fixture.liveAgent !== undefined) {
      const targets = fixture.liveAgent.taskIds;
      console.log(
        `Live agent: ${fixture.liveAgent.command} for ` +
          `${targets === "all" ? "every task" : targets.join(", ")}`,
      );
    }
    console.log("\nFinal src/counter.js:\n");
    console.log(source.trimEnd());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runHistory(
  runId: string | undefined,
  flags: readonly string[],
): Promise<void> {
  const store = openStore(flags, "db");
  const asJson = flags.includes("--json");
  try {
    if (runId === undefined) {
      const runs = await store.listRuns();
      if (asJson) {
        console.log(JSON.stringify(runs, undefined, 2));
        return;
      }
      if (runs.length === 0) {
        console.log("No recorded runs. Use `coord demo --persist` to record one.");
        return;
      }

      console.log(
        ["Run".padEnd(42), "Scenario".padEnd(12), "Status".padEnd(11), "Started"].join(""),
      );
      for (const run of runs) {
        console.log(
          [
            run.id.padEnd(42),
            (run.scenario ?? "-").padEnd(12),
            run.status.padEnd(11),
            run.startedAt,
          ].join(""),
        );
      }
      return;
    }

    const detail = await store.getRun(runId);
    if (detail === undefined) {
      throw new Error(`Unknown run: ${runId}`);
    }
    if (asJson) {
      console.log(JSON.stringify(detail, undefined, 2));
      return;
    }

    console.log(
      `Run ${detail.run.id} (${detail.run.scenario ?? "no scenario"}) ` +
        `${detail.run.status}`,
    );
    console.log(
      `Base ${detail.run.baseRevision.slice(0, 12)} -> ` +
        `${detail.run.finalRevision?.slice(0, 12) ?? "unchanged"}\n`,
    );

    console.log("Tasks:");
    for (const task of detail.tasks) {
      console.log(
        `  ${task.id.padEnd(24)} ${task.status.padEnd(11)} ` +
          `${task.decision?.decision ?? "-"}` +
          (task.explanation === undefined ? "" : ` — ${task.explanation}`),
      );
    }

    if (detail.conflicts.length > 0) {
      console.log("\nConflicts:");
      for (const conflict of detail.conflicts) {
        console.log(
          `  ${conflict.taskIds.join(" <-> ")} score ${conflict.score} ` +
            `(${conflict.disposition})`,
        );
      }
    }

    console.log("\nIntegrations:");
    for (const integration of detail.integrations) {
      console.log(
        `  ${integration.taskId.padEnd(24)} ${integration.status.padEnd(18)} ` +
          `${integration.explanation}`,
      );
    }

    console.log(`\nChangesets: ${detail.changeSets.length}`);
    for (const changeSet of detail.changeSets) {
      console.log(
        `  ${changeSet.taskId.padEnd(24)} ` +
          `${changeSet.patches.map((patch) => patch.path).join(", ")}`,
      );
    }

    console.log(`\nAudit events: ${detail.audit.length}`);
  } finally {
    await store.close();
  }
}

async function runVerifyAudit(flags: readonly string[]): Promise<void> {
  const store = openStore(flags, "db");
  try {
    const verification = await store.verifyAudit();
    if (verification.valid) {
      console.log(
        `Audit chain intact across ${verification.events} event(s).`,
      );
      return;
    }
    console.error(
      `Audit chain broken at event ${verification.brokenAt} of ` +
        `${verification.events}: ${verification.reason}`,
    );
    process.exitCode = 1;
  } finally {
    await store.close();
  }
}

/** Fails fast so a `--live` run never silently falls back to scripted agents. */
function requireLiveAgentConfig(): LiveAgentConfig {
  const config = readLiveAgentConfig();
  if (config === undefined) {
    throw new Error(
      "--live requires COORD_AGENT_CMD to name the agent executable",
    );
  }
  return config;
}

async function main(): Promise<void> {
  const [command = "help", ...flags] = process.argv.slice(2);
  const live = flags.includes("--live");
  switch (command) {
    case "demo": {
      const persist = flags.some((entry) => entry.startsWith("--persist"));
      const store = persist ? openStore(flags, "persist") : undefined;
      try {
        await runDemo(live, selectScenario(flags), store);
      } finally {
        await store?.close();
      }
      break;
    }
    case "history":
      // A run id, when present, is the only positional argument.
      await runHistory(
        flags.find((entry) => !entry.startsWith("--")),
        flags,
      );
      break;
    case "verify-audit":
      await runVerifyAudit(flags);
      break;
    case "benchmark": {
      const scenario = selectScenario(flags);
      const repeat = selectRepeat(flags);
      const liveAgent = live ? requireLiveAgentConfig() : undefined;
      const reports = [];

      for (let run = 1; run <= repeat; run += 1) {
        const root = await mkdtemp(path.join(os.tmpdir(), "coord-benchmark-"));
        try {
          const report = await runBenchmark(root, {
            scenario,
            ...(liveAgent === undefined ? {} : { liveAgent }),
          });
          reports.push(report);
          if (!flags.includes("--json")) {
            printBenchmarkTable(report, repeat === 1 ? undefined : run);
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }

      if (flags.includes("--json")) {
        console.log(
          JSON.stringify(repeat === 1 ? reports[0] : reports, undefined, 2),
        );
      }
      break;
    }
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : error;
  console.error(message);
  process.exitCode = 1;
});

