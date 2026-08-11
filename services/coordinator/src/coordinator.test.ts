import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  type AgentAdapter,
  type AgentCapabilities,
  type AgentEvent,
  type AgentSession,
  type CoordinatorContext,
  type StartTaskInput,
} from "@coord/agent-protocol";
import {
  createId,
  type AgentPlan,
  type ChangeSet,
  type ReplanRequest,
  type ScopeChangeDecision,
  type ScopeChangeRequest,
  type TaskDefinition,
} from "@coord/shared-types";
import { InMemoryCoordinationStore } from "@coord/persistence";
import {
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  GitWorktreeWorkspaceManager,
  type TaskWorkspace,
  type WorkspaceManager,
} from "@coord/workspace-manager";

import { ApprovalPolicy } from "./approval-service.js";
import { Coordinator } from "./coordinator.js";
import { buildTaskHandoff } from "./handoff.js";
import { recordTaskHandoff } from "./handoff-store.js";

interface TestSession {
  input: StartTaskInput;
  context?: CoordinatorContext;
  eventHandler?: (event: AgentEvent) => void;
  scopeResolver?: (decision: ScopeChangeDecision) => void;
  scopeRejecter?: (error: Error) => void;
}

class TestAgent implements AgentAdapter {
  private readonly sessions = new Map<string, TestSession>();
  /** Every `startTask` call, for asserting what the agent was told up front. */
  public readonly startInputs: StartTaskInput[] = [];
  public readonly executionVersions: number[] = [];
  public readonly scopeDecisions: ScopeChangeDecision[] = [];
  public cancelCount = 0;

  public constructor(
    private readonly agentId: string,
    private readonly plan: AgentPlan,
    private readonly repository: CanonicalRepository,
    private readonly workspaces: WorkspaceManager,
    private readonly outputPath: string,
    private readonly planningFailure: boolean | Error = false,
    private readonly scopePath?: string,
  ) {}

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
    this.startInputs.push(input);
    this.sessions.set(session.id, { input });
    return session;
  }

  public async requestPlan(sessionId: string): Promise<AgentPlan> {
    this.requireSession(sessionId);
    if (this.planningFailure === true) {
      throw new Error("planned failure");
    }
    if (this.planningFailure !== false) {
      throw this.planningFailure;
    }
    return structuredClone(this.plan);
  }

  public async requestReplan(
    sessionId: string,
    _request: ReplanRequest,
  ): Promise<AgentPlan> {
    this.requireSession(sessionId);
    return structuredClone(this.plan);
  }

  public async sendContext(
    sessionId: string,
    context: CoordinatorContext,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    session.context = context;
    this.executionVersions.push(context.canonicalVersion.sequence);
    const scopePath = this.scopePath;
    if (scopePath !== undefined) {
      const decision = await new Promise<ScopeChangeDecision>((resolve, reject) => {
        session.scopeResolver = resolve;
        session.scopeRejecter = reject;
        session.eventHandler?.({
          event: "scope_change_requested",
          requestId: `scope_${this.plan.taskId}`,
          additionalFiles: [scopePath],
          reason: "The implementation needs one additional fixture file",
          occurredAt: new Date().toISOString(),
        });
      });
      if (decision.decision !== "rejected") {
        await writeFile(
          path.join(context.workspacePath, scopePath),
          `${this.plan.taskId} scope\n`,
          "utf8",
        );
      }
    }
    await writeFile(
      path.join(context.workspacePath, this.outputPath),
      `${this.plan.taskId}\n`,
      "utf8",
    );
  }

  public async pause(): Promise<void> {
    throw new Error("Test agents cannot pause");
  }

  public async resume(): Promise<void> {
    throw new Error("Test agents cannot resume");
  }

  public async resolveScopeChange(
    sessionId: string,
    decision: ScopeChangeDecision,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    this.scopeDecisions.push(structuredClone(decision));
    session.scopeResolver?.(decision);
    delete session.scopeResolver;
    delete session.scopeRejecter;
  }

  public async cancel(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    this.cancelCount += 1;
    session.scopeRejecter?.(new Error("Test agent was cancelled"));
    delete session.scopeResolver;
    delete session.scopeRejecter;
  }

  public async collectChanges(sessionId: string): Promise<ChangeSet> {
    const session = this.requireSession(sessionId);
    if (session.context === undefined) {
      throw new Error("Test agent has no coordinator context");
    }
    const workspace: TaskWorkspace = {
      id: session.context.decision.workspaceId ?? createId("workspace"),
      taskId: session.input.task.id,
      path: session.context.workspacePath,
      rootPath: session.context.workspacePath,
      repository: this.repository,
      baseVersion: session.context.canonicalVersion,
      isolation: "git-worktree",
      createdAt: new Date().toISOString(),
    };
    return await this.workspaces.collectChangeSet(workspace, {
      symbolsChanged: [],
      riskAssessment: { level: this.plan.riskLevel, reasons: [] },
      agentExplanation: "Coordinator lifecycle test",
    });
  }

  public async streamEvents(
    sessionId: string,
    handler: (event: AgentEvent) => void,
  ): Promise<void> {
    this.requireSession(sessionId).eventHandler = handler;
  }

  private requireSession(sessionId: string): TestSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return session;
  }
}

