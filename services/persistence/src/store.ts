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

export interface StoredRepository {
  id: string;
  path: string;
  branch: string;
  provider?: "local" | "git" | "github";
  remoteUrl?: string;
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

export interface UserAccount {
  id: UserId;
  email: string;
  displayName: string;
  passwordDigest: string;
  systemAdmin: boolean;
  disabled: boolean;
  createdAt: string;
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
  userId: UserId;
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
}

export interface SubmittedTask {
  id: TaskId;
  repositoryId: string;
  projectId: ProjectId | undefined;
  objective: string;
  agentId: string;
  validationCommands: ValidationCommand[];
  submittedBy: UserId | undefined;
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
    name: string;
    adapters: string[];
    version: string;
  }): Promise<WorkerRecord>;
  listWorkers(): Promise<WorkerRecord[]>;
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
  /** Removes a repository registration only when no task or run references it. */
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

  close(): Promise<void>;
}
