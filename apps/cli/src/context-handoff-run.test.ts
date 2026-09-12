import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Coordinator, findTaskHandoffs } from "@coord/coordinator";
import { SqliteCoordinationStore } from "@coord/persistence";
import { RepositoryService } from "@coord/repository-service";
import { assertAgentPlan, type AgentPlan } from "@coord/shared-types";
import { GitWorktreeWorkspaceManager } from "@coord/workspace-manager";

import { ScriptedAgentAdapter } from "./scripted-agent.js";

/**
 * A run that stops itself because its context window filled, driven by the
 * scripted agent the scenarios and benchmarks use.
 *
 * The vendor adapters that really observe a window need a real CLI and a real
 * run to fill one, so this is the only way to hold the in-process driver to
 * the whole sequence deterministically: the event is answered rather than
 * mistaken for a scope change, the figures are recorded, a `long_running`
 * handoff is projected from them, and the task is returned to the queue
 * instead of being failed or promoted.
 */

const PRESSURE = {
  occupiedTokens: 48_153,
  peakTokens: 69_478,
  maximumContextTokens: 60_000,
  turns: 12,
  compactions: 1,
  droppedTokens: 46_655,
  stale: true,
};

async function fixture(root: string) {
  const sourcePath = path.join(root, "source");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await writeFile(path.join(sourcePath, "src", "value.js"), "seed\n", "utf8");
  await repositories.commitAll(sourcePath, "seed");
  const repository = await repositories.importLocalRepository(
    sourcePath,
    path.join(root, "canonical.git"),
    "fixture",
  );
  return {
    repositories,
    repository,
    workspaces: new GitWorktreeWorkspaceManager(repositories.getGitClient()),
  };
}

function plan(taskId: string): AgentPlan {
  const value = {
    taskId,
    objective: "raise the value",
    expectedFiles: ["src/value.js"],
    expectedSymbols: [],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };
  assertAgentPlan(value);
  return value;
}

test("an agent that stops for context pressure is requeued with its figures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-handoff-"));
  try {
    const context = await fixture(root);
    const store = SqliteCoordinationStore.open(":memory:");
    const ordinary = new ScriptedAgentAdapter({
      agentId: "scripted",
      repository: context.repository,
      workspaces: context.workspaces,
      behavior: { plan: plan("task_handoff"), execute: async () => {} },
    });
    // Absent reads as none, which is what every scripted run is: it says
    // nothing about a window because it has none.
    assert.equal(
      (await ordinary.getCapabilities()).contextObservation,
      "none",
    );

    const agent = new ScriptedAgentAdapter({
      agentId: "scripted",
      repository: context.repository,
      workspaces: context.workspaces,
      behavior: {
        plan: plan("task_handoff"),
        execute: async () => {
          throw new Error("a stopped round never gets this far");
        },
      },
      contextHandoffAfterContext: {
        reason: "the agent compacted its own context at 69478 tokens",
        pressure: PRESSURE,
      },
    });
    assert.equal((await agent.getCapabilities()).contextObservation, "live");

    const result = await new Coordinator({
      repositories: context.repositories,
      workspaces: context.workspaces,
      store,
    }).run({
      repository: context.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        {
          task: {
            id: "task_handoff",
            objective: "raise the value",
            agentId: "scripted",
            validationCommands: [],
          },
          adapter: agent,
        },
      ],
    });

    // `queued` is the status the runner turns into a released lease or a
    // retried row — the same primitive an empty admission already uses.
    assert.equal(result.tasks[0]?.status, "queued", result.tasks[0]?.explanation);
    assert.equal(result.tasks[0]?.decision.decision, "queued");
    assert.equal(
      result.audit.some((event) => event.type === "canonical_promoted"),
      false,
      "a stopped round has nothing to promote",
    );

    const handedOff = result.audit.find(
      (event) => event.type === "task_handed_off",
    );
    assert.ok(handedOff, result.audit.map((event) => event.type).join(", "));
    assert.deepEqual(handedOff.data["pressure"], PRESSURE);

    const handoff = (
      await findTaskHandoffs(store, { taskId: "task_handoff" })
    )[0];
    assert.equal(handoff?.reason, "long_running");
    // Projected from the figures, never from what the agent said in words.
    assert.equal(
      JSON.stringify(handoff).includes("compacted its own context"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
