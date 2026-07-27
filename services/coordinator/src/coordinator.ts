import type { AgentAdapter, AgentSession } from "@coord/agent-protocol";
import {
  assertAgentPlan,
  type AgentPlan,
  type AuditEventType,
  type ChangeSet,
  type CoordinationRunResult,
  type CoordinatorDecision,
  type TaskDefinition,
  type TaskExecutionResult,
} from "@coord/shared-types";
import { IntegrationService } from "@coord/integration-service";
import type { CoordinationStore } from "@coord/persistence";
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
  /** Recorded alongside the run so history can be filtered by task set. */
  scenario?: string;
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
    /**
     * Optional durable store. Writes happen as the run progresses, so a crash
     * leaves a partial but truthful record rather than nothing.
     */
    private readonly store?: CoordinationStore,
  ) {}

  public async run(input: CoordinatorRunInput): Promise<CoordinationRunResult> {
    const initialVersion = await this.repositories.getCanonicalVersion(
      input.repository,
    );

    const storedRun = await this.store?.createRun({
      repository: input.repository,
      mode: "coordinated",
      baseVersion: initialVersion,
      ...(input.scenario === undefined ? {} : { scenario: input.scenario }),
    });
    const runId = storedRun?.id;

    try {
      const result = await this.execute(input, initialVersion, runId);
      await this.store?.finishRun(
        runId ?? "",
        "completed",
        result.canonicalVersion,
      );
      return result;
    } catch (error) {
      await this.store?.finishRun(runId ?? "", "failed");
      throw error;
    }
  }

  private async execute(
    input: CoordinatorRunInput,
    initialVersion: Awaited<
      ReturnType<RepositoryService["getCanonicalVersion"]>
    >,
    runId: string | undefined,
  ): Promise<CoordinationRunResult> {
    for (const entry of input.tasks) {
      await this.store?.saveTask(runId ?? "", entry.task);
      await this.trace(runId, "task_submitted", entry.task.id, {
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
        await this.store?.saveSession(runId ?? "", session);

        const plan = await entry.adapter.requestPlan(session.id);
        assertAgentPlan(plan);
        if (plan.taskId !== entry.task.id) {
          throw new Error(
            `Agent plan task ${plan.taskId} does not match ${entry.task.id}`,
          );
        }

        await this.store?.savePlan(runId ?? "", entry.task.id, plan);
        await this.trace(runId, "plan_received", entry.task.id, {
          expectedFiles: plan.expectedFiles,
          riskLevel: plan.riskLevel,
        });
        return { ...entry, session, plan };
      }),
    );

    const assessments = this.conflicts.assessAll(
      sessionPlans.map((entry) => entry.plan),
    );
    await this.store?.saveConflicts(runId ?? "", assessments);
    for (const assessment of assessments) {
      await this.trace(runId, "conflict_detected", undefined, {
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
            await this.store?.saveLeases(runId ?? "", leases);
            await this.trace(runId, "ownership_granted", entry.task.id, {
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
            await this.store?.saveDecision(runId ?? "", entry.decision);
            await this.store?.saveWorkspace(runId ?? "", {
              id: workspace.id,
              runId: runId ?? "",
              taskId: entry.task.id,
              path: workspace.path,
              isolation: workspace.isolation,
              baseRevision: workspace.baseVersion.revision,
              createdAt: workspace.createdAt,
            });
            await this.store?.saveTaskStatus(runId ?? "", entry.task.id, "running");
            await this.trace(runId, "task_started", entry.task.id, {
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
            await this.store?.saveChangeSet(runId ?? "", changeSet);
            await this.trace(runId, "changeset_collected", entry.task.id, {
              changeSetId: changeSet.id,
              files: changeSet.patches.map((patch) => patch.path),
            });
            return { ...entry, workspace, changeSet };
          } catch (error) {
            if (workspace !== undefined) {
              await this.workspaces.destroy(workspace);
            }
            this.ownership.releaseTask(entry.task.id);
            await this.store?.releaseLeases(runId ?? "", entry.task.id);
            await this.store?.saveTaskStatus(
              runId ?? "",
              entry.task.id,
              "failed",
              errorMessage(error),
            );
            await this.trace(runId, "task_failed", entry.task.id, {
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
          await this.store?.saveIntegration(runId ?? "", integration);
          await this.trace(runId, "validation_completed", result.task.id, {
            status: integration.status,
            commands: integration.validation.map((entry) => ({
              label: entry.command.label,
              exitCode: entry.exitCode,
            })),
          });

          if (integration.status === "integrated") {
            await this.trace(runId, "canonical_promoted", result.task.id, {
              previousRevision: integration.previousVersion.revision,
              revision: integration.canonicalVersion.revision,
              changeSetId: integration.changeSetId,
            });
          } else {
            await this.trace(runId, "task_failed", result.task.id, {
              status: integration.status,
              explanation: integration.explanation,
            });
          }

          const status =
            integration.status === "integrated" ? "integrated" : "failed";
          await this.store?.saveTaskStatus(
            runId ?? "",
            result.task.id,
            status,
            integration.explanation,
          );
          taskResults.push({
            task: result.task,
            plan: result.plan,
            decision: result.decision,
            integration,
            status,
            explanation: integration.explanation,
          });
        } catch (error) {
          await this.store?.saveTaskStatus(
            runId ?? "",
            result.task.id,
            "failed",
            errorMessage(error),
          );
          await this.trace(runId, "task_failed", result.task.id, {
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
          await this.store?.releaseLeases(runId ?? "", result.task.id);
          await this.trace(runId, "ownership_released", result.task.id, {
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

  /** Records one transition to the in-process log and the durable store. */
  private async trace(
    runId: string | undefined,
    type: AuditEventType,
    taskId: string | undefined,
    data: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    this.audit.record(type, taskId, data);
    if (this.store !== undefined) {
      await this.store.appendAudit(runId, {
        type,
        data,
        ...(taskId === undefined ? {} : { taskId }),
      });
    }
  }
}
