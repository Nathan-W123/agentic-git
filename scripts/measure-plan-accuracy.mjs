#!/usr/bin/env node
/**
 * Would a cheap plan be cheap?
 *
 * The solo fast path already skips the coordinator's own analysis, so the
 * remaining cost of starting a task is the agent's planning round trip. The
 * proposal on the table is to ask a *thin* question when a task is alone in
 * its repository — just the files — and to escalate to a full plan only if
 * another agent turns up and the thin claim turns out to be short.
 *
 * Whether that saves time or merely relocates it depends on three numbers
 * this repository already records and has never been asked for:
 *
 *   1. How often a plan's declared files covered what the changeset really
 *      touched. A plan that was already right would have been just as right
 *      if it had been cheaper to produce.
 *   2. How often a task widened its scope mid-run, or replanned. Each one is
 *      the round trip a thin plan would make more likely.
 *   3. How often a task ran alone in its repository. Only those tasks can
 *      take the cheap path at all, and only they collect the saving.
 *
 * Read-only, and safe against a live coordinator: nothing here takes a write
 * lock, and every query is a plain select.
 *
 *   node scripts/measure-plan-accuracy.mjs                 # sqlite, default path
 *   node scripts/measure-plan-accuracy.mjs --db=/data/.coordinator/coordinator.db
 *   COORD_DATABASE_URL=postgres://… node scripts/measure-plan-accuracy.mjs
 *   node scripts/measure-plan-accuracy.mjs --json=out.json
 */

