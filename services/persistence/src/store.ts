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
  /**
   * What people call this repository, when they have renamed it.
   *
   * The id stays the handle: it keys every row that references a repository
   * and names the mirror directory on disk, so renaming it would be a
   * migration rather than an edit. A display name is the part somebody
   * actually wanted to change, and absent means "call it by its id".
   */
  displayName?: string;
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
  /**
   * Access to this repository that costs nobody anything, and that stands on
   * its own regardless of what the owning organization's subscription says.
   *
   * The deployment's operators hand these out: somebody they invited to one
   * repository gets full use of that repository without paying and without
   * the organization paying for them. It is deliberately the narrowest thing
   * that can be given away — one person, one repository — because a comp that
   * reached the whole organization would be giving away every repository it
   * has, including ones that do not exist yet.
   */
  comped: boolean;
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
  /**
   * Whether accepting this creates a seat nobody is charged for.
   *
   * Decided when the link is made, not when it is used, so the answer cannot
   * change under the recipient between clicking and joining — and so that a
   * link handed out as free stays free even if the person who made it later
   * stops being able to make free ones.
   */
  comped: boolean;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | undefined;
  acceptedBy: UserId | undefined;
  revokedAt: string | undefined;
}

/**
 * A pending password reset.
 *
 * Modelled on `InvitationRecord`: the link's secret is stored only as a hash,
 * so a readable table is a list of dead links rather than a list of working
 * ones. `email` is a copy of the address the link was sent to, kept so a reset
 * that arrives after the account changed address can be refused rather than
 * quietly resetting a mailbox that is no longer proof of anything.
 */
export interface PasswordResetRecord {
  id: string;
  userId: UserId;
  email: string;
  secretHash: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | undefined;
}

/**
 * Somebody who is partway through a paid sign-up.
 *
 * Deliberately not an account, and deliberately holding no secret worth
 * stealing. There is no password here: the card is taken before any details
 * are, so a name and a password are only ever collected once the payment has
 * cleared, and they go straight into the account rather than through this
 * table. An abandoned checkout therefore leaves a row that names an
 * organization nobody made and an email nobody claimed.
 *
 * The organization id is minted when the intent is written rather than when
 * the organization is created, so it can be stamped into Stripe's metadata at
 * checkout. Every later event — an invoice three months from now — then names
 * an organization that exists, with no lookup table and no metadata written
 * back.
 */
export interface SignupIntentRecord {
  id: string;
  /** Minted now, created once payment clears, named by Stripe in between. */
  organizationId: string;
  /** Collected before checkout so a duplicate is caught before any charge. */
  email: string;
  organizationName: string | undefined;
  /** The claim link's secret, hashed the way a password reset's is. */
  secretHash: string;
  stripeSessionId: string | undefined;
  /** Set once the account exists, so finishing twice cannot make two. */
  userId: string | undefined;
  createdAt: string;
  expiresAt: string;
  /** Set when payment provisioned the organization. */
  completedAt: string | undefined;
}

/**
 * Somebody who asked to be let in, while nobody is being let in automatically.
 *
 * Not an account and not a credential: an address, a name if they gave one,
 * and a note. Nothing here can be signed in to, so the table is a list of
 * people to contact rather than a list of ways in — which is what makes it
 * safe to fill from an unauthenticated form.
 *
 * `invitedAt` is the only state it has. Unset means waiting; set means
 * somebody who runs the deployment has decided this address may create an
 * account, and it is what the registration route reads before it builds one.
 * Kept rather than deleted on approval so the list stays a record of who was
 * let in and when, which is the question an operator actually asks of it.
 */
export interface WaitlistEntry {
  id: string;
  /** Lowercased on the way in, so one person cannot hold two places. */
  email: string;
  displayName: string | undefined;
  note: string | undefined;
  /** Where they came from — the marketing page, the app, an operator. */
  source: string | undefined;
  createdAt: string;
  invitedAt: string | undefined;
}

export interface UserAppearance {
  accent?: string;
  /**
   * The second interface colour, used where a surface needs to be marked
   * without competing with the primary — see `--accent-2` in `styles.css`.
   * Personal, like `accent`, and absent until somebody picks one.
   */
  accentSecondary?: string;
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
  /**
   * A seat that carries no charge — an invitation from whoever runs the
   * deployment, rather than one the organization bought.
   *
   * On the membership rather than on the user: the same person can be a paid
   * seat in one organization and a comped one in another, and which they are
   * is a fact about the pair.
   */
  comped: boolean;
  createdAt: string;
}

/**
 * What an organization is entitled to.
 *
 * `comped` never expires and is what every organization that predates billing
 * holds. `trialing` is the fourteen days a new organization gets before it has
 * to decide. `active` is a paid subscription; `past_due` is one whose payment
 * failed but whose grace has not run out; `canceled` is one that has stopped.
 *
 * Only the first three permit work — see `subscriptionAllowsWork` in the
 * gateway, which is the single place that judgement is made.
 */
