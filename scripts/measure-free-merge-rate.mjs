#!/usr/bin/env node
/**
 * How often does re-grading a race loser actually buy a free merge?
 *
 * `acceptWorkResult` used to requeue any result whose integration came back
 * stale, unconditionally: losing the compare-and-swap at the end of promotion
 * meant paying for an agent replan no matter how unrelated the advance that
 * beat it was. It now re-grades the result against that advance, up to
 * `STALE_REASSESSMENT_BUDGET` times, and lets a purely textual overlap try a
 * free three-way merge.
 *
 * The unit tests prove the two ends of that behaviour — a disjoint loser merges,
 * an overlapping loser still replans. Neither says how often the new path fires,
 * because a rate is not a property one example can carry. This harness drives
 * many independent pairs through the real code and counts.
 *
 * Nothing here is scripted, stubbed, or modelled:
 *
 *   - every pair gets its own real Git repository, its own canonical branch,
 *     and its own worktrees;
 *   - the competing advance is a real commit really promoted to canonical, in
 *     the window between the caller's canonical read and the integration's own,
 *     which is what makes the result genuinely stale rather than merely
 *     overtaken;
 *   - the integration, the three-way merge, and the validation run are the real
 *     `IntegrationService`.
 *
 * No agent, scripted or real, is involved: the "agent's" edit is a fixed textual
 * change this script makes in a worktree. That is the point — the question is
 * about the coordinator's arithmetic on a lost race, not about what an agent
 * would have written.
 *
 * ## The A/B
 *
 * The old behaviour is exactly `STALE_REASSESSMENT_BUDGET = 0`: the first stale
 * answer exhausts the budget and falls through to the same requeue. So the two
 * arms are the same compiled module with that one constant changed, and the
 * "before" arm is the real previous code path rather than a reconstruction of
 * it.
 *
 * ## What the rate depends on
 *
 * Whether a race loser can be merged for free depends on how far its edit sits
 * from the winner's. That distance is a property of the workload, not of the
 * coordinator, and this harness cannot learn it from anywhere — so it sweeps it
 * instead of guessing, and reports the aggregate under a stated, explicit
 * assumption rather than presenting one number as if it were measured.
 *
 * Run after building:
 *   npx turbo run build
 *   node scripts/measure-free-merge-rate.mjs [--pairs 60] [--seed 1]
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const load = async (relative) =>
  import(pathToFileURL(path.resolve(relative)).href);

const { DEFAULT_ORGANIZATION_ID, DEFAULT_PROJECT_ID, InMemoryCoordinationStore } =
  await load("services/persistence/dist/index.js");
const { IntegrationService } = await load(
  "services/integration-service/dist/index.js",
);
const { RepositoryService } = await load(
  "services/repository-service/dist/index.js",
);
const { GitWorktreeWorkspaceManager } = await load(
  "services/workspace-manager/dist/index.js",
);

/**
 * The two arms.
 *
 * The zero-budget copy is written beside the real compiled module so that its
 * bare `@coord/*` imports resolve identically; every other byte is the shipped
 * build's.
 */
const REAL = "apps/cli/dist/worker-operations.js";
const PATCHED = "apps/cli/dist/worker-operations.budget0.generated.js";
const source = readFileSync(REAL, "utf8");
const patched = source.replace(
  /export const STALE_REASSESSMENT_BUDGET = \d+;/u,
  "export const STALE_REASSESSMENT_BUDGET = 0;",
);
if (patched === source) {
  console.error(`could not find the budget constant in ${REAL}`);
  process.exit(1);
}
writeFileSync(PATCHED, patched);

const arms = {
  after: await load(REAL),
  before: await load(PATCHED),
};
if (arms.after.STALE_REASSESSMENT_BUDGET !== 1) {
  console.error(
    `expected the shipped budget to be 1, found ${String(arms.after.STALE_REASSESSMENT_BUDGET)}`,
  );
}

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
}
const PAIRS = arg("--pairs", 60);
const SEED = arg("--seed", 1);

