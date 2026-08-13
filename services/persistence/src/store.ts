import type {
  AgentPlan,
  ApprovalDecision,
  ApprovalKind,
  ApprovalRequest,
  ApprovalStatus,
  AuditEvent,
  AuditEventType,
  CanonicalVersion,
  ChangeSet,
  ConflictAssessment,
  CoordinatorDecision,
  FilePatchStatus,
  IntegrationResult,
  PlanAdmission,
  ProjectId,
  ResourceLease,
  ScopeChangeDecision,
  ScopeChangeRequest,
  SequencedAuditEvent,
  TaskDefinition,
  TaskId,
  TaskStatus,
  UserId,
  ValidationCommand,
} from "@coord/shared-types";

import type { AuditChainVerification, AuditCheckpoint } from "./audit-chain.js";

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

/**
 * Whether a save would point an existing repository id at a different
 * canonical repository.
 *
 * Identity is the path and the branch — those say *which* repository this is.
 * Provider and remote URL are provenance, and are only compared when the
 * incoming record actually states them.
 *
 * That distinction is the fix for a real failure: `canonical()` in
 * worker-operations narrows a stored repository to `{id, path, branch}` for
 * Git, and that narrowed record reaches `createRun` → `saveRepository`.
 * Reading an absent provider as `"local"` then made every run on a
 * GitHub-imported repository fail with "already mapped to a different
 * canonical repository" — the repository was the same one, the caller simply
 * had no reason to carry its provenance. A locally-created repository was
 * unaffected, so the failure looked like GitHub import being broken.
 *
 * Omission is not assertion. The row itself keeps its provenance regardless:
 * every store's insert is `ON CONFLICT DO NOTHING`, so a narrowed save cannot
 * overwrite `github` with `local` either.
 */
export function repositoryConflicts(
  existing: StoredRepository,
  incoming: StoredRepository,
): boolean {
  return (
    existing.path !== incoming.path ||
    existing.branch !== incoming.branch ||
    (incoming.provider !== undefined &&
      (existing.provider ?? "local") !== incoming.provider) ||
    (incoming.remoteUrl !== undefined &&
      existing.remoteUrl !== incoming.remoteUrl)
  );
}

export interface StoredRepository {
  id: string;
  path: string;
  branch: string;
  provider?: "local" | "git" | "github";
  remoteUrl?: string;
  /**
   * Who created this repository, for the creator-owns-it capabilities
   * (deletion, repository-scoped promotion) layered on top of the ordinary
   * org-role/grant permission pipeline.
   *
   * Undefined for any repository that predates this field — there is no
   * honest way to backfill an owner for those rows, so they fall back to
   * requiring the plain `manage_project` permission with no creator
   * shortcut, rather than guessing.
   */
  createdBy?: UserId;
}

export type OrganizationRole =
  | "owner"
  | "admin"
  | "developer"
  | "reviewer"
  | "viewer";

export interface Organization {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
}

/**
 * How one person's agents are drawn.
 *
 * `accent` is a personal interface preference. `agentColor` is not: it is the
 * colour every one of this user's agents is drawn in, on shared views as well
 * as their own, so colleagues can tell at a glance whose agent is holding a
 * file. Both are `#rrggbb` or absent.
 */
/**
 * One person's access to one repository.
 *
 * Additive to organization membership rather than a replacement for it: an
 * organization role still reaches every repository, and a grant is how
 * somebody with no such role reaches one.
 */
export interface RepositoryGrant {
  repositoryId: string;
  userId: UserId;
  role: OrganizationRole;
  grantedBy: UserId | undefined;
  createdAt: string;
}

/**
 * A pending invitation into an organization.
 *
 * The secret is never stored — only its hash — so a leaked database yields no
 * usable invitation links. `email` is what the invitation is *for*; accepting
 * it with a different signed-in account is refused, or the link would be a
 * transferable membership grant.
 */
export interface InvitationRecord {
  id: string;
  organizationId: string;
  /** When set, accepting grants this repository rather than the organization. */
  repositoryId: string | undefined;
  email: string;
  role: OrganizationRole;
  secretHash: string;
  invitedBy: UserId;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | undefined;
  acceptedBy: UserId | undefined;
  revokedAt: string | undefined;
}

export interface UserAppearance {
  accent?: string;
  agentColor?: string;
}

export interface UserAccount {
  id: UserId;
  email: string;
  displayName: string;
  passwordDigest: string;
  systemAdmin: boolean;
  disabled: boolean;
  createdAt: string;
  appearance?: UserAppearance;
}

export interface OrganizationMembership {
  organizationId: string;
  userId: UserId;
  role: OrganizationRole;
  createdAt: string;
}

export interface ProjectRecord {
  id: ProjectId;
  organizationId: string;
  slug: string;
  name: string;
  description: string;
  archived: boolean;
  /**
   * Declarative coordination policy, opaque to the store. The gateway
   * validates writes and the coordinator interprets reads, so the storage
   * layer never needs the policy vocabulary.
   */
  policy: Record<string, unknown> | undefined;
  createdAt: string;
  updatedAt: string;
}

/**
 * A long-lived bearer credential for a non-browser client.
 *
 * Only `secretHash` is persisted, so the plaintext token exists exactly once —
 * in the response that created it. Scopes are stored as opaque strings here;
 * the gateway is what interprets them, which keeps permission vocabulary out
 * of the storage layer.
 */
export interface ApiTokenRecord {
  id: string;
  userId: UserId;
  /** Restricts the token to one organization. Undefined means every one the user can reach. */
  organizationId: string | undefined;
  name: string;
  secretHash: string;
  scopes: string[];
  createdAt: string;
  /** Session that minted it, so a compromised session's tokens can be traced. */
  createdBySession: string | undefined;
  expiresAt: string | undefined;
  lastUsedAt: string | undefined;
  lastUsedIp: string | undefined;
  revokedAt: string | undefined;
  revokedReason: string | undefined;
}

