import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  type TaskDefinition,
} from "@coord/shared-types";
import {
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  GitWorktreeWorkspaceManager,
  type TaskWorkspace,
} from "@coord/workspace-manager";

import { ConversationRegistry, Coordinator } from "./coordinator.js";

/**
 * The conversational-task lifecycle, observed from outside: a task whose
 * turns share a `conversationId` keeps its workspace directory and its agent
 * session across a landed turn, a failed turn tears both down, and the next
 * turn starts from whatever canonical holds by then. See
 * docs/architecture/conversational-tasks.md, stages one and two.
 */

interface SessionState {
  input: StartTaskInput;
  context?: CoordinatorContext;
  eventHandler?: (event: AgentEvent) => void;
}

/**
 * An agent driven turn by turn: the test sets what it plans and writes
 * before each run, and reads back what the agent could see when its edit
 * phase began — which is how "the second turn starts from the rebased
 * state" becomes an assertion rather than an assumption.
 */
class ConversationAgent implements AgentAdapter {
  private readonly sessions = new Map<string, SessionState>();
  /** What this agent plans for the current turn; set by the test per run. */
  public turnPlan: AgentPlan;
  /** What it writes during the current turn; nothing when undefined. */
  public turnOutput: { path: string; content: string } | undefined = undefined;
  /** Workspace-relative files to read at the start of each edit phase. */
  public probePaths: string[] = [];
  /** One record per edit phase: probed path → content, or "<absent>". */
  public readonly observed: Array<Record<string, string>> = [];
  public readonly startInputs: StartTaskInput[] = [];
  public readonly startedSessions: AgentSession[] = [];
  public readonly continueInputs: Array<{
    session: AgentSession;
    input: StartTaskInput;
  }> = [];
  /** What resumeToken answers for any of this agent's sessions. */
  public resumeTokenValue: string | undefined = undefined;
  public readonly replanRequests: ReplanRequest[] = [];
  /** Workspace path seen by each edit phase, in order. */
  public readonly workspacePaths: string[] = [];
  public cancelCount = 0;

  /**
   * Continues the session under the next turn's task. Declared as an
   * optional property rather than a method so one class can model both an
   * adapter that supports continuation and one that does not.
   */
  public readonly continueTask?: (
    session: AgentSession,
    input: StartTaskInput,
  ) => Promise<AgentSession>;

  public constructor(
    private readonly agentId: string,
    firstPlan: AgentPlan,
    private readonly repository: CanonicalRepository,
    private readonly workspaces: GitWorktreeWorkspaceManager,
    supportsContinuation = true,
  ) {
    this.turnPlan = firstPlan;
    if (supportsContinuation) {
      this.continueTask = async (session, input) => {
        this.continueInputs.push({ session: structuredClone(session), input });
        // Adopting is creating: a fresh instance has never seen this id, and
        // the record it builds from the handed-over session IS the adoption.
        // The next turn starts fresh everywhere but the identity: new input,
        // new context, a new streamEvents registration to come.
        this.sessions.set(session.id, { input });
        return {
          id: session.id,
          agentId: this.agentId,
          taskId: input.task.id,
          startedAt: session.startedAt,
          ...(session.resume === undefined ? {} : { resume: session.resume }),
        };
      };
    }
  }

  public resumeToken(sessionId: string): string | undefined {
    this.requireSession(sessionId);
    return this.resumeTokenValue;
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
    this.startInputs.push(input);
    this.startedSessions.push(session);
    this.sessions.set(session.id, { input });
    return session;
  }

  public async requestPlan(sessionId: string): Promise<AgentPlan> {
    this.requireSession(sessionId);
    return structuredClone(this.turnPlan);
  }

  public async requestReplan(
    sessionId: string,
    request: ReplanRequest,
  ): Promise<AgentPlan> {
    this.requireSession(sessionId);
    this.replanRequests.push(structuredClone(request));
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
    throw new Error("Conversation agents cannot pause");
  }

