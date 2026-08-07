import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { CodeIntelligenceService } from "@coord/code-intelligence";
import {
  PlanAdmissionController,
  StoreApprovalController,
  approvalPolicyForProject,
} from "@coord/coordinator";
import { IntegrationService } from "@coord/integration-service";
import type { CoordinationStore } from "@coord/persistence";
import {
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  assertAgentPlan,
  createId,
  planAdmissionApproved,
  type AgentPlan,
  type CanonicalVersion,
  type CoordinatorDecision,
  type IntegrationResult,
} from "@coord/shared-types";
import { GitWorktreeWorkspaceManager } from "@coord/workspace-manager";

import type { CoordinatorProject } from "./project.js";

/**
 * Rolling canonical back to an earlier revision.
 *
 * The tempting implementation is `git reset --hard`, and it is the one thing
 * this must never do. Canonical has exactly one write path — plan, conflict
 * check, ownership, validation, policy gate, compare-and-swap promotion — and
 * a rollback that stepped around it would be an uncoordinated write against a
 * repository other agents are actively working in, which is the failure mode
 * the whole platform exists to prevent.
 *
 * So a rollback is submitted as an ordinary change. The revert is materialised
 * in a workspace, collected as a real changeset, planned against the resources
 * it touches, and pushed through the same pipeline as any agent's work. It can
 * be sequenced behind active work, it can require human approval, and it can
 * fail validation — all of which are correct outcomes for reverting a
 * repository other people are working in.
 */

export interface RollbackInput {
  repositoryId: string;
  /** Revision to restore the tree to. */
  targetRevision: string;
  actorId: string;
  projectId?: string;
  reason?: string;
}

export type RollbackStatus =
  | IntegrationResult["status"]
  /** Conflicts with work already executing; nothing was changed. */
  | "blocked"
  /** Canonical already matches the target tree. */
  | "noop";

export interface RollbackResult {
  status: RollbackStatus;
  explanation: string;
  runId?: string;
  taskId?: string;
  /** Canonical revision after the attempt. */
  revision?: string;
  /** Files the revert touches. */
  files?: string[];
  blockedBy?: string[];
}