export interface WorkerRecord {
  id: string;
  /** The person whose credential registered the worker, and who may drive it. */
  userId: UserId;
  /**
   * The tenant the worker belongs to, and the only unit visibility is granted
   * against: a fleet is a property of a team, not of whoever happened to start
   * the process.
   *
   * `undefined` only for rows registered before workers were org-scoped whose
   * owner had no membership to backfill from. Such a worker matches no
   * organization filter, so it stays invisible rather than leaking into an
   * arbitrary tenant's fleet.
   */
  organizationId: string | undefined;
  name: string;
  /** Agent adapters this worker can drive, e.g. `codex`, `generic-cli`. */
  adapters: string[];
  version: string;
  registeredAt: string;
  lastSeenAt: string;
}

export type WorkLeaseStatus = "active" | "completed" | "failed" | "expired" | "released";

/**
 * The plan a remote worker submitted for its lease, and the coordinator's
 * answer, recorded before any editing happens.
 *
 * Attaching it to the lease rather than to a run is what makes plan-time
 * arbitration possible: the set of plans currently being executed in a
 * repository is exactly the set of active leases carrying an approved
 * admission, and that set is readable without knowing which runs exist yet.
 */
export interface WorkLeasePlan {
  plan: AgentPlan;
  admission: PlanAdmission;
}

export interface SaveWorkLeasePlanInput {
  leaseId: string;
  submission: WorkLeasePlan;
  /**
   * Ids of the other active leases in the same repository that already carried
   * an approved plan when the admission was decided. The write is refused when
   * that set has changed, so two workers arbitrating at the same moment cannot
   * both be admitted against a stale view.
   */
  observedApprovedLeaseIds: readonly string[];
  /**
   * Replace an approved contract instead of refusing to.
   *
   * An approved admission is normally immutable: it is what ownership was
   * granted against, and letting a later request widen it would let a worker
   * grant itself scope nobody arbitrated. Mid-execution scope arbitration is
   * the one caller that legitimately produces a wider contract, because the
   * widening has just been decided against every other holder — through the
   * same conflict and ownership services, under the same staleness check
   * below, which is what makes it a decision rather than a claim.
   */
  replaceApproved?: boolean;
}

/**
 * Order-insensitive comparison of an observed admitted set against the current
 * one. Shared by every backend so the staleness rule cannot drift between them.
 */
export function sameLeaseIdSet(
  first: readonly string[],
  second: readonly string[],
): boolean {
  if (first.length !== second.length) {
    return false;
  }
  const left = [...first].sort();
  const right = [...second].sort();
  return left.every((value, index) => value === right[index]);
}

export type SaveWorkLeasePlanResult =
  | { outcome: "saved"; lease: WorkLease }
  /** This lease already has an approved contract, which is immutable. */
  | { outcome: "already_admitted"; lease: WorkLease }
  /** Another lease was admitted concurrently; re-read and decide again. */
  | { outcome: "stale"; approvedLeaseIds: string[] }
  /** The lease is gone, lapsed, or settled; the plan cannot be recorded. */
  | { outcome: "lease_lost" };

/**
 * An exclusive, time-bounded assignment of one task to one worker.
 *
 * The expiry is the recovery mechanism: a worker that crashes stops
 * heartbeating, the lease lapses, and the task returns to the queue instead of
 * being stranded. A unique index guarantees at most one active lease per task.
 */
export interface WorkLease {
  id: string;
  taskId: TaskId;
  workerId: string;
  repositoryId: string;
  projectId: ProjectId | undefined;
  status: WorkLeaseStatus;
  /** Canonical revision the worker must build its workspace from. */
  baseRevision: string;
  issuedAt: string;
  expiresAt: string;
  heartbeatAt: string;
  finishedAt: string | undefined;
  outcome: string | undefined;
  detail: string | undefined;
  /** Set once the worker submits a plan and the coordinator answers it. */
  plan: WorkLeasePlan | undefined;
}

export interface LeaseTaskInput {
  workerId: string;
  baseRevision: string;
  ttlMs: number;
  taskId?: TaskId;
  repositoryId?: string;
  projectId?: ProjectId;
  /**
   * How many active leases one repository may carry at once. Defaults to 1:
   * strictly serialized remote execution. Values above 1 admit concurrent
   * workers in a repository; correctness then rests on exact-base integration
   * and stale-requeue at result acceptance, which this limit does not relax.
   */
  repositoryParallelism?: number;
}

export interface LeasedWork {
  lease: WorkLease;
  task: SubmittedTask;
}

export interface AuthSessionRecord {
  id: string;
  userId: UserId;
  secretHash: string;
  csrfHash: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  ipAddress: string;
  userAgent: string;
}

/**
 * A task's lifecycle before, during, and after the run that executes it.
 *
 * `claimed` exists so a crashed run leaves evidence that a task was taken,
 * rather than silently returning to the queue and being executed twice.
 */
export type SubmittedTaskStatus =
  | "submitted"
  | "claimed"
  | "integrated"
  | "failed"
  | "cancelled";
export type SubmittedTaskCompletionStatus = Extract<
  SubmittedTaskStatus,
  "integrated" | "failed" | "cancelled"
>;

export interface SubmitTaskInput {
  repositoryId: string;
  projectId?: ProjectId;
  objective: string;
  agentId: string;
  validationCommands: ValidationCommand[];
  submittedBy?: UserId;
  /**
   * What this request was asked inside, for the agent that will run it.
   *
   * Today that is the thread a channel dispatch came from: "now do the same
   * for the other file" is unanswerable without the messages before it. Kept
   * out of `objective` deliberately — the objective is what somebody asked
   * for, and it is rendered in the channel, in task lists and in thread
   * titles, where a pasted transcript would make every request unreadable.
   *
   * Advisory, never authoritative: it is what was said, not what is true of
   * the workspace now.
   */
  context?: string;
}

