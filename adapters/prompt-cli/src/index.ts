import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  MAX_AGENT_QUESTIONS,
  type AgentActionResult,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentEvent,
  type AgentSession,
  type AgentTokenUsage,
  type CoordinatorContext,
  type QuestionAnswer,
  type QuestionChoice,
  type ScopeContentionNotice,
  type StartTaskInput,
} from "@coord/agent-protocol";
import {
  assertAgentPlan,
  createId,
  isBlanketClaim,
  readsAsReportRequest,
  scopeChangeGranted,
  type AgentPlan,
  type ChangeSet,
  type HolderWorkingChange,
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

/**
 * Internal objective marker written by the channel's explicit `/ask` command.
 *
 * The command has to survive task submission, planning and queueing before the
 * execution adapter can act on it. Keeping the marker in the existing
 * objective avoids a new persisted task field, while the exact, namespaced
 * text keeps ordinary requests containing the word "ask" out of this path.
 */
const FORCE_QUESTION_MARKER =
  "[Coordinator: force a question round before implementation.]";

export type PromptCliProcessRunner = (
  executable: string,
  args: readonly string[],
  options?: ProcessOptions,
) => Promise<ProcessOutput>;

/**
 * A partial line this long is not a line. Guards the reassembly buffer against
 * a CLI that streams something enormous without a newline in it.
 */
const MAX_NARRATION_TAIL = 512 * 1024;

/**
 * Linux rejects any individual argv entry larger than 128 KiB, independently
 * of the much larger total ARG_MAX allowance. Leave room for encoding and
 * platform bookkeeping while turning a variadic CLI prompt into safe words.
 */
const MAX_PROMPT_ARGUMENT_BYTES = 96 * 1024;

function splitPromptArguments(prompt: string): string[] {
  if (Buffer.byteLength(prompt, "utf8") <= MAX_PROMPT_ARGUMENT_BYTES) {
    return [prompt];
  }

  const chunks: string[] = [];
  let start = 0;
  let index = 0;
  let bytes = 0;
  let lastSpace = -1;

  for (const character of prompt) {
    const characterStart = index;
    const characterBytes = Buffer.byteLength(character, "utf8");
    index += character.length;

    if (bytes + characterBytes > MAX_PROMPT_ARGUMENT_BYTES) {
      if (lastSpace >= start) {
        // Cursor joins variadic prompt arguments with one space. Splitting on
        // an existing single space therefore reconstructs the original text.
        chunks.push(prompt.slice(start, lastSpace));
        start = lastSpace + 1;
        bytes = Buffer.byteLength(prompt.slice(start, characterStart), "utf8");
        if (bytes + characterBytes > MAX_PROMPT_ARGUMENT_BYTES) {
          chunks.push(prompt.slice(start, characterStart));
          start = characterStart;
          bytes = 0;
        }
      } else {
        // Generated prompts normally contain many spaces. This fallback also
        // handles an unusually long token; the inserted separator is safer
        // than allowing the process to fail before the CLI starts.
        chunks.push(prompt.slice(start, characterStart));
        start = characterStart;
        bytes = 0;
      }
      lastSpace = -1;
    }

    bytes += characterBytes;
    if (character === " ") {
      lastSpace = characterStart;
    }
  }

  chunks.push(prompt.slice(start));
  return chunks;
}

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
   * Most CLIs accept the prompt on stdin. Browser-account CLIs whose
   * non-interactive command requires positional values opt into `argument`
   * or the variadic `arguments` form.
   */
  promptDelivery?: "stdin" | "argument" | "arguments";
  /**
   * Unwraps the CLI's stdout into the model's text answer, or throws when
   * the envelope itself reports failure.
   */
  unwrap(stdout: string): string;
  /**
   * What the agent said, out of one line of a streamed run, or nothing.
   *
   * Absent on a profile whose CLI answers only at exit, which is every one but
   * Claude's execution today — and absence is the whole of the difference: a
   * profile without this narrates its lifecycle and nothing else, exactly as
   * before.
   */
  narrate?(event: unknown): string | undefined;
  /**
   * The flag that resumes a previous invocation's vendor-side session.
   *
   * Optional like `usage`, and for the same reason: it describes what one
   * concrete CLI can do. Claude Code accepts `--resume <session_id>`;
   * Gemini's envelope names no session, so its profile has no hook and its
   * invocations never carry the flag.
   */
  resumeArgs?(token: string): string[];
  /**
   * The vendor session id this invocation's envelope reports, if any.
   *
   * Read after every successful exec and overwritten, not written once: a
   * resumed Claude run forks a fresh session id, and the one worth keeping
   * is always the newest — it names the state as this invocation left it.
   */
  sessionId?(stdout: string): string | undefined;
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
/**
 * The result envelope, from either output format.
 *
 * Claude answers `--output-format json` with one envelope and `stream-json`
 * with a line per event, the last of which is that same envelope under
 * `type: "result"`. Reading both here is what lets execution stream while
 * planning stays as it was: one format change, not two parsers to keep in
 * step.
 *
 * A stream that ends without a result event is an error and says so. That is
 * the failure this has to be loudest about — a run that did the work and
 * reported nothing looks exactly like a run that did nothing, and the whole
 * point of the change is that the work is now visible while it happens.
 */
export function claudeResultEnvelope(stdout: string): unknown {
  const text = stdout.trim();
  if (!text.includes("\n")) {
    return parseJson(text, "the Claude result envelope");
  }
  let envelope: unknown;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // A line that is not JSON is not the envelope, and a stream carrying
      // one is not thereby broken — the vendor may print anything it likes
      // alongside its events.
      continue;
    }
    if (
      typeof event === "object" &&
      event !== null &&
      (event as { type?: unknown }).type === "result"
    ) {
      envelope = event;
    }
  }
  if (envelope === undefined) {
    // Not "no result text": the distinction matters when reading a failure.
    throw new Error(
      "Claude streamed no result event, so the run's outcome is unknown",
    );
  }
  return envelope;
}

/**
 * What the agent said, out of one stream event, or nothing worth saying.
 *
 * Assistant *text* only. A stream also carries tool calls and their results,
 * and narrating those would turn a thread into a transcript of every file
 * read — the noise the thinking block exists to fold away, except there would
 * be far more of it. What a reader wants is the sentence the agent wrote
 * before it acted: "the pieces are pink and angular, changing them now".
 */
export function readClaudeNarration(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  const record = event as { type?: unknown; message?: unknown };
  if (record.type !== "assistant") {
    return undefined;
  }
  const content = (record.message as { content?: unknown } | undefined)
    ?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const said = content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
  return said.length === 0 ? undefined : said;
}

