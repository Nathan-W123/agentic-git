import {
  createId,
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
  verifyAuditChain,
  type AuditChainVerification,
  type ChainedAuditEvent,
} from "./audit-chain.js";
import type {
  ApiTokenRecord,
  AppendAuditInput,
  LeaseTaskInput,
  LeasedWork,
  WorkLease,
  WorkLeaseStatus,
  WorkerRecord,
  ApprovalFilter,
  AuditEventFilter,
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
  UserAccount,
} from "./store.js";
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
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
 * Non-durable store with identical semantics to the SQLite one.
 *
 * Keeps the coordinator's default behavior dependency-free and lets tests
 * exercise the write path without touching disk.
 */
export class InMemoryCoordinationStore implements CoordinationStore {
  private readonly runs = new Map<string, RunState>();
  private readonly audit: ChainedAuditEvent[] = [];
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
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly workLeases = new Map<string, WorkLease>();
  private readonly approvals = new Map<string, ApprovalRequest>();

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
    },
  ): Promise<UserAccount> {
    const user = this.requireUser(id);
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
    name: string;
    adapters: string[];
    version: string;
  }): Promise<WorkerRecord> {
    this.requireUser(input.userId);
    const now = new Date().toISOString();
    const worker: WorkerRecord = {
      id: createId("worker"),
      userId: input.userId,
      name: input.name,
      adapters: [...input.adapters],
      version: input.version,
      registeredAt: now,
      lastSeenAt: now,
    };
    this.workers.set(worker.id, worker);
    return { ...worker, adapters: [...worker.adapters] };
  }

  public async listWorkers(): Promise<WorkerRecord[]> {
    return [...this.workers.values()]
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
          (filter.issuedAfter === undefined ||
            lease.issuedAt > filter.issuedAfter),
      )
      .sort((left, right) => right.issuedAt.localeCompare(left.issuedAt))
      .map((lease) => ({ ...lease }));
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

    const previousHash = this.audit.at(-1)?.chainHash ?? GENESIS_HASH;
    const payloadHash = hashAuditPayload(event);
    this.audit.push({
      event,
      sequence: this.audit.length + 1,
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
          (filter.runId === undefined || entry.runId === filter.runId),
      )
      .slice(0, limit);
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
      audit: await this.listAudit(runId),
    });
  }

  public async listAudit(runId?: string): Promise<AuditEvent[]> {
    return this.audit
      .filter((_, index) => runId === undefined || this.auditRuns[index] === runId)
      .map((entry) => copy(entry.event));
  }

  public async verifyAudit(): Promise<AuditChainVerification> {
    return verifyAuditChain(this.audit);
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
