import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentSession,
  CoordinatorContext,
  StartTaskInput,
} from "@coord/agent-protocol";
import { CodeIntelligenceService } from "@coord/code-intelligence";
import {
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  createId,
  type AgentPlan,
  type AuditEvent,
  type ChangeSet,
  type ScopeChangeDecision,
  type TaskDefinition,
} from "@coord/shared-types";
import {
  GitWorktreeWorkspaceManager,
  WarmWorkspacePool,
  type TaskWorkspace,
} from "@coord/workspace-manager";

import { Coordinator } from "./coordinator.js";

/**
 * Warm starts on the control plane, observed from outside: a task that lands
 * gives its directory to the next task in the same repository, a task that
 * fails does not, and a promotion indexes the revision it created so the next
 * run does not do it on its own critical path.
 *
 * Two coordinators rather than one, because that is the shape of the thing: a
 * coordinator is built per run, and both halves of this feature exist
 * precisely because the pool and the index service outlive it.
 */

interface SessionState {
  input: StartTaskInput;
  context?: CoordinatorContext;
}

/** Writes one file per turn and reports whatever the workspace then holds. */
class ScriptedAgent implements AgentAdapter {
  private readonly sessions = new Map<string, SessionState>();
  public turnPlan: AgentPlan;
  public turnOutput: { path: string; content: string } | undefined;
  /** Workspace-relative paths read at the start of every edit phase. */
  public probePaths: string[] = [];
  /** One record per edit phase: probed path → content, or "<absent>". */
  public readonly observed: Array<Record<string, string>> = [];
  public readonly workspacePaths: string[] = [];
  public readonly continueTask?: (
    session: AgentSession,
    input: StartTaskInput,
  ) => Promise<AgentSession>;

  public constructor(
    private readonly agentId: string,
    firstPlan: AgentPlan,
    private readonly repository: CanonicalRepository,
    private readonly workspaces: GitWorktreeWorkspaceManager,
    conversational = false,
  ) {
    this.turnPlan = firstPlan;
    if (conversational) {
      this.continueTask = async (session, input) => {
        this.sessions.set(session.id, { input });
        return { ...session, taskId: input.task.id };
      };
    }
  }

  public async getCapabilities(): Promise<AgentCapabilities> {
    return {
      canPlan: true,
      canEditFiles: true,
      canRunCommands: true,
      canUseTools: false,
      supportsStreaming: false,
      supportsPause: false,
    };
  }

  public async startTask(input: StartTaskInput): Promise<AgentSession> {
    const session: AgentSession = {
      id: createId("session"),
      agentId: this.agentId,
      taskId: input.task.id,
      startedAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, { input });
    return session;
  }

  public async requestPlan(sessionId: string): Promise<AgentPlan> {
    this.requireSession(sessionId);
    return structuredClone(this.turnPlan);
  }

  public async requestReplan(sessionId: string): Promise<AgentPlan> {
    this.requireSession(sessionId);
    return structuredClone(this.turnPlan);
  }

  public async sendContext(
    sessionId: string,
    context: CoordinatorContext,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    session.context = context;
    this.workspacePaths.push(context.workspacePath);
    const seen: Record<string, string> = {};
    for (const probe of this.probePaths) {
      try {
        seen[probe] = await readFile(
          path.join(context.workspacePath, probe),
          "utf8",
        );
      } catch {
        seen[probe] = "<absent>";
      }
    }
    this.observed.push(seen);
    if (this.turnOutput !== undefined) {
      await writeFile(
        path.join(context.workspacePath, this.turnOutput.path),
        this.turnOutput.content,
        "utf8",
      );
    }
  }

  public async pause(): Promise<void> {
    throw new Error("not supported");
  }

  public async resume(): Promise<void> {
    throw new Error("not supported");
  }

  public async resolveScopeChange(
    _sessionId: string,
    _decision: ScopeChangeDecision,
  ): Promise<void> {}

  /**
   * Written when the session closes, which is the last moment before the
   * directory is offered to the pool — the closest a test gets to an agent
   * that was still finishing up as its task settled.
   */
  public leaveOnCancel: Array<{ path: string; content: string }> = [];

  public async cancel(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const workspacePath = session.context?.workspacePath;
    if (workspacePath === undefined) {
      return;
    }
    for (const entry of this.leaveOnCancel) {
      await mkdir(path.dirname(path.join(workspacePath, entry.path)), {
        recursive: true,
      });
      await writeFile(
        path.join(workspacePath, entry.path),
        entry.content,
        "utf8",
      );
    }
  }

