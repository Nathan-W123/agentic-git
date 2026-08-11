import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  resolveClaudeCommand,
  type PromptCliProcessRunner,
  parseClaudeUsage,
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
    assert.ok(args.includes("--effort"));
    assert.ok(args.includes("low"));
    const schemaArgument = args[args.indexOf("--json-schema") + 1];
    assert.equal(typeof schemaArgument, "string");
    const schema = JSON.parse(schemaArgument ?? "{}") as {
      required?: unknown;
    };
    assert.ok(Array.isArray(schema.required));
    calls.push({ args, options });
    if (args.includes("--permission-mode")) {
      assert.ok(schema.required.includes("taskId"));
      assert.ok(schema.required.includes("commands"));
      // Planning: instructions travel on stdin, never argv.
      assert.equal(args.includes(TASK.objective), false);
      assert.match(String(options.input), /coordination plan/u);
      // The answer arrives fenced, as real models often do.
      return output(
        claudeEnvelope("```json\n" + JSON.stringify(PLAN) + "\n```"),
      );
    }
    assert.ok(args.includes("--dangerously-skip-permissions"));
    assert.ok(schema.required.includes("outcome"));
    assert.ok(schema.required.includes("additionalFiles"));
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
    effort: "low",
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

test(
  "Windows Claude npm shims resolve to the native executable",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "coord-claude-shim-"));
    const nativeCommand = path.join(
      root,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );
    try {
      await mkdir(path.dirname(nativeCommand), { recursive: true });
      await writeFile(path.join(root, "claude.cmd"), "@echo off\n", "utf8");
      await writeFile(nativeCommand, "", "utf8");

      assert.equal(resolveClaudeCommand("claude.cmd", root), nativeCommand);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
  assert.throws(
    () =>
      createGeminiAdapter({
        agentId: "gemini",
        repository: fixture.repository,
        workspaces: fixture.workspaces,
        planningRoot: fixture.planningRoot,
        effort: "low",
      }),
    /supported only by Claude/u,
  );
});

test("claude usage is read from the envelope the adapter already parses", () => {
  // A real envelope, trimmed. Cache traffic dominates a coding session and is
  // billed, so a total that dropped it would understate cost by two orders of
  // magnitude here: 4 + 73 uncached against 24,566 + 24,514 cached.
  const envelope = JSON.stringify({
    is_error: false,
    result: '{"answer":"ok"}',
    total_cost_usd: 0.260363,
    usage: {
      input_tokens: 4,
      output_tokens: 73,
      cache_creation_input_tokens: 24566,
      cache_read_input_tokens: 24514,
    },
  });
  const usage = parseClaudeUsage(envelope);
  assert.equal(usage?.inputTokens, 4);
  assert.equal(usage?.outputTokens, 73);
  assert.equal(usage?.cacheCreationTokens, 24566);
  assert.equal(usage?.cacheReadTokens, 24514);
  assert.equal(usage?.totalTokens, 4 + 73 + 24566 + 24514);
  assert.equal(usage?.costUsd, 0.260363);
});

test("an envelope without usage reports nothing rather than zero", () => {
  // "not reported" and "cost nothing" are different claims, and a total built
  // from the second is quietly wrong.
  assert.equal(parseClaudeUsage('{"is_error":false,"result":"hi"}'), undefined);
  assert.equal(parseClaudeUsage("not json at all"), undefined);
  assert.equal(parseClaudeUsage(""), undefined);
});

test("the claude profile carries a usage reader and gemini does not", () => {
  // Gemini's envelope has no usage block, so claiming to read one would
  // manufacture zeros for every Gemini run.
  assert.equal(typeof CLAUDE_PROFILE.usage, "function");
  assert.equal(GEMINI_PROFILE.usage, undefined);
});

test("a task asked to look finishes with an empty changeset instead of failing", async () => {
  // The other half of the rule above. An audit or a summary succeeds by
  // changing nothing, and refusing that turned work that had been done into
  // "complete but changed no files" — a failure reported for a finished job.
  const fixture = await createFixture();
  const reportTask: TaskDefinition = {
    ...TASK,
    objective: "Give me a summary of the repository",
  };
  const runner: PromptCliProcessRunner = async (_executable, args) => {
    if (!args.includes("--yolo")) {
      return output(geminiEnvelope(JSON.stringify(PLAN)));
    }
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
    task: reportTask,
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
  assert.equal(changeSet.patches.length, 0);
  // And it carries the model's own words, which are the deliverable here.
  assert.ok(changeSet.agentExplanation.length > 0);
});
