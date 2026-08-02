import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepositoryService } from "@coord/repository-service";

import { GitWorktreeWorkspaceManager } from "./index.js";

test("change collection excludes untracked dependency trees without a gitignore", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-changeset-test-"));
  try {
    const sourcePath = path.join(root, "source");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(sourcePath);
    await mkdir(path.join(sourcePath, "src"), { recursive: true });
    await writeFile(
      path.join(sourcePath, "src", "value.js"),
      "export const value = 1;\n",
      "utf8",
    );
    await repositories.commitAll(sourcePath, "seed");
    const repository = await repositories.importLocalRepository(
      sourcePath,
      path.join(root, "canonical.git"),
      "fixture",
    );
    const manager = new GitWorktreeWorkspaceManager(
      repositories.getGitClient(),
    );
    const workspace = await manager.create({
      taskId: "task_change",
      rootPath: path.join(root, "workspaces"),
      repository,
      baseVersion: await repositories.getCanonicalVersion(repository),
    });

    await writeFile(
      path.join(workspace.path, "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );
    await mkdir(path.join(workspace.path, "node_modules", "fixture"), {
      recursive: true,
    });
    await writeFile(
      path.join(workspace.path, "node_modules", "fixture", "package.json"),
      "{}\n",
      "utf8",
    );
    await mkdir(path.join(workspace.path, "dist"), { recursive: true });
    await writeFile(
      path.join(workspace.path, "dist", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );

    const changeSet = await manager.collectChangeSet(workspace, {
      expectedFiles: ["src/value.js"],
      symbolsChanged: ["value"],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "updated the value",
    });

    assert.deepEqual(
      changeSet.patches.map((patch) => patch.path),
      ["src/value.js"],
    );
    await manager.destroy(workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
