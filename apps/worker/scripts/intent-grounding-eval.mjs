#!/usr/bin/env node
/**
 * Scores the grounded intent-conflict signal against the team-queue corpus, on
 * one side of the registered split at a time.
 *
 * The split is `intent-holdout.mjs`, unchanged and reused deliberately: it was
 * registered before the *previous* intent signal was written, which makes it
 * older than this one too, and re-drawing it now would throw away the only
 * property that makes the held-out numbers worth anything.
 *
 * What is scored here is not the text of the two intents against each other.
 * Each intent is first grounded against a repository index built from the
 * scenario's own seed — the same index `plan-grounding` resolves hallucinated
 * declarations against — and the pair is judged on where those groundings
 * land. Declared files are never read. That is the whole point: an agent's
 * declarations are the thing the structural evidence classes already use, and
 * the question here is what can be recovered from the sentence alone when they
 * are missing or invented.
 *
 * Usage (from the repository root, after `npx turbo run build`):
 *
 *   node apps/worker/scripts/intent-grounding-eval.mjs --split=development \
 *     docs/benchmarks/data/team-queue/*.json
 *   node apps/worker/scripts/intent-grounding-eval.mjs --split=held-out \
 *     docs/benchmarks/data/team-queue/*.json
 *
 * `--groundings` prints what each task's intent grounded to, restricted to the
 * tasks on the requested side of the split. `--json` writes the per-pair table.
 */

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  TEAM_QUEUE_BANDS,
  TEAM_QUEUE_SCENARIO,
  TEAM_QUEUE_TRUE_CONFLICTS,
} from "./team-queue-scenario.mjs";
import {
  assertRegisteredSeed,
  DEVELOPMENT_AGENTS,
  HELD_OUT_AGENTS,
  splitOf,
  TASK_AGENTS,
} from "./intent-holdout.mjs";

// The tree is an input to this measurement as much as the prose is, and the
// index below is rebuilt from the live scenario on every run. If the seed has
// been edited since these runs were recorded, stop.
assertRegisteredSeed(TEAM_QUEUE_SCENARIO.seed, createHash);

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const fromDist = async (pkg, file) =>
  import(
    `file:///${path.join(REPO_ROOT, pkg, "dist", file).replaceAll("\\", "/")}`
  );

const { RepositoryService } = await fromDist(
  "services/repository-service",
  "index.js",
);
const {
  CodeIntelligenceService,
  groundIntent,
  assessGroundedIntent,
  DEFAULT_INTENT_GROUNDING_OPTIONS,
  DEFAULT_GROUNDED_INTENT_OPTIONS,
} = await fromDist("services/code-intelligence", "index.js");

// The split was registered against a fixed agent assignment. If the scenario is
// edited so that a task changes hands, the recorded split silently stops
// meaning what it says, so refuse rather than re-split.
for (const entry of TEAM_QUEUE_SCENARIO.tasks) {
  const expected = TASK_AGENTS[entry.task.id];
  if (expected !== entry.task.agentId) {
    throw new Error(
      `held-out split is stale: ${entry.task.id} is now owned by ` +
        `${entry.task.agentId}, registered as ${expected}`,
    );
  }
}

const args = process.argv.slice(2);
const files = args.filter((entry) => entry.endsWith(".json"));
const wantedSplit =
  args.find((entry) => entry.startsWith("--split="))?.slice("--split=".length) ??
  "development";
const asJson = args.includes("--json");
const showGroundings = args.includes("--groundings");
const overrides = Object.fromEntries(
  args
    .filter((entry) => entry.startsWith("--opt:"))
    .map((entry) => {
      const [name, value] = entry.slice("--opt:".length).split("=");
      return [name, Number(value)];
    }),
);
if (!["development", "held-out"].includes(wantedSplit)) {
  throw new Error(`--split must be development or held-out, got ${wantedSplit}`);
}
if (files.length === 0) {
  throw new Error("pass one or more team-queue run JSON files");
}

const groundingOptions = { ...DEFAULT_INTENT_GROUNDING_OPTIONS, ...overrides };
const signalOptions = { ...DEFAULT_GROUNDED_INTENT_OPTIONS, ...overrides };

/** The agents whose intent prose this invocation is allowed to look at. */
const visibleAgents =
  wantedSplit === "development" ? DEVELOPMENT_AGENTS : HELD_OUT_AGENTS;

const pairKey = (a, b) => [a, b].sort().join("|");

