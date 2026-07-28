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

/**
 * How the coordinator answers a plan submitted before any editing.
 *
 * A local task reaches the same four outcomes through the wave scheduler in
 * {@link CoordinatorDecision}; this is the shape a remote worker receives over
 * the wire, where the answer must travel back to a process that has not yet
 * spent a single agent execution token.
 */
export type PlanAdmissionStatus =
  | "approved"
  | "approved_with_constraints"
  | "blocked"
  | "sequenced";

/**
 * A resource a plan declared that its admission withheld while granting the
 * rest of the plan.
 *
 * Ownership has always been per-resource; this is what makes the *decision*
 * per-resource too. A holder that receives one of these may start immediately
 * on everything else it declared, and must leave this resource alone: it is
 * owned by the named tasks, and the control plane refuses any changeset that
 * touches it.
 */
export interface DeferredResource {
  resourceType: ResourceType;
  resourceId: string;
  /** Executing tasks that hold the resource right now. */
  heldBy: TaskId[];
  reason: string;
}

export interface PlanAdmission {
  status: PlanAdmissionStatus;
  taskId: TaskId;
  planRevision: number;
  /** Canonical revision the plan was evaluated against. */
  baseRevision: string;
  ownershipGrants: ResourceLease[];
  constraints: string[];
  blockedBy: TaskId[];
  /** Structural evidence behind a non-approval, empty when approved. */
  conflicts: ConflictAssessment[];
  /**
   * Declared resources this admission withheld. Absent or empty for an
   * all-or-nothing decision; non-empty only on an approval, where it means the
   * holder was admitted on the rest of its plan and these are still contested.
   */
  deferredResources?: DeferredResource[];
  explanation: string;
  /** How long to wait before resubmitting the same plan. Absent when approved. */
  retryAfterMs?: number;
  /**
   * The plan can no longer be admitted at this base. The holder must release
   * its lease and plan again from fresh canonical rather than resubmitting.
   */
  requeue?: boolean;
  decidedAt: string;
}

export function planAdmissionApproved(admission: PlanAdmission): boolean {
  return (
    admission.status === "approved" ||
    admission.status === "approved_with_constraints"
  );
}

/**
 * Whether the holder was admitted on part of its plan rather than all of it.
 *
 * A partial admission is an approval — the holder executes — so it is
 * deliberately not a separate status. What distinguishes it is the withheld
 * set, which the control plane enforces when the result comes back.
 */
export function planAdmissionPartial(admission: PlanAdmission): boolean {
  return (
    planAdmissionApproved(admission) &&
    (admission.deferredResources ?? []).length > 0
  );
}

/** Files a partial admission withheld, in the changeset's path form. */
export function deferredFilePaths(
  admission: PlanAdmission,
): string[] {
  return uniqueRepositoryPaths(
    (admission.deferredResources ?? [])
      .filter((resource) => resource.resourceType === "file")
      .map((resource) => resource.resourceId),
  );
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
  /**
   * The base the changeset was written against, when that is not the revision
   * it was integrated on top of. Present only on a replay, so the history
   * records that a result outlived its own base rather than hiding it behind
   * an ordinary promotion.
   */
  replayedFrom?: string;
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
  | "plan_admitted"
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
  | "ownership_released"
  | "recovery_completed"
  /** A human overlay workspace was created from the dashboard. */
  | "workspace_created"
  /** A sandboxed terminal command ran in an overlay workspace. */
  | "workspace_command_executed";

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

function isValidationCommand(value: unknown): value is ValidationCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<ValidationCommand>).executable === "string" &&
    (value as Partial<ValidationCommand>).executable?.trim().length !== 0 &&
    Array.isArray((value as Partial<ValidationCommand>).args) &&
    (value as Partial<ValidationCommand>).args?.every(
      (argument) => typeof argument === "string",
    ) === true &&
    typeof (value as Partial<ValidationCommand>).label === "string" &&
    (value as Partial<ValidationCommand>).label?.trim().length !== 0
  );
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
    !plan.commands.every(isValidationCommand) ||
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

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isCommandResult(value: unknown): value is CommandResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const result = value as Partial<CommandResult>;
  return (
    isValidationCommand(result.command) &&
    Number.isSafeInteger(result.exitCode) &&
    typeof result.stdout === "string" &&
    typeof result.stderr === "string" &&
    typeof result.startedAt === "string" &&
    !Number.isNaN(Date.parse(result.startedAt)) &&
    isNonNegativeInteger(result.durationMs)
  );
}

function isTestResult(value: unknown): value is TestResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const result = value as Partial<TestResult>;
  return (
    typeof result.name === "string" &&
    result.name.trim().length > 0 &&
    ["passed", "failed", "skipped"].includes(result.status ?? "") &&
    isNonNegativeInteger(result.durationMs) &&
    typeof result.output === "string"
  );
}

/**
 * Validates a changeset received across a trust boundary and normalizes every
 * repository path before it can reach Git or durable storage.
 */