export interface SubmittedTask {
  id: TaskId;
  repositoryId: string;
  projectId: ProjectId | undefined;
  objective: string;
  agentId: string;
  validationCommands: ValidationCommand[];
  submittedBy: UserId | undefined;
  /** See {@link SubmitTaskInput.context}. Absent on everything submitted outside a thread. */
  context: string | undefined;
  status: SubmittedTaskStatus;
  submittedAt: string;
  claimedAt: string | undefined;
  completedAt: string | undefined;
  runId: string | undefined;
}

export interface SubmittedTaskFilter {
  repositoryId?: string;
  projectId?: ProjectId;
  status?: SubmittedTaskStatus;
}

export interface CreateRunInput {
  repository: StoredRepository;
  projectId?: ProjectId;
  mode: RunMode;
  scenario?: string;
  baseVersion: CanonicalVersion;
}

export interface StoredRun {
  id: string;
  repositoryId: string;
  projectId: ProjectId | undefined;
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
  validationCommands: ValidationCommand[];
  status: TaskStatus;
  explanation: string | undefined;
  plan: AgentPlan | undefined;
  decision: CoordinatorDecision | undefined;
  sessionId: string | undefined;
  sessionStartedAt: string | undefined;
}

export interface StoredPlanRevision {
  id: string;
  runId: string;
  taskId: TaskId;
  revision: number;
  reason: "initial" | "canonical_change" | "scope_change";
  canonicalRevision: string;
  plan: AgentPlan;
  createdAt: string;
}

