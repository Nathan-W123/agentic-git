import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type AgentAdapter,
  type AgentCapabilities,
  type AgentEvent,
  type AgentSession,
  type AgentTokenUsage,
  type CoordinatorContext,
  type StartTaskInput,
} from "@coord/agent-protocol";
import {
  assertAgentPlan,
  createId,
  readsAsReportRequest,
  scopeChangeGranted,
  substituteGroundedNames,
  type AgentPlan,
  type ChangeSet,
  type ReplanRequest,
  type ScopeChangeDecision,
} from "@coord/shared-types";
import {
  runProcess,
  type CanonicalRepository,
  type ProcessOptions,
  type ProcessOutput,
} from "@coord/repository-service";
import type {
  TaskWorkspace,
  WorkspaceManager,
} from "@coord/workspace-manager";

const DEFAULT_PLANNING_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_REPLAY_EVENTS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  // OpenAI structured outputs run in strict mode: `required` must name every
  // key in `properties`, at every object level, or the API rejects the request
  // with `invalid_json_schema` before the model is ever called. Fields that are
  // logically optional are satisfied with an empty array or string instead.
  required: [
    "taskId",
    "objective",
    "expectedFiles",
    "expectedSymbols",
    "expectedApis",
    "expectedSchemas",
    "expectedConfigKeys",
    "expectedTests",
    "expectedServices",
    "dependencies",
    "commands",
    "externalAccess",
    "riskLevel",
    "intent",
  ],
  properties: {
    taskId: { type: "string" },
    objective: { type: "string" },
    expectedFiles: { type: "array", items: { type: "string" } },
    expectedSymbols: { type: "array", items: { type: "string" } },
    expectedApis: { type: "array", items: { type: "string" } },
    expectedSchemas: { type: "array", items: { type: "string" } },
    expectedConfigKeys: { type: "array", items: { type: "string" } },
    expectedTests: { type: "array", items: { type: "string" } },
    expectedServices: { type: "array", items: { type: "string" } },
    dependencies: { type: "array", items: { type: "string" } },
    commands: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["executable", "args", "label"],
        properties: {
          executable: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          label: { type: "string" },
        },
      },
    },
    externalAccess: { type: "array", items: { type: "string" } },
    riskLevel: {
      type: "string",
      enum: ["low", "medium", "high", "critical"],
    },
    intent: { type: "string" },
  },
} as const;

const COMPLETION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "outcome",
    "symbolsChanged",
    "explanation",
    "requestId",
    "additionalFiles",
    "additionalSymbols",
    "additionalApis",
    "additionalSchemas",
    "additionalConfigKeys",
    "additionalTests",
    "additionalServices",
    "reason",
  ],
  properties: {
    outcome: {
      type: "string",
      enum: ["completed", "scope_change_requested"],
    },
    symbolsChanged: { type: "array", items: { type: "string" } },
    explanation: { type: "string" },
    requestId: { type: "string" },
    additionalFiles: { type: "array", items: { type: "string" } },
    additionalSymbols: { type: "array", items: { type: "string" } },
    additionalApis: { type: "array", items: { type: "string" } },
    additionalSchemas: { type: "array", items: { type: "string" } },
    additionalConfigKeys: { type: "array", items: { type: "string" } },
    additionalTests: { type: "array", items: { type: "string" } },
    additionalServices: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
} as const;

export type CodexProcessRunner = (
  executable: string,
  args: readonly string[],
  options?: ProcessOptions,
) => Promise<ProcessOutput>;

export interface CodexAdapterOptions {
  agentId: string;
  repository: CanonicalRepository;
  workspaces: WorkspaceManager;
  /** Disposable read-only worktrees used while Codex prepares plans. */
  planningRoot: string;
  command?: string;
  /**
   * Optional safe Codex arguments. Only `--model <id>` / `-m <id>` are
   * accepted so project configuration cannot weaken the enforced sandbox.
   */
  args?: readonly string[];
  /**
   * Reasoning level, as Codex's own `model_reasoning_effort` configuration.
   *
   * A `-c` override rather than a flag because that is the surface Codex
   * exposes it on, and the same one the chat path already drives it through.
   * The vocabulary is the model's, not ours: whatever the CLI accepts for the
   * selected model is what works, so this is passed through as given and a
   * level the model does not know is refused by Codex rather than here.
   */
  effort?: string;
  env?: NodeJS.ProcessEnv;
  planningTimeoutMs?: number;
  executionTimeoutMs?: number;
  maxOutputBytes?: number;
  ignoreUserConfig?: boolean;
  /**
   * Native Windows sandbox backend. The stronger `elevated` backend is the
   * default; `unelevated` remains scoped but is available when local policy
   * blocks the administrator-approved setup.
   */
  windowsSandbox?: CodexWindowsSandbox;
  /** Native platform override used by embedders and cross-platform tests. */
  platform?: NodeJS.Platform;
  /**
   * Sandbox Codex runs the edit phase under. Defaults to `workspace-write`,
   * which confines writes to the task workspace.
   *
   * `danger-full-access` removes Codex's own confinement entirely and is only
   * appropriate where the workspace is already isolated by other means. It
   * exists because platforms without a sandbox helper cannot honour
   * `workspace-write` at all; see {@link CodexWriteDeniedError}.
   */
  executionSandbox?: CodexExecutionSandbox;
  runner?: CodexProcessRunner;
}

export type CodexExecutionSandbox = "workspace-write" | "danger-full-access";
export type CodexWindowsSandbox = "elevated" | "unelevated";

interface CodexCompletion {
  outcome: "completed";
  symbolsChanged: string[];
  explanation: string;
}

