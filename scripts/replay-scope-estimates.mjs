#!/usr/bin/env node
/**
 * Does the intake scope estimate resemble reality?
 *
 * This is item 1 of the verification plan in `docs/architecture/task-decomposition.md`,
 * and the only one that can be answered without ever enabling a split or
 * running an agent. The estimate is the load-bearing assumption underneath
 * decomposition: every veto, every module grouping, and every contention
 * comparison reads it. If it does not track what tasks actually touch, nothing
 * built on top of it can be right for the right reason.
 *
 * The replay is against runs that already happened. For each recorded plan
 * revision the coordinator stored, we have three things it never compared:
 *
 *   1. the objective text the human submitted,
 *   2. the files the agent's plan *declared* at that canonical revision,
 *   3. the files the resulting changeset *actually touched*.
 *
 * `estimateScope` is re-run against a real index of the real repository at the
 * exact canonical revision the plan was made against, and its answer is scored
 * against (2) and (3). Splitting stays off throughout — this measures the input
 * to the decision, not the decision.
 *
 * Scoring is per-task, reported as precision (of the files the estimate named,
 * how many were really touched) and recall (of the files really touched, how
 * many the estimate named). Recall is the number that matters for
 * decomposition: an estimate that misses most of a task's real footprint will
 * group modules wrongly and read contention against a scope that does not
 * exist.
 *
 * Run after building:
 *   npx turbo run build
 *   node scripts/replay-scope-estimates.mjs [--db <path>] [--json <out>]
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const load = async (relative) =>
  import(pathToFileURL(path.resolve(relative)).href);

const { estimateScope, decomposeTask } = await load(
  "services/coordinator/dist/index.js",
);
const { CodeIntelligenceService } = await load(
  "services/code-intelligence/dist/index.js",
);
const { RepositoryService } = await load(
  "services/repository-service/dist/index.js",
);

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
}

const DB = arg("--db", ".coordinator/coordination.db");
const JSON_OUT = arg("--json", undefined);

/**
 * Reads the recorded runs out of the coordination store.
 *
 * Opened read-only: this is a one-shot analysis over a store another process
 * may still be writing to, and nothing here should ever take a write lock on a
 * live coordinator's database.
 */
const db = new DatabaseSync(DB, { readOnly: true });
const query = (sql) => db.prepare(sql).all();

const repositories = new Map(
  query("select id, path, branch from repositories").map((row) => [
    row.id,
    { id: row.id, path: row.path, branch: row.branch },
  ]),
);

/**
 * One replayable observation: an objective, the revision it was planned
 * against, what the plan declared, and what the changeset touched.
 *
 * A plan revision is the unit rather than a task, because a task that replanned
 * against new canonical change made a *different* scope claim each time and the
 * estimate should be scored against each. Where a task has several revisions,
 * only the one whose canonical revision matches the changeset's base is scored
 * against actuals; the rest are scored against their declaration only.
 */
const planRevisions = query(`
  select pr.run_id, pr.task_id, pr.revision, pr.reason, pr.canonical_revision,
         pr.plan_json, t.objective, r.repository_id
    from task_plan_revisions pr
    join runs r on r.id = pr.run_id
    left join tasks t on t.run_id = pr.run_id and t.id = pr.task_id
   order by pr.task_id, pr.revision
`);

const changesets = query(`
  select cs.id, cs.run_id, cs.task_id, cs.base_revision
    from changesets cs
`);
const patchesByChangeset = new Map();
for (const row of query(
  "select changeset_id, path from file_patches order by changeset_id, ordinal",
)) {
  const entry = patchesByChangeset.get(row.changeset_id) ?? [];
  entry.push(row.path);
  patchesByChangeset.set(row.changeset_id, entry);
}

const actualByRunTask = new Map();
for (const cs of changesets) {
  actualByRunTask.set(`${cs.run_id}\0${cs.task_id}`, {
    base: cs.base_revision,
    paths: patchesByChangeset.get(cs.id) ?? [],
  });
}

const intelligence = new CodeIntelligenceService(new RepositoryService());

