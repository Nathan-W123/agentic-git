import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, type Dirent } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  extractJsonObject,
  resolveClaudeCommand,
} from "@coord/adapter-prompt-cli";
import type { CoordinatorProject } from "@coord/cli/project";
import {
  runProcess,
  sanitizeChildEnv,
  type ProcessOutput,
} from "@coord/repository-service";
import {
  supportedCredentialKinds,
  UserCredentialError,
  UserCredentialStore,
  assertSessionFile,
  captureClaudeSession,
  credentialHint,
  SESSION_FILE_SHARES_REFRESH_TOKEN,
  withCredentialHome,
  type CredentialHome,
  type CredentialVisibility,
  type UserCredential,
  type UserCredentialKind,
  type UserCredentialSummary,
  type VendorCliKind,
} from "@coord/workspace-manager";

/**
 * Direct provider chat for the dashboard's agent panel, in the VS Code
 * Copilot-Chat mold: you *sign in with the provider account*, never paste an
 * API key. Concretely, each provider is backed by its vendor CLI and that
 * CLI's own OAuth login:
 *
 * - **OpenAI** — the Codex CLI, signed in with a ChatGPT account
 *   (`codex login`). Completions run `codex exec --json` in read-only
 *   sandbox mode; usage (including reasoning tokens) and reasoning summaries
 *   come from its event stream, and the model/effort options offered are the
 *   ones the signed-in account's own `models_cache.json` reports.
 * - **Anthropic** — Claude Code, signed in with a claude.ai account
 *   (`claude login` / `claude auth status`). Completions run headless
 *   stream-json; usage, cost, thinking-token counts, and the subscription
 *   rate-limit window all come from the CLI's events.
 * - **Google** — the Gemini CLI's "Sign in with Google" OAuth. Detection and
 *   sign-in are real, but connecting validates eligibility with a live call
 *   and refuses with the provider's own error when the signed-in account
 *   cannot use the service, rather than degrading to anything fake.
 *
 * Every number surfaced traces to something a CLI actually reported; every
 * option offered is one the connected account actually exposes. Where a CLI
 * exposes nothing programmatically (Claude Code has no model-list command),
 * that absence is stated instead of papered over with a guessed list.
 *
 * ### Two ways to be connected
 *
 * **Own account** — the user supplies a credential they minted themselves
 * (`claude setup-token`, or an API key) and it is stored encrypted per user.
 * Their prompts run under their account and bill it. Any user may do this;
 * see `@coord/workspace-manager`'s user-credentials module for why a
 * server-side OAuth grant is not available from these vendors and what is
 * used instead.
 *
 * **Host login** — the deployment's own machine is signed in via the vendor
 * CLI and every prompt spends the *host owner's* account. That is the
 * original single-operator arrangement, and because one person pays for
 * everyone it stays restricted to system administrators.
 *
 * A user's own credential is preferred whenever one exists, so a deployment
 * can move from the shared login to per-user accounts one user at a time
 * without a flag day.
 */

export type ProviderId = "anthropic" | "openai" | "google";
export const PROVIDER_IDS: readonly ProviderId[] = [
  "anthropic",
  "openai",
  "google",
];

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  /** Reasoning/thought tokens, when the provider accounts for them. */
  thinkingTokens?: number;
  costUsd?: number;
}

export interface ChatRateLimit {
  source: "cli-window";
  windowKind?: string;
  windowStatus?: string;
  windowResetsAt?: string;
}

/** One consumption figure a CLI reports for the signed-in account. */
export interface ProviderUsageWindow {
  label: string;
  percentUsed: number;
  /** Reset moment exactly as the CLI worded it; it carries its own zone. */
  resetsAt?: string;
}

export interface ProviderUsageReport {
  /** Where these numbers came from, shown to the user verbatim-ish. */
  source: string;
  windows: ProviderUsageWindow[];
  /** Set when the CLI publishes no consumption figure at all. */
  unavailableReason?: string;
}

export interface ChatReply {
  provider: ProviderId;
  model: string;
  text: string;
  /** Reasoning content when the provider exposes it; absent otherwise. */
  thinking?: string;
  /** Reasoning happened but its content is withheld by the provider. */
  thinkingHidden?: boolean;
  usage: ChatUsage;
  rateLimit?: ChatRateLimit;
  /** Continues the CLI conversation server-side (claude session / codex thread). */
  cliSessionId?: string;
  /** The model context window, when the CLI reports it. */
  contextWindow?: number;
}

export interface ProviderSettings {
  model?: string;
  effort?: string;
}

export interface ProviderCliState {
  detected: boolean;
  loggedIn: boolean;
  /** Human-readable identity, e.g. "ChatGPT account" or an email. */
  account?: string;
  /** Subscription/plan, when the CLI reports one (e.g. claude auth status). */
  plan?: string;
  /** Why this provider cannot be used despite a real login, verbatim-ish. */
  blockedReason?: string;
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  connected: boolean;
  kind?: "account" | "own-credential";
  /** Effective model/effort after per-user settings. */
  model: string;
  effort?: string;
  cli: ProviderCliState;
  exposesThinking: boolean;
  /**
   * Whether *this user, right now* would need administrator rights to use the
   * provider — true only when they would be falling back to the shared host
   * login. Connecting an own credential clears it.
   */
  requiresAdmin: boolean;
  /** The user's own stored credential, without the secret. */
  ownCredential?: UserCredentialSummary;
  /** Credential kinds this provider can accept from a user. */
  acceptedCredentialKinds: UserCredentialKind[];
  /**
   * How this provider signs a user in through their browser, or absent when
   * it cannot.
   *
   * The screen needs this to decide what to offer before anything is clicked:
   * a provider that can sign in should lead with that rather than asking
   * somebody to go and find a credential, and the two modes render
   * differently — `approve` shows a code to confirm, `code_exchange` shows a
   * box to paste the browser's code into. Reported by the server because only
   * the server knows which CLIs are drivable.
   */
  signInFlow?: DeviceAuthMode;
}

/** Which providers can be signed into from here, and how. */
const SIGN_IN_FLOWS: Partial<Record<ProviderId, DeviceAuthMode>> = {
  openai: "approve",
  anthropic: "code_exchange",
  // Google is deliberately absent: the Gemini CLI has no login subcommand —
  // authentication is a menu inside its interactive UI — so there is nothing
  // here to drive.
};

export interface ProviderModelOption {
  id: string;
  label: string;
  description?: string;
  efforts?: string[];
  defaultEffort?: string;
  contextWindow?: number;
}

export interface ProviderOptions {
  /** null when the provider exposes no model list programmatically. */
  models: ProviderModelOption[] | null;
  modelListSource?: string;
  /** Efforts valid when the model list carries none (Anthropic). */
  efforts: string[] | null;
  allowCustomModel: boolean;
  notes: string[];
}

export class ProviderChatError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderChatError";
  }
}

interface StoredConnection {
  kind: "account";
  createdAt: string;
  settings?: ProviderSettings;
}

type ConnectionFile = Record<
  string,
  Partial<Record<ProviderId, StoredConnection>>
>;

const PROVIDER_NAMES: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

/** The dashboard names providers by vendor; the CLIs name them by tool. */
const PROVIDER_VENDORS: Record<ProviderId, VendorCliKind> = {
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
};

/** The inverse of {@link PROVIDER_VENDORS}, for reporting a stored vendor back. */
const VENDOR_PROVIDERS: Record<VendorCliKind, ProviderId> = {
  claude: "anthropic",
  codex: "openai",
  gemini: "google",
};

/** What a user has to do to obtain a credential we can accept. */
export const CREDENTIAL_INSTRUCTIONS: Record<ProviderId, string[]> = {
  anthropic: [
    "Run `claude setup-token` on your own machine and finish the browser " +
      "sign-in. It prints a long-lived token starting `sk-ant-oat` that " +
      "spends your own Claude subscription.",
    "Or paste an Anthropic API key from console.anthropic.com, which bills " +
      "that key's account instead.",
  ],
  openai: [
    "Sign in with your ChatGPT account: this deployment shows you a link and " +
      "a one-time code, you approve it in your own browser, and the session " +
      "it receives is its own — nothing of yours is copied.",
    "Or paste an OpenAI API key from platform.openai.com, which bills that " +
      "key's account instead of your subscription.",
  ],
  google: [
    "Paste a Google AI Studio API key from aistudio.google.com. This is the " +
      "recommended way to connect Gemini.",
    "Advanced: paste the contents of ~/.gemini/oauth_creds.json to use your " +
      `Google subscription. ${SESSION_FILE_SHARES_REFRESH_TOKEN}`,
  ],
};

/** Names the window a Codex rate limit covers, from its own minute count. */
function codexWindowLabel(minutes: number): string {
  if (minutes % (60 * 24 * 30) === 0) {
    const months = minutes / (60 * 24 * 30);
    return months === 1 ? "month" : `${months} months`;
  }
  if (minutes % (60 * 24 * 7) === 0) {
    const weeks = minutes / (60 * 24 * 7);
    return weeks === 1 ? "week" : `${weeks} weeks`;
  }
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return days === 1 ? "day" : `${days} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "hour" : `${hours} hours`;
  }
  return `${minutes} minutes`;
}

interface CodexRateWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

/**
 * Pulls the last `rate_limits` object out of a Codex rollout file. Only
 * windows the CLI actually filled in become bars; nulls stay absent.
 * Exported for tests.
 */
export function parseCodexRateLimits(
  contents: string,
): ProviderUsageReport | undefined {
  const marker = '"rate_limits":';
  const at = contents.lastIndexOf(marker);
  if (at === -1) {
    return undefined;
  }
  // The object runs to the end of its own JSON line.
  const lineEnd = contents.indexOf("\n", at);
  const line = contents.slice(
    contents.lastIndexOf("\n", at) + 1,
    lineEnd === -1 ? undefined : lineEnd,
  );
  let limits:
    | {
        primary?: CodexRateWindow | null;
        secondary?: CodexRateWindow | null;
        plan_type?: string | null;
      }
    | undefined;
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const found = findRateLimits(event);
    limits = found as typeof limits;
  } catch {
    return undefined;
  }
  if (limits === undefined) {
    return undefined;
  }
  const windows: ProviderUsageWindow[] = [];
  for (const [name, window] of [
    ["primary", limits.primary],
    ["secondary", limits.secondary],
  ] as const) {
    if (
      window === null ||
      window === undefined ||
      typeof window.used_percent !== "number"
    ) {
      continue;
    }
    windows.push({
      label:
        typeof window.window_minutes === "number"
          ? codexWindowLabel(window.window_minutes)
          : name,
      percentUsed: Math.max(0, Math.min(100, window.used_percent)),
      ...(typeof window.resets_at === "number"
        ? {
            resetsAt: new Date(window.resets_at * 1000).toLocaleString(
              undefined,
              { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
            ),
          }
        : {}),
    });
  }
  return windows.length === 0
    ? undefined
    : { source: "Codex CLI", windows };
}

/** Finds the `rate_limits` object wherever the CLI nested it. */
function findRateLimits(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record["rate_limits"] !== undefined && record["rate_limits"] !== null) {
    return record["rate_limits"];
  }
  for (const nested of Object.values(record)) {
    const found = findRateLimits(nested);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * Reads the percentages out of `claude -p "/usage" --output-format json`.
 * The CLI prints lines like:
 *   Current session: 36% used · resets Jul 29, 10:59am (America/Los_Angeles)
 *   Current week (all models): 19% used · resets Jul 31, 9:59am (...)
 * Only lines matching that shape become windows; anything else is ignored
 * rather than guessed at.
 */
export function parseClaudeUsage(stdout: string): ProviderUsageReport {
  const source = "claude /usage, as reported by the signed-in account";
  let text: string;
  try {
    const envelope = JSON.parse(stdout) as { result?: unknown };
    text = typeof envelope.result === "string" ? envelope.result : stdout;
  } catch {
    text = stdout;
  }
  const windows: ProviderUsageWindow[] = [];
  const line =
    /^\s*(Current [^:]+):\s*(\d{1,3})%\s*used(?:\s*·\s*resets\s*([^\n]+?))?\s*$/gimu;
  for (const match of text.matchAll(line)) {
    const percent = Number(match[2]);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      continue;
    }
    windows.push({
      label: (match[1] as string).replace(/^Current\s+/iu, "").trim(),
      percentUsed: percent,
      ...(match[3] === undefined ? {} : { resetsAt: match[3].trim() }),
    });
  }
  return windows.length > 0
    ? { source, windows }
    : {
        source,
        windows: [],
        unavailableReason:
          "The claude CLI did not report a usage percentage in this run.",
      };
}

/** Real `--effort` values the Claude CLI accepts. */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";
const DEFAULT_CLAUDE_EFFORT = "high";

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 32_000;
const CLI_TIMEOUT_MS = 240_000;
/**
 * A connect request is a person waiting on a form, and the probe is one
 * trivial prompt, so it gets a far shorter deadline than a real completion.
 */
const CREDENTIAL_PROBE_TIMEOUT_MS = 90_000;
/** Usage moves slowly; re-probing on every render would be wasteful. */
const USAGE_CACHE_MS = 120_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// Square brackets appear in real Claude Code model values (e.g. the
// "claude-fable-5[1m]" context variant it caches for its own picker).
const MODEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/u;

/**
 * The vendor's own words for why a credential was refused.
 *
 * The CLIs put the useful line ("OAuth access token is invalid", "Not logged
 * in") on either stream and pad it with banners, so the first line that reads
 * like a diagnosis is preferred over the first line outright.
 */
function probeFailureDetail(output: ProcessOutput): string {
  const lines = `${output.stderr}\n${output.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("{"));
  const diagnosis = lines.find((line) =>
    /error|invalid|expired|unauthor|denied|forbidden|not logged in|failed/iu.test(
      line,
    ),
  );
  return (
    diagnosis ??
    lines[0] ??
    (output.exitCode === 124
      ? "the CLI did not answer before the deadline"
      : `the CLI exited ${output.exitCode}`)
  ).slice(0, 300);
}

