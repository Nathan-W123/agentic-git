import { AsyncLocalStorage } from "node:async_hooks";

import pg from "pg";

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
  segmentDigest,
  verifyArchivedChain,
  type ArchivedSegment,
  type AuditChainVerification,
  type AuditCheckpoint,
  type ChainedAuditEvent,
} from "./audit-chain.js";
import { LATEST_SCHEMA_VERSION } from "./schema.js";
import { POSTGRES_MIGRATIONS } from "./postgres-schema.js";
import type {
  ApiTokenRecord,
  AppendAuditInput,
  AddChangesetCommentInput,
  AddChannelReplyInput,
  AppendChannelMessageInput,
  ApprovalFilter,
  AgentCallSign,
  ArchiveAuditInput,
  ChangesetComment,
  ChannelAgentOverride,
  ChannelEntryKind,
  CreateSubChannelInput,
  SubChannel,
  SubChannelMember,
  SubChannelVisibility,
  UpdateSubChannelInput,
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
  TaskKind,
  SubmittedTaskCompletionStatus,
  SubmittedTaskFilter,
  RecordTokenUsageInput,
  TokenUsageFilter,
  TokenUsageRecord,
  SubmittedTaskStatus,
  InvitationRecord,
  PasswordResetRecord,
  SignupIntentRecord,
  WaitlistEntry,
  RepositoryGrant,
  UserAccount,
  UserAppearance,
  LeaseTaskInput,
  LeasedWork,
  SaveWorkLeasePlanInput,
  SaveWorkLeasePlanResult,
  WorkLease,
  WorkLeasePlan,
  WorkLeaseStatus,
  WorkerRecord,
} from "./store.js";
import {
  GENERAL_SUB_CHANNEL_SLUG,
  directPairKey,
  parseChangedFiles,
  repositoryConflicts,
} from "./store.js";
import { DEFAULT_PROJECT_ID, sameLeaseIdSet } from "./store.js";

const { Pool } = pg;
type PoolClient = pg.PoolClient;
type QueryResult = pg.QueryResult;

type Row = Record<string, unknown>;

/**
 * The id of the `#general` a repository falls back to.
 *
 * Identical to the SQLite store's helper and to what the
 * `repository-sub-channels` migration minted, so an unqualified write lands
 * in the same room whichever backend is underneath.
 */
function generalChannelId(repositoryId: string): string {
  return `subchan_general_${repositoryId}`;
}

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
  if (typeof value !== "number") {
    throw new Error(`Expected a number in column ${column}`);
  }
  return value;
}

function flag(row: Row, column: string): boolean {
  const value = row[column];
  if (typeof value !== "boolean") {
    throw new Error(`Expected a boolean in column ${column}`);
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

/** Appends `value` and returns its 1-based `$n` placeholder. */
function bind(values: unknown[], value: unknown): string {
  return `$${values.push(value)}`;
}

/**
 * BIGSERIAL and COUNT(*) come back as int8, which node-postgres returns as a
 * string to be safe near 2^63. Every int8 this store produces is a row
 * counter or sequence that fits a JS number, so parse it as one.
 */
const INT8_OID = 20;
const queryTypes: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) => {
    if (oid === INT8_OID && format !== "binary") {
      return (value: string) => Number(value);
    }
    return (
      pg.types.getTypeParser as (oid: number, format?: string) => unknown
    )(oid, format);
  }) as pg.CustomTypesConfig["getTypeParser"],
};

/**
 * Writers that read shared state before writing take this transaction-scoped
 * advisory lock, giving Postgres the same single-writer discipline SQLite gets
 * from BEGIN IMMEDIATE. The key is salted with the database name so two
 * coordinator databases in one cluster do not contend.
 */
const WRITE_LOCK = "SELECT pg_advisory_xact_lock(hashtext(current_database()), 810274)";
const MIGRATE_LOCK_KEY = 810275;

/**
 * Postgres-backed coordination store.
 *
 * This is the backend for shared deployments: several devices and users
 * pointing at one database server rather than one file on one disk. It speaks
 * the same behavioral contract as the SQLite store — the parameterized
 * contract suite runs against both — and stores timestamps as the same ISO
 * text so ordering and expiry comparisons behave identically.
 */
export class PostgresCoordinationStore implements CoordinationStore {
  private readonly pool: pg.Pool;
  /** The connection a `runInTransaction` body must use, while one is open. */
  private readonly ambientClient = new AsyncLocalStorage<PoolClient>();
  /** Migrations run lazily; every public method awaits this first. */
  private readonly ready: Promise<void>;

  private constructor(pool: pg.Pool) {
    this.pool = pool;
    this.ready = this.migrate();
    // A rejected migration must surface where the store is used, not as an
    // unhandled rejection that kills the process before any caller awaits.
    this.ready.catch(() => undefined);
  }

