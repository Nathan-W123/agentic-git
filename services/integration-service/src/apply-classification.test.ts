import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepositoryService } from "@coord/repository-service";
import { GitWorktreeWorkspaceManager } from "@coord/workspace-manager";

import { IntegrationService } from "./index.js";

/**
 * What a failed `git apply` is allowed to be called.
 *
 * Integration used to apply changesets under `--whitespace=error-all`, which
 * makes git treat a trailing space as an error rather than as content. A
 * Markdown hard line break is two trailing spaces — the documented way to
 * write one — so a patch containing one failed the apply outright and was
 * reported as a conflict. That is expensive and it is false: a conflict costs
 * a full replan, and the handoff tells the next session the files it touched
 * "have moved underneath it" when nothing moved at all.
 *
 * These tests pin the three outcomes apart: whitespace is content, a real
 * collision is still a conflict, and a changeset that cannot be applied for
 * any other reason is a defect rather than contention.
 */

interface Fixture {
  root: string;
  repositories: RepositoryService;
  workspaces: GitWorktreeWorkspaceManager;
  repository: Awaited<ReturnType<RepositoryService["importLocalRepository"]>>;
  workspaceRoot: string;
  integrationRoot: string;
}

async function fixture(seed: Record<string, string>): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-apply-test-"));
  const sourcePath = path.join(root, "source");
  const repositories = new RepositoryService();
  const workspaces = new GitWorktreeWorkspaceManager(
    repositories.getGitClient(),
  );

  await repositories.initializeWorkingRepository(sourcePath);
  for (const [relativePath, contents] of Object.entries(seed)) {
    const target = path.join(sourcePath, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
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

test("integrates a Markdown hard line break rather than calling it a conflict", async () => {
  const context = await fixture({ "README.md": "Seed\n" });
  const hardBreak = "First line  \nsecond line\n";

  try {
    const baseVersion = await context.repositories.getCanonicalVersion(
      context.repository,
    );
    const workspace = await context.workspaces.create({
      taskId: "task_docs",
      rootPath: context.workspaceRoot,
      repository: context.repository,
      baseVersion,
    });

    await writeFile(path.join(workspace.path, "README.md"), hardBreak, "utf8");
    const changeSet = await context.workspaces.collectChangeSet(workspace, {
      symbolsChanged: [],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "Document the thing",
    });

    const result = await new IntegrationService(
      context.repositories,
      context.workspaces,
    ).integrate({
      repository: context.repository,
      integrationRoot: context.integrationRoot,
      changeSet,
      validationCommands: [],
      commitMessage: "coord: document the thing",
    });

    assert.equal(result.status, "integrated", result.explanation);
    // The trailing spaces must survive. Integration is not entitled to edit
    // the bytes the agent produced and the worker already validated.
    assert.equal(
      await context.repositories.readFile(
        context.repository,
        result.canonicalVersion.revision,
        "README.md",
      ),
      hardBreak,
    );

    await context.workspaces.destroy(workspace);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("still reports a genuine collision as a conflict, naming the file", async () => {
  const context = await fixture({
    "src/value.js": "export const value = 1;\n",
  });

  try {
    const baseVersion = await context.repositories.getCanonicalVersion(
      context.repository,
    );

    // Two agents start from the same base and rewrite the same line.
    const first = await context.workspaces.create({
      taskId: "task_first",
      rootPath: context.workspaceRoot,
      repository: context.repository,
      baseVersion,
    });
    const second = await context.workspaces.create({
      taskId: "task_second",
      rootPath: context.workspaceRoot,
      repository: context.repository,
      baseVersion,
    });

    await writeFile(
      path.join(first.path, "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );
    await writeFile(
      path.join(second.path, "src", "value.js"),
      "export const value = 3;\n",
      "utf8",
    );

    const metadata = {
      symbolsChanged: ["value"],
      riskAssessment: { level: "low" as const, reasons: [] },
      agentExplanation: "rewrite the value",
    };
    const firstChangeSet = await context.workspaces.collectChangeSet(
      first,
      metadata,
    );
    const secondChangeSet = await context.workspaces.collectChangeSet(
      second,
      metadata,
    );

    const integration = new IntegrationService(
      context.repositories,
      context.workspaces,
    );
    const promoted = await integration.integrate({
      repository: context.repository,
      integrationRoot: context.integrationRoot,
      changeSet: firstChangeSet,
      validationCommands: [],
      commitMessage: "coord: value = 2",
    });
    assert.equal(promoted.status, "integrated", promoted.explanation);

    const collided = await integration.integrate({
      repository: context.repository,
      integrationRoot: context.integrationRoot,
      changeSet: secondChangeSet,
      validationCommands: [],
      commitMessage: "coord: value = 3",
    });

    assert.equal(collided.status, "conflict", collided.explanation);
    assert.match(collided.explanation, /src\/value\.js/u);

    await context.workspaces.destroy(first);
    await context.workspaces.destroy(second);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("separates an unapplyable changeset from a conflict", async () => {
  const context = await fixture({ "kept.txt": "kept\n" });

  try {
    const baseVersion = await context.repositories.getCanonicalVersion(
      context.repository,
    );

    // A patch against a file that has never existed, carrying blob ids that
    // resolve to nothing, so the three-way fallback has no base to fall back
    // to. Nothing about this is contention, and replanning would produce it
    // again.
    const orphanPatch =
      "diff --git a/ghost.txt b/ghost.txt\n" +
      "index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644\n" +
      "--- a/ghost.txt\n" +
      "+++ b/ghost.txt\n" +
      "@@ -1 +1 @@\n" +
      "-nope\n" +
      "+yep\n";

    const result = await new IntegrationService(
      context.repositories,
      context.workspaces,
    ).integrate({
      repository: context.repository,
      integrationRoot: context.integrationRoot,
      changeSet: {
        id: "changeset_orphan",
        taskId: "task_orphan",
        baseVersion: baseVersion.sequence,
        baseRevision: baseVersion.revision,
        patches: [
          { path: "ghost.txt", status: "modified", patch: orphanPatch },
        ],
        commandsRun: [],
        tests: [],
        dependenciesChanged: [],
        symbolsChanged: [],
        riskAssessment: { level: "low", reasons: [] },
        agentExplanation: "orphan",
        createdAt: new Date().toISOString(),
      },
      validationCommands: [],
      commitMessage: "coord: orphan",
    });

    assert.equal(result.status, "policy_failed", result.explanation);
    assert.match(result.explanation, /not because it conflicts/u);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});