export type SubscriptionStatus =
  | "comped"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled";

export interface Subscription {
  organizationId: string;
  status: SubscriptionStatus;
  /** When the trial runs out, for `trialing` only. */
  trialEndsAt?: string;
  /** What the current paid period is good through, for `active`/`past_due`. */
  currentPeriodEnd?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  createdAt: string;
  updatedAt: string;
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
 *
 * `open` is the one non-terminal ending: a conversational task whose turn
 * landed and whose thread is waiting for the next message — see
 * docs/architecture/conversational-tasks.md. Not `claimed`, because nothing
 * holds it right now; not terminal, because a reply continues it. It leaves
 * `open` when the next turn is submitted (superseded, `integrated`), when
 * somebody ends the conversation (`cancelled`), or when the silence outlasts
 * {@link CoordinationStore.expireOpenTasks}'s cutoff (`integrated` — the
 * work landed; only the waiting is over).
 */
export type SubmittedTaskStatus =
  | "submitted"
  | "claimed"
  /**
   * Planned, and waiting on a person before it may run.
   *
   * Distinct from `submitted` because that status means "queued to run", and
   * every lease query is written against it. A `/plan` task parked as
   * `submitted` was picked up by the next unrelated dispatch in the same
   * repository — `leaseNextTask` takes the oldest queued row, not the one the
   * caller had in mind — so work a person had explicitly not approved ran
   * anyway, on their credential. Held work is a different thing from queued
   * work and now says so.
   */
  | "planned"
  /**
   * Stopped by a person who means to continue it.
   *
   * Non-terminal, like `planned`, and for the same reason: no lease query
   * mentions it, so a paused row cannot be picked up by the next dispatch in
   * the repository. It differs from `planned` in where it came from — held
   * work never started, paused work did and is being kept mid-flight, with
   * its conversation session and workspace retained so resuming continues
   * rather than restarts. It leaves `paused` only through
   * {@link CoordinationStore.resumePausedTask} (back to `submitted`) or an
   * ordinary cancel.
   */
  | "paused"
  | "open"
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
   * A task which must stop being active before this one may be leased.
   * Used by explicit follow-up queues; absent tasks and terminal tasks do
   * not block the new work.
   */
  afterTaskId?: TaskId;
  /**
   * Atomically choose {@link afterTaskId} as this agent owner's latest
   * submitted or claimed task. Explicit `afterTaskId` wins when both exist.
   */
  queueAfterCurrent?: boolean;
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
  /**
   * The conversation this task is one turn of — in practice the thread root
   * message id, which is the one identity every turn of a thread shares.
   *
   * Submitting a turn settles the conversation's previous turn: any task of
   * this conversation still `open` becomes `integrated`, because its work
   * already landed and the thing it was waiting for has now arrived. That
   * keeps "at most one open turn per conversation" true by construction
   * rather than by every caller remembering to close the last one.
   */
  conversationId?: string;
  /**
   * File this task as `planned` rather than `submitted`: intent recorded, and
   * nothing may run it until a person releases it.
   *
   * Set at insert rather than by holding the row afterwards, because the gap
   * between the two is exactly long enough for another dispatch's
   * `runRepository` to lease it.
   */
  planOnly?: boolean;
  /**
   * What this one task should run with, overriding the agent's configured
   * default. Set by a channel that has picked a model or a reasoning level
   * for the agent it is talking to.
   *
   * Advisory in the sense that an adapter which cannot honour it says so at
   * launch — `effort` is Claude and Codex only, and a model name is whatever
   * the vendor CLI accepts — but it is not silently dropped, which is what
   * happened while these lived only on the channel row.
   */
  model?: string;
  effort?: string;
}

