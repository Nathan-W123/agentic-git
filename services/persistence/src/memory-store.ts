import {
  createId,
  planAdmissionApproved,
  type AgentPlan,
  type ApprovalDecision,
  type ApprovalRequest,
  type AuditEvent,
  type CanonicalVersion,
  type ChangeSet,
  type ConflictAssessment,
  type CoordinatorDecision,
  type IntegrationResult,
  type ProjectId,
  type ResourceLease,
  type ScopeChangeDecision,
  type ScopeChangeRequest,
  type SequencedAuditEvent,
  type TaskDefinition,
  type TaskId,
  type TaskStatus,
} from "@coord/shared-types";

import {
  GENESIS_HASH,
  chainHash,
  hashAuditPayload,
  segmentDigest,
  verifyArchivedChain,
  type ArchivedSegment,
  type AuditChainVerification,
  type AuditCheckpoint,
  type ChainedAuditEvent,
} from "./audit-chain.js";
import type {
  ApiTokenRecord,
  AppendAuditInput,
  LeaseTaskInput,
  LeasedWork,
  SaveWorkLeasePlanInput,
  SaveWorkLeasePlanResult,
  WorkLease,
  WorkLeaseStatus,
  WorkerRecord,
  AddChangesetCommentInput,
  AddChannelReplyInput,
  AppendChannelMessageInput,
  ApprovalFilter,
  ArchiveAuditInput,
  ChangesetComment,
  ChannelAgentMember,
  ChannelAgentOverride,
  ChannelEntryKind,
  ChannelMessage,
  ChannelMessageFilter,
  ChannelReaction,
  ChannelReply,
  AuditArchiveResult,
  AuditEventFilter,
  AuditorCursor,
  AuthSessionRecord,
  CoordinationStore,
  CreateApprovalInput,
  CreateRunInput,
  Organization,
  OrganizationMembership,
  OrganizationRole,
  ProjectRecord,
  RunDetail,
  RunStatus,
  SessionRecord,
  StoredPlanRevision,
  StoredRepository,
  StoredRun,
  StoredScopeChange,
  StoredTask,
  StoredWorkspace,
  SubmitTaskInput,
  SubmittedTask,
  SubmittedTaskCompletionStatus,
  SubmittedTaskFilter,
  RecordTokenUsageInput,
  TokenUsageFilter,
  TokenUsageRecord,
  InvitationRecord,
  RepositoryGrant,
  UserAccount,
  UserAppearance,
} from "./store.js";
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
  sameLeaseIdSet,
} from "./store.js";

