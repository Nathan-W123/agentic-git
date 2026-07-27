import path from "node:path";

import type {
  AgentPlan,
  BenchmarkModeResult,
  BenchmarkReport,
  CanonicalVersion,
  ChangeSet,
  CoordinationRunResult,
  CoordinatorDecision,
  IntegrationResult,
  TaskDefinition,
} from "@coord/shared-types";
import type { AgentAdapter } from "@coord/agent-protocol";
import { Coordinator } from "@coord/coordinator";
import { GenericCliAdapter } from "@coord/adapter-generic-cli";
import { IntegrationService } from "@coord/integration-service";
import type { CoordinationStore } from "@coord/persistence";
import type { TaskWorkspace } from "@coord/workspace-manager";

import {
  createBenchmarkFixture,
  isLiveTask,
  type BenchmarkFixture,
  type BenchmarkFixtureOptions,
  type LiveAgentConfig,
} from "./fixture.js";
import type { BenchmarkScenario, ScenarioTask } from "./scenarios.js";
import {
  ScriptedAgentAdapter,
  type ScriptedAgentBehavior,
} from "./scripted-agent.js";

export interface CoordinatedFixtureResult {
  metrics: BenchmarkModeResult;
  run: CoordinationRunResult;
  fixture: BenchmarkFixture;
}

export interface CoordinatedFixtureOptions {
  /** Durable coordination store. Omitted runs keep in-memory state only. */
  store?: CoordinationStore;
}

interface PreparedUncoordinatedTask {
  task: TaskDefinition;
  plan: AgentPlan;
  workspace: TaskWorkspace;
  changeSet: ChangeSet;
}

function rate(value: number, total: number): number {
  return total === 0 ? 0 : Number((value / total).toFixed(4));
}

/**
 * Selects the driver for one benchmark task.
 *
 * Live tasks run a real process through {@link GenericCliAdapter}; everything
 * else keeps the deterministic scripted behavior used by CI.
 */
function createAdapter(
  fixture: BenchmarkFixture,
  task: TaskDefinition,
  behavior: ScriptedAgentBehavior,
): AgentAdapter {
  const live = fixture.liveAgent;
  if (live !== undefined && isLiveTask(live, task.id)) {
    return new GenericCliAdapter({
      agentId: task.agentId,
      launch: { command: live.command, args: [...live.args] },
      repository: fixture.repository,
      workspaces: fixture.workspaces,
      planningRoot: path.join(fixture.rootPath, "planning"),
      ...(fixture.sandbox === undefined ? {} : { sandbox: fixture.sandbox }),
    });
  }

  return new ScriptedAgentAdapter({
    agentId: task.agentId,
    repository: fixture.repository,
    workspaces: fixture.workspaces,
    behavior,
  });
}

/** Tasks the scenario explicitly documents as currently undetectable. */
function undetectedConflictIds(scenario: BenchmarkScenario): Set<string> {
  return new Set(Object.keys(scenario.knownUndetectedConflicts ?? {}));
}

export async function runCoordinatedFixture(
  fixture: BenchmarkFixture,
  options: CoordinatedFixtureOptions = {},
): Promise<CoordinatedFixtureResult> {
  const startedAt = performance.now();
  const integration = new IntegrationService(
    fixture.repositories,
    fixture.workspaces,
  );
  const coordinator = new Coordinator({
    repositories: fixture.repositories,
    workspaces: fixture.workspaces,
    integrations: integration,
    ...(options.store === undefined ? {} : { store: options.store }),
  });
  const run = await coordinator.run({
    repository: fixture.repository,
    workspaceRoot: fixture.workspaceRoot,
    integrationRoot: fixture.integrationRoot,
    scenario: fixture.scenario.name,
    tasks: fixture.scenario.tasks.map((entry) => ({
      task: entry.task,
      adapter: createAdapter(fixture, entry.task, entry.behavior),
    })),
  });

  const attempted = run.tasks.filter((entry) => entry.integration !== undefined);
  const failures = attempted.filter(
    (entry) => entry.integration?.status !== "integrated",
  );
  const predictedTaskIds = new Set(
    run.conflicts.flatMap((assessment) => assessment.taskIds),
  );
  const tasksPlanned = run.tasks.length;
  const tasksCompleted = run.tasks.filter(
    (entry) => entry.status === "integrated",
  ).length;

  return {
    fixture,
    run,
    metrics: {
      mode: "coordinated",
      scenario: fixture.scenario.name,
      tasksPlanned,
      tasksCompleted,
      completionRate: rate(tasksCompleted, tasksPlanned),
      conflictWarnings: run.conflicts.length,
      integrationAttempts: attempted.length,
      integrationFailures: failures.length,
      // The scheduler sequences colliding work instead of replaying it, so a
      // coordinated run performs no rework by construction. Failures are
      // reported through integrationFailures rather than folded in here.
      reworkCount: 0,
      reworkRate: 0,
      undetectedConflicts: failures.filter(
        (entry) => !predictedTaskIds.has(entry.task.id),
      ).length,
      elapsedMs: Math.round(performance.now() - startedAt),
      finalRevision: run.canonicalVersion.revision,
    },
  };
}

