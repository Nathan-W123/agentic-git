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
} from "@coord/shared-types";
import type { CanonicalRepository } from "@coord/repository-service";
import type {
  TaskWorkspace,
  WorkspaceManager,
} from "@coord/workspace-manager";

export interface ScriptedAgentBehavior {
  plan: AgentPlan;
  execute: (workspacePath: string) => Promise<void>;
}

interface ScriptedSession {
  session: AgentSession;
  input: StartTaskInput;
  context?: CoordinatorContext;
  cancelled: boolean;
  events: AgentEvent[];
}

export interface ScriptedAgentOptions {
  agentId: string;
  repository: CanonicalRepository;
  workspaces: WorkspaceManager;
  behavior: ScriptedAgentBehavior;
}

export class ScriptedAgentAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, ScriptedSession>();

  public constructor(private readonly options: ScriptedAgentOptions) {}

  public async getCapabilities(): Promise<AgentCapabilities> {
    return {
      canPlan: true,
      canEditFiles: true,
      canRunCommands: false,
      canUseTools: false,
      supportsStreaming: true,
      supportsPause: false,
    };
  }

  public async startTask(input: StartTaskInput): Promise<AgentSession> {
    if (input.task.id !== this.options.behavior.plan.taskId) {
      throw new Error(
        `Scripted behavior for ${this.options.behavior.plan.taskId} cannot run ${input.task.id}`,
      );
    }

    const session: AgentSession = {
      id: createId("session"),
      agentId: this.options.agentId,
      taskId: input.task.id,
      startedAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, {
      session,
      input,
      cancelled: false,
      events: [],
    });
    return session;
  }

  public async requestPlan(sessionId: string): Promise<AgentPlan> {
    this.requireSession(sessionId);
    return structuredClone(this.options.behavior.plan);
  }

  public async sendContext(
    sessionId: string,
    context: CoordinatorContext,
  ): Promise<void> {
    const record = this.requireSession(sessionId);
    if (record.cancelled) {
      throw new Error(`Session ${sessionId} was cancelled`);
    }

    record.context = context;
    record.events.push({
      event: "progress",
      message: `Editing ${this.options.behavior.plan.expectedFiles.join(", ")}`,
      occurredAt: new Date().toISOString(),
    });
    await this.options.behavior.execute(context.workspacePath);
    record.events.push({
      event: "completed",
      occurredAt: new Date().toISOString(),
    });
  }

  public async pause(_sessionId: string): Promise<void> {
    throw new Error("Scripted agents complete synchronously and cannot pause");
  }

  public async resume(_sessionId: string): Promise<void> {
    throw new Error("Scripted agents complete synchronously and cannot resume");
  }

  public async cancel(sessionId: string): Promise<void> {
    this.requireSession(sessionId).cancelled = true;
  }

  public async collectChanges(sessionId: string): Promise<ChangeSet> {
    const record = this.requireSession(sessionId);
    const context = record.context;
    if (context === undefined) {
      throw new Error(`Session ${sessionId} has not received a workspace`);
    }

    const workspace: TaskWorkspace = {
      id: context.decision.workspaceId ?? createId("workspace"),
      taskId: record.input.task.id,
      path: context.workspacePath,
      rootPath: context.workspacePath,
      repository: this.options.repository,
      baseVersion: context.canonicalVersion,
      isolation: "git-worktree",
      createdAt: new Date().toISOString(),
    };
    return await this.options.workspaces.collectChangeSet(workspace, {
      symbolsChanged: this.options.behavior.plan.expectedSymbols,
      riskAssessment: {
        level: this.options.behavior.plan.riskLevel,
        reasons: [],
      },
      agentExplanation: `Scripted execution of ${record.input.task.objective}`,
    });
  }

  public async streamEvents(
    sessionId: string,
    handler: (event: AgentEvent) => void,
  ): Promise<void> {
    for (const event of this.requireSession(sessionId).events) {
      handler(event);
    }
  }

  private requireSession(sessionId: string): ScriptedSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown scripted session: ${sessionId}`);
    }
    return session;
  }
}