export interface StoredScopeChange {
  runId: string;
  request: ScopeChangeRequest;
  decision: ScopeChangeDecision | undefined;
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

/**
 * A review remark on a changeset, optionally anchored to one file.
 *
 * Separate from the approval record on purpose: an approval is a single
 * decision with one outcome, while review is a conversation that may happen
 * before, during, or after that decision — including on changesets that were
 * never gated at all.
 */
export interface ChangesetComment {
  id: string;
  runId: string;
  changeSetId: string;
  taskId: TaskId;
  /** File the remark is about; absent for a comment on the changeset itself. */
  filePath: string | undefined;
  authorId: UserId;
  body: string;
  createdAt: string;
  resolvedAt: string | undefined;
  resolvedBy: UserId | undefined;
}

export interface AddChangesetCommentInput {
  runId: string;
  changeSetId: string;
  taskId: TaskId;
  filePath?: string;
  authorId: UserId;
  body: string;
}

export interface RunDetail {
  run: StoredRun;
  tasks: StoredTask[];
  conflicts: ConflictAssessment[];
  changeSets: ChangeSet[];
  integrations: IntegrationResult[];
  leases: ResourceLease[];
  workspaces: StoredWorkspace[];
  planRevisions: StoredPlanRevision[];
  scopeChanges: StoredScopeChange[];
  approvals: ApprovalRequest[];
  comments: ChangesetComment[];
  audit: AuditEvent[];
}

export interface AppendAuditInput {
  type: AuditEventType;
  taskId?: TaskId;
  data?: Readonly<Record<string, unknown>>;
}

export interface AuditEventFilter {
  afterSequence?: number;
  runId?: string;
  taskId?: TaskId;
  /**
   * Matches the `projectId` stamped into an event's data. Events written
   * before project stamping carry none and are excluded rather than guessed.
   */
  projectId?: ProjectId;
  types?: AuditEventType[];
  /** Inclusive lower bound on `occurredAt`. */
  occurredAfter?: string;
  /** Exclusive upper bound on `occurredAt`. */
  occurredBefore?: string;
  limit?: number;
}

export interface ArchiveAuditInput {
  /** Archive events at or below this sequence. */
  throughSequence?: number;
  /** Archive events that occurred strictly before this ISO timestamp. */
  before?: string;
}

export interface AuditArchiveResult {
  checkpoint: AuditCheckpoint;
  /** The events that moved, in sequence order. */
  events: SequencedAuditEvent[];
}

/** Which half of an agent's work spent the tokens. */
export type TokenUsagePhase = "planning" | "execution";

export interface RecordTokenUsageInput {
  /**
   * Identity of the measurement, not of the row.
   *
   * A worker reports a *running total* as it goes, so the same lease and
   * phase are reported repeatedly with a larger figure. Keying on
   * (lease, task, phase) and replacing makes those reports idempotent:
   * the stored figure is the latest total rather than a sum of snapshots.
   */
  usageKey: string;
  projectId?: ProjectId;
  repositoryId: string;
  taskId: TaskId;
  leaseId?: string;
  runId?: string;
  agentId: string;
  phase: TokenUsagePhase;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens: number;
  recordedAt: string;
}

export interface TokenUsageRecord {
  id: string;
  usageKey: string;
  projectId: ProjectId | undefined;
  repositoryId: string;
  taskId: TaskId;
  leaseId: string | undefined;
  runId: string | undefined;
  agentId: string;
  phase: TokenUsagePhase;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  recordedAt: string;
}

export interface TokenUsageFilter {
  projectId?: ProjectId;
  repositoryId?: string;
  taskId?: TaskId;
  leaseId?: string;
  /** Only usage recorded at or after this ISO timestamp. */
  recordedAfter?: string;
}

export interface ApprovalFilter {
  organizationId?: string;
  projectId?: ProjectId;
  repositoryId?: string;
  runId?: string;
  taskId?: TaskId;
  status?: ApprovalStatus;
}

export interface CreateApprovalInput {
  organizationId?: string;
  projectId?: ProjectId;
  repositoryId: string;
  runId: string;
  taskId: TaskId;
  kind: ApprovalKind;
  requestedBy: string;
  requiredRole: "reviewer" | "admin" | "owner";
  reasons: string[];
  changeSetId?: string;
  scopeChangeId?: string;
  expiresAt: string;
}

/**
 * `progress` is an agent narrating its own run — thinking, steps taken, files
 * touched — rather than saying something to the room.
 *
 * Separate from `agent` because the difference is invisible to a reader
 * otherwise, and everything downstream needs it: a thread's reply count
 * should mean "how much was said", not "how long the run was", and a wall of
 * step-by-step commentary reads better as one block that grows than as thirty
 * messages from somebody who will not stop talking.
 *
 * `outcome` is the reply that ends a thread — the run's verdict, whether that
 * is the agent's own account of what it did, a failure, or a cancellation.
 *
 * Marked for the same reason `progress` is: the browser was deciding it by
 * matching the text against the fixed sentences the narration used to write,
 * and then the ending became the agent's own summary. Nothing an agent writes
 * begins "Done —", so every thread that finished well was read as still
 * thinking: the summary — the one line the reader came for — was filed inside
 * the collapsed reasoning block, the typing dots never retired, and the sweep
 * that gives unfinished threads an ending could not tell this thread already
 * had one and gave it a second.
 *
 * Stored as text like the others, so nothing migrates: rows written before
 * this existed are `agent`, which is what they were, and the text match stays
 * as the fallback that reads them.
 */
export type ChannelEntryKind =
  | "user"
  | "agent"
  | "system"
  | "progress"
  | "outcome";

/** One emoji's reaction summary from one viewer's point of view. */
export interface ChannelReaction {
  emoji: string;
  count: number;
  /** Whether the requesting viewer is among the reactors. */
  mine: boolean;
}

export interface ChannelReply {
  id: string;
  messageId: string;
  kind: ChannelEntryKind;
  authorId: string;
  content: string;
  createdAt: string;
}

/**
 * One message in a repository's shared group channel — the one room every
 * human and agent working that repository shares, mirroring what
 * `apps/web/public/data.js` produced locally before there was a server
 * behind it.
 */
export interface ChannelMessage {
  id: string;
  repositoryId: string;
  projectId: ProjectId;
  kind: ChannelEntryKind;
  authorId: string;
  content: string;
  createdAt: string;
  replies: ChannelReply[];
  /** Keyed by emoji; `mine` is relative to whichever viewer asked. */
  reactions: Record<string, ChannelReaction>;
  /** The task this thread narrates, when it narrates one. */
  taskId: TaskId | undefined;
  /**
   * What that task has changed so far — added, modified or deleted — kept
   * with the thread so it survives the audit log being archived, and so a
   * reader can see it without the run still being in memory.
   *
   * Undefined until the task touches something. An empty array would claim a
   * task changed nothing, which is a different statement.
   */
  changedFiles: ChannelChangedFile[] | undefined;
}

/**
 * How far a repository's auditor has already looked, and how much it has
 * spent looking.
 *
 * Two positions rather than one, because they answer different questions and
 * neither substitutes for the other. `sequence` is the audit log position the
 * watcher has consumed: it is what makes the poll idempotent, so a restart
 * re-reads nothing and a promotion that arrived while the process was down is
 * still seen. `revision` is where canonical stood when the last audit
 * actually ran: it is what the *next* audit diffs against, so a run that
 * crashes between consuming the event and finishing the audit does not
 * silently skip the change it was about to look at.
 *
 * Storing only the sequence would lose the diff base the moment the log is
 * compacted; storing only the revision would re-audit every promotion again
 * after a restart, which is exactly the unbounded background spend the
 * feature has to avoid.
 */
export interface AuditorCursor {
  repositoryId: string;
  /**
   * Canonical revision the last completed audit examined up to, or `""` when
   * this repository's auditor has not yet finished one — a row can exist
   * before any audit has run, because pausing writes one.
   */
  revision: string;
  /** Highest `canonical_promoted` audit-log sequence already consumed. */
  sequence: number;
  /**
   * Whether auditing is switched off here.
   *
   * Separate from holding the role, and deliberately so: an auditor on a busy
   * repository costs a model call per merge, and the answer to "this is too
   * expensive this week" should not be to demote the agent and lose its
   * place. Pausing keeps the cursor, so resuming audits the gap rather than
   * starting over or skipping what happened while it was off.
   *
   * A repository with no row at all is *not* paused: auditing is on from the
   * moment an agent is promoted, and absence means "nothing has said
   * otherwise".
   */
  paused: boolean;
  updatedAt: string;
}

export interface AppendChannelMessageInput {
  repositoryId: string;
  projectId: ProjectId;
  kind?: ChannelEntryKind;
  authorId: string;
  content: string;
  /**
   * The task this thread is the story of, when it is one.
   *
   * Recorded rather than remembered: the link lived only in the channel
   * watcher's memory, so a restart lost it — and a thread has to be able to
   * say what its work changed for as long as it exists, not for as long as
   * the process that started it.
   */
  taskId?: TaskId;
}

/** One file a thread's task changed, for the summary hanging off the thread. */
export interface ChannelChangedFile {
  path: string;
  status: FilePatchStatus;
  /**
   * Lines added and removed, when the run reported enough to count them.
   *
   * Optional because the shape predates them and older rows have none — a
   * thread from before this stays a list of paths rather than becoming a list
   * of paths claiming every file changed nothing.
   */
  added?: number;
  removed?: number;
}

const CHANGED_FILE_STATUSES: readonly FilePatchStatus[] = [
  "added",
  "modified",
  "deleted",
];

/**
 * Reads a stored changed-file summary back.
 *
 * Deliberately forgiving: this decorates a thread, and a row that cannot be
 * parsed — written by a future version, truncated, hand-edited — must cost
 * the reader a dropdown, never the conversation it hangs off.
 */
export function parseChangedFiles(
  json: string | undefined,
): ChannelChangedFile[] | undefined {
  if (json === undefined || json.trim() === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const files = parsed.flatMap((entry): ChannelChangedFile[] => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const { path, status, added, removed } = entry as {
      path?: unknown;
      status?: unknown;
      added?: unknown;
      removed?: unknown;
    };
    if (typeof path !== "string" || path.length === 0) {
      return [];
    }
    if (!CHANGED_FILE_STATUSES.includes(status as FilePatchStatus)) {
      return [];
    }
    // The line counts, when the row has them.
    //
    // This used to rebuild each entry as `{ path, status }` and drop the rest,
    // which quietly undid the whole point of storing them: a run wrote its
    // counts into the row, the thread rendered them once from what the
    // collector returned, and the next read — a reload, another person opening
    // the channel — got paths alone. The counts looked like they only worked
    // for the newest thread, when in fact they only worked before the first
    // re-read. The in-memory store keeps whole objects, so nothing in the
    // tests could see it.
    //
    // Both or neither, matching the writer: half a count renders as "+8 −0",
    // which reads as a measurement rather than as the absence of one.
    const counted =
      typeof added === "number" &&
      Number.isFinite(added) &&
      typeof removed === "number" &&
      Number.isFinite(removed);
    return [
      {
        path,
        status: status as FilePatchStatus,
        ...(counted ? { added, removed } : {}),
      },
    ];
  });
  return files.length === 0 ? undefined : files;
}

export interface AddChannelReplyInput {
  repositoryId: string;
  messageId: string;
  kind?: ChannelEntryKind;
  authorId: string;
  content: string;
}

export interface ChannelMessageFilter {
  /** Exclusive cursor: only messages created strictly before this ISO time. */
  before?: string;
  limit?: number;
}

/**
 * One message from one person to one other person, private to the two of them.
 *
 * The counterpart to `ChannelMessage`, and deliberately not a variant of it: a
 * channel message is readable by anyone with access to its repository, which
 * is the property this type exists to not have. Nothing here is addressed to
 * an agent — an agent is talked to through its own conversation, and a request
 * for work goes to the channel where the rest of the team can see it.
 */
export interface DirectMessage {
  id: string;
  projectId: ProjectId;
  authorId: string;
  recipientId: string;
  content: string;
  createdAt: string;
  /** When the recipient read it. Absent while it is still unread. */
  readAt?: string;
}

export interface AppendDirectMessageInput {
  projectId: ProjectId;
  authorId: string;
  recipientId: string;
  content: string;
}

/** One correspondent and the state of that conversation, for the inbox. */
export interface DirectConversation {
  /** The other person, from the asking viewer's side. */
  userId: string;
  lastMessage: DirectMessage;
  /** Messages the viewer has not read yet. */
  unread: number;
}

export interface DirectMessageFilter {
  /** Exclusive cursor: only messages created strictly before this ISO time. */
  before?: string;
  limit?: number;
}

/**
 * The identity of a conversation, independent of who is asking.
 *
 * Sorted, so the pair reads the same from either side and a thread can be
 * fetched with one indexed equality rather than an OR across two columns. The
 * separator is a character no generated id contains; it is a plain one on
 * purpose, so that a file holding these keys stays text.
 */
export function directPairKey(one: string, other: string): string {
  return [one, other].sort().join("|");
}

/**
 * A per-(repository, agent) override of how an agent presents itself in one
 * channel — a display name, a role label, and/or a model/reasoning-effort
 * choice that is free to disagree with the agent's account-wide connection,
 * the same way a person picks a different display name per Slack workspace.
 *
 * `role` is the only source of an agent's role — an agent is unlabeled ("")
 * until a channel sets one, there is no vendor-guessed default — the same
 * way `name` overrides the default "<Vendor> (<owner>)". One agent can be
 * "Frontend Agent" in one repository and unlabeled, or something else
 * entirely, in another.
 */
export interface ChannelAgentOverride {
  repositoryId: string;
  agentId: string;
  name?: string;
  role?: string;
  model?: string;
  effort?: string;
  updatedAt: string;
}

/**
 * One (repository, user, provider) triple that is an actual member of a
 * channel — i.e. eligible to appear in its roster and be @mentioned there.
 *
 * Membership is opt-in: connecting a vendor CLI makes an agent usable, not
 * automatically present in every repository's channel. See
 * `channelAgentConnections` in server.ts for how this is enforced and for the
 * one-time backfill that grandfathers in whatever was already visible before
 * membership existed as a concept.
 */
export interface ChannelAgentMember {
  repositoryId: string;
  userId: string;
  provider: string;
}

export const DEFAULT_ORGANIZATION_ID = "org_local";
export const DEFAULT_PROJECT_ID = "project_local";

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
  createOrganization(input: {
    slug: string;
    name: string;
  }): Promise<Organization>;
  updateOrganization(
    id: string,
    input: { name?: string; slug?: string },
  ): Promise<Organization>;
  listOrganizations(userId?: UserId): Promise<Organization[]>;
  getOrganization(id: string): Promise<Organization | undefined>;

