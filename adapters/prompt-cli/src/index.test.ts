import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { CoordinatorContext } from "@coord/agent-protocol";
import type { AgentPlan, TaskDefinition } from "@coord/shared-types";
import {
  RepositoryService,
  type CanonicalRepository,
  type ProcessOptions,
  type ProcessOutput,
} from "@coord/repository-service";
import {
  GitWorktreeWorkspaceManager,
  type TaskWorkspace,
} from "@coord/workspace-manager";

import {
  PromptCliAdapter,
  CLAUDE_PROFILE,
  GEMINI_PROFILE,
  createClaudeAdapter,
  createGeminiAdapter,
  extractJsonObject,
  type PromptCliProcessRunner,
} from "./index.js";

const TASK: TaskDefinition = {
  id: "task_update_value",
  objective: "Update the fixture value",
  agentId: "claude",
  validationCommands: [],
};

const PLAN: AgentPlan = {
  taskId: TASK.id,
  objective: TASK.objective,
  expectedFiles: ["src/value.js"],
  expectedSymbols: ["value"],
  dependencies: [],
  commands: [],
  externalAccess: [],
  riskLevel: "low",
};

const COMPLETION = {
  outcome: "completed",
  symbolsChanged: ["value"],
  explanation: "Updated the fixture value",
  requestId: "",
  additionalFiles: [],
  additionalSymbols: [],
  additionalApis: [],
  additionalSchemas: [],
  additionalConfigKeys: [],
  additionalTests: [],
  additionalServices: [],
  reason: "",
};

interface Fixture {
  root: string;
  repository: CanonicalRepository;
  repositories: RepositoryService;
  workspaces: GitWorktreeWorkspaceManager;
  planningRoot: string;
  workspaceRoot: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-promptcli-test-"));
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
  return {
    root,
    repository,
    repositories,
    workspaces: new GitWorktreeWorkspaceManager(repositories.getGitClient()),
    planningRoot: path.join(root, "planning"),
    workspaceRoot: path.join(root, "workspaces"),
  };
}

function contextFor(workspace: TaskWorkspace): CoordinatorContext {
  return {
    decision: {
      decision: "approved",
      taskId: TASK.id,
      workspaceId: workspace.id,
      ownershipGrants: [],
      constraints: [],
      blockedBy: [],
      explanation: "Approved",
    },
    canonicalVersion: workspace.baseVersion,
    workspacePath: workspace.path,
  };
}

function output(
  stdout: string,
  overrides: Partial<ProcessOutput> = {},
): ProcessOutput {
  return { exitCode: 0, stdout, stderr: "", durationMs: 1, ...overrides };
}

function claudeEnvelope(result: string): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
  });
}

function geminiEnvelope(response: string): string {
  return JSON.stringify({ response, stats: {} });
}

test("extractJsonObject tolerates prose and code fences but never repairs", () => {
  assert.deepEqual(extractJsonObject('{"a":1}', "x"), { a: 1 });
  assert.deepEqual(
    extractJsonObject('Here is the plan:\n```json\n{"a":1}\n```\nDone.', "x"),
    { a: 1 },
  );
  assert.throws(() => extractJsonObject("no json here", "x"), /no JSON object/u);
  assert.throws(() => extractJsonObject('{"broken": }', "x"), /Could not parse/u);
});

