import type {
  CoordinationStore,
  CreateRunInput,
  RunStatus,
  SessionRecord,
  StoredPlanRevision,
  StoredWorkspace,
} from "@coord/persistence";
import type {
  AgentPlan,
  AuditEvent,
  AuditEventType,
  CanonicalVersion,
  ChangeSet,
  ConflictAssessment,
  CoordinatorDecision,
  IntegrationResult,
  ResourceLease,
  ScopeChangeDecision,
  ScopeChangeRequest,
  TaskDefinition,
  TaskId,
  TaskStatus,
} from "@coord/shared-types";

/**
 * Binds a store to the single run it is recording.
 *
 * The coordinator holds one of these or nothing at all, which is what makes
 * the run id non-optional: there is no state where a store is present but the
 * run it belongs to is unknown.
 */
export class RunRecorder {
  private constructor(
    private readonly store: CoordinationStore,
    public readonly runId: string,
  ) {}

  public static async begin(
    store: CoordinationStore,
    input: CreateRunInput,
  ): Promise<RunRecorder> {
    const run = await store.createRun(input);
    return new RunRecorder(store, run.id);
  }

  public async task(task: TaskDefinition): Promise<void> {
    await this.store.saveTask(this.runId, task);
  }

  public async plan(taskId: TaskId, plan: AgentPlan): Promise<void> {
    await this.store.savePlan(this.runId, taskId, plan);
  }

  public async planRevision(
    taskId: TaskId,
    input: Omit<
      StoredPlanRevision,
      "id" | "runId" | "taskId" | "createdAt"
    >,
  ): Promise<void> {
    await this.store.savePlanRevision(this.runId, taskId, input);
  }

  public async scopeChange(request: ScopeChangeRequest): Promise<void> {
    await this.store.saveScopeChange(this.runId, request);
  }

  public async scopeDecision(decision: ScopeChangeDecision): Promise<void> {
    await this.store.saveScopeChangeDecision(this.runId, decision);
  }

  public async session(session: SessionRecord): Promise<void> {
    await this.store.saveSession(this.runId, session);
  }

  public async decision(decision: CoordinatorDecision): Promise<void> {
    await this.store.saveDecision(this.runId, decision);
  }

  public async status(
    taskId: TaskId,
    status: TaskStatus,
    explanation?: string,
  ): Promise<void> {
    await this.store.saveTaskStatus(
      this.runId,
      taskId,
      status,
      ...(explanation === undefined ? [] : [explanation]),
    );
  }

  public async conflicts(
    assessments: readonly ConflictAssessment[],
  ): Promise<void> {
    await this.store.saveConflicts(this.runId, assessments);
  }

  public async leases(leases: readonly ResourceLease[]): Promise<void> {
    await this.store.saveLeases(this.runId, leases);
  }

  public async releaseLeases(taskId: TaskId): Promise<void> {
    await this.store.releaseLeases(this.runId, taskId);
  }

  public async workspace(
    workspace: Omit<StoredWorkspace, "runId">,
  ): Promise<void> {
    await this.store.saveWorkspace(this.runId, {
      ...workspace,
      runId: this.runId,
    });
  }

  public async changeSet(changeSet: ChangeSet): Promise<void> {
    await this.store.saveChangeSet(this.runId, changeSet);
  }

  public async integration(result: IntegrationResult): Promise<void> {
    await this.store.saveIntegration(this.runId, result);
  }

  public async audit(
    type: AuditEventType,
    taskId: string | undefined,
    data: Readonly<Record<string, unknown>>,
  ): Promise<AuditEvent> {
    return await this.store.appendAudit(this.runId, {
      type,
      data,
      ...(taskId === undefined ? {} : { taskId }),
    });
  }

  public async finish(
    status: RunStatus,
    finalVersion?: CanonicalVersion,
  ): Promise<void> {
    await this.store.finishRun(
      this.runId,
      status,
      ...(finalVersion === undefined ? [] : [finalVersion]),
    );
  }
}
