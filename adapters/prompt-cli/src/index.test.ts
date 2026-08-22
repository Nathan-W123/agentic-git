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
  createCursorAdapter,
  createGeminiAdapter,
  extractJsonObject,
  resolveClaudeCommand,
  type PromptCliProcessRunner,
  parseClaudeSessionId,
  parseClaudeUsage,
  claudeResultEnvelope,
  readClaudeNarration,
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

const FORCE_QUESTION_MARKER =
  "[Coordinator: force a question round before implementation.]";

const ASK_TASK: TaskDefinition = {
  ...TASK,
  objective: `${TASK.objective}\n\n${FORCE_QUESTION_MARKER}`,
};

const ASK_PLAN: AgentPlan = {
  ...PLAN,
  objective: ASK_TASK.objective,
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

function claudeEnvelope(result: string, sessionId?: string): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
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

test("claude: an explicit ask cannot complete before asking its questions", async () => {
  const fixture = await createFixture();
  const runner: PromptCliProcessRunner = async (
    _executable,
    args,
    options = {},
  ) => {
    if (args.includes("--permission-mode")) {
      return output(claudeEnvelope(JSON.stringify(ASK_PLAN)));
    }
    const schemaArgument = args[args.indexOf("--json-schema") + 1];
    const schema = JSON.parse(schemaArgument ?? "{}") as {
      properties?: { outcome?: { enum?: unknown }; questions?: unknown };
      required?: unknown[];
    };
    assert.deepEqual(schema.properties?.outcome?.enum, ["question_asked"]);
    assert.ok(schema.required?.includes("questions"));
    assert.match(String(options.input), /explicit \/ask command/u);
    assert.match(String(options.input), /between one and 6 focused questions/u);
    return output(claudeEnvelope(JSON.stringify(COMPLETION)));
  };

  const adapter = createClaudeAdapter({
    agentId: "claude",
    repository: fixture.repository,
    workspaces: fixture.workspaces,
    planningRoot: fixture.planningRoot,
    command: "claude-test",
    runner,
  });
  const session = await adapter.startTask({
    task: ASK_TASK,
    canonicalVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
    repositoryId: fixture.repository.id,
  });
  await adapter.requestPlan(session.id);
  const workspace = await fixture.workspaces.create({
    taskId: ASK_TASK.id,
    rootPath: fixture.workspaceRoot,
    repository: fixture.repository,
    baseVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
  });

  await assert.rejects(
    adapter.sendContext(session.id, contextFor(workspace)),
    /must produce a question_asked outcome/u,
  );
});

test("claude: every explicit ask opens the question round, then continues with its answer", async () => {
  const fixture = await createFixture();
  const executionInputs: string[] = [];
  const runner: PromptCliProcessRunner = async (
    _executable,
    args,
    options = {},
  ) => {
    if (args.includes("--permission-mode")) {
      return output(claudeEnvelope(JSON.stringify(ASK_PLAN)));
    }
    executionInputs.push(String(options.input));
    if (executionInputs.length === 1) {
      return output(
        claudeEnvelope(
          JSON.stringify({
            ...COMPLETION,
            outcome: "question_asked",
            requestId: "ask_first_round",
            symbolsChanged: [],
            explanation: "",
            questions: [
              {
                question: "Which value should the fixture use?",
                options: ["Two", "Three"],
                recommended: 0,
              },
            ],
          }),
        ),
      );
    }
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
    runner,
  });
  const session = await adapter.startTask({
    task: ASK_TASK,
    canonicalVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
    repositoryId: fixture.repository.id,
  });
  await adapter.requestPlan(session.id);
  const seen: string[] = [];
  await adapter.streamEvents(session.id, (event) => {
    seen.push(event.event);
    if (event.event === "question_asked") {
      assert.equal(event.questions?.[0]?.recommended, 0);
      void adapter.resolveQuestion(session.id, {
        requestId: event.requestId ?? "",
        status: "answered",
        answers: [{ chosen: 0 }],
      });
    }
  });
  const workspace = await fixture.workspaces.create({
    taskId: ASK_TASK.id,
    rootPath: fixture.workspaceRoot,
    repository: fixture.repository,
    baseVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
  });

  await adapter.sendContext(session.id, contextFor(workspace));

  assert.equal(executionInputs.length, 2);
  assert.match(executionInputs[0] ?? "", /explicit \/ask command/u);
  assert.doesNotMatch(executionInputs[0] ?? "", /Required validation commands/u);
  assert.match(executionInputs[1] ?? "", /Answers you already have/u);
  assert.match(executionInputs[1] ?? "", /Which value should the fixture use\?/u);
  assert.match(executionInputs[1] ?? "", /already been satisfied/u);
  assert.ok(seen.includes("question_asked"), seen.join(", "));
  const changeSet = await adapter.collectChanges(session.id);
  assert.equal(changeSet.patches.length, 1);
});

