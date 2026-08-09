import { existsSync } from "node:fs";
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
  scopeChangeGranted,
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

/**
 * Adapters for prompt-in / JSON-out coding CLIs: Claude Code and Gemini CLI.
 *
 * Both tools share a shape with `codex exec` — a non-interactive invocation
 * that receives a prompt, works inside the current directory with its own
 * agentic tooling, and can print a JSON result envelope — but neither speaks
 * this platform's generic-cli NDJSON protocol, and neither offers Codex's
 * `--output-schema` enforcement. So this driver:
 *
 * - runs planning in a disposable worktree and instructs the model to emit
 *   only a JSON plan, which is then extracted and validated with
 *   {@link assertAgentPlan} (a malformed plan fails the task, it is never
 *   guessed at);
 * - runs execution in the coordinator-granted task worktree with the CLI's
 *   non-interactive approval mode, and expects a completion envelope that
 *   either completes or requests a scope change;
 * - collects changes exactly like every other adapter — from the worktree
 *   diff — so nothing the model *says* matters beyond what it actually
 *   edited inside the workspace.
 *
 * Credentials are the CLI's own: whatever `claude` / `gemini` is logged in
 * as (or API-key environment variables passed through agent `env` config) on
 * the machine running the control plane or worker. The dashboard never
 * handles them.
 */

const DEFAULT_PLANNING_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_REPLAY_EVENTS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_SCOPE_ROUNDS = 8;

export type PromptCliProcessRunner = (
  executable: string,
  args: readonly string[],
  options?: ProcessOptions,
) => Promise<ProcessOutput>;

/** How one concrete CLI is invoked and how its output is unwrapped. */
export interface PromptCliProfile {
  /** Adapter id used in configuration and error messages. */
  name: string;
  defaultCommand: string;
  /**
   * Arguments for the read-only planning invocation. The prompt is appended
   * as the final positional argument.
   */
  planningArgs(
    model: string | undefined,
    effort: PromptCliEffort | undefined,
    jsonSchema: string | undefined,
  ): string[];
  /** Arguments for the workspace-writing execution invocation. */
  executionArgs(
    model: string | undefined,
    effort: PromptCliEffort | undefined,
    jsonSchema: string | undefined,
  ): string[];
  /**
   * Unwraps the CLI's stdout into the model's text answer, or throws when
   * the envelope itself reports failure.
   */
  unwrap(stdout: string): string;
  /**
   * What the invocation cost, if the CLI said.
   *
   * Undefined where the envelope carries no usage at all: "not reported" and
   * "cost nothing" are different claims, and a total built from the second is
   * quietly wrong. Every `team-queue-wired` run reported `tokens=0` for
   * exactly this reason — nothing here read the figure the CLI was already
   * printing.
   */
  usage?(stdout: string): PromptCliUsage | undefined;
}

/**
 * One invocation's cost, as the vendor CLI reported it.
 *
 * `totalTokens` counts everything the request was billed for, cache included:
 * a cached read is cheaper than a fresh one but it is not free, and a total
 * that omitted it would understate a long session badly — in practice cache
 * traffic dominates. The split is kept alongside so a reader can recover the
 * uncached figure.
 */
export interface PromptCliUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** What the CLI said it cost, where it says so. */
  costUsd?: number;
}

function numberField(source: Record<string, unknown>, name: string): number {
  const value = source[name];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Reads the `usage` block Claude Code prints in its result envelope.
 *
 * The envelope is the same JSON `unwrap` already parses, so this adds no
 * second invocation and no second parse contract — if the shape ever changes,
 * both fail together rather than one silently reporting zero.
 */
export function parseClaudeUsage(stdout: string): PromptCliUsage | undefined {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout.trim()) as unknown;
  } catch {
    return undefined;
  }
  if (typeof envelope !== "object" || envelope === null) {
    return undefined;
  }
  const usage = (envelope as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const inputTokens = numberField(record, "input_tokens");
  const outputTokens = numberField(record, "output_tokens");
  const cacheReadTokens = numberField(record, "cache_read_input_tokens");
  const cacheCreationTokens = numberField(
    record,
    "cache_creation_input_tokens",
  );
  const cost = (envelope as { total_cost_usd?: unknown }).total_cost_usd;
  return {
    totalTokens:
      inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    ...(typeof cost === "number" && Number.isFinite(cost)
      ? { costUsd: cost }
      : {}),
  };
}