/** Deterministic RNG, so a reported rate can be reproduced exactly. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const GUIDE =
  Array.from({ length: 40 }, (_, index) => `Guide line ${String(index + 1)}.`).join(
    "\n",
  ) + "\n";

async function createHarness(root, extraFiles) {
  const sourcePath = path.join(root, "src-repo");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "src", "value.js"),
    "export const value = 1;\n",
    "utf8",
  );
  for (const [file, contents] of Object.entries(extraFiles)) {
    const target = path.join(sourcePath, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  await repositories.commitAll(sourcePath, "seed");
  const canonical = await repositories.importLocalRepository(
    sourcePath,
    path.join(root, "canon.git"),
    "repo_worker",
    "main",
  );
  const store = new InMemoryCoordinationStore();
  await store.saveRepository({
    id: canonical.id,
    path: canonical.path,
    branch: canonical.branch,
  });
  const user = await store.createUser({
    email: "fleet@example.com",
    displayName: "Fleet",
    passwordDigest: "digest",
  });
  const worker = await store.registerWorker({
    userId: user.id,
    organizationId: DEFAULT_ORGANIZATION_ID,
    name: "worker-a",
    adapters: ["generic-cli"],
    version: "1.0.0",
  });
  return { root, store, repositories, workerId: worker.id, canonical };
}

const planFor = (taskId, objective, files) => ({
  taskId,
  objective,
  expectedFiles: files,
  expectedSymbols: [],
  dependencies: [],
  commands: [],
  externalAccess: [],
  riskLevel: "low",
});

/** A real competing commit really promoted to canonical. */
async function landExternalAdvance(harness, line, file) {
  const from = await harness.repositories.getCanonicalVersion(harness.canonical);
  const workspaces = new GitWorktreeWorkspaceManager(
    harness.repositories.getGitClient(),
  );
  const competing = await workspaces.create({
    taskId: `external-edit-${String(line)}`,
    rootPath: path.join(harness.root, "external", String(line)),
    repository: harness.canonical,
    baseVersion: from,
  });
  const target = path.join(competing.path, ...file.split("/"));
  await writeFile(
    target,
    (await readFile(target, "utf8")).replace(
      `Guide line ${String(line)}.`,
      `Guide line ${String(line)}, expanded externally.`,
    ),
    "utf8",
  );
  const candidate = await harness.repositories.commitAll(
    competing.path,
    "advance canonical",
  );
  await harness.repositories.promote(harness.canonical, candidate, from.revision);
  await workspaces.destroy(competing);
}

async function collectEdit(harness, taskId, baseVersion, line) {
  const workspaces = new GitWorktreeWorkspaceManager(
    harness.repositories.getGitClient(),
  );
  const workspace = await workspaces.create({
    taskId,
    rootPath: path.join(harness.root, "merge-workspaces"),
    repository: harness.canonical,
    baseVersion,
  });
  const target = path.join(workspace.path, "docs", "guide.md");
  await writeFile(
    target,
    (await readFile(target, "utf8")).replace(
      `Guide line ${String(line)}.`,
      `Guide line ${String(line)}, corrected.`,
    ),
    "utf8",
  );
  const changeSet = await workspaces.collectChangeSet(workspace, {
    symbolsChanged: [],
    riskAssessment: { level: "low", reasons: [] },
    agentExplanation: "edited the guide",
  });
  await workspaces.destroy(workspace);
  return changeSet;
}

/**
 * An integration service that lets a competing advance land in the window
 * between the caller's pre-integration canonical read and the integration's
 * own — the race that makes a result stale rather than merely overtaken.
 */
function racingIntegrations(harness, winnerLine, file) {
  const real = new IntegrationService(harness.repositories);
  const attempts = [];
  return {
    attempts,
    service: {
      integrate: async (input) => {
        attempts.push(input.replayableOnto ?? "exact-base");
        if (attempts.length === 1) {
          await landExternalAdvance(harness, winnerLine, file);
        }
        return await real.integrate(input);
      },
    },
  };
}

/**
 * One pair: a task admitted on the guide, a competing advance that beats it to
 * canonical, and the result arriving to find itself stale.
 *
 * `winnerFile` is what makes the two shapes of pair differ. When the advance
 * lands in the same file, the result can only merge if its edit is far enough
 * from the winner's for git to call the hunks disjoint. When it lands in
 * another file the advance is unrelated, and the only thing standing between
 * the result and canonical was the lost race itself.
 */
