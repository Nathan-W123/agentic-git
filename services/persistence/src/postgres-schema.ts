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
  {
    // Mirrors the SQLite migration of the same version.
    version: 10,
    name: "remote-plan-admission",
    statements: [
      `ALTER TABLE work_leases ADD COLUMN plan_json TEXT`,
      `CREATE INDEX work_leases_by_repository
         ON work_leases(repository_id, status)`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version.
    version: 11,
    name: "audit-retention",
    statements: [
      `CREATE TABLE audit_checkpoints (
        id TEXT PRIMARY KEY,
        through_sequence BIGINT NOT NULL UNIQUE,
        chain_hash TEXT NOT NULL,
        segment_digest TEXT NOT NULL,
        events BIGINT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE audit_archive (
        sequence BIGINT PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        checkpoint_id TEXT NOT NULL REFERENCES audit_checkpoints(id),
        run_id TEXT,
        task_id TEXT,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        chain_hash TEXT NOT NULL
      )`,
      `CREATE FUNCTION audit_archive_immutable() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'audit_archive is append-only';
        END
      $$ LANGUAGE plpgsql`,
      `CREATE TRIGGER audit_archive_immutable_guard
        BEFORE UPDATE ON audit_archive
        FOR EACH ROW EXECUTE FUNCTION audit_archive_immutable()`,
      // Split the one guard into an absolute bar on UPDATE and a
      // checkpoint-conditional bar on DELETE.
      `DROP TRIGGER audit_events_immutable_guard ON audit_events`,
      `CREATE TRIGGER audit_events_immutable_update
        BEFORE UPDATE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION audit_events_immutable()`,
      `CREATE FUNCTION audit_events_prune_guard() RETURNS trigger AS $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM audit_checkpoints
            WHERE through_sequence >= OLD.sequence
          ) THEN
            RAISE EXCEPTION
              'audit_events may only be pruned below a recorded checkpoint';
          END IF;
          RETURN OLD;
        END
      $$ LANGUAGE plpgsql`,
      `CREATE TRIGGER audit_events_prune_guard
        BEFORE DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION audit_events_prune_guard()`,
      `CREATE INDEX audit_by_task ON audit_events(task_id, sequence)`,
      `CREATE INDEX audit_by_type ON audit_events(type, sequence)`,
      `CREATE INDEX audit_by_time ON audit_events(occurred_at)`,
      `CREATE INDEX audit_archive_by_checkpoint
         ON audit_archive(checkpoint_id, sequence)`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version.
    version: 12,
    name: "changeset-comments",
    statements: [
      `CREATE TABLE changeset_comments (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        change_set_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        file_path TEXT,
        author_id TEXT NOT NULL REFERENCES users(id),
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT REFERENCES users(id)
      )`,
      `CREATE INDEX comments_by_run
         ON changeset_comments(run_id, created_at)`,
      `CREATE INDEX comments_by_changeset
         ON changeset_comments(change_set_id, created_at)`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version.
    version: 13,
    name: "token-usage-accounting",
    statements: [
      `CREATE TABLE token_usage (
        id TEXT PRIMARY KEY,
        usage_key TEXT NOT NULL UNIQUE,
        project_id TEXT,
        repository_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        lease_id TEXT,
        run_id TEXT,
        agent_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        input_tokens BIGINT NOT NULL,
        output_tokens BIGINT NOT NULL,
        total_tokens BIGINT NOT NULL,
        recorded_at TEXT NOT NULL
      )`,
      `CREATE INDEX token_usage_by_task ON token_usage(task_id, recorded_at)`,
      `CREATE INDEX token_usage_by_project
         ON token_usage(project_id, recorded_at)`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version.
    version: 14,
    name: "worker-organization-scope",
    statements: [
      `ALTER TABLE workers
         ADD COLUMN organization_id TEXT REFERENCES organizations(id)`,
      `UPDATE workers SET organization_id = (
         SELECT m.organization_id FROM organization_memberships m
         WHERE m.user_id = workers.user_id
         ORDER BY m.created_at ASC, m.organization_id ASC
         LIMIT 1
       ) WHERE organization_id IS NULL`,
      `CREATE INDEX workers_by_organization
         ON workers(organization_id, last_seen_at DESC)`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version.
    version: 15,
    name: "user-appearance",
    statements: [`ALTER TABLE users ADD COLUMN appearance TEXT`],
  },
  {
    // Mirrors the SQLite migration of the same version. Postgres has no
    // COLLATE NOCASE, so the email is stored lowercased by the store instead.
    version: 16,
    name: "organization-invitations",
    statements: [
      `CREATE TABLE invitations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        invited_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        accepted_at TEXT,
        accepted_by TEXT REFERENCES users(id),
        revoked_at TEXT
      )`,
      `CREATE INDEX invitations_by_organization
         ON invitations(organization_id, created_at DESC)`,
    ],
  },
{
  // Mirrors the SQLite migration of the same version.
    // Access to one repository rather than to everything an organization owns.
    //
    // Membership was organization-wide, so sharing a single repository meant
    // handing over every repository the team had. A grant is the narrower
    // thing: it names a person, a repository, and the role they hold there.
    //
    // Organization roles still confer blanket access. Scoping owners down to
    // explicit grants would let them lock themselves out of repositories they
    // created, and an administrator who cannot see their own team's work is a
    // worse failure than one who can see too much.
    version: 17,
    name: "repository-grants",
    statements: [
      `CREATE TABLE repository_grants (
        repository_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id),
        role TEXT NOT NULL,
        granted_by TEXT REFERENCES users(id),
        created_at TEXT NOT NULL,
        PRIMARY KEY (repository_id, user_id)
      )`,
      `CREATE INDEX repository_grants_by_user ON repository_grants(user_id)`,
    ],
  },
{
    // Mirrors the SQLite migration of the same version.
    // Narrowing an invitation to a single repository.
    //
    // A separate migration rather than an edit to the one that created the
    // table: migration 16 has already run wherever this branch has been
    // started, and an applied migration is never re-applied, so changing it
    // would leave those databases without the column and every insert failing.
    version: 18,
    name: "repository-scoped-invitations",
    statements: [`ALTER TABLE invitations ADD COLUMN repository_id TEXT`],
  },
  {
    // Mirrors the SQLite migration of the same version.
    // The shared group channel: one room per repository, with every human and
    // agent working it as a participant. Reactions are a join table keyed by
    // (message, emoji, user) rather than a count, so "mine" can be answered
    // correctly for whichever viewer is asking instead of only for whoever
    // reacted most recently.
    version: 19,
    name: "repository-channels",
    statements: [
      `CREATE TABLE channel_messages (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE channel_message_replies (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES channel_messages(id),
        kind TEXT NOT NULL,
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE channel_message_reactions (
        message_id TEXT NOT NULL REFERENCES channel_messages(id),
        emoji TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, emoji, user_id)
      )`,
      `CREATE TABLE channel_agent_overrides (
        repository_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        name TEXT,
        model TEXT,
        effort TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repository_id, agent_id)
      )`,
      `CREATE TABLE channel_read_cursors (
        repository_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        read_at TEXT NOT NULL,
        PRIMARY KEY (repository_id, user_id)
      )`,
      `CREATE INDEX channel_messages_by_repository
         ON channel_messages(repository_id, created_at)`,
      `CREATE INDEX channel_message_replies_by_message
         ON channel_message_replies(message_id, created_at)`,
      `CREATE INDEX channel_message_reactions_by_message
         ON channel_message_reactions(message_id)`,
    ],
  },
  {
    // Mirrors schema.ts's migration 20 — see its comment for the full
    // reasoning on the role column and the opt-in membership backfill.
    version: 20,
    name: "channel-agent-roles-and-membership",
    statements: [
      `ALTER TABLE channel_agent_overrides ADD COLUMN role TEXT`,
      `CREATE TABLE channel_agent_members (
        repository_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (repository_id, user_id, provider)
      )`,
      `CREATE TABLE channel_membership_backfills (
        repository_id TEXT PRIMARY KEY,
        backfilled_at TEXT NOT NULL
      )`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version. See its comment for
    // why the column is nullable and why the creator is an additional path
    // in rather than a replacement for manage_project.
    version: 21,
    name: "repository-creator",
    statements: [
      `ALTER TABLE repositories ADD COLUMN created_by TEXT REFERENCES users(id)`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version. See its comment for
    // why this is keyed on the repository alone and not on the holding agent.
    version: 22,
    name: "auditor-cursor",
    statements: [
      `CREATE TABLE auditor_cursors (
        repository_id TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        sequence BIGINT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version.
    version: 23,
    name: "auditor-paused",
    statements: [
      `ALTER TABLE auditor_cursors ADD COLUMN paused BOOLEAN NOT NULL DEFAULT FALSE`,
    ],
  },
  {
    // Where a thread sits in the channel, as against when it was first said.
    //
    // Continuing an existing thread has to bring it back into view or the
    // work lands somewhere nobody is looking. Reordering by rewriting
    //  would buy that by lying about when the message was
    // posted, and every reply hangs off that ordering. A second column keeps
    // both facts: history stays true, position follows the conversation.
    version: 24,
    name: "channel-message-bumped-at",
    statements: [
      `ALTER TABLE channel_messages ADD COLUMN bumped_at TEXT`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version.
    version: 25,
    name: "submitted-task-context",
    statements: [
      `ALTER TABLE submitted_tasks ADD COLUMN context TEXT`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version.
    version: 26,
    name: "channel-message-task-changes",
    statements: [
      `ALTER TABLE channel_messages ADD COLUMN task_id TEXT`,
      `ALTER TABLE channel_messages ADD COLUMN changed_files_json TEXT`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version.
    version: 27,
    name: "direct-messages",
    statements: [
      `CREATE TABLE direct_messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        pair_key TEXT NOT NULL,
        author_id TEXT NOT NULL REFERENCES users(id),
        recipient_id TEXT NOT NULL REFERENCES users(id),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT
      )`,
      `CREATE INDEX direct_messages_thread
        ON direct_messages (project_id, pair_key, created_at)`,
      `CREATE INDEX direct_messages_unread
        ON direct_messages (project_id, recipient_id, read_at)`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version.
    version: 28,
    name: "conversational-tasks",
    statements: [
      `ALTER TABLE submitted_tasks ADD COLUMN conversation_id TEXT`,
      `ALTER TABLE submitted_tasks ADD COLUMN opened_at TEXT`,
      `CREATE INDEX submitted_tasks_conversation
        ON submitted_tasks (conversation_id, status)`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version.
    version: 29,
    name: "channel-message-pins",
    statements: [
      `ALTER TABLE channel_messages ADD COLUMN pinned_at TEXT`,
      `ALTER TABLE channel_messages ADD COLUMN pinned_by TEXT`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version.
    version: 30,
    name: "channel-message-ended-elsewhere",
    statements: [
      `ALTER TABLE channel_messages ADD COLUMN ended_at TEXT`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version.
    version: 31,
    name: "submitted-task-model-effort",
    statements: [
      `ALTER TABLE submitted_tasks ADD COLUMN model TEXT`,
      `ALTER TABLE submitted_tasks ADD COLUMN effort TEXT`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version.
    version: 32,
    name: "agent-call-signs",
    statements: [
      `CREATE TABLE agent_call_signs (
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        call_sign TEXT NOT NULL,
        assigned_at TEXT NOT NULL,
        PRIMARY KEY (user_id, provider)
      )`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version.
    version: 33,
    name: "channel-message-tombstones",
    statements: [
      `ALTER TABLE channel_messages ADD COLUMN deleted_at TEXT`,
      `ALTER TABLE channel_messages ADD COLUMN deleted_by TEXT`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version. Trigger enforcement
    // keeps a reference inside its repository even for direct SQL writes;
    // physical deletion clears it, while redaction keeps the target row and
    // therefore keeps the navigable tombstone.
    version: 34,
    name: "channel-message-references",
    statements: [
      `ALTER TABLE channel_messages ADD COLUMN referenced_message_id TEXT
         REFERENCES channel_messages(id) ON DELETE SET NULL`,
      `CREATE FUNCTION validate_channel_message_reference()
       RETURNS trigger AS $channel_reference$
       BEGIN
         IF NEW.referenced_message_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM channel_messages target
            WHERE target.id = NEW.referenced_message_id
              AND target.repository_id = NEW.repository_id
         ) THEN
           RAISE EXCEPTION 'channel message reference must target the same repository';
         END IF;
         IF TG_OP = 'UPDATE' THEN
           IF EXISTS (
             SELECT 1 FROM channel_messages source
              WHERE source.referenced_message_id = OLD.id
                AND source.repository_id <> NEW.repository_id
           ) THEN
             RAISE EXCEPTION 'channel message reference must target the same repository';
           END IF;
         END IF;
         RETURN NEW;
       END;
       $channel_reference$ LANGUAGE plpgsql`,
      `CREATE TRIGGER channel_message_reference_validate
       BEFORE INSERT OR UPDATE
       ON channel_messages
       FOR EACH ROW EXECUTE FUNCTION validate_channel_message_reference()`,
      `CREATE INDEX channel_messages_by_reference
         ON channel_messages(referenced_message_id)`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version.
    version: 35,
    name: "queued-task-dependencies",
    statements: [
      `ALTER TABLE submitted_tasks ADD COLUMN after_task_id TEXT
         REFERENCES submitted_tasks(id) ON DELETE SET NULL`,
      `CREATE INDEX submitted_tasks_after_task
         ON submitted_tasks(after_task_id)`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version. Postgres has no
    // COLLATE NOCASE, so the address is stored lowercased by the store.
    version: 36,
    name: "password-resets",
    statements: [
      `CREATE TABLE password_resets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        email TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      )`,
      `CREATE INDEX password_resets_by_user
         ON password_resets(user_id, created_at DESC)`,
      `CREATE INDEX password_resets_by_token ON password_resets(token_hash)`,
    ],
  },
  {
    // Mirrors the SQLite migration of the same version.
    version: 37,
    name: "fresh-token-usage",
    statements: [
      `ALTER TABLE token_usage ADD COLUMN fresh_tokens BIGINT`,
    ],
  },
];
