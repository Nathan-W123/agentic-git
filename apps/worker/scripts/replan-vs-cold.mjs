#!/usr/bin/env node
/**
 * What an incremental replan costs, against planning the same task cold.
 *
 * The question this settles: when canonical moves under a task, is amending
 * its existing plan cheaper than throwing it away and planning again? The
 * remote worker path today always does the second, and the machinery for the
 * first exists in every adapter but is only ever called by the in-process
 * coordinator.
 *
 * Both arms produce a plan valid at the *same* new revision, which is what
 * makes them comparable:
 *
 *   1. plan the task at revision A                (the "previous plan")
 *   2. move canonical to revision B
 *   3a. REPLAN  — same session, amend the plan for B, given the change notice
 *   3b. COLD    — a fresh session, plan the task at B from nothing
 *
 * Tokens come from the adapter's own usage records, so they are the vendor's
 * numbers rather than an estimate. Every task is run through both arms, and
 * the order within a task is fixed: the replan first, so it cannot benefit
 * from anything the cold run warmed.
 *
 * Usage (from the repository root, after `npx turbo run build`):
 *
 *   node apps/worker/scripts/replan-vs-cold.mjs --tasks=3
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createClaudeAdapter } from "@coord/adapter-prompt-cli";
import { RepositoryService } from "@coord/repository-service";
import { GitWorktreeWorkspaceManager } from "@coord/workspace-manager";
import { CodeIntelligenceService } from "@coord/code-intelligence";

import { TEAM_QUEUE_WIRED_SCENARIO as SCENARIO } from "./team-queue-wired-scenario.mjs";

const flag = (name, fallback) => {
  const raw = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return raw === undefined ? fallback : raw.slice(name.length + 3);
};
const taskCount = Number(flag("tasks", "3"));

const command = process.env["COORD_AGENT_CMD"]?.trim() ?? "";
if (command.length === 0) {
  throw new Error("COORD_AGENT_CMD must name the agent executable");
}
const args = JSON.parse(process.env["COORD_AGENT_ARGS"]?.trim() || "[]");
const effort = process.env["COORD_AGENT_EFFORT"]?.trim() || undefined;

const root = await mkdtemp(path.join(os.tmpdir(), "replan-bench-"));
const repositories = new RepositoryService();
const workspaces = new GitWorktreeWorkspaceManager(repositories.getGitClient());
const intelligence = new CodeIntelligenceService(repositories);

const sourcePath = path.join(root, "src-repo");
await repositories.initializeWorkingRepository(sourcePath);
for (const [file, contents] of Object.entries(SCENARIO.seed)) {
  const target = path.join(sourcePath, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}
await repositories.commitAll(sourcePath, "seed");
const canonical = await repositories.importLocalRepository(
  sourcePath,
  path.join(root, "canon.git"),
  "repo_replan_bench",
  "main",
);
const revisionA = await repositories.getCanonicalVersion(canonical);

/**
 * A second revision that genuinely disturbs the pricing tasks.
 *
 * The change has to be one a plan might care about, or the replan is being
 * asked an easier question than the one it faces in a real run: `orderTotal`
 * gains a rounding step, which is exactly the kind of edit the deep band's
 * tasks collide over.
 */
const mutation = path.join(root, "mutate");
await repositories.cloneForWrite?.(canonical, mutation).catch(() => undefined);
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const run = promisify(execFile);
await run("git", ["clone", "--quiet", canonical.path, mutation]);
await run("git", ["-C", mutation, "config", "user.email", "bench@example.test"]);
await run("git", ["-C", mutation, "config", "user.name", "bench"]);
const totalPath = path.join(mutation, "src/pricing/total.js");
const { readFile } = await import("node:fs/promises");
const before = await readFile(totalPath, "utf8");
await writeFile(
  totalPath,
  before.replace(
    "export function orderTotal(order) {",
    "/** Applied before anything else that reads the order. */\nexport function orderTotal(order) {\n  const auditedAt = Date.now();\n  void auditedAt;",
  ),
  "utf8",
);
await run("git", ["-C", mutation, "add", "-A"]);
await run("git", ["-C", mutation, "commit", "--quiet", "-m", "audit stamp in orderTotal"]);
await run("git", ["-C", mutation, "push", "--quiet", "origin", "HEAD:main"]);
const revisionB = await repositories.getCanonicalVersion(canonical);
console.log(
  `revision A ${revisionA.revision.slice(0, 12)} -> B ${revisionB.revision.slice(0, 12)}\n`,
);

const changedFiles = await repositories.listChangedFiles(
  canonical,
  revisionA.revision,
  revisionB.revision,
);
const indexB = await intelligence.index(canonical, revisionB.revision);
const changedSymbols = [
  ...new Set(
    indexB.files
      .filter((file) => changedFiles.includes(file.path))
      .flatMap((file) => file.symbols),
  ),
].sort();

const notice = {
  previousVersion: revisionA,
  canonicalVersion: revisionB,
  changedFiles: [...changedFiles].sort(),
  changedSymbols,
  changedApis: [],
  changedSchemas: [],
  changedConfigKeys: [],
  changedTests: changedFiles.filter((file) => file.startsWith("test/")),
  changedServices: [],
  reason: "another task integrated an audit stamp into the order total",
};

