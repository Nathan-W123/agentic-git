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
  /**
   * What this request was asked inside — today, the channel thread it was
   * dispatched from.
   *
   * Separate from `objective` because the objective is what somebody asked
   * for and is rendered wherever the request is shown; a transcript folded
   * into it would make every request unreadable in those places. The
   * coordinator merges this with the handoff seed into the planning prompt's
   * prior context.
   */
  context?: string;
}

export type PlanGroundingConfidence = "verified" | "grounded" | "ungrounded";

/** A declared file that does not exist, mapped to the real file it names. */
export interface GroundedFileReference {
  declared: string;
  resolved: string;
}

/** A declared symbol the repository cannot locate, mapped to its likely real
 * counterpart, plus the files where that counterpart is declared. */
export interface GroundedSymbolReference {
  declared: string;
  resolved: string;
  files: string[];
}

/**
 * How a plan's declarations compare against the repository they were written
 * for, established by the coordinator from the base-revision index — never
 * taken from the agent, which is the whole point: an agent that misnames the
 * code it is about to edit would misname it here too.
 *
 * `verified` means every declared file exists and every declared symbol
 * resolves. `grounded` means some declarations do not resolve but at least one
 * anchors the plan to real code, whether directly or through a referent.
 * `ungrounded` means nothing the plan names can be connected to the
 * repository at all — arbitration has literally no true statement to work
 * from.
 *
 * Referents feed conflict arbitration only. They never widen the write scope:
 * enforcement still holds the agent to the files it declared.
 */
