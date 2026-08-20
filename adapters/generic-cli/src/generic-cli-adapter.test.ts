import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentEvent, CoordinatorContext } from "@coord/agent-protocol";
import type { AgentPlan, TaskDefinition } from "@coord/shared-types";
import {
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  GitWorktreeWorkspaceManager,
  type SandboxLaunchSpec,
  type TaskWorkspace,
  type WorkspaceSandbox,
} from "@coord/workspace-manager";

import {
  AgentProtocolError,
  GenericCliAdapter,
  executionTokenUsage,
} from "./index.js";

/**
 * A minimal JSONL agent used as the process under test. Its behavior is
 * selected with FIXTURE_MODE so one script can cover the failure paths.
 */
const FIXTURE_AGENT = [
  'import fs from "node:fs";',
  'import path from "node:path";',
  "",
  "let started = null;",
  "let buffer = '';",
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (chunk) => {',
  "  buffer += chunk;",
  '  let index = buffer.indexOf("\\n");',
  "  while (index !== -1) {",
  "    const line = buffer.slice(0, index).trim();",
  "    buffer = buffer.slice(index + 1);",
  "    if (line.length > 0) {",
  "      handle(JSON.parse(line));",
  "    }",
  '    index = buffer.indexOf("\\n");',
  "  }",
  "});",
  "",
  "function send(message) {",
  '  process.stdout.write(JSON.stringify(message) + "\\n");',
  "}",
  "",
  "function handle(message) {",
  '  const mode = process.env.FIXTURE_MODE ?? "ok";',
  '  if (message.type === "start") {',
  "    started = message;",
  "    return;",
  "  }",
  '  if (message.type === "plan_request") {',
  '    if (!started.workspacePath || !fs.existsSync(path.join(started.workspacePath, "src", "counter.js"))) {',
  '      send({ type: "error", message: "planning workspace missing" });',
  "      return;",
  "    }",
  '    if (mode === "plan_error") {',
  '      send({ type: "error", message: "no model credentials" });',
  "      return;",
  "    }",
  '    if (mode === "bad_plan") {',
  '      send({ type: "plan", plan: { taskId: "task_cap_value" } });',
  "      return;",
  "    }",
  '    if (mode === "crash") {',
  '      process.stderr.write("fatal: agent runtime missing\\n");',
  "      process.exit(3);",
  "    }",
  '    if (mode === "silent") {',
  "      return;",
  "    }",
  '    send({ type: "plan", plan: JSON.parse(process.env.FIXTURE_PLAN) });',
  "    return;",
  "  }",
  '  if (message.type === "context") {',
  "    send({",
  '      type: "event",',
  '      event: { event: "progress", message: "editing src/counter.js" },',
  "    });",
  '    const file = path.join(message.workspacePath, "src", "counter.js");',
  '    const source = fs.readFileSync(file, "utf8");',
  "    fs.writeFileSync(",
  "      file,",
  '      source.replace("value + 1", "Math.min(value + 1, 10)"),',
  "    );",
  "    send({",
  '      type: "done",',
  '      symbolsChanged: ["increment"],',
  '      explanation: "capped increment at ten",',
  "    });",
  "    return;",
  "  }",
  '  if (message.type === "cancel") {',
  "    process.exit(0);",
  "  }",
  "}",
  "",
].join("\n");

const TASK: TaskDefinition = {
  id: "task_cap_value",
  objective: "Cap the incremented value at ten",
  agentId: "generic-cli-fixture",
  validationCommands: [],
};

const PLAN: AgentPlan = {
  taskId: TASK.id,
  objective: TASK.objective,
  expectedFiles: ["src/counter.js"],
  expectedSymbols: ["increment"],
  dependencies: [],
  commands: [],
  externalAccess: [],
  riskLevel: "low",
};

interface Fixture {
  root: string;
  scriptPath: string;
  repository: CanonicalRepository;
  repositories: RepositoryService;
  workspaces: GitWorktreeWorkspaceManager;
  workspaceRoot: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-generic-cli-"));
  const scriptPath = path.join(root, "fixture-agent.mjs");
  await writeFile(scriptPath, FIXTURE_AGENT, "utf8");

  const sourcePath = path.join(root, "source");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "src", "counter.js"),
    ["export function increment(value) {", "  return value + 1;", "}", ""].join(
      "\n",
    ),
    "utf8",
  );
  await repositories.commitAll(sourcePath, "seed adapter fixture");

  const repository = await repositories.importLocalRepository(
    sourcePath,
    path.join(root, "canonical.git"),
    "adapter-fixture",
  );

  return {
    root,
    scriptPath,
    repository,
    repositories,
    workspaces: new GitWorktreeWorkspaceManager(repositories.getGitClient()),
    workspaceRoot: path.join(root, "workspaces"),
  };
}

