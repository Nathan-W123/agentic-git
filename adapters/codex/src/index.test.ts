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
      assert.match(error.message, /missing the sandbox helper/u);
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