async function prepareUncoordinatedTask(
  fixture: BenchmarkFixture,
  entry: ScenarioTask,
  baseVersion: CanonicalVersion,
): Promise<PreparedUncoordinatedTask> {
  const adapter = createAdapter(fixture, entry.task, entry.behavior);
  const session = await adapter.startTask({
    task: entry.task,
    canonicalVersion: baseVersion,
    repositoryId: fixture.repository.id,
  });
  const plan = await adapter.requestPlan(session.id);
  const workspace = await fixture.workspaces.create({
    taskId: entry.task.id,
    rootPath: fixture.workspaceRoot,
    repository: fixture.repository,
    baseVersion,
  });
  const decision: CoordinatorDecision = {
    decision: "approved",
    taskId: entry.task.id,
    workspaceId: workspace.id,
    ownershipGrants: [],
    constraints: [],
    blockedBy: [],
    explanation: "Uncoordinated baseline starts immediately",
  };
  await adapter.sendContext(session.id, {
    decision,
    canonicalVersion: baseVersion,
    workspacePath: workspace.path,
  });
  const changeSet = await adapter.collectChanges(session.id);
  return { task: entry.task, plan, workspace, changeSet };
}

async function integratePreparedTask(
  fixture: BenchmarkFixture,
  integration: IntegrationService,
  prepared: PreparedUncoordinatedTask,
): Promise<IntegrationResult> {
  return await integration.integrate({
    repository: fixture.repository,
    integrationRoot: fixture.integrationRoot,
    changeSet: prepared.changeSet,
    validationCommands: prepared.task.validationCommands,
    commitMessage: `baseline(${prepared.task.id}): ${prepared.task.objective}`,
  });
}

export async function runUncoordinatedFixture(
  fixture: BenchmarkFixture,
): Promise<BenchmarkModeResult> {
  const startedAt = performance.now();
  const scenarioTasks = fixture.scenario.tasks;
  const behaviors = new Map(
    scenarioTasks.map((entry) => [entry.task.id, entry]),
  );
  const baseVersion = await fixture.repositories.getCanonicalVersion(
    fixture.repository,
  );
  const integration = new IntegrationService(
    fixture.repositories,
    fixture.workspaces,
  );

  // Every task starts from the same revision, which is the whole point of the
  // baseline: nothing tells a task that another task moved canonical first.
  const prepared = await Promise.all(
    scenarioTasks.map(
      async (entry) =>
        await prepareUncoordinatedTask(fixture, entry, baseVersion),
    ),
  );

  const undetected = undetectedConflictIds(fixture.scenario);
  let integrationAttempts = 0;
  let integrationFailures = 0;
  let reworkCount = 0;
  let tasksCompleted = 0;
  let undetectedConflicts = 0;

  try {
    for (const entry of prepared) {
      integrationAttempts += 1;
      const result = await integratePreparedTask(fixture, integration, entry);
      if (result.status === "integrated") {
        tasksCompleted += 1;
        continue;
      }

      integrationFailures += 1;
      reworkCount += 1;

      const scenarioTask = behaviors.get(entry.task.id);
      if (scenarioTask === undefined) {
        throw new Error(`Missing scenario behavior for ${entry.task.id}`);
      }

      const refreshedVersion = await fixture.repositories.getCanonicalVersion(
        fixture.repository,
      );
      const replay = await prepareUncoordinatedTask(
        fixture,
        scenarioTask,
        refreshedVersion,
      );
      try {
        integrationAttempts += 1;
        const replayResult = await integratePreparedTask(
          fixture,
          integration,
          replay,
        );
        if (replayResult.status === "integrated") {
          tasksCompleted += 1;
        } else {
          integrationFailures += 1;
          if (undetected.has(entry.task.id)) {
            undetectedConflicts += 1;
          }
        }
      } finally {
        await fixture.workspaces.destroy(replay.workspace);
      }
    }
  } finally {
    await Promise.all(
      prepared.map(async (entry) => {
        await fixture.workspaces.destroy(entry.workspace);
      }),
    );
  }

  const finalVersion = await fixture.repositories.getCanonicalVersion(
    fixture.repository,
  );
  return {
    mode: "uncoordinated",
    scenario: fixture.scenario.name,
    tasksPlanned: prepared.length,
    tasksCompleted,
    completionRate: rate(tasksCompleted, prepared.length),
    conflictWarnings: 0,
    integrationAttempts,
    integrationFailures,
    reworkCount,
    reworkRate: rate(reworkCount, prepared.length),
    undetectedConflicts,
    elapsedMs: Math.round(performance.now() - startedAt),
    finalRevision: finalVersion.revision,
  };
}

export interface RunBenchmarkOptions {
  liveAgent?: LiveAgentConfig;
  scenario?: BenchmarkScenario;
}

export async function runBenchmark(
  rootPath: string,
  options: RunBenchmarkOptions = {},
): Promise<BenchmarkReport> {
  const fixtureOptions: BenchmarkFixtureOptions = {
    ...(options.liveAgent === undefined ? {} : { liveAgent: options.liveAgent }),
    ...(options.scenario === undefined ? {} : { scenario: options.scenario }),
  };

  const coordinatedFixture = await createBenchmarkFixture(
    rootPath,
    "coordinated",
    fixtureOptions,
  );
  const coordinated = await runCoordinatedFixture(coordinatedFixture);
  const uncoordinatedFixture = await createBenchmarkFixture(
    rootPath,
    "uncoordinated",
    fixtureOptions,
  );
  const uncoordinated = await runUncoordinatedFixture(uncoordinatedFixture);

  return {
    generatedAt: new Date().toISOString(),
    scenario: coordinatedFixture.scenario.name,
    scenarioDescription: coordinatedFixture.scenario.description,
    coordinated: coordinated.metrics,
    uncoordinated,
    reworkAvoided:
      uncoordinated.reworkCount - coordinated.metrics.reworkCount,
    reworkRateAvoided: Number(
      (uncoordinated.reworkRate - coordinated.metrics.reworkRate).toFixed(4),
    ),
  };
}
