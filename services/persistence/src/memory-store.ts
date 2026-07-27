import {
  createId,
  type AgentPlan,
  type AuditEvent,
  type CanonicalVersion,
  type ChangeSet,
  type ConflictAssessment,
  type CoordinatorDecision,
  type IntegrationResult,
  type ResourceLease,
  type TaskDefinition,
  type TaskId,
  type TaskStatus,
} from "@coord/shared-types";

import {
  GENESIS_HASH,
  chainHash,
  hashAuditPayload,
  verifyAuditChain,
  type AuditChainVerification,
  type ChainedAuditEvent,
} from "./audit-chain.js";
import type {
  AppendAuditInput,
  CoordinationStore,
  CreateRunInput,
  RunDetail,
  RunStatus,
  SessionRecord,
  StoredRun,
  StoredTask,
  StoredWorkspace,
} from "./store.js";

interface RunState {
  run: StoredRun;
  tasks: Map<TaskId, StoredTask>;
  conflicts: ConflictAssessment[];
  changeSets: ChangeSet[];
  integrations: IntegrationResult[];
  leases: ResourceLease[];
  workspaces: StoredWorkspace[];
}

/**
 * Non-durable store with identical semantics to the SQLite one.
 *
 * Keeps the coordinator's default behavior dependency-free and lets tests
 * exercise the write path without touching disk.
 */
export class InMemoryCoordinationStore implements CoordinationStore {
  private readonly runs = new Map<string, RunState>();
  private readonly audit: ChainedAuditEvent[] = [];
  /** Run association per audit entry, parallel to {@link audit}. */
  private readonly auditRuns: Array<string | undefined> = [];

  public async createRun(input: CreateRunInput): Promise<StoredRun> {
    const run: StoredRun = {
      id: createId("run"),
      repositoryId: input.repository.id,
      mode: input.mode,
      scenario: input.scenario,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      baseRevision: input.baseVersion.revision,
      finalRevision: undefined,
    };
    this.runs.set(run.id, {
      run,
      tasks: new Map(),
      conflicts: [],
      changeSets: [],
      integrations: [],
      leases: [],
      workspaces: [],
    });
    return run;
  }

  public async finishRun(
    runId: string,
    status: RunStatus,
    finalVersion?: CanonicalVersion,
  ): Promise<void> {
    const state = this.runs.get(runId);
    if (state === undefined) {
      return;
    }
    state.run.status = status;
    state.run.finishedAt = new Date().toISOString();
    state.run.finalRevision = finalVersion?.revision;
  }

  public async saveTask(runId: string, task: TaskDefinition): Promise<void> {
    this.requireRun(runId).tasks.set(task.id, {
      runId,
      id: task.id,
      objective: task.objective,
      agentId: task.agentId,
      status: "submitted",
      explanation: undefined,
      plan: undefined,
      decision: undefined,
      sessionId: undefined,
    });
  }

  public async savePlan(
    runId: string,
    taskId: TaskId,
    plan: AgentPlan,
  ): Promise<void> {
    const task = this.requireTask(runId, taskId);
    task.plan = plan;
    task.status = "planning";
  }

  public async saveSession(runId: string, session: SessionRecord): Promise<void> {
    this.requireTask(runId, session.taskId).sessionId = session.id;
  }

  public async saveDecision(
    runId: string,
    decision: CoordinatorDecision,
  ): Promise<void> {
    this.requireTask(runId, decision.taskId).decision = decision;
  }

  public async saveTaskStatus(
    runId: string,
    taskId: TaskId,
    status: TaskStatus,
    explanation?: string,
  ): Promise<void> {
    const task = this.requireTask(runId, taskId);
    task.status = status;
    task.explanation = explanation;
  }

  public async saveConflicts(
    runId: string,
    assessments: readonly ConflictAssessment[],
  ): Promise<void> {
    this.requireRun(runId).conflicts.push(...assessments);
  }

  public async saveLeases(
    runId: string,
    leases: readonly ResourceLease[],
  ): Promise<void> {
    this.requireRun(runId).leases.push(...leases);
  }

  public async releaseLeases(_runId: string, _taskId: TaskId): Promise<void> {
    // Release time is not projected in memory; the lease list is the record.
  }

  public async saveWorkspace(
    runId: string,
    workspace: StoredWorkspace,
  ): Promise<void> {
    this.requireRun(runId).workspaces.push(workspace);
  }

  public async saveChangeSet(runId: string, changeSet: ChangeSet): Promise<void> {
    this.requireRun(runId).changeSets.push(changeSet);
  }

  public async saveIntegration(
    runId: string,
    result: IntegrationResult,
  ): Promise<void> {
    this.requireRun(runId).integrations.push(result);
  }

  public async saveCanonicalVersion(
    _repositoryId: string,
    _version: CanonicalVersion,
  ): Promise<void> {
    // Canonical history is only meaningful once durable.
  }

  public async appendAudit(
    runId: string | undefined,
    input: AppendAuditInput,
  ): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: createId("audit"),
      type: input.type,
      occurredAt: new Date().toISOString(),
      data: input.data ?? {},
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    };

    const previousHash = this.audit.at(-1)?.chainHash ?? GENESIS_HASH;
    const payloadHash = hashAuditPayload(event);
    this.audit.push({
      event,
      sequence: this.audit.length + 1,
      payloadHash,
      previousHash,
      chainHash: chainHash(previousHash, payloadHash),
    });
    this.auditRuns.push(runId);
    return event;
  }

  public async listRuns(limit = 50): Promise<StoredRun[]> {
    return [...this.runs.values()]
      .map((state) => state.run)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, limit);
  }

  public async getRun(runId: string): Promise<RunDetail | undefined> {
    const state = this.runs.get(runId);
    if (state === undefined) {
      return undefined;
    }
    return {
      run: state.run,
      tasks: [...state.tasks.values()],
      conflicts: [...state.conflicts],
      changeSets: [...state.changeSets],
      integrations: [...state.integrations],
      leases: [...state.leases],
      workspaces: [...state.workspaces],
      audit: await this.listAudit(runId),
    };
  }

  public async listAudit(runId?: string): Promise<AuditEvent[]> {
    return this.audit
      .filter((_, index) => runId === undefined || this.auditRuns[index] === runId)
      .map((entry) => entry.event);
  }

  public async verifyAudit(): Promise<AuditChainVerification> {
    return verifyAuditChain(this.audit);
  }

  public async close(): Promise<void> {
    // Nothing to release.
  }

  private requireRun(runId: string): RunState {
    const state = this.runs.get(runId);
    if (state === undefined) {
      throw new Error(`Unknown coordination run: ${runId}`);
    }
    return state;
  }

  private requireTask(runId: string, taskId: TaskId): StoredTask {
    const task = this.requireRun(runId).tasks.get(taskId);
    if (task === undefined) {
      throw new Error(`Unknown task ${taskId} in run ${runId}`);
    }
    return task;
  }
}
