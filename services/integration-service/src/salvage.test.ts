import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepositoryService } from "@coord/repository-service";
import { GitWorktreeWorkspaceManager } from "@coord/workspace-manager";

import { IntegrationService } from "./index.js";

/**
 * Keeping the part of a conflicting changeset that still applies.
 *
 * A conflict used to discard everything an agent produced — every clean file
 * and every clean hunk beside the contested one — and buy a replan at roughly
 * 145k tokens to rediscover work that had already been done. Most conflicts
 * are one hunk out of many.
 *
 * Salvage is opt-in because it promotes a subset and hands the remainder
 * back: a caller that ignored `salvagedDeferred` would silently lose the
 * difference, which is worse than refusing the changeset whole. These tests
 * pin both halves — what lands, and what is handed back — because either one
 * being wrong loses work.
 */

/** Ten distinct lines, so hunks can be made far enough apart not to merge. */
const SEED_LINES = Array.from(
  { length: 24 },
  (_, index) => `line ${String(index + 1)}`,
).join("\n");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-salvage-"));
  const sourcePath = path.join(root, "source");
  const repositories = new RepositoryService();
  const workspaces = new GitWorktreeWorkspaceManager(
    repositories.getGitClient(),
  );

  await repositories.initializeWorkingRepository(sourcePath);
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "src", "wide.txt"),
    `${SEED_LINES}\n`,
    "utf8",
  );
  await writeFile(path.join(sourcePath, "src", "calm.txt"), "calm\n", "utf8");
  await repositories.commitAll(sourcePath, "seed");

  const repository = await repositories.importLocalRepository(
    sourcePath,
    path.join(root, "canonical.git"),
    "fixture",
  );

  return {
    root,
    repositories,
    workspaces,
    repository,
    workspaceRoot: path.join(root, "workspaces"),
    integrationRoot: path.join(root, "integration"),
  };
}

const METADATA = {
  symbolsChanged: [],
  riskAssessment: { level: "low" as const, reasons: [] },
  agentExplanation: "edit",
};