const newAdapter = (suffix) =>
  createClaudeAdapter({
    agentId: `bench-${suffix}`,
    repository: canonical,
    workspaces,
    planningRoot: path.join(root, `planning-${suffix}`),
    command,
    ...(args.length === 0 ? {} : { args }),
    ...(effort === undefined ? {} : { effort }),
  });

const usageOf = (adapter) =>
  adapter
    .allTokenUsage()
    .filter((entry) => entry.phase === "planning")
    .reduce(
      (totals, entry) => ({
        tokens: totals.tokens + entry.totalTokens,
        costUsd: totals.costUsd + (entry.costUsd ?? 0),
      }),
      { tokens: 0, costUsd: 0 },
    );

const rows = [];
const selected = SCENARIO.tasks
  .filter((entry) => entry.band !== "independent")
  .slice(0, taskCount);

for (const [position, entry] of selected.entries()) {
  const task = {
    id: entry.task.id,
    objective: entry.task.objective,
    agentId: entry.task.agentId,
    validationCommands: [],
  };
  console.log(`--- ${task.id} (${position + 1}/${selected.length}) ---`);

  // 1. The previous plan, written against revision A.
  const warm = newAdapter(`warm-${position}`);
  const warmSession = await warm.startTask({
    task,
    canonicalVersion: revisionA,
    repositoryId: canonical.id,
  });
  const firstStarted = Date.now();
  const previousPlan = await warm.requestPlan(warmSession.id);
  const firstMs = Date.now() - firstStarted;
  const afterFirst = usageOf(warm);
  console.log(
    `  initial plan at A : ${Math.round(firstMs / 1000)}s, ${afterFirst.tokens.toLocaleString()} tokens`,
  );

  // 2. The incremental amendment, same session, given the change notice.
  const replanStarted = Date.now();
  const revised = await warm.requestReplan(warmSession.id, {
    taskId: task.id,
    previousPlan,
    canonicalChange: notice,
    constraints: [],
  });
  const replanMs = Date.now() - replanStarted;
  const afterReplan = usageOf(warm);
  const replanTokens = afterReplan.tokens - afterFirst.tokens;
  const replanCost = afterReplan.costUsd - afterFirst.costUsd;
  await warm.cancel(warmSession.id).catch(() => undefined);

  // 3. The same task planned cold at revision B, which is what the remote
  //    path does today after a requeue.
  const cold = newAdapter(`cold-${position}`);
  const coldSession = await cold.startTask({
    task,
    canonicalVersion: revisionB,
    repositoryId: canonical.id,
  });
  const coldStarted = Date.now();
  const coldPlan = await cold.requestPlan(coldSession.id);
  const coldMs = Date.now() - coldStarted;
  const coldUsage = usageOf(cold);
  await cold.cancel(coldSession.id).catch(() => undefined);

  console.log(
    `  REPLAN  at B      : ${Math.round(replanMs / 1000)}s, ${replanTokens.toLocaleString()} tokens, $${replanCost.toFixed(3)}`,
  );
  console.log(
    `  COLD    at B      : ${Math.round(coldMs / 1000)}s, ${coldUsage.tokens.toLocaleString()} tokens, $${coldUsage.costUsd.toFixed(3)}`,
  );
  console.log(
    `  files: replan ${JSON.stringify(revised.expectedFiles)} vs cold ${JSON.stringify(coldPlan.expectedFiles)}`,
  );
  rows.push({
    taskId: task.id,
    replanMs,
    replanTokens,
    replanCost,
    coldMs,
    coldTokens: coldUsage.tokens,
    coldCost: coldUsage.costUsd,
    replanFiles: revised.expectedFiles,
    coldFiles: coldPlan.expectedFiles,
  });
}

const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
console.log(`\n${"=".repeat(64)}`);
console.log(`pooled over ${rows.length} tasks`);
console.log("=".repeat(64));
const rt = sum("replanTokens");
const ct = sum("coldTokens");
const replanMsTotal = sum("replanMs");
const coldMsTotal = sum("coldMs");
console.log(`  REPLAN : ${Math.round(replanMsTotal / 1000)}s, ${rt.toLocaleString()} tokens, $${sum("replanCost").toFixed(2)}`);
console.log(`  COLD   : ${Math.round(coldMsTotal / 1000)}s, ${ct.toLocaleString()} tokens, $${sum("coldCost").toFixed(2)}`);
console.log(
  `  tokens : ${ct === 0 ? "n/a" : `${(100 * (1 - rt / ct)).toFixed(0)}% ${rt < ct ? "cheaper" : "MORE EXPENSIVE"}`}`,
);
console.log(
  `  time   : ${coldMsTotal === 0 ? "n/a" : `${(100 * (1 - replanMsTotal / coldMsTotal)).toFixed(0)}% ${replanMsTotal < coldMsTotal ? "faster" : "SLOWER"}`}`,
);
await rm(root, { recursive: true, force: true }).catch(() => undefined);
