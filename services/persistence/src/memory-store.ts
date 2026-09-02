import {
  boundValidation,
  createId,
  CHANNEL_TOUCH_FLOOR,
  planAdmissionApproved,
  type AgentPlan,
  type ApprovalDecision,
  type ApprovalRequest,
  type AuditEvent,
  type CanonicalVersion,
  type ChangeSet,
  type TouchedFileSample,
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
  CreateMcpServerInput,
  LeaseTaskInput,
  LeasedWork,
  McpServerRecord,
  McpServerSecrets,
  SaveWorkLeasePlanInput,
  SaveWorkLeasePlanResult,
  UpdateMcpServerInput,
  WorkLease,
  WorkLeaseStatus,
  WorkerRecord,
  AddChangesetCommentInput,
  AddChannelReplyInput,
  AppendChannelMessageInput,
  ApprovalFilter,
  AgentCallSign,
  ArchiveAuditInput,
  ChangesetComment,
  ChannelAgentMember,
  ChannelAgentOverride,
  ChannelEntryKind,
  ChannelMessage,
  ChannelChangedFile,
  ChannelMessageCounts,
  ChannelMessageFilter,
  AppendDirectMessageInput,
  DirectConversation,
  DirectMessage,
  DirectMessageFilter,
  ChannelReaction,
  ChannelReply,
  CreateSubChannelInput,
  SubChannel,
  SubChannelMember,
  UpdateSubChannelInput,
  AuditArchiveResult,
  AuditEventFilter,
  AuditorCursor,
  AuthSessionRecord,
  CatchUpCursor,
  CoordinationStore,
  CreateApprovalInput,
  CreateRunInput,
  Organization,
  OrganizationMembership,
  Subscription,
  SubscriptionStatus,
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
  PasswordResetRecord,
  SignupIntentRecord,
  WaitlistEntry,
  RepositoryGrant,
  UserAccount,
  UserAppearance,
} from "./store.js";
import {
  GENERAL_SUB_CHANNEL_SLUG,
  applyMcpSecretsPatch,
  directPairKey,
  mcpSecretNames,
  normalizeMcpRepositoryIds,
  repositoryConflicts,
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

/**
 * A server and its secrets, kept apart so the record can be handed out
 * without a second thought and the secrets only ever by name.
 */
interface StoredMcpServer {
  record: McpServerRecord;
  secrets: McpServerSecrets;
}

/**
 * Name order as the SQL stores list it — `ORDER BY LOWER(name), id` — so a
 * screen sorted by this backend matches one sorted by the others.
 */
function compareMcpServers(left: McpServerRecord, right: McpServerRecord): number {
  const leftName = left.name.toLowerCase();
  const rightName = right.name.toLowerCase();
  if (leftName !== rightName) {
    return leftName < rightName ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

interface StoredChannelReply {
  id: string;
  messageId: string;
  kind: ChannelEntryKind;
  authorId: string;
  content: string;
  createdAt: string;
  referencedMessageId?: string;
}

interface StoredChannelMessage {
  id: string;
  repositoryId: string;
  channelId: string;
  projectId: ProjectId;
  kind: ChannelEntryKind;
  authorId: string;
  content: string;
  createdAt: string;
  /** The earlier root this channel message answers. */
  referencedMessageId?: string;
  /** Where it sits, once continuing a thread has moved it. */
  bumpedAt?: string;
  /** The task this thread is the story of, when it is one. */
  taskId?: TaskId;
  /** What that task changed, kept with the thread. */
  changedFiles?: ChannelChangedFile[];
  /** When somebody pinned it to the channel's banner, and who. */
  pinnedAt?: string;
  pinnedBy?: string;
  /** When this thread's task was ended outside the thread. */
  endedAt?: string;
  /** When it was blanked in place, and by whom. */
  deletedAt?: string;
  deletedBy?: string;
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
  runs: ReadonlyMap<string, RunState>,
): boolean {
  return (
    (filter.runId === undefined || entry.runId === filter.runId) &&
    (filter.taskId === undefined || entry.event.taskId === filter.taskId) &&
    // A payload stamp when the writer knew the project, and otherwise the
    // project of the run the event was written under. `runs` is passed in
    // rather than read off the entry because the association lives beside the
    // entry, in a parallel array, rather than inside it.
    (filter.projectId === undefined ||
      entry.event.data["projectId"] === filter.projectId ||
      (entry.runId !== undefined &&
        runs.get(entry.runId)?.run.projectId === filter.projectId)) &&
    (filter.types === undefined || filter.types.includes(entry.event.type)) &&
    (filter.occurredAfter === undefined ||
      entry.event.occurredAt >= filter.occurredAfter) &&
    (filter.occurredBefore === undefined ||
      entry.event.occurredAt < filter.occurredBefore)
  );
}

/** One person's catch-up mark in one project, as a map key. */
function catchUpKey(projectId: string, userId: string): string {
  return `${projectId}\0${userId}`;
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
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly projectRepositories = new Set<string>();
  private readonly authSessions = new Map<string, AuthSessionRecord>();
  private readonly apiTokens = new Map<string, ApiTokenRecord>();
  private readonly mcpServers = new Map<string, StoredMcpServer>();
  /** Keyed by usage key so a re-reported running total replaces its predecessor. */
  private readonly tokenUsage = new Map<string, TokenUsageRecord>();
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly workLeases = new Map<string, WorkLease>();
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly comments = new Map<string, ChangesetComment>();
  private readonly channelMessages = new Map<string, StoredChannelMessage>();
  private readonly directMessages = new Map<string, DirectMessage>();
  /** Keyed by `repositoryId\0agentId`. */
  private readonly channelAgentOverrides = new Map<string, ChannelAgentOverride>();
  /** Keyed by `channelId\0userId\0provider`. */
  private readonly channelAgentMembers = new Map<string, ChannelAgentMember>();
  /** Every sub-channel, keyed by its id. */
  private readonly subChannels = new Map<string, SubChannel>();
  /** Keyed by `channelId\0userId`. */
  private readonly subChannelMembers = new Map<string, SubChannelMember>();
  /** Keyed by `userId\0provider` — the name an agent answers to everywhere. */
  private readonly agentCallSigns = new Map<string, AgentCallSign>();
  /** Repository ids whose one-time membership backfill has already run. */
  private readonly channelMembershipBackfilled = new Set<string>();
  /** Keyed by `repositoryId\0channelId\0userId`. */
  private readonly channelReadCursors = new Map<string, string>();
  /** Keyed by `projectId\0userId`. */
  private readonly catchUpCursors = new Map<string, string>();
  /** Keyed by `repositoryId\0userId` — present only while muted. */
  private readonly channelMutes = new Map<string, string>();
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
    id?: string;
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
      id: input.id ?? createId("org"),
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
    comped?: boolean;
  }): Promise<OrganizationMembership> {
    this.requireOrganization(input.organizationId);
    this.requireUser(input.userId);
    const key = this.membershipKey(input.organizationId, input.userId);
    const existing = this.memberships.get(key);
    const membership: OrganizationMembership = {
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role,
      // An omitted `comped` keeps what the row already says, so a role change
      // cannot quietly start charging for a seat that was given away.
      comped: input.comped ?? existing?.comped ?? false,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.memberships.set(key, membership);
    return copy(membership);
  }

  public async getSubscription(
    organizationId: string,
  ): Promise<Subscription | undefined> {
    const found = this.subscriptions.get(organizationId);
    return found === undefined ? undefined : copy(found);
  }

  public async saveSubscription(input: {
    organizationId: string;
    status: SubscriptionStatus;
    trialEndsAt?: string;
    currentPeriodEnd?: string;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
  }): Promise<Subscription> {
    this.requireOrganization(input.organizationId);
    const now = new Date().toISOString();
    const existing = this.subscriptions.get(input.organizationId);
    const subscription: Subscription = {
      organizationId: input.organizationId,
      status: input.status,
      ...(input.trialEndsAt === undefined
        ? {}
        : { trialEndsAt: input.trialEndsAt }),
      ...(input.currentPeriodEnd === undefined
        ? {}
        : { currentPeriodEnd: input.currentPeriodEnd }),
      ...(input.stripeCustomerId === undefined
        ? {}
        : { stripeCustomerId: input.stripeCustomerId }),
      ...(input.stripeSubscriptionId === undefined
        ? {}
        : { stripeSubscriptionId: input.stripeSubscriptionId }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.subscriptions.set(input.organizationId, subscription);
    return copy(subscription);
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
    // The project's MCP servers let go of the repository too: their
    // attachment is a fact about this project, and a repository linked back
    // later must not find last year's servers waiting for it.
    for (const stored of this.mcpServers.values()) {
      if (stored.record.projectId === projectId) {
        stored.record.repositoryIds = stored.record.repositoryIds.filter(
          (id) => id !== repositoryId,
        );
      }
    }
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
          // Fail closed. See the Postgres branch: absent means `task`, so a
          // caller written before questions existed cannot be handed one.
          (input.kinds ?? ["task"]).includes(task.kind) &&
          // A NULL owner matches either way: nobody's account is at stake, so
          // there is nothing to reserve and nothing to get wrong.
          (input.claimableBy === undefined ||
            task.submittedBy === undefined ||
            task.submittedBy === input.claimableBy) &&
          (input.excludeSubmittedBy === undefined ||
            task.submittedBy === undefined ||
            !input.excludeSubmittedBy.includes(task.submittedBy)) &&
          (task.afterTaskId === undefined ||
            !["submitted", "claimed", "planned", "paused"].includes(
              this.submitted.get(task.afterTaskId)?.status ?? "integrated",
            )) &&
          activeLeases(task.repositoryId) < parallelism,
      )
      // A question ahead of work of the same age: somebody is watching a
      // channel for it, and it has no plan to admit or changeset to integrate.
      .sort(
        (left, right) =>
          Number(left.kind !== "question") - Number(right.kind !== "question") ||
          left.submittedAt.localeCompare(right.submittedAt),
      )[0];
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
      freshTokens: input.freshTokens,
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

  /* ---------------------------------------------------- password resets ---- */

  private readonly waitlistEntries = new Map<string, WaitlistEntry>();

  public async createWaitlistEntry(entry: WaitlistEntry): Promise<WaitlistEntry> {
    const email = entry.email.trim().toLowerCase();
    const existing = await this.getWaitlistEntryByEmail(email);
    // Re-asking refreshes what they told us and keeps where they are in the
    // queue, which is the behaviour the backends with a unique index give.
    const stored: WaitlistEntry = {
      ...entry,
      email,
      ...(existing === undefined
        ? {}
        : {
            id: existing.id,
            createdAt: existing.createdAt,
            invitedAt: existing.invitedAt,
          }),
    };
    this.waitlistEntries.set(stored.id, stored);
    return { ...stored };
  }

  public async getWaitlistEntryByEmail(
    email: string,
  ): Promise<WaitlistEntry | undefined> {
    const wanted = email.trim().toLowerCase();
    for (const entry of this.waitlistEntries.values()) {
      if (entry.email.toLowerCase() === wanted) {
        return { ...entry };
      }
    }
    return undefined;
  }

  public async listWaitlistEntries(): Promise<WaitlistEntry[]> {
    return [...this.waitlistEntries.values()]
      .map((entry) => ({ ...entry }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  public async markWaitlistEntryInvited(
    id: string,
    at: string,
  ): Promise<boolean> {
    const found = this.waitlistEntries.get(id);
    if (found === undefined || found.invitedAt !== undefined) {
      return false;
    }
    found.invitedAt = at;
    return true;
  }

  public async deleteWaitlistEntry(id: string): Promise<void> {
    this.waitlistEntries.delete(id);
  }

  private readonly signupIntents = new Map<string, SignupIntentRecord>();
  /** Held while a `runInTransaction` body runs, for rollback. */
  private transactionSnapshot: Map<string, Map<unknown, unknown>> | undefined;

  public async createSignupIntent(intent: SignupIntentRecord): Promise<void> {
    this.signupIntents.set(intent.id, { ...intent });
  }

  public async getSignupIntent(
    id: string,
  ): Promise<SignupIntentRecord | undefined> {
    const found = this.signupIntents.get(id);
    return found === undefined ? undefined : { ...found };
  }

  public async completeSignupIntent(
    id: string,
    at: string,
  ): Promise<boolean> {
    // Conditional on still being open, so a Stripe redelivery — or the second
    // of two events that both name this intent — provisions nothing twice.
    const found = this.signupIntents.get(id);
    if (found === undefined || found.completedAt !== undefined) {
      return false;
    }
    found.completedAt = at;
    return true;
  }

  public async getSignupIntentByOrganization(
    organizationId: string,
  ): Promise<SignupIntentRecord | undefined> {
    for (const intent of this.signupIntents.values()) {
      if (intent.organizationId === organizationId) {
        return { ...intent };
      }
    }
    return undefined;
  }

  public async attachSignupIntentUser(
    id: string,
    userId: string,
  ): Promise<boolean> {
    // Conditional, so two requests racing one claim link cannot both build an
    // account against the same paid organization.
    const found = this.signupIntents.get(id);
    if (found === undefined || found.userId !== undefined) {
      return false;
    }
    found.userId = userId;
    return true;
  }

  public async deleteExpiredSignupIntents(before: string): Promise<void> {
    for (const [id, intent] of this.signupIntents) {
      if (intent.completedAt === undefined && intent.expiresAt < before) {
        this.signupIntents.delete(id);
      }
    }
  }

  private readonly passwordResets = new Map<string, PasswordResetRecord>();

  public async createPasswordReset(reset: PasswordResetRecord): Promise<void> {
    this.requireUser(reset.userId);
    this.passwordResets.set(reset.id, { ...reset });
  }

  public async getPasswordReset(
    id: string,
  ): Promise<PasswordResetRecord | undefined> {
    const found = this.passwordResets.get(id);
    return found === undefined ? undefined : { ...found };
  }

  public async consumePasswordReset(
    id: string,
    at: string,
  ): Promise<boolean> {
    const found = this.passwordResets.get(id);
    if (found === undefined || found.consumedAt !== undefined) {
      return false;
    }
    found.consumedAt = at;
    return true;
  }

  public async deletePasswordResetsForUser(userId: string): Promise<void> {
    for (const [id, reset] of this.passwordResets) {
      if (reset.userId === userId) {
        this.passwordResets.delete(id);
      }
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
    // And everything it minted, which is what makes minting safe at all: a
    // credential that could outlive the one that created it would put
    // revocation out of reach. One level, because a minted token may not mint.
    for (const child of this.apiTokens.values()) {
      if (child.createdByToken === id && child.revokedAt === undefined) {
        child.revokedAt = at;
        child.revokedReason = `${reason} (minted by a revoked token)`;
      }
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

  public async createMcpServer(
    input: CreateMcpServerInput,
  ): Promise<McpServerRecord> {
    this.requireProject(input.projectId);
    this.assertMcpServerNameAvailable(input.projectId, input.name);
    const secrets = copy(input.secrets ?? {});
    const record: McpServerRecord = {
      id: input.id,
      projectId: input.projectId,
      name: input.name,
      transport: input.transport,
      ...(input.command === undefined ? {} : { command: input.command }),
      args: [...(input.args ?? [])],
      ...(input.url === undefined ? {} : { url: input.url }),
      values: { ...(input.values ?? {}) },
      secretNames: mcpSecretNames(secrets),
      // Off until somebody with the standing to say otherwise does, through
      // the one method that can; see `McpServerRecord`.
      enabled: false,
      scope: input.scope ?? "repository",
      repositoryIds: normalizeMcpRepositoryIds(input.repositoryIds ?? []),
      createdBy: input.createdBy,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    this.mcpServers.set(record.id, { record, secrets });
    return copy(record);
  }

  public async getMcpServer(id: string): Promise<McpServerRecord | undefined> {
    const stored = this.mcpServers.get(id);
    return stored === undefined ? undefined : copy(stored.record);
  }

  public async getMcpServerSecrets(
    id: string,
  ): Promise<McpServerSecrets | undefined> {
    const stored = this.mcpServers.get(id);
    return stored === undefined ? undefined : copy(stored.secrets);
  }

  public async listMcpServers(
    projectId: string,
    filter: { repositoryId?: string; enabledOnly?: boolean } = {},
  ): Promise<McpServerRecord[]> {
    const repositoryId = filter.repositoryId;
    return copy(
      [...this.mcpServers.values()]
        .map((stored) => stored.record)
        .filter((record) => record.projectId === projectId)
        .filter((record) => filter.enabledOnly !== true || record.enabled)
        .filter(
          (record) =>
            repositoryId === undefined ||
            record.scope === "project" ||
            record.repositoryIds.includes(repositoryId),
        )
        .sort(compareMcpServers),
    );
  }

  public async updateMcpServer(
    id: string,
    patch: UpdateMcpServerInput,
  ): Promise<McpServerRecord> {
    const stored = this.requireMcpServer(id);
    const { record } = stored;
    if (patch.name !== undefined) {
      this.assertMcpServerNameAvailable(record.projectId, patch.name, id);
      record.name = patch.name;
    }
    if (patch.command === null) {
      delete record.command;
    } else if (patch.command !== undefined) {
      record.command = patch.command;
    }
    if (patch.args !== undefined) {
      record.args = [...patch.args];
    }
    if (patch.url === null) {
      delete record.url;
    } else if (patch.url !== undefined) {
      record.url = patch.url;
    }
    if (patch.values !== undefined) {
      record.values = { ...patch.values };
    }
    if (patch.secrets !== undefined) {
      stored.secrets = applyMcpSecretsPatch(stored.secrets, patch.secrets);
      record.secretNames = mcpSecretNames(stored.secrets);
    }
    if (patch.scope !== undefined) {
      record.scope = patch.scope;
    }
    if (patch.repositoryIds !== undefined) {
      record.repositoryIds = normalizeMcpRepositoryIds(patch.repositoryIds);
    }
    record.updatedAt = patch.updatedAt;
    return copy(record);
  }

  public async setMcpServerApproval(
    id: string,
    approval: { enabled: boolean; approvedBy: string; approvedAt: string },
  ): Promise<McpServerRecord> {
    const { record } = this.requireMcpServer(id);
    record.enabled = approval.enabled;
    if (approval.enabled) {
      record.approvedBy = approval.approvedBy;
      record.approvedAt = approval.approvedAt;
    } else {
      // A disabled server carries no approval at all, so a later enable is
      // a fresh decision with a fresh name on it rather than the old one
      // quietly resumed.
      delete record.approvedBy;
      delete record.approvedAt;
    }
    record.updatedAt = approval.approvedAt;
    return copy(record);
  }

  public async deleteMcpServer(id: string): Promise<void> {
    this.mcpServers.delete(id);
  }

  private requireMcpServer(id: string): StoredMcpServer {
    const stored = this.mcpServers.get(id);
    if (stored === undefined) {
      throw new Error(`Unknown MCP server: ${id}`);
    }
    return stored;
  }

  /**
   * Case-insensitive, because the name becomes a key in a vendor's config
   * file where `Linear` and `linear` are the same entry — the rule the SQL
   * stores enforce with a unique index over LOWER(name).
   */
  private assertMcpServerNameAvailable(
    projectId: string,
    name: string,
    exceptId?: string,
  ): void {
    const wanted = name.toLowerCase();
    for (const { record } of this.mcpServers.values()) {
      if (
        record.id !== exceptId &&
        record.projectId === projectId &&
        record.name.toLowerCase() === wanted
      ) {
        throw new Error(
          `An MCP server named ${name} already exists in project ${projectId}`,
        );
      }
    }
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
      repositoryConflicts(existing, repository)
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

  public async renameRepository(
    id: string,
    displayName: string | undefined,
  ): Promise<void> {
    const repository = this.repositories.get(id);
    if (repository === undefined) {
      return;
    }
    if (displayName === undefined) {
      delete repository.displayName;
      return;
    }
    repository.displayName = displayName;
  }

  public async setRepositoryPicture(
    id: string,
    picture: string | undefined,
  ): Promise<void> {
    const repository = this.repositories.get(id);
    if (repository === undefined) {
      return;
    }
    if (picture === undefined) {
      delete repository.picture;
      return;
    }
    repository.picture = picture;
  }

  public async removeRepository(id: string): Promise<void> {
    // Execution history goes with the repository — see the SQLite store's doc
    // comment. The refusal this used to throw surfaced in production as a raw
    // foreign-key error with no path forward, and the durable record of what
    // happened lives in the audit log, which none of this touches.
    //
    // An MCP server's attachment goes too. Left behind, it would re-attach
    // the server — secrets and all — to whatever repository next took this
    // id.
    for (const stored of this.mcpServers.values()) {
      stored.record.repositoryIds = stored.record.repositoryIds.filter(
        (repositoryId) => repositoryId !== id,
      );
    }
    for (const [taskId, task] of [...this.submitted]) {
      if (task.repositoryId === id) {
        this.submitted.delete(taskId);
      }
    }
    for (const [runId, state] of [...this.runs]) {
      if (state.run.repositoryId === id) {
        this.runs.delete(runId);
      }
    }
    for (const [leaseId, lease] of [...this.workLeases]) {
      if (lease.repositoryId === id) {
        this.workLeases.delete(leaseId);
      }
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
    // silently inherit.
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
    for (const [channelId, channel] of [...this.subChannels]) {
      if (channel.repositoryId !== id) {
        continue;
      }
      this.subChannels.delete(channelId);
      for (const key of [...this.subChannelMembers.keys()]) {
        if (key.startsWith(`${channelId}\0`)) {
          this.subChannelMembers.delete(key);
        }
      }
      for (const key of [...this.channelAgentMembers.keys()]) {
        if (key.startsWith(`${channelId}\0`)) {
          this.channelAgentMembers.delete(key);
        }
      }
    }
    for (const key of [...this.channelReadCursors.keys()]) {
      if (key.startsWith(`${id}\0`)) {
        this.channelReadCursors.delete(key);
      }
    }
    for (const key of [...this.channelMutes.keys()]) {
      if (key.startsWith(`${id}\0`)) {
        this.channelMutes.delete(key);
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
    // A new turn settles the conversation's previous one: its work already
    // landed, and what it was waiting for has now arrived.
    if (input.conversationId !== undefined) {
      for (const existing of this.submitted.values()) {
        if (
          existing.conversationId === input.conversationId &&
          existing.status === "open"
        ) {
          existing.status = "integrated";
          existing.completedAt = new Date().toISOString();
        }
      }
    }
    const afterTaskId =
      input.afterTaskId ??
      (input.queueAfterCurrent === true
        ? [...this.submitted.values()]
            .filter(
              (candidate) =>
                candidate.repositoryId === input.repositoryId &&
                candidate.projectId ===
                  (input.projectId ?? DEFAULT_PROJECT_ID) &&
                candidate.agentId === input.agentId &&
                candidate.submittedBy === input.submittedBy &&
                (candidate.status === "submitted" ||
                  candidate.status === "claimed"),
            )
            .sort((left, right) =>
              left.submittedAt.localeCompare(right.submittedAt),
            )
            .at(-1)?.id
        : undefined);
    const task: SubmittedTask = {
      id: createId("task"),
      kind: input.kind ?? "task",
      answerTo: input.answerTo,
      repositoryId: input.repositoryId,
      projectId: input.projectId ?? DEFAULT_PROJECT_ID,
      objective: input.objective,
      agentId: input.agentId,
      validationCommands: copy(input.validationCommands),
      submittedBy: input.submittedBy,
      afterTaskId,
      context: input.context,
      conversationId: input.conversationId,
      model: input.model,
      effort: input.effort,
      status: input.planOnly === true ? "planned" : "submitted",
      submittedAt: new Date().toISOString(),
      claimedAt: undefined,
      completedAt: undefined,
      openedAt: undefined,
      runId: undefined,
    };
    this.submitted.set(task.id, task);
    return copy(task);
  }

  public async getSubmittedTask(
    taskId: TaskId,
  ): Promise<SubmittedTask | undefined> {
    const task = this.submitted.get(taskId);
    return task === undefined ? undefined : copy(task);
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
          (filter.status === undefined || task.status === filter.status) &&
          // Defaults to work, so every caller that predates questions keeps seeing
          // exactly what it saw. The readers of this list feed coding paths — the
          // drain, the crash sweep, the queue view — and a question in any of them
          // would be treated as an objective. `any` is for the two lease-bookkeeping
          // callers that legitimately need both.
          ((filter.kind ?? "task") === "any" ||
            task.kind === (filter.kind ?? "task")),
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
      const predecessor =
        stored?.afterTaskId === undefined
          ? undefined
          : this.submitted.get(stored.afterTaskId);
      if (
        stored?.status === "submitted" &&
        (predecessor === undefined ||
          !["submitted", "claimed", "planned", "paused"].includes(predecessor.status))
      ) {
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
    if (
      task.status !== "submitted" &&
      task.status !== "claimed" &&
      // Dropping a plan you decided against is the ordinary way one ends.
      task.status !== "planned" &&
      // "That's it, we're done" is exactly how an open conversation ends.
      task.status !== "open" &&
      // Changing your mind about paused work is abandoning it, not resuming
      // it: without this a paused task could only ever be un-paused.
      task.status !== "paused"
    ) {
      throw new Error(
        `Task ${taskId} cannot be cancelled from status ${task.status}`,
      );
    }
    task.status = "cancelled";
    task.completedAt = new Date().toISOString();
    return copy(task);
  }

  public async pauseSubmittedTask(
    taskId: TaskId,
  ): Promise<SubmittedTask | undefined> {
    const task = this.submitted.get(taskId);
    // Only live work pauses. A settled task, a held plan and an open
    // conversation all answer "nothing to pause" rather than erroring: the
    // button that sent this may simply have been a frame behind the run.
    if (
      task === undefined ||
      (task.status !== "submitted" && task.status !== "claimed")
    ) {
      return undefined;
    }
    task.status = "paused";
    return copy(task);
  }

  public async resumePausedTask(
    taskId: TaskId,
  ): Promise<SubmittedTask | undefined> {
    const task = this.submitted.get(taskId);
    if (task === undefined || task.status !== "paused") {
      return undefined;
    }
    task.status = "submitted";
    // Back to the shape of work nobody has claimed: the resumed turn is
    // leased afresh, and a stale claim stamp would make it read as running
    // for however long it waited in the queue.
    task.claimedAt = undefined;
    task.runId = undefined;
    return copy(task);
  }

  public async releasePlannedTask(
    taskId: TaskId,
  ): Promise<SubmittedTask | undefined> {
    const task = this.submitted.get(taskId);
    if (task === undefined || task.status !== "planned") {
      return undefined;
    }
    task.status = "submitted";
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

  public async openSubmittedTask(taskId: TaskId, runId?: string): Promise<void> {
    const task = this.submitted.get(taskId);
    if (task === undefined) {
      throw new Error(`Unknown submitted task: ${taskId}`);
    }
    if (task.status !== "claimed") {
      throw new Error(
        `Task ${taskId} cannot be opened from status ${task.status}`,
      );
    }
    task.status = "open";
    task.openedAt = new Date().toISOString();
    task.runId = runId;
  }

  public async expireOpenTasks(
    cutoff: string,
    filter: { repositoryId?: string } = {},
  ): Promise<SubmittedTask[]> {
    const expired: SubmittedTask[] = [];
    for (const task of this.submitted.values()) {
      if (
        task.status === "open" &&
        task.openedAt !== undefined &&
        task.openedAt <= cutoff &&
        (filter.repositoryId === undefined ||
          task.repositoryId === filter.repositoryId)
      ) {
        task.status = "integrated";
        task.completedAt = new Date().toISOString();
        expired.push(copy(task));
      }
    }
    return expired;
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

  public async findWorkspaceByTaskId(
    taskId: TaskId,
  ): Promise<StoredWorkspace | undefined> {
    let newest: StoredWorkspace | undefined;
    for (const state of this.runs.values()) {
      for (const workspace of state.workspaces) {
        if (workspace.taskId !== taskId) {
          continue;
        }
        if (
          newest === undefined ||
          workspace.createdAt > newest.createdAt ||
          (workspace.createdAt === newest.createdAt &&
            workspace.id > newest.id)
        ) {
          newest = workspace;
        }
      }
    }
    return newest === undefined ? undefined : copy(newest);
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

  public async recentlyTouchedFiles(input: {
    repositoryId: string;
    conversationId?: string;
    limit?: number;
  }): Promise<TouchedFileSample[]> {
    const limit = input.limit ?? 400;
    const channelId =
      input.conversationId === undefined
        ? undefined
        : this.channelMessages.get(input.conversationId)?.channelId;
    // Which conversations belong to that channel, so a changeset can be
    // attributed to it through the task that produced it.
    const ofChannel =
      channelId === undefined
        ? undefined
        : new Set(
            [...this.submitted.values()]
              .filter((task) => {
                const conversation = task.conversationId;
                return (
                  conversation !== undefined &&
                  this.channelMessages.get(conversation)?.channelId === channelId
                );
              })
              .map((task) => task.id),
          );
    const gather = (only: ReadonlySet<string> | undefined): TouchedFileSample[] => {
      const found: TouchedFileSample[] = [];
      for (const state of this.runs.values()) {
        if (state.run.repositoryId !== input.repositoryId) {
          continue;
        }
        const landed = new Set(
          state.integrations
            .filter((entry) => entry.status === "integrated")
            .map((entry) => entry.changeSetId),
        );
        for (const changeSet of state.changeSets) {
          if (!landed.has(changeSet.id)) {
            continue;
          }
          if (only !== undefined && !only.has(changeSet.taskId)) {
            continue;
          }
          for (const patch of changeSet.patches) {
            found.push({ path: patch.path, at: changeSet.createdAt });
          }
        }
      }
      return found.sort((left, right) => right.at.localeCompare(left.at));
    };
    if (ofChannel !== undefined) {
      const scoped = gather(ofChannel);
      if (scoped.length >= CHANNEL_TOUCH_FLOOR) {
        return scoped.slice(0, Math.max(0, limit));
      }
    }
    const samples: TouchedFileSample[] = [];
    for (const state of this.runs.values()) {
      if (state.run.repositoryId !== input.repositoryId) {
        continue;
      }
      // Only what landed. A changeset that never integrated is often one that
      // touched the wrong thing, and this points at where work goes rather
      // than where it went wrong.
      const landed = new Set(
        state.integrations
          .filter((entry) => entry.status === "integrated")
          .map((entry) => entry.changeSetId),
      );
      for (const changeSet of state.changeSets) {
        if (!landed.has(changeSet.id)) {
          continue;
        }
        for (const patch of changeSet.patches) {
          samples.push({ path: patch.path, at: changeSet.createdAt });
        }
      }
    }
    return samples
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, Math.max(0, limit));
  }

  public async saveIntegration(
    runId: string,
    result: IntegrationResult,
  ): Promise<void> {
    // Bounded here too, so a test against the memory store sees the same row
    // the real one would store rather than a larger, kinder version of it.
    this.requireRun(runId).integrations.push(
      copy({ ...result, validation: boundValidation(result.validation) }),
    );
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
      .filter(
        (entry) =>
          entry.sequence > after &&
          matchesAuditFilter(entry, filter, this.runs),
      )
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
      .filter(
        (entry) =>
          entry.sequence > after &&
          matchesAuditFilter(entry, filter, this.runs),
      )
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
      channelId: message.channelId,
      projectId: message.projectId,
      kind: message.kind,
      authorId: message.authorId,
      content: message.content,
      createdAt: message.createdAt,
      ...(message.referencedMessageId === undefined
        ? {}
        : { referencedMessageId: message.referencedMessageId }),
      replies: copy(message.replies),
      reactions,
      taskId: message.taskId,
      changedFiles: message.changedFiles,
      pinnedAt: message.pinnedAt,
      pinnedBy: message.pinnedBy,
      endedAt: message.endedAt,
      ...(message.deletedAt === undefined ? {} : { deletedAt: message.deletedAt }),
      ...(message.deletedBy === undefined ? {} : { deletedBy: message.deletedBy }),
    };
  }

  public async markChannelMessageEnded(
    repositoryId: string,
    messageId: string,
  ): Promise<void> {
    const message = this.channelMessages.get(messageId);
    if (message === undefined || message.repositoryId !== repositoryId) {
      return;
    }
    message.endedAt ??= new Date().toISOString();
  }

  public async setChannelMessageChangedFiles(
    repositoryId: string,
    messageId: string,
    files: readonly ChannelChangedFile[],
  ): Promise<void> {
    const message = this.channelMessages.get(messageId);
    if (message === undefined || message.repositoryId !== repositoryId) {
      return;
    }
    // An empty list reads back as "nothing recorded", not as "recorded, and it
    // was nothing". That is what the SQL stores do — `parseChangedFiles`
    // returns undefined for an empty array — and the difference is not
    // cosmetic: the gateway decides whether to look a summary up again by
    // testing this field for undefined, so the two backends would otherwise
    // disagree about whether a thread ever gets a second chance.
    if (files.length === 0) {
      delete message.changedFiles;
      return;
    }
    message.changedFiles = [...files];
  }

  public async setChannelMessageTask(
    repositoryId: string,
    messageId: string,
    taskId: TaskId,
  ): Promise<void> {
    const message = this.channelMessages.get(messageId);
    if (message === undefined || message.repositoryId !== repositoryId) {
      return;
    }
    message.taskId = taskId;
  }

  public async setChannelMessageContent(
    repositoryId: string,
    messageId: string,
    content: string,
  ): Promise<void> {
    const message = this.channelMessages.get(messageId);
    if (message === undefined || message.repositoryId !== repositoryId) {
      return;
    }
    message.content = content;
  }

  public async channelEntryHasDependents(
    repositoryId: string,
    entryId: string,
  ): Promise<boolean> {
    for (const message of this.channelMessages.values()) {
      if (message.repositoryId !== repositoryId) {
        continue;
      }
      if (message.referencedMessageId === entryId) {
        return true;
      }
      if (
        message.replies.some(
          (reply) => reply.referencedMessageId === entryId,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  private channelAgentKey(repositoryId: string, agentId: string): string {
    return `${repositoryId}\0${agentId}`;
  }

  private channelMemberKey(
    channelId: string,
    userId: string,
    provider: string,
  ): string {
    return `${channelId}\0${userId}\0${provider}`;
  }

  private channelReadKey(
    repositoryId: string,
    userId: string,
    channelId: string,
  ): string {
    return `${repositoryId}\0${channelId}\0${userId}`;
  }

  /**
   * Muting is per repository, not per sub-channel.
   *
   * Its own key rather than {@link channelReadKey}'s, because that one gained
   * a channel when sub-channels landed and this did not: the interface takes
   * no channel here, and the SQL backends key `channel_mutes` on
   * `(repository_id, user_id)` alone. Sharing the helper compiled only while
   * the two shapes agreed, and the fix that silences the arity error by
   * passing `#general` is worse than the error — `listMutedChannels` splits
   * this key into exactly two parts, so a three-part one reads the channel id
   * as the owner, matches nobody, and drops every mute from the list.
   */
  private channelMuteKey(repositoryId: string, userId: string): string {
    return `${repositoryId}\0${userId}`;
  }

  /**
   * The `#general` id every writer that names no channel falls back to.
   *
   * Derived from the repository id rather than looked up, matching the shape
   * the `repository-sub-channels` migration mints in the SQL backends, so the
   * three stores agree on what an unqualified write means.
   */
  private generalChannelId(repositoryId: string): string {
    return `subchan_general_${repositoryId}`;
  }

  public async listChannelMessages(
    repositoryId: string,
    viewerId: string,
    filter: ChannelMessageFilter = {},
  ): Promise<ChannelMessage[]> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    // Where the message sits, not when it was said — the two differ once a
    // thread has been continued. Matches the SQL backends' COALESCE.
    const at = (message: { createdAt: string; bumpedAt?: string }): string =>
      message.bumpedAt ?? message.createdAt;
    const rows = [...this.channelMessages.values()]
      .filter((message) => message.repositoryId === repositoryId)
      .filter(
        (message) =>
          filter.channelId === undefined ||
          message.channelId === filter.channelId,
      )
      .filter(
        (message) => filter.before === undefined || at(message) < filter.before,
      )
      .sort((left, right) => at(left).localeCompare(at(right)));
    return rows
      .slice(-limit)
      .map((message) => this.toPublicChannelMessage(message, viewerId));
  }

  public async countChannelMessages(
    repositoryId: string,
    channelId?: string,
  ): Promise<ChannelMessageCounts> {
    let messages = 0;
    let replies = 0;
    for (const message of this.channelMessages.values()) {
      if (message.repositoryId !== repositoryId) {
        continue;
      }
      if (channelId !== undefined && message.channelId !== channelId) {
        continue;
      }
      messages += 1;
      replies += message.replies.length;
    }
    return { messages, replies };
  }

  public async bumpChannelMessage(
    repositoryId: string,
    messageId: string,
    at: string,
  ): Promise<void> {
    const message = this.channelMessages.get(messageId);
    if (message !== undefined && message.repositoryId === repositoryId) {
      message.bumpedAt = at;
    }
  }

  public async deleteChannelMessage(
    repositoryId: string,
    messageId: string,
  ): Promise<void> {
    const message = this.channelMessages.get(messageId);
    if (message === undefined || message.repositoryId !== repositoryId) {
      return;
    }
    this.channelMessages.delete(messageId);
    for (const candidate of this.channelMessages.values()) {
      if (candidate.referencedMessageId === messageId) {
        delete candidate.referencedMessageId;
      }
    }
  }

  public async redactChannelMessage(
    repositoryId: string,
    messageId: string,
    input: { deletedAt: string; deletedBy: string },
  ): Promise<void> {
    const message = this.channelMessages.get(messageId);
    if (message === undefined || message.repositoryId !== repositoryId) {
      return;
    }
    // First deletion wins: a second pass must not restamp who unsaid it.
    if (message.deletedAt !== undefined) {
      return;
    }
    message.content = "";
    message.deletedAt = input.deletedAt;
    message.deletedBy = input.deletedBy;
    // Reactions and the pin were both attention paid to a line that is no
    // longer there. A banner pointing at a tombstone is worse than no banner.
    message.reactions.clear();
    delete message.pinnedAt;
    delete message.pinnedBy;
  }

  public async deleteChannelReply(
    repositoryId: string,
    messageId: string,
    replyId: string,
  ): Promise<ChannelReply | undefined> {
    const message = this.channelMessages.get(messageId);
    if (message === undefined || message.repositoryId !== repositoryId) {
      return undefined;
    }
    const index = message.replies.findIndex((reply) => reply.id === replyId);
    if (index < 0) {
      return undefined;
    }
    const [reply] = message.replies.splice(index, 1);
    for (const remaining of message.replies) {
      if (remaining.referencedMessageId === reply?.id) {
        delete remaining.referencedMessageId;
      }
    }
    return reply === undefined ? undefined : copy(reply);
  }

  public async deleteChannelMessages(
    repositoryId: string,
    channelId?: string,
  ): Promise<number> {
    let removed = 0;
    for (const [id, message] of [...this.channelMessages]) {
      if (
        message.repositoryId === repositoryId &&
        (channelId === undefined || message.channelId === channelId)
      ) {
        this.channelMessages.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  public async appendChannelMessage(
    input: AppendChannelMessageInput,
  ): Promise<ChannelMessage> {
    const content = input.content.trim();
    if (content.length === 0) {
      throw new Error("A channel message must have content");
    }
    let referencedChannelId: string | undefined;
    if (input.referencedMessageId !== undefined) {
      const target = this.channelMessages.get(input.referencedMessageId);
      if (target === undefined || target.repositoryId !== input.repositoryId) {
        throw new Error(
          "A channel message reference must target the same repository",
        );
      }
      referencedChannelId = target.channelId;
    }
    // An answer belongs in the room the question was asked in, so a writer
    // that names no channel inherits the referenced message's before it falls
    // back to `#general`.
    const channelId =
      input.channelId ??
      referencedChannelId ??
      (await this.ensureGeneralSubChannel(input.repositoryId, input.projectId))
        .id;
    const message: StoredChannelMessage = {
      id: createId("chanmsg"),
      repositoryId: input.repositoryId,
      channelId,
      projectId: input.projectId,
      kind: input.kind ?? "user",
      authorId: input.authorId,
      content,
      createdAt: new Date().toISOString(),
      replies: [],
      reactions: new Map(),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.referencedMessageId === undefined
        ? {}
        : { referencedMessageId: input.referencedMessageId }),
    };
    this.channelMessages.set(message.id, message);
    return this.toPublicChannelMessage(message, input.authorId);
  }

  public async appendDirectMessage(
    input: AppendDirectMessageInput,
  ): Promise<DirectMessage> {
    const content = input.content.trim();
    if (content.length === 0) {
      throw new Error("A direct message must have content");
    }
    if (input.authorId === input.recipientId) {
      throw new Error("A direct message needs two people");
    }
    if (input.referencedMessageId !== undefined) {
      const target = this.directMessages.get(input.referencedMessageId);
      if (
        target === undefined ||
        target.projectId !== input.projectId ||
        directPairKey(target.authorId, target.recipientId) !==
          directPairKey(input.authorId, input.recipientId)
      ) {
        throw new Error(
          "A direct message reference must target the same conversation",
        );
      }
    }
    const message: DirectMessage = {
      id: createId("dm"),
      projectId: input.projectId,
      authorId: input.authorId,
      recipientId: input.recipientId,
      content,
      createdAt: new Date().toISOString(),
      ...(input.referencedMessageId === undefined
        ? {}
        : { referencedMessageId: input.referencedMessageId }),
    };
    this.directMessages.set(message.id, message);
    return { ...message };
  }

  public async updateDirectMessage(
    projectId: ProjectId,
    messageId: string,
    authorId: string,
    content: string,
  ): Promise<DirectMessage | undefined> {
    const message = this.directMessages.get(messageId);
    const updated = content.trim();
    if (
      message === undefined ||
      message.projectId !== projectId ||
      message.authorId !== authorId ||
      updated.length === 0
    ) {
      return undefined;
    }
    message.content = updated;
    return { ...message };
  }

  public async deleteDirectMessage(
    projectId: ProjectId,
    messageId: string,
    authorId: string,
  ): Promise<DirectMessage | undefined> {
    const message = this.directMessages.get(messageId);
    if (
      message === undefined ||
      message.projectId !== projectId ||
      message.authorId !== authorId
    ) {
      return undefined;
    }
    this.directMessages.delete(messageId);
    for (const candidate of this.directMessages.values()) {
      if (candidate.referencedMessageId === messageId) {
        delete candidate.referencedMessageId;
      }
    }
    return { ...message };
  }

  public async listDirectMessages(
    projectId: ProjectId,
    viewerId: string,
    otherId: string,
    filter: DirectMessageFilter = {},
  ): Promise<DirectMessage[]> {
    const pair = directPairKey(viewerId, otherId);
    const thread = [...this.directMessages.values()]
      .filter(
        (message) =>
          message.projectId === projectId &&
          directPairKey(message.authorId, message.recipientId) === pair &&
          (filter.before === undefined || message.createdAt < filter.before),
      )
      // Timestamps are milliseconds and ids are random, so two messages sent
      // in the same millisecond have no natural order. The id is not a
      // meaningful tiebreak, but it is a stable one, and the SQL stores order
      // the same way — a conversation that reads differently depending on
      // which backend served it would be worse than an arbitrary order.
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
    // The page is the newest `limit`, returned oldest-first: a conversation is
    // read from the bottom, so paging backwards has to take from the end and
    // then restore reading order, not take the first rows it finds.
    const page =
      filter.limit === undefined ? thread : thread.slice(-filter.limit);
    return page.map((message) => ({ ...message }));
  }

  public async listDirectConversations(
    projectId: ProjectId,
    viewerId: string,
  ): Promise<DirectConversation[]> {
    const byCorrespondent = new Map<string, DirectConversation>();
    const mine = [...this.directMessages.values()]
      .filter(
        (message) =>
          message.projectId === projectId &&
          (message.authorId === viewerId || message.recipientId === viewerId),
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
    for (const message of mine) {
      const other =
        message.authorId === viewerId ? message.recipientId : message.authorId;
      const existing = byCorrespondent.get(other);
      const unread =
        (existing?.unread ?? 0) +
        (message.recipientId === viewerId && message.readAt === undefined
          ? 1
          : 0);
      // Ascending, so the last one seen for a correspondent is the latest.
      byCorrespondent.set(other, {
        userId: other,
        lastMessage: { ...message },
        unread,
      });
    }
    return [...byCorrespondent.values()].sort((left, right) =>
      right.lastMessage.createdAt.localeCompare(left.lastMessage.createdAt),
    );
  }

  public async markDirectMessagesRead(
    projectId: ProjectId,
    viewerId: string,
    otherId: string,
    at: string,
  ): Promise<number> {
    let marked = 0;
    for (const message of this.directMessages.values()) {
      if (
        message.projectId === projectId &&
        message.recipientId === viewerId &&
        message.authorId === otherId &&
        message.readAt === undefined
      ) {
        message.readAt = at;
        marked += 1;
      }
    }
    return marked;
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
    if (
      input.referencedMessageId !== undefined &&
      input.referencedMessageId !== message.id &&
      !message.replies.some((reply) => reply.id === input.referencedMessageId)
    ) {
      throw new Error("A reply reference must target the same thread");
    }
    const reply: StoredChannelReply = {
      id: createId("chanreply"),
      messageId: message.id,
      kind: input.kind ?? "user",
      authorId: input.authorId,
      content,
      createdAt: new Date().toISOString(),
      ...(input.referencedMessageId === undefined
        ? {}
        : { referencedMessageId: input.referencedMessageId }),
    };
    message.replies.push(reply);
    return copy(reply);
  }

  public async setChannelReplyContent(
    repositoryId: string,
    messageId: string,
    replyId: string,
    content: string,
  ): Promise<void> {
    const message = this.channelMessages.get(messageId);
    if (message === undefined || message.repositoryId !== repositoryId) {
      return;
    }
    const reply = message.replies.find((candidate) => candidate.id === replyId);
    if (reply !== undefined) {
      reply.content = content;
    }
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

  public async toggleChannelMessagePin(
    repositoryId: string,
    messageId: string,
    userId: string,
  ): Promise<ChannelMessage> {
    const message = this.channelMessages.get(messageId);
    if (message === undefined || message.repositoryId !== repositoryId) {
      throw new Error(`Unknown channel message: ${messageId}`);
    }
    if (message.pinnedAt === undefined) {
      message.pinnedAt = new Date().toISOString();
      message.pinnedBy = userId;
    } else {
      delete message.pinnedAt;
      delete message.pinnedBy;
    }
    return this.toPublicChannelMessage(message, userId);
  }

  public async listPinnedChannelMessages(
    repositoryId: string,
    viewerId: string,
    channelId?: string,
  ): Promise<ChannelMessage[]> {
    return [...this.channelMessages.values()]
      .filter(
        (message) =>
          message.repositoryId === repositoryId &&
          (channelId === undefined || message.channelId === channelId) &&
          message.pinnedAt !== undefined,
      )
      .sort(
        (left, right) =>
          String(left.pinnedAt).localeCompare(String(right.pinnedAt)) ||
          left.id.localeCompare(right.id),
      )
      .map((message) => this.toPublicChannelMessage(message, viewerId));
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

  public async clearChannelAgentNameOverrides(agentId: string): Promise<void> {
    for (const [key, override] of this.channelAgentOverrides) {
      if (override.agentId !== agentId || override.name === undefined) {
        continue;
      }
      const { name: _dropped, ...rest } = override;
      // A row that only ever carried a name has nothing left to say once the
      // name is the account's again, so it goes rather than lingering empty.
      if (
        (rest.role ?? "") === "" &&
        (rest.model ?? "") === "" &&
        (rest.effort ?? "") === ""
      ) {
        this.channelAgentOverrides.delete(key);
      } else {
        this.channelAgentOverrides.set(key, {
          ...rest,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  public async listAgentCallSigns(): Promise<AgentCallSign[]> {
    return [...this.agentCallSigns.values()].map((sign) => copy(sign));
  }

  public async setAgentCallSign(
    userId: string,
    provider: string,
    callSign: string,
    visibility: "personal" | "org" = "personal",
  ): Promise<AgentCallSign> {
    const record: AgentCallSign = {
      userId,
      provider,
      callSign,
      assignedAt: new Date().toISOString(),
      visibility,
    };
    this.agentCallSigns.set(`${userId}\0${provider}`, record);
    return copy(record);
  }

  public async clearAgentCallSign(
    userId: string,
    provider: string,
  ): Promise<void> {
    this.agentCallSigns.delete(`${userId}\0${provider}`);
  }

  /* ------------------------------------------------- sub-channels ---- */

  public async listSubChannels(repositoryId: string): Promise<SubChannel[]> {
    return [...this.subChannels.values()]
      .filter((channel) => channel.repositoryId === repositoryId)
      .sort(
        (left, right) =>
          Number(right.slug === GENERAL_SUB_CHANNEL_SLUG) -
            Number(left.slug === GENERAL_SUB_CHANNEL_SLUG) ||
          left.slug.localeCompare(right.slug),
      )
      .map((channel) => ({ ...channel }));
  }

  public async getSubChannel(
    repositoryId: string,
    channelId: string,
  ): Promise<SubChannel | undefined> {
    const channel = this.subChannels.get(channelId);
    return channel === undefined || channel.repositoryId !== repositoryId
      ? undefined
      : { ...channel };
  }

  public async ensureGeneralSubChannel(
    repositoryId: string,
    projectId: ProjectId,
  ): Promise<SubChannel> {
    const id = this.generalChannelId(repositoryId);
    const existing = this.subChannels.get(id);
    if (existing !== undefined) {
      return { ...existing };
    }
    const channel: SubChannel = {
      id,
      repositoryId,
      projectId,
      slug: GENERAL_SUB_CHANNEL_SLUG,
      name: GENERAL_SUB_CHANNEL_SLUG,
      visibility: "public",
      createdAt: new Date().toISOString(),
    };
    this.subChannels.set(id, channel);
    return { ...channel };
  }

  public async createSubChannel(
    input: CreateSubChannelInput,
  ): Promise<SubChannel> {
    const slug = input.slug.trim().toLowerCase();
    if (slug.length === 0) {
      throw new Error("A sub-channel needs a name");
    }
    for (const channel of this.subChannels.values()) {
      if (channel.repositoryId === input.repositoryId && channel.slug === slug) {
        throw new Error("A sub-channel with that name already exists");
      }
    }
    const channel: SubChannel = {
      id: createId("subchan"),
      repositoryId: input.repositoryId,
      projectId: input.projectId,
      slug,
      name: input.name?.trim() === "" ? slug : (input.name?.trim() ?? slug),
      visibility: input.visibility ?? "read_only",
      createdAt: new Date().toISOString(),
      ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
    };
    this.subChannels.set(channel.id, channel);
    return { ...channel };
  }

  public async updateSubChannel(
    repositoryId: string,
    channelId: string,
    input: UpdateSubChannelInput,
  ): Promise<SubChannel> {
    const channel = this.subChannels.get(channelId);
    if (channel === undefined || channel.repositoryId !== repositoryId) {
      throw new Error("Sub-channel was not found");
    }
    if (input.slug !== undefined) {
      const slug = input.slug.trim().toLowerCase();
      if (slug.length === 0) {
        throw new Error("A sub-channel needs a name");
      }
      for (const other of this.subChannels.values()) {
        if (
          other.id !== channelId &&
          other.repositoryId === repositoryId &&
          other.slug === slug
        ) {
          throw new Error("A sub-channel with that name already exists");
        }
      }
      channel.slug = slug;
    }
    if (input.name !== undefined) {
      channel.name = input.name.trim() === "" ? channel.slug : input.name.trim();
    }
    if (input.visibility !== undefined) {
      channel.visibility = input.visibility;
    }
    return { ...channel };
  }

  public async deleteSubChannel(
    repositoryId: string,
    channelId: string,
  ): Promise<void> {
    const channel = this.subChannels.get(channelId);
    if (channel === undefined || channel.repositoryId !== repositoryId) {
      return;
    }
    if (channel.slug === GENERAL_SUB_CHANNEL_SLUG) {
      throw new Error("The #general channel cannot be deleted");
    }
    await this.deleteChannelMessages(repositoryId, channelId);
    this.subChannels.delete(channelId);
    for (const key of [...this.subChannelMembers.keys()]) {
      if (key.startsWith(`${channelId}\0`)) {
        this.subChannelMembers.delete(key);
      }
    }
    for (const key of [...this.channelAgentMembers.keys()]) {
      if (key.startsWith(`${channelId}\0`)) {
        this.channelAgentMembers.delete(key);
      }
    }
    for (const key of [...this.channelReadCursors.keys()]) {
      if (key.includes(`\0${channelId}\0`)) {
        this.channelReadCursors.delete(key);
      }
    }
  }

  public async listSubChannelMembers(
    channelId: string,
  ): Promise<SubChannelMember[]> {
    return [...this.subChannelMembers.values()]
      .filter((member) => member.channelId === channelId)
      .sort((left, right) => left.userId.localeCompare(right.userId))
      .map((member) => ({ ...member }));
  }

  public async setSubChannelMember(
    channelId: string,
    userId: string,
    isMember: boolean,
  ): Promise<void> {
    const key = `${channelId}\0${userId}`;
    if (isMember) {
      if (!this.subChannelMembers.has(key)) {
        this.subChannelMembers.set(key, {
          channelId,
          userId,
          addedAt: new Date().toISOString(),
        });
      }
    } else {
      this.subChannelMembers.delete(key);
    }
  }

  public async isSubChannelMember(
    channelId: string,
    userId: string,
  ): Promise<boolean> {
    return this.subChannelMembers.has(`${channelId}\0${userId}`);
  }

  public async listChannelAgentMembers(
    repositoryId: string,
    channelId?: string,
  ): Promise<Array<{ userId: string; provider: string; channelId: string }>> {
    const result: Array<{
      userId: string;
      provider: string;
      channelId: string;
    }> = [];
    for (const member of this.channelAgentMembers.values()) {
      if (member.repositoryId !== repositoryId) {
        continue;
      }
      if (channelId !== undefined && member.channelId !== channelId) {
        continue;
      }
      result.push({
        userId: member.userId,
        provider: member.provider,
        channelId: member.channelId,
      });
    }
    return result;
  }

  public async setChannelAgentMember(
    repositoryId: string,
    userId: string,
    provider: string,
    isMember: boolean,
    channelId?: string,
  ): Promise<void> {
    const target = channelId ?? this.generalChannelId(repositoryId);
    const key = this.channelMemberKey(target, userId, provider);
    if (isMember) {
      this.channelAgentMembers.set(key, {
        repositoryId,
        channelId: target,
        userId,
        provider,
      });
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
    channelId?: string,
  ): Promise<void> {
    // Forward only, matching the persistent stores: a request that arrives
    // out of order must not hand back messages the reader has already seen.
    const key = this.channelReadKey(
      repositoryId,
      userId,
      channelId ?? this.generalChannelId(repositoryId),
    );
    const current = this.channelReadCursors.get(key);
    if (current === undefined || current < at) {
      this.channelReadCursors.set(key, at);
    }
  }

  public async getChannelReadCursor(
    repositoryId: string,
    userId: string,
    channelId?: string,
  ): Promise<string | undefined> {
    return this.channelReadCursors.get(
      this.channelReadKey(
        repositoryId,
        userId,
        channelId ?? this.generalChannelId(repositoryId),
      ),
    );
  }

  public async countUnreadByChannel(
    repositoryId: string,
    userId: string,
  ): Promise<Record<string, number>> {
    // Deliberately the same three rules the SQL backends encode, in the same
    // order, because this store and those have drifted apart before and the
    // contract test compares them: a message counts when it is not this
    // reader's own, is not deleted, and is newer than this reader's cursor
    // for the room it is in. No cursor means the room was never opened, and
    // "" sorts before every ISO timestamp, so all of it counts.
    const unread: Record<string, number> = {};
    for (const message of this.channelMessages.values()) {
      if (message.repositoryId !== repositoryId) {
        continue;
      }
      const channelId = message.channelId || this.generalChannelId(repositoryId);
      const readAt =
        this.channelReadCursors.get(
          this.channelReadKey(repositoryId, userId, channelId),
        ) ?? "";
      let count = 0;
      if (
        message.deletedAt === undefined &&
        message.authorId !== userId &&
        message.createdAt > readAt
      ) {
        count += 1;
      }
      // Replies are not filtered on the root's deletion: a tombstoned root
      // keeps its thread, and an answer in it is still something you missed.
      for (const reply of message.replies) {
        if (reply.authorId !== userId && reply.createdAt > readAt) {
          count += 1;
        }
      }
      if (count > 0) {
        unread[channelId] = (unread[channelId] ?? 0) + count;
      }
    }
    return unread;
  }

  public async setChannelMuted(
    repositoryId: string,
    userId: string,
    muted: boolean,
  ): Promise<void> {
    const key = this.channelMuteKey(repositoryId, userId);
    if (muted) {
      this.channelMutes.set(key, new Date().toISOString());
    } else {
      this.channelMutes.delete(key);
    }
  }

  public async listMutedChannels(userId: string): Promise<string[]> {
    const muted: string[] = [];
    for (const key of this.channelMutes.keys()) {
      const [repositoryId = "", owner = ""] = key.split("\0");
      if (owner === userId) {
        muted.push(repositoryId);
      }
    }
    return muted.sort((left, right) => left.localeCompare(right));
  }

  public async getCatchUpCursor(
    projectId: string,
    userId: string,
  ): Promise<CatchUpCursor | undefined> {
    const seenAt = this.catchUpCursors.get(catchUpKey(projectId, userId));
    return seenAt === undefined ? undefined : { projectId, userId, seenAt };
  }

  public async markCatchUpSeen(
    projectId: string,
    userId: string,
    at: string,
  ): Promise<void> {
    // Forward-only, matching the SQL stores' conditional upsert.
    const key = catchUpKey(projectId, userId);
    const seen = this.catchUpCursors.get(key);
    if (seen === undefined || seen < at) {
      this.catchUpCursors.set(key, at);
    }
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

  public async runInTransaction<T>(
    body: (store: CoordinationStore) => Promise<T>,
  ): Promise<T> {
    // Snapshot and restore, which is what "transaction" can mean for a store
    // that is a set of maps in one process. It gives the same guarantee the
    // SQL backends give a caller — a body that throws leaves nothing behind —
    // and it is not durable, which this backend never was.
    //
    // Nesting joins, matching the SQL backends: only the outermost call holds
    // a snapshot, so only it can roll back.
    if (this.transactionSnapshot !== undefined) {
      return await body(this);
    }
    const snapshot = new Map<string, Map<unknown, unknown>>();
    for (const [name, map] of this.mutableCollections()) {
      snapshot.set(name, new Map(map));
    }
    this.transactionSnapshot = snapshot;
    try {
      const result = await body(this);
      return result;
    } catch (error) {
      for (const [name, map] of this.mutableCollections()) {
        const saved = snapshot.get(name);
        if (saved === undefined) {
          continue;
        }
        map.clear();
        for (const [key, value] of saved) {
          map.set(key, value);
        }
      }
      throw error;
    } finally {
      this.transactionSnapshot = undefined;
    }
  }

  /**
   * The maps a rollback has to put back.
   *
   * Listed rather than discovered, because a map this misses is one a failed
   * transaction would leave written — so the list is the contract, and a new
   * collection has to be added to it deliberately.
   */
  private mutableCollections(): Array<[string, Map<unknown, unknown>]> {
    return [
      ["users", this.users as unknown as Map<unknown, unknown>],
      ["organizations", this.organizations as unknown as Map<unknown, unknown>],
      ["memberships", this.memberships as unknown as Map<unknown, unknown>],
      ["projects", this.projects as unknown as Map<unknown, unknown>],
      ["subscriptions", this.subscriptions as unknown as Map<unknown, unknown>],
      ["signupIntents", this.signupIntents as unknown as Map<unknown, unknown>],
      [
        "waitlistEntries",
        this.waitlistEntries as unknown as Map<unknown, unknown>,
      ],
    ];
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
