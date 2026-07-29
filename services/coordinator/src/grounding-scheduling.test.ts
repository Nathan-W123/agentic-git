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

import { Coordinator } from "./coordinator.js";

/**
 * Scheduling behaviour of verification, observed from the outside: a plan
 * whose declarations connect to nothing real runs in a wave of its own, and
 * verified disjoint plans keep the concurrency they always had.
 */

interface SessionState {
  input: StartTaskInput;
  context?: CoordinatorContext;
}

/** Writes exactly its declared files; plans whatever it was given. */
class GhostAgent implements AgentAdapter {
  private readonly sessions = new Map<string, SessionState>();
  /** Canonical sequence seen when execution context arrived, per call. */
  public readonly executionVersions: number[] = [];

  public constructor(
    private readonly agentId: string,
    private readonly plan: AgentPlan,
    private readonly repository: CanonicalRepository,
    private readonly workspaces: GitWorktreeWorkspaceManager,
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
    this.sessions.set(session.id, { input });
    return session;
  }

  public async requestPlan(): Promise<AgentPlan> {
    return structuredClone(this.plan);
  }

  public async requestReplan(
    _sessionId: string,
    _request: ReplanRequest,
  ): Promise<AgentPlan> {
    return structuredClone(this.plan);
  }

  public async sendContext(
    sessionId: string,
    context: CoordinatorContext,
  ): Promise<void> {
    const session = this.require(sessionId);
    session.context = context;
    this.executionVersions.push(context.canonicalVersion.sequence);
    for (const file of this.plan.expectedFiles) {
      await mkdir(path.dirname(path.join(context.workspacePath, file)), {
        recursive: true,
      });
      await writeFile(
        path.join(context.workspacePath, file),
        `${this.plan.taskId}\n`,
        "utf8",
      );
    }
  }

  public async pause(): Promise<void> {}
  public async resume(): Promise<void> {}
  public async resolveScopeChange(
    _sessionId: string,
    _decision: ScopeChangeDecision,
  ): Promise<void> {}
  public async cancel(): Promise<void> {}

  public async collectChanges(sessionId: string): Promise<ChangeSet> {
    const session = this.require(sessionId);
    const context = session.context;
    if (context === undefined) {
      throw new Error("No coordinator context was sent");
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
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "grounding scheduling test",
    });
  }

  public async streamEvents(
    _sessionId: string,
    _handler: (event: AgentEvent) => void,
  ): Promise<void> {}

  private require(sessionId: string): SessionState {
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
  objective: string,
  expectedFiles: string[],
  expectedSymbols: string[] = [],
): AgentPlan {
  return {
    taskId,
    objective,
    expectedFiles,
    expectedSymbols,
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };
}

async function fixture(root: string): Promise<{
  repositories: RepositoryService;
  repository: CanonicalRepository;
  workspaces: GitWorktreeWorkspaceManager;
}> {
  const sourcePath = path.join(root, "source");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  for (const name of ["a.txt", "b.txt"]) {
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

test("two unverifiable plans about one objective never share a wave, even with no detected overlap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-grounding-run-"));
  try {
    const parts = await fixture(root);
    const coordinator = new Coordinator({
      repositories: parts.repositories,
      workspaces: parts.workspaces,
    });
    // Neither declared file exists; neither symbol resolves; the declared
    // names of the two plans share nothing — the recorded live failure shape.
    // The objectives, though, are visibly about the same checkout pricing.
    const agentA = new GhostAgent(
      "agent_a",
      plan(
        "task_a",
        "charge a checkout handling fee on orders",
        ["src/ghost-a.txt"],
        ["phantomAlpha"],
      ),
      parts.repository,
      parts.workspaces,
    );
    const agentB = new GhostAgent(
      "agent_b",
      plan(
        "task_b",
        "waive checkout delivery charges on orders",
        ["src/ghost-b.txt"],
        ["phantomBeta"],
      ),
      parts.repository,
      parts.workspaces,
    );

    const result = await coordinator.run({
      repository: parts.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        { task: task("task_a"), adapter: agentA },
        { task: task("task_b"), adapter: agentB },
      ],
    });

    assert.deepEqual(
      result.tasks.map((entry) => entry.status),
      ["integrated", "integrated"],
    );
    // No structural conflict was detectable from the declarations — that is
    // the point — yet the tasks did not run concurrently: the second saw the
    // canonical sequence the first produced.
    assert.equal(result.conflicts.length, 0);
    assert.equal(agentA.executionVersions.length, 1);
    assert.equal(agentB.executionVersions.length, 1);
    assert.equal(
      (agentB.executionVersions[0] ?? 0) - (agentA.executionVersions[0] ?? 0),
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verified disjoint plans keep their concurrency", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-grounding-run-"));
  try {
    const parts = await fixture(root);
    const coordinator = new Coordinator({
      repositories: parts.repositories,
      workspaces: parts.workspaces,
    });
    const agentA = new GhostAgent(
      "agent_a",
      plan("task_a", "polish the alpha text", ["src/a.txt"]),
      parts.repository,
      parts.workspaces,
    );
    const agentB = new GhostAgent(
      "agent_b",
      plan("task_b", "rewrite the beta copy", ["src/b.txt"]),
      parts.repository,
      parts.workspaces,
    );

    const result = await coordinator.run({
      repository: parts.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        { task: task("task_a"), adapter: agentA },
        { task: task("task_b"), adapter: agentB },
      ],
    });

    assert.deepEqual(
      result.tasks.map((entry) => entry.status),
      ["integrated", "integrated"],
    );
    // Same wave: both executed against the same canonical sequence.
    assert.equal(agentA.executionVersions[0], agentB.executionVersions[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unverifiable plan about an unrelated objective keeps its concurrency", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-grounding-run-"));
  try {
    const parts = await fixture(root);
    const coordinator = new Coordinator({
      repositories: parts.repositories,
      workspaces: parts.workspaces,
    });
    // A creates a brand-new file — unverifiable by construction — while B
    // edits a real one about something else entirely. Serialising them would
    // punish every module-creating task for the sins of hallucinating ones.
    const agentA = new GhostAgent(
      "agent_a",
      plan("task_a", "add a telemetry module", ["src/telemetry.txt"]),
      parts.repository,
      parts.workspaces,
    );
    const agentB = new GhostAgent(
      "agent_b",
      plan("task_b", "polish the alpha text", ["src/a.txt"]),
      parts.repository,
      parts.workspaces,
    );

    const result = await coordinator.run({
      repository: parts.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        { task: task("task_a"), adapter: agentA },
        { task: task("task_b"), adapter: agentB },
      ],
    });

    assert.deepEqual(
      result.tasks.map((entry) => entry.status),
      ["integrated", "integrated"],
    );
    assert.equal(agentA.executionVersions[0], agentB.executionVersions[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