/** One plan per task: the first revision, which is what first arbitration saw. */
function initialPlans(run) {
  const byTask = new Map();
  for (const entry of run.plans ?? []) {
    if (entry.scenarioTaskId === undefined) {
      continue;
    }
    const current = byTask.get(entry.scenarioTaskId);
    if (current === undefined || entry.revision < current.revision) {
      byTask.set(entry.scenarioTaskId, entry);
    }
  }
  return byTask;
}

/** Which pairs actually contended, from the arm with a common base. */
function observedConflicts(run) {
  if (run.arm !== "uncoordinated") {
    return undefined;
  }
  const files = new Map();
  for (const entry of run.outcome?.patchFiles ?? []) {
    if (entry.scenarioTaskId !== undefined) {
      files.set(entry.scenarioTaskId, new Set(entry.files));
    }
  }
  if (files.size === 0) {
    for (const entry of run.outcome?.merges ?? []) {
      const known = run.tasks.find((task) => task.id === entry.taskId);
      if (known?.scenarioTaskId !== undefined) {
        files.set(known.scenarioTaskId, new Set(entry.conflictedFiles ?? []));
      }
    }
  }
  const ids = [...files.keys()];
  const conflicts = new Set();
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const left = files.get(ids[i]);
      const right = files.get(ids[j]);
      if ([...left].some((file) => right.has(file))) {
        conflicts.add(pairKey(ids[i], ids[j]));
      }
    }
  }
  // `patched` is reported alongside, because observed truth is only defined
  // for a task that produced a changeset. An agent that ran out of budget
  // contends with nothing by construction, and scoring a pair against it
  // charges the signal for the agent's failure rather than for its own.
  return { conflicts, patched: new Set(ids) };
}

/**
 * A repository index over the scenario's seed.
 *
 * Built from `TEAM_QUEUE_SCENARIO.seed` rather than from a recorded artefact
 * so that the index this is grounded against is provably the tree the agents
 * were given — the same bytes the experiment writes into every canonical
 * repository before any task starts.
 */
async function seedIndex() {
  const root = await mkdtemp(path.join(tmpdir(), "intent-grounding-"));
  const sourcePath = path.join(root, "src-repo");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  for (const [file, contents] of Object.entries(TEAM_QUEUE_SCENARIO.seed)) {
    const target = path.join(sourcePath, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  await repositories.commitAll(sourcePath, "seed");
  const canonical = await repositories.importLocalRepository(
    sourcePath,
    path.join(root, "canon.git"),
    "repo_team_queue_intent_grounding",
    "main",
  );
  const intelligence = new CodeIntelligenceService(repositories);
  const index = await intelligence.index(canonical, canonical.branch);
  await rm(root, { recursive: true, force: true });
  return index;
}

const index = await seedIndex();

const runs = [];
for (const file of files) {
  runs.push({
    file: path.basename(file),
    ...JSON.parse(await readFile(file, "utf8")),
  });
}

function matrix(rows, fires) {
  const tp = rows.filter((r) => fires(r) && r.truth).length;
  const fp = rows.filter((r) => fires(r) && !r.truth).length;
  const fn = rows.filter((r) => !fires(r) && r.truth).length;
  const tn = rows.filter((r) => !fires(r) && !r.truth).length;
  return {
    pairs: rows.length,
    positives: tp + fn,
    fired: tp + fp,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    precision: tp + fp === 0 ? undefined : tp / (tp + fp),
    recall: tp + fn === 0 ? undefined : tp / (tp + fn),
  };
}

const format = (m) =>
  `pairs=${String(m.pairs).padStart(3)} pos=${String(m.positives).padStart(2)} ` +
  `fired=${String(m.fired).padStart(2)} TP=${String(m.truePositives).padStart(2)} ` +
  `FP=${String(m.falsePositives).padStart(2)} FN=${String(m.falseNegatives).padStart(2)} ` +
  `precision=${m.precision === undefined ? " n/a" : `${(m.precision * 100).toFixed(0)}%`.padStart(4)} ` +
  `recall=${m.recall === undefined ? " n/a" : `${(m.recall * 100).toFixed(0)}%`.padStart(4)}`;

const pooled = { designed: [], observed: [], "observed (both patched)": [] };
const groundingRows = [];

for (const run of runs) {
  const plans = initialPlans(run);
  const observed = observedConflicts(run);
  const ids = [...plans.keys()].sort();

  const grounded = new Map();
  for (const id of ids) {
    const plan = plans.get(id).plan;
    const text = plan.intent ?? plan.objective;
    grounded.set(id, { text, grounding: groundIntent(text, index, groundingOptions) });
    if (visibleAgents.has(TASK_AGENTS[id])) {
      groundingRows.push({ run: run.file, task: id, ...grounded.get(id) });
    }
  }

  const rows = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      if (splitOf(ids[i], ids[j]) !== wantedSplit) {
        continue;
      }
      const result = assessGroundedIntent(
        grounded.get(ids[i]),
        grounded.get(ids[j]),
        index,
        signalOptions,
      );
      rows.push({
        run: run.file,
        pair: pairKey(ids[i], ids[j]),
        left: ids[i],
        right: ids[j],
        bands: [TEAM_QUEUE_BANDS[ids[i]], TEAM_QUEUE_BANDS[ids[j]]],
        truth: TEAM_QUEUE_TRUE_CONFLICTS.has(pairKey(ids[i], ids[j])),
        observed: observed?.conflicts.has(pairKey(ids[i], ids[j])),
        bothPatched:
          observed !== undefined &&
          observed.patched.has(ids[i]) &&
          observed.patched.has(ids[j]),
        fires: result.fires,
        score: result.score,
        relation: result.relation,
        sharedTargets: result.sharedTargets,
        callTargets: result.callTargets,
        adjacentTargets: result.adjacentTargets,
        corroboration: result.corroboration,
        opposition: result.opposition,
        leftTargets: grounded.get(ids[i]).grounding.targets.map((t) => t.file),
        rightTargets: grounded.get(ids[j]).grounding.targets.map((t) => t.file),
      });
    }
  }
  pooled.designed.push(...rows);
  if (observed !== undefined && observed.conflicts.size > 0) {
    pooled.observed.push(...rows.map((row) => ({ ...row, truth: row.observed })));
    pooled["observed (both patched)"].push(
      ...rows
        .filter((row) => row.bothPatched)
        .map((row) => ({ ...row, truth: row.observed })),
    );
  }

  if (asJson) {
    continue;
  }
  console.log(`\n${"=".repeat(78)}`);
  console.log(`${run.arm} / ${run.label}  —  ${wantedSplit} split`);
  console.log("=".repeat(78));
  console.log(`  grounded intent  ${format(matrix(rows, (r) => r.fires))}`);
  console.log(
    `  shared target only ${format(matrix(rows, (r) => r.relation === "shared"))}`,
  );
}

