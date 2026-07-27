import { randomUUID } from "node:crypto";
import path from "node:path";

export type TaskId = string;
export type AgentId = string;
export type SessionId = string;
export type WorkspaceId = string;
export type ChangeSetId = string;
export type LeaseId = string;
export type OrganizationId = string;
export type UserId = string;
export type ProjectId = string;
export type ApprovalId = string;
export type ScopeChangeId = string;

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type TaskStatus =
  | "submitted"
  | "planning"
  | "approved"
  | "queued"
  | "running"
  | "replanning"
  | "awaiting_approval"
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
  projectId?: ProjectId;
}

export interface AgentPlan {
  taskId: TaskId;
  objective: string;
  expectedFiles: string[];
  expectedSymbols: string[];
  /** Public routes, commands, events, or other externally consumed APIs. */
  expectedApis?: string[];
  /** Database, validation, serialization, or infrastructure schemas. */
  expectedSchemas?: string[];
  /** Configuration keys whose values or meaning may change. */
  expectedConfigKeys?: string[];
  /** Test files or named test suites expected to change or be affected. */
  expectedTests?: string[];
  /** Services expected to be changed, introduced, or consumed. */
  expectedServices?: string[];
  dependencies: string[];
  commands: ValidationCommand[];
  externalAccess: string[];
  riskLevel: RiskLevel;
  /** Concise engineering intent used only for advisory intent analysis. */
  intent?: string;
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

export type ResourceType =
  | "file"
  | "symbol"
  | "api"
  | "schema"
  | "configuration"
  | "test"
  | "service";

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
  kind:
    | "file_overlap"
    | "symbol_overlap"
    | "dependency_impact"
    | "api_overlap"
    | "schema_overlap"
    | "configuration_overlap"
    | "test_overlap"
    | "intent_conflict";
  resources: string[];
  taskIds: [TaskId, TaskId];
  score: number;
  /** Intent evidence is advisory and cannot independently block execution. */
  advisory?: boolean;
  explanation?: string;
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
  planRevision?: number;
  ownershipGrants: ResourceLease[];
  constraints: string[];
  blockedBy: TaskId[];
  explanation: string;
}

export interface CanonicalChangeNotice {
  previousVersion: CanonicalVersion;
  canonicalVersion: CanonicalVersion;
  changedFiles: string[];
  changedSymbols: string[];
  changedApis: string[];
  changedSchemas: string[];
  changedConfigKeys: string[];
  changedTests: string[];
  changedServices: string[];
  reason: string;
}

export interface ReplanRequest {
  taskId: TaskId;
  previousPlan: AgentPlan;
  canonicalChange: CanonicalChangeNotice;
  constraints: string[];
}

export interface ScopeChangeRequest {
  id: ScopeChangeId;
  taskId: TaskId;
  additionalFiles: string[];
  additionalSymbols: string[];
  additionalApis: string[];
  additionalSchemas: string[];
  additionalConfigKeys: string[];
  additionalTests: string[];
  additionalServices: string[];
  reason: string;
  occurredAt: string;
}

export type ScopeChangeDecisionKind =
  | "approved"
  | "approved_with_constraints"
  | "rejected";

export interface ScopeChangeDecision {
  requestId: ScopeChangeId;
  taskId: TaskId;
  decision: ScopeChangeDecisionKind;
  revisedPlan: AgentPlan;
  constraints: string[];
  ownershipGrants: ResourceLease[];
  explanation: string;
  decidedAt: string;
}

export type ApprovalKind = "changeset" | "scope_change" | "policy_override";
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired";

export interface ApprovalRequest {
  id: ApprovalId;
  organizationId?: OrganizationId;
  projectId?: ProjectId;
  repositoryId: string;
  runId: string;
  taskId: TaskId;
  kind: ApprovalKind;
  status: ApprovalStatus;
  requestedBy: string;
  requiredRole: "reviewer" | "admin" | "owner";
  reasons: string[];
  changeSetId?: ChangeSetId;
  scopeChangeId?: ScopeChangeId;
  requestedAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: UserId;
  decisionComment?: string;
}

export interface ApprovalDecision {
  approvalId: ApprovalId;
  status: Extract<ApprovalStatus, "approved" | "rejected">;
  decidedBy: UserId;
  comment: string;
  decidedAt: string;
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
  | "policy_failed"
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
  cleanupWarnings?: string[];
  explanation: string;
}

export type AuditEventType =
  | "user_authenticated"
  | "user_signed_out"
  | "user_changed"
  | "api_token_issued"
  | "api_token_revoked"
  | "organization_changed"
  | "membership_changed"
  | "project_changed"
  | "repository_imported"
  | "task_submitted"
  | "plan_received"
  | "plan_revised"
  | "replan_requested"
  | "conflict_detected"
  | "ownership_granted"
  | "task_started"
  | "agent_progress"
  | "scope_change_requested"
  | "scope_change_decided"
  | "changeset_collected"
  | "approval_requested"
  | "approval_decided"
  | "validation_completed"
  | "canonical_promoted"
  | "canonical_changed"
  | "task_failed"
  | "task_cancelled"
  | "cleanup_failed"
  | "ownership_released";

