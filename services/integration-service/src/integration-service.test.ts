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

import {
  IntegrationService,
  ValidationBaselineCache,
  validationEvidence,
} from "./index.js";

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
    // Twice, and that is the point: once at canonical before the patch and
    // once after it. One measurement cannot tell "fixed it" from "broke
    // nothing" from "was already broken".
    const invocation = {
      spec: { command: "node", args: ["--check", "src/value.js"] },
      options: { timeoutMs: 12_345, maxOutputBytes: 54_321 },
    };
    assert.deepEqual(workspaces.commands, [invocation, invocation]);
    assert.equal(result.baseline?.cached, false);
    assert.equal(result.baseline?.revision, result.previousVersion.revision);
    // The fixture's command passes at canonical too, so nothing went from red
    // to green — an honest "executed", not "demonstrated".
    assert.deepEqual(result.baseline?.nowPassing, []);
    assert.equal(result.evidence, "executed");
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

test("allows generated artifacts created by successful validation", async () => {
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
      expectedFiles: ["src/value.js"],
      symbolsChanged: ["value"],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "Update the fixture value",
    });
    const script = [
      "const fs = require('node:fs');",
      "fs.mkdirSync('node_modules/fixture', { recursive: true });",
      "fs.writeFileSync('node_modules/fixture/package.json', '{}\\n');",
      "fs.mkdirSync('dist', { recursive: true });",
      "fs.writeFileSync('dist/value.js', 'generated\\n');",
      "fs.writeFileSync('tsconfig.tsbuildinfo', 'generated\\n');",
    ].join("");
    const result = await new IntegrationService(
      repositories,
      workspaces,
    ).integrate({
      repository,
      integrationRoot: path.join(root, "integration"),
      changeSet,
      validationCommands: [
        {
          executable: process.execPath,
          args: ["-e", script],
          label: "generated output",
        },
      ],
      commitMessage: "coord: allow generated validation output",
    });

    assert.equal(result.status, "integrated");
    assert.match(
      await repositories.readFile(
        repository,
        result.canonicalVersion.revision,
        "src/value.js",
      ),
      /value = 2/u,
    );
    for (const generatedPath of [
      "node_modules/fixture/package.json",
      "dist/value.js",
      "tsconfig.tsbuildinfo",
    ]) {
      await assert.rejects(
        repositories.readFile(
          repository,
          result.canonicalVersion.revision,
          generatedPath,
        ),
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

/** A repository with one source file and one test that asserts its value. */
async function gradedFixture(root: string): Promise<{
  repositories: RepositoryService;
  repository: Awaited<ReturnType<RepositoryService["importLocalRepository"]>>;
  workspaces: GitWorktreeWorkspaceManager;
  workspaceRoot: string;
  integrationRoot: string;
}> {
  const sourcePath = path.join(root, "source");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await mkdir(path.join(sourcePath, "test"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "src", "value.js"),
    "export const value = 1;\n",
    "utf8",
  );
  // Asserts 2, so it fails at canonical and passes once the change lands.
  await writeFile(
    path.join(sourcePath, "test", "value.test.js"),
    [
      'import { value } from "../src/value.js";',
      "if (value !== 2) { process.exit(1); }",
    ].join("\n"),
    "utf8",
  );
  await repositories.commitAll(sourcePath, "seed");
  return {
    repositories,
    repository: await repositories.importLocalRepository(
      sourcePath,
      path.join(root, "canonical.git"),
      "graded",
    ),
    workspaces: new GitWorktreeWorkspaceManager(repositories.getGitClient()),
    workspaceRoot: path.join(root, "workspaces"),
    integrationRoot: path.join(root, "integration"),
  };
}

const NODE_TEST = {
  executable: process.execPath,
  args: ["test/value.test.js"],
  label: "suite",
};

test("a change that turns a failing test green is recorded as demonstrated", async () => {
  // The signal Kumi could not produce before. One run says "nothing exploded";
  // two say "something that was broken now works", which is the only evidence
  // integration can give on its own that the change did what was asked.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-evidence-"));
  try {
    const fixture = await gradedFixture(root);
    const baseVersion = await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    );
    const workspace = await fixture.workspaces.create({
      taskId: "task_fix",
      rootPath: fixture.workspaceRoot,
      repository: fixture.repository,
      baseVersion,
    });
    await writeFile(
      path.join(workspace.path, "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );
    const changeSet = await fixture.workspaces.collectChangeSet(workspace, {
      symbolsChanged: ["value"],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "make the test pass",
    });

    const result = await new IntegrationService(
      fixture.repositories,
      fixture.workspaces,
    ).integrate({
      repository: fixture.repository,
      integrationRoot: fixture.integrationRoot,
      changeSet,
      validationCommands: [NODE_TEST],
      commitMessage: "coord: fix the value",
    });

    assert.equal(result.status, "integrated");
    assert.equal(result.evidence, "demonstrated");
    assert.deepEqual(result.baseline?.nowPassing, ["suite"]);
    assert.equal(result.baseline?.results[0]?.exitCode, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a change that passes only because it rewrote the test says so", async () => {
  // Not a refusal — a task whose point is to change behaviour has to move the
  // test that encodes the old behaviour. What was missing is that "passes the
  // test as it stood" and "passes the test it rewrote" were the same record.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-grader-"));
  try {
    const fixture = await gradedFixture(root);
    const baseVersion = await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    );
    const workspace = await fixture.workspaces.create({
      taskId: "task_regrade",
      rootPath: fixture.workspaceRoot,
      repository: fixture.repository,
      baseVersion,
    });
    // The source is untouched; only the grader moves to accept what is there.
    await writeFile(
      path.join(workspace.path, "test", "value.test.js"),
      [
        'import { value } from "../src/value.js";',
        "if (value !== 1) { process.exit(1); }",
      ].join("\n"),
      "utf8",
    );
    const changeSet = await fixture.workspaces.collectChangeSet(workspace, {
      symbolsChanged: [],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "adjust the expectation",
    });

    const result = await new IntegrationService(
      fixture.repositories,
      fixture.workspaces,
    ).integrate({
      repository: fixture.repository,
      integrationRoot: fixture.integrationRoot,
      changeSet,
      validationCommands: [NODE_TEST],
      commitMessage: "coord: adjust the expectation",
    });

    assert.equal(result.status, "integrated");
    assert.deepEqual(result.graderEdits?.paths, ["test/value.test.js"]);
    assert.equal(result.graderEdits?.passesOnlyWithEdits, true);
    // And the promoted tree is the candidate, not the one graded without the
    // edits — the restore is load-bearing, not cosmetic.
    assert.equal(
      await fixture.repositories.readFile(
        fixture.repository,
        result.canonicalVersion.revision,
        "test/value.test.js",
      ),
      [
        'import { value } from "../src/value.js";',
        "if (value !== 1) { process.exit(1); }",
      ].join("\n"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project that configured nothing does not get a green for free", async () => {
  // The default config ships an integrity check and nothing else. It runs, it
  // passes, and it establishes nothing about whether the program works.
  assert.equal(
    validationEvidence(
      [
        {
          executable: "git",
          args: ["diff", "--check"],
          label: "patch integrity",
          proves: "integrity",
        },
      ],
      undefined,
    ),
    "integrity",
  );
  assert.equal(validationEvidence([], undefined), "none");
  assert.equal(
    validationEvidence([NODE_TEST], undefined),
    "executed",
  );
});

test("a baseline is reused at a revision that has already been measured", async () => {
  const cache = new ValidationBaselineCache();
  assert.equal(cache.get("repo_1", "abc", [NODE_TEST]), undefined);
  cache.set("repo_1", "abc", [NODE_TEST], [
    {
      command: NODE_TEST,
      exitCode: 0,
      stdout: "",
      stderr: "",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 1,
    },
  ]);
  assert.equal(cache.get("repo_1", "abc", [NODE_TEST])?.length, 1);
  // A different revision, or different commands, is a different question.
  assert.equal(cache.get("repo_1", "def", [NODE_TEST]), undefined);
  assert.equal(
    cache.get("repo_1", "abc", [{ ...NODE_TEST, label: "other" }]),
    undefined,
  );
});

test("a reproduction test is attested only when it failed before and passes after", async () => {
  // The strongest measured filter in the literature, and it is mechanical:
  // no model, no oracle, just the same test run either side of the change.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-repro-"));
  try {
    const fixture = await gradedFixture(root);
    const baseVersion = await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    );
    const workspace = await fixture.workspaces.create({
      taskId: "task_repro",
      rootPath: fixture.workspaceRoot,
      repository: fixture.repository,
      baseVersion,
    });
    await writeFile(
      path.join(workspace.path, "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );
    const changeSet = await fixture.workspaces.collectChangeSet(workspace, {
      symbolsChanged: ["value"],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "make the reproduction pass",
    });

    const result = await new IntegrationService(
      fixture.repositories,
      fixture.workspaces,
    ).integrate({
      repository: fixture.repository,
      integrationRoot: fixture.integrationRoot,
      changeSet,
      validationCommands: [],
      reproductionTest: {
        path: "test/value.test.js",
        executable: process.execPath,
        args: ["test/value.test.js"],
        label: "reproduction",
      },
      commitMessage: "coord: fix the value",
    });

    assert.equal(result.status, "integrated");
    assert.equal(result.reproduction?.failedBefore, true);
    assert.equal(result.reproduction?.passesAfter, true);
    assert.equal(result.reproduction?.attested, true);
    // An attested reproduction is the strongest thing integration can say,
    // and it says it even with no validation commands configured at all.
    assert.equal(result.evidence, "demonstrated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a reproduction test that already passed proves nothing and says so", async () => {
  // The failure mode this contract exists to catch: a test that was green
  // before the change is not evidence about the change, however green it is
  // afterwards.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-repro-vacuous-"));
  try {
    const fixture = await gradedFixture(root);
    const baseVersion = await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    );
    const workspace = await fixture.workspaces.create({
      taskId: "task_vacuous",
      rootPath: fixture.workspaceRoot,
      repository: fixture.repository,
      baseVersion,
    });
    await writeFile(
      path.join(workspace.path, "src", "other.js"),
      "export const other = 1;\n",
      "utf8",
    );
    const changeSet = await fixture.workspaces.collectChangeSet(workspace, {
      symbolsChanged: ["other"],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "add an unrelated file",
    });

    const result = await new IntegrationService(
      fixture.repositories,
      fixture.workspaces,
    ).integrate({
      repository: fixture.repository,
      integrationRoot: fixture.integrationRoot,
      changeSet,
      validationCommands: [],
      reproductionTest: {
        // Always passes, so it can never demonstrate anything.
        path: "test/trivial.js",
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        label: "reproduction",
      },
      commitMessage: "coord: add an unrelated file",
    });

    assert.equal(result.status, "integrated");
    assert.equal(result.reproduction?.failedBefore, false);
    assert.equal(result.reproduction?.attested, false);
    assert.match(result.reproduction?.explanation ?? "", /does not demonstrate/u);
    assert.equal(result.evidence, "none");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