  public async collectChanges(sessionId: string): Promise<ChangeSet> {
    const session = this.requireSession(sessionId);
    const context = session.context;
    if (context === undefined) {
      throw new Error("the agent has no coordinator context");
    }
    const workspace: TaskWorkspace = {
      id: context.decision.workspaceId ?? createId("workspace"),
      taskId: session.input.task.id,
      path: context.workspacePath,
      rootPath: context.workspacePath,
      repository: this.repository,
      baseVersion: context.canonicalVersion,
      isolation: "git-worktree",
      createdAt: new Date().toISOString(),
    };
    return await this.workspaces.collectChangeSet(workspace, {
      symbolsChanged: [],
      riskAssessment: { level: this.turnPlan.riskLevel, reasons: [] },
      agentExplanation: "warm start test",
    });
  }

  public async streamEvents(
    _sessionId: string,
    _handler: (event: AgentEvent) => void,
  ): Promise<void> {}

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return session;
  }
}

function task(id: string, validation: TaskDefinition["validationCommands"] = []) {
  return {
    id,
    objective: id,
    agentId: `agent_${id}`,
    validationCommands: validation,
  } satisfies TaskDefinition;
}

function plan(taskId: string, expectedFiles: string[]): AgentPlan {
  return {
    taskId,
    objective: taskId,
    expectedFiles,
    expectedSymbols: [],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };
}

async function createFixture(root: string) {
  const sourcePath = path.join(root, "source");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  for (const name of ["a.txt", "b.txt", "c.txt"]) {
    await writeFile(path.join(sourcePath, "src", name), "seed\n", "utf8");
  }
  await repositories.commitAll(sourcePath, "seed");
  const repository = await repositories.importLocalRepository(
    sourcePath,
    path.join(root, "canonical.git"),
    "fixture",
  );
  return {
    repositories,
    repository,
    workspaces: new GitWorktreeWorkspaceManager(repositories.getGitClient()),
  };
}

/** The `task_started` payload for one task, as the audit chain recorded it. */
function startPayload(
  audit: readonly AuditEvent[],
  taskId: string,
): Record<string, unknown> {
  const event = audit.find(
    (entry) => entry.type === "task_started" && entry.taskId === taskId,
  );
  assert.ok(event !== undefined, `no task_started for ${taskId}`);
  return event.data;
}