export function parseClaudeUsage(stdout: string): PromptCliUsage | undefined {
  let envelope: unknown;
  try {
    // The same reader `unwrap` uses, so a streamed run is billed exactly as a
    // buffered one is. Read separately rather than threaded through, because
    // a missing usage block is not worth failing a run over and a missing
    // result event is.
    envelope = claudeResultEnvelope(stdout);
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

/**
 * The shape Claude Code session ids take, checked before one ever reaches an
 * argv. The envelope is our own CLI's output, but a malformed or truncated id
 * fed back through `--resume` buys a confusing exec failure later; refusing
 * it here costs only the warmth. Same rule the chat providers apply.
 */
const CLAUDE_SESSION_ID = /^[A-Za-z0-9-]{8,64}$/u;

/**
 * Reads the `session_id` Claude Code's result envelope reports.
 *
 * The same JSON `unwrap` and `parseClaudeUsage` already parse, for the same
 * reason: no second invocation, no second parse contract. Tolerant like the
 * usage reader — an envelope without one contributes nothing, because a turn
 * that cannot be resumed is still a turn that worked.
 */
export function parseClaudeSessionId(stdout: string): string | undefined {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout.trim()) as unknown;
  } catch {
    return undefined;
  }
  if (typeof envelope !== "object" || envelope === null) {
    return undefined;
  }
  const sessionId = (envelope as { session_id?: unknown }).session_id;
  return typeof sessionId === "string" && CLAUDE_SESSION_ID.test(sessionId)
    ? sessionId
    : undefined;
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
  // Execution streams; planning does not. A plan is one answer and arrives at
  // the end either way, so streaming it would buy nothing and put the schema
  // parse behind a second format. Execution is the long half — the stretch
  // where the run has plenty to say and said none of it, because with
  // `--output-format json` the adapter hears nothing until the process exits.
  executionArgs: (model, effort, jsonSchema) => [
    "-p",
    "--output-format",
    "stream-json",
    // `stream-json` is refused without it.
    "--verbose",
    "--dangerously-skip-permissions",
    ...(model === undefined ? [] : ["--model", model]),
    ...(effort === undefined ? [] : ["--effort", effort]),
    ...(jsonSchema === undefined ? [] : ["--json-schema", jsonSchema]),
  ],
  narrate: readClaudeNarration,
  unwrap: (stdout) => {
    const envelope = claudeResultEnvelope(stdout);
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
  resumeArgs: (token) => ["--resume", token],
  sessionId: parseClaudeSessionId,
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

/** Unwraps the small JSON envelopes used by browser-account coding CLIs. */
function unwrapBrowserCli(stdout: string, name: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error(`${name} returned no result`);
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") {
      return parsed;
    }
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const key of ["response", "result", "text", "message"]) {
        if (typeof record[key] === "string") {
          return record[key] as string;
        }
      }
    }
  } catch {
    // Plain text is the documented output of Copilot and Kiro. The model is
    // still required to put one JSON object in that text, and the adapter's
    // existing extractor validates it at the next boundary.
  }
  return trimmed;
}

/** Cursor Agent CLI in non-interactive print mode. */
export const CURSOR_PROFILE: PromptCliProfile = {
  name: "cursor",
  defaultCommand: "agent",
  // Cursor declares its prompt as the variadic `[prompt...]`. Keep large
  // prompts below Linux's per-argument MAX_ARG_STRLEN limit by sending them
  // as several positional words; Cursor joins those words before starting
  // the agent. A single generated prompt can readily exceed 128 KiB once it
  // contains task context and prior coordinator decisions, at which point
  // passing it as one argument makes spawn fail with E2BIG before Cursor even
  // starts.
  promptDelivery: "arguments",
  planningArgs: (model) => [
    "-p",
    "--output-format",
    "json",
    "--force",
    ...(model === undefined ? [] : ["--model", model]),
  ],
  executionArgs: (model) => [
    "-p",
    "--output-format",
    "json",
    "--force",
    ...(model === undefined ? [] : ["--model", model]),
  ],
  unwrap: (stdout) => unwrapBrowserCli(stdout, "Cursor"),
};

/** GitHub Copilot CLI using the account connected by `copilot login`. */
export const COPILOT_PROFILE: PromptCliProfile = {
  name: "copilot",
  defaultCommand: "copilot",
  promptDelivery: "argument",
  planningArgs: (model) => [
    "--allow-all-tools",
    ...(model === undefined ? [] : ["--model", model]),
    "-p",
  ],
  executionArgs: (model) => [
    "--allow-all-tools",
    ...(model === undefined ? [] : ["--model", model]),
    "-p",
  ],
  unwrap: (stdout) => unwrapBrowserCli(stdout, "Copilot"),
};