/** What one prompt-cli invocation cost, and which half of the task it bought. */
export interface PromptCliTokenUsage extends PromptCliUsage {
  phase: "planning" | "execution";
  durationMs: number;
  at: string;
}

export const PROMPT_CLI_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type PromptCliEffort = (typeof PROMPT_CLI_EFFORTS)[number];

/**
 * Claude Code headless mode: `claude -p <prompt> --output-format json`.
 *
 * Planning runs under `--permission-mode plan`, which structurally refuses
 * edits. Execution runs with `--dangerously-skip-permissions`, the documented
 * non-interactive mode: the workspace worktree is disposable and only its
 * diff ever reaches the pipeline, and project policy still gates promotion.
 */
export const CLAUDE_PROFILE: PromptCliProfile = {
  name: "claude",
  defaultCommand: "claude",
  planningArgs: (model, effort, jsonSchema) => [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "plan",
    ...(model === undefined ? [] : ["--model", model]),
    ...(effort === undefined ? [] : ["--effort", effort]),
    ...(jsonSchema === undefined ? [] : ["--json-schema", jsonSchema]),
  ],
  executionArgs: (model, effort, jsonSchema) => [
    "-p",
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    ...(model === undefined ? [] : ["--model", model]),
    ...(effort === undefined ? [] : ["--effort", effort]),
    ...(jsonSchema === undefined ? [] : ["--json-schema", jsonSchema]),
  ],
  unwrap: (stdout) => {
    const envelope = parseJson(stdout, "the Claude result envelope");
    if (typeof envelope !== "object" || envelope === null) {
      throw new Error("Claude returned a non-object result envelope");
    }
    const record = envelope as {
      is_error?: unknown;
      result?: unknown;
      subtype?: unknown;
    };
    if (record.is_error === true) {
      throw new Error(
        `Claude reported an error result (${String(record.subtype ?? "unknown")}): ${String(
          record.result ?? "",
        ).slice(0, 500)}`,
      );
    }
    if (typeof record.result !== "string") {
      throw new Error("Claude result envelope carries no result text");
    }
    return record.result;
  },
  usage: parseClaudeUsage,
};

/**
 * Gemini CLI headless mode: `gemini -p <prompt> --output-format json`.
 *
 * Gemini has no plan-only permission mode, so planning relies on the
 * disposable planning worktree (changes there are discarded) plus prompt
 * instructions. Execution uses `--yolo` auto-approval inside the granted
 * workspace.
 */
export const GEMINI_PROFILE: PromptCliProfile = {
  name: "gemini",
  defaultCommand: "gemini",
  planningArgs: (model, _effort, _jsonSchema) => [
    "-p",
    "--output-format",
    "json",
    ...(model === undefined ? [] : ["--model", model]),
  ],
  executionArgs: (model, _effort, _jsonSchema) => [
    "-p",
    "--output-format",
    "json",
    "--yolo",
    ...(model === undefined ? [] : ["--model", model]),
  ],
  unwrap: (stdout) => {
    const envelope = parseJson(stdout, "the Gemini result envelope");
    if (typeof envelope !== "object" || envelope === null) {
      throw new Error("Gemini returned a non-object result envelope");
    }
    const record = envelope as { response?: unknown; error?: unknown };
    if (record.error !== undefined && record.error !== null) {
      throw new Error(
        `Gemini reported an error: ${JSON.stringify(record.error).slice(0, 500)}`,
      );
    }
    if (typeof record.response !== "string") {
      throw new Error("Gemini result envelope carries no response text");
    }
    return record.response;
  },
};

export interface PromptCliAdapterOptions {
  agentId: string;
  repository: CanonicalRepository;
  workspaces: WorkspaceManager;
  /** Disposable read-only worktrees used while the model prepares plans. */
  planningRoot: string;
  profile: PromptCliProfile;
  command?: string;
  /**
   * Optional safe arguments. Only `--model <id>` / `-m <id>` pairs are
   * accepted, so project configuration cannot weaken the invocation mode
   * this adapter enforces.
   */
  args?: readonly string[];
  /** Claude reasoning effort. Unsupported by the Gemini profile. */
  effort?: PromptCliEffort;
  env?: NodeJS.ProcessEnv;
  planningTimeoutMs?: number;
  executionTimeoutMs?: number;
  maxOutputBytes?: number;
  runner?: PromptCliProcessRunner;
}

