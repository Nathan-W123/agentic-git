import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createId,
  type AgentPlan,
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
  type ResourceLease,
  type RiskLevel,
  type TaskDefinition,
  type TaskId,
  type TaskStatus,
  type TestResult,
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
  AppendAuditInput,
  CoordinationStore,
  CreateRunInput,
  RunDetail,
  RunMode,
  RunStatus,
  SessionRecord,
  StoredRun,
  StoredTask,
  StoredWorkspace,
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

  public async createRun(input: CreateRunInput): Promise<StoredRun> {
    const startedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO repositories (id, path, branch, first_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET path = excluded.path, branch = excluded.branch`,
      )
      .run(
        input.repository.id,
        input.repository.path,
        input.repository.branch,
        startedAt,
      );

    const run: StoredRun = {
      id: createId("run"),
      repositoryId: input.repository.id,
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
        `INSERT INTO runs (id, repository_id, mode, scenario, status, started_at, base_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.repositoryId,
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
    this.db
      .prepare(
        `UPDATE runs SET status = ?, finished_at = ?, final_revision = ? WHERE id = ?`,
      )
      .run(status, new Date().toISOString(), finalVersion?.revision ?? null, runId);

    if (finalVersion !== undefined) {
      const row = this.db
        .prepare("SELECT repository_id FROM runs WHERE id = ?")
        .get(runId) as Row | undefined;
      if (row !== undefined) {
        await this.saveCanonicalVersion(text(row, "repository_id"), finalVersion);
      }
    }
  }

  public async saveTask(runId: string, task: TaskDefinition): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tasks (run_id, id, objective, agent_id, status, validation_commands_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, id) DO UPDATE SET
           objective = excluded.objective,
           agent_id = excluded.agent_id`,
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
    this.db
      .prepare(`UPDATE tasks SET plan_json = ?, status = ? WHERE run_id = ? AND id = ?`)
      .run(JSON.stringify(plan), "planning", runId, taskId);
  }

  public async saveSession(runId: string, session: SessionRecord): Promise<void> {
    this.db
      .prepare(
        `UPDATE tasks SET session_id = ?, session_started_at = ? WHERE run_id = ? AND id = ?`,
      )
      .run(session.id, session.startedAt, runId, session.taskId);
  }

  public async saveDecision(
    runId: string,
    decision: CoordinatorDecision,
  ): Promise<void> {
    this.db
      .prepare(`UPDATE tasks SET decision_json = ? WHERE run_id = ? AND id = ?`)
      .run(JSON.stringify(decision), runId, decision.taskId);
  }

  public async saveTaskStatus(
    runId: string,
    taskId: TaskId,
    status: TaskStatus,
    explanation?: string,
  ): Promise<void> {
    this.db
      .prepare(`UPDATE tasks SET status = ?, explanation = ? WHERE run_id = ? AND id = ?`)
      .run(status, explanation ?? null, runId, taskId);
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
      this.db
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
            candidate_revision, validation_json, explanation, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

    return event;
  }

  public async listRuns(limit = 50): Promise<StoredRun[]> {
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

  private toRun(row: Row): StoredRun {
    return {
      id: text(row, "id"),
      repositoryId: text(row, "repository_id"),
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
      status: text(row, "status") as TaskStatus,
      explanation: optionalText(row, "explanation"),
      plan: optionalJson<AgentPlan>(row, "plan_json"),
      decision: optionalJson<CoordinatorDecision>(row, "decision_json"),
      sessionId: optionalText(row, "session_id"),
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
