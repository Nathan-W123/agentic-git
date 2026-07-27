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
  TaskDefinition,
  TaskId,
  TaskStatus,
} from "@coord/shared-types";

import type { AuditChainVerification } from "./audit-chain.js";

export type RunMode = "coordinated" | "uncoordinated";
export type RunStatus = "running" | "completed" | "failed";

/**
 * The parts of an agent session the store records.
 *
 * Declared here rather than imported from the agent protocol so persistence
 * stays independent of provider-facing contracts. `AgentSession` satisfies it
 * structurally.
 */
export interface SessionRecord {
  id: string;
  agentId: string;
  taskId: TaskId;
  startedAt: string;
}

export interface StoredRepository {
  id: string;
  path: string;
  branch: string;
}

export interface CreateRunInput {
  repository: StoredRepository;
  mode: RunMode;
  scenario?: string;
  baseVersion: CanonicalVersion;
}

export interface StoredRun {
  id: string;
  repositoryId: string;
  mode: RunMode;
  scenario: string | undefined;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | undefined;
  baseRevision: string;
  finalRevision: string | undefined;
}

export interface StoredTask {
  runId: string;
  id: TaskId;
  objective: string;
  agentId: string;
  status: TaskStatus;
  explanation: string | undefined;
  plan: AgentPlan | undefined;
  decision: CoordinatorDecision | undefined;
  sessionId: string | undefined;
}

export interface StoredWorkspace {
  id: string;
  runId: string;
  taskId: TaskId;
  path: string;
  isolation: string;
  baseRevision: string;
  createdAt: string;
}

export interface RunDetail {
  run: StoredRun;
  tasks: StoredTask[];
  conflicts: ConflictAssessment[];
  changeSets: ChangeSet[];
  integrations: IntegrationResult[];
  leases: ResourceLease[];
  workspaces: StoredWorkspace[];
  audit: AuditEvent[];
}

export interface AppendAuditInput {
  type: AuditEventType;
  taskId?: TaskId;
  data?: Readonly<Record<string, unknown>>;
}

/**
 * Durable coordination state.
 *
 * Writes happen as a run progresses rather than at the end, so a crash leaves
 * a partial but truthful record instead of nothing. Reads exist to serve task
 * management, integration history, agent status, and the audit timeline.
 *
 * Implementations must treat audit events as append-only.
 */
export interface CoordinationStore {
  createRun(input: CreateRunInput): Promise<StoredRun>;
  finishRun(
    runId: string,
    status: RunStatus,
    finalVersion?: CanonicalVersion,
  ): Promise<void>;

  saveTask(runId: string, task: TaskDefinition): Promise<void>;
  savePlan(runId: string, taskId: TaskId, plan: AgentPlan): Promise<void>;
  saveSession(runId: string, session: SessionRecord): Promise<void>;
  saveDecision(runId: string, decision: CoordinatorDecision): Promise<void>;
  saveTaskStatus(
    runId: string,
    taskId: TaskId,
    status: TaskStatus,
    explanation?: string,
  ): Promise<void>;

  saveConflicts(
    runId: string,
    assessments: readonly ConflictAssessment[],
  ): Promise<void>;
  saveLeases(runId: string, leases: readonly ResourceLease[]): Promise<void>;
  releaseLeases(runId: string, taskId: TaskId): Promise<void>;
  saveWorkspace(runId: string, workspace: StoredWorkspace): Promise<void>;
  saveChangeSet(runId: string, changeSet: ChangeSet): Promise<void>;
  saveIntegration(runId: string, result: IntegrationResult): Promise<void>;
  saveCanonicalVersion(
    repositoryId: string,
    version: CanonicalVersion,
  ): Promise<void>;

  appendAudit(
    runId: string | undefined,
    input: AppendAuditInput,
  ): Promise<AuditEvent>;

  listRuns(limit?: number): Promise<StoredRun[]>;
  getRun(runId: string): Promise<RunDetail | undefined>;
  listAudit(runId?: string): Promise<AuditEvent[]>;
  verifyAudit(): Promise<AuditChainVerification>;

  close(): Promise<void>;
}
