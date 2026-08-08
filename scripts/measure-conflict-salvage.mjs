#!/usr/bin/env node
/**
 * How much of a conflicting changeset is actually worth keeping?
 *
 * A conflict used to be all or nothing: one contested hunk discarded every
 * clean file and every clean hunk beside it, and the task went back for a
 * replan. The unit tests prove the two ends of the new behaviour — a clean
 * file beside a contested one survives, a changeset with nothing left is still
 * refused. Neither says how much a real conflict typically carries, because a
 * rate is not a property one example can carry.
 *
 * Nothing here is scripted, stubbed, or modelled:
 *
 *   - every trial gets its own real Git repository, canonical branch and
 *     worktrees;
 *   - the competing change is a real commit really promoted to canonical;
 *   - the integration, the three-way merge and the salvage pass are the real
 *     `IntegrationService`.
 *
 * No agent is involved: the "agent's" edit is a fixed textual change this
 * script makes in a worktree. That is the point — the question is what
 * integration can recover from a conflict, not what an agent would have
 * written.
 *
 * ## The A/B
 *
 * The two arms are the same compiled module called with `salvageConflicts`
 * off and on, so the "before" arm is the real previous code path rather than a
 * reconstruction of it.
 *
 * ## What the rate depends on
 *
 * How much survives depends on how much of a changeset the contested file is,
 * and on whether the collision is the whole file or one hunk of it. Both are
 * properties of the workload rather than of the coordinator, and this harness
 * cannot learn them from anywhere — so it sweeps them and reports under a
 * stated assumption rather than presenting one number as if it were measured.
 *
 * Run after building:
 *   npx turbo run build
 *   node scripts/measure-conflict-salvage.mjs [--trials 40]
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const load = async (relative) =>
  await import(pathToFileURL(path.resolve(relative)).href);

const { RepositoryService } = await load(
  "services/repository-service/dist/index.js",
);
const { GitWorktreeWorkspaceManager } = await load(
  "services/workspace-manager/dist/index.js",
);
const { IntegrationService } = await load(
  "services/integration-service/dist/index.js",
);

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

const TRIALS = argOf("trials", 40);
/** How many files the agent's changeset touches, swept across trials. */
const FILE_COUNTS = [2, 3, 5, 8];
const LINES = 40;

const body = (marker) =>
  Array.from({ length: LINES }, (_, index) =>
    index === 0 ? `line 1 ${marker}` : `line ${String(index + 1)}`,
  ).join("\n") + "\n";

const METADATA = {
  symbolsChanged: [],
  riskAssessment: { level: "low", reasons: [] },
  agentExplanation: "edit",
};

/**
 * One trial: an agent changeset over `fileCount` files, of which exactly one
 * is also rewritten on canonical underneath it.
 *
 * `wholeFile` decides whether the collision takes the whole contested file
 * (both sides rewrite the same line) or only part of it (the agent also edits
 * a distant line that has no competitor).
 */
async function trial(root, index, fileCount, wholeFile) {
  const repositories = new RepositoryService();
  const workspaces = new GitWorktreeWorkspaceManager(
    repositories.getGitClient(),
  );
  const trialRoot = path.join(root, `t${String(index)}`);
  const sourcePath = path.join(trialRoot, "source");
  await mkdir(sourcePath, { recursive: true });
  await repositories.initializeWorkingRepository(sourcePath);
  for (let file = 0; file < fileCount; file += 1) {
    await writeFile(
      path.join(sourcePath, `f${String(file)}.txt`),
      body("base"),
      "utf8",
    );
  }
  await repositories.commitAll(sourcePath, "seed");
  const repository = await repositories.importLocalRepository(
    sourcePath,
    path.join(trialRoot, "canonical.git"),
    `repo${String(index)}`,
  );
  const base = await repositories.getCanonicalVersion(repository);

  // The agent edits every file. In the partial case it also edits a distant
  // line of the contested file, which has no competitor and should survive.
  const agent = await workspaces.create({
    taskId: `agent${String(index)}`,
    rootPath: path.join(trialRoot, "ws"),
    repository,
    baseVersion: base,
  });
  for (let file = 0; file < fileCount; file += 1) {
    const lines = body("base").split("\n");
    lines[0] = "line 1 AGENT";
    if (file === 0 && !wholeFile) {
      lines[LINES - 1] = `line ${String(LINES)} AGENT`;
    }
    await writeFile(
      path.join(agent.path, `f${String(file)}.txt`),
      lines.join("\n"),
      "utf8",
    );
  }
  const changeSet = await workspaces.collectChangeSet(agent, METADATA);
  await workspaces.destroy(agent);

  // Canonical moves under f0 only, on the same line the agent rewrote.
  const rival = await workspaces.create({
    taskId: `rival${String(index)}`,
    rootPath: path.join(trialRoot, "ws"),
    repository,
    baseVersion: base,
  });
  await writeFile(
    path.join(rival.path, "f0.txt"),
    body("RIVAL"),
    "utf8",
  );
  const rivalChangeSet = await workspaces.collectChangeSet(rival, METADATA);
  await workspaces.destroy(rival);

  const integrations = new IntegrationService(repositories, workspaces);
  const integrationRoot = path.join(trialRoot, "integration");
  const landed = await integrations.integrate({
    repository,
    integrationRoot,
    changeSet: rivalChangeSet,
    validationCommands: [],
    commitMessage: "rival",
  });
  if (landed.status !== "integrated") {
    throw new Error(`rival did not land: ${landed.explanation}`);
  }

  const before = await integrations.integrate({
    repository,
    integrationRoot,
    changeSet,
    validationCommands: [],
    commitMessage: "agent (before)",
  });
  const after = await integrations.integrate({
    repository,
    integrationRoot,
    changeSet,
    validationCommands: [],
    commitMessage: "agent (after)",
    salvageConflicts: true,
  });

  const deferred = after.salvagedDeferred?.length ?? 0;
  return {
    fileCount,
    wholeFile,
    beforeStatus: before.status,
    afterStatus: after.status,
    filesKept: after.status === "integrated" ? fileCount - deferred : 0,
    divided: after.salvagedDividedFiles?.length ?? 0,
  };
}