/** Kiro CLI's non-interactive chat mode. */
export const KIRO_PROFILE: PromptCliProfile = {
  name: "kiro",
  defaultCommand: "kiro-cli",
  promptDelivery: "argument",
  planningArgs: (model) => [
    "chat",
    "--no-interactive",
    "--trust-all-tools",
    ...(model === undefined ? [] : ["--model", model]),
  ],
  executionArgs: (model) => [
    "chat",
    "--no-interactive",
    "--trust-all-tools",
    ...(model === undefined ? [] : ["--model", model]),
  ],
  unwrap: (stdout) => unwrapBrowserCli(stdout, "Kiro"),
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

interface QuestionAsked {
  outcome: "question_asked";
  requestId: string;
  /** The single-question shape, still accepted and still what most asks use. */
  question?: string;
  options?: string[];
  recommended?: number;
  /** One to six questions asked together; see `MAX_AGENT_QUESTIONS`. */
  questions?: AskedQuestion[];
  symbolsChanged: string[];
  explanation: string;
}

interface AskedQuestion {
  question: string;
  options: string[];
  /** Index into `options` the agent would pick itself. */
  recommended?: number;
}

/**
 * The agent asking the platform, not a person, to do something from the
 * fixed action list — publish canonical, start or stop its preview. The
 * round trip mirrors `question_asked`: the round ends on the request, the
 * platform's answer comes back through {@link PromptCliAdapter.resolveAction},
 * and the next round's prompt carries the result. This variant is what
 * makes "push to GitHub" possible for a prompt-CLI agent at all: its own
 * `git push` has no credential and no remote it is allowed to reach, so
 * before this the request was simply impossible from the two adapters most
 * channels run.
 */
interface ActionRequested {
  outcome: "action_requested";
  requestId: string;
  action: string;
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

/**
 * The agent handing part of its approved plan back before the task ends.
 *
 * Carried in the same fields a widening uses, rather than seven more of its
 * own: the CLI answers one fixed schema every round, and an outcome that
 * needed extra properties would make every ordinary completion carry them
 * too. The outcome says which direction the named resources are moving.
 */
interface ScopeRelease {
  outcome: "scope_release_requested";
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

type ExecutionResult =
  | Completion
  | ScopeChange
  | ScopeRelease
  | QuestionAsked
  | ActionRequested;

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
  /** What a person chose, for the prompt that follows the question. */
  answers: Array<{ question: string; chose: string }>;
  /**
   * The newest vendor session id this session's execs reported — what a
   * `--resume` would pick up. Overwritten after every successful exec,
   * because a resumed run forks a fresh id; cleared when a resume attempt
   * turns out stale.
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
  /**
   * Questions put to a person and not yet answered.
   *
   * Separate from `pendingScope` because the two are answered by different
   * things — arbitration decides a scope request in milliseconds, a person
   * decides this one when they get to it — and collapsing them would hide
   * that difference behind one name.
   */
  pendingQuestion: Map<
    string,
    {
      promise: Promise<QuestionAnswer>;
      resolve: (answer: QuestionAnswer) => void;
      reject: (error: Error) => void;
    }
  >;
  /**
   * Actions asked of the platform and not yet answered. Its own map for the
   * same reason the two above are separate: the platform answers in however
   * long the action takes — a push is seconds, a preview boot longer — and
   * the answer arrives through its own resolver.
   */
  pendingAction: Map<
    string,
    {
      promise: Promise<AgentActionResult>;
      resolve: (result: AgentActionResult) => void;
      reject: (error: Error) => void;
    }
  >;
  /** What the platform did and said, for the prompt of the round after. */
  actionResults: AgentActionResult[];
  /**
   * Who is queued behind resources this session holds, as the coordinator has
   * told it so far.
   *
   * Kept on the record rather than answered on arrival because the CLI is a
   * process per round: a notice that lands mid-round has nowhere to go until
   * the next prompt is built, and that prompt is where an agent can act on it
   * by handing the files back.
   */
  contention: ScopeContentionNotice[];
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
  if (completion.outcome === "question_asked") {
    // Two options at minimum: one "option" is a statement, and a question
    // with nothing to choose between is the free-text ask this shape exists
    // to prevent. Six at most, because past that the agent is designing a
    // form rather than asking what blocks it.
    if (typeof completion.requestId !== "string") {
      throw new TypeError("A question must carry a requestId");
    }
    // Read as unknown, because this is the boundary: the CLI wrote this JSON
    // and the type above is what it is supposed to have written, not what it
    // did.
    const asked: unknown[] = Array.isArray(completion.questions)
      ? completion.questions
      : [
          {
            question: completion.question,
            options: completion.options,
            recommended: completion.recommended,
          },
        ];
    if (asked.length === 0 || asked.length > MAX_AGENT_QUESTIONS) {
      throw new TypeError(
        `Ask between one and ${String(MAX_AGENT_QUESTIONS)} questions at once`,
      );
    }
    for (const value of asked) {
      const entry = value as Partial<AskedQuestion>;
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof entry.question !== "string" ||
        entry.question.trim().length === 0 ||
        !stringArray(entry.options) ||
        entry.options.length < 2 ||
        (entry.recommended !== undefined &&
          (!Number.isInteger(entry.recommended) ||
            entry.recommended < 0 ||
            entry.recommended >= entry.options.length))
      ) {
        throw new TypeError(
          "Every question must carry the question itself and at least two " +
            "options to choose between, and any recommendation must name " +
            "one of them",
        );
      }
    }
    return;
  }
  if (completion.outcome === "action_requested") {
    // The name is all the platform needs; whether it is an action this
    // deployment performs is the authority's decision, answered as done or
    // refused rather than validated here.
    if (
      typeof completion.requestId !== "string" ||
      typeof completion.action !== "string" ||
      completion.action.trim().length === 0
    ) {
      throw new TypeError(
        "An action request must carry a requestId and the action's name",
      );
    }
    return;
  }
  if (
    (completion.outcome !== "scope_change_requested" &&
      completion.outcome !== "scope_release_requested") ||
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
      "The scope request does not match the required output shape",
    );
  }
}

/**
 * The questions one ask carries, whichever shape the CLI used to write them.
 *
 * Validated already by `assertExecutionResult`, so this only has to choose
 * between the two shapes rather than defend against either.
 */
function questionsAsked(execution: QuestionAsked): AskedQuestion[] {
  const asked: AskedQuestion[] =
    execution.questions !== undefined && execution.questions.length > 0
      ? execution.questions
      : [
          {
            question: execution.question ?? "",
            options: execution.options ?? [],
            ...(execution.recommended === undefined
              ? {}
              : { recommended: execution.recommended }),
          },
        ];
  return asked.slice(0, MAX_AGENT_QUESTIONS).map((entry) => ({
    question: entry.question,
    options: [...entry.options],
    ...(entry.recommended === undefined
      ? {}
      : { recommended: entry.recommended }),
  }));
}

const PLAN_SHAPE_INSTRUCTIONS = [
  "Answer with exactly one JSON object and nothing else. No prose, no code fence.",
  "The object must have exactly these keys (use empty arrays where nothing applies):",
  '  taskId, objective, expectedFiles, expectedSymbols, expectedApis, expectedSchemas,',
  '  expectedConfigKeys, expectedTests, expectedServices, dependencies,',
  '  commands (array of {executable, args, label}), externalAccess,',
  '  riskLevel ("low"|"medium"|"high"|"critical"), intent (a non-empty concise string)',
  // Naming the functions is what lets somebody else work in the same file at
  // the same time: arbitration withholds the ones named here and grants the
  // rest of the file to whoever asks next. An empty list is read as a claim on
  // every file listed, whole, so it is the difference between a colleague
  // working alongside this task and one waiting for it.
  //
  // Stated as a consequence rather than a request, because the field is
  // easily read as bookkeeping. It is not: it is the difference between
  // holding two lines of a file and holding all of it. The instruction below
  // also says to go and look, since planning happens with the repository
  // open and a name guessed from the objective is worth less than one read
  // off the code.
  "expectedSymbols decides whether anyone can work in the same file as you",
  "while you work. Name every function, class or method you will add, change",
  "or remove — including ones that do not exist yet. You have the repository",
  "in front of you: open the files you named and read the declarations out,",
  "rather than guessing them from the objective.",
  "An empty list claims every file you listed, whole, and makes everybody",
  "else wait for you to finish. Leave it empty only for a change that belongs",
  "to no declaration at all — a config value, a bare data file.",
  'Asked to remove a notification bell from a header, this is ["notificationBell"],',
  "not [].",
].join("\n");

/**
 * How the explanation is expected to read.
 *
 * It is the line the channel shows when the task lands, and it was being
 * written as a changelog for whoever would read the diff next: file paths,
 * function names, the reasoning between them. Most people reading it never
 * open the diff, and the ending they got was a paragraph of implementation
 * detail cut off at the channel's bound. Asking for the short plain version
 * fixes the account itself rather than trimming one downstream.
 */
const EXPLANATION_STYLE_INSTRUCTIONS = [
  "The explanation is shown to the person who asked, in a chat, as the one " +
    "line that says how this task ended. Most of them will never read the " +
    "diff.",
  "Write it for them: one or two plain sentences saying what is different " +
    "now. No file paths, function or symbol names, code, or an account of how " +
    "you went about it — somebody who cannot read the code should still " +
    "understand it.",
  // Brevity is asked for here rather than enforced downstream. Nothing trims
  // this any more, so the only thing keeping the ending short is the ask.
  "Keep it short. The shortest ending that still says what changed is the " +
    "right one: no preamble, no restating the request back, no listing " +
    "everything you touched along the way.",
  // No character count: the reader is shown whatever this says, whole, so a
  // number here only ever taught the model to stop mid-thought near it.
  "Say the whole thing. A summary that stops halfway is worse than a shorter " +
    "one, and there is nowhere else for the reader to find the rest.",
].join("\n");

