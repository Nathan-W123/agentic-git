import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createId,
  type AgentPlan,
  type ApprovalDecision,
  type ApprovalRequest,
  type AuditEvent,
  type CanonicalVersion,
  type ChangeSet,
  type CommandResult,
  type ConflictAssessment,
  type ConflictDisposition,
  type ConflictEvidence,
  type CoordinatorDecision,
  type FilePatch,
  type FilePatchStatus,
  type IntegrationResult,
  type IntegrationStatus,
  type ProjectId,
  type ResourceLease,
  type RiskLevel,
  type ScopeChangeDecision,
  type ScopeChangeRequest,
  type SequencedAuditEvent,
  type TaskDefinition,
  type TaskId,
  type TaskStatus,
  type TestResult,
  type ValidationCommand,
} from "@coord/shared-types";

import {
  GENESIS_HASH,
  chainHash,
  hashAuditPayload,
  verifyAuditChain,
  type AuditChainVerification,
  type ChainedAuditEvent,
} from "./audit-chain.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./schema.js";
import type {
  ApiTokenRecord,
  AppendAuditInput,
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
  RunMode,
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
  SubmittedTaskStatus,
  UserAccount,
  LeaseTaskInput,
  LeasedWork,
  WorkLease,
  WorkLeaseStatus,
  WorkerRecord,
} from "./store.js";
import {
  DEFAULT_PROJECT_ID,
} from "./store.js";

type Row = Record<string, unknown>;

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`Expected a string in column ${column}`);
  }
  return value;
}

function optionalText(row: Row, column: string): string | undefined {
  const value = row[column];
  return typeof value === "string" ? value : undefined;
}

function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value !== "number") {
    throw new Error(`Expected a number in column ${column}`);
  }
  return value;
}

function parseJson<T>(row: Row, column: string): T {
  return JSON.parse(text(row, column)) as T;
}

function optionalJson<T>(row: Row, column: string): T | undefined {
  const value = optionalText(row, column);
  return value === undefined ? undefined : (JSON.parse(value) as T);
}

/**
 * SQLite-backed coordination store.
 *
 * Uses Node's built-in `node:sqlite`, so the coordinator gains durable state
 * without adding a runtime dependency or requiring a database server. The
 * interface is async and the driver is synchronous; that mismatch is
 * deliberate, so a Postgres implementation can replace this one without
 * touching a caller.
 */
