import { randomUUID } from "node:crypto";
import path from "node:path";

export type TaskId = string;
export type AgentId = string;
export type SessionId = string;
export type WorkspaceId = string;
export type ChangeSetId = string;
export type LeaseId = string;

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type TaskStatus =
  | "submitted"
  | "planning"
  | "approved"
  | "queued"
  | "running"
  | "validating"
  | "integrated"
  | "failed"
  | "cancelled";

export interface ValidationCommand {
  executable: string;
  args: string[];
  label: string;
}

export interface TaskDefinition {
  id: TaskId;
  objective: string;
  agentId: AgentId;
  validationCommands: ValidationCommand[];
}

export interface AgentPlan {
  taskId: TaskId;
  objective: string;
  expectedFiles: string[];
  expectedSymbols: string[];
  dependencies: string[];
  commands: ValidationCommand[];
  externalAccess: string[];
  riskLevel: RiskLevel;
}

export interface CanonicalVersion {
  sequence: number;
  revision: string;
  branch: string;
  createdAt: string;
}

export type OwnershipMode =
  | "observe"
  | "shared"
  | "intent"
  | "exclusive"
  | "approval_required";

export type ResourceType = "file" | "symbol" | "api" | "schema" | "service";

export interface ResourceLease {
  leaseId: LeaseId;
  resourceType: ResourceType;
  resourceId: string;
  principalId: AgentId;
  taskId: TaskId;
  mode: OwnershipMode;
  baseVersion: number;
  expiresAt: string;
}

export type ConflictDisposition =
  | "concurrent"
  | "concurrent_with_notification"
  | "sequence"
  | "block";

export interface ConflictEvidence {
  kind: "file_overlap";
  resources: string[];
  taskIds: [TaskId, TaskId];
  score: number;
}

export interface ConflictAssessment {
  taskIds: [TaskId, TaskId];
  score: number;
  disposition: ConflictDisposition;
  evidence: ConflictEvidence[];
  explanation: string;
}

export type CoordinatorDecisionKind =
  | "approved"
  | "approved_with_constraints"
  | "queued"
  | "rejected";

export interface CoordinatorDecision {
  decision: CoordinatorDecisionKind;
  taskId: TaskId;
  workspaceId?: WorkspaceId;
  ownershipGrants: ResourceLease[];
  constraints: string[];
  blockedBy: TaskId[];
  explanation: string;
}

export type FilePatchStatus = "added" | "modified" | "deleted";

export interface FilePatch {
  path: string;
  status: FilePatchStatus;
  patch: string;
}

export interface CommandResult {
  command: ValidationCommand;
  exitCode: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  durationMs: number;
}

export interface TestResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  output: string;
}

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
}

export interface ChangeSet {
  id: ChangeSetId;
  taskId: TaskId;
  baseVersion: number;
  baseRevision: string;
  patches: FilePatch[];
  commandsRun: CommandResult[];
  tests: TestResult[];
  dependenciesChanged: string[];
  symbolsChanged: string[];
  riskAssessment: RiskAssessment;
  agentExplanation: string;
  createdAt: string;
}

export type IntegrationStatus =
  | "integrated"
  | "conflict"
  | "validation_failed"
  | "stale"
  | "empty";

export interface IntegrationResult {
  taskId: TaskId;
  changeSetId: ChangeSetId;
  status: IntegrationStatus;
  previousVersion: CanonicalVersion;
  canonicalVersion: CanonicalVersion;
  validation: CommandResult[];
  candidateRevision?: string;
  explanation: string;
}

export type AuditEventType =
  | "task_submitted"
  | "plan_received"
  | "conflict_detected"
  | "ownership_granted"
  | "task_started"
  | "changeset_collected"
  | "validation_completed"
  | "canonical_promoted"
  | "task_failed"
  | "ownership_released";

export interface AuditEvent {
  id: string;
  type: AuditEventType;
  taskId?: TaskId;
  occurredAt: string;
  data: Readonly<Record<string, unknown>>;
}

export interface TaskExecutionResult {
  task: TaskDefinition;
  plan: AgentPlan;
  decision: CoordinatorDecision;
  integration?: IntegrationResult;
  status: TaskStatus;
  explanation: string;
}

export interface CoordinationRunResult {
  canonicalVersion: CanonicalVersion;
  conflicts: ConflictAssessment[];
  tasks: TaskExecutionResult[];
  audit: AuditEvent[];
}

export interface BenchmarkModeResult {
  mode: "coordinated" | "uncoordinated";
  scenario: string;
  tasksPlanned: number;
  tasksCompleted: number;
  /** tasksCompleted / tasksPlanned, so scenarios of different sizes compare. */
  completionRate: number;
  conflictWarnings: number;
  integrationAttempts: number;
  /**
   * Attempts that did not reach canonical. Reported separately from rework
   * because a coordinated run performs no replay: an unrecovered failure would
   * otherwise be indistinguishable from a clean run.
   */
  integrationFailures: number;
  /** Replays performed after a failed attempt. */
  reworkCount: number;
  /** reworkCount / tasksPlanned. */
  reworkRate: number;
  /**
   * Tasks that failed integration despite no predicted conflict. This is the
   * coordinator's miss rate, not a property of the mode.
   */
  undetectedConflicts: number;
  elapsedMs: number;
  finalRevision: string;
}

export interface BenchmarkReport {
  generatedAt: string;
  scenario: string;
  scenarioDescription: string;
  coordinated: BenchmarkModeResult;
  uncoordinated: BenchmarkModeResult;
  reworkAvoided: number;
  /** reworkRate difference; positive means coordination removed rework. */
  reworkRateAvoided: number;
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function normalizeRepositoryPath(value: string): string {
  const candidate = value.trim().replaceAll("\\", "/");

  if (
    candidate.length === 0 ||
    candidate.includes("\0") ||
    path.posix.isAbsolute(candidate) ||
    /^[A-Za-z]:\//u.test(candidate)
  ) {
    throw new Error(`Invalid repository-relative path: ${JSON.stringify(value)}`);
  }

  const normalized = path.posix.normalize(candidate);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Path escapes the repository: ${JSON.stringify(value)}`);
  }

  return normalized;
}

export function uniqueRepositoryPaths(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeRepositoryPath))].sort();
}

export function assertAgentPlan(value: unknown): asserts value is AgentPlan {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Agent plan must be an object");
  }

  const plan = value as Partial<AgentPlan>;
  if (
    typeof plan.taskId !== "string" ||
    typeof plan.objective !== "string" ||
    !Array.isArray(plan.expectedFiles) ||
    !plan.expectedFiles.every((file) => typeof file === "string") ||
    !Array.isArray(plan.expectedSymbols) ||
    !plan.expectedSymbols.every((symbol) => typeof symbol === "string") ||
    !Array.isArray(plan.dependencies) ||
    !plan.dependencies.every((dependency) => typeof dependency === "string") ||
    !Array.isArray(plan.commands) ||
    !Array.isArray(plan.externalAccess) ||
    !plan.externalAccess.every((entry) => typeof entry === "string") ||
    !["low", "medium", "high", "critical"].includes(plan.riskLevel ?? "")
  ) {
    throw new TypeError("Agent plan does not match the coordination schema");
  }

  plan.expectedFiles = uniqueRepositoryPaths(plan.expectedFiles);
}