  createUser(input: {
    email: string;
    displayName: string;
    passwordDigest: string;
    systemAdmin?: boolean;
  }): Promise<UserAccount>;
  updateUser(
    id: UserId,
    input: {
      displayName?: string;
      passwordDigest?: string;
      disabled?: boolean;
      systemAdmin?: boolean;
      appearance?: UserAppearance;
    },
  ): Promise<UserAccount>;
  getUser(id: UserId): Promise<UserAccount | undefined>;
  getUserByEmail(email: string): Promise<UserAccount | undefined>;
  listUsers(): Promise<UserAccount[]>;
  countUsers(): Promise<number>;

  saveMembership(membership: {
    organizationId: string;
    userId: UserId;
    role: OrganizationRole;
  }): Promise<OrganizationMembership>;
  removeMembership(organizationId: string, userId: UserId): Promise<void>;
  listMemberships(
    organizationId: string,
  ): Promise<OrganizationMembership[]>;
  getMembership(
    organizationId: string,
    userId: UserId,
  ): Promise<OrganizationMembership | undefined>;

  createProject(input: {
    organizationId: string;
    slug: string;
    name: string;
    description?: string;
  }): Promise<ProjectRecord>;
  updateProject(
    id: ProjectId,
    input: {
      slug?: string;
      name?: string;
      description?: string;
      archived?: boolean;
      /** An object replaces the policy; `null` clears it. */
      policy?: Record<string, unknown> | null;
    },
  ): Promise<ProjectRecord>;
  getProject(id: ProjectId): Promise<ProjectRecord | undefined>;
  listProjects(organizationId: string): Promise<ProjectRecord[]>;
  linkRepository(projectId: ProjectId, repositoryId: string): Promise<void>;
  unlinkRepository(projectId: ProjectId, repositoryId: string): Promise<void>;
  listProjectRepositories(projectId: ProjectId): Promise<StoredRepository[]>;
  projectHasRepository(
    projectId: ProjectId,
    repositoryId: string,
  ): Promise<boolean>;