export interface SubmittedTask {
  id: TaskId;
  repositoryId: string;
  projectId: ProjectId | undefined;
  objective: string;
  agentId: string;
  validationCommands: ValidationCommand[];
  submittedBy: UserId | undefined;
  /** See {@link SubmitTaskInput.afterTaskId}. */
  afterTaskId: TaskId | undefined;
  /** See {@link SubmitTaskInput.context}. Absent on everything submitted outside a thread. */
  context: string | undefined;
  /** See {@link SubmitTaskInput.conversationId}. Absent on one-shot tasks. */
  conversationId: string | undefined;
  /** Per-task overrides of the agent's configured model / reasoning level. */
  model: string | undefined;
  effort: string | undefined;
  status: SubmittedTaskStatus;
  submittedAt: string;
  claimedAt: string | undefined;
  completedAt: string | undefined;
  /** When the task went `open`, for the abandonment sweep. */
  openedAt: string | undefined;
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
  /**
   * `agent_replan` is the agent deciding its own approved plan was the wrong
   * one, which is a different thing from the three that came before it: those
   * are all the coordinator revising a plan in response to something that
   * happened *to* the task.
   */
  reason:
    | "initial"
    | "canonical_change"
    | "scope_change"
    /** The agent handing part of its plan back, the inverse of a widening. */
    | "scope_release"
    | "agent_replan";
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
  /**
   * Cache-adjusted input plus output; absent for legacy/aggregate reporters.
   *
   * Replaced, not merged, on a repeat report of the same key. Reports carry a
   * running total, so a fresh figure kept from an earlier snapshot would sit
   * beside a total that has since grown and quietly undercount; leaving it
   * absent means "this reporter is not splitting cache out", which is what
   * the room's activity line needs to know.
   */
  freshTokens?: number;
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
  freshTokens: number | undefined;
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
  requiredRole: "admin" | "owner";
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
 * `plan` is the deep plan a `/plan` task produces before anything runs. It is
 * marked rather than left as an `agent` reply because it is not a thing said
 * in a conversation: it is a document, several hundred words of it, and a
 * thread that inlines it is a thread nobody can read the rest of. The mark is
 * what lets the browser show it as a card in the thread and open the document
 * itself in its own panel beside the room.
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
  | "outcome"
  | "plan";

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
  /** The root or reply in this thread that this reply directly answers. */
  referencedMessageId?: string;
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
  /**
   * The sub-channel this message was posted in.
   *
   * Every repository has at least a `#general` (see
   * {@link GENERAL_SUB_CHANNEL_SLUG}), and the `repository-sub-channels`
   * migration moved every pre-existing message into it, so this is always
   * set on a row read back from the store even though writers may leave it
   * out and let the store resolve `#general`.
   */
  channelId: string;
  projectId: ProjectId;
  kind: ChannelEntryKind;
  authorId: string;
  content: string;
  createdAt: string;
  /**
   * The earlier channel root this message is answering, when it is an
   * agent-authored response rather than a new topic.
   *
   * Kept on the root instead of represented as a thread reply: task threads
   * still narrate work, while this link preserves the ordinary chronological
   * transcript and gives the response a way back to what prompted it.
   */
  referencedMessageId?: string;
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
  /** When somebody pinned this message to the channel's banner, if anyone has. */
  pinnedAt: string | undefined;
  /**
   * Who pinned it. Anyone who can view the channel may pin, and anyone may
   * unpin — a pin is shared attention, not moderation — so this is a record
   * of who flagged it, not a lock on who may clear it.
   */
  pinnedBy: UserId | undefined;
  /**
   * When this thread's task was given its ending outside the thread.
   *
   * A quick task ends as its own line in the channel rather than as a reply,
   * which leaves the root looking like a thread that was never finished. This
   * says otherwise, so the sweep that closes threads orphaned by a restart
   * does not paste a second, canned ending under work that already reported.
   */
  endedAt: string | undefined;
  /**
   * When this message was deleted in place, leaving a tombstone behind.
   *
   * Only set on a root that still holds replies: removing such a row would
   * take an agent's whole account of a task with it, so the words go and the
   * thread stays. A message nobody has replied to is deleted outright and is
   * simply absent, which is why this is undefined far more often than not.
   */
  deletedAt?: string;
  /** Who deleted it. Present exactly when {@link deletedAt} is. */
  deletedBy?: string;
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
  /**
   * Which sub-channel to post into.
   *
   * Optional so every internal writer that predates sub-channels keeps
   * working unchanged: left out, the store posts into the sub-channel of
   * {@link referencedMessageId} when there is one — an agent's answer belongs
   * beside the question — and otherwise into the repository's `#general`.
   */
  channelId?: string;
  projectId: ProjectId;
  kind?: ChannelEntryKind;
  authorId: string;
  content: string;
  /**
   * A channel root this internally-authored message answers.
   *
   * The target must exist in the same repository. This is intentionally an
   * internal store input rather than part of the public channel POST body.
   */
  referencedMessageId?: string;
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
  referencedMessageId?: string;
}

export interface ChannelMessageFilter {
  /** Exclusive cursor: only messages created strictly before this ISO time. */
  before?: string;
  limit?: number;
  /**
   * Narrow to one sub-channel.
   *
   * Absent means the whole repository, which is what every reader meant
   * before sub-channels existed and what the task narrator and the socket
   * fan-out still mean. The HTTP surface always names one.
   */
  channelId?: string;
}

/**
 * How much has been said in one channel, counted rather than paged.
 *
 * `messages` is roots, `replies` is every line under them. Both are the whole
 * room's totals: a stat that stopped at whatever one page can hold would be a
 * different number from the one the room actually has, and the popover reads
 * as an exact figure.
 */