export interface PlanGrounding {
  confidence: PlanGroundingConfidence;
  /** Revision of the index the grounding was computed against. */
  revision: string;
  /** Declared files that do not exist at that revision. */
  missingFiles: string[];
  /** Declared symbols the index cannot locate anywhere. */
  unresolvedSymbols: string[];
  fileReferents: GroundedFileReference[];
  symbolReferents: GroundedSymbolReference[];
  /** Human-readable account of every correction, for audit trails. */
  notes: string[];
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
  /**
   * Verification of these declarations against the real repository. Written
   * by the coordinator after plan submission; anything an agent sends here is
   * recomputed and overwritten before the plan is used for arbitration.
   */
  grounding?: PlanGrounding;
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

/**
 * A span of lines in one file, measured at the revision it was taken from.
 *
 * Both ends are 1-based and inclusive. This is the only coordinate a diff and
 * a repository index have in common, which is what makes it the unit an
 * ownership claim can be both *stated* and *checked* in.
 */
export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface ResourceLease {
  leaseId: LeaseId;
  resourceType: ResourceType;
  resourceId: string;
  principalId: AgentId;
  taskId: TaskId;
  mode: OwnershipMode;
  baseVersion: number;
  expiresAt: string;
  /**
   * The lines of the resource this lease covers, when the claim behind it is
   * narrower than the whole resource.
   *
   * Absent means all of it, which is what every lease meant before line-range
   * leases existed and what every lease still means for a file a plan named
   * outright. It is present for a file a plan reaches only through code the
   * index could place — there the plan's claim really is a set of spans, and
   * two such claims that do not intersect are not a contest at all.
   */
  ranges?: LineRange[];
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
    | "intent_conflict"
    | "intent_independent";
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
 * Where a withheld resource lives, at the base revision the plan was written
 * against.
 *
 * Line numbers are the only coordinate a diff and a repository index have in
 * common, which is what makes this the unit a withholding can be *checked* in
 * rather than merely stated. Both ends are 1-based and inclusive.
 */
export interface DeferredResourceLocation extends LineRange {
  file: string;
}

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
  /**
   * Where this resource sits inside files the plan *was* granted, when the
   * index could locate it.
   *
   * Present only for a resource finer than a file. It is what turns "leave
   * `orderTotal` alone" into a claim about lines, so the enforcement pass can
   * promote the hunks of a granted file that stay clear of it instead of
   * losing the whole file to one trespassing hunk. Absent means the withheld
   * resource could not be located, and the coarse answer stands.
   */
  locations?: DeferredResourceLocation[];
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
  /**
   * What moved underneath the plan, when {@link requeue} says it did.
   *
   * Present so a holder can *amend* its plan rather than write a new one. The
   * control plane already computes this to decide whether a finished result
   * can be replayed; handing the same notice to a plan that has not executed
   * yet is what lets the next attempt be an edit instead of a cold start.
   * Measured on `team-queue-wired`, amending costs 57% fewer tokens and 49%
   * less wall clock than planning the same task again from nothing.
   *
   * It describes exactly one transition — `previousVersion` to
   * `canonicalVersion` — and is only usable by a holder whose plan was
   * written against `previousVersion`, arriving at a lease based on
   * `canonicalVersion`. Any other pairing must plan cold, because a notice
   * that does not span the whole gap would understate what changed.
   */
  canonicalChange?: CanonicalChangeNotice;
  /**
   * A human is being asked about this plan before it may execute.
   *
   * A holder that sees this waits far longer than an ordinary deferral: what
   * it is waiting for is a person, not a lease. It keeps heartbeating, so the
   * lease survives the wait, and resubmits until the decision lands.
   */
  awaitingApproval?: boolean;
  /** The durable approval request behind {@link awaitingApproval}. */
  approvalId?: string;
  /**
   * Run this admission is recorded against, present once anything durable has
   * been written for the task — today, an approval request, which needs a run
   * to belong to. The result path reuses it rather than opening a second run
   * for the same work.
   */
  runId?: string;
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

/**
 * The record one task leaves for whoever picks up its unfinished business.
 *
 * The point of it is that it is *not* a summary of a conversation. A summary
 * is unverifiable — it says what someone remembers, at whatever altitude they
 * chose. Every field here is projected from evidence the control plane already
 * holds durably: what integrated, which commands passed, which resources were
 * withheld and by whom, what the coordinator decided and why. A reader can
 * check any line of it against the run record, and a fresh session can be
 * seeded with it instead of replaying raw history it has no way to audit.
 */
export type HandoffReason =
  | "completed"
  | "partially_completed"
  | "blocked"
  | "requeued"
  | "failed"
  | "long_running";

/** Something that happened, and where to verify it. */
export interface HandoffEvidence {
  kind:
    | "canonical_promotion"
    | "validation"
    | "changeset"
    | "integration"
    | "ownership"
    | "follow_up_task";
  /** A revision, changeset id, command label, or task id — never prose. */
  reference: string;
  detail: string;
}

/** A choice the run made, and the reason it made it. */
export interface HandoffDecision {
  decision: string;
  rationale: string;
  /** Where the decision is recorded, when it came from the control plane. */
  reference?: string;
}

/** Work this task did not finish, and what is in the way. */
export interface HandoffOpenItem {
  item: string;
  /** Task ids or resources holding it up. Empty when simply unstarted. */
  blockedBy: string[];
  reason: string;
}

export interface TaskHandoff {
  version: 1;
  taskId: TaskId;
  runId?: string;
  repositoryId: string;
  projectId?: ProjectId;
  reason: HandoffReason;
  objective: string;
  /** Where canonical stood when this was written. */
  canonicalRevision: string;
  /** What was done, each line answerable from the run record. */
  completed: HandoffEvidence[];
  /** What was not. */
  open: HandoffOpenItem[];
  decisions: HandoffDecision[];
  /** Specific traps found the hard way, not general advice. */
  gotchas: string[];
  /** Concrete enough to start on without reading anything else. */
  nextSteps: string[];
  createdAt: string;
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
  /**
   * Not now. Another task holds what was asked for, and will not hold it
   * forever — so unlike a rejection this is worth asking about again once
   * `retryAfterMs` has passed. The agent continues within its current scope
   * meanwhile rather than stopping.
   */
  | "deferred"
  | "rejected";

export interface ScopeChangeDecision {
  requestId: ScopeChangeId;
  taskId: TaskId;
  decision: ScopeChangeDecisionKind;
  revisedPlan: AgentPlan;
  constraints: string[];
  ownershipGrants: ResourceLease[];
  explanation: string;
  /** Tasks holding the requested resources, on a deferral or a refusal. */
  blockedBy?: TaskId[];
  /** How long to wait before asking again. Present only on a deferral. */
  retryAfterMs?: number;
  decidedAt: string;
}

/**
 * Whether a scope decision actually widened what the agent may write.
 *
 * The distinction that matters everywhere downstream is granted versus not,
 * not which flavour of "not". Deferral and refusal both leave the previously
 * approved plan in force, and reading this rather than comparing against
 * `"rejected"` is what keeps a new outcome from silently being treated as a
 * grant.
 */
export function scopeChangeGranted(decision: ScopeChangeDecision): boolean {
  return (
    decision.decision === "approved" ||
    decision.decision === "approved_with_constraints"
  );
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
  /**
   * Work that conflicted and was held back so the rest could land.
   *
   * Present only when the caller asked for salvage. A conflict used to
   * discard the whole changeset — every clean hunk with it — and buy a replan
   * to rediscover work that had already been done. These are the patches that
   * genuinely collided; the caller must requeue them, which is why salvage is
   * something a caller opts into rather than something integration does on
   * its own.
   */
  salvagedDeferred?: FilePatch[];
  /** Files that landed in part, having been split at the conflicting hunks. */
  salvagedDividedFiles?: string[];
  explanation: string;
}

/**
 * Whether a task was asked to look at the repository rather than change it.
 *
 * Read-only work is real work — an audit, a summary, an explanation succeeds
 * precisely by changing nothing — but every layer here measures success in
 * patches, so an empty result is indistinguishable from an edit that silently
 * failed. This tells them apart, and it reads the *request*, because what was
 * asked for is the only thing that says whether an empty changeset is the
 * answer or the absence of one.
 *
 * Lives here because both ends need the same answer: the adapters, which
 * refuse to hand back an empty changeset, and the integration path, which
 * decides what an empty one means. Two copies would drift, and the drift would
 * show up as a task that one layer calls a success and the other calls a
 * failure.
 *
 * An editing verb settles it first, whatever else the sentence does. "Can you
 * fix the retry loop?" is a question and a change request, and letting the
 * question mark excuse an empty result is exactly how a sandbox refusing every
 * write would pass for success.
 */
export function readsAsReportRequest(objective: string): boolean {
  if (
    /\b(fix|add|change|edit|write|create|remove|delete|rename|update|implement|refactor|patch|revert|bump|replace|move|migrate|upgrade|install|wire|hook)\b/iu.test(
      objective,
    )
  ) {
    return false;
  }
  return (
    /\b(audit|audits|audited|auditing|summar(?:y|ise|ize|ised|ized|ising|izing|ies)|analy[sz]e|analy[sz]es|analy[sz]ed|analy[sz]ing|analysis|inspect|inspects|inspected|inspecting|assess|assesses|assessed|assessing|examine|examines|examined|examining|diagnose|diagnoses|diagnosed|diagnosing|explain|explains|explained|explaining)\b/iu.test(
      objective,
    ) ||
    /\?\s*$/u.test(objective.trim()) ||
    /^\s*(?:what|which|where|when|why|how|who|is|are|does|do|did|can|could|should|would)\b/iu.test(
      objective,
    )
  );
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
  | "repository_created"
  | "repository_imported"
  | "task_submitted"
  /**
   * One submitted objective was queued as several narrower tasks. Written at
   * intake, before any run exists, so it is the only record connecting the
   * siblings to the objective they came from and to the reason they were
   * separated.
   */
  | "task_decomposed"
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
  /** Patches a partial admission held back, kept for the follow-up task. */
  | "changeset_withheld"
  /** A structured handoff written at a task boundary for the next session. */
  | "handoff_recorded"
  | "approval_requested"
  | "approval_decided"
  | "validation_completed"
  /**
   * A task that was asked to look rather than to change, finishing with a
   * report and no patches.
   *
   * Distinct from `canonical_promoted` because nothing was promoted, and
   * distinct from `task_failed` because nothing went wrong. Without it, an
   * audit or a summary — work that succeeds precisely by changing nothing —
   * came back as "complete but changed no files", which the pipeline recorded
   * as a failure and the channel reported as one.
   */
  | "task_reported"
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
  | "workspace_command_executed"
  /**
   * Someone joined a live editing session on another user's overlay. Recorded
   * because it is the one way a user's unsubmitted work becomes visible to
   * anybody else.
   */
  | "workspace_collaboration_joined"
  /** A live editing session flushed a shared document into the overlay. */
  | "workspace_collaboration_saved"
  /** A message was posted to a repository's shared group channel. */
  | "channel_message_posted"
  /** A threaded reply was posted under a channel message. */
  | "channel_message_replied"
  /** A reaction on a channel message was added or removed. */
  | "channel_reaction_toggled"
  /** An agent's per-channel display name, role, or model/effort setting changed. */
  | "channel_agent_overridden"
  /** A (user, provider) agent was added to or removed from a channel's opt-in roster. */
  | "channel_agent_membership_changed"
  /**
   * A thread removed, or a channel cleared. Recorded because the messages
   * themselves are gone afterwards — this is the only remaining trace that
   * an account of somebody's work once existed and who removed it.
   */
  | "channel_message_deleted"
  /**
   * A repository (and its cascaded channel state and grants) was removed.
   * Runs and submitted tasks are never cascaded — see `removeRepository`'s
   * doc comment in `@coord/persistence` — so this event marks the one
   * irreversible removal of a repository's own state.
   */
  | "repository_deleted";

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
  /**
   * Tokens the agents reported spending, when they report it at all.
   *
   * Absent rather than zero when no driver reported a figure — a scripted
   * fixture costs nothing to run, and "0" there would read as a measurement
   * instead of as silence. Only ever a sum of what an agent actually printed.
   */
  tokensTotal?: number;
  /** The same figure split by task, so a costly outlier is visible. */
  tokensByTask?: Record<string, number>;
  /** Same figures grouped by adapter phase: planning, replanning, execution. */
  tokensByPhase?: Record<string, number>;
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

function isGroundedFileReference(
  value: unknown,
): value is GroundedFileReference {
  const entry = value as Partial<GroundedFileReference>;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof entry.declared === "string" &&
    typeof entry.resolved === "string"
  );
}

function isGroundedSymbolReference(
  value: unknown,
): value is GroundedSymbolReference {
  const entry = value as Partial<GroundedSymbolReference>;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof entry.declared === "string" &&
    typeof entry.resolved === "string" &&
    isStringArray(entry.files)
  );
}

function isPlanGrounding(value: unknown): value is PlanGrounding {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const grounding = value as Partial<PlanGrounding>;
  return (
    ["verified", "grounded", "ungrounded"].includes(
      grounding.confidence ?? "",
    ) &&
    typeof grounding.revision === "string" &&
    isStringArray(grounding.missingFiles) &&
    isStringArray(grounding.unresolvedSymbols) &&
    Array.isArray(grounding.fileReferents) &&
    grounding.fileReferents.every(isGroundedFileReference) &&
    Array.isArray(grounding.symbolReferents) &&
    grounding.symbolReferents.every(isGroundedSymbolReference) &&
    isStringArray(grounding.notes)
  );
}

/**
 * The verification state arbitration should assume for a plan.
 *
 * A plan without a grounding record is treated as verified: every plan that
 * existed before verification was introduced, and every scripted fixture,
 * behaves exactly as it did.
 */
export function planGroundingConfidence(
  plan: AgentPlan,
): PlanGroundingConfidence {
  return plan.grounding?.confidence ?? "verified";
}

/**
 * The files arbitration must treat a plan as touching: the declared set plus
 * every real file its unverifiable declarations were grounded to. Two plans
 * that misname the same real file in different ways overlap here even though
 * their declared sets are disjoint.
 */
export function arbitrationFiles(plan: AgentPlan): string[] {
  const grounding = plan.grounding;
  if (grounding === undefined) {
    return plan.expectedFiles;
  }
  return uniqueRepositoryPaths([
    ...plan.expectedFiles,
    ...grounding.fileReferents.map((entry) => entry.resolved),
    ...grounding.symbolReferents.flatMap((entry) => entry.files),
  ]);
}

/** One declaration verification could map to real code, and what it maps to. */
export interface GroundedSubstitution {
  kind: "file" | "symbol";
  declared: string;
  /** Real names the index says the declaration meant, best first. */
  resolved: string[];
  /** Files the real symbols are declared in. Empty for a file substitution. */
  files: string[];
}

export interface GroundedPlanView {
  /** The plan with every resolvable misname replaced by the real name. */
  plan: AgentPlan;
  substitutions: GroundedSubstitution[];
  /** Declarations nothing in the repository matches, so plausibly new. */
  inventedFiles: string[];
  inventedSymbols: string[];
}

/**
 * A plan rewritten to say what verification decided it meant.
 *
 * Grounding already computes this mapping, and until now it was used in two
 * places: arbitration, which scores a plan on its referents, and correction,
 * which fixes a plan after the agent has produced it. What it was never used
 * for is the thing the agent actually reads. A replan prompt that hands back
 * the previous plan verbatim hands back `src/checkout.js` — the invented name,
 * in the most authoritative position in the prompt — and then appends a note
 * saying it does not exist. This substitutes first and reports second.
 *
 * The grounding record itself is dropped from the returned plan. It is the
 * coordinator's verdict about declarations that no longer appear, and its
 * `missingFiles` list is a verbatim copy of exactly the names not to repeat.
 *
 * Declarations that ground to nothing are left alone and reported separately:
 * a plan for a new module names files that do not exist yet, and that is not
 * an error to correct.
 */
export function substituteGroundedNames(plan: AgentPlan): GroundedPlanView {
  const grounding = plan.grounding;
  if (grounding === undefined) {
    return {
      plan,
      substitutions: [],
      inventedFiles: [],
      inventedSymbols: [],
    };
  }
  const substitutions: GroundedSubstitution[] = [];
  const fileFor = new Map<string, string[]>();
  for (const entry of grounding.fileReferents) {
    fileFor.set(entry.declared, [
      ...(fileFor.get(entry.declared) ?? []),
      entry.resolved,
    ]);
  }
  const symbolFor = new Map<string, { resolved: string[]; files: string[] }>();
  for (const entry of grounding.symbolReferents) {
    const existing = symbolFor.get(entry.declared) ?? { resolved: [], files: [] };
    symbolFor.set(entry.declared, {
      resolved: [...existing.resolved, entry.resolved],
      files: [...existing.files, ...entry.files],
    });
  }

  for (const [declared, resolved] of fileFor) {
    substitutions.push({ kind: "file", declared, resolved, files: [] });
  }
  for (const [declared, entry] of symbolFor) {
    substitutions.push({
      kind: "symbol",
      declared,
      resolved: entry.resolved,
      files: uniqueRepositoryPaths(entry.files),
    });
  }
  substitutions.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.declared.localeCompare(right.declared),
  );

  const { grounding: dropped, ...bare } = structuredClone(plan);
  void dropped;
  return {
    plan: {
      ...bare,
      expectedFiles: uniqueRepositoryPaths(
        plan.expectedFiles.flatMap((file) => fileFor.get(file) ?? [file]),
      ),
      expectedSymbols: uniqueStrings(
        plan.expectedSymbols.flatMap(
          (symbol) => symbolFor.get(symbol)?.resolved ?? [symbol],
        ),
      ),
    },
    substitutions,
    inventedFiles: grounding.missingFiles.filter(
      (file) => !fileFor.has(file),
    ),
    inventedSymbols: grounding.unresolvedSymbols.filter(
      (symbol) => !symbolFor.has(symbol),
    ),
  };
}

/** The symbols arbitration must treat a plan as claiming; see {@link arbitrationFiles}. */
export function arbitrationSymbols(plan: AgentPlan): string[] {
  const grounding = plan.grounding;
  if (grounding === undefined) {
    return plan.expectedSymbols;
  }
  return uniqueStrings([
    ...plan.expectedSymbols,
    ...grounding.symbolReferents.map((entry) => entry.resolved),
  ]);
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
      (typeof plan.intent !== "string" || plan.intent.trim().length === 0)) ||
    (plan.grounding !== undefined && !isPlanGrounding(plan.grounding))
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

/**
 * A plan with every optional resource collection populated. Grounding stays
 * optional: it is a verification verdict, not a resource collection, and
 * there is no honest default for a plan that was never verified.
 */
export type CompleteAgentPlan = Required<Omit<AgentPlan, "grounding">> &
  Pick<AgentPlan, "grounding">;

/** Returns a detached plan with every optional resource collection populated. */
export function completeAgentPlan(plan: AgentPlan): CompleteAgentPlan {
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
    // A withheld declaration takes its grounding with it: the referent only
    // ever stood in for that declaration, and keeping it would leave the
    // reduced plan claiming code it no longer names.
    ...(plan.grounding === undefined
      ? {}
      : {
          grounding: {
            ...structuredClone(plan.grounding),
            missingFiles: plan.grounding.missingFiles.filter(keep("file")),
            unresolvedSymbols: plan.grounding.unresolvedSymbols.filter(
              keep("symbol"),
            ),
            fileReferents: plan.grounding.fileReferents.filter((entry) =>
              keep("file")(entry.declared),
            ),
            symbolReferents: plan.grounding.symbolReferents.filter((entry) =>
              keep("symbol")(entry.declared),
            ),
          },
        }),
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
  /**
   * Disables durable human approval pauses for this project when false.
   * Isolation, ownership, validation, audit, and atomic promotion still apply.
   * Default: true.
   */
  enabled?: boolean;
  /** Require a human decision when a plan claims schema resources. Default: true. */
  requireSchemaReview?: boolean;
  /** Require a human decision on every changeset, regardless of risk. */
  requireChangesetReview?: boolean;
  /**
   * Move the gate for remote work forward to plan admission.
   *
   * The local coordinator has always paused a risky *plan* before handing an
   * agent a workspace; remotely the only gate was at the changeset, by which
   * point the agent has already run. With this on, a remote plan whose
   * reasons would have stopped it locally — its risk level, a schema claim, a
   * protected path — waits for a reviewer before the worker executes it.
   *
   * Off by default, because it costs a second blocking gate per task and a
   * worker holding a repository slot while a person is asked. Default: false.
   */
  requireRemotePlanReview?: boolean;
  /**
   * Whether rolling canonical back asks a human. Defaults to true and is not
   * governed by `enabled`: it guards a destructive operator action rather than
   * work arriving through the pipeline.
   */
  requireRollbackReview?: boolean;
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
  /**
   * Hard cap on the model tokens one task may spend.
   *
   * Enforced at heartbeat alongside the runtime cap, against the running
   * total the worker reports as it goes: a task past the cap is failed rather
   * than extended. Runtime and tokens answer different questions — a task can
   * be quick and expensive, or slow and cheap — so neither substitutes for
   * the other. Only spend an agent actually reports is counted; an agent that
   * reports nothing cannot be capped this way.
   */
  maxTaskTokens?: number;
  /**
   * Rolling 24-hour cap on the project's total reported token spend.
   * Enforced at lease time exactly as the runtime budget is: an exhausted
   * project stops receiving workers until usage rolls out of the window, and
   * tasks stay queued rather than failing.
   */
  maxProjectTokensPerDay?: number;
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
      key !== "enabled" &&
      key !== "requireSchemaReview" &&
      key !== "requireChangesetReview" &&
      key !== "requireRemotePlanReview" &&
      key !== "requireRollbackReview" &&
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
    approvals.enabled !== undefined &&
    typeof approvals.enabled !== "boolean"
  ) {
    throw new TypeError("enabled must be a boolean");
  }
  if (
    approvals.requireSchemaReview !== undefined &&
    typeof approvals.requireSchemaReview !== "boolean"
  ) {
    throw new TypeError("requireSchemaReview must be a boolean");
  }
  if (
    approvals.requireChangesetReview !== undefined &&
    typeof approvals.requireChangesetReview !== "boolean"
  ) {
    throw new TypeError("requireChangesetReview must be a boolean");
  }
  if (
    approvals.requireRemotePlanReview !== undefined &&
    typeof approvals.requireRemotePlanReview !== "boolean"
  ) {
    throw new TypeError("requireRemotePlanReview must be a boolean");
  }
  if (
    approvals.requireRollbackReview !== undefined &&
    typeof approvals.requireRollbackReview !== "boolean"
  ) {
    throw new TypeError("requireRollbackReview must be a boolean");
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
/** A trillion tokens: far above any real cap, low enough to catch a typo. */
const MAX_BUDGET_TOKENS = 1_000_000_000_000;

function assertBudgetPolicy(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Project policy budgets must be an object");
  }
  const budgets = value as Partial<ProjectBudgetPolicyConfig>;
  const known = [
    "maxTaskRuntimeMs",
    "maxProjectRuntimeMsPerDay",
    "maxTaskTokens",
    "maxProjectTokensPerDay",
  ];
  for (const key of Object.keys(budgets)) {
    if (!known.includes(key)) {
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
  for (const key of ["maxTaskTokens", "maxProjectTokensPerDay"] as const) {
    const limit = budgets[key];
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BUDGET_TOKENS)
    ) {
      throw new TypeError(
        `${key} must be an integer between 1 and ${MAX_BUDGET_TOKENS} tokens`,
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
