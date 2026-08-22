import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  type AgentActionResult,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentEvent,
  type AgentQuestion,
  type AgentSession,
  type CoordinatorContext,
  type QuestionAnswer,
  type ScopeContentionNotice,
  type StartTaskInput,
} from "@coord/agent-protocol";
import {
  createId,
  ROLE_CONTEXT_PREFIX,
  type AgentPlan,
  type ChangeSet,
  type FilePatch,
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
import {
  Coordinator,
  type DeferredScopeRequest,
} from "./coordinator.js";
import { buildTaskHandoff } from "./handoff.js";
import { recordTaskHandoff } from "./handoff-store.js";
import { TaskCancellationRegistry } from "./task-cancellation.js";

interface TestSession {
  input: StartTaskInput;
  context?: CoordinatorContext;
  eventHandler?: (event: AgentEvent) => void;
  scopeResolver?: (decision: ScopeChangeDecision) => void;
  scopeRejecter?: (error: Error) => void;
  actionResolver?: (result: AgentActionResult) => void;
}

class TestAgent implements AgentAdapter {
  private readonly sessions = new Map<string, TestSession>();
  /** Every `startTask` call, for asserting what the agent was told up front. */
  public readonly startInputs: StartTaskInput[] = [];
  public readonly executionVersions: number[] = [];
  public readonly scopeDecisions: ScopeChangeDecision[] = [];
  public readonly actionResults: AgentActionResult[] = [];
  public readonly replanRequests: ReplanRequest[] = [];
  public cancelCount = 0;

  public constructor(
    private readonly agentId: string,
    protected readonly plan: AgentPlan,
    private readonly repository: CanonicalRepository,
    private readonly workspaces: WorkspaceManager,
    /** Empty writes nothing, which is what a task asked only to look does. */
    private readonly outputPath: string,
    private readonly planningFailure: boolean | Error = false,
    private readonly scopePath?: string,
    /** What the agent says it found, when the finding is the deliverable. */
    private readonly reportText?: string,
    /**
     * How long the edit phase lingers after writing, so a test can observe
     * what is reported *while* an agent works rather than only afterwards.
     */
    private readonly editLingerMs = 0,
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
    request: ReplanRequest,
  ): Promise<AgentPlan> {
    this.requireSession(sessionId);
    this.replanRequests.push(structuredClone(request));
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
    if (this.outputPath !== "") {
      await writeFile(
        path.join(context.workspacePath, this.outputPath),
        `${this.plan.taskId}\n`,
        "utf8",
      );
    }
    if (this.editLingerMs > 0) {
      // Standing in for the long edit phase a real CLI spends here — the one
      // stretch of a run that reported nothing.
      await new Promise((resolve) => setTimeout(resolve, this.editLingerMs));
    }
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

  public async resolveAction(
    sessionId: string,
    result: AgentActionResult,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    this.actionResults.push(structuredClone(result));
    session.actionResolver?.(result);
    delete session.actionResolver;
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
      agentExplanation: this.reportText ?? "Coordinator lifecycle test",
    });
  }

  public async streamEvents(
    sessionId: string,
    handler: (event: AgentEvent) => void,
  ): Promise<void> {
    this.requireSession(sessionId).eventHandler = handler;
  }

  /** The event handler for one session, for a subclass that emits its own. */
  protected handlerFor(sessionId: string): ((event: AgentEvent) => void) | undefined {
    return this.sessions.get(sessionId)?.eventHandler;
  }

  /** This agent's plan, for a subclass building a variation of it. */
  protected planFor(): AgentPlan {
    return this.plan;
  }

  /** One session, for a subclass that has to park a resolver on it. */
  protected sessionFor(sessionId: string): TestSession {
    return this.requireSession(sessionId);
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

test("a planning failure fails that task alone; the wave runs on", async () => {
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

    // The tasks are independent requests, so one agent failing to plan —
    // a dead sign-in, most days — must not abort the other's healthy run.
    const result = await coordinator.run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        { task: task("task_a"), adapter: healthy },
        { task: task("task_b"), adapter: failing },
      ],
    });

    const outcomes = new Map(
      result.tasks.map((entry) => [entry.task.id, entry]),
    );
    assert.equal(outcomes.get("task_a")?.status, "integrated");
    assert.equal(outcomes.get("task_b")?.status, "failed");
    // The failure keeps its causes, not just the wrapper's shape.
    assert.match(
      outcomes.get("task_b")?.explanation ?? "",
      /provider authentication failed/u,
    );
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

test("closes the agent session when its task integrates", async () => {
  // The session used to be dropped rather than closed on success: every
  // adapter.cancel in the coordinator sat on a failure path, so whatever the
  // adapter still held for the session outlived the task. Settlement now
  // closes it on every outcome, the way the remote worker always has.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new TestAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
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
    assert.equal(agent.cancelCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("closes the agent session when integration fails", async () => {
  // Failing at integration is settling all the same. This path never
  // cancelled either — prepareTask's catch covered execution failures, but a
  // task whose validation rejected it slipped past both.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new TestAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
    );
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        {
          task: {
            ...task("task_a"),
            validationCommands: [
              {
                executable: process.execPath,
                args: ["-e", "process.exit(1)"],
                label: "always fails",
              },
            ],
          },
          adapter: agent,
        },
      ],
    });

    assert.equal(result.tasks[0]?.status, "failed");
    assert.equal(agent.cancelCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * An agent that asks the platform to start its app before it edits anything,
 * the way one checking its own work would.
 */
class ActionAgent extends TestAgent {
  public readonly seen: AgentActionResult[] = [];

  public override async sendContext(
    sessionId: string,
    context: CoordinatorContext,
  ): Promise<void> {
    const result = await new Promise<AgentActionResult>((resolve) => {
      this.sessionFor(sessionId).actionResolver = resolve;
      this.handlerFor(sessionId)?.({
        event: "action_requested",
        requestId: "action_1",
        action: "preview_start",
        occurredAt: new Date().toISOString(),
      });
    });
    this.seen.push(result);
    await super.sendContext(sessionId, context);
  }
}

/** An agent that decides mid-task that its approved plan was the wrong one. */
class ReplanningAgent extends TestAgent {
  public readonly answers: ScopeChangeDecision[] = [];

  public constructor(
    agentId: string,
    plan: AgentPlan,
    repository: CanonicalRepository,
    workspaces: WorkspaceManager,
    outputPath: string,
    private readonly proposedFiles: string[],
  ) {
    super(agentId, plan, repository, workspaces, outputPath);
  }

  public override async sendContext(
    sessionId: string,
    context: CoordinatorContext,
  ): Promise<void> {
    const answer = await new Promise<ScopeChangeDecision>((resolve) => {
      this.sessionFor(sessionId).scopeResolver = resolve;
      this.handlerFor(sessionId)?.({
        event: "replan_proposed",
        requestId: "replan_1",
        plan: {
          ...structuredClone(this.planFor()),
          expectedFiles: [...this.proposedFiles],
        },
        reason: "The work belongs in a different file than I declared",
        occurredAt: new Date().toISOString(),
      });
    });
    this.answers.push(answer);
    await super.sendContext(sessionId, context);
  }
}

test("an agent may replace its own plan, and is held to the same checks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ReplanningAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      ["src/a.txt", "src/c.txt"],
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

    assert.equal(agent.answers[0]?.decision, "approved");
    assert.equal(
      agent.answers[0]?.revisedPlan.expectedFiles.includes("src/c.txt"),
      true,
    );
    // The plan in force is the new one, so scope enforcement holds the agent
    // to what it proposed rather than to what it originally declared.
    assert.equal(result.tasks[0]?.plan.expectedFiles.includes("src/c.txt"), true);
    assert.equal(result.tasks[0]?.status, "integrated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a proposed plan that reaches into work running elsewhere is refused", async () => {
  // The point of putting a mid-task plan through the durable authority. An
  // agent rewriting its own plan is exactly when it would otherwise be able to
  // claim whatever it liked, and a refusal leaves it working inside the plan
  // it already had rather than ending the task.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ReplanningAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      ["src/held.txt"],
    );
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      planAuthority: {
        async admit(request) {
          return request.plan.expectedFiles.includes("src/held.txt")
            ? {
                outcome: "deferred",
                retryAfterMs: 1_000,
                blockedBy: ["task_elsewhere"],
                explanation: "src/held.txt is leased to task_elsewhere",
              }
            : { outcome: "admitted", plan: request.plan };
        },
      },
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    assert.equal(agent.answers[0]?.decision, "rejected");
    assert.match(agent.answers[0]?.explanation ?? "", /task_elsewhere/u);
    // Refused, not failed: the original plan is still in force and the task
    // finishes inside it.
    assert.deepEqual(agent.answers[0]?.revisedPlan.expectedFiles, ["src/a.txt"]);
    assert.equal(result.tasks[0]?.status, "integrated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a replan is refused rather than quietly narrowed", async () => {
  // Partial admission is an answer to "what may this task start on", and a
  // replan is past that: the agent is running inside an approved plan.
  //
  // Taking a narrower grant here would be worse than refusing. `revisedPlan`
  // is what ownership is taken on and what the changeset is validated
  // against, so a withheld file would sit *inside* the approved plan, pass
  // the check, and reach canonical while another task held its lease. The
  // authority is asked for all-or-nothing, and one that narrows anyway is
  // refused rather than obeyed — which is what this stub does.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ReplanningAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      ["src/a.txt", "src/held.txt"],
    );
    const asked: (boolean | undefined)[] = [];
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      planAuthority: {
        async admit(request) {
          asked.push(request.partialAdmission);
          if (!request.plan.expectedFiles.includes("src/held.txt")) {
            return { outcome: "admitted", plan: request.plan };
          }
          // Ignores the all-or-nothing request on purpose.
          return {
            outcome: "admitted",
            plan: { ...request.plan, expectedFiles: ["src/a.txt"] },
            admission: {
              status: "approved_with_constraints",
              taskId: request.task.id,
              planRevision: 1,
              baseRevision: "b".repeat(40),
              ownershipGrants: [],
              constraints: [],
              blockedBy: [],
              conflicts: [],
              deferredResources: [
                {
                  resourceType: "file",
                  resourceId: "src/held.txt",
                  heldBy: ["task_elsewhere"],
                  reason: "held by task_elsewhere",
                },
              ],
              explanation: "src/held.txt is leased to task_elsewhere",
              decidedAt: new Date().toISOString(),
            },
          };
        },
      },
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    // The replan asked for all-or-nothing rather than taking what it got.
    assert.equal(asked.includes(false), true);
    // Refused, so the agent stays on the plan it already had and finishes
    // inside it — and src/held.txt never enters the approved plan at all.
    assert.equal(agent.answers[0]?.decision, "rejected");
    assert.match(agent.answers[0]?.explanation ?? "", /task_elsewhere/u);
    assert.deepEqual(agent.answers[0]?.revisedPlan.expectedFiles, ["src/a.txt"]);
    assert.equal(result.tasks[0]?.status, "integrated");
    assert.equal(result.tasks[0]?.plan.expectedFiles.includes("src/held.txt"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Writes a file it was not granted, the way a real agent does under a split. */
class OverreachingAgent extends TestAgent {
  public constructor(
    agentId: string,
    plan: AgentPlan,
    repository: CanonicalRepository,
    workspaces: WorkspaceManager,
    outputPath: string,
    private readonly alsoWrites: string,
  ) {
    super(agentId, plan, repository, workspaces, outputPath);
  }

  public override async sendContext(
    sessionId: string,
    context: CoordinatorContext,
  ): Promise<void> {
    await super.sendContext(sessionId, context);
    await writeFile(
      path.join(context.workspacePath, this.alsoWrites),
      "written without being granted\n",
      "utf8",
    );
  }
}

test("a file the admission withheld is held back, not called a scope escape", async () => {
  // Two halves of one job, sharing a file. The agent planned both, was granted
  // one, and wrote both anyway — which is the ordinary case, not misbehaviour:
  // it planned before it was told what it could have.
  //
  // The withheld file is somebody else's to write, so it is held back and
  // becomes a task of its own. Failing the task over it would throw away the
  // granted work too, which is what this path used to do while the worker path
  // split correctly — the same run's outcome depended on which executor ran it.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new OverreachingAgent(
      "agent_a",
      plan("task_a", ["src/a.txt", "src/shared.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      "src/shared.txt",
    );
    const remainders: DeferredScopeRequest[] = [];
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      planAuthority: {
        async admit(request) {
          return {
            outcome: "admitted",
            plan: { ...request.plan, expectedFiles: ["src/a.txt"] },
            admission: {
              status: "approved_with_constraints",
              taskId: request.task.id,
              planRevision: 1,
              baseRevision: "b".repeat(40),
              ownershipGrants: [],
              constraints: [],
              blockedBy: [],
              conflicts: [],
              deferredResources: [
                {
                  resourceType: "file",
                  resourceId: "src/shared.txt",
                  heldBy: ["task_elsewhere"],
                  reason: "also declared by executing task task_elsewhere",
                },
              ],
              explanation: "src/shared.txt is leased to task_elsewhere",
              decidedAt: new Date().toISOString(),
            },
          };
        },
        async deferRemainder(request) {
          remainders.push(request);
        },
      },
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    // Integrated rather than failed — the whole point. Before the split, the
    // withheld file failed the task and took `src/a.txt` down with it.
    assert.equal(result.tasks[0]?.status, "integrated");
    // Queued as work of its own, and only after the granted half was durably
    // promoted, so it is not silently gone either.
    assert.equal(remainders.length, 1);
    assert.deepEqual(
      remainders[0]?.split.granted.patches.map(
        (patch: FilePatch) => patch.path,
      ),
      ["src/a.txt"],
    );
    assert.deepEqual(
      remainders[0]?.split.deferred.map((patch: FilePatch) => patch.path),
      ["src/shared.txt"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an agent can ask the platform to act, and is told what happened", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ActionAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
    );
    const asked: string[] = [];
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      actionAuthority: {
        async perform(request) {
          asked.push(request.action);
          // The workspace, not canonical — an agent looking at its own work
          // needs the change it has just made, which canonical does not have.
          assert.equal(typeof request.workspacePath, "string");
          assert.notEqual(request.workspacePath, "");
          return {
            outcome: "done",
            detail: { url: "http://127.0.0.1:4321", output: ["listening"] },
            explanation: "The app is at http://127.0.0.1:4321.",
          };
        },
      },
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    assert.deepEqual(asked, ["preview_start"]);
    assert.equal(agent.seen[0]?.outcome, "done");
    assert.equal(agent.seen[0]?.detail?.url, "http://127.0.0.1:4321");
    // Both halves are in the log, so "what did this agent ask for" and "what
    // was it given" are each answerable after the fact.
    assert.equal(
      result.audit.some((event) => event.type === "action_requested"),
      true,
    );
    assert.equal(
      result.audit.some((event) => event.type === "action_performed"),
      true,
    );
    assert.equal(result.tasks[0]?.status, "integrated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a task whose deliverable was a performed action ends done, not empty", async () => {
  // "Push to GitHub" leaves no diff by design: the push happens in the
  // platform, not the workspace. This used to settle as failed — "The agent
  // produced no repository changes" — with the push done and the branch name
  // discarded in favour of that sentence.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ActionAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      // Writes nothing: the action is the whole of the work.
      "",
      false,
      undefined,
      "Pushed abc1234 to coord/export-test as octocat.",
    );
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      store: new InMemoryCoordinationStore(),
      actionAuthority: {
        async perform() {
          return {
            outcome: "done",
            explanation: "Pushed abc1234 to coord/export-test.",
          };
        },
      },
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    assert.equal(result.tasks[0]?.status, "integrated");
    // The agent's account of the action is the deliverable, not the generic
    // no-changes sentence.
    assert.equal(
      result.tasks[0]?.explanation,
      "Pushed abc1234 to coord/export-test as octocat.",
    );
    const types = result.audit.map((event) => event.type);
    assert.ok(types.includes("task_reported"), types.join(", "));
    assert.ok(!types.includes("task_failed"), types.join(", "));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a refused action completes with the agent's explanation", async () => {
  // The platform result is the deliverable. Relaying a refusal changes no
  // files, but the agent still completed the task it was able to perform.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ActionAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "",
      false,
      undefined,
      // What a well-behaved agent writes after a refusal: the relay the
      // prompt asks for. The ending must carry it — this exact sentence
      // sitting unread while the thread said "produced no repository
      // changes" is how a missing GitHub connection was undiagnosable
      // from the channel.
      "The push was refused: you haven't connected GitHub.",
    );
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      store: new InMemoryCoordinationStore(),
      actionAuthority: {
        async perform() {
          return {
            outcome: "refused",
            explanation: "You haven't connected GitHub.",
          };
        },
      },
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    assert.equal(result.tasks[0]?.status, "integrated");
    assert.equal(
      result.tasks[0]?.explanation,
      "The push was refused: you haven't connected GitHub.",
    );
    const types = result.audit.map((event) => event.type);
    assert.ok(types.includes("task_reported"), types.join(", "));
    assert.ok(!types.includes("task_failed"), types.join(", "));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a deployment that performs no actions says so, and the task carries on", async () => {
  // The agent is blocked waiting and holds an approved plan it can still work
  // inside, so a refusal costs it one round trip. An exception would cost the
  // whole task.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ActionAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
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

    assert.equal(agent.seen[0]?.outcome, "refused");
    assert.match(agent.seen[0]?.explanation ?? "", /does not perform actions/u);
    assert.equal(result.tasks[0]?.status, "integrated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses live scope that overlaps work running in another run", async () => {
  // The wave this task belongs to is the only thing the conflict check can
  // see, and a task in a different run is not in it. Before the authority was
  // consulted here, an agent could widen into a file another run was holding
  // and nothing noticed until both tried to land — the same blind spot
  // admission had before it read durable leases, one layer down.
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
    const asked: string[][] = [];
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      planAuthority: {
        async admit(request) {
          asked.push([...request.plan.expectedFiles]);
          // Approve the original plan, refuse the widening — which is what a
          // durable authority does when somebody else holds the extra file.
          return request.plan.expectedFiles.includes("src/c.txt")
            ? {
                outcome: "deferred",
                retryAfterMs: 1_000,
                blockedBy: ["task_elsewhere"],
                explanation: "src/c.txt is leased to task_elsewhere",
              }
            : { outcome: "admitted", plan: request.plan };
        },
      },
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    // Refused, not queued: the agent is mid-execution with a plan it can still
    // work inside, so it is told to carry on rather than left waiting.
    assert.equal(agent.scopeDecisions[0]?.decision, "rejected");
    assert.match(
      agent.scopeDecisions[0]?.explanation ?? "",
      /task_elsewhere/u,
    );
    // The widening was actually put to the authority, rather than the check
    // being skipped when a run has only one task in it.
    assert.equal(
      asked.some((files) => files.includes("src/c.txt")),
      true,
    );
    // And the task still finishes the work it was admitted for.
    assert.equal(result.tasks[0]?.status, "integrated");
    assert.equal(result.tasks[0]?.plan.expectedFiles.includes("src/c.txt"), false);
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

test("a task asked to look finishes by reporting, not by failing", async () => {
  // The failure this removes, in full: an audit asked for in a channel ran,
  // wrote its findings into the changeset, reached integration with no
  // patches, and was recorded as failed with "The agent produced no
  // repository changes" in place of what it found. Only the remote-worker
  // path could tell a report from a silently-refused edit; every task the
  // control plane runs in process comes through the coordinator.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const store = new InMemoryCoordinationStore();
    const findings = "Three things worth fixing: the retry bound is inclusive.";
    const agent = new TestAgent(
      "agent_a",
      plan("task_a", []),
      fixture.repository,
      fixture.workspaces,
      // Writes nothing, which is what an audit does.
      "",
      false,
      undefined,
      findings,
    );
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      store,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        {
          task: { ...task("task_a"), objective: "audit the codebase" },
          adapter: agent,
        },
      ],
    });

    assert.equal(result.tasks[0]?.status, "integrated");
    // The agent's own words are the deliverable — there is no diff to read
    // instead, and the generic line says nothing a reader can use.
    assert.equal(result.tasks[0]?.explanation, findings);
    const types = result.audit.map((event) => event.type);
    assert.ok(types.includes("task_reported"), JSON.stringify(types));
    assert.ok(!types.includes("task_failed"), JSON.stringify(types));
    // Nothing was validated because nothing was changed; saying validation
    // "came back empty" in front of a finished report is the same false alarm
    // one line earlier.
    assert.ok(!types.includes("validation_completed"), JSON.stringify(types));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a completed task is not failed solely because it changed nothing", async () => {
  // Completion is the agent's explicit outcome. Inferring failure from the
  // objective made legitimate no-op answers depend on a wording heuristic.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const store = new InMemoryCoordinationStore();
    const agent = new TestAgent(
      "agent_a",
      plan("task_a", []),
      fixture.repository,
      fixture.workspaces,
      "",
      false,
      undefined,
      "The retry loop already has the requested behavior.",
    );
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      store,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        {
          task: { ...task("task_a"), objective: "fix the retry loop" },
          adapter: agent,
        },
      ],
    });

    assert.equal(result.tasks[0]?.status, "integrated");
    assert.equal(
      result.tasks[0]?.explanation,
      "The retry loop already has the requested behavior.",
    );
    const types = result.audit.map((event) => event.type);
    assert.ok(types.includes("task_reported"), types.join(", "));
    assert.ok(!types.includes("task_failed"), types.join(", "));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty run carries the agent's account as its successful result", async () => {
  // With no diff to read, the agent's account is the deliverable and must be
  // preserved without a no-changes failure wrapped around it.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const store = new InMemoryCoordinationStore();
    const account =
      "Diagnosis only — no files changed. The attachment route reads bytes " +
      "back out of the attachment store and never writes them into the " +
      "repository, so a pasted screenshot cannot bloat the checkout.";
    const agent = new TestAgent(
      "agent_a",
      plan("task_a", []),
      fixture.repository,
      fixture.workspaces,
      "",
      false,
      undefined,
      account,
    );
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      store,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        {
          task: { ...task("task_a"), objective: "fix the retry loop" },
          adapter: agent,
        },
      ],
    });

    assert.equal(result.tasks[0]?.status, "integrated");
    const explanation = result.tasks[0]?.explanation ?? "";
    assert.equal(explanation, account);
    const types = result.audit.map((event) => event.type);
    assert.ok(types.includes("task_reported"), types.join(", "));
    assert.ok(!types.includes("task_failed"), types.join(", "));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a role preamble does not turn an audit into a failure", async () => {
  // The second half of the same bug. A channel dispatch submits
  // `withRoleContext(role, message)`, so the objective the coordinator reads
  // begins with the agent's declared role — and a role naming an editing verb
  // vetoed the report check before it ever looked at the request.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const store = new InMemoryCoordinationStore();
    const agent = new TestAgent(
      "agent_a",
      plan("task_a", []),
      fixture.repository,
      fixture.workspaces,
      "",
      false,
      undefined,
      "Nothing structural is wrong; two naming nits.",
    );
    const result = await new Coordinator({
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
            objective:
              `${ROLE_CONTEXT_PREFIX} Codebase auditor and fixer.\n\n` +
              "audit the codebase",
          },
          adapter: agent,
        },
      ],
    });

    assert.equal(result.tasks[0]?.status, "integrated");
    assert.equal(
      result.tasks[0]?.explanation,
      "Nothing structural is wrong; two naming nits.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a promoted change carries the agent's own account of it", async () => {
  // The ending a reader actually sees is built from this event. Recording
  // only the revisions is why every successful task in the system finished
  // with one fixed sentence about canonical: the agent had written an account
  // of its work at `collectChanges`, and it travelled this far unread.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const store = new InMemoryCoordinationStore();
    const account = "Repointed six test imports at their new modules.";
    const agent = new TestAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      false,
      undefined,
      account,
    );
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

    assert.equal(result.tasks[0]?.status, "integrated");
    const promoted = result.audit.find(
      (event) => event.type === "canonical_promoted",
    );
    assert.ok(promoted !== undefined, "nothing was promoted");
    const data = promoted.data as Record<string, unknown>;
    assert.equal(data["agentExplanation"], account);
    // The files travel too, so the ending can say how much changed without
    // the reader opening anything.
    assert.deepEqual(data["files"], ["src/a.txt"]);
    // The revisions stay: they are what makes the claim checkable later.
    assert.equal(typeof data["revision"], "string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run reports what it is touching while it is still touching it", async () => {
  // The one stretch of a run that said nothing. `sendContext` is a single
  // await around the agent's whole edit phase — up to an hour — and no
  // adapter emits inside it, so a thread went quiet after "execution started"
  // and stayed quiet until the run ended. Work and a hang looked identical.
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
      false,
      undefined,
      undefined,
      // Long enough for several polls at the interval set below.
      400,
    );
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      store,
      workingChangePollMs: 25,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    assert.equal(result.tasks[0]?.status, "integrated");
    const live = result.audit.filter(
      (event) => event.type === "workspace_changed",
    );
    assert.ok(live.length > 0, "the edit phase reported nothing");
    const data = live[0]?.data as Record<string, unknown>;
    // The whole current set, so a reader arriving late does not have to
    // accumulate a diff of its own...
    assert.deepEqual(data["files"], [{ path: "src/a.txt", status: "modified" }]);
    // ...and what moved since the last report, which is what the channel says
    // out loud.
    assert.deepEqual(data["changed"], ["src/a.txt"]);

    // Reported once, not on every tick: a file that has not moved since the
    // last report is not news, and a thread of identical lines is no more
    // informative than silence.
    assert.equal(live.length, 1, JSON.stringify(live.map((e) => e.data)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an untracked file the agent creates is reported as added", async () => {
  // Untracked files are invisible to `git diff` until they are staged, and
  // staging is precisely what a poll must not do — `collectChangeSet` stages
  // with `--intent-to-add`, and running that on a timer underneath a live
  // agent writes to the index of a worktree somebody is editing.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new TestAgent(
      "agent_a",
      plan("task_a", ["src/new-file.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/new-file.txt",
      false,
      undefined,
      undefined,
      400,
    );
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      store: new InMemoryCoordinationStore(),
      workingChangePollMs: 25,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    const live = result.audit.filter(
      (event) => event.type === "workspace_changed",
    );
    assert.ok(live.length > 0, "a new file was never reported");
    assert.deepEqual((live[0]?.data as Record<string, unknown>)["files"], [
      { path: "src/new-file.txt", status: "added" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unanswered question cancels the task rather than guessing", async () => {
  // The agent asked because the choice was not its to make, and nobody
  // answering does not hand it back. Picking a default here would be the
  // platform deciding on somebody's behalf and calling it consent.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const asked: Array<{ question: string; options: string[] }> = [];
    const agent = new AskingAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      { question: "Change both modules?", options: ["Both", "One and a shim"] },
    );
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      store: new InMemoryCoordinationStore(),
      // Nobody ever answers.
      questions: {
        awaitAnswer: async (ask) => {
          asked.push({ question: ask.question, options: [...ask.options] });
          return undefined;
        },
      },
      questionDeadlineMs: 50,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.question, "Change both modules?");
    assert.equal(result.tasks[0]?.status, "failed");
    // Said as a cancellation, not as a mysterious timeout — the run must not
    // die on the execution clock when the deadline that lapsed was this one.
    const types = result.audit.map((event) => event.type);
    assert.ok(types.includes("question_asked"), JSON.stringify(types));
    assert.ok(types.includes("question_cancelled"), JSON.stringify(types));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an answered question is handed back and the run continues", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new AskingAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      { question: "Change both modules?", options: ["Both", "One and a shim"] },
    );
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      store: new InMemoryCoordinationStore(),
      questions: { awaitAnswer: async () => ({ chosen: 1 }) },
      questionDeadlineMs: 5_000,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    assert.equal(result.tasks[0]?.status, "integrated");
    assert.deepEqual(agent.answers, [{ requestId: "q1", status: "answered", chosen: 1 }]);
    const types = result.audit.map((event) => event.type);
    assert.ok(types.includes("question_answered"), JSON.stringify(types));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a set of questions is put whole, and answered one for one", async () => {
  // Asking three things at once costs one wait rather than three. The whole
  // set reaches the controller, and every question gets its own answer back —
  // including the one nobody chose an option for, which is a real answer
  // ("your call") rather than silence.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const asked: AgentQuestion[][] = [];
    const agent = new AskingAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      {
        question: "Change both modules?",
        options: ["Both", "One and a shim"],
        questions: [
          {
            question: "Change both modules?",
            options: ["Both", "One and a shim"],
            recommended: 0,
          },
          { question: "Keep the old name?", options: ["Keep", "Rename"] },
          { question: "Add a test?", options: ["Yes", "No"], recommended: 0 },
        ],
      },
    );
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      store: new InMemoryCoordinationStore(),
      questions: {
        awaitAnswer: async (ask) => {
          asked.push(ask.questions.map((entry) => ({ ...entry })));
          return {
            answers: [{ chosen: 0 }, { text: "call it loader2" }, { skipped: true }],
          };
        },
      },
      questionDeadlineMs: 5_000,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    assert.equal(result.tasks[0]?.status, "integrated");
    assert.equal(asked[0]?.length, 3);
    assert.equal(asked[0]?.[0]?.recommended, 0);
    assert.equal(asked[0]?.[1]?.question, "Keep the old name?");
    assert.deepEqual(agent.answers, [
      {
        requestId: "q1",
        status: "answered",
        chosen: 0,
        answers: [{ chosen: 0 }, { text: "call it loader2" }, { skipped: true }],
      },
    ]);
    const answered = result.audit.find(
      (event) => event.type === "question_answered",
    );
    assert.deepEqual(answered?.data["chose_all"], [
      "Both",
      "call it loader2",
      "(skipped)",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * An agent whose edit phase runs until somebody stops it — the shape of the
 * task the owner could not stop: a session mid-work, returning nothing, with
 * nothing user-facing able to reach it.
 */
class StoppableAgent extends TestAgent {
  /** Resolves once the edit phase has begun waiting, so a test can stop it. */
  public readonly startedWorking: Promise<void>;
  private noteStarted!: () => void;
  private interrupt: ((error: Error) => void) | undefined;

  public constructor(
    agentId: string,
    plan: AgentPlan,
    repository: CanonicalRepository,
    workspaces: WorkspaceManager,
  ) {
    super(agentId, plan, repository, workspaces, "");
    this.startedWorking = new Promise((resolve) => {
      this.noteStarted = resolve;
    });
  }

  public override async sendContext(): Promise<void> {
    await new Promise<void>((_resolve, reject) => {
      this.interrupt = reject;
      this.noteStarted();
    });
  }

  public override async cancel(sessionId: string): Promise<void> {
    await super.cancel(sessionId);
    // What a real adapter's abort does: the in-flight operation rejects.
    this.interrupt?.(new Error("The session was cancelled"));
    this.interrupt = undefined;
  }
}

test("a stop from outside aborts the live session and the task ends cancelled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new StoppableAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    const cancellations = new TaskCancellationRegistry();
    const running = new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      store: new InMemoryCoordinationStore(),
      cancellations,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    await agent.startedWorking;
    const reachedLive = await cancellations.cancel(
      "task_a",
      "Stopped from the channel",
    );
    assert.equal(reachedLive, true, "the live session must be reachable");

    const result = await running;
    assert.equal(result.tasks[0]?.status, "cancelled");
    assert.equal(result.tasks[0]?.explanation, "Stopped from the channel");
    assert.ok(agent.cancelCount >= 1, "the agent session was never aborted");
    // A stop is not a failure: task_failed here would hand the thread a
    // second, contradictory ending after "This was cancelled."
    assert.ok(
      !result.audit.some((event) => event.type === "task_failed"),
      result.audit.map((event) => event.type).join(", "),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an event handler failure names its cause, not the cancel's echo", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    // A store that refuses the one write the scope event needs — standing in
    // for any event handler failing mid-run. The handler's catch cancels the
    // session; the edit phase then rejects with that cancel's echo, and the
    // echo used to be the whole explanation the thread got.
    class RefusingStore extends InMemoryCoordinationStore {
      public override async saveScopeChange(
        _runId: string,
        _request: ScopeChangeRequest,
      ): Promise<void> {
        throw new Error("scope audit write refused");
      }
    }
    const agent = new TestAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      false,
      "src/extra.txt",
    );
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      store: new RefusingStore(),
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    assert.equal(result.tasks[0]?.status, "failed");
    assert.match(
      result.tasks[0]?.explanation ?? "",
      /scope audit write refused/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stop recorded before the wave starts removes the task unrun", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new TestAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
    );
    const cancellations = new TaskCancellationRegistry();
    // The stop lands while the task is still queued — before the run was
    // even dispatched, from the run's point of view.
    await cancellations.cancel("task_a", "Stopped before it started");

    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      store: new InMemoryCoordinationStore(),
      cancellations,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    assert.equal(result.tasks[0]?.status, "cancelled");
    // The edit phase never ran: the drain caught it at the wave boundary.
    assert.equal(agent.executionVersions.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * An agent that stops once to ask, then does the work it was going to do.
 *
 * Separate from `TestAgent` because the interesting behaviour is what it does
 * with the answer — including the case where there isn't one, where it must
 * stop rather than carry on with a guess.
 */
class AskingAgent extends TestAgent {
  public readonly answers: QuestionAnswer[] = [];
  private pending: ((answer: QuestionAnswer) => void) | undefined;

  public constructor(
    agentId: string,
    plan: AgentPlan,
    repository: CanonicalRepository,
    workspaces: WorkspaceManager,
    outputPath: string,
    private readonly ask: {
      question: string;
      options: string[];
      questions?: AgentQuestion[];
    },
  ) {
    super(agentId, plan, repository, workspaces, outputPath);
  }

  public override async sendContext(
    sessionId: string,
    context: CoordinatorContext,
  ): Promise<void> {
    const answer = await new Promise<QuestionAnswer>((resolve) => {
      this.pending = resolve;
      void this.emitQuestion(sessionId);
    });
    this.answers.push(answer);
    if (answer.status !== "answered") {
      // What the real adapter does: the choice was not its to make, and
      // silence does not hand it back.
      throw new Error("No answer — the task was cancelled rather than guessed at.");
    }
    await super.sendContext(sessionId, context);
  }

  public async resolveQuestion(
    _sessionId: string,
    answer: QuestionAnswer,
  ): Promise<void> {
    this.pending?.(answer);
    this.pending = undefined;
  }

  private async emitQuestion(sessionId: string): Promise<void> {
    this.handlerFor(sessionId)?.({
      event: "question_asked",
      requestId: "q1",
      question: this.ask.question,
      options: [...this.ask.options],
      ...(this.ask.questions === undefined
        ? {}
        : { questions: this.ask.questions }),
      occurredAt: new Date().toISOString(),
    });
  }
}

test("a wave only replans the tasks its work actually moved under", async () => {
  // The n(n-1)/2 the profiling found. Tasks are sequenced on *predicted*
  // overlap — a and b both claim ab.txt, b and c both claim bc.txt — but a
  // replan is only owed when canonical actually moved under a plan. Here each
  // task writes one file nobody else claims, so the chain still serialises and
  // nothing needs planning again.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-replan-test-"));
  const build = () => {
    const agents = {
      a: new TestAgent("agent_a", plan("task_a", ["src/a.txt", "src/ab.txt"]),
        fixtureRef.repository, fixtureRef.workspaces, "src/a.txt"),
      b: new TestAgent("agent_b", plan("task_b", ["src/ab.txt", "src/b.txt", "src/bc.txt"]),
        fixtureRef.repository, fixtureRef.workspaces, "src/b.txt"),
      c: new TestAgent("agent_c", plan("task_c", ["src/bc.txt", "src/c.txt"]),
        fixtureRef.repository, fixtureRef.workspaces, "src/c.txt"),
    };
    return [
      { task: task("task_a"), adapter: agents.a },
      { task: task("task_b"), adapter: agents.b },
      { task: task("task_c"), adapter: agents.c },
    ];
  };
  let fixtureRef!: Awaited<ReturnType<typeof createFixture>>;

  try {
    fixtureRef = await createFixture(root);
    const run = await new Coordinator({
      repositories: fixtureRef.repositories,
      workspaces: fixtureRef.workspaces,
    }).run({
      repository: fixtureRef.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: build(),
    });

    // Still fully sequenced, and still all three landed: this changes what a
    // wave costs, not what it orders or what it produces.
    assert.equal(run.tasks.every((entry) => entry.status === "integrated"), true);
    assert.deepEqual(
      run.audit.filter((e) => e.type === "replan_requested").map((e) => e.taskId),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the strict rebase switch restores the unconditional replan", async () => {
  // The rollback, spelled the same as the worker path's. With it on, every
  // queued task plans again after every wave: two after the first promotion,
  // one after the second — the n(n-1)/2 this replaced.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-replan-strict-"));
  const previous = process.env["COORD_STRICT_PLAN_REBASE"];
  process.env["COORD_STRICT_PLAN_REBASE"] = "1";
  try {
    const fixture = await createFixture(root);
    const run = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        { task: task("task_a"), adapter: new TestAgent("agent_a",
          plan("task_a", ["src/a.txt", "src/ab.txt"]),
          fixture.repository, fixture.workspaces, "src/a.txt") },
        { task: task("task_b"), adapter: new TestAgent("agent_b",
          plan("task_b", ["src/ab.txt", "src/b.txt", "src/bc.txt"]),
          fixture.repository, fixture.workspaces, "src/b.txt") },
        { task: task("task_c"), adapter: new TestAgent("agent_c",
          plan("task_c", ["src/bc.txt", "src/c.txt"]),
          fixture.repository, fixture.workspaces, "src/c.txt") },
      ],
    });
    assert.equal(run.tasks.every((entry) => entry.status === "integrated"), true);
    assert.equal(
      run.audit.filter((e) => e.type === "replan_requested").length,
      3,
    );
  } finally {
    if (previous === undefined) {
      delete process.env["COORD_STRICT_PLAN_REBASE"];
    } else {
      process.env["COORD_STRICT_PLAN_REBASE"] = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});

/** What a releasing agent does after its edits are on disk. */
interface ReleaseScript {
  /** Handed back mid-run, once the edits below are written. */
  release: string[];
  /** Written before the release, so a test can edit what it gives back. */
  alsoWrites?: string[];
  /** Called once this agent's release has been decided. */
  announce?: () => void;
  /** Awaited before asking for anything back. */
  awaitBefore?: Promise<void>;
  /** Asked for again afterwards, through the ordinary widening path. */
  reacquire?: string[];
}

/** An agent that gives part of its plan back before the task ends. */
class ReleasingAgent extends TestAgent {
  public readonly decisions: ScopeChangeDecision[] = [];

  public constructor(
    agentId: string,
    agentPlan: AgentPlan,
    repository: CanonicalRepository,
    workspaces: WorkspaceManager,
    outputPath: string,
    private readonly script: ReleaseScript,
  ) {
    super(agentId, agentPlan, repository, workspaces, outputPath);
  }

  public override async sendContext(
    sessionId: string,
    context: CoordinatorContext,
  ): Promise<void> {
    await super.sendContext(sessionId, context);
    for (const extra of this.script.alsoWrites ?? []) {
      await writeFile(
        path.join(context.workspacePath, extra),
        `${this.planFor().taskId} still editing\n`,
        "utf8",
      );
    }
    const released = await new Promise<ScopeChangeDecision>((resolve) => {
      this.sessionFor(sessionId).scopeResolver = resolve;
      this.handlerFor(sessionId)?.({
        event: "scope_release_requested",
        requestId: `release_${this.planFor().taskId}`,
        releasedFiles: [...this.script.release],
        reason: "Finished with these; they turned out not to need changing",
        occurredAt: new Date().toISOString(),
      });
    });
    this.decisions.push(released);
    this.script.announce?.();

    const reacquire = this.script.reacquire;
    if (reacquire === undefined) {
      return;
    }
    await this.script.awaitBefore;
    const answer = await new Promise<ScopeChangeDecision>((resolve) => {
      this.sessionFor(sessionId).scopeResolver = resolve;
      this.handlerFor(sessionId)?.({
        event: "scope_change_requested",
        requestId: `regain_${this.planFor().taskId}`,
        additionalFiles: [...reacquire],
        reason: "One of the released files needs a change after all",
        occurredAt: new Date().toISOString(),
      });
    });
    this.decisions.push(answer);
    if (answer.decision === "rejected" || answer.decision === "deferred") {
      // The honest ending: refused means refused, and writing anyway would be
      // an edit outside the plan — a scope escape that fails the whole task.
      return;
    }
    for (const regained of reacquire) {
      await writeFile(
        path.join(context.workspacePath, regained),
        `${this.planFor().taskId} regained\n`,
        "utf8",
      );
    }
  }
}

/** An agent that waits for somebody else's release and then takes the file. */
class TakingAgent extends TestAgent {
  public readonly decisions: ScopeChangeDecision[] = [];

  public constructor(
    agentId: string,
    agentPlan: AgentPlan,
    repository: CanonicalRepository,
    workspaces: WorkspaceManager,
    outputPath: string,
    private readonly takes: string[],
    private readonly awaitBefore: Promise<void>,
    private readonly announce?: () => void,
  ) {
    super(agentId, agentPlan, repository, workspaces, outputPath);
  }

  public override async sendContext(
    sessionId: string,
    context: CoordinatorContext,
  ): Promise<void> {
    await super.sendContext(sessionId, context);
    await this.awaitBefore;
    const answer = await new Promise<ScopeChangeDecision>((resolve) => {
      this.sessionFor(sessionId).scopeResolver = resolve;
      this.handlerFor(sessionId)?.({
        event: "scope_change_requested",
        requestId: `take_${this.planFor().taskId}`,
        additionalFiles: [...this.takes],
        reason: "Picking up a file another task has finished with",
        occurredAt: new Date().toISOString(),
      });
    });
    this.decisions.push(answer);
    if (answer.decision !== "rejected" && answer.decision !== "deferred") {
      for (const taken of this.takes) {
        await writeFile(
          path.join(context.workspacePath, taken),
          `${this.planFor().taskId} took over\n`,
          "utf8",
        );
      }
    }
    this.announce?.();
  }
}

function signal(): { wait: Promise<void>; fire: () => void } {
  let fire: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    fire = () => {
      resolve();
    };
  });
  return { wait, fire };
}

test("a released file goes to another agent while the task is still running", async () => {
  // The whole point of releasing early: a plan that named two files and needed
  // one held the other until it settled, and everything that wanted it waited
  // that long for work that was already finished.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const handedOver = signal();
    const releasing = new ReleasingAgent(
      "agent_a",
      plan("task_a", ["src/a.txt", "src/b.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      { release: ["src/b.txt"], announce: handedOver.fire },
    );
    const taking = new TakingAgent(
      "agent_b",
      plan("task_b", ["src/c.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/c.txt",
      ["src/b.txt"],
      handedOver.wait,
    );

    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        { task: task("task_a"), adapter: releasing },
        { task: task("task_b"), adapter: taking },
      ],
    });

    assert.equal(releasing.decisions[0]?.decision, "approved");
    // The plan narrows with the leases: two agents believing they hold one
    // file is the failure this has to avoid.
    assert.deepEqual(releasing.decisions[0]?.revisedPlan.expectedFiles, [
      "src/a.txt",
    ]);
    assert.equal(taking.decisions[0]?.decision, "approved");
    assert.equal(result.tasks.every((entry) => entry.status === "integrated"), true);
    assert.deepEqual(result.tasks[0]?.plan.expectedFiles, ["src/a.txt"]);
    assert.equal(
      result.tasks[1]?.plan.expectedFiles.includes("src/b.txt"),
      true,
    );
    assert.equal(
      result.audit.some((event) => event.type === "scope_release_requested"),
      true,
    );
    assert.equal(
      result.audit.some((event) => event.type === "scope_release_decided"),
      true,
    );
    assert.equal(
      result.audit.some(
        (event) =>
          event.type === "ownership_released" &&
          event.taskId === "task_a" &&
          (event.data as { stage?: string }).stage === "scope_release",
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** An agent that hands back exactly what it is told somebody is waiting for. */
class NoticedAgent extends TestAgent {
  public readonly notices: ScopeContentionNotice[] = [];
  public readonly decisions: ScopeChangeDecision[] = [];

  public async noteScopeContention(
    _sessionId: string,
    notice: ScopeContentionNotice,
  ): Promise<void> {
    this.notices.push(structuredClone(notice));
  }

  public override async sendContext(
    sessionId: string,
    context: CoordinatorContext,
  ): Promise<void> {
    await super.sendContext(sessionId, context);
    const wanted = [
      ...new Set(this.notices.flatMap((notice) => notice.files)),
    ].filter((file) => this.planFor().expectedFiles.includes(file));
    if (wanted.length === 0) {
      return;
    }
    const released = await new Promise<ScopeChangeDecision>((resolve) => {
      this.sessionFor(sessionId).scopeResolver = resolve;
      this.handlerFor(sessionId)?.({
        event: "scope_release_requested",
        requestId: `release_${this.planFor().taskId}`,
        releasedFiles: wanted,
        reason: "Told somebody is waiting on these, and they are finished with",
        occurredAt: new Date().toISOString(),
      });
    });
    this.decisions.push(released);
  }
}

test("a holder is told which files another task is waiting on, and hands them back", async () => {
  // The trigger the release path never had. Everything downstream of the
  // request already worked; nothing ever told an agent there was anybody to
  // release to, so no agent ever asked.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const holder = new NoticedAgent(
      "agent_a",
      plan("task_a", ["src/a.txt", "src/b.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
    );

    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      planAuthority: {
        async admit(request) {
          return { outcome: "admitted", plan: request.plan };
        },
        async listWaitingOn(request) {
          return request.plan.expectedFiles.includes("src/b.txt")
            ? [
                {
                  taskId: "task_waiting",
                  files: ["src/b.txt"],
                  symbols: [],
                  apis: [],
                  schemas: [],
                  configKeys: [],
                  tests: [],
                  services: [],
                  explanation: "src/b.txt is held by task_a",
                },
              ]
            : [];
        },
      },
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: holder }],
    });

    assert.equal(holder.notices[0]?.taskId, "task_waiting");
    assert.deepEqual(holder.notices[0]?.files, ["src/b.txt"]);
    assert.match(holder.notices[0]?.reason ?? "", /task_waiting/u);
    // Announced once per waiting task and resource, however many times the
    // queue is read while the agent works.
    assert.equal(
      holder.notices.filter((notice) => notice.files.includes("src/b.txt"))
        .length,
      1,
    );
    assert.equal(holder.decisions[0]?.decision, "approved");
    assert.deepEqual(holder.decisions[0]?.revisedPlan.expectedFiles, [
      "src/a.txt",
    ]);
    assert.equal(
      result.audit.some(
        (event) =>
          event.type === "scope_contention_noticed" &&
          event.taskId === "task_a" &&
          (event.data as { waitingTaskId?: string }).waitingTaskId ===
            "task_waiting",
      ),
      true,
    );
    assert.equal(result.tasks[0]?.status, "integrated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a holder nobody is waiting on is told nothing", async () => {
  // The notice has to be worth reading. An agent told on every poll that
  // nothing is happening would learn to skip the paragraph that matters.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const holder = new NoticedAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
    );

    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      planAuthority: {
        async admit(request) {
          return { outcome: "admitted", plan: request.plan };
        },
        async listWaitingOn() {
          return [];
        },
      },
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: holder }],
    });

    assert.deepEqual(holder.notices, []);
    assert.equal(
      result.audit.some((event) => event.type === "scope_contention_noticed"),
      false,
    );
    assert.equal(result.tasks[0]?.status, "integrated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a task sequenced behind another in the same run is named to the holder", async () => {
  // A queue forms inside one run as well as across them: the second task is
  // held back by conflict detection, and its decision already says whose work
  // it is waiting for.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const first = new NoticedAgent(
      "agent_a",
      plan("task_a", ["src/a.txt", "src/ab.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
    );
    const second = new NoticedAgent(
      "agent_b",
      plan("task_b", ["src/ab.txt", "src/b.txt"]),
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
        { task: task("task_a"), adapter: first },
        { task: task("task_b"), adapter: second },
      ],
    });

    // Whichever of the two went first was the holder, and it was told which
    // file the other one is queued behind.
    const told = [...first.notices, ...second.notices];
    assert.equal(told.length > 0, true);
    assert.equal(
      told.every((notice) => notice.files.includes("src/ab.txt")),
      true,
    );
    assert.equal(result.tasks.every((entry) => entry.status === "integrated"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a released file can be asked for again, and is granted if nobody took it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ReleasingAgent(
      "agent_a",
      plan("task_a", ["src/a.txt", "src/b.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      { release: ["src/b.txt"], reacquire: ["src/b.txt"] },
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

    assert.equal(agent.decisions[0]?.decision, "approved");
    // Re-acquisition is the widening path, unchanged — no second mechanism.
    assert.equal(agent.decisions[1]?.decision, "approved");
    assert.equal(result.tasks[0]?.status, "integrated");
    assert.equal(
      result.tasks[0]?.plan.expectedFiles.includes("src/b.txt"),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a released file taken by somebody else is refused, and the task still ends cleanly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const handedOver = signal();
    const takenOver = signal();
    const releasing = new ReleasingAgent(
      "agent_a",
      plan("task_a", ["src/a.txt", "src/b.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      {
        release: ["src/b.txt"],
        announce: handedOver.fire,
        awaitBefore: takenOver.wait,
        reacquire: ["src/b.txt"],
      },
    );
    const taking = new TakingAgent(
      "agent_b",
      plan("task_b", ["src/c.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/c.txt",
      ["src/b.txt"],
      handedOver.wait,
      takenOver.fire,
    );

    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        { task: task("task_a"), adapter: releasing },
        { task: task("task_b"), adapter: taking },
      ],
    });

    assert.equal(releasing.decisions[0]?.decision, "approved");
    // Refused rather than queued: a running agent holding leases must never
    // be parked waiting for one.
    assert.equal(releasing.decisions[1]?.decision, "rejected");
    assert.equal(releasing.decisions[1]?.retryAfterMs, undefined);
    // Refused means the agent reports rather than writes: an edit outside the
    // plan would fail the whole task as a scope escape.
    assert.equal(result.tasks.every((entry) => entry.status === "integrated"), true);
    assert.equal(
      result.tasks[0]?.plan.expectedFiles.includes("src/b.txt"),
      false,
    );
    const b = await fixture.repositories.readFile(
      fixture.repository,
      (
        await fixture.repositories.getCanonicalVersion(fixture.repository)
      ).revision,
      "src/b.txt",
    );
    assert.match(b, /task_b took over/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file the agent still has edits in is not released", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ReleasingAgent(
      "agent_a",
      plan("task_a", ["src/a.txt", "src/b.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      { release: ["src/b.txt"], alsoWrites: ["src/b.txt"] },
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

    assert.equal(agent.decisions[0]?.decision, "rejected");
    assert.match(agent.decisions[0]?.explanation ?? "", /uncommitted edits/iu);
    // Nothing was given away, so the edit still lands.
    assert.equal(result.tasks[0]?.status, "integrated");
    assert.equal(
      result.tasks[0]?.plan.expectedFiles.includes("src/b.txt"),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nothing is released for a resource the plan never claimed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ReleasingAgent(
      "agent_a",
      plan("task_a", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      { release: ["src/d.txt"] },
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

    assert.equal(agent.decisions[0]?.decision, "rejected");
    assert.equal(result.tasks[0]?.status, "integrated");
    assert.deepEqual(result.tasks[0]?.plan.expectedFiles, ["src/a.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "two agents releasing and then asking for each other's file both get answers",
  { timeout: 120_000 },
  async () => {
    // The deadlock shape early release re-introduces: incremental acquisition,
    // two holders, each wanting what the other has. It is safe only because no
    // decision here ever waits on a lease — a widening is answered on the spot,
    // granted or refused, and neither agent is parked while holding its own.
    // If either side queued, this run would never finish.
    const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

    try {
      const fixture = await createFixture(root);
      const aReleased = signal();
      const bReleased = signal();
      const first = new ReleasingAgent(
        "agent_a",
        plan("task_a", ["src/a.txt", "src/ab.txt"]),
        fixture.repository,
        fixture.workspaces,
        "src/a.txt",
        {
          release: ["src/ab.txt"],
          announce: aReleased.fire,
          awaitBefore: bReleased.wait,
          reacquire: ["src/bc.txt"],
        },
      );
      const second = new ReleasingAgent(
        "agent_b",
        plan("task_b", ["src/b.txt", "src/bc.txt"]),
        fixture.repository,
        fixture.workspaces,
        "src/b.txt",
        {
          release: ["src/bc.txt"],
          announce: bReleased.fire,
          awaitBefore: aReleased.wait,
          reacquire: ["src/ab.txt"],
        },
      );

      const result = await new Coordinator({
        repositories: fixture.repositories,
        workspaces: fixture.workspaces,
      }).run({
        repository: fixture.repository,
        workspaceRoot: path.join(root, "workspaces"),
        integrationRoot: path.join(root, "integration"),
        tasks: [
          { task: task("task_a"), adapter: first },
          { task: task("task_b"), adapter: second },
        ],
      });

      for (const agent of [first, second]) {
        assert.equal(agent.decisions[0]?.decision, "approved");
        // Answered, not queued — and never with "come back later", which is
        // what waiting while holding would look like from here.
        assert.equal(agent.decisions[1] !== undefined, true);
        assert.notEqual(agent.decisions[1]?.decision, "deferred");
        assert.equal(agent.decisions[1]?.retryAfterMs, undefined);
      }
      assert.equal(result.tasks.every((entry) => entry.status === "integrated"), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("the narrowed plan is recorded with the authority before anything is released", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ReleasingAgent(
      "agent_a",
      plan("task_a", ["src/a.txt", "src/b.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      { release: ["src/b.txt"] },
    );
    const admitted: Array<{ files: string[]; revising: boolean | undefined }> = [];
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      planAuthority: {
        async admit(request) {
          admitted.push({
            files: [...request.plan.expectedFiles],
            revising: request.revising,
          });
          return { outcome: "admitted", plan: request.plan };
        },
      },
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    assert.equal(agent.decisions[0]?.decision, "approved");
    // Without this the control plane keeps showing the wide plan, and tasks
    // in other runs go on being refused a file nobody is using.
    assert.deepEqual(admitted.at(-1), {
      files: ["src/a.txt"],
      revising: true,
    });
    assert.equal(result.tasks[0]?.status, "integrated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a narrowing the authority will not record releases nothing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-run-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ReleasingAgent(
      "agent_a",
      plan("task_a", ["src/a.txt", "src/b.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
      { release: ["src/b.txt"] },
    );
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      planAuthority: {
        async admit(request) {
          return request.revising === true
            ? {
                outcome: "deferred",
                retryAfterMs: 1_000,
                blockedBy: [],
                explanation: "the record is unavailable",
              }
            : { outcome: "admitted", plan: request.plan };
        },
      },
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    // Told its files were freed while the record still claims them is worse
    // than told to keep them, so nothing moves.
    assert.equal(agent.decisions[0]?.decision, "rejected");
    assert.match(agent.decisions[0]?.explanation ?? "", /record/u);
    assert.equal(
      agent.decisions[0]?.revisedPlan.expectedFiles.includes("src/b.txt"),
      true,
    );
    assert.equal(result.tasks[0]?.status, "integrated");
    assert.equal(
      result.tasks[0]?.plan.expectedFiles.includes("src/b.txt"),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a deferred waiter plans against the holder's in-progress edits", async () => {
  // While admit keeps saying "come back later", the wait used to sleep and
  // produce nothing. Now it plans against the holder's WIP so that when the
  // holder lands, assessReplay can treat the advance as already accounted for.
  // Speculation must not acquire leases — admit is never asked to revise.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-speculate-"));

  try {
    const fixture = await createFixture(root);
    const store = new InMemoryCoordinationStore();
    const version = await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    );
    const holderWorkspace = await fixture.workspaces.create({
      taskId: "task_holder",
      rootPath: path.join(root, "holder-workspaces"),
      repository: fixture.repository,
      baseVersion: version,
    });
    await writeFile(
      path.join(holderWorkspace.path, "src", "a.txt"),
      "holder wip\n",
      "utf8",
    );
    const holderRun = await store.createRun({
      repository: fixture.repository,
      mode: "coordinated",
      baseVersion: version,
    });
    await store.saveWorkspace(holderRun.id, {
      id: holderWorkspace.id,
      runId: holderRun.id,
      taskId: "task_holder",
      path: holderWorkspace.path,
      isolation: holderWorkspace.isolation,
      baseRevision: version.revision,
      createdAt: holderWorkspace.createdAt,
    });

    const agent = new TestAgent(
      "agent_waiter",
      plan("task_waiter", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      "src/a.txt",
    );
    let admits = 0;
    let revisingAdmits = 0;
    const result = await new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      store,
      planAuthority: {
        async admit(request) {
          if (request.revising === true) {
            revisingAdmits += 1;
          }
          admits += 1;
          if (admits <= 2) {
            return {
              outcome: "deferred",
              retryAfterMs: 5,
              blockedBy: ["task_holder"],
              explanation: "src/a.txt is leased to task_holder",
            };
          }
          return { outcome: "admitted", plan: request.plan };
        },
      },
    }).run({
      repository: fixture.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_waiter"), adapter: agent }],
    });

    assert.equal(result.tasks[0]?.status, "integrated");
    assert.equal(revisingAdmits, 0);
    const speculative = agent.replanRequests.filter(
      (request) =>
        request.canonicalChange.reason.includes("in progress") &&
        (request.holderWorkingChanges ?? []).some(
          (change) => change.path === "src/a.txt",
        ),
    );
    assert.ok(
      speculative.length >= 1,
      "expected at least one speculative replan against holder WIP",
    );
    assert.equal(
      result.audit.some(
        (event) =>
          event.type === "replan_requested" &&
          event.data["speculative"] === true,
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Writes fixed replacement text over a seeded file, so a test can control
 * exactly which lines a run's patch touches.
 *
 * `TestAgent` writes one short string over the whole file, which produces a
 * single hunk. Hunk-level division only means anything when a patch has
 * several, some reaching a withheld symbol and some clear of it.
 */
class RewritingAgent extends TestAgent {
  public constructor(
    agentId: string,
    plan: AgentPlan,
    repository: CanonicalRepository,
    workspaces: WorkspaceManager,
    private readonly file: string,
    private readonly contents: string,
  ) {
    super(agentId, plan, repository, workspaces, "");
  }

  public override async sendContext(
    sessionId: string,
    context: CoordinatorContext,
  ): Promise<void> {
    await super.sendContext(sessionId, context);
    await writeFile(
      path.join(context.workspacePath, this.file),
      this.contents,
      "utf8",
    );
  }
}

/** Three functions, spaced so an edit in each lands in its own diff hunk. */
function symbolModule(alpha: string, withheld: string, omega: string): string {
  const gap = "\n".repeat(9);
  return (
    `export function alpha(): number {\n  return ${alpha};\n}\n${gap}` +
    `export function withheld(): number {\n  return ${withheld};\n}\n${gap}` +
    `export function omega(): number {\n  return ${omega};\n}\n`
  );
}

test("a withheld symbol costs its hunks, not the whole file", async () => {
  // The division itself is covered in partial-admission.test.ts, against a
  // supplied symbol index. This is about the wiring: `splitChangeSet` is
  // pessimistic when nothing can locate the withheld symbol — it treats every
  // hunk as touching it — so a caller that omits the index does not fall back
  // to file-level behaviour, it falls back to the *worst* case and hands the
  // whole file back. The remote-worker path passed an index from the start
  // and this one did not, so hunk-level admission worked or did not purely by
  // which executor picked the task up, and this deployment only runs this one.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-symbol-test-"));

  try {
    const sourcePath = path.join(root, "source");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(sourcePath);
    await mkdir(path.join(sourcePath, "src"), { recursive: true });
    await writeFile(
      path.join(sourcePath, "src", "mod.ts"),
      symbolModule("1", "2", "3"),
      "utf8",
    );
    await repositories.commitAll(sourcePath, "seed");
    const repository = await repositories.importLocalRepository(
      sourcePath,
      path.join(root, "canonical.git"),
      "fixture",
    );
    const workspaces = new GitWorktreeWorkspaceManager(
      repositories.getGitClient(),
    );

    // All three functions edited; only `withheld` belongs to somebody else.
    const agent = new RewritingAgent(
      "agent_a",
      plan("task_a", ["src/mod.ts"]),
      repository,
      workspaces,
      "src/mod.ts",
      symbolModule("11", "22", "33"),
    );

    const result = await new Coordinator({
      repositories,
      workspaces,
      planAuthority: {
        async admit(request) {
          return {
            outcome: "admitted",
            plan: request.plan,
            admission: {
              status: "approved_with_constraints",
              taskId: request.task.id,
              planRevision: 1,
              baseRevision: "b".repeat(40),
              ownershipGrants: [],
              constraints: [],
              blockedBy: [],
              conflicts: [],
              deferredResources: [
                {
                  resourceType: "symbol",
                  resourceId: "withheld",
                  heldBy: ["task_elsewhere"],
                  reason: "held by task_elsewhere",
                },
              ],
              explanation: "withheld() is leased to task_elsewhere",
              decidedAt: new Date().toISOString(),
            },
          };
        },
      },
    }).run({
      repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [{ task: task("task_a"), adapter: agent }],
    });

    assert.equal(result.tasks[0]?.status, "integrated");

    // The two clear edits landed and the trespassing one did not. Reading
    // canonical rather than the split: what matters is which bytes are in the
    // repository, not what the bookkeeping said about them.
    const head = await repositories.readFile(
      repository,
      result.canonicalVersion.revision,
      "src/mod.ts",
    );
    assert.match(head, /return 11;/u, "the hunk before the withheld symbol");
    assert.match(head, /return 33;/u, "the hunk after the withheld symbol");
    assert.match(head, /return 2;/u, "the withheld symbol is untouched");
    assert.doesNotMatch(head, /return 22;/u, "the withheld edit did not land");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
