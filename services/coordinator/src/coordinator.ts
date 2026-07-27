import type { AgentAdapter, AgentSession } from "@coord/agent-protocol";
import {
  assertAgentPlan,
  type AgentPlan,
  type ChangeSet,
  type CoordinationRunResult,
  type CoordinatorDecision,
  type TaskDefinition,
  type TaskExecutionResult,
} from "@coord/shared-types";
import { IntegrationService } from "@coord/integration-service";
import {
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  GitWorktreeWorkspaceManager,
  type TaskWorkspace,
  type WorkspaceManager,
} from "@coord/workspace-manager";

import { InMemoryAuditLog } from "./audit-log.js";
import {
  ConflictDetector,
  overlappingFiles,
} from "./conflict-detector.js";
import { OwnershipService } from "./ownership-service.js";
import { assertChangeSetWithinPlan } from "./scope-validator.js";

export interface CoordinatedTask {
  task: TaskDefinition;
  adapter: AgentAdapter;
}

export interface CoordinatorRunInput {
  repository: CanonicalRepository;
  workspaceRoot: string;
  integrationRoot: string;
  tasks: CoordinatedTask[];
}

interface PlannedTask extends CoordinatedTask {
  session: AgentSession;
  plan: AgentPlan;
  decision: CoordinatorDecision;
}

interface PreparedTask extends PlannedTask {
  workspace: TaskWorkspace;
  changeSet: ChangeSet;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plansOverlap(first: AgentPlan, second: AgentPlan): boolean {
  return overlappingFiles(first, second).length > 0;
}

export class Coordinator {
  public constructor(
    private readonly repositories = new RepositoryService(),
    private readonly workspaces: WorkspaceManager =
      new GitWorktreeWorkspaceManager(repositories.getGitClient()),
    private readonly integrations = new IntegrationService(
      repositories,
      workspaces,
    ),
    private readonly conflicts = new ConflictDetector(),
    private readonly ownership = new OwnershipService(),
    private readonly audit = new InMemoryAuditLog(),
  ) {}

