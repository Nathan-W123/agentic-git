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
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
  type CoordinationStore,
} from "./store.js";

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
      assert.equal(
        detail.tasks[0]?.sessionStartedAt,
        "2026-01-01T00:01:00.000Z",
      );
      assert.deepEqual(
        detail.tasks[0]?.validationCommands,
        TASK.validationCommands,
      );
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

  test(`${backend.name}: repository ids cannot be remapped`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      await store.saveRepository(REPOSITORY);
      await assert.rejects(
        store.saveRepository({ ...REPOSITORY, path: "/other.git" }),
        /already mapped/u,
      );
      assert.deepEqual(await store.getRepository(REPOSITORY.id), REPOSITORY);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: history reads are detached snapshots`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const runId = await populate(store);
      const first = await store.getRun(runId);
      assert.ok(first !== undefined);
      first.run.status = "failed";
      first.tasks[0]?.plan?.expectedFiles.push("src/forged.js");
      if (first.changeSets[0]?.patches[0] !== undefined) {
        first.changeSets[0].patches[0].path = "src/forged.js";
      }
      first.audit[0]!.data = { forged: true };

      const second = await store.getRun(runId);
      assert.equal(second?.run.status, "completed");
      assert.deepEqual(second?.tasks[0]?.plan?.expectedFiles, [
        "src/counter.js",
      ]);
      assert.equal(
        second?.changeSets[0]?.patches[0]?.path,
        "src/counter.js",
      );
      assert.deepEqual(second?.audit[0]?.data, {
        objective: TASK.objective,
      });
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

  test(`${backend.name}: saving a changeset twice is idempotent`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const runId = await populate(store);
      await store.saveChangeSet(runId, CHANGESET);
      const detail = await store.getRun(runId);
      assert.equal(detail?.changeSets.length, 1);
      assert.equal(detail?.changeSets[0]?.patches.length, 2);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: integration cleanup warnings survive history reads`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const runId = await populate(store);
      await store.saveIntegration(runId, {
        ...INTEGRATION,
        cleanupWarnings: ["workspace cleanup failed"],
        explanation:
          `${INTEGRATION.explanation}; workspace cleanup failed`,
      });
      const detail = await store.getRun(runId);
      assert.deepEqual(
        detail?.integrations.at(-1)?.cleanupWarnings,
        ["workspace cleanup failed"],
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: claimed and failed tasks can be explicitly retried`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      const submitted = await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: TASK.objective,
        agentId: TASK.agentId,
        validationCommands: TASK.validationCommands,
      });
      assert.equal(submitted.claimedAt, undefined);
      assert.equal(submitted.completedAt, undefined);

      const firstClaim = await store.claimSubmittedTasks(REPOSITORY.id);
      assert.equal(firstClaim[0]?.status, "claimed");
      assert.ok(firstClaim[0]?.claimedAt !== undefined);

      const retriedClaim = await store.retrySubmittedTask(submitted.id);
      assert.equal(retriedClaim.status, "submitted");
      assert.equal(retriedClaim.claimedAt, undefined);

      await store.claimSubmittedTasks(REPOSITORY.id);
      await store.completeSubmittedTask(submitted.id, "failed");
      const failed = (
        await store.listSubmittedTasks({ status: "failed" })
      )[0];
      assert.ok(failed?.completedAt !== undefined);

      await store.retrySubmittedTask(submitted.id);
      await store.claimSubmittedTasks(REPOSITORY.id);
      await store.completeSubmittedTask(submitted.id, "integrated");
      await assert.rejects(store.retrySubmittedTask(submitted.id), /integrated/u);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: concurrent claims never return the same task twice`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      await store.submitTask({
        repositoryId: REPOSITORY.id,
        objective: TASK.objective,
        agentId: TASK.agentId,
        validationCommands: [],
      });
      const claims = await Promise.all([
        store.claimSubmittedTasks(REPOSITORY.id),
        store.claimSubmittedTasks(REPOSITORY.id),
      ]);
      assert.equal(claims[0]!.length + claims[1]!.length, 1);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: project-scoped claims cannot consume another queue`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      await store.saveRepository(REPOSITORY);
      assert.equal(
        await store.projectHasRepository(DEFAULT_PROJECT_ID, REPOSITORY.id),
        false,
      );
      await store.linkRepository(DEFAULT_PROJECT_ID, REPOSITORY.id);
      const secondProject = await store.createProject({
        organizationId: DEFAULT_ORGANIZATION_ID,
        slug: "second-project",
        name: "Second project",
      });
      await store.linkRepository(secondProject.id, REPOSITORY.id);
      const localTask = await store.submitTask({
        projectId: DEFAULT_PROJECT_ID,
        repositoryId: REPOSITORY.id,
        objective: "Local project task",
        agentId: TASK.agentId,
        validationCommands: [],
      });
      const secondTask = await store.submitTask({
        projectId: secondProject.id,
        repositoryId: REPOSITORY.id,
        objective: "Second project task",
        agentId: TASK.agentId,
        validationCommands: [],
      });

      const claimed = await store.claimSubmittedTasks(
        REPOSITORY.id,
        secondProject.id,
      );
      assert.deepEqual(claimed.map((task) => task.id), [secondTask.id]);
      assert.equal(
        (await store.listSubmittedTasks()).find(
          (task) => task.id === localTask.id,
        )?.status,
        "submitted",
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: api tokens round-trip, revoke, and expire`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const user = await store.createUser({
        email: "worker@example.com",
        displayName: "Worker",
        passwordDigest: "test-digest",
      });

      await store.createApiToken({
        id: "tok_live",
        userId: user.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "worker",
        secretHash: "hash-live",
        scopes: ["view", "run_task"],
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBySession: "auth_1",
        expiresAt: "2026-06-01T00:00:00.000Z",
        lastUsedAt: undefined,
        lastUsedIp: undefined,
        revokedAt: undefined,
        revokedReason: undefined,
      });
      await store.createApiToken({
        id: "tok_stale",
        userId: user.id,
        organizationId: undefined,
        name: "expired",
        secretHash: "hash-stale",
        scopes: ["view"],
        createdAt: "2025-01-01T00:00:00.000Z",
        createdBySession: undefined,
        expiresAt: "2025-02-01T00:00:00.000Z",
        lastUsedAt: undefined,
        lastUsedIp: undefined,
        revokedAt: undefined,
        revokedReason: undefined,
      });

      const live = await store.getApiToken("tok_live");
      assert.equal(live?.name, "worker");
      assert.deepEqual(live?.scopes, ["view", "run_task"]);
      assert.equal(live?.organizationId, DEFAULT_ORGANIZATION_ID);
      assert.equal(live?.createdBySession, "auth_1");
      // The secret digest is all that is kept; there is no plaintext column.
      assert.equal(live?.secretHash, "hash-live");

      // Newest first, and both belong to the same user.
      assert.deepEqual(
        (await store.listApiTokens(user.id)).map((token) => token.id),
        ["tok_live", "tok_stale"],
      );

      await store.touchApiToken("tok_live", "2026-02-02T00:00:00.000Z", "10.0.0.9");
      const touched = await store.getApiToken("tok_live");
      assert.equal(touched?.lastUsedAt, "2026-02-02T00:00:00.000Z");
      assert.equal(touched?.lastUsedIp, "10.0.0.9");

      await store.revokeApiToken("tok_live", "2026-03-03T00:00:00.000Z", "compromised");
      const revoked = await store.getApiToken("tok_live");
      assert.equal(revoked?.revokedAt, "2026-03-03T00:00:00.000Z");
      assert.equal(revoked?.revokedReason, "compromised");

      // Revocation is final: a second call must not rewrite when or why.
      await store.revokeApiToken("tok_live", "2026-04-04T00:00:00.000Z", "again");
      assert.equal(
        (await store.getApiToken("tok_live"))?.revokedAt,
        "2026-03-03T00:00:00.000Z",
      );

      // Only the token whose expiry has passed is swept.
      assert.equal(await store.deleteExpiredApiTokens("2026-01-15T00:00:00.000Z"), 1);
      assert.equal(await store.getApiToken("tok_stale"), undefined);
      assert.notEqual(await store.getApiToken("tok_live"), undefined);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: tenant membership and auth sessions round-trip`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const user = await store.createUser({
        email: "Developer@Example.com",
        displayName: "Developer",
        passwordDigest: "test-digest",
      });
      await store.saveMembership({
        organizationId: DEFAULT_ORGANIZATION_ID,
        userId: user.id,
        role: "developer",
      });
      assert.deepEqual(
        (await store.listOrganizations(user.id)).map(
          (organization) => organization.id,
        ),
        [DEFAULT_ORGANIZATION_ID],
      );
      assert.equal(
        (
          await store.getMembership(DEFAULT_ORGANIZATION_ID, user.id)
        )?.role,
        "developer",
      );

      await store.createAuthSession({
        id: "auth_contract",
        userId: user.id,
        secretHash: "secret-hash",
        csrfHash: "csrf-hash",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T02:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        ipAddress: "127.0.0.1",
        userAgent: "contract-test",
      });
      await store.touchAuthSession(
        "auth_contract",
        "2026-01-01T00:01:00.000Z",
      );
      assert.equal(
        (await store.getAuthSession("auth_contract"))?.lastSeenAt,
        "2026-01-01T00:01:00.000Z",
      );
      await store.revokeUserSessions(user.id);
      assert.equal(await store.getAuthSession("auth_contract"), undefined);
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: plan revisions and scope decisions remain ordered`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const runId = await populate(store);
      await store.savePlanRevision(runId, TASK.id, {
        revision: 1,
        reason: "initial",
        canonicalRevision: BASE_VERSION.revision,
        plan: PLAN,
      });
      const revisedPlan: AgentPlan = {
        ...PLAN,
        expectedFiles: [...PLAN.expectedFiles, "src/extra.js"],
      };
      await store.savePlanRevision(runId, TASK.id, {
        revision: 2,
        reason: "scope_change",
        canonicalRevision: BASE_VERSION.revision,
        plan: revisedPlan,
      });
      const request = {
        id: "scope_contract",
        taskId: TASK.id,
        additionalFiles: ["src/extra.js"],
        additionalSymbols: [],
        additionalApis: [],
        additionalSchemas: [],
        additionalConfigKeys: [],
        additionalTests: [],
        additionalServices: [],
        reason: "Implementation needs a helper",
        occurredAt: "2026-01-01T00:02:00.000Z",
      };
      await store.saveScopeChange(runId, request);
      await store.saveScopeChangeDecision(runId, {
        requestId: request.id,
        taskId: TASK.id,
        decision: "approved",
        revisedPlan,
        constraints: [],
        ownershipGrants: [],
        explanation: "Conflict-free",
        decidedAt: "2026-01-01T00:02:01.000Z",
      });

      const detail = await store.getRun(runId);
      assert.deepEqual(
        detail?.planRevisions.map((revision) => revision.revision),
        [1, 2],
      );
      assert.equal(detail?.scopeChanges[0]?.decision?.decision, "approved");
      assert.deepEqual(
        await store.listPlanRevisions(runId, TASK.id),
        detail?.planRevisions,
      );
    } finally {
      await store.close();
      await cleanup();
    }
  });

  test(`${backend.name}: approval decisions are final and pending gates expire`, async () => {
    const { store, cleanup } = await backend.open();
    try {
      const runId = await populate(store);
      const approval = await store.createApproval({
        organizationId: DEFAULT_ORGANIZATION_ID,
        projectId: DEFAULT_PROJECT_ID,
        repositoryId: REPOSITORY.id,
        runId,
        taskId: TASK.id,
        kind: "changeset",
        requestedBy: TASK.agentId,
        requiredRole: "reviewer",
        reasons: ["Protected changeset"],
        changeSetId: CHANGESET.id,
        expiresAt: "2026-01-01T01:00:00.000Z",
      });
      const decided = await store.decideApproval({
        approvalId: approval.id,
        status: "approved",
        decidedBy: "reviewer_contract",
        comment: "Reviewed",
        decidedAt: "2026-01-01T00:10:00.000Z",
      });
      assert.equal(decided.status, "approved");
      await assert.rejects(
        store.decideApproval({
          approvalId: approval.id,
          status: "rejected",
          decidedBy: "reviewer_contract",
          comment: "Changed mind",
          decidedAt: "2026-01-01T00:11:00.000Z",
        }),
        /approved/u,
      );

      const expiring = await store.createApproval({
        organizationId: DEFAULT_ORGANIZATION_ID,
        projectId: DEFAULT_PROJECT_ID,
        repositoryId: REPOSITORY.id,
        runId,
        taskId: TASK.id,
        kind: "policy_override",
        requestedBy: TASK.agentId,
        requiredRole: "admin",
        reasons: ["Risk policy"],
        expiresAt: "2026-01-01T00:20:00.000Z",
      });
      assert.equal(
        await store.expireApprovals("2026-01-01T00:21:00.000Z"),
        1,
      );
      assert.equal((await store.getApproval(expiring.id))?.status, "expired");
      assert.equal((await store.getRun(runId))?.approvals.length, 2);
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
      await assert.rejects(store.listRuns(0), RangeError);
    } finally {
      await store.close();
      await cleanup();
    }
  });
}
