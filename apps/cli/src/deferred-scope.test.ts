import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalRepository } from "@coord/repository-service";
import { InMemoryCoordinationStore } from "@coord/persistence";
import { DEFERRED_SCOPE_MARKER } from "@coord/coordinator";
import type { ChangeSetSplit, DeferredScopeRequest } from "@coord/coordinator";
import type { PlanAdmission } from "@coord/shared-types";

import { LeasePlanAuthority } from "./lease-admission.js";

/**
 * The remainder of a partial admission is a task somebody has to be able to
 * run. The coordinator hands over a `TaskDefinition`, which carries neither
 * who is paying nor what the channel picked to run it with, so the authority
 * has to read those back off the submitted row — and a follow-up missing
 * `submittedBy` cannot resolve credentials at all: queued, and then stuck.
 */
test("the deferred remainder inherits who is paying and what it runs with", async () => {
  const store = new InMemoryCoordinationStore();
  await store.saveRepository({ id: "repo_a", path: "/tmp/repo_a", branch: "main" });
  const owner = await store.createUser({
    email: "nathan@example.com",
    displayName: "Nathan",
    passwordDigest: "x",
  });
  const original = await store.submitTask({
    repositoryId: "repo_a",
    objective: "build the terminal output half",
    agentId: "agent_a",
    validationCommands: [],
    submittedBy: owner.id,
    model: "claude-opus-5",
    effort: "high",
  });

  const admission: PlanAdmission = {
    status: "approved_with_constraints",
    taskId: original.id,
    planRevision: 1,
    baseRevision: "a".repeat(40),
    ownershipGrants: [],
    constraints: [],
    blockedBy: [],
    conflicts: [],
    deferredResources: [
      {
        resourceType: "file",
        resourceId: "src/tool/shared.py",
        heldBy: ["task_ingest"],
        reason: "also declared by executing task task_ingest",
      },
    ],
    explanation: "src/tool/shared.py is leased to task_ingest",
    decidedAt: new Date().toISOString(),
  };
  const split: ChangeSetSplit = {
    granted: {
      id: "cs_1",
      taskId: original.id,
      baseRevision: "a".repeat(40),
      baseVersion: 1,
      patches: [],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "",
      commandsRun: [],
      tests: [],
      dependenciesChanged: [],
      symbolsChanged: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    deferred: [
      { path: "src/tool/shared.py", status: "modified", patch: "diff" },
    ],
    escaped: [],
    withheldSymbols: {},
    divided: [],
  };

  const authority = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map(),
  });
  const request: DeferredScopeRequest = {
    task: {
      id: original.id,
      objective: original.objective,
      agentId: original.agentId,
      validationCommands: [],
    },
    repository: { id: "repo_a" } as CanonicalRepository,
    admission,
    split,
  };
  await authority.deferRemainder(request);

  const tasks = await store.listSubmittedTasks({ repositoryId: "repo_a" });
  const followUp = tasks.find((candidate) => candidate.id !== original.id);
  assert.notEqual(followUp, undefined, "a follow-up task should exist");
  assert.ok(followUp?.objective.includes(DEFERRED_SCOPE_MARKER));
  assert.ok(followUp?.objective.includes("src/tool/shared.py"));
  // The three that only live on the submitted row, and are silently lost if
  // the follow-up is built from the definition alone.
  assert.equal(followUp?.submittedBy, owner.id);
  assert.equal(followUp?.model, "claude-opus-5");
  assert.equal(followUp?.effort, "high");
  assert.equal(followUp?.agentId, "agent_a");
});

test("nothing deferred queues nothing", async () => {
  const store = new InMemoryCoordinationStore();
  await store.saveRepository({ id: "repo_b", path: "/tmp/repo_b", branch: "main" });
  const original = await store.submitTask({
    repositoryId: "repo_b",
    objective: "build something",
    agentId: "agent_a",
    validationCommands: [],
  });
  const authority = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map(),
  });

  await authority.deferRemainder({
    task: {
      id: original.id,
      objective: original.objective,
      agentId: original.agentId,
      validationCommands: [],
    },
    repository: { id: "repo_b" } as CanonicalRepository,
    admission: {
      status: "approved",
      taskId: original.id,
      planRevision: 1,
      baseRevision: "a".repeat(40),
      ownershipGrants: [],
      constraints: [],
      blockedBy: [],
      conflicts: [],
      explanation: "approved",
      decidedAt: new Date().toISOString(),
    },
    split: {
      granted: {
        id: "cs_1",
        taskId: original.id,
        baseRevision: "a".repeat(40),
        baseVersion: 1,
        patches: [],
        riskAssessment: { level: "low", reasons: [] },
        agentExplanation: "",
        commandsRun: [],
        tests: [],
        dependenciesChanged: [],
        symbolsChanged: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      deferred: [],
      escaped: [],
      withheldSymbols: {},
      divided: [],
    },
  });

  const tasks = await store.listSubmittedTasks({ repositoryId: "repo_b" });
  assert.equal(tasks.length, 1);
});