test("a conflict in one file no longer discards the clean files beside it", async () => {
  const context = await fixture();
  try {
    const base = await context.repositories.getCanonicalVersion(
      context.repository,
    );
    const mine = await context.workspaces.create({
      taskId: "task_mine",
      rootPath: context.workspaceRoot,
      repository: context.repository,
      baseVersion: base,
    });
    const theirs = await context.workspaces.create({
      taskId: "task_theirs",
      rootPath: context.workspaceRoot,
      repository: context.repository,
      baseVersion: base,
    });

    // Both rewrite line 1 of wide.txt; only mine touches calm.txt.
    const contested = SEED_LINES.split("\n");
    await writeFile(
      path.join(mine.path, "src", "wide.txt"),
      `${["MINE", ...contested.slice(1)].join("\n")}\n`,
      "utf8",
    );
    await writeFile(path.join(mine.path, "src", "calm.txt"), "mine\n", "utf8");
    await writeFile(
      path.join(theirs.path, "src", "wide.txt"),
      `${["THEIRS", ...contested.slice(1)].join("\n")}\n`,
      "utf8",
    );

    const mineChangeSet = await context.workspaces.collectChangeSet(
      mine,
      METADATA,
    );
    const theirsChangeSet = await context.workspaces.collectChangeSet(
      theirs,
      METADATA,
    );

    const integration = new IntegrationService(
      context.repositories,
      context.workspaces,
    );
    const first = await integration.integrate({
      repository: context.repository,
      integrationRoot: context.integrationRoot,
      changeSet: theirsChangeSet,
      validationCommands: [],
      commitMessage: "coord: theirs",
    });
    assert.equal(first.status, "integrated", first.explanation);

    // Without salvage this is a flat conflict and every file is lost.
    const refused = await integration.integrate({
      repository: context.repository,
      integrationRoot: context.integrationRoot,
      changeSet: mineChangeSet,
      validationCommands: [],
      commitMessage: "coord: mine",
    });
    assert.equal(refused.status, "conflict", refused.explanation);

    const salvaged = await integration.integrate({
      repository: context.repository,
      integrationRoot: context.integrationRoot,
      changeSet: mineChangeSet,
      validationCommands: [],
      commitMessage: "coord: mine",
      salvageConflicts: true,
    });
    assert.equal(salvaged.status, "integrated", salvaged.explanation);

    // The uncontested file landed.
    assert.equal(
      await context.repositories.readFile(
        context.repository,
        salvaged.canonicalVersion.revision,
        "src/calm.txt",
      ),
      "mine\n",
    );
    // The contested one was not overwritten, and is handed back.
    assert.match(
      await context.repositories.readFile(
        context.repository,
        salvaged.canonicalVersion.revision,
        "src/wide.txt",
      ),
      /^THEIRS\n/u,
    );
    assert.deepEqual(
      salvaged.salvagedDeferred?.map((filePatch) => filePatch.path),
      ["src/wide.txt"],
    );
    assert.deepEqual(salvaged.salvagedDividedFiles, []);

    await context.workspaces.destroy(mine);
    await context.workspaces.destroy(theirs);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("one bad hunk costs its own lines, not the whole file", async () => {
  const context = await fixture();
  try {
    const base = await context.repositories.getCanonicalVersion(
      context.repository,
    );
    const mine = await context.workspaces.create({
      taskId: "task_mine",
      rootPath: context.workspaceRoot,
      repository: context.repository,
      baseVersion: base,
    });
    const theirs = await context.workspaces.create({
      taskId: "task_theirs",
      rootPath: context.workspaceRoot,
      repository: context.repository,
      baseVersion: base,
    });

    // Two edits far enough apart to stay separate hunks. Canonical moves only
    // under the first, so the second must still land.
    const lines = SEED_LINES.split("\n");
    const mineLines = [...lines];
    mineLines[0] = "MINE top";
    mineLines[23] = "MINE bottom";
    await writeFile(
      path.join(mine.path, "src", "wide.txt"),
      `${mineLines.join("\n")}\n`,
      "utf8",
    );

    const theirLines = [...lines];
    theirLines[0] = "THEIRS top";
    await writeFile(
      path.join(theirs.path, "src", "wide.txt"),
      `${theirLines.join("\n")}\n`,
      "utf8",
    );

    const mineChangeSet = await context.workspaces.collectChangeSet(
      mine,
      METADATA,
    );
    const theirsChangeSet = await context.workspaces.collectChangeSet(
      theirs,
      METADATA,
    );

    const integration = new IntegrationService(
      context.repositories,
      context.workspaces,
    );
    assert.equal(
      (
        await integration.integrate({
          repository: context.repository,
          integrationRoot: context.integrationRoot,
          changeSet: theirsChangeSet,
          validationCommands: [],
          commitMessage: "coord: theirs",
        })
      ).status,
      "integrated",
    );

    const salvaged = await integration.integrate({
      repository: context.repository,
      integrationRoot: context.integrationRoot,
      changeSet: mineChangeSet,
      validationCommands: [],
      commitMessage: "coord: mine",
      salvageConflicts: true,
    });
    assert.equal(salvaged.status, "integrated", salvaged.explanation);

    const result = await context.repositories.readFile(
      context.repository,
      salvaged.canonicalVersion.revision,
      "src/wide.txt",
    );
    const resultLines = result.split("\n");
    // The clean hunk landed; the contested one did not overwrite canonical.
    assert.equal(resultLines[23], "MINE bottom");
    assert.equal(resultLines[0], "THEIRS top");

    assert.deepEqual(salvaged.salvagedDividedFiles, ["src/wide.txt"]);
    const deferred = salvaged.salvagedDeferred ?? [];
    assert.equal(deferred.length, 1);
    // What comes back is the contested hunk alone, not the whole file, so a
    // follow-up task is told precisely what is left.
    assert.match(deferred[0]?.patch ?? "", /MINE top/u);
    assert.doesNotMatch(deferred[0]?.patch ?? "", /MINE bottom/u);

    await context.workspaces.destroy(mine);
    await context.workspaces.destroy(theirs);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("a changeset with nothing left to salvage is still a conflict", async () => {
  const context = await fixture();
  try {
    const base = await context.repositories.getCanonicalVersion(
      context.repository,
    );
    const mine = await context.workspaces.create({
      taskId: "task_mine",
      rootPath: context.workspaceRoot,
      repository: context.repository,
      baseVersion: base,
    });
    const theirs = await context.workspaces.create({
      taskId: "task_theirs",
      rootPath: context.workspaceRoot,
      repository: context.repository,
      baseVersion: base,
    });

    await writeFile(path.join(mine.path, "src", "calm.txt"), "mine\n", "utf8");
    await writeFile(
      path.join(theirs.path, "src", "calm.txt"),
      "theirs\n",
      "utf8",
    );
    const mineChangeSet = await context.workspaces.collectChangeSet(
      mine,
      METADATA,
    );
    const theirsChangeSet = await context.workspaces.collectChangeSet(
      theirs,
      METADATA,
    );

    const integration = new IntegrationService(
      context.repositories,
      context.workspaces,
    );
    assert.equal(
      (
        await integration.integrate({
          repository: context.repository,
          integrationRoot: context.integrationRoot,
          changeSet: theirsChangeSet,
          validationCommands: [],
          commitMessage: "coord: theirs",
        })
      ).status,
      "integrated",
    );

    const salvaged = await integration.integrate({
      repository: context.repository,
      integrationRoot: context.integrationRoot,
      changeSet: mineChangeSet,
      validationCommands: [],
      commitMessage: "coord: mine",
      salvageConflicts: true,
    });
    // Salvage must not invent a promotion out of nothing: canonical is
    // untouched and the answer is the same refusal as before.
    assert.equal(salvaged.status, "conflict", salvaged.explanation);
    assert.equal(salvaged.salvagedDeferred, undefined);
    assert.equal(
      await context.repositories.readFile(
        context.repository,
        salvaged.canonicalVersion.revision,
        "src/calm.txt",
      ),
      "theirs\n",
    );

    await context.workspaces.destroy(mine);
    await context.workspaces.destroy(theirs);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("salvaged work still has to pass validation", async () => {
  const context = await fixture();
  try {
    const base = await context.repositories.getCanonicalVersion(
      context.repository,
    );
    const mine = await context.workspaces.create({
      taskId: "task_mine",
      rootPath: context.workspaceRoot,
      repository: context.repository,
      baseVersion: base,
    });
    const theirs = await context.workspaces.create({
      taskId: "task_theirs",
      rootPath: context.workspaceRoot,
      repository: context.repository,
      baseVersion: base,
    });

    const lines = SEED_LINES.split("\n");
    const mineLines = [...lines];
    mineLines[0] = "MINE top";
    await writeFile(
      path.join(mine.path, "src", "wide.txt"),
      `${mineLines.join("\n")}\n`,
      "utf8",
    );
    await writeFile(path.join(mine.path, "src", "calm.txt"), "mine\n", "utf8");

    const theirLines = [...lines];
    theirLines[0] = "THEIRS top";
    await writeFile(
      path.join(theirs.path, "src", "wide.txt"),
      `${theirLines.join("\n")}\n`,
      "utf8",
    );

    const mineChangeSet = await context.workspaces.collectChangeSet(
      mine,
      METADATA,
    );
    const theirsChangeSet = await context.workspaces.collectChangeSet(
      theirs,
      METADATA,
    );

    const integration = new IntegrationService(
      context.repositories,
      context.workspaces,
    );
    await integration.integrate({
      repository: context.repository,
      integrationRoot: context.integrationRoot,
      changeSet: theirsChangeSet,
      validationCommands: [],
      commitMessage: "coord: theirs",
    });

    const before = await context.repositories.getCanonicalVersion(
      context.repository,
    );
    const salvaged = await integration.integrate({
      repository: context.repository,
      integrationRoot: context.integrationRoot,
      changeSet: mineChangeSet,
      validationCommands: [
        { executable: "node", args: ["-e", "process.exit(1)"], label: "gate" },
      ],
      commitMessage: "coord: mine",
      salvageConflicts: true,
    });

    // The surviving subset is not privileged. It goes through the same gate,
    // and a failure leaves canonical exactly where it was.
    assert.equal(salvaged.status, "validation_failed", salvaged.explanation);
    assert.equal(
      (await context.repositories.getCanonicalVersion(context.repository))
        .revision,
      before.revision,
    );

    await context.workspaces.destroy(mine);
    await context.workspaces.destroy(theirs);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});
