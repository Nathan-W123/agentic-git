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
  /**
   * The symbols the agent itself named, before enrichment widened the set.
   *
   * `enrichPlan` adds every symbol of every declared file to
   * {@link expectedSymbols}, which is right for the things it exists for —
   * comparing plans, spotting semantic overlap — and wrong for deciding what
   * one task withholds from another inside a file they share. Withheld
   * against the enriched set, a holder claims every function in the file, so
   * a second agent that wants one of them is admitted to the file with every
   * function in it withheld: it can edit the imports and the gaps between
   * declarations, produce a changeset whose every hunk is then deferred, and
   * land nothing after paying for a full run.
   *
   * So the agent's own declaration is kept alongside the widened one, and the
   * symbol-level withholding reads this. Absent means the plan was never
   * enriched and {@link expectedSymbols} is already the agent's own words;
   * empty means the agent named no symbols at all, which withholds the whole
   * file exactly as it did before.
   */
  declaredSymbols?: string[];
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
  /**
   * How this plan's scope was arrived at, when it was not an agent writing
   * down what it intended to touch.
   *
   * Absent on every plan an agent submitted, which is what keeps the ordinary
   * path exactly as it was. See {@link PlanClaim} for the two shapes a
   * coordinator-issued claim takes.
   */
  claim?: PlanClaim;
}

/**
 * The whole repository, claimed without anybody describing it.
 *
 * Granted to a task that is alone in its repository, in place of the planning
 * round trip whose only purpose was to give a second task something to
 * arbitrate against. Nothing can conflict with it, because nothing else can
 * be admitted while it is held.
 */
export interface BlanketPlanClaim {
  kind: "blanket";
  grantedAt: string;
}

/**
 * What a blanket claim was narrowed to when somebody else arrived, read from
 * the holder's worktree rather than predicted.
 *
 * `directories` is the unit deliberately: a task frozen halfway through a
 * sweep has touched a few files of a directory it is still working through,
 * and freezing it to exactly those files would refuse it the next file in the
 * same directory a second later. Directories keep a wide refactor moving; the
 * cost is that the arriving task is admitted to a little less than it could
 * strictly have had.
 */
export interface FrozenPlanClaim {
  kind: "frozen";
  /** Repository-relative directory prefixes, each ending in `/`. */
  directories: string[];
  frozenAt: string;
}

export type PlanClaim = BlanketPlanClaim | FrozenPlanClaim;

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

/**
 * One uncommitted edit from a holder a waiting task is planning against.
 *
 * Speculative only: the holder still owns the file. `absolutePath` is where
 * the holder's worktree has the bytes, so a planning workspace can overlay
 * them onto canonical; absent when the holder deleted the file.
 */
export interface HolderWorkingChange {
  path: string;
  status: "added" | "modified" | "deleted";
  absolutePath?: string;
}