  /**
   * Opens a pool against `connectionString` (postgres:// or postgresql://).
   *
   * Connections are established lazily, so this stays synchronous like
   * {@link SqliteCoordinationStore.open}; the first operation performs the
   * migration and reports connection failures.
   */
  public static open(connectionString: string): PostgresCoordinationStore {
    return new PostgresCoordinationStore(
      new Pool({ connectionString, max: 10, types: queryTypes }),
    );
  }

  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Serialize concurrent instances of the coordinator migrating the same
      // database; without this, two fresh processes race the baseline DDL.
      await client.query(
        "SELECT pg_advisory_lock(hashtext(current_database()), $1)",
        [MIGRATE_LOCK_KEY],
      );
      try {
        await client.query(
          "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
        );
        const current = await client.query(
          "SELECT MAX(version) AS version FROM schema_version",
        );
        const value: unknown = (current.rows[0] as Row | undefined)?.["version"];
        const applied = typeof value === "number" ? value : 0;

        if (applied > LATEST_SCHEMA_VERSION) {
          throw new Error(
            `The coordination database is at schema version ${applied}, ` +
              `newer than this build understands (${LATEST_SCHEMA_VERSION})`,
          );
        }

        for (const migration of POSTGRES_MIGRATIONS) {
          if (migration.version <= applied) {
            continue;
          }
          await client.query("BEGIN");
          try {
            for (const statement of migration.statements) {
              await client.query(statement);
            }
            await client.query(
              "INSERT INTO schema_version (version) VALUES ($1)",
              [migration.version],
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
      } finally {
        await client.query(
          "SELECT pg_advisory_unlock(hashtext(current_database()), $1)",
          [MIGRATE_LOCK_KEY],
        );
      }
    } finally {
      client.release();
    }
  }

  public async runInTransaction<T>(
    body: (store: CoordinationStore) => Promise<T>,
  ): Promise<T> {
    if (this.ambientClient.getStore() !== undefined) {
      return await body(this);
    }
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.ambientClient.run(
        client,
        async () => await body(this),
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original failure matters more than a rollback on a dead socket.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async query(
    statement: string,
    values: unknown[] = [],
  ): Promise<QueryResult> {
    await this.ready;
    // Inside `runInTransaction` every statement has to travel the one
    // connection holding the transaction, or it commits independently of it
    // — which is the bug this exists to remove, reintroduced one level down.
    const client = this.ambientClient.getStore();
    return await (client ?? this.pool).query(statement, values);
  }

  private async row(
    statement: string,
    values: unknown[] = [],
  ): Promise<Row | undefined> {
    return (await this.query(statement, values)).rows[0] as Row | undefined;
  }

  private async rows(
    statement: string,
    values: unknown[] = [],
  ): Promise<Row[]> {
    return (await this.query(statement, values)).rows as Row[];
  }

  private async transaction<T>(
    body: (client: PoolClient) => Promise<T>,
    options: { serialize?: boolean } = {},
  ): Promise<T> {
    // Already inside one: join it rather than opening a second on a different
    // connection, which would deadlock against the lock the outer one holds.
    // Rollback stays with the outermost caller, the only one that can honour
    // it.
    const ambient = this.ambientClient.getStore();
    if (ambient !== undefined) {
      if (options.serialize === true) {
        await ambient.query(WRITE_LOCK);
      }
      return await body(ambient);
    }
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (options.serialize === true) {
        await client.query(WRITE_LOCK);
      }
      const result = await body(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original failure matters more than a rollback on a dead socket.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async saveRepository(repository: StoredRepository): Promise<void> {
    await this.query(
      `INSERT INTO repositories
         (id, path, branch, first_seen_at, provider, remote_url, created_by,
          display_name, picture)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [
        repository.id,
        repository.path,
        repository.branch,
        new Date().toISOString(),
        repository.provider ?? "local",
        repository.remoteUrl ?? null,
        repository.createdBy ?? null,
        repository.displayName ?? null,
        repository.picture ?? null,
      ],
    );
    const existing = await this.getRepository(repository.id);
    if (existing === undefined || repositoryConflicts(existing, repository)) {
      throw new Error(
        `Repository id ${repository.id} is already mapped to a different canonical repository`,
      );
    }
  }

  public async createOrganization(input: {
    id?: string;
    slug: string;
    name: string;
  }): Promise<Organization> {
    const organization: Organization = {
      id: input.id ?? createId("org"),
      slug: input.slug.trim().toLowerCase(),
      name: input.name.trim(),
      createdAt: new Date().toISOString(),
    };
    await this.query(
      `INSERT INTO organizations (id, slug, name, created_at)
       VALUES ($1, $2, $3, $4)`,
      [
        organization.id,
        organization.slug,
        organization.name,
        organization.createdAt,
      ],
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
    await this.query(
      "UPDATE organizations SET slug = $1, name = $2 WHERE id = $3",
      [organization.slug, organization.name, id],
    );
    return organization;
  }

  public async listOrganizations(userId?: string): Promise<Organization[]> {
    const rows =
      userId === undefined
        ? await this.rows("SELECT * FROM organizations ORDER BY name, id")
        : await this.rows(
            `SELECT o.* FROM organizations o
             JOIN organization_memberships m ON m.organization_id = o.id
             WHERE m.user_id = $1
             ORDER BY o.name, o.id`,
            [userId],
          );
    return rows.map((row) => this.toOrganization(row));
  }

  public async getOrganization(id: string): Promise<Organization | undefined> {
    const row = await this.row("SELECT * FROM organizations WHERE id = $1", [
      id,
    ]);
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
    await this.query(
      `INSERT INTO users
         (id, email, display_name, password_digest, system_admin, disabled, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        user.id,
        user.email,
        user.displayName,
        user.passwordDigest,
        user.systemAdmin,
        false,
        user.createdAt,
      ],
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
      appearance?: UserAppearance;
    },
  ): Promise<UserAccount> {
    const existing = await this.getUser(id);
    if (existing === undefined) {
      throw new Error(`Unknown user: ${id}`);
    }
    const appearance = input.appearance ?? existing.appearance;
    const user: UserAccount = {
      ...existing,
      displayName: input.displayName?.trim() ?? existing.displayName,
      passwordDigest: input.passwordDigest ?? existing.passwordDigest,
      disabled: input.disabled ?? existing.disabled,
      systemAdmin: input.systemAdmin ?? existing.systemAdmin,
      ...(appearance === undefined ? {} : { appearance }),
    };
    await this.query(
      `UPDATE users
       SET display_name = $1, password_digest = $2, disabled = $3,
           system_admin = $4, appearance = $5
       WHERE id = $6`,
      [
        user.displayName,
        user.passwordDigest,
        user.disabled,
        user.systemAdmin,
        appearance === undefined ? null : JSON.stringify(appearance),
        id,
      ],
    );
    return user;
  }

  public async getUser(id: string): Promise<UserAccount | undefined> {
    const row = await this.row("SELECT * FROM users WHERE id = $1", [id]);
    return row === undefined ? undefined : this.toUser(row);
  }

  public async getUserByEmail(email: string): Promise<UserAccount | undefined> {
    const row = await this.row(
      "SELECT * FROM users WHERE LOWER(email) = LOWER($1)",
      [email.trim()],
    );
    return row === undefined ? undefined : this.toUser(row);
  }

  public async listUsers(): Promise<UserAccount[]> {
    return (await this.rows("SELECT * FROM users ORDER BY email, id")).map(
      (row) => this.toUser(row),
    );
  }

  public async countUsers(): Promise<number> {
    const row = await this.row('SELECT COUNT(*) AS "count" FROM users');
    return row === undefined ? 0 : integer(row, "count");
  }

  public async saveMembership(input: {
    organizationId: string;
    userId: string;
    role: OrganizationRole;
    comped?: boolean;
  }): Promise<OrganizationMembership> {
    // An omitted `comped` keeps what the row already says. A role change must
    // not quietly start charging for a seat that was given away, and the
    // caller changing somebody's role is rarely the one who knows.
    await this.query(
      `INSERT INTO organization_memberships
         (organization_id, user_id, role, comped, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, user_id)
       DO UPDATE SET
         role = EXCLUDED.role,
         comped = COALESCE($6, organization_memberships.comped)`,
      [
        input.organizationId,
        input.userId,
        input.role,
        input.comped ?? false,
        new Date().toISOString(),
        input.comped ?? null,
      ],
    );
    const membership = await this.getMembership(
      input.organizationId,
      input.userId,
    );
    if (membership === undefined) {
      throw new Error("Membership was not persisted");
    }
    return membership;
  }

  public async getSubscription(
    organizationId: string,
  ): Promise<Subscription | undefined> {
    const row = await this.row(
      `SELECT * FROM subscriptions WHERE organization_id = $1`,
      [organizationId],
    );
    return row === undefined ? undefined : this.toSubscription(row);
  }

  public async saveSubscription(input: {
    organizationId: string;
    status: SubscriptionStatus;
    trialEndsAt?: string;
    currentPeriodEnd?: string;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
  }): Promise<Subscription> {
    const now = new Date().toISOString();
    // Written whole rather than merged: a status change carries its own dates,
    // and a half-updated row — `active` still holding the trial's end date —
    // is the shape that makes a billing bug hard to see.
    await this.query(
      `INSERT INTO subscriptions
         (organization_id, status, trial_ends_at, current_period_end,
          stripe_customer_id, stripe_subscription_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (organization_id)
       DO UPDATE SET
         status = EXCLUDED.status,
         trial_ends_at = EXCLUDED.trial_ends_at,
         current_period_end = EXCLUDED.current_period_end,
         stripe_customer_id = EXCLUDED.stripe_customer_id,
         stripe_subscription_id = EXCLUDED.stripe_subscription_id,
         updated_at = EXCLUDED.updated_at`,
      [
        input.organizationId,
        input.status,
        input.trialEndsAt ?? null,
        input.currentPeriodEnd ?? null,
        input.stripeCustomerId ?? null,
        input.stripeSubscriptionId ?? null,
        now,
        now,
      ],
    );
    const saved = await this.getSubscription(input.organizationId);
    if (saved === undefined) {
      throw new Error("Subscription was not persisted");
    }
    return saved;
  }

  public async removeMembership(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await this.query(
      `DELETE FROM organization_memberships
       WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId],
    );
  }

  public async listMemberships(
    organizationId: string,
  ): Promise<OrganizationMembership[]> {
    const rows = await this.rows(
      `SELECT * FROM organization_memberships
       WHERE organization_id = $1 ORDER BY created_at, user_id`,
      [organizationId],
    );
    return rows.map((row) => this.toMembership(row));
  }

  public async getMembership(
    organizationId: string,
    userId: string,
  ): Promise<OrganizationMembership | undefined> {
    const row = await this.row(
      `SELECT * FROM organization_memberships
       WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId],
    );
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
    await this.query(
      `INSERT INTO projects
         (id, organization_id, slug, name, description, archived, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        project.id,
        project.organizationId,
        project.slug,
        project.name,
        project.description,
        false,
        now,
        now,
      ],
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
    await this.query(
      `UPDATE projects
       SET slug = $1, name = $2, description = $3, archived = $4,
           policy_json = $5, updated_at = $6
       WHERE id = $7`,
      [
        project.slug,
        project.name,
        project.description,
        project.archived,
        project.policy === undefined ? null : JSON.stringify(project.policy),
        project.updatedAt,
        id,
      ],
    );
    return project;
  }

  public async getProject(id: string): Promise<ProjectRecord | undefined> {
    const row = await this.row("SELECT * FROM projects WHERE id = $1", [id]);
    return row === undefined ? undefined : this.toProject(row);
  }

  public async listProjects(organizationId: string): Promise<ProjectRecord[]> {
    const rows = await this.rows(
      `SELECT * FROM projects
       WHERE organization_id = $1 ORDER BY name, id`,
      [organizationId],
    );
    return rows.map((row) => this.toProject(row));
  }

  public async linkRepository(
    projectId: string,
    repositoryId: string,
  ): Promise<void> {
    await this.query(
      `INSERT INTO project_repositories
         (project_id, repository_id, linked_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id, repository_id) DO NOTHING`,
      [projectId, repositoryId, new Date().toISOString()],
    );
  }

  public async unlinkRepository(
    projectId: string,
    repositoryId: string,
  ): Promise<void> {
    await this.query(
      `DELETE FROM project_repositories
       WHERE project_id = $1 AND repository_id = $2`,
      [projectId, repositoryId],
    );
  }

  public async listProjectRepositories(
    projectId: string,
  ): Promise<StoredRepository[]> {
    const rows = await this.rows(
      `SELECT r.* FROM repositories r
       JOIN project_repositories pr ON pr.repository_id = r.id
       WHERE pr.project_id = $1 ORDER BY r.id`,
      [projectId],
    );
    return rows.map((row) => this.toRepository(row));
  }

  public async projectHasRepository(
    projectId: string,
    repositoryId: string,
  ): Promise<boolean> {
    const row = await this.row(
      `SELECT 1 AS found FROM project_repositories
       WHERE project_id = $1 AND repository_id = $2`,
      [projectId, repositoryId],
    );
    return row !== undefined;
  }

  public async registerWorker(input: {
    userId: string;
    organizationId: string;
    name: string;
    adapters: string[];
    version: string;
  }): Promise<WorkerRecord> {
    if ((await this.getUser(input.userId)) === undefined) {
      throw new Error(`Unknown user: ${input.userId}`);
    }
    if ((await this.getOrganization(input.organizationId)) === undefined) {
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
    await this.query(
      `INSERT INTO workers
         (id, user_id, organization_id, name, adapters_json, version,
          registered_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        worker.id,
        worker.userId,
        worker.organizationId,
        worker.name,
        JSON.stringify(worker.adapters),
        worker.version,
        worker.registeredAt,
        worker.lastSeenAt,
      ],
    );
    return worker;
  }

  public async listWorkers(filter?: {
    organizationId?: string;
  }): Promise<WorkerRecord[]> {
    // `= $1` rather than a caller-side filter, so a legacy row with a NULL
    // organization never matches and cannot surface in a tenant's fleet.
    const rows =
      filter?.organizationId === undefined
        ? await this.rows("SELECT * FROM workers ORDER BY last_seen_at DESC")
        : await this.rows(
            `SELECT * FROM workers WHERE organization_id = $1
             ORDER BY last_seen_at DESC`,
            [filter.organizationId],
          );
    return rows.map((row) => this.toWorker(row));
  }

  public async getWorker(id: string): Promise<WorkerRecord | undefined> {
    const row = await this.row("SELECT * FROM workers WHERE id = $1", [id]);
    return row === undefined ? undefined : this.toWorker(row);
  }

  public async touchWorker(id: string, at: string): Promise<void> {
    await this.query("UPDATE workers SET last_seen_at = $1 WHERE id = $2", [
      at,
      id,
    ]);
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

    // The advisory lock plays the role BEGIN IMMEDIATE plays in SQLite: two
    // workers polling at the same moment serialise here rather than both
    // reading the same pending row and racing to claim it.
    return await this.transaction(
      async (client) => {
        const now = new Date();
        const nowIso = now.toISOString();
        const expired = (
          await client.query(
            `SELECT task_id FROM work_leases
             WHERE status = 'active' AND expires_at <= $1`,
            [nowIso],
          )
        ).rows as Row[];
        await client.query(
          `UPDATE work_leases
           SET status = 'expired', finished_at = $1, outcome = 'expired',
               detail = 'lease expired'
           WHERE status = 'active' AND expires_at <= $1`,
          [nowIso],
        );
        for (const row of expired) {
          await client.query(
            `UPDATE submitted_tasks SET status = 'submitted', claimed_at = NULL
             WHERE id = $1 AND status = 'claimed'`,
            [text(row, "task_id")],
          );
        }

        const values: unknown[] = [];
        const clauses = ["status = 'submitted'"];
        clauses.push(
          `NOT EXISTS (
            SELECT 1 FROM submitted_tasks predecessor
            WHERE predecessor.id = submitted_tasks.after_task_id
              AND predecessor.status IN ('submitted', 'claimed', 'planned', 'paused')
          )`,
        );
        if (input.taskId !== undefined) {
          clauses.push(`id = ${bind(values, input.taskId)}`);
        }
        if (input.repositoryId !== undefined) {
          clauses.push(`repository_id = ${bind(values, input.repositoryId)}`);
        }
        if (input.projectId !== undefined) {
          clauses.push(`project_id = ${bind(values, input.projectId)}`);
        }
        // Fail closed, and this is the clause the whole feature rests on.
        //
        // The control plane's own drain calls this with no `taskId` and takes
        // whatever is oldest, so filtering the listings elsewhere does not
        // stop it: without this, a question row is claimed by the coding path
        // within a minute of being filed and executed as though its text were
        // an objective — planned, admitted, integrated. Absent means `task`,
        // so every caller written before questions existed keeps taking
        // exactly what it always took.
        const kinds = input.kinds ?? ["task"];
        clauses.push(
          `kind IN (${kinds.map((kind) => bind(values, kind)).join(", ")})`,
        );
        // A NULL owner matches either way: nobody's account is at stake, so
        // there is nothing to reserve and nothing to get wrong.
        if (input.claimableBy !== undefined) {
          clauses.push(
            `(submitted_by IS NULL OR submitted_by = ${bind(values, input.claimableBy)})`,
          );
        }
        if (
          input.excludeSubmittedBy !== undefined &&
          input.excludeSubmittedBy.length > 0
        ) {
          // Expanded rather than passed as an array parameter, to match the
          // SQLite branch and to keep the generated SQL free of driver-level
          // array serialisation. The list is one entry per user with a live
          // worker, so it is bounded by the size of the organization's fleet.
          const placeholders = input.excludeSubmittedBy
            .map((owner) => bind(values, owner))
            .join(", ");
          clauses.push(
            `(submitted_by IS NULL OR submitted_by NOT IN (${placeholders}))`,
          );
        }
        // The parallelism cap bounds concurrent leases per repository. It is
        // a throughput valve, not the safety mechanism: exact-base
        // integration and stale-requeue at acceptance hold at any setting.
        clauses.push(
          `(SELECT COUNT(*) FROM work_leases
            WHERE work_leases.repository_id = submitted_tasks.repository_id
              AND work_leases.status = 'active') < ${bind(values, parallelism)}`,
        );

        const row = (
          await client.query(
            `SELECT * FROM submitted_tasks WHERE ${clauses.join(" AND ")}
             ORDER BY CASE kind WHEN 'question' THEN 0 ELSE 1 END,
                      submitted_at, seq LIMIT 1`,
            values,
          )
        ).rows[0] as Row | undefined;
        if (row === undefined) {
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
          plan: undefined,
        };

        await client.query(
          `UPDATE submitted_tasks SET status = 'claimed', claimed_at = $1
           WHERE id = $2`,
          [lease.issuedAt, task.id],
        );
        await client.query(
          `INSERT INTO work_leases
             (id, task_id, worker_id, repository_id, project_id, status,
              base_revision, issued_at, expires_at, heartbeat_at)
           VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9)`,
          [
            lease.id,
            lease.taskId,
            lease.workerId,
            lease.repositoryId,
            lease.projectId ?? null,
            lease.baseRevision,
            lease.issuedAt,
            lease.expiresAt,
            lease.heartbeatAt,
          ],
        );
        return {
          lease,
          task: { ...task, status: "claimed", claimedAt: lease.issuedAt },
        };
      },
      { serialize: true },
    );
  }

  public async getWorkLease(id: string): Promise<WorkLease | undefined> {
    const row = await this.row("SELECT * FROM work_leases WHERE id = $1", [id]);
    return row === undefined ? undefined : this.toWorkLease(row);
  }

  public async listWorkLeases(
    filter: {
      workerId?: string;
      status?: WorkLeaseStatus;
      projectId?: ProjectId;
      repositoryId?: string;
      issuedAfter?: string;
    } = {},
  ): Promise<WorkLease[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.workerId !== undefined) {
      clauses.push(`worker_id = ${bind(values, filter.workerId)}`);
    }
    if (filter.status !== undefined) {
      clauses.push(`status = ${bind(values, filter.status)}`);
    }
    if (filter.projectId !== undefined) {
      clauses.push(`project_id = ${bind(values, filter.projectId)}`);
    }
    if (filter.repositoryId !== undefined) {
      clauses.push(`repository_id = ${bind(values, filter.repositoryId)}`);
    }
    if (filter.issuedAfter !== undefined) {
      clauses.push(`issued_at > ${bind(values, filter.issuedAfter)}`);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = await this.rows(
      `SELECT * FROM work_leases${where} ORDER BY issued_at DESC`,
      values,
    );
    return rows.map((row) => this.toWorkLease(row));
  }

  public async saveWorkLeasePlan(
    input: SaveWorkLeasePlanInput,
  ): Promise<SaveWorkLeasePlanResult> {
    // Serialized for the same reason leaseNextTask is: two workers arbitrating
    // overlapping plans at the same moment must not both read a view that
    // omits the other, and the loser is told to decide again.
    return await this.transaction(
      async (client): Promise<SaveWorkLeasePlanResult> => {
        const row = (
          await client.query(
            "SELECT * FROM work_leases WHERE id = $1 AND status = 'active'",
            [input.leaseId],
          )
        ).rows[0] as Row | undefined;
        if (row === undefined) {
          return { outcome: "lease_lost" };
        }
        const lease = this.toWorkLease(row);
        if (
          input.replaceApproved !== true &&
          lease.plan !== undefined &&
          planAdmissionApproved(lease.plan.admission)
        ) {
          return { outcome: "already_admitted", lease };
        }
        const approvedLeaseIds = (
          (
            await client.query(
              `SELECT * FROM work_leases
               WHERE repository_id = $1 AND status = 'active' AND id <> $2`,
              [lease.repositoryId, lease.id],
            )
          ).rows as Row[]
        )
          .map((candidate) => this.toWorkLease(candidate))
          .filter(
            (candidate) =>
              candidate.plan !== undefined &&
              planAdmissionApproved(candidate.plan.admission),
          )
          .map((candidate) => candidate.id)
          .sort();
        if (!sameLeaseIdSet(approvedLeaseIds, input.observedApprovedLeaseIds)) {
          return { outcome: "stale", approvedLeaseIds };
        }
        await client.query(
          "UPDATE work_leases SET plan_json = $1 WHERE id = $2",
          [JSON.stringify(input.submission), lease.id],
        );
        return {
          outcome: "saved",
          lease: { ...lease, plan: structuredClone(input.submission) },
        };
      },
      { serialize: true },
    );
  }

  public async heartbeatWorkLease(
    id: string,
    at: string,
    expiresAt: string,
  ): Promise<WorkLease | undefined> {
    if (expiresAt <= at) {
      return undefined;
    }
    const changed = await this.query(
      `UPDATE work_leases SET heartbeat_at = $1, expires_at = $2
       WHERE id = $3 AND status = 'active' AND expires_at > $1`,
      [at, expiresAt, id],
    );
    return (changed.rowCount ?? 0) === 0
      ? undefined
      : await this.getWorkLease(id);
  }

  public async finishWorkLease(
    id: string,
    status: Exclude<WorkLeaseStatus, "active">,
    at: string,
    detail?: string,
  ): Promise<boolean> {
    return await this.transaction(
      async (client) => {
        const row = (
          await client.query(
            "SELECT * FROM work_leases WHERE id = $1 AND status = 'active'",
            [id],
          )
        ).rows[0] as Row | undefined;
        if (row === undefined) {
          return false;
        }
        const lease = this.toWorkLease(row);
        const lapsed = lease.expiresAt <= at;
        if (status === "expired" ? !lapsed : lapsed) {
          return false;
        }
        await client.query(
          `UPDATE work_leases SET status = $1, finished_at = $2, outcome = $1, detail = $3
           WHERE id = $4`,
          [status, at, detail ?? null, id],
        );

        // A released or expired lease returns its task to the queue; a settled
        // one leaves the task alone for the caller to complete.
        if (status === "released" || status === "expired") {
          await client.query(
            `UPDATE submitted_tasks SET status = 'submitted', claimed_at = NULL
             WHERE id = $1 AND status = 'claimed'`,
            [lease.taskId],
          );
        }
        return true;
      },
      { serialize: true },
    );
  }

  public async expireWorkLeases(now: string): Promise<WorkLease[]> {
    const rows = await this.rows(
      "SELECT * FROM work_leases WHERE status = 'active' AND expires_at <= $1",
      [now],
    );
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
      organizationId: optionalText(row, "organization_id"),
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
      plan: optionalJson<WorkLeasePlan>(row, "plan_json"),
    };
  }

  private toTokenUsage(row: Row): TokenUsageRecord {
    return {
      id: String(row["id"]),
      usageKey: String(row["usage_key"]),
      projectId: (row["project_id"] as string | null) ?? undefined,
      repositoryId: String(row["repository_id"]),
      taskId: String(row["task_id"]),
      leaseId: (row["lease_id"] as string | null) ?? undefined,
      runId: (row["run_id"] as string | null) ?? undefined,
      agentId: String(row["agent_id"]),
      phase: row["phase"] as TokenUsageRecord["phase"],
      inputTokens: Number(row["input_tokens"]),
      outputTokens: Number(row["output_tokens"]),
      freshTokens:
        row["fresh_tokens"] === null || row["fresh_tokens"] === undefined
          ? undefined
          : Number(row["fresh_tokens"]),
      totalTokens: Number(row["total_tokens"]),
      recordedAt: String(row["recorded_at"]),
    };
  }

  public async recordTokenUsage(
    input: RecordTokenUsageInput,
  ): Promise<TokenUsageRecord> {
    // Upsert for the same reason the SQLite backend does: reports carry a
    // running total, so the newest one replaces its predecessor — including
    // clearing `fresh_tokens` when the newest report has no cache split.
    const rows = (
      await this.query(
        `INSERT INTO token_usage
           (id, usage_key, project_id, repository_id, task_id, lease_id,
            run_id, agent_id, phase, input_tokens, output_tokens,
            fresh_tokens, total_tokens, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (usage_key) DO UPDATE SET
           input_tokens = EXCLUDED.input_tokens,
           output_tokens = EXCLUDED.output_tokens,
           fresh_tokens = EXCLUDED.fresh_tokens,
           total_tokens = EXCLUDED.total_tokens,
           run_id = COALESCE(EXCLUDED.run_id, token_usage.run_id),
           recorded_at = EXCLUDED.recorded_at
         RETURNING *`,
        [
          createId("usage"),
          input.usageKey,
          input.projectId ?? null,
          input.repositoryId,
          input.taskId,
          input.leaseId ?? null,
          input.runId ?? null,
          input.agentId,
          input.phase,
          input.inputTokens ?? 0,
          input.outputTokens ?? 0,
          input.freshTokens ?? null,
          input.totalTokens,
          input.recordedAt,
        ],
      )
    ).rows as Row[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Token usage upsert returned no row");
    }
    return this.toTokenUsage(row);
  }

  public async listTokenUsage(
    filter: TokenUsageFilter = {},
  ): Promise<TokenUsageRecord[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    const bind = (column: string, value: unknown): void => {
      values.push(value);
      clauses.push(`${column} = $${values.length}`);
    };
    if (filter.projectId !== undefined) {
      bind("project_id", filter.projectId);
    }
    if (filter.repositoryId !== undefined) {
      bind("repository_id", filter.repositoryId);
    }
    if (filter.taskId !== undefined) {
      bind("task_id", filter.taskId);
    }
    if (filter.leaseId !== undefined) {
      bind("lease_id", filter.leaseId);
    }
    if (filter.recordedAfter !== undefined) {
      values.push(filter.recordedAfter);
      clauses.push(`recorded_at >= $${values.length}`);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = (
      await this.query(
        `SELECT * FROM token_usage${where} ORDER BY recorded_at ASC`,
        values,
      )
    ).rows as Row[];
    return rows.map((row) => this.toTokenUsage(row));
  }


  /* ------------------------------------------------------- invitations ---- */


  /* -------------------------------------------------- repository grants ---- */

  public async saveRepositoryGrant(grant: RepositoryGrant): Promise<void> {
    await this.query(
      `INSERT INTO repository_grants
         (repository_id, user_id, role, granted_by, comped, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (repository_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, comped = EXCLUDED.comped`,
      [
        grant.repositoryId,
        grant.userId,
        grant.role,
        grant.grantedBy ?? null,
        grant.comped,
        grant.createdAt,
      ],
    );
  }

  public async removeRepositoryGrant(
    repositoryId: string,
    userId: string,
  ): Promise<void> {
    await this.query(
      "DELETE FROM repository_grants WHERE repository_id = $1 AND user_id = $2",
      [repositoryId, userId],
    );
  }

  public async listRepositoryGrants(
    repositoryId: string,
  ): Promise<RepositoryGrant[]> {
    const rows = await this.rows(
      "SELECT * FROM repository_grants WHERE repository_id = $1 ORDER BY created_at",
      [repositoryId],
    );
    return rows.map((row) => this.toGrant(row));
  }

  public async listGrantsForUser(userId: string): Promise<RepositoryGrant[]> {
    const rows = await this.rows(
      "SELECT * FROM repository_grants WHERE user_id = $1",
      [userId],
    );
    return rows.map((row) => this.toGrant(row));
  }

  private toGrant(row: Row): RepositoryGrant {
    return {
      repositoryId: text(row, "repository_id"),
      userId: text(row, "user_id"),
      role: text(row, "role") as RepositoryGrant["role"],
      grantedBy: optionalText(row, "granted_by"),
      comped: flag(row, "comped"),
      createdAt: text(row, "created_at"),
    };
  }

  public async createInvitation(invitation: InvitationRecord): Promise<void> {
    await this.query(
      `INSERT INTO invitations
         (id, organization_id, repository_id, email, role, secret_hash,
          invited_by, comped, created_at, expires_at, accepted_at,
          accepted_by, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NULL, NULL)`,
      [
        invitation.id,
        invitation.organizationId,
        invitation.repositoryId ?? null,
        // Lowercased here because this schema has no case-insensitive collation
        // on the column, and an invitation must match the address regardless of
        // how the recipient types it.
        invitation.email.toLowerCase(),
        invitation.role,
        invitation.secretHash,
        invitation.invitedBy,
        invitation.comped,
        invitation.createdAt,
        invitation.expiresAt,
      ],
    );
  }

  public async getInvitation(id: string): Promise<InvitationRecord | undefined> {
    const row = await this.row("SELECT * FROM invitations WHERE id = $1", [id]);
    return row === undefined ? undefined : this.toInvitation(row);
  }

  public async listInvitations(
    organizationId: string,
  ): Promise<InvitationRecord[]> {
    const rows = await this.rows(
      `SELECT * FROM invitations WHERE organization_id = $1
       ORDER BY created_at DESC`,
      [organizationId],
    );
    return rows.map((row) => this.toInvitation(row));
  }

  public async acceptInvitation(
    id: string,
    userId: string,
    at: string,
  ): Promise<boolean> {
    const rows = await this.rows(
      `UPDATE invitations SET accepted_at = $1, accepted_by = $2
       WHERE id = $3 AND accepted_at IS NULL AND revoked_at IS NULL
       RETURNING id`,
      [at, userId, id],
    );
    return rows.length === 1;
  }

  public async revokeInvitation(id: string, at: string): Promise<void> {
    await this.query(
      "UPDATE invitations SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL",
      [at, id],
    );
  }

  private toInvitation(row: Row): InvitationRecord {
    return {
      id: text(row, "id"),
      organizationId: text(row, "organization_id"),
      repositoryId: optionalText(row, "repository_id"),
      email: text(row, "email"),
      role: text(row, "role") as InvitationRecord["role"],
      secretHash: text(row, "secret_hash"),
      invitedBy: text(row, "invited_by"),
      comped: flag(row, "comped"),
      createdAt: text(row, "created_at"),
      expiresAt: text(row, "expires_at"),
      acceptedAt: optionalText(row, "accepted_at"),
      acceptedBy: optionalText(row, "accepted_by"),
      revokedAt: optionalText(row, "revoked_at"),
    };
  }

  public async createPasswordReset(reset: PasswordResetRecord): Promise<void> {
    await this.query(
      `INSERT INTO password_resets
         (id, user_id, email, token_hash, created_at, expires_at, consumed_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
      [
        reset.id,
        reset.userId,
        // Lowercased for the same reason invitations are: this schema has no
        // case-insensitive collation on the column.
        reset.email.toLowerCase(),
        reset.secretHash,
        reset.createdAt,
        reset.expiresAt,
      ],
    );
  }

  public async getPasswordReset(
    id: string,
  ): Promise<PasswordResetRecord | undefined> {
    const row = await this.row("SELECT * FROM password_resets WHERE id = $1", [
      id,
    ]);
    return row === undefined ? undefined : this.toPasswordReset(row);
  }

  public async createWaitlistEntry(entry: WaitlistEntry): Promise<WaitlistEntry> {
    const email = entry.email.trim().toLowerCase();
    // Upsert on the address, which is where the uniqueness lives — the id is
    // the caller's and a second attempt carries a new one. `LOWER(email)` is
    // an expression index, so the conflict target has to name the expression
    // rather than the column.
    await this.query(
      `INSERT INTO waitlist_entries
         (id, email, display_name, note, source, created_at, invited_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (LOWER(email)) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         note = EXCLUDED.note,
         source = EXCLUDED.source`,
      [
        entry.id,
        email,
        entry.displayName ?? null,
        entry.note ?? null,
        entry.source ?? null,
        entry.createdAt,
        entry.invitedAt ?? null,
      ],
    );
    const stored = await this.getWaitlistEntryByEmail(email);
    return stored ?? { ...entry, email };
  }

  public async getWaitlistEntryByEmail(
    email: string,
  ): Promise<WaitlistEntry | undefined> {
    const row = await this.row(
      "SELECT * FROM waitlist_entries WHERE LOWER(email) = $1",
      [email.trim().toLowerCase()],
    );
    return row === undefined ? undefined : this.toWaitlistEntry(row);
  }

  public async listWaitlistEntries(): Promise<WaitlistEntry[]> {
    return (
      await this.rows("SELECT * FROM waitlist_entries ORDER BY created_at, id")
    ).map((row) => this.toWaitlistEntry(row));
  }

  public async markWaitlistEntryInvited(
    id: string,
    at: string,
  ): Promise<boolean> {
    // Conditional on still waiting, so two operators approving the same row
    // send one welcome between them rather than one each.
    const rows = await this.rows(
      `UPDATE waitlist_entries SET invited_at = $1
       WHERE id = $2 AND invited_at IS NULL
       RETURNING id`,
      [at, id],
    );
    return rows.length === 1;
  }

  public async deleteWaitlistEntry(id: string): Promise<void> {
    await this.query("DELETE FROM waitlist_entries WHERE id = $1", [id]);
  }

  private toWaitlistEntry(row: Row): WaitlistEntry {
    return {
      id: text(row, "id"),
      email: text(row, "email"),
      displayName: optionalText(row, "display_name"),
      note: optionalText(row, "note"),
      source: optionalText(row, "source"),
      createdAt: text(row, "created_at"),
      invitedAt: optionalText(row, "invited_at"),
    };
  }

  public async createSignupIntent(intent: SignupIntentRecord): Promise<void> {
    await this.query(
      `INSERT INTO signup_intents
         (id, organization_id, email, organization_name, secret_hash,
          stripe_session_id, user_id, created_at, expires_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        intent.id,
        intent.organizationId,
        intent.email,
        intent.organizationName ?? null,
        intent.secretHash,
        intent.stripeSessionId ?? null,
        intent.userId ?? null,
        intent.createdAt,
        intent.expiresAt,
        intent.completedAt ?? null,
      ],
    );
  }

  public async getSignupIntent(
    id: string,
  ): Promise<SignupIntentRecord | undefined> {
    const row = await this.row("SELECT * FROM signup_intents WHERE id = $1", [
      id,
    ]);
    return row === undefined ? undefined : this.toSignupIntent(row);
  }

  public async completeSignupIntent(
    id: string,
    at: string,
  ): Promise<boolean> {
    // Conditional on still being open, so a Stripe redelivery — or the second
    // of two events that both name this intent — provisions nothing twice.
    const rows = await this.rows(
      `UPDATE signup_intents SET completed_at = $1
       WHERE id = $2 AND completed_at IS NULL
       RETURNING id`,
      [at, id],
    );
    return rows.length === 1;
  }

  public async getSignupIntentByOrganization(
    organizationId: string,
  ): Promise<SignupIntentRecord | undefined> {
    const row = await this.row(
      "SELECT * FROM signup_intents WHERE organization_id = $1",
      [organizationId],
    );
    return row === undefined ? undefined : this.toSignupIntent(row);
  }

  public async attachSignupIntentUser(
    id: string,
    userId: string,
  ): Promise<boolean> {
    // Conditional, so two requests racing one claim link cannot both build an
    // account against the same paid organization.
    const rows = await this.rows(
      "UPDATE signup_intents SET user_id = $1 WHERE id = $2 AND user_id IS NULL RETURNING id",
      [userId, id],
    );
    return rows.length === 1;
  }

  public async deleteExpiredSignupIntents(before: string): Promise<void> {
    await this.query(
      "DELETE FROM signup_intents WHERE completed_at IS NULL AND expires_at < $1",
      [before],
    );
  }

  public async consumePasswordReset(id: string, at: string): Promise<boolean> {
    const rows = await this.rows(
      `UPDATE password_resets SET consumed_at = $1
       WHERE id = $2 AND consumed_at IS NULL
       RETURNING id`,
      [at, id],
    );
    return rows.length === 1;
  }

  public async deletePasswordResetsForUser(userId: string): Promise<void> {
    await this.query("DELETE FROM password_resets WHERE user_id = $1", [userId]);
  }

  private toSignupIntent(row: Row): SignupIntentRecord {
    return {
      id: text(row, "id"),
      organizationId: text(row, "organization_id"),
      email: text(row, "email"),
      organizationName: optionalText(row, "organization_name"),
      secretHash: text(row, "secret_hash"),
      stripeSessionId: optionalText(row, "stripe_session_id"),
      userId: optionalText(row, "user_id"),
      createdAt: text(row, "created_at"),
      expiresAt: text(row, "expires_at"),
      completedAt: optionalText(row, "completed_at"),
    };
  }

  private toPasswordReset(row: Row): PasswordResetRecord {
    return {
      id: text(row, "id"),
      userId: text(row, "user_id"),
      email: text(row, "email"),
      secretHash: text(row, "token_hash"),
      createdAt: text(row, "created_at"),
      expiresAt: text(row, "expires_at"),
      consumedAt: optionalText(row, "consumed_at"),
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
    await this.query(
      `INSERT INTO api_tokens
         (id, user_id, organization_id, name, secret_hash, scopes_json,
          created_at, created_by_session, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        token.id,
        token.userId,
        token.organizationId ?? null,
        token.name,
        token.secretHash,
        JSON.stringify(token.scopes),
        token.createdAt,
        token.createdBySession ?? null,
        token.expiresAt ?? null,
      ],
    );
  }

  public async getApiToken(id: string): Promise<ApiTokenRecord | undefined> {
    const row = await this.row("SELECT * FROM api_tokens WHERE id = $1", [id]);
    return row === undefined ? undefined : this.toApiToken(row);
  }

  public async listApiTokens(userId: string): Promise<ApiTokenRecord[]> {
    const rows = await this.rows(
      `SELECT * FROM api_tokens WHERE user_id = $1
       ORDER BY created_at DESC, seq DESC`,
      [userId],
    );
    return rows.map((row) => this.toApiToken(row));
  }

  public async touchApiToken(
    id: string,
    at: string,
    ipAddress: string,
  ): Promise<void> {
    await this.query(
      "UPDATE api_tokens SET last_used_at = $1, last_used_ip = $2 WHERE id = $3",
      [at, ipAddress, id],
    );
  }

  public async revokeApiToken(
    id: string,
    at: string,
    reason: string,
  ): Promise<void> {
    // Revocation is recorded rather than deleted so the audit trail keeps a
    // record that the credential existed.
    await this.query(
      `UPDATE api_tokens SET revoked_at = $1, revoked_reason = $2
       WHERE id = $3 AND revoked_at IS NULL`,
      [at, reason, id],
    );
  }

  public async deleteExpiredApiTokens(now: string): Promise<number> {
    const result = await this.query(
      "DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at <= $1",
      [now],
    );
    return result.rowCount ?? 0;
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
    await this.query(
      `INSERT INTO auth_sessions
         (id, user_id, secret_hash, csrf_hash, created_at, expires_at,
          last_seen_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        session.id,
        session.userId,
        session.secretHash,
        session.csrfHash,
        session.createdAt,
        session.expiresAt,
        session.lastSeenAt,
        session.ipAddress,
        session.userAgent,
      ],
    );
  }

  public async getAuthSession(
    id: string,
  ): Promise<AuthSessionRecord | undefined> {
    const row = await this.row("SELECT * FROM auth_sessions WHERE id = $1", [
      id,
    ]);
    return row === undefined ? undefined : this.toAuthSession(row);
  }

  public async touchAuthSession(id: string, at: string): Promise<void> {
    await this.query(
      "UPDATE auth_sessions SET last_seen_at = $1 WHERE id = $2",
      [at, id],
    );
  }

  public async revokeAuthSession(id: string): Promise<void> {
    await this.query("DELETE FROM auth_sessions WHERE id = $1", [id]);
  }

  public async revokeUserSessions(userId: string): Promise<void> {
    await this.query("DELETE FROM auth_sessions WHERE user_id = $1", [userId]);
  }

  public async deleteExpiredAuthSessions(now: string): Promise<number> {
    const result = await this.query(
      "DELETE FROM auth_sessions WHERE expires_at <= $1",
      [now],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Runs and submitted tasks are execution history rather than repository
   * state, so they are left to the `repositories(id)` foreign key on
   * `runs`/`submitted_tasks`: deleting a repository either still references
   * fails loudly, matching the store's documented contract and mirroring the
   * SQLite backend.
   *
   * Everything else scoped to this repository — its shared channel (which
   * would otherwise block deletion outright, since `channel_messages` also
   * carries that foreign key) and its per-repository access grants — is the
   * repository's *own* state, not history, and is cascaded here so a repeat
   * registration of the same id never inherits another repository's chat
   * room or grants.
   */
  public async removeRepository(id: string): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `DELETE FROM channel_message_reactions
           WHERE message_id IN (
             SELECT id FROM channel_messages WHERE repository_id = $1
           )`,
        [id],
      );
      await client.query(
        `DELETE FROM channel_message_replies
           WHERE message_id IN (
             SELECT id FROM channel_messages WHERE repository_id = $1
           )`,
        [id],
      );
      await client.query(
        "DELETE FROM channel_messages WHERE repository_id = $1",
        [id],
      );
      await client.query(
        "DELETE FROM channel_agent_overrides WHERE repository_id = $1",
        [id],
      );
      await client.query(
        "DELETE FROM channel_agent_members WHERE repository_id = $1",
        [id],
      );
      await client.query(
        "DELETE FROM channel_read_cursors WHERE repository_id = $1",
        [id],
      );
      await client.query("DELETE FROM channel_mutes WHERE repository_id = $1", [
        id,
      ]);
      await client.query(
        `DELETE FROM sub_channel_members
           WHERE channel_id IN (
             SELECT id FROM sub_channels WHERE repository_id = $1
           )`,
        [id],
      );
      await client.query("DELETE FROM sub_channels WHERE repository_id = $1", [
        id,
      ]);
      await client.query(
        "DELETE FROM channel_membership_backfills WHERE repository_id = $1",
        [id],
      );
      await client.query(
        "DELETE FROM auditor_cursors WHERE repository_id = $1",
        [id],
      );
      await client.query(
        "DELETE FROM repository_grants WHERE repository_id = $1",
        [id],
      );
      await client.query(
        "DELETE FROM project_repositories WHERE repository_id = $1",
        [id],
      );
      await client.query(
        "DELETE FROM canonical_versions WHERE repository_id = $1",
        [id],
      );
      // The run history, children first — see the SQLite store: the cascade
      // covered the channel and grants and nothing else, so deleting any
      // repository that had actually been used failed on the `runs` foreign
      // key.
      // The one grandchild: patches hang off changesets, which hang off runs.
      await client.query(
        `DELETE FROM file_patches
         WHERE changeset_id IN (
           SELECT id FROM changesets
           WHERE run_id IN (SELECT id FROM runs WHERE repository_id = $1)
         )`,
        [id],
      );
      for (const child of [
        "tasks",
        "workspaces",
        "resource_leases",
        "conflicts",
        "changesets",
        "integrations",
        "task_plan_revisions",
        "scope_changes",
        "changeset_comments",
      ]) {
        await client.query(
          `DELETE FROM ${child}
           WHERE run_id IN (SELECT id FROM runs WHERE repository_id = $1)`,
          [id],
        );
      }
      await client.query("DELETE FROM approvals WHERE repository_id = $1", [
        id,
      ]);
      await client.query("DELETE FROM runs WHERE repository_id = $1", [id]);
      await client.query("DELETE FROM work_leases WHERE repository_id = $1", [
        id,
      ]);
      await client.query(
        "DELETE FROM submitted_tasks WHERE repository_id = $1",
        [id],
      );
      await client.query("DELETE FROM repositories WHERE id = $1", [id]);
    });
  }

  public async listRepositories(): Promise<StoredRepository[]> {
    const rows = await this.rows("SELECT * FROM repositories ORDER BY id");
    return rows.map((row) => this.toRepository(row));
  }

  public async renameRepository(
    id: string,
    displayName: string | undefined,
  ): Promise<void> {
    await this.query(
      "UPDATE repositories SET display_name = $1 WHERE id = $2",
      [displayName ?? null, id],
    );
  }

  public async setRepositoryPicture(
    id: string,
    picture: string | undefined,
  ): Promise<void> {
    await this.query("UPDATE repositories SET picture = $1 WHERE id = $2", [
      picture ?? null,
      id,
    ]);
  }

  public async getRepository(
    id: string,
  ): Promise<StoredRepository | undefined> {
    const row = await this.row("SELECT * FROM repositories WHERE id = $1", [
      id,
    ]);
    return row === undefined ? undefined : this.toRepository(row);
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
      kind: input.kind ?? "task",
      answerTo: input.answerTo,
      repositoryId: input.repositoryId,
      projectId,
      objective: input.objective,
      agentId: input.agentId,
      validationCommands: input.validationCommands,
      submittedBy: input.submittedBy,
      afterTaskId: input.afterTaskId,
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

    await this.transaction(
      async (client) => {
        if (task.afterTaskId === undefined && input.queueAfterCurrent === true) {
          const predecessor = (
            await client.query(
              `SELECT id FROM submitted_tasks
               WHERE repository_id = $1 AND project_id = $2 AND agent_id = $3
                 AND submitted_by IS NOT DISTINCT FROM $4
                 AND status IN ('submitted', 'claimed')
               ORDER BY submitted_at DESC, seq DESC LIMIT 1`,
              [
                task.repositoryId,
                task.projectId ?? DEFAULT_PROJECT_ID,
                task.agentId,
                task.submittedBy ?? null,
              ],
            )
          ).rows[0] as Row | undefined;
          task.afterTaskId =
            predecessor === undefined ? undefined : text(predecessor, "id");
        }
        // A new turn settles the conversation's previous one: its work
        // already landed, and what it was waiting for has now arrived. One
        // transaction with the insert, so "at most one open turn per
        // conversation" cannot be caught false in between.
        if (task.conversationId !== undefined) {
          await client.query(
            `UPDATE submitted_tasks
             SET status = 'integrated', completed_at = $1
             WHERE conversation_id = $2 AND status = 'open'`,
            [task.submittedAt, task.conversationId],
          );
        }
        await client.query(
          `INSERT INTO submitted_tasks
             (id, repository_id, project_id, objective, agent_id,
              validation_commands_json, submitted_by, status, submitted_at,
              context, conversation_id, model, effort, after_task_id,
              kind, answer_to)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                   $15, $16)`,
          [
            task.id,
            task.repositoryId,
            task.projectId ?? DEFAULT_PROJECT_ID,
            task.objective,
            task.agentId,
            JSON.stringify(task.validationCommands),
            task.submittedBy ?? null,
            task.status,
            task.submittedAt,
            task.context ?? null,
            task.conversationId ?? null,
            task.model ?? null,
            task.effort ?? null,
            task.afterTaskId ?? null,
            task.kind,
            task.answerTo ?? null,
          ],
        );
      },
      { serialize: true },
    );
    return task;
  }

  public async listSubmittedTasks(
    filter: SubmittedTaskFilter = {},
  ): Promise<SubmittedTask[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.repositoryId !== undefined) {
      clauses.push(`repository_id = ${bind(values, filter.repositoryId)}`);
    }
    if (filter.projectId !== undefined) {
      clauses.push(`project_id = ${bind(values, filter.projectId)}`);
    }
    if (filter.status !== undefined) {
      clauses.push(`status = ${bind(values, filter.status)}`);
    }
    // Defaults to work, so every caller that predates questions keeps seeing
    // exactly what it saw. The readers of this list feed coding paths — the
    // drain, the crash sweep, the queue view — and a question in any of them
    // would be treated as an objective. `any` is for the two lease-bookkeeping
    // callers that legitimately need both.
    if ((filter.kind ?? "task") !== "any") {
      clauses.push(`kind = ${bind(values, filter.kind ?? "task")}`);
    }

    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = await this.rows(
      `SELECT * FROM submitted_tasks${where} ORDER BY submitted_at, seq`,
      values,
    );
    return rows.map((row) => this.toSubmittedTask(row));
  }

  public async claimSubmittedTasks(
    repositoryId: string,
    projectId?: ProjectId,
  ): Promise<SubmittedTask[]> {
    return await this.transaction(
      async (client) => {
        const values: unknown[] = [repositoryId];
        const projectClause =
          projectId === undefined
            ? ""
            : ` AND project_id = ${bind(values, projectId)}`;
        const rows = (
          await client.query(
            `SELECT * FROM submitted_tasks
             WHERE repository_id = $1${projectClause} AND status = 'submitted'
               AND kind = 'task'
               AND NOT EXISTS (
                 SELECT 1 FROM submitted_tasks predecessor
                 WHERE predecessor.id = submitted_tasks.after_task_id
                   AND predecessor.status IN ('submitted', 'claimed', 'planned', 'paused')
               )
             ORDER BY submitted_at, seq`,
            values,
          )
        ).rows as Row[];

        const claimedAt = new Date().toISOString();
        for (const row of rows) {
          await client.query(
            `UPDATE submitted_tasks SET status = 'claimed', claimed_at = $1
             WHERE id = $2`,
            [claimedAt, text(row, "id")],
          );
        }
        return rows.map((row) => ({
          ...this.toSubmittedTask(row),
          status: "claimed" as const,
          claimedAt,
        }));
      },
      { serialize: true },
    );
  }

  public async retrySubmittedTask(taskId: TaskId): Promise<SubmittedTask> {
    const result = await this.query(
      `UPDATE submitted_tasks
       SET status = 'submitted', claimed_at = NULL, completed_at = NULL, run_id = NULL
       WHERE id = $1 AND status IN ('claimed', 'failed')`,
      [taskId],
    );
    if ((result.rowCount ?? 0) === 0) {
      const current = await this.row(
        "SELECT status FROM submitted_tasks WHERE id = $1",
        [taskId],
      );
      if (current === undefined) {
        throw new Error(`Unknown submitted task: ${taskId}`);
      }
      throw new Error(
        `Task ${taskId} cannot be retried from status ${text(current, "status")}`,
      );
    }
    const row = await this.row(
      "SELECT * FROM submitted_tasks WHERE id = $1",
      [taskId],
    );
    if (row === undefined) {
      throw new Error(`Submitted task disappeared after retry: ${taskId}`);
    }
    return this.toSubmittedTask(row);
  }

  public async cancelSubmittedTask(taskId: TaskId): Promise<SubmittedTask> {
    const completedAt = new Date().toISOString();
    const result = await this.query(
      `UPDATE submitted_tasks
       SET status = 'cancelled', completed_at = $1
       WHERE id = $2 AND status IN ('submitted', 'claimed', 'planned', 'open', 'paused')`,
      [completedAt, taskId],
    );
    if ((result.rowCount ?? 0) === 0) {
      const current = await this.row(
        "SELECT status FROM submitted_tasks WHERE id = $1",
        [taskId],
      );
      if (current === undefined) {
        throw new Error(`Unknown submitted task: ${taskId}`);
      }
      throw new Error(
        `Task ${taskId} cannot be cancelled from status ${text(current, "status")}`,
      );
    }
    const row = await this.row(
      "SELECT * FROM submitted_tasks WHERE id = $1",
      [taskId],
    );
    if (row === undefined) {
      throw new Error(
        `Submitted task disappeared after cancellation: ${taskId}`,
      );
    }
    return this.toSubmittedTask(row);
  }

  public async pauseSubmittedTask(
    taskId: TaskId,
  ): Promise<SubmittedTask | undefined> {
    // Returning the row from the UPDATE itself, so the pause and the read of
    // what was paused cannot straddle another writer.
    const row = await this.row(
      `UPDATE submitted_tasks SET status = 'paused'
       WHERE id = $1 AND status IN ('submitted', 'claimed')
       RETURNING *`,
      [taskId],
    );
    return row === undefined ? undefined : this.toSubmittedTask(row);
  }

  public async resumePausedTask(
    taskId: TaskId,
  ): Promise<SubmittedTask | undefined> {
    const row = await this.row(
      `UPDATE submitted_tasks
       SET status = 'submitted', claimed_at = NULL, run_id = NULL
       WHERE id = $1 AND status = 'paused'
       RETURNING *`,
      [taskId],
    );
    return row === undefined ? undefined : this.toSubmittedTask(row);
  }

  public async releasePlannedTask(
    taskId: TaskId,
  ): Promise<SubmittedTask | undefined> {
    // Returning the row from the UPDATE itself, so the release and the read
    // of what was released cannot straddle another writer.
    const row = await this.row(
      `UPDATE submitted_tasks SET status = 'submitted'
       WHERE id = $1 AND status = 'planned'
       RETURNING *`,
      [taskId],
    );
    return row === undefined ? undefined : this.toSubmittedTask(row);
  }

  public async completeSubmittedTask(
    taskId: TaskId,
    status: SubmittedTaskCompletionStatus,
    runId?: string,
  ): Promise<void> {
    const result = await this.query(
      `UPDATE submitted_tasks
       SET status = $1, completed_at = $2, run_id = $3
       WHERE id = $4 AND status = 'claimed'`,
      [status, new Date().toISOString(), runId ?? null, taskId],
    );
    if ((result.rowCount ?? 0) === 0) {
      const current = await this.row(
        "SELECT status FROM submitted_tasks WHERE id = $1",
        [taskId],
      );
      if (current === undefined) {
        throw new Error(`Unknown submitted task: ${taskId}`);
      }
      throw new Error(
        `Task ${taskId} cannot be completed from status ${text(current, "status")}`,
      );
    }
  }

  public async openSubmittedTask(taskId: TaskId, runId?: string): Promise<void> {
    const result = await this.query(
      `UPDATE submitted_tasks
       SET status = 'open', opened_at = $1, run_id = $2
       WHERE id = $3 AND status = 'claimed'`,
      [new Date().toISOString(), runId ?? null, taskId],
    );
    if ((result.rowCount ?? 0) === 0) {
      const current = await this.row(
        "SELECT status FROM submitted_tasks WHERE id = $1",
        [taskId],
      );
      if (current === undefined) {
        throw new Error(`Unknown submitted task: ${taskId}`);
      }
      throw new Error(
        `Task ${taskId} cannot be opened from status ${text(current, "status")}`,
      );
    }
  }

  public async expireOpenTasks(
    cutoff: string,
    filter: { repositoryId?: string } = {},
  ): Promise<SubmittedTask[]> {
    return await this.transaction(
      async (client) => {
        const values: unknown[] = [cutoff];
        const repositoryClause =
          filter.repositoryId === undefined
            ? ""
            : ` AND repository_id = ${bind(values, filter.repositoryId)}`;
        const rows = (
          await client.query(
            `SELECT * FROM submitted_tasks
             WHERE status = 'open' AND opened_at <= $1${repositoryClause}
             ORDER BY submitted_at, seq`,
            values,
          )
        ).rows as Row[];
        const completedAt = new Date().toISOString();
        for (const row of rows) {
          await client.query(
            `UPDATE submitted_tasks
             SET status = 'integrated', completed_at = $1
             WHERE id = $2 AND status = 'open'`,
            [completedAt, text(row, "id")],
          );
        }
        return rows.map((row) => ({
          ...this.toSubmittedTask(row),
          status: "integrated" as const,
          completedAt,
        }));
      },
      { serialize: true },
    );
  }

  private toSubmittedTask(row: Row): SubmittedTask {
    return {
      id: text(row, "id"),
      // Defaulted rather than required: the column arrived in migration 52 and
      // every row written before it is work, which is what the column default
      // says too. Read defensively so a store whose migration has not run yet
      // still returns a valid task rather than one with an undefined kind.
      kind: (optionalText(row, "kind") ?? "task") as TaskKind,
      answerTo: optionalText(row, "answer_to"),
      repositoryId: text(row, "repository_id"),
      projectId: optionalText(row, "project_id"),
      objective: text(row, "objective"),
      agentId: text(row, "agent_id"),
      validationCommands: parseJson<ValidationCommand[]>(
        row,
        "validation_commands_json",
      ),
      submittedBy: optionalText(row, "submitted_by"),
      afterTaskId: optionalText(row, "after_task_id"),
      context: optionalText(row, "context"),
      conversationId: optionalText(row, "conversation_id"),
      model: optionalText(row, "model"),
      effort: optionalText(row, "effort"),
      status: text(row, "status") as SubmittedTaskStatus,
      submittedAt: text(row, "submitted_at"),
      claimedAt: optionalText(row, "claimed_at"),
      completedAt: optionalText(row, "completed_at"),
      openedAt: optionalText(row, "opened_at"),
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

    await this.query(
      `INSERT INTO runs
         (id, repository_id, project_id, mode, scenario, status, started_at, base_revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        run.id,
        run.repositoryId,
        run.projectId ?? DEFAULT_PROJECT_ID,
        run.mode,
        run.scenario ?? null,
        run.status,
        run.startedAt,
        run.baseRevision,
      ],
    );

    await this.saveCanonicalVersion(input.repository.id, input.baseVersion);
    return run;
  }

  public async finishRun(
    runId: string,
    status: RunStatus,
    finalVersion?: CanonicalVersion,
  ): Promise<void> {
    const updated = await this.query(
      "UPDATE runs SET status = $1, finished_at = $2, final_revision = $3 WHERE id = $4",
      [status, new Date().toISOString(), finalVersion?.revision ?? null, runId],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new Error(`Unknown coordination run: ${runId}`);
    }

    if (finalVersion !== undefined) {
      const row = await this.row(
        "SELECT repository_id FROM runs WHERE id = $1",
        [runId],
      );
      if (row === undefined) {
        throw new Error(
          `Coordination run disappeared while finishing: ${runId}`,
        );
      }
      await this.saveCanonicalVersion(text(row, "repository_id"), finalVersion);
    }
  }

  public async saveTask(runId: string, task: TaskDefinition): Promise<void> {
    await this.query(
      `INSERT INTO tasks (run_id, id, objective, agent_id, status, validation_commands_json)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (run_id, id) DO UPDATE SET
         objective = EXCLUDED.objective,
         agent_id = EXCLUDED.agent_id,
         validation_commands_json = EXCLUDED.validation_commands_json`,
      [
        runId,
        task.id,
        task.objective,
        task.agentId,
        "submitted",
        JSON.stringify(task.validationCommands),
      ],
    );
  }

  public async savePlan(
    runId: string,
    taskId: TaskId,
    plan: AgentPlan,
  ): Promise<void> {
    const updated = await this.query(
      "UPDATE tasks SET plan_json = $1, status = $2 WHERE run_id = $3 AND id = $4",
      [JSON.stringify(plan), "planning", runId, taskId],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new Error(`Unknown task ${taskId} in run ${runId}`);
    }
  }

  public async savePlanRevision(
    runId: string,
    taskId: TaskId,
    input: Omit<StoredPlanRevision, "id" | "runId" | "taskId" | "createdAt">,
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
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO task_plan_revisions
           (id, run_id, task_id, revision, reason, canonical_revision,
            plan_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          revision.id,
          runId,
          taskId,
          revision.revision,
          revision.reason,
          revision.canonicalRevision,
          JSON.stringify(revision.plan),
          revision.createdAt,
        ],
      );
      const updated = await client.query(
        "UPDATE tasks SET plan_json = $1 WHERE run_id = $2 AND id = $3",
        [JSON.stringify(revision.plan), runId, taskId],
      );
      if ((updated.rowCount ?? 0) === 0) {
        throw new Error(`Unknown task ${taskId} in run ${runId}`);
      }
    });
    return revision;
  }

  public async listPlanRevisions(
    runId: string,
    taskId?: TaskId,
  ): Promise<StoredPlanRevision[]> {
    const rows =
      taskId === undefined
        ? await this.rows(
            `SELECT * FROM task_plan_revisions
             WHERE run_id = $1 ORDER BY task_id, revision`,
            [runId],
          )
        : await this.rows(
            `SELECT * FROM task_plan_revisions
             WHERE run_id = $1 AND task_id = $2 ORDER BY revision`,
            [runId, taskId],
          );
    return rows.map((row) => this.toPlanRevision(row));
  }

  public async saveScopeChange(
    runId: string,
    request: ScopeChangeRequest,
  ): Promise<void> {
    await this.query(
      `INSERT INTO scope_changes
         (id, run_id, task_id, request_json, requested_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        request.id,
        runId,
        request.taskId,
        JSON.stringify(request),
        request.occurredAt,
      ],
    );
  }

  public async saveScopeChangeDecision(
    runId: string,
    decision: ScopeChangeDecision,
  ): Promise<void> {
    const updated = await this.query(
      `UPDATE scope_changes
       SET decision_json = $1, decided_at = $2
       WHERE id = $3 AND run_id = $4 AND decision_json IS NULL`,
      [JSON.stringify(decision), decision.decidedAt, decision.requestId, runId],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new Error(
        `Scope-change request ${decision.requestId} is unknown or already decided`,
      );
    }
  }

  public async listScopeChanges(runId: string): Promise<StoredScopeChange[]> {
    const rows = await this.rows(
      `SELECT * FROM scope_changes
       WHERE run_id = $1 ORDER BY requested_at, seq`,
      [runId],
    );
    return rows.map((row) => ({
      runId,
      request: parseJson<ScopeChangeRequest>(row, "request_json"),
      decision: optionalJson<ScopeChangeDecision>(row, "decision_json"),
    }));
  }

  public async saveSession(
    runId: string,
    session: SessionRecord,
  ): Promise<void> {
    const updated = await this.query(
      `UPDATE tasks SET session_id = $1, session_started_at = $2
       WHERE run_id = $3 AND id = $4`,
      [session.id, session.startedAt, runId, session.taskId],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new Error(`Unknown task ${session.taskId} in run ${runId}`);
    }
  }

  public async saveDecision(
    runId: string,
    decision: CoordinatorDecision,
  ): Promise<void> {
    const updated = await this.query(
      "UPDATE tasks SET decision_json = $1 WHERE run_id = $2 AND id = $3",
      [JSON.stringify(decision), runId, decision.taskId],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new Error(`Unknown task ${decision.taskId} in run ${runId}`);
    }
  }

  public async saveTaskStatus(
    runId: string,
    taskId: TaskId,
    status: TaskStatus,
    explanation?: string,
  ): Promise<void> {
    const updated = await this.query(
      "UPDATE tasks SET status = $1, explanation = $2 WHERE run_id = $3 AND id = $4",
      [status, explanation ?? null, runId, taskId],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new Error(`Unknown task ${taskId} in run ${runId}`);
    }
  }

  public async saveConflicts(
    runId: string,
    assessments: readonly ConflictAssessment[],
  ): Promise<void> {
    for (const assessment of assessments) {
      await this.query(
        `INSERT INTO conflicts
           (run_id, first_task_id, second_task_id, score, disposition, evidence_json, explanation)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          runId,
          assessment.taskIds[0],
          assessment.taskIds[1],
          assessment.score,
          assessment.disposition,
          JSON.stringify(assessment.evidence),
          assessment.explanation,
        ],
      );
    }
  }

  public async saveLeases(
    runId: string,
    leases: readonly ResourceLease[],
  ): Promise<void> {
    for (const lease of leases) {
      await this.query(
        `INSERT INTO resource_leases
           (lease_id, run_id, task_id, resource_type, resource_id, principal_id, mode, base_version, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (lease_id) DO NOTHING`,
        [
          lease.leaseId,
          runId,
          lease.taskId,
          lease.resourceType,
          lease.resourceId,
          lease.principalId,
          lease.mode,
          lease.baseVersion,
          lease.expiresAt,
        ],
      );
    }
  }

  public async releaseLeases(runId: string, taskId: TaskId): Promise<void> {
    await this.query(
      `UPDATE resource_leases SET released_at = $1
       WHERE run_id = $2 AND task_id = $3 AND released_at IS NULL`,
      [new Date().toISOString(), runId, taskId],
    );
  }

  public async saveWorkspace(
    runId: string,
    workspace: StoredWorkspace,
  ): Promise<void> {
    await this.query(
      `INSERT INTO workspaces (id, run_id, task_id, path, isolation, base_revision, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        workspace.id,
        runId,
        workspace.taskId,
        workspace.path,
        workspace.isolation,
        workspace.baseRevision,
        workspace.createdAt,
      ],
    );
  }

  public async findWorkspaceByTaskId(
    taskId: TaskId,
  ): Promise<StoredWorkspace | undefined> {
    const row = await this.row(
      `SELECT id, run_id, task_id, path, isolation, base_revision, created_at
       FROM workspaces
       WHERE task_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [taskId],
    );
    if (row === undefined) {
      return undefined;
    }
    return {
      id: text(row, "id"),
      runId: text(row, "run_id"),
      taskId: text(row, "task_id"),
      path: text(row, "path"),
      isolation: text(row, "isolation"),
      baseRevision: text(row, "base_revision"),
      createdAt: text(row, "created_at"),
    };
  }

  public async saveChangeSet(
    runId: string,
    changeSet: ChangeSet,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO changesets
           (id, run_id, task_id, base_version, base_revision, symbols_changed_json,
            dependencies_changed_json, risk_level, risk_reasons_json, agent_explanation,
            commands_run_json, tests_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO NOTHING`,
        [
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
        ],
      );

      if ((inserted.rowCount ?? 0) > 0) {
        for (const [ordinal, patch] of changeSet.patches.entries()) {
          await client.query(
            `INSERT INTO file_patches (changeset_id, ordinal, path, status, patch)
             VALUES ($1, $2, $3, $4, $5)`,
            [changeSet.id, ordinal, patch.path, patch.status, patch.patch],
          );
        }
      }
    });
  }

  public async addChangesetComment(
    input: AddChangesetCommentInput,
  ): Promise<ChangesetComment> {
    const body = input.body.trim();
    if (body.length === 0) {
      throw new Error("A comment must have a body");
    }
    const changeSet = await this.row(
      "SELECT id FROM changesets WHERE id = $1 AND run_id = $2",
      [input.changeSetId, input.runId],
    );
    if (changeSet === undefined) {
      throw new Error(`Unknown changeset: ${input.changeSetId}`);
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
    await this.query(
      `INSERT INTO changeset_comments
         (id, run_id, change_set_id, task_id, file_path, author_id, body, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        comment.id,
        comment.runId,
        comment.changeSetId,
        comment.taskId,
        comment.filePath ?? null,
        comment.authorId,
        comment.body,
        comment.createdAt,
      ],
    );
    return comment;
  }

  public async listChangesetComments(
    filter: { runId?: string; changeSetId?: string; resolved?: boolean } = {},
  ): Promise<ChangesetComment[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.runId !== undefined) {
      clauses.push(`run_id = ${bind(values, filter.runId)}`);
    }
    if (filter.changeSetId !== undefined) {
      clauses.push(`change_set_id = ${bind(values, filter.changeSetId)}`);
    }
    if (filter.resolved !== undefined) {
      clauses.push(
        filter.resolved ? "resolved_at IS NOT NULL" : "resolved_at IS NULL",
      );
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = await this.rows(
      `SELECT * FROM changeset_comments${where} ORDER BY created_at, id`,
      values,
    );
    return rows.map((row) => this.toComment(row));
  }

  public async getChangesetComment(
    id: string,
  ): Promise<ChangesetComment | undefined> {
    const row = await this.row(
      "SELECT * FROM changeset_comments WHERE id = $1",
      [id],
    );
    return row === undefined ? undefined : this.toComment(row);
  }

  public async resolveChangesetComment(
    id: string,
    resolvedBy: string,
    at: string,
  ): Promise<ChangesetComment> {
    // Guarded on resolved_at so resolving twice keeps the first reviewer's
    // name rather than quietly reassigning the remark to whoever clicked last.
    await this.query(
      `UPDATE changeset_comments SET resolved_at = $1, resolved_by = $2
       WHERE id = $3 AND resolved_at IS NULL`,
      [at, resolvedBy, id],
    );
    const comment = await this.getChangesetComment(id);
    if (comment === undefined) {
      throw new Error(`Unknown comment: ${id}`);
    }
    return comment;
  }

  private toComment(row: Row): ChangesetComment {
    return {
      id: text(row, "id"),
      runId: text(row, "run_id"),
      changeSetId: text(row, "change_set_id"),
      taskId: text(row, "task_id"),
      filePath: optionalText(row, "file_path"),
      authorId: text(row, "author_id"),
      body: text(row, "body"),
      createdAt: text(row, "created_at"),
      resolvedAt: optionalText(row, "resolved_at"),
      resolvedBy: optionalText(row, "resolved_by"),
    };
  }

  public async recentlyTouchedFiles(input: {
    repositoryId: string;
    conversationId?: string;
    limit?: number;
  }): Promise<TouchedFileSample[]> {
    const limit = input.limit ?? 400;
    if (input.conversationId !== undefined) {
      const scope: unknown[] = [];
      const found = (await this.rows(
        `SELECT channel_id FROM channel_messages
          WHERE id = ${bind(scope, input.conversationId)}`,
        scope,
      )) as { channel_id?: string }[];
      const channelId = found[0]?.channel_id;
      if (channelId !== undefined) {
        const scoped: unknown[] = [];
        const rows = (await this.rows(
          `SELECT file_patches.path AS path, changesets.created_at AS at
             FROM file_patches
             JOIN changesets ON changesets.id = file_patches.changeset_id
             JOIN runs ON runs.id = changesets.run_id
             JOIN integrations ON integrations.changeset_id = changesets.id
              AND integrations.status = 'integrated'
             JOIN submitted_tasks ON submitted_tasks.id = changesets.task_id
             JOIN channel_messages
               ON channel_messages.id = submitted_tasks.conversation_id
            WHERE runs.repository_id = ${bind(scoped, input.repositoryId)}
              AND channel_messages.channel_id = ${bind(scoped, channelId)}
            ORDER BY changesets.created_at DESC, file_patches.ordinal ASC
            LIMIT ${bind(scoped, Math.max(0, limit))}`,
          scoped,
        )) as { path: string; at: string }[];
        if (rows.length >= CHANNEL_TOUCH_FLOOR) {
          return rows.map((row) => ({ path: row.path, at: row.at }));
        }
      }
    }
    const values: unknown[] = [];
    // Joined through `integrations` rather than reading every changeset: a
    // changeset that never landed is often one that touched the wrong thing.
    const rows = (await this.rows(
      `SELECT file_patches.path AS path, changesets.created_at AS at
         FROM file_patches
         JOIN changesets ON changesets.id = file_patches.changeset_id
         JOIN runs ON runs.id = changesets.run_id
         JOIN integrations ON integrations.changeset_id = changesets.id
          AND integrations.status = 'integrated'
        WHERE runs.repository_id = ${bind(values, input.repositoryId)}
        ORDER BY changesets.created_at DESC, file_patches.ordinal ASC
        LIMIT ${bind(values, Math.max(0, limit))}`,
      values,
    )) as { path: string; at: string }[];
    return rows.map((row) => ({ path: row.path, at: row.at }));
  }

  public async saveIntegration(
    runId: string,
    result: IntegrationResult,
  ): Promise<void> {
    // Bounded on the way in, not on the way out. The control plane is handed
    // this by a remote worker, so the size of a row here is decided by how
    // noisy somebody else's test runner is — and nothing reads the text
    // anyway. See `boundValidation`.
    const validation = boundValidation(result.validation);
    await this.query(
      `INSERT INTO integrations
         (run_id, task_id, changeset_id, status,
          previous_sequence, previous_revision, previous_branch, previous_created_at,
          canonical_sequence, canonical_revision, canonical_branch, canonical_created_at,
          candidate_revision, validation_json, cleanup_warnings_json, explanation, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
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
        JSON.stringify(validation),
        JSON.stringify(result.cleanupWarnings ?? []),
        result.explanation,
        new Date().toISOString(),
      ],
    );
  }

  public async saveCanonicalVersion(
    repositoryId: string,
    version: CanonicalVersion,
  ): Promise<void> {
    await this.query(
      `INSERT INTO canonical_versions
         (repository_id, revision, sequence, branch, created_at, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (repository_id, revision) DO NOTHING`,
      [
        repositoryId,
        version.revision,
        version.sequence,
        version.branch,
        version.createdAt,
        new Date().toISOString(),
      ],
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

    await this.transaction(
      async (client) => {
        const previous = (
          await client.query(
            "SELECT chain_hash FROM audit_events ORDER BY sequence DESC LIMIT 1",
          )
        ).rows[0] as Row | undefined;
        // Falls back to the newest checkpoint when the live log is empty,
        // which is what archiving everything leaves behind; reading GENESIS
        // there would silently fork the chain.
        const checkpoint =
          previous !== undefined
            ? undefined
            : ((
                await client.query(
                  `SELECT chain_hash FROM audit_checkpoints
                   ORDER BY through_sequence DESC LIMIT 1`,
                )
              ).rows[0] as Row | undefined);
        const previousHash =
          previous !== undefined
            ? text(previous, "chain_hash")
            : checkpoint !== undefined
              ? text(checkpoint, "chain_hash")
              : GENESIS_HASH;
        const payloadHash = hashAuditPayload(event);

        await client.query(
          `INSERT INTO audit_events
             (id, run_id, task_id, type, data_json, occurred_at, payload_hash, previous_hash, chain_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            event.id,
            runId ?? null,
            event.taskId ?? null,
            event.type,
            JSON.stringify(event.data),
            event.occurredAt,
            payloadHash,
            previousHash,
            chainHash(previousHash, payloadHash),
          ],
        );
      },
      { serialize: true },
    );

    return event;
  }

  public async listAuditEvents(
    filter: AuditEventFilter = {},
  ): Promise<SequencedAuditEvent[]> {
    return await this.selectAuditEvents("audit_events", filter);
  }

  public async listArchivedAuditEvents(
    filter: AuditEventFilter = {},
  ): Promise<SequencedAuditEvent[]> {
    return await this.selectAuditEvents("audit_archive", filter);
  }

  /**
   * The live log and the archive have identical shapes, so one query serves
   * both and a filter can never mean two different things depending on which
   * side of a checkpoint an event happens to sit.
   */
  private async selectAuditEvents(
    table: "audit_events" | "audit_archive",
    filter: AuditEventFilter,
  ): Promise<SequencedAuditEvent[]> {
    const afterSequence = filter.afterSequence ?? 0;
    const limit = filter.limit ?? 500;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError("Audit cursor must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new RangeError("Audit event limit must be between 1 and 5000");
    }
    const values: unknown[] = [];
    const clauses = [`sequence > ${bind(values, afterSequence)}`];
    if (filter.runId !== undefined) {
      clauses.push(`run_id = ${bind(values, filter.runId)}`);
    }
    if (filter.taskId !== undefined) {
      clauses.push(`task_id = ${bind(values, filter.taskId)}`);
    }
    if (filter.projectId !== undefined) {
      // Stamped inside the event payload when the writer knew it, and carried
      // by the run it was written under when it did not. The coordinator
      // stamps only four of its forty-six traces, and every `task_failed` is
      // among the forty-two that do not — so a payload-only test discarded
      // every failure, every reported task and every restart before the
      // metrics ever saw them, and the dashboard read them as zero.
      //
      // The whole disjunction is parenthesized. This list is joined with AND
      // and OR binds looser, so a bare `a = $n OR ...` would split the WHERE
      // into two arms and let each half bypass the other half's filters —
      // including `sequence >`, whose loss makes the metrics pager loop
      // forever on the same page.
      const project = bind(values, filter.projectId);
      clauses.push(
        `((data_json::jsonb ->> 'projectId') = ${project}
          OR run_id IN (SELECT id FROM runs WHERE project_id = ${project}))`,
      );
    }
    if (filter.types !== undefined) {
      if (filter.types.length === 0) {
        return [];
      }
      clauses.push(
        `type IN (${filter.types
          .map((type) => bind(values, type))
          .join(", ")})`,
      );
    }
    if (filter.occurredAfter !== undefined) {
      clauses.push(`occurred_at >= ${bind(values, filter.occurredAfter)}`);
    }
    if (filter.occurredBefore !== undefined) {
      clauses.push(`occurred_at < ${bind(values, filter.occurredBefore)}`);
    }
    const rows = await this.rows(
      `SELECT * FROM ${table} WHERE ${clauses.join(" AND ")}
       ORDER BY sequence LIMIT ${bind(values, limit)}`,
      values,
    );
    return rows.map((row) => {
      const eventRunId = optionalText(row, "run_id");
      return {
        sequence: integer(row, "sequence"),
        ...(eventRunId === undefined ? {} : { runId: eventRunId }),
        event: this.toAuditEvent(row),
      };
    });
  }

  private toChainedAuditEvent(row: Row): ChainedAuditEvent {
    return {
      event: this.toAuditEvent(row),
      sequence: integer(row, "sequence"),
      payloadHash: text(row, "payload_hash"),
      previousHash: text(row, "previous_hash"),
      chainHash: text(row, "chain_hash"),
    };
  }

  private toCheckpoint(row: Row): AuditCheckpoint {
    return {
      id: text(row, "id"),
      throughSequence: integer(row, "through_sequence"),
      chainHash: text(row, "chain_hash"),
      segmentDigest: text(row, "segment_digest"),
      events: integer(row, "events"),
      createdAt: text(row, "created_at"),
    };
  }

  public async listAuditCheckpoints(): Promise<AuditCheckpoint[]> {
    const rows = await this.rows(
      "SELECT * FROM audit_checkpoints ORDER BY through_sequence",
    );
    return rows.map((row) => this.toCheckpoint(row));
  }

  public async archiveAuditEvents(
    input: ArchiveAuditInput,
  ): Promise<AuditArchiveResult | undefined> {
    // Verified before the lock is taken: archiving a chain that is already
    // broken would fold the break into a checkpoint and make it look settled.
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

    return await this.transaction(
      async (client): Promise<AuditArchiveResult | undefined> => {
        const values: unknown[] = [];
        const clauses: string[] = [];
        if (input.throughSequence !== undefined) {
          clauses.push(`sequence <= ${bind(values, input.throughSequence)}`);
        }
        if (input.before !== undefined) {
          clauses.push(`occurred_at < ${bind(values, input.before)}`);
        }
        const rows = (
          await client.query(
            `SELECT * FROM audit_events WHERE ${clauses.join(" AND ")}
             ORDER BY sequence`,
            values,
          )
        ).rows as Row[];
        if (rows.length === 0) {
          return undefined;
        }

        const entries = rows.map((row) => this.toChainedAuditEvent(row));
        const last = entries.at(-1);
        if (last === undefined) {
          return undefined;
        }
        // A time bound can only cut where the sequence does, or the archive
        // would be a set of holes rather than a prefix and nothing would link.
        const total = (
          await client.query(
            "SELECT COUNT(*) AS n FROM audit_events WHERE sequence <= $1",
            [last.sequence],
          )
        ).rows[0] as Row;
        if (Number(integer(total, "n")) !== entries.length) {
          throw new Error(
            "Archiving must cover an unbroken prefix of the chain; the " +
              "requested boundary would leave earlier events behind",
          );
        }

        const checkpoint: AuditCheckpoint = {
          id: createId("checkpoint"),
          throughSequence: last.sequence,
          chainHash: last.chainHash,
          segmentDigest: segmentDigest(
            entries.map((entry) => entry.payloadHash),
          ),
          events: entries.length,
          createdAt: new Date().toISOString(),
        };
        await client.query(
          `INSERT INTO audit_checkpoints
             (id, through_sequence, chain_hash, segment_digest, events, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            checkpoint.id,
            checkpoint.throughSequence,
            checkpoint.chainHash,
            checkpoint.segmentDigest,
            checkpoint.events,
            checkpoint.createdAt,
          ],
        );
        for (const row of rows) {
          await client.query(
            `INSERT INTO audit_archive
               (sequence, id, checkpoint_id, run_id, task_id, type, data_json,
                occurred_at, payload_hash, previous_hash, chain_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              integer(row, "sequence"),
              text(row, "id"),
              checkpoint.id,
              optionalText(row, "run_id") ?? null,
              optionalText(row, "task_id") ?? null,
              text(row, "type"),
              text(row, "data_json"),
              text(row, "occurred_at"),
              text(row, "payload_hash"),
              text(row, "previous_hash"),
              text(row, "chain_hash"),
            ],
          );
        }
        // The prune guard permits this only because the checkpoint above now
        // covers every sequence being removed.
        await client.query("DELETE FROM audit_events WHERE sequence <= $1", [
          checkpoint.throughSequence,
        ]);

        return {
          checkpoint,
          events: rows.map((row) => {
            const eventRunId = optionalText(row, "run_id");
            return {
              sequence: integer(row, "sequence"),
              ...(eventRunId === undefined ? {} : { runId: eventRunId }),
              event: this.toAuditEvent(row),
            };
          }),
        };
      },
      { serialize: true },
    );
  }

  public async pruneArchivedAuditEvents(
    throughSequence: number,
  ): Promise<number> {
    const covered = await this.row(
      "SELECT COUNT(*) AS n FROM audit_checkpoints WHERE through_sequence <= $1",
      [throughSequence],
    );
    if (covered === undefined || integer(covered, "n") === 0) {
      throw new Error(
        "Archived events can only be pruned up to a recorded checkpoint",
      );
    }
    // Whole segments only. Half a segment would no longer reproduce its
    // checkpoint digest, and verification would report the operator's own
    // housekeeping as tampering.
    const removed = await this.query(
      `DELETE FROM audit_archive WHERE checkpoint_id IN (
         SELECT id FROM audit_checkpoints WHERE through_sequence <= $1
       )`,
      [throughSequence],
    );
    return removed.rowCount ?? 0;
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
    await this.query(
      `INSERT INTO approvals
         (id, organization_id, project_id, repository_id, run_id, task_id,
          kind, status, requested_by, required_role, reasons_json,
          changeset_id, scope_change_id, requested_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
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
      ],
    );
    return approval;
  }

  public async getApproval(id: string): Promise<ApprovalRequest | undefined> {
    const row = await this.row("SELECT * FROM approvals WHERE id = $1", [id]);
    return row === undefined ? undefined : this.toApproval(row);
  }

  public async listApprovals(
    filter: ApprovalFilter = {},
  ): Promise<ApprovalRequest[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of [
      ["organization_id", filter.organizationId],
      ["project_id", filter.projectId],
      ["repository_id", filter.repositoryId],
      ["run_id", filter.runId],
      ["task_id", filter.taskId],
      ["status", filter.status],
    ] as const) {
      if (value !== undefined) {
        clauses.push(`${column} = ${bind(values, value)}`);
      }
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = await this.rows(
      `SELECT * FROM approvals${where}
       ORDER BY requested_at DESC, seq DESC`,
      values,
    );
    return rows.map((row) => this.toApproval(row));
  }

  public async decideApproval(
    decision: ApprovalDecision,
  ): Promise<ApprovalRequest> {
    const updated = await this.query(
      `UPDATE approvals
       SET status = $1, decided_at = $2, decided_by = $3, decision_comment = $4
       WHERE id = $5 AND status = 'pending'`,
      [
        decision.status,
        decision.decidedAt,
        decision.decidedBy,
        decision.comment,
        decision.approvalId,
      ],
    );
    if ((updated.rowCount ?? 0) === 0) {
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
      throw new Error(
        `Approval disappeared after decision: ${decision.approvalId}`,
      );
    }
    return approval;
  }

  public async expireApprovals(now: string): Promise<number> {
    const result = await this.query(
      `UPDATE approvals
       SET status = 'expired', decided_at = $1
       WHERE status = 'pending' AND expires_at <= $1`,
      [now],
    );
    return result.rowCount ?? 0;
  }

  public async listRuns(limit = 50): Promise<StoredRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("Run list limit must be a positive safe integer");
    }
    const rows = await this.rows(
      "SELECT * FROM runs ORDER BY started_at DESC, seq DESC LIMIT $1",
      [limit],
    );
    return rows.map((row) => this.toRun(row));
  }

  public async getRun(runId: string): Promise<RunDetail | undefined> {
    const row = await this.row("SELECT * FROM runs WHERE id = $1", [runId]);
    if (row === undefined) {
      return undefined;
    }

    return {
      run: this.toRun(row),
      tasks: await this.tasksFor(runId),
      conflicts: await this.conflictsFor(runId),
      changeSets: await this.changeSetsFor(runId),
      integrations: await this.integrationsFor(runId),
      leases: await this.leasesFor(runId),
      workspaces: await this.workspacesFor(runId),
      planRevisions: await this.listPlanRevisions(runId),
      scopeChanges: await this.listScopeChanges(runId),
      approvals: await this.listApprovals({ runId }),
      comments: await this.listChangesetComments({ runId }),
      audit: await this.listAudit(runId),
    };
  }

  public async listAudit(runId?: string): Promise<AuditEvent[]> {
    const rows =
      runId === undefined
        ? await this.rows("SELECT * FROM audit_events ORDER BY sequence")
        : await this.rows(
            "SELECT * FROM audit_events WHERE run_id = $1 ORDER BY sequence",
            [runId],
          );
    return rows.map((entry) => this.toAuditEvent(entry));
  }

  public async verifyAudit(): Promise<AuditChainVerification> {
    const checkpoints = await this.listAuditCheckpoints();
    const segments: ArchivedSegment[] = [];
    for (const checkpoint of checkpoints) {
      const archived = await this.rows(
        "SELECT * FROM audit_archive WHERE checkpoint_id = $1 ORDER BY sequence",
        [checkpoint.id],
      );
      segments.push({
        checkpoint,
        ...(archived.length === 0
          ? {}
          : { entries: archived.map((row) => this.toChainedAuditEvent(row)) }),
      });
    }
    const rows = await this.rows(
      "SELECT * FROM audit_events ORDER BY sequence",
    );
    return verifyArchivedChain(
      segments,
      rows.map((row) => this.toChainedAuditEvent(row)),
    );
  }

  public async listChannelMessages(
    repositoryId: string,
    viewerId: string,
    filter: ChannelMessageFilter = {},
  ): Promise<ChannelMessage[]> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const values: unknown[] = [];
    const clauses = [`repository_id = ${bind(values, repositoryId)}`];
    if (filter.channelId !== undefined) {
      clauses.push(
        `COALESCE(channel_id, ${bind(values, generalChannelId(repositoryId))}) = ${bind(values, filter.channelId)}`,
      );
    }
    if (filter.before !== undefined) {
      clauses.push(
        `COALESCE(bumped_at, created_at) < ${bind(values, filter.before)}`,
      );
    }
    // Position, not time — see `bumpChannelMessage`. The cursor above pages
    // on the same expression so it agrees with the order it is paging.
    const rows = await this.rows(
      `SELECT * FROM channel_messages WHERE ${clauses.join(" AND ")}
       ORDER BY COALESCE(bumped_at, created_at) DESC, id DESC
       LIMIT ${bind(values, limit)}`,
      values,
    );
    const bases = rows.reverse().map((row) => this.toChannelMessageBase(row));
    return await this.hydrateChannelMessages(bases, viewerId);
  }

  public async countChannelMessages(
    repositoryId: string,
    channelId?: string,
  ): Promise<ChannelMessageCounts> {
    // Two counts rather than a join: a LEFT JOIN would have to count DISTINCT
    // roots to avoid multiplying them by their own replies, and this reads as
    // what it is. Both int8 results are parsed to numbers by `queryTypes`.
    const scope = [generalChannelId(repositoryId), channelId ?? null];
    const scopeSql =
      " AND ($3::text IS NULL OR COALESCE(channel_id, $2) = $3)";
    const roots = await this.row(
      `SELECT COUNT(*) AS total FROM channel_messages
        WHERE repository_id = $1${scopeSql}`,
      [repositoryId, ...scope],
    );
    const replies = await this.row(
      `SELECT COUNT(*) AS total FROM channel_message_replies
        WHERE message_id IN (
          SELECT id FROM channel_messages
           WHERE repository_id = $1${scopeSql}
        )`,
      [repositoryId, ...scope],
    );
    return {
      messages: roots === undefined ? 0 : integer(roots, "total"),
      replies: replies === undefined ? 0 : integer(replies, "total"),
    };
  }

  public async bumpChannelMessage(
    repositoryId: string,
    messageId: string,
    at: string,
  ): Promise<void> {
    await this.query(
      `UPDATE channel_messages SET bumped_at = $1
        WHERE repository_id = $2 AND id = $3`,
      [at, repositoryId, messageId],
    );
  }

  public async deleteChannelMessage(
    repositoryId: string,
    messageId: string,
  ): Promise<void> {
    await this.transaction(async (client) => {
      // Reactions reference replies as well as the message itself, so they
      // go before the rows they point at.
      await client.query(
        `DELETE FROM channel_message_reactions
          WHERE message_id = $1
             OR message_id IN (
               SELECT id FROM channel_message_replies WHERE message_id = $1
             )`,
        [messageId],
      );
      await client.query(
        "DELETE FROM channel_message_replies WHERE message_id = $1",
        [messageId],
      );
      await client.query(
        "DELETE FROM channel_messages WHERE repository_id = $1 AND id = $2",
        [repositoryId, messageId],
      );
    });
  }

  public async redactChannelMessage(
    repositoryId: string,
    messageId: string,
    input: { deletedAt: string; deletedBy: string },
  ): Promise<void> {
    await this.transaction(async (client) => {
      // `deleted_at IS NULL` so a second pass cannot restamp who unsaid it.
      const result = await client.query(
        // The pin goes with the words: a banner pointing at a tombstone is
        // worse than no banner.
        `UPDATE channel_messages
           SET content = '', deleted_at = $1, deleted_by = $2,
               pinned_at = NULL, pinned_by = NULL
         WHERE repository_id = $3 AND id = $4 AND deleted_at IS NULL`,
        [input.deletedAt, input.deletedBy, repositoryId, messageId],
      );
      if ((result.rowCount ?? 0) > 0) {
        // Reactions were agreement with a line that is no longer there.
        await client.query(
          "DELETE FROM channel_message_reactions WHERE message_id = $1",
          [messageId],
        );
      }
    });
  }

  public async deleteChannelReply(
    repositoryId: string,
    messageId: string,
    replyId: string,
  ): Promise<ChannelReply | undefined> {
    return await this.transaction(async (client) => {
      const found = await client.query(
        `SELECT r.* FROM channel_message_replies r
           JOIN channel_messages m ON m.id = r.message_id
         WHERE r.id = $1 AND r.message_id = $2 AND m.repository_id = $3`,
        [replyId, messageId, repositoryId],
      );
      const row = found.rows[0] as Row | undefined;
      if (row === undefined) {
        return undefined;
      }
      await client.query(
        "DELETE FROM channel_message_reactions WHERE message_id = $1",
        [replyId],
      );
      await client.query(
        `UPDATE channel_message_replies SET referenced_message_id = NULL
         WHERE message_id = $1 AND referenced_message_id = $2`,
        [messageId, replyId],
      );
      await client.query("DELETE FROM channel_message_replies WHERE id = $1", [
        replyId,
      ]);
      return this.toChannelReply(row);
    });
  }

  public async deleteChannelMessages(
    repositoryId: string,
    channelId?: string,
  ): Promise<number> {
    const scope = [generalChannelId(repositoryId), channelId ?? null];
    const scopeSql = " AND ($3::text IS NULL OR COALESCE(channel_id, $2) = $3)";
    return await this.transaction(async (client) => {
      const ids = (
        await client.query(
          `SELECT id FROM channel_messages
            WHERE repository_id = $1${scopeSql}`,
          [repositoryId, ...scope],
        )
      ).rows.map((row) => String((row as Row)["id"]));
      for (const id of ids) {
        await client.query(
          `DELETE FROM channel_message_reactions
            WHERE message_id = $1
               OR message_id IN (
                 SELECT id FROM channel_message_replies WHERE message_id = $1
               )`,
          [id],
        );
        await client.query(
          "DELETE FROM channel_message_replies WHERE message_id = $1",
          [id],
        );
      }
      await client.query(
        `DELETE FROM channel_messages WHERE repository_id = $1${scopeSql}`,
        [repositoryId, ...scope],
      );
      return ids.length;
    });
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
      const target = await this.row(
        "SELECT repository_id, channel_id FROM channel_messages WHERE id = $1",
        [input.referencedMessageId],
      );
      if (
        target === undefined ||
        text(target, "repository_id") !== input.repositoryId
      ) {
        throw new Error(
          "A channel message reference must target the same repository",
        );
      }
      referencedChannelId = optionalText(target, "channel_id");
    }
    // An answer belongs in the room the question was asked in, so a writer
    // that names no channel inherits the referenced message's before it falls
    // back to `#general`.
    const channelId =
      input.channelId ??
      referencedChannelId ??
      (await this.ensureGeneralSubChannel(input.repositoryId, input.projectId))
        .id;
    const message = {
      id: createId("chanmsg"),
      repositoryId: input.repositoryId,
      channelId,
      projectId: input.projectId,
      kind: input.kind ?? "user",
      authorId: input.authorId,
      content,
      createdAt: new Date().toISOString(),
    };
    await this.query(
      `INSERT INTO channel_messages
         (id, repository_id, channel_id, project_id, kind, author_id, content,
          created_at, task_id, referenced_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        message.id,
        message.repositoryId,
        message.channelId,
        message.projectId,
        message.kind,
        message.authorId,
        message.content,
        message.createdAt,
        input.taskId ?? null,
        input.referencedMessageId ?? null,
      ],
    );
    return {
      ...message,
      replies: [],
      reactions: {},
      taskId: input.taskId,
      ...(input.referencedMessageId === undefined
        ? {}
        : { referencedMessageId: input.referencedMessageId }),
      changedFiles: undefined,
      pinnedAt: undefined,
      pinnedBy: undefined,
      endedAt: undefined,
    };
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
      const target = await this.query(
        `SELECT id FROM direct_messages
         WHERE id = $1 AND project_id = $2 AND pair_key = $3`,
        [
          input.referencedMessageId,
          input.projectId,
          directPairKey(input.authorId, input.recipientId),
        ],
      );
      if (target.rows.length === 0) {
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
    await this.query(
      `INSERT INTO direct_messages
         (id, project_id, pair_key, author_id, recipient_id, content,
          created_at, read_at, referenced_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)`,
      [
        message.id,
        message.projectId,
        directPairKey(message.authorId, message.recipientId),
        message.authorId,
        message.recipientId,
        message.content,
        message.createdAt,
        message.referencedMessageId ?? null,
      ],
    );
    return message;
  }

  public async updateDirectMessage(
    projectId: ProjectId,
    messageId: string,
    authorId: string,
    content: string,
  ): Promise<DirectMessage | undefined> {
    const updated = content.trim();
    if (updated.length === 0) {
      return undefined;
    }
    const rows = (
      await this.query(
        `UPDATE direct_messages SET content = $1
         WHERE id = $2 AND project_id = $3 AND author_id = $4
         RETURNING *`,
        [updated, messageId, projectId, authorId],
      )
    ).rows as Row[];
    const row = rows[0];
    return row === undefined ? undefined : this.toDirectMessage(row);
  }

  public async deleteDirectMessage(
    projectId: ProjectId,
    messageId: string,
    authorId: string,
  ): Promise<DirectMessage | undefined> {
    const rows = (
      await this.query(
        `DELETE FROM direct_messages
         WHERE id = $1 AND project_id = $2 AND author_id = $3
         RETURNING *`,
        [messageId, projectId, authorId],
      )
    ).rows as Row[];
    const row = rows[0];
    return row === undefined ? undefined : this.toDirectMessage(row);
  }

  public async listDirectMessages(
    projectId: ProjectId,
    viewerId: string,
    otherId: string,
    filter: DirectMessageFilter = {},
  ): Promise<DirectMessage[]> {
    const conditions = ["project_id = $1", "pair_key = $2"];
    const values: unknown[] = [projectId, directPairKey(viewerId, otherId)];
    if (filter.before !== undefined) {
      values.push(filter.before);
      conditions.push(`created_at < $${values.length}`);
    }
    // Newest first with a limit, then reversed — see the SQLite store: the
    // page a conversation wants is the most recent N.
    values.push(filter.limit ?? null);
    const result = await this.query(
      `SELECT * FROM direct_messages
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.reverse().map((row) => this.toDirectMessage(row));
  }

  public async listDirectConversations(
    projectId: ProjectId,
    viewerId: string,
  ): Promise<DirectConversation[]> {
    const result = await this.query(
      `SELECT * FROM direct_messages
       WHERE project_id = $1 AND (author_id = $2 OR recipient_id = $2)
       ORDER BY created_at ASC, id ASC`,
      [projectId, viewerId],
    );
    const byCorrespondent = new Map<string, DirectConversation>();
    for (const row of result.rows) {
      const message = this.toDirectMessage(row);
      const other =
        message.authorId === viewerId ? message.recipientId : message.authorId;
      const unread =
        (byCorrespondent.get(other)?.unread ?? 0) +
        (message.recipientId === viewerId && message.readAt === undefined
          ? 1
          : 0);
      byCorrespondent.set(other, {
        userId: other,
        lastMessage: message,
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
    const result = await this.query(
      `UPDATE direct_messages SET read_at = $1
       WHERE project_id = $2 AND recipient_id = $3 AND author_id = $4
         AND read_at IS NULL`,
      [at, projectId, viewerId, otherId],
    );
    return result.rowCount ?? 0;
  }

  private toDirectMessage(row: Row): DirectMessage {
    const readAt = optionalText(row, "read_at");
    const referencedMessageId = optionalText(row, "referenced_message_id");
    return {
      id: text(row, "id"),
      projectId: text(row, "project_id"),
      authorId: text(row, "author_id"),
      recipientId: text(row, "recipient_id"),
      content: text(row, "content"),
      createdAt: text(row, "created_at"),
      ...(readAt === undefined ? {} : { readAt }),
      ...(referencedMessageId === undefined ? {} : { referencedMessageId }),
    };
  }

  public async addChannelReply(
    input: AddChannelReplyInput,
  ): Promise<ChannelReply> {
    const owner = await this.row(
      "SELECT id FROM channel_messages WHERE id = $1 AND repository_id = $2",
      [input.messageId, input.repositoryId],
    );
    if (owner === undefined) {
      throw new Error(`Unknown channel message: ${input.messageId}`);
    }
    const content = input.content.trim();
    if (content.length === 0) {
      throw new Error("A reply must have content");
    }
    if (input.referencedMessageId !== undefined) {
      const targetIsRoot = input.referencedMessageId === input.messageId;
      const targetIsReply = await this.row(
        "SELECT 1 FROM channel_message_replies WHERE id = $1 AND message_id = $2",
        [input.referencedMessageId, input.messageId],
      );
      if (!targetIsRoot && targetIsReply === undefined) {
        throw new Error("A reply reference must target the same thread");
      }
    }
    const reply: ChannelReply = {
      id: createId("chanreply"),
      messageId: input.messageId,
      kind: input.kind ?? "user",
      authorId: input.authorId,
      content,
      createdAt: new Date().toISOString(),
      ...(input.referencedMessageId === undefined
        ? {}
        : { referencedMessageId: input.referencedMessageId }),
    };
    await this.query(
      `INSERT INTO channel_message_replies
         (id, message_id, kind, author_id, content, created_at,
          referenced_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        reply.id,
        reply.messageId,
        reply.kind,
        reply.authorId,
        reply.content,
        reply.createdAt,
        reply.referencedMessageId ?? null,
      ],
    );
    return reply;
  }

  public async getChannelMessage(
    repositoryId: string,
    messageId: string,
    viewerId: string,
  ): Promise<ChannelMessage | undefined> {
    const row = await this.row(
      "SELECT * FROM channel_messages WHERE id = $1 AND repository_id = $2",
      [messageId, repositoryId],
    );
    if (row === undefined) {
      return undefined;
    }
    const [hydrated] = await this.hydrateChannelMessages(
      [this.toChannelMessageBase(row)],
      viewerId,
    );
    return hydrated;
  }

  public async toggleChannelReaction(
    repositoryId: string,
    messageId: string,
    userId: string,
    emoji: string,
  ): Promise<ChannelMessage> {
    const owner = await this.row(
      "SELECT id FROM channel_messages WHERE id = $1 AND repository_id = $2",
      [messageId, repositoryId],
    );
    if (owner === undefined) {
      throw new Error(`Unknown channel message: ${messageId}`);
    }
    const existing = await this.row(
      `SELECT 1 FROM channel_message_reactions
       WHERE message_id = $1 AND emoji = $2 AND user_id = $3`,
      [messageId, emoji, userId],
    );
    if (existing === undefined) {
      await this.query(
        `INSERT INTO channel_message_reactions
           (message_id, emoji, user_id, created_at)
         VALUES ($1, $2, $3, $4)`,
        [messageId, emoji, userId, new Date().toISOString()],
      );
    } else {
      await this.query(
        `DELETE FROM channel_message_reactions
         WHERE message_id = $1 AND emoji = $2 AND user_id = $3`,
        [messageId, emoji, userId],
      );
    }
    const message = await this.getChannelMessage(repositoryId, messageId, userId);
    if (message === undefined) {
      throw new Error(`Unknown channel message: ${messageId}`);
    }
    return message;
  }

  public async toggleChannelMessagePin(
    repositoryId: string,
    messageId: string,
    userId: string,
  ): Promise<ChannelMessage> {
    const current = await this.row(
      "SELECT pinned_at FROM channel_messages WHERE id = $1 AND repository_id = $2",
      [messageId, repositoryId],
    );
    if (current === undefined) {
      throw new Error(`Unknown channel message: ${messageId}`);
    }
    if (optionalText(current, "pinned_at") === undefined) {
      await this.query(
        `UPDATE channel_messages SET pinned_at = $1, pinned_by = $2
          WHERE repository_id = $3 AND id = $4`,
        [new Date().toISOString(), userId, repositoryId, messageId],
      );
    } else {
      await this.query(
        `UPDATE channel_messages SET pinned_at = NULL, pinned_by = NULL
          WHERE repository_id = $1 AND id = $2`,
        [repositoryId, messageId],
      );
    }
    const message = await this.getChannelMessage(repositoryId, messageId, userId);
    if (message === undefined) {
      throw new Error(`Unknown channel message: ${messageId}`);
    }
    return message;
  }

  public async listPinnedChannelMessages(
    repositoryId: string,
    viewerId: string,
    channelId?: string,
  ): Promise<ChannelMessage[]> {
    const rows = await this.rows(
      `SELECT * FROM channel_messages
       WHERE repository_id = $1 AND pinned_at IS NOT NULL
         AND ($3::text IS NULL OR COALESCE(channel_id, $2) = $3)
       ORDER BY pinned_at, id`,
      [repositoryId, generalChannelId(repositoryId), channelId ?? null],
    );
    return await this.hydrateChannelMessages(
      rows.map((row) => this.toChannelMessageBase(row)),
      viewerId,
    );
  }

  public async listChannelAgentOverrides(
    repositoryId: string,
  ): Promise<Record<string, ChannelAgentOverride>> {
    const rows = await this.rows(
      "SELECT * FROM channel_agent_overrides WHERE repository_id = $1",
      [repositoryId],
    );
    const result: Record<string, ChannelAgentOverride> = {};
    for (const row of rows) {
      const override = this.toChannelAgentOverride(row);
      result[override.agentId] = override;
    }
    return result;
  }

  public async setChannelAgentOverride(
    repositoryId: string,
    agentId: string,
    patch: { name?: string; role?: string; model?: string; effort?: string },
  ): Promise<ChannelAgentOverride> {
    const existing = await this.row(
      "SELECT * FROM channel_agent_overrides WHERE repository_id = $1 AND agent_id = $2",
      [repositoryId, agentId],
    );
    const current =
      existing === undefined ? undefined : this.toChannelAgentOverride(existing);
    const name = patch.name ?? current?.name;
    const role = patch.role ?? current?.role;
    const model = patch.model ?? current?.model;
    const effort = patch.effort ?? current?.effort;
    const override: ChannelAgentOverride = {
      repositoryId,
      agentId,
      ...(name === undefined ? {} : { name }),
      ...(role === undefined ? {} : { role }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      updatedAt: new Date().toISOString(),
    };
    await this.query(
      `INSERT INTO channel_agent_overrides
         (repository_id, agent_id, name, role, model, effort, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (repository_id, agent_id) DO UPDATE SET
         name = excluded.name,
         role = excluded.role,
         model = excluded.model,
         effort = excluded.effort,
         updated_at = excluded.updated_at`,
      [
        repositoryId,
        agentId,
        override.name ?? null,
        override.role ?? null,
        override.model ?? null,
        override.effort ?? null,
        override.updatedAt,
      ],
    );
    return override;
  }

  public async clearChannelAgentNameOverrides(agentId: string): Promise<void> {
    // Two statements rather than one UPDATE: a row whose only content was the
    // name has nothing left to say afterwards, and leaving it empty would keep
    // an override in every list for no reason.
    await this.query(
      `DELETE FROM channel_agent_overrides
        WHERE agent_id = $1 AND name IS NOT NULL
          AND (role IS NULL OR role = '')
          AND (model IS NULL OR model = '')
          AND (effort IS NULL OR effort = '')`,
      [agentId],
    );
    await this.query(
      `UPDATE channel_agent_overrides
          SET name = NULL, updated_at = $1
        WHERE agent_id = $2 AND name IS NOT NULL`,
      [new Date().toISOString(), agentId],
    );
  }

  public async listAgentCallSigns(): Promise<AgentCallSign[]> {
    const rows = await this.rows(
      "SELECT * FROM agent_call_signs ORDER BY assigned_at, user_id",
      [],
    );
    return rows.map((row) => ({
      userId: text(row, "user_id"),
      provider: text(row, "provider"),
      callSign: text(row, "call_sign"),
      assignedAt: text(row, "assigned_at"),
      // Read through a guard rather than cast: rows written before this
      // column existed carry the default, and anything else on a row is not
      // a visibility this system knows how to honour. `personal` is the safe
      // reading of an unanswerable value — it withholds rather than widens.
      visibility: text(row, "visibility") === "org" ? "org" : "personal",
    }));
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
    await this.query(
      `INSERT INTO agent_call_signs
         (user_id, provider, call_sign, assigned_at, visibility)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         call_sign = excluded.call_sign,
         assigned_at = excluded.assigned_at,
         visibility = excluded.visibility`,
      [userId, provider, callSign, record.assignedAt, visibility],
    );
    return record;
  }

  public async clearAgentCallSign(
    userId: string,
    provider: string,
  ): Promise<void> {
    await this.query(
      "DELETE FROM agent_call_signs WHERE user_id = $1 AND provider = $2",
      [userId, provider],
    );
  }

  /* ------------------------------------------------- sub-channels ---- */

  private toSubChannel(row: Row): SubChannel {
    const createdBy = optionalText(row, "created_by");
    return {
      id: text(row, "id"),
      repositoryId: text(row, "repository_id"),
      projectId: text(row, "project_id") as ProjectId,
      slug: text(row, "slug"),
      name: text(row, "name"),
      visibility: text(row, "visibility") as SubChannelVisibility,
      createdAt: text(row, "created_at"),
      ...(createdBy === undefined ? {} : { createdBy }),
    };
  }

  public async listSubChannels(repositoryId: string): Promise<SubChannel[]> {
    const rows = await this.rows(
      `SELECT * FROM sub_channels WHERE repository_id = $1
        ORDER BY (slug = $2) DESC, slug`,
      [repositoryId, GENERAL_SUB_CHANNEL_SLUG],
    );
    return rows.map((row) => this.toSubChannel(row));
  }

  public async getSubChannel(
    repositoryId: string,
    channelId: string,
  ): Promise<SubChannel | undefined> {
    const row = await this.row(
      "SELECT * FROM sub_channels WHERE id = $1 AND repository_id = $2",
      [channelId, repositoryId],
    );
    return row === undefined ? undefined : this.toSubChannel(row);
  }

  public async ensureGeneralSubChannel(
    repositoryId: string,
    projectId: ProjectId,
  ): Promise<SubChannel> {
    await this.query(
      `INSERT INTO sub_channels
         (id, repository_id, project_id, slug, name, visibility, created_at, created_by)
       VALUES ($1, $2, $3, $4, $4, 'public', $5, NULL)
       ON CONFLICT (repository_id, slug) DO NOTHING`,
      [
        generalChannelId(repositoryId),
        repositoryId,
        projectId,
        GENERAL_SUB_CHANNEL_SLUG,
        new Date().toISOString(),
      ],
    );
    const row = await this.row(
      "SELECT * FROM sub_channels WHERE repository_id = $1 AND slug = $2",
      [repositoryId, GENERAL_SUB_CHANNEL_SLUG],
    );
    if (row === undefined) {
      throw new Error("Sub-channel was not found");
    }
    return this.toSubChannel(row);
  }

  public async createSubChannel(
    input: CreateSubChannelInput,
  ): Promise<SubChannel> {
    const slug = input.slug.trim().toLowerCase();
    if (slug.length === 0) {
      throw new Error("A sub-channel needs a name");
    }
    const trimmed = input.name?.trim();
    const channel: SubChannel = {
      id: createId("subchan"),
      repositoryId: input.repositoryId,
      projectId: input.projectId,
      slug,
      name: trimmed === undefined || trimmed === "" ? slug : trimmed,
      visibility: input.visibility ?? "read_only",
      createdAt: new Date().toISOString(),
      ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
    };
    const existing = await this.row(
      "SELECT id FROM sub_channels WHERE repository_id = $1 AND slug = $2",
      [input.repositoryId, slug],
    );
    if (existing !== undefined) {
      throw new Error("A sub-channel with that name already exists");
    }
    await this.query(
      `INSERT INTO sub_channels
         (id, repository_id, project_id, slug, name, visibility, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        channel.id,
        channel.repositoryId,
        channel.projectId,
        channel.slug,
        channel.name,
        channel.visibility,
        channel.createdAt,
        input.createdBy ?? null,
      ],
    );
    return channel;
  }

  public async updateSubChannel(
    repositoryId: string,
    channelId: string,
    input: UpdateSubChannelInput,
  ): Promise<SubChannel> {
    const current = await this.getSubChannel(repositoryId, channelId);
    if (current === undefined) {
      throw new Error("Sub-channel was not found");
    }
    const slug =
      input.slug === undefined ? current.slug : input.slug.trim().toLowerCase();
    if (slug.length === 0) {
      throw new Error("A sub-channel needs a name");
    }
    if (slug !== current.slug) {
      const clash = await this.row(
        "SELECT id FROM sub_channels WHERE repository_id = $1 AND slug = $2",
        [repositoryId, slug],
      );
      if (clash !== undefined) {
        throw new Error("A sub-channel with that name already exists");
      }
    }
    const trimmed = input.name?.trim();
    const name =
      input.name === undefined
        ? current.name
        : trimmed === undefined || trimmed === ""
          ? slug
          : trimmed;
    const visibility = input.visibility ?? current.visibility;
    await this.query(
      `UPDATE sub_channels SET slug = $1, name = $2, visibility = $3
        WHERE id = $4 AND repository_id = $5`,
      [slug, name, visibility, channelId, repositoryId],
    );
    return { ...current, slug, name, visibility };
  }

  public async deleteSubChannel(
    repositoryId: string,
    channelId: string,
  ): Promise<void> {
    const channel = await this.getSubChannel(repositoryId, channelId);
    if (channel === undefined) {
      return;
    }
    if (channel.slug === GENERAL_SUB_CHANNEL_SLUG) {
      throw new Error("The #general channel cannot be deleted");
    }
    await this.deleteChannelMessages(repositoryId, channelId);
    await this.transaction(async (client) => {
      await client.query(
        "DELETE FROM sub_channel_members WHERE channel_id = $1",
        [channelId],
      );
      await client.query(
        "DELETE FROM channel_agent_members WHERE channel_id = $1",
        [channelId],
      );
      await client.query(
        "DELETE FROM channel_read_cursors WHERE channel_id = $1",
        [channelId],
      );
      await client.query("DELETE FROM sub_channels WHERE id = $1", [channelId]);
    });
  }

  public async listSubChannelMembers(
    channelId: string,
  ): Promise<SubChannelMember[]> {
    const rows = await this.rows(
      "SELECT * FROM sub_channel_members WHERE channel_id = $1 ORDER BY user_id",
      [channelId],
    );
    return rows.map((row) => ({
      channelId: text(row, "channel_id"),
      userId: text(row, "user_id"),
      addedAt: text(row, "added_at"),
    }));
  }

  public async setSubChannelMember(
    channelId: string,
    userId: string,
    isMember: boolean,
  ): Promise<void> {
    if (isMember) {
      await this.query(
        `INSERT INTO sub_channel_members (channel_id, user_id, added_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (channel_id, user_id) DO NOTHING`,
        [channelId, userId, new Date().toISOString()],
      );
    } else {
      await this.query(
        "DELETE FROM sub_channel_members WHERE channel_id = $1 AND user_id = $2",
        [channelId, userId],
      );
    }
  }

  public async isSubChannelMember(
    channelId: string,
    userId: string,
  ): Promise<boolean> {
    const row = await this.row(
      "SELECT user_id FROM sub_channel_members WHERE channel_id = $1 AND user_id = $2",
      [channelId, userId],
    );
    return row !== undefined;
  }

  public async listChannelAgentMembers(
    repositoryId: string,
    channelId?: string,
  ): Promise<Array<{ userId: string; provider: string; channelId: string }>> {
    const rows = await this.rows(
      `SELECT user_id, provider, channel_id FROM channel_agent_members
        WHERE repository_id = $1 AND ($2::text IS NULL OR channel_id = $2)`,
      [repositoryId, channelId ?? null],
    );
    return rows.map((row) => ({
      userId: text(row, "user_id"),
      provider: text(row, "provider"),
      channelId: text(row, "channel_id"),
    }));
  }

  public async setChannelAgentMember(
    repositoryId: string,
    userId: string,
    provider: string,
    isMember: boolean,
    channelId?: string,
  ): Promise<void> {
    const target = channelId ?? generalChannelId(repositoryId);
    if (isMember) {
      await this.query(
        `INSERT INTO channel_agent_members
           (repository_id, channel_id, user_id, provider, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (channel_id, user_id, provider) DO NOTHING`,
        [repositoryId, target, userId, provider, new Date().toISOString()],
      );
    } else {
      await this.query(
        "DELETE FROM channel_agent_members WHERE channel_id = $1 AND user_id = $2 AND provider = $3",
        [target, userId, provider],
      );
    }
  }

  public async hasBackfilledChannelMembership(
    repositoryId: string,
  ): Promise<boolean> {
    const row = await this.row(
      "SELECT repository_id FROM channel_membership_backfills WHERE repository_id = $1",
      [repositoryId],
    );
    return row !== undefined;
  }

  public async markChannelMembershipBackfilled(
    repositoryId: string,
  ): Promise<void> {
    await this.query(
      `INSERT INTO channel_membership_backfills (repository_id, backfilled_at)
       VALUES ($1, $2)
       ON CONFLICT (repository_id) DO NOTHING`,
      [repositoryId, new Date().toISOString()],
    );
  }

  public async markChannelRead(
    repositoryId: string,
    userId: string,
    at: string,
    channelId?: string,
  ): Promise<void> {
    await this.query(
      // Forward only, exactly as the SQLite store keeps it: a late write must
      // not move a cursor backwards and un-read messages somebody has seen.
      `INSERT INTO channel_read_cursors (repository_id, channel_id, user_id, read_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (repository_id, channel_id, user_id) DO UPDATE SET
         read_at = GREATEST(channel_read_cursors.read_at, excluded.read_at)`,
      [repositoryId, channelId ?? generalChannelId(repositoryId), userId, at],
    );
  }

  public async getChannelReadCursor(
    repositoryId: string,
    userId: string,
    channelId?: string,
  ): Promise<string | undefined> {
    const row = await this.row(
      `SELECT read_at FROM channel_read_cursors
        WHERE repository_id = $1 AND channel_id = $2 AND user_id = $3`,
      [repositoryId, channelId ?? generalChannelId(repositoryId), userId],
    );
    return row === undefined ? undefined : text(row, "read_at");
  }

  public async countUnreadByChannel(
    repositoryId: string,
    userId: string,
  ): Promise<Record<string, number>> {
    // See the SQLite store for why this is two grouped counts rather than one
    // join, and why a room with no cursor reads as entirely unread.
    const general = generalChannelId(repositoryId);
    const unread: Record<string, number> = {};
    const add = (rows: Row[]): void => {
      for (const row of rows) {
        const channelId = text(row, "channel_id");
        unread[channelId] = (unread[channelId] ?? 0) + integer(row, "total");
      }
    };
    add(
      await this.rows(
        `SELECT COALESCE(m.channel_id, $1) AS channel_id, COUNT(*) AS total
           FROM channel_messages m
           LEFT JOIN channel_read_cursors c
             ON c.repository_id = m.repository_id
            AND c.channel_id = COALESCE(m.channel_id, $1)
            AND c.user_id = $2
          WHERE m.repository_id = $3
            AND m.deleted_at IS NULL
            AND m.author_id <> $2
            AND m.created_at > COALESCE(c.read_at, '')
          GROUP BY COALESCE(m.channel_id, $1)`,
        [general, userId, repositoryId],
      ),
    );
    add(
      await this.rows(
        `SELECT COALESCE(m.channel_id, $1) AS channel_id, COUNT(*) AS total
           FROM channel_message_replies r
           JOIN channel_messages m ON m.id = r.message_id
           LEFT JOIN channel_read_cursors c
             ON c.repository_id = m.repository_id
            AND c.channel_id = COALESCE(m.channel_id, $1)
            AND c.user_id = $2
          WHERE m.repository_id = $3
            AND r.author_id <> $2
            AND r.created_at > COALESCE(c.read_at, '')
          GROUP BY COALESCE(m.channel_id, $1)`,
        [general, userId, repositoryId],
      ),
    );
    return unread;
  }

  public async setChannelMuted(
    repositoryId: string,
    userId: string,
    muted: boolean,
  ): Promise<void> {
    if (!muted) {
      await this.query(
        "DELETE FROM channel_mutes WHERE repository_id = $1 AND user_id = $2",
        [repositoryId, userId],
      );
      return;
    }
    // Muting twice is not a second mute — the first moment is the one worth
    // keeping, so a repeat leaves the row alone.
    await this.query(
      `INSERT INTO channel_mutes (repository_id, user_id, muted_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (repository_id, user_id) DO NOTHING`,
      [repositoryId, userId, new Date().toISOString()],
    );
  }

  public async listMutedChannels(userId: string): Promise<string[]> {
    const rows = await this.rows(
      `SELECT repository_id FROM channel_mutes
        WHERE user_id = $1 ORDER BY repository_id`,
      [userId],
    );
    return rows.map((row) => text(row, "repository_id"));
  }

  public async getCatchUpCursor(
    projectId: string,
    userId: string,
  ): Promise<CatchUpCursor | undefined> {
    const row = await this.row(
      `SELECT project_id, user_id, seen_at FROM catch_up_cursors
        WHERE project_id = $1 AND user_id = $2`,
      [projectId, userId],
    );
    return row === undefined
      ? undefined
      : {
          projectId: text(row, "project_id"),
          userId: text(row, "user_id"),
          seenAt: text(row, "seen_at"),
        };
  }

  public async markCatchUpSeen(
    projectId: string,
    userId: string,
    at: string,
  ): Promise<void> {
    // Forward-only, for the reason the SQLite copy gives.
    await this.query(
      `INSERT INTO catch_up_cursors (project_id, user_id, seen_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id, user_id) DO UPDATE SET seen_at = excluded.seen_at
         WHERE catch_up_cursors.seen_at < excluded.seen_at`,
      [projectId, userId, at],
    );
  }

  public async getAuditorCursor(
    repositoryId: string,
  ): Promise<AuditorCursor | undefined> {
    const row = await this.row(
      `SELECT repository_id, revision, sequence, paused, updated_at
         FROM auditor_cursors WHERE repository_id = $1`,
      [repositoryId],
    );
    return row === undefined
      ? undefined
      : {
          repositoryId: text(row, "repository_id"),
          revision: text(row, "revision"),
          sequence: Number(row["sequence"]),
          paused: row["paused"] === true,
          updatedAt: text(row, "updated_at"),
        };
  }

  public async saveAuditorCursor(
    cursor: Omit<AuditorCursor, "paused">,
  ): Promise<void> {
    await this.query(
      `INSERT INTO auditor_cursors (repository_id, revision, sequence, paused, updated_at)
       VALUES ($1, $2, $3, FALSE, $4)
       ON CONFLICT (repository_id) DO UPDATE SET
         revision = EXCLUDED.revision,
         sequence = EXCLUDED.sequence,
         updated_at = EXCLUDED.updated_at`,
      [cursor.repositoryId, cursor.revision, cursor.sequence, cursor.updatedAt],
    );
  }

  public async setAuditorPaused(
    repositoryId: string,
    paused: boolean,
  ): Promise<void> {
    await this.query(
      `INSERT INTO auditor_cursors (repository_id, revision, sequence, paused, updated_at)
       VALUES ($1, '', 0, $2, $3)
       ON CONFLICT (repository_id) DO UPDATE SET
         paused = EXCLUDED.paused,
         updated_at = EXCLUDED.updated_at`,
      [repositoryId, paused, new Date().toISOString()],
    );
  }

  private toChannelMessageBase(
    row: Row,
  ): Omit<ChannelMessage, "replies" | "reactions"> {
    const referencedMessageId = optionalText(row, "referenced_message_id");
    const deletedAt = optionalText(row, "deleted_at");
    const deletedBy = optionalText(row, "deleted_by");
    const repositoryId = text(row, "repository_id");
    return {
      id: text(row, "id"),
      repositoryId,
      channelId:
        optionalText(row, "channel_id") ?? generalChannelId(repositoryId),
      projectId: text(row, "project_id") as ProjectId,
      kind: text(row, "kind") as ChannelEntryKind,
      authorId: text(row, "author_id"),
      content: text(row, "content"),
      createdAt: text(row, "created_at"),
      ...(referencedMessageId === undefined ? {} : { referencedMessageId }),
      taskId: optionalText(row, "task_id") as TaskId | undefined,
      changedFiles: parseChangedFiles(optionalText(row, "changed_files_json")),
      pinnedAt: optionalText(row, "pinned_at"),
      pinnedBy: optionalText(row, "pinned_by"),
      endedAt: optionalText(row, "ended_at"),
      ...(deletedAt === undefined ? {} : { deletedAt }),
      ...(deletedBy === undefined ? {} : { deletedBy }),
    };
  }

  public async setChannelMessageChangedFiles(
    repositoryId: string,
    messageId: string,
    files: readonly ChannelChangedFile[],
  ): Promise<void> {
    await this.query(
      `UPDATE channel_messages SET changed_files_json = $1
       WHERE id = $2 AND repository_id = $3`,
      [JSON.stringify(files), messageId, repositoryId],
    );
  }

  public async markChannelMessageEnded(
    repositoryId: string,
    messageId: string,
  ): Promise<void> {
    // First ending wins: a re-narrated run must not restamp the row and make
    // the mark look like it belongs to the later pass.
    await this.query(
      `UPDATE channel_messages SET ended_at = $1
       WHERE id = $2 AND repository_id = $3 AND ended_at IS NULL`,
      [new Date().toISOString(), messageId, repositoryId],
    );
  }

  public async setChannelMessageTask(
    repositoryId: string,
    messageId: string,
    taskId: TaskId,
  ): Promise<void> {
    await this.query(
      `UPDATE channel_messages SET task_id = $1
       WHERE id = $2 AND repository_id = $3`,
      [taskId, messageId, repositoryId],
    );
  }

  public async setChannelMessageContent(
    repositoryId: string,
    messageId: string,
    content: string,
  ): Promise<void> {
    await this.query(
      `UPDATE channel_messages SET content = $1
       WHERE id = $2 AND repository_id = $3`,
      [content, messageId, repositoryId],
    );
  }

  public async setChannelReplyContent(
    repositoryId: string,
    messageId: string,
    replyId: string,
    content: string,
  ): Promise<void> {
    await this.query(
      `UPDATE channel_message_replies SET content = $1
       WHERE id = $2 AND message_id = $3
         AND EXISTS (
           SELECT 1 FROM channel_messages
           WHERE id = $3 AND repository_id = $4
         )`,
      [content, replyId, messageId, repositoryId],
    );
  }

  public async channelEntryHasDependents(
    repositoryId: string,
    entryId: string,
  ): Promise<boolean> {
    const row = await this.row(
      `SELECT 1
         FROM channel_messages
        WHERE repository_id = $1 AND referenced_message_id = $2
        UNION ALL
       SELECT 1
         FROM channel_message_replies AS reply
         JOIN channel_messages AS root ON root.id = reply.message_id
        WHERE root.repository_id = $1 AND reply.referenced_message_id = $2
        LIMIT 1`,
      [repositoryId, entryId],
    );
    return row !== undefined;
  }

  private toChannelReply(row: Row): ChannelReply {
    const referencedMessageId = optionalText(row, "referenced_message_id");
    return {
      id: text(row, "id"),
      messageId: text(row, "message_id"),
      kind: text(row, "kind") as ChannelEntryKind,
      authorId: text(row, "author_id"),
      content: text(row, "content"),
      createdAt: text(row, "created_at"),
      ...(referencedMessageId === undefined ? {} : { referencedMessageId }),
    };
  }

  private toChannelAgentOverride(row: Row): ChannelAgentOverride {
    const name = optionalText(row, "name");
    const role = optionalText(row, "role");
    const model = optionalText(row, "model");
    const effort = optionalText(row, "effort");
    return {
      repositoryId: text(row, "repository_id"),
      agentId: text(row, "agent_id"),
      ...(name === undefined ? {} : { name }),
      ...(role === undefined ? {} : { role }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      updatedAt: text(row, "updated_at"),
    };
  }

  /** Bulk-loads replies and reactions for a page of messages in two queries. */
  private async hydrateChannelMessages(
    bases: ReadonlyArray<Omit<ChannelMessage, "replies" | "reactions">>,
    viewerId: string,
  ): Promise<ChannelMessage[]> {
    if (bases.length === 0) {
      return [];
    }
    const ids = bases.map((base) => base.id);
    const replyValues: unknown[] = [];
    const replyPlaceholders = ids.map((id) => bind(replyValues, id)).join(", ");
    const replyRows = await this.rows(
      `SELECT * FROM channel_message_replies WHERE message_id IN (${replyPlaceholders})
       ORDER BY created_at, id`,
      replyValues,
    );
    const reactionValues: unknown[] = [];
    const reactionPlaceholders = ids
      .map((id) => bind(reactionValues, id))
      .join(", ");
    const reactionRows = await this.rows(
      `SELECT * FROM channel_message_reactions WHERE message_id IN (${reactionPlaceholders})`,
      reactionValues,
    );

    const repliesByMessage = new Map<string, ChannelReply[]>();
    for (const row of replyRows) {
      const reply = this.toChannelReply(row);
      const list = repliesByMessage.get(reply.messageId) ?? [];
      list.push(reply);
      repliesByMessage.set(reply.messageId, list);
    }
    const reactionsByMessage = new Map<string, Map<string, Set<string>>>();
    for (const row of reactionRows) {
      const messageId = text(row, "message_id");
      const emoji = text(row, "emoji");
      const userId = text(row, "user_id");
      const byEmoji =
        reactionsByMessage.get(messageId) ?? new Map<string, Set<string>>();
      const reactors = byEmoji.get(emoji) ?? new Set<string>();
      reactors.add(userId);
      byEmoji.set(emoji, reactors);
      reactionsByMessage.set(messageId, byEmoji);
    }
    return bases.map((base) => ({
      ...base,
      replies: repliesByMessage.get(base.id) ?? [],
      reactions: this.toReactionMap(reactionsByMessage.get(base.id), viewerId),
    }));
  }

  private toReactionMap(
    byEmoji: Map<string, Set<string>> | undefined,
    viewerId: string,
  ): Record<string, ChannelReaction> {
    const result: Record<string, ChannelReaction> = {};
    if (byEmoji === undefined) {
      return result;
    }
    for (const [emoji, userIds] of byEmoji) {
      result[emoji] = { emoji, count: userIds.size, mine: userIds.has(viewerId) };
    }
    return result;
  }

  public async close(): Promise<void> {
    // Settle the migration first so an in-flight failure cannot race the
    // pool shutdown; its error, if any, was already delivered to callers.
    await this.ready.catch(() => undefined);
    await this.pool.end();
  }

  private toRepository(row: Row): StoredRepository {
    const provider = optionalText(row, "provider");
    const remoteUrl = optionalText(row, "remote_url");
    const createdBy = optionalText(row, "created_by");
    const displayName = optionalText(row, "display_name");
    const picture = optionalText(row, "picture");
    return {
      id: text(row, "id"),
      path: text(row, "path"),
      branch: text(row, "branch"),
      ...(provider === undefined || provider === "local"
        ? {}
        : { provider: provider as "git" | "github" }),
      ...(remoteUrl === undefined ? {} : { remoteUrl }),
      ...(createdBy === undefined ? {} : { createdBy }),
      ...(displayName === undefined ? {} : { displayName }),
      ...(picture === undefined ? {} : { picture }),
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
    const appearance = row["appearance"];
    return {
      id: text(row, "id"),
      email: text(row, "email"),
      displayName: text(row, "display_name"),
      passwordDigest: text(row, "password_digest"),
      systemAdmin: flag(row, "system_admin"),
      disabled: flag(row, "disabled"),
      createdAt: text(row, "created_at"),
      // A row written before the column existed, or by a client that never
      // chose, reads as absent rather than as an empty preference.
      ...(typeof appearance === "string" && appearance.length > 0
        ? { appearance: JSON.parse(appearance) as UserAppearance }
        : {}),
    };
  }

  private toMembership(row: Row): OrganizationMembership {
    return {
      organizationId: text(row, "organization_id"),
      userId: text(row, "user_id"),
      role: text(row, "role") as OrganizationRole,
      comped: flag(row, "comped"),
      createdAt: text(row, "created_at"),
    };
  }

  private toSubscription(row: Row): Subscription {
    const optional = (column: string): string | undefined => {
      const value = row[column];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    };
    const trialEndsAt = optional("trial_ends_at");
    const currentPeriodEnd = optional("current_period_end");
    const stripeCustomerId = optional("stripe_customer_id");
    const stripeSubscriptionId = optional("stripe_subscription_id");
    return {
      organizationId: text(row, "organization_id"),
      status: text(row, "status") as SubscriptionStatus,
      ...(trialEndsAt === undefined ? {} : { trialEndsAt }),
      ...(currentPeriodEnd === undefined ? {} : { currentPeriodEnd }),
      ...(stripeCustomerId === undefined ? {} : { stripeCustomerId }),
      ...(stripeSubscriptionId === undefined ? {} : { stripeSubscriptionId }),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
    };
  }

  private toProject(row: Row): ProjectRecord {
    return {
      id: text(row, "id"),
      organizationId: text(row, "organization_id"),
      slug: text(row, "slug"),
      name: text(row, "name"),
      description: text(row, "description"),
      archived: flag(row, "archived"),
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
      requiredRole: text(
        row,
        "required_role",
      ) as ApprovalRequest["requiredRole"],
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

  private async tasksFor(runId: string): Promise<StoredTask[]> {
    const rows = await this.rows(
      "SELECT * FROM tasks WHERE run_id = $1 ORDER BY seq",
      [runId],
    );
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

  private async conflictsFor(runId: string): Promise<ConflictAssessment[]> {
    const rows = await this.rows(
      "SELECT * FROM conflicts WHERE run_id = $1 ORDER BY id",
      [runId],
    );
    return rows.map((row) => ({
      taskIds: [text(row, "first_task_id"), text(row, "second_task_id")],
      score: integer(row, "score"),
      disposition: text(row, "disposition") as ConflictDisposition,
      evidence: parseJson<ConflictEvidence[]>(row, "evidence_json"),
      explanation: text(row, "explanation"),
    }));
  }

  private async changeSetsFor(runId: string): Promise<ChangeSet[]> {
    const rows = await this.rows(
      "SELECT * FROM changesets WHERE run_id = $1 ORDER BY created_at, seq",
      [runId],
    );

    const changeSets: ChangeSet[] = [];
    for (const row of rows) {
      const id = text(row, "id");
      const patches = (
        await this.rows(
          "SELECT * FROM file_patches WHERE changeset_id = $1 ORDER BY ordinal",
          [id],
        )
      ).map<FilePatch>((patch) => ({
        path: text(patch, "path"),
        status: text(patch, "status") as FilePatchStatus,
        patch: text(patch, "patch"),
      }));

      changeSets.push({
        id,
        taskId: text(row, "task_id"),
        baseVersion: integer(row, "base_version"),
        baseRevision: text(row, "base_revision"),
        patches,
        commandsRun: parseJson<CommandResult[]>(row, "commands_run_json"),
        tests: parseJson<TestResult[]>(row, "tests_json"),
        dependenciesChanged: parseJson<string[]>(
          row,
          "dependencies_changed_json",
        ),
        symbolsChanged: parseJson<string[]>(row, "symbols_changed_json"),
        riskAssessment: {
          level: text(row, "risk_level") as RiskLevel,
          reasons: parseJson<string[]>(row, "risk_reasons_json"),
        },
        agentExplanation: text(row, "agent_explanation"),
        createdAt: text(row, "created_at"),
      });
    }
    return changeSets;
  }

  private async integrationsFor(runId: string): Promise<IntegrationResult[]> {
    const rows = await this.rows(
      "SELECT * FROM integrations WHERE run_id = $1 ORDER BY id",
      [runId],
    );
    return rows.map((row) => {
      const candidate = optionalText(row, "candidate_revision");
      const cleanupWarnings = parseJson<string[]>(row, "cleanup_warnings_json");
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

  private async leasesFor(runId: string): Promise<ResourceLease[]> {
    const rows = await this.rows(
      "SELECT * FROM resource_leases WHERE run_id = $1 ORDER BY seq",
      [runId],
    );
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

  private async workspacesFor(runId: string): Promise<StoredWorkspace[]> {
    const rows = await this.rows(
      "SELECT * FROM workspaces WHERE run_id = $1 ORDER BY created_at, seq",
      [runId],
    );
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