interface Completion {
  outcome: "completed";
  symbolsChanged: string[];
  explanation: string;
}

interface ScopeChange {
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

type ExecutionResult = Completion | ScopeChange;

interface PromptCliSession {
  session: AgentSession;
  input: StartTaskInput;
  planningWorkspace: TaskWorkspace | undefined;
  plan: AgentPlan | undefined;
  context: CoordinatorContext | undefined;
  completion: Completion | undefined;
  events: AgentEvent[];
  eventHandlers: Set<(event: AgentEvent) => void>;
  controller: AbortController | undefined;
  active: Promise<ProcessOutput> | undefined;
  tokenUsage: PromptCliTokenUsage[];
  scopeDecisions: ScopeChangeDecision[];
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

function parseJson(text: string, what: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error(`The agent returned no output while parsing ${what}`);
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new Error(
      `Could not parse ${what}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Extracts the JSON object a model was asked to answer with.
 *
 * Gemini does not enforce an output schema, and custom profiles may also
 * return JSON wrapped in a code fence or prose. The extractor takes the
 * substring between the first `{` and the last `}` — and then real parsing
 * and validation decide whether it is acceptable. No repair is attempted.
 */
export function extractJsonObject(answer: string, what: string): unknown {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(
      `The agent's answer contains no JSON object while parsing ${what}`,
    );
  }
  return parseJson(answer.slice(start, end + 1), what);
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function safeAdditionalArgs(values: readonly string[]): string | undefined {
  if (values.length === 0) {
    return undefined;
  }
  if (values.length !== 2) {
    throw new Error(
      "Prompt-CLI adapter args accept only a single --model <id> pair",
    );
  }
  const [flag, value] = values;
  if (
    (flag !== "--model" && flag !== "-m") ||
    value === undefined ||
    value.trim().length === 0 ||
    value.includes("\0")
  ) {
    throw new Error(
      "Prompt-CLI adapter args accept only a single --model <id> pair",
    );
  }
  return value;
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function assertExecutionResult(
  value: unknown,
): asserts value is ExecutionResult {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("The execution result must be a JSON object");
  }
  const completion = value as Partial<ExecutionResult>;
  if (
    !stringArray(completion.symbolsChanged) ||
    typeof completion.explanation !== "string"
  ) {
    throw new TypeError(
      "The execution result does not match the required output shape",
    );
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
    throw new TypeError(
      "The scope change request does not match the required output shape",
    );
  }
}

const PLAN_SHAPE_INSTRUCTIONS = [
  "Answer with exactly one JSON object and nothing else. No prose, no code fence.",
  "The object must have exactly these keys (use empty arrays where nothing applies):",
  '  taskId, objective, expectedFiles, expectedSymbols, expectedApis, expectedSchemas,',
  '  expectedConfigKeys, expectedTests, expectedServices, dependencies,',
  '  commands (array of {executable, args, label}), externalAccess,',
  '  riskLevel ("low"|"medium"|"high"|"critical"), intent (a non-empty concise string)',
].join("\n");

const COMPLETION_SHAPE_INSTRUCTIONS = [
  "When you are done (or blocked), answer with exactly one JSON object and nothing else:",
  '  outcome ("completed" or "scope_change_requested"), symbolsChanged, explanation,',
  "  requestId, additionalFiles, additionalSymbols, additionalApis, additionalSchemas,",
  "  additionalConfigKeys, additionalTests, additionalServices, reason",
  "For completed, use empty scope fields. For scope_change_requested, fill every scope field.",
].join("\n");

const STRING_ARRAY_JSON_SCHEMA = {
  type: "array",
  items: { type: "string" },
} as const;

const PLAN_JSON_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    taskId: { type: "string", minLength: 1 },
    objective: { type: "string", minLength: 1 },
    expectedFiles: STRING_ARRAY_JSON_SCHEMA,
    expectedSymbols: STRING_ARRAY_JSON_SCHEMA,
    expectedApis: STRING_ARRAY_JSON_SCHEMA,
    expectedSchemas: STRING_ARRAY_JSON_SCHEMA,
    expectedConfigKeys: STRING_ARRAY_JSON_SCHEMA,
    expectedTests: STRING_ARRAY_JSON_SCHEMA,
    expectedServices: STRING_ARRAY_JSON_SCHEMA,
    dependencies: STRING_ARRAY_JSON_SCHEMA,
    commands: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          executable: { type: "string", minLength: 1 },
          args: STRING_ARRAY_JSON_SCHEMA,
          label: { type: "string", minLength: 1 },
        },
        required: ["executable", "args", "label"],
      },
    },
    externalAccess: STRING_ARRAY_JSON_SCHEMA,
    riskLevel: {
      type: "string",
      enum: ["low", "medium", "high", "critical"],
    },
    intent: { type: "string", minLength: 1 },
  },
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
});