export interface ReplanRequest {
  taskId: TaskId;
  previousPlan: AgentPlan;
  canonicalChange: CanonicalChangeNotice;
  constraints: string[];
  /**
   * In-progress edits from holders this task is deferred behind.
   *
   * Present only for speculative replans during a deferred wait: plan against
   * canonical plus these overlays. Not an admission — leases stay with the
   * holders. When they land, {@link CanonicalChangeNotice} amend covers any
   * residual mismatch; when speculation is invalid on wake, fall back to a
   * cold replan.
   */
  holderWorkingChanges?: HolderWorkingChange[];
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

/**
 * Resources an agent is handing back mid-run, before the task settles.
 *
 * The narrowing counterpart of {@link ScopeChangeRequest}. Deliberately the
 * same shape in reverse — an id, a set of resources, a reason — because the
 * two are decided by the same machinery and answered with the same
 * {@link ScopeChangeDecision}.
 */
export interface ScopeReleaseRequest {
  id: ScopeChangeId;
  taskId: TaskId;
  releasedFiles: string[];
  releasedSymbols: string[];
  releasedApis: string[];
  releasedSchemas: string[];
  releasedConfigKeys: string[];
  releasedTests: string[];
  releasedServices: string[];
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

/**
 * One changed file as a thread reports it: what happened to it, and how much.
 *
 * The counts are the whole reason this exists as a shared shape. Four separate
 * places emit `changeset_collected`, every one of them holding the patches;
 * one of them counted the lines and the other three did not, so whether a
 * thread showed "+12 −3" or bare paths depended on which code path had run the
 * task. That is not a difference a reader can see the cause of.
 */
export interface ChangedFileSummary {
  path: string;
  status: FilePatchStatus;
  added: number;
  removed: number;
}

/**
 * The changed-file summary for a set of patches, counted from the patches.
 *
 * Counted from the diff itself rather than carried alongside it: the patch is
 * the only place the number exists, and a count computed anywhere else could
 * disagree with the text it claims to describe. `+++`/`---` are the file
 * headers rather than content, so they are not lines that changed.
 */
export function summariseChangedFiles(
  patches: readonly FilePatch[],
): ChangedFileSummary[] {
  return patches.map((patch) => {
    const lines = String(patch.patch ?? "").split("\n");
    return {
      path: patch.path,
      status: patch.status,
      added: lines.filter(
        (line) => line.startsWith("+") && !line.startsWith("+++"),
      ).length,
      removed: lines.filter(
        (line) => line.startsWith("-") && !line.startsWith("---"),
      ).length,
    };
  });
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
 * The preamble a channel dispatch puts in front of an objective to say what
 * the agent's role in that repository is.
 *
 * Lives here rather than only at the gateway that writes it, because
 * {@link readsAsReportRequest} has to take it back off again — see there.
 * Two spellings of one prefix would mean the reader silently stopped
 * recognising what the writer emits.
 */
export const ROLE_CONTEXT_PREFIX = "Your role in this repository:";

/**
 * How a failure line introduces the agent's own words.
 *
 * An empty run that still wrote an account has that account appended to the
 * alarm rather than replacing it (see the coordinator's empty-changeset
 * branch), and the narration that turns the failure into a channel line has to
 * find the seam again: the alarm is boilerplate worth clipping and the account
 * is the deliverable, which must not be cut mid-word. Written in one place so
 * the reader cannot silently stop recognising what the writer emits.
 */
export const AGENT_ACCOUNT_PREFIX = "The agent's own account:";

/**
 * An objective with any role preamble removed — what was actually asked for.
 */
export function withoutRoleContext(objective: string): string {
  const trimmed = objective.trimStart();
  if (!trimmed.startsWith(ROLE_CONTEXT_PREFIX)) {
    return objective;
  }
  // The preamble is one line; the request is *everything* after the blank
  // line that follows it, not merely the next paragraph. Splitting on the
  // separator with a limit would drop every paragraph after the first, and a
  // request whose second paragraph said "and fix what you find" would then be
  // judged only on its first — passing an empty changeset off as a report
  // when it is the symptom of a sandbox refusing every write.
  const separator = /\n[^\S\n]*\n/u.exec(trimmed);
  if (separator === null) {
    return objective;
  }
  const request = trimmed.slice(separator.index + separator[0].length);
  // A preamble with nothing behind it is left alone rather than reduced to
  // nothing, so the caller still has something to read.
  return request.trim() === "" ? objective : request;
}

/**
 * Asking for the answer and nothing else, in the words people use for it.
 *
 * Read before the editing-verb veto, because a question is often *about*
 * editing and the veto cannot tell the subject of a question from a request
 * to act on it.
 */
const ANSWER_ONLY_RE =
  /\b(?:just|only|simply)\s+(?:answer|tell|explain|say)\b|\banswer\s+(?:this|the|my|that)\s+question\b/iu;

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
 * write would pass for success. The one thing that outranks it is
 * {@link ANSWER_ONLY_RE}: a request that says outright it wants an answer and
 * nothing else has named its deliverable, and the editing verbs left in the
 * sentence belong to whatever it is asking *about*.
 *
 * Read against the request alone, with any role preamble stripped first. A
 * channel dispatch prepends "Your role in this repository: …" to every
 * objective it submits, and that sentence is the operator describing the
 * agent, not anybody asking for work — so an agent whose declared role
 * happened to contain a word like "fixer" or "implementation" failed the
 * editing-verb check on every task it was ever given, and every audit it ran
 * came back as a failure. The veto has to read what was asked, not who was
 * asked.
 */
export function readsAsReportRequest(objective: string): boolean {
  const request = withoutRoleContext(objective);
  // A forbidden edit is not a requested one. "Don't change anything" is the
  // plainest way anybody has of saying a task is read-only, and it names an
  // editing verb to say so — so the veto below read it as a change request and
  // failed the task for changing nothing, which is the exact outcome that
  // sentence was asking for. Negated clauses come out before the veto looks.
  const asked = request.replace(
    /\b(?:do\s+not|don'?t|never|without|avoid|no\s+need\s+to)\s+(?:\w+\s+){0,2}?(?:fix|add|change|edit|write|create|remove|delete|rename|update|implement|refactor|patch|modify|touch|alter)\w*/giu,
    " ",
  );
  // Asking for the answer and nothing else, said outright. The veto below reads
  // an editing verb anywhere in the sentence, and a question is often *about*
  // editing: "does adding a photo add it to the codebase? just answer this
  // question" names `add` twice and asks for neither. That question was judged
  // a change request, ran, changed nothing, and came back as a failure with the
  // answer buried in the failure line. An explicit answer-only instruction is
  // the plainest statement anybody makes that the deliverable is words, so it
  // settles the reading before the veto looks.
  if (ANSWER_ONLY_RE.test(asked)) {
    return true;
  }
  if (
    /\b(fix|add|change|edit|write|create|remove|delete|rename|update|implement|refactor|patch|revert|bump|replace|move|migrate|upgrade|install|wire|hook)\b/iu.test(
      asked,
    )
  ) {
    return false;
  }
  return (
    // `look`, `describe`, `review`, `report`, `investigate` and `list` are
    // how people actually ask for a report. The list began with the formal
    // words — audit, analyse, diagnose — and missed the ordinary ones, so
    // "look at this repository and describe what it is" was not recognised as
    // a request to look at all.
    //
    // `name`, `show`, `tell`, `enumerate`, `identify`, `print`, `display` and
    // `count` are the same lesson a second time. "List all files in this repo"
    // was a report and "name all files in this repo" was a failed task, which
    // is not a distinction anybody typing either sentence intended to draw.
    //
    // Verbs that could as easily introduce a change stay out — "find a way to
    // make this faster" asks for work and names nothing this could veto on, so
    // reading it as a report would record an empty changeset as success and
    // hide exactly the failure the empty-changeset check exists to catch.
    /\b(audit|audits|audited|auditing|summar(?:y|ise|ize|ised|ized|ising|izing|ies)|analy[sz]e|analy[sz]es|analy[sz]ed|analy[sz]ing|analysis|inspect|inspects|inspected|inspecting|assess|assesses|assessed|assessing|examine|examines|examined|examining|diagnose|diagnoses|diagnosed|diagnosing|explain|explains|explained|explaining|describe|describes|described|describing|review|reviews|reviewed|reviewing|report|reports|reported|reporting|investigate|investigates|investigated|investigating|list|lists|listed|listing|name|names|named|naming|show|shows|showed|showing|shown|tell|tells|telling|told|enumerate|enumerates|enumerated|enumerating|identify|identifies|identified|identifying|print|prints|printed|printing|display|displays|displayed|displaying|count|counts|counted|counting)\b/iu.test(
      asked,
    ) ||
    // "Look at X and tell me Y" — the one that names no formal verb at all.
    // Bare `look` is too loose ("look, just fix it"), so it is required to be
    // looking *at* or *into* something.
    /\blook(?:s|ed|ing)?\s+(?:at|into|through|over)\b/iu.test(asked) ||
    // Running something and saying what happened. The result is the output,
    // not a diff — "run the test suite" that changed no files did exactly what
    // was asked, and was recorded as a failure for it.
    //
    // Safe beside the editing-verb veto above, which has already returned:
    // "run the tests" is a report, "run the tests and fix what fails" is a
    // change request, and the veto is what tells them apart. That ordering is
    // why these can be this permissive.
    /\b(test|tests|tested|testing|verify|verifies|verified|verifying|validate|validates|validated|validating|reproduce|reproduces|reproduced|reproducing|benchmark|benchmarks|benchmarked|benchmarking|profile|profiles|profiled|profiling|lint|lints|linted|linting|typecheck|typechecks|typechecked|typechecking)\b/iu.test(
      asked,
    ) ||
    // The phrase, for the common request that names no verb of its own.
    /\brun(?:s|ning)?\s+(?:the\s+)?(?:unit\s+|integration\s+|e2e\s+)?(?:test|tests|test\s+suite|suite|checks|linter|benchmarks?)\b/iu.test(
      asked,
    ) ||
    /\?\s*$/u.test(asked.trim()) ||
    /^\s*(?:what|which|where|when|why|how|who|is|are|does|do|did|can|could|should|would)\b/iu.test(
      asked,
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
  /**
   * Canonical was brought up to date with its GitHub origin — the other
   * half of export. Records how far it moved and which upstream tip the
   * mirror now considers its import point.
   */
  | "repository_synced"
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
  /** An agent stopped on a choice that was not its to make. */
  | "question_asked"
  | "question_answered"
  /** Nobody answered inside the deadline, so the task was cancelled. */
  | "question_cancelled"
  /**
   * What the agent has touched so far, read from the worktree while it is
   * still editing — the one stretch of a run that previously reported
   * nothing. Carries the whole current set, so a reader arriving late does
   * not have to accumulate a diff of its own.
   */
  | "workspace_changed"
  /**
   * An agent asked the platform to do something, and what came of it. Kept as
   * a pair so "what did this agent ask for" and "what was it given" are both
   * answerable from the log.
   */
  | "action_requested"
  | "action_performed"
  | "scope_change_requested"
  | "scope_change_decided"
  /**
   * An agent gave part of its approved plan back before the task ended, and
   * what came of it. The pair is what makes an over-claimed plan visible: the
   * request names what was never needed, the decision says when everyone else
   * stopped waiting for it.
   */
  | "scope_release_requested"
  | "scope_release_decided"
  /**
   * A holder was told that another task is queued behind resources it owns.
   *
   * The trigger the release request never had. Recorded because an agent that
   * is told and hands nothing back is a different failure from one that was
   * never told at all, and only the trail can tell them apart.
   */
  | "scope_contention_noticed"
  /**
   * A task alone in its repository was handed the whole of it without being
   * asked to describe itself, and — when somebody else turned up — what that
   * claim was narrowed to, read from its worktree at that moment.
   */
  | "blanket_claim_granted"
  | "blanket_claim_frozen"
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
  /**
   * One task's landed work was put back. Recorded against the *reverted*
   * task, not the revert's own, so anything reconstructing what that task
   * changed can see that the answer is now "nothing".
   */
  | "task_reverted"
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
  /**
   * A channel message was pinned to, or unpinned from, the channel's
   * banner; `data.pinned` says which. The `channel_` prefix is load-bearing:
   * the dashboard's reconcile re-reads any channel whose audit events start
   * with it.
   */
  | "channel_message_pinned"
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
   * One reply removed from a thread that survives it. Its own type rather
   * than folded into the event above, because the two answer different
   * questions after the fact: that one says a conversation stopped
   * existing, this one says a turn inside a still-readable conversation
   * was taken out of it.
   */
  | "channel_reply_deleted"
  /**
   * A repository (and its cascaded channel state and grants) was removed.
   * Runs and submitted tasks are never cascaded — see `removeRepository`'s
   * doc comment in `@coord/persistence` — so this event marks the one
   * irreversible removal of a repository's own state.
   */
  | "repository_deleted"
  /**
   * A repository was given a new display name. The id it is keyed by never
   * changes, so this records only what people call it.
   */
  | "repository_renamed";

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

/**
 * An error as a single line, with anything an `AggregateError` is carrying
 * unwrapped into it.
 *
 * `error.message` on an aggregate is only the wrapper — "One or more tasks
 * failed during planning" — and the reasons live in `errors`, which reading
 * `.message` silently drops. A caller that does the obvious thing therefore
 * reports the shape of the failure and never its cause, which is how a
 * planning failure reached a channel saying nothing a reader could act on.
 *
 * Lives here because the coordinator raises these aggregates and the gateway
 * renders them, and a second copy of this rule at either end is one that can
 * drift from the other.
 */
export function describeError(
  error: unknown,
  seen: Set<unknown> = new Set(),
): string {
  if (typeof error === "object" && error !== null) {
    if (seen.has(error)) {
      return "[circular error]";
    }
    seen.add(error);
  }

  const summary = error instanceof Error ? error.message : String(error);
  if (!(error instanceof AggregateError)) {
    return summary;
  }

  const messages = [
    summary,
    ...Array.from(error.errors, (nested) => describeError(nested, seen)),
  ].filter(
    (message, index, all) =>
      message.length > 0 && all.indexOf(message) === index,
  );
  return messages.join("; ");
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

/**
 * The symbols arbitration must treat a plan as claiming; see
 * {@link arbitrationFiles}.
 *
 * The agent's own declarations, not the ones enrichment added. `enrichPlan`
 * puts every symbol of every declared file into `expectedSymbols`, so scoring
 * symbol overlap against that set finds an overlap between any two plans that
 * merely named the same file — which is what file overlap already says, and
 * says better. Counted twice it becomes structural evidence of a symbol
 * collision that neither agent declared, and one of them is sequenced behind
 * a function the other never asked for.
 *
 * Grounding still counts, narrowed the same way: a referent stands in for the
 * declaration it resolved, so only referents of symbols this plan actually
 * declared are claimed on its behalf.
 */
export function arbitrationSymbols(plan: AgentPlan): string[] {
  const declared = plan.declaredSymbols ?? plan.expectedSymbols;
  const grounding = plan.grounding;
  if (grounding === undefined) {
    return declared;
  }
  const own = new Set(declared.map((name) => name.toLowerCase()));
  return uniqueStrings([
    ...declared,
    ...grounding.symbolReferents
      .filter((entry) => own.has(entry.declared.toLowerCase()))
      .map((entry) => entry.resolved),
  ]);
}

/** Whether this plan is a repository-wide claim nobody has narrowed yet. */
export function isBlanketClaim(plan: Pick<AgentPlan, "claim">): boolean {
  return plan.claim?.kind === "blanket";
}

/** The directories a frozen claim covers, or nothing for any other plan. */
export function claimedDirectories(
  plan: Pick<AgentPlan, "claim">,
): readonly string[] {
  return plan.claim?.kind === "frozen" ? plan.claim.directories : [];
}

/**
 * Whether a claim — as opposed to the declarations beside it — covers a path.
 *
 * A blanket claim covers everything. A frozen claim covers whatever lives
 * under a directory its holder was observed working in. Neither says anything
 * about `expectedFiles`, which every caller checks the ordinary way.
 */
export function claimCoversPath(
  plan: Pick<AgentPlan, "claim">,
  file: string,
): boolean {
  if (plan.claim === undefined) {
    return false;
  }
  if (plan.claim.kind === "blanket") {
    return true;
  }
  return plan.claim.directories.some((directory) =>
    file.startsWith(directory),
  );
}

/**
 * Whether a claim makes its holder *occupy* a path, for arbitration.
 *
 * The narrower reading of {@link claimCoversPath}. A blanket claim occupies
 * the repository, as it always did. A frozen claim occupies only the files its
 * holder actually declared: its directories say "new files I may create here",
 * not "every existing file under here is mine". A directory-only match — the
 * path lives under a claimed directory but is named nowhere in the plan — is
 * therefore free for somebody else to take, which is the whole point: one task
 * touching one file in a directory must not queue up everybody else behind the
 * other seventeen.
 *
 * The cost is deliberate. A holder that later reaches into a file granted away
 * is refused when it tries to widen, and that task fails. Reaching for what you
 * never named is the rarer accident; being locked out of a directory somebody
 * else brushed against was the common one.
 */
export function claimOccupiesPath(
  plan: Pick<AgentPlan, "claim" | "expectedFiles">,
  file: string,
): boolean {
  if (plan.claim === undefined) {
    return false;
  }
  if (plan.claim.kind === "blanket") {
    return true;
  }
  return plan.expectedFiles.includes(file);
}

function isPlanClaim(value: unknown): value is PlanClaim {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const claim = value as {
    kind?: unknown;
    grantedAt?: unknown;
    frozenAt?: unknown;
    directories?: unknown;
  };
  if (claim.kind === "blanket") {
    return typeof claim.grantedAt === "string";
  }
  return (
    claim.kind === "frozen" &&
    typeof claim.frozenAt === "string" &&
    isStringArray(claim.directories) &&
    claim.directories.every((directory) => directory.endsWith("/"))
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
    !isOptionalStringArray(plan.declaredSymbols) ||
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
    (plan.grounding !== undefined && !isPlanGrounding(plan.grounding)) ||
    (plan.claim !== undefined && !isPlanClaim(plan.claim))
  ) {
    throw new TypeError("Agent plan does not match the coordination schema");
  }

  plan.expectedFiles = uniqueRepositoryPaths(plan.expectedFiles);
  plan.expectedSymbols = uniqueStrings(plan.expectedSymbols);
  if (plan.declaredSymbols !== undefined) {
    plan.declaredSymbols = uniqueStrings(plan.declaredSymbols);
  }
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
 * A plan with every optional resource collection populated. Grounding and
 * claim stay optional: neither is a resource collection, and neither has an
 * honest default — grounding is a verification verdict a plan may never have
 * received, and a claim records that the coordinator issued this scope rather
 * than an agent describing it, which is untrue of every plan an agent wrote.
 */
export type CompleteAgentPlan = Required<
  Omit<AgentPlan, "grounding" | "claim" | "declaredSymbols">
> &
  // `declaredSymbols` keeps its optionality on purpose: absent is not the
  // same as empty. Absent says this plan was never enriched, so
  // `expectedSymbols` is still the agent's own words; empty says the agent
  // named no symbols. Filling it in here would erase that distinction.
  Pick<AgentPlan, "grounding" | "claim" | "declaredSymbols">;

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

/**
 * The resources a release names, as {@link reducePlanScope} and the ownership
 * service both want them.
 *
 * One reading of the request rather than seven at each call site: a release
 * that narrowed the plan by a different set than it released leases for would
 * leave a file owned by nobody and still claimed, or claimed by nobody and
 * still owned.
 */
export function scopeReleaseResources(
  request: ScopeReleaseRequest,
): PlanResourceRef[] {
  const resources: PlanResourceRef[] = [];
  const add = (resourceType: ResourceType, ids: readonly string[]): void => {
    for (const resourceId of ids) {
      resources.push({ resourceType, resourceId });
    }
  };
  add("file", request.releasedFiles);
  add("symbol", request.releasedSymbols);
  add("api", request.releasedApis);
  add("schema", request.releasedSchemas);
  add("configuration", request.releasedConfigKeys);
  add("test", request.releasedTests);
  add("service", request.releasedServices);
  return resources;
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
