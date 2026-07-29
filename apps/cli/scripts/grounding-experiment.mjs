#!/usr/bin/env node
/**
 * Before/after measurement harness for plan grounding.
 *
 * Runs the coordinated arm of a live benchmark scenario N times and records,
 * per run, the evidence that matters for plan-time conflict detection:
 * what each agent declared, what verification made of those declarations,
 * whether the contending pair was flagged before execution, how the schedule
 * sequenced the tasks, and what integration ultimately cost.
 *
 * The two arms run the same build. `COORD_DISABLE_PLAN_GROUNDING=1` restores
 * the pre-grounding behaviour exactly, so the only variable between a
 * "before" and an "after" collection is the fix under test.
 *
 * Usage:
 *   node apps/cli/scripts/grounding-experiment.mjs \
 *     --runs=3 --scenario=live-checkout --label=after --out=docs/benchmarks/data/grounding
 *
 * Requires COORD_AGENT_CMD (and usually COORD_AGENT_ADAPTER=codex,
 * COORD_AGENT_TASKS=all) exactly like `coord benchmark --live`.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCoordinatedFixture } from "../dist/benchmark.js";
import { createBenchmarkFixture, readLiveAgentConfig } from "../dist/fixture.js";
import { findScenario } from "../dist/scenarios.js";

function flag(name, fallback) {
  const raw = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return raw === undefined ? fallback : raw.slice(name.length + 3);
}

const runs = Number(flag("runs", "1"));
const scenarioName = flag("scenario", "live-checkout");
const label = flag("label", "unlabelled");
const outDir = flag("out", "docs/benchmarks/data/grounding");

function structural(assessment) {
  return assessment.evidence.some(
    (entry) => entry.advisory !== true && entry.score > 0,
  );
}

function summarizeGrounding(grounding) {
  if (grounding === undefined) {
    return { attached: false };
  }
  return {
    attached: true,
    confidence: grounding.confidence,
    missingFiles: grounding.missingFiles,
    unresolvedSymbols: grounding.unresolvedSymbols,
    fileReferents: grounding.fileReferents,
    symbolReferents: grounding.symbolReferents,
  };
}

async function once(scenario, liveAgent, runNumber) {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-grounding-"));
  const startedAt = Date.now();
  try {
    const fixture = await createBenchmarkFixture(root, "coordinated", {
      scenario,
      ...(liveAgent === undefined ? {} : { liveAgent }),
    });
    const { run, metrics } = await runCoordinatedFixture(fixture);

    const planEvents = run.audit.filter(
      (event) => event.type === "plan_received",
    );
    const conflictEvents = run.audit.filter(
      (event) => event.type === "conflict_detected",
    );
    const taskIds = run.tasks.map((entry) => entry.task.id);
    const pairFlagged =
      run.conflicts.some(structural) ||
      conflictEvents.some((event) => {
        const evidence = event.data.evidence ?? [];
        return evidence.some(
          (entry) => entry.advisory !== true && entry.score > 0,
        );
      });

    return {
      label,
      scenario: scenario.name,
      run: runNumber,
      groundingDisabled: process.env.COORD_DISABLE_PLAN_GROUNDING === "1",
      startedAt: new Date(startedAt).toISOString(),
      elapsedMs: Date.now() - startedAt,
      taskIds,
      plans: planEvents.map((event) => ({
        taskId: event.taskId,
        revision: event.data.revision,
        expectedFiles: event.data.expectedFiles,
        expectedSymbols: event.data.expectedSymbols,
        grounding: summarizeGrounding(event.data.grounding),
      })),
      conflicts: run.conflicts.map((assessment) => ({
        taskIds: assessment.taskIds,
        score: assessment.score,
        disposition: assessment.disposition,
        structural: structural(assessment),
        explanation: assessment.explanation,
      })),
      pairFlaggedAtPlanTime: pairFlagged,
      replans: run.audit.filter((event) => event.type === "replan_requested")
        .length,
      scopeChanges: run.audit.filter(
        (event) => event.type === "scope_change_requested",
      ).length,
      tasks: run.tasks.map((entry) => ({
        taskId: entry.task.id,
        status: entry.status,
        integration: entry.integration?.status,
        explanation: entry.explanation.slice(0, 400),
      })),
      metrics: {
        tasksCompleted: metrics.tasksCompleted,
        integrationAttempts: metrics.integrationAttempts,
        integrationFailures: metrics.integrationFailures,
        conflictWarnings: metrics.conflictWarnings,
        undetectedConflicts: metrics.undetectedConflicts,
        elapsedMs: metrics.elapsedMs,
        tokensTotal: metrics.tokensTotal,
        tokensByTask: metrics.tokensByTask,
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const scenario = findScenario(scenarioName);
const liveAgent = readLiveAgentConfig();
if (liveAgent === undefined) {
  throw new Error("COORD_AGENT_CMD must name the agent executable");
}
await mkdir(outDir, { recursive: true });

for (let runNumber = 1; runNumber <= runs; runNumber += 1) {
  const record = await once(scenario, liveAgent, runNumber);
  const file = path.join(
    outDir,
    `${scenario.name}-${label}-run${String(runNumber)}-${Date.now()}.json`,
  );
  await writeFile(file, `${JSON.stringify(record, undefined, 2)}\n`, "utf8");
  console.log(
    `[${label} run ${String(runNumber)}/${String(runs)}] ` +
      `flagged=${String(record.pairFlaggedAtPlanTime)} ` +
      `completed=${String(record.metrics.tasksCompleted)}/${String(record.taskIds.length)} ` +
      `attempts=${String(record.metrics.integrationAttempts)} ` +
      `failures=${String(record.metrics.integrationFailures)} ` +
      `tokens=${String(record.metrics.tokensTotal ?? "n/a")} ` +
      `elapsed=${String(Math.round(record.elapsedMs / 1000))}s -> ${file}`,
  );
}