function createAdapter(
  fixture: Fixture,
  mode: string,
  overrides: {
    sandbox?: WorkspaceSandbox;
    requestTimeoutMs?: number;
  } = {},
): GenericCliAdapter {
  return new GenericCliAdapter({
    agentId: TASK.agentId,
    launch: {
      command: process.execPath,
      args: [fixture.scriptPath],
      env: {
        ...process.env,
        FIXTURE_MODE: mode,
        FIXTURE_PLAN: JSON.stringify(PLAN),
      },
    },
    repository: fixture.repository,
    workspaces: fixture.workspaces,
    planningRoot: path.join(fixture.root, "planning"),
    ...overrides,
  });
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
      explanation: "Approved for the adapter test",
    },
    canonicalVersion: workspace.baseVersion,
    workspacePath: workspace.path,
  };
}

async function createWorkspace(fixture: Fixture): Promise<TaskWorkspace> {
  return await fixture.workspaces.create({
    taskId: TASK.id,
    rootPath: fixture.workspaceRoot,
    repository: fixture.repository,
    baseVersion: await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    ),
  });
}

test("claims a cache-free token figure only when the agent split its cache out", () => {
  // A report whose total exceeds its two sides is accounting for cached
  // context separately, so input plus output is the part that was new work.
  assert.deepEqual(
    executionTokenUsage({ total: 25_000, input: 2_000, output: 500 }),
    {
      phase: "execution",
      totalTokens: 25_000,
      inputTokens: 2_000,
      outputTokens: 500,
      freshTokens: 2_500,
    },
  );
  // A total that is exactly the two sides could be a run with no cache or one
  // that folded its cache into the input figure. Calling the second fresh is
  // what made an afternoon's work read in the millions, so nothing is claimed
  // and the room counts the row as a lower bound instead.
  assert.deepEqual(
    executionTokenUsage({ total: 2_500, input: 2_000, output: 500 }),
    {
      phase: "execution",
      totalTokens: 2_500,
      inputTokens: 2_000,
      outputTokens: 500,
    },
  );
  // A bare total is recorded as a bare total; a missing half is never
  // invented as a zero.
  assert.deepEqual(executionTokenUsage({ total: 900 }), {
    phase: "execution",
    totalTokens: 900,
  });
  assert.deepEqual(executionTokenUsage({ total: 900, output: 100 }), {
    phase: "execution",
    totalTokens: 900,
    outputTokens: 100,
  });
});