  registerWorker(input: {
    userId: UserId;
    organizationId: string;
    name: string;
    adapters: string[];
    version: string;
  }): Promise<WorkerRecord>;
  /**
   * Lists registered workers, newest heartbeat first.
   *
   * `organizationId` is the tenant boundary and is filtered in the query
   * rather than by the caller: an unfiltered call returns every worker on the
   * deployment, so anything serving a user must pass one.
   */
  listWorkers(filter?: { organizationId?: string }): Promise<WorkerRecord[]>;
  getWorker(id: string): Promise<WorkerRecord | undefined>;
  touchWorker(id: string, at: string): Promise<void>;

  /**
   * Atomically hands the oldest pending task to one worker.
   *
   * Returns `undefined` when nothing is pending. Callers must not pre-check
   * availability: the claim and the lease are one transaction so two workers
   * polling simultaneously cannot receive the same task.
   */
  leaseNextTask(input: LeaseTaskInput): Promise<LeasedWork | undefined>;
  getWorkLease(id: string): Promise<WorkLease | undefined>;
  listWorkLeases(filter?: {
    workerId?: string;
    status?: WorkLeaseStatus;
    projectId?: ProjectId;
    repositoryId?: string;
    /** Only leases issued strictly after this ISO timestamp. */
    issuedAfter?: string;
  }): Promise<WorkLease[]>;
  /**
   * Records a plan and its admission against an active lease.
   *
   * Serialized against other admissions in the same repository so that two
   * workers evaluating overlapping plans at the same moment cannot both be
   * approved: the loser is told its view was stale and decides again.
   */
  saveWorkLeasePlan(
    input: SaveWorkLeasePlanInput,
  ): Promise<SaveWorkLeasePlanResult>;
  /** Extends an active lease. Returns undefined if it already lapsed. */
  heartbeatWorkLease(
    id: string,
    at: string,
    expiresAt: string,
  ): Promise<WorkLease | undefined>;
  /**
   * Ends a lease. `completed` and `failed` settle the task; `released`
   * returns it to the queue for another worker.
   */
  finishWorkLease(
    id: string,
    status: Exclude<WorkLeaseStatus, "active">,
    at: string,
    detail?: string,
  ): Promise<boolean>;
  /** Lapses active leases past their expiry and requeues their tasks. */
  expireWorkLeases(now: string): Promise<WorkLease[]>;

  /**
   * Records what an agent reported spending.
   *
   * Upserts on `usageKey`, because a worker reports a running total rather
   * than increments: the last report for one lease and phase is the truth,
   * and adding them up would multiply the bill by however often the worker
   * happened to heartbeat.
   */
  recordTokenUsage(input: RecordTokenUsageInput): Promise<TokenUsageRecord>;
  listTokenUsage(filter?: TokenUsageFilter): Promise<TokenUsageRecord[]>;

  saveRepositoryGrant(grant: RepositoryGrant): Promise<void>;
  removeRepositoryGrant(repositoryId: string, userId: UserId): Promise<void>;
  listRepositoryGrants(repositoryId: string): Promise<RepositoryGrant[]>;
  /** Every repository this user has been granted, across all of them. */
  listGrantsForUser(userId: UserId): Promise<RepositoryGrant[]>;

  createInvitation(invitation: InvitationRecord): Promise<void>;
  getInvitation(id: string): Promise<InvitationRecord | undefined>;
  /** Newest first. Accepted and revoked ones are kept so the record stands. */
  listInvitations(organizationId: string): Promise<InvitationRecord[]>;
  /** Marks it used. Returns false when it was already used or revoked. */
  acceptInvitation(id: string, userId: UserId, at: string): Promise<boolean>;
  revokeInvitation(id: string, at: string): Promise<void>;

  createApiToken(token: ApiTokenRecord): Promise<void>;
  getApiToken(id: string): Promise<ApiTokenRecord | undefined>;
  /** Newest first. Revoked tokens are included so history stays auditable. */
  listApiTokens(userId: UserId): Promise<ApiTokenRecord[]>;
  touchApiToken(id: string, at: string, ipAddress: string): Promise<void>;
  revokeApiToken(id: string, at: string, reason: string): Promise<void>;
  /** Removes tokens that expired before `now`; returns how many were deleted. */
  deleteExpiredApiTokens(now: string): Promise<number>;

  createAuthSession(session: AuthSessionRecord): Promise<void>;
  getAuthSession(id: string): Promise<AuthSessionRecord | undefined>;
  touchAuthSession(id: string, at: string): Promise<void>;
  revokeAuthSession(id: string): Promise<void>;
  revokeUserSessions(userId: UserId): Promise<void>;
  deleteExpiredAuthSessions(now: string): Promise<number>;