  public async resume(): Promise<void> {
    throw new Error("Conversation agents cannot resume");
  }

  public async resolveScopeChange(
    _sessionId: string,
    _decision: ScopeChangeDecision,
  ): Promise<void> {}

  public async cancel(sessionId: string): Promise<void> {
    this.requireSession(sessionId);
    this.cancelCount += 1;
  }

  public async collectChanges(sessionId: string): Promise<ChangeSet> {
    const session = this.requireSession(sessionId);
    if (session.context === undefined) {
      throw new Error("Conversation agent has no coordinator context");
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
      riskAssessment: { level: this.turnPlan.riskLevel, reasons: [] },
      agentExplanation: "Conversation lifecycle test",
    });
  }

  public async streamEvents(
    sessionId: string,
    handler: (event: AgentEvent) => void,
  ): Promise<void> {
    this.requireSession(sessionId).eventHandler = handler;
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return session;
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
  options: { dependencies?: string[] } = {},
): AgentPlan {
  return {
    taskId,
    objective: taskId,
    expectedFiles,
    expectedSymbols: [],
    dependencies: options.dependencies ?? [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
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
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "bc.txt"]) {
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

interface Conversation {
  coordinator: Coordinator;
  agent: ConversationAgent;
  runTurn: (
    definition: TaskDefinition,
  ) => ReturnType<Coordinator["run"]>;
}

function openConversation(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  root: string,
  agent: ConversationAgent,
  conversationId = "conversation",
  options: { coordinator?: Coordinator } = {},
): Conversation {
  const coordinator =
    options.coordinator ??
    new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
    });
  return {
    coordinator,
    agent,
    runTurn: async (definition) =>
      await coordinator.run({
        repository: fixture.repository,
        workspaceRoot: path.join(root, "workspaces"),
        integrationRoot: path.join(root, "integration"),
        tasks: [{ task: definition, adapter: agent, conversationId }],
      }),
  };
}

