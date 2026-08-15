import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentEvent, CoordinatorContext } from "@coord/agent-protocol";
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
  CodexAdapter,
  CodexWriteDeniedError,
  parseCodexSessionId,
  parseCodexTokens,
  type CodexProcessRunner,
} from "./index.js";

const TASK: TaskDefinition = {
  id: "task_update_value",
  objective: "Update the fixture value",
  agentId: "codex",
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

interface Fixture {
  root: string;
  repository: CanonicalRepository;
  repositories: RepositoryService;
  workspaces: GitWorktreeWorkspaceManager;
  planningRoot: string;
  workspaceRoot: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-codex-test-"));
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

function output(stdout: string, overrides: Partial<ProcessOutput> = {}): ProcessOutput {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 1,
    ...overrides,
  };
}

test("runs structured read-only planning then workspace-write execution", async () => {
  const fixture = await createFixture();
  const calls: Array<{
    executable: string;
    args: readonly string[];
    options: ProcessOptions;
    schemaPath: string;
  }> = [];
  const runner: CodexProcessRunner = async (executable, args, options = {}) => {
    const schemaIndex = args.indexOf("--output-schema");
    const schemaPath = args[schemaIndex + 1];
    assert.ok(schemaPath !== undefined);
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as {
      properties?: Record<string, unknown>;
    };
    calls.push({ executable, args, options, schemaPath });

    const sandbox = args[args.indexOf("--sandbox") + 1];
    if (sandbox === "read-only") {
      assert.ok(schema.properties?.["expectedFiles"] !== undefined);
      return output(JSON.stringify(PLAN));
    }

    assert.equal(sandbox, "workspace-write");
    assert.ok(schema.properties?.["symbolsChanged"] !== undefined);
    assert.ok(options.cwd !== undefined);
    await writeFile(
      path.join(options.cwd, "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );
    return output(
      JSON.stringify({
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
      }),
    );
  };

  try {
    const adapter = new CodexAdapter({
      agentId: "codex",
      repository: fixture.repository,
      workspaces: fixture.workspaces,
      planningRoot: fixture.planningRoot,
      command: "codex-test",
      args: ["--model", "gpt-test"],
      runner,
    });
    const baseVersion = await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    );
    const session = await adapter.startTask({
      task: TASK,
      canonicalVersion: baseVersion,
      repositoryId: fixture.repository.id,
    });
    const events: AgentEvent[] = [];
    await adapter.streamEvents(session.id, (event) => events.push(event));

    assert.deepEqual(await adapter.requestPlan(session.id), PLAN);
    const planningPath = calls[0]?.options.cwd;
    assert.ok(planningPath !== undefined);

    const workspace = await fixture.workspaces.create({
      taskId: TASK.id,
      rootPath: fixture.workspaceRoot,
      repository: fixture.repository,
      baseVersion,
    });
    await adapter.sendContext(session.id, contextFor(workspace));
    const changeSet = await adapter.collectChanges(session.id);

    assert.equal(changeSet.patches[0]?.path, "src/value.js");
    assert.match(changeSet.patches[0]?.patch ?? "", /value = 2/u);
    assert.deepEqual(
      events.map((event) => event.event),
      ["progress", "progress", "progress", "completed"],
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.executable, "codex-test");
    assert.ok(calls[0]?.args.includes("--ephemeral"));
    assert.ok(calls[0]?.args.includes("--ignore-user-config"));
    if (process.platform === "win32") {
      const configIndex = calls[0]?.args.indexOf("-c") ?? -1;
      assert.equal(
        calls[0]?.args[configIndex + 1],
        'windows.sandbox="elevated"',
      );
    }
    assert.ok(calls[0]?.args.includes("gpt-test"));
    assert.equal(calls[0]?.args.at(-1), "-");
    assert.match(calls[0]?.options.input ?? "", /Update the fixture value/u);
    await assert.rejects(access(planningPath));
    for (const call of calls) {
      await assert.rejects(access(call.schemaPath));
    }

    await fixture.workspaces.destroy(workspace);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a requested platform action round-trips and replays into the next round", async () => {
  const fixture = await createFixture();
  const executionInputs: string[] = [];
  const emptyScope = {
    additionalFiles: [],
    additionalSymbols: [],
    additionalApis: [],
    additionalSchemas: [],
    additionalConfigKeys: [],
    additionalTests: [],
    additionalServices: [],
    reason: "",
  };
  const runner: CodexProcessRunner = async (_executable, args, options = {}) => {
    const sandbox = args[args.indexOf("--sandbox") + 1];
    if (sandbox === "read-only") {
      return output(JSON.stringify(PLAN));
    }
    executionInputs.push(options.input ?? "");
    if (executionInputs.length === 1) {
      // The task is a push, which only the platform can perform: the round
      // ends on the request instead of on a changeset.
      return output(
        JSON.stringify({
          outcome: "action_requested",
          requestId: "act_1",
          action: "push",
          symbolsChanged: [],
          explanation: "The push is the platform's to run",
          ...emptyScope,
        }),
      );
    }
    return output(
      JSON.stringify({
        outcome: "completed",
        symbolsChanged: [],
        explanation: "Pushed: published as coord/export-1",
        requestId: "",
        action: "",
        ...emptyScope,
      }),
    );
  };

  try {
    const adapter = new CodexAdapter({
      agentId: "codex",
      repository: fixture.repository,
      workspaces: fixture.workspaces,
      planningRoot: fixture.planningRoot,
      command: "codex-test",
      runner,
    });
    const baseVersion = await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    );
    const session = await adapter.startTask({
      task: TASK,
      canonicalVersion: baseVersion,
      repositoryId: fixture.repository.id,
    });
    const events: AgentEvent[] = [];
    await adapter.streamEvents(session.id, (event) => {
      events.push(event);
      // Standing in for the coordinator, which always answers an action.
      if (event.event === "action_requested") {
        void adapter.resolveAction(session.id, {
          requestId: event.requestId ?? "",
          action: event.action,
          outcome: "done",
          explanation: "Published revision abc123 on coord/export-1",
        });
      }
    });
    await adapter.requestPlan(session.id);
    const workspace = await fixture.workspaces.create({
      taskId: TASK.id,
      rootPath: fixture.workspaceRoot,
      repository: fixture.repository,
      baseVersion,
    });
    await adapter.sendContext(session.id, contextFor(workspace));

    // Two execution rounds: the first taught the actions and asked for one,
    // the second was told what the platform did and finished on it.
    assert.equal(executionInputs.length, 2);
    assert.match(
      executionInputs[0] ?? "",
      /platform can perform a small fixed set of actions/iu,
    );
    assert.match(executionInputs[1] ?? "", /Published revision abc123/u);
    const kinds = events.map((event) => event.event);
    assert.ok(kinds.includes("action_requested"), kinds.join(", "));
    assert.equal(kinds.at(-1), "completed");

    await fixture.workspaces.destroy(workspace);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a conversational turn drops --ephemeral and resumes its thread", async () => {
  // The trade the conversational flag names: hermetic execution for a task
  // that runs once, a persisted thread for a turn whose next turn wants it
  // back. Planning runs fresh and names the thread; every exec after rides
  // it via the `exec resume` subcommand, whose narrower flag surface takes
  // the sandbox as configuration.
  const fixture = await createFixture();
  const calls: Array<{ args: readonly string[]; options: ProcessOptions }> = [];
  const runner: CodexProcessRunner = async (_executable, args, options = {}) => {
    calls.push({ args, options });
    if (args[1] === "resume") {
      assert.equal(args[2], "thread-cdx-11111111");
      assert.equal(args.includes("--sandbox"), false);
      assert.ok(args.includes('sandbox_mode="workspace-write"'));
      assert.ok(args.includes("--output-schema"));
      assert.equal(args.at(-1), "-");
      assert.ok(options.cwd !== undefined);
      await writeFile(
        path.join(String(options.cwd), "src", "value.js"),
        "export const value = 2;\n",
        "utf8",
      );
      return {
        ...completedWith("1,204"),
        stderr: "codex\nsession id: thread-cdx-22222222\ntokens used\n1,204\n",
      };
    }
    // The fresh planning exec of a conversational session: persistent, so
    // no --ephemeral, and it names the thread in its banner.
    assert.equal(args.includes("--ephemeral"), false);
    assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
    return output(JSON.stringify(PLAN), {
      stderr: "codex\nsession id: thread-cdx-11111111\n",
    });
  };

  try {
    const adapter = new CodexAdapter({
      agentId: "codex",
      repository: fixture.repository,
      workspaces: fixture.workspaces,
      planningRoot: fixture.planningRoot,
      command: "codex-test",
      runner,
    });
    const baseVersion = await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    );
    const session = await adapter.startTask({
      task: TASK,
      canonicalVersion: baseVersion,
      repositoryId: fixture.repository.id,
      conversational: true,
    });
    await adapter.requestPlan(session.id);
    const workspace = await fixture.workspaces.create({
      taskId: TASK.id,
      rootPath: fixture.workspaceRoot,
      repository: fixture.repository,
      baseVersion,
    });
    await adapter.sendContext(session.id, contextFor(workspace));

    assert.equal(calls.length, 2);
    // The token names the state as the newest exec left it.
    assert.equal(adapter.resumeToken(session.id), "thread-cdx-22222222");

    await fixture.workspaces.destroy(workspace);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a stale thread id falls back to a fresh exec, once", async () => {
  // A CODEX_HOME that did not survive the gap, a restart, a resume surface
  // that refuses a flag — whatever staled the thread costs the conversation
  // its memory, never the turn.
  const fixture = await createFixture();
  const calls: Array<{ args: readonly string[] }> = [];
  const runner: CodexProcessRunner = async (_executable, args, options = {}) => {
    calls.push({ args });
    if (args[1] === "resume") {
      return output("", {
        exitCode: 1,
        stderr: "no thread found with id thread-cdx-33333333",
      });
    }
    if (args[args.indexOf("--sandbox") + 1] === "read-only") {
      return output(JSON.stringify(PLAN), {
        stderr: "codex\nsession id: thread-cdx-33333333\n",
      });
    }
    // The bare retry: a fresh exec, still persistent — the conversation is
    // still a conversation even after its memory lapsed.
    assert.equal(args.includes("--ephemeral"), false);
    await writeFile(
      path.join(String(options.cwd), "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );
    return {
      ...completedWith("980"),
      stderr: "codex\nsession id: thread-cdx-44444444\ntokens used\n980\n",
    };
  };

  try {
    const adapter = new CodexAdapter({
      agentId: "codex",
      repository: fixture.repository,
      workspaces: fixture.workspaces,
      planningRoot: fixture.planningRoot,
      command: "codex-test",
      runner,
    });
    const baseVersion = await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    );
    const session = await adapter.startTask({
      task: TASK,
      canonicalVersion: baseVersion,
      repositoryId: fixture.repository.id,
      conversational: true,
    });
    await adapter.requestPlan(session.id);
    const workspace = await fixture.workspaces.create({
      taskId: TASK.id,
      rootPath: fixture.workspaceRoot,
      repository: fixture.repository,
      baseVersion,
    });
    await adapter.sendContext(session.id, contextFor(workspace));

    // Plan, the failed resume, the bare retry — and nothing more.
    assert.equal(calls.length, 3);
    assert.equal(calls[1]?.args[1], "resume");
    assert.notEqual(calls[2]?.args[1], "resume");
    assert.equal(adapter.resumeToken(session.id), "thread-cdx-44444444");

    await fixture.workspaces.destroy(workspace);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("continueTask adopts a handed-over thread on a fresh instance", async () => {
  // Production's shape: every run constructs its own adapters, so the
  // instance asked to continue has never seen the session. The record it is
  // handed carries the thread's name, and its first exec re-enters it.
  const fixture = await createFixture();
  const calls: Array<{ args: readonly string[] }> = [];
  const runner: CodexProcessRunner = async (_executable, args) => {
    calls.push({ args });
    assert.equal(args[1], "resume");
    assert.equal(args[2], "thread-cdx-55555555");
    assert.ok(args.includes('sandbox_mode="read-only"'));
    return output(
      JSON.stringify({ ...PLAN, taskId: "task_turn_two" }),
      { stderr: "codex\nsession id: thread-cdx-66666666\n" },
    );
  };

  try {
    const adapter = new CodexAdapter({
      agentId: "codex",
      repository: fixture.repository,
      workspaces: fixture.workspaces,
      planningRoot: fixture.planningRoot,
      command: "codex-test",
      runner,
    });
    const baseVersion = await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    );
    const continued = await adapter.continueTask(
      {
        id: "session_prior_turn",
        agentId: "codex",
        taskId: TASK.id,
        startedAt: new Date().toISOString(),
        resume: "thread-cdx-55555555",
      },
      {
        task: { ...TASK, id: "task_turn_two", objective: "Update it again" },
        canonicalVersion: baseVersion,
        repositoryId: fixture.repository.id,
        conversational: true,
      },
    );
    assert.equal(continued.id, "session_prior_turn");
    assert.equal(continued.taskId, "task_turn_two");
    assert.equal(continued.resume, "thread-cdx-55555555");
    await adapter.requestPlan(continued.id);
    assert.equal(calls.length, 1);
    assert.equal(adapter.resumeToken(continued.id), "thread-cdx-66666666");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("parseCodexSessionId reads the banner and nothing else", () => {
  assert.equal(
    parseCodexSessionId("codex\nsession id: thread-cdx-12345678\n"),
    "thread-cdx-12345678",
  );
  // The label is prose, not a contract — both spellings are read.
  assert.equal(
    parseCodexSessionId("thread id 0195a2b4-aaaa-bbbb-cccc-121212121212"),
    "0195a2b4-aaaa-bbbb-cccc-121212121212",
  );
  // Absent, malformed, or suspicious ids contribute nothing: an ephemeral
  // run persists no thread, and a turn that cannot be resumed still worked.
  assert.equal(parseCodexSessionId("codex\ntokens used\n1,204\n"), undefined);
  assert.equal(parseCodexSessionId("session id: short"), undefined);
});

test("cancellation aborts an active Codex process and removes planning state", async () => {
  const fixture = await createFixture();
  let started: (() => void) | undefined;
  const processStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const runner: CodexProcessRunner = async (
    _executable,
    _args,
    options = {},
  ) => {
    started?.();
    return await new Promise<ProcessOutput>((resolve) => {
      const finish = () =>
        resolve(
          output("", {
            exitCode: 130,
            stderr: "[process aborted]",
            aborted: true,
          }),
        );
      if (options.signal?.aborted === true) {
        finish();
      } else {
        options.signal?.addEventListener("abort", finish, { once: true });
      }
    });
  };

  try {
    const adapter = new CodexAdapter({
      agentId: "codex",
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
    const planning = assert.rejects(
      adapter.requestPlan(session.id),
      /process aborted/u,
    );
    await processStarted;
    await adapter.cancel(session.id);
    await planning;
    assert.deepEqual(await readdir(fixture.planningRoot), []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects Codex arguments that could weaken confinement", async () => {
  const fixture = await createFixture();
  try {
    assert.throws(
      () =>
        new CodexAdapter({
          agentId: "codex",
          repository: fixture.repository,
          workspaces: fixture.workspaces,
          planningRoot: fixture.planningRoot,
          args: ["--sandbox", "danger-full-access"],
        }),
      /only complete --model/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("selects a scoped native Windows sandbox even while ignoring user config", async () => {
  const fixture = await createFixture();
  const calls: string[][] = [];
  const runner: CodexProcessRunner = async (_executable, args) => {
    calls.push([...args]);
    return output(JSON.stringify(PLAN));
  };

  try {
    const adapter = new CodexAdapter({
      agentId: "codex",
      repository: fixture.repository,
      workspaces: fixture.workspaces,
      planningRoot: fixture.planningRoot,
      command: "codex-test",
      platform: "win32",
      windowsSandbox: "unelevated",
      runner,
    });
    const baseVersion = await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    );
    const session = await adapter.startTask({
      task: TASK,
      canonicalVersion: baseVersion,
      repositoryId: fixture.repository.id,
    });

    await adapter.requestPlan(session.id);

    const args = calls[0] ?? [];
    const configIndex = args.indexOf("-c");
    assert.ok(args.includes("--ignore-user-config"));
    assert.equal(args[configIndex + 1], 'windows.sandbox="unelevated"');
    assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
    await adapter.cancel(session.id);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

/**
 * OpenAI structured outputs run in strict mode. If `required` omits any key in
 * `properties`, the API rejects the request with `invalid_json_schema` before
 * the model runs — so a schema that looks reasonable fails only against the
 * real service. This walks both shipped schemas so that cannot regress.
 */
function assertStrictSchema(node: unknown, where: string): void {
  if (node === null || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((entry, index) => assertStrictSchema(entry, `${where}[${index}]`));
    return;
  }

  const record = node as Record<string, unknown>;
  if (record["type"] === "object" && record["properties"] !== undefined) {
    const properties = Object.keys(record["properties"] as Record<string, unknown>);
    const required = record["required"];
    assert.ok(Array.isArray(required), `${where} has properties but no required array`);
    assert.deepEqual(
      [...(required as string[])].sort(),
      [...properties].sort(),
      `${where}: required must name every property for OpenAI strict mode`,
    );
  }
  for (const [key, value] of Object.entries(record)) {
    assertStrictSchema(value, `${where}.${key}`);
  }
}

test("both output schemas satisfy OpenAI strict structured outputs", async () => {
  const fixture = await createFixture();
  const seen: unknown[] = [];
  const runner: CodexProcessRunner = async (_executable, args) => {
    const schemaPath = args[args.indexOf("--output-schema") + 1];
    assert.ok(schemaPath !== undefined);
    seen.push(JSON.parse(await readFile(schemaPath, "utf8")));
    const sandbox = args[args.indexOf("--sandbox") + 1];
    if (sandbox === "read-only") {
      return output(JSON.stringify(PLAN));
    }
    throw new Error("stop after planning");
  };

  const adapter = new CodexAdapter({
    agentId: "codex",
    repository: fixture.repository,
    workspaces: fixture.workspaces,
    planningRoot: fixture.planningRoot,
    command: "codex-test",
    runner,
  });
  const session = await adapter.startTask({
    task: TASK,
    canonicalVersion: await fixture.repositories.getCanonicalVersion(fixture.repository),
    repositoryId: fixture.repository.id,
  });
  await adapter.requestPlan(session.id);

  assert.equal(seen.length, 1);
  assertStrictSchema(seen[0], "PLAN_SCHEMA");
  await rm(fixture.root, { recursive: true, force: true });
});

test("a denied write fails loudly instead of reporting success", async () => {
  const fixture = await createFixture();
  const runner: CodexProcessRunner = async (_executable, args) => {
    const sandbox = args[args.indexOf("--sandbox") + 1];
    if (sandbox === "read-only") {
      return output(JSON.stringify(PLAN));
    }
    // Exactly what Codex emits when the platform has no sandbox helper: the
    // patch is refused, nothing is written, and the process still exits 0.
    return output(
      JSON.stringify({
        outcome: "completed",
        symbolsChanged: ["value"],
        explanation: "done",
        requestId: "",
        additionalFiles: [],
        additionalSymbols: [],
        additionalApis: [],
        additionalSchemas: [],
        additionalConfigKeys: [],
        additionalTests: [],
        additionalServices: [],
        reason: "",
      }),
      { stderr: "ERROR patch rejected: writing is blocked by read-only sandbox" },
    );
  };

  const adapter = new CodexAdapter({
    agentId: "codex",
    repository: fixture.repository,
    workspaces: fixture.workspaces,
    planningRoot: fixture.planningRoot,
    command: "codex-test",
    runner,
  });
  const baseVersion = await fixture.repositories.getCanonicalVersion(fixture.repository);
  const session = await adapter.startTask({
    task: TASK,
    canonicalVersion: baseVersion,
    repositoryId: fixture.repository.id,
  });
  await adapter.requestPlan(session.id);
  const workspace = await fixture.workspaces.create({
    taskId: TASK.id,
    rootPath: fixture.workspaceRoot,
    repository: fixture.repository,
    baseVersion,
  });

  await assert.rejects(
    adapter.sendContext(session.id, {
      decision: {
        decision: "approved",
        taskId: TASK.id,
        workspaceId: workspace.id,
        ownershipGrants: [],
        constraints: [],
        blockedBy: [],
        explanation: "test",
      },
      canonicalVersion: baseVersion,
      workspacePath: workspace.path,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CodexWriteDeniedError);
      assert.match(error.message, /scoped-write sandbox is unavailable/u);
      return true;
    },
  );

  await fixture.workspaces.destroy(workspace);
  await rm(fixture.root, { recursive: true, force: true });
});

test("the execution sandbox is configurable and defaults to workspace-write", async () => {
  const fixture = await createFixture();
  const sandboxes: string[] = [];
  const runner: CodexProcessRunner = async (_executable, args) => {
    sandboxes.push(args[args.indexOf("--sandbox") + 1] ?? "");
    if (args[args.indexOf("--sandbox") + 1] === "read-only") {
      return output(JSON.stringify(PLAN));
    }
    throw new Error("stop");
  };

  for (const [configured, expected] of [
    [undefined, "workspace-write"],
    ["danger-full-access", "danger-full-access"],
  ] as const) {
    sandboxes.length = 0;
    const adapter = new CodexAdapter({
      agentId: "codex",
      repository: fixture.repository,
      workspaces: fixture.workspaces,
      planningRoot: fixture.planningRoot,
      command: "codex-test",
      runner,
      ...(configured === undefined ? {} : { executionSandbox: configured }),
    });
    const baseVersion = await fixture.repositories.getCanonicalVersion(fixture.repository);
    const session = await adapter.startTask({
      task: TASK,
      canonicalVersion: baseVersion,
      repositoryId: fixture.repository.id,
    });
    await adapter.requestPlan(session.id);
    const workspace = await fixture.workspaces.create({
      taskId: TASK.id,
      rootPath: fixture.workspaceRoot,
      repository: fixture.repository,
      baseVersion,
    });
    await assert.rejects(
      adapter.sendContext(session.id, {
        decision: {
          decision: "approved",
          taskId: TASK.id,
          workspaceId: workspace.id,
          ownershipGrants: [],
          constraints: [],
          blockedBy: [],
          explanation: "test",
        },
        canonicalVersion: baseVersion,
        workspacePath: workspace.path,
      }),
    );
    assert.equal(sandboxes[0], "read-only");
    assert.equal(sandboxes[1], expected);
    await fixture.workspaces.destroy(workspace);
  }
  await rm(fixture.root, { recursive: true, force: true });
});

/**
 * Token accounting. Codex reports what a call cost on the same stream the
 * structured result is parsed from, so the figure is only recoverable at the
 * moment the transcript is in hand — after parsing it is gone.
 */

/** A completion envelope with the token line Codex appends after it. */
function completedWith(tokens: string | undefined): ProcessOutput {
  const body = JSON.stringify({
    outcome: "completed",
    symbolsChanged: ["value"],
    explanation: "done",
    requestId: "",
    additionalFiles: [],
    additionalSymbols: [],
    additionalApis: [],
    additionalSchemas: [],
    additionalConfigKeys: [],
    additionalTests: [],
    additionalServices: [],
    reason: "",
  });
  // Real Codex reserves stdout for the structured result under
  // --output-schema and prints its cost to stderr, so the stub does too.
  return output(
    body,
    tokens === undefined ? {} : { stderr: `codex\ntokens used\n${tokens}\n` },
  );
}

test("parses the token figure Codex prints, and refuses to invent one", () => {
  // The exact shapes seen from the real CLI, thousands separators and all.
  assert.equal(parseCodexTokens("codex\nREADY\ntokens used\n14,907\n"), 14907);
  assert.equal(parseCodexTokens("tokens used\n25,371\nResolved."), 25371);
  assert.equal(parseCodexTokens("tokens used 1234"), 1234);
  // Absent is undefined, never zero: "not reported" and "cost nothing" are
  // different claims, and a total built from the second is quietly wrong.
  assert.equal(parseCodexTokens("no usage line here"), undefined);
  assert.equal(parseCodexTokens(""), undefined);
});

test("records what each Codex call cost, tagged by phase and in order", async () => {
  const fixture = await createFixture();
  // The first execution asks for more scope, so this session spends three
  // calls. A single total would hide that; the per-call record does not.
  let executions = 0;
  const runner: CodexProcessRunner = async (_executable, args, options = {}) => {
    const sandbox = args[args.indexOf("--sandbox") + 1];
    if (sandbox === "read-only") {
      return output(JSON.stringify(PLAN), {
        stderr: "codex\ntokens used\n1,000\n",
      });
    }
    executions += 1;
    if (executions === 1) {
      return output(
        `${JSON.stringify({
          outcome: "scope_change_requested",
          symbolsChanged: [],
          explanation: "needs another file",
          requestId: "scope_1",
          additionalFiles: ["src/other.js"],
          additionalSymbols: [],
          additionalApis: [],
          additionalSchemas: [],
          additionalConfigKeys: [],
          additionalTests: [],
          additionalServices: [],
          reason: "discovered mid-run",
        })}`,
        { stderr: "codex\ntokens used\n2,500\n" },
      );
    }
    assert.ok(options.cwd !== undefined);
    await writeFile(
      path.join(options.cwd, "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );
    return completedWith("3,750");
  };

  try {
    const adapter = new CodexAdapter({
      agentId: "codex",
      repository: fixture.repository,
      workspaces: fixture.workspaces,
      planningRoot: fixture.planningRoot,
      command: "codex-test",
      runner,
    });
    const baseVersion = await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    );
    const session = await adapter.startTask({
      task: TASK,
      canonicalVersion: baseVersion,
      repositoryId: fixture.repository.id,
    });
    const plan = await adapter.requestPlan(session.id);

    await adapter.streamEvents(session.id, (event) => {
      if (event.event !== "scope_change_requested") {
        return;
      }
      void adapter.resolveScopeChange(session.id, {
        requestId: event.requestId ?? "scope_1",
        taskId: TASK.id,
        decision: "approved",
        revisedPlan: plan,
        constraints: [],
        ownershipGrants: [],
        explanation: "approved",
        decidedAt: new Date().toISOString(),
      });
    });

    const workspace = await fixture.workspaces.create({
      taskId: TASK.id,
      rootPath: fixture.workspaceRoot,
      repository: fixture.repository,
      baseVersion,
    });
    await adapter.sendContext(session.id, contextFor(workspace));
    await adapter.collectChanges(session.id);

    assert.deepEqual(
      adapter.tokenUsage(session.id).map((entry) => [entry.phase, entry.tokens]),
      [
        ["planning", 1000],
        ["execution", 2500],
        ["execution", 3750],
      ],
    );
    assert.equal(adapter.totalTokens(), 7250);
    assert.deepEqual(
      [...new Set(adapter.allTokenUsage().map((entry) => entry.taskId))],
      [TASK.id],
    );
    // Durations come from the process, not from a guess.
    assert.ok(
      adapter.tokenUsage(session.id).every((entry) => entry.durationMs >= 0),
    );

    await fixture.workspaces.destroy(workspace);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a transcript with no token line records nothing rather than zero", async () => {
  const fixture = await createFixture();
  const runner: CodexProcessRunner = async (_executable, args, options = {}) => {
    const sandbox = args[args.indexOf("--sandbox") + 1];
    if (sandbox === "read-only") {
      return output(JSON.stringify(PLAN));
    }
    assert.ok(options.cwd !== undefined);
    await writeFile(
      path.join(options.cwd, "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );
    return completedWith(undefined);
  };

  try {
    const adapter = new CodexAdapter({
      agentId: "codex",
      repository: fixture.repository,
      workspaces: fixture.workspaces,
      planningRoot: fixture.planningRoot,
      command: "codex-test",
      runner,
    });
    const baseVersion = await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    );
    const session = await adapter.startTask({
      task: TASK,
      canonicalVersion: baseVersion,
      repositoryId: fixture.repository.id,
    });
    await adapter.requestPlan(session.id);
    const workspace = await fixture.workspaces.create({
      taskId: TASK.id,
      rootPath: fixture.workspaceRoot,
      repository: fixture.repository,
      baseVersion,
    });
    await adapter.sendContext(session.id, contextFor(workspace));
    await adapter.collectChanges(session.id);

    // No entries at all, rather than entries reading zero.
    assert.deepEqual(adapter.tokenUsage(session.id), []);
    assert.equal(adapter.totalTokens(), 0);

    await fixture.workspaces.destroy(workspace);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

/**
 * What a replan is shown about the names its previous turn got wrong.
 *
 * The measured failure this addresses: an agent told "checkout.js does not
 * exist" re-declared it anyway about half the time, because the prompt's most
 * authoritative content — the previous plan, quoted verbatim — still said
 * `checkout.js`. Substitution puts the real name there instead, and states the
 * correction positively rather than as a denial.
 */

const HALLUCINATED_PLAN: AgentPlan = {
  taskId: TASK.id,
  objective: TASK.objective,
  expectedFiles: ["src/checkout.js"],
  expectedSymbols: ["calculateOrderTotal", "brandNewHelper"],
  dependencies: [],
  commands: [],
  externalAccess: [],
  riskLevel: "low",
  intent: "raise the value",
  grounding: {
    confidence: "grounded",
    revision: "a".repeat(40),
    missingFiles: ["src/checkout.js"],
    unresolvedSymbols: ["calculateOrderTotal", "brandNewHelper"],
    fileReferents: [
      { declared: "src/checkout.js", resolved: "src/value.js" },
    ],
    symbolReferents: [
      {
        declared: "calculateOrderTotal",
        resolved: "value",
        files: ["src/value.js"],
      },
    ],
    notes: ["declared file src/checkout.js does not exist"],
  },
};

async function replanPromptFor(
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const fixture = await createFixture();
  const prompts: string[] = [];
  const runner: CodexProcessRunner = async (_executable, args, options = {}) => {
    prompts.push(options.input ?? "");
    return output(
      JSON.stringify(
        args.includes("read-only")
          ? { ...HALLUCINATED_PLAN, grounding: undefined }
          : {},
      ),
    );
  };
  const restore = { ...process.env };
  try {
    Object.assign(process.env, environment);
    const adapter = new CodexAdapter({
      agentId: "codex",
      repository: fixture.repository,
      workspaces: fixture.workspaces,
      planningRoot: fixture.planningRoot,
      command: "codex-test",
      runner,
    });
    const baseVersion = await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    );
    const session = await adapter.startTask({
      task: TASK,
      canonicalVersion: baseVersion,
      repositoryId: fixture.repository.id,
    });
    await adapter.requestPlan(session.id);
    await adapter.requestReplan(session.id, {
      taskId: TASK.id,
      previousPlan: HALLUCINATED_PLAN,
      canonicalChange: {
        previousVersion: baseVersion,
        canonicalVersion: baseVersion,
        changedFiles: ["src/value.js"],
        changedSymbols: [],
        changedApis: [],
        changedSchemas: [],
        changedConfigKeys: [],
        changedTests: [],
        changedServices: [],
        reason: "another task integrated",
      },
      constraints: [],
    });
    return prompts.at(-1) ?? "";
  } finally {
    for (const key of Object.keys(environment)) {
      if (restore[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = restore[key];
      }
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test("a replan is handed the real names, not the ones it invented", async () => {
  const prompt = await replanPromptFor({});

  // The corrected plan is what the prompt asserts.
  assert.match(prompt, /"expectedFiles":\["src\/value\.js"\]/u);
  assert.match(prompt, /"expectedSymbols":\[[^\]]*"value"/u);
  // And the correction is stated as a fact about where the code is.
  assert.match(
    prompt,
    /The file you called src\/checkout\.js does not exist\. The real file is src\/value\.js\./u,
  );
  assert.match(
    prompt,
    /The symbol you called calculateOrderTotal does not exist\. The real symbol is value, declared in src\/value\.js\./u,
  );
});

test("the invented name appears only where it is being corrected", async () => {
  const prompt = await replanPromptFor({});
  const mentions = prompt.split("src/checkout.js").length - 1;
  assert.equal(mentions, 1);
  // The grounding record is dropped rather than serialised: its missingFiles
  // list is a verbatim copy of exactly the names not to repeat.
  assert.doesNotMatch(prompt, /"missingFiles"/u);
  assert.doesNotMatch(prompt, /Coordinator verification of your previous/u);
});

test("a name that grounds to nothing is reported as a creation, not an error", async () => {
  const prompt = await replanPromptFor({});
  assert.match(prompt, /treating them as things you intend to create: brandNewHelper/u);
  // It stays in the plan: the agent may well be about to write it.
  assert.match(prompt, /"brandNewHelper"/u);
});

test("COORD_UNGROUNDED_REPLAN restores the prompt substitution replaced", async () => {
  const prompt = await replanPromptFor({ COORD_UNGROUNDED_REPLAN: "1" });

  assert.match(prompt, /Previous plan: \{/u);
  assert.match(prompt, /"expectedFiles":\["src\/checkout\.js"\]/u);
  assert.match(prompt, /Coordinator verification of your previous declarations/u);
  assert.doesNotMatch(prompt, /The real file is/u);
});

test("earlier work reaches the planning prompt as background, not as fact", async () => {
  // Handoffs were written at every task boundary and never read back, so each
  // task rediscovered the repository from an empty context window. This is the
  // path that reads them — and it has to arrive labelled, because a handoff
  // describes an earlier revision while the workspace is what is true now.
  const fixture = await createFixture();
  const prompts: string[] = [];
  const adapter = new CodexAdapter({
    agentId: "codex",
    repository: fixture.repository,
    workspaces: fixture.workspaces,
    planningRoot: fixture.planningRoot,
    runner: async (_executable, _args, options) => {
      prompts.push(String(options?.input ?? ""));
      return {
        stdout: JSON.stringify({ type: "item.completed", item: { text: JSON.stringify(PLAN) } }),
        stderr: "",
        exitCode: 0,
        durationMs: 0,
      };
    },
  });
  const session = await adapter.startTask({
    task: TASK,
    canonicalVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
    repositoryId: fixture.repository.id,
    priorContext:
      "Handoff from earlier work\nGotcha: the retry counter is off by one.",
  });
  await adapter.requestPlan(session.id).catch(() => undefined);
  const planning = prompts[0] ?? "";
  assert.match(planning, /Gotcha: the retry counter is off by one\./u);
  assert.match(planning, /Treat as background/u);
  // The objective stays the thing somebody actually asked for.
  assert.match(planning, /Objective: /u);
  await rm(fixture.root, { recursive: true, force: true });
});

test("a reasoning effort reaches Codex as its own configuration override", async (t) => {
  // The channel can now pick a reasoning level for a Codex agent, and this is
  // the last link in the chain that makes picking one mean anything: Codex
  // exposes the setting as `model_reasoning_effort` configuration rather than
  // as a flag, which is the same surface the chat path already drives.
  const fixture = await createFixture();
  t.after(async () => await rm(fixture.root, { recursive: true, force: true }));
  const seen: string[][] = [];
  const adapter = new CodexAdapter({
    agentId: "codex",
    repository: fixture.repository,
    workspaces: fixture.workspaces,
    planningRoot: fixture.planningRoot,
    command: "codex-test",
    effort: "xhigh",
    runner: async (_command, args) => {
      seen.push([...args]);
      return output(JSON.stringify(PLAN));
    },
  });
  const session = await adapter.startTask({
    task: TASK,
    canonicalVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
    repositoryId: fixture.repository.id,
  });
  await adapter.requestPlan(session.id);

  const argv = seen[0] ?? [];
  const at = argv.indexOf('model_reasoning_effort="xhigh"');
  assert.ok(at > 0, `no effort override in ${JSON.stringify(argv)}`);
  assert.equal(argv[at - 1], "-c");
});

test("a reasoning effort that could break out of the config expression is refused", async (t) => {
  // The value is interpolated into `-c key="value"`, so anything that could
  // close the quote and start a second setting is rejected at construction
  // rather than escaped — a level is a bare word in every vendor that has one,
  // and `sandbox_mode` is one `-c` away from being the thing overridden.
  const fixture = await createFixture();
  t.after(async () => await rm(fixture.root, { recursive: true, force: true }));
  assert.throws(
    () =>
      new CodexAdapter({
        agentId: "codex",
        repository: fixture.repository,
        workspaces: fixture.workspaces,
        planningRoot: fixture.planningRoot,
        effort: 'high" -c sandbox_mode="danger-full-access',
      }),
    /bare word/u,
  );
});