  saveRepository(repository: StoredRepository): Promise<void>;
  /**
   * Removes a repository registration and everything scoped to it.
   *
   * That is the shared channel (messages, replies, reactions, per-agent
   * overrides and membership), the per-repository access grants, and the
   * execution history: the queue, runs and their children, approvals, and
   * leases.
   *
   * History used to refuse deletion, on the reasoning that a run is a record
   * and a record should not be thrown away. In production that surfaced as a
   * raw "FOREIGN KEY constraint failed" with nothing offering to clear the
   * history behind it, so a repository that had ever done work could not be
   * removed at all. A contract nobody can satisfy is not protection; the
   * cascade is deliberate and the store-contract tests assert it.
   */
  removeRepository(id: string): Promise<void>;
  listRepositories(): Promise<StoredRepository[]>;
  getRepository(id: string): Promise<StoredRepository | undefined>;

  submitTask(input: SubmitTaskInput): Promise<SubmittedTask>;
  listSubmittedTasks(filter?: SubmittedTaskFilter): Promise<SubmittedTask[]>;
  /**
   * Atomically claims submitted work for one repository.
   *
   * `projectId` is required by tenant-facing runtimes so a repository linked
   * to multiple projects cannot leak work across project queues. It remains
   * optional for the trusted local CLI and backwards-compatible stores.
   */
  claimSubmittedTasks(
    repositoryId: string,
    projectId?: ProjectId,
  ): Promise<SubmittedTask[]>;
  /** Explicitly returns a claimed or failed task to the pending queue. */
  retrySubmittedTask(taskId: TaskId): Promise<SubmittedTask>;
  cancelSubmittedTask(taskId: TaskId): Promise<SubmittedTask>;
  completeSubmittedTask(
    taskId: TaskId,
    status: SubmittedTaskCompletionStatus,
    runId?: string,
  ): Promise<void>;

  createRun(input: CreateRunInput): Promise<StoredRun>;
  finishRun(
    runId: string,
    status: RunStatus,
    finalVersion?: CanonicalVersion,
  ): Promise<void>;

  saveTask(runId: string, task: TaskDefinition): Promise<void>;
  savePlan(runId: string, taskId: TaskId, plan: AgentPlan): Promise<void>;
  savePlanRevision(
    runId: string,
    taskId: TaskId,
    input: Omit<StoredPlanRevision, "id" | "runId" | "taskId" | "createdAt">,
  ): Promise<StoredPlanRevision>;
  listPlanRevisions(
    runId: string,
    taskId?: TaskId,
  ): Promise<StoredPlanRevision[]>;
  saveScopeChange(
    runId: string,
    request: ScopeChangeRequest,
  ): Promise<void>;
  saveScopeChangeDecision(
    runId: string,
    decision: ScopeChangeDecision,
  ): Promise<void>;
  listScopeChanges(runId: string): Promise<StoredScopeChange[]>;
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
  addChangesetComment(
    input: AddChangesetCommentInput,
  ): Promise<ChangesetComment>;
  listChangesetComments(filter?: {
    runId?: string;
    changeSetId?: string;
    resolved?: boolean;
  }): Promise<ChangesetComment[]>;
  getChangesetComment(id: string): Promise<ChangesetComment | undefined>;
  /** Marks a remark handled. Resolving an already-resolved comment is a no-op. */
  resolveChangesetComment(
    id: string,
    resolvedBy: UserId,
    at: string,
  ): Promise<ChangesetComment>;
  saveIntegration(runId: string, result: IntegrationResult): Promise<void>;
  saveCanonicalVersion(
    repositoryId: string,
    version: CanonicalVersion,
  ): Promise<void>;

  appendAudit(
    runId: string | undefined,
    input: AppendAuditInput,
  ): Promise<AuditEvent>;
  listAuditEvents(filter?: AuditEventFilter): Promise<SequencedAuditEvent[]>;
  /**
   * Moves the oldest events out of the live log and records a checkpoint.
   *
   * Returns `undefined` when nothing matches. Refuses to archive a chain that
   * does not currently verify, because a checkpoint over a broken segment
   * would launder the break into an attestation. The live log continues from
   * the checkpoint's chain hash, so verification survives compaction.
   */
  archiveAuditEvents(
    input: ArchiveAuditInput,
  ): Promise<AuditArchiveResult | undefined>;
  listAuditCheckpoints(): Promise<AuditCheckpoint[]>;
  listArchivedAuditEvents(
    filter?: AuditEventFilter,
  ): Promise<SequencedAuditEvent[]>;
  /**
   * Drops retained archive rows at or below a checkpoint to reclaim space.
   *
   * The checkpoint survives, so the segment stays attested; what is lost is
   * the ability to re-derive its contents. Returns how many rows went.
   */
  pruneArchivedAuditEvents(throughSequence: number): Promise<number>;

  createApproval(input: CreateApprovalInput): Promise<ApprovalRequest>;
  getApproval(id: string): Promise<ApprovalRequest | undefined>;
  listApprovals(filter?: ApprovalFilter): Promise<ApprovalRequest[]>;
  decideApproval(decision: ApprovalDecision): Promise<ApprovalRequest>;
  expireApprovals(now: string): Promise<number>;

  listRuns(limit?: number): Promise<StoredRun[]>;
  getRun(runId: string): Promise<RunDetail | undefined>;
  listAudit(runId?: string): Promise<AuditEvent[]>;
  verifyAudit(): Promise<AuditChainVerification>;