if (asJson) {
  console.log(
    JSON.stringify(
      { split: wantedSplit, groundingOptions, signalOptions, rows: pooled.designed },
      undefined,
      2,
    ),
  );
} else {
  if (showGroundings) {
    console.log(`\n${"-".repeat(78)}`);
    console.log(`intent groundings — ${wantedSplit} tasks only`);
    console.log("-".repeat(78));
    for (const row of groundingRows) {
      console.log(`  ${row.task} [${row.run}]`);
      console.log(`    ${row.text}`);
      console.log(`    vocabulary: ${row.grounding.vocabulary.join(", ")}`);
      for (const target of row.grounding.targets) {
        console.log(
          `    -> ${target.file} ${target.score.toFixed(3)} ` +
            `(${target.anchors.join(", ")})`,
        );
      }
      for (const note of row.grounding.notes) {
        console.log(`    note: ${note}`);
      }
    }
  }
  for (const [name, rows] of Object.entries(pooled)) {
    if (rows.length === 0) {
      continue;
    }
    console.log(`\n${"-".repeat(78)}`);
    console.log(
      `pooled over ${runs.length} runs — ground truth: ${name} — ${wantedSplit} split`,
    );
    console.log("-".repeat(78));
    console.log(`  grounded intent    ${format(matrix(rows, (r) => r.fires))}`);
    console.log(
      `  shared target only ${format(matrix(rows, (r) => r.relation === "shared"))}`,
    );
  }
  console.log(
    `\noptions: ${JSON.stringify({ ...groundingOptions, ...signalOptions })}`,
  );
  console.log("\nfirings:");
  for (const row of pooled.designed.filter((r) => r.fires)) {
    console.log(
      `  ${row.truth ? "TP" : "FP"} ${row.left} + ${row.right} ` +
        `[${row.bands.join("/")}] ${row.relation} score=${row.score} ` +
        `on ${[...row.sharedTargets, ...row.callTargets, ...row.adjacentTargets].join(", ")} ` +
        `terms=${row.corroboration.join(",")}`,
    );
  }
  console.log("\nmissed real conflicts:");
  for (const row of pooled.designed.filter((r) => !r.fires && r.truth)) {
    console.log(
      `  FN ${row.left} + ${row.right} [${row.bands.join("/")}] ` +
        `left=${row.leftTargets.join(",") || "-"} ` +
        `right=${row.rightTargets.join(",") || "-"}`,
    );
  }
}
