import { mkdir } from "node:fs/promises";
import path from "node:path";

import { CodeIntelligenceService } from "@coord/code-intelligence";
import {
  ApprovalPolicy,
  StoreApprovalController,
  assertChangeSetWithinPlan,
} from "@coord/coordinator";
import { IntegrationService } from "@coord/integration-service";
import type {
  CoordinationStore,
  SubmittedTask,
  WorkLease,
} from "@coord/persistence";
import {
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  assertAgentPlan,
  assertChangeSet,
  type AgentPlan,
  type CanonicalVersion,
  type ChangeSet,
  type CoordinatorDecision,
  type IntegrationResult,
  type TaskDefinition,
} from "@coord/shared-types";
import {
  DockerWorkspaceManager,
  GitWorktreeWorkspaceManager,
  type WorkspaceManager,
} from "@coord/workspace-manager";

import type { CoordinatorProject } from "./project.js";

/** A worker holds a task for this long before it must heartbeat again. */
export const WORK_LEASE_TTL_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

export interface WorkAssignment {
  lease: WorkLease;
  task: SubmittedTask;
  repository: { id: string; branch: string };
  canonicalVersion: CanonicalVersion;
  bundleUrl: string;
  bundleRef: string;
  heartbeatIntervalMs: number;
}

export interface WorkResultInput {
  leaseId: string;
  status: "completed" | "failed";
  actorId: string;
  plan: unknown;
  changeSet: unknown;
  detail?: string;
}

export interface WorkResultAcceptance {
  accepted: boolean;
  reason?: string;
  runId?: string;
  integrationStatus?: IntegrationResult["status"];
  requeued?: boolean;
}

interface WorkResultServices {
  repositories?: RepositoryService;
  intelligence?: CodeIntelligenceService;
  integrations?: IntegrationService;
  integrationRoot?: string;
}

/** Derived from the lease so concurrent bundle requests cannot collide. */
export function bundleRefFor(leaseId: string): string {
  return `coord-lease/${leaseId.replaceAll(/[^A-Za-z0-9_-]/gu, "")}`;
}