  /**
   * A repository's shared group channel, newest last.
   *
   * `viewerId` decides `mine` on each reaction; the stored rows have no
   * concept of a single viewer. `filter.before` pages backward from the
   * newest message so the client's default view (most recent) needs no
   * cursor at all.
   */
  listChannelMessages(
    repositoryId: string,
    viewerId: UserId,
    filter?: ChannelMessageFilter,
  ): Promise<ChannelMessage[]>;
  appendChannelMessage(
    input: AppendChannelMessageInput,
  ): Promise<ChannelMessage>;
  /**
   * Replaces the changed-file summary on one thread.
   *
   * The whole set each time rather than an append, because the run reports
   * the whole set: a file can go from added to modified, or stop being
   * changed at all when an agent reverts itself, and merging deltas here
   * would leave the thread claiming edits that no longer exist.
   *
   * A message that has since been deleted is not an error — the run
   * outlives nothing, but the thread it was narrating can be gone.
   */
  setChannelMessageChangedFiles(
    repositoryId: string,
    messageId: string,
    files: readonly ChannelChangedFile[],
  ): Promise<void>;
  /**
   * Records which task a thread is the story of.
   *
   * Set after the fact rather than when the thread opens, because the thread
   * opens first: the agent acknowledges in its own voice before anything slow
   * runs, and the task does not exist until the submission that follows
   * returns. Attaching it here is what lets the thread and the work be joined
   * without the run still being in memory.
   */
  setChannelMessageTask(
    repositoryId: string,
    messageId: string,
    taskId: TaskId,
  ): Promise<void>;
  addChannelReply(input: AddChannelReplyInput): Promise<ChannelReply>;
  getChannelMessage(
    repositoryId: string,
    messageId: string,
    viewerId: UserId,
  ): Promise<ChannelMessage | undefined>;
  /** Adds the viewer's reaction if absent, removes it if present. */
  toggleChannelReaction(
    repositoryId: string,
    messageId: string,
    userId: UserId,
    emoji: string,
  ): Promise<ChannelMessage>;
  /**
   * Moves a message to the foot of the channel without changing when it was
   * said.
   *
   * Continuing an existing thread has to bring it back into view, or work
   * lands where nobody is looking. Rewriting `createdAt` would buy that by
   * lying about history, and every reply's ordering hangs off it — so
   * position and time are separate facts, and only position moves.
   */
  bumpChannelMessage(
    repositoryId: string,
    messageId: string,
    at: string,
  ): Promise<void>;
  /** Removes a message with its replies and reactions. */
  deleteChannelMessage(repositoryId: string, messageId: string): Promise<void>;
  /** Removes every message in one channel. Returns how many went. */
  deleteChannelMessages(repositoryId: string): Promise<number>;

  appendDirectMessage(input: AppendDirectMessageInput): Promise<DirectMessage>;
  /**
   * One conversation, oldest first, between the viewer and one other person.
   *
   * Both directions: the viewer's own messages and the other's are one
   * thread, so this is not filtered by author. `viewerId` is here to say which
   * side is asking, not to narrow the result.
   */
  listDirectMessages(
    projectId: ProjectId,
    viewerId: string,
    otherId: string,
    filter?: DirectMessageFilter,
  ): Promise<DirectMessage[]>;
  /**
   * Everyone the viewer has a conversation with, most recently active first.
   *
   * Only correspondents with at least one message: a roster of people who
   * *could* be written to is a different question, answered from membership,
   * and mixing the two would make an empty inbox look like a contact list.
   */
  listDirectConversations(
    projectId: ProjectId,
    viewerId: string,
  ): Promise<DirectConversation[]>;
  /**
   * Marks what the viewer has now seen, returning how many rows changed.
   *
   * Only messages addressed *to* the viewer can be marked: reading your own
   * message is not an event, and letting a sender mark their own would zero
   * the recipient's badge from the wrong side.
   */
  markDirectMessagesRead(
    projectId: ProjectId,
    viewerId: string,
    otherId: string,
    at: string,
  ): Promise<number>;
  listChannelAgentOverrides(
    repositoryId: string,
  ): Promise<Record<string, ChannelAgentOverride>>;
  setChannelAgentOverride(
    repositoryId: string,
    agentId: string,
    patch: { name?: string; role?: string; model?: string; effort?: string },
  ): Promise<ChannelAgentOverride>;
  /** Every (user, provider) that is currently an opted-in member of this channel. */
  listChannelAgentMembers(
    repositoryId: string,
  ): Promise<Array<{ userId: string; provider: string }>>;
  /** Adds or removes one (repository, user, provider) membership row. */
  setChannelAgentMember(
    repositoryId: string,
    userId: string,
    provider: string,
    isMember: boolean,
  ): Promise<void>;
  /**
   * Whether the one-time grandfather backfill (see `channelAgentConnections`
   * in server.ts) has already populated this repository's membership rows
   * from whatever was visible before membership was opt-in. Checked and set
   * per repository — not globally — so a repository created after this
   * feature shipped is never backfilled and starts with no members.
   */
  hasBackfilledChannelMembership(repositoryId: string): Promise<boolean>;
  markChannelMembershipBackfilled(repositoryId: string): Promise<void>;
  markChannelRead(
    repositoryId: string,
    userId: UserId,
    at: string,
  ): Promise<void>;
  getChannelReadCursor(
    repositoryId: string,
    userId: UserId,
  ): Promise<string | undefined>;

  /** How far this repository's auditor has already looked. */
  getAuditorCursor(repositoryId: string): Promise<AuditorCursor | undefined>;
  /**
   * Records progress. Leaves `paused` alone: an audit finishing must not
   * switch auditing back on underneath somebody who just switched it off.
   */
  saveAuditorCursor(
    cursor: Omit<AuditorCursor, "paused">,
  ): Promise<void>;
  /**
   * Switches auditing off or on, leaving the position alone so a resume
   * audits the gap rather than starting over.
   */
  setAuditorPaused(repositoryId: string, paused: boolean): Promise<void>;

  close(): Promise<void>;
}