interface RollbackServices {
  repositories?: RepositoryService;
  intelligence?: CodeIntelligenceService;
  integrations?: IntegrationService;
  admissions?: PlanAdmissionController;
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

/**
 * Plans a rollback against the work currently executing in the repository.
 *
 * Reuses the remote workers' admission controller rather than a second copy of
 * the rules: a rollback rewriting a file some agent is mid-edit on is the same
 * collision as two agents on one file, and deserves the same answer.
 */
async function admitRollback(
  store: CoordinationStore,
  admissions: PlanAdmissionController,
  repositoryId: string,
  plan: AgentPlan,
  baseVersion: CanonicalVersion,
): Promise<{ approved: boolean; blockedBy: string[]; explanation: string }> {
  const leases = await store.listWorkLeases({
    status: "active",
    repositoryId,
  });
  const tasks = await store.listSubmittedTasks({ repositoryId });
  const agentFor = new Map(tasks.map((task) => [task.id, task.agentId]));
  const active = leases
    .filter(
      (lease) =>
        lease.plan !== undefined && planAdmissionApproved(lease.plan.admission),
    )
    .map((lease) => ({
      taskId: lease.taskId,
      agentId: agentFor.get(lease.taskId) ?? lease.workerId,
      plan: (lease.plan as { plan: AgentPlan }).plan,
    }));

  const admission = admissions.admit({
    plan,
    agentId: "coordinator-rollback",
    baseRevision: baseVersion.revision,
    baseVersion: baseVersion.sequence,
    active,
  });
  return {
    approved: planAdmissionApproved(admission),
    blockedBy: [...admission.blockedBy],
    explanation: admission.explanation,
  };
}

export async function rollbackCanonical(
  project: CoordinatorProject,
  store: CoordinationStore,
  input: RollbackInput,
  services: RollbackServices = {},
): Promise<RollbackResult> {
  const repositories = services.repositories ?? new RepositoryService();
  const intelligence =
    services.intelligence ?? new CodeIntelligenceService(repositories);
  const workspaces = new GitWorktreeWorkspaceManager(
    repositories.getGitClient(),
  );
  const integrations =
    services.integrations ?? new IntegrationService(repositories, workspaces);
  const admissions = services.admissions ?? new PlanAdmissionController();

  const stored = await store.getRepository(input.repositoryId);
  if (stored === undefined) {
    throw new Error(`Unknown repository: ${input.repositoryId}`);
  }
  const repository = canonical(stored);
  const current = await repositories.getCanonicalVersion(repository);
  // Resolves and validates in one step: an unknown revision throws here rather
  // than producing an empty changeset later.
  const target = await repositories.getVersionAtRevision(
    repository,
    input.targetRevision,
  );

  if (target.revision === current.revision) {
    return {
      status: "noop",
      explanation: "Canonical is already at that revision",
      revision: current.revision,
    };
  }
  const files = await repositories.listChangedFiles(
    repository,
    current.revision,
    target.revision,
  );
  if (files.length === 0) {
    return {
      status: "noop",
      explanation:
        "That revision has the same tree as canonical; there is nothing to revert",
      revision: current.revision,
    };
  }

  const taskId = createId("task");
  const objective =
    `Roll canonical back to ${target.revision.slice(0, 12)}` +
    (input.reason === undefined || input.reason.trim().length === 0
      ? ""
      : `: ${input.reason.trim()}`);
  const index = await intelligence.index(repository, current.revision);
  const plan = intelligence.enrichPlan(
    {
      taskId,
      objective,
      expectedFiles: [...files],
      expectedSymbols: [],
      dependencies: [],
      commands: [],
      externalAccess: [],
      // A rollback discards work that was already accepted, so it is treated
      // as high risk by default and meets whatever review the project's policy
      // attaches to that.
      riskLevel: "high",
      intent: objective,
    },
    index,
  );
  assertAgentPlan(plan);

  const admission = await admitRollback(
    store,
    admissions,
    stored.id,
    plan,
    current,
  );
  if (!admission.approved) {
    await store.appendAudit(undefined, {
      type: "conflict_detected",
      taskId,
      data: {
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        repositoryId: stored.id,
        stage: "rollback_admission",
        blockedBy: admission.blockedBy,
        explanation: admission.explanation,
      },
    });
    return {
      status: "blocked",
      explanation: admission.explanation,
      blockedBy: admission.blockedBy,
      taskId,
      files,
      revision: current.revision,
    };
  }

  const run = await store.createRun({
    repository: stored,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    mode: "coordinated",
    scenario: "canonical-rollback",
    baseVersion: current,
  });
  const workspaceRoot = path.join(project.workspaceRoot, "rollback");
  let workspace: Awaited<ReturnType<typeof workspaces.create>> | undefined;
  let runFinished = false;
  try {
    await store.saveTask(run.id, {
      id: taskId,
      objective,
      agentId: "coordinator-rollback",
      validationCommands: project.config.validationCommands,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    });
    await store.saveTaskStatus(run.id, taskId, "planning");
    await store.savePlan(run.id, taskId, plan);
    await store.savePlanRevision(run.id, taskId, {
      revision: 1,
      reason: "initial",
      canonicalRevision: current.revision,
      plan,
    });
    await store.appendAudit(run.id, {
      type: "plan_received",
      taskId,
      data: {
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        repositoryId: stored.id,
        rollbackTo: target.revision,
        expectedFiles: plan.expectedFiles,
        riskLevel: plan.riskLevel,
        actorId: input.actorId,
      },
    });

    await mkdir(workspaceRoot, { recursive: true });
    workspace = await workspaces.create({
      taskId,
      rootPath: workspaceRoot,
      repository,
      baseVersion: current,
    });
    await store.saveTaskStatus(run.id, taskId, "running");

    // The revert itself: point the index and working tree at the target tree
    // while the workspace stays based on current canonical. Collecting the
    // diff then yields an ordinary changeset that happens to undo things,
    // rather than a privileged operation on canonical.
    await repositories
      .getGitClient()
      .run(["-C", workspace.path, "read-tree", "-u", "--reset", target.revision]);
    const changeSet = await workspaces.collectChangeSet(workspace, {
      symbolsChanged: [],
      riskAssessment: {
        level: "high",
        reasons: [
          `Reverts canonical to ${target.revision.slice(0, 12)}`,
          `Discards changes across ${files.length} file(s)`,
        ],
      },
      agentExplanation: objective,
    });
    if (changeSet.patches.length === 0) {
      throw new Error(
        "The rollback produced no patch; canonical and the target tree agree",
      );
    }
    await store.saveChangeSet(run.id, changeSet);
    await store.appendAudit(run.id, {
      type: "changeset_collected",
      taskId,
      data: {
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        changeSetId: changeSet.id,
        files: changeSet.patches.map((patch) => patch.path),
      },
    });

    const projectRecord =
      input.projectId === undefined
        ? undefined
        : await store.getProject(input.projectId);
    const policy = approvalPolicyForProject(projectRecord?.policy);
    const reasons = [
      // A rollback keeps its confirmation even where the pipeline runs
      // unattended: it discards work that was already reviewed, validated and
      // accepted, and nothing downstream re-checks it. See
      // ApprovalPolicyOptions.requireRollbackReview.
      ...policy.rollbackReasons(),
      ...policy.planReasons(plan),
      ...policy.changesetReasons(plan, changeSet, {
        planWasReviewed: true,
      }),
    ];
    const decision: CoordinatorDecision = {
      decision: reasons.length === 0 ? "approved" : "approved_with_constraints",
      taskId,
      planRevision: 1,
      ownershipGrants: [],
      constraints: [
        "Rollback must pass the same validation as any other change",
        ...(reasons.length === 0 ? [] : ["Rollback received human approval"]),
      ],
      blockedBy: [],
      explanation: `Reverting canonical to ${target.revision}`,
    };
    if (reasons.length > 0) {
      await store.saveTaskStatus(
        run.id,
        taskId,
        "awaiting_approval",
        reasons.join("; "),
      );
      const review = await new StoreApprovalController(
        store,
        policy.timeoutMs,
      ).review({
        ...(projectRecord === undefined
          ? {}
          : { organizationId: projectRecord.organizationId }),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        repositoryId: stored.id,
        runId: run.id,
        taskId,
        kind: "changeset",
        requestedBy: input.actorId,
        reasons,
        changeSetId: changeSet.id,
        onRequested: async (request) => {
          await store.appendAudit(run.id, {
            type: "approval_requested",
            taskId,
            data: {
              ...(input.projectId === undefined
                ? {}
                : { projectId: input.projectId }),
              approvalId: request.id,
              reasons: request.reasons,
              expiresAt: request.expiresAt,
            },
          });
        },
      });
      await store.appendAudit(run.id, {
        type: "approval_decided",
        taskId,
        data: {
          ...(input.projectId === undefined
            ? {}
            : { projectId: input.projectId }),
          approvalId: review.request.id,
          status: review.request.status,
          decidedBy: review.request.decidedBy,
        },
      });
      if (!review.approved) {
        throw new Error(
          `Rollback approval ${review.request.id} was not granted: ${review.explanation}`,
        );
      }
    }
    await store.saveDecision(run.id, decision);
    await store.saveTaskStatus(run.id, taskId, "validating");

    const integration = await integrations.integrate({
      repository,
      integrationRoot: project.integrationRoot,
      changeSet,
      validationCommands: project.config.validationCommands,
      commitMessage: `coord(rollback): ${objective}`,
      // Same compare-and-swap discipline as any other change: if canonical
      // moved while the rollback was being reviewed, it is stale, not forced.
      requireExactBase: true,
    });
    await store.saveIntegration(run.id, integration);
    await store.appendAudit(run.id, {
      type: "validation_completed",
      taskId,
      data: {
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        status: integration.status,
        commands: integration.validation.map((entry) => ({
          label: entry.command.label,
          exitCode: entry.exitCode,
        })),
      },
    });

    if (integration.status === "integrated") {
      await store.saveTaskStatus(
        run.id,
        taskId,
        "integrated",
        integration.explanation,
      );
      await store.appendAudit(run.id, {
        type: "canonical_promoted",
        taskId,
        data: {
          ...(input.projectId === undefined
            ? {}
            : { projectId: input.projectId }),
          previousRevision: integration.previousVersion.revision,
          revision: integration.canonicalVersion.revision,
          rolledBackTo: target.revision,
          changeSetId: integration.changeSetId,
          actorId: input.actorId,
        },
      });
    } else {
      await store.saveTaskStatus(
        run.id,
        taskId,
        "failed",
        integration.explanation,
      );
      await store.appendAudit(run.id, {
        type: "task_failed",
        taskId,
        data: {
          ...(input.projectId === undefined
            ? {}
            : { projectId: input.projectId }),
          stage: "rollback_integration",
          status: integration.status,
          explanation: integration.explanation,
        },
      });
    }
    await store.finishRun(
      run.id,
      integration.status === "integrated" ? "completed" : "failed",
      integration.canonicalVersion,
    );
    runFinished = true;
    return {
      status: integration.status,
      explanation: integration.explanation,
      runId: run.id,
      taskId,
      revision: integration.canonicalVersion.revision,
      files,
    };
  } catch (error) {
    const explanation = errorMessage(error);
    await store
      .saveTaskStatus(run.id, taskId, "failed", explanation)
      .catch(() => undefined);
    await store
      .appendAudit(run.id, {
        type: "task_failed",
        taskId,
        data: {
          ...(input.projectId === undefined
            ? {}
            : { projectId: input.projectId }),
          stage: "rollback",
          error: explanation,
        },
      })
      .catch(() => undefined);
    if (!runFinished) {
      await store.finishRun(run.id, "failed").catch(() => undefined);
    }
    return {
      status: "policy_failed",
      explanation,
      runId: run.id,
      taskId,
      files,
    };
  } finally {
    if (workspace !== undefined) {
      await workspaces.destroy(workspace).catch(() => undefined);
    }
    await rm(workspaceRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}