test("claude: plan-mode planning, skip-permissions execution, collected diff", async () => {
  const fixture = await createFixture();
  const calls: Array<{ args: readonly string[]; options: ProcessOptions }> = [];
  const runner: PromptCliProcessRunner = async (executable, args, options = {}) => {
    assert.equal(executable, "claude-test");
    calls.push({ args, options });
    if (args.includes("--permission-mode")) {
      // Planning: instructions travel on stdin, never argv.
      assert.equal(args.includes(TASK.objective), false);
      assert.match(String(options.input), /coordination plan/u);
      // The answer arrives fenced, as real models often do.
      return output(
        claudeEnvelope("```json\n" + JSON.stringify(PLAN) + "\n```"),
      );
    }
    assert.ok(args.includes("--dangerously-skip-permissions"));
    assert.ok(options.cwd !== undefined);
    await writeFile(
      path.join(String(options.cwd), "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );
    return output(claudeEnvelope(JSON.stringify(COMPLETION)));
  };

  const adapter = createClaudeAdapter({
    agentId: "claude",
    repository: fixture.repository,
    workspaces: fixture.workspaces,
    planningRoot: fixture.planningRoot,
    command: "claude-test",
    args: ["--model", "claude-test-model"],
    runner,
  });

  const session = await adapter.startTask({
    task: TASK,
    canonicalVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
    repositoryId: fixture.repository.id,
  });
  const plan = await adapter.requestPlan(session.id);
  assert.deepEqual(plan.expectedFiles, ["src/value.js"]);
  assert.ok(calls[0]?.args.includes("--model"));
  assert.ok(calls[0]?.args.includes("claude-test-model"));

  const workspace = await fixture.workspaces.create({
    taskId: TASK.id,
    rootPath: fixture.workspaceRoot,
    repository: fixture.repository,
    baseVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
  });
  await adapter.sendContext(session.id, contextFor(workspace));
  const changeSet = await adapter.collectChanges(session.id);
  assert.equal(changeSet.patches.length, 1);
  assert.equal(changeSet.patches[0]?.path, "src/value.js");
  assert.deepEqual(changeSet.symbolsChanged, ["value"]);
});

test("gemini: json envelope, --yolo execution, collected diff", async () => {
  const fixture = await createFixture();
  const runner: PromptCliProcessRunner = async (executable, args, options = {}) => {
    assert.equal(executable, "gemini");
    if (!args.includes("--yolo")) {
      return output(geminiEnvelope(JSON.stringify(PLAN)));
    }
    await writeFile(
      path.join(String(options.cwd), "src", "value.js"),
      "export const value = 3;\n",
      "utf8",
    );
    return output(geminiEnvelope(JSON.stringify(COMPLETION)));
  };

  const adapter = createGeminiAdapter({
    agentId: "gemini",
    repository: fixture.repository,
    workspaces: fixture.workspaces,
    planningRoot: fixture.planningRoot,
    runner,
  });
  const session = await adapter.startTask({
    task: TASK,
    canonicalVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
    repositoryId: fixture.repository.id,
  });
  await adapter.requestPlan(session.id);
  const workspace = await fixture.workspaces.create({
    taskId: TASK.id,
    rootPath: fixture.workspaceRoot,
    repository: fixture.repository,
    baseVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
  });
  await adapter.sendContext(session.id, contextFor(workspace));
  const changeSet = await adapter.collectChanges(session.id);
  assert.equal(changeSet.patches.length, 1);
});

test("an error envelope fails planning instead of being parsed as a plan", async () => {
  const fixture = await createFixture();
  const runner: PromptCliProcessRunner = async () =>
    output(
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "Invalid API key",
      }),
    );
  const adapter = createClaudeAdapter({
    agentId: "claude",
    repository: fixture.repository,
    workspaces: fixture.workspaces,
    planningRoot: fixture.planningRoot,
    runner,
  });
  const session = await adapter.startTask({
    task: TASK,
    canonicalVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
    repositoryId: fixture.repository.id,
  });
  await assert.rejects(
    adapter.requestPlan(session.id),
    /Claude reported an error result/u,
  );
});

test("a completion that changed nothing is a failure, not an empty success", async () => {
  const fixture = await createFixture();
  const runner: PromptCliProcessRunner = async (_executable, args) => {
    if (!args.includes("--yolo")) {
      return output(geminiEnvelope(JSON.stringify(PLAN)));
    }
    // Reports success without touching the workspace — the signature of an
    // unauthenticated CLI answering conversationally.
    return output(geminiEnvelope(JSON.stringify(COMPLETION)));
  };
  const adapter = createGeminiAdapter({
    agentId: "gemini",
    repository: fixture.repository,
    workspaces: fixture.workspaces,
    planningRoot: fixture.planningRoot,
    runner,
  });
  const session = await adapter.startTask({
    task: TASK,
    canonicalVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
    repositoryId: fixture.repository.id,
  });
  await adapter.requestPlan(session.id);
  const workspace = await fixture.workspaces.create({
    taskId: TASK.id,
    rootPath: fixture.workspaceRoot,
    repository: fixture.repository,
    baseVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
  });
  await adapter.sendContext(session.id, contextFor(workspace));
  await assert.rejects(
    adapter.collectChanges(session.id),
    /changed no files/u,
  );
});

test("configuration cannot smuggle arbitrary flags through args", async () => {
  const fixture = await createFixture();
  assert.throws(
    () =>
      new PromptCliAdapter({
        agentId: "claude",
        repository: fixture.repository,
        workspaces: fixture.workspaces,
        planningRoot: fixture.planningRoot,
        profile: CLAUDE_PROFILE,
        args: ["--dangerously-skip-permissions", "x"],
      }),
    /only a single --model/u,
  );
  assert.throws(
    () =>
      new PromptCliAdapter({
        agentId: "gemini",
        repository: fixture.repository,
        workspaces: fixture.workspaces,
        planningRoot: fixture.planningRoot,
        profile: GEMINI_PROFILE,
        args: ["--model", "a", "--extra", "b"],
      }),
    /only a single --model/u,
  );
});
