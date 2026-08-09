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
} from "@coord/shared-types";
import type { CanonicalRepository } from "@coord/repository-service";
import type {
  TaskWorkspace,
  WorkspaceManager,
} from "@coord/workspace-manager";

export interface ScriptedAgentBehavior {
  plan: AgentPlan;
  replan?: (request: ReplanRequest) => AgentPlan | Promise<AgentPlan>;
  execute: (workspacePath: string) => Promise<void>;
  /**
   * Re-applies the agent's intent to files that changed underneath it.
   *
   * Called instead of `execute` when the coordinator asks for a repair. The
   * named files already hold current canonical content, so a scripted agent
   * models a real one by editing on top of what is there rather than by
   * writing what it wrote the first time. Absent means this agent cannot
   * repair, which is the honest default for one that only knows one edit.
   */
  repair?: (workspacePath: string, files: string[]) => Promise<void>;
}

interface ScriptedSession {
  session: AgentSession;
  input: StartTaskInput;
  plan: AgentPlan;
  context?: CoordinatorContext;
  cancelled: boolean;
  events: AgentEvent[];
  eventHandlers: Set<(event: AgentEvent) => void>;
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
      plan: structuredClone(this.options.behavior.plan),
      cancelled: false,
      events: [],
      eventHandlers: new Set(),
    });
    return session;
  }

  public async requestPlan(sessionId: string): Promise<AgentPlan> {
    return structuredClone(this.requireSession(sessionId).plan);
  }

  public async requestReplan(
    sessionId: string,
    request: ReplanRequest,
  ): Promise<AgentPlan> {
    const record = this.requireSession(sessionId);
    record.plan = structuredClone(
      this.options.behavior.replan === undefined
        ? { ...record.plan, objective: request.previousPlan.objective }
        : await this.options.behavior.replan(request),
    );
    return structuredClone(record.plan);
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
    const repair = context.repair;
    this.emit(record, {
      event: "progress",
      message:
        repair === undefined
          ? `Editing ${record.plan.expectedFiles.join(", ")}`
          : `Reconciling ${repair.files.join(", ")}`,
      occurredAt: new Date().toISOString(),
    });
    if (repair !== undefined) {
      const reconcile = this.options.behavior.repair;
      if (reconcile === undefined) {
        // An agent that cannot reconcile must not answer as though it did:
        // returning its original edits would re-propose exactly what already
        // lost, and returning nothing at least fails honestly.
        throw new Error(
          `Scripted agent ${this.options.agentId} was asked to repair ` +
            `${repair.files.join(", ")} but has no repair behaviour`,
        );
      }
      await reconcile(context.workspacePath, [...repair.files]);
    } else {
      await this.options.behavior.execute(context.workspacePath);
    }
    this.emit(record, {
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

  public async resolveScopeChange(
    sessionId: string,
    decision: ScopeChangeDecision,
  ): Promise<void> {
    const record = this.requireSession(sessionId);
    if (decision.decision !== "rejected") {
      record.plan = structuredClone(decision.revisedPlan);
    }
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
      symbolsChanged: record.plan.expectedSymbols,
      riskAssessment: {
        level: record.plan.riskLevel,
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
    const record = this.requireSession(sessionId);
    if (
      !record.cancelled &&
      !record.events.some((event) => event.event === "completed")
    ) {
      record.eventHandlers.add(handler);
    }
  }

  private emit(record: ScriptedSession, event: AgentEvent): void {
    record.events.push(event);
    for (const handler of record.eventHandlers) {
      handler(event);
    }
    if (event.event === "completed") {
      record.eventHandlers.clear();
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