const COMPLETION_SHAPE_INSTRUCTIONS = [
  "When you are done (or blocked), answer with exactly one JSON object and nothing else:",
  '  outcome ("completed", "scope_change_requested", "scope_release_requested", "question_asked" or "action_requested"), symbolsChanged, explanation,',
  "  requestId, additionalFiles, additionalSymbols, additionalApis, additionalSchemas,",
  "  additionalConfigKeys, additionalTests, additionalServices, reason,",
  "  question, options, recommended, questions, action",
  "For completed, use empty scope fields. For scope_change_requested, fill every scope field.",
  "For scope_release_requested, put the resources you are handing back in the same scope fields and say why in reason. Use it the moment you are finished with something: it is what lets a waiting agent start.",
  'For question_asked, set requestId and either question plus options (at least two), or questions: a list of up to ' +
    String(MAX_AGENT_QUESTIONS) +
    ' objects, each with its own question, options (at least two) and recommended (the index of the one you would pick). Leave the scope fields empty.',
  "For action_requested, set requestId and action; leave the scope fields empty.",
  EXPLANATION_STYLE_INSTRUCTIONS,
].join("\n");

const FORCED_QUESTION_SHAPE_INSTRUCTIONS = [
  "This run was started with an explicit /ask command. Its first execution " +
    "round must open the question prompt before any implementation begins.",
  "Do not edit files, run commands, complete the task, request scope, or " +
    "request a platform action in this round.",
  "Answer with exactly one JSON object and nothing else. Set outcome to " +
    '"question_asked", set requestId, and put every question in questions.',
  `Ask between one and ${String(MAX_AGENT_QUESTIONS)} focused questions. ` +
    "Every question must have at least two concrete options and recommended " +
    "must be the zero-based index of the option you recommend.",
  "Ask about what you would otherwise have to guess: what the person " +
    "actually wants built, and the choices that would be expensive to get " +
    "wrong. Read enough of the repository first that the options are real.",
  "Use empty arrays for every scope field and symbolsChanged, and empty " +
    "strings for action and reason. The response will be rejected unless it " +
    "is a valid question_asked outcome.",
  "The answers arrive with the next round, which is where you implement the " +
    "task. /ask delays the work; it does not replace it.",
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

const COMPLETION_JSON_SCHEMA_DEFINITION = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: {
      type: "string",
      enum: [
        "completed",
        "scope_change_requested",
        "scope_release_requested",
        "question_asked",
        "action_requested",
      ],
    },
    symbolsChanged: STRING_ARRAY_JSON_SCHEMA,
    explanation: { type: "string" },
    requestId: { type: "string" },
    // Present only for `question_asked`, and not required, because a schema
    // that demanded them would force every ordinary completion to invent a
    // question to satisfy it.
    question: { type: "string" },
    options: STRING_ARRAY_JSON_SCHEMA,
    recommended: { type: "integer" },
    // The multi-question shape. One ask may carry up to six of them, each
    // with its own options and its own recommendation.
    questions: {
      type: "array",
      minItems: 1,
      maxItems: MAX_AGENT_QUESTIONS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: { type: "string" },
          options: STRING_ARRAY_JSON_SCHEMA,
          recommended: { type: "integer" },
        },
        required: ["question", "options"],
      },
    },
    // Present only for `action_requested`, optional for the same reason.
    action: { type: "string" },
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
} as const;

const COMPLETION_JSON_SCHEMA = JSON.stringify(
  COMPLETION_JSON_SCHEMA_DEFINITION,
);

/**
 * Claude enforces this schema at the process boundary for an explicit ask.
 * Gemini has no schema flag, so the matching runtime check in `sendContext`
 * enforces the same invariant after parsing its response.
 */
