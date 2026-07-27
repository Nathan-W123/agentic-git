import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepositoryService } from "@coord/repository-service";
import { GitWorktreeWorkspaceManager } from "@coord/workspace-manager";

import { IntegrationService } from "./index.js";

test("validates and atomically promotes a changeset", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-integration-test-"));
  const sourcePath = path.join(root, "source");
  const canonicalPath = path.join(root, "canonical.git");
  const workspaceRoot = path.join(root, "workspaces");
  const integrationRoot = path.join(root, "integration");
  const repositories = new RepositoryService();
  const workspaces = new GitWorktreeWorkspaceManager(
    repositories.getGitClient(),
  );

  try {
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
      canonicalPath,
      "fixture",
    );
    const baseVersion = await repositories.getCanonicalVersion(repository);
    const taskWorkspace = await workspaces.create({
      taskId: "task_update",
      rootPath: workspaceRoot,
      repository,
      baseVersion,
    });

    await writeFile(
      path.join(taskWorkspace.path, "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );
    const changeSet = await workspaces.collectChangeSet(taskWorkspace, {
      symbolsChanged: ["value"],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "Update the fixture value",
    });

    const integration = new IntegrationService(repositories, workspaces);
    const result = await integration.integrate({
      repository,
      integrationRoot,
      changeSet,
      validationCommands: [
        {
          executable: "node",
          args: ["--check", "src/value.js"],
          label: "syntax",
        },
      ],
      commitMessage: "coord: update fixture value",
    });

    assert.equal(result.status, "integrated");
    assert.notEqual(
      result.canonicalVersion.revision,
      result.previousVersion.revision,
    );
    assert.equal(
      await repositories.readFile(
        repository,
        result.canonicalVersion.revision,
        "src/value.js",
      ),
      "export const value = 2;\n",
    );

    await workspaces.destroy(taskWorkspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

