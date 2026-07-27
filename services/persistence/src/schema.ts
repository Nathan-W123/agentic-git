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
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);