const FORCED_QUESTION_JSON_SCHEMA = JSON.stringify({
  ...COMPLETION_JSON_SCHEMA_DEFINITION,
  properties: {
    ...COMPLETION_JSON_SCHEMA_DEFINITION.properties,
    outcome: { type: "string", enum: ["question_asked"] },
    questions: {
      ...COMPLETION_JSON_SCHEMA_DEFINITION.properties.questions,
      items: {
        ...COMPLETION_JSON_SCHEMA_DEFINITION.properties.questions.items,
        properties: {
          ...COMPLETION_JSON_SCHEMA_DEFINITION.properties.questions.items
            .properties,
          question: { type: "string", minLength: 1 },
          options: { ...STRING_ARRAY_JSON_SCHEMA, minItems: 2 },
        },
        required: ["question", "options", "recommended"],
      },
    },
  },
  required: [
    ...COMPLETION_JSON_SCHEMA_DEFINITION.required,
    "questions",
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
      pendingQuestion: new Map(),
      answers: [],
      pendingAction: new Map(),
      actionResults: [],
      contention: [],
      resume: undefined,
      cancelled: false,
    });
    this.emit(this.sessions.get(session.id)!, {
      event: "progress",
      message: `${this.profile.name} planning workspace prepared`,
      occurredAt: new Date().toISOString(),
    });
    return session;
  }

  /**
   * Continues a session as the next turn of its conversation. See the
   * protocol doc: the whole record travels because this instance may never
   * have seen the session — everything a warm continuation needs is on the
   * vendor's side, named by the record's `resume` token, and adopting it is
   * building a fresh per-turn record around that name.
   *
   * Everything per-turn resets — plan, context, completion, events, waiters —
   * exactly as a `startTask` would leave it; what carries over is the
   * identity, the token, and (same-instance) the cumulative token usage,
   * which is per-session by contract.
   */
  public async continueTask(
    session: AgentSession,
    input: StartTaskInput,
  ): Promise<AgentSession> {
    if (input.repositoryId !== this.options.repository.id) {
      throw new Error(
        `${this.profile.name} adapter for ${this.options.repository.id} cannot continue a task for ${input.repositoryId}`,
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
    this.sessions.set(session.id, {
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
      tokenUsage: existing?.tokenUsage ?? [],
      scopeDecisions: [],
      pendingScope: new Map(),
      pendingQuestion: new Map(),
      answers: [],
      pendingAction: new Map(),
      actionResults: [],
      contention: [],
      resume,
      cancelled: false,
    });
    this.emit(this.sessions.get(session.id)!, {
      event: "progress",
      message:
        resume === undefined
          ? `${this.profile.name} continuing the conversation cold`
          : `${this.profile.name} resuming the conversation`,
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

  /**
   * Takes the coordinator's word for what this session may touch.
   *
   * The planning workspace goes with it: a session that will never be asked
   * to plan has no use for a second checkout of the repository, and holding
   * one would cost the very thing skipping the plan was meant to save.
   */
  public async acceptBlanketClaim(
    sessionId: string,
    plan: AgentPlan,
  ): Promise<void> {
    const record = this.requireSession(sessionId);
    record.plan = structuredClone(plan);
    await this.destroyPlanningWorkspace(record);
    this.emit(record, {
      event: "progress",
      message: `${this.profile.name} holds the whole repository and started without planning`,
      occurredAt: new Date().toISOString(),
    });
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
      await applyHolderWorkingOverlay(
        record.planningWorkspace.path,
        request.holderWorkingChanges,
      );
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
      const forceQuestion = this.forcedQuestionPending(record);
      const stdout = await this.run(
        record,
        context.workspacePath,
        this.profile.executionArgs(
          this.model,
          this.effort,
          this.profile.name === "claude"
            ? forceQuestion
              ? FORCED_QUESTION_JSON_SCHEMA
              : COMPLETION_JSON_SCHEMA
            : undefined,
        ),
        forceQuestion
          ? this.forcedQuestionPrompt(record, context)
          : this.executionPrompt(record, context),
        this.executionTimeoutMs,
        "execution",
      );
      const execution = extractJsonObject(
        this.profile.unwrap(stdout),
        "the execution result",
      );
      assertExecutionResult(execution);
      // Claude is constrained before it answers; Gemini and custom profiles
      // are constrained here. An explicit `/ask` must never silently turn
      // into a completion, scope request or platform action because a model
      // ignored the prompt that distinguishes this round.
      if (forceQuestion && execution.outcome !== "question_asked") {
        throw new TypeError(
          "An explicit /ask command must produce a question_asked outcome before execution",
        );
      }
      if (
        forceQuestion &&
        execution.outcome === "question_asked" &&
        (execution.questions === undefined ||
          execution.questions.length === 0 ||
          execution.questions.some((question) => question.recommended === undefined))
      ) {
        throw new TypeError(
          "An explicit /ask command must produce one to six questions with recommendations",
        );
      }
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

      if (execution.outcome === "question_asked") {
        const askId = execution.requestId.trim() || createId("question");
        const asked = questionsAsked(execution);
        const first = asked[0];
        if (first === undefined) {
          throw new Error("A question was asked with nothing in it");
        }
        const waiting = this.createQuestionWaiter(record, askId);
        this.emit(record, {
          event: "question_asked",
          requestId: askId,
          question: first.question,
          options: [...first.options],
          ...(first.recommended === undefined
            ? {}
            : { recommended: first.recommended }),
          questions: asked.map((entry) => ({
            question: entry.question,
            options: [...entry.options],
            ...(entry.recommended === undefined
              ? {}
              : { recommended: entry.recommended }),
          })),
          occurredAt: new Date().toISOString(),
        });
        const answer = await waiting;
        // Nobody answered. The agent asked because the decision was not its
        // to make, and silence does not hand it back — so the run ends here
        // rather than guessing on somebody's behalf. Skipping is not silence:
        // it is somebody handing this one decision back deliberately, which
        // the loop below records as such.
        if (answer.status !== "answered") {
          throw new Error(
            `No answer to "${first.question}" — the task was cancelled ` +
              `rather than guessed at.`,
          );
        }
        const choices: QuestionChoice[] =
          answer.answers ??
          (answer.chosen === undefined ? [] : [{ chosen: answer.chosen }]);
        if (choices.length === 0) {
          throw new Error(
            `No answer to "${first.question}" — the task was cancelled ` +
              `rather than guessed at.`,
          );
        }
        for (const [index, entry] of asked.entries()) {
          const choice = choices[index];
          const chose =
            choice === undefined || choice.skipped === true
              ? "(you decide)"
              : (choice.text?.trim() ??
                entry.options[choice.chosen ?? -1] ??
                "(you decide)");
          this.emit(record, {
            event: "progress",
            message: `Answered: ${chose}`,
            occurredAt: new Date().toISOString(),
          });
          record.answers.push({ question: entry.question, chose });
        }
        continue;
      }

      if (execution.outcome === "action_requested") {
        const askId = execution.requestId.trim() || createId("action");
        const waiting = this.createActionWaiter(record, askId);
        this.emit(record, {
          event: "action_requested",
          requestId: askId,
          action: execution.action,
          occurredAt: new Date().toISOString(),
        });
        // The platform always answers — done or refused, never silence (see
        // `handleActionRequest` in the coordinator) — so unlike a question
        // there is no deadline to fall on. A refusal is a real answer: the
        // next round's prompt carries it, and the agent finishes by
        // reporting it rather than by retrying.
        const result = await waiting;
        record.actionResults.push(structuredClone(result));
        this.emit(record, {
          event: "progress",
          message:
            `Platform ${result.outcome === "done" ? "performed" : "refused"} ` +
            `${execution.action}: ${result.explanation}`,
          occurredAt: new Date().toISOString(),
        });
        continue;
      }
      const requestId = execution.requestId.trim() || createId("scope");
      const pending = this.createScopeWaiter(record, requestId);
      if (execution.outcome === "scope_release_requested") {
        // The same round trip as a widening, in the other direction: the
        // coordinator answers with the plan now in force, and a granted
        // release means the named files are somebody else's from here on.
        this.emit(record, {
          event: "scope_release_requested",
          requestId,
          releasedFiles: [...execution.additionalFiles],
          releasedSymbols: [...execution.additionalSymbols],
          releasedApis: [...execution.additionalApis],
          releasedSchemas: [...execution.additionalSchemas],
          releasedConfigKeys: [...execution.additionalConfigKeys],
          releasedTests: [...execution.additionalTests],
          releasedServices: [...execution.additionalServices],
          reason: execution.reason,
          occurredAt: new Date().toISOString(),
        });
        const released = await pending;
        record.scopeDecisions.push(structuredClone(released));
        if (scopeChangeGranted(released)) {
          // The narrowed plan is what the next round is prompted with, so the
          // agent cannot go on believing it may edit what it just gave back.
          record.plan = structuredClone(released.revisedPlan);
        }
        this.emit(record, {
          event: "progress",
          message:
            `Scope release ${requestId} was ${released.decision}; ` +
            `${this.profile.name} execution is continuing`,
          occurredAt: new Date().toISOString(),
        });
        continue;
      }
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

  /**
   * Records that another task is waiting on part of what this session holds.
   *
   * Kept for the next round's prompt rather than pushed at the running
   * process: there is nothing to push to — each round is its own CLI
   * invocation — and the round boundary is the only moment an agent can
   * actually answer with a release.
   *
   * Silent about a session it does not know or has already cancelled. This is
   * advice, and advice that arrives late is not a failure of the run that
   * sent it. The same notice twice is dropped: repeating it would fill the
   * prompt with the queue rather than with the work.
   */
  public async noteScopeContention(
    sessionId: string,
    notice: ScopeContentionNotice,
  ): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (record === undefined || record.cancelled) {
      return;
    }
    const fingerprint = (entry: ScopeContentionNotice): string =>
      JSON.stringify({
        taskId: entry.taskId,
        files: [...entry.files].sort(),
        symbols: [...(entry.symbols ?? [])].sort(),
        apis: [...(entry.apis ?? [])].sort(),
        schemas: [...(entry.schemas ?? [])].sort(),
        configKeys: [...(entry.configKeys ?? [])].sort(),
        tests: [...(entry.tests ?? [])].sort(),
        services: [...(entry.services ?? [])].sort(),
      });
    const known = fingerprint(notice);
    if (record.contention.some((seen) => fingerprint(seen) === known)) {
      return;
    }
    record.contention.push(structuredClone(notice));
    const waitingOn =
      notice.files.length > 0
        ? notice.files.join(", ")
        : "resources this task holds";
    this.emit(record, {
      event: "progress",
      message: `Another task is waiting on ${waitingOn}`,
      occurredAt: new Date().toISOString(),
    });
  }

  public async cancel(sessionId: string): Promise<void> {
    const record = this.requireSession(sessionId);
    record.cancelled = true;
    record.eventHandlers.clear();
    for (const pending of record.pendingScope.values()) {
      pending.reject(new Error(`Session ${sessionId} was cancelled`));
    }
    record.pendingScope.clear();
    // Questions and actions wait between rounds, where no process is running
    // for the abort controller to kill. Left pending they would hold the
    // execution loop's await open after the session is gone — a stop that
    // lands mid-question would take until the question's own deadline to be
    // felt, and one mid-action until the action returned.
    for (const pending of record.pendingQuestion.values()) {
      pending.reject(new Error(`Session ${sessionId} was cancelled`));
    }
    record.pendingQuestion.clear();
    for (const pending of record.pendingAction.values()) {
      pending.reject(new Error(`Session ${sessionId} was cancelled`));
    }
    record.pendingAction.clear();
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
    // An empty changeset is reported, never thrown.
    //
    // This used to fail the task unless the objective read as a request to
    // look, on the reasoning that work meant to write and writing nothing has
    // a defect behind it. The reasoning holds; the test for it does not. It
    // had to guess a person's intent from their words, and it guessed wrong
    // often enough that ordinary requests — a one-word "GitHub", a question
    // phrased as an instruction, an agent correctly answering that there was
    // nothing to do — came back as failures with a message about broken
    // authentication. Being told your CLI is unauthenticated when it is not
    // sends you somewhere there is nothing to find.
    //
    // The empty result travels on and is narrated as what it is: finished
    // without changing anything. A genuinely unauthenticated CLI still shows
    // up — it just shows up as a task that did nothing, which is what the
    // reader can see for themselves, rather than as a diagnosis this layer is
    // not in a position to make.
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
    // A held resume token rides on every invocation — planning, replanning
    // and each execution round alike — so the whole turn happens inside the
    // vendor session the conversation has been having, not beside it.
    const resume = record.resume;
    const resumeArgs = this.profile.resumeArgs;
    const resumable = resume !== undefined && resumeArgs !== undefined;
    let output = await this.spawn(
      record,
      workingDirectory,
      resumable ? [...args, ...resumeArgs(resume)] : [...args],
      prompt,
      timeoutMs,
      // Only execution streams; see the Claude profile's `executionArgs`.
      phase === "execution",
    );
    if (
      output.exitCode !== 0 &&
      resumable &&
      output.aborted !== true &&
      output.timedOut !== true
    ) {
      // A stale session id (restart, CLI cleanup) costs the conversation
      // its memory, not the turn: retried once without the flag, the same
      // policy the chat providers apply. The token is dropped first, so a
      // later round in this same turn does not repeat the failure.
      record.resume = undefined;
      output = await this.spawn(
        record,
        workingDirectory,
        [...args],
        prompt,
        timeoutMs,
        phase === "execution",
      );
    }
    if (output.exitCode !== 0) {
      const reason =
        output.stderr.trim() ||
        output.stdout.trim() ||
        `exit code ${output.exitCode}`;
      throw new Error(`${this.profile.name} execution failed: ${reason}`);
    }
    // Truncation is no longer a failure. The stream carries every thinking
    // step and tool result, so a long run can outgrow any cap — and this
    // used to fail the whole round as "output exceeded the configured
    // limit". The runner now retains the *tail* of the stream, and every
    // durable payload — the result envelope, the usage block, the vendor
    // session id — lives on the final line, so a truncated head costs
    // nothing the parsers below need. A stream whose retained tail still
    // holds no envelope fails in the parser, with a message that says what
    // is actually missing.
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
    // Overwritten, never written once: a resumed run forks a fresh vendor
    // session id, and the newest one is what names the state as this
    // invocation left it.
    const vendorSession = this.profile.sessionId?.(output.stdout);
    if (vendorSession !== undefined) {
      record.resume = vendorSession;
    }
    return output.stdout;
  }

  /**
   * Turns a streamed run's output into progress events as it arrives.
   *
   * Chunks arrive on no particular boundary, so lines are reassembled here
   * rather than assumed — a JSON object split across two reads would
   * otherwise be two unparseable fragments and one lost sentence.
   *
   * Everything here is best effort by construction. Narration is commentary
   * on a run, and a run must not fail because its commentary could not be
   * parsed: an unreadable line is skipped, and the result is still read from
   * the buffered stdout at exit exactly as it was before.
   */
  private narrator(record: PromptCliSession): (chunk: string) => void {
    let pending = "";
    return (chunk: string): void => {
      pending += chunk;
      let index = pending.indexOf("\n");
      while (index !== -1) {
        const line = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        index = pending.indexOf("\n");
        if (line.length === 0) {
          continue;
        }
        let said: string | undefined;
        try {
          said = this.profile.narrate?.(JSON.parse(line));
        } catch {
          said = undefined;
        }
        if (said !== undefined) {
          this.emit(record, {
            event: "progress",
            message: said,
            occurredAt: new Date().toISOString(),
          });
        }
      }
      // A tail without a newline is held rather than dropped: the next chunk
      // usually completes it, and at exit the result is read from stdout
      // anyway, so nothing depends on this ever finishing a line.
      if (pending.length > MAX_NARRATION_TAIL) {
        pending = "";
      }
    };
  }

  /** One process, with the record's active/controller bookkeeping around it. */
  private async spawn(
    record: PromptCliSession,
    workingDirectory: string,
    argv: string[],
    prompt: string,
    timeoutMs: number,
    /** Set while executing, so a streamed run can say what it is doing. */
    narrate = false,
  ): Promise<ProcessOutput> {
    const controller = new AbortController();
    record.controller = controller;
    // Prefer stdin so objectives are not visible in the process list. A few
    // vendor CLIs expose non-interactive mode only through a positional
    // prompt; their profile opts into that explicitly above.
    const promptInArgument = this.profile.promptDelivery === "argument";
    const promptArguments =
      this.profile.promptDelivery === "arguments"
        ? splitPromptArguments(prompt)
        : promptInArgument
          ? [prompt]
          : [];
    const active = this.runner(
      this.command,
      promptArguments.length === 0 ? argv : [...argv, ...promptArguments],
      {
        cwd: workingDirectory,
        ...(promptArguments.length === 0 ? { input: prompt } : {}),
        ...(this.options.env === undefined ? {} : { env: this.options.env }),
        timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        // The end of the stream is the payload: the result envelope is the
        // last line, and head retention was guaranteed to discard it on
        // exactly the long runs that most needed to finish. The narrator
        // still sees every byte live regardless of what is retained.
        retainOutput: "tail",
        signal: controller.signal,
        ...(narrate && this.profile.narrate !== undefined
          ? { onStdout: this.narrator(record) }
          : {}),
      },
    );
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
        // Fresh input only. Cache traffic is billed and stays in
        // `totalTokens`, which is what budgets are enforced against, but
        // folding it in here left nothing anywhere that meant "new tokens
        // this run" — and a room's "tokens spent" line, built from the split,
        // then counted the same cached prefix once per turn and read in the
        // millions. The cached figure is recoverable as the difference
        // between `totalTokens` and the two sides.
        inputTokens: current.inputTokens + entry.inputTokens,
        outputTokens: current.outputTokens + entry.outputTokens,
      });
    }
    return [...totals].map(([phase, sums]) => ({
      phase,
      ...sums,
      freshTokens: sums.inputTokens + sums.outputTokens,
    }));
  }

  /**
   * Hands the agent a promise for what a person will say.
   *
   * No timer of its own, unlike the scope waiter. A question is answered by
   * somebody who may be at lunch, and the coordinator is what knows how long
   * that is allowed to take — putting a second deadline here would mean two
   * clocks disagreeing about when the same wait ended.
   */
  private createQuestionWaiter(
    record: PromptCliSession,
    requestId: string,
  ): Promise<QuestionAnswer> {
    if (record.pendingQuestion.has(requestId)) {
      throw new Error(
        `${this.profile.name} repeated pending question ${requestId}`,
      );
    }
    let resolvePromise: (answer: QuestionAnswer) => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const promise = new Promise<QuestionAnswer>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    record.pendingQuestion.set(requestId, {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    });
    return promise;
  }

  public async resolveQuestion(
    sessionId: string,
    answer: QuestionAnswer,
  ): Promise<void> {
    const record = this.requireSession(sessionId);
    const pending = record.pendingQuestion.get(answer.requestId);
    if (pending === undefined) {
      throw new Error(`Unknown question ${answer.requestId}`);
    }
    record.pendingQuestion.delete(answer.requestId);
    pending.resolve(structuredClone(answer));
  }

  private createActionWaiter(
    record: PromptCliSession,
    requestId: string,
  ): Promise<AgentActionResult> {
    if (record.pendingAction.has(requestId)) {
      throw new Error(
        `${this.profile.name} repeated pending action ${requestId}`,
      );
    }
    let resolvePromise: (result: AgentActionResult) => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const promise = new Promise<AgentActionResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    record.pendingAction.set(requestId, {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    });
    return promise;
  }

  public async resolveAction(
    sessionId: string,
    result: AgentActionResult,
  ): Promise<void> {
    const record = this.requireSession(sessionId);
    const pending = record.pendingAction.get(result.requestId);
    if (pending === undefined) {
      throw new Error(`Unknown action ${result.requestId}`);
    }
    record.pendingAction.delete(result.requestId);
    pending.resolve(structuredClone(result));
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
      `Objective: ${input.task.objective.replace(FORCE_QUESTION_MARKER, "").trim()}`,
      // An explicit `/ask` still ends in code, so the plan has to be a plan
      // for that code — otherwise the round after the answers arrive has an
      // empty scope to implement inside.
      ...(input.task.objective.includes(FORCE_QUESTION_MARKER)
        ? [
            "This task opens a short clarification round with the person " +
              "before implementation. Plan the implementation you expect to " +
              "carry out once they answer, listing every file it is likely " +
              "to touch.",
          ]
        : []),
      // See the codex adapter's equivalent: notes from earlier tasks, offered
      // as background rather than as fact.
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
      ...(request.holderWorkingChanges === undefined ||
      request.holderWorkingChanges.length === 0
        ? []
        : [
            "Holder working changes (in-progress edits from tasks you are " +
              "waiting on — already overlaid into this planning workspace; " +
              "treat them as the likely result of those tasks, not as fact):",
            JSON.stringify(request.holderWorkingChanges),
          ]),
      `Coordinator constraints: ${JSON.stringify(request.constraints)}`,
      "Account for changed dependencies and remove stale file assumptions.",
      PLAN_SHAPE_INSTRUCTIONS,
    ].join("\n");
  }

  private executionPrompt(
    record: PromptCliSession,
    context: CoordinatorContext,
  ): string {
    const taskObjective = this.isForcedQuestionTask(record)
      ? record.input.task.objective.replace(FORCE_QUESTION_MARKER, "").trim()
      : record.input.task.objective;
    const approvedPlan =
      record.plan === undefined
        ? undefined
        : { ...record.plan, objective: taskObjective, commands: [] };
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
        `Task, for context only: ${taskObjective}`,
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
      "Skip optional polish, broad exploration, and repeated validation.",
      // Deliberately hedged about. Asking is the right move for a genuine
      // fork and the wrong one for anything a reasonable engineer would
      // simply decide — and the cost of over-asking is invisible from in
      // here: the run holds its workspace and its ownership leases while it
      // waits, so other work queues behind the question, and nobody
      // answering ends the task outright.
      "You may stop and ask, but only for a decision that is genuinely not " +
        "yours: work that would be thrown away if you guessed wrong, or a " +
        "choice between approaches with different consequences for the " +
        "person who asked. Do not ask to confirm something you can check, " +
        "or to be told a preference you can infer. Prefer deciding and " +
        "saying what you assumed in the explanation.",
      "To ask, answer with a question_asked outcome carrying the question " +
        "and at least two concrete options. Somebody has a limited time to " +
        "answer; if nobody does, the task is cancelled, so ask once and ask " +
        "for the thing that actually blocks you.",
      // One prompt, not one per decision. Each ask holds the workspace and
      // the leases for as long as it waits, so a run blocked on three things
      // that asks three times costs three of those waits and three chances
      // for nobody to be around.
      `Ask everything that blocks you in that one outcome — up to ${String(
        MAX_AGENT_QUESTIONS,
      )} questions in the questions list, each with its own options. Set ` +
        "recommended on each to the option you would pick yourself: the " +
        "person answering sees it marked, and agreeing with you is one tap.",
      // The incident behind this sentence: an agent blocked on credentials
      // offered "have the operator provision credentials to the runner",
      // waited, got an answer — and nothing anywhere could act on it. An
      // answer is one word back into this same session; anything that needs
      // hands other than yours cannot happen no matter what is chosen.
      "Every option must be something you can do yourself, in this " +
        "workspace, once the answer arrives — choosing an option changes " +
        "nothing outside this session. Never offer actions that need " +
        "somebody else to do something (provision credentials, change the " +
        "deployment, grant access, install software on the host): nobody " +
        "can, and the answer would be wasted. If the task is blocked on " +
        "something like that, do not ask — answer with a failed outcome " +
        "explaining exactly what is missing, so the person can fix it and " +
        "resubmit.",
      // The platform's own verbs, distinct from questions: a question goes
      // to a person, an action goes to the machinery. Without this
      // paragraph the actions existed and no prompt-CLI agent had any way
      // to learn so — "push to GitHub" was a request the two most common
      // agents could not satisfy by any route, including the git they hold:
      // the workspace's remote is the local canonical mirror, and no
      // credential for anything beyond it is ever in their environment.
      "The platform can perform a small fixed set of actions for you. To " +
        "ask, answer with an action_requested outcome carrying requestId " +
        'and action. The actions: "push" publishes this repository\'s ' +
        "accepted canonical state to its recorded remote on a fresh branch " +
        "— use it when asked to push or publish to GitHub; your own `git " +
        "push` cannot reach the remote from this workspace, so never try " +
        'it. "pull" brings the platform\'s copy of this repository up to ' +
        "date from its GitHub remote — use it when asked to pull, sync, or " +
        "update from GitHub; a `git pull` in this workspace reaches only " +
        "the platform's local mirror and updates nothing anyone else can " +
        'see. "preview_start" runs this repository\'s app and answers with ' +
        'its URL; "preview_stop" stops it. The platform answers done or ' +
        "refused with an explanation either way. A refusal is final for " +
        "this run — do not retry it; finish with a completed outcome whose " +
        "explanation relays the refusal's reason, so the person who asked " +
        "can act on it.",
      "When an action's result is the whole of what was asked for — a " +
        "requested push, for example — finish with a completed outcome " +
        "whose explanation reports the action's own result, even though " +
        "you changed no files. Changing files is not the goal of such a " +
        "task; the action was.",
      "Do not modify files outside expectedFiles without first answering with a scope_change_requested outcome.",
      // The standing instruction. Handing scope back used to be mentioned
      // only in the schema note — mechanically, as one of five outcomes — and
      // no agent ever volunteered it, so an over-claimed plan held every file
      // it named until the task settled.
      "Hand files back as you finish with them, without waiting to be asked. " +
        "Everything in expectedFiles is yours alone until this task ends, so " +
        "a file you stopped needing in the first ten minutes blocks whoever " +
        "wants it for the rest of the run. When you know you will not touch " +
        "one again, answer with a scope_release_requested outcome naming it " +
        "in the same scope fields, with a reason; you carry on working " +
        "inside what is left.",
      "Release nothing you still have edits in or may still touch. A file " +
        "with uncommitted changes is refused — correctly, it is not finished " +
        "with — and asking for a released file back is a scope change that " +
        "is refused if somebody else has taken it by then.",
      ...(record.contention.length === 0
        ? []
        : [
            "Tasks are queued behind resources you hold right now: " +
              JSON.stringify(record.contention),
            "Each of them is stopped until you release what it names or this " +
              "task ends. Release now whatever you have finished with — that " +
              "is all it takes for the waiting task to start — and keep the " +
              "rest. If you are still working in every one of them, say so " +
              "in your explanation and carry on.",
          ]),
      "Do not change Git metadata.",
      `Task: ${taskObjective}`,
      `Approved plan: ${JSON.stringify(approvedPlan)}`,
      ...(approvedPlan !== undefined && isBlanketClaim(approvedPlan)
        ? [
            "You hold the whole repository: nobody asked you for a file " +
              "list because nothing else is running here, so edit whatever " +
              "the objective genuinely requires. If another task starts " +
              "while you work, your claim is narrowed to the directories " +
              "you have already touched, and reaching outside them from " +
              "then on can be refused — so if you are told a file is " +
              "taken, report that honestly instead of editing it anyway.",
          ]
        : []),
      `Coordinator decision: ${JSON.stringify(context.decision)}`,
      `Prior scope decisions: ${JSON.stringify(record.scopeDecisions)}`,
      // Answers already given, so a second round does not ask the same thing
      // again — the CLI is re-invoked per round and remembers nothing of the
      // last one.
      `Answers you already have: ${JSON.stringify(record.answers)}`,
      ...(this.isForcedQuestionTask(record)
        ? [
            "The explicit /ask question round has already been satisfied. " +
              "Use the answers above and continue the task; do not ask the " +
              "same questions again.",
          ]
        : []),
      // Same replay for actions: the round after a push has to know the push
      // happened — and where it landed — or it would ask again.
      `Platform actions already performed: ${JSON.stringify(record.actionResults)}`,
      `Canonical revision: ${context.canonicalVersion.revision}`,
      `Coordinator validation labels (do not execute): ${JSON.stringify(validationLabels)}`,
      COMPLETION_SHAPE_INSTRUCTIONS,
    ].join("\n");
  }

  /** Whether this task came from the channel's explicit `/ask` command. */
  private isForcedQuestionTask(record: PromptCliSession): boolean {
    return record.input.task.objective.includes(FORCE_QUESTION_MARKER);
  }

  /** The forced round is complete as soon as at least one answer is recorded. */
  private forcedQuestionPending(record: PromptCliSession): boolean {
    return this.isForcedQuestionTask(record) && record.answers.length === 0;
  }

  /**
   * A dedicated first-round prompt rather than stronger wording inside the
   * normal implementation prompt. Mixing "implement now" and "only ask" in
   * one instruction leaves the model a choice; this round has exactly one
   * valid operation and a schema that says the same thing.
   */
  private forcedQuestionPrompt(
    record: PromptCliSession,
    context: CoordinatorContext,
  ): string {
    const markerAt = record.input.task.objective.indexOf(FORCE_QUESTION_MARKER);
    const objective = record.input.task.objective.slice(0, markerAt).trim();
    const approvedPlan =
      record.plan === undefined
        ? undefined
        : { ...record.plan, objective, commands: [] };
    return [
      FORCED_QUESTION_SHAPE_INSTRUCTIONS,
      `Task: ${objective}`,
      `Thread/context that led to this task: ${record.input.task.context ?? ""}`,
      `Approved plan: ${JSON.stringify(approvedPlan)}`,
      `Canonical revision: ${context.canonicalVersion.revision}`,
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

export function createCursorAdapter(
  options: NamedPromptCliOptions,
): PromptCliAdapter {
  return new PromptCliAdapter({ ...options, profile: CURSOR_PROFILE });
}

export function createCopilotAdapter(
  options: NamedPromptCliOptions,
): PromptCliAdapter {
  return new PromptCliAdapter({ ...options, profile: COPILOT_PROFILE });
}

export function createKiroAdapter(
  options: NamedPromptCliOptions,
): PromptCliAdapter {
  return new PromptCliAdapter({ ...options, profile: KIRO_PROFILE });
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