/** Waits for the fire-and-forget build a promotion starts. */
async function untilIndexed(
  intelligence: CodeIntelligenceService,
  repository: CanonicalRepository,
  revision: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await intelligence.isWarm(repository, revision)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${revision} was never indexed by the promotion`);
}

test("a landed task hands its directory and its index to the next run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-warm-run-"));
  try {
    const fixture = await createFixture(root);
    const warmWorkspaces = new WarmWorkspacePool({ log: () => {} });
    const intelligence = new CodeIntelligenceService(fixture.repositories);
    const run = async (
      agent: ScriptedAgent,
      definition: TaskDefinition,
    ): Promise<ReturnType<Coordinator["run"]>> =>
      await new Coordinator({
        repositories: fixture.repositories,
        workspaces: fixture.workspaces,
        warmWorkspaces,
        intelligence,
      }).run({
        repository: fixture.repository,
        workspaceRoot: path.join(root, "workspaces"),
        integrationRoot: path.join(root, "integration"),
        tasks: [{ task: definition, adapter: agent }],
      });

    const first = new ScriptedAgent(
      "agent_one",
      plan("task_one", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    first.turnOutput = { path: "src/a.txt", content: "landed\n" };
    // Everything a task leaves behind, in one directory: an ephemeral tree
    // worth keeping and a stray file that must not reach the next tenant.
    first.leaveOnCancel = [
      { path: "node_modules/dep.js", content: "1\n" },
      { path: "stray.txt", content: "mine\n" },
    ];
    const firstResult = await run(first, task("task_one"));
    assert.equal(firstResult.tasks[0]?.status, "integrated");
    assert.deepEqual(startPayload(firstResult.audit, "task_one")["indexStart"], "cold");
    assert.deepEqual(
      startPayload(firstResult.audit, "task_one")["workspaceStart"],
      "cold",
    );

    const workspacePath = first.workspacePaths[0];
    assert.ok(workspacePath !== undefined);

    await warmWorkspaces.settled();
    assert.equal(warmWorkspaces.size(fixture.repository.id), 1);
    await untilIndexed(
      intelligence,
      fixture.repository,
      firstResult.canonicalVersion.revision,
    );

    const second = new ScriptedAgent(
      "agent_two",
      plan("task_two", ["src/b.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    second.turnOutput = { path: "src/b.txt", content: "second\n" };
    second.probePaths = ["src/a.txt", "stray.txt", "node_modules/dep.js"];
    const secondResult = await run(second, task("task_two"));
    assert.equal(
      secondResult.tasks[0]?.status,
      "integrated",
      secondResult.tasks[0]?.explanation,
    );

    // The same directory, and nothing of the first task's in it except what
    // is expensive to rebuild.
    assert.equal(second.workspacePaths[0], workspacePath);
    assert.equal(second.observed[0]?.["src/a.txt"], "landed\n");
    assert.equal(second.observed[0]?.["stray.txt"], "<absent>");
    assert.equal(second.observed[0]?.["node_modules/dep.js"], "1\n");

    const payload = startPayload(secondResult.audit, "task_two");
    assert.equal(payload["workspaceStart"], "warm");
    // Warm because the first run's promotion indexed the revision this one
    // started from, not because anything in this run did.
    assert.equal(payload["indexStart"], "warm");
    assert.equal(payload["dependencies"], "skipped");
    assert.equal(warmWorkspaces.stats().hits, 1);

    await warmWorkspaces.drain();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a conversational turn reads as resumed rather than warm", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-warm-resumed-"));
  try {
    const fixture = await createFixture(root);
    const warmWorkspaces = new WarmWorkspacePool({ log: () => {} });
    const coordinator = new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      warmWorkspaces,
    });
    const agent = new ScriptedAgent(
      "agent_conv",
      plan("turn_one", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      true,
    );
    const runTurn = async (definition: TaskDefinition) =>
      await coordinator.run({
        repository: fixture.repository,
        workspaceRoot: path.join(root, "workspaces"),
        integrationRoot: path.join(root, "integration"),
        tasks: [
          { task: definition, adapter: agent, conversationId: "conversation" },
        ],
      });

    agent.turnOutput = { path: "src/a.txt", content: "turn one\n" };
    const first = await runTurn(task("turn_one"));
    assert.equal(first.tasks[0]?.status, "integrated");
    // A conversation keeps its own directory, so it never reaches the pool.
    assert.equal(warmWorkspaces.size(fixture.repository.id), 0);

    agent.turnPlan = plan("turn_two", ["src/b.txt"]);
    agent.turnOutput = { path: "src/b.txt", content: "turn two\n" };
    const second = await runTurn(task("turn_two"));
    assert.equal(second.tasks[0]?.status, "integrated");
    assert.equal(
      startPayload(second.audit, "turn_two")["workspaceStart"],
      "resumed",
    );

    await warmWorkspaces.drain();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a task that fails keeps nothing, and the next one starts cold", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-warm-failed-"));
  try {
    const fixture = await createFixture(root);
    const warmWorkspaces = new WarmWorkspacePool({ log: () => {} });
    const run = async (agent: ScriptedAgent, definition: TaskDefinition) =>
      await new Coordinator({
        repositories: fixture.repositories,
        workspaces: fixture.workspaces,
        warmWorkspaces,
      }).run({
        repository: fixture.repository,
        workspaceRoot: path.join(root, "workspaces"),
        integrationRoot: path.join(root, "integration"),
        tasks: [{ task: definition, adapter: agent }],
      });

    const failing = new ScriptedAgent(
      "agent_fail",
      plan("task_fail", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    failing.turnOutput = { path: "src/a.txt", content: "broken\n" };
    const failed = await run(
      failing,
      task("task_fail", [
        {
          executable: process.execPath,
          args: ["-e", "process.exit(1)"],
          label: "always fails",
        },
      ]),
    );
    assert.notEqual(failed.tasks[0]?.status, "integrated");
    await warmWorkspaces.settled();
    // A failed task's agent process can outlive the cancel that was sent to
    // it, so its directory is never offered — and it is destroyed as before.
    assert.equal(warmWorkspaces.size(fixture.repository.id), 0);
    const failedPath = failing.workspacePaths[0];
    assert.ok(failedPath !== undefined);
    await assert.rejects(access(failedPath));

    const next = new ScriptedAgent(
      "agent_next",
      plan("task_next", ["src/b.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    next.turnOutput = { path: "src/b.txt", content: "next\n" };
    const following = await run(next, task("task_next"));
    assert.equal(following.tasks[0]?.status, "integrated");
    assert.equal(
      startPayload(following.audit, "task_next")["workspaceStart"],
      "cold",
    );

    await warmWorkspaces.drain();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a coordinator with no pool destroys every workspace, as it always did", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-warm-absent-"));
  try {
    const fixture = await createFixture(root);
    const agent = new ScriptedAgent(
      "agent_plain",
      plan("task_plain", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    agent.turnOutput = { path: "src/a.txt", content: "landed\n" };
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_plain"), adapter: agent }],
    });

    assert.equal(result.tasks[0]?.status, "integrated");
    const workspacePath = agent.workspacePaths[0];
    assert.ok(workspacePath !== undefined);
    await assert.rejects(access(workspacePath));
    // Still recorded, so the metric reads honestly on a deployment that has
    // not turned the pool on.
    assert.equal(
      startPayload(result.audit, "task_plain")["workspaceStart"],
      "cold",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