export class SqliteCoordinationStore implements CoordinationStore {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** `:memory:` is accepted for tests. Any other path is created if missing. */
  public static open(databasePath: string): SqliteCoordinationStore {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    }

    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec("PRAGMA busy_timeout = 5000");
      const store = new SqliteCoordinationStore(db);
      store.migrate();
      return store;
    } catch (error) {
      // A failed open must not leave the handle behind: WAL keeps -wal and
      // -shm files locked, which on Windows blocks deleting the database.
      db.close();
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
    );
    const current = this.db
      .prepare("SELECT MAX(version) AS version FROM schema_version")
      .get() as Row | undefined;
    const applied =
      current === undefined || current["version"] === null
        ? 0
        : integer(current, "version");

    if (applied > LATEST_SCHEMA_VERSION) {
      throw new Error(
        `The coordination database is at schema version ${applied}, ` +
          `newer than this build understands (${LATEST_SCHEMA_VERSION})`,
      );
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= applied) {
        continue;
      }
      this.db.exec("BEGIN");
      try {
        for (const statement of migration.statements) {
          this.db.exec(statement);
        }
        this.db
          .prepare("INSERT INTO schema_version (version) VALUES (?)")
          .run(migration.version);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  public async saveRepository(repository: StoredRepository): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO repositories
           (id, path, branch, first_seen_at, provider, remote_url)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        repository.id,
        repository.path,
        repository.branch,
        new Date().toISOString(),
        repository.provider ?? "local",
        repository.remoteUrl ?? null,
      );
    const existing = await this.getRepository(repository.id);
    if (
      existing === undefined ||
      existing.path !== repository.path ||
      existing.branch !== repository.branch ||
      (existing.provider ?? "local") !== (repository.provider ?? "local") ||
      existing.remoteUrl !== repository.remoteUrl
    ) {
      throw new Error(
        `Repository id ${repository.id} is already mapped to a different canonical repository`,
      );
    }
  }

  public async createOrganization(input: {
    slug: string;
    name: string;
  }): Promise<Organization> {
    const organization: Organization = {
      id: createId("org"),
      slug: input.slug.trim().toLowerCase(),
      name: input.name.trim(),
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO organizations (id, slug, name, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        organization.id,
        organization.slug,
        organization.name,
        organization.createdAt,
      );
    return organization;
  }

  public async updateOrganization(
    id: string,
    input: { name?: string; slug?: string },
  ): Promise<Organization> {
    const existing = await this.getOrganization(id);
    if (existing === undefined) {
      throw new Error(`Unknown organization: ${id}`);
    }
    const organization: Organization = {
      ...existing,
      name: input.name?.trim() ?? existing.name,
      slug: input.slug?.trim().toLowerCase() ?? existing.slug,
    };
    this.db
      .prepare("UPDATE organizations SET slug = ?, name = ? WHERE id = ?")
      .run(organization.slug, organization.name, id);
    return organization;
  }

  public async listOrganizations(userId?: string): Promise<Organization[]> {
    const rows = (
      userId === undefined
        ? this.db
            .prepare("SELECT * FROM organizations ORDER BY name, id")
            .all()
        : this.db
            .prepare(
              `SELECT o.* FROM organizations o
               JOIN organization_memberships m ON m.organization_id = o.id
               WHERE m.user_id = ?
               ORDER BY o.name, o.id`,
            )
            .all(userId)
    ) as Row[];
    return rows.map((row) => this.toOrganization(row));
  }

  public async getOrganization(
    id: string,
  ): Promise<Organization | undefined> {
    const row = this.db
      .prepare("SELECT * FROM organizations WHERE id = ?")
      .get(id) as Row | undefined;
    return row === undefined ? undefined : this.toOrganization(row);
  }

  public async createUser(input: {
    email: string;
    displayName: string;
    passwordDigest: string;
    systemAdmin?: boolean;
  }): Promise<UserAccount> {
    const user: UserAccount = {
      id: createId("user"),
      email: input.email.trim().toLowerCase(),
      displayName: input.displayName.trim(),
      passwordDigest: input.passwordDigest,
      systemAdmin: input.systemAdmin ?? false,
      disabled: false,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO users
           (id, email, display_name, password_digest, system_admin, disabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id,
        user.email,
        user.displayName,
        user.passwordDigest,
        user.systemAdmin ? 1 : 0,
        0,
        user.createdAt,
      );
    return user;
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
    const existing = await this.getUser(id);
    if (existing === undefined) {
      throw new Error(`Unknown user: ${id}`);
    }
    const user: UserAccount = {
      ...existing,
      displayName: input.displayName?.trim() ?? existing.displayName,
      passwordDigest: input.passwordDigest ?? existing.passwordDigest,
      disabled: input.disabled ?? existing.disabled,
      systemAdmin: input.systemAdmin ?? existing.systemAdmin,
    };
    this.db
      .prepare(
        `UPDATE users
         SET display_name = ?, password_digest = ?, disabled = ?, system_admin = ?
         WHERE id = ?`,
      )
      .run(
        user.displayName,
        user.passwordDigest,
        user.disabled ? 1 : 0,
        user.systemAdmin ? 1 : 0,
        id,
      );
    return user;
  }

  public async getUser(id: string): Promise<UserAccount | undefined> {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row === undefined ? undefined : this.toUser(row);
  }

  public async getUserByEmail(
    email: string,
  ): Promise<UserAccount | undefined> {
    const row = this.db
      .prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE")
      .get(email.trim()) as Row | undefined;
    return row === undefined ? undefined : this.toUser(row);
  }

  public async listUsers(): Promise<UserAccount[]> {
    return (
      this.db.prepare("SELECT * FROM users ORDER BY email, id").all() as Row[]
    ).map((row) => this.toUser(row));
  }

  public async countUsers(): Promise<number> {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM users").get() as Row;
    return integer(row, "count");
  }

  public async saveMembership(input: {
    organizationId: string;
    userId: string;
    role: OrganizationRole;
  }): Promise<OrganizationMembership> {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO organization_memberships
           (organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(organization_id, user_id)
         DO UPDATE SET role = excluded.role`,
      )
      .run(input.organizationId, input.userId, input.role, createdAt);
    const membership = await this.getMembership(
      input.organizationId,
      input.userId,
    );
    if (membership === undefined) {
      throw new Error("Membership was not persisted");
    }
    return membership;
  }

  public async removeMembership(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM organization_memberships
         WHERE organization_id = ? AND user_id = ?`,
      )
      .run(organizationId, userId);
  }

  public async listMemberships(
    organizationId: string,
  ): Promise<OrganizationMembership[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM organization_memberships
         WHERE organization_id = ? ORDER BY created_at, user_id`,
      )
      .all(organizationId) as Row[];
    return rows.map((row) => this.toMembership(row));
  }

  public async getMembership(
    organizationId: string,
    userId: string,
  ): Promise<OrganizationMembership | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM organization_memberships
         WHERE organization_id = ? AND user_id = ?`,
      )
      .get(organizationId, userId) as Row | undefined;
    return row === undefined ? undefined : this.toMembership(row);
  }

  public async createProject(input: {
    organizationId: string;
    slug: string;
    name: string;
    description?: string;
  }): Promise<ProjectRecord> {
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      id: createId("project"),
      organizationId: input.organizationId,
      slug: input.slug.trim().toLowerCase(),
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      archived: false,
      policy: undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO projects
           (id, organization_id, slug, name, description, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.organizationId,
        project.slug,
        project.name,
        project.description,
        0,
        now,
        now,
      );
    return project;
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
    const existing = await this.getProject(id);
    if (existing === undefined) {
      throw new Error(`Unknown project: ${id}`);
    }
    const project: ProjectRecord = {
      ...existing,
      slug: input.slug?.trim().toLowerCase() ?? existing.slug,
      name: input.name?.trim() ?? existing.name,
      description: input.description?.trim() ?? existing.description,
      archived: input.archived ?? existing.archived,
      policy:
        input.policy === undefined
          ? existing.policy
          : input.policy === null
            ? undefined
            : structuredClone(input.policy),
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE projects
         SET slug = ?, name = ?, description = ?, archived = ?, policy_json = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        project.slug,
        project.name,
        project.description,
        project.archived ? 1 : 0,
        project.policy === undefined ? null : JSON.stringify(project.policy),
        project.updatedAt,
        id,
      );
    return project;
  }

  public async getProject(id: string): Promise<ProjectRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row === undefined ? undefined : this.toProject(row);
  }

  public async listProjects(
    organizationId: string,
  ): Promise<ProjectRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM projects
         WHERE organization_id = ? ORDER BY name, id`,
      )
      .all(organizationId) as Row[];
    return rows.map((row) => this.toProject(row));
  }

  public async linkRepository(
    projectId: string,
    repositoryId: string,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO project_repositories
           (project_id, repository_id, linked_at)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id, repository_id) DO NOTHING`,
      )
      .run(projectId, repositoryId, new Date().toISOString());
  }

  public async unlinkRepository(
    projectId: string,
    repositoryId: string,
  ): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM project_repositories
         WHERE project_id = ? AND repository_id = ?`,
      )
      .run(projectId, repositoryId);
  }

  public async listProjectRepositories(
    projectId: string,
  ): Promise<StoredRepository[]> {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM repositories r
         JOIN project_repositories pr ON pr.repository_id = r.id
         WHERE pr.project_id = ? ORDER BY r.id`,
      )
      .all(projectId) as Row[];
    return rows.map((row) => this.toRepository(row));
  }

  public async projectHasRepository(
    projectId: string,
    repositoryId: string,
  ): Promise<boolean> {
    return (
      this.db
        .prepare(
          `SELECT 1 AS found FROM project_repositories
           WHERE project_id = ? AND repository_id = ?`,
        )
        .get(projectId, repositoryId) !== undefined
    );
  }

  public async registerWorker(input: {
    userId: string;
    name: string;
    adapters: string[];
    version: string;
  }): Promise<WorkerRecord> {
    if ((await this.getUser(input.userId)) === undefined) {
      throw new Error(`Unknown user: ${input.userId}`);
    }
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
    this.db
      .prepare(
        `INSERT INTO workers
           (id, user_id, name, adapters_json, version, registered_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        worker.id,
        worker.userId,
        worker.name,
        JSON.stringify(worker.adapters),
        worker.version,
        worker.registeredAt,
        worker.lastSeenAt,
      );
    return worker;
  }

  public async listWorkers(): Promise<WorkerRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM workers ORDER BY last_seen_at DESC")
      .all() as Row[];
    return rows.map((row) => this.toWorker(row));
  }

  public async getWorker(id: string): Promise<WorkerRecord | undefined> {
    const row = this.db
      .prepare("SELECT * FROM workers WHERE id = ?")
      .get(id) as Row | undefined;
    return row === undefined ? undefined : this.toWorker(row);
  }

  public async touchWorker(id: string, at: string): Promise<void> {
    this.db
      .prepare("UPDATE workers SET last_seen_at = ? WHERE id = ?")
      .run(at, id);
  }

  public async leaseNextTask(
    input: LeaseTaskInput,
  ): Promise<LeasedWork | undefined> {
    if ((await this.getWorker(input.workerId)) === undefined) {
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

    // BEGIN IMMEDIATE takes the write lock up front, so two workers polling at
    // the same moment serialise here rather than both reading the same
    // pending row and racing to claim it.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date();
      const nowIso = now.toISOString();
      const expired = this.db
        .prepare(
          `SELECT task_id FROM work_leases
           WHERE status = 'active' AND expires_at <= ?`,
        )
        .all(nowIso) as Row[];
      this.db
        .prepare(
          `UPDATE work_leases
           SET status = 'expired', finished_at = ?, outcome = 'expired',
               detail = 'lease expired'
           WHERE status = 'active' AND expires_at <= ?`,
        )
        .run(nowIso, nowIso);
      for (const row of expired) {
        this.db
          .prepare(
            `UPDATE submitted_tasks SET status = 'submitted', claimed_at = NULL
             WHERE id = ? AND status = 'claimed'`,
          )
          .run(text(row, "task_id"));
      }

      const clauses = ["status = 'submitted'"];
      const values: (string | number)[] = [];
      if (input.taskId !== undefined) {
        clauses.push("id = ?");
        values.push(input.taskId);
      }
      if (input.repositoryId !== undefined) {
        clauses.push("repository_id = ?");
        values.push(input.repositoryId);
      }
      if (input.projectId !== undefined) {
        clauses.push("project_id = ?");
        values.push(input.projectId);
      }
      // The parallelism cap bounds concurrent leases per repository. It is a
      // throughput valve, not the safety mechanism: exact-base integration
      // and stale-requeue at acceptance hold at any setting.
      clauses.push(
        `(SELECT COUNT(*) FROM work_leases
          WHERE work_leases.repository_id = submitted_tasks.repository_id
            AND work_leases.status = 'active') < ?`,
      );
      values.push(parallelism);

      const row = this.db
        .prepare(
          `SELECT * FROM submitted_tasks WHERE ${clauses.join(" AND ")}
           ORDER BY submitted_at, rowid LIMIT 1`,
        )
        .get(...values) as Row | undefined;
      if (row === undefined) {
        this.db.exec("COMMIT");
        return undefined;
      }

      const task = this.toSubmittedTask(row);
      const lease: WorkLease = {
        id: createId("lease"),
        taskId: task.id,
        workerId: input.workerId,
        repositoryId: task.repositoryId,
        projectId: task.projectId,
        status: "active",
        baseRevision: input.baseRevision,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
        heartbeatAt: now.toISOString(),
        finishedAt: undefined,
        outcome: undefined,
        detail: undefined,
      };

      this.db
        .prepare(
          "UPDATE submitted_tasks SET status = 'claimed', claimed_at = ? WHERE id = ?",
        )
        .run(lease.issuedAt, task.id);
      this.db
        .prepare(
          `INSERT INTO work_leases
             (id, task_id, worker_id, repository_id, project_id, status,
              base_revision, issued_at, expires_at, heartbeat_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        )
        .run(
          lease.id,
          lease.taskId,
          lease.workerId,
          lease.repositoryId,
          lease.projectId ?? null,
          lease.baseRevision,
          lease.issuedAt,
          lease.expiresAt,
          lease.heartbeatAt,
        );
      this.db.exec("COMMIT");
      return { lease, task: { ...task, status: "claimed", claimedAt: lease.issuedAt } };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public async getWorkLease(id: string): Promise<WorkLease | undefined> {
    const row = this.db
      .prepare("SELECT * FROM work_leases WHERE id = ?")
      .get(id) as Row | undefined;
    return row === undefined ? undefined : this.toWorkLease(row);
  }

  public async listWorkLeases(
    filter: { workerId?: string; status?: WorkLeaseStatus } = {},
  ): Promise<WorkLease[]> {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filter.workerId !== undefined) {
      clauses.push("worker_id = ?");
      values.push(filter.workerId);
    }
    if (filter.status !== undefined) {
      clauses.push("status = ?");
      values.push(filter.status);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.db
      .prepare(`SELECT * FROM work_leases${where} ORDER BY issued_at DESC`)
      .all(...values) as Row[];
    return rows.map((row) => this.toWorkLease(row));
  }

  public async heartbeatWorkLease(
    id: string,
    at: string,
    expiresAt: string,
  ): Promise<WorkLease | undefined> {
    if (expiresAt <= at) {
      return undefined;
    }
    const changed = this.db
      .prepare(
        `UPDATE work_leases SET heartbeat_at = ?, expires_at = ?
         WHERE id = ? AND status = 'active' AND expires_at > ?`,
      )
      .run(at, expiresAt, id, at);
    return changed.changes === 0 ? undefined : await this.getWorkLease(id);
  }

  public async finishWorkLease(
    id: string,
    status: Exclude<WorkLeaseStatus, "active">,
    at: string,
    detail?: string,
  ): Promise<boolean> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM work_leases WHERE id = ? AND status = 'active'")
        .get(id) as Row | undefined;
      if (row === undefined) {
        this.db.exec("COMMIT");
        return false;
      }
      const lease = this.toWorkLease(row);
      const lapsed = lease.expiresAt <= at;
      if (status === "expired" ? !lapsed : lapsed) {
        this.db.exec("COMMIT");
        return false;
      }
      this.db
        .prepare(
          `UPDATE work_leases SET status = ?, finished_at = ?, outcome = ?, detail = ?
           WHERE id = ?`,
        )
        .run(status, at, status, detail ?? null, id);

      // A released or expired lease returns its task to the queue; a settled
      // one leaves the task alone for the caller to complete.
      if (status === "released" || status === "expired") {
        this.db
          .prepare(
            `UPDATE submitted_tasks SET status = 'submitted', claimed_at = NULL
             WHERE id = ? AND status = 'claimed'`,
          )
          .run(lease.taskId);
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public async expireWorkLeases(now: string): Promise<WorkLease[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM work_leases WHERE status = 'active' AND expires_at <= ?",
      )
      .all(now) as Row[];
    const expired: WorkLease[] = [];
    for (const row of rows) {
      const { id } = this.toWorkLease(row);
      const changed = await this.finishWorkLease(
        id,
        "expired",
        now,
        "lease expired",
      );
      if (!changed) {
        continue;
      }
      // Re-read rather than returning the row selected above: that snapshot
      // still says `active`, and a caller reporting these leases would
      // describe expired work as running.
      const settled = await this.getWorkLease(id);
      if (settled !== undefined) {
        expired.push(settled);
      }
    }
    return expired;
  }

  private toWorker(row: Row): WorkerRecord {
    return {
      id: text(row, "id"),
      userId: text(row, "user_id"),
      name: text(row, "name"),
      adapters: parseJson<string[]>(row, "adapters_json"),
      version: text(row, "version"),
      registeredAt: text(row, "registered_at"),
      lastSeenAt: text(row, "last_seen_at"),
    };
  }

  private toWorkLease(row: Row): WorkLease {
    return {
      id: text(row, "id"),
      taskId: text(row, "task_id"),
      workerId: text(row, "worker_id"),
      repositoryId: text(row, "repository_id"),
      projectId: optionalText(row, "project_id"),
      status: text(row, "status") as WorkLeaseStatus,
      baseRevision: text(row, "base_revision"),
      issuedAt: text(row, "issued_at"),
      expiresAt: text(row, "expires_at"),
      heartbeatAt: text(row, "heartbeat_at"),
      finishedAt: optionalText(row, "finished_at"),
      outcome: optionalText(row, "outcome"),
      detail: optionalText(row, "detail"),
    };
  }

  public async createApiToken(token: ApiTokenRecord): Promise<void> {
    if ((await this.getUser(token.userId)) === undefined) {
      throw new Error(`Unknown user: ${token.userId}`);
    }
    if (
      token.organizationId !== undefined &&
      (await this.getOrganization(token.organizationId)) === undefined
    ) {
      throw new Error(`Unknown organization: ${token.organizationId}`);
    }
    this.db
      .prepare(
        `INSERT INTO api_tokens
           (id, user_id, organization_id, name, secret_hash, scopes_json,
            created_at, created_by_session, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        token.id,
        token.userId,
        token.organizationId ?? null,
        token.name,
        token.secretHash,
        JSON.stringify(token.scopes),
        token.createdAt,
        token.createdBySession ?? null,
        token.expiresAt ?? null,
      );
  }

  public async getApiToken(id: string): Promise<ApiTokenRecord | undefined> {
    const row = this.db
      .prepare("SELECT * FROM api_tokens WHERE id = ?")
      .get(id) as Row | undefined;
    return row === undefined ? undefined : this.toApiToken(row);
  }

  public async listApiTokens(userId: string): Promise<ApiTokenRecord[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC, rowid DESC",
      )
      .all(userId) as Row[];
    return rows.map((row) => this.toApiToken(row));
  }

  public async touchApiToken(
    id: string,
    at: string,
    ipAddress: string,
  ): Promise<void> {
    this.db
      .prepare(
        "UPDATE api_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?",
      )
      .run(at, ipAddress, id);
  }

  public async revokeApiToken(
    id: string,
    at: string,
    reason: string,
  ): Promise<void> {
    // Revocation is recorded rather than deleted so the audit trail keeps a
    // record that the credential existed.
    this.db
      .prepare(
        `UPDATE api_tokens SET revoked_at = ?, revoked_reason = ?
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(at, reason, id);
  }

  public async deleteExpiredApiTokens(now: string): Promise<number> {
    const before = this.db
      .prepare("SELECT COUNT(*) AS total FROM api_tokens")
      .get() as Row;
    this.db
      .prepare("DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .run(now);
    const after = this.db
      .prepare("SELECT COUNT(*) AS total FROM api_tokens")
      .get() as Row;
    return integer(before, "total") - integer(after, "total");
  }

  private toApiToken(row: Row): ApiTokenRecord {
    return {
      id: text(row, "id"),
      userId: text(row, "user_id"),
      organizationId: optionalText(row, "organization_id"),
      name: text(row, "name"),
      secretHash: text(row, "secret_hash"),
      scopes: parseJson<string[]>(row, "scopes_json"),
      createdAt: text(row, "created_at"),
      createdBySession: optionalText(row, "created_by_session"),
      expiresAt: optionalText(row, "expires_at"),
      lastUsedAt: optionalText(row, "last_used_at"),
      lastUsedIp: optionalText(row, "last_used_ip"),
      revokedAt: optionalText(row, "revoked_at"),
      revokedReason: optionalText(row, "revoked_reason"),
    };
  }

  public async createAuthSession(session: AuthSessionRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO auth_sessions
           (id, user_id, secret_hash, csrf_hash, created_at, expires_at,
            last_seen_at, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.userId,
        session.secretHash,
        session.csrfHash,
        session.createdAt,
        session.expiresAt,
        session.lastSeenAt,
        session.ipAddress,
        session.userAgent,
      );
  }

  public async getAuthSession(
    id: string,
  ): Promise<AuthSessionRecord | undefined> {
    const row = this.db
      .prepare("SELECT * FROM auth_sessions WHERE id = ?")
      .get(id) as Row | undefined;
    return row === undefined ? undefined : this.toAuthSession(row);
  }

  public async touchAuthSession(id: string, at: string): Promise<void> {
    this.db
      .prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?")
      .run(at, id);
  }

  public async revokeAuthSession(id: string): Promise<void> {
    this.db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(id);
  }

  public async revokeUserSessions(userId: string): Promise<void> {
    this.db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
  }

  public async deleteExpiredAuthSessions(now: string): Promise<number> {
    return Number(
      this.db
        .prepare("DELETE FROM auth_sessions WHERE expires_at <= ?")
        .run(now).changes,
    );
  }

  public async removeRepository(id: string): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM project_repositories WHERE repository_id = ?")
        .run(id);
      this.db
        .prepare("DELETE FROM canonical_versions WHERE repository_id = ?")
        .run(id);
      this.db.prepare("DELETE FROM repositories WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public async listRepositories(): Promise<StoredRepository[]> {
    const rows = this.db
      .prepare("SELECT * FROM repositories ORDER BY id")
      .all() as Row[];
    return rows.map((row) => this.toRepository(row));
  }

  public async getRepository(id: string): Promise<StoredRepository | undefined> {
    const row = this.db
      .prepare("SELECT * FROM repositories WHERE id = ?")
      .get(id) as Row | undefined;
    return row === undefined
      ? undefined
      : this.toRepository(row);
  }

  public async submitTask(input: SubmitTaskInput): Promise<SubmittedTask> {
    if ((await this.getRepository(input.repositoryId)) === undefined) {
      throw new Error(`Unknown repository: ${input.repositoryId}`);
    }
    const projectId = input.projectId ?? DEFAULT_PROJECT_ID;
    if ((await this.getProject(projectId)) === undefined) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    if (
      input.submittedBy !== undefined &&
      (await this.getUser(input.submittedBy)) === undefined
    ) {
      throw new Error(`Unknown user: ${input.submittedBy}`);
    }
    const task: SubmittedTask = {
      id: createId("task"),
      repositoryId: input.repositoryId,
      projectId,
      objective: input.objective,
      agentId: input.agentId,
      validationCommands: input.validationCommands,
      submittedBy: input.submittedBy,
      status: "submitted",
      submittedAt: new Date().toISOString(),
      claimedAt: undefined,
      completedAt: undefined,
      runId: undefined,
    };

    this.db
      .prepare(
        `INSERT INTO submitted_tasks
           (id, repository_id, project_id, objective, agent_id,
            validation_commands_json, submitted_by, status, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.repositoryId,
        task.projectId ?? DEFAULT_PROJECT_ID,
        task.objective,
        task.agentId,
        JSON.stringify(task.validationCommands),
        task.submittedBy ?? null,
        task.status,
        task.submittedAt,
      );
    return task;
  }

  public async listSubmittedTasks(
    filter: SubmittedTaskFilter = {},
  ): Promise<SubmittedTask[]> {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filter.repositoryId !== undefined) {
      clauses.push("repository_id = ?");
      values.push(filter.repositoryId);
    }
    if (filter.projectId !== undefined) {
      clauses.push("project_id = ?");
      values.push(filter.projectId);
    }
    if (filter.status !== undefined) {
      clauses.push("status = ?");
      values.push(filter.status);
    }

    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.db
      .prepare(`SELECT * FROM submitted_tasks${where} ORDER BY submitted_at, rowid`)
      .all(...values) as Row[];
    return rows.map((row) => this.toSubmittedTask(row));
  }

  public async claimSubmittedTasks(
    repositoryId: string,
    projectId?: ProjectId,
  ): Promise<SubmittedTask[]> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const projectClause =
        projectId === undefined ? "" : " AND project_id = ?";
      const rows = this.db
        .prepare(
          `SELECT * FROM submitted_tasks
           WHERE repository_id = ?${projectClause} AND status = 'submitted'
           ORDER BY submitted_at, rowid`,
        )
        .all(
          ...(projectId === undefined
            ? [repositoryId]
            : [repositoryId, projectId]),
        ) as Row[];

      const claimedAt = new Date().toISOString();
      const update = this.db.prepare(
        "UPDATE submitted_tasks SET status = 'claimed', claimed_at = ? WHERE id = ?",
      );
      for (const row of rows) {
        update.run(claimedAt, text(row, "id"));
      }
      this.db.exec("COMMIT");
      return rows.map((row) => ({
        ...this.toSubmittedTask(row),
        status: "claimed" as const,
        claimedAt,
      }));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public async retrySubmittedTask(taskId: TaskId): Promise<SubmittedTask> {
    const result = this.db
      .prepare(
        `UPDATE submitted_tasks
         SET status = 'submitted', claimed_at = NULL, completed_at = NULL, run_id = NULL
         WHERE id = ? AND status IN ('claimed', 'failed')`,
      )
      .run(taskId);
    if (result.changes === 0) {
      const current = this.db
        .prepare("SELECT status FROM submitted_tasks WHERE id = ?")
        .get(taskId) as Row | undefined;
      if (current === undefined) {
        throw new Error(`Unknown submitted task: ${taskId}`);
      }
      throw new Error(
        `Task ${taskId} cannot be retried from status ${text(current, "status")}`,
      );
    }
    const row = this.db
      .prepare("SELECT * FROM submitted_tasks WHERE id = ?")
      .get(taskId) as Row | undefined;
    if (row === undefined) {
      throw new Error(`Submitted task disappeared after retry: ${taskId}`);
    }
    return this.toSubmittedTask(row);
  }

  public async cancelSubmittedTask(taskId: TaskId): Promise<SubmittedTask> {
    const completedAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE submitted_tasks
         SET status = 'cancelled', completed_at = ?
         WHERE id = ? AND status IN ('submitted', 'claimed')`,
      )
      .run(completedAt, taskId);
    if (result.changes === 0) {
      const current = this.db
        .prepare("SELECT status FROM submitted_tasks WHERE id = ?")
        .get(taskId) as Row | undefined;
      if (current === undefined) {
        throw new Error(`Unknown submitted task: ${taskId}`);
      }
      throw new Error(
        `Task ${taskId} cannot be cancelled from status ${text(current, "status")}`,
      );
    }
    const row = this.db
      .prepare("SELECT * FROM submitted_tasks WHERE id = ?")
      .get(taskId) as Row | undefined;
    if (row === undefined) {
      throw new Error(`Submitted task disappeared after cancellation: ${taskId}`);
    }
    return this.toSubmittedTask(row);
  }

  public async completeSubmittedTask(
    taskId: TaskId,
    status: SubmittedTaskCompletionStatus,
    runId?: string,
  ): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE submitted_tasks
         SET status = ?, completed_at = ?, run_id = ?
         WHERE id = ? AND status = 'claimed'`,
      )
      .run(status, new Date().toISOString(), runId ?? null, taskId);
    if (result.changes === 0) {
      const current = this.db
        .prepare("SELECT status FROM submitted_tasks WHERE id = ?")
        .get(taskId) as Row | undefined;
      if (current === undefined) {
        throw new Error(`Unknown submitted task: ${taskId}`);
      }
      throw new Error(
        `Task ${taskId} cannot be completed from status ${text(current, "status")}`,
      );
    }
  }

  private toSubmittedTask(row: Row): SubmittedTask {
    return {
      id: text(row, "id"),
      repositoryId: text(row, "repository_id"),
      projectId: optionalText(row, "project_id"),
      objective: text(row, "objective"),
      agentId: text(row, "agent_id"),
      validationCommands: parseJson<ValidationCommand[]>(
        row,
        "validation_commands_json",
      ),
      submittedBy: optionalText(row, "submitted_by"),
      status: text(row, "status") as SubmittedTaskStatus,
      submittedAt: text(row, "submitted_at"),
      claimedAt: optionalText(row, "claimed_at"),
      completedAt: optionalText(row, "completed_at"),
      runId: optionalText(row, "run_id"),
    };
  }

  public async createRun(input: CreateRunInput): Promise<StoredRun> {
    const startedAt = new Date().toISOString();
    await this.saveRepository(input.repository);

    const run: StoredRun = {
      id: createId("run"),
      repositoryId: input.repository.id,
      projectId: input.projectId ?? DEFAULT_PROJECT_ID,
      mode: input.mode,
      scenario: input.scenario,
      status: "running",
      startedAt,
      finishedAt: undefined,
      baseRevision: input.baseVersion.revision,
      finalRevision: undefined,
    };

    this.db
      .prepare(
        `INSERT INTO runs
           (id, repository_id, project_id, mode, scenario, status, started_at, base_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.repositoryId,
        run.projectId ?? DEFAULT_PROJECT_ID,
        run.mode,
        run.scenario ?? null,
        run.status,
        run.startedAt,
        run.baseRevision,
      );

    await this.saveCanonicalVersion(input.repository.id, input.baseVersion);
    return run;
  }

  public async finishRun(
    runId: string,
    status: RunStatus,
    finalVersion?: CanonicalVersion,
  ): Promise<void> {
    const updated = this.db
      .prepare(
        `UPDATE runs SET status = ?, finished_at = ?, final_revision = ? WHERE id = ?`,
      )
      .run(status, new Date().toISOString(), finalVersion?.revision ?? null, runId);
    if (updated.changes === 0) {
      throw new Error(`Unknown coordination run: ${runId}`);
    }

    if (finalVersion !== undefined) {
      const row = this.db
        .prepare("SELECT repository_id FROM runs WHERE id = ?")
        .get(runId) as Row | undefined;
      if (row === undefined) {
        throw new Error(`Coordination run disappeared while finishing: ${runId}`);
      }
      await this.saveCanonicalVersion(text(row, "repository_id"), finalVersion);
    }
  }

  public async saveTask(runId: string, task: TaskDefinition): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tasks (run_id, id, objective, agent_id, status, validation_commands_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, id) DO UPDATE SET
           objective = excluded.objective,
           agent_id = excluded.agent_id,
           validation_commands_json = excluded.validation_commands_json`,
      )
      .run(
        runId,
        task.id,
        task.objective,
        task.agentId,
        "submitted",
        JSON.stringify(task.validationCommands),
      );
  }

  public async savePlan(
    runId: string,
    taskId: TaskId,
    plan: AgentPlan,
  ): Promise<void> {
    const updated = this.db
      .prepare(`UPDATE tasks SET plan_json = ?, status = ? WHERE run_id = ? AND id = ?`)
      .run(JSON.stringify(plan), "planning", runId, taskId);
    if (updated.changes === 0) {
      throw new Error(`Unknown task ${taskId} in run ${runId}`);
    }
  }

  public async savePlanRevision(
    runId: string,
    taskId: TaskId,
    input: Omit<
      StoredPlanRevision,
      "id" | "runId" | "taskId" | "createdAt"
    >,
  ): Promise<StoredPlanRevision> {
    const revision: StoredPlanRevision = {
      id: createId("plan"),
      runId,
      taskId,
      revision: input.revision,
      reason: input.reason,
      canonicalRevision: input.canonicalRevision,
      plan: structuredClone(input.plan),
      createdAt: new Date().toISOString(),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO task_plan_revisions
             (id, run_id, task_id, revision, reason, canonical_revision,
              plan_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revision.id,
          runId,
          taskId,
          revision.revision,
          revision.reason,
          revision.canonicalRevision,
          JSON.stringify(revision.plan),
          revision.createdAt,
        );
      const updated = this.db
        .prepare(
          "UPDATE tasks SET plan_json = ? WHERE run_id = ? AND id = ?",
        )
        .run(JSON.stringify(revision.plan), runId, taskId);
      if (updated.changes === 0) {
        throw new Error(`Unknown task ${taskId} in run ${runId}`);
      }
      this.db.exec("COMMIT");
      return revision;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public async listPlanRevisions(
    runId: string,
    taskId?: TaskId,
  ): Promise<StoredPlanRevision[]> {
    const rows = (
      taskId === undefined
        ? this.db
            .prepare(
              `SELECT * FROM task_plan_revisions
               WHERE run_id = ? ORDER BY task_id, revision`,
            )
            .all(runId)
        : this.db
            .prepare(
              `SELECT * FROM task_plan_revisions
               WHERE run_id = ? AND task_id = ? ORDER BY revision`,
            )
            .all(runId, taskId)
    ) as Row[];
    return rows.map((row) => this.toPlanRevision(row));
  }

  public async saveScopeChange(
    runId: string,
    request: ScopeChangeRequest,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO scope_changes
           (id, run_id, task_id, request_json, requested_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        request.id,
        runId,
        request.taskId,
        JSON.stringify(request),
        request.occurredAt,
      );
  }

  public async saveScopeChangeDecision(
    runId: string,
    decision: ScopeChangeDecision,
  ): Promise<void> {
    const updated = this.db
      .prepare(
        `UPDATE scope_changes
         SET decision_json = ?, decided_at = ?
         WHERE id = ? AND run_id = ? AND decision_json IS NULL`,
      )
      .run(
        JSON.stringify(decision),
        decision.decidedAt,
        decision.requestId,
        runId,
      );
    if (updated.changes === 0) {
      throw new Error(
        `Scope-change request ${decision.requestId} is unknown or already decided`,
      );
    }
  }

  public async listScopeChanges(runId: string): Promise<StoredScopeChange[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM scope_changes
         WHERE run_id = ? ORDER BY requested_at, rowid`,
      )
      .all(runId) as Row[];
    return rows.map((row) => ({
      runId,
      request: parseJson<ScopeChangeRequest>(row, "request_json"),
      decision: optionalJson<ScopeChangeDecision>(row, "decision_json"),
    }));
  }

  public async saveSession(runId: string, session: SessionRecord): Promise<void> {
    const updated = this.db
      .prepare(
        `UPDATE tasks SET session_id = ?, session_started_at = ? WHERE run_id = ? AND id = ?`,
      )
      .run(session.id, session.startedAt, runId, session.taskId);
    if (updated.changes === 0) {
      throw new Error(`Unknown task ${session.taskId} in run ${runId}`);
    }
  }

  public async saveDecision(
    runId: string,
    decision: CoordinatorDecision,
  ): Promise<void> {
    const updated = this.db
      .prepare(`UPDATE tasks SET decision_json = ? WHERE run_id = ? AND id = ?`)
      .run(JSON.stringify(decision), runId, decision.taskId);
    if (updated.changes === 0) {
      throw new Error(`Unknown task ${decision.taskId} in run ${runId}`);
    }
  }

  public async saveTaskStatus(
    runId: string,
    taskId: TaskId,
    status: TaskStatus,
    explanation?: string,
  ): Promise<void> {
    const updated = this.db
      .prepare(`UPDATE tasks SET status = ?, explanation = ? WHERE run_id = ? AND id = ?`)
      .run(status, explanation ?? null, runId, taskId);
    if (updated.changes === 0) {
      throw new Error(`Unknown task ${taskId} in run ${runId}`);
    }
  }

  public async saveConflicts(
    runId: string,
    assessments: readonly ConflictAssessment[],
  ): Promise<void> {
    const statement = this.db.prepare(
      `INSERT INTO conflicts (run_id, first_task_id, second_task_id, score, disposition, evidence_json, explanation)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const assessment of assessments) {
      statement.run(
        runId,
        assessment.taskIds[0],
        assessment.taskIds[1],
        assessment.score,
        assessment.disposition,
        JSON.stringify(assessment.evidence),
        assessment.explanation,
      );
    }
  }

  public async saveLeases(
    runId: string,
    leases: readonly ResourceLease[],
  ): Promise<void> {
    const statement = this.db.prepare(
      `INSERT INTO resource_leases
         (lease_id, run_id, task_id, resource_type, resource_id, principal_id, mode, base_version, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(lease_id) DO NOTHING`,
    );
    for (const lease of leases) {
      statement.run(
        lease.leaseId,
        runId,
        lease.taskId,
        lease.resourceType,
        lease.resourceId,
        lease.principalId,
        lease.mode,
        lease.baseVersion,
        lease.expiresAt,
      );
    }
  }

  public async releaseLeases(runId: string, taskId: TaskId): Promise<void> {
    this.db
      .prepare(
        `UPDATE resource_leases SET released_at = ?
         WHERE run_id = ? AND task_id = ? AND released_at IS NULL`,
      )
      .run(new Date().toISOString(), runId, taskId);
  }

  public async saveWorkspace(
    runId: string,
    workspace: StoredWorkspace,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO workspaces (id, run_id, task_id, path, isolation, base_revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        workspace.id,
        runId,
        workspace.taskId,
        workspace.path,
        workspace.isolation,
        workspace.baseRevision,
        workspace.createdAt,
      );
  }

  public async saveChangeSet(runId: string, changeSet: ChangeSet): Promise<void> {
    this.db.exec("BEGIN");
    try {
      const inserted = this.db
        .prepare(
          `INSERT INTO changesets
             (id, run_id, task_id, base_version, base_revision, symbols_changed_json,
              dependencies_changed_json, risk_level, risk_reasons_json, agent_explanation,
              commands_run_json, tests_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(
          changeSet.id,
          runId,
          changeSet.taskId,
          changeSet.baseVersion,
          changeSet.baseRevision,
          JSON.stringify(changeSet.symbolsChanged),
          JSON.stringify(changeSet.dependenciesChanged),
          changeSet.riskAssessment.level,
          JSON.stringify(changeSet.riskAssessment.reasons),
          changeSet.agentExplanation,
          JSON.stringify(changeSet.commandsRun),
          JSON.stringify(changeSet.tests),
          changeSet.createdAt,
        );

      if (inserted.changes > 0) {
        const patchStatement = this.db.prepare(
          `INSERT INTO file_patches (changeset_id, ordinal, path, status, patch)
           VALUES (?, ?, ?, ?, ?)`,
        );
        changeSet.patches.forEach((patch, ordinal) => {
          patchStatement.run(
            changeSet.id,
            ordinal,
            patch.path,
            patch.status,
            patch.patch,
          );
        });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public async saveIntegration(
    runId: string,
    result: IntegrationResult,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO integrations
           (run_id, task_id, changeset_id, status,
            previous_sequence, previous_revision, previous_branch, previous_created_at,
            canonical_sequence, canonical_revision, canonical_branch, canonical_created_at,
            candidate_revision, validation_json, cleanup_warnings_json, explanation, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        result.taskId,
        result.changeSetId,
        result.status,
        result.previousVersion.sequence,
        result.previousVersion.revision,
        result.previousVersion.branch,
        result.previousVersion.createdAt,
        result.canonicalVersion.sequence,
        result.canonicalVersion.revision,
        result.canonicalVersion.branch,
        result.canonicalVersion.createdAt,
        result.candidateRevision ?? null,
        JSON.stringify(result.validation),
        JSON.stringify(result.cleanupWarnings ?? []),
        result.explanation,
        new Date().toISOString(),
      );
  }

  public async saveCanonicalVersion(
    repositoryId: string,
    version: CanonicalVersion,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO canonical_versions
           (repository_id, revision, sequence, branch, created_at, observed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repository_id, revision) DO NOTHING`,
      )
      .run(
        repositoryId,
        version.revision,
        version.sequence,
        version.branch,
        version.createdAt,
        new Date().toISOString(),
      );
  }

  public async appendAudit(
    runId: string | undefined,
    input: AppendAuditInput,
  ): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: createId("audit"),
      type: input.type,
      occurredAt: new Date().toISOString(),
      data: input.data ?? {},
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db
        .prepare("SELECT chain_hash FROM audit_events ORDER BY sequence DESC LIMIT 1")
        .get() as Row | undefined;
      const previousHash =
        previous === undefined ? GENESIS_HASH : text(previous, "chain_hash");
      const payloadHash = hashAuditPayload(event);

      this.db
        .prepare(
          `INSERT INTO audit_events
             (id, run_id, task_id, type, data_json, occurred_at, payload_hash, previous_hash, chain_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          runId ?? null,
          event.taskId ?? null,
          event.type,
          JSON.stringify(event.data),
          event.occurredAt,
          payloadHash,
          previousHash,
          chainHash(previousHash, payloadHash),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return event;
  }

  public async listAuditEvents(
    filter: AuditEventFilter = {},
  ): Promise<SequencedAuditEvent[]> {
    const afterSequence = filter.afterSequence ?? 0;
    const limit = filter.limit ?? 500;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError("Audit cursor must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new RangeError("Audit event limit must be between 1 and 5000");
    }
    const rows = (
      filter.runId === undefined
        ? this.db
            .prepare(
              `SELECT * FROM audit_events
               WHERE sequence > ? ORDER BY sequence LIMIT ?`,
            )
            .all(afterSequence, limit)
        : this.db
            .prepare(
              `SELECT * FROM audit_events
               WHERE sequence > ? AND run_id = ?
               ORDER BY sequence LIMIT ?`,
            )
            .all(afterSequence, filter.runId, limit)
    ) as Row[];
    return rows.map((row) => {
      const runId = optionalText(row, "run_id");
      return {
        sequence: integer(row, "sequence"),
        ...(runId === undefined ? {} : { runId }),
        event: this.toAuditEvent(row),
      };
    });
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
    this.db
      .prepare(
        `INSERT INTO approvals
           (id, organization_id, project_id, repository_id, run_id, task_id,
            kind, status, requested_by, required_role, reasons_json,
            changeset_id, scope_change_id, requested_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.organizationId ?? null,
        approval.projectId ?? null,
        approval.repositoryId,
        approval.runId,
        approval.taskId,
        approval.kind,
        approval.status,
        approval.requestedBy,
        approval.requiredRole,
        JSON.stringify(approval.reasons),
        approval.changeSetId ?? null,
        approval.scopeChangeId ?? null,
        approval.requestedAt,
        approval.expiresAt,
      );
    return approval;
  }

  public async getApproval(id: string): Promise<ApprovalRequest | undefined> {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row === undefined ? undefined : this.toApproval(row);
  }

  public async listApprovals(
    filter: ApprovalFilter = {},
  ): Promise<ApprovalRequest[]> {
    const clauses: string[] = [];
    const values: string[] = [];
    for (const [column, value] of [
      ["organization_id", filter.organizationId],
      ["project_id", filter.projectId],
      ["repository_id", filter.repositoryId],
      ["run_id", filter.runId],
      ["task_id", filter.taskId],
      ["status", filter.status],
    ] as const) {
      if (value !== undefined) {
        clauses.push(`${column} = ?`);
        values.push(value);
      }
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.db
      .prepare(
        `SELECT * FROM approvals${where}
         ORDER BY requested_at DESC, rowid DESC`,
      )
      .all(...values) as Row[];
    return rows.map((row) => this.toApproval(row));
  }

  public async decideApproval(
    decision: ApprovalDecision,
  ): Promise<ApprovalRequest> {
    const updated = this.db
      .prepare(
        `UPDATE approvals
         SET status = ?, decided_at = ?, decided_by = ?, decision_comment = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(
        decision.status,
        decision.decidedAt,
        decision.decidedBy,
        decision.comment,
        decision.approvalId,
      );
    if (updated.changes === 0) {
      const current = await this.getApproval(decision.approvalId);
      if (current === undefined) {
        throw new Error(`Unknown approval: ${decision.approvalId}`);
      }
      throw new Error(
        `Approval ${decision.approvalId} cannot be decided from ${current.status}`,
      );
    }
    const approval = await this.getApproval(decision.approvalId);
    if (approval === undefined) {
      throw new Error(`Approval disappeared after decision: ${decision.approvalId}`);
    }
    return approval;
  }

  public async expireApprovals(now: string): Promise<number> {
    return Number(
      this.db
        .prepare(
          `UPDATE approvals
           SET status = 'expired', decided_at = ?
           WHERE status = 'pending' AND expires_at <= ?`,
        )
        .run(now, now).changes,
    );
  }

  public async listRuns(limit = 50): Promise<StoredRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("Run list limit must be a positive safe integer");
    }
    const rows = this.db
      .prepare(`SELECT * FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as Row[];
    return rows.map((row) => this.toRun(row));
  }

  public async getRun(runId: string): Promise<RunDetail | undefined> {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | Row
      | undefined;
    if (row === undefined) {
      return undefined;
    }

    return {
      run: this.toRun(row),
      tasks: this.tasksFor(runId),
      conflicts: this.conflictsFor(runId),
      changeSets: this.changeSetsFor(runId),
      integrations: this.integrationsFor(runId),
      leases: this.leasesFor(runId),
      workspaces: this.workspacesFor(runId),
      planRevisions: await this.listPlanRevisions(runId),
      scopeChanges: await this.listScopeChanges(runId),
      approvals: await this.listApprovals({ runId }),
      audit: await this.listAudit(runId),
    };
  }

  public async listAudit(runId?: string): Promise<AuditEvent[]> {
    const rows = (
      runId === undefined
        ? this.db.prepare("SELECT * FROM audit_events ORDER BY sequence").all()
        : this.db
            .prepare("SELECT * FROM audit_events WHERE run_id = ? ORDER BY sequence")
            .all(runId)
    ) as Row[];
    return rows.map((entry) => this.toAuditEvent(entry));
  }

  public async verifyAudit(): Promise<AuditChainVerification> {
    const rows = this.db
      .prepare("SELECT * FROM audit_events ORDER BY sequence")
      .all() as Row[];
    const entries: ChainedAuditEvent[] = rows.map((row) => ({
      event: this.toAuditEvent(row),
      sequence: integer(row, "sequence"),
      payloadHash: text(row, "payload_hash"),
      previousHash: text(row, "previous_hash"),
      chainHash: text(row, "chain_hash"),
    }));
    return verifyAuditChain(entries);
  }

  public async close(): Promise<void> {
    this.db.close();
  }

  private toRepository(row: Row): StoredRepository {
    const provider = optionalText(row, "provider");
    const remoteUrl = optionalText(row, "remote_url");
    return {
      id: text(row, "id"),
      path: text(row, "path"),
      branch: text(row, "branch"),
      ...(provider === undefined || provider === "local"
        ? {}
        : { provider: provider as "git" | "github" }),
      ...(remoteUrl === undefined ? {} : { remoteUrl }),
    };
  }

  private toOrganization(row: Row): Organization {
    return {
      id: text(row, "id"),
      slug: text(row, "slug"),
      name: text(row, "name"),
      createdAt: text(row, "created_at"),
    };
  }

  private toUser(row: Row): UserAccount {
    return {
      id: text(row, "id"),
      email: text(row, "email"),
      displayName: text(row, "display_name"),
      passwordDigest: text(row, "password_digest"),
      systemAdmin: integer(row, "system_admin") === 1,
      disabled: integer(row, "disabled") === 1,
      createdAt: text(row, "created_at"),
    };
  }

  private toMembership(row: Row): OrganizationMembership {
    return {
      organizationId: text(row, "organization_id"),
      userId: text(row, "user_id"),
      role: text(row, "role") as OrganizationRole,
      createdAt: text(row, "created_at"),
    };
  }

  private toProject(row: Row): ProjectRecord {
    return {
      id: text(row, "id"),
      organizationId: text(row, "organization_id"),
      slug: text(row, "slug"),
      name: text(row, "name"),
      description: text(row, "description"),
      archived: integer(row, "archived") === 1,
      policy: optionalJson<Record<string, unknown>>(row, "policy_json"),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
    };
  }

  private toAuthSession(row: Row): AuthSessionRecord {
    return {
      id: text(row, "id"),
      userId: text(row, "user_id"),
      secretHash: text(row, "secret_hash"),
      csrfHash: text(row, "csrf_hash"),
      createdAt: text(row, "created_at"),
      expiresAt: text(row, "expires_at"),
      lastSeenAt: text(row, "last_seen_at"),
      ipAddress: text(row, "ip_address"),
      userAgent: text(row, "user_agent"),
    };
  }

  private toPlanRevision(row: Row): StoredPlanRevision {
    return {
      id: text(row, "id"),
      runId: text(row, "run_id"),
      taskId: text(row, "task_id"),
      revision: integer(row, "revision"),
      reason: text(row, "reason") as StoredPlanRevision["reason"],
      canonicalRevision: text(row, "canonical_revision"),
      plan: parseJson<AgentPlan>(row, "plan_json"),
      createdAt: text(row, "created_at"),
    };
  }

  private toApproval(row: Row): ApprovalRequest {
    const organizationId = optionalText(row, "organization_id");
    const projectId = optionalText(row, "project_id");
    const changeSetId = optionalText(row, "changeset_id");
    const scopeChangeId = optionalText(row, "scope_change_id");
    const decidedAt = optionalText(row, "decided_at");
    const decidedBy = optionalText(row, "decided_by");
    const decisionComment = optionalText(row, "decision_comment");
    return {
      id: text(row, "id"),
      ...(organizationId === undefined ? {} : { organizationId }),
      ...(projectId === undefined ? {} : { projectId }),
      repositoryId: text(row, "repository_id"),
      runId: text(row, "run_id"),
      taskId: text(row, "task_id"),
      kind: text(row, "kind") as ApprovalRequest["kind"],
      status: text(row, "status") as ApprovalRequest["status"],
      requestedBy: text(row, "requested_by"),
      requiredRole: text(row, "required_role") as ApprovalRequest["requiredRole"],
      reasons: parseJson<string[]>(row, "reasons_json"),
      ...(changeSetId === undefined ? {} : { changeSetId }),
      ...(scopeChangeId === undefined ? {} : { scopeChangeId }),
      requestedAt: text(row, "requested_at"),
      expiresAt: text(row, "expires_at"),
      ...(decidedAt === undefined ? {} : { decidedAt }),
      ...(decidedBy === undefined ? {} : { decidedBy }),
      ...(decisionComment === undefined ? {} : { decisionComment }),
    };
  }

  private toRun(row: Row): StoredRun {
    return {
      id: text(row, "id"),
      repositoryId: text(row, "repository_id"),
      projectId: optionalText(row, "project_id"),
      mode: text(row, "mode") as RunMode,
      scenario: optionalText(row, "scenario"),
      status: text(row, "status") as RunStatus,
      startedAt: text(row, "started_at"),
      finishedAt: optionalText(row, "finished_at"),
      baseRevision: text(row, "base_revision"),
      finalRevision: optionalText(row, "final_revision"),
    };
  }

  private toAuditEvent(row: Row): AuditEvent {
    const taskId = optionalText(row, "task_id");
    return {
      id: text(row, "id"),
      type: text(row, "type") as AuditEvent["type"],
      occurredAt: text(row, "occurred_at"),
      data: parseJson<Record<string, unknown>>(row, "data_json"),
      ...(taskId === undefined ? {} : { taskId }),
    };
  }

  private tasksFor(runId: string): StoredTask[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE run_id = ? ORDER BY rowid")
      .all(runId) as Row[];
    return rows.map((row) => ({
      runId,
      id: text(row, "id"),
      objective: text(row, "objective"),
      agentId: text(row, "agent_id"),
      validationCommands: parseJson<ValidationCommand[]>(
        row,
        "validation_commands_json",
      ),
      status: text(row, "status") as TaskStatus,
      explanation: optionalText(row, "explanation"),
      plan: optionalJson<AgentPlan>(row, "plan_json"),
      decision: optionalJson<CoordinatorDecision>(row, "decision_json"),
      sessionId: optionalText(row, "session_id"),
      sessionStartedAt: optionalText(row, "session_started_at"),
    }));
  }

  private conflictsFor(runId: string): ConflictAssessment[] {
    const rows = this.db
      .prepare("SELECT * FROM conflicts WHERE run_id = ? ORDER BY id")
      .all(runId) as Row[];
    return rows.map((row) => ({
      taskIds: [text(row, "first_task_id"), text(row, "second_task_id")],
      score: integer(row, "score"),
      disposition: text(row, "disposition") as ConflictDisposition,
      evidence: parseJson<ConflictEvidence[]>(row, "evidence_json"),
      explanation: text(row, "explanation"),
    }));
  }

  private changeSetsFor(runId: string): ChangeSet[] {
    const rows = this.db
      .prepare("SELECT * FROM changesets WHERE run_id = ? ORDER BY created_at, rowid")
      .all(runId) as Row[];
    const patchStatement = this.db.prepare(
      "SELECT * FROM file_patches WHERE changeset_id = ? ORDER BY ordinal",
    );

    return rows.map((row) => {
      const id = text(row, "id");
      const patches = (patchStatement.all(id) as Row[]).map<FilePatch>(
        (patch) => ({
          path: text(patch, "path"),
          status: text(patch, "status") as FilePatchStatus,
          patch: text(patch, "patch"),
        }),
      );

      return {
        id,
        taskId: text(row, "task_id"),
        baseVersion: integer(row, "base_version"),
        baseRevision: text(row, "base_revision"),
        patches,
        commandsRun: parseJson<CommandResult[]>(row, "commands_run_json"),
        tests: parseJson<TestResult[]>(row, "tests_json"),
        dependenciesChanged: parseJson<string[]>(row, "dependencies_changed_json"),
        symbolsChanged: parseJson<string[]>(row, "symbols_changed_json"),
        riskAssessment: {
          level: text(row, "risk_level") as RiskLevel,
          reasons: parseJson<string[]>(row, "risk_reasons_json"),
        },
        agentExplanation: text(row, "agent_explanation"),
        createdAt: text(row, "created_at"),
      };
    });
  }

  private integrationsFor(runId: string): IntegrationResult[] {
    const rows = this.db
      .prepare("SELECT * FROM integrations WHERE run_id = ? ORDER BY id")
      .all(runId) as Row[];
    return rows.map((row) => {
      const candidate = optionalText(row, "candidate_revision");
      const cleanupWarnings = parseJson<string[]>(
        row,
        "cleanup_warnings_json",
      );
      return {
        taskId: text(row, "task_id"),
        changeSetId: text(row, "changeset_id"),
        status: text(row, "status") as IntegrationStatus,
        previousVersion: {
          sequence: integer(row, "previous_sequence"),
          revision: text(row, "previous_revision"),
          branch: text(row, "previous_branch"),
          createdAt: text(row, "previous_created_at"),
        },
        canonicalVersion: {
          sequence: integer(row, "canonical_sequence"),
          revision: text(row, "canonical_revision"),
          branch: text(row, "canonical_branch"),
          createdAt: text(row, "canonical_created_at"),
        },
        validation: parseJson<CommandResult[]>(row, "validation_json"),
        ...(candidate === undefined ? {} : { candidateRevision: candidate }),
        ...(cleanupWarnings.length === 0 ? {} : { cleanupWarnings }),
        explanation: text(row, "explanation"),
      };
    });
  }

  private leasesFor(runId: string): ResourceLease[] {
    const rows = this.db
      .prepare("SELECT * FROM resource_leases WHERE run_id = ? ORDER BY rowid")
      .all(runId) as Row[];
    return rows.map((row) => ({
      leaseId: text(row, "lease_id"),
      resourceType: text(row, "resource_type") as ResourceLease["resourceType"],
      resourceId: text(row, "resource_id"),
      principalId: text(row, "principal_id"),
      taskId: text(row, "task_id"),
      mode: text(row, "mode") as ResourceLease["mode"],
      baseVersion: integer(row, "base_version"),
      expiresAt: text(row, "expires_at"),
    }));
  }

  private workspacesFor(runId: string): StoredWorkspace[] {
    const rows = this.db
      .prepare("SELECT * FROM workspaces WHERE run_id = ? ORDER BY created_at, rowid")
      .all(runId) as Row[];
    return rows.map((row) => ({
      id: text(row, "id"),
      runId,
      taskId: text(row, "task_id"),
      path: text(row, "path"),
      isolation: text(row, "isolation"),
      baseRevision: text(row, "base_revision"),
      createdAt: text(row, "created_at"),
    }));
  }
}
