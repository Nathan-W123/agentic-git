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
  {
    // Hosted execution: a task is handed to exactly one remote worker for a
    // bounded time. Without an expiry a worker that dies mid-task strands the
    // work forever, so the lease is what makes remote execution recoverable.
    version: 8,
    name: "remote-workers",
    statements: [
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
      // Only one active lease per task, enforced by the database rather than by
      // application logic, so two workers can never hold the same task.
      `CREATE UNIQUE INDEX work_leases_one_active
         ON work_leases(task_id) WHERE status = 'active'`,
      `CREATE INDEX work_leases_by_worker ON work_leases(worker_id, status)`,
      `CREATE INDEX work_leases_expiring ON work_leases(status, expires_at)`,
      `CREATE INDEX workers_by_user ON workers(user_id, last_seen_at DESC)`,
    ],
  },
  {
    // Declarative per-project coordination policy, stored as opaque JSON.
    // The coordinator interprets it; the store only carries it.
    version: 9,
    name: "project-policy",
    statements: [`ALTER TABLE projects ADD COLUMN policy_json TEXT`],
  },
  {
    // Plan-first remote execution: a worker's plan and the coordinator's
    // answer are recorded on the lease before any editing, so the set of
    // plans currently executing in a repository is readable and a new plan
    // can be arbitrated against it.
    version: 10,
    name: "remote-plan-admission",
    statements: [
      `ALTER TABLE work_leases ADD COLUMN plan_json TEXT`,
      // Plan arbitration reads every active lease in one repository.
      `CREATE INDEX work_leases_by_repository
         ON work_leases(repository_id, status)`,
    ],
  },
  {
    // Audit retention. The log was append-only with no way out, so it grew
    // without bound and every metrics pass walked all of it. Archiving moves
    // the cold front of the chain aside behind a checkpoint that preserves
    // verifiability; the delete trigger becomes conditional on that checkpoint
    // rather than absolute, so history still cannot be quietly dropped.
    version: 11,
    name: "audit-retention",
    statements: [
      `CREATE TABLE audit_checkpoints (
        id TEXT PRIMARY KEY,
        through_sequence INTEGER NOT NULL UNIQUE,
        chain_hash TEXT NOT NULL,
        segment_digest TEXT NOT NULL,
        events INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE audit_archive (
        sequence INTEGER PRIMARY KEY,
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
      // An archived event is as immutable as a live one. Deletion stays
      // possible so an operator can reclaim space; the checkpoint keeps the
      // segment attested afterwards.
      `CREATE TRIGGER audit_archive_immutable_update
        BEFORE UPDATE ON audit_archive
        BEGIN SELECT RAISE(ABORT, 'audit_archive is append-only'); END`,
      `DROP TRIGGER audit_events_immutable_delete`,
      // Deleting a live event is legal only where a checkpoint already covers
      // it, which is exactly the rows archiving has copied aside.
      `CREATE TRIGGER audit_events_prune_guard
        BEFORE DELETE ON audit_events
        BEGIN
          SELECT RAISE(
            ABORT,
            'audit_events may only be pruned below a recorded checkpoint'
          )
          WHERE NOT EXISTS (
            SELECT 1 FROM audit_checkpoints
            WHERE through_sequence >= OLD.sequence
          );
        END`,
      `CREATE INDEX audit_by_task ON audit_events(task_id, sequence)`,
      `CREATE INDEX audit_by_type ON audit_events(type, sequence)`,
      `CREATE INDEX audit_by_time ON audit_events(occurred_at)`,
      `CREATE INDEX audit_archive_by_checkpoint
         ON audit_archive(checkpoint_id, sequence)`,
    ],
  },
  {
    // Review threads on changeset diffs. Distinct from approvals: an approval
    // is one decision with one outcome, while review is a conversation that
    // can happen around a changeset that was never gated at all.
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
    // Model spend, as reported by the agents that incurred it.
    //
    // Separate from the runtime budgets already enforced on leases because it
    // answers a different question: wall-clock says how long a task held a
    // worker, tokens say what it cost. Rows are per (task, phase, worker
    // report) rather than aggregated, so a project total is a sum that can
    // always be broken back down — and so a re-report of the same running
    // total replaces its predecessor instead of double-counting, which is
    // what `usage_key` uniqueness is for.
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
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        recorded_at TEXT NOT NULL
      )`,
      `CREATE INDEX token_usage_by_task ON token_usage(task_id, recorded_at)`,
      `CREATE INDEX token_usage_by_project
         ON token_usage(project_id, recorded_at)`,
    ],
  },
  {
    // Workers belong to an organization, not to whoever started the process.
    //
    // A fleet is something a team operates, so seeing it has to be a property
    // of membership; filtering a platform-wide list by `user_id` made every
    // colleague's worker invisible and made the query's correctness depend on
    // the caller remembering to filter at all.
    //
    // Nullable on purpose. Existing rows are backfilled from their owner's
    // earliest membership, but a worker whose owner belongs to no organization
    // has no defensible tenant to be assigned to, and inventing one would put
    // it in a fleet nobody registered it with. NULL matches no organization
    // filter, so those rows fail closed instead.
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
    // How a person's agents are drawn, stored on the user rather than in the
    // browser.
    //
    // The colour is an identity signal, not a local preference: the point of
    // choosing one is that colleagues can tell whose agents are whose on the
    // coordinator's shared views. A value only the chooser could see would
    // answer no question anyone has. Nullable, because "never chose" is a real
    // state and the interface derives a stable default from the user id.
    version: 15,
    name: "user-appearance",
    statements: [`ALTER TABLE users ADD COLUMN appearance TEXT`],
  },
  {
    // Bringing somebody new onto a team.
    //
    // Adding a member requires an account that already exists, and creating an
    // account requires a system administrator — so an organization owner had
    // no way at all to bring in a colleague. An invitation is the missing
    // half: it names an email and a role, carries a secret the recipient
    // presents once, and creates the account at the moment it is accepted.
    //
    // The secret is stored hashed, exactly like an API token, because a
    // readable invitations table would otherwise be a list of working keys to
    // every organization.
    version: 16,
    name: "organization-invitations",
    statements: [
      `CREATE TABLE invitations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        email TEXT NOT NULL COLLATE NOCASE,
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
    // Per-repository role labels (`channel_agent_overrides.role`) and opt-in
    // channel membership. Before this, `channelAgentConnections` in
    // server.ts treated every agent any collaborator had connected as
    // present in every repository's channel automatically; membership rows
    // narrow that to an explicit allowlist. `channel_membership_backfills`
    // exists solely so the switch to opt-in does not make an
    // already-working agent silently vanish from a channel it was already
    // active in — the first post-migration read of a repository's roster
    // grandfathers in whatever was visible then, once, and never again (see
    // `channelAgentConnections`'s doc comment for the full reasoning and the
    // tradeoff that choice accepts).
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
    // Who created a repository, so deletion and repository-scoped promotion
    // can give the creator an additional path in alongside the ordinary
    // manage_project/manage_members permission check — never a replacement
    // for it, so an org admin who did not create a repository keeps full
    // access. Nullable: existing rows predate this feature, and there is no
    // honest way to backfill who created them, so they fall back to
    // requiring manage_project with no creator shortcut.
    version: 21,
    name: "repository-creator",
    statements: [
      `ALTER TABLE repositories ADD COLUMN created_by TEXT REFERENCES users(id)`,
    ],
  },
  {
    // How far each repository's auditor has looked. One row per repository,
    // not per (repository, agent): the auditor is one to a repository by
    // construction, and keying on the agent would restart the audit history
    // from zero every time the role changed hands — re-auditing everything
    // already reported, on the new holder's account.
    version: 22,
    name: "auditor-cursor",
    statements: [
      `CREATE TABLE auditor_cursors (
        repository_id TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    // Auditing switched off per repository without demoting the agent. The
    // default is off-the-switch, not paused: an existing auditor keeps
    // auditing across this migration, which is what its operator already
    // agreed to.
    version: 23,
    name: "auditor-paused",
    statements: [
      `ALTER TABLE auditor_cursors ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`,
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
    // What the request was asked inside, as against what it asked for.
    //
    // A task dispatched from a thread arrives with an objective and nothing
    // else, so "now do the same for the other file" reaches the agent with no
    // idea what "the same" refers to. The transcript cannot go in the
    // objective — that text is rendered in the channel, in task lists and in
    // thread titles — so it gets a column of its own.
    //
    // Nullable: every existing row predates this and has nothing to say.
    version: 25,
    name: "submitted-task-context",
    statements: [
      `ALTER TABLE submitted_tasks ADD COLUMN context TEXT`,
    ],
  },
  {
    // What a thread's work actually changed, kept with the thread.
    //
    // The link from a thread to its task lived only in the watcher's memory,
    // so a restart lost it — and this deployment restarts on every deploy.
    // Recording it makes the thread able to answer "what did this change?"
    // for as long as the thread exists, rather than for as long as the
    // process does.
    //
    // The summary is stored beside it rather than recomputed from the audit
    // log on every read: the log is archived and pruned, and a thread that
    // silently lost its file list once the archiver ran would be worse than
    // one that never had it.
    version: 26,
    name: "channel-message-task-changes",
    statements: [
      `ALTER TABLE channel_messages ADD COLUMN task_id TEXT`,
      `ALTER TABLE channel_messages ADD COLUMN changed_files_json TEXT`,
    ],
  },
  {
    // One person to one person, off the shared channel.
    //
    // Not a channel with two members. A channel belongs to a repository and is
    // readable by everyone who can read that repository, which is the whole
    // point of it and exactly wrong here — the authorization question for a
    // direct message is "are you one of the two", and answering it from
    // repository access would mean either widening who can read a private
    // message or bolting an exception onto the surface that grants it.
    //
    // `pair_key` is the two ids sorted and joined, so a conversation has one
    // identity no matter who is looking at it: without it, reading a thread
    // means matching (author, recipient) OR (recipient, author) and no index
    // covers both halves. The separator is a character no id contains.
    //
    // Project-scoped, like every other route here. A direct message is
    // arguably a fact about two people rather than about a project, but all
    // navigation and every authorization helper in the gateway is
    // project-scoped, and inventing a second scope for one table would be a
    // larger change than the feature.
    //
    // `read_at` is per message rather than a high-water mark per conversation,
    // because the unread count is the thing the badge needs and a mark would
    // make it a subtraction against a position that moves.
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
    // A conversational task is one turn of a thread, and the turns share an
    // identity — the thread root's message id. It goes on the task rather
    // than in anyone's memory because the coordinator's map of open
    // conversations dies with its process, while "this thread's task is
    // waiting for a reply" has to survive a deploy.
    //
    // `opened_at` is when the task went `open` (a status, not a column —
    // status is untyped TEXT here on purpose, like every status in this
    // schema). Between turns no lease is active and nothing heartbeats, so
    // abandoned conversations are swept by their own clock rather than by
    // the lease expiry that covers every other kind of held work.
    //
    // Both nullable: every existing row is a one-shot task and stays one.
    version: 28,
    name: "conversational-tasks",
    statements: [
      `ALTER TABLE submitted_tasks ADD COLUMN conversation_id TEXT`,
      `ALTER TABLE submitted_tasks ADD COLUMN opened_at TEXT`,
      `CREATE INDEX submitted_tasks_conversation
        ON submitted_tasks (conversation_id, status)`,
    ],
  },
];
export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);