const COMPLETION_JSON_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: {
      type: "string",
      enum: ["completed", "scope_change_requested"],
    },
    symbolsChanged: STRING_ARRAY_JSON_SCHEMA,
    explanation: { type: "string" },
    requestId: { type: "string" },
    additionalFiles: STRING_ARRAY_JSON_SCHEMA,
    additionalSymbols: STRING_ARRAY_JSON_SCHEMA,
    additionalApis: STRING_ARRAY_JSON_SCHEMA,
    additionalSchemas: STRING_ARRAY_JSON_SCHEMA,
    additionalConfigKeys: STRING_ARRAY_JSON_SCHEMA,
    additionalTests: STRING_ARRAY_JSON_SCHEMA,
    additionalServices: STRING_ARRAY_JSON_SCHEMA,
    reason: { type: "string" },
  },
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
});

function environmentPath(
  environment: Readonly<Record<string, string | undefined>> | undefined,
): string | undefined {
  if (environment === undefined) {
    return process.env.PATH;
  }
  const pathEntry = Object.entries(environment).find(
    ([name]) => name.toLowerCase() === "path",
  );
  return pathEntry?.[1] ?? process.env.PATH;
}

/**
 * Claude's npm `.cmd` shim cannot safely carry a JSON schema through `cmd.exe`.
 * Official Windows installs place a native executable beside the shim's
 * package, which also gives timeout handling a process it can terminate.
 */
export function resolveClaudeCommand(
  command: string,
  pathValue = process.env.PATH,
): string {
  if (process.platform !== "win32") {
    return command;
  }
  const commandName = path.win32.basename(command).toLowerCase();
  if (commandName !== "claude" && commandName !== "claude.cmd") {
    return command;
  }

  const hasDirectory = command.includes("/") || command.includes("\\");
  const wrapperNames =
    commandName === "claude.cmd" ? ["claude.cmd"] : ["claude.cmd", "claude"];
  const wrappers = hasDirectory
    ? [path.resolve(command)]
    : (pathValue ?? "")
        .split(path.delimiter)
        .map((entry) => entry.trim().replace(/^"(.*)"$/u, "$1"))
        .filter((entry) => entry.length > 0)
        .flatMap((entry) =>
          wrapperNames.map((name) => path.resolve(entry, name)),
        );

  for (const wrapper of wrappers) {
    if (!existsSync(wrapper)) {
      continue;
    }
    const directory = path.dirname(wrapper);
    const candidates = [
      path.join(
        directory,
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe",
      ),
      path.join(
        path.dirname(directory),
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe",
      ),
    ];
    const nativeCommand = candidates.find((candidate) => existsSync(candidate));
    if (nativeCommand !== undefined) {
      return nativeCommand;
    }
  }
  return command;
}

/**
 * Drives Claude Code or Gemini CLI through the coordinator's plan-first
 * lifecycle. See the profiles above for the exact invocations.
 */
