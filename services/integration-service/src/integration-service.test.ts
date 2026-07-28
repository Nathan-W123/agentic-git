import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepositoryService } from "@coord/repository-service";
import {
  GitWorktreeWorkspaceManager,
  type ChangeSetMetadata,
  type CreateWorkspaceInput,
  type SandboxLaunchSpec,
  type TaskWorkspace,
  type WorkspaceCommandOptions,
  type WorkspaceManager,
} from "@coord/workspace-manager";
import type { ProcessOutput } from "@coord/repository-service";

import { IntegrationService } from "./index.js";

class TrackingWorkspaceManager implements WorkspaceManager {
  public readonly commands: Array<{
    spec: SandboxLaunchSpec;
    options: WorkspaceCommandOptions;
  }> = [];

  public constructor(
    protected readonly delegate: GitWorktreeWorkspaceManager,
  ) {}

  public async create(input: CreateWorkspaceInput): Promise<TaskWorkspace> {
    return await this.delegate.create(input);
  }

  public async destroy(workspace: TaskWorkspace): Promise<void> {
    await this.delegate.destroy(workspace);
  }

  public async runInWorkspace(
    workspace: TaskWorkspace,
    spec: SandboxLaunchSpec,
    options: WorkspaceCommandOptions = {},
  ): Promise<ProcessOutput> {
    this.commands.push({ spec, options });
    return await this.delegate.runInWorkspace(workspace, spec, options);
  }

  public async collectChangeSet(
    workspace: TaskWorkspace,
    metadata: ChangeSetMetadata,
  ) {
    return await this.delegate.collectChangeSet(workspace, metadata);
  }
}

class CleanupFailingWorkspaceManager extends TrackingWorkspaceManager {
  public override async destroy(workspace: TaskWorkspace): Promise<void> {
    await super.destroy(workspace);
    if (workspace.taskId.startsWith("integration-")) {
      throw new Error("simulated integration cleanup failure");
    }
  }
}

test("validates and atomically promotes a changeset", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-integration-test-"));
  const sourcePath = path.join(root, "source");
  const canonicalPath = path.join(root, "canonical.git");
  const workspaceRoot = path.join(root, "workspaces");
  const integrationRoot = path.join(root, "integration");
  const repositories = new RepositoryService();
  const workspaces = new TrackingWorkspaceManager(
    new GitWorktreeWorkspaceManager(repositories.getGitClient()),
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

    const integration = new IntegrationService(repositories, workspaces, {
      validationTimeoutMs: 12_345,
      maxValidationOutputBytes: 54_321,
    });
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
    assert.deepEqual(workspaces.commands, [
      {
        spec: {
          command: "node",
          args: ["--check", "src/value.js"],
        },
        options: {
          timeoutMs: 12_345,
          maxOutputBytes: 54_321,
        },
      },
    ]);
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

test("rejects patches whose contents do not match declared files", async () => {
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
    const original = await workspaces.collectChangeSet(taskWorkspace, {
      symbolsChanged: ["value"],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "Update the fixture value",
    });
    const forged = {
      ...original,
      patches: original.patches.map((entry) => ({
        ...entry,
        path: "src/declared-only.js",
      })),
    };

    const integration = new IntegrationService(repositories, workspaces);
    const result = await integration.integrate({
      repository,
      integrationRoot,
      changeSet: forged,
      validationCommands: [],
      commitMessage: "coord: forged update",
    });

    assert.equal(result.status, "policy_failed");
    assert.equal(
      (await repositories.getCanonicalVersion(repository)).revision,
      baseVersion.revision,
    );

    const wrongStatus = {
      ...original,
      patches: original.patches.map((entry) => ({
        ...entry,
        status: "added" as const,
      })),
    };
    const statusResult = await integration.integrate({
      repository,
      integrationRoot,
      changeSet: wrongStatus,
      validationCommands: [],
      commitMessage: "coord: wrong status",
    });
    assert.equal(statusResult.status, "policy_failed");

    await workspaces.destroy(taskWorkspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects repository mutations made by validation commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-integration-test-"));
  const sourcePath = path.join(root, "source");
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
      path.join(root, "canonical.git"),
      "fixture",
    );
    const baseVersion = await repositories.getCanonicalVersion(repository);
    const taskWorkspace = await workspaces.create({
      taskId: "task_update",
      rootPath: path.join(root, "workspaces"),
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

    for (const script of [
      "require('node:fs').writeFileSync('src/injected.js', 'injected\\n')",
      "require('node:fs').writeFileSync('src/value.js', 'tampered\\n')",
    ]) {
      const result = await integration.integrate({
        repository,
        integrationRoot: path.join(root, "integration"),
        changeSet,
        validationCommands: [
          {
            executable: process.execPath,
            args: ["-e", script],
            label: "mutating validation",
          },
        ],
        commitMessage: "coord: guarded validation",
      });
      assert.equal(result.status, "policy_failed");
      assert.match(result.explanation, /validation command modified/u);
      assert.equal(
        (await repositories.getCanonicalVersion(repository)).revision,
        baseVersion.revision,
      );
    }

    await workspaces.destroy(taskWorkspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves a promoted result when integration cleanup fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-integration-test-"));
  const sourcePath = path.join(root, "source");
  const repositories = new RepositoryService();
  const workspaces = new CleanupFailingWorkspaceManager(
    new GitWorktreeWorkspaceManager(repositories.getGitClient()),
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
      path.join(root, "canonical.git"),
      "fixture",
    );
    const baseVersion = await repositories.getCanonicalVersion(repository);
    const taskWorkspace = await workspaces.create({
      taskId: "task_update",
      rootPath: path.join(root, "workspaces"),
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

    const result = await new IntegrationService(
      repositories,
      workspaces,
    ).integrate({
      repository,
      integrationRoot: path.join(root, "integration"),
      changeSet,
      validationCommands: [],
      commitMessage: "coord: update fixture value",
    });

    assert.equal(result.status, "integrated");
    assert.match(result.cleanupWarnings?.[0] ?? "", /cleanup failure/u);
    assert.notEqual(result.canonicalVersion.revision, baseVersion.revision);
    await workspaces.destroy(taskWorkspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