function score(estimated, truth) {
  const est = new Set(estimated);
  const real = new Set(truth);
  if (real.size === 0) {
    return undefined;
  }
  let hit = 0;
  for (const entry of real) {
    if (est.has(entry)) {
      hit += 1;
    }
  }
  return {
    overlap: hit,
    estimated: est.size,
    actual: real.size,
    precision: est.size === 0 ? 0 : hit / est.size,
    recall: hit / real.size,
  };
}

const rows = [];
for (const revision of planRevisions) {
  const repository = repositories.get(revision.repository_id);
  if (repository === undefined || !revision.objective) {
    continue;
  }
  let plan;
  try {
    plan = JSON.parse(revision.plan_json ?? "null");
  } catch {
    plan = null;
  }
  const declared = plan?.expectedFiles ?? [];

  let index;
  try {
    index = await intelligence.index(repository, revision.canonical_revision);
  } catch (error) {
    rows.push({
      taskId: revision.task_id,
      runId: revision.run_id,
      revision: revision.revision,
      error: String(error?.message ?? error),
    });
    continue;
  }

  const estimate = estimateScope(revision.objective, index);
  const estimatedPaths = estimate.files.map((file) => file.path);

  /**
   * The estimator can only ever name a file that exists at the revision it
   * indexed. A task that creates its footprint — "generate the backend" against
   * a repository holding one README — is therefore unscoreable by construction,
   * and pooling it with the rest would blame the estimator for a limit of the
   * method rather than a failure of it. Scoring it separately is the only way
   * to tell "cannot localize" apart from "nothing to localize yet".
   */
  const existing = new Set(index.paths);
  const preexisting = (paths) => paths.filter((entry) => existing.has(entry));

  const actual = actualByRunTask.get(`${revision.run_id}\0${revision.task_id}`);
  // Actuals are only comparable when the changeset was built from the same
  // canonical revision this plan was made against; otherwise the repository the
  // estimate saw is not the repository the agent edited.
  const comparableActual =
    actual !== undefined && actual.base === revision.canonical_revision
      ? actual.paths
      : undefined;

  rows.push({
    taskId: revision.task_id,
    runId: revision.run_id,
    revision: revision.revision,
    reason: revision.reason,
    objective: revision.objective,
    canonicalRevision: revision.canonical_revision,
    confidence: estimate.confidence,
    tokens: estimate.tokens,
    namedPaths: estimate.namedPaths,
    namedDirectories: estimate.namedDirectories,
    indexedFiles: index.files.length,
    estimated: estimatedPaths,
    declared,
    actual: comparableActual,
    modules: estimate.modules.map((module) => ({
      root: module.root,
      files: module.files.length,
    })),
    repositoryFiles: index.paths.length,
    // What the policy would have done with this estimate, had splitting been
    // enabled. Accuracy only matters through this decision, and `always` is
    // used rather than `contended` because the recorded runs carry no
    // concurrent queue to read contention from — this reports the vetoes that
    // are properties of the objective itself.
    wouldSplit: decomposeTask({
      objective: revision.objective,
      estimate,
      index,
      options: { mode: "always" },
    }),
    declaredExisting: preexisting(declared).length,
    actualExisting:
      comparableActual === undefined
        ? undefined
        : preexisting(comparableActual).length,
    vsDeclared: score(estimatedPaths, declared),
    vsActual:
      comparableActual === undefined
        ? undefined
        : score(estimatedPaths, comparableActual),
    // The same comparison restricted to files that already existed, i.e. the
    // part of the footprint the estimator was ever in a position to name.
    vsDeclaredExisting: score(estimatedPaths, preexisting(declared)),
    vsActualExisting:
      comparableActual === undefined
        ? undefined
        : score(estimatedPaths, preexisting(comparableActual)),
    discarded: estimate.notes.filter((note) => note.includes("discarded")),
  });
}