export class PromptCliAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, PromptCliSession>();
  private readonly command: string;
  private readonly effort: PromptCliEffort | undefined;
  private readonly model: string | undefined;
  private readonly planningTimeoutMs: number;
  private readonly executionTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly runner: PromptCliProcessRunner;
  private readonly profile: PromptCliProfile;

  public constructor(private readonly options: PromptCliAdapterOptions) {
    this.profile = options.profile;
    const configuredCommand =
      options.command?.trim() || this.profile.defaultCommand;
    this.command =
      this.profile.name === "claude"
        ? resolveClaudeCommand(configuredCommand, environmentPath(options.env))
        : configuredCommand;
    this.model = safeAdditionalArgs(options.args ?? []);
    this.effort = options.effort;
    if (
      this.effort !== undefined &&
      !(PROMPT_CLI_EFFORTS as readonly string[]).includes(this.effort)
    ) {
      throw new Error(
        `Prompt-CLI effort must be one of ${PROMPT_CLI_EFFORTS.join(", ")}`,
      );
    }
    if (this.effort !== undefined && this.profile.name !== "claude") {
      throw new Error("Prompt-CLI effort is supported only by Claude");
    }
    this.planningTimeoutMs = positiveInteger(
      options.planningTimeoutMs,
      DEFAULT_PLANNING_TIMEOUT_MS,
      `${this.profile.name} planning timeout`,
    );
    this.executionTimeoutMs = positiveInteger(
      options.executionTimeoutMs,
      DEFAULT_EXECUTION_TIMEOUT_MS,
      `${this.profile.name} execution timeout`,
    );
    this.maxOutputBytes = positiveInteger(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      `${this.profile.name} output limit`,
    );
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
        `${this.profile.name} adapter for ${this.options.repository.id} cannot start a task for ${input.repositoryId}`,
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
    this.sessions.set(session.id, {
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
      tokenUsage: [],
      scopeDecisions: [],
      pendingScope: new Map(),
      cancelled: false,
    });
    this.emit(this.sessions.get(session.id)!, {
      event: "progress",
      message: `${this.profile.name} planning workspace prepared`,
      occurredAt: new Date().toISOString(),
    });
    return session;
  }

  public async requestPlan(sessionId: string): Promise<AgentPlan> {
    const record = this.requireSession(sessionId);
    const workspace = record.planningWorkspace;
    if (workspace === undefined) {
      throw new Error(`Session ${sessionId} has no planning workspace`);
    }
    try {
      const plan = await this.runPlanning(
        record,
        workspace.path,
        this.planPrompt(record.input),
      );
      record.plan = plan;
      this.emit(record, {
        event: "progress",
        message: `${this.profile.name} planned ${plan.expectedFiles.length} file(s)`,
        occurredAt: new Date().toISOString(),
      });
      return structuredClone(plan);
    } catch (error) {
      return await this.cleanupAfter(error, record, "planning");
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
      const plan = await this.runPlanning(
        record,
        record.planningWorkspace.path,
        this.replanPrompt(record, request),
      );
      record.plan = plan;
      this.emit(record, {
        event: "progress",
        message: `${this.profile.name} revised its plan for canonical ${request.canonicalChange.canonicalVersion.revision.slice(0, 12)}`,
        occurredAt: new Date().toISOString(),
      });
      return structuredClone(plan);
    } catch (error) {
      return await this.cleanupAfter(error, record, "replanning");
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
      message: `${this.profile.name} execution started`,
      occurredAt: new Date().toISOString(),
    });

    for (let round = 0; round < MAX_SCOPE_ROUNDS; round += 1) {
      const stdout = await this.run(
        record,
        context.workspacePath,
        this.profile.executionArgs(
          this.model,
          this.effort,
          this.profile.name === "claude"
            ? COMPLETION_JSON_SCHEMA
            : undefined,
        ),
        this.executionPrompt(record, context),
        this.executionTimeoutMs,
        "execution",
      );
      const execution = extractJsonObject(
        this.profile.unwrap(stdout),
        "the execution result",
      );
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
          `${this.profile.name} execution is continuing`,
        occurredAt: new Date().toISOString(),
      });
    }
    throw new Error(
      `${this.profile.name} exceeded the maximum scope-change rounds for ${record.input.task.id}`,
    );
  }

  public async pause(_sessionId: string): Promise<void> {
    throw new Error(
      "PromptCliAdapter does not support pausing ephemeral executions",
    );
  }

  public async resume(_sessionId: string): Promise<void> {
    throw new Error(
      "PromptCliAdapter does not support resuming ephemeral executions",
    );
  }

  public async resolveScopeChange(
    sessionId: string,
    decision: ScopeChangeDecision,
  ): Promise<void> {
    const record = this.requireSession(sessionId);
    const pending = record.pendingScope.get(decision.requestId);
    if (pending === undefined) {
      throw new Error(
        `Session ${sessionId} has no pending scope request ${decision.requestId}`,
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
    const changeSet = await this.options.workspaces.collectChangeSet(
      workspace,
      {
        expectedFiles: plan.expectedFiles,
        symbolsChanged:
          completion.symbolsChanged.length === 0
            ? plan.expectedSymbols
            : completion.symbolsChanged,
        riskAssessment: { level: plan.riskLevel, reasons: [] },
        agentExplanation:
          completion.explanation ||
          `${this.profile.name} completed ${record.input.task.objective}`,
      },
    );
    // The model reported success but touched nothing. Every known cause is a
    // defect (an unauthenticated CLI answering conversationally is the common
    // one), and an empty changeset must not enter the pipeline as a success.
    if (changeSet.patches.length === 0) {
      throw new Error(
        `${this.profile.name} reported ${record.input.task.id} complete but changed no files. ` +
          `Check that the ${this.command} CLI is authenticated and actually edited the workspace.`,
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

  private async runPlanning(
    record: PromptCliSession,
    workingDirectory: string,
    prompt: string,
  ): Promise<AgentPlan> {
    const stdout = await this.run(
      record,
      workingDirectory,
      this.profile.planningArgs(
        this.model,
        this.effort,
        this.profile.name === "claude" ? PLAN_JSON_SCHEMA : undefined,
      ),
      prompt,
      this.planningTimeoutMs,
      "planning",
    );
    const plan = extractJsonObject(this.profile.unwrap(stdout), "the plan");
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
    return plan;
  }

  private async run(
    record: PromptCliSession,
    workingDirectory: string,
    args: readonly string[],
    prompt: string,
    timeoutMs: number,
    phase: "planning" | "execution",
  ): Promise<string> {
    if (record.active !== undefined) {
      throw new Error(
        `Session ${record.session.id} already has an active ${this.profile.name} process`,
      );
    }
    if (record.cancelled) {
      throw new Error(`Session ${record.session.id} was cancelled`);
    }
    const controller = new AbortController();
    record.controller = controller;
    // The prompt travels over stdin so objectives are never visible in the
    // process list and never parsed as flags.
    const active = this.runner(this.command, [...args], {
      cwd: workingDirectory,
      input: prompt,
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      signal: controller.signal,
    });
    record.active = active;
    let output: ProcessOutput;
    try {
      output = await active;
    } finally {
      if (record.active === active) {
        record.active = undefined;
        record.controller = undefined;
      }
    }
    if (output.exitCode !== 0) {
      const reason =
        output.stderr.trim() ||
        output.stdout.trim() ||
        `exit code ${output.exitCode}`;
      throw new Error(`${this.profile.name} execution failed: ${reason}`);
    }
    if (output.stdoutTruncated === true) {
      throw new Error(
        `${this.profile.name} output exceeded the configured limit`,
      );
    }
    // Recorded only where the CLI actually reported a figure. A profile with
    // no `usage` reader, or an envelope without a usage block, contributes
    // nothing rather than contributing a zero.
    const usage = this.profile.usage?.(output.stdout);
    if (usage !== undefined) {
      record.tokenUsage.push({
        ...usage,
        phase,
        durationMs: output.durationMs,
        at: new Date().toISOString(),
      });
    }
    return output.stdout;
  }

  /** Every invocation this adapter made, for cost accounting and benchmarks. */
  public allTokenUsage(): (PromptCliTokenUsage & {
    sessionId: string;
    taskId: string;
  })[] {
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
    return this.allTokenUsage().reduce(
      (sum, entry) => sum + entry.totalTokens,
      0,
    );
  }

  /** What the vendor said this adapter's work cost, where it said so. */
  public totalCostUsd(): number {
    return this.allTokenUsage().reduce(
      (sum, entry) => sum + (entry.costUsd ?? 0),
      0,
    );
  }

  /**
   * The protocol-shaped view of {@link allTokenUsage}, for the control plane.
   *
   * Summed per phase, matching what `CodexAdapter` reports, so a run mixing
   * adapters produces one comparable number rather than two shapes.
   */
  public reportedTokenUsage(sessionId: string): AgentTokenUsage[] {
    const totals = new Map<
      AgentTokenUsage["phase"],
      { totalTokens: number; inputTokens: number; outputTokens: number }
    >();
    for (const entry of this.requireSession(sessionId).tokenUsage) {
      const current = totals.get(entry.phase) ?? {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      totals.set(entry.phase, {
        totalTokens: current.totalTokens + entry.totalTokens,
        // Cache traffic is input the request was billed for, so it belongs on
        // the input side rather than nowhere.
        inputTokens:
          current.inputTokens +
          entry.inputTokens +
          entry.cacheReadTokens +
          entry.cacheCreationTokens,
        outputTokens: current.outputTokens + entry.outputTokens,
      });
    }
    return [...totals].map(([phase, sums]) => ({ phase, ...sums }));
  }

  private createScopeWaiter(
    record: PromptCliSession,
    requestId: string,
  ): Promise<ScopeChangeDecision> {
    if (record.pendingScope.has(requestId)) {
      throw new Error(
        `${this.profile.name} repeated pending scope request ${requestId}`,
      );
    }
    let resolvePromise: (decision: ScopeChangeDecision) => void = () =>
      undefined;
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
    record.pendingScope.set(requestId, {
      promise,
      resolve: (decision) => {
        clearTimeout(timer);
        resolvePromise(decision);
      },
      reject: (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    });
    return promise;
  }

  private async cleanupAfter(
    error: unknown,
    record: PromptCliSession,
    stage: string,
  ): Promise<never> {
    try {
      await this.destroyPlanningWorkspace(record);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${this.profile.name} ${stage} and workspace cleanup failed for ${record.input.task.id}`,
      );
    }
    throw error;
  }

  private async destroyPlanningWorkspace(
    record: PromptCliSession,
  ): Promise<void> {
    const workspace = record.planningWorkspace;
    record.planningWorkspace = undefined;
    if (workspace !== undefined) {
      await this.options.workspaces.destroy(workspace);
    }
  }

  private planPrompt(input: StartTaskInput): string {
    return [
      "Inspect the repository in the current directory and prepare a coordination plan.",
      "Do not edit files. Do not run commands that modify repository state.",
      "Keep planning focused: inspect only enough files to establish an accurate scope.",
      `Planning deadline: ${this.planningTimeoutMs} ms.`,
      `Task id: ${input.task.id}`,
      `Objective: ${input.task.objective}`,
      `Canonical revision: ${input.canonicalVersion.revision}`,
      `Required validation commands: ${JSON.stringify(input.task.validationCommands)}`,
      "List every repository-relative file you expect to change.",
      "List affected symbols, APIs, schemas, configuration keys, tests, and services.",
      "State a concise intent that distinguishes adding, removing, enabling, or disabling behavior.",
      "List external access honestly; execution may deny it.",
      PLAN_SHAPE_INSTRUCTIONS,
    ].join("\n");
  }

  private replanPrompt(
    record: PromptCliSession,
    request: ReplanRequest,
  ): string {
    // Why this is written as an amendment rather than a fresh planning task:
    // the whole reason to replan incrementally is that the coordinator has
    // *already* enumerated what moved, exhaustively — files, symbols, APIs,
    // schemas, config keys, tests and services. An agent that re-explores the
    // tree anyway pays a cold planning round to rediscover a diff it was
    // handed, which is the entire saving gone. So the instruction is not
    // "inspect only what changed" (which still invites a look around) but
    // "the change list is complete, start from the previous plan".
    const change = request.canonicalChange;
    const touched = [
      ...change.changedFiles,
      ...change.changedSymbols,
      ...change.changedApis,
      ...change.changedSchemas,
      ...change.changedConfigKeys,
      ...change.changedTests,
      ...change.changedServices,
    ];
    return [
      "Amend an existing plan. This is not a fresh planning task.",
      "Do not edit files.",
      "The canonical change below is a COMPLETE and AUTHORITATIVE record of",
      "everything that moved since the previous plan was written. Trust it.",
      "Do NOT re-read the repository to rediscover it, and do NOT re-derive",
      "the previous plan's reasoning.",
      touched.length === 0
        ? "Nothing relevant changed: return the previous plan unaltered."
        : "Open a file only if it appears in the change list below AND the " +
          "previous plan already claimed it. Read nothing else.",
      "Most amendments need no file reads at all — the previous plan plus the",
      "change list is usually enough. Returning the previous plan unchanged is",
      "a correct answer when nothing it claimed was affected.",
      `Planning deadline: ${this.planningTimeoutMs} ms.`,
      `Task id: ${record.input.task.id}`,
      `Objective: ${record.input.task.objective}`,
      `Previous plan: ${JSON.stringify(request.previousPlan)}`,
      `Canonical change: ${JSON.stringify(request.canonicalChange)}`,
      `Coordinator constraints: ${JSON.stringify(request.constraints)}`,
      "Account for changed dependencies and remove stale file assumptions.",
      PLAN_SHAPE_INSTRUCTIONS,
    ].join("\n");
  }

  private executionPrompt(
    record: PromptCliSession,
    context: CoordinatorContext,
  ): string {
    const approvedPlan =
      record.plan === undefined ? undefined : { ...record.plan, commands: [] };
    const validationLabels = record.input.task.validationCommands.map(
      (command) => command.label,
    );
    if (context.repair !== undefined) {
      // A second pass over work this session already did. The prompt is
      // deliberately narrow: everything else the agent wrote is already in
      // canonical, and re-describing the whole task invites it to redo work
      // that landed.
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
        `Task, for context only: ${record.input.task.objective}`,
        `Approved plan: ${JSON.stringify(approvedPlan)}`,
        `Canonical revision: ${context.canonicalVersion.revision}`,
        `Coordinator validation labels (do not execute): ${JSON.stringify(validationLabels)}`,
        COMPLETION_SHAPE_INSTRUCTIONS,
      ].join("\n");
    }
    return [
      "Implement the approved task in the current workspace directory.",
      `Execution deadline: ${this.executionTimeoutMs} ms. Prioritize a complete minimal implementation.`,
      "Finish all required edits within the first 80% of the deadline; reserve the remainder only for required validation and the final JSON response.",
      "The coordinator runs every required validation command after collection; do not repeat clean installs, full builds, or full test suites inside this agent session.",
      "Do not install dependency trees, start servers or watchers, or use the network. A package-lock-only operation is allowed only when the task explicitly changes a lockfile.",
      "Skip optional polish, broad exploration, and repeated validation. Never wait for human input.",
      "Do not modify files outside expectedFiles without first answering with a scope_change_requested outcome.",
      "Do not change Git metadata.",
      `Task: ${record.input.task.objective}`,
      `Approved plan: ${JSON.stringify(approvedPlan)}`,
      `Coordinator decision: ${JSON.stringify(context.decision)}`,
      `Prior scope decisions: ${JSON.stringify(record.scopeDecisions)}`,
      `Canonical revision: ${context.canonicalVersion.revision}`,
      `Coordinator validation labels (do not execute): ${JSON.stringify(validationLabels)}`,
      COMPLETION_SHAPE_INSTRUCTIONS,
    ].join("\n");
  }

  private emit(record: PromptCliSession, event: AgentEvent): void {
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

  private requireSession(sessionId: string): PromptCliSession {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new Error(`Unknown ${this.profile.name} session: ${sessionId}`);
    }
    return record;
  }
}

/** Convenience constructors used by the CLI and worker wiring. */
export type NamedPromptCliOptions = Omit<PromptCliAdapterOptions, "profile">;

export function createClaudeAdapter(
  options: NamedPromptCliOptions,
): PromptCliAdapter {
  return new PromptCliAdapter({ ...options, profile: CLAUDE_PROFILE });
}

export function createGeminiAdapter(
  options: NamedPromptCliOptions,
): PromptCliAdapter {
  return new PromptCliAdapter({ ...options, profile: GEMINI_PROFILE });
}