test("drives a real child process from plan through changeset", async () => {
  const fixture = await createFixture();
  try {
    const adapter = createAdapter(fixture, "ok");
    const capabilities = await adapter.getCapabilities();
    assert.equal(capabilities.canPlan, true);

    const baseVersion = await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    );
    const session = await adapter.startTask({
      task: TASK,
      canonicalVersion: baseVersion,
      repositoryId: fixture.repository.id,
    });

    const plan = await adapter.requestPlan(session.id);
    assert.deepEqual(plan.expectedFiles, ["src/counter.js"]);
    assert.equal(plan.taskId, TASK.id);

    const workspace = await createWorkspace(fixture);
    const events: AgentEvent[] = [];
    await adapter.streamEvents(session.id, (event) => events.push(event));
    await adapter.sendContext(session.id, contextFor(workspace));
    const changeSet = await adapter.collectChanges(session.id);

    assert.equal(changeSet.taskId, TASK.id);
    assert.equal(changeSet.baseRevision, baseVersion.revision);
    assert.equal(changeSet.patches.length, 1);
    assert.equal(changeSet.patches[0]?.path, "src/counter.js");
    assert.match(changeSet.patches[0]?.patch ?? "", /Math\.min\(value \+ 1, 10\)/u);
    assert.deepEqual(changeSet.symbolsChanged, ["increment"]);
    assert.equal(changeSet.agentExplanation, "capped increment at ten");
    assert.equal(changeSet.riskAssessment.level, "low");

    assert.deepEqual(
      events.map((event) => event.event),
      ["progress", "completed"],
    );

    await fixture.workspaces.destroy(workspace);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("surfaces an error message reported by the agent", async () => {
  const fixture = await createFixture();
  try {
    const adapter = createAdapter(fixture, "plan_error");
    const session = await adapter.startTask({
      task: TASK,
      canonicalVersion: await fixture.repositories.getCanonicalVersion(
        fixture.repository,
      ),
      repositoryId: fixture.repository.id,
    });
    await assert.rejects(adapter.requestPlan(session.id), (error: unknown) => {
      assert.ok(error instanceof AgentProtocolError);
      assert.match(error.message, /no model credentials/u);
      return true;
    });
    await adapter.cancel(session.id);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a plan that does not match the coordination schema", async () => {
  const fixture = await createFixture();
  try {
    const adapter = createAdapter(fixture, "bad_plan");
    const session = await adapter.startTask({
      task: TASK,
      canonicalVersion: await fixture.repositories.getCanonicalVersion(
        fixture.repository,
      ),
      repositoryId: fixture.repository.id,
    });
    await assert.rejects(adapter.requestPlan(session.id), TypeError);
    await adapter.cancel(session.id);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("reports child process failure with captured stderr", async () => {
  const fixture = await createFixture();
  try {
    const adapter = createAdapter(fixture, "crash");
    const session = await adapter.startTask({
      task: TASK,
      canonicalVersion: await fixture.repositories.getCanonicalVersion(
        fixture.repository,
      ),
      repositoryId: fixture.repository.id,
    });
    await assert.rejects(adapter.requestPlan(session.id), (error: unknown) => {
      assert.ok(error instanceof AgentProtocolError);
      assert.match(error.message, /agent runtime missing/u);
      return true;
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("times out an agent that never answers", async () => {
  const fixture = await createFixture();
  try {
    const adapter = createAdapter(fixture, "silent", { requestTimeoutMs: 250 });
    const session = await adapter.startTask({
      task: TASK,
      canonicalVersion: await fixture.repositories.getCanonicalVersion(
        fixture.repository,
      ),
      repositoryId: fixture.repository.id,
    });
    await assert.rejects(adapter.requestPlan(session.id), (error: unknown) => {
      assert.ok(error instanceof AgentProtocolError);
      assert.match(error.message, /Timed out after 250 ms/u);
      return true;
    });
    await adapter.cancel(session.id);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("invalid process limits and NUL-bearing launches fail before spawning", async () => {
  const fixture = await createFixture();
  try {
    assert.throws(
      () => createAdapter(fixture, "ok", { requestTimeoutMs: 0 }),
      /requestTimeoutMs must be a positive integer/u,
    );
    assert.throws(
      () =>
        new GenericCliAdapter({
          agentId: TASK.agentId,
          launch: { command: process.execPath, args: ["bad\0argument"] },
          repository: fixture.repository,
          workspaces: fixture.workspaces,
        }),
      /arguments must contain no NUL/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("collectChanges refuses a session that never completed", async () => {
  const fixture = await createFixture();
  try {
    const adapter = createAdapter(fixture, "ok");
    const session = await adapter.startTask({
      task: TASK,
      canonicalVersion: await fixture.repositories.getCanonicalVersion(
        fixture.repository,
      ),
      repositoryId: fixture.repository.id,
    });
    await assert.rejects(
      adapter.collectChanges(session.id),
      /has not received a workspace/u,
    );
    await adapter.cancel(session.id);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a sandbox mounts separate planning and execution workspaces", async () => {
  const fixture = await createFixture();
  const wrapped: Array<TaskWorkspace | undefined> = [];
  const sandbox: WorkspaceSandbox = {
    wrapLaunch(spec: SandboxLaunchSpec, workspace?: TaskWorkspace) {
      wrapped.push(workspace);
      return spec;
    },
    resolveWorkspacePath(workspace: TaskWorkspace) {
      return workspace.path;
    },
  };

  try {
    const adapter = createAdapter(fixture, "ok", { sandbox });
    const session = await adapter.startTask({
      task: TASK,
      canonicalVersion: await fixture.repositories.getCanonicalVersion(
        fixture.repository,
      ),
      repositoryId: fixture.repository.id,
    });
    await adapter.requestPlan(session.id);

    const workspace = await createWorkspace(fixture);
    await adapter.sendContext(session.id, contextFor(workspace));
    const changeSet = await adapter.collectChanges(session.id);

    assert.equal(wrapped.length, 2);
    assert.match(wrapped[0]?.taskId ?? "", /^planning-/u);
    assert.notEqual(wrapped[0]?.path, workspace.path);
    assert.equal(wrapped[1]?.path, workspace.path);
    assert.equal(changeSet.patches.length, 1);

    await fixture.workspaces.destroy(workspace);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
