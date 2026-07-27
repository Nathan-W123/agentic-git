import { spawn, type ChildProcess } from "node:child_process";

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
import {
  sanitizeChildEnv,
  type CanonicalRepository,
} from "@coord/repository-service";
import type {
  SandboxLaunchSpec,
  TaskWorkspace,
  WorkspaceManager,
  WorkspaceSandbox,
} from "@coord/workspace-manager";

import {
  AgentProtocolError,
  JsonLineDecoder,
  encodeHostMessage,
  parseAgentMessage,
  type AgentMessage,
  type AgentMessageType,
  type HostMessage,
} from "./protocol.js";

export * from "./protocol.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 600_000;
const STDERR_RETENTION_BYTES = 16_384;

export interface GenericCliAdapterOptions {
  /** Identifier recorded on the session and in audit events. */
  agentId: string;
  /** Executable and arguments for the agent process. Never run through a shell. */
  launch: SandboxLaunchSpec;
  repository: CanonicalRepository;
  workspaces: WorkspaceManager;
  /**
   * Optional confinement for the agent process.
   *
   * When set, the planning process runs without any host mount and is replaced
   * by a second confined process once a workspace exists, because a container
   * cannot gain a bind mount after it has started.
   */
  sandbox?: WorkspaceSandbox;
  /** Timeout for plan requests. */
  requestTimeoutMs?: number;
  /** Timeout for the edit phase, which is normally much slower than planning. */
  executionTimeoutMs?: number;
}