async function runPair(arm, { loserLine, winnerLine, winnerFile }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "freemerge-"));
  try {
    const harness = await createHarness(root, {
      "docs/guide.md": GUIDE,
      "docs/other.md": GUIDE,
    });
    const task = await harness.store.submitTask({
      repositoryId: "repo_worker",
      objective: "correct the closing summary",
      agentId: "generic-cli",
      validationCommands: [],
    });
    const assignment = await arm.leaseWork(harness.store, {
      workerId: harness.workerId,
      projectId: DEFAULT_PROJECT_ID,
    });
    const admitted = await arm.admitWorkPlan(
      harness.store,
      {
        leaseId: assignment.lease.id,
        actorId: "user",
        plan: planFor(task.id, task.objective, ["docs/guide.md"]),
      },
      { repositories: harness.repositories },
    );
    if (admitted.outcome !== "admitted") {
      return { outcome: "not-admitted" };
    }
    const changeSet = await collectEdit(
      harness,
      task.id,
      assignment.canonicalVersion,
      loserLine,
    );
    const racing = racingIntegrations(harness, winnerLine, winnerFile);
    const accepted = await arm.acceptWorkResult(
      harness.store,
      {
        leaseId: assignment.lease.id,
        status: "completed",
        actorId: "user",
        plan: planFor(task.id, task.objective, ["docs/guide.md"]),
        changeSet,
      },
      {
        repositories: harness.repositories,
        integrations: racing.service,
        integrationRoot: path.join(root, "integration"),
      },
    );
    return {
      outcome: accepted.accepted
        ? "free-merge"
        : accepted.requeued
          ? "paid-replan"
          : "other",
      attempts: racing.attempts.length,
      reason: accepted.reason,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const random = rng(SEED);

/**
 * The workload. Two thirds of the pairs contend in the same file at a random
 * distance; one third are beaten by an advance elsewhere in the repository.
 * Both are drawn per pair and then replayed identically in both arms, so the
 * two arms differ only in the constant.
 */
const workload = Array.from({ length: PAIRS }, () => {
  const sameFile = random() < 2 / 3;
  return {
    winnerFile: sameFile ? "docs/guide.md" : "docs/other.md",
    winnerLine: 1 + Math.floor(random() * 40),
    loserLine: 1 + Math.floor(random() * 40),
  };
});

console.log(
  `${PAIRS} pairs per arm, seed ${SEED}; real git repositories, real integration, no agents\n`,
);

const results = { before: [], after: [] };
for (const [name, arm] of [
  ["before", arms.before],
  ["after", arms.after],
]) {
  process.stdout.write(`${name} (budget ${String(arm.STALE_REASSESSMENT_BUDGET)}): `);
  for (const [at, pair] of workload.entries()) {
    const result = await runPair(arm, pair);
    results[name].push({ ...pair, ...result });
    if ((at + 1) % 10 === 0) {
      process.stdout.write(`${String(at + 1)} `);
    }
  }
  process.stdout.write("done\n");
}

function rate(rows, predicate = () => true) {
  const scoped = rows.filter(predicate);
  const free = scoped.filter((row) => row.outcome === "free-merge").length;
  return {
    n: scoped.length,
    free,
    replan: scoped.filter((row) => row.outcome === "paid-replan").length,
    other: scoped.filter(
      (row) => row.outcome !== "free-merge" && row.outcome !== "paid-replan",
    ).length,
    pct: scoped.length === 0 ? 0 : (100 * free) / scoped.length,
  };
}

function report(label, predicate) {
  const before = rate(results.before, predicate);
  const after = rate(results.after, predicate);
  console.log(
    `\n${label}  (n=${after.n} per arm)\n` +
      `  before (budget 0): ${String(before.free)} free / ${String(before.replan)} replan` +
      `${before.other > 0 ? ` / ${String(before.other)} other` : ""}` +
      `  = ${before.pct.toFixed(1)}% free\n` +
      `  after  (budget 1): ${String(after.free)} free / ${String(after.replan)} replan` +
      `${after.other > 0 ? ` / ${String(after.other)} other` : ""}` +
      `  = ${after.pct.toFixed(1)}% free\n` +
      `  delta: ${(after.pct - before.pct >= 0 ? "+" : "")}${(after.pct - before.pct).toFixed(1)} points`,
  );
}

report("all race losers", () => true);
report(
  "advance landed in ANOTHER file (unrelated)",
  (row) => row.winnerFile === "docs/other.md",
);
report(
  "advance landed in the SAME file",
  (row) => row.winnerFile === "docs/guide.md",
);

console.log("\nsame-file losers by distance between the two edits");
const sameFile = results.after.filter((row) => row.winnerFile === "docs/guide.md");
const buckets = [
  ["0 (identical line)", (d) => d === 0],
  ["1-3 lines", (d) => d >= 1 && d <= 3],
  ["4-9 lines", (d) => d >= 4 && d <= 9],
  ["10+ lines", (d) => d >= 10],
];
for (const [label, test] of buckets) {
  const rows = sameFile.filter((row) =>
    test(Math.abs(row.winnerLine - row.loserLine)),
  );
  if (rows.length === 0) {
    continue;
  }
  const free = rows.filter((row) => row.outcome === "free-merge").length;
  console.log(
    `  ${label.padEnd(20)} ${String(free).padStart(3)}/${String(rows.length).padEnd(3)} merged free ` +
      `(${((100 * free) / rows.length).toFixed(0)}%)`,
  );
}

const extraAttempts = results.after.reduce(
  (sum, row) => sum + ((row.attempts ?? 1) - 1),
  0,
);
console.log(
  `\ncost: ${String(extraAttempts)} extra integration+validation attempts across ` +
    `${String(PAIRS)} pairs in the after arm ` +
    `(${(extraAttempts / PAIRS).toFixed(2)} per pair)`,
);
