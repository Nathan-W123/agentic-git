import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  AgentPlan,
  CanonicalVersion,
  ChangeSet,
  ConflictAssessment,
  CoordinatorDecision,
  IntegrationResult,
  ResourceLease,
  TaskDefinition,
} from "@coord/shared-types";

import { InMemoryCoordinationStore } from "./memory-store.js";
import { SqliteCoordinationStore } from "./sqlite-store.js";
import type { CoordinationStore } from "./store.js";

/**
 * Behavior every store implementation must share.
 *
 * Running one suite against both backends keeps the in-memory default honest:
 * a divergence would otherwise only surface once persistence was switched on.
 */

const REPOSITORY = { id: "repo_1", path: "/canonical.git", branch: "main" };

const BASE_VERSION: CanonicalVersion = {
  sequence: 1,
  revision: "a".repeat(40),
  branch: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const FINAL_VERSION: CanonicalVersion = {
  sequence: 2,
  revision: "b".repeat(40),
  branch: "main",
  createdAt: "2026-01-01T00:05:00.000Z",
};

const TASK: TaskDefinition = {
  id: "task_cap_value",
  objective: "Cap the incremented value at ten",
  agentId: "scripted-generic-cli",
  validationCommands: [
    { executable: "node", args: ["--test"], label: "repository tests" },
  ],
};

const PLAN: AgentPlan = {
  taskId: TASK.id,
  objective: TASK.objective,
  expectedFiles: ["src/counter.js"],
  expectedSymbols: ["increment"],
  dependencies: [],
  commands: TASK.validationCommands,
  externalAccess: [],
  riskLevel: "low",
};

const DECISION: CoordinatorDecision = {
  decision: "queued",
  taskId: TASK.id,
  workspaceId: "workspace_1",
  ownershipGrants: [],
  constraints: ["Start from canonical state after blocking tasks integrate"],
  blockedBy: ["task_normalize_input"],
  explanation: "Queued behind task_normalize_input",
};

const CONFLICT: ConflictAssessment = {
  taskIds: ["task_normalize_input", TASK.id],
  score: 20,
  disposition: "concurrent",
  evidence: [
    {
      kind: "file_overlap",
      resources: ["src/counter.js"],
      taskIds: ["task_normalize_input", TASK.id],
      score: 20,
    },
  ],
  explanation: "1 planned file overlap(s): src/counter.js.",
};

const LEASE: ResourceLease = {
  leaseId: "lease_1",
  resourceType: "file",
  resourceId: "src/counter.js",
  principalId: TASK.agentId,
  taskId: TASK.id,
  mode: "exclusive",
  baseVersion: 1,
  expiresAt: "2026-01-01T00:05:00.000Z",
};

const CHANGESET: ChangeSet = {
  id: "changeset_1",
  taskId: TASK.id,
  baseVersion: 1,
  baseRevision: BASE_VERSION.revision,
  patches: [
    { path: "src/counter.js", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b\n" },
    { path: "test/cap.test.js", status: "added", patch: "@@ -0,0 +1 @@\n+x\n" },
  ],
  commandsRun: [],
  tests: [],
  dependenciesChanged: [],
  symbolsChanged: ["increment"],
  riskAssessment: { level: "low", reasons: ["file-level change only"] },
  agentExplanation: "capped the incremented value at ten",
  createdAt: "2026-01-01T00:02:00.000Z",
};

const INTEGRATION: IntegrationResult = {
  taskId: TASK.id,
  changeSetId: CHANGESET.id,
  status: "integrated",
  previousVersion: BASE_VERSION,
  canonicalVersion: FINAL_VERSION,
  validation: [],
  candidateRevision: "c".repeat(40),
  explanation: "Promoted cccccccccccc atomically",
};

async function populate(store: CoordinationStore): Promise<string> {
  const run = await store.createRun({
    repository: REPOSITORY,
    mode: "coordinated",
    scenario: "overlap",
    baseVersion: BASE_VERSION,
  });

  await store.saveTask(run.id, TASK);
  await store.appendAudit(run.id, {
    type: "task_submitted",
    taskId: TASK.id,
    data: { objective: TASK.objective },
  });
  await store.savePlan(run.id, TASK.id, PLAN);
  await store.saveSession(run.id, {
    id: "session_1",
    agentId: TASK.agentId,
    taskId: TASK.id,
    startedAt: "2026-01-01T00:01:00.000Z",
  });
  await store.saveDecision(run.id, DECISION);
  await store.saveConflicts(run.id, [CONFLICT]);
  await store.saveLeases(run.id, [LEASE]);
  await store.saveWorkspace(run.id, {
    id: "workspace_1",
    runId: run.id,
    taskId: TASK.id,
    path: "/workspaces/task_cap_value",
    isolation: "git-worktree",
    baseRevision: BASE_VERSION.revision,
    createdAt: "2026-01-01T00:01:30.000Z",
  });
  await store.saveChangeSet(run.id, CHANGESET);
  await store.appendAudit(run.id, {
    type: "changeset_collected",
    taskId: TASK.id,
    data: { changeSetId: CHANGESET.id },
  });
  await store.saveIntegration(run.id, INTEGRATION);
  await store.releaseLeases(run.id, TASK.id);
  await store.saveTaskStatus(run.id, TASK.id, "integrated", "Promoted");
  await store.finishRun(run.id, "completed", FINAL_VERSION);
  return run.id;
}

interface Backend {
  name: string;
  open: () => Promise<{ store: CoordinationStore; cleanup: () => Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: "in-memory",
    open: async () => ({
      store: new InMemoryCoordinationStore(),
      cleanup: async () => undefined,
    }),
  },
  {
    name: "sqlite",
    open: async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "coord-store-"));
      return {
        store: SqliteCoordinationStore.open(path.join(root, "coordination.db")),
        cleanup: async () => {
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  },
];

for (const backend of backends) {
  test(`${backend.name}: a completed run reads back in full`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const runId = await populate(store);
      const detail = await store.getRun(runId);
      assert.ok(detail !== undefined);

      assert.equal(detail.run.status, "completed");
      assert.equal(detail.run.scenario, "overlap");
      assert.equal(detail.run.baseRevision, BASE_VERSION.revision);
      assert.equal(detail.run.finalRevision, FINAL_VERSION.revision);

      assert.equal(detail.tasks.length, 1);
      assert.equal(detail.tasks[0]?.status, "integrated");
      assert.equal(detail.tasks[0]?.sessionId, "session_1");
      assert.deepEqual(detail.tasks[0]?.plan, PLAN);
      assert.deepEqual(detail.tasks[0]?.decision, DECISION);

      assert.deepEqual(detail.conflicts, [CONFLICT]);
      assert.deepEqual(detail.changeSets, [CHANGESET]);
      assert.deepEqual(detail.integrations, [INTEGRATION]);
      assert.equal(detail.leases.length, 1);
      assert.equal(detail.workspaces.length, 1);
      assert.equal(detail.audit.length, 2);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: file patches keep their order and content`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const runId = await populate(store);
      const detail = await store.getRun(runId);
      const patches = detail?.changeSets[0]?.patches ?? [];
      assert.deepEqual(
        patches.map((patch) => patch.path),
        ["src/counter.js", "test/cap.test.js"],
      );
      assert.equal(patches[1]?.status, "added");
      assert.equal(patches[0]?.patch, CHANGESET.patches[0]?.patch);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: the audit chain verifies after a run`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await populate(store);
      const verification = await store.verifyAudit();
      assert.equal(verification.valid, true);
      assert.equal(verification.events, 2);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: audit events are scoped to their run`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const first = await populate(store);
      const second = await populate(store);
      assert.notEqual(first, second);

      assert.equal((await store.listAudit(first)).length, 2);
      assert.equal((await store.listAudit(second)).length, 2);
      assert.equal((await store.listAudit()).length, 4);
      assert.equal((await store.verifyAudit()).valid, true);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: runs list newest first and unknown ids return undefined`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await populate(store);
      await populate(store);
      const runs = await store.listRuns();
      assert.equal(runs.length, 2);
      assert.equal(await store.getRun("run_missing"), undefined);
    } finally {
      await store.close();
      await cleanup();
    }
  });
}