type Pending = {
  type: AgentMessageType;
  resolve: (message: AgentMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * One JSONL-over-stdio conversation with a child process.
 *
 * The protocol is strictly request/response with unsolicited `event` lines
 * allowed at any point, so at most one request may be in flight.
 */
class AgentProcess {
  private readonly child: ChildProcess;
  private readonly decoder = new JsonLineDecoder();
  private readonly stderrChunks: string[] = [];
  private stderrLength = 0;
  private pending: Pending | undefined;
  private failure: Error | undefined;
  private exited = false;
  private readonly closed: Promise<void>;

  public constructor(
    private readonly spec: SandboxLaunchSpec,
    private readonly onEvent: (event: AgentEvent) => void,
  ) {
    this.child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: sanitizeChildEnv(spec.env ?? process.env),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.consume(chunk);
    });
    this.child.stderr?.on("data", (chunk: string) => {
      this.recordStderr(chunk);
    });
    // A dead child turns further writes into EPIPE; the close handler reports it.
    this.child.stdin?.on("error", () => undefined);
    this.child.once("error", (error: Error) => {
      this.fail(error);
    });

    this.closed = new Promise<void>((resolve) => {
      this.child.once("close", (code, signal) => {
        this.exited = true;
        for (const line of this.decoder.flush()) {
          this.consumeLine(line);
        }
        this.fail(
          new AgentProtocolError(
            `Agent process ${this.describe()} exited with ` +
              `${signal === null ? `code ${String(code)}` : `signal ${signal}`}` +
              this.stderrSuffix(),
          ),
        );
        resolve();
      });
    });
  }

  public send(message: HostMessage): void {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    if (this.exited || this.child.stdin === null) {
      throw new AgentProtocolError(
        `Agent process ${this.describe()} is no longer accepting input`,
      );
    }
    this.child.stdin.write(encodeHostMessage(message));
  }

  public async waitFor<T extends AgentMessageType>(
    type: T,
    timeoutMs: number,
  ): Promise<Extract<AgentMessage, { type: T }>> {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    if (this.pending !== undefined) {
      throw new AgentProtocolError(
        "A request is already in flight for this agent process",
      );
    }

    return await new Promise<Extract<AgentMessage, { type: T }>>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          // `fail` rejects the still-registered pending request.
          this.fail(
            new AgentProtocolError(
              `Timed out after ${timeoutMs} ms waiting for a "${type}" message` +
                this.stderrSuffix(),
            ),
          );
        }, timeoutMs);
        timer.unref?.();

        this.pending = {
          type,
          resolve: (message) => {
            resolve(message as Extract<AgentMessage, { type: T }>);
          },
          reject,
          timer,
        };
      },
    );
  }

  public async close(): Promise<void> {
    if (this.exited) {
      return;
    }
    this.child.stdin?.end();
    const kill = setTimeout(() => {
      this.child.kill("SIGKILL");
    }, 5_000);
    kill.unref?.();
    try {
      await this.closed;
    } finally {
      clearTimeout(kill);
    }
  }

  public kill(): void {
    if (!this.exited) {
      this.child.kill("SIGKILL");
    }
  }

  private describe(): string {
    return `${this.spec.command} ${this.spec.args.join(" ")}`.trim();
  }

  private consume(chunk: string): void {
    let lines: string[];
    try {
      lines = this.decoder.push(chunk);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    for (const line of lines) {
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    let message: AgentMessage;
    try {
      message = parseAgentMessage(line);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    if (message.type === "event") {
      this.onEvent(message.event);
      return;
    }

    const pending = this.pending;
    if (pending === undefined) {
      this.fail(
        new AgentProtocolError(
          `Agent sent an unsolicited "${message.type}" message`,
        ),
      );
      return;
    }

    this.pending = undefined;
    clearTimeout(pending.timer);

    if (message.type === "error") {
      pending.reject(new AgentProtocolError(`Agent reported: ${message.message}`));
      return;
    }
    if (message.type !== pending.type) {
      const error = new AgentProtocolError(
        `Expected a "${pending.type}" message but the agent sent "${message.type}"`,
      );
      pending.reject(error);
      this.failure ??= error;
      return;
    }
    pending.resolve(message);
  }

  private recordStderr(chunk: string): void {
    this.stderrChunks.push(chunk);
    this.stderrLength += chunk.length;
    while (this.stderrLength > STDERR_RETENTION_BYTES && this.stderrChunks.length > 1) {
      this.stderrLength -= this.stderrChunks.shift()?.length ?? 0;
    }
  }

  private stderrSuffix(): string {
    const stderr = this.stderrChunks.join("").trim();
    return stderr.length === 0 ? "" : `; stderr: ${stderr}`;
  }

  private fail(error: Error): void {
    this.failure ??= error;
    const pending = this.pending;
    if (pending !== undefined) {
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
  }
}

interface CliSession {
  session: AgentSession;
  input: StartTaskInput;
  process: AgentProcess | undefined;
  plan: AgentPlan | undefined;
  context: CoordinatorContext | undefined;
  completion: { symbolsChanged: string[]; explanation: string } | undefined;
  events: AgentEvent[];
  cancelled: boolean;
}

/**
 * Provider-neutral process driver for command-line coding agents.
 *
 * The agent speaks newline-delimited JSON on stdin and stdout. See
 * {@link ./protocol.ts} for the message shapes.
 */
export class GenericCliAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, CliSession>();

  public constructor(private readonly options: GenericCliAdapterOptions) {}

  public async getCapabilities(): Promise<AgentCapabilities> {
    return {
      canPlan: true,
      canEditFiles: true,
      canRunCommands: true,
      canUseTools: false,
      supportsStreaming: true,
      supportsPause: false,
    };
  }

  public async startTask(input: StartTaskInput): Promise<AgentSession> {
    const session: AgentSession = {
      id: createId("session"),
      agentId: this.options.agentId,
      taskId: input.task.id,
      startedAt: new Date().toISOString(),
    };
    const record: CliSession = {
      session,
      input,
      process: undefined,
      plan: undefined,
      context: undefined,
      completion: undefined,
      events: [],
      cancelled: false,
    };
    this.sessions.set(session.id, record);

    record.process = this.spawnAgent(record);
    return session;
  }

  public async requestPlan(sessionId: string): Promise<AgentPlan> {
    const record = this.requireSession(sessionId);
    const agent = this.requireProcess(record);

    agent.send({ type: "plan_request", sessionId });
    const reply = await agent.waitFor(
      "plan",
      this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    if (reply.plan.taskId !== record.input.task.id) {
      throw new AgentProtocolError(
        `Agent planned ${reply.plan.taskId} but was started for ${record.input.task.id}`,
      );
    }

    record.plan = reply.plan;
    return structuredClone(reply.plan);
  }

  public async sendContext(
    sessionId: string,
    context: CoordinatorContext,
  ): Promise<void> {
    const record = this.requireSession(sessionId);
    if (record.cancelled) {
      throw new Error(`Session ${sessionId} was cancelled`);
    }
    if (record.plan === undefined) {
      throw new Error(`Session ${sessionId} has not submitted a plan`);
    }

    record.context = context;
    const workspace = this.toWorkspace(record, context);

    try {
      // A container cannot gain a bind mount after it starts, so the confined
      // planning process is replaced by one that can see the workspace.
      if (this.options.sandbox !== undefined) {
        await record.process?.close();
        record.process = this.spawnAgent(record, workspace);
      }

      const agent = this.requireProcess(record);
      agent.send({
        type: "context",
        sessionId,
        workspacePath:
          this.options.sandbox?.resolveWorkspacePath(workspace) ??
          context.workspacePath,
        decision: context.decision,
        canonicalVersion: context.canonicalVersion,
        plan: record.plan,
      });

      const done = await agent.waitFor(
        "done",
        this.options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
      );
      record.completion = {
        symbolsChanged: done.symbolsChanged,
        explanation: done.explanation,
      };
      record.events.push({
        event: "completed",
        occurredAt: new Date().toISOString(),
      });
    } finally {
      // Changes are collected from the host worktree, so the agent process is
      // no longer needed and must not outlive the task.
      const agent = record.process;
      record.process = undefined;
      await agent?.close();
    }
  }

  public async pause(_sessionId: string): Promise<void> {
    throw new Error("GenericCliAdapter does not support pausing agent sessions");
  }

  public async resume(_sessionId: string): Promise<void> {
    throw new Error("GenericCliAdapter does not support resuming agent sessions");
  }

  public async cancel(sessionId: string): Promise<void> {
    const record = this.requireSession(sessionId);
    record.cancelled = true;
    const agent = record.process;
    record.process = undefined;
    if (agent === undefined) {
      return;
    }
    try {
      agent.send({ type: "cancel", sessionId });
    } catch {
      // The process may already be gone; the kill below is the real guarantee.
    }
    agent.kill();
    await agent.close();
  }

  public async collectChanges(sessionId: string): Promise<ChangeSet> {
    const record = this.requireSession(sessionId);
    const context = record.context;
    if (context === undefined) {
      throw new Error(`Session ${sessionId} has not received a workspace`);
    }
    if (record.completion === undefined) {
      throw new Error(`Session ${sessionId} has not signalled completion`);
    }

    const plan = record.plan;
    const symbolsChanged =
      record.completion.symbolsChanged.length > 0
        ? record.completion.symbolsChanged
        : plan?.expectedSymbols ?? [];

    return await this.options.workspaces.collectChangeSet(
      this.toWorkspace(record, context),
      {
        symbolsChanged: [...symbolsChanged],
        riskAssessment: { level: plan?.riskLevel ?? "medium", reasons: [] },
        agentExplanation:
          record.completion.explanation ||
          `Generic CLI agent completed ${record.input.task.objective}`,
      },
    );
  }

  public async streamEvents(
    sessionId: string,
    handler: (event: AgentEvent) => void,
  ): Promise<void> {
    for (const event of this.requireSession(sessionId).events) {
      handler(event);
    }
  }

  private spawnAgent(
    record: CliSession,
    workspace?: TaskWorkspace,
  ): AgentProcess {
    const sandbox = this.options.sandbox;
    const spec =
      sandbox === undefined
        ? this.options.launch
        : sandbox.wrapLaunch(this.options.launch, workspace);

    const agent = new AgentProcess(spec, (event) => {
      record.events.push(event);
    });
    agent.send({
      type: "start",
      sessionId: record.session.id,
      taskId: record.input.task.id,
      objective: record.input.task.objective,
      repositoryId: record.input.repositoryId,
      canonicalVersion: record.input.canonicalVersion,
      validationCommands: record.input.task.validationCommands,
    });
    return agent;
  }

  private toWorkspace(
    record: CliSession,
    context: CoordinatorContext,
  ): TaskWorkspace {
    return {
      id: context.decision.workspaceId ?? createId("workspace"),
      taskId: record.input.task.id,
      path: context.workspacePath,
      rootPath: context.workspacePath,
      repository: this.options.repository,
      baseVersion: context.canonicalVersion,
      isolation: this.options.sandbox === undefined ? "git-worktree" : "docker",
      createdAt: record.session.startedAt,
    };
  }

  private requireProcess(record: CliSession): AgentProcess {
    if (record.process === undefined) {
      throw new Error(
        `Session ${record.session.id} has no running agent process`,
      );
    }
    return record.process;
  }

  private requireSession(sessionId: string): CliSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown generic CLI session: ${sessionId}`);
    }
    return session;
  }
}