class FailingScopeStore extends InMemoryCoordinationStore {
  public override async saveScopeChange(
    _runId: string,
    _request: ScopeChangeRequest,
  ): Promise<void> {
    throw new Error("scope persistence unavailable");
  }
}

function task(id: string): TaskDefinition {
  return {
    id,
    objective: id,
    agentId: `agent_${id}`,
    validationCommands: [],
  };
}

function plan(
  taskId: string,
  expectedFiles: string[],
  options: {
    dependencies?: string[];
    riskLevel?: AgentPlan["riskLevel"];
  } = {},
): AgentPlan {
  return {
    taskId,
    objective: taskId,
    expectedFiles,
    expectedSymbols: [],
    dependencies: options.dependencies ?? [],
    commands: [],
    externalAccess: [],
    riskLevel: options.riskLevel ?? "low",
  };
}

async function createFixture(root: string): Promise<{
  repositories: RepositoryService;
  repository: CanonicalRepository;
  workspaces: GitWorktreeWorkspaceManager;
}> {
  const sourcePath = path.join(root, "source");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "ab.txt", "bc.txt"]) {
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

test("honors transitive blocker order and isolates each run's audit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const coordinator = new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
    });
    const agentA = new TestAgent(
      "agent_a",
      plan("task_a", ["src/a.txt", "src/ab.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
    );
    const agentB = new TestAgent(
      "agent_b",
      plan("task_b", ["src/ab.txt", "src/b.txt", "src/bc.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/b.txt",
    );
    const agentC = new TestAgent(
      "agent_c",
      plan("task_c", ["src/bc.txt", "src/c.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/c.txt",
    );

    const first = await coordinator.run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        { task: task("task_a"), adapter: agentA },
        { task: task("task_b"), adapter: agentB },
        { task: task("task_c"), adapter: agentC },
      ],
    });

    assert.equal(first.tasks.every((entry) => entry.status === "integrated"), true);
    assert.deepEqual(agentA.executionVersions, [1]);
    assert.deepEqual(agentB.executionVersions, [2]);
    assert.deepEqual(agentC.executionVersions, [3]);

    const agentD = new TestAgent(
      "agent_d",
      plan("task_d", ["src/d.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/d.txt",
    );
    const second = await coordinator.run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_d"), adapter: agentD }],
    });

    assert.deepEqual(
      second.audit
        .filter((event) => event.type === "task_submitted")
        .map((event) => event.taskId),
      ["task_d"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancels every started session when planning fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const store = new InMemoryCoordinationStore();
    const coordinator = new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      store,
    });
    const healthy = new TestAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
    );
    const failing = new TestAgent(
      "agent_b",
      plan("task_b", ["src/b.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/b.txt",
      new AggregateError(
        [new Error("provider authentication failed"), new Error("cleanup denied")],
        "planning and cleanup failed",
      ),
    );

    await assert.rejects(
      coordinator.run({
        repository: fixture.repository,
        workspaceRoot: path.join(root, "workspaces"),
        integrationRoot: path.join(root, "integration"),
        tasks: [
          { task: task("task_a"), adapter: healthy },
          { task: task("task_b"), adapter: failing },
        ],
      }),
      /failed during planning/u,
    );
    assert.equal(healthy.cancelCount, 1);
    assert.equal(failing.cancelCount, 1);
    const [run] = await store.listRuns(1);
    assert.ok(run);
    const detail = await store.getRun(run.id);
    assert.match(
      detail?.tasks.find((entry) => entry.id === "task_b")?.explanation ?? "",
      /planning and cleanup failed; provider authentication failed; cleanup denied/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancels dependency descendants when their producer cannot integrate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const coordinator = new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      // What stops the producer here is the approval gate on a high-risk
      // plan, with nobody to give one. That used to be the default; since
      // 2026-08-06 an unconfigured project runs unattended, so the gate this
      // test depends on is asked for explicitly. The subject under test is
      // dependency cancellation, not the default.
      approvalPolicy: new ApprovalPolicy({ enabled: true }),
    });
    const producer = new TestAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"], { riskLevel: "high" }),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
    );
    const consumer = new TestAgent(
      "agent_b",
      plan("task_b", ["src/b.txt"], {
        dependencies: ["file:src/a.txt"],
      }),
      fixture.repository,
      fixture.workspaces,
      "src/b.txt",
    );

    const result = await coordinator.run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        { task: task("task_a"), adapter: producer },
        { task: task("task_b"), adapter: consumer },
      ],
    });

    assert.equal(
      result.tasks.find((entry) => entry.task.id === "task_a")?.status,
      "failed",
    );
    assert.equal(
      result.tasks.find((entry) => entry.task.id === "task_b")?.status,
      "cancelled",
    );
    assert.deepEqual(consumer.executionVersions, []);
    assert.equal(consumer.cancelCount, 1);
    assert.equal(
      result.audit.some(
        (event) =>
          event.type === "task_cancelled" &&
          event.data["blockedBy"] === "task_a",
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grants conflict-free live scope and integrates the revised plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new TestAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      false,
      "src/c.txt",
    );
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    assert.equal(result.tasks[0]?.status, "integrated");
    assert.equal(result.tasks[0]?.plan.expectedFiles.includes("src/c.txt"), true);
    assert.equal(agent.scopeDecisions[0]?.decision, "approved");
    assert.equal(
      result.audit.some((event) => event.type === "scope_change_decided"),
      true,
    );
    assert.match(
      await fixture.repositories.readFile(
        fixture.repository,
        result.canonicalVersion.revision,
        "src/c.txt",
      ),
      /scope/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects live scope that collides with another active task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const expanding = new TestAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      false,
      "src/b.txt",
    );
    const owner = new TestAgent(
      "agent_b",
      plan("task_b", ["src/b.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/b.txt",
    );
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        { task: task("task_a"), adapter: expanding },
        { task: task("task_b"), adapter: owner },
      ],
    });

    assert.equal(result.tasks.every((entry) => entry.status === "integrated"), true);
    assert.equal(expanding.scopeDecisions[0]?.decision, "rejected");
    assert.match(
      expanding.scopeDecisions[0]?.explanation ?? "",
      /conflicts with active task task_b/u,
    );
    assert.deepEqual(result.tasks[0]?.plan.expectedFiles, ["src/a.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancels execution promptly when a scope event cannot be persisted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new TestAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      false,
      "src/c.txt",
    );
    const store = new FailingScopeStore();
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      store,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    assert.equal(result.tasks[0]?.status, "failed");
    assert.match(result.tasks[0]?.explanation ?? "", /cancelled/u);
    assert.ok(agent.cancelCount >= 1);
    assert.equal(result.canonicalVersion.sequence, 1);
    assert.equal((await store.listRuns())[0]?.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a task's own context leads the handoffs it is seeded with", async () => {
  // Two kinds of background reach one planning prompt, and they are not
  // equally close to the work. The thread is about *this* request — it is
  // where "now do the same for the other file" gets its meaning — while a
  // handoff is about the repository in general. Nearest first, so the thing
  // being asked for survives any truncation at the far end.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const store = new InMemoryCoordinationStore();
    await recordTaskHandoff(
      store,
      buildTaskHandoff({
        taskId: "task_earlier",
        objective: "Rename the config loader",
        repositoryId: fixture.repository.id,
        canonicalRevision: "b".repeat(40),
        reason: "completed",
        now: () => new Date("2026-07-29T12:00:00.000Z"),
      }),
    );
    const agent = new TestAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
    );
    await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      store,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        {
          task: {
            ...task("task_a"),
            context: "In the thread so far:\n- update the endpoint file too",
          },
          adapter: agent,
        },
      ],
    });

    const prior = agent.startInputs[0]?.priorContext ?? "";
    assert.match(prior, /update the endpoint file too/u);
    assert.match(prior, /Handoff from earlier work/u);
    assert.ok(
      prior.indexOf("update the endpoint file too") <
        prior.indexOf("Handoff from earlier work"),
      `the thread should lead the handoffs, got: ${prior}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a task with no context is seeded with the handoffs alone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const store = new InMemoryCoordinationStore();
    const agent = new TestAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
    );
    await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      store,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    // Nothing on either side: the adapter must be given no field at all
    // rather than a heading with nothing under it.
    assert.equal(agent.startInputs[0]?.priorContext, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