test("a conversation keeps its workspace directory and session across turns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-conv-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ConversationAgent(
      "agent_conv",
      plan("turn_1", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    const conversation = openConversation(fixture, root, agent);

    agent.turnOutput = { path: "src/a.txt", content: "turn one\n" };
    const first = await conversation.runTurn(task("turn_1"));
    assert.equal(first.tasks[0]?.status, "integrated");
    // The turn landed and the conversation stays open — so the session was
    // not closed, but the turn's leases were released all the same: survival
    // buys no standing claim on the files it touched.
    assert.equal(agent.cancelCount, 0);
    assert.ok(
      first.audit.some(
        (event) =>
          event.type === "ownership_released" && event.taskId === "turn_1",
      ),
    );

    // Untracked build output stands in for everything the directory keeps
    // between turns; `dist` is one of the ephemeral names a changeset never
    // collects, which is exactly why scratch belongs there.
    const workspacePath = agent.workspacePaths[0];
    assert.ok(workspacePath !== undefined);
    await mkdir(path.join(workspacePath, "dist"), { recursive: true });
    await writeFile(
      path.join(workspacePath, "dist", "scratch.txt"),
      "kept between turns\n",
      "utf8",
    );

    agent.turnPlan = plan("turn_2", ["src/b.txt"]);
    agent.turnOutput = { path: "src/b.txt", content: "turn two\n" };
    agent.probePaths = ["dist/scratch.txt", "src/a.txt"];
    const second = await conversation.runTurn(task("turn_2"));
    assert.equal(second.tasks[0]?.status, "integrated");

    // Same directory, same session: the two halves of what a conversation
    // keeps. The path proves the directory — a rebuilt workspace would live
    // under a fresh name — and the scratch file proves it arrived with its
    // contents rather than merely its name.
    assert.equal(agent.workspacePaths[1], workspacePath);
    assert.equal(agent.observed[1]?.["dist/scratch.txt"], "kept between turns\n");
    // The checkout caught up to what the first turn landed before the second
    // began: nothing accumulates uncommitted between turns.
    assert.equal(agent.observed[1]?.["src/a.txt"], "turn one\n");
    assert.equal(agent.startInputs.length, 1);
    assert.equal(agent.continueInputs.length, 1);
    assert.equal(
      agent.continueInputs[0]?.session.id,
      agent.startedSessions[0]?.id,
    );
    assert.equal(agent.cancelCount, 0);
    assert.equal(second.canonicalVersion.sequence, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed turn tears down the workspace and the session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-conv-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ConversationAgent(
      "agent_conv",
      plan("turn_1", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    const conversation = openConversation(fixture, root, agent);

    agent.turnOutput = { path: "src/a.txt", content: "turn one\n" };
    const first = await conversation.runTurn(task("turn_1"));
    assert.equal(first.tasks[0]?.status, "integrated");
    const workspacePath = agent.workspacePaths[0];
    assert.ok(workspacePath !== undefined);

    // The second turn does its work and then fails validation — a settled
    // failure, not a crash. Survival is only for success: the conversation
    // ends, the session closes, the directory goes.
    agent.turnPlan = plan("turn_2", ["src/b.txt"]);
    agent.turnOutput = { path: "src/b.txt", content: "turn two\n" };
    const second = await conversation.runTurn({
      ...task("turn_2"),
      validationCommands: [
        {
          executable: process.execPath,
          args: ["-e", "process.exit(1)"],
          label: "always fails",
        },
      ],
    });
    assert.equal(second.tasks[0]?.status, "failed");
    assert.equal(agent.cancelCount, 1);
    await assert.rejects(lstat(workspacePath), { code: "ENOENT" });

    // A third turn finds nothing to resume and starts cold, from a fresh
    // directory — the conversation did not quietly survive its failure.
    agent.turnPlan = plan("turn_3", ["src/c.txt"]);
    agent.turnOutput = { path: "src/c.txt", content: "turn three\n" };
    const third = await conversation.runTurn(task("turn_3"));
    assert.equal(third.tasks[0]?.status, "integrated");
    assert.equal(agent.startInputs.length, 2);
    assert.equal(agent.continueInputs.length, 1);
    assert.notEqual(agent.workspacePaths[2], workspacePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Lands one change from a second agent through the same coordinator, the way
 * an unrelated task would between two turns of a conversation.
 */
async function landInterloper(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  root: string,
  conversation: Conversation,
  file: string,
  content: string,
): Promise<{ revision: string }> {
  const interloper = new ConversationAgent(
    "agent_other",
    plan("interloper", [file]),
    fixture.repository,
    fixture.workspaces,
  );
  interloper.turnOutput = { path: file, content };
  const landed = await conversation.coordinator.run({
    repository: fixture.repository,
    workspaceRoot: path.join(root, "workspaces"),
    integrationRoot: path.join(root, "integration"),
    tasks: [{ task: task("interloper"), adapter: interloper }],
  });
  assert.equal(landed.tasks[0]?.status, "integrated");
  return { revision: landed.canonicalVersion.revision };
}

test("a disjoint advance between turns is caught up silently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-conv-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ConversationAgent(
      "agent_conv",
      plan("turn_1", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    const conversation = openConversation(fixture, root, agent);

    agent.turnOutput = { path: "src/a.txt", content: "turn one\n" };
    const first = await conversation.runTurn(task("turn_1"));
    assert.equal(first.tasks[0]?.status, "integrated");

    await landInterloper(fixture, root, conversation, "src/d.txt", "other\n");

    agent.turnPlan = plan("turn_2", ["src/b.txt"]);
    agent.turnOutput = { path: "src/b.txt", content: "turn two\n" };
    agent.probePaths = ["src/d.txt"];
    const second = await conversation.runTurn(task("turn_2"));
    assert.equal(second.tasks[0]?.status, "integrated");

    // The advance touched nothing this conversation wrote, claimed or
    // depends on, so the turn opens without a word about it — but from the
    // rebased state: the interloper's landing is on disk before the edit
    // phase begins.
    assert.equal(agent.observed[1]?.["src/d.txt"], "other\n");
    assert.equal(agent.replanRequests.length, 0);
    assert.equal(agent.continueInputs[0]?.input.priorContext, undefined);
    assert.equal(agent.workspacePaths[1], agent.workspacePaths[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean overlap between turns is caught up and named to the agent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-conv-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ConversationAgent(
      "agent_conv",
      plan("turn_1", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    const conversation = openConversation(fixture, root, agent);

    agent.turnOutput = { path: "src/a.txt", content: "turn one\n" };
    const first = await conversation.runTurn(task("turn_1"));
    assert.equal(first.tasks[0]?.status, "integrated");

    // The interloper lands in a file this conversation wrote — but not one
    // it declared a dependency on, so the overlap is textual: both merged
    // cleanly at landing time, and only the telling remains.
    await landInterloper(
      fixture,
      root,
      conversation,
      "src/a.txt",
      "other landed\n",
    );

    agent.turnPlan = plan("turn_2", ["src/b.txt"]);
    agent.turnOutput = { path: "src/b.txt", content: "turn two\n" };
    agent.probePaths = ["src/a.txt"];
    const second = await conversation.runTurn(task("turn_2"));
    assert.equal(second.tasks[0]?.status, "integrated");

    // No replan — the conversation's knowledge still stands — but the turn
    // opens told which of its files moved, and the workspace already holds
    // the other change.
    assert.equal(agent.replanRequests.length, 0);
    assert.match(
      agent.continueInputs[0]?.input.priorContext ?? "",
      /src\/a\.txt/u,
    );
    assert.equal(agent.observed[1]?.["src/a.txt"], "other landed\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a conflicting advance between turns opens the turn as a replan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-conv-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ConversationAgent(
      "agent_conv",
      // The first turn declares it depends on src/bc.txt: the conversation
      // read that file and reasoned from it.
      plan("turn_1", ["src/a.txt"], { dependencies: ["file:src/bc.txt"] }),
      fixture.repository,
      fixture.workspaces,
    );
    const conversation = openConversation(fixture, root, agent);

    agent.turnOutput = { path: "src/a.txt", content: "turn one\n" };
    const first = await conversation.runTurn(task("turn_1"));
    assert.equal(first.tasks[0]?.status, "integrated");
    const syncedRevision = first.canonicalVersion.revision;

    const interloped = await landInterloper(
      fixture,
      root,
      conversation,
      "src/bc.txt",
      "dependency moved\n",
    );

    agent.turnPlan = plan("turn_2", ["src/b.txt"]);
    agent.turnOutput = { path: "src/b.txt", content: "turn two\n" };
    agent.probePaths = ["src/bc.txt"];
    const second = await conversation.runTurn(task("turn_2"));
    assert.equal(second.tasks[0]?.status, "integrated");

    // The advance invalidated what the conversation knows, so the turn
    // opened with the same conversation a replan has: the previous plan and
    // a notice of exactly what moved, spanning last turn's landing to the
    // interloper's.
    assert.equal(agent.replanRequests.length, 1);
    const request = agent.replanRequests[0];
    assert.equal(request?.taskId, "turn_2");
    assert.equal(request?.previousPlan.taskId, "turn_1");
    assert.ok(request?.canonicalChange);
    assert.ok(request.canonicalChange.changedFiles.includes("src/bc.txt"));
    assert.equal(
      request.canonicalChange.previousVersion.revision,
      syncedRevision,
    );
    assert.equal(
      request?.canonicalChange.canonicalVersion.revision,
      interloped.revision,
    );
    // And still from the rebased state, exactly like the other outcomes.
    assert.equal(agent.observed[1]?.["src/bc.txt"], "dependency moved\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a resume token carries the session to a fresh adapter instance", async () => {
  // The production shape of continuation: each run constructs its own
  // adapters, so the instance asked to continue is never the instance that
  // opened the session. With a resume token the state lives vendor-side and
  // the fresh instance adopts it — warm; the same shape without a token is
  // covered by the cold-continuation tests around this one.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-conv-test-"));

  try {
    const fixture = await createFixture(root);
    const registry = new ConversationRegistry();
    const first = new ConversationAgent(
      "agent_conv",
      plan("turn_1", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    first.resumeTokenValue = "vendor-thread-7";
    first.turnOutput = { path: "src/a.txt", content: "turn one\n" };
    // The turns share their agent — task ids differ, the agent does not.
    // The resume ladder reads the task's agentId to tell "same agent, new
    // instance" from "someone else's conversation".
    const turnOne = await openConversation(fixture, root, first, "conversation", {
      coordinator: new Coordinator({
        repositories: fixture.repositories,
        workspaces: fixture.workspaces,
        conversations: registry,
      }),
    }).runTurn({ ...task("turn_1"), agentId: "agent_conv" });
    assert.equal(turnOne.tasks[0]?.status, "integrated");

    const second = new ConversationAgent(
      "agent_conv",
      plan("turn_2", ["src/b.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    second.turnOutput = { path: "src/b.txt", content: "turn two\n" };
    const turnTwo = await openConversation(fixture, root, second, "conversation", {
      coordinator: new Coordinator({
        repositories: fixture.repositories,
        workspaces: fixture.workspaces,
        conversations: registry,
      }),
    }).runTurn({ ...task("turn_2"), agentId: "agent_conv" });
    assert.equal(turnTwo.tasks[0]?.status, "integrated");

    // Adopted, not restarted: the new instance was continued with the token
    // the old one reported, opened no session of its own, and nothing was
    // cancelled — a token is not a process, so there was nothing to close.
    assert.equal(second.startInputs.length, 0);
    assert.equal(second.continueInputs.length, 1);
    assert.equal(
      second.continueInputs[0]?.session.resume,
      "vendor-thread-7",
    );
    assert.equal(first.cancelCount, 0);
    assert.equal(second.workspacePaths[0], first.workspacePaths[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an idle session closes; the conversation continues cold in its directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-conv-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ConversationAgent(
      "agent_conv",
      plan("turn_1", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    const coordinator = new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      // Idle from the moment it lands: the sweep's clock is wall time and a
      // test cannot wait out a real deadline.
      conversationSessionIdleMs: 0,
    });
    const conversation = openConversation(fixture, root, agent, "conversation", {
      coordinator,
    });

    agent.turnOutput = { path: "src/a.txt", content: "turn one\n" };
    const first = await conversation.runTurn(task("turn_1"));
    assert.equal(first.tasks[0]?.status, "integrated");
    assert.equal(agent.cancelCount, 0);

    // The sweep sheds the process and only the process.
    await coordinator.closeIdleConversationSessions();
    assert.equal(agent.cancelCount, 1);

    agent.turnPlan = plan("turn_2", ["src/b.txt"]);
    agent.turnOutput = { path: "src/b.txt", content: "turn two\n" };
    const second = await conversation.runTurn(task("turn_2"));
    assert.equal(second.tasks[0]?.status, "integrated");
    // Cold session, warm directory: startTask ran again, continueTask never
    // did, and the turn still worked where the last one left off.
    assert.equal(agent.startInputs.length, 2);
    assert.equal(agent.continueInputs.length, 0);
    assert.equal(agent.workspacePaths[1], agent.workspacePaths[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the deployment's idle deadline is read from the environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-conv-test-"));
  const previous = process.env["COORD_CONVERSATION_SESSION_IDLE_MS"];

  try {
    // Idle from the moment it lands, said the way an operator says it: the
    // deployment builds its registry with no arguments at all, so a bound
    // only a caller could pass would be a bound nobody could set.
    process.env["COORD_CONVERSATION_SESSION_IDLE_MS"] = "0";
    const fixture = await createFixture(root);
    const agent = new ConversationAgent(
      "agent_conv",
      plan("turn_1", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    const coordinator = new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
    });
    const conversation = openConversation(fixture, root, agent, "conversation", {
      coordinator,
    });

    agent.turnOutput = { path: "src/a.txt", content: "turn one\n" };
    const first = await conversation.runTurn(task("turn_1"));
    assert.equal(first.tasks[0]?.status, "integrated");
    assert.equal(agent.cancelCount, 0);

    await coordinator.closeIdleConversationSessions();
    assert.equal(agent.cancelCount, 1);
  } finally {
    if (previous === undefined) {
      delete process.env["COORD_CONVERSATION_SESSION_IDLE_MS"];
    } else {
      process.env["COORD_CONVERSATION_SESSION_IDLE_MS"] = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("the deployment's session cap is read from the environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-conv-test-"));
  const previous = process.env["COORD_MAX_CONVERSATION_SESSIONS"];

  try {
    process.env["COORD_MAX_CONVERSATION_SESSIONS"] = "1";
    const fixture = await createFixture(root);
    const coordinator = new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
    });
    const first = new ConversationAgent(
      "agent_first",
      plan("first_1", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    const second = new ConversationAgent(
      "agent_second",
      plan("second_1", ["src/b.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    const conversationA = openConversation(fixture, root, first, "conv_a", {
      coordinator,
    });
    const conversationB = openConversation(fixture, root, second, "conv_b", {
      coordinator,
    });

    first.turnOutput = { path: "src/a.txt", content: "first one\n" };
    assert.equal(
      (await conversationA.runTurn(task("first_1"))).tasks[0]?.status,
      "integrated",
    );
    second.turnOutput = { path: "src/b.txt", content: "second one\n" };
    assert.equal(
      (await conversationB.runTurn(task("second_1"))).tasks[0]?.status,
      "integrated",
    );

    // The configured cap of one, honoured: the older session is the one that
    // pays, and it pays with its process rather than its place.
    assert.equal(first.cancelCount, 1);
    assert.equal(second.cancelCount, 0);
  } finally {
    if (previous === undefined) {
      delete process.env["COORD_MAX_CONVERSATION_SESSIONS"];
    } else {
      process.env["COORD_MAX_CONVERSATION_SESSIONS"] = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("a conversation bound that is not a number is refused, not ignored", () => {
  const previous = process.env["COORD_MAX_CONVERSATION_SESSIONS"];

  try {
    process.env["COORD_MAX_CONVERSATION_SESSIONS"] = "eight";
    // Falling back to the default here would leave a deployment holding a
    // cap it did not choose and believes it did not set.
    assert.throws(() => new ConversationRegistry(), {
      message: /COORD_MAX_CONVERSATION_SESSIONS/u,
    });
    // An explicit argument still wins, so a caller that knows its own bound
    // is not held hostage by the environment it happens to run in.
    assert.doesNotThrow(() => new ConversationRegistry({ maxSessions: 2 }));
  } finally {
    if (previous === undefined) {
      delete process.env["COORD_MAX_CONVERSATION_SESSIONS"];
    } else {
      process.env["COORD_MAX_CONVERSATION_SESSIONS"] = previous;
    }
  }
});

test("the session cap closes the oldest conversation's session first", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-conv-test-"));

  try {
    const fixture = await createFixture(root);
    const coordinator = new Coordinator({
      repositories: fixture.repositories,
      workspaces: fixture.workspaces,
      maxConversationSessions: 1,
    });
    const first = new ConversationAgent(
      "agent_first",
      plan("first_1", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    const second = new ConversationAgent(
      "agent_second",
      plan("second_1", ["src/b.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    const conversationA = openConversation(fixture, root, first, "conv_a", {
      coordinator,
    });
    const conversationB = openConversation(fixture, root, second, "conv_b", {
      coordinator,
    });

    first.turnOutput = { path: "src/a.txt", content: "first one\n" };
    const landedA = await conversationA.runTurn(task("first_1"));
    assert.equal(landedA.tasks[0]?.status, "integrated");
    assert.equal(first.cancelCount, 0);

    // The second conversation landing pushes the population past the cap,
    // and the conversation that landed longest ago pays — with its process,
    // not its place.
    second.turnOutput = { path: "src/b.txt", content: "second one\n" };
    const landedB = await conversationB.runTurn(task("second_1"));
    assert.equal(landedB.tasks[0]?.status, "integrated");
    assert.equal(first.cancelCount, 1);
    assert.equal(second.cancelCount, 0);

    // The evicted conversation is still open: its next turn is cold but in
    // the directory it kept all along.
    first.turnPlan = plan("first_2", ["src/c.txt"]);
    first.turnOutput = { path: "src/c.txt", content: "first two\n" };
    const resumed = await conversationA.runTurn(task("first_2"));
    assert.equal(resumed.tasks[0]?.status, "integrated");
    assert.equal(first.startInputs.length, 2);
    assert.equal(first.continueInputs.length, 0);
    assert.equal(first.workspacePaths[1], first.workspacePaths[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ending a conversation destroys both halves", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-conv-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ConversationAgent(
      "agent_conv",
      plan("turn_1", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
    );
    const conversation = openConversation(fixture, root, agent);

    agent.turnOutput = { path: "src/a.txt", content: "turn one\n" };
    const first = await conversation.runTurn(task("turn_1"));
    assert.equal(first.tasks[0]?.status, "integrated");
    const workspacePath = agent.workspacePaths[0];
    assert.ok(workspacePath !== undefined);

    await conversation.coordinator.endConversation("conversation");
    assert.equal(agent.cancelCount, 1);
    await assert.rejects(lstat(workspacePath), { code: "ENOENT" });
    // Ending twice is a no-op, not an error.
    await conversation.coordinator.endConversation("conversation");
    assert.equal(agent.cancelCount, 1);

    // The next turn finds nothing to resume and starts a fresh conversation.
    agent.turnPlan = plan("turn_2", ["src/b.txt"]);
    agent.turnOutput = { path: "src/b.txt", content: "turn two\n" };
    const second = await conversation.runTurn(task("turn_2"));
    assert.equal(second.tasks[0]?.status, "integrated");
    assert.equal(agent.startInputs.length, 2);
    assert.notEqual(agent.workspacePaths[1], workspacePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an adapter without continueTask still keeps the directory, cold", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-conv-test-"));

  try {
    const fixture = await createFixture(root);
    const agent = new ConversationAgent(
      "agent_conv",
      plan("turn_1", ["src/a.txt"]),
      fixture.repository,
      fixture.workspaces,
      false,
    );
    const conversation = openConversation(fixture, root, agent);

    agent.turnOutput = { path: "src/a.txt", content: "turn one\n" };
    const first = await conversation.runTurn(task("turn_1"));
    assert.equal(first.tasks[0]?.status, "integrated");
    assert.equal(agent.cancelCount, 0);

    // The session is the expendable half: without continueTask the old one
    // is closed and the turn starts cold with the thread as context, while
    // the directory — the cheap-to-keep, expensive-to-rebuild half — is
    // still reused.
    agent.turnPlan = plan("turn_2", ["src/b.txt"]);
    agent.turnOutput = { path: "src/b.txt", content: "turn two\n" };
    const second = await conversation.runTurn(task("turn_2"));
    assert.equal(second.tasks[0]?.status, "integrated");
    assert.equal(agent.startInputs.length, 2);
    assert.equal(agent.cancelCount, 1);
    assert.equal(agent.workspacePaths[1], agent.workspacePaths[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