interface RunState {
  run: StoredRun;
  tasks: Map<TaskId, StoredTask>;
  conflicts: ConflictAssessment[];
  changeSets: ChangeSet[];
  integrations: IntegrationResult[];
  leases: ResourceLease[];
  workspaces: StoredWorkspace[];
  planRevisions: StoredPlanRevision[];
  scopeChanges: StoredScopeChange[];
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

interface StoredChannelReply {
  id: string;
  messageId: string;
  kind: ChannelEntryKind;
  authorId: string;
  content: string;
  createdAt: string;
}

interface StoredChannelMessage {
  id: string;
  repositoryId: string;
  projectId: ProjectId;
  kind: ChannelEntryKind;
  authorId: string;
  content: string;
  createdAt: string;
  replies: StoredChannelReply[];
  /** Emoji to the set of user ids who reacted with it. */
  reactions: Map<string, Set<string>>;
}

/**
 * The filter predicate, shared by the live log and the archive so a query
 * cannot mean two different things depending on which side of a checkpoint an
 * event happens to sit.
 */
function matchesAuditFilter(
  entry: SequencedAuditEvent,
  filter: AuditEventFilter,
): boolean {
  return (
    (filter.runId === undefined || entry.runId === filter.runId) &&
    (filter.taskId === undefined || entry.event.taskId === filter.taskId) &&
    (filter.projectId === undefined ||
      entry.event.data["projectId"] === filter.projectId) &&
    (filter.types === undefined || filter.types.includes(entry.event.type)) &&
    (filter.occurredAfter === undefined ||
      entry.event.occurredAt >= filter.occurredAfter) &&
    (filter.occurredBefore === undefined ||
      entry.event.occurredAt < filter.occurredBefore)
  );
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
  /**
   * Monotonic, never derived from array length: archiving removes entries
   * from the front, and a length-based sequence would then reissue numbers
   * that the archive already holds.
   */
  private auditSequence = 0;
  private readonly auditCheckpoints: AuditCheckpoint[] = [];
  private readonly auditArchive: Array<{
    entry: ChainedAuditEvent;
    runId: string | undefined;
    checkpointId: string;
  }> = [];
  /** Run association per audit entry, parallel to {@link audit}. */
  private readonly auditRuns: Array<string | undefined> = [];

  private readonly repositories = new Map<string, StoredRepository>();
  private readonly submitted = new Map<TaskId, SubmittedTask>();
  private readonly organizations = new Map<string, Organization>();
  private readonly users = new Map<string, UserAccount>();
  private readonly memberships = new Map<string, OrganizationMembership>();
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly projectRepositories = new Set<string>();
  private readonly authSessions = new Map<string, AuthSessionRecord>();
  private readonly apiTokens = new Map<string, ApiTokenRecord>();
  /** Keyed by usage key so a re-reported running total replaces its predecessor. */
  private readonly tokenUsage = new Map<string, TokenUsageRecord>();
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly workLeases = new Map<string, WorkLease>();
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly comments = new Map<string, ChangesetComment>();
  private readonly channelMessages = new Map<string, StoredChannelMessage>();
  /** Keyed by `repositoryId\0agentId`. */
  private readonly channelAgentOverrides = new Map<string, ChannelAgentOverride>();
  /** Keyed by `repositoryId\0userId\0provider`. */
  private readonly channelAgentMembers = new Map<string, ChannelAgentMember>();
  /** Repository ids whose one-time membership backfill has already run. */
  private readonly channelMembershipBackfilled = new Set<string>();
  /** Keyed by `repositoryId\0userId`. */
  private readonly channelReadCursors = new Map<string, string>();
  private readonly auditorCursors = new Map<string, AuditorCursor>();

  public constructor() {
    const now = new Date().toISOString();
    this.organizations.set(DEFAULT_ORGANIZATION_ID, {
      id: DEFAULT_ORGANIZATION_ID,
      slug: "local",
      name: "Local Workspace",
      createdAt: now,
    });
    this.projects.set(DEFAULT_PROJECT_ID, {
      id: DEFAULT_PROJECT_ID,
      organizationId: DEFAULT_ORGANIZATION_ID,
      slug: "local",
      name: "Local Project",
      description: "Default project for CLI-created repositories",
      archived: false,
      policy: undefined,
      createdAt: now,
      updatedAt: now,
    });
  }

  public async createOrganization(input: {
    slug: string;
    name: string;
  }): Promise<Organization> {
    const slug = input.slug.trim().toLowerCase();
    if (
      [...this.organizations.values()].some(
        (organization) => organization.slug.toLowerCase() === slug,
      )
    ) {
      throw new Error(`Organization slug is already in use: ${slug}`);
    }
    const organization: Organization = {
      id: createId("org"),
      slug,
      name: input.name.trim(),
      createdAt: new Date().toISOString(),
    };
    this.organizations.set(organization.id, organization);
    return copy(organization);
  }

  public async updateOrganization(
    id: string,
    input: { name?: string; slug?: string },
  ): Promise<Organization> {
    const organization = this.requireOrganization(id);
    if (input.slug !== undefined) {
      const slug = input.slug.trim().toLowerCase();
      if (
        [...this.organizations.values()].some(
          (candidate) =>
            candidate.id !== id &&
            candidate.slug.toLowerCase() === slug,
        )
      ) {
        throw new Error(`Organization slug is already in use: ${slug}`);
      }
      organization.slug = slug;
    }
    if (input.name !== undefined) {
      organization.name = input.name.trim();
    }
    return copy(organization);
  }

  public async listOrganizations(userId?: string): Promise<Organization[]> {
    const allowed =
      userId === undefined
        ? undefined
        : new Set(
            [...this.memberships.values()]
              .filter((membership) => membership.userId === userId)
              .map((membership) => membership.organizationId),
          );
    return copy(
      [...this.organizations.values()]
        .filter((organization) => allowed?.has(organization.id) ?? true)
        .sort((left, right) => left.name.localeCompare(right.name)),
    );
  }

  public async getOrganization(id: string): Promise<Organization | undefined> {
    const organization = this.organizations.get(id);
    return organization === undefined ? undefined : copy(organization);
  }

  public async createUser(input: {
    email: string;
    displayName: string;
    passwordDigest: string;
    systemAdmin?: boolean;
  }): Promise<UserAccount> {
    const email = input.email.trim().toLowerCase();
    if (
      [...this.users.values()].some(
        (user) => user.email.toLowerCase() === email,
      )
    ) {
      throw new Error(`User email is already in use: ${email}`);
    }
    const user: UserAccount = {
      id: createId("user"),
      email,
      displayName: input.displayName.trim(),
      passwordDigest: input.passwordDigest,
      systemAdmin: input.systemAdmin ?? false,
      disabled: false,
      createdAt: new Date().toISOString(),
    };
    this.users.set(user.id, user);
    return copy(user);
  }

  public async updateUser(
    id: string,
    input: {
      displayName?: string;
      passwordDigest?: string;
      disabled?: boolean;
      systemAdmin?: boolean;
      appearance?: UserAppearance;
    },
  ): Promise<UserAccount> {
    const user = this.requireUser(id);
    if (input.appearance !== undefined) {
      user.appearance = input.appearance;
    }
    if (input.displayName !== undefined) {
      user.displayName = input.displayName.trim();
    }
    if (input.passwordDigest !== undefined) {
      user.passwordDigest = input.passwordDigest;
    }
    if (input.disabled !== undefined) {
      user.disabled = input.disabled;
    }
    if (input.systemAdmin !== undefined) {
      user.systemAdmin = input.systemAdmin;
    }
    return copy(user);
  }

  public async getUser(id: string): Promise<UserAccount | undefined> {
    const user = this.users.get(id);
    return user === undefined ? undefined : copy(user);
  }

  public async getUserByEmail(email: string): Promise<UserAccount | undefined> {
    const normalized = email.trim().toLowerCase();
    const user = [...this.users.values()].find(
      (candidate) => candidate.email.toLowerCase() === normalized,
    );
    return user === undefined ? undefined : copy(user);
  }

  public async listUsers(): Promise<UserAccount[]> {
    return copy(
      [...this.users.values()].sort((left, right) =>
        left.email.localeCompare(right.email),
      ),
    );
  }

  public async countUsers(): Promise<number> {
    return this.users.size;
  }

  public async saveMembership(input: {
    organizationId: string;
    userId: string;
    role: OrganizationRole;
  }): Promise<OrganizationMembership> {
    this.requireOrganization(input.organizationId);
    this.requireUser(input.userId);
    const key = this.membershipKey(input.organizationId, input.userId);
    const existing = this.memberships.get(key);
    const membership: OrganizationMembership = {
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.memberships.set(key, membership);
    return copy(membership);
  }

  public async removeMembership(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    this.memberships.delete(this.membershipKey(organizationId, userId));
  }

  public async listMemberships(
    organizationId: string,
  ): Promise<OrganizationMembership[]> {
    return copy(
      [...this.memberships.values()]
        .filter((membership) => membership.organizationId === organizationId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    );
  }

  public async getMembership(
    organizationId: string,
    userId: string,
  ): Promise<OrganizationMembership | undefined> {
    const membership = this.memberships.get(
      this.membershipKey(organizationId, userId),
    );
    return membership === undefined ? undefined : copy(membership);
  }

  public async createProject(input: {
    organizationId: string;
    slug: string;
    name: string;
    description?: string;
  }): Promise<ProjectRecord> {
    this.requireOrganization(input.organizationId);
    const slug = input.slug.trim().toLowerCase();
    this.assertProjectSlugAvailable(input.organizationId, slug);
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      id: createId("project"),
      organizationId: input.organizationId,
      slug,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      archived: false,
      policy: undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(project.id, project);
    return copy(project);
  }

  public async updateProject(
    id: string,
    input: {
      slug?: string;
      name?: string;
      description?: string;
      archived?: boolean;
      policy?: Record<string, unknown> | null;
    },
  ): Promise<ProjectRecord> {
    const project = this.requireProject(id);
    if (input.slug !== undefined) {
      const slug = input.slug.trim().toLowerCase();
      this.assertProjectSlugAvailable(project.organizationId, slug, id);
      project.slug = slug;
    }
    if (input.name !== undefined) {
      project.name = input.name.trim();
    }
    if (input.description !== undefined) {
      project.description = input.description.trim();
    }
    if (input.archived !== undefined) {
      project.archived = input.archived;
    }
    if (input.policy !== undefined) {
      project.policy =
        input.policy === null ? undefined : structuredClone(input.policy);
    }
    project.updatedAt = new Date().toISOString();
    return copy(project);
  }

  public async getProject(id: string): Promise<ProjectRecord | undefined> {
    const project = this.projects.get(id);
    return project === undefined ? undefined : copy(project);
  }

  public async listProjects(organizationId: string): Promise<ProjectRecord[]> {
    return copy(
      [...this.projects.values()]
        .filter((project) => project.organizationId === organizationId)
        .sort((left, right) => left.name.localeCompare(right.name)),
    );
  }

  public async linkRepository(
    projectId: string,
    repositoryId: string,
  ): Promise<void> {
    this.requireProject(projectId);
    if (!this.repositories.has(repositoryId)) {
      throw new Error(`Unknown repository: ${repositoryId}`);
    }
    this.projectRepositories.add(
      this.projectRepositoryKey(projectId, repositoryId),
    );
  }

  public async unlinkRepository(
    projectId: string,
    repositoryId: string,
  ): Promise<void> {
    this.projectRepositories.delete(
      this.projectRepositoryKey(projectId, repositoryId),
    );
  }

  public async listProjectRepositories(
    projectId: string,
  ): Promise<StoredRepository[]> {
    this.requireProject(projectId);
    return copy(
      [...this.repositories.values()]
        .filter((repository) =>
          this.projectRepositories.has(
            this.projectRepositoryKey(projectId, repository.id),
          ),
        )
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
  }

  public async projectHasRepository(
    projectId: string,
    repositoryId: string,
  ): Promise<boolean> {
    return this.projectRepositories.has(
      this.projectRepositoryKey(projectId, repositoryId),
    );
  }

  public async registerWorker(input: {
    userId: string;
    organizationId: string;
    name: string;
    adapters: string[];
    version: string;
  }): Promise<WorkerRecord> {
    this.requireUser(input.userId);
    if (!this.organizations.has(input.organizationId)) {
      throw new Error(`Unknown organization: ${input.organizationId}`);
    }
    const now = new Date().toISOString();
    const worker: WorkerRecord = {
      id: createId("worker"),
      userId: input.userId,
      organizationId: input.organizationId,
      name: input.name,
      adapters: [...input.adapters],
      version: input.version,
      registeredAt: now,
      lastSeenAt: now,
    };
    this.workers.set(worker.id, worker);
    return { ...worker, adapters: [...worker.adapters] };
  }

  public async listWorkers(filter?: {
    organizationId?: string;
  }): Promise<WorkerRecord[]> {
    return [...this.workers.values()]
      .filter(
        (worker) =>
          filter?.organizationId === undefined ||
          worker.organizationId === filter.organizationId,
      )
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .map((worker) => ({ ...worker, adapters: [...worker.adapters] }));
  }

  public async getWorker(id: string): Promise<WorkerRecord | undefined> {
    const worker = this.workers.get(id);
    return worker === undefined
      ? undefined
      : { ...worker, adapters: [...worker.adapters] };
  }

  public async touchWorker(id: string, at: string): Promise<void> {
    const worker = this.workers.get(id);
    if (worker !== undefined) {
      worker.lastSeenAt = at;
    }
  }

  public async leaseNextTask(
    input: LeaseTaskInput,
  ): Promise<LeasedWork | undefined> {
    if (!this.workers.has(input.workerId)) {
      throw new Error(`Unknown worker: ${input.workerId}`);
    }
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1) {
      throw new RangeError("Work lease TTL must be a positive integer");
    }
    if (input.baseRevision.trim().length === 0) {
      throw new Error("Work lease base revision must not be empty");
    }
    const parallelism = input.repositoryParallelism ?? 1;
    if (!Number.isSafeInteger(parallelism) || parallelism < 1) {
      throw new RangeError("Repository parallelism must be a positive integer");
    }

    const now = new Date();
    await this.expireWorkLeases(now.toISOString());

    // The parallelism cap bounds concurrent leases per repository; it is a
    // throughput valve, not the safety mechanism.
    const activeLeases = (repositoryId: string): number =>
      [...this.workLeases.values()].filter(
        (lease) =>
          lease.status === "active" && lease.repositoryId === repositoryId,
      ).length;

    // Single-threaded by construction here, but the ordering matches the
    // SQLite transaction so both backends behave identically.
    const candidate = [...this.submitted.values()]
      .filter(
        (task) =>
          task.status === "submitted" &&
          (input.taskId === undefined || task.id === input.taskId) &&
          (input.repositoryId === undefined ||
            task.repositoryId === input.repositoryId) &&
          (input.projectId === undefined || task.projectId === input.projectId) &&
          activeLeases(task.repositoryId) < parallelism,
      )
      .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt))[0];
    if (candidate === undefined) {
      return undefined;
    }

    const lease: WorkLease = {
      id: createId("lease"),
      taskId: candidate.id,
      workerId: input.workerId,
      repositoryId: candidate.repositoryId,
      projectId: candidate.projectId,
      status: "active",
      baseRevision: input.baseRevision,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      heartbeatAt: now.toISOString(),
      finishedAt: undefined,
      outcome: undefined,
      detail: undefined,
      plan: undefined,
    };
    candidate.status = "claimed";
    candidate.claimedAt = lease.issuedAt;
    this.workLeases.set(lease.id, lease);
    return { lease: { ...lease }, task: { ...candidate } };
  }

  public async getWorkLease(id: string): Promise<WorkLease | undefined> {
    const lease = this.workLeases.get(id);
    return lease === undefined ? undefined : { ...lease };
  }

  public async listWorkLeases(
    filter: {
      workerId?: string;
      status?: WorkLeaseStatus;
      projectId?: string;
      repositoryId?: string;
      issuedAfter?: string;
    } = {},
  ): Promise<WorkLease[]> {
    return [...this.workLeases.values()]
      .filter(
        (lease) =>
          (filter.workerId === undefined || lease.workerId === filter.workerId) &&
          (filter.status === undefined || lease.status === filter.status) &&
          (filter.projectId === undefined ||
            lease.projectId === filter.projectId) &&
          (filter.repositoryId === undefined ||
            lease.repositoryId === filter.repositoryId) &&
          (filter.issuedAfter === undefined ||
            lease.issuedAt > filter.issuedAfter),
      )
      .sort((left, right) => right.issuedAt.localeCompare(left.issuedAt))
      .map((lease) => ({ ...lease }));
  }

  public async saveWorkLeasePlan(
    input: SaveWorkLeasePlanInput,
  ): Promise<SaveWorkLeasePlanResult> {
    const lease = this.workLeases.get(input.leaseId);
    if (lease === undefined || lease.status !== "active") {
      return { outcome: "lease_lost" };
    }
    if (
      input.replaceApproved !== true &&
      lease.plan !== undefined &&
      planAdmissionApproved(lease.plan.admission)
    ) {
      return { outcome: "already_admitted", lease: structuredClone(lease) };
    }
    const approvedLeaseIds = this.approvedPlanLeaseIds(
      lease.repositoryId,
      lease.id,
    );
    if (!sameLeaseIdSet(approvedLeaseIds, input.observedApprovedLeaseIds)) {
      return { outcome: "stale", approvedLeaseIds };
    }
    lease.plan = structuredClone(input.submission);
    return { outcome: "saved", lease: { ...lease } };
  }

  /** Other active leases in one repository whose plan was admitted. */
  private approvedPlanLeaseIds(
    repositoryId: string,
    excludeLeaseId: string,
  ): string[] {
    return [...this.workLeases.values()]
      .filter(
        (candidate) =>
          candidate.id !== excludeLeaseId &&
          candidate.status === "active" &&
          candidate.repositoryId === repositoryId &&
          candidate.plan !== undefined &&
          planAdmissionApproved(candidate.plan.admission),
      )
      .map((candidate) => candidate.id)
      .sort();
  }

  public async heartbeatWorkLease(
    id: string,
    at: string,
    expiresAt: string,
  ): Promise<WorkLease | undefined> {
    const lease = this.workLeases.get(id);
    if (
      lease === undefined ||
      lease.status !== "active" ||
      lease.expiresAt <= at ||
      expiresAt <= at
    ) {
      return undefined;
    }
    lease.heartbeatAt = at;
    lease.expiresAt = expiresAt;
    return { ...lease };
  }

  public async finishWorkLease(
    id: string,
    status: Exclude<WorkLeaseStatus, "active">,
    at: string,
    detail?: string,
  ): Promise<boolean> {
    const lease = this.workLeases.get(id);
    const lapsed = lease !== undefined && lease.expiresAt <= at;
    if (
      lease === undefined ||
      lease.status !== "active" ||
      (status === "expired" ? !lapsed : lapsed)
    ) {
      return false;
    }
    lease.status = status;
    lease.finishedAt = at;
    lease.outcome = status;
    lease.detail = detail;

    if (status === "released" || status === "expired") {
      const task = this.submitted.get(lease.taskId);
      if (task !== undefined && task.status === "claimed") {
        task.status = "submitted";
        task.claimedAt = undefined;
      }
    }
    return true;
  }

  public async expireWorkLeases(now: string): Promise<WorkLease[]> {
    const expired = [...this.workLeases.values()].filter(
      (lease) => lease.status === "active" && lease.expiresAt <= now,
    );
    const settled: WorkLease[] = [];
    for (const lease of expired) {
      if (
        await this.finishWorkLease(lease.id, "expired", now, "lease expired")
      ) {
        settled.push(lease);
      }
    }
    return settled.map((lease) => ({ ...lease }));
  }

  public async recordTokenUsage(
    input: RecordTokenUsageInput,
  ): Promise<TokenUsageRecord> {
    const existing = this.tokenUsage.get(input.usageKey);
    const record: TokenUsageRecord = {
      id: existing?.id ?? createId("usage"),
      usageKey: input.usageKey,
      projectId: input.projectId,
      repositoryId: input.repositoryId,
      taskId: input.taskId,
      leaseId: input.leaseId,
      runId: input.runId,
      agentId: input.agentId,
      phase: input.phase,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      totalTokens: input.totalTokens,
      recordedAt: input.recordedAt,
    };
    this.tokenUsage.set(input.usageKey, record);
    return { ...record };
  }

  public async listTokenUsage(
    filter: TokenUsageFilter = {},
  ): Promise<TokenUsageRecord[]> {
    return [...this.tokenUsage.values()]
      .filter(
        (record) =>
          (filter.projectId === undefined ||
            record.projectId === filter.projectId) &&
          (filter.repositoryId === undefined ||
            record.repositoryId === filter.repositoryId) &&
          (filter.taskId === undefined || record.taskId === filter.taskId) &&
          (filter.leaseId === undefined || record.leaseId === filter.leaseId) &&
          (filter.recordedAfter === undefined ||
            record.recordedAt >= filter.recordedAfter),
      )
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
      .map((record) => ({ ...record }));
  }


  /* ------------------------------------------------------- invitations ---- */

  private readonly invitations = new Map<string, InvitationRecord>();


  /* -------------------------------------------------- repository grants ---- */

  private readonly grants = new Map<string, RepositoryGrant>();

  public async saveRepositoryGrant(grant: RepositoryGrant): Promise<void> {
    this.grants.set(`${grant.repositoryId}\u0000${grant.userId}`, { ...grant });
  }

  public async removeRepositoryGrant(
    repositoryId: string,
    userId: string,
  ): Promise<void> {
    this.grants.delete(`${repositoryId}\u0000${userId}`);
  }

  public async listRepositoryGrants(
    repositoryId: string,
  ): Promise<RepositoryGrant[]> {
    return [...this.grants.values()]
      .filter((grant) => grant.repositoryId === repositoryId)
      .map((grant) => ({ ...grant }));
  }

  public async listGrantsForUser(userId: string): Promise<RepositoryGrant[]> {
    return [...this.grants.values()]
      .filter((grant) => grant.userId === userId)
      .map((grant) => ({ ...grant }));
  }

  public async createInvitation(invitation: InvitationRecord): Promise<void> {
    this.invitations.set(invitation.id, { ...invitation });
  }

  public async getInvitation(id: string): Promise<InvitationRecord | undefined> {
    const found = this.invitations.get(id);
    return found === undefined ? undefined : { ...found };
  }

  public async listInvitations(
    organizationId: string,
  ): Promise<InvitationRecord[]> {
    return [...this.invitations.values()]
      .filter((entry) => entry.organizationId === organizationId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((entry) => ({ ...entry }));
  }

  public async acceptInvitation(
    id: string,
    userId: string,
    at: string,
  ): Promise<boolean> {
    const found = this.invitations.get(id);
    if (
      found === undefined ||
      found.acceptedAt !== undefined ||
      found.revokedAt !== undefined
    ) {
      return false;
    }
    found.acceptedAt = at;
    found.acceptedBy = userId;
    return true;
  }

  public async revokeInvitation(id: string, at: string): Promise<void> {
    const found = this.invitations.get(id);
    if (found !== undefined && found.revokedAt === undefined) {
      found.revokedAt = at;
    }
  }

  public async createApiToken(token: ApiTokenRecord): Promise<void> {
    this.requireUser(token.userId);
    if (token.organizationId !== undefined) {
      this.requireOrganization(token.organizationId);
    }
    this.apiTokens.set(token.id, { ...token, scopes: [...token.scopes] });
  }

  public async getApiToken(id: string): Promise<ApiTokenRecord | undefined> {
    const token = this.apiTokens.get(id);
    return token === undefined
      ? undefined
      : { ...token, scopes: [...token.scopes] };
  }

  public async listApiTokens(userId: string): Promise<ApiTokenRecord[]> {
    return [...this.apiTokens.values()]
      .filter((token) => token.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((token) => ({ ...token, scopes: [...token.scopes] }));
  }

  public async touchApiToken(
    id: string,
    at: string,
    ipAddress: string,
  ): Promise<void> {
    const token = this.apiTokens.get(id);
    if (token !== undefined) {
      token.lastUsedAt = at;
      token.lastUsedIp = ipAddress;
    }
  }

  public async revokeApiToken(
    id: string,
    at: string,
    reason: string,
  ): Promise<void> {
    const token = this.apiTokens.get(id);
    if (token !== undefined && token.revokedAt === undefined) {
      token.revokedAt = at;
      token.revokedReason = reason;
    }
  }

  public async deleteExpiredApiTokens(now: string): Promise<number> {
    let removed = 0;
    for (const [id, token] of this.apiTokens) {
      if (token.expiresAt !== undefined && token.expiresAt <= now) {
        this.apiTokens.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  public async createAuthSession(session: AuthSessionRecord): Promise<void> {
    this.requireUser(session.userId);
    this.authSessions.set(session.id, copy(session));
  }

  public async getAuthSession(
    id: string,
  ): Promise<AuthSessionRecord | undefined> {
    const session = this.authSessions.get(id);
    return session === undefined ? undefined : copy(session);
  }

  public async touchAuthSession(id: string, at: string): Promise<void> {
    const session = this.authSessions.get(id);
    if (session !== undefined) {
      session.lastSeenAt = at;
    }
  }

  public async revokeAuthSession(id: string): Promise<void> {
    this.authSessions.delete(id);
  }

  public async revokeUserSessions(userId: string): Promise<void> {
    for (const [id, session] of this.authSessions) {
      if (session.userId === userId) {
        this.authSessions.delete(id);
      }
    }
  }

  public async deleteExpiredAuthSessions(now: string): Promise<number> {
    let removed = 0;
    for (const [id, session] of this.authSessions) {
      if (session.expiresAt <= now) {
        this.authSessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  public async saveRepository(repository: StoredRepository): Promise<void> {
    const existing = this.repositories.get(repository.id);
    if (
      existing !== undefined &&
      (existing.path !== repository.path ||
        existing.branch !== repository.branch ||
        existing.provider !== repository.provider ||
        existing.remoteUrl !== repository.remoteUrl)
    ) {
      throw new Error(
        `Repository id ${repository.id} is already mapped to a different canonical repository`,
      );
    }
    if (existing !== undefined) {
      // First insert wins, matching the SQLite/Postgres backends'
      // `ON CONFLICT DO NOTHING`: a resubmission (a retried creation, for
      // instance) must not move `createdBy` or anything else already
      // recorded for this id.
      return;
    }
    this.repositories.set(repository.id, copy(repository));
  }

  public async removeRepository(id: string): Promise<void> {
    if (
      [...this.submitted.values()].some((task) => task.repositoryId === id) ||
      [...this.runs.values()].some((state) => state.run.repositoryId === id)
    ) {
      throw new Error(`Repository ${id} is still referenced`);
    }
    this.repositories.delete(id);
    for (const key of this.projectRepositories) {
      if (key.endsWith(`\0${id}`)) {
        this.projectRepositories.delete(key);
      }
    }
    // Cascade the repository's *own* state — its shared channel (messages,
    // replies, reactions, per-agent overrides and membership, the one-time
    // backfill flag) and any per-repository access grants — rather than
    // leaving them as orphaned rows a future repository reusing this id would
    // silently inherit. Runs and submitted tasks are refused above instead of
    // cascaded: they are execution history, not repository state, and the
    // store's contract (see `removeRepository`'s doc comment) is that they
    // block deletion rather than disappear with it.
    for (const [messageId, message] of this.channelMessages) {
      if (message.repositoryId === id) {
        this.channelMessages.delete(messageId);
      }
    }
    for (const key of [...this.channelAgentOverrides.keys()]) {
      if (key.startsWith(`${id}\0`)) {
        this.channelAgentOverrides.delete(key);
      }
    }
    for (const key of [...this.channelAgentMembers.keys()]) {
      if (key.startsWith(`${id}\0`)) {
        this.channelAgentMembers.delete(key);
      }
    }
    for (const key of [...this.channelReadCursors.keys()]) {
      if (key.startsWith(`${id}\0`)) {
        this.channelReadCursors.delete(key);
      }
    }
    this.channelMembershipBackfilled.delete(id);
    this.auditorCursors.delete(id);
    for (const key of [...this.grants.keys()]) {
      if (key.startsWith(`${id}\0`)) {
        this.grants.delete(key);
      }
    }
  }

  public async listRepositories(): Promise<StoredRepository[]> {
    return copy(
      [...this.repositories.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    );
  }

  public async getRepository(id: string): Promise<StoredRepository | undefined> {
    const repository = this.repositories.get(id);
    return repository === undefined ? undefined : copy(repository);
  }

  public async submitTask(input: SubmitTaskInput): Promise<SubmittedTask> {
    if (!this.repositories.has(input.repositoryId)) {
      throw new Error(`Unknown repository: ${input.repositoryId}`);
    }
    this.requireProject(input.projectId ?? DEFAULT_PROJECT_ID);
    if (input.submittedBy !== undefined) {
      this.requireUser(input.submittedBy);
    }
    const task: SubmittedTask = {
      id: createId("task"),
      repositoryId: input.repositoryId,
      projectId: input.projectId ?? DEFAULT_PROJECT_ID,
      objective: input.objective,
      agentId: input.agentId,
      validationCommands: copy(input.validationCommands),
      submittedBy: input.submittedBy,
      status: "submitted",
      submittedAt: new Date().toISOString(),
      claimedAt: undefined,
      completedAt: undefined,
      runId: undefined,
    };
    this.submitted.set(task.id, task);
    return copy(task);
  }

  public async listSubmittedTasks(
    filter: SubmittedTaskFilter = {},
  ): Promise<SubmittedTask[]> {
    return [...this.submitted.values()]
      .filter(
        (task) =>
          (filter.repositoryId === undefined ||
            task.repositoryId === filter.repositoryId) &&
          (filter.projectId === undefined ||
            task.projectId === filter.projectId) &&
          (filter.status === undefined || task.status === filter.status),
      )
      .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt))
      .map((task) => copy(task));
  }

  public async claimSubmittedTasks(
    repositoryId: string,
    projectId?: ProjectId,
  ): Promise<SubmittedTask[]> {
    const claimed: SubmittedTask[] = [];
    for (const task of await this.listSubmittedTasks({
      repositoryId,
      ...(projectId === undefined ? {} : { projectId }),
      status: "submitted",
    })) {
      const stored = this.submitted.get(task.id);
      if (stored?.status === "submitted") {
        stored.status = "claimed";
        stored.claimedAt = new Date().toISOString();
        claimed.push(copy(stored));
      }
    }
    return claimed;
  }

  public async retrySubmittedTask(taskId: TaskId): Promise<SubmittedTask> {
    const task = this.submitted.get(taskId);
    if (task === undefined) {
      throw new Error(`Unknown submitted task: ${taskId}`);
    }
    if (task.status !== "claimed" && task.status !== "failed") {
      throw new Error(
        `Task ${taskId} cannot be retried from status ${task.status}`,
      );
    }
    task.status = "submitted";
    task.claimedAt = undefined;
    task.completedAt = undefined;
    task.runId = undefined;
    return copy(task);
  }

  public async cancelSubmittedTask(taskId: TaskId): Promise<SubmittedTask> {
    const task = this.submitted.get(taskId);
    if (task === undefined) {
      throw new Error(`Unknown submitted task: ${taskId}`);
    }
    if (task.status !== "submitted" && task.status !== "claimed") {
      throw new Error(
        `Task ${taskId} cannot be cancelled from status ${task.status}`,
      );
    }
    task.status = "cancelled";
    task.completedAt = new Date().toISOString();
    return copy(task);
  }

  public async completeSubmittedTask(
    taskId: TaskId,
    status: SubmittedTaskCompletionStatus,
    runId?: string,
  ): Promise<void> {
    const task = this.submitted.get(taskId);
    if (task === undefined) {
      throw new Error(`Unknown submitted task: ${taskId}`);
    }
    if (task.status !== "claimed") {
      throw new Error(
        `Task ${taskId} cannot be completed from status ${task.status}`,
      );
    }
    task.status = status;
    task.completedAt = new Date().toISOString();
    task.runId = runId;
  }

  public async createRun(input: CreateRunInput): Promise<StoredRun> {
    await this.saveRepository(input.repository);
    const run: StoredRun = {
      id: createId("run"),
      repositoryId: input.repository.id,
      projectId: input.projectId ?? DEFAULT_PROJECT_ID,
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
      planRevisions: [],
      scopeChanges: [],
    });
    return copy(run);
  }

  public async finishRun(
    runId: string,
    status: RunStatus,
    finalVersion?: CanonicalVersion,
  ): Promise<void> {
    const state = this.runs.get(runId);
    if (state === undefined) {
      throw new Error(`Unknown coordination run: ${runId}`);
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
      validationCommands: copy(task.validationCommands),
      status: "submitted",
      explanation: undefined,
      plan: undefined,
      decision: undefined,
      sessionId: undefined,
      sessionStartedAt: undefined,
    });
  }

  public async savePlan(
    runId: string,
    taskId: TaskId,
    plan: AgentPlan,
  ): Promise<void> {
    const task = this.requireTask(runId, taskId);
    task.plan = copy(plan);
    task.status = "planning";
  }

  public async savePlanRevision(
    runId: string,
    taskId: TaskId,
    input: Omit<
      StoredPlanRevision,
      "id" | "runId" | "taskId" | "createdAt"
    >,
  ): Promise<StoredPlanRevision> {
    const state = this.requireRun(runId);
    this.requireTask(runId, taskId);
    if (
      state.planRevisions.some(
        (entry) => entry.taskId === taskId && entry.revision === input.revision,
      )
    ) {
      throw new Error(
        `Plan revision ${input.revision} already exists for ${taskId}`,
      );
    }
    const revision: StoredPlanRevision = {
      id: createId("plan"),
      runId,
      taskId,
      revision: input.revision,
      reason: input.reason,
      canonicalRevision: input.canonicalRevision,
      plan: copy(input.plan),
      createdAt: new Date().toISOString(),
    };
    state.planRevisions.push(revision);
    this.requireTask(runId, taskId).plan = copy(input.plan);
    return copy(revision);
  }

  public async listPlanRevisions(
    runId: string,
    taskId?: TaskId,
  ): Promise<StoredPlanRevision[]> {
    return copy(
      this.requireRun(runId).planRevisions
        .filter((entry) => taskId === undefined || entry.taskId === taskId)
        .sort((left, right) => left.revision - right.revision),
    );
  }

  public async saveScopeChange(
    runId: string,
    request: ScopeChangeRequest,
  ): Promise<void> {
    const state = this.requireRun(runId);
    if (state.scopeChanges.some((entry) => entry.request.id === request.id)) {
      return;
    }
    state.scopeChanges.push({
      runId,
      request: copy(request),
      decision: undefined,
    });
  }

  public async saveScopeChangeDecision(
    runId: string,
    decision: ScopeChangeDecision,
  ): Promise<void> {
    const entry = this.requireRun(runId).scopeChanges.find(
      (candidate) => candidate.request.id === decision.requestId,
    );
    if (entry === undefined) {
      throw new Error(`Unknown scope-change request: ${decision.requestId}`);
    }
    if (entry.decision !== undefined) {
      throw new Error(
        `Scope-change request ${decision.requestId} is already decided`,
      );
    }
    entry.decision = copy(decision);
  }

  public async listScopeChanges(runId: string): Promise<StoredScopeChange[]> {
    return copy(this.requireRun(runId).scopeChanges);
  }

  public async saveSession(runId: string, session: SessionRecord): Promise<void> {
    const task = this.requireTask(runId, session.taskId);
    task.sessionId = session.id;
    task.sessionStartedAt = session.startedAt;
  }

  public async saveDecision(
    runId: string,
    decision: CoordinatorDecision,
  ): Promise<void> {
    this.requireTask(runId, decision.taskId).decision = copy(decision);
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
    this.requireRun(runId).conflicts.push(...copy(assessments));
  }

  public async saveLeases(
    runId: string,
    leases: readonly ResourceLease[],
  ): Promise<void> {
    this.requireRun(runId).leases.push(...copy(leases));
  }

  public async releaseLeases(_runId: string, _taskId: TaskId): Promise<void> {
    // Release time is not projected in memory; the lease list is the record.
  }

  public async saveWorkspace(
    runId: string,
    workspace: StoredWorkspace,
  ): Promise<void> {
    this.requireRun(runId).workspaces.push(copy(workspace));
  }

  public async saveChangeSet(runId: string, changeSet: ChangeSet): Promise<void> {
    const state = this.requireRun(runId);
    if (!state.changeSets.some((entry) => entry.id === changeSet.id)) {
      state.changeSets.push(copy(changeSet));
    }
  }

  public async addChangesetComment(
    input: AddChangesetCommentInput,
  ): Promise<ChangesetComment> {
    const state = this.requireRun(input.runId);
    if (!state.changeSets.some((entry) => entry.id === input.changeSetId)) {
      throw new Error(`Unknown changeset: ${input.changeSetId}`);
    }
    this.requireUser(input.authorId);
    const body = input.body.trim();
    if (body.length === 0) {
      throw new Error("A comment must have a body");
    }
    const comment: ChangesetComment = {
      id: createId("comment"),
      runId: input.runId,
      changeSetId: input.changeSetId,
      taskId: input.taskId,
      filePath: input.filePath,
      authorId: input.authorId,
      body,
      createdAt: new Date().toISOString(),
      resolvedAt: undefined,
      resolvedBy: undefined,
    };
    this.comments.set(comment.id, comment);
    return copy(comment);
  }

  public async listChangesetComments(
    filter: { runId?: string; changeSetId?: string; resolved?: boolean } = {},
  ): Promise<ChangesetComment[]> {
    return copy(
      [...this.comments.values()]
        .filter(
          (comment) =>
            (filter.runId === undefined || comment.runId === filter.runId) &&
            (filter.changeSetId === undefined ||
              comment.changeSetId === filter.changeSetId) &&
            (filter.resolved === undefined ||
              filter.resolved === (comment.resolvedAt !== undefined)),
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    );
  }

  public async getChangesetComment(
    id: string,
  ): Promise<ChangesetComment | undefined> {
    const comment = this.comments.get(id);
    return comment === undefined ? undefined : copy(comment);
  }

  public async resolveChangesetComment(
    id: string,
    resolvedBy: string,
    at: string,
  ): Promise<ChangesetComment> {
    const comment = this.comments.get(id);
    if (comment === undefined) {
      throw new Error(`Unknown comment: ${id}`);
    }
    this.requireUser(resolvedBy);
    if (comment.resolvedAt === undefined) {
      comment.resolvedAt = at;
      comment.resolvedBy = resolvedBy;
    }
    return copy(comment);
  }

  public async saveIntegration(
    runId: string,
    result: IntegrationResult,
  ): Promise<void> {
    this.requireRun(runId).integrations.push(copy(result));
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
      data: copy(input.data ?? {}),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    };

    // Falls back to the newest checkpoint when the live log is empty, which
    // is what archiving everything leaves behind; GENESIS there would fork
    // the chain.
    const previousHash =
      this.audit.at(-1)?.chainHash ??
      this.auditCheckpoints.at(-1)?.chainHash ??
      GENESIS_HASH;
    const payloadHash = hashAuditPayload(event);
    this.auditSequence += 1;
    this.audit.push({
      event,
      sequence: this.auditSequence,
      payloadHash,
      previousHash,
      chainHash: chainHash(previousHash, payloadHash),
    });
    this.auditRuns.push(runId);
    return copy(event);
  }

  public async listAuditEvents(
    filter: AuditEventFilter = {},
  ): Promise<SequencedAuditEvent[]> {
    const after = filter.afterSequence ?? 0;
    const limit = filter.limit ?? 500;
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new RangeError("Audit cursor must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new RangeError("Audit event limit must be between 1 and 5000");
    }
    return this.audit
      .map((entry, index): SequencedAuditEvent => ({
        sequence: entry.sequence,
        ...(this.auditRuns[index] === undefined
          ? {}
          : { runId: this.auditRuns[index] }),
        event: copy(entry.event),
      }))
      .filter((entry) => entry.sequence > after && matchesAuditFilter(entry, filter))
      .slice(0, limit);
  }

  public async listArchivedAuditEvents(
    filter: AuditEventFilter = {},
  ): Promise<SequencedAuditEvent[]> {
    const after = filter.afterSequence ?? 0;
    const limit = filter.limit ?? 500;
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new RangeError("Audit cursor must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new RangeError("Audit event limit must be between 1 and 5000");
    }
    return this.auditArchive
      .map((row): SequencedAuditEvent => ({
        sequence: row.entry.sequence,
        ...(row.runId === undefined ? {} : { runId: row.runId }),
        event: copy(row.entry.event),
      }))
      .filter((entry) => entry.sequence > after && matchesAuditFilter(entry, filter))
      .slice(0, limit);
  }

  public async listAuditCheckpoints(): Promise<AuditCheckpoint[]> {
    return copy(
      [...this.auditCheckpoints].sort(
        (left, right) => left.throughSequence - right.throughSequence,
      ),
    );
  }

  public async archiveAuditEvents(
    input: ArchiveAuditInput,
  ): Promise<AuditArchiveResult | undefined> {
    const verification = await this.verifyAudit();
    if (!verification.valid) {
      throw new Error(
        `Refusing to archive a broken audit chain: ${verification.reason}`,
      );
    }
    if (input.throughSequence === undefined && input.before === undefined) {
      throw new Error(
        "Archiving needs a boundary: pass throughSequence or before",
      );
    }

    const selected = this.audit.filter(
      (entry) =>
        (input.throughSequence === undefined ||
          entry.sequence <= input.throughSequence) &&
        (input.before === undefined ||
          entry.event.occurredAt < input.before),
    );
    if (selected.length === 0) {
      return undefined;
    }
    const last = selected.at(-1);
    if (last === undefined) {
      return undefined;
    }
    // A time bound can only cut where the sequence does, or the archive would
    // be a set of holes rather than a prefix and nothing would link.
    if (selected.length !== this.audit.filter(
      (entry) => entry.sequence <= last.sequence,
    ).length) {
      throw new Error(
        "Archiving must cover an unbroken prefix of the chain; the requested " +
          "boundary would leave earlier events behind",
      );
    }

    const checkpoint: AuditCheckpoint = {
      id: createId("checkpoint"),
      throughSequence: last.sequence,
      chainHash: last.chainHash,
      segmentDigest: segmentDigest(
        selected.map((entry) => entry.payloadHash),
      ),
      events: selected.length,
      createdAt: new Date().toISOString(),
    };
    const events: SequencedAuditEvent[] = [];
    for (const entry of selected) {
      const index = this.audit.indexOf(entry);
      const runId = this.auditRuns[index];
      this.auditArchive.push({
        entry: copy(entry),
        runId,
        checkpointId: checkpoint.id,
      });
      events.push({
        sequence: entry.sequence,
        ...(runId === undefined ? {} : { runId }),
        event: copy(entry.event),
      });
    }
    this.audit.splice(0, selected.length);
    this.auditRuns.splice(0, selected.length);
    this.auditCheckpoints.push(checkpoint);
    return { checkpoint, events };
  }

  public async pruneArchivedAuditEvents(
    throughSequence: number,
  ): Promise<number> {
    const pruned = new Set(
      this.auditCheckpoints
        .filter((checkpoint) => checkpoint.throughSequence <= throughSequence)
        .map((checkpoint) => checkpoint.id),
    );
    if (pruned.size === 0) {
      throw new Error(
        "Archived events can only be pruned up to a recorded checkpoint",
      );
    }
    // Whole segments only. Half a segment would no longer reproduce its
    // checkpoint digest, and verification would report the operator's own
    // housekeeping as tampering.
    let removed = 0;
    for (let index = this.auditArchive.length - 1; index >= 0; index -= 1) {
      if (pruned.has(this.auditArchive[index]?.checkpointId ?? "")) {
        this.auditArchive.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  }

  public async createApproval(
    input: CreateApprovalInput,
  ): Promise<ApprovalRequest> {
    const approval: ApprovalRequest = {
      id: createId("approval"),
      ...(input.organizationId === undefined
        ? {}
        : { organizationId: input.organizationId }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      repositoryId: input.repositoryId,
      runId: input.runId,
      taskId: input.taskId,
      kind: input.kind,
      status: "pending",
      requestedBy: input.requestedBy,
      requiredRole: input.requiredRole,
      reasons: [...input.reasons],
      ...(input.changeSetId === undefined
        ? {}
        : { changeSetId: input.changeSetId }),
      ...(input.scopeChangeId === undefined
        ? {}
        : { scopeChangeId: input.scopeChangeId }),
      requestedAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
    };
    this.approvals.set(approval.id, approval);
    return copy(approval);
  }

  public async getApproval(id: string): Promise<ApprovalRequest | undefined> {
    const approval = this.approvals.get(id);
    return approval === undefined ? undefined : copy(approval);
  }

  public async listApprovals(
    filter: ApprovalFilter = {},
  ): Promise<ApprovalRequest[]> {
    return copy(
      [...this.approvals.values()]
        .filter(
          (approval) =>
            (filter.organizationId === undefined ||
              approval.organizationId === filter.organizationId) &&
            (filter.projectId === undefined ||
              approval.projectId === filter.projectId) &&
            (filter.repositoryId === undefined ||
              approval.repositoryId === filter.repositoryId) &&
            (filter.runId === undefined || approval.runId === filter.runId) &&
            (filter.taskId === undefined ||
              approval.taskId === filter.taskId) &&
            (filter.status === undefined || approval.status === filter.status),
        )
        .sort((left, right) =>
          right.requestedAt.localeCompare(left.requestedAt),
        ),
    );
  }

  public async decideApproval(
    decision: ApprovalDecision,
  ): Promise<ApprovalRequest> {
    const approval = this.approvals.get(decision.approvalId);
    if (approval === undefined) {
      throw new Error(`Unknown approval: ${decision.approvalId}`);
    }
    if (approval.status !== "pending") {
      throw new Error(
        `Approval ${approval.id} cannot be decided from ${approval.status}`,
      );
    }
    approval.status = decision.status;
    approval.decidedBy = decision.decidedBy;
    approval.decisionComment = decision.comment;
    approval.decidedAt = decision.decidedAt;
    return copy(approval);
  }

  public async expireApprovals(now: string): Promise<number> {
    let count = 0;
    for (const approval of this.approvals.values()) {
      if (approval.status === "pending" && approval.expiresAt <= now) {
        approval.status = "expired";
        approval.decidedAt = now;
        count += 1;
      }
    }
    return count;
  }

  public async listRuns(limit = 50): Promise<StoredRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("Run list limit must be a positive safe integer");
    }
    return copy(
      [...this.runs.values()]
        .map((state) => state.run)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, limit),
    );
  }

  public async getRun(runId: string): Promise<RunDetail | undefined> {
    const state = this.runs.get(runId);
    if (state === undefined) {
      return undefined;
    }
    return copy({
      run: state.run,
      tasks: [...state.tasks.values()],
      conflicts: [...state.conflicts],
      changeSets: [...state.changeSets],
      integrations: [...state.integrations],
      leases: [...state.leases],
      workspaces: [...state.workspaces],
      planRevisions: [...state.planRevisions],
      scopeChanges: [...state.scopeChanges],
      approvals: await this.listApprovals({ runId }),
      comments: await this.listChangesetComments({ runId }),
      audit: await this.listAudit(runId),
    });
  }

  public async listAudit(runId?: string): Promise<AuditEvent[]> {
    return this.audit
      .filter((_, index) => runId === undefined || this.auditRuns[index] === runId)
      .map((entry) => copy(entry.event));
  }

  public async verifyAudit(): Promise<AuditChainVerification> {
    const segments: ArchivedSegment[] = this.auditCheckpoints
      .slice()
      .sort((left, right) => left.throughSequence - right.throughSequence)
      .map((checkpoint) => {
        const entries = this.auditArchive
          .filter((row) => row.checkpointId === checkpoint.id)
          .sort((left, right) => left.entry.sequence - right.entry.sequence)
          .map((row) => row.entry);
        return {
          checkpoint,
          ...(entries.length === 0 ? {} : { entries }),
        };
      });
    return verifyArchivedChain(segments, this.audit);
  }

  private toPublicChannelMessage(
    message: StoredChannelMessage,
    viewerId: string,
  ): ChannelMessage {
    const reactions: Record<string, ChannelReaction> = {};
    for (const [emoji, userIds] of message.reactions) {
      if (userIds.size === 0) {
        continue;
      }
      reactions[emoji] = {
        emoji,
        count: userIds.size,
        mine: userIds.has(viewerId),
      };
    }
    return {
      id: message.id,
      repositoryId: message.repositoryId,
      projectId: message.projectId,
      kind: message.kind,
      authorId: message.authorId,
      content: message.content,
      createdAt: message.createdAt,
      replies: copy(message.replies),
      reactions,
    };
  }

  private channelAgentKey(repositoryId: string, agentId: string): string {
    return `${repositoryId}\0${agentId}`;
  }

  private channelMemberKey(
    repositoryId: string,
    userId: string,
    provider: string,
  ): string {
    return `${repositoryId}\0${userId}\0${provider}`;
  }

  private channelReadKey(repositoryId: string, userId: string): string {
    return `${repositoryId}\0${userId}`;
  }

  public async listChannelMessages(
    repositoryId: string,
    viewerId: string,
    filter: ChannelMessageFilter = {},
  ): Promise<ChannelMessage[]> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = [...this.channelMessages.values()]
      .filter((message) => message.repositoryId === repositoryId)
      .filter(
        (message) =>
          filter.before === undefined || message.createdAt < filter.before,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return rows
      .slice(-limit)
      .map((message) => this.toPublicChannelMessage(message, viewerId));
  }

  public async appendChannelMessage(
    input: AppendChannelMessageInput,
  ): Promise<ChannelMessage> {
    const content = input.content.trim();
    if (content.length === 0) {
      throw new Error("A channel message must have content");
    }
    const message: StoredChannelMessage = {
      id: createId("chanmsg"),
      repositoryId: input.repositoryId,
      projectId: input.projectId,
      kind: input.kind ?? "user",
      authorId: input.authorId,
      content,
      createdAt: new Date().toISOString(),
      replies: [],
      reactions: new Map(),
    };
    this.channelMessages.set(message.id, message);
    return this.toPublicChannelMessage(message, input.authorId);
  }

  public async addChannelReply(
    input: AddChannelReplyInput,
  ): Promise<ChannelReply> {
    const message = this.channelMessages.get(input.messageId);
    if (message === undefined || message.repositoryId !== input.repositoryId) {
      throw new Error(`Unknown channel message: ${input.messageId}`);
    }
    const content = input.content.trim();
    if (content.length === 0) {
      throw new Error("A reply must have content");
    }
    const reply: StoredChannelReply = {
      id: createId("chanreply"),
      messageId: message.id,
      kind: input.kind ?? "user",
      authorId: input.authorId,
      content,
      createdAt: new Date().toISOString(),
    };
    message.replies.push(reply);
    return copy(reply);
  }

  public async getChannelMessage(
    repositoryId: string,
    messageId: string,
    viewerId: string,
  ): Promise<ChannelMessage | undefined> {
    const message = this.channelMessages.get(messageId);
    if (message === undefined || message.repositoryId !== repositoryId) {
      return undefined;
    }
    return this.toPublicChannelMessage(message, viewerId);
  }

  public async toggleChannelReaction(
    repositoryId: string,
    messageId: string,
    userId: string,
    emoji: string,
  ): Promise<ChannelMessage> {
    const message = this.channelMessages.get(messageId);
    if (message === undefined || message.repositoryId !== repositoryId) {
      throw new Error(`Unknown channel message: ${messageId}`);
    }
    const reactors = message.reactions.get(emoji) ?? new Set<string>();
    if (reactors.has(userId)) {
      reactors.delete(userId);
    } else {
      reactors.add(userId);
    }
    if (reactors.size === 0) {
      message.reactions.delete(emoji);
    } else {
      message.reactions.set(emoji, reactors);
    }
    return this.toPublicChannelMessage(message, userId);
  }

  public async listChannelAgentOverrides(
    repositoryId: string,
  ): Promise<Record<string, ChannelAgentOverride>> {
    const result: Record<string, ChannelAgentOverride> = {};
    for (const override of this.channelAgentOverrides.values()) {
      if (override.repositoryId === repositoryId) {
        result[override.agentId] = copy(override);
      }
    }
    return result;
  }

  public async setChannelAgentOverride(
    repositoryId: string,
    agentId: string,
    patch: { name?: string; role?: string; model?: string; effort?: string },
  ): Promise<ChannelAgentOverride> {
    const key = this.channelAgentKey(repositoryId, agentId);
    const existing = this.channelAgentOverrides.get(key);
    const name = patch.name ?? existing?.name;
    const role = patch.role ?? existing?.role;
    const model = patch.model ?? existing?.model;
    const effort = patch.effort ?? existing?.effort;
    const override: ChannelAgentOverride = {
      repositoryId,
      agentId,
      ...(name === undefined ? {} : { name }),
      ...(role === undefined ? {} : { role }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      updatedAt: new Date().toISOString(),
    };
    this.channelAgentOverrides.set(key, override);
    return copy(override);
  }

  public async listChannelAgentMembers(
    repositoryId: string,
  ): Promise<Array<{ userId: string; provider: string }>> {
    const result: Array<{ userId: string; provider: string }> = [];
    for (const member of this.channelAgentMembers.values()) {
      if (member.repositoryId === repositoryId) {
        result.push({ userId: member.userId, provider: member.provider });
      }
    }
    return result;
  }

  public async setChannelAgentMember(
    repositoryId: string,
    userId: string,
    provider: string,
    isMember: boolean,
  ): Promise<void> {
    const key = this.channelMemberKey(repositoryId, userId, provider);
    if (isMember) {
      this.channelAgentMembers.set(key, { repositoryId, userId, provider });
    } else {
      this.channelAgentMembers.delete(key);
    }
  }

  public async hasBackfilledChannelMembership(
    repositoryId: string,
  ): Promise<boolean> {
    return this.channelMembershipBackfilled.has(repositoryId);
  }

  public async markChannelMembershipBackfilled(
    repositoryId: string,
  ): Promise<void> {
    this.channelMembershipBackfilled.add(repositoryId);
  }

  public async markChannelRead(
    repositoryId: string,
    userId: string,
    at: string,
  ): Promise<void> {
    this.channelReadCursors.set(this.channelReadKey(repositoryId, userId), at);
  }

  public async getChannelReadCursor(
    repositoryId: string,
    userId: string,
  ): Promise<string | undefined> {
    return this.channelReadCursors.get(this.channelReadKey(repositoryId, userId));
  }

  public async getAuditorCursor(
    repositoryId: string,
  ): Promise<AuditorCursor | undefined> {
    const cursor = this.auditorCursors.get(repositoryId);
    return cursor === undefined ? undefined : copy(cursor);
  }

  public async saveAuditorCursor(
    cursor: Omit<AuditorCursor, "paused">,
  ): Promise<void> {
    const existing = this.auditorCursors.get(cursor.repositoryId);
    this.auditorCursors.set(cursor.repositoryId, {
      ...copy(cursor),
      paused: existing?.paused ?? false,
    });
  }

  public async setAuditorPaused(
    repositoryId: string,
    paused: boolean,
  ): Promise<void> {
    const existing = this.auditorCursors.get(repositoryId);
    this.auditorCursors.set(repositoryId, {
      repositoryId,
      revision: existing?.revision ?? "",
      sequence: existing?.sequence ?? 0,
      paused,
      updatedAt: new Date().toISOString(),
    });
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

  private requireOrganization(id: string): Organization {
    const organization = this.organizations.get(id);
    if (organization === undefined) {
      throw new Error(`Unknown organization: ${id}`);
    }
    return organization;
  }

  private requireUser(id: string): UserAccount {
    const user = this.users.get(id);
    if (user === undefined) {
      throw new Error(`Unknown user: ${id}`);
    }
    return user;
  }

  private requireProject(id: string): ProjectRecord {
    const project = this.projects.get(id);
    if (project === undefined) {
      throw new Error(`Unknown project: ${id}`);
    }
    return project;
  }

  private membershipKey(organizationId: string, userId: string): string {
    return `${organizationId}\0${userId}`;
  }

  private projectRepositoryKey(
    projectId: string,
    repositoryId: string,
  ): string {
    return `${projectId}\0${repositoryId}`;
  }

  private assertProjectSlugAvailable(
    organizationId: string,
    slug: string,
    exceptId?: string,
  ): void {
    if (
      [...this.projects.values()].some(
        (project) =>
          project.organizationId === organizationId &&
          project.id !== exceptId &&
          project.slug.toLowerCase() === slug.toLowerCase(),
      )
    ) {
      throw new Error(`Project slug is already in use: ${slug}`);
    }
  }
}
