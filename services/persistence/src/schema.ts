/**
 * Schema migrations for the coordination store.
 *
 * Migrations are ordered and applied once. `schema_version` records how far a
 * database has advanced so an existing file is never re-initialized or
 * silently downgraded.
 */
export interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "coordination-core",
    statements: [
      `CREATE TABLE repositories (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        branch TEXT NOT NULL,
        first_seen_at TEXT NOT NULL
      )`,
      `CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        mode TEXT NOT NULL,
        scenario TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        base_revision TEXT NOT NULL,
        final_revision TEXT
      )`,
      `CREATE TABLE tasks (
        run_id TEXT NOT NULL REFERENCES runs(id),
        id TEXT NOT NULL,
        objective TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        explanation TEXT,
        plan_json TEXT,
        decision_json TEXT,
        session_id TEXT,
        session_started_at TEXT,
        validation_commands_json TEXT NOT NULL,
        PRIMARY KEY (run_id, id)
      )`,
      `CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        task_id TEXT NOT NULL,
        path TEXT NOT NULL,
        isolation TEXT NOT NULL,
        base_revision TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE resource_leases (
        lease_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        task_id TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        base_version INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT
      )`,
      `CREATE TABLE conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        first_task_id TEXT NOT NULL,
        second_task_id TEXT NOT NULL,
        score INTEGER NOT NULL,
        disposition TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        explanation TEXT NOT NULL
      )`,
      `CREATE TABLE changesets (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        task_id TEXT NOT NULL,
        base_version INTEGER NOT NULL,
        base_revision TEXT NOT NULL,
        symbols_changed_json TEXT NOT NULL,
        dependencies_changed_json TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        risk_reasons_json TEXT NOT NULL,
        agent_explanation TEXT NOT NULL,
        commands_run_json TEXT NOT NULL,
        tests_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE file_patches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        changeset_id TEXT NOT NULL REFERENCES changesets(id),
        ordinal INTEGER NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL,
        patch TEXT NOT NULL
      )`,
      `CREATE TABLE integrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        task_id TEXT NOT NULL,
        changeset_id TEXT NOT NULL,
        status TEXT NOT NULL,
        -- Both versions are stored in full. Deriving the previous version's
        -- branch or timestamp from the canonical one silently misreports the
        -- base an integration was attempted against.
        previous_sequence INTEGER NOT NULL,
        previous_revision TEXT NOT NULL,
        previous_branch TEXT NOT NULL,
        previous_created_at TEXT NOT NULL,
        canonical_sequence INTEGER NOT NULL,
        canonical_revision TEXT NOT NULL,
        canonical_branch TEXT NOT NULL,
        canonical_created_at TEXT NOT NULL,
        candidate_revision TEXT,
        validation_json TEXT NOT NULL,
        explanation TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      )`,
      `CREATE TABLE canonical_versions (
        repository_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        branch TEXT NOT NULL,
        created_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (repository_id, revision)
      )`,
      // Append-only. Sequence is the chain order; the triggers below make an
      // in-place edit fail loudly instead of silently rewriting history.
      `CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        run_id TEXT,
        task_id TEXT,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        chain_hash TEXT NOT NULL
      )`,
      `CREATE TRIGGER audit_events_immutable_update
        BEFORE UPDATE ON audit_events
        BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END`,
      `CREATE TRIGGER audit_events_immutable_delete
        BEFORE DELETE ON audit_events
        BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END`,
      `CREATE INDEX tasks_by_run ON tasks(run_id)`,
      `CREATE INDEX changesets_by_run ON changesets(run_id)`,
      `CREATE INDEX integrations_by_run ON integrations(run_id)`,
      `CREATE INDEX conflicts_by_run ON conflicts(run_id)`,
      `CREATE INDEX leases_by_run ON resource_leases(run_id)`,
      `CREATE INDEX workspaces_by_run ON workspaces(run_id)`,
      `CREATE INDEX audit_by_run ON audit_events(run_id, sequence)`,
      `CREATE INDEX runs_by_start ON runs(started_at DESC)`,
    ],
  },
  {
    // Tasks exist before any run claims them, so the queue cannot live in
    // `tasks`, which is keyed by run.
    version: 2,
    name: "task-submission-queue",
    statements: [
      `CREATE TABLE submitted_tasks (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        objective TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        validation_commands_json TEXT NOT NULL,
        status TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        claimed_at TEXT,
        completed_at TEXT,
        run_id TEXT
      )`,
      `CREATE INDEX submitted_tasks_pending
         ON submitted_tasks(repository_id, status, submitted_at)`,
    ],
  },
  {
    version: 3,
    name: "changeset-patch-idempotency",
    statements: [
      `DELETE FROM file_patches
       WHERE id NOT IN (
         SELECT MIN(id) FROM file_patches GROUP BY changeset_id, ordinal
       )`,
      `CREATE UNIQUE INDEX file_patches_by_changeset_ordinal
         ON file_patches(changeset_id, ordinal)`,
    ],
  },
  {
    version: 4,
    name: "integration-cleanup-warnings",
    statements: [
      `ALTER TABLE integrations
         ADD COLUMN cleanup_warnings_json TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    version: 5,
    name: "multi-tenant-control-plane",
    statements: [
      `CREATE TABLE organizations (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_digest TEXT NOT NULL,
        system_admin INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE organization_memberships (
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, user_id)
      )`,
      `CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        slug TEXT NOT NULL COLLATE NOCASE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (organization_id, slug)
      )`,
      `CREATE TABLE project_repositories (
        project_id TEXT NOT NULL REFERENCES projects(id),
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        linked_at TEXT NOT NULL,
        PRIMARY KEY (project_id, repository_id)
      )`,
      `CREATE TABLE auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        secret_hash TEXT NOT NULL,
        csrf_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ip_address TEXT NOT NULL,
        user_agent TEXT NOT NULL
      )`,
      `INSERT INTO organizations (id, slug, name, created_at)
       VALUES ('org_local', 'local', 'Local Workspace', CURRENT_TIMESTAMP)`,
      `INSERT INTO projects
         (id, organization_id, slug, name, description, archived, created_at, updated_at)
       VALUES
         ('project_local', 'org_local', 'local', 'Local Project',
          'Default project for CLI-created repositories', 0,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      `ALTER TABLE repositories ADD COLUMN provider TEXT NOT NULL DEFAULT 'local'`,
      `ALTER TABLE repositories ADD COLUMN remote_url TEXT`,
      `ALTER TABLE runs ADD COLUMN project_id TEXT NOT NULL DEFAULT 'project_local'`,
      `ALTER TABLE submitted_tasks
         ADD COLUMN project_id TEXT NOT NULL DEFAULT 'project_local'`,
      `ALTER TABLE submitted_tasks ADD COLUMN submitted_by TEXT`,
      `INSERT INTO project_repositories (project_id, repository_id, linked_at)
       SELECT 'project_local', id, CURRENT_TIMESTAMP FROM repositories`,
      `CREATE INDEX memberships_by_user
         ON organization_memberships(user_id, organization_id)`,
      `CREATE INDEX projects_by_organization
         ON projects(organization_id, archived, created_at)`,
      `CREATE INDEX project_repositories_by_repository
         ON project_repositories(repository_id, project_id)`,
      `CREATE INDEX auth_sessions_by_user
         ON auth_sessions(user_id, expires_at)`,
      `CREATE INDEX auth_sessions_by_expiry ON auth_sessions(expires_at)`,
      `CREATE INDEX submitted_tasks_by_project
         ON submitted_tasks(project_id, status, submitted_at)`,
    ],
  },
  {
    version: 6,
    name: "approvals-and-dynamic-replanning",
    statements: [
      `CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        project_id TEXT,
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        required_role TEXT NOT NULL,
        reasons_json TEXT NOT NULL,
        changeset_id TEXT,
        scope_change_id TEXT,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        decision_comment TEXT
      )`,
      `CREATE TABLE task_plan_revisions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        task_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        reason TEXT NOT NULL,
        canonical_revision TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, task_id, revision)
      )`,
      `CREATE TABLE scope_changes (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        task_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        decision_json TEXT,
        requested_at TEXT NOT NULL,
        decided_at TEXT
      )`,
      `CREATE INDEX approvals_pending
         ON approvals(status, project_id, requested_at)`,
      `CREATE INDEX approvals_by_run ON approvals(run_id, task_id)`,
      `CREATE INDEX plan_revisions_by_task
         ON task_plan_revisions(run_id, task_id, revision)`,
      `CREATE INDEX scope_changes_by_task
         ON scope_changes(run_id, task_id, requested_at)`,
    ],
  },
  {
    // Cookie sessions only work for a browser. Headless participants — the CLI,
    // remote workers, and agents — authenticate with a bearer token instead.
    version: 7,
    name: "api-tokens",
    statements: [
      `CREATE TABLE api_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        organization_id TEXT,
        name TEXT NOT NULL,
        -- Only the digest is stored. A lost token cannot be recovered, only
        -- revoked and reissued.
        secret_hash TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by_session TEXT,
        expires_at TEXT,
        last_used_at TEXT,
        last_used_ip TEXT,
        revoked_at TEXT,
        revoked_reason TEXT
      )`,
      `CREATE INDEX api_tokens_by_user ON api_tokens(user_id, created_at DESC)`,
      `CREATE INDEX api_tokens_by_expiry ON api_tokens(expires_at)`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);