import { writeFile } from "node:fs/promises";

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((entry) => entry.startsWith(`${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 1);
}

const DATABASE_URL = process.env["COORD_DATABASE_URL"]?.trim() ?? "";
const DB = arg("--db", ".coordinator/coordinator.db");
const JSON_OUT = arg("--json", undefined);

/**
 * One reader over either backend.
 *
 * The two stores share a schema — same tables, same columns — so the queries
 * below are written once. Only the placeholder syntax differs, and none of
 * these need parameters.
 */
async function openReader() {
  if (DATABASE_URL.length > 0) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    return {
      kind: "postgres",
      query: async (sql) => (await client.query(sql)).rows,
      close: async () => await client.end(),
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(DB, { readOnly: true });
  return {
    kind: `sqlite (${DB})`,
    query: async (sql) => db.prepare(sql).all(),
    close: async () => db.close(),
  };
}

const reader = await openReader();

try {
  // What each plan revision declared, newest revision last so the reduce
  // below keeps revision 1 — the claim a *first* planning call produced,
  // which is the one a thin plan would be replacing.
  // Keyed by run *and* task: a task id is only unique inside its run, and a
  // conversational task keeps the same id across every turn it runs. Keying
  // on the id alone would fold several separate planning episodes into one
  // and score each against the wrong changeset.
  const key = (runId, taskId) => `${runId}\u0000${taskId}`;
  const revisions = await reader.query(`
    select run_id, task_id, revision, plan_json
      from task_plan_revisions
     order by run_id, task_id, revision
  `);
  const declaredByTask = new Map();
  const revisionCount = new Map();
  for (const row of revisions) {
    const id = key(row.run_id, row.task_id);
    revisionCount.set(id, (revisionCount.get(id) ?? 0) + 1);
    if (declaredByTask.has(id)) {
      continue;
    }
    let files = [];
    try {
      files = JSON.parse(row.plan_json)?.expectedFiles ?? [];
    } catch {
      files = [];
    }
    declaredByTask.set(id, new Set(files));
  }

  // What the changeset actually touched.
  const changesets = await reader.query(
    "select id, run_id, task_id from changesets",
  );
  const patches = await reader.query(
    "select changeset_id, path from file_patches",
  );
  const pathsByChangeset = new Map();
  for (const row of patches) {
    const entry = pathsByChangeset.get(row.changeset_id) ?? [];
    entry.push(row.path);
    pathsByChangeset.set(row.changeset_id, entry);
  }
  const touchedByTask = new Map();
  for (const row of changesets) {
    const id = key(row.run_id, row.task_id);
    const entry = touchedByTask.get(id) ?? new Set();
    for (const path of pathsByChangeset.get(row.id) ?? []) {
      entry.add(path);
    }
    touchedByTask.set(id, entry);
  }

  // Mid-run corrections: the cost a thin plan would make more likely.
  const corrections = await reader.query(`
    select run_id, task_id, type
      from audit_events
     where type in ('scope_change_requested', 'replan_requested')
  `);
  const widened = new Set();
  const replanned = new Set();
  for (const row of corrections) {
    (row.type === "scope_change_requested" ? widened : replanned).add(
      key(row.run_id, row.task_id),
    );
  }

  // Solo or crowded: how many tasks its run carried. A run with one task had
  // nobody to arbitrate against, which is exactly the population that can
  // take a cheap plan.
  const runSizes = await reader.query(`
    select run_id, count(*) as task_count
      from tasks
     group by run_id
  `);
  const sizeByRun = new Map(
    runSizes.map((row) => [row.run_id, Number(row.task_count)]),
  );
  const taskRuns = await reader.query("select run_id, id from tasks");

  let scored = 0;
  let covered = 0;
  let extraFiles = 0;
  let soloTasks = 0;
  const misses = [];
  for (const row of taskRuns) {
    if ((sizeByRun.get(row.run_id) ?? 0) <= 1) {
      soloTasks += 1;
    }
    const declared = declaredByTask.get(key(row.run_id, row.id));
    const touched = touchedByTask.get(key(row.run_id, row.id));
    if (declared === undefined || touched === undefined || touched.size === 0) {
      continue;
    }
    scored += 1;
    const outside = [...touched].filter((path) => !declared.has(path));
    if (outside.length === 0) {
      covered += 1;
    } else {
      extraFiles += outside.length;
      misses.push({ runId: row.run_id, taskId: row.id, outside });
    }
  }

  const pct = (part, whole) =>
    whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;
  const totalTasks = taskRuns.length;

  const report = {
    source: reader.kind,
    tasksRecorded: totalTasks,
    tasksScored: scored,
    planCoveredActuals: covered,
    planCoveredActualsPct: pct(covered, scored),
    tasksWithFilesOutsideThePlan: scored - covered,
    extraFilesTotal: extraFiles,
    tasksThatWidenedMidRun: widened.size,
    tasksThatReplanned: replanned.size,
    tasksWithMoreThanOnePlanRevision: [...revisionCount.values()].filter(
      (count) => count > 1,
    ).length,
    soloTasks,
    soloTasksPct: pct(soloTasks, totalTasks),
  };

  console.log("");
  console.log(`Source: ${report.source}`);
  console.log(`Tasks recorded: ${report.tasksRecorded}`);
  console.log("");
  console.log("1. Was the plan already right?");
  console.log(`   scored (had both a plan and a changeset): ${report.tasksScored}`);
  console.log(
    `   plan covered every file touched:          ${report.planCoveredActuals} (${report.planCoveredActualsPct})`,
  );
  console.log(
    `   touched files it never declared:          ${report.tasksWithFilesOutsideThePlan} tasks, ${report.extraFilesTotal} files`,
  );
  console.log("");
  console.log("2. How often was a correction needed mid-run?");
  console.log(`   widened scope:        ${report.tasksThatWidenedMidRun}`);
  console.log(`   replanned:            ${report.tasksThatReplanned}`);
  console.log(`   >1 plan revision:     ${report.tasksWithMoreThanOnePlanRevision}`);
  console.log("");
  console.log("3. How much work could take the cheap path at all?");
  console.log(`   tasks that ran alone: ${report.soloTasks} (${report.soloTasksPct})`);
  console.log("");
  console.log("Read it like this: a high (1) with a low (2) means plans are");
  console.log("already accurate, so a thinner one has room to stay accurate.");
  console.log("A low (1) means the deep plan is earning its cost and a thin");
  console.log("one would mostly relocate the wait. (3) caps the whole prize.");
  if (misses.length > 0) {
    console.log("");
    console.log("Files touched but never declared (first 10):");
    for (const miss of misses.slice(0, 10)) {
      console.log(`  ${miss.taskId}: ${miss.outside.join(", ")}`);
    }
  }
  console.log("");

  if (JSON_OUT !== undefined) {
    await writeFile(JSON_OUT, `${JSON.stringify({ ...report, misses }, null, 2)}\n`);
    console.log(`Wrote ${JSON_OUT}`);
  }
} finally {
  await reader.close();
}
