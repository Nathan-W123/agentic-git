import {
  AdapterNotConfiguredError,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentEvent,
  type AgentSession,
  type CoordinatorContext,
  type StartTaskInput,
} from "@coord/agent-protocol";
import type { AgentPlan, ChangeSet } from "@coord/shared-types";

/**
 * Protocol boundary for a future Codex process driver.
 *
 * The Phase 0 demo does not invoke a provider binary. Keeping this adapter
 * explicit prevents provider behavior from leaking into coordinator services.
 */
export class CodexAdapter implements AgentAdapter {
  public async getCapabilities(): Promise<AgentCapabilities> {
    return {
      canPlan: true,
      canEditFiles: true,
      canRunCommands: true,
      canUseTools: true,
      supportsStreaming: true,
      supportsPause: true,
    };
  }

  public async startTask(_input: StartTaskInput): Promise<AgentSession> {
    return this.unavailable("start tasks");
  }

  public async requestPlan(_sessionId: string): Promise<AgentPlan> {
    return this.unavailable("request plans");
  }

  public async sendContext(
    _sessionId: string,
    _context: CoordinatorContext,
  ): Promise<void> {
    return this.unavailable("send coordinator context");
  }

  public async pause(_sessionId: string): Promise<void> {
    return this.unavailable("pause sessions");
  }

  public async resume(_sessionId: string): Promise<void> {
    return this.unavailable("resume sessions");
  }

  public async cancel(_sessionId: string): Promise<void> {
    return this.unavailable("cancel sessions");
  }

  public async collectChanges(_sessionId: string): Promise<ChangeSet> {
    return this.unavailable("collect changes");
  }

  public async streamEvents(
    _sessionId: string,
    _handler: (event: AgentEvent) => void,
  ): Promise<void> {
    return this.unavailable("stream events");
  }

  private unavailable(operation: string): never {
    throw new AdapterNotConfiguredError("CodexAdapter", operation);
  }
}

