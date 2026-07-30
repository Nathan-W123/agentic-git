#!/usr/bin/env node
/**
 * Paired before/after measurement of the replan-prompt name substitution.
 *
 * The question is narrow: given the same facts about which declared names do
 * not exist, does *substituting* the real names into the previous plan reduce
 * re-hallucination compared with *noting* the correction alongside the
 * original plan? Both arms carry the same information — the control's
 * verification notes name the real files and symbols too — so what differs is
 * where that information sits and how it is phrased.
 *
 * Design: one real planning call produces one plan, and the same plan is then
 * replanned twice, once per arm, from a fresh session each time. Pairing on
 * the plan removes the variance that dominated the earlier warm-vs-cold
 * experiment, where each arm planned independently and the arms were compared
 * across different first plans.
 *
 * Arm order alternates by sample, so neither arm systematically sees the
 * warmer or colder end of a session.
 *
 * Usage:
 *   node apps/cli/scripts/replan-substitution-experiment.mjs \
 *     --samples=10 --out=docs/benchmarks/data/grounding
 *
 * Requires COORD_AGENT_CMD to name the Codex executable, as `coord benchmark
 * --live` does.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexAdapter } from "@coord/adapter-codex";
import { CodeIntelligenceService, groundPlan } from "@coord/code-intelligence";
import { RepositoryService } from "@coord/repository-service";
import { GitWorktreeWorkspaceManager } from "@coord/workspace-manager";

import { createBenchmarkFixture, readLiveAgentConfig } from "../dist/fixture.js";
import { findScenario } from "../dist/scenarios.js";

function flag(name, fallback) {
  const raw = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return raw === undefined ? fallback : raw.slice(name.length + 3);
}

const samples = Number(flag("samples", "6"));
const scenarioName = flag("scenario", "live-checkout-trio");
const outDir = flag("out", "docs/benchmarks/data/grounding");
const label = flag("label", "replan-substitution");

/** What a grounding verdict says about whether a plan named real code. */
function hallucinations(grounding) {
  if (grounding === undefined) {
    return { missingFiles: [], unresolvedSymbols: [], confidence: "verified" };
  }
  return {
    confidence: grounding.confidence,
    missingFiles: grounding.missingFiles,
    unresolvedSymbols: grounding.unresolvedSymbols,
    fileReferents: grounding.fileReferents,
    symbolReferents: grounding.symbolReferents,
  };
}

/**
 * The measurement.
 *
 * `repeated` is the strict one: a name the previous turn already declared and
 * the coordinator already told the agent about, declared again. `fresh` is a
 * name that did not exist and was not in the previous plan either — a new
 * invention rather than a repeat. Both matter; only the first is what the
 * substitution is trying to stop.
 */
function score(previous, revised) {
  const priorMissing = new Set([
    ...(previous.grounding?.missingFiles ?? []),
    ...(previous.grounding?.unresolvedSymbols ?? []),
  ]);
  const revisedMissing = [
    ...(revised.grounding?.missingFiles ?? []),
    ...(revised.grounding?.unresolvedSymbols ?? []),
  ];
  const repeated = revisedMissing.filter((name) => priorMissing.has(name));
  const fresh = revisedMissing.filter((name) => !priorMissing.has(name));
  // Did the agent actually adopt what the coordinator resolved the name to?
  const resolved = new Set([
    ...(previous.grounding?.fileReferents ?? []).map((entry) => entry.resolved),
    ...(previous.grounding?.symbolReferents ?? []).map(
      (entry) => entry.resolved,
    ),
  ]);
  const declared = new Set([
    ...revised.expectedFiles,
    ...revised.expectedSymbols,
  ]);
  const adopted = [...resolved].filter((name) => declared.has(name));
  return {
    anyHallucination: revisedMissing.length > 0,
    repeated,
    fresh,
    adopted,
    adoptedAll: resolved.size > 0 && adopted.length === resolved.size,
    expectedFiles: revised.expectedFiles,
    expectedSymbols: revised.expectedSymbols,
    grounding: hallucinations(revised.grounding),
  };
}

function adapterFor(fixture, root, liveAgent, suffix) {
  const workspaces = new GitWorktreeWorkspaceManager();
  return new CodexAdapter({
    agentId: `codex-${suffix}`,
    repository: fixture.repository,
    workspaces,
    planningRoot: path.join(root, `planning-${suffix}`),
    command: liveAgent.command,
    args: liveAgent.args,
    ...(liveAgent.executionSandbox === undefined
      ? {}
      : { executionSandbox: liveAgent.executionSandbox }),
    ...(liveAgent.windowsSandbox === undefined
      ? {}
      : { windowsSandbox: liveAgent.windowsSandbox }),
  });
}