const root = await mkdtemp(path.join(os.tmpdir(), "coord-salvage-measure-"));
const rows = [];
try {
  for (let index = 0; index < TRIALS; index += 1) {
    const fileCount = FILE_COUNTS[index % FILE_COUNTS.length];
    const wholeFile = index % 2 === 0;
    rows.push(await trial(root, index, fileCount, wholeFile));
    process.stderr.write(`\r  ${String(index + 1)}/${String(TRIALS)} trials`);
  }
  process.stderr.write("\n");
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

const conflicted = rows.filter((row) => row.beforeStatus === "conflict");
const rescued = conflicted.filter((row) => row.afterStatus === "integrated");
const totalFiles = conflicted.reduce((sum, row) => sum + row.fileCount, 0);
const keptFiles = conflicted.reduce((sum, row) => sum + row.filesKept, 0);

console.log(`\ntrials: ${String(rows.length)}`);
console.log(
  `conflicts under the old behaviour: ${String(conflicted.length)} ` +
    `(each one discarded its whole changeset and bought a replan)`,
);
console.log(
  `of those, now integrated in part: ${String(rescued.length)}/${String(conflicted.length)} ` +
    `(${((100 * rescued.length) / Math.max(1, conflicted.length)).toFixed(0)}%)`,
);
console.log(
  `file-edits preserved: ${String(keptFiles)}/${String(totalFiles)} ` +
    `(${((100 * keptFiles) / Math.max(1, totalFiles)).toFixed(0)}%)`,
);

console.log("\nby shape of the collision:");
for (const [label, whole] of [
  ["whole contested file", true],
  ["one hunk of it", false],
]) {
  const subset = conflicted.filter((row) => row.wholeFile === whole);
  if (subset.length === 0) {
    continue;
  }
  const kept = subset.reduce((sum, row) => sum + row.filesKept, 0);
  const files = subset.reduce((sum, row) => sum + row.fileCount, 0);
  const split = subset.filter((row) => row.divided > 0).length;
  console.log(
    `  ${label.padEnd(22)} ${String(kept).padStart(3)}/${String(files).padEnd(3)} file-edits kept ` +
      `(${((100 * kept) / files).toFixed(0)}%), ${String(split)} split at the hunk`,
  );
}

console.log("\nby changeset width:");
for (const fileCount of FILE_COUNTS) {
  const subset = conflicted.filter((row) => row.fileCount === fileCount);
  if (subset.length === 0) {
    continue;
  }
  const kept = subset.reduce((sum, row) => sum + row.filesKept, 0);
  console.log(
    `  ${String(fileCount).padStart(2)} files/changeset  ` +
      `${(kept / subset.length).toFixed(1)} of ${String(fileCount)} kept on average`,
  );
}

console.log(
  "\nAssumption: every trial has exactly one contested file. A changeset whose\n" +
    "contested file is its only file keeps nothing, which is the 2-file row's\n" +
    "floor; wider changesets are where the saving is.",
);