function summarize(label, key) {
  const scored = rows.filter((row) => row[key] !== undefined);
  if (scored.length === 0) {
    console.log(`\n${label}: no comparable observations`);
    return;
  }
  const mean = (pick) =>
    scored.reduce((sum, row) => sum + pick(row[key]), 0) / scored.length;
  // Micro-averaged: pooled overlap over pooled totals, so a task with a large
  // footprint counts for more than one that touched a single file. The
  // macro average above it treats every task alike; they answer different
  // questions and disagreeing is informative.
  const pooled = scored.reduce(
    (acc, row) => ({
      overlap: acc.overlap + row[key].overlap,
      estimated: acc.estimated + row[key].estimated,
      actual: acc.actual + row[key].actual,
    }),
    { overlap: 0, estimated: 0, actual: 0 },
  );
  console.log(`\n${label}  (n=${scored.length})`);
  console.log(
    `  macro precision ${mean((s) => s.precision).toFixed(3)}   ` +
      `macro recall ${mean((s) => s.recall).toFixed(3)}`,
  );
  console.log(
    `  micro precision ${(pooled.overlap / Math.max(1, pooled.estimated)).toFixed(3)}   ` +
      `micro recall ${(pooled.overlap / Math.max(1, pooled.actual)).toFixed(3)}` +
      `   (${pooled.overlap} of ${pooled.actual} touched files named)`,
  );
  const zero = scored.filter((row) => row[key].recall === 0).length;
  const full = scored.filter((row) => row[key].recall === 1).length;
  console.log(
    `  recall = 0 on ${zero}/${scored.length} observations; recall = 1 on ${full}/${scored.length}`,
  );
}

console.log(`replaying ${rows.length} recorded plan revisions from ${DB}`);

const byConfidence = new Map();
for (const row of rows) {
  const key = row.confidence ?? "error";
  byConfidence.set(key, (byConfidence.get(key) ?? 0) + 1);
}
console.log("\nestimate confidence over recorded objectives");
for (const [confidence, count] of [...byConfidence].sort()) {
  console.log(`  ${confidence.padEnd(9)} ${count}`);
}

summarize("estimate vs. what the plan DECLARED", "vsDeclared");
summarize("estimate vs. what the changeset TOUCHED", "vsActual");

console.log(
  "\n--- restricted to files that already existed at the canonical revision ---",
);
console.log(
  "  (a file the task created cannot be named by an estimator reading the index)",
);
summarize("estimate vs. DECLARED, pre-existing only", "vsDeclaredExisting");
summarize("estimate vs. TOUCHED, pre-existing only", "vsActualExisting");

const creation = rows.filter(
  (row) => row.actual !== undefined && row.actualExisting === 0,
);
console.log(
  `\n${creation.length} of ${rows.filter((row) => row.actual !== undefined).length} ` +
    "observations with a changeset touched no pre-existing file at all " +
    "(pure creation; unscoreable by construction)",
);

console.log(
  "\nwhat the split policy would have decided (mode=always, so these are the " +
    "objective's own vetoes)",
);
const decisions = new Map();
for (const row of rows) {
  if (row.wouldSplit === undefined) {
    continue;
  }
  const key = `${row.wouldSplit.split ? "SPLIT" : "no split"}: ${row.wouldSplit.reason}`;
  decisions.set(key, (decisions.get(key) ?? 0) + 1);
}
for (const [key, count] of [...decisions].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}  ${key}`);
}

console.log("\nper-observation");
for (const row of rows) {
  if (row.error) {
    console.log(`  ${row.taskId.slice(0, 18)} r${row.revision}  ERROR ${row.error}`);
    continue;
  }
  const fmt = (s) =>
    s === undefined ? "     —      " : `p=${s.precision.toFixed(2)} r=${s.recall.toFixed(2)}`;
  console.log(
    `  ${row.taskId.slice(0, 18)} r${row.revision} ${row.confidence.padEnd(8)} ` +
      `est=${String(row.estimated.length).padStart(2)} ` +
      `decl=${String(row.declared.length).padStart(2)} ` +
      `act=${String(row.actual?.length ?? 0).padStart(2)}  ` +
      `declared:${fmt(row.vsDeclared)}  actual:${fmt(row.vsActual)}  ` +
      `"${row.objective.slice(0, 46)}"`,
  );
}

if (JSON_OUT !== undefined) {
  writeFileSync(JSON_OUT, `${JSON.stringify({ db: DB, rows }, undefined, 2)}\n`);
  console.log(`\nwrote ${JSON_OUT}`);
}