interface CodexScopeChange {
  outcome: "scope_change_requested";
  requestId: string;
  additionalFiles: string[];
  additionalSymbols: string[];
  additionalApis: string[];
  additionalSchemas: string[];
  additionalConfigKeys: string[];
  additionalTests: string[];
  additionalServices: string[];
  reason: string;
  symbolsChanged: string[];
  explanation: string;
}

type CodexExecutionResult = CodexCompletion | CodexScopeChange;

interface CodexSession {
  session: AgentSession;
  input: StartTaskInput;
  planningWorkspace: TaskWorkspace | undefined;
  plan: AgentPlan | undefined;
  context: CoordinatorContext | undefined;
  completion: CodexCompletion | undefined;
  events: AgentEvent[];
  eventHandlers: Set<(event: AgentEvent) => void>;
  controller: AbortController | undefined;
  active: Promise<ProcessOutput> | undefined;
  scopeDecisions: ScopeChangeDecision[];
  /** One entry per `codex exec` invocation this session made. */
  tokenUsage: CodexTokenUsage[];
  /**
   * The newest thread id this session's execs reported — what an
   * `exec resume` would pick up. Overwritten after every successful exec,
   * because a resumed run forks a fresh id; cleared when a resume attempt
   * turns out stale. Always undefined for an ephemeral (one-shot) session.
   */
  resume: string | undefined;
  pendingScope: Map<
    string,
    {
      promise: Promise<ScopeChangeDecision>;
      resolve: (decision: ScopeChangeDecision) => void;
      reject: (error: Error) => void;
    }
  >;
  cancelled: boolean;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return resolved;
}

/**
 * A reasoning level safe to interpolate into a `-c key="value"` override.
 *
 * The value is quoted into a config expression, so anything that could close
 * the quote or start a second setting is refused outright rather than
 * escaped — the vocabulary is a bare word in every vendor that has one, and a
 * level needing more than that is a level worth rejecting.
 */
function safeEffort(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const effort = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(effort)) {
    throw new Error(
      `Codex adapter reasoning effort must be a bare word: ${effort}`,
    );
  }
  return effort;
}

function safeAdditionalArgs(values: readonly string[]): string[] {
  const resolved: string[] = [];
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (
      (flag !== "--model" && flag !== "-m") ||
      value === undefined ||
      value.trim().length === 0 ||
      value.includes("\0")
    ) {
      throw new Error(
        "Codex adapter args accept only complete --model <id> pairs",
      );
    }
    resolved.push(flag, value);
  }
  return resolved;
}

/**
 * Signatures Codex emits when it accepted the run but could not write.
 *
 * `--sandbox workspace-write` needs a platform sandbox backend. If that
 * backend is unavailable or misconfigured, Codex can degrade to a read-only
 * filesystem, refuse every patch, and still exit 0 reporting the task
 * complete. Left undetected that produces an empty changeset presented as
 * success, which is worse than a crash.
 */
const WRITE_DENIED_SIGNATURES = [
  "writing is blocked by read-only sandbox",
  "workspace is read-only",
  "missing sandbox helper",
  "failed to write file",
];

export class CodexWriteDeniedError extends Error {
  public constructor(sandbox: string, detail: string) {
    super(
      `Codex could not write to the workspace under --sandbox ${sandbox}. ` +
        "The scoped-write sandbox is unavailable or misconfigured, so every " +
        "edit was rejected while Codex still reported success. Run `codex doctor` " +
        "to confirm the native sandbox setup, and only set executionSandbox to " +
        "\"danger-full-access\" when the workspace is already isolated by other " +
        `means, such as a container. Codex reported: ${detail}`,
    );
    this.name = "CodexWriteDeniedError";
  }
}

/** Fails loudly when a write-phase run was denied rather than completed. */
function assertWritesPermitted(
  sandbox: string,
  output: ProcessOutput,
): void {
  if (sandbox === "read-only") {
    return;
  }
  const haystack = `${output.stdout}\n${output.stderr}`.toLowerCase();
  const matched = WRITE_DENIED_SIGNATURES.find((signature) =>
    haystack.includes(signature),
  );
  if (matched !== undefined) {
    throw new CodexWriteDeniedError(sandbox, matched);
  }
}

/**
 * What one `codex exec` invocation cost.
 *
 * Codex reports a single aggregate figure on stdout rather than an
 * input/output/reasoning split, so that is what is recorded — inventing a
 * breakdown it never reported would be worse than reporting one number.
 */
export interface CodexTokenUsage {
  phase: CodexPhase;
  tokens: number;
  durationMs: number;
  at: string;
}

export type CodexPhase = "planning" | "replanning" | "execution";

/**
 * Pulls the token count out of a `codex exec` transcript.
 *
 * The CLI prints it as a `tokens used` line followed by the figure, grouped
 * with thousands separators. It lands on stderr whenever `--output-schema`
 * reserves stdout for the structured result, and on stdout otherwise, so
 * callers should offer both. Returns undefined rather than zero when the line
 * is absent: "not reported" and "cost nothing" are different claims, and a
 * total built from the second would be quietly wrong.
 */
export function parseCodexTokens(output: string): number | undefined {
  const match = /tokens\s+used\s+([\d,]+)/iu.exec(output);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const tokens = Number.parseInt(match[1].replaceAll(",", ""), 10);
  return Number.isSafeInteger(tokens) ? tokens : undefined;
}

/**
 * The shape Codex thread ids take, checked before one ever reaches an argv.
 * Same rule the chat providers and the Claude profile apply: the id is our
 * own CLI's output, but a malformed one fed back through `exec resume` buys
 * a confusing failure later, and refusing it costs only the warmth.
 */
