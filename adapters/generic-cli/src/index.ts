import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  type AgentActionResult,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentEvent,
  type AgentSession,
  type AgentTokenUsage,
  type CoordinatorContext,
  type StartTaskInput,
} from "@coord/agent-protocol";
import {
  createId,
  requestFromObjective,
  scopeChangeGranted,
  type AgentPlan,
  type ChangeSet,
  type HolderWorkingChange,
  type ReplanRequest,
  type ScopeChangeDecision,
} from "@coord/shared-types";
import {
  explainSpawnFailure,
  sanitizeChildEnv,
  spawnInvocation,
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
const MAX_REPLAY_EVENTS = 10_000;
const STDERR_RETENTION_BYTES = 16_384;

export interface GenericCliAdapterOptions {
  /** Identifier recorded on the session and in audit events. */
  agentId: string;
  /** Executable and arguments for the agent process. Never run through a shell. */
  launch: SandboxLaunchSpec;
  repository: CanonicalRepository;
  workspaces: WorkspaceManager;
  /** Disposable canonical worktrees made visible during planning. */
  planningRoot?: string;
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
    // Not `spawn(spec.command, ...)` directly. This adapter owns its child
    // rather than borrowing `runProcess`, and that is exactly why it has to
    // ask for the same invocation: a bare `agent` on Windows is a `.cmd` shim
    // that libuv will not find and Node will not execute, so spawning the
    // name as written produced `spawn agent ENOENT` on every task.
    const childEnv = sanitizeChildEnv(spec.env ?? process.env);
    const invocation = spawnInvocation(
      spec.command,
      spec.args,
      spec.cwd,
      childEnv,
    );
    this.child = spawn(invocation.executable, invocation.args, {
      cwd: spec.cwd,
      env: childEnv,
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
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
      this.fail(explainSpawnFailure(error, spec.command, childEnv));
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
  planningWorkspace: TaskWorkspace | undefined;
  process: AgentProcess | undefined;
  plan: AgentPlan | undefined;
  context: CoordinatorContext | undefined;
  completion: { symbolsChanged: string[]; explanation: string } | undefined;
  events: AgentEvent[];
  eventHandlers: Set<(event: AgentEvent) => void>;
  /** What the agent said it spent. Empty when it said nothing. */
  tokenUsage: AgentTokenUsage[];
  cancelled: boolean;
  paused: boolean;
}

/**
 * One `done` token report, in the shape the coordinator stores.
 *
 * The cache-free figure is claimed only when the report's total exceeds its
 * two sides: the excess is cache traffic, so the agent is accounting for
 * cache separately and its input is the uncached part. When the total is
 * exactly input plus output there is no telling a run that used no cache
 * from one that folded its cache into the input figure, and calling the
 * second fresh is what made a long conversation's activity read in the
 * millions. Those reports carry no fresh figure and count as a lower bound.
 */
export function executionTokenUsage(tokens: {
  total: number;
  input?: number;
  output?: number;
}): AgentTokenUsage {
  const { total, input, output } = tokens;
  const cacheAccountedSeparately =
    input !== undefined && output !== undefined && total > input + output;
  return {
    phase: "execution",
    totalTokens: total,
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(cacheAccountedSeparately
      ? { freshTokens: (input ?? 0) + (output ?? 0) }
      : {}),
  };
}

/**
 * Provider-neutral process driver for command-line coding agents.
 *
 * The agent speaks newline-delimited JSON on stdin and stdout. See
 * {@link ./protocol.ts} for the message shapes.
 */
export class GenericCliAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, CliSession>();

  public constructor(private readonly options: GenericCliAdapterOptions) {
    for (const [name, value] of [
      ["requestTimeoutMs", options.requestTimeoutMs],
      ["executionTimeoutMs", options.executionTimeoutMs],
    ] as const) {
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || value < 1)
      ) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
    if (
      options.launch.command.trim().length === 0 ||
      options.launch.command.includes("\0")
    ) {
      throw new Error(
        "Agent command must be non-empty and contain no NUL bytes",
      );
    }
    if (options.launch.args.some((argument) => argument.includes("\0"))) {
      throw new Error("Agent arguments must contain no NUL bytes");
    }
    if (
      Object.values(options.launch.env ?? {}).some(
        (value) => value?.includes("\0") === true,
      )
    ) {
      throw new Error("Agent environment values must contain no NUL bytes");
    }
  }

  public async getCapabilities(): Promise<AgentCapabilities> {
    return {
      canPlan: true,
      canEditFiles: true,
      canRunCommands: true,
      canUseTools: false,
      supportsStreaming: true,
      supportsPause: true,
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
      planningWorkspace: undefined,
      process: undefined,
      plan: undefined,
      context: undefined,
      completion: undefined,
      events: [],
      eventHandlers: new Set(),
      tokenUsage: [],
      cancelled: false,
      paused: false,
    };
    this.sessions.set(session.id, record);

    try {
      if (this.options.planningRoot !== undefined) {
        record.planningWorkspace = await this.options.workspaces.create({
          taskId: `planning-${input.task.id}`,
          rootPath: this.options.planningRoot,
          repository: this.options.repository,
          baseVersion: input.canonicalVersion,
        });
      }
      record.process = this.spawnAgent(record, record.planningWorkspace);
      return session;
    } catch (error) {
      this.sessions.delete(session.id);
      await this.destroyPlanningWorkspace(record);
      throw error;
    }
  }

  public async requestPlan(sessionId: string): Promise<AgentPlan> {
    const record = this.requireSession(sessionId);
    const agent = this.requireProcess(record);

    try {
      agent.send({ type: "plan_request", sessionId });
      const reply = await agent.waitFor(
        "plan",
        this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
      // The model's copy of the task id carries no information: this adapter
      // started the session and knows which task it is for. A transcription slip
      // in a 36-character UUID used to throw away a whole agent run -- measured
      // once in the A/B series, where a replan returned `...-496f-496f-...` for
      // `...-ef4f-496f-...` and the task failed outright. So the id is *set*
      // rather than checked, which makes the binding stronger than trusting the
      // model to echo it: the same treatment the worker already gives `objective`,
      // and for the same reason.
      reply.plan.taskId = record.input.task.id;

      record.plan = reply.plan;
      return structuredClone(reply.plan);
    } catch (error) {
      // A failed or timed-out planning request must not leave an idle child
      // waiting forever for context that the coordinator will never send.
      record.process = undefined;
      agent.kill();
      await agent.close();
      await this.destroyPlanningWorkspace(record);
      throw error;
    }
  }

  public async requestReplan(
    sessionId: string,
    request: ReplanRequest,
  ): Promise<AgentPlan> {
    const record = this.requireSession(sessionId);
    if (request.taskId !== record.input.task.id) {
      throw new AgentProtocolError(
        `Replan request ${request.taskId} does not match ${record.input.task.id}`,
      );
    }
    if (record.context !== undefined) {
      throw new Error(
        `Session ${sessionId} cannot replan after execution context was sent`,
      );
    }

    const previous = record.process;
    record.process = undefined;
    await previous?.close();
    await this.destroyPlanningWorkspace(record);
    record.input = {
      ...record.input,
      canonicalVersion: request.canonicalChange.canonicalVersion,
    };

    try {
      if (this.options.planningRoot !== undefined) {
        record.planningWorkspace = await this.options.workspaces.create({
          taskId: `replanning-${record.input.task.id}`,
          rootPath: this.options.planningRoot,
          repository: this.options.repository,
          baseVersion: request.canonicalChange.canonicalVersion,
        });
        await applyHolderWorkingOverlay(
          record.planningWorkspace.path,
          request.holderWorkingChanges,
        );
      }
      record.process = this.spawnAgent(record, record.planningWorkspace);
      const agent = this.requireProcess(record);
      agent.send({
        type: "replan_request",
        sessionId,
        request,
        ...(record.planningWorkspace === undefined
          ? {}
          : {
              workspacePath:
                this.options.sandbox?.resolveWorkspacePath(
                  record.planningWorkspace,
                ) ?? record.planningWorkspace.path,
            }),
      });
      const reply = await agent.waitFor(
        "plan",
        this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
      // The model's copy of the task id carries no information: this adapter
      // started the session and knows which task it is for. A transcription slip
      // in a 36-character UUID used to throw away a whole agent run -- measured
      // once in the A/B series, where a replan returned `...-496f-496f-...` for
      // `...-ef4f-496f-...` and the task failed outright. So the id is *set*
      // rather than checked, which makes the binding stronger than trusting the
      // model to echo it: the same treatment the worker already gives `objective`,
      // and for the same reason.
      reply.plan.taskId = record.input.task.id;
      record.plan = reply.plan;
      return structuredClone(reply.plan);
    } catch (error) {
      const agent = record.process;
      record.process = undefined;
      agent?.kill();
      await agent?.close();
      await this.destroyPlanningWorkspace(record);
      throw error;
    }
  }

  /**
   * Takes the coordinator's word for what this session may touch, in place of
   * the planning round trip a task alone in its repository does not need.
   */
  public async acceptBlanketClaim(
    sessionId: string,
    plan: AgentPlan,
  ): Promise<void> {
    const record = this.requireSession(sessionId);
    record.plan = structuredClone(plan);
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
      // A process cannot gain a new cwd or container mount after startup.
      // Replace planning with a fresh process tied only to the granted
      // execution workspace.
      if (
        this.options.sandbox !== undefined ||
        record.planningWorkspace !== undefined
      ) {
        await record.process?.close();
        await this.destroyPlanningWorkspace(record);
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
        ...(context.planRevision === undefined
          ? {}
          : { planRevision: context.planRevision }),
      });

      const done = await agent.waitFor(
        "done",
        this.options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
      );
      record.completion = {
        symbolsChanged: done.symbolsChanged,
        explanation: done.explanation,
      };
      if (done.tokens !== undefined) {
        record.tokenUsage.push(executionTokenUsage(done.tokens));
      }
      this.emitEvent(record, {
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

  public async pause(sessionId: string): Promise<void> {
    const record = this.requireSession(sessionId);
    if (record.paused) {
      return;
    }
    this.requireProcess(record).send({ type: "pause", sessionId });
    record.paused = true;
  }

  public async resume(sessionId: string): Promise<void> {
    const record = this.requireSession(sessionId);
    if (!record.paused) {
      return;
    }
    this.requireProcess(record).send({ type: "resume", sessionId });
    record.paused = false;
  }

  public async resolveAction(
    sessionId: string,
    result: AgentActionResult,
  ): Promise<void> {
    const record = this.requireSession(sessionId);
    // Nothing about the plan changes here. An action is the platform doing
    // something on the agent's behalf, not the agent being granted anything —
    // which is exactly why it needs no equivalent of the scope widening below.
    this.requireProcess(record).send({
      type: "action_result",
      sessionId,
      result,
    });
  }

  public async resolveScopeChange(
    sessionId: string,
    decision: ScopeChangeDecision,
  ): Promise<void> {
    const record = this.requireSession(sessionId);
    if (decision.taskId !== record.input.task.id) {
      throw new Error(
        `Scope decision ${decision.taskId} does not match ${record.input.task.id}`,
      );
    }
    // Only a grant widens the plan. A deferral or a refusal leaves the
    // previously approved scope in force, which is what the agent is still
    // held to when its changeset is collected.
    if (scopeChangeGranted(decision)) {
      record.plan = structuredClone(decision.revisedPlan);
    }
    this.requireProcess(record).send({
      type: "scope_decision",
      sessionId,
      decision,
    });
  }

  public async cancel(sessionId: string): Promise<void> {
    const record = this.requireSession(sessionId);
    record.cancelled = true;
    record.eventHandlers.clear();
    const agent = record.process;
    record.process = undefined;
    if (agent !== undefined) {
      try {
        agent.send({ type: "cancel", sessionId });
      } catch {
        // The process may already be gone; the kill below is the real guarantee.
      }
      agent.kill();
      await agent.close();
    }
    await this.destroyPlanningWorkspace(record);
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
        expectedFiles: plan?.expectedFiles ?? [],
        symbolsChanged: [...symbolsChanged],
        riskAssessment: { level: plan?.riskLevel ?? "medium", reasons: [] },
        agentExplanation:
          record.completion.explanation ||
          // The request, not the stored objective: this line is posted into
          // the channel when the agent returned no explanation of its own,
          // and the stored objective would put the coordinator's own role
          // preamble and reply directives in front of the room as if the
          // agent had said them.
          `Generic CLI agent completed ${requestFromObjective(record.input.task.objective)}`,
      },
    );
  }

  public async streamEvents(
    sessionId: string,
    handler: (event: AgentEvent) => void,
  ): Promise<void> {
    const record = this.requireSession(sessionId);
    for (const event of record.events) {
      handler(event);
    }
    if (!record.cancelled && record.completion === undefined) {
      record.eventHandlers.add(handler);
    }
  }

  /** What this session's agent reported spending; empty when it reported none. */
  public reportedTokenUsage(sessionId: string): AgentTokenUsage[] {
    return this.requireSession(sessionId).tokenUsage.map((entry) => ({
      ...entry,
    }));
  }

  private spawnAgent(
    record: CliSession,
    workspace?: TaskWorkspace,
  ): AgentProcess {
    const sandbox = this.options.sandbox;
    const launch =
      workspace === undefined
        ? this.options.launch
        : { ...this.options.launch, cwd: workspace.path };
    const spec =
      sandbox === undefined ? launch : sandbox.wrapLaunch(launch, workspace);

    const agent = new AgentProcess(spec, (event) => {
      this.emitEvent(record, event);
    });
    agent.send({
      type: "start",
      sessionId: record.session.id,
      taskId: record.input.task.id,
      // The stored objective, whole, deliberately. This is the wire
      // contract's copy of the task record rather than a prompt: this adapter
      // builds no prompt of its own, so there is no per-phase seam to strip
      // at, and a third-party agent may echo the field straight back in its
      // plan. If a clean request is wanted here it belongs in an additive
      // sibling field on the protocol, not in a rewrite of this one.
      objective: record.input.task.objective,
      repositoryId: record.input.repositoryId,
      canonicalVersion: record.input.canonicalVersion,
      validationCommands: record.input.task.validationCommands,
      ...(workspace === undefined
        ? {}
        : {
            workspacePath:
              sandbox?.resolveWorkspacePath(workspace) ?? workspace.path,
          }),
    });
    return agent;
  }

  private async destroyPlanningWorkspace(record: CliSession): Promise<void> {
    const workspace = record.planningWorkspace;
    record.planningWorkspace = undefined;
    if (workspace !== undefined) {
      await this.options.workspaces.destroy(workspace);
    }
  }

  private emitEvent(record: CliSession, event: AgentEvent): void {
    if (record.events.length >= MAX_REPLAY_EVENTS) {
      record.events.shift();
    }
    record.events.push(event);
    for (const handler of record.eventHandlers) {
      handler(event);
    }
    if (event.event === "completed") {
      record.eventHandlers.clear();
    }
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

/**
 * Overlay a holder's in-progress edits onto a planning worktree built from
 * canonical. Speculative only — the holder still owns the files.
 */
async function applyHolderWorkingOverlay(
  workspacePath: string,
  changes: readonly HolderWorkingChange[] | undefined,
): Promise<void> {
  if (changes === undefined || changes.length === 0) {
    return;
  }
  for (const change of changes) {
    const target = path.join(workspacePath, change.path);
    if (change.status === "deleted") {
      await rm(target, { force: true });
      continue;
    }
    if (change.absolutePath === undefined) {
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(change.absolutePath, target);
  }
}