export interface AuditEvent {
  id: string;
  type: AuditEventType;
  taskId?: TaskId;
  occurredAt: string;
  data: Readonly<Record<string, unknown>>;
}

export interface SequencedAuditEvent {
  sequence: number;
  runId?: string;
  event: AuditEvent;
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
  /** Identifier assigned by the durable store, when one recorded the run. */
  runId?: string;
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
  const candidate = value.replaceAll("\\", "/");

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

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}

export function assertAgentPlan(value: unknown): asserts value is AgentPlan {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Agent plan must be an object");
  }

  const plan = value as Partial<AgentPlan>;
  if (
    typeof plan.taskId !== "string" ||
    plan.taskId.length === 0 ||
    typeof plan.objective !== "string" ||
    plan.objective.trim().length === 0 ||
    !isStringArray(plan.expectedFiles) ||
    !isStringArray(plan.expectedSymbols) ||
    !isOptionalStringArray(plan.expectedApis) ||
    !isOptionalStringArray(plan.expectedSchemas) ||
    !isOptionalStringArray(plan.expectedConfigKeys) ||
    !isOptionalStringArray(plan.expectedTests) ||
    !isOptionalStringArray(plan.expectedServices) ||
    !isStringArray(plan.dependencies) ||
    !Array.isArray(plan.commands) ||
    !plan.commands.every(
      (command) =>
        typeof command === "object" &&
        command !== null &&
        typeof command.executable === "string" &&
        command.executable.trim().length > 0 &&
        Array.isArray(command.args) &&
        command.args.every((argument) => typeof argument === "string") &&
        typeof command.label === "string" &&
        command.label.trim().length > 0,
    ) ||
    !isStringArray(plan.externalAccess) ||
    !["low", "medium", "high", "critical"].includes(plan.riskLevel ?? "") ||
    (plan.intent !== undefined &&
      (typeof plan.intent !== "string" || plan.intent.trim().length === 0))
  ) {
    throw new TypeError("Agent plan does not match the coordination schema");
  }

  plan.expectedFiles = uniqueRepositoryPaths(plan.expectedFiles);
  plan.expectedSymbols = uniqueStrings(plan.expectedSymbols);
  plan.dependencies = uniqueStrings(plan.dependencies);
  plan.externalAccess = uniqueStrings(plan.externalAccess);
  if (plan.expectedApis !== undefined) {
    plan.expectedApis = uniqueStrings(plan.expectedApis);
  }
  if (plan.expectedSchemas !== undefined) {
    plan.expectedSchemas = uniqueStrings(plan.expectedSchemas);
  }
  if (plan.expectedConfigKeys !== undefined) {
    plan.expectedConfigKeys = uniqueStrings(plan.expectedConfigKeys);
  }
  if (plan.expectedTests !== undefined) {
    plan.expectedTests = uniqueStrings(plan.expectedTests);
  }
  if (plan.expectedServices !== undefined) {
    plan.expectedServices = uniqueStrings(plan.expectedServices);
  }
  if (plan.intent !== undefined) {
    plan.intent = plan.intent.trim();
  }
}

/** Returns a detached plan with every optional resource collection populated. */
export function completeAgentPlan(plan: AgentPlan): Required<AgentPlan> {
  return {
    ...structuredClone(plan),
    expectedApis: [...(plan.expectedApis ?? [])],
    expectedSchemas: [...(plan.expectedSchemas ?? [])],
    expectedConfigKeys: [...(plan.expectedConfigKeys ?? [])],
    expectedTests: [...(plan.expectedTests ?? [])],
    expectedServices: [...(plan.expectedServices ?? [])],
    intent: plan.intent ?? plan.objective,
  };
}

/** Applies an approved scope expansion while preserving normalized resources. */
export function mergePlanScope(
  plan: AgentPlan,
  request: ScopeChangeRequest,
): AgentPlan {
  const revised: AgentPlan = {
    ...structuredClone(plan),
    expectedFiles: uniqueRepositoryPaths([
      ...plan.expectedFiles,
      ...request.additionalFiles,
    ]),
    expectedSymbols: uniqueStrings([
      ...plan.expectedSymbols,
      ...request.additionalSymbols,
    ]),
    expectedApis: uniqueStrings([
      ...(plan.expectedApis ?? []),
      ...request.additionalApis,
    ]),
    expectedSchemas: uniqueStrings([
      ...(plan.expectedSchemas ?? []),
      ...request.additionalSchemas,
    ]),
    expectedConfigKeys: uniqueStrings([
      ...(plan.expectedConfigKeys ?? []),
      ...request.additionalConfigKeys,
    ]),
    expectedTests: uniqueStrings([
      ...(plan.expectedTests ?? []),
      ...request.additionalTests,
    ]),
    expectedServices: uniqueStrings([
      ...(plan.expectedServices ?? []),
      ...request.additionalServices,
    ]),
  };
  assertAgentPlan(revised);
  return revised;
}