test("claude: a transcript past the cap still finishes — the tail holds the result", async () => {
  // The stream carries every thinking step and tool result, so a long run
  // outgrows any cap. This exact shape — truncated flag set, head gone
  // mid-line, envelope last — used to fail the whole round as "output
  // exceeded the configured limit".
  const fixture = await createFixture();
  const retention: Array<string | undefined> = [];
  const runner: PromptCliProcessRunner = async (
    _executable,
    args,
    options = {},
  ) => {
    retention.push(options.retainOutput);
    if (args.includes("--permission-mode")) {
      return output(
        claudeEnvelope("```json\n" + JSON.stringify(PLAN) + "\n```"),
      );
    }
    await writeFile(
      path.join(String(options.cwd), "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );
    return output(
      "[output truncated]\n" +
        '99,"tool_use_id":"toolu_x"}\n' +
        '{"type":"assistant","message":{"content":[]}}\n'.repeat(50) +
        claudeEnvelope(JSON.stringify(COMPLETION)),
      { stdoutTruncated: true },
    );
  };

  const adapter = createClaudeAdapter({
    agentId: "claude",
    repository: fixture.repository,
    workspaces: fixture.workspaces,
    planningRoot: fixture.planningRoot,
    command: "claude-test",
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
  // The adapter asked the runner to keep the end of the stream, which is
  // what makes the truncated head harmless.
  assert.ok(retention.every((mode) => mode === "tail"));
});

test("claude: an action round trip — the platform acts, the next round knows", async () => {
  // "Push to GitHub" through the adapter's own machinery: round one is told
  // what the platform can do and asks for the push; the platform answers
  // through resolveAction; round two's prompt carries the result and the
  // agent finishes by reporting it, with nothing in the diff.
  const fixture = await createFixture();
  const executionInputs: string[] = [];
  const runner: PromptCliProcessRunner = async (_executable, args, options = {}) => {
    if (args.includes("--permission-mode")) {
      return output(claudeEnvelope(JSON.stringify(PLAN)));
    }
    executionInputs.push(String(options.input));
    if (executionInputs.length === 1) {
      return output(
        claudeEnvelope(
          JSON.stringify({
            ...COMPLETION,
            outcome: "action_requested",
            requestId: "act_1",
            action: "push",
            symbolsChanged: [],
            explanation: "",
          }),
        ),
      );
    }
    return output(
      claudeEnvelope(
        JSON.stringify({
          ...COMPLETION,
          symbolsChanged: [],
          explanation: "Pushed abc1234 to coord/export-test as octocat.",
        }),
      ),
    );
  };

  const adapter = createClaudeAdapter({
    agentId: "claude",
    repository: fixture.repository,
    workspaces: fixture.workspaces,
    planningRoot: fixture.planningRoot,
    command: "claude-test",
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

  const seen: string[] = [];
  await adapter.streamEvents(session.id, (event) => {
    seen.push(event.event);
    if (event.event === "action_requested") {
      assert.equal(event.action, "push");
      // The platform's half of the round trip, as the coordinator does it.
      void adapter.resolveAction(session.id, {
        requestId: event.requestId ?? "",
        action: "push",
        outcome: "done",
        detail: { url: "https://github.example/x/y" },
        explanation: "Pushed abc1234 to coord/export-test.",
      });
    }
  });

  const workspace = await fixture.workspaces.create({
    taskId: TASK.id,
    rootPath: fixture.workspaceRoot,
    repository: fixture.repository,
    baseVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
  });
  await adapter.sendContext(session.id, contextFor(workspace));

  // Round one was told what it may ask for; round two was told the answer.
  assert.match(executionInputs[0] ?? "", /"push" publishes/u);
  assert.match(
    executionInputs[1] ?? "",
    /Platform actions already performed/u,
  );
  assert.match(executionInputs[1] ?? "", /coord\/export-test/u);
  assert.ok(seen.includes("action_requested"), seen.join(", "));

  // The action is the deliverable; the diff is honestly empty.
  const changes = await adapter.collectChanges(session.id);
  assert.equal(changes.patches.length, 0);
  assert.equal(
    changes.agentExplanation,
    "Pushed abc1234 to coord/export-test as octocat.",
  );
});

test("claude: the vendor session id chains --resume across execs and instances", async () => {
  // Warm continuation, adapter side: the envelope's session_id is captured
  // after every exec, rides the next one as --resume, and — handed over as
  // the session record's resume token — lets a completely fresh adapter
  // instance pick the conversation up where the vendor left it.
  const fixture = await createFixture();
  const calls: Array<{ args: readonly string[] }> = [];
  const runner: PromptCliProcessRunner = async (_executable, args, options = {}) => {
    calls.push({ args });
    if (args.includes("--permission-mode")) {
      return output(
        claudeEnvelope(
          "```json\n" + JSON.stringify(PLAN) + "\n```",
          "sess-plan-11111111",
        ),
      );
    }
    await writeFile(
      path.join(String(options.cwd), "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );
    return output(
      claudeEnvelope(JSON.stringify(COMPLETION), "sess-exec-22222222"),
    );
  };
  const adapter = createClaudeAdapter({
    agentId: "claude",
    repository: fixture.repository,
    workspaces: fixture.workspaces,
    planningRoot: fixture.planningRoot,
    command: "claude-test",
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
  // The first exec of a fresh session has nothing to resume.
  assert.equal(calls[0]?.args.includes("--resume"), false);

  const workspace = await fixture.workspaces.create({
    taskId: TASK.id,
    rootPath: fixture.workspaceRoot,
    repository: fixture.repository,
    baseVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
  });
  await adapter.sendContext(session.id, contextFor(workspace));
  // The edit phase resumed the session planning opened…
  const executionArgs = calls[1]?.args ?? [];
  assert.equal(
    executionArgs[executionArgs.indexOf("--resume") + 1],
    "sess-plan-11111111",
  );
  // …and the token now names the state as the newest exec left it.
  assert.equal(adapter.resumeToken(session.id), "sess-exec-22222222");

  // A different instance — production's shape, where every run constructs
  // its own adapters — adopts the handed-over record and opens its first
  // exec inside the same vendor session.
  const secondCalls: Array<{ args: readonly string[] }> = [];
  const secondRunner: PromptCliProcessRunner = async (_executable, args) => {
    secondCalls.push({ args });
    return output(
      claudeEnvelope(
        "```json\n" +
          JSON.stringify({ ...PLAN, taskId: "task_turn_two" }) +
          "\n```",
        "sess-plan-33333333",
      ),
    );
  };
  const second = createClaudeAdapter({
    agentId: "claude",
    repository: fixture.repository,
    workspaces: fixture.workspaces,
    planningRoot: fixture.planningRoot,
    command: "claude-test",
    runner: secondRunner,
  });
  const continued = await second.continueTask(
    { ...session, resume: "sess-exec-22222222" },
    {
      task: { ...TASK, id: "task_turn_two", objective: "Update it again" },
      canonicalVersion: await fixture.repositories.getCanonicalVersion(
        fixture.repository,
      ),
      repositoryId: fixture.repository.id,
    },
  );
  assert.equal(continued.id, session.id);
  assert.equal(continued.taskId, "task_turn_two");
  assert.equal(continued.resume, "sess-exec-22222222");
  await second.requestPlan(continued.id);
  const adoptedArgs = secondCalls[0]?.args ?? [];
  assert.equal(
    adoptedArgs[adoptedArgs.indexOf("--resume") + 1],
    "sess-exec-22222222",
  );
  assert.equal(second.resumeToken(continued.id), "sess-plan-33333333");
});

test("claude: a stale resume token is retried without the flag, once", async () => {
  // A restart or the CLI's own cleanup can invalidate a session id. That
  // costs the conversation its memory, never the turn: the exec is retried
  // once without --resume, the same policy the chat providers apply.
  const fixture = await createFixture();
  const calls: Array<{ args: readonly string[] }> = [];
  const runner: PromptCliProcessRunner = async (_executable, args, options = {}) => {
    calls.push({ args });
    if (args.includes("--permission-mode")) {
      return output(
        claudeEnvelope(
          "```json\n" + JSON.stringify(PLAN) + "\n```",
          "sess-stale-44444444",
        ),
      );
    }
    if (args.includes("--resume")) {
      return output("", {
        exitCode: 1,
        stderr: "No conversation found with session ID sess-stale-44444444",
      });
    }
    await writeFile(
      path.join(String(options.cwd), "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );
    return output(
      claudeEnvelope(JSON.stringify(COMPLETION), "sess-fresh-55555555"),
    );
  };
  const adapter = createClaudeAdapter({
    agentId: "claude",
    repository: fixture.repository,
    workspaces: fixture.workspaces,
    planningRoot: fixture.planningRoot,
    command: "claude-test",
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

  // Plan, the failed resume, the bare retry — and nothing more.
  assert.equal(calls.length, 3);
  assert.equal(calls[1]?.args.includes("--resume"), true);
  assert.equal(calls[2]?.args.includes("--resume"), false);
  // The stale token is gone; the retry's envelope named the fresh state.
  assert.equal(adapter.resumeToken(session.id), "sess-fresh-55555555");
});

test("the claude profile carries resume hooks and gemini does not", () => {
  // Gemini's envelope names no session, so claiming to resume one would
  // put a flag its CLI may not accept on every invocation.
  assert.equal(typeof CLAUDE_PROFILE.resumeArgs, "function");
  assert.equal(typeof CLAUDE_PROFILE.sessionId, "function");
  assert.equal(GEMINI_PROFILE.resumeArgs, undefined);
  assert.equal(GEMINI_PROFILE.sessionId, undefined);
});

test("parseClaudeSessionId accepts the envelope's id and nothing else", () => {
  assert.equal(
    parseClaudeSessionId(claudeEnvelope("done", "sess-ok-12345678")),
    "sess-ok-12345678",
  );
  // Absent, malformed, or suspicious ids contribute nothing: a turn that
  // cannot be resumed is still a turn that worked.
  assert.equal(parseClaudeSessionId(claudeEnvelope("done")), undefined);
  assert.equal(parseClaudeSessionId("not json"), undefined);
  assert.equal(
    parseClaudeSessionId(claudeEnvelope("done", "short")),
    undefined,
  );
  assert.equal(
    parseClaudeSessionId(
      JSON.stringify({ result: "done", session_id: "bad id with spaces" }),
    ),
    undefined,
  );
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

test("cursor: large prompts are split below the per-argument spawn limit", async () => {
  const fixture = await createFixture();
  const objective = `Investigate Cursor with ${"a large context ".repeat(12_000)}`;
  const task = { ...TASK, objective, agentId: "cursor" };
  const plan = { ...PLAN, objective };
  let promptArguments: readonly string[] = [];

  const runner: PromptCliProcessRunner = async (
    _executable,
    args,
    options = {},
  ) => {
    const promptStart = args.indexOf("--force") + 1;
    promptArguments = args.slice(promptStart);
    assert.equal(options.input, undefined);
    return output(JSON.stringify(plan));
  };

  const adapter = createCursorAdapter({
    agentId: "cursor",
    repository: fixture.repository,
    workspaces: fixture.workspaces,
    planningRoot: fixture.planningRoot,
    runner,
  });
  const session = await adapter.startTask({
    task,
    canonicalVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
    repositoryId: fixture.repository.id,
  });
  await adapter.requestPlan(session.id);

  assert.ok(promptArguments.length > 1);
  assert.ok(
    promptArguments.every(
      (argument) => Buffer.byteLength(argument, "utf8") < 128 * 1024,
    ),
  );
  assert.match(promptArguments.join(" "), /a large context a large context/u);
  assert.ok(promptArguments.join(" ").includes(objective));
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

test("a completion that changed nothing is reported, not failed", async () => {
  const fixture = await createFixture();
  const runner: PromptCliProcessRunner = async (_executable, args) => {
    if (!args.includes("--yolo")) {
      return output(geminiEnvelope(JSON.stringify(PLAN)));
    }
    // Reports success without touching the workspace. This used to be failed
    // as a broken CLI, which meant judging intent from the objective's
    // wording — and ordinary requests were told their authentication was
    // broken when it was not.
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
  // Collected, not thrown: an empty result travels on and is narrated as
  // having changed nothing, which a reader can judge for themselves.
  const changeSet = await adapter.collectChanges(session.id);
  assert.equal(changeSet.patches.length, 0);
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

test("a streamed run is read from its result event, in either format", () => {
  // Execution streams and planning does not, so both formats reach the same
  // reader. One envelope on its own is still one envelope.
  const buffered = JSON.stringify({ type: "result", result: "done" });
  assert.deepEqual(claudeResultEnvelope(buffered), {
    type: "result",
    result: "done",
  });

  const streamed = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [] } }),
    JSON.stringify({ type: "result", result: "done", usage: { input_tokens: 5 } }),
  ].join("\n");
  assert.equal(
    (claudeResultEnvelope(streamed) as { result?: string }).result,
    "done",
  );
  // Billed the same either way, so streaming does not quietly stop recording
  // what a run cost.
  assert.equal(parseClaudeUsage(streamed)?.inputTokens, 5);
});

test("a stream that ends without a result is an error, not an empty answer", () => {
  // The failure this has to be loudest about. A run that did the work and
  // reported nothing looks exactly like a run that did nothing, and silence
  // is what the whole change exists to end.
  const truncated = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [] } }),
  ].join("\n");
  assert.throws(() => claudeResultEnvelope(truncated), /streamed no result/u);
  // Usage is not worth failing a run over, so it answers nothing instead.
  assert.equal(parseClaudeUsage(truncated), undefined);
});

test("a line that is not JSON does not break the stream around it", () => {
  // A CLI may print whatever it likes alongside its events, and a warning on
  // stdout must not cost the run its result.
  const noisy = [
    "warning: something the vendor felt like saying",
    JSON.stringify({ type: "result", result: "done" }),
  ].join("\n");
  assert.equal(
    (claudeResultEnvelope(noisy) as { result?: string }).result,
    "done",
  );
});

test("narration is what the agent said, not what it did", () => {
  // Assistant text only. Tool calls and their results are the noise a reader
  // does not want, and there is far more of that than there is of this.
  assert.equal(
    readClaudeNarration({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "The pieces are pink and angular; changing them now." },
        ],
      },
    }),
    "The pieces are pink and angular; changing them now.",
  );
  assert.equal(
    readClaudeNarration({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: {} }] },
    }),
    undefined,
  );
  assert.equal(readClaudeNarration({ type: "result", result: "done" }), undefined);
  assert.equal(readClaudeNarration({ type: "assistant" }), undefined);
  assert.equal(readClaudeNarration("not an object"), undefined);
});

test("execution streams and planning does not", () => {
  // Planning is one answer that arrives at the end either way, so streaming it
  // would buy nothing and put the schema parse behind a second format.
  assert.ok(CLAUDE_PROFILE.executionArgs(undefined, undefined, undefined).includes("stream-json"));
  assert.ok(CLAUDE_PROFILE.executionArgs(undefined, undefined, undefined).includes("--verbose"));
  assert.ok(CLAUDE_PROFILE.planningArgs(undefined, undefined, undefined).includes("json"));
  assert.equal(
    CLAUDE_PROFILE.planningArgs(undefined, undefined, undefined).includes("stream-json"),
    false,
  );
});

test("the execution prompt asks for an ending a person can read", async () => {
  // The channel shows one line when a task lands, and it is whatever the
  // agent wrote here. Left unsaid, models wrote it for the next engineer to
  // read the diff — paths, function names, the reasoning between them — and
  // the reader got a paragraph of implementation detail clipped at the
  // channel's bound.
  const fixture = await createFixture();
  const executionInputs: string[] = [];
  const runner: PromptCliProcessRunner = async (
    _executable,
    args,
    options = {},
  ) => {
    if (args.includes("--permission-mode")) {
      return output(claudeEnvelope(JSON.stringify(PLAN)));
    }
    executionInputs.push(String(options.input));
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
  await adapter.collectChanges(session.id);

  const prompt = executionInputs[0] ?? "";
  assert.match(prompt, /one or two plain sentences saying what is different/u);
  assert.match(prompt, /No file paths, function or symbol names/u);
  assert.match(prompt, /Keep it short/u);
  assert.match(prompt, /Say the whole thing/u);
  // No character count in the ask any more: the channel shows the whole
  // account, and a number here only taught the model to stop near it.
  assert.doesNotMatch(prompt, /under \d+ characters/u);
});

test("claude: an explicit ask is planned as the work that follows its questions", async () => {
  // The plan is what the implementation round is allowed to touch, so a plan
  // made from an objective still carrying the routing marker used to read as
  // "plan to ask a question" — leaving nothing to build once the answers
  // arrived. `/ask` delays the work; the plan is still a plan for the work.
  const fixture = await createFixture();
  const planningInputs: string[] = [];
  const runner: PromptCliProcessRunner = async (
    _executable,
    args,
    options = {},
  ) => {
    assert.ok(args.includes("--permission-mode"));
    planningInputs.push(String(options.input));
    return output(claudeEnvelope(JSON.stringify(ASK_PLAN)));
  };

  const adapter = createClaudeAdapter({
    agentId: "claude",
    repository: fixture.repository,
    workspaces: fixture.workspaces,
    planningRoot: fixture.planningRoot,
    command: "claude-test",
    runner,
  });
  const session = await adapter.startTask({
    task: ASK_TASK,
    canonicalVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
    repositoryId: fixture.repository.id,
  });
  await adapter.requestPlan(session.id);

  assert.match(planningInputs[0] ?? "", /Objective: Update the fixture value/u);
  assert.doesNotMatch(planningInputs[0] ?? "", /Coordinator: force a question/u);
  assert.match(planningInputs[0] ?? "", /clarification round/u);
});

test("claude: a released file is handed back and the next round is prompted with the narrowed plan", async () => {
  const fixture = await createFixture();
  const executionInputs: string[] = [];
  const runner: PromptCliProcessRunner = async (
    _executable,
    args,
    options = {},
  ) => {
    if (args.includes("--permission-mode")) {
      return output(
        claudeEnvelope(
          JSON.stringify({
            ...PLAN,
            expectedFiles: ["src/value.js", "src/spare.js"],
          }),
        ),
      );
    }
    executionInputs.push(String(options.input));
    if (executionInputs.length === 1) {
      return output(
        claudeEnvelope(
          JSON.stringify({
            ...COMPLETION,
            outcome: "scope_release_requested",
            requestId: "release_1",
            symbolsChanged: [],
            explanation: "",
            additionalFiles: ["src/spare.js"],
            reason: "The spare file turned out not to need changing",
          }),
        ),
      );
    }
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
  const seen: string[] = [];
  await adapter.streamEvents(session.id, (event) => {
    seen.push(event.event);
    if (event.event === "scope_release_requested") {
      assert.deepEqual(event.releasedFiles, ["src/spare.js"]);
      void adapter.resolveScopeChange(session.id, {
        requestId: event.requestId ?? "",
        taskId: TASK.id,
        decision: "approved",
        revisedPlan: { ...PLAN, expectedFiles: ["src/value.js"] },
        constraints: [],
        ownershipGrants: [],
        explanation: "Released",
        decidedAt: new Date().toISOString(),
      });
    }
  });
  const workspace = await fixture.workspaces.create({
    taskId: TASK.id,
    rootPath: fixture.workspaceRoot,
    repository: fixture.repository,
    baseVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
  });

  await adapter.sendContext(session.id, contextFor(workspace));

  assert.ok(seen.includes("scope_release_requested"), seen.join(", "));
  assert.equal(executionInputs.length, 2);
  // The round after a granted release is prompted with the plan now in force,
  // so the agent cannot go on believing the released file is still its own.
  assert.doesNotMatch(executionInputs[1] ?? "", /src\/spare\.js/u);
  const changeSet = await adapter.collectChanges(session.id);
  assert.equal(changeSet.patches.length, 1);
});

test("claude: a task queued behind this one is named in the prompt it reads", async () => {
  // The trigger. The release outcome existed, worked, and was never used,
  // because nothing ever told an agent that anybody was waiting on anything.
  const fixture = await createFixture();
  let executionInput = "";
  const runner: PromptCliProcessRunner = async (
    _executable,
    args,
    options = {},
  ) => {
    if (args.includes("--permission-mode")) {
      return output(claudeEnvelope(JSON.stringify(PLAN)));
    }
    executionInput = String(options.input);
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
  const notice = {
    taskId: "task_waiting",
    files: ["src/value.js"],
    reason: "Task task_waiting is waiting for these before it can start",
    occurredAt: new Date().toISOString(),
  };
  await adapter.noteScopeContention?.(session.id, notice);
  // Said twice, printed once: a queue is re-read while the agent works, and
  // repeating it would crowd out the work.
  await adapter.noteScopeContention?.(session.id, notice);
  // An unknown session is not an error — the notice is advice, and a session
  // that has already ended cannot act on it.
  await adapter.noteScopeContention?.("session_gone", notice);
  await adapter.sendContext(session.id, contextFor(workspace));

  assert.equal(executionInput.split("task_waiting").length - 1, 1);
  assert.match(executionInput, /queued behind resources you hold/u);
  assert.match(executionInput, /src\/value\.js/u);
  // The standing instruction stands whether or not anybody is waiting.
  assert.match(executionInput, /Hand files back as you finish with them/u);
});

test("claude: the execution prompt and schema both offer handing scope back", async () => {
  const fixture = await createFixture();
  let executionInput = "";
  let executionSchema: { properties?: { outcome?: { enum?: string[] } } } = {};
  const runner: PromptCliProcessRunner = async (
    _executable,
    args,
    options = {},
  ) => {
    if (args.includes("--permission-mode")) {
      return output(claudeEnvelope(JSON.stringify(PLAN)));
    }
    executionInput = String(options.input);
    executionSchema = JSON.parse(
      String(args[args.indexOf("--json-schema") + 1]),
    ) as typeof executionSchema;
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

  assert.match(executionInput, /scope_release_requested/u);
  assert.ok(
    executionSchema.properties?.outcome?.enum?.includes(
      "scope_release_requested",
    ),
    JSON.stringify(executionSchema.properties?.outcome),
  );
});