function canonical(repository: {
  id: string;
  path: string;
  branch: string;
}): CanonicalRepository {
  return {
    id: repository.id,
    path: repository.path,
    branch: repository.branch,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function submittedTask(
  store: CoordinationStore,
  lease: WorkLease,
): Promise<SubmittedTask | undefined> {
  return (
    await store.listSubmittedTasks({
      repositoryId: lease.repositoryId,
      ...(lease.projectId === undefined ? {} : { projectId: lease.projectId }),
    })
  ).find((task) => task.id === lease.taskId);
}

async function failClaimedTask(
  store: CoordinationStore,
  taskId: string,
  runId?: string,
): Promise<void> {
  const current = (await store.listSubmittedTasks()).find(
    (task) => task.id === taskId,
  );
  if (current?.status === "claimed") {
    await store.completeSubmittedTask(taskId, "failed", runId);
  }
}

async function trace(
  store: CoordinationStore,
  runId: string | undefined,
  type: Parameters<CoordinationStore["appendAudit"]>[1]["type"],
  taskId: string,
  data: Readonly<Record<string, unknown>>,
): Promise<void> {
  await store.appendAudit(runId, { type, taskId, data });
}

function adapterName(
  project: CoordinatorProject | undefined,
  task: SubmittedTask,
): string | undefined {
  if (project === undefined) {
    return undefined;
  }
  const [, agent] = project.requireAgent(task.agentId);
  return agent.adapter ?? "generic-cli";
}

/**
 * Atomically leases the next compatible task in one authorized project.
 *
 * The store serializes active leases per repository, so remote workers always
 * plan from the latest accepted canonical state rather than racing blind edits.
 */
export async function leaseWork(
  store: CoordinationStore,
  input: {
    workerId: string;
    projectId: string;
    repositoryId?: string;
  },
  repositories = new RepositoryService(),
  project?: CoordinatorProject,
): Promise<WorkAssignment | undefined> {
  const worker = await store.getWorker(input.workerId);
  if (worker === undefined) {
    throw new Error(`Unknown worker: ${input.workerId}`);
  }
  const pending = await store.listSubmittedTasks({
    projectId: input.projectId,
    status: "submitted",
    ...(input.repositoryId === undefined
      ? {}
      : { repositoryId: input.repositoryId }),
  });
  const next = pending.find((task) => {
    const required = adapterName(project, task);
    return required === undefined || worker.adapters.includes(required);
  });
  if (next === undefined) {
    return undefined;
  }

  const stored = await store.getRepository(next.repositoryId);
  if (stored === undefined) {
    throw new Error(`Unknown repository: ${next.repositoryId}`);
  }
  const repository = canonical(stored);
  const version = await repositories.getCanonicalVersion(repository);
  const leased = await store.leaseNextTask({
    workerId: input.workerId,
    taskId: next.id,
    projectId: input.projectId,
    repositoryId: next.repositoryId,
    baseRevision: version.revision,
    ttlMs: WORK_LEASE_TTL_MS,
  });
  if (leased === undefined) {
    return undefined;
  }
  await trace(store, undefined, "task_started", leased.task.id, {
    projectId: leased.task.projectId,
    repositoryId: leased.task.repositoryId,
    workerId: leased.lease.workerId,
    leaseId: leased.lease.id,
    baseRevision: leased.lease.baseRevision,
    remote: true,
  });
  return {
    lease: leased.lease,
    task: leased.task,
    repository: {
      id: stored.id,
      branch: stored.branch,
    },
    canonicalVersion: version,
    bundleUrl: `/api/v1/workers/leases/${leased.lease.id}/bundle`,
    bundleRef: bundleRefFor(leased.lease.id),
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  };
}

/**
 * Packages the leased snapshot. The bundle includes ancestors reachable from
 * that commit, but no newer canonical revision or unrelated branch ref.
 */
export async function leaseBundle(
  store: CoordinationStore,
  leaseId: string,
  repositories = new RepositoryService(),
): Promise<Buffer | undefined> {
  const now = new Date().toISOString();
  await store.expireWorkLeases(now);
  const lease = await store.getWorkLease(leaseId);
  if (lease === undefined || lease.status !== "active") {
    return undefined;
  }
  const repository = await store.getRepository(lease.repositoryId);
  if (repository === undefined) {
    return undefined;
  }
  return await repositories.createBundle(
    canonical(repository),
    lease.baseRevision,
    bundleRefFor(lease.id),
  );
}

async function rejectWorkerResult(
  store: CoordinationStore,
  lease: WorkLease,
  reason: string,
): Promise<WorkResultAcceptance> {
  const now = new Date().toISOString();
  const settled = await store.finishWorkLease(
    lease.id,
    "failed",
    now,
    reason.slice(0, 2_000),
  );
  if (!settled) {
    await store.expireWorkLeases(now);
    return { accepted: false, reason: "lease was lost before result rejection" };
  }
  await failClaimedTask(store, lease.taskId);
  await trace(store, undefined, "task_failed", lease.taskId, {
    projectId: lease.projectId,
    repositoryId: lease.repositoryId,
    workerId: lease.workerId,
    leaseId: lease.id,
    stage: "remote_result_validation",
    error: reason,
  });
  return { accepted: false, reason };
}

async function requeueForCanonicalChange(
  store: CoordinationStore,
  repositories: RepositoryService,
  lease: WorkLease,
  previousVersion: CanonicalVersion,
  canonicalVersion: CanonicalVersion,
  runId?: string,
): Promise<WorkResultAcceptance> {
  const repository = await store.getRepository(lease.repositoryId);
  const changedFiles =
    repository === undefined
      ? []
      : await repositories.listChangedFiles(
          canonical(repository),
          previousVersion.revision,
          canonicalVersion.revision,
        );
  const now = new Date().toISOString();
  if (runId === undefined) {
    const released = await store.finishWorkLease(
      lease.id,
      "released",
      now,
      "canonical changed; remote task must replan",
    );
    if (!released) {
      await store.expireWorkLeases(now);
      return { accepted: false, reason: "lease was lost before replanning" };
    }
  } else {
    const currentLease = await store.getWorkLease(lease.id);
    if (currentLease?.status === "active") {
      const released = await store.finishWorkLease(
        lease.id,
        "released",
        now,
        "canonical changed; remote task must replan",
      );
      if (!released) {
        await store.expireWorkLeases(now);
      }
    } else {
      const currentTask = (await store.listSubmittedTasks()).find(
        (task) => task.id === lease.taskId,
      );
      if (currentTask?.status === "claimed") {
        await store.retrySubmittedTask(lease.taskId);
      }
    }
    await store.saveTaskStatus(
      runId,
      lease.taskId,
      "cancelled",
      "Canonical changed; task was returned to the remote queue for replanning",
    );
    await store.finishRun(runId, "completed", canonicalVersion);
  }
  const data = {
    projectId: lease.projectId,
    repositoryId: lease.repositoryId,
    previousRevision: previousVersion.revision,
    revision: canonicalVersion.revision,
    changedFiles,
    workerId: lease.workerId,
    leaseId: lease.id,
  };
  await trace(store, runId, "canonical_changed", lease.taskId, data);
  await trace(store, runId, "replan_requested", lease.taskId, data);
  return {
    accepted: false,
    reason: "Canonical changed while the task was remote; it was requeued to replan",
    ...(runId === undefined ? {} : { runId }),
    requeued: true,
  };
}

/**
 * Validates and transactionally integrates a remote worker result.
 *
 * The lease is settled before Git promotion, making duplicate result posts
 * harmless. Exact-base integration and stale requeueing provide the remote
 * equivalent of dynamic replanning when canonical advances.
 */
export async function acceptWorkResult(
  store: CoordinationStore,
  input: WorkResultInput,
  services: WorkResultServices = {},
): Promise<WorkResultAcceptance> {
  const repositories = services.repositories ?? new RepositoryService();
  const intelligence =
    services.intelligence ?? new CodeIntelligenceService(repositories);
  const integrations =
    services.integrations ?? new IntegrationService(repositories);
  const leaseAtStart = await store.getWorkLease(input.leaseId);
  if (leaseAtStart === undefined) {
    throw new Error(`Unknown lease: ${input.leaseId}`);
  }
  if (leaseAtStart.status === "failed") {
    return input.status === "failed"
      ? { accepted: true }
      : { accepted: false, reason: "lease is failed" };
  }
  if (leaseAtStart.status === "completed") {
    const completedTask = await submittedTask(store, leaseAtStart);
    if (completedTask?.status === "integrated") {
      return {
        accepted: true,
        ...(completedTask.runId === undefined
          ? {}
          : { runId: completedTask.runId }),
        integrationStatus: "integrated",
      };
    }
    if (completedTask?.status === "failed") {
      const detail =
        completedTask.runId === undefined
          ? undefined
          : await store.getRun(completedTask.runId);
      const integration = detail?.integrations.at(-1);
      return {
        accepted: false,
        reason: integration?.explanation ?? "Remote integration failed",
        ...(completedTask.runId === undefined
          ? {}
          : { runId: completedTask.runId }),
        ...(integration === undefined
          ? {}
          : { integrationStatus: integration.status }),
      };
    }
    if (completedTask?.status === "submitted") {
      return {
        accepted: false,
        reason: "Canonical changed; the task was requeued to replan",
        requeued: true,
      };
    }
    return {
      accepted: false,
      reason: "Remote result is still being integrated",
    };
  }
  const now = new Date().toISOString();
  if (
    leaseAtStart.status !== "active" ||
    leaseAtStart.expiresAt <= now
  ) {
    await store.expireWorkLeases(now);
    const current = await store.getWorkLease(input.leaseId);
    return {
      accepted: false,
      reason: `lease is ${current?.status ?? leaseAtStart.status}`,
    };
  }
  const task = await submittedTask(store, leaseAtStart);
  if (task === undefined || task.status !== "claimed") {
    return await rejectWorkerResult(
      store,
      leaseAtStart,
      "The leased task is no longer claimed",
    );
  }

  if (input.status === "failed") {
    const settled = await store.finishWorkLease(
      input.leaseId,
      "failed",
      now,
      input.detail ?? "worker reported failure",
    );
    if (!settled) {
      await store.expireWorkLeases(now);
      return { accepted: false, reason: "lease was lost before failure report" };
    }
    await store.completeSubmittedTask(task.id, "failed");
    await trace(store, undefined, "task_failed", task.id, {
      projectId: task.projectId,
      repositoryId: task.repositoryId,
      workerId: leaseAtStart.workerId,
      leaseId: leaseAtStart.id,
      detail: input.detail ?? "worker reported failure",
    });
    return { accepted: true };
  }

  let rawPlan: AgentPlan;
  let changeSet: ChangeSet;
  try {
    const planValue = structuredClone(input.plan);
    const changeSetValue = structuredClone(input.changeSet);
    assertAgentPlan(planValue);
    assertChangeSet(changeSetValue);
    rawPlan = planValue;
    changeSet = changeSetValue;
  } catch (error) {
    return await rejectWorkerResult(
      store,
      leaseAtStart,
      `Invalid remote result: ${errorMessage(error)}`,
    );
  }

  const storedRepository = await store.getRepository(task.repositoryId);
  if (storedRepository === undefined) {
    return await rejectWorkerResult(
      store,
      leaseAtStart,
      `Unknown repository: ${task.repositoryId}`,
    );
  }
  const repository = canonical(storedRepository);
  let baseVersion: CanonicalVersion;
  let plan: AgentPlan;
  try {
    baseVersion = await repositories.getVersionAtRevision(
      repository,
      leaseAtStart.baseRevision,
    );
    if (
      rawPlan.taskId !== task.id ||
      rawPlan.objective.trim() !== task.objective.trim() ||
      changeSet.taskId !== task.id
    ) {
      throw new Error("Plan or changeset is for a different task");
    }
    if (
      changeSet.baseRevision !== leaseAtStart.baseRevision ||
      changeSet.baseVersion !== baseVersion.sequence
    ) {
      throw new Error(
        "Changeset base does not match the canonical version assigned by the lease",
      );
    }
    if (changeSet.riskAssessment.level !== rawPlan.riskLevel) {
      throw new Error("Plan and changeset disagree about risk level");
    }
    const index = await intelligence.index(repository, baseVersion.revision);
    plan = intelligence.enrichPlan(rawPlan, index);
    assertChangeSetWithinPlan(plan, changeSet);
  } catch (error) {
    return await rejectWorkerResult(
      store,
      leaseAtStart,
      `Remote result failed coordination policy: ${errorMessage(error)}`,
    );
  }

  const currentBeforeRun = await repositories.getCanonicalVersion(repository);
  if (currentBeforeRun.revision !== baseVersion.revision) {
    return await requeueForCanonicalChange(
      store,
      repositories,
      leaseAtStart,
      baseVersion,
      currentBeforeRun,
    );
  }

  const taskDefinition: TaskDefinition = {
    id: task.id,
    objective: task.objective,
    agentId: task.agentId,
    validationCommands: task.validationCommands,
    ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
  };
  const run = await store.createRun({
    repository: storedRepository,
    ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
    mode: "coordinated",
    scenario: "remote-worker",
    baseVersion,
  });
  let runFinished = false;
  try {
    await store.saveTask(run.id, taskDefinition);
    await store.saveTaskStatus(run.id, task.id, "planning");
    await store.savePlan(run.id, task.id, plan);
    await store.savePlanRevision(run.id, task.id, {
      revision: 1,
      reason: "initial",
      canonicalRevision: baseVersion.revision,
      plan,
    });
    await store.saveChangeSet(run.id, changeSet);
    await trace(store, run.id, "plan_received", task.id, {
      projectId: task.projectId,
      repositoryId: task.repositoryId,
      workerId: leaseAtStart.workerId,
      leaseId: leaseAtStart.id,
      expectedFiles: plan.expectedFiles,
      riskLevel: plan.riskLevel,
    });
    await trace(store, run.id, "changeset_collected", task.id, {
      projectId: task.projectId,
      repositoryId: task.repositoryId,
      workerId: leaseAtStart.workerId,
      leaseId: leaseAtStart.id,
      changeSetId: changeSet.id,
      files: changeSet.patches.map((patch) => patch.path),
    });

    const approvalPolicy = new ApprovalPolicy();
    const reviewReasons = approvalPolicy.changesetReasons(plan, changeSet);
    const decision: CoordinatorDecision = {
      decision:
        reviewReasons.length === 0 ? "approved" : "approved_with_constraints",
      taskId: task.id,
      planRevision: 1,
      ownershipGrants: [],
      constraints:
        reviewReasons.length === 0
          ? ["Remote changeset must pass exact-base control-plane validation"]
          : ["Remote changeset received required human approval"],
      blockedBy: [],
      explanation:
        "Remote plan, task identity, base revision, and file scope were verified",
    };
    if (reviewReasons.length > 0) {
      await store.saveTaskStatus(
        run.id,
        task.id,
        "awaiting_approval",
        reviewReasons.join("; "),
      );
      const project =
        task.projectId === undefined
          ? undefined
          : await store.getProject(task.projectId);
      const review = await new StoreApprovalController(
        store,
        approvalPolicy.timeoutMs,
      ).review({
        ...(project === undefined
          ? {}
          : { organizationId: project.organizationId }),
        ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
        repositoryId: task.repositoryId,
        runId: run.id,
        taskId: task.id,
        kind: "changeset",
        requestedBy: task.agentId,
        reasons: reviewReasons,
        changeSetId: changeSet.id,
        onRequested: async (request) => {
          await trace(store, run.id, "approval_requested", task.id, {
            projectId: task.projectId,
            approvalId: request.id,
            reasons: request.reasons,
            expiresAt: request.expiresAt,
          });
        },
      });
      await trace(store, run.id, "approval_decided", task.id, {
        projectId: task.projectId,
        approvalId: review.request.id,
        status: review.request.status,
        decidedBy: review.request.decidedBy,
        explanation: review.explanation,
      });
      if (!review.approved) {
        throw new Error(
          `Human approval ${review.request.id} was not granted: ${review.explanation}`,
        );
      }
    }
    await store.saveDecision(run.id, decision);
    await store.saveTaskStatus(run.id, task.id, "approved");

    const currentBeforeIntegration =
      await repositories.getCanonicalVersion(repository);
    if (currentBeforeIntegration.revision !== baseVersion.revision) {
      return await requeueForCanonicalChange(
        store,
        repositories,
        leaseAtStart,
        baseVersion,
        currentBeforeIntegration,
        run.id,
      );
    }
    const settled = await store.finishWorkLease(
      input.leaseId,
      "completed",
      new Date().toISOString(),
      input.detail ?? "remote changeset accepted for integration",
    );
    if (!settled) {
      await store.expireWorkLeases(new Date().toISOString());
      throw new Error("Lease was lost before integration");
    }

    await mkdir(
      services.integrationRoot ??
        path.resolve(".coordinator", "integration"),
      { recursive: true },
    );
    await store.saveTaskStatus(run.id, task.id, "validating");
    const integration = await integrations.integrate({
      repository,
      integrationRoot:
        services.integrationRoot ??
        path.resolve(".coordinator", "integration"),
      changeSet,
      validationCommands: task.validationCommands,
      commitMessage: `coord(${task.id}): ${task.objective}`,
      requireExactBase: true,
    });
    await store.saveIntegration(run.id, integration);
    await trace(store, run.id, "validation_completed", task.id, {
      projectId: task.projectId,
      status: integration.status,
      commands: integration.validation.map((entry) => ({
        label: entry.command.label,
        exitCode: entry.exitCode,
      })),
    });

    if (integration.status === "stale") {
      return await requeueForCanonicalChange(
        store,
        repositories,
        leaseAtStart,
        baseVersion,
        integration.canonicalVersion,
        run.id,
      );
    }
    if (integration.status === "integrated") {
      await store.saveTaskStatus(
        run.id,
        task.id,
        "integrated",
        integration.explanation,
      );
      await store.completeSubmittedTask(task.id, "integrated", run.id);
      await trace(store, run.id, "canonical_promoted", task.id, {
        projectId: task.projectId,
        previousRevision: integration.previousVersion.revision,
        revision: integration.canonicalVersion.revision,
        changeSetId: integration.changeSetId,
      });
    } else {
      await store.saveTaskStatus(
        run.id,
        task.id,
        "failed",
        integration.explanation,
      );
      await store.completeSubmittedTask(task.id, "failed", run.id);
      await trace(store, run.id, "task_failed", task.id, {
        projectId: task.projectId,
        status: integration.status,
        explanation: integration.explanation,
      });
    }
    await store.finishRun(run.id, "completed", integration.canonicalVersion);
    runFinished = true;
    return {
      accepted: integration.status === "integrated",
      ...(integration.status === "integrated"
        ? {}
        : { reason: integration.explanation }),
      runId: run.id,
      integrationStatus: integration.status,
    };
  } catch (error) {
    const explanation = errorMessage(error);
    const failedAt = new Date().toISOString();
    const lease = await store.getWorkLease(input.leaseId);
    let canFailTask = lease?.status === "completed";
    if (lease?.status === "active") {
      canFailTask = await store.finishWorkLease(
        lease.id,
        "failed",
        failedAt,
        explanation.slice(0, 2_000),
      );
      if (!canFailTask) {
        await store.expireWorkLeases(failedAt);
      }
    }
    if (canFailTask) {
      await failClaimedTask(store, task.id, run.id);
    }
    await store
      .saveTaskStatus(run.id, task.id, "failed", explanation)
      .catch(() => undefined);
    await trace(store, run.id, "task_failed", task.id, {
      projectId: task.projectId,
      repositoryId: task.repositoryId,
      workerId: leaseAtStart.workerId,
      leaseId: leaseAtStart.id,
      stage: "remote_integration",
      error: explanation,
    }).catch(() => undefined);
    if (!runFinished) {
      await store.finishRun(run.id, "failed").catch(() => undefined);
    }
    return { accepted: false, reason: explanation, runId: run.id };
  }
}

/** Convenience binding for a project-hosted control plane. */
export function workerOperations(
  project: CoordinatorProject,
  store: CoordinationStore,
) {
  const repositories = new RepositoryService();
  const worktrees = new GitWorktreeWorkspaceManager(
    repositories.getGitClient(),
  );
  const sandboxOptions = project.sandboxOptions();
  const workspaces: WorkspaceManager =
    sandboxOptions === undefined
      ? worktrees
      : new DockerWorkspaceManager(sandboxOptions, worktrees);
  const services: WorkResultServices = {
    repositories,
    intelligence: new CodeIntelligenceService(repositories),
    integrations: new IntegrationService(repositories, workspaces),
    integrationRoot: project.integrationRoot,
  };
  const processing = new Map<string, Promise<WorkResultAcceptance>>();
  return {
    leaseWork: async (input: {
      workerId: string;
      projectId: string;
      repositoryId?: string;
    }) => await leaseWork(store, input, repositories, project),
    leaseBundle: async (leaseId: string) =>
      await leaseBundle(store, leaseId, repositories),
    acceptWorkResult: async (input: WorkResultInput) => {
      const existing = processing.get(input.leaseId);
      if (existing !== undefined) {
        return await existing;
      }
      const operation = acceptWorkResult(store, input, services);
      processing.set(input.leaseId, operation);
      try {
        return await operation;
      } finally {
        if (processing.get(input.leaseId) === operation) {
          processing.delete(input.leaseId);
        }
      }
    },
  };
}