export function assertChangeSet(value: unknown): asserts value is ChangeSet {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Changeset must be an object");
  }

  const changeSet = value as Partial<ChangeSet>;
  if (
    typeof changeSet.id !== "string" ||
    changeSet.id.trim().length === 0 ||
    typeof changeSet.taskId !== "string" ||
    changeSet.taskId.trim().length === 0 ||
    !isNonNegativeInteger(changeSet.baseVersion) ||
    typeof changeSet.baseRevision !== "string" ||
    changeSet.baseRevision.trim().length === 0 ||
    !Array.isArray(changeSet.patches) ||
    !changeSet.patches.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.path === "string" &&
        ["added", "modified", "deleted"].includes(entry.status) &&
        typeof entry.patch === "string",
    ) ||
    !Array.isArray(changeSet.commandsRun) ||
    !changeSet.commandsRun.every(isCommandResult) ||
    !Array.isArray(changeSet.tests) ||
    !changeSet.tests.every(isTestResult) ||
    !isStringArray(changeSet.dependenciesChanged) ||
    !isStringArray(changeSet.symbolsChanged) ||
    typeof changeSet.riskAssessment !== "object" ||
    changeSet.riskAssessment === null ||
    !["low", "medium", "high", "critical"].includes(
      changeSet.riskAssessment.level ?? "",
    ) ||
    !isStringArray(changeSet.riskAssessment.reasons) ||
    typeof changeSet.agentExplanation !== "string" ||
    typeof changeSet.createdAt !== "string" ||
    Number.isNaN(Date.parse(changeSet.createdAt))
  ) {
    throw new TypeError("Changeset does not match the coordination schema");
  }

  changeSet.id = changeSet.id.trim();
  changeSet.taskId = changeSet.taskId.trim();
  changeSet.baseRevision = changeSet.baseRevision.trim();
  changeSet.patches = changeSet.patches.map((entry) => ({
    ...entry,
    path: normalizeRepositoryPath(entry.path),
  }));
  changeSet.dependenciesChanged = uniqueStrings(changeSet.dependenciesChanged);
  changeSet.symbolsChanged = uniqueStrings(changeSet.symbolsChanged);
  changeSet.riskAssessment = {
    ...changeSet.riskAssessment,
    reasons: uniqueStrings(changeSet.riskAssessment.reasons),
  };
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

/**
 * Removes named resources from a plan, leaving everything else intact.
 *
 * The inverse of {@link mergePlanScope}: where that widens a plan after an
 * approved scope change, this narrows one to the subset a partial admission
 * granted. The objective is deliberately untouched — the plan is still for the
 * same task, and every identity check downstream compares objectives.
 *
 * `dependencies` are untouched too: a dependency is something the plan reads,
 * not something it claims, so removing a claim never removes a dependency.
 */
export function reducePlanScope(
  plan: AgentPlan,
  removed: readonly PlanResourceRef[],
): AgentPlan {
  const dropped = new Set(
    removed.map((resource) =>
      planResourceKey(resource.resourceType, resource.resourceId),
    ),
  );
  const keep =
    (type: ResourceType) =>
    (value: string): boolean =>
      !dropped.has(planResourceKey(type, value));
  const revised: AgentPlan = {
    ...structuredClone(plan),
    expectedFiles: plan.expectedFiles.filter(keep("file")),
    expectedSymbols: plan.expectedSymbols.filter(keep("symbol")),
    ...(plan.expectedApis === undefined
      ? {}
      : { expectedApis: plan.expectedApis.filter(keep("api")) }),
    ...(plan.expectedSchemas === undefined
      ? {}
      : { expectedSchemas: plan.expectedSchemas.filter(keep("schema")) }),
    ...(plan.expectedConfigKeys === undefined
      ? {}
      : {
          expectedConfigKeys: plan.expectedConfigKeys.filter(
            keep("configuration"),
          ),
        }),
    ...(plan.expectedTests === undefined
      ? {}
      : { expectedTests: plan.expectedTests.filter(keep("test")) }),
    ...(plan.expectedServices === undefined
      ? {}
      : { expectedServices: plan.expectedServices.filter(keep("service")) }),
  };
  assertAgentPlan(revised);
  return revised;
}

export interface PlanResourceRef {
  resourceType: ResourceType;
  resourceId: string;
}

/** Case-insensitive identity for a planned resource. */
export function planResourceKey(type: ResourceType, id: string): string {
  return `${type}\0${id.trim().toLowerCase()}`;
}

/**
 * Declarative per-project coordination policy.
 *
 * Stored on the project record and evaluated by the coordinator wherever it
 * previously used built-in constants. Every field is optional: an absent
 * field means "use the built-in default", so an empty policy changes
 * nothing and a project with no policy behaves exactly as before.
 */
export interface ProjectApprovalPolicyConfig {
  /** Require a human decision on every changeset, regardless of risk. */
  requireChangesetReview?: boolean;
  /** Risk levels that require human review. Default: high and critical. */
  riskLevels?: RiskLevel[];
  /** Glob patterns whose files require human review when touched. */
  protectedPaths?: string[];
  /** How long an approval waits before expiring, in milliseconds. */
  approvalTimeoutMs?: number;
}