  public async run(input: CoordinatorRunInput): Promise<CoordinationRunResult> {
    const initialVersion = await this.repositories.getCanonicalVersion(
      input.repository,
    );
    for (const entry of input.tasks) {
      this.audit.record("task_submitted", entry.task.id, {
        objective: entry.task.objective,
        agentId: entry.task.agentId,
      });
    }

    const sessionPlans = await Promise.all(
      input.tasks.map(async (entry) => {
        const capabilities = await entry.adapter.getCapabilities();
        if (!capabilities.canPlan || !capabilities.canEditFiles) {
          throw new Error(
            `Agent ${entry.task.agentId} cannot satisfy the Phase 0 protocol`,
          );
        }

        const session = await entry.adapter.startTask({
          task: entry.task,
          canonicalVersion: initialVersion,
          repositoryId: input.repository.id,
        });
        const plan = await entry.adapter.requestPlan(session.id);
        assertAgentPlan(plan);
        if (plan.taskId !== entry.task.id) {
          throw new Error(
            `Agent plan task ${plan.taskId} does not match ${entry.task.id}`,
          );
        }

        this.audit.record("plan_received", entry.task.id, {
          expectedFiles: plan.expectedFiles,
          riskLevel: plan.riskLevel,
        });
        return { ...entry, session, plan };
      }),
    );

    const assessments = this.conflicts.assessAll(
      sessionPlans.map((entry) => entry.plan),
    );
    for (const assessment of assessments) {
      this.audit.record("conflict_detected", undefined, {
        taskIds: assessment.taskIds,
        score: assessment.score,
        evidence: assessment.evidence,
      });
    }

    const planned: PlannedTask[] = sessionPlans.map((entry, index) => {
      const earlierBlockers = sessionPlans
        .slice(0, index)
        .filter((candidate) => plansOverlap(candidate.plan, entry.plan))
        .map((candidate) => candidate.task.id);
      const isQueued = earlierBlockers.length > 0;
      return {
        ...entry,
        decision: {
          decision: isQueued ? "queued" : "approved",
          taskId: entry.task.id,
          ownershipGrants: [],
          constraints: isQueued
            ? ["Start from canonical state after blocking tasks integrate"]
            : [],
          blockedBy: earlierBlockers,
          explanation: isQueued
            ? `Queued behind ${earlierBlockers.join(", ")} due to exclusive file ownership`
            : "Approved for the next non-conflicting execution wave",
        },
      };
    });

    const pending = [...planned];
    const taskResults: TaskExecutionResult[] = [];

    while (pending.length > 0) {
      const wave: PlannedTask[] = [];
      for (const candidate of pending) {
        if (
          wave.every((selected) => !plansOverlap(selected.plan, candidate.plan))
        ) {
          wave.push(candidate);
        }
      }
      for (const selected of wave) {
        pending.splice(pending.indexOf(selected), 1);
      }

      const waveVersion = await this.repositories.getCanonicalVersion(
        input.repository,
      );
      const prepared = await Promise.all(
        wave.map(async (entry): Promise<PreparedTask | TaskExecutionResult> => {
          let workspace: TaskWorkspace | undefined;
          try {
            const leases = this.ownership.acquire(
              entry.plan,
              entry.task.agentId,
              waveVersion.sequence,
            );
            this.audit.record("ownership_granted", entry.task.id, {
              leases,
            });

            workspace = await this.workspaces.create({
              taskId: entry.task.id,
              rootPath: input.workspaceRoot,
              repository: input.repository,
              baseVersion: waveVersion,
            });
            entry.decision.workspaceId = workspace.id;
            entry.decision.ownershipGrants = leases;
            this.audit.record("task_started", entry.task.id, {
              workspaceId: workspace.id,
              baseRevision: waveVersion.revision,
            });

            await entry.adapter.sendContext(entry.session.id, {
              decision: entry.decision,
              canonicalVersion: waveVersion,
              workspacePath: workspace.path,
            });
            const changeSet = await entry.adapter.collectChanges(
              entry.session.id,
            );
            if (
              changeSet.taskId !== entry.task.id ||
              changeSet.baseRevision !== waveVersion.revision ||
              changeSet.baseVersion !== waveVersion.sequence
            ) {
              throw new Error(
                `Agent ${entry.task.agentId} returned a changeset for an unexpected task or base`,
              );
            }
            assertChangeSetWithinPlan(entry.plan, changeSet);
            this.audit.record("changeset_collected", entry.task.id, {
              changeSetId: changeSet.id,
              files: changeSet.patches.map((patch) => patch.path),
            });
            return { ...entry, workspace, changeSet };
          } catch (error) {
            if (workspace !== undefined) {
              await this.workspaces.destroy(workspace);
            }
            this.ownership.releaseTask(entry.task.id);
            this.audit.record("task_failed", entry.task.id, {
              error: errorMessage(error),
            });
            return {
              task: entry.task,
              plan: entry.plan,
              decision: entry.decision,
              status: "failed",
              explanation: errorMessage(error),
            };
          }
        }),
      );

      for (const result of prepared) {
        if (!("changeSet" in result)) {
          taskResults.push(result);
          continue;
        }

        try {
          const integration = await this.integrations.integrate({
            repository: input.repository,
            integrationRoot: input.integrationRoot,
            changeSet: result.changeSet,
            validationCommands: result.task.validationCommands,
            commitMessage: `coord(${result.task.id}): ${result.task.objective}`,
          });
          this.audit.record("validation_completed", result.task.id, {
            status: integration.status,
            commands: integration.validation.map((entry) => ({
              label: entry.command.label,
              exitCode: entry.exitCode,
            })),
          });

          if (integration.status === "integrated") {
            this.audit.record("canonical_promoted", result.task.id, {
              previousRevision: integration.previousVersion.revision,
              revision: integration.canonicalVersion.revision,
              changeSetId: integration.changeSetId,
            });
          } else {
            this.audit.record("task_failed", result.task.id, {
              status: integration.status,
              explanation: integration.explanation,
            });
          }

          taskResults.push({
            task: result.task,
            plan: result.plan,
            decision: result.decision,
            integration,
            status:
              integration.status === "integrated" ? "integrated" : "failed",
            explanation: integration.explanation,
          });
        } catch (error) {
          this.audit.record("task_failed", result.task.id, {
            error: errorMessage(error),
          });
          taskResults.push({
            task: result.task,
            plan: result.plan,
            decision: result.decision,
            status: "failed",
            explanation: errorMessage(error),
          });
        } finally {
          await this.workspaces.destroy(result.workspace);
          const released = this.ownership.releaseTask(result.task.id);
          this.audit.record("ownership_released", result.task.id, {
            leaseIds: released.map((lease) => lease.leaseId),
          });
        }
      }
    }

    const canonicalVersion = await this.repositories.getCanonicalVersion(
      input.repository,
    );
    return {
      canonicalVersion,
      conflicts: assessments,
      tasks: input.tasks.map((entry) => {
        const result = taskResults.find(
          (candidate) => candidate.task.id === entry.task.id,
        );
        if (result === undefined) {
          throw new Error(`Missing result for task ${entry.task.id}`);
        }
        return result;
      }),
      audit: this.audit.all(),
    };
  }
}
