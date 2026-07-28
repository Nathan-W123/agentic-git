import type { Migration } from "./schema.js";

/**
 * Schema migrations for the Postgres coordination store.
 *
 * Postgres arrived at schema version 8, so its history begins with one
 * baseline migration that creates the full schema the SQLite migrations
 * build up incrementally to that point. Migrations after 8 are added to both
 * dialects under the same version number so either backend can host the
 * same release.
 *
 * Dialect notes, so the two schemas stay recognizably the same:
 * - Timestamps stay TEXT holding UTC ISO-8601 strings, exactly as in SQLite.
 *   Every comparison in the stores is a string comparison; introducing
 *   timestamptz here would silently change ordering and equality semantics.
 * - SQLite's implicit `rowid` insertion order becomes an explicit BIGSERIAL
 *   `seq` column on tables whose read order depends on it.
 * - `COLLATE NOCASE` uniqueness becomes a unique index over LOWER(...).
 * - Boolean flags are real BOOLEANs rather than 0/1 integers.
 */
export const POSTGRES_MIGRATIONS: readonly Migration[] = [
  {
    version: 8,
    name: "postgres-baseline",
    statements: [
      `CREATE TABLE repositories (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        branch TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'local',
        remote_url TEXT
      )`,
      `CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        seq BIGSERIAL,
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        project_id TEXT NOT NULL DEFAULT 'project_local',
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
        seq BIGSERIAL,
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
        seq BIGSERIAL,
        run_id TEXT NOT NULL REFERENCES runs(id),
        task_id TEXT NOT NULL,
        path TEXT NOT NULL,
        isolation TEXT NOT NULL,
        base_revision TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE resource_leases (
        lease_id TEXT PRIMARY KEY,
        seq BIGSERIAL,
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
        id BIGSERIAL PRIMARY KEY,
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
        seq BIGSERIAL,
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
        id BIGSERIAL PRIMARY KEY,
        changeset_id TEXT NOT NULL REFERENCES changesets(id),
        ordinal INTEGER NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL,
        patch TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX file_patches_by_changeset_ordinal
         ON file_patches(changeset_id, ordinal)`,
      `CREATE TABLE integrations (
        id BIGSERIAL PRIMARY KEY,
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
        cleanup_warnings_json TEXT NOT NULL DEFAULT '[]',
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
      // Append-only. Sequence is the chain order; the trigger makes an
      // in-place edit fail loudly instead of silently rewriting history.
      `CREATE TABLE audit_events (
        sequence BIGSERIAL PRIMARY KEY,
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
      `CREATE FUNCTION audit_events_immutable() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'audit_events is append-only';
        END
      $$ LANGUAGE plpgsql`,
      `CREATE TRIGGER audit_events_immutable_guard
        BEFORE UPDATE OR DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION audit_events_immutable()`,
      `CREATE TABLE submitted_tasks (
        id TEXT PRIMARY KEY,
        seq BIGSERIAL,
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        project_id TEXT NOT NULL DEFAULT 'project_local',
        objective TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        validation_commands_json TEXT NOT NULL,
        submitted_by TEXT,
        status TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        claimed_at TEXT,
        completed_at TEXT,
        run_id TEXT
      )`,
      `CREATE TABLE organizations (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX organizations_slug_nocase
         ON organizations(LOWER(slug))`,
      `CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        password_digest TEXT NOT NULL,
        system_admin BOOLEAN NOT NULL DEFAULT FALSE,
        disabled BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX users_email_nocase ON users(LOWER(email))`,
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
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        archived BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX projects_slug_nocase
         ON projects(organization_id, LOWER(slug))`,
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
      `CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        seq BIGSERIAL,
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
        seq BIGSERIAL,
        run_id TEXT NOT NULL REFERENCES runs(id),
        task_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        decision_json TEXT,
        requested_at TEXT NOT NULL,
        decided_at TEXT
      )`,
      `CREATE TABLE api_tokens (
        id TEXT PRIMARY KEY,
        seq BIGSERIAL,
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
      `CREATE TABLE workers (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        adapters_json TEXT NOT NULL,
        version TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      )`,
      `CREATE TABLE work_leases (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        worker_id TEXT NOT NULL REFERENCES workers(id),
        repository_id TEXT NOT NULL,
        project_id TEXT,
        status TEXT NOT NULL,
        base_revision TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT,
        detail TEXT
      )`,
      // Only one active lease per task, enforced by the database rather than
      // by application logic, so two workers can never hold the same task.
      `CREATE UNIQUE INDEX work_leases_one_active
         ON work_leases(task_id) WHERE status = 'active'`,
      `INSERT INTO organizations (id, slug, name, created_at)
       VALUES ('org_local', 'local', 'Local Workspace', CURRENT_TIMESTAMP::text)`,
      `INSERT INTO projects
         (id, organization_id, slug, name, description, archived, created_at, updated_at)
       VALUES
         ('project_local', 'org_local', 'local', 'Local Project',
          'Default project for CLI-created repositories', FALSE,
          CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text)`,
      `CREATE INDEX tasks_by_run ON tasks(run_id)`,
      `CREATE INDEX changesets_by_run ON changesets(run_id)`,
      `CREATE INDEX integrations_by_run ON integrations(run_id)`,
      `CREATE INDEX conflicts_by_run ON conflicts(run_id)`,
      `CREATE INDEX leases_by_run ON resource_leases(run_id)`,
      `CREATE INDEX workspaces_by_run ON workspaces(run_id)`,
      `CREATE INDEX audit_by_run ON audit_events(run_id, sequence)`,
      `CREATE INDEX runs_by_start ON runs(started_at DESC)`,
      `CREATE INDEX submitted_tasks_pending
         ON submitted_tasks(repository_id, status, submitted_at)`,
      `CREATE INDEX submitted_tasks_by_project
         ON submitted_tasks(project_id, status, submitted_at)`,
      `CREATE INDEX memberships_by_user
         ON organization_memberships(user_id, organization_id)`,
      `CREATE INDEX projects_by_organization
         ON projects(organization_id, archived, created_at)`,
      `CREATE INDEX project_repositories_by_repository
         ON project_repositories(repository_id, project_id)`,
      `CREATE INDEX auth_sessions_by_user
         ON auth_sessions(user_id, expires_at)`,
      `CREATE INDEX auth_sessions_by_expiry ON auth_sessions(expires_at)`,
      `CREATE INDEX approvals_pending
         ON approvals(status, project_id, requested_at)`,
      `CREATE INDEX approvals_by_run ON approvals(run_id, task_id)`,
      `CREATE INDEX plan_revisions_by_task
         ON task_plan_revisions(run_id, task_id, revision)`,
      `CREATE INDEX scope_changes_by_task
         ON scope_changes(run_id, task_id, requested_at)`,
      `CREATE INDEX api_tokens_by_user ON api_tokens(user_id, created_at DESC)`,
      `CREATE INDEX api_tokens_by_expiry ON api_tokens(expires_at)`,
      `CREATE INDEX work_leases_by_worker ON work_leases(worker_id, status)`,
      `CREATE INDEX work_leases_expiring ON work_leases(status, expires_at)`,
      `CREATE INDEX workers_by_user ON workers(user_id, last_seen_at DESC)`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version.
    version: 9,
    name: "project-policy",
    statements: [`ALTER TABLE projects ADD COLUMN policy_json TEXT`],
  },
];