async function once(scenario, liveAgent, sampleNumber) {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-replansub-"));
  const startedAt = Date.now();
  try {
    const fixture = await createBenchmarkFixture(root, "replansub", {
      scenario,
      liveAgent,
    });
    const repositories = new RepositoryService();
    const intelligence = new CodeIntelligenceService(repositories);
    const baseVersion = await repositories.getCanonicalVersion(
      fixture.repository,
    );
    const index = await intelligence.index(
      fixture.repository,
      baseVersion.revision,
    );

    // The contended task: its objective is checkout vocabulary that matches no
    // real file or symbol, which is what makes the first plan worth replanning.
    const task = scenario.tasks[0].task;

    const planner = adapterFor(fixture, root, liveAgent, "plan");
    const planning = await planner.startTask({
      task,
      canonicalVersion: baseVersion,
      repositoryId: fixture.repository.id,
    });
    const rawFirst = await planner.requestPlan(planning.id);
    const first = groundPlan(rawFirst, index);
    await planner.cancel(planning.id).catch(() => {});

    // A plausible canonical advance: the sibling task in this scenario lands
    // its change to the order total first, which is the real reason a replan
    // is requested here.
    const notice = {
      previousVersion: baseVersion,
      canonicalVersion: baseVersion,
      changedFiles: ["src/pricing/total.js"],
      changedSymbols: ["orderTotal"],
      changedApis: [],
      changedSchemas: [],
      changedConfigKeys: [],
      changedTests: [],
      changedServices: [],
      reason: "another task integrated a change to the order total",
    };

    const arms =
      sampleNumber % 2 === 1
        ? [
            ["control", "1"],
            ["treatment", undefined],
          ]
        : [
            ["treatment", undefined],
            ["control", "1"],
          ];

    const results = {};
    for (const [arm, ungrounded] of arms) {
      const previous = process.env["COORD_UNGROUNDED_REPLAN"];
      if (ungrounded === undefined) {
        delete process.env["COORD_UNGROUNDED_REPLAN"];
      } else {
        process.env["COORD_UNGROUNDED_REPLAN"] = ungrounded;
      }
      try {
        const adapter = adapterFor(fixture, root, liveAgent, arm);
        const session = await adapter.startTask({
          task,
          canonicalVersion: baseVersion,
          repositoryId: fixture.repository.id,
        });
        const revised = groundPlan(
          await adapter.requestReplan(session.id, {
            taskId: task.id,
            previousPlan: first,
            canonicalChange: notice,
            constraints: [
              "Start from canonical state after the blocking tasks integrate",
            ],
          }),
          index,
        );
        await adapter.cancel(session.id).catch(() => {});
        results[arm] = score(first, revised);
      } catch (error) {
        results[arm] = { error: String(error).slice(0, 400) };
      } finally {
        if (previous === undefined) {
          delete process.env["COORD_UNGROUNDED_REPLAN"];
        } else {
          process.env["COORD_UNGROUNDED_REPLAN"] = previous;
        }
      }
    }

    return {
      label,
      scenario: scenario.name,
      sample: sampleNumber,
      startedAt: new Date(startedAt).toISOString(),
      elapsedMs: Date.now() - startedAt,
      armOrder: arms.map(([arm]) => arm),
      taskId: task.id,
      objective: task.objective,
      indexRevision: index.revision,
      firstPlan: {
        expectedFiles: first.expectedFiles,
        expectedSymbols: first.expectedSymbols,
        intent: first.intent,
        grounding: hallucinations(first.grounding),
      },
      arms: results,
    };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

const scenario = findScenario(scenarioName);
const liveAgent = readLiveAgentConfig();
if (liveAgent === undefined) {
  throw new Error("COORD_AGENT_CMD must name the agent executable");
}
await mkdir(outDir, { recursive: true });

for (let sample = 1; sample <= samples; sample += 1) {
  const record = await once(scenario, liveAgent, sample);
  const file = path.join(
    outDir,
    `${scenario.name}-${label}-sample${String(sample)}-${Date.now()}.json`,
  );
  await writeFile(file, `${JSON.stringify(record, undefined, 2)}\n`, "utf8");
  const summary = (arm) => {
    const entry = record.arms[arm];
    if (entry?.error !== undefined) {
      return `${arm}=ERROR`;
    }
    return (
      `${arm}: hallucinated=${String(entry?.anyHallucination)} ` +
      `repeated=${String(entry?.repeated.length)} ` +
      `adopted=${String(entry?.adopted.length)}`
    );
  };
  console.log(
    `[sample ${String(sample)}/${String(samples)}] ` +
      `first-plan missing=${String(record.firstPlan.grounding.missingFiles.length)}/` +
      `${String(record.firstPlan.grounding.unresolvedSymbols.length)} | ` +
      `${summary("control")} | ${summary("treatment")} | ` +
      `${String(Math.round(record.elapsedMs / 1000))}s -> ${file}`,
  );
}