export interface ProjectBudgetPolicyConfig {
  /**
   * Hard cap on one task's remote execution time. Enforced at heartbeat: a
   * lease past this age is failed rather than extended, so a runaway agent
   * cannot burn compute indefinitely.
   */
  maxTaskRuntimeMs?: number;
  /**
   * Rolling 24-hour budget of total remote execution time for the project.
   * Enforced at lease time: an exhausted project stops receiving workers
   * until usage rolls out of the window. Tasks stay queued, not failed.
   */
  maxProjectRuntimeMsPerDay?: number;
}

export interface ProjectPolicy {
  version: 1;
  approvals?: ProjectApprovalPolicyConfig;
  budgets?: ProjectBudgetPolicyConfig;
}

export const RISK_LEVELS: readonly RiskLevel[] = [
  "low",
  "medium",
  "high",
  "critical",
];

const MAX_PROTECTED_PATHS = 200;
const MAX_PROTECTED_PATH_LENGTH = 512;
const MIN_APPROVAL_TIMEOUT_MS = 1_000;
const MAX_APPROVAL_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;

export function assertProjectPolicy(
  value: unknown,
): asserts value is ProjectPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Project policy must be an object");
  }
  const policy = value as Partial<ProjectPolicy>;
  if (policy.version !== 1) {
    throw new TypeError("Project policy version must be 1");
  }
  for (const key of Object.keys(policy)) {
    if (key !== "version" && key !== "approvals" && key !== "budgets") {
      throw new TypeError(`Project policy has an unknown field: ${key}`);
    }
  }
  assertBudgetPolicy(policy.budgets);
  if (policy.approvals === undefined) {
    return;
  }
  const approvals = policy.approvals as Partial<ProjectApprovalPolicyConfig>;
  if (
    typeof approvals !== "object" ||
    approvals === null ||
    Array.isArray(approvals)
  ) {
    throw new TypeError("Project policy approvals must be an object");
  }
  for (const key of Object.keys(approvals)) {
    if (
      key !== "requireChangesetReview" &&
      key !== "riskLevels" &&
      key !== "protectedPaths" &&
      key !== "approvalTimeoutMs"
    ) {
      throw new TypeError(
        `Project approval policy has an unknown field: ${key}`,
      );
    }
  }
  if (
    approvals.requireChangesetReview !== undefined &&
    typeof approvals.requireChangesetReview !== "boolean"
  ) {
    throw new TypeError("requireChangesetReview must be a boolean");
  }
  if (approvals.riskLevels !== undefined) {
    if (
      !Array.isArray(approvals.riskLevels) ||
      !approvals.riskLevels.every((entry) =>
        (RISK_LEVELS as readonly string[]).includes(entry as string),
      )
    ) {
      throw new TypeError(
        `riskLevels must be an array drawn from ${RISK_LEVELS.join(", ")}`,
      );
    }
  }
  if (approvals.protectedPaths !== undefined) {
    if (
      !Array.isArray(approvals.protectedPaths) ||
      approvals.protectedPaths.length > MAX_PROTECTED_PATHS ||
      !approvals.protectedPaths.every(
        (entry) =>
          typeof entry === "string" &&
          entry.trim().length > 0 &&
          entry.length <= MAX_PROTECTED_PATH_LENGTH,
      )
    ) {
      throw new TypeError(
        "protectedPaths must be non-empty glob strings " +
          `(at most ${MAX_PROTECTED_PATHS} of up to ${MAX_PROTECTED_PATH_LENGTH} characters)`,
      );
    }
  }
  if (approvals.approvalTimeoutMs !== undefined) {
    if (
      !Number.isSafeInteger(approvals.approvalTimeoutMs) ||
      approvals.approvalTimeoutMs < MIN_APPROVAL_TIMEOUT_MS ||
      approvals.approvalTimeoutMs > MAX_APPROVAL_TIMEOUT_MS
    ) {
      throw new TypeError(
        "approvalTimeoutMs must be an integer between one second and thirty days",
      );
    }
  }
}

const MAX_BUDGET_MS = 30 * 24 * 60 * 60 * 1000;

function assertBudgetPolicy(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Project policy budgets must be an object");
  }
  const budgets = value as Partial<ProjectBudgetPolicyConfig>;
  for (const key of Object.keys(budgets)) {
    if (key !== "maxTaskRuntimeMs" && key !== "maxProjectRuntimeMsPerDay") {
      throw new TypeError(`Project budget policy has an unknown field: ${key}`);
    }
  }
  for (const key of ["maxTaskRuntimeMs", "maxProjectRuntimeMsPerDay"] as const) {
    const limit = budgets[key];
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BUDGET_MS)
    ) {
      throw new TypeError(
        `${key} must be an integer between 1 ms and thirty days`,
      );
    }
  }
}

/**
 * Reads the budget block out of a stored project policy.
 *
 * Missing policy means no budgets. A corrupt policy throws for the same
 * reason approval interpretation does: a configured spending limit must
 * never be silently ignored because the record failed to parse.
 */
export function projectBudgets(
  policy: Record<string, unknown> | undefined,
): ProjectBudgetPolicyConfig {
  if (policy === undefined) {
    return {};
  }
  assertProjectPolicy(policy);
  return policy.budgets ?? {};
}