export interface ChannelMessageCounts {
  messages: number;
  replies: number;
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
  /** The earlier message this one answers, when it is a direct reply. */
  referencedMessageId?: string;
  /** When the recipient read it. Absent while it is still unread. */
  readAt?: string;
}

export interface AppendDirectMessageInput {
  projectId: ProjectId;
  authorId: string;
  recipientId: string;
  content: string;
  referencedMessageId?: string;
}

/** One correspondent and the state of that conversation, for the inbox. */
export interface DirectConversation {
  /** The other person, from the asking viewer's side. */
  userId: string;
  lastMessage: DirectMessage;
  /** Messages the viewer has not read yet. */
  unread: number;
}

/**
 * The last time a viewer was shown what changed in a project.
 *
 * One row per person per project: the catch-up is a personal thing, and
 * nothing about it is shared with the rest of the team.
 */
export interface CatchUpCursor {
  projectId: ProjectId;
  userId: UserId;
  seenAt: string;
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
 * The name one account's agent answers to everywhere — its call sign.
 *
 * Handed out once, when the account connects (`assignCallSign` in
 * `apps/web/src/providers.ts`), and deliberately *not* per channel: the same
 * agent is the same Athena in every room.
 *
 * It lives here, in the coordination store, rather than only in the control
 * plane's local `secrets/provider-connections.json`. That file is beside the
 * credentials on the control plane's own disk, so a deployment whose
 * filesystem does not outlive a restart came back with every name gone and
 * every roster reading "Claude (Nathan)" again — the vendor-label fallback —
 * even though the database still held every channel, message and override.
 * A name people have learned belongs with the rest of the durable state.
 */
export interface AgentCallSign {
  userId: string;
  /** A chat provider id, such as "anthropic", "cursor", or "google". */
  provider: string;
  callSign: string;
  assignedAt: string;
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
  /** The sub-channel the agent is assigned to. */
  channelId: string;
  userId: string;
  provider: string;
}

/**
 * Whether a sub-channel is listed to everyone in the project or only to the
 * people in it.
 *
 * `open` is Slack's public channel: anybody who can see the repository sees
 * it in the list and can read what is said there, but only members may post.
 * `private` is stronger than "not allowed": a non-member is not told it
 * exists at all, so reads and writes answer 404 rather than 403 — a 403
 * discloses the name of a room somebody deliberately kept off the list.
 */
/**
 * Who can find a room, read it, and speak in it.
 *
 * Three states rather than two, because "can I see this conversation" and
 * "may I join it" are separate questions and only one of them was being
 * asked. `open` answers the first and refuses the second, which is the right
 * shape for a room a team wants read over its shoulder — and the wrong one
 * for a room anybody should be able to walk into.
 *
 * - `private`  — absent for a non-member. Not listed, not readable, and a
 *   request for it answers 404 rather than 403, so its existence is not
 *   disclosed by the refusal.
 * - `open`     — listed and readable by everybody in the project; only
 *   members post. The read-over-your-shoulder room.
 * - `public`   — listed, readable, and postable by everybody in the project.
 *   Membership still exists and still means something elsewhere (it is what
 *   a mention roster and an unread cursor hang off), but it is not a gate.
 *
 * Stored as plain text with no CHECK constraint in either SQL backend, so a
 * fourth state would need no migration either.
 */
export type SubChannelVisibility = "open" | "private" | "public";

/** The slug every repository's default sub-channel is created under. */
export const GENERAL_SUB_CHANNEL_SLUG = "general";

/**
 * One room inside a repository's channel.
 *
 * A repository used to be a channel outright — `ChannelMessage` was keyed on
 * `repositoryId` alone. This is the level beneath that: the repository is the
 * workspace, and the conversation inside it is divided the way Slack or
 * Discord divides a server. Every repository has a `#general` that everybody
 * in the project belongs to, so a deployment that never adds a second
 * sub-channel behaves exactly as it did before.
 */
export interface SubChannel {
  id: string;
  repositoryId: string;
  projectId: ProjectId;
  /** The `#name` handle, lowercase and hyphenated, unique per repository. */
  slug: string;
  /** What an admin typed. Defaults to the slug. */
  name: string;
  visibility: SubChannelVisibility;
  createdAt: string;
  createdBy?: string;
}

/** One person's membership of one sub-channel. */
export interface SubChannelMember {
  channelId: string;
  userId: string;
  addedAt: string;
}

export interface CreateSubChannelInput {
  repositoryId: string;
  projectId: ProjectId;
  slug: string;
  name?: string;
  visibility?: SubChannelVisibility;
  createdBy?: string;
}

export interface UpdateSubChannelInput {
  slug?: string;
  name?: string;
  visibility?: SubChannelVisibility;
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
    /**
     * The id to create it under, when the caller has already committed to one.
     *
     * A paid sign-up mints the organization id before the organization, so it
     * can be stamped into Stripe's metadata at checkout — which is what makes
     * every later event about that subscription attributable without a lookup
     * table. Omitted, one is generated as before.
     */
    id?: string;
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
    /** Omitted keeps whatever the existing row says, or false for a new one. */
    comped?: boolean;
  }): Promise<OrganizationMembership>;
  removeMembership(organizationId: string, userId: UserId): Promise<void>;
  listMemberships(
    organizationId: string,
  ): Promise<OrganizationMembership[]>;
  getMembership(
    organizationId: string,
    userId: UserId,
  ): Promise<OrganizationMembership | undefined>;

  /**
   * What an organization is entitled to, or undefined for one that predates
   * the subscriptions table and was never backfilled.
   *
   * Callers treat undefined as "no entitlement recorded" rather than as
   * permission: an organization the gate cannot find an answer for is not one
   * it may quietly wave through.
   */
  getSubscription(organizationId: string): Promise<Subscription | undefined>;
  saveSubscription(input: {
    organizationId: string;
    status: SubscriptionStatus;
    trialEndsAt?: string;
    currentPeriodEnd?: string;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
  }): Promise<Subscription>;

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

  /**
   * Runs a body with every write inside one transaction.
   *
   * The store had no way to compose one. Transactions existed in both SQL
   * backends and were private to single methods, so anything built from
   * several calls — creating an account is five — was five separate commits
   * with no rollback between them. A failure partway left the earlier ones
   * durable, which is how a sign-up came to leave a user row that could sign
   * in and belonged to nothing.
   *
   * The body is handed the same store back. Calls made on it inside the body
   * join the transaction; a call made on any other reference does not, so
   * take the argument rather than closing over the outer store.
   *
   * Nesting joins rather than throwing, so a composite method that opens its
   * own transaction is safe to call from inside a body. Rollback then belongs
   * to the outermost call, which is the only one that can honour it.
   *
   * The in-memory store keeps this contract by snapshotting, which is
   * sufficient for a single process and is not durable — it is a test and
   * local-development backend, and this does not change that.
   */
  runInTransaction<T>(body: (store: CoordinationStore) => Promise<T>): Promise<T>;

  /**
   * Records a place in the queue, or refreshes one that already exists.
   *
   * Upsert rather than insert: somebody who fills the form twice is one
   * person who did not hear back, not an error worth showing them, and their
   * second attempt usually carries the better note. `createdAt` and
   * `invitedAt` survive the refresh — where they are in the queue is not
   * something re-asking should move, in either direction.
   */
  createWaitlistEntry(entry: WaitlistEntry): Promise<WaitlistEntry>;
  /** The place this address holds, if it holds one. Matched case-insensitively. */
  getWaitlistEntryByEmail(email: string): Promise<WaitlistEntry | undefined>;
  /** Everybody waiting, oldest first, so the queue reads as a queue. */
  listWaitlistEntries(): Promise<WaitlistEntry[]>;
  /**
   * Lets one address through, and says whether this caller is who did it.
   *
   * Conditional on still waiting, like {@link completeSignupIntent}: two
   * operators pressing approve on the same row should send one welcome, not
   * two.
   */
  markWaitlistEntryInvited(id: string, at: string): Promise<boolean>;
  /** Removes a place entirely — a duplicate, or somebody who asked to go. */
  deleteWaitlistEntry(id: string): Promise<void>;

  createSignupIntent(intent: SignupIntentRecord): Promise<void>;
  getSignupIntent(id: string): Promise<SignupIntentRecord | undefined>;
  /** The sign-up that minted an organization id, for the webhook that lands. */
  getSignupIntentByOrganization(
    organizationId: string,
  ): Promise<SignupIntentRecord | undefined>;
  /**
   * Marks an intent provisioned, and says whether this caller is the one that
   * did it.
   *
   * Conditional on still being open, like {@link consumePasswordReset}: Stripe
   * redelivers, and `checkout.session.completed` can arrive after
   * `customer.subscription.created` has already provisioned from the same
   * intent. Whichever gets here second is told `false` and does nothing —
   * which is what stops a retry sending a second welcome email.
   */
  completeSignupIntent(id: string, at: string): Promise<boolean>;
  /** Records the account a finished sign-up created, once. */
  attachSignupIntentUser(id: string, userId: UserId): Promise<boolean>;
  /** Sweeps abandoned checkouts; nothing was created, so nothing is lost. */
  deleteExpiredSignupIntents(before: string): Promise<void>;

  createPasswordReset(reset: PasswordResetRecord): Promise<void>;
  getPasswordReset(id: string): Promise<PasswordResetRecord | undefined>;
  /** Marks it used. Returns false when it was already used. */
  consumePasswordReset(id: string, at: string): Promise<boolean>;
  /**
   * Drops every outstanding reset for one account.
   *
   * Called when a reset succeeds and when the password changes by any other
   * route, so a link that was requested and then superseded cannot be used to
   * take an account back after its owner has recovered it.
   */
  deletePasswordResetsForUser(userId: UserId): Promise<void>;

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
  /**
   * Sets or clears a repository's display name.
   *
   * Separate from {@link CoordinationStore.saveRepository} because that one
   * is first-insert-wins on every backend — a resubmission must not move what
   * is already recorded — so it cannot express an edit. Passing `undefined`
   * puts the repository back to being called by its id.
   */
  renameRepository(id: string, displayName: string | undefined): Promise<void>;
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
  /**
   * Parks live or queued work as `paused`, because a person means to come
   * back to it.
   *
   * The reversible sibling of {@link cancelSubmittedTask}, and guarded the
   * same way: only work that has not settled can be paused. `planned` and
   * `open` are excluded deliberately — a held plan and a waiting conversation
   * are already stopped, and offering to pause them would be offering to do
   * nothing.
   *
   * Returns undefined rather than throwing when the row is not pausable, so
   * a pause racing a task's own ending is answered as "it already finished"
   * instead of as an error. Nothing else about the row moves: `completedAt`
   * stays unset, because a paused task has not completed.
   */
  pauseSubmittedTask(taskId: TaskId): Promise<SubmittedTask | undefined>;
  /**
   * Puts a `paused` task back in the queue, because a person said continue.
   *
   * Modelled on {@link releasePlannedTask}, including its undefined return:
   * the status test and the write are one step, so two resumes racing produce
   * one queued task rather than two runs of the same work.
   */
  resumePausedTask(taskId: TaskId): Promise<SubmittedTask | undefined>;
  /**
   * Releases a `planned` task into the queue, because a person said go.
   *
   * Returns undefined when the task is not held — already released, already
   * running, gone — so an approval arriving twice, or arriving for work that
   * was never held, is answered as ordinary conversation rather than starting
   * something a second time. The status test and the write are one step for
   * the same reason: two "go ahead"s racing must produce one run.
   */
  releasePlannedTask(taskId: TaskId): Promise<SubmittedTask | undefined>;
  completeSubmittedTask(
    taskId: TaskId,
    status: SubmittedTaskCompletionStatus,
    runId?: string,
  ): Promise<void>;
  /**
   * Marks a claimed conversational task `open`: its turn landed, and its
   * thread is waiting for the next message.
   *
   * The non-terminal sibling of {@link completeSubmittedTask}, guarded the
   * same way — only a claimed task can settle, however it settles. An open
   * task is not claimable; the next turn arrives as its own submitted task
   * carrying the same conversation id, which supersedes this one.
   */
  openSubmittedTask(taskId: TaskId, runId?: string): Promise<void>;
  /**
   * Ends open conversations whose silence has outlasted the cutoff.
   *
   * The doc's "the ordinary case of nobody replying". Between turns no lease
   * is active and no process is ticking, so open tasks need their own
   * sweep — modelled on the opportunistic expiry every lease path performs.
   * Expired tasks become `integrated`: the work landed; only the waiting is
   * over. Returns what expired, so a caller can also release whatever it is
   * holding for those conversations.
   */
  expireOpenTasks(
    cutoff: string,
    filter?: { repositoryId?: string },
  ): Promise<SubmittedTask[]>;

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
  /**
   * The workspace a task is editing, if one is recorded.
   *
   * Used to read a holder's in-progress edits while another task waits on it.
   * When several rows exist for the same task, the newest by `createdAt` wins.
   */
  findWorkspaceByTaskId(taskId: TaskId): Promise<StoredWorkspace | undefined>;
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
  /**
   * Exact root and reply totals for one channel.
   *
   * Counted in the store rather than derived from {@link listChannelMessages},
   * whose 200-row page is a read cap and would silently turn any busier room's
   * figure into "200+". A count is cheap where the rows already are; carrying
   * them all into the gateway to measure their length is not.
   */
  countChannelMessages(
    repositoryId: string,
    channelId?: string,
  ): Promise<ChannelMessageCounts>;

  /**
   * The sub-channels inside one repository, `#general` first and the rest by
   * name. Every one of them, regardless of visibility — hiding a private room
   * from somebody who is not in it is the gateway's job, because only it
   * knows who is asking.
   */
  listSubChannels(repositoryId: string): Promise<SubChannel[]>;
  getSubChannel(
    repositoryId: string,
    channelId: string,
  ): Promise<SubChannel | undefined>;
  /**
   * The repository's `#general`, created if it is not there yet.
   *
   * Idempotent and safe to race: two callers asking at once get the same row
   * rather than two rooms with the same name. This is what makes every
   * message writer able to leave `channelId` out and still land somewhere
   * real.
   */
  ensureGeneralSubChannel(
    repositoryId: string,
    projectId: ProjectId,
  ): Promise<SubChannel>;
  createSubChannel(input: CreateSubChannelInput): Promise<SubChannel>;
  updateSubChannel(
    repositoryId: string,
    channelId: string,
    input: UpdateSubChannelInput,
  ): Promise<SubChannel>;
  /**
   * Removes a sub-channel and everything said in it.
   *
   * Refuses `#general`: it is the room every message written without a
   * destination falls back to, and a repository without one has nowhere to
   * put the next line.
   */
  deleteSubChannel(repositoryId: string, channelId: string): Promise<void>;
  listSubChannelMembers(channelId: string): Promise<SubChannelMember[]>;
  setSubChannelMember(
    channelId: string,
    userId: string,
    isMember: boolean,
  ): Promise<void>;
  isSubChannelMember(channelId: string, userId: string): Promise<boolean>;
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
   * Records that this thread's task was ended somewhere other than in it.
   *
   * Written by the narrator when a task finishes too small to deserve a
   * thread, so the ending goes into the channel as its own line. Without it
   * the root is indistinguishable from a thread whose watcher died, and the
   * orphan sweep gives it an ending it already has.
   */
  markChannelMessageEnded(
    repositoryId: string,
    messageId: string,
  ): Promise<void>;
  /**
   * Records which task a thread is the story of.
   *
   * Set after the request is posted because the task id does not exist until
   * submission returns. Attaching it here is what lets the thread and the work
   * be joined without the run still being in memory.
   */
  setChannelMessageTask(
    repositoryId: string,
    messageId: string,
    taskId: TaskId,
  ): Promise<void>;
  /**
   * Replaces what a message says, leaving everything else about it alone.
   *
   * For a line that has to exist before its final wording is known. Rewriting
   * in place keeps the message's identity, timestamp and thread intact.
   */
  setChannelMessageContent(
    repositoryId: string,
    messageId: string,
    content: string,
  ): Promise<void>;
  /**
   * Replaces what one reply says without moving it within its thread.
   *
   * The repository and root ids are part of the write boundary so a reply id
   * learned in one room cannot be used to change another room's history.
   */
  setChannelReplyContent(
    repositoryId: string,
    messageId: string,
    replyId: string,
    content: string,
  ): Promise<void>;
  /**
   * Whether another channel entry points at this message or reply.
   *
   * Editing is intentionally limited to words nobody (including an agent)
   * has answered yet. Keeping this lookup in the store grounds that rule in
   * durable conversation history rather than whichever page a browser has
   * loaded.
   */
  channelEntryHasDependents(
    repositoryId: string,
    entryId: string,
  ): Promise<boolean>;
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
   * Pins when unpinned, unpins when pinned. The reactions rule: anyone who
   * can view the channel may do either, and the pinner is recorded rather
   * than privileged.
   */
  toggleChannelMessagePin(
    repositoryId: string,
    messageId: string,
    userId: UserId,
  ): Promise<ChannelMessage>;
  /**
   * Every pinned message in one channel, oldest pin first.
   *
   * Its own read, unbounded by {@link listChannelMessages}'s 200-row page:
   * a pin exists precisely so a message survives the room moving on, and a
   * banner that lost pins because the room kept talking would be the exact
   * failure pinning exists to prevent.
   */
  listPinnedChannelMessages(
    repositoryId: string,
    viewerId: UserId,
    channelId?: string,
  ): Promise<ChannelMessage[]>;
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
  deleteChannelMessages(
    repositoryId: string,
    channelId?: string,
  ): Promise<number>;
  /**
   * Blanks a message in place, leaving its thread standing.
   *
   * The alternative to {@link deleteChannelMessage} for a root somebody has
   * already replied under: the replies are an agent's account of a task and
   * belong to the people who read them, not to whoever opened the thread, so
   * a request to unsay something takes the words and nothing else. Reactions
   * and the pin go with the content — both were attention paid to a line that
   * is no longer there — while replies, task link and position are untouched.
   */
  redactChannelMessage(
    repositoryId: string,
    messageId: string,
    input: { deletedAt: string; deletedBy: string },
  ): Promise<void>;
  /**
   * Removes one reply with its reactions, returning what went.
   *
   * A reply is a leaf: nothing hangs off it, so there is nothing a tombstone
   * would protect and it is removed outright. The returned row is what the
   * caller needs to have already checked who wrote it.
   */
  deleteChannelReply(
    repositoryId: string,
    messageId: string,
    replyId: string,
  ): Promise<ChannelReply | undefined>;

  appendDirectMessage(input: AppendDirectMessageInput): Promise<DirectMessage>;
  /** Replaces the sender's own direct message, returning the updated row. */
  updateDirectMessage(
    projectId: ProjectId,
    messageId: string,
    authorId: string,
    content: string,
  ): Promise<DirectMessage | undefined>;
  /**
   * Removes one direct message, and only if `authorId` is the one who sent
   * it.
   *
   * The check is here rather than at the caller because it is the whole of
   * the rule: private mail has no moderator, so the sender unsends and
   * nobody else can. Undefined when there was no such message of theirs to
   * remove — the same answer for "already gone" and "not yours", which is
   * the pair a probe would otherwise tell apart.
   */
  deleteDirectMessage(
    projectId: ProjectId,
    messageId: string,
    authorId: string,
  ): Promise<DirectMessage | undefined>;
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
  /**
   * Drops one agent's per-repository *names*, everywhere.
   *
   * An agent has one name, held on the account as its call sign, and renaming
   * it is meant to be visible in every repository at once. A per-repository
   * name row shadows that call sign wherever it exists
   * (`resolveChannelAgentPresentation` prefers the override), so a rename that
   * only wrote the call sign left the old name standing in every room the
   * agent had ever been renamed in. Clearing the shadows is what makes one
   * name mean one name.
   *
   * Roles, models and efforts are per-repository decisions and are deliberately
   * untouched: this clears the `name` column and nothing else, deleting a row
   * only when nothing else on it survives. `agentId` is the resolved
   * `${userId}:${provider}` form and only rows naming that one agent are
   * touched — a legacy bare-provider row names every agent on the vendor, so
   * clearing it here would rename somebody else's agent as a side effect of
   * renaming your own.
   */
  clearChannelAgentNameOverrides(agentId: string): Promise<void>;
  /**
   * Every agent name this deployment has handed out, across all accounts.
   *
   * Read whole rather than per user because both readers need it whole: the
   * roster resolves several people's agents at once, and handing out a new
   * name has to know which signs are already taken deployment-wide so two
   * agents in one room are not both Hermes.
   */
  listAgentCallSigns(): Promise<AgentCallSign[]>;
  /**
   * Records the name an account's agent answers to. Last write wins, which
   * is what renaming through the settings route means; callers that must not
   * rename (the automatic first naming) check for an existing row first.
   */
  setAgentCallSign(
    userId: string,
    provider: string,
    callSign: string,
  ): Promise<AgentCallSign>;
  /**
   * Forgets a name, so the agent falls back to its vendor label again. This
   * is what clearing the name in the connection's settings means; without it
   * a cleared name would reappear on the next restart, which is the same
   * complaint as a name that vanishes, pointed the other way.
   */
  clearAgentCallSign(userId: string, provider: string): Promise<void>;
  /** Every (user, provider) that is currently an opted-in member of this channel. */
  listChannelAgentMembers(
    repositoryId: string,
    channelId?: string,
  ): Promise<Array<{ userId: string; provider: string; channelId: string }>>;
  /**
   * Adds or removes one (channel, user, provider) membership row.
   *
   * `channelId` left out means the repository's `#general`, which is where
   * the pre-sub-channel rows were migrated to.
   */
  setChannelAgentMember(
    repositoryId: string,
    userId: string,
    provider: string,
    isMember: boolean,
    channelId?: string,
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
    channelId?: string,
  ): Promise<void>;
  getChannelReadCursor(
    repositoryId: string,
    userId: UserId,
    channelId?: string,
  ): Promise<string | undefined>;

  /**
   * Silences a channel for one person, or lets it speak again.
   *
   * Per person, never per room: a mute is somebody deciding they do not want
   * to be interrupted, not a property of the repository, so it must not reach
   * anybody else reading the same conversation. Unmuting removes the record
   * rather than storing a false — see the `channel-mutes` migration.
   */
  setChannelMuted(
    repositoryId: string,
    userId: UserId,
    muted: boolean,
  ): Promise<void>;
  /**
   * Every repository this person has muted, across all of them.
   *
   * Answered for the whole account rather than per repository so the browser
   * can learn which rooms are quiet in one call at start-up instead of one
   * call per channel in the list.
   */
  listMutedChannels(userId: UserId): Promise<string[]>;

  /**
   * How far a viewer has been caught up on one project's news.
   *
   * Separate from the channel read cursor rather than derived from it: that
   * one moves every time somebody glances at a room, while this one is the
   * mark the login catch-up is measured from, and a person who read one
   * channel on their phone has not thereby been told what the rest of the
   * project did.
   */
  getCatchUpCursor(
    projectId: ProjectId,
    userId: UserId,
  ): Promise<CatchUpCursor | undefined>;
  /**
   * Advances the mark, and only ever forward.
   *
   * Two tabs opening at once would otherwise race, and the loser would drag
   * the mark backwards and show the same news again on the next login.
   */
  markCatchUpSeen(
    projectId: ProjectId,
    userId: UserId,
    at: string,
  ): Promise<void>;

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
