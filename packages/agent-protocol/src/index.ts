import type {
  AgentPlan,
  CanonicalVersion,
  ChangeSet,
  CoordinatorDecision,
  TaskDefinition,
} from "@coord/shared-types";

export interface AgentCapabilities {
  canPlan: boolean;
  canEditFiles: boolean;
  canRunCommands: boolean;
  canUseTools: boolean;
  supportsStreaming: boolean;
  supportsPause: boolean;
  maximumContextTokens?: number;
}

export interface StartTaskInput {
  task: TaskDefinition;
  canonicalVersion: CanonicalVersion;
  repositoryId: string;
}

export interface AgentSession {
  id: string;
  agentId: string;
  taskId: string;
  startedAt: string;
}

export interface CoordinatorContext {
  decision: CoordinatorDecision;
  canonicalVersion: CanonicalVersion;
  workspacePath: string;
}

export type AgentEvent =
  | {
      event: "progress";
      message: string;
      occurredAt: string;
    }
  | {
      event: "scope_change_requested";
      additionalFiles: string[];
      reason: string;
      occurredAt: string;
    }
  | {
      event: "completed";
      occurredAt: string;
    };

export interface AgentAdapter {
  getCapabilities(): Promise<AgentCapabilities>;

  startTask(input: StartTaskInput): Promise<AgentSession>;

  requestPlan(sessionId: string): Promise<AgentPlan>;

  sendContext(
    sessionId: string,
    context: CoordinatorContext,
  ): Promise<void>;

  pause(sessionId: string): Promise<void>;

  resume(sessionId: string): Promise<void>;

  cancel(sessionId: string): Promise<void>;

  collectChanges(sessionId: string): Promise<ChangeSet>;

  streamEvents(
    sessionId: string,
    handler: (event: AgentEvent) => void,
  ): Promise<void>;
}

export class AdapterNotConfiguredError extends Error {
  public constructor(adapterName: string, operation: string) {
    super(
      `${adapterName} cannot ${operation} until a provider process driver is configured`,
    );
    this.name = "AdapterNotConfiguredError";
  }
}