const CODEX_THREAD_ID = /^[A-Za-z0-9-]{8,64}$/u;

/**
 * Pulls the session/thread id out of a `codex exec` transcript.
 *
 * A persisted run names its thread in the banner, the way it prints its
 * token figure — on stderr when `--output-schema` reserves stdout, on stdout
 * otherwise, so callers should offer both. Tolerant on the label because the
 * banner is prose, not a contract, and tolerant of absence because an
 * `--ephemeral` run persists nothing and prints nothing: a turn that cannot
 * be resumed is still a turn that worked.
 */
export function parseCodexSessionId(output: string): string | undefined {
  const match = /(?:session|thread)\s*id[:\s]+([A-Za-z0-9-]{8,64})\b/iu.exec(
    output,
  );
  const thread = match?.[1];
  return thread !== undefined && CODEX_THREAD_ID.test(thread)
    ? thread
    : undefined;
}

function parseJsonObject(output: string, operation: string): unknown {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    throw new Error(`Codex returned no structured output while ${operation}`);
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new Error(
      `Codex returned invalid structured output while ${operation}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
  );
}

function assertExecutionResult(
  value: unknown,
): asserts value is CodexExecutionResult {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Codex execution result must be an object");
  }
  const completion = value as Partial<CodexExecutionResult>;
  if (
    !stringArray(completion.symbolsChanged) ||
    typeof completion.explanation !== "string"
  ) {
    throw new TypeError("Codex execution result does not match the output schema");
  }
  if (completion.outcome === "completed") {
    return;
  }
  if (
    completion.outcome !== "scope_change_requested" ||
    typeof completion.requestId !== "string" ||
    !stringArray(completion.additionalFiles) ||
    !stringArray(completion.additionalSymbols) ||
    !stringArray(completion.additionalApis) ||
    !stringArray(completion.additionalSchemas) ||
    !stringArray(completion.additionalConfigKeys) ||
    !stringArray(completion.additionalTests) ||
    !stringArray(completion.additionalServices) ||
    typeof completion.reason !== "string"
  ) {
    throw new TypeError("Codex scope change does not match the output schema");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Direct driver for the supported non-interactive Codex CLI surface.
 *
 * Planning and execution are separate ephemeral `codex exec` calls. Planning
 * receives a disposable worktree under a read-only sandbox; execution receives
 * only the coordinator-granted task worktree under `workspace-write`.
 */
export class CodexAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, CodexSession>();
  private readonly command: string;
  private readonly executionSandbox: CodexExecutionSandbox;
  private readonly windowsSandbox: CodexWindowsSandbox;
  private readonly platform: NodeJS.Platform;
  private readonly additionalArgs: string[];
  private readonly effort: string | undefined;
  private readonly planningTimeoutMs: number;
  private readonly executionTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly runner: CodexProcessRunner;

  public constructor(private readonly options: CodexAdapterOptions) {
    this.command = options.command?.trim() || "codex";
    this.additionalArgs = safeAdditionalArgs(options.args ?? []);
    this.effort = safeEffort(options.effort);
    this.planningTimeoutMs = positiveInteger(
      options.planningTimeoutMs,
      DEFAULT_PLANNING_TIMEOUT_MS,
      "Codex planning timeout",
    );
    this.executionTimeoutMs = positiveInteger(
      options.executionTimeoutMs,
      DEFAULT_EXECUTION_TIMEOUT_MS,
      "Codex execution timeout",
    );
    this.maxOutputBytes = positiveInteger(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      "Codex output limit",
    );
    this.executionSandbox = options.executionSandbox ?? "workspace-write";
    this.windowsSandbox = options.windowsSandbox ?? "elevated";
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? runProcess;
  }

  public async getCapabilities(): Promise<AgentCapabilities> {
    return {
      canPlan: true,
      canEditFiles: true,
      canRunCommands: true,
      canUseTools: true,
      supportsStreaming: true,
      supportsPause: false,
    };
  }

  public async startTask(input: StartTaskInput): Promise<AgentSession> {
    if (input.repositoryId !== this.options.repository.id) {
      throw new Error(
        `Codex adapter for ${this.options.repository.id} cannot start a task for ${input.repositoryId}`,
      );
    }

    const planningWorkspace = await this.options.workspaces.create({
      taskId: `planning-${input.task.id}`,
      rootPath: path.resolve(this.options.planningRoot),
      repository: this.options.repository,
      baseVersion: input.canonicalVersion,
    });
    const session: AgentSession = {
      id: createId("session"),
      agentId: this.options.agentId,
      taskId: input.task.id,
      startedAt: new Date().toISOString(),
    };
    const record: CodexSession = {
      session,
      input,
      planningWorkspace,
      plan: undefined,
      context: undefined,
      completion: undefined,
      events: [],
      eventHandlers: new Set(),
      controller: undefined,
      active: undefined,
      scopeDecisions: [],
      tokenUsage: [],
      pendingScope: new Map(),
      resume: undefined,
      cancelled: false,
    };
    this.sessions.set(session.id, record);
    this.emit(record, {
      event: "progress",
      message: "Codex planning workspace prepared",
      occurredAt: new Date().toISOString(),
    });
    return session;
  }

  /**
   * Continues a session as the next turn of its conversation. The whole
   * record travels because this instance may never have seen the session —
   * a conversational codex turn persists its thread on the vendor's side,
   * named by the record's `resume` token, and adopting it is building a
   * fresh per-turn record around that name. Everything per-turn resets
   * exactly as `startTask` would leave it; the identity, the token, and
   * (same-instance) the cumulative token usage carry.
   */
  public async continueTask(
    session: AgentSession,
    input: StartTaskInput,
  ): Promise<AgentSession> {
    if (input.repositoryId !== this.options.repository.id) {
      throw new Error(
        `Codex adapter for ${this.options.repository.id} cannot continue a task for ${input.repositoryId}`,
      );
    }
    const existing = this.sessions.get(session.id);
    if (existing?.cancelled === true) {
      throw new Error(`Session ${session.id} was cancelled`);
    }
    const planningWorkspace = await this.options.workspaces.create({
      taskId: `continuing-${input.task.id}`,
      rootPath: path.resolve(this.options.planningRoot),
      repository: this.options.repository,
      baseVersion: input.canonicalVersion,
    });
    // This instance's own memory of the session wins when it has one — it is
    // at least as fresh as what the platform retained at the last settlement.
    const resume = existing?.resume ?? session.resume;
    const continued: AgentSession = {
      id: session.id,
      agentId: this.options.agentId,
      taskId: input.task.id,
      startedAt: session.startedAt,
      ...(resume === undefined ? {} : { resume }),
    };
    const record: CodexSession = {
      session: continued,
      input,
      planningWorkspace,
      plan: undefined,
      context: undefined,
      completion: undefined,
      events: [],
      eventHandlers: new Set(),
      controller: undefined,
      active: undefined,
      scopeDecisions: [],
      tokenUsage: existing?.tokenUsage ?? [],
      pendingScope: new Map(),
      resume,
      cancelled: false,
    };
    this.sessions.set(session.id, record);
    this.emit(record, {
      event: "progress",
      message:
        resume === undefined
          ? "Codex continuing the conversation cold"
          : "Codex resuming the conversation",
      occurredAt: new Date().toISOString(),
    });
    return continued;
  }

  public resumeToken(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.resume;
  }

  public async requestPlan(sessionId: string): Promise<AgentPlan> {
    const record = this.requireSession(sessionId);
    const workspace = record.planningWorkspace;
    if (workspace === undefined) {
      throw new Error(`Session ${sessionId} has no planning workspace`);
    }

    try {
      const output = await this.withSchema(
        PLAN_SCHEMA,
        async (schemaPath) =>
          await this.runCodex(
            record,
            workspace.path,
            "read-only",
            schemaPath,
            this.planPrompt(record.input),
            this.planningTimeoutMs,
            "planning",
          ),
      );
      const plan = parseJsonObject(output, "planning");
      assertAgentPlan(plan);
      // The model's copy of the task id carries no information: this adapter
      // started the session and knows which task it is for. A transcription slip
      // in a 36-character UUID used to throw away a whole agent run -- measured
      // once in the A/B series, where a replan returned `...-496f-496f-...` for
      // `...-ef4f-496f-...` and the task failed outright. So the id is *set*
      // rather than checked, which makes the binding stronger than trusting the
      // model to echo it: the same treatment the worker already gives `objective`,
      // and for the same reason.
      plan.taskId = record.input.task.id;
      record.plan = plan;
      this.emit(record, {
        event: "progress",
        message: `Codex planned ${plan.expectedFiles.length} file(s)`,
        occurredAt: new Date().toISOString(),
      });
      return structuredClone(plan);
    } catch (error) {
      try {
        await this.destroyPlanningWorkspace(record);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Codex planning and workspace cleanup failed for ${record.input.task.id}`,
        );
      }
      throw error;
    }
  }

  public async requestReplan(
    sessionId: string,
    request: ReplanRequest,
  ): Promise<AgentPlan> {
    const record = this.requireSession(sessionId);
    if (record.context !== undefined) {
      throw new Error(
        `Session ${sessionId} cannot replan after execution context was sent`,
      );
    }
    if (request.taskId !== record.input.task.id) {
      throw new Error(
        `Replan request ${request.taskId} does not match ${record.input.task.id}`,
      );
    }
    await this.destroyPlanningWorkspace(record);
    record.input = {
      ...record.input,
      canonicalVersion: request.canonicalChange.canonicalVersion,
    };
    record.planningWorkspace = await this.options.workspaces.create({
      taskId: `replanning-${record.input.task.id}`,
      rootPath: path.resolve(this.options.planningRoot),
      repository: this.options.repository,
      baseVersion: request.canonicalChange.canonicalVersion,
    });

    try {
      const output = await this.withSchema(
        PLAN_SCHEMA,
        async (schemaPath) =>
          await this.runCodex(
            record,
            record.planningWorkspace?.path ?? "",
            "read-only",
            schemaPath,
            this.replanPrompt(record, request),
            this.planningTimeoutMs,
            "replanning",
          ),
      );
      const plan = parseJsonObject(output, "replanning");
      assertAgentPlan(plan);
      // The model's copy of the task id carries no information: this adapter
      // started the session and knows which task it is for. A transcription slip
      // in a 36-character UUID used to throw away a whole agent run -- measured
      // once in the A/B series, where a replan returned `...-496f-496f-...` for
      // `...-ef4f-496f-...` and the task failed outright. So the id is *set*
      // rather than checked, which makes the binding stronger than trusting the
      // model to echo it: the same treatment the worker already gives `objective`,
      // and for the same reason.
      plan.taskId = record.input.task.id;
      record.plan = plan;
      this.emit(record, {
        event: "progress",
        message: `Codex revised its plan for canonical ${request.canonicalChange.canonicalVersion.revision.slice(0, 12)}`,
        occurredAt: new Date().toISOString(),
      });
      return structuredClone(plan);
    } catch (error) {
      try {
        await this.destroyPlanningWorkspace(record);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Codex replanning and cleanup failed for ${record.input.task.id}`,
        );
      }
      throw error;
    }
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
    if (context.decision.taskId !== record.input.task.id) {
      throw new Error(
        `Coordinator context for ${context.decision.taskId} does not match ${record.input.task.id}`,
      );
    }

    await this.destroyPlanningWorkspace(record);
    record.context = context;
    this.emit(record, {
      event: "progress",
      message: "Codex execution started",
      occurredAt: new Date().toISOString(),
    });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const output = await this.withSchema(
        COMPLETION_SCHEMA,
        async (schemaPath) =>
          await this.runCodex(
            record,
            context.workspacePath,
            this.executionSandbox,
            schemaPath,
            this.executionPrompt(record, context),
            this.executionTimeoutMs,
            "execution",
          ),
      );
      const execution = parseJsonObject(output, "executing the task");
      assertExecutionResult(execution);
      if (execution.outcome === "completed") {
        record.completion = {
          outcome: "completed",
          symbolsChanged: [...new Set(execution.symbolsChanged)],
          explanation: execution.explanation,
        };
        this.emit(record, {
          event: "completed",
          occurredAt: new Date().toISOString(),
        });
        return;
      }

      const requestId = execution.requestId.trim() || createId("scope");
      const pending = this.createScopeWaiter(record, requestId);
      this.emit(record, {
        event: "scope_change_requested",
        requestId,
        additionalFiles: [...execution.additionalFiles],
        additionalSymbols: [...execution.additionalSymbols],
        additionalApis: [...execution.additionalApis],
        additionalSchemas: [...execution.additionalSchemas],
        additionalConfigKeys: [...execution.additionalConfigKeys],
        additionalTests: [...execution.additionalTests],
        additionalServices: [...execution.additionalServices],
        reason: execution.reason,
        occurredAt: new Date().toISOString(),
      });
      const decision = await pending;
      record.scopeDecisions.push(structuredClone(decision));
      if (scopeChangeGranted(decision)) {
        record.plan = structuredClone(decision.revisedPlan);
      }
      this.emit(record, {
        event: "progress",
        message:
          `Scope request ${requestId} was ${decision.decision}; ` +
          "Codex execution is continuing",
        occurredAt: new Date().toISOString(),
      });
    }
    throw new Error(
      `Codex exceeded the maximum scope-change rounds for ${record.input.task.id}`,
    );
  }

  /**
   * What each `codex exec` call for this session cost, in order.
   *
   * Reported rather than summed so a caller can see where the spend went —
   * a plan that had to be redone and an execution that ran twice for a scope
   * change are different stories, and both are invisible in a single total.
   */
  public tokenUsage(sessionId: string): CodexTokenUsage[] {
    return [...this.requireSession(sessionId).tokenUsage];
  }

  /**
   * Every session this adapter instance drove.
   *
   * Sessions outlive `collectChanges`, so a harness can total the cost after
   * the work is finished without holding each session id itself.
   */
  public allTokenUsage(): Array<CodexTokenUsage & { sessionId: string; taskId: string }> {
    return [...this.sessions.values()].flatMap((record) =>
      record.tokenUsage.map((entry) => ({
        ...entry,
        sessionId: record.session.id,
        taskId: record.input.task.id,
      })),
    );
  }

  /** Total tokens across every session this adapter drove. */
  public totalTokens(): number {
    return this.allTokenUsage().reduce((sum, entry) => sum + entry.tokens, 0);
  }

  /**
   * The protocol-shaped view of {@link tokenUsage}, for cost accounting.
   *
   * Replanning is charged to planning: the coordinator's budgets are about
   * what a task cost, and the finer story — a plan that had to be redone
   * versus one that did not — stays available in {@link tokenUsage} for
   * anyone asking that question instead.
   */
  public reportedTokenUsage(sessionId: string): AgentTokenUsage[] {
    const totals = new Map<AgentTokenUsage["phase"], number>();
    for (const entry of this.requireSession(sessionId).tokenUsage) {
      const phase = entry.phase === "execution" ? "execution" : "planning";
      totals.set(phase, (totals.get(phase) ?? 0) + entry.tokens);
    }
    return [...totals].map(([phase, totalTokens]) => ({ phase, totalTokens }));
  }

  public async pause(_sessionId: string): Promise<void> {
    throw new Error("CodexAdapter does not support pausing ephemeral executions");
  }

  public async resume(_sessionId: string): Promise<void> {
    throw new Error("CodexAdapter does not support resuming ephemeral executions");
  }

  public async resolveScopeChange(
    sessionId: string,
    decision: ScopeChangeDecision,
  ): Promise<void> {
    const record = this.requireSession(sessionId);
    const pending = record.pendingScope.get(decision.requestId);
    if (pending === undefined) {
      throw new Error(
        `Codex session ${sessionId} has no pending scope request ${decision.requestId}`,
      );
    }
    record.pendingScope.delete(decision.requestId);
    pending.resolve(structuredClone(decision));
  }

  public async cancel(sessionId: string): Promise<void> {
    const record = this.requireSession(sessionId);
    record.cancelled = true;
    record.eventHandlers.clear();
    for (const pending of record.pendingScope.values()) {
      pending.reject(new Error(`Session ${sessionId} was cancelled`));
    }
    record.pendingScope.clear();
    record.controller?.abort();
    const active = record.active;
    if (active !== undefined) {
      try {
        await active;
      } catch {
        // The operation that owns the process reports its own failure.
      }
    }
    await this.destroyPlanningWorkspace(record);
  }

  public async collectChanges(sessionId: string): Promise<ChangeSet> {
    const record = this.requireSession(sessionId);
    const context = record.context;
    const completion = record.completion;
    const plan = record.plan;
    if (context === undefined) {
      throw new Error(`Session ${sessionId} has not received a workspace`);
    }
    if (completion === undefined || plan === undefined) {
      throw new Error(`Session ${sessionId} has not completed execution`);
    }

    const workspace: TaskWorkspace = {
      id: context.decision.workspaceId ?? createId("workspace"),
      taskId: record.input.task.id,
      path: context.workspacePath,
      rootPath: context.workspacePath,
      repository: this.options.repository,
      baseVersion: context.canonicalVersion,
      isolation: "git-worktree",
      createdAt: record.session.startedAt,
    };
    const changeSet = await this.options.workspaces.collectChangeSet(workspace, {
      expectedFiles: plan.expectedFiles,
      symbolsChanged:
        completion.symbolsChanged.length === 0
          ? plan.expectedSymbols
          : completion.symbolsChanged,
      riskAssessment: { level: plan.riskLevel, reasons: [] },
      agentExplanation:
        completion.explanation ||
        `Codex completed ${record.input.task.objective}`,
    });

    // Codex reported the task done, yet the workspace is untouched. For work
    // that was meant to write, every known cause is a defect — a denied write,
    // a sandbox that dropped the edits, or a model that answered without
    // acting — and letting it through would put a no-op into the pipeline as a
    // successful task.
    //
    // Asked to look rather than to change, the same result is the answer. An
    // audit, a summary or a question about the code succeeds precisely by
    // changing nothing, and this refusal was what turned each of those into
    // "complete but changed no files" — a failure reported for work that had
    // been done. The request decides which it is, on the same reading the
    // integration path uses, so the two ends cannot disagree.
    if (
      changeSet.patches.length === 0 &&
      !readsAsReportRequest(record.input.task.objective)
    ) {
      throw new Error(
        `Codex reported ${record.input.task.id} complete but changed no files. ` +
          "The edit phase produced nothing; check that the execution sandbox " +
          "permits writes before treating this as an empty task.",
      );
    }
    return changeSet;
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

  private createScopeWaiter(
    record: CodexSession,
    requestId: string,
  ): Promise<ScopeChangeDecision> {
    if (record.pendingScope.has(requestId)) {
      throw new Error(`Codex repeated pending scope request ${requestId}`);
    }
    let resolvePromise: (decision: ScopeChangeDecision) => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const promise = new Promise<ScopeChangeDecision>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timer = setTimeout(() => {
      record.pendingScope.delete(requestId);
      rejectPromise(
        new Error(
          `Timed out waiting for a decision on scope request ${requestId}`,
        ),
      );
    }, this.executionTimeoutMs);
    const resolve = (decision: ScopeChangeDecision): void => {
      clearTimeout(timer);
      resolvePromise(decision);
    };
    const reject = (error: Error): void => {
      clearTimeout(timer);
      rejectPromise(error);
    };
    record.pendingScope.set(requestId, { promise, resolve, reject });
    return promise;
  }

  private async runCodex(
    record: CodexSession,
    workingDirectory: string,
    sandbox: "read-only" | CodexExecutionSandbox,
    schemaPath: string,
    prompt: string,
    timeoutMs: number,
    phase: CodexPhase,
  ): Promise<string> {
    if (record.active !== undefined) {
      throw new Error(`Session ${record.session.id} already has an active Codex process`);
    }
    if (record.cancelled) {
      throw new Error(`Session ${record.session.id} was cancelled`);
    }

    // Hermetic by default, persistent for a conversation. `--ephemeral` is
    // the right posture for a task that runs once — nothing worth
    // remembering, nothing left on the host — and exactly wrong for a turn
    // whose next turn wants the thread back. Read off `record.input`, which
    // replans rebind, so the posture survives a replan.
    const conversational = record.input.conversational === true;
    const args = [
      "exec",
      ...this.additionalArgs,
      ...(conversational ? [] : ["--ephemeral"]),
      "--sandbox",
      sandbox,
      "--color",
      "never",
      ...(this.options.ignoreUserConfig ?? true
        ? ["--ignore-user-config"]
        : []),
      ...(this.platform === "win32"
        ? ["-c", `windows.sandbox="${this.windowsSandbox}"`]
        : []),
      ...(this.effort === undefined
        ? []
        : ["-c", `model_reasoning_effort="${this.effort}"`]),
      "-C",
      workingDirectory,
      "--output-schema",
      schemaPath,
      "-",
    ];
    // A held thread id rides every invocation of a conversational session —
    // planning, replanning and each execution round — as the `exec resume`
    // subcommand, whose flag surface is narrower than a fresh exec's: the
    // sandbox travels as `-c` configuration and `-C` is dropped (the
    // process's own cwd already points at the right directory), the shape
    // the chat providers proved. The prompt stays on stdin either way.
    const resume = record.resume;
    const resumeArgs =
      conversational && resume !== undefined
        ? [
            "exec",
            "resume",
            resume,
            "-c",
            `sandbox_mode="${sandbox}"`,
            ...(this.platform === "win32"
              ? ["-c", `windows.sandbox="${this.windowsSandbox}"`]
              : []),
            ...(this.effort === undefined
              ? []
              : ["-c", `model_reasoning_effort="${this.effort}"`]),
            "--output-schema",
            schemaPath,
            "-",
          ]
        : undefined;
    let output = await this.spawnCodex(
      record,
      workingDirectory,
      resumeArgs ?? args,
      prompt,
      timeoutMs,
    );
    if (
      output.exitCode !== 0 &&
      resumeArgs !== undefined &&
      output.aborted !== true &&
      output.timedOut !== true
    ) {
      // A stale thread id — a restart, a CODEX_HOME that did not survive the
      // gap between turns, an `exec resume` surface that refuses a flag —
      // costs the conversation its memory, never the turn: retried once as
      // a fresh exec, the same policy the chat providers and the Claude
      // profile apply. The token is dropped first, so a later round in this
      // same turn does not repeat the failure.
      record.resume = undefined;
      output = await this.spawnCodex(
        record,
        workingDirectory,
        args,
        prompt,
        timeoutMs,
      );
    }
    if (output.exitCode !== 0) {
      const reason =
        output.stderr.trim() ||
        output.stdout.trim() ||
        `exit code ${output.exitCode}`;
      throw new Error(`Codex ${sandbox} execution failed: ${reason}`);
    }
    if (output.stdoutTruncated === true) {
      throw new Error("Codex structured output exceeded the configured limit");
    }
    assertWritesPermitted(sandbox, output);
    // Under `--output-schema` stdout carries nothing but the structured
    // result, and Codex prints its banner and its own cost to stderr. Both
    // streams are searched because a bare invocation without a schema puts the
    // figure on stdout instead, and reading only the wrong one would silently
    // report every run as costing nothing.
    const tokens =
      parseCodexTokens(output.stderr) ?? parseCodexTokens(output.stdout);
    if (tokens !== undefined) {
      record.tokenUsage.push({
        phase,
        tokens,
        durationMs: output.durationMs,
        at: new Date().toISOString(),
      });
    }
    // Overwritten, never written once: a resumed run forks a fresh thread
    // id, and the newest names the state as this invocation left it. An
    // ephemeral run prints none and contributes nothing.
    const thread =
      parseCodexSessionId(output.stderr) ?? parseCodexSessionId(output.stdout);
    if (thread !== undefined) {
      record.resume = thread;
    }
    return output.stdout;
  }

  /** One process, with the record's active/controller bookkeeping around it. */
  private async spawnCodex(
    record: CodexSession,
    workingDirectory: string,
    argv: string[],
    prompt: string,
    timeoutMs: number,
  ): Promise<ProcessOutput> {
    const controller = new AbortController();
    record.controller = controller;
    const active = this.runner(this.command, argv, {
      cwd: workingDirectory,
      input: prompt,
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      signal: controller.signal,
    });
    record.active = active;
    try {
      return await active;
    } finally {
      if (record.active === active) {
        record.active = undefined;
        record.controller = undefined;
      }
    }
  }

  private async withSchema<T>(
    schema: Readonly<Record<string, unknown>>,
    run: (schemaPath: string) => Promise<T>,
  ): Promise<T> {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "coord-codex-schema-"),
    );
    const schemaPath = path.join(directory, "output-schema.json");
    try {
      await writeFile(schemaPath, JSON.stringify(schema), "utf8");
      return await run(schemaPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async destroyPlanningWorkspace(record: CodexSession): Promise<void> {
    const workspace = record.planningWorkspace;
    record.planningWorkspace = undefined;
    if (workspace !== undefined) {
      await this.options.workspaces.destroy(workspace);
    }
  }

  private planPrompt(input: StartTaskInput): string {
    return [
      "Inspect the repository and prepare a coordination plan.",
      "Do not edit files. Do not run commands that modify repository state.",
      "Keep planning focused: inspect only enough files to establish an accurate scope.",
      `Planning deadline: ${this.planningTimeoutMs} ms.`,
      "Return only the JSON object required by the output schema.",
      `Task id: ${input.task.id}`,
      `Objective: ${input.task.objective}`,
      // What earlier tasks in this repository already worked out. Advisory:
      // it was true at an earlier revision, and the workspace is what is true
      // now — so it is labelled as notes rather than as fact.
      ...(input.priorContext === undefined || input.priorContext.trim() === ""
        ? []
        : [
            "Notes left by earlier work in this repository. Treat as background,",
            "not as fact — verify anything you rely on against the workspace:",
            input.priorContext.trim(),
          ]),
      `Canonical revision: ${input.canonicalVersion.revision}`,
      `Required validation commands: ${JSON.stringify(input.task.validationCommands)}`,
      "List every repository-relative file you expect to change.",
      "List affected symbols, APIs, schemas, configuration keys, tests, and services.",
      "State a concise intent that distinguishes adding, removing, enabling, or disabling behavior.",
      "List external access honestly; the execution sandbox may deny it.",
    ].join("\n");
  }

  /**
   * The previous plan as the agent should see it, and what was corrected.
   *
   * `COORD_UNGROUNDED_REPLAN=1` hands back the plan verbatim instead, which is
   * what this prompt did before substitution existed. It is the control arm of
   * the before/after measurement and the operational rollback, in the same
   * shape as `COORD_COLD_REPLAN` and `COORD_DISABLE_PLAN_GROUNDING`.
   */
  private groundedPreviousPlan(request: ReplanRequest): string[] {
    if (process.env["COORD_UNGROUNDED_REPLAN"] === "1") {
      return [`Previous plan: ${JSON.stringify(request.previousPlan)}`];
    }
    const view = substituteGroundedNames(request.previousPlan);
    if (view.substitutions.length === 0 && view.inventedFiles.length === 0) {
      return [`Previous plan: ${JSON.stringify(view.plan)}`];
    }
    return [
      // The corrected plan is what the prompt asserts. Telling an agent that a
      // name was wrong still leaves the wrong name as the only concrete thing
      // in front of it; telling it the right name does not.
      "Previous plan, with every name the coordinator could resolve already " +
        `replaced by the real one: ${JSON.stringify(view.plan)}`,
      ...view.substitutions.map((entry) =>
        entry.kind === "file"
          ? `The file you called ${entry.declared} does not exist. The real ` +
            `file is ${entry.resolved.join(" or ")}. Declare that path.`
          : `The symbol you called ${entry.declared} does not exist. The real ` +
            `symbol is ${entry.resolved.join(" or ")}` +
            (entry.files.length === 0
              ? ""
              : `, declared in ${entry.files.join(", ")}`) +
            ". Declare that name.",
      ),
      ...(view.inventedFiles.length === 0 && view.inventedSymbols.length === 0
        ? []
        : [
            "These names match nothing in the repository and the coordinator " +
              "could not work out what they meant, so it is treating them as " +
              "things you intend to create: " +
              [...view.inventedFiles, ...view.inventedSymbols].join(", ") +
              ". If you are not creating them, they were mistakes — open the " +
              "repository and declare what is really there.",
          ]),
    ];
  }

  private replanPrompt(
    record: CodexSession,
    request: ReplanRequest,
  ): string {
    return [
      "Replan the approved task against the new canonical repository state.",
      "Do not edit files. Return only the JSON object required by the schema.",
      "Use the previous plan and canonical change first; inspect only what changed.",
      `Planning deadline: ${this.planningTimeoutMs} ms.`,
      `Task id: ${record.input.task.id}`,
      `Objective: ${record.input.task.objective}`,
      ...this.groundedPreviousPlan(request),
      // COORD_COLD_REPLAN=1 strips the warm-start lines below, restoring the
      // pre-enrichment replan prompt on an identical build. It exists for
      // measuring the enrichment against its absence, and as a rollback.
      ...(process.env["COORD_COLD_REPLAN"] === "1"
        ? []
        : [
            // The model already reasoned about this task once; hand that
            // reasoning back instead of making it re-derive everything.
            ...(request.previousPlan.intent === undefined
              ? []
              : [
                  `Your previous stated intent: ${request.previousPlan.intent}`,
                ]),
            // And what verification made of its previous declarations. These
            // notes quote every invented name back verbatim, which is the
            // opposite of what substitution is for, so they are only included
            // when substitution is off.
            ...(process.env["COORD_UNGROUNDED_REPLAN"] !== "1" ||
            (request.previousPlan.grounding?.notes.length ?? 0) === 0
              ? []
              : [
                  "Coordinator verification of your previous declarations: " +
                    (request.previousPlan.grounding?.notes ?? []).join("; "),
                ]),
          ]),
      `Canonical change: ${JSON.stringify(request.canonicalChange)}`,
      `Coordinator constraints: ${JSON.stringify(request.constraints)}`,
      "Account for changed dependencies and remove stale file assumptions.",
      ...(process.env["COORD_COLD_REPLAN"] === "1"
        ? []
        : [
            "Declare only files and symbols that exist at the new revision, plus any you will create.",
          ]),
      "List all affected symbols, APIs, schemas, configuration keys, tests, and services.",
    ].join("\n");
  }

  private executionPrompt(
    record: CodexSession,
    context: CoordinatorContext,
  ): string {
    const approvedPlan =
      record.plan === undefined ? undefined : { ...record.plan, commands: [] };
    const validationLabels = record.input.task.validationCommands.map(
      (command) => command.label,
    );
    if (context.repair !== undefined) {
      // A second pass over work this session already did. Kept narrow on
      // purpose: everything else it wrote is already in canonical, and
      // restating the whole task invites it to redo work that landed.
      return [
        "Part of your change could not be kept, because these files changed " +
          "in canonical while you were working.",
        `Files to reconcile: ${JSON.stringify(context.repair.files)}`,
        context.repair.reason,
        "Those files in the workspace now hold the current canonical content, " +
          "not your earlier edits. Re-apply only your intended change on top " +
          "of what is there.",
        "Every other file you edited has already been integrated. Do not " +
          "touch anything outside the listed files.",
        "Return only the JSON object required by the output schema, with " +
          "outcome=completed.",
        `Task, for context only: ${record.input.task.objective}`,
        `Approved plan: ${JSON.stringify(approvedPlan)}`,
        `Canonical revision: ${context.canonicalVersion.revision}`,
        `Coordinator validation labels (do not execute): ${JSON.stringify(validationLabels)}`,
      ].join("\n");
    }
    return [
      "Implement the approved task in the current workspace.",
      `Execution deadline: ${this.executionTimeoutMs} ms. Prioritize a complete minimal implementation.`,
      "Finish all required edits within the first 80% of the deadline; reserve the remainder only for required validation and the final JSON response.",
      "The coordinator runs every required validation command after collection; do not repeat clean installs, full builds, or full test suites inside this agent session.",
      "Do not install dependency trees, start servers or watchers, or use the network. A package-lock-only operation is allowed only when the task explicitly changes a lockfile.",
      "Skip optional polish, broad exploration, and repeated validation. Never wait for human input.",
      "Do not modify files outside expectedFiles without first returning a scope_change_requested outcome.",
      "Do not change Git metadata.",
      "Return only the JSON object required by the output schema.",
      "For completed, set outcome=completed and use empty scope-change fields.",
      "When more scope is necessary, stop, set outcome=scope_change_requested, populate every scope field, and wait for the next invocation.",
      `Task: ${record.input.task.objective}`,
      `Approved plan: ${JSON.stringify(approvedPlan)}`,
      `Coordinator decision: ${JSON.stringify(context.decision)}`,
      `Prior scope decisions: ${JSON.stringify(record.scopeDecisions)}`,
      `Canonical revision: ${context.canonicalVersion.revision}`,
      `Coordinator validation labels (do not execute): ${JSON.stringify(validationLabels)}`,
    ].join("\n");
  }

  private emit(record: CodexSession, event: AgentEvent): void {
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

  private requireSession(sessionId: string): CodexSession {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new Error(`Unknown Codex session: ${sessionId}`);
    }
    return record;
  }
}
