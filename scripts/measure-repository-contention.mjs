#!/usr/bin/env node
/**
 * How often a task is not alone in its repository.
 *
 * The blanket-claim fast path is worth exactly what solitude is worth: a task
 * with nobody else in its repository never has to describe itself, and a task
 * that meets somebody pays the narrowing instead. So the number that decides
 * whether the design is mostly upside is the share of executions that
 * overlapped another execution in the same repository.
 *
 * Read entirely from durable state — the work leases are the executions, and
 * their issue/finish times are the intervals — so it can be re-run against any
 * control plane's database without instrumenting anything.
 *
 * Usage: node scripts/measure-repository-contention.mjs [--database <path>] [--json]
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const databasePath = path.resolve(
  argument(
    "database",
    process.env["COORD_DATABASE"] ?? ".coordinator/coordination.db",
  ),
);
const asJson = process.argv.includes("--json");

const db = new DatabaseSync(databasePath, { readOnly: true });

/**
 * A lease's execution window. `finished_at` is absent for a lease that lapsed
 * rather than settled, and its expiry is then the last moment it could have
 * been executing — the generous end, so contention is never undercounted.
 */
const leases = db
  .prepare(
    `SELECT id, task_id, repository_id, status, issued_at,
            COALESCE(finished_at, expires_at) AS ended_at,
            plan_json IS NOT NULL AS had_plan
       FROM work_leases
      ORDER BY repository_id, issued_at`,
  )
  .all();

const byRepository = new Map();
for (const lease of leases) {
  const key = lease.repository_id ?? "(none)";
  const bucket = byRepository.get(key) ?? [];
  bucket.push({
    id: lease.id,
    taskId: lease.task_id,
    from: Date.parse(lease.issued_at),
    to: Date.parse(lease.ended_at),
    hadPlan: lease.had_plan === 1,
  });
  byRepository.set(key, bucket);
}

let contended = 0;
let solo = 0;
/**
 * Alone at the moment of starting, which is the population a blanket claim is
 * actually offered to — distinct from being alone for the whole execution,
 * which is the population that never has to be narrowed.
 */
let aloneAtStart = 0;
const perRepository = [];
for (const [repositoryId, bucket] of byRepository) {
  let repositoryContended = 0;
  for (const lease of bucket) {
    const overlaps = bucket.some(
      (other) =>
        other.id !== lease.id &&
        other.from < lease.to &&
        lease.from < other.to,
    );
    if (overlaps) {
      repositoryContended += 1;
      contended += 1;
    } else {
      solo += 1;
    }
    if (
      !bucket.some(
        (other) =>
          other.id !== lease.id &&
          other.from <= lease.from &&
          lease.from < other.to,
      )
    ) {
      aloneAtStart += 1;
    }
  }
  perRepository.push({
    repositoryId,
    leases: bucket.length,
    contended: repositoryContended,
  });
}

/**
 * The same question asked of the admission record rather than the lease
 * intervals, as a cross-check: an admission that named a blocker, or that was
 * decided while another lease already carried an approved plan, is one the
 * blanket path would have had to freeze.
 */
const admissions = db
  .prepare(
    `SELECT data_json FROM audit_events WHERE type = 'plan_admitted'`,
  )
  .all();
let admissionsWithBlockers = 0;
for (const row of admissions) {
  try {
    const data = JSON.parse(row.data_json) ?? {};
    if (Array.isArray(data.blockedBy) && data.blockedBy.length > 0) {
      admissionsWithBlockers += 1;
    }
  } catch {
    // A payload this cannot read says nothing either way.
  }
}

const total = contended + solo;
const report = {
  database: databasePath,
  leases: total,
  solo,
  aloneAtStart,
  contended,
  contendedShare: total === 0 ? 0 : Number((contended / total).toFixed(4)),
  repositories: byRepository.size,
  admissionsRecorded: admissions.length,
  admissionsWithBlockers,
  busiestRepositories: perRepository
    .sort((first, second) => second.contended - first.contended)
    .slice(0, 5),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`database             ${report.database}`);
  console.log(`executions           ${report.leases}`);
  console.log(`alone in repository  ${report.solo}`);
  console.log(`alone when they began ${report.aloneAtStart}`);
  console.log(
    `overlapped another   ${report.contended} ` +
      `(${(report.contendedShare * 100).toFixed(1)}%)`,
  );
  console.log(`repositories         ${report.repositories}`);
  console.log(
    `admissions recorded  ${report.admissionsRecorded} ` +
      `(${report.admissionsWithBlockers} named a blocker)`,
  );
}
db.close();