export type ProcessRunner = typeof runProcess;
export type DetachedSpawner = (command: string, args: string[]) => void;

/**
 * A CLI held open across several HTTP requests.
 *
 * Device authorization is the one flow that cannot be a single call: the CLI
 * prints a code, then waits — for as long as the person takes to walk to their
 * browser and approve it. So the process outlives the request that started it,
 * and the dashboard polls. This is the seam that makes that testable without a
 * real login.
 */
export interface LongRunningProcess {
  /** Resolves when the CLI exits, however it exits. */
  done: Promise<ProcessOutput>;
  kill(): void;
  /**
   * Sends a line to the CLI's stdin.
   *
   * Only meaningful for a flow spawned with `stdin: "pipe"`. Anthropic's
   * sign-in is a conversation rather than a poll: the CLI prints a URL, the
   * user signs in on their own machine and is given a code, and the CLI waits
   * on stdin for that code. Without a way to answer it, the flow cannot be
   * completed from a server at all.
   */
  write(line: string): void;
}

export type LongRunningSpawner = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string; stdin?: "ignore" | "pipe" },
  onLine: (line: string) => void,
) => LongRunningProcess;

/** Terminal colour codes, which the Codex CLI wraps its device code in. */
const ANSI = /\[[0-9;]*m/gu;

/**
 * Written by character code rather than as an escape.
 *
 * This file gets rewritten by tooling often enough that a literal
 * backslash-n has been turned into a real line break inside a string literal
 * here before, which produces a string containing a newline where the
 * two-character escape was meant and does not always fail loudly.
 */
const NEWLINE = String.fromCharCode(10);

export function stripAnsi(value: string): string {
  return value.replace(ANSI, "");
}

/**
 * Default {@link LongRunningSpawner}: a plain child process whose stdout is
 * split into lines and whose handle stays available for cancellation.
 */
function spawnLongRunning(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string; stdin?: "ignore" | "pipe" },
  onLine: (line: string) => void,
): LongRunningProcess {
  const startedAt = Date.now();
  const child = spawn(command, [...args], {
    env: options.env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    // Written as two literal tuples rather than one computed array so the
    // child's stdout and stderr stay typed as present. Stdin defaults to
    // `ignore`, which is what a polling flow wants: a CLI that never reads it
    // should see it closed rather than held open.
    stdio:
      options.stdin === "pipe"
        ? (["pipe", "pipe", "pipe"] as const)
        : (["ignore", "pipe", "pipe"] as const),
  });
  // Narrowed once, explicitly: both are always piped above, but the stdio
  // tuple is chosen at runtime so the types no longer say so.
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (stdoutStream === null || stderrStream === null) {
    throw new Error(`${command} was spawned without pipes`);
  }
  let stdout = "";
  let stderr = "";
  let pending = "";
  const consume = (chunk: string): void => {
    stdout += chunk;
    pending += chunk;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      onLine(line);
    }
  };
  stdoutStream.setEncoding("utf8");
  stdoutStream.on("data", consume);
  stderrStream.setEncoding("utf8");
  stderrStream.on("data", (chunk: string) => {
    stderr += chunk;
    // The Codex CLI prints its instructions to stdout but its warnings to
    // stderr; the device code has been seen on both across versions, so both
    // are scanned.
    consume("");
    for (const line of chunk.split(/\r?\n/u)) {
      onLine(line);
    }
  });
  const done = new Promise<ProcessOutput>((resolve) => {
    const settle = (exitCode: number): void => {
      if (pending.trim().length > 0) {
        onLine(pending);
        pending = "";
      }
      resolve({
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    };
    child.on("error", (error) => {
      stderr += `\n${error.message}`;
      settle(1);
    });
    child.on("close", (code) => {
      settle(code ?? 1);
    });
  });
  return {
    done,
    kill: () => {
      child.kill();
    },
    write: (value: string) => {
      // The newline is what submits the answer, so it is added here rather
      // than trusted to the caller. A CLI that is not listening is not an
      // error worth failing a sign-in over: the flow's own status check is
      // what decides whether it worked.
      child.stdin?.write(value + NEWLINE);
    },
  };
}

/**
 * How a browser sign-in finishes, which differs by vendor and changes what
 * the screen has to render.
 *
 * `approve` is Codex: the CLI shows a code, the user approves it, and the CLI
 * polls until the vendor says yes. Nothing comes back to us.
 *
 * `code_exchange` is Claude: the CLI shows a URL, the user signs in and is
 * handed a code, and that code has to be given back to the waiting CLI. It is
 * one extra step for the user and a whole extra leg for the server, which is
 * why the two are named rather than collapsed.
 */
export type DeviceAuthMode = "approve" | "code_exchange";

/** What the browser needs to show a device-authorization prompt. */
export interface DeviceAuthStart {
  flowId: string;
  verificationUrl: string;
  /** Absent on `code_exchange`, where the browser issues the code instead. */
  userCode: string;
  expiresAt: string;
  mode: DeviceAuthMode;
}

export interface DeviceAuthState {
  flowId: string;
  status: "pending" | "completed" | "failed" | "expired";
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: string;
  mode?: DeviceAuthMode;
  /** The vendor's own words when it did not work out. */
  detail?: string;
  account?: string;
}

interface DeviceAuthFlow {
  id: string;
  userId: string;
  provider: ProviderId;
  home: string;
  verificationUrl: string | undefined;
  userCode: string | undefined;
  expiresAtMs: number;
  status: DeviceAuthState["status"];
  mode: DeviceAuthMode;
  detail: string | undefined;
  account: string | undefined;
  process: LongRunningProcess;
  timer: NodeJS.Timeout | undefined;
  /** Set once a code has been handed to the CLI, so it is not sent twice. */
  codeSubmitted: boolean;
}

/**
 * Pulls the verification URL and one-time code out of the CLI's own output.
 *
 * The CLI writes these for a human in a terminal — numbered steps, colour
 * codes, an expiry in prose — so they are recovered by shape rather than by
 * position, and colour codes are stripped first or the URL would carry them.
 */
export function parseDeviceAuthLine(line: string): {
  url?: string;
  code?: string;
  expiresInMinutes?: number;
} {
  const clean = stripAnsi(line).trim();
  const result: { url?: string; code?: string; expiresInMinutes?: number } = {};
  const url = /https?:\/\/[^\s"'<>]+/u.exec(clean);
  if (url !== null) {
    result.url = url[0];
  }
  // Deliberately anchored to the whole line: a bare grouped code on its own
  // line is the code, whereas the same shape inside prose is not.
  const code = /^([A-Z0-9]{4,8}-[A-Z0-9]{4,8})$/u.exec(clean);
  if (code !== null && code[1] !== undefined) {
    result.code = code[1];
  }
  const expiry = /expires? in (\d{1,3}) minutes?/iu.exec(clean);
  if (expiry !== null && expiry[1] !== undefined) {
    result.expiresInMinutes = Number.parseInt(expiry[1], 10);
  }
  return result;
}

/**
 * Removes a staged credential home, tolerating a child still holding it.
 *
 * Windows keeps a directory locked until every handle inside the exited
 * process is released, and that lags the exit itself — so removing a device-
 * auth home straight after `kill()` fails with `EBUSY` and turns "Cancel" into
 * a server error. Verified against the real CLI, which is how this was found.
 */
async function removeCredentialHome(directory: string): Promise<void> {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

/** How long to wait for the CLI to print a code before giving up on it. */
const DEVICE_AUTH_PROMPT_TIMEOUT_MS = 60_000;
/** Fallback when the CLI does not state an expiry in its own output. */
const DEVICE_AUTH_DEFAULT_EXPIRY_MS = 15 * 60_000;

/**
 * Runs a CLI and hands back every stdout line the moment it arrives, while
 * still accumulating the whole output. The accumulated text goes through the
 * same parsers the non-streaming path uses, so live events and the final
 * reply can never disagree about what the CLI said.
 */
export type StreamRunner = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    input?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
  },
  onLine: (line: string) => void,
) => Promise<ProcessOutput>;

/** What the browser is told while a reply is still being produced. */
export type ChatStreamEvent =
  /** Coarse progress the CLI itself announced (e.g. "requesting"). */
  | { type: "status"; status: string }
  /** Reasoning began. `hidden` marks a provider that withholds the text. */
  | { type: "reasoning_start"; hidden: boolean }
  /** Real reasoning text, only ever forwarded verbatim from the CLI. */
  | { type: "reasoning"; text: string }
  /** Reasoning token counts for providers that report counts but no text. */
  | { type: "reasoning_tokens"; tokens: number }
  /** Answer text as it is produced. */
  | { type: "text"; delta: string }
  | { type: "done"; reply: ChatReply }
  | { type: "error"; message: string; code: string };

async function streamProcess(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    input?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
  },
  onLine: (line: string) => void,
): Promise<ProcessOutput> {
  const startedAt = Date.now();
  return await new Promise<ProcessOutput>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: sanitizeChildEnv(process.env),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let settled = false;
    const limit = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill();
          }, options.timeoutMs);
    const finish = (result: ProcessOutput) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(result);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < limit) {
        stdout += chunk;
      }
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length > 0) {
          onLine(line);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < limit) {
        stderr += chunk;
      }
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (pending.trim().length > 0) {
        onLine(pending);
      }
      finish({
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

export interface ProviderChatServiceOptions {
  runner?: ProcessRunner;
  /** Feeds CLI stdout lines out as they arrive, for streaming replies. */
  streamRunner?: StreamRunner;
  /** Launches a browser-opening login flow without holding the request. */
  detachedSpawner?: DetachedSpawner;
  /** Holds a CLI open across requests, for device authorization. */
  longRunningSpawner?: LongRunningSpawner;
  homeDirectory?: string;
  /**
   * Per-user credential storage. Share one instance with everything else that
   * reads credentials: opening the store can generate the key file, and two
   * openers racing on that would leave half the records unreadable.
   */
  credentials?: UserCredentialStore;
}

function assertMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProviderChatError(
      400,
      "invalid_messages",
      "messages must be a non-empty array",
    );
  }
  if (value.length > MAX_MESSAGES) {
    throw new ProviderChatError(
      400,
      "invalid_messages",
      `messages must contain at most ${MAX_MESSAGES} entries`,
    );
  }
  return value.map((entry, index) => {
    const message = entry as Partial<ChatMessage>;
    if (
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.content !== "string" ||
      message.content.length === 0 ||
      message.content.length > MAX_MESSAGE_CHARS
    ) {
      throw new ProviderChatError(
        400,
        "invalid_messages",
        `messages[${index}] must be a user/assistant message under ${MAX_MESSAGE_CHARS} characters`,
      );
    }
    return { role: message.role, content: message.content };
  });
}

