import type {
  AgentPlan,
  CanonicalVersion,
  ChangeSet,
  ReplanRequest,
  ScopeChangeDecision,
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
  planRevision?: number;
}

export type AgentEvent =
  | {
      event: "progress";
      message: string;
      occurredAt: string;
    }
  | {
      event: "scope_change_requested";
      requestId?: string;
      additionalFiles: string[];
      additionalSymbols?: string[];
      additionalApis?: string[];
      additionalSchemas?: string[];
      additionalConfigKeys?: string[];
      additionalTests?: string[];
      additionalServices?: string[];
      reason: string;
      occurredAt: string;
    }
  | {
      event: "completed";
      occurredAt: string;
    };

/**
 * Model spend one agent reported for one phase of one session.
 *
 * Optional throughout, because it is the agent's to report and not every CLI
 * says. A coordinator that receives nothing records nothing rather than
 * guessing: an invented number would be worse than an absent one, since a
 * budget would then be enforced against fiction.
 */
export interface AgentTokenUsage {
  phase: "planning" | "execution";
  /** Cumulative for the phase, not an increment since the last report. */
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AgentAdapter {
  getCapabilities(): Promise<AgentCapabilities>;

  startTask(input: StartTaskInput): Promise<AgentSession>;

  requestPlan(sessionId: string): Promise<AgentPlan>;

  requestReplan(
    sessionId: string,
    request: ReplanRequest,
  ): Promise<AgentPlan>;

  sendContext(
    sessionId: string,
    context: CoordinatorContext,
  ): Promise<void>;

  pause(sessionId: string): Promise<void>;

  resume(sessionId: string): Promise<void>;

  resolveScopeChange(
    sessionId: string,
    decision: ScopeChangeDecision,
  ): Promise<void>;

  cancel(sessionId: string): Promise<void>;

  collectChanges(sessionId: string): Promise<ChangeSet>;

  streamEvents(
    sessionId: string,
    handler: (event: AgentEvent) => void,
  ): Promise<void>;

  /**
   * What this session has spent so far, if the underlying tool reports it.
   *
   * Synchronous and safe to call at any point, including mid-execution, so a
   * worker can send a running total up with its heartbeat and the control
   * plane can stop a task that is burning through its budget rather than
   * discovering the overspend once the bill has been paid.
   */
  reportedTokenUsage?(sessionId: string): AgentTokenUsage[];
}