/**
 * The Gemini CLI installs as an npm `.cmd` shim on Windows, which a
 * shell-less spawn cannot execute; its JS entry run through Node can.
 */
export function resolveGeminiCommand(): { command: string; prefixArgs: string[] } {
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"];
    if (appData !== undefined) {
      const entry = path.join(
        appData,
        "npm",
        "node_modules",
        "@google",
        "gemini-cli",
        "bundle",
        "gemini.js",
      );
      if (existsSync(entry)) {
        return { command: process.execPath, prefixArgs: [entry] };
      }
    }
  }
  return { command: "gemini", prefixArgs: [] };
}

/** The Codex CLI may live off PATH; the actively-used install is a fallback. */
export function resolveCodexCommand(homeDirectory = os.homedir()): string {
  const candidates = [
    "codex",
    path.join(homeDirectory, ".codex", ".sandbox-bin", "codex.exe"),
    path.join(homeDirectory, ".codex", "bin", "codex"),
  ];
  for (const candidate of candidates) {
    if (candidate === "codex") {
      continue; // Tried last, via PATH, only if file candidates are missing.
    }
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "codex";
}

export class ProviderChatService {
  private readonly runner: ProcessRunner;
  private readonly detachedSpawner: DetachedSpawner;
  private readonly homeDirectory: string;
  private readonly detectionCache = new Map<
    ProviderId,
    { at: number; state: ProviderCliState }
  >();
  private readonly usageCache = new Map<
    ProviderId,
    { at: number; report: ProviderUsageReport }
  >();
  private readonly streamRunner: StreamRunner;
  private readonly longRunningSpawner: LongRunningSpawner;
  private readonly deviceAuthFlows = new Map<string, DeviceAuthFlow>();
  private credentialStorePromise: Promise<UserCredentialStore> | undefined;

  public constructor(
    private readonly project: CoordinatorProject,
    options: ProviderChatServiceOptions = {},
  ) {
    this.runner = options.runner ?? runProcess;
    this.streamRunner = options.streamRunner ?? streamProcess;
    this.longRunningSpawner = options.longRunningSpawner ?? spawnLongRunning;
    if (options.credentials !== undefined) {
      this.credentialStorePromise = Promise.resolve(options.credentials);
    }
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.detachedSpawner =
      options.detachedSpawner ??
      ((command, args) => {
        const child = spawn(command, args, {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      });
  }

  private get secretsDirectory(): string {
    return path.join(this.project.directory, "secrets");
  }

  private get secretsPath(): string {
    return path.join(this.secretsDirectory, "provider-connections.json");
  }

  /**
   * Opened once and reused. Opening generates a key file when the deployment
   * has not configured one, so doing it per request would race on that write.
   */
  private async credentialStore(): Promise<UserCredentialStore> {
    this.credentialStorePromise ??= UserCredentialStore.open(
      this.secretsDirectory,
    );
    return await this.credentialStorePromise;
  }

  /** The user's own credential, or undefined when they have not supplied one. */
  private async ownCredential(
    userId: string,
    provider: ProviderId,
  ): Promise<UserCredential | undefined> {
    try {
      return await (
        await this.credentialStore()
      ).get(userId, PROVIDER_VENDORS[provider]);
    } catch (error) {
      if (error instanceof UserCredentialError) {
        throw new ProviderChatError(409, error.code, error.message);
      }
      throw error;
    }
  }

  private async readConnections(): Promise<ConnectionFile> {
    try {
      return JSON.parse(
        await readFile(this.secretsPath, "utf8"),
      ) as ConnectionFile;
    } catch {
      return {};
    }
  }

  private async writeConnections(file: ConnectionFile): Promise<void> {
    await mkdir(path.dirname(this.secretsPath), { recursive: true });
    await writeFile(
      this.secretsPath,
      JSON.stringify(file, undefined, 2),
      "utf8",
    );
  }

  /* ------------------------------------------------- CLI detection ------ */

  private async detect(provider: ProviderId): Promise<ProviderCliState> {
    const cached = this.detectionCache.get(provider);
    if (cached !== undefined && Date.now() - cached.at < 120_000) {
      return cached.state;
    }
    let state: ProviderCliState;
    try {
      if (provider === "anthropic") {
        state = await this.detectClaude();
      } else if (provider === "openai") {
        state = await this.detectCodex();
      } else {
        state = await this.detectGemini();
      }
    } catch (error) {
      state = {
        detected: false,
        loggedIn: false,
        blockedReason: error instanceof Error ? error.message : String(error),
      };
    }
    this.detectionCache.set(provider, { at: Date.now(), state });
    return state;
  }

  /**
   * Reads what Claude Code's own `/usage` command reports. That command is
   * handled inside the CLI — it costs nothing and runs no model turn — and
   * is the only place a consumed figure is published, so its lines are
   * parsed rather than any number being derived here.
   */
  public async usage(input: {
    provider: ProviderId;
  }): Promise<ProviderUsageReport> {
    if (input.provider === "google") {
      return {
        source: PROVIDER_NAMES[input.provider],
        windows: [],
        unavailableReason:
          "No usage figures are available for this provider.",
      };
    }
    if (input.provider === "openai") {
      const cachedCodex = this.usageCache.get(input.provider);
      if (
        cachedCodex !== undefined &&
        Date.now() - cachedCodex.at < USAGE_CACHE_MS
      ) {
        return cachedCodex.report;
      }
      const report = await this.codexUsage();
      this.usageCache.set(input.provider, { at: Date.now(), report });
      return report;
    }
    const cached = this.usageCache.get(input.provider);
    if (cached !== undefined && Date.now() - cached.at < USAGE_CACHE_MS) {
      return cached.report;
    }
    let report: ProviderUsageReport;
    try {
      const result = await this.runner(
        resolveClaudeCommand("claude"),
        ["-p", "/usage", "--output-format", "json"],
        { timeoutMs: 60_000, maxOutputBytes: 262_144 },
      );
      report =
        result.exitCode === 0
          ? parseClaudeUsage(result.stdout)
          : {
              source: "claude /usage",
              windows: [],
              unavailableReason: "The claude CLI could not report usage.",
            };
    } catch (error) {
      report = {
        source: "claude /usage",
        windows: [],
        unavailableReason:
          error instanceof Error ? error.message : String(error),
      };
    }
    this.usageCache.set(input.provider, { at: Date.now(), report });
    return report;
  }

  /**
   * The Codex CLI does not print rate limits on stdout, but it records them
   * in the rollout it writes for every session: a `rate_limits` object with
   * the percentage used, the window length, and the reset time. The newest
   * rollout is read and those figures are reported as-is.
   */
  private async codexUsage(): Promise<ProviderUsageReport> {
    const source = "Codex CLI session records (~/.codex/sessions)";
    try {
      const newest = await this.newestCodexRollout();
      if (newest === undefined) {
        return {
          source,
          windows: [],
          unavailableReason:
            "No Codex session has recorded rate limits on this machine yet.",
        };
      }
      const contents = await readFile(newest, "utf8");
      const report = parseCodexRateLimits(contents);
      return report === undefined
        ? {
            source,
            windows: [],
            unavailableReason:
              "The latest Codex session recorded no rate-limit figures.",
          }
        : { ...report, source };
    } catch (error) {
      return {
        source,
        windows: [],
        unavailableReason:
          error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Rollouts live under sessions/YYYY/MM/DD; the newest one is the current. */
  private async newestCodexRollout(): Promise<string | undefined> {
    const root = path.join(this.homeDirectory, ".codex", "sessions");
    let newest: { path: string; at: number } | undefined;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 4) {
        return;
      }
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        } else if (entry.name.endsWith(".jsonl")) {
          try {
            const info = await stat(full);
            if (newest === undefined || info.mtimeMs > newest.at) {
              newest = { path: full, at: info.mtimeMs };
            }
          } catch {
            // Vanished between listing and stat; ignore.
          }
        }
      }
    };
    await walk(root, 0);
    return newest?.path;
  }

  private async detectClaude(): Promise<ProviderCliState> {
    const result = await this.runner(
      resolveClaudeCommand("claude"),
      ["auth", "status"],
      { timeoutMs: 30_000, maxOutputBytes: 65_536 },
    );
    if (result.exitCode !== 0) {
      return { detected: false, loggedIn: false };
    }
    try {
      const status = JSON.parse(result.stdout) as {
        loggedIn?: boolean;
        authMethod?: string;
        email?: string;
        subscriptionType?: string;
      };
      return {
        detected: true,
        loggedIn: status.loggedIn === true,
        ...(status.email !== undefined
          ? { account: status.email }
          : status.authMethod === undefined
            ? {}
            : { account: `${status.authMethod} account` }),
        ...(status.subscriptionType === undefined
          ? {}
          : { plan: status.subscriptionType }),
      };
    } catch {
      return { detected: true, loggedIn: false };
    }
  }

  private async detectCodex(): Promise<ProviderCliState> {
    const command = resolveCodexCommand(this.homeDirectory);
    const version = await this.runner(command, ["--version"], {
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
    });
    if (version.exitCode !== 0) {
      return { detected: false, loggedIn: false };
    }
    const login = await this.runner(command, ["login", "status"], {
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
    });
    const output = `${login.stdout}\n${login.stderr}`;
    const loggedIn = login.exitCode === 0 && /logged in/iu.test(output);
    return {
      detected: true,
      loggedIn,
      ...(loggedIn && /chatgpt/iu.test(output)
        ? { account: "ChatGPT account" }
        : {}),
    };
  }

  private async detectGemini(): Promise<ProviderCliState> {
    const gemini = resolveGeminiCommand();
    const version = await this.runner(gemini.command, [...gemini.prefixArgs, "--version"], {
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
    });
    if (version.exitCode !== 0) {
      return { detected: false, loggedIn: false };
    }
    let account: string | undefined;
    try {
      const accounts = JSON.parse(
        await readFile(
          path.join(this.homeDirectory, ".gemini", "google_accounts.json"),
          "utf8",
        ),
      ) as { active?: string };
      account = accounts.active;
    } catch {
      account = undefined;
    }
    const loggedIn =
      account !== undefined ||
      existsSync(path.join(this.homeDirectory, ".gemini", "oauth_creds.json"));
    return { detected: true, loggedIn, ...(account ? { account } : {}) };
  }

  /* ------------------------------------------------------- statuses ----- */

  public async list(input: {
    userId: string;
    systemAdmin: boolean;
  }): Promise<ProviderStatus[]> {
    const connections = (await this.readConnections())[input.userId] ?? {};
    const store = await this.credentialStore();
    const statuses: ProviderStatus[] = [];
    for (const id of PROVIDER_IDS) {
      const connection = connections[id];
      const cli = await this.detect(id);
      const settings = connection?.settings ?? {};
      const own = await store.summary(input.userId, PROVIDER_VENDORS[id]);
      // An own credential authenticates on its own and needs no host login,
      // so it is checked before the shared-login path and outranks it.
      const connected =
        own !== undefined ||
        (connection !== undefined && input.systemAdmin && cli.loggedIn);
      statuses.push({
        id,
        name: PROVIDER_NAMES[id],
        connected,
        ...(own !== undefined
          ? { kind: "own-credential" as const, ownCredential: own }
          : connection === undefined
            ? {}
            : { kind: "account" as const }),
        acceptedCredentialKinds: supportedCredentialKinds(PROVIDER_VENDORS[id]),
        ...(SIGN_IN_FLOWS[id] === undefined
          ? {}
          : { signInFlow: SIGN_IN_FLOWS[id] }),
        model:
          settings.model ??
          (id === "anthropic"
            ? DEFAULT_CLAUDE_MODEL
            : id === "openai"
              ? (await this.codexModels())?.[0]?.id ?? "codex default"
              : "gemini"),
        ...(settings.effort === undefined
          ? id === "anthropic"
            ? { effort: DEFAULT_CLAUDE_EFFORT }
            : {}
          : { effort: settings.effort }),
        cli,
        exposesThinking: id === "openai",
        requiresAdmin: own === undefined,
      });
    }
    return statuses;
  }

  /**
   * Which vendors a set of *other* users have connected, for a shared
   * repository channel roster.
   *
   * This deliberately reads far less than {@link list}: no CLI detection, no
   * model/effort settings, no running task, and critically no secret —
   * `UserCredentialStore.list` already returns `UserCredentialSummary`, which
   * is documented as "everything but the secret. Safe to return to a
   * browser." That guarantee is what makes it safe to answer this for users
   * other than the caller. Even so, only the vendor and `visibility` travel
   * back; the summary's free-text `label` (whatever the credential's own
   * owner typed to tell their connections apart) is left out; it is the
   * owner's own text about their own account, not a fact a teammate needs to
   * see. `visibility` is different in kind: it is exactly the fact the
   * channel roster exists to show — which of a teammate's agents can
   * actually be @mentioned into real work versus are merely visible.
   */
  public async listConnectionsFor(
    userIds: readonly string[],
  ): Promise<
    Record<string, Array<{ provider: ProviderId; visibility: CredentialVisibility }>>
  > {
    const store = await this.credentialStore();
    const result: Record<
      string,
      Array<{ provider: ProviderId; visibility: CredentialVisibility }>
    > = {};
    for (const userId of userIds) {
      const summaries = await store.list(userId);
      result[userId] = summaries.map((summary) => ({
        provider: VENDOR_PROVIDERS[summary.vendor],
        visibility: summary.visibility,
      }));
    }
    return result;
  }

  /* ------------------------------------------------ own credentials ----- */

  /**
   * Stores a credential the user supplies, after proving it works.
   *
   * Verification is not a formality. A credential that is merely stored looks
   * connected in the UI and only fails much later, mid-task, where the error
   * surfaces as a failed run rather than a typo at connect time. So the
   * credential answers a real prompt first, under the same isolation its
   * tasks will run with, and is stored only if it does.
   */
  public async connectOwnCredential(input: {
    userId: string;
    provider: ProviderId;
    /**
     * Only affects how the *other* providers are reported back: an
     * administrator still sees the ones the shared host login covers. It
     * grants nothing here — any user may connect their own account.
     */
    systemAdmin?: boolean;
    kind: UserCredentialKind;
    secret: string;
    label?: string;
    /**
     * "Personal" (the default) or "org-wide" — see {@link CredentialVisibility}.
     * Chosen once, at connect time, in the connect modal; a caller that omits
     * it gets the same personal-only behavior every connection had before
     * this existed.
     */
    visibility?: CredentialVisibility;
  }): Promise<ProviderStatus[]> {
    const vendor = PROVIDER_VENDORS[input.provider];
    if (!supportedCredentialKinds(vendor).includes(input.kind)) {
      throw new ProviderChatError(
        400,
        "unsupported_kind",
        `${PROVIDER_NAMES[input.provider]} cannot accept a ${input.kind} per ` +
          `user; ${CREDENTIAL_INSTRUCTIONS[input.provider][0] ?? ""}`,
      );
    }
    const secret = input.secret.trim();
    // A session file is a whole JSON document — a real Codex auth.json runs
    // past 4.5 KB on its id_token alone — so it cannot share the cap that
    // suits a pasted key.
    const limit = input.kind === "session_file" ? 64_000 : 4_096;
    if (secret.length === 0 || secret.length > limit) {
      throw new ProviderChatError(
        400,
        "invalid_secret",
        input.kind === "session_file"
          ? `Paste the entire file contents (up to ${limit} characters)`
          : "Paste the credential exactly as the provider issued it",
      );
    }
    if (input.kind === "session_file") {
      // Shape is checked before the CLI is involved, so a user who pasted the
      // wrong file is told which file to paste instead of watching a probe
      // fail for reasons that look like a rejected account.
      try {
        assertSessionFile(vendor, secret);
      } catch (error) {
        throw new ProviderChatError(
          400,
          "invalid_session_file",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const cli = await this.detect(input.provider);
    if (!cli.detected) {
      throw new ProviderChatError(
        409,
        "cli_unavailable",
        `No usable ${PROVIDER_NAMES[input.provider]} CLI was found on this host`,
      );
    }

    const account = await this.verifyCredential(input.provider, {
      vendor,
      kind: input.kind,
      secret,
      label: input.label,
      origin: input.kind === "session_file" ? "copied" : "pasted",
      createdAt: new Date().toISOString(),
      lastVerifiedAt: undefined,
      hint: credentialHint(input.kind, secret),
      visibility: input.visibility ?? "personal",
    });

    const store = await this.credentialStore();
    await store.put(input.userId, vendor, {
      kind: input.kind,
      secret,
      origin: input.kind === "session_file" ? "copied" : "pasted",
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    });
    await store.markVerified(input.userId, vendor, account);

    // A stored credential is a connection in its own right, so the settings
    // record is created if absent; without it the user has no model/effort.
    const file = await this.readConnections();
    if (file[input.userId]?.[input.provider] === undefined) {
      file[input.userId] = {
        ...file[input.userId],
        [input.provider]: {
          kind: "account",
          createdAt: new Date().toISOString(),
        },
      };
      await this.writeConnections(file);
    }

    return await this.list({
      userId: input.userId,
      systemAdmin: input.systemAdmin ?? false,
    });
  }

  /* --------------------------------------------- device authorization --- */

  /**
   * Starts `codex login --device-auth` against an isolated home.
   *
   * This is the only per-user connection that is a genuine grant rather than a
   * copied secret: the CLI runs here, the user approves it in their own
   * browser on their own ChatGPT account, and what lands is a session issued
   * to this deployment. Nothing of the user's is pasted, and no refresh token
   * is shared with their own machine.
   *
   * The CLI is left running deliberately — it is what polls the vendor and
   * writes `auth.json` when approval arrives. {@link deviceAuthStatus} reads
   * the outcome; {@link cancelDeviceAuth} and the expiry timer guarantee the
   * process and its home are not left behind.
   */
  public async startDeviceAuth(input: {
    userId: string;
    provider: ProviderId;
  }): Promise<DeviceAuthStart> {
    const signInFlow = SIGN_IN_FLOWS[input.provider];
    if (signInFlow === undefined) {
      // The Gemini CLI has no login subcommand at all — authentication is a
      // menu inside its interactive UI — so there is nothing here to drive.
      throw new ProviderChatError(
        400,
        "unsupported_flow",
        `${PROVIDER_NAMES[input.provider]} has no sign-in flow that can be ` +
          "driven from a server; connect it with a credential instead",
      );
    }
    const cli = await this.detect(input.provider);
    if (!cli.detected) {
      throw new ProviderChatError(
        409,
        "cli_unavailable",
        `No usable ${PROVIDER_NAMES[input.provider]} CLI was found on this host`,
      );
    }

    // One flow per user and provider: starting again abandons the old code,
    // which is what a user pressing the button twice means.
    await this.cancelDeviceAuthFor(input.userId, input.provider);

    const anthropic = input.provider === "anthropic";
    const home = await mkdtemp(path.join(os.tmpdir(), "coord-device-"));
    const env: NodeJS.ProcessEnv = {
      ...sanitizeChildEnv(process.env),
      ...(anthropic ? { CLAUDE_CONFIG_DIR: home } : { CODEX_HOME: home }),
    };
    // The host's own keys must not be visible to a sign-in: an inherited one
    // would let the CLI succeed without the user ever signing in, and the
    // credential captured afterwards would be the host owner's.
    for (const name of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]) {
      delete env[name];
    }

    const flow: DeviceAuthFlow = {
      id: randomUUID(),
      userId: input.userId,
      provider: input.provider,
      home,
      verificationUrl: undefined,
      userCode: undefined,
      expiresAtMs: Date.now() + DEVICE_AUTH_DEFAULT_EXPIRY_MS,
      status: "pending",
      mode: signInFlow,
      detail: undefined,
      account: undefined,
      process: undefined as unknown as LongRunningProcess,
      timer: undefined,
      codeSubmitted: false,
    };

    let announce: () => void = () => {};
    const announced = new Promise<void>((resolve) => {
      announce = resolve;
    });

    flow.process = this.longRunningSpawner(
      anthropic
        ? resolveClaudeCommand("claude")
        : resolveCodexCommand(this.homeDirectory),
      anthropic ? ["auth", "login"] : ["login", "--device-auth"],
      // Claude waits on stdin for the code the browser hands the user, so its
      // flow must be able to answer. Codex never reads stdin and keeps it
      // closed.
      { env, cwd: home, ...(anthropic ? { stdin: "pipe" as const } : {}) },
      (line) => {
        const parsed = parseDeviceAuthLine(line);
        flow.verificationUrl ??= parsed.url;
        flow.userCode ??= parsed.code;
        if (parsed.expiresInMinutes !== undefined) {
          flow.expiresAtMs = Date.now() + parsed.expiresInMinutes * 60_000;
        }
        // Codex prints the URL before the code and only the pair is usable,
        // so it waits for whichever arrives last. Claude issues no code here
        // — the browser does — so its URL alone is the whole prompt.
        if (
          flow.verificationUrl !== undefined &&
          (flow.mode === "code_exchange" || flow.userCode !== undefined)
        ) {
          announce();
        }
      },
    );

    this.deviceAuthFlows.set(flow.id, flow);
    void flow.process.done.then(
      (output) => this.finishDeviceAuth(flow, output),
      (error: unknown) => {
        flow.status = "failed";
        flow.detail = error instanceof Error ? error.message : String(error);
      },
    );
    flow.timer = setTimeout(() => {
      if (flow.status === "pending") {
        flow.status = "expired";
        flow.detail = "The one-time code expired before it was approved";
        flow.process.kill();
        void flow.process.done
          .catch(() => undefined)
          .then(() => removeCredentialHome(flow.home));
      }
    }, DEVICE_AUTH_DEFAULT_EXPIRY_MS);
    flow.timer.unref?.();

    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new ProviderChatError(
            502,
            "device_auth_unavailable",
            `The ${PROVIDER_NAMES[input.provider]} CLI did not print a ` +
              "sign-in prompt. Its output was: " +
              (flow.detail ?? "nothing recognizable"),
          ),
        );
      }, DEVICE_AUTH_PROMPT_TIMEOUT_MS);
      timer.unref?.();
    });

    try {
      await Promise.race([announced, timeout]);
    } catch (error) {
      await this.cancelDeviceAuth({
        userId: input.userId,
        flowId: flow.id,
      });
      throw error;
    }

    return {
      flowId: flow.id,
      verificationUrl: flow.verificationUrl as string,
      userCode: flow.userCode ?? "",
      expiresAt: new Date(flow.expiresAtMs).toISOString(),
      mode: flow.mode,
    };
  }

  /**
   * Hands the CLI the code the browser gave the user.
   *
   * This is the leg a polling flow does not have. The CLI is sitting on
   * stdin waiting for it, and until it arrives the sign-in cannot finish —
   * which is also why the flow is per user and looked up by owner: a code is
   * a bearer secret for somebody's account for as long as it is live.
   */
  public async submitDeviceAuthCode(input: {
    userId: string;
    flowId: string;
    code: string;
  }): Promise<DeviceAuthState> {
    const flow = this.deviceAuthFlows.get(input.flowId);
    if (flow === undefined || flow.userId !== input.userId) {
      throw new ProviderChatError(404, "unknown_flow", "No such sign-in");
    }
    if (flow.mode !== "code_exchange") {
      throw new ProviderChatError(
        400,
        "unsupported_flow",
        `${PROVIDER_NAMES[flow.provider]} approves in the browser and takes ` +
          "no code here",
      );
    }
    if (flow.status !== "pending") {
      return this.describeDeviceAuth(flow);
    }
    const code = input.code.trim();
    // Anything the CLI would read as more than one answer is refused rather
    // than sent: a newline here would submit a second line to a prompt that
    // is not expecting one.
    if (code.length === 0 || /\s/u.test(code)) {
      throw new ProviderChatError(
        400,
        "invalid_code",
        "Paste the single code the sign-in page gave you",
      );
    }
    if (flow.codeSubmitted) {
      throw new ProviderChatError(
        409,
        "code_already_submitted",
        "That sign-in already has a code; start again if it did not work",
      );
    }
    flow.codeSubmitted = true;
    flow.process.write(code);
    return this.describeDeviceAuth(flow);
  }

  /**
   * Turns an exited login process into a stored credential, or an explanation.
   *
   * `auth.json` is the artifact that matters, not the exit code: the CLI is
   * interactive and can exit non-zero for reasons unrelated to whether the
   * grant landed. So the file is what decides, and it is validated before it
   * is trusted.
   */
  private async finishDeviceAuth(
    flow: DeviceAuthFlow,
    output: ProcessOutput,
  ): Promise<void> {
    if (flow.status !== "pending") {
      return;
    }
    if (flow.provider === "anthropic") {
      await this.finishClaudeAuth(flow, output);
      return;
    }
    try {
      const authPath = path.join(flow.home, "auth.json");
      const secret = await readFile(authPath, "utf8");
      assertSessionFile("codex", secret);

      const account = await this.verifyCredential(flow.provider, {
        vendor: "codex",
        kind: "session_file",
        secret,
        label: undefined,
        origin: "device_auth",
        createdAt: new Date().toISOString(),
        lastVerifiedAt: undefined,
        hint: credentialHint("session_file", secret),
        // Device authorization has no connect-modal step to offer the
        // personal/org-wide choice in, so it keeps the safe default; a user
        // who wants this agent org-wide can reconnect it that way once that
        // UI exists for this flow too.
        visibility: "personal",
      });

      const store = await this.credentialStore();
      await store.put(flow.userId, "codex", {
        kind: "session_file",
        secret,
        origin: "device_auth",
        label: account ?? "ChatGPT sign-in",
      });
      await store.markVerified(flow.userId, "codex", account);
      await this.ensureConnectionRecord(flow.userId, flow.provider);

      flow.status = "completed";
      flow.account = account;
    } catch (error) {
      flow.status = "failed";
      flow.detail =
        error instanceof ProviderChatError
          ? error.message
          : (error as NodeJS.ErrnoException).code === "ENOENT"
            ? `The sign-in did not complete: ${probeFailureDetail(output)}`
            : error instanceof Error
              ? error.message
              : String(error);
    } finally {
      if (flow.timer !== undefined) {
        clearTimeout(flow.timer);
      }
      // The staged home has served its purpose either way: the credential is
      // in the vault now, and leaving a live session on disk would outlast the
      // isolation everything else here maintains.
      await removeCredentialHome(flow.home);
    }
  }

  public async deviceAuthStatus(input: {
    userId: string;
    flowId: string;
  }): Promise<DeviceAuthState> {
    const flow = this.deviceAuthFlows.get(input.flowId);
    if (flow === undefined || flow.userId !== input.userId) {
      throw new ProviderChatError(
        404,
        "unknown_flow",
        "That sign-in is no longer in progress; start it again",
      );
    }
    if (flow.status === "pending" && Date.now() > flow.expiresAtMs) {
      flow.status = "expired";
      flow.detail = "The one-time code expired before it was approved";
      flow.process.kill();
    }
    const state = this.describeDeviceAuth(flow);
    if (flow.status !== "pending") {
      // Terminal states are read once by the poller and then discarded, so a
      // long-lived dashboard cannot accumulate finished flows.
      this.deviceAuthFlows.delete(flow.id);
    }
    return state;
  }

  /**
   * Turns a finished `claude auth login` into a stored credential.
   *
   * The CLI prints no token — it writes into the configuration directory —
   * and the file it uses has moved between versions. So rather than reading a
   * layout this would then be pinned to, the CLI is *asked*: `claude auth
   * status --json` reports `loggedIn` against the same directory, and only a
   * yes is treated as a sign-in. That makes a future layout change surface
   * here, as a refused connection with the CLI's own words, instead of as a
   * credential that stores cleanly and fails silently when it is used.
   *
   * The exit code is deliberately not the test. The CLI is interactive and
   * can exit non-zero for reasons that have nothing to do with whether the
   * sign-in landed.
   */
  private async finishClaudeAuth(
    flow: DeviceAuthFlow,
    output: ProcessOutput,
  ): Promise<void> {
    try {
      const status = await this.runner(
        resolveClaudeCommand("claude"),
        ["auth", "status", "--json"],
        {
          env: {
            ...sanitizeChildEnv(process.env),
            CLAUDE_CONFIG_DIR: flow.home,
          },
          cwd: flow.home,
          timeoutMs: 30_000,
        },
      );
      const report = extractJsonObject(
        status.stdout,
        "the Claude sign-in status",
      ) as { loggedIn?: unknown; authMethod?: unknown };
      if (report.loggedIn !== true) {
        throw new ProviderChatError(
          400,
          "sign_in_incomplete",
          `The sign-in did not complete: ${probeFailureDetail(output)}`,
        );
      }

      const secret = await captureClaudeSession(flow.home);
      const store = await this.credentialStore();
      const account =
        typeof report.authMethod === "string" && report.authMethod.length > 0
          ? `Claude sign-in (${report.authMethod})`
          : "Claude sign-in";
      await store.put(flow.userId, "claude", {
        kind: "session_file",
        secret,
        origin: "device_auth",
        label: account,
      });
      await store.markVerified(flow.userId, "claude", account);
      await this.ensureConnectionRecord(flow.userId, flow.provider);

      flow.status = "completed";
      flow.account = account;
    } catch (error) {
      flow.status = "failed";
      flow.detail =
        error instanceof ProviderChatError || error instanceof Error
          ? error.message
          : String(error);
    } finally {
      if (flow.timer !== undefined) {
        clearTimeout(flow.timer);
      }
      // The staged home has done its job either way: the credential is in the
      // vault now, and leaving a live session on disk would outlast the
      // isolation everything else here maintains.
      await removeCredentialHome(flow.home);
    }
  }

  /** The flow as the browser sees it. Reading it changes nothing. */
  private describeDeviceAuth(flow: DeviceAuthFlow): DeviceAuthState {
    return {
      flowId: flow.id,
      status: flow.status,
      mode: flow.mode,
      ...(flow.verificationUrl === undefined
        ? {}
        : { verificationUrl: flow.verificationUrl }),
      ...(flow.userCode === undefined ? {} : { userCode: flow.userCode }),
      expiresAt: new Date(flow.expiresAtMs).toISOString(),
      ...(flow.detail === undefined ? {} : { detail: flow.detail }),
      ...(flow.account === undefined ? {} : { account: flow.account }),
    };
  }

  public async cancelDeviceAuth(input: {
    userId: string;
    flowId: string;
  }): Promise<void> {
    const flow = this.deviceAuthFlows.get(input.flowId);
    if (flow === undefined || flow.userId !== input.userId) {
      return;
    }
    await this.disposeDeviceAuth(flow);
  }

  private async cancelDeviceAuthFor(
    userId: string,
    provider: ProviderId,
  ): Promise<void> {
    for (const flow of [...this.deviceAuthFlows.values()]) {
      if (flow.userId === userId && flow.provider === provider) {
        await this.disposeDeviceAuth(flow);
      }
    }
  }

  private async disposeDeviceAuth(flow: DeviceAuthFlow): Promise<void> {
    this.deviceAuthFlows.delete(flow.id);
    if (flow.timer !== undefined) {
      clearTimeout(flow.timer);
    }
    if (flow.status === "pending") {
      flow.status = "failed";
      flow.process.kill();
      // The exit must be awaited, not just requested: the home cannot be
      // removed while the child still holds it.
      await flow.process.done.catch(() => undefined);
    }
    await removeCredentialHome(flow.home);
  }

  /** Creates the settings record a connection needs, if it has none yet. */
  private async ensureConnectionRecord(
    userId: string,
    provider: ProviderId,
  ): Promise<void> {
    const file = await this.readConnections();
    if (file[userId]?.[provider] === undefined) {
      file[userId] = {
        ...file[userId],
        [provider]: { kind: "account", createdAt: new Date().toISOString() },
      };
      await this.writeConnections(file);
    }
  }

  /**
   * Runs the smallest real call each CLI supports and returns the account it
   * reports, when it reports one.
   */
  private async verifyCredential(
    provider: ProviderId,
    credential: UserCredential,
  ): Promise<string | undefined> {
    const vendor = PROVIDER_VENDORS[provider];
    return await withCredentialHome(
      { vendor, credential, baseEnv: sanitizeChildEnv(process.env) },
      async (home) => {
        const probe = await this.probeCredential(provider, home);
        if (probe.ok) {
          return probe.account;
        }
        throw new ProviderChatError(
          409,
          "credential_rejected",
          `${PROVIDER_NAMES[provider]} rejected that credential: ${probe.detail}`,
        );
      },
    );
  }

  private async probeCredential(
    provider: ProviderId,
    home: CredentialHome,
  ): Promise<{ ok: boolean; account?: string; detail: string }> {
    const scratch = await this.scratchDirectory();
    const options = {
      cwd: scratch,
      env: home.env,
      timeoutMs: CREDENTIAL_PROBE_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    };

    if (provider === "anthropic") {
      const output = await this.runner(
        resolveClaudeCommand("claude"),
        [
          "-p",
          "Reply with exactly: pong",
          "--output-format",
          "stream-json",
          "--verbose",
          "--model",
          DEFAULT_CLAUDE_MODEL,
        ],
        options,
      );
      if (output.exitCode === 0 && output.stdout.includes("pong")) {
        return { ok: true, detail: "verified" };
      }
      return { ok: false, detail: probeFailureDetail(output) };
    }

    if (provider === "openai") {
      const output = await this.runner(
        resolveCodexCommand(this.homeDirectory),
        [
          "exec",
          "--json",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "-C",
          scratch,
          "Reply with exactly: pong",
        ],
        options,
      );
      if (output.exitCode === 0 && output.stdout.includes("pong")) {
        return { ok: true, detail: "verified" };
      }
      return { ok: false, detail: probeFailureDetail(output) };
    }

    const gemini = resolveGeminiCommand();
    const output = await this.runner(
      gemini.command,
      [...gemini.prefixArgs, "-p", "Reply with exactly: pong", "-o", "json"],
      options,
    );
    if (output.exitCode === 0 && output.stdout.includes("pong")) {
      return { ok: true, detail: "verified" };
    }
    return { ok: false, detail: probeFailureDetail(output) };
  }

  /**
   * Starts the provider's own browser sign-in on the host. Nothing to hold
   * open: the CLI opens the browser, the user completes it there, and the
   * dashboard re-checks status.
   */
  public async signIn(input: {
    systemAdmin: boolean;
    provider: ProviderId;
  }): Promise<{ started: boolean; note: string }> {
    if (!input.systemAdmin) {
      throw new ProviderChatError(
        403,
        "admin_required",
        "Provider sign-in runs on the host and is restricted to system administrators",
      );
    }
    this.detectionCache.delete(input.provider);
    if (input.provider === "openai") {
      const command = resolveCodexCommand(this.homeDirectory);
      this.detachedSpawner(command, ["login"]);
      return {
        started: true,
        note: "Codex is opening a ChatGPT sign-in in the host's browser. Finish there, then press Check again.",
      };
    }
    if (input.provider === "anthropic") {
      this.detachedSpawner(resolveClaudeCommand("claude"), ["login"]);
      return {
        started: true,
        note: "Claude Code is opening a claude.ai sign-in in the host's browser. Finish there, then press Check again.",
      };
    }
    const gemini = resolveGeminiCommand();
    this.detachedSpawner(gemini.command, [...gemini.prefixArgs]);
    return {
      started: true,
      note: "The Gemini CLI is starting; complete its Google sign-in on the host, then press Check again.",
    };
  }

  public async connect(input: {
    userId: string;
    systemAdmin: boolean;
    provider: ProviderId;
  }): Promise<ProviderStatus[]> {
    if (!input.systemAdmin) {
      throw new ProviderChatError(
        403,
        "admin_required",
        "CLI-backed provider connections spend the host owner's account and are restricted to system administrators",
      );
    }
    this.detectionCache.delete(input.provider);
    const cli = await this.detect(input.provider);
    if (!cli.detected) {
      throw new ProviderChatError(
        409,
        "cli_unavailable",
        `No usable ${PROVIDER_NAMES[input.provider]} CLI was found on this host`,
      );
    }
    if (!cli.loggedIn) {
      throw new ProviderChatError(
        409,
        "not_signed_in",
        `The ${PROVIDER_NAMES[input.provider]} CLI is not signed in yet — use “Sign in”, finish in the browser, and try again`,
      );
    }
    if (input.provider === "google") {
      // Login state alone is not enough: eligibility is enforced server-side
      // by Google, so prove the account can actually answer before claiming
      // a connection.
      const gemini = resolveGeminiCommand();
      const probe = await this.runner(
        gemini.command,
        [...gemini.prefixArgs, "-p", "Reply with exactly: pong", "-o", "json"],
        { timeoutMs: 90_000, maxOutputBytes: 1024 * 1024 },
      );
      if (probe.exitCode !== 0 || !probe.stdout.includes("pong")) {
        const reason =
          `${probe.stderr}\n${probe.stdout}`
            .split("\n")
            .map((line) => line.trim())
            .find((line) => /error|ineligible|denied|failed/iu.test(line)) ??
          "The Gemini CLI could not complete a test prompt";
        throw new ProviderChatError(
          409,
          "provider_blocked",
          `Signed in as ${cli.account ?? "a Google account"}, but Gemini refused: ${reason.slice(0, 300)}`,
        );
      }
    }

    const file = await this.readConnections();
    file[input.userId] = {
      ...file[input.userId],
      [input.provider]: {
        kind: "account",
        createdAt: new Date().toISOString(),
        ...(file[input.userId]?.[input.provider]?.settings === undefined
          ? {}
          : { settings: file[input.userId]?.[input.provider]?.settings }),
      },
    };
    await this.writeConnections(file);
    return await this.list(input);
  }

  /**
   * Disconnecting also destroys the user's stored credential. Leaving the
   * secret behind would mean a provider the user believes they detached still
   * holds a working key to their account.
   */
  public async disconnect(input: {
    userId: string;
    provider: ProviderId;
  }): Promise<void> {
    await (
      await this.credentialStore()
    ).delete(input.userId, PROVIDER_VENDORS[input.provider]);
    const file = await this.readConnections();
    const userConnections = file[input.userId];
    if (userConnections !== undefined) {
      delete userConnections[input.provider];
      await this.writeConnections(file);
    }
  }

  /* ----------------------------------------------- settings/options ----- */

  private async codexModels(): Promise<ProviderModelOption[] | undefined> {
    try {
      const cache = JSON.parse(
        await readFile(
          path.join(this.homeDirectory, ".codex", "models_cache.json"),
          "utf8",
        ),
      ) as {
        models?: Array<{
          slug?: string;
          display_name?: string;
          description?: string;
          default_reasoning_level?: string;
          supported_reasoning_levels?: Array<{ effort?: string }>;
          context_window?: number;
        }>;
      };
      const models = (cache.models ?? [])
        .filter((model) => typeof model.slug === "string")
        .map((model) => ({
          id: model.slug as string,
          label: model.display_name ?? (model.slug as string),
          ...(model.description === undefined
            ? {}
            : { description: model.description }),
          efforts: (model.supported_reasoning_levels ?? [])
            .map((level) => level.effort)
            .filter((effort): effort is string => typeof effort === "string"),
          ...(model.default_reasoning_level === undefined
            ? {}
            : { defaultEffort: model.default_reasoning_level }),
          ...(typeof model.context_window === 'number'
            ? { contextWindow: model.context_window }
            : {}),
        }));
      return models.length > 0 ? models : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Claude Code has no model-list command, but it does leave two real traces
   * on this machine: the option cache it writes for its own picker, and the
   * aliases its own --help documents. Both are read here; nothing is invented,
   * and free text stays available for anything neither source mentions.
   */
  private async claudeModels(): Promise<{
    models: ProviderModelOption[];
    sources: string[];
  }> {
    const models = new Map<string, ProviderModelOption>();
    const sources: string[] = [];
    try {
      const config = JSON.parse(
        await readFile(path.join(this.homeDirectory, ".claude.json"), "utf8"),
      ) as {
        additionalModelOptionsCache?: Array<{
          value?: string;
          label?: string;
          description?: string;
        }>;
      };
      for (const option of config.additionalModelOptionsCache ?? []) {
        if (typeof option.value !== "string" || option.value.length === 0) {
          continue;
        }
        models.set(option.value, {
          id: option.value,
          label: option.label ?? option.value,
          ...(option.description === undefined
            ? {}
            : { description: option.description }),
        });
      }
      if (models.size > 0) {
        sources.push("Claude Code's own model cache (~/.claude.json)");
      }
    } catch {
      // No cache on this machine yet; the aliases below still apply.
    }
    try {
      const help = await this.runner(
        resolveClaudeCommand("claude"),
        ["--help"],
        { timeoutMs: 30_000, maxOutputBytes: 262_144 },
      );
      if (help.exitCode === 0) {
        // Reads the --model paragraph only, so unrelated quoted examples
        // elsewhere in the help text cannot leak in as model names.
        const paragraph = /--model <model>([\s\S]*?)(?:\n\s*-{1,2}[A-Za-z])/u
          .exec(help.stdout)?.[1];
        const quoted = [...(paragraph ?? "").matchAll(/'([A-Za-z0-9._:-]+)'/gu)]
          .map((match) => match[1] as string)
          .filter((value) => MODEL_VALUE.test(value));
        for (const value of quoted) {
          if (!models.has(value)) {
            models.set(value, { id: value, label: value });
          }
        }
        if (quoted.length > 0) {
          sources.push("aliases documented by `claude --help`");
        }
      }
    } catch {
      // Help unavailable; whatever the cache provided still stands.
    }
    return { models: [...models.values()], sources };
  }

  public async options(input: {
    provider: ProviderId;
  }): Promise<ProviderOptions> {
    if (input.provider === "openai") {
      const models = await this.codexModels();
      return {
        models: models ?? null,
        ...(models === undefined
          ? {}
          : {
              modelListSource:
                "Models and reasoning levels reported by the signed-in Codex account (~/.codex/models_cache.json)",
            }),
        efforts: null,
        allowCustomModel: false,
        notes:
          models === undefined
            ? ["The Codex CLI has not cached a model list for this account yet."]
            : [],
      };
    }
    if (input.provider === "anthropic") {
      const claude = await this.claudeModels();
      return {
        models: claude.models.length > 0 ? claude.models : null,
        ...(claude.sources.length > 0
          ? {
              modelListSource: `Models read from ${claude.sources.join(" and ")}. Claude Code has no model-list command, so this is what it actually reports here.`,
            }
          : {}),
        efforts: [...CLAUDE_EFFORTS],
        allowCustomModel: true,
        notes: [
          "Any other model name still works — the value is passed to --model as-is.",
          "Reasoning effort maps to the CLI's real --effort option.",
        ],
      };
    }
    return {
      models: null,
      efforts: null,
      allowCustomModel: false,
      notes: [
        "Gemini CLI settings become available once the signed-in account is eligible to use it.",
      ],
    };
  }

  public async setSettings(input: {
    userId: string;
    provider: ProviderId;
    model?: string;
    effort?: string;
  }): Promise<ProviderStatus[]> {
    const file = await this.readConnections();
    const connection = file[input.userId]?.[input.provider];
    if (connection === undefined) {
      throw new ProviderChatError(
        409,
        "not_connected",
        `Connect ${PROVIDER_NAMES[input.provider]} before changing its settings`,
      );
    }
    const options = await this.options({ provider: input.provider });
    // Partial updates merge: changing the effort alone must not drop the
    // chosen model, and vice versa.
    const settings: ProviderSettings = { ...connection.settings };
    if (input.model !== undefined && input.model.length > 0) {
      if (!MODEL_VALUE.test(input.model)) {
        throw new ProviderChatError(400, "invalid_model", "Model value is invalid");
      }
      if (
        options.models !== null &&
        !options.allowCustomModel &&
        !options.models.some((model) => model.id === input.model)
      ) {
        throw new ProviderChatError(
          400,
          "invalid_model",
          "That model is not one the connected account reports",
        );
      }
      settings.model = input.model;
    }
    if (input.effort !== undefined && input.effort.length > 0) {
      const valid =
        options.efforts?.includes(input.effort) ??
        options.models?.some(
          (model) =>
            (settings.model === undefined || model.id === settings.model) &&
            model.efforts?.includes(input.effort as string),
        ) ??
        false;
      if (!valid) {
        throw new ProviderChatError(
          400,
          "invalid_effort",
          "That reasoning effort is not one the provider reports for this model",
        );
      }
      settings.effort = input.effort;
    }
    connection.settings = settings;
    await this.writeConnections(file);
    return await this.list({ userId: input.userId, systemAdmin: true });
  }

  /* ---------------------------------------------------- completions ----- */

  /**
   * Same contract as {@link complete}, but every event the CLI emits while
   * it works is handed to `onEvent` as it arrives. The final reply still
   * comes from the same parser the non-streaming path uses.
   */
  public async completeStream(
    input: {
      userId: string;
      systemAdmin: boolean;
      provider: ProviderId;
      messages: unknown;
      cliSessionId?: string;
    },
    onEvent: (event: ChatStreamEvent) => void,
  ): Promise<ChatReply> {
    const prompt = await this.prepareCompletion(input);
    return await this.withCompletionEnv(
      input.provider,
      prompt.credential,
      async (env) =>
        input.provider === "anthropic"
          ? await this.streamViaClaudeCli(
              prompt.text,
              prompt.settings,
              input.cliSessionId,
              onEvent,
              env,
            )
          : await this.streamViaCodexCli(
              prompt.text,
              prompt.settings,
              input.cliSessionId,
              onEvent,
              env,
            ),
    );
  }

  /**
   * Shared gate: connection, authority, message shape — and which account
   * will pay.
   *
   * The admin check applies only to the shared host login, because that is
   * the case where one person's account funds another person's prompt. A user
   * running on their own credential is spending their own money and needs no
   * elevated rights.
   */
  private async prepareCompletion(input: {
    userId: string;
    systemAdmin: boolean;
    provider: ProviderId;
    messages: unknown;
  }): Promise<{
    text: string;
    settings: ProviderSettings;
    credential: UserCredential | undefined;
  }> {
    const messages = assertMessages(input.messages);
    const credential = await this.ownCredential(input.userId, input.provider);
    const connection = (await this.readConnections())[input.userId]?.[
      input.provider
    ];
    if (connection === undefined && credential === undefined) {
      throw new ProviderChatError(
        409,
        "not_connected",
        `Connect ${PROVIDER_NAMES[input.provider]} before chatting`,
      );
    }
    if (credential === undefined && !input.systemAdmin) {
      throw new ProviderChatError(
        403,
        "admin_required",
        `Chatting on this deployment's shared ${PROVIDER_NAMES[input.provider]} ` +
          "login is restricted to system administrators — connect your own " +
          "account instead",
      );
    }
    const latest = messages.at(-1);
    if (latest === undefined || latest.role !== "user") {
      throw new ProviderChatError(
        400,
        "invalid_messages",
        "The last message must be from the user",
      );
    }
    if (input.provider === "google" && credential === undefined) {
      throw new ProviderChatError(
        409,
        "provider_blocked",
        "Gemini chat is unavailable until the signed-in Google account is eligible",
      );
    }
    return {
      text: latest.content,
      settings: connection?.settings ?? {},
      credential,
    };
  }

  /**
   * Runs `use` with the environment the caller's prompt should execute under.
   *
   * With an own credential that is an isolated home carrying only their
   * secret; without one it is the ambient environment, which is what reaches
   * the host's own CLI login. Every completion path goes through here so the
   * two cases cannot drift apart.
   */
  private async withCompletionEnv<T>(
    provider: ProviderId,
    credential: UserCredential | undefined,
    use: (env: NodeJS.ProcessEnv | undefined) => Promise<T>,
  ): Promise<T> {
    if (credential === undefined) {
      return await use(undefined);
    }
    return await withCredentialHome(
      {
        vendor: PROVIDER_VENDORS[provider],
        credential,
        baseEnv: sanitizeChildEnv(process.env),
      },
      async (home) => await use(home.env),
    );
  }

  public async complete(input: {
    userId: string;
    systemAdmin: boolean;
    provider: ProviderId;
    messages: unknown;
    cliSessionId?: string;
  }): Promise<ChatReply> {
    const prompt = await this.prepareCompletion(input);
    try {
      return await this.withCompletionEnv(
        input.provider,
        prompt.credential,
        async (env) =>
          input.provider === "anthropic"
            ? await this.completeViaClaudeCli(
                prompt.text,
                prompt.settings,
                input.cliSessionId,
                env,
              )
            : await this.completeViaCodexCli(
                prompt.text,
                prompt.settings,
                input.cliSessionId,
                env,
              ),
      );
    } catch (error) {
      // A stored credential that no longer authenticates is recorded as such
      // here, where the failure is actually observed. Nothing else can see
      // it: the vault knows a secret exists, and `claude auth status` reports
      // a *stored* session rather than a working one, so without this the
      // dashboard went on showing an agent as connected while every task and
      // every message it was given failed to authenticate.
      await this.noteCredentialFailure(input.userId, input.provider, error);
      throw error;
    }
  }

  /** Whether a failure means the credential itself has stopped working. */
  private static isAuthFailure(message: string): boolean {
    return /OAuth session expired|could not be refreshed|Failed to authenticate|Not logged in|invalid_api_key|unauthorized|401/iu.test(
      message,
    );
  }

  /**
   * Public counterpart of {@link noteCredentialFailure}, for the run path.
   *
   * A task fails inside the coordinator, which never touches this service, so
   * the gateway forwards what it saw rather than the failure going unrecorded
   * and the dashboard continuing to claim the agent is connected.
   */
  public async noteAuthFailure(input: {
    userId: string;
    provider: ProviderId;
    reason: string;
  }): Promise<void> {
    try {
      const store = await this.credentialStore();
      await store.markUnusable(
        input.userId,
        PROVIDER_VENDORS[input.provider],
        input.reason,
      );
    } catch {
      // Recording a failure must never become a second one.
    }
  }

  private async noteCredentialFailure(
    userId: string,
    provider: ProviderId,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    if (!ProviderChatService.isAuthFailure(message)) {
      return;
    }
    try {
      const store = await this.credentialStore();
      await store.markUnusable(
        userId,
        PROVIDER_VENDORS[provider],
        "The sign-in has expired. Reconnect this agent.",
      );
    } catch {
      // Recording why something failed must not become a second failure.
    }
  }

  private async scratchDirectory(): Promise<string> {
    const scratch = path.join(os.tmpdir(), "coord-provider-chat");
    await mkdir(scratch, { recursive: true });
    return scratch;
  }

  private cliFailure(name: string, output: ProcessOutput): ProviderChatError {
    return new ProviderChatError(
      502,
      "cli_failed",
      `The ${name} CLI exited ${output.exitCode}: ${
        output.stderr.trim().slice(0, 400) ||
        output.stdout.trim().slice(0, 400)
      }`,
    );
  }

  /**
   * Streaming Claude Code completion. `--include-partial-messages` makes the
   * CLI emit the answer as it is produced. Verified on this host: thinking
   * blocks arrive with their text *redacted* (empty `thinking_delta`s) while
   * carrying real token estimates, so reasoning is reported as hidden with
   * live counts and never invented.
   */
  private async streamViaClaudeCli(
    prompt: string,
    settings: ProviderSettings,
    cliSessionId: string | undefined,
    onEvent: (event: ChatStreamEvent) => void,
    env: NodeJS.ProcessEnv | undefined,
  ): Promise<ChatReply> {
    const scratch = await this.scratchDirectory();
    const model = settings.model ?? DEFAULT_CLAUDE_MODEL;
    const effort = settings.effort ?? DEFAULT_CLAUDE_EFFORT;
    const usePositional = prompt.length <= 8_000;
    const resumable =
      cliSessionId !== undefined && /^[A-Za-z0-9-]{8,64}$/u.test(cliSessionId);
    const argsFor = (resume: boolean) => [
      "-p",
      ...(usePositional ? [prompt] : []),
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      model,
      "--effort",
      effort,
      ...(resume ? ["--resume", cliSessionId as string] : []),
    ];
    let reasoningAnnounced = false;
    const handleLine = (line: string) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event["type"] === "system" && event["subtype"] === "status") {
        const status = event["status"];
        if (typeof status === "string") {
          onEvent({ type: "status", status });
        }
        return;
      }
      if (
        event["type"] === "system" &&
        event["subtype"] === "thinking_tokens"
      ) {
        const tokens = event["estimated_tokens"];
        if (typeof tokens === "number") {
          onEvent({ type: "reasoning_tokens", tokens });
        }
        return;
      }
      if (event["type"] !== "stream_event") {
        return;
      }
      const inner = event["event"] as
        | {
            type?: string;
            content_block?: { type?: string };
            delta?: { type?: string; text?: string; thinking?: string };
          }
        | undefined;
      if (
        inner?.type === "content_block_start" &&
        inner.content_block?.type === "thinking" &&
        !reasoningAnnounced
      ) {
        reasoningAnnounced = true;
        onEvent({ type: "reasoning_start", hidden: true });
        return;
      }
      if (inner?.type === "content_block_delta") {
        if (
          inner.delta?.type === "text_delta" &&
          typeof inner.delta.text === "string"
        ) {
          onEvent({ type: "text", delta: inner.delta.text });
        } else if (
          inner.delta?.type === "thinking_delta" &&
          typeof inner.delta.thinking === "string" &&
          inner.delta.thinking.length > 0
        ) {
          // Only reached if a future CLI stops redacting the text.
          onEvent({ type: "reasoning", text: inner.delta.thinking });
        }
      }
    };
    const runOnce = async (resume: boolean): Promise<ProcessOutput> =>
      await this.streamRunner(
        resolveClaudeCommand("claude"),
        argsFor(resume),
        {
          cwd: scratch,
          ...(usePositional ? {} : { input: prompt }),
          ...(env === undefined ? {} : { env }),
          timeoutMs: CLI_TIMEOUT_MS,
          maxOutputBytes: MAX_OUTPUT_BYTES,
        },
        handleLine,
      );
    let output = await runOnce(resumable);
    if (output.exitCode !== 0 && resumable) {
      output = await runOnce(false);
    }
    if (output.exitCode !== 0) {
      throw this.cliFailure("claude", output);
    }
    return parseClaudeStreamJson(output.stdout, model);
  }

  /**
   * Streaming Codex completion. `model_reasoning_summary="detailed"` makes
   * the CLI emit real reasoning-summary items mid-turn — verified live,
   * arriving ~20s before the answer — which are forwarded verbatim. The CLI
   * emits completed items rather than token deltas, so the answer still
   * lands in one piece.
   */
  private async streamViaCodexCli(
    prompt: string,
    settings: ProviderSettings,
    cliSessionId: string | undefined,
    onEvent: (event: ChatStreamEvent) => void,
    env: NodeJS.ProcessEnv | undefined,
  ): Promise<ChatReply> {
    const scratch = await this.scratchDirectory();
    const command = resolveCodexCommand(this.homeDirectory);
    const resumable =
      cliSessionId !== undefined &&
      /^[A-Za-z0-9-]{8,64}$/u.test(cliSessionId);
    const overrides = [
      ...(settings.effort === undefined
        ? []
        : ["-c", `model_reasoning_effort=${JSON.stringify(settings.effort)}`]),
      "-c",
      'model_reasoning_summary="detailed"',
    ];
    const argsFor = (resume: boolean) =>
      resume
        ? [
            "exec",
            "resume",
            cliSessionId as string,
            "--json",
            "--skip-git-repo-check",
            "-c",
            'sandbox_mode="read-only"',
            ...overrides,
            prompt,
          ]
        : [
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "-C",
            scratch,
            ...(settings.model === undefined ? [] : ["-m", settings.model]),
            ...overrides,
            prompt,
          ];
    let reasoningAnnounced = false;
    const handleLine = (line: string) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event["type"] === "turn.started") {
        onEvent({ type: "status", status: "working" });
        return;
      }
      if (event["type"] !== "item.completed") {
        return;
      }
      const item = event["item"] as
        | { type?: string; text?: string }
        | undefined;
      if (item?.type === "reasoning" && typeof item.text === "string") {
        if (!reasoningAnnounced) {
          reasoningAnnounced = true;
          onEvent({ type: "reasoning_start", hidden: false });
        }
        onEvent({ type: "reasoning", text: item.text });
        return;
      }
      if (item?.type === "agent_message" && typeof item.text === "string") {
        onEvent({ type: "text", delta: item.text });
      }
    };
    const runOnce = async (resume: boolean): Promise<ProcessOutput> =>
      await this.streamRunner(
        command,
        argsFor(resume),
        {
          cwd: scratch,
          ...(env === undefined ? {} : { env }),
          timeoutMs: CLI_TIMEOUT_MS,
          maxOutputBytes: MAX_OUTPUT_BYTES,
        },
        handleLine,
      );
    let output = await runOnce(resumable);
    if (output.exitCode !== 0 && resumable) {
      output = await runOnce(false);
    }
    if (output.exitCode !== 0) {
      throw this.cliFailure("codex", output);
    }
    const reply = parseCodexJsonl(
      output.stdout,
      settings.model ?? "codex default",
    );
    const models = await this.codexModels();
    const contextWindow = (
      models?.find((model) => model.id === settings.model) ?? models?.[0]
    )?.contextWindow;
    return {
      ...reply,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    };
  }

  /**
   * Headless Claude Code completion. The prompt is a positional argument —
   * verified live that a piped stdin prompt makes the CLI skip thinking —
   * and the process runs in an empty scratch directory under default
   * deny-by-request permissions, so it can answer but not act on the host.
   */
  private async completeViaClaudeCli(
    prompt: string,
    settings: ProviderSettings,
    cliSessionId: string | undefined,
    env: NodeJS.ProcessEnv | undefined,
  ): Promise<ChatReply> {
    const scratch = await this.scratchDirectory();
    const model = settings.model ?? DEFAULT_CLAUDE_MODEL;
    const effort = settings.effort ?? DEFAULT_CLAUDE_EFFORT;
    const usePositional = prompt.length <= 8_000;
    const resumable =
      cliSessionId !== undefined && /^[A-Za-z0-9-]{8,64}$/u.test(cliSessionId);
    const argsFor = (resume: boolean) => [
      "-p",
      ...(usePositional ? [prompt] : []),
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      model,
      "--effort",
      effort,
      ...(resume ? ["--resume", cliSessionId as string] : []),
    ];
    const runOnce = async (resume: boolean): Promise<ProcessOutput> =>
      await this.runner(resolveClaudeCommand("claude"), argsFor(resume), {
        cwd: scratch,
        ...(usePositional ? {} : { input: prompt }),
        ...(env === undefined ? {} : { env }),
        timeoutMs: CLI_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
    let output = await runOnce(resumable);
    if (output.exitCode !== 0 && resumable) {
      // A stale session id (restart, CLI cleanup) costs the thread memory,
      // not the message.
      output = await runOnce(false);
    }
    if (output.exitCode !== 0) {
      throw this.cliFailure("claude", output);
    }
    return parseClaudeStreamJson(output.stdout, model);
  }

  /**
   * Codex CLI completion over the signed-in ChatGPT account.
   *
   * Runs `codex exec --json` in the read-only sandbox inside an empty
   * scratch directory: the model can reason and answer but the CLI's own
   * sandbox denies writes and command execution. Continuity uses
   * `codex exec resume <thread_id>`.
   */
  private async completeViaCodexCli(
    prompt: string,
    settings: ProviderSettings,
    cliSessionId: string | undefined,
    env: NodeJS.ProcessEnv | undefined,
  ): Promise<ChatReply> {
    const scratch = await this.scratchDirectory();
    const command = resolveCodexCommand(this.homeDirectory);
    const resumable =
      cliSessionId !== undefined &&
      /^[A-Za-z0-9-]{8,64}$/u.test(cliSessionId);
    const effortOverride =
      settings.effort === undefined
        ? []
        : ["-c", `model_reasoning_effort=${JSON.stringify(settings.effort)}`];
    // `exec resume` accepts only `-c` overrides, so the sandbox travels as
    // configuration there; a fresh exec uses the ordinary flags.
    const argsFor = (resume: boolean) =>
      resume
        ? [
            "exec",
            "resume",
            cliSessionId as string,
            "--json",
            "--skip-git-repo-check",
            "-c",
            'sandbox_mode="read-only"',
            ...effortOverride,
            prompt,
          ]
        : [
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "-C",
            scratch,
            ...(settings.model === undefined ? [] : ["-m", settings.model]),
            ...effortOverride,
            prompt,
          ];
    const runOnce = async (resume: boolean): Promise<ProcessOutput> =>
      await this.runner(command, argsFor(resume), {
        cwd: scratch,
        ...(env === undefined ? {} : { env }),
        timeoutMs: CLI_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
    let output = await runOnce(resumable);
    if (output.exitCode !== 0 && resumable) {
      output = await runOnce(false);
    }
    if (output.exitCode !== 0) {
      throw this.cliFailure("codex", output);
    }
    const reply = parseCodexJsonl(
      output.stdout,
      settings.model ?? "codex default",
    );
    // The account's model cache carries the real context window; attach it
    // so the usage view can show consumption against a true denominator.
    const models = await this.codexModels();
    const contextWindow = (
      models?.find((model) => model.id === settings.model) ?? models?.[0]
    )?.contextWindow;
    return {
      ...reply,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    };
  }
}

/* ----------------------------------------------------- stream parsing ---- */

/**
 * Extracts the reply, thinking, usage, cost, and rate-limit window from the
 * claude CLI's stream-json output. Exported for tests.
 */
export function parseClaudeStreamJson(
  stdout: string,
  model: string,
): ChatReply {
  let text = "";
  let thinking = "";
  /**
   * Current Claude Code redacts thinking *content* in headless mode — blocks
   * arrive with empty text plus a signature — but reports how many thinking
   * tokens were spent via `system/thinking_tokens` events. Those counts are
   * kept and the reasoning is marked hidden; if a future CLI ships the text,
   * it will simply start appearing.
   */
  let thinkingTokens = 0;
  let sawThinkingBlock = false;
  let usage: ChatUsage = {};
  let rateLimit: ChatRateLimit | undefined;
  let cliSessionId: string | undefined;
  let contextWindow: number | undefined;
  let resultSeen = false;
  let isError = false;
  let errorDetail = "";

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event["type"] === "assistant") {
      const message = event["message"] as
        | {
            content?: Array<{
              type?: string;
              text?: string;
              thinking?: string;
            }>;
          }
        | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === "text") {
          text += block.text ?? "";
        } else if (block.type === "thinking") {
          sawThinkingBlock = true;
          const content = (block.thinking ?? "").trim();
          if (content.length > 0) {
            thinking += (thinking.length > 0 ? "\n\n" : "") + content;
          }
        }
      }
    } else if (
      event["type"] === "system" &&
      event["subtype"] === "thinking_tokens"
    ) {
      const estimated = event["estimated_tokens"];
      if (typeof estimated === "number" && estimated > thinkingTokens) {
        thinkingTokens = estimated;
      }
    } else if (event["type"] === "rate_limit_event") {
      const info = event["rate_limit_info"] as
        | { status?: string; resetsAt?: number; rateLimitType?: string }
        | undefined;
      if (info !== undefined) {
        rateLimit = {
          source: "cli-window",
          ...(info.rateLimitType === undefined
            ? {}
            : { windowKind: info.rateLimitType }),
          ...(info.status === undefined ? {} : { windowStatus: info.status }),
          ...(typeof info.resetsAt === "number"
            ? { windowResetsAt: new Date(info.resetsAt * 1000).toISOString() }
            : {}),
        };
      }
    } else if (event["type"] === "result") {
      resultSeen = true;
      isError = event["is_error"] === true;
      if (typeof event["result"] === "string" && text.length === 0) {
        text = event["result"];
      }
      if (isError && typeof event["result"] === "string") {
        errorDetail = event["result"];
      }
      const eventUsage = event["usage"] as
        | { input_tokens?: number; output_tokens?: number }
        | undefined;
      usage = {
        ...(eventUsage?.input_tokens === undefined
          ? {}
          : { inputTokens: eventUsage.input_tokens }),
        ...(eventUsage?.output_tokens === undefined
          ? {}
          : { outputTokens: eventUsage.output_tokens }),
        ...(typeof event["total_cost_usd"] === "number"
          ? { costUsd: event["total_cost_usd"] }
          : {}),
      };
      if (typeof event["session_id"] === "string") {
        cliSessionId = event["session_id"];
      }
      const modelUsage = event["modelUsage"] as
        | Record<string, { contextWindow?: number }>
        | undefined;
      for (const entry of Object.values(modelUsage ?? {})) {
        if (
          typeof entry?.contextWindow === "number" &&
          entry.contextWindow > (contextWindow ?? 0)
        ) {
          contextWindow = entry.contextWindow;
        }
      }
    }
  }

  if (!resultSeen) {
    throw new ProviderChatError(
      502,
      "cli_failed",
      "The local claude CLI produced no result event",
    );
  }
  if (isError) {
    throw new ProviderChatError(
      502,
      "cli_failed",
      `The local claude CLI reported an error: ${errorDetail.slice(0, 400)}`,
    );
  }
  const reasonedInvisibly =
    thinking.length === 0 && (sawThinkingBlock || thinkingTokens > 0);
  return {
    provider: "anthropic",
    model,
    text,
    ...(thinking.length > 0 ? { thinking } : {}),
    ...(reasonedInvisibly ? { thinkingHidden: true } : {}),
    usage: {
      ...usage,
      ...(thinkingTokens > 0 ? { thinkingTokens } : {}),
    },
    ...(rateLimit === undefined ? {} : { rateLimit }),
    ...(cliSessionId === undefined ? {} : { cliSessionId }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

/**
 * Extracts the reply, reasoning summaries, usage, and thread id from
 * `codex exec --json` output. Exported for tests.
 */
export function parseCodexJsonl(stdout: string, model: string): ChatReply {
  let text = "";
  let thinking = "";
  let usage: ChatUsage = {};
  let threadId: string | undefined;
  let sawTurnCompleted = false;
  let failure: string | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = event["type"];
    if (type === "thread.started" && typeof event["thread_id"] === "string") {
      threadId = event["thread_id"];
    } else if (type === "item.completed") {
      const item = event["item"] as
        | { type?: string; text?: string }
        | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        text += (text.length > 0 ? "\n\n" : "") + item.text;
      } else if (
        item?.type === "reasoning" &&
        typeof item.text === "string" &&
        item.text.trim().length > 0
      ) {
        thinking += (thinking.length > 0 ? "\n\n" : "") + item.text.trim();
      }
    } else if (type === "turn.completed") {
      sawTurnCompleted = true;
      const turnUsage = event["usage"] as
        | {
            input_tokens?: number;
            cached_input_tokens?: number;
            output_tokens?: number;
            reasoning_output_tokens?: number;
          }
        | undefined;
      usage = {
        ...(turnUsage?.input_tokens === undefined
          ? {}
          : { inputTokens: turnUsage.input_tokens }),
        ...(turnUsage?.cached_input_tokens === undefined
          ? {}
          : { cachedInputTokens: turnUsage.cached_input_tokens }),
        ...(turnUsage?.output_tokens === undefined
          ? {}
          : { outputTokens: turnUsage.output_tokens }),
        ...(turnUsage?.reasoning_output_tokens === undefined
          ? {}
          : { thinkingTokens: turnUsage.reasoning_output_tokens }),
      };
    } else if (type === "turn.failed" || type === "error") {
      failure =
        (typeof event["message"] === "string" && event["message"]) ||
        JSON.stringify(event).slice(0, 300);
    }
  }

  if (failure !== undefined) {
    throw new ProviderChatError(
      502,
      "cli_failed",
      `The codex CLI reported an error: ${failure.slice(0, 400)}`,
    );
  }
  if (!sawTurnCompleted) {
    throw new ProviderChatError(
      502,
      "cli_failed",
      "The codex CLI produced no completed turn",
    );
  }
  const hasHiddenReasoning =
    thinking.length === 0 && (usage.thinkingTokens ?? 0) > 0;
  return {
    provider: "openai",
    model,
    text,
    ...(thinking.length > 0 ? { thinking } : {}),
    ...(hasHiddenReasoning ? { thinkingHidden: true } : {}),
    usage,
    ...(threadId === undefined ? {} : { cliSessionId: threadId }),
  };
}
