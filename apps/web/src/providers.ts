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
  type CanonicalRepository,
  type ProcessOutput,
} from "@coord/repository-service";
import {
  AGENT_CALL_SIGNS,
  deriveCallSign,
  type CanonicalVersion,
} from "@coord/shared-types";
import {
  GitWorktreeWorkspaceManager,
  supportedCredentialKinds,
  UserCredentialError,
  UserCredentialStore,
  assertSessionFile,
  captureBrowserSession,
  captureClaudeSession,
  credentialHint,
  credentialSourcesFor,
  programCacheEnv,
  withCredentialHome,
  type CredentialHome,
  type CredentialVisibility,
  type TaskWorkspace,
  type UserCredential,
  type UserCredentialKind,
  type UserCredentialSummary,
  type VendorCliKind,
  type WorkspaceManager,
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

export type ProviderId =
  | "anthropic"
  | "openai"
  | "google"
  | "cursor"
  | "copilot"
  | "kiro";
export const PROVIDER_IDS: readonly ProviderId[] = [
  "anthropic",
  "openai",
  "cursor",
  "kiro",
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
  /**
   * The same reset moment as the CLI's own seconds-since-epoch, kept beside
   * the formatted string rather than instead of it. `resetsAt` is formatted
   * on the server, in the server's locale and zone; the browser cannot undo
   * that to say "in 42 minutes", which is the form a person actually reads a
   * quota in. Absent when the CLI published no reset time.
   */
  resetsAtEpoch?: number;
  /**
   * How long this window is, in minutes, as the CLI reported it. The label is
   * derived from it ("5 hours", "7 days"), but the number itself distinguishes
   * a five-hour window from a weekly one without parsing English back.
   */
  windowDurationMins?: number;
}

/** See {@link ProviderUsageReport.spend}. */
export interface ProviderSpend {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** How many tasks these tokens came from, so a big number has a scale. */
  tasks: number;
  /** The start of the window measured, so "since" is not left to a guess. */
  since: string;
}

export interface ProviderUsageReport {
  /**
   * Where these numbers came from, shown to the user verbatim-ish. Absent
   * when the provenance would say nothing the reader did not already know:
   * Claude's own `/usage` is read for the account the card is already about.
   */
  source?: string;
  windows: ProviderUsageWindow[];
  /** Set when the CLI publishes no consumption figure at all. */
  unavailableReason?: string;
  /**
   * When this reading was taken, for a figure that came from a machine rather
   * than from asking just now. Absent means it is live. Present means the card
   * should say so, because a machine that has been asleep for a day is not
   * reporting today's quota.
   */
  asOf?: string;
  /**
   * What this agent has actually spent through Kumi.
   *
   * Kumi's own accounting, not the vendor's, and the two answer different
   * questions. A vendor quota says how much of a ceiling is left and only the
   * vendor knows the ceiling; this says what the work done here cost, and is
   * available for every vendor because it is measured rather than asked for —
   * the worker reports a running total on each heartbeat and it is stored per
   * task.
   *
   * It is the answer for Claude in particular, whose CLI publishes no quota
   * figure outside its own interactive view at all: there is no percentage to
   * be had, and an empty card that says so forever is worse than a real
   * number about real work.
   */
  spend?: ProviderSpend;
  /** The subscription tier the account is on ("plus", "pro", ...). */
  planType?: string;
  /**
   * Credits left on the account, when it holds a credit balance at all.
   *
   * Kept as a plain number because that is the only part of the credits
   * object whose shape has been stable across CLI releases; anything else it
   * carries is deliberately not promised here.
   */
  creditBalance?: number;
  /**
   * Readable facts the CLI reported that are not percentages.
   *
   * Cursor's `status` answers with the account, its plan and its version
   * rather than a quota, and dropping that on the floor left the card saying
   * "no usage reported" about a CLI that had just answered. Kept as the CLI's
   * own lines so nothing here is a number it never gave.
   */
  notes?: string[];
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
  /**
   * The agent's call sign, held once per connected account.
   *
   * It belongs here rather than on a channel because it is the agent's name,
   * not its name *in a room*: somebody who has met Icarus in one channel
   * should meet the same Icarus in the next. A channel may still override it
   * -- two people's agents can collide in a room that neither of them chose --
   * but the override is the exception and this is the default.
   */
  callSign?: string;
}

/**
 * Names handed to newly connected accounts, drawn at random.
 *
 * Greek and Roman gods, and the distinction from things is not decoration. An
 * agent named after a product talks about itself as one: an agent called
 * Apollo once reported that "Apollo integration isn't installed" when asked
 * about itself. `agentIdentity()` counters that directly, and a name with no
 * software of the same name to be confused with does not start the argument.
 *
 * Order carries no meaning: assignment picks uniformly from whatever is still
 * free, so this reads as sections of a pantheon rather than as a queue.
 */
// Re-exported from where it now lives, so every existing importer of this
// module is untouched. The gateway needs the same list — it assigns a name to
// an agent created without a credential — and two copies would drift.
export { AGENT_CALL_SIGNS };

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
  /** The agent's own name, held per account rather than per channel. */
  callSign?: string;
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
  // Cursor and Gemini hand an authorization code back to the waiting CLI.
  // Copilot and Kiro have real device flows: the CLI prints a one-time code,
  // the user enters it on the vendor page, and the CLI polls for completion.
  cursor: "code_exchange",
  copilot: "approve",
  kiro: "approve",
  google: "code_exchange",
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
  /**
   * Names worth offering when the account has reported none of its own.
   *
   * Kept apart from `models` on purpose, and that separation is the whole
   * point: `models` is what this account's CLI actually reports, and a
   * suggestion is a guess that saves typing. Merging the two is what went
   * wrong before — a hardcoded pair of names rendered in the same control as
   * reported ones, so a person had no way to tell which they were reading,
   * and the pair was two years stale besides. Offered only where the real
   * list is absent, labelled as suggestions, and always overridable by
   * typing, because the value is passed to the CLI verbatim either way.
   */
  suggestedModels?: ProviderModelOption[];
  /** The same, for reasoning levels the provider did not enumerate. */
  suggestedEfforts?: string[];
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
  cursor: "Cursor",
  copilot: "GitHub Copilot",
  kiro: "Kiro",
};

/** The dashboard names providers by vendor; the CLIs name them by tool. */
const PROVIDER_VENDORS: Record<ProviderId, VendorCliKind> = {
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
  cursor: "cursor",
  copilot: "copilot",
  kiro: "kiro",
};

/** The inverse of {@link PROVIDER_VENDORS}, for reporting a stored vendor back. */
const VENDOR_PROVIDERS: Record<VendorCliKind, ProviderId> = {
  claude: "anthropic",
  codex: "openai",
  gemini: "google",
  cursor: "cursor",
  copilot: "copilot",
  kiro: "kiro",
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
    "Paste an API key from aistudio.google.com/apikey. It bills per request " +
      "rather than against a subscription.",
    "Browser sign-in is still available on a paid Gemini Code Assist plan, " +
      "but Google has withdrawn it from personal accounts.",
  ],
  cursor: [
    "Sign in to Cursor in the browser opened by Cursor Agent CLI. API keys " +
      "and copied session files are not accepted.",
  ],
  copilot: [
    "Sign in to GitHub in the browser opened by Copilot CLI. API keys and " +
      "personal access tokens are not accepted for this agent connection.",
  ],
  kiro: [
    "Sign in to Kiro in the browser opened by Kiro CLI. API keys and copied " +
      "session files are not accepted.",
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
  if (!contents.includes(marker)) {
    return undefined;
  }
  type CodexRateLimits = {
    primary?: CodexRateWindow | null;
    secondary?: CodexRateWindow | null;
    plan_type?: string | null;
  };
  // Newest reading of each window, not the newest event.
  //
  // A session emits `rate_limits` repeatedly, and the payloads are not always
  // complete: an event can carry the weekly window and not the five-hour one.
  // Reading only the last occurrence meant one partial event at the end of a
  // rollout discarded a figure that was sitting a few lines above it, and the
  // card showed a week with no five hours beside it. Each window is now taken
  // from the most recent event that actually reported it.
  let limits: CodexRateLimits | undefined;
  const freshest: CodexRateLimits = {};
  const lines = contents.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || !line.includes(marker)) {
      continue;
    }
    let found: CodexRateLimits | undefined;
    try {
      found = findRateLimits(
        JSON.parse(line) as Record<string, unknown>,
      ) as CodexRateLimits | undefined;
    } catch {
      continue;
    }
    if (found === undefined) {
      continue;
    }
    limits ??= found;
    if (
      freshest.primary == null &&
      typeof found.primary?.used_percent === "number"
    ) {
      freshest.primary = found.primary;
    }
    if (
      freshest.secondary == null &&
      typeof found.secondary?.used_percent === "number"
    ) {
      freshest.secondary = found.secondary;
    }
    if (freshest.plan_type == null && typeof found.plan_type === "string") {
      freshest.plan_type = found.plan_type;
    }
    if (freshest.primary != null && freshest.secondary != null) {
      break;
    }
  }
  if (limits === undefined) {
    return undefined;
  }
  limits = { ...limits, ...freshest };
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
      ...(typeof window.window_minutes === "number" && window.window_minutes > 0
        ? { windowDurationMins: window.window_minutes }
        : {}),
      ...(typeof window.resets_at === "number"
        ? {
            resetsAt: new Date(window.resets_at * 1000).toLocaleString(
              undefined,
              { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
            ),
            resetsAtEpoch: window.resets_at,
          }
        : {}),
    });
  }
  return windows.length === 0
    ? undefined
    : {
        source: "Codex CLI",
        windows,
        ...(typeof limits.plan_type === "string" && limits.plan_type.trim() !== ""
          ? { planType: limits.plan_type.trim() }
          : {}),
      };
}

/** How long the account-quota handshake may take before it is abandoned. */
export const CODEX_QUOTA_TIMEOUT_MS = 8_000;

function codexNumber(
  value: Record<string, unknown>,
  camelCase: string,
  snakeCase: string,
): number | undefined {
  const found = value[camelCase] ?? value[snakeCase];
  return typeof found === "number" && Number.isFinite(found)
    ? found
    : undefined;
}

function codexStatusNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/%$/u, "");
  if (trimmed === "") {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function codexStatusWindow(
  value: unknown,
  fallbackMinutes: number,
): ProviderUsageWindow | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const window = value as Record<string, unknown>;
  const used = codexStatusNumber(
    window["usedPercent"] ??
      window["used_percent"] ??
      window["percentUsed"] ??
      window["percent_used"],
  );
  const remaining = codexStatusNumber(
    window["remainingPercent"] ??
      window["remaining_percent"] ??
      window["remainingPercentage"] ??
      window["remaining_percentage"] ??
      window["percentRemaining"] ??
      window["percent_remaining"],
  );
  if (used === undefined && remaining === undefined) {
    return undefined;
  }
  const minutes =
    codexStatusNumber(
      window["windowDurationMins"] ??
        window["window_duration_mins"] ??
        window["windowMinutes"] ??
        window["window_minutes"] ??
        window["durationMins"] ??
        window["duration_mins"],
    ) ?? fallbackMinutes;
  const resetsAt = codexStatusNumber(
    window["resetsAt"] ??
      window["resets_at"] ??
      window["resetAt"] ??
      window["reset_at"],
  );
  return codexAppServerWindow(
    {
      usedPercent: used !== undefined ? used : 100 - (remaining ?? 100),
      windowDurationMins: minutes,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    },
    codexWindowLabel(fallbackMinutes),
  );
}

function codexAppServerWindow(
  value: unknown,
  fallbackLabel: string,
): ProviderUsageWindow | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const window = value as Record<string, unknown>;
  const used = codexNumber(window, "usedPercent", "used_percent");
  if (used === undefined) {
    return undefined;
  }
  // Two spellings of the same field across CLI releases, and neither is worth
  // preferring: the app-server answers `window_minutes` on some builds and
  // `window_duration_mins` on others.
  const minutes =
    codexNumber(window, "windowMinutes", "window_minutes") ??
    codexNumber(window, "windowDurationMins", "window_duration_mins");
  const resetsAt = codexNumber(window, "resetsAt", "resets_at");
  return {
    label: minutes === undefined ? fallbackLabel : codexWindowLabel(minutes),
    percentUsed: Math.max(0, Math.min(100, used)),
    ...(minutes === undefined || minutes <= 0
      ? {}
      : { windowDurationMins: minutes }),
    ...(resetsAt === undefined || resetsAt < 0
      ? {}
      : {
          resetsAt: new Date(resetsAt * 1000).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }),
          resetsAtEpoch: resetsAt,
        }),
  };
}

/**
 * The balance out of the app-server's `credits` object, if it has one.
 *
 * Only the number is taken. The credits object has changed shape between CLI
 * releases and an account on a plain subscription has none at all, so this
 * reads the one field that has been constant and treats everything else --
 * including a credits object that is present but says nothing -- as absent
 * rather than as a zero balance.
 */
function codexCreditBalance(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return codexNumber(value as Record<string, unknown>, "balance", "balance");
}

interface CodexAppServerLimitSnapshot {
  id: string;
  name: string;
  plan?: string;
  creditBalance?: number;
  windows: ProviderUsageWindow[];
}

function codexAppServerLimitSnapshot(
  value: unknown,
  fallbackName: string,
): CodexAppServerLimitSnapshot | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const limits = value as Record<string, unknown>;
  const windows = [
    codexAppServerWindow(limits["primary"], "primary"),
    codexAppServerWindow(limits["secondary"], "secondary"),
  ].filter((window): window is ProviderUsageWindow => window !== undefined);
  if (windows.length === 0) {
    return undefined;
  }
  const idValue = limits["limitId"] ?? limits["limit_id"];
  const id =
    typeof idValue === "string" && idValue.trim() !== ""
      ? idValue.trim()
      : fallbackName;
  const nameValue = limits["limitName"] ?? limits["limit_name"];
  const planValue = limits["planType"] ?? limits["plan_type"];
  const creditBalance = codexCreditBalance(limits["credits"]);
  return {
    id,
    name:
      typeof nameValue === "string" && nameValue.trim() !== ""
        ? nameValue.trim()
        : id,
    ...(typeof planValue === "string" && planValue.trim() !== ""
      ? { plan: planValue.trim() }
      : {}),
    ...(creditBalance === undefined ? {} : { creditBalance }),
    windows,
  };
}

function codexAppServerSnapshotSignature(
  snapshot: CodexAppServerLimitSnapshot,
): string {
  return JSON.stringify(
    snapshot.windows.map((window) => [
      window.label,
      window.percentUsed,
      window.resetsAt ?? null,
    ]),
  );
}

/**
 * Reads the quota answer out of `codex app-server`'s JSON-RPC stdout.
 *
 * This is the figure the Codex CLI itself shows for `/status`, asked of the
 * account directly rather than inferred from whatever a past session happened
 * to write down — which is why it is worth a handshake: a deployment where
 * every run gets its own temporary credential home has no past session
 * records to read, and the usage card had nothing to show as a result.
 *
 * Exported for tests.
 */
export function parseCodexAppServerRateLimits(
  stdout: string,
): ProviderUsageReport | undefined {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("{")) {
      continue;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const result = message["result"];
    if (typeof result !== "object" || result === null) {
      continue;
    }
    const envelope = result as Record<string, unknown>;
    const byLimitValue =
      envelope["rateLimitsByLimitId"] ??
      envelope["rate_limits_by_limit_id"];
    const snapshots: CodexAppServerLimitSnapshot[] = [];
    if (
      typeof byLimitValue === "object" &&
      byLimitValue !== null &&
      !Array.isArray(byLimitValue)
    ) {
      for (const [limitId, value] of Object.entries(
        byLimitValue as Record<string, unknown>,
      )) {
        const snapshot = codexAppServerLimitSnapshot(value, limitId);
        if (snapshot !== undefined) {
          snapshots.push(snapshot);
        }
      }
    }

    // Older app-servers returned just `rateLimits`; newer ones retain it as a
    // compatibility alias while putting the complete set in the keyed map.
    // Keep a genuinely distinct top-level bucket, but do not show the aliased
    // default twice.
    const legacyValue =
      envelope["rateLimits"] ??
      envelope["rate_limits"] ??
      (envelope["primary"] !== undefined || envelope["secondary"] !== undefined
        ? envelope
        : undefined);
    const legacy = codexAppServerLimitSnapshot(legacyValue, "default");
    if (
      legacy !== undefined &&
      !snapshots.some(
        (snapshot) =>
          (legacy.id !== "default" && snapshot.id === legacy.id) ||
          codexAppServerSnapshotSignature(snapshot) ===
            codexAppServerSnapshotSignature(legacy),
      )
    ) {
      snapshots.push(legacy);
    }
    if (snapshots.length === 0) {
      continue;
    }
    const plan =
      legacy?.plan ?? snapshots.find((snapshot) => snapshot.plan)?.plan;
    // Credits are an account-level fact, so the app-server has put them at
    // the envelope on some builds and inside the limits object on others.
    // Either spelling answers the same question; neither is invented.
    const creditBalance =
      codexCreditBalance(envelope["credits"]) ??
      legacy?.creditBalance ??
      snapshots.find((snapshot) => snapshot.creditBalance !== undefined)
        ?.creditBalance;
    const showBucketNames = snapshots.length > 1;
    const windows = snapshots.flatMap((snapshot) =>
      snapshot.windows.map((window) => ({
        ...window,
        label: showBucketNames
          ? `${snapshot.name} · ${window.label}`
          : window.label,
      })),
    );
    return {
      source:
        plan !== undefined
          ? `Codex account rate limits (${plan})`
          : "Codex account rate limits",
      windows,
      ...(plan === undefined ? {} : { planType: plan }),
      ...(creditBalance === undefined ? {} : { creditBalance }),
    };
  }
  return undefined;
}

/**
 * Reads the machine-readable counterpart of Codex's native `/status` view.
 *
 * Status releases have used both camel- and snake-case names and have called
 * the two subscription windows either primary/secondary or five-hour/weekly.
 * The status view reports remaining percentages on some builds, while the
 * dashboard's existing contract stores used percentages, so that one value
 * is converted here and nowhere else.
 */
export function parseCodexStatusRateLimits(
  stdout: string,
): ProviderUsageReport | undefined {
  let root: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    root = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const statusValue = root["status"];
  const envelope =
    typeof statusValue === "object" &&
    statusValue !== null &&
    !Array.isArray(statusValue)
      ? (statusValue as Record<string, unknown>)
      : root;
  const limitsValue =
    envelope["rateLimits"] ??
    envelope["rate_limits"] ??
    envelope["limits"] ??
    envelope["usage"] ??
    envelope;
  if (
    typeof limitsValue !== "object" ||
    limitsValue === null ||
    Array.isArray(limitsValue)
  ) {
    return undefined;
  }
  const limits = limitsValue as Record<string, unknown>;
  const primary = codexStatusWindow(
    limits["primary"] ??
      limits["fiveHour"] ??
      limits["five_hour"] ??
      limits["fiveHourUsage"] ??
      limits["five_hour_usage"] ??
      limits["5h"] ??
      limits["5-hour"],
    300,
  );
  const secondary = codexStatusWindow(
    limits["secondary"] ??
      limits["weekly"] ??
      limits["week"] ??
      limits["weeklyUsage"] ??
      limits["weekly_usage"],
    10_080,
  );
  if (primary === undefined || secondary === undefined) {
    return undefined;
  }
  const windows = [primary, secondary];
  const accountValue = envelope["account"] ?? root["account"];
  const account =
    typeof accountValue === "object" &&
    accountValue !== null &&
    !Array.isArray(accountValue)
      ? (accountValue as Record<string, unknown>)
      : undefined;
  const planValue =
    limits["planType"] ??
    limits["plan_type"] ??
    envelope["planType"] ??
    envelope["plan_type"] ??
    root["planType"] ??
    root["plan_type"] ??
    account?.["planType"] ??
    account?.["plan_type"];
  const plan =
    typeof planValue === "string" && planValue.trim() !== ""
      ? planValue.trim()
      : undefined;
  const credits =
    limits["credits"] ?? envelope["credits"] ?? root["credits"];
  const creditBalance =
    codexCreditBalance(credits) ??
    codexStatusNumber(
      limits["creditBalance"] ??
        limits["credit_balance"] ??
        envelope["creditBalance"] ??
        envelope["credit_balance"] ??
        root["creditBalance"] ??
        root["credit_balance"],
    );
  return {
    source:
      plan === undefined
        ? "Codex native status"
        : `Codex native status (${plan})`,
    windows,
    ...(plan === undefined ? {} : { planType: plan }),
    ...(creditBalance === undefined ? {} : { creditBalance }),
  };
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
  if (windows.length > 0) {
    return { windows };
  }
  // Percentages exist because a *subscription* has limits to be a percentage
  // of; `/usage` opens with "You are currently using your subscription to
  // power your Claude Code usage" when it has them. An API key has no such
  // ceiling, so there is nothing to report and no fault to find.
  if (/api\s*key/iu.test(text)) {
    return {
      windows: [],
      unavailableReason:
        "This account bills per API key, which has no subscription limit to report a percentage of.",
    };
  }
  // The CLI ran the slash command as a prompt and handed back a session.
  //
  // `claude -p "/usage"` is a *prompt* that happens to begin with a slash, not
  // an invocation of the interactive `/usage` view, and on a CLI that does not
  // recognise it as a command the answer is the ordinary end-of-session
  // summary — "Total cost", "Total duration", token counts. No percentage is
  // in it and none ever will be.
  //
  // That is a different fact from the one this used to state. It said the
  // account was probably not on a subscription, which is a claim about
  // somebody's billing made from evidence that says nothing about it — so a
  // person on a perfectly ordinary subscription plan was told their plan was
  // the reason, and had nowhere to go from there.
  if (/Total cost|Total duration|tokens? used/iu.test(text)) {
    return {
      windows: [],
      // Which account was asked, not whether the CLI can answer.
      //
      // `/usage` reports percentages for an account that has a subscription
      // ceiling to be a percentage *of*. Run as an account without one — an
      // API-key login, an agent token, or the container's own sign-in — it
      // has nothing to report and falls back to the session's cost summary.
      //
      // On a deployment that runs agents locally that is the ordinary case
      // and it is a question of *where*, not of what: no credential of the
      // owner's is stored here, so the command runs as whatever this machine
      // is signed in as rather than as them. Asked on the machine that holds
      // their login it answers normally, which is what the desktop reader
      // exists for.
      //
      // Said this way because the first attempt at this sentence claimed the
      // CLI could not publish the figure at all, which is false, and was
      // arrived at by testing one account that happened to have no
      // subscription and generalising from it.
      unavailableReason:
        "That reply came from an account with no subscription window to " +
        "report — it answered with a session summary instead. Usage is read " +
        "on the machine that holds your CLI login; until the Kumi app there " +
        "reports one, there is nothing here to show.",
    };
  }
  return {
    windows: [],
    // Its own words, bounded. A reader can tell a signed-out CLI from an
    // unrecognised one; this side cannot, and guessing is what produced the
    // sentence above.
    unavailableReason:
      "The claude CLI reported no usage percentage. It said: " +
      `${text.trim().split("\n")[0]?.slice(0, 160) ?? "(nothing)"}`,
  };
}

/**
 * Turns what a machine reported into a usage card.
 *
 * The desktop runs the vendor's own usage command and sends back exactly what
 * it printed, so this is the same parsing the control plane already does when
 * it runs those commands itself — the same functions, in the same order —
 * only fed from the machine that actually holds the login. That is what makes
 * a figure possible without a second sign-in: nothing has to be stored here
 * for the number to be about the right account.
 *
 * Exported for tests.
 */
export function parseReportedUsage(
  provider: ProviderId,
  raw: string,
): ProviderUsageReport {
  if (provider === "anthropic") {
    return parseClaudeUsage(raw);
  }
  if (provider === "openai") {
    // The order the machine tried them in, so whichever one answered is the
    // one read. A reading that parses at all is the answer; the reasons below
    // are for a reading that parses as nothing.
    const parsed =
      parseCodexAppServerRateLimits(raw) ??
      parseCodexStatusRateLimits(raw) ??
      parseCodexRateLimits(raw);
    if (parsed !== undefined) {
      return parsed;
    }
    // A reply is the only thing that supports the API-key reading, so that is
    // the only thing it is said about. Said of anything that failed to parse,
    // it blamed a healthy account's billing for a CLI that had answered with
    // a complaint — which is the wrong diagnosis handed out with confidence.
    const replied = /"(?:result|rate_?[lL]imits)"/u.test(raw);
    return {
      source: PROVIDER_NAMES.openai,
      windows: [],
      unavailableReason: replied
        ? "The Codex CLI on this machine answered without any rate limits, " +
          "which is what an account billed by API key returns — that usage " +
          "is reported in the OpenAI dashboard rather than here."
        : raw.trim() === ""
          ? "The Codex CLI on this machine reported nothing when asked for " +
            "its quota."
          : // Its own words, because they name the problem better than any
            // guess made from here can.
            `The Codex CLI on this machine did not report a quota. It said: ${
              raw.trim().split("\n")[0]?.slice(0, 200) ?? ""
            }`,
    };
  }
  if (provider === "cursor") {
    // Cursor publishes no quota at all: its status view reports account
    // facts. Rather than a card that reads as a failure forever, the account
    // it is signed in as is worth saying, because that is the fact somebody
    // is actually checking when they open this.
    const account = parseCursorAccount(raw);
    return {
      source: PROVIDER_NAMES.cursor,
      windows: [],
      unavailableReason:
        account === undefined
          ? "Cursor publishes no usage figure, so there is no quota to show."
          : `Signed in as ${account} on this machine. Cursor publishes no ` +
            "usage figure, so there is no quota to show.",
    };
  }
  return {
    source: PROVIDER_NAMES[provider],
    windows: [],
    unavailableReason: `No usage reading is understood for ${PROVIDER_NAMES[provider]}.`,
  };
}

/**
 * Pulls the signed-in account out of `cursor-agent status`.
 *
 * Deliberately only an email or a `Logged in as` line: the rest of that view
 * is version and path detail that says nothing about whether the login works.
 * Nothing is inferred when neither appears — an unrecognised status view is
 * reported as no account rather than as a guess at one.
 */
export function parseCursorAccount(raw: string): string | undefined {
  const labelled = /^\s*(?:logged in as|signed in as|account|email)\s*[:\-]?\s*(\S+@\S+\.\S+)/imu.exec(
    raw,
  );
  if (labelled?.[1] !== undefined) {
    return labelled[1];
  }
  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/u.exec(raw);
  return email?.[0];
}

/** Real `--effort` values the Claude CLI accepts. */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Names to offer when an account has reported no list of its own.
 *
 * One table, in the service that already owns every other fact about these
 * CLIs, rather than a copy in each screen that renders a picker — the last
 * arrangement had five independent literals and the browser's had drifted two
 * reasoning levels behind the adapter's.
 *
 * These are conveniences, not claims. They are offered only where the real
 * list is missing, they are labelled as suggestions where they are rendered,
 * and the control that shows them accepts anything typed instead, because the
 * value goes to `--model` / `-m` verbatim. A name here going out of date
 * therefore costs a stale entry in a dropdown, not a broken setting: that is
 * the property that makes keeping the list honest cheap, and it is why the
 * list is allowed to exist at all.
 */
/**
 * Readable names for the model values the Claude CLI reports.
 *
 * `claude --help` documents its `--model` values as bare words — `fable`,
 * `opus`, `claude-fable-5` — and they were rendered into the picker exactly
 * as parsed, so the dropdown read "fable / sonnet / opus / claude-fable-5":
 * correct values, unreadable as a list, and giving no clue that the first
 * three float to the newest release while the fourth pins one.
 *
 * The values are the CLI's, not ours — only the labels are added here, and a
 * value with no entry still renders as itself rather than being hidden.
 */
const CLAUDE_MODEL_LABELS: Record<string, string> = {
  fable: "Fable (latest)",
  opus: "Opus (latest)",
  sonnet: "Sonnet (latest)",
  haiku: "Haiku (latest)",
  "claude-fable-5": "Fable 5",
  "claude-mythos-5": "Mythos 5",
  "claude-opus-5": "Opus 5",
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-7": "Opus 4.7",
  "claude-opus-4-6": "Opus 4.6",
  "claude-sonnet-5": "Sonnet 5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5": "Haiku 4.5",
};

const SUGGESTED_MODELS: Record<ProviderId, ProviderModelOption[]> = {
  anthropic: [
    { id: "claude-fable-5", label: "Fable 5" },
    { id: "claude-opus-5", label: "Opus 5" },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5" },
  ],
  // What the Codex CLI documents, newest first. gpt-5.1-codex and
  // gpt-5.2-codex, which this list used to hold, are deprecated. Shown
  // only where the CLI has cached nothing, and never in place of a real list:
  // an account that reports its own models never sees these.
  //
  // These are not the `-codex` suffixed names this list used to hold. That
  // rule came from `gpt-5` 400ing on a ChatGPT-account Codex ("The 'gpt-5'
  // model is not supported when using Codex with a ChatGPT account"), and it
  // is not known here whether these three carry the same split. They are
  // offered as suggestions rather than as a reported list — `optionsNote`
  // says which the reader is looking at — and a wrong one fails at planning
  // with the CLI's own words rather than silently. The cure is the cache: the
  // moment it exists these are gone.
  openai: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    // Still reachable "depending on your account/API configuration", and kept
    // for exactly that reason: the three above carry no -codex suffix, and it
    // was a bare id that a ChatGPT-account Codex refused last time. If that
    // split still holds, an account the newest names fail for has something
    // in the list that works rather than an empty answer — and the last of
    // these is suffixed the old safe way.
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  ],
  google: [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ],
  cursor: [],
  copilot: [],
  kiro: [],
};

/**
 * Reasoning levels to offer when a provider enumerated none.
 *
 * Codex reports its levels per model, so an account with no cached model list
 * has no levels either — and the picker had nothing to show. These are the
 * words its CLI takes today; typing another still works.
 */
const SUGGESTED_EFFORTS: Record<ProviderId, string[]> = {
  anthropic: [...CLAUDE_EFFORTS],
  openai: ["none", "low", "medium", "high", "xhigh", "max"],
  google: [],
  cursor: [],
  copilot: [],
  kiro: [],
};
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";

/**
 * The model to run a throwaway line on, per provider.
 *
 * Some of what this server asks a model for is ceremony, not work: a six-word
 * thread title, for example. Those were running on
 * whatever model the account had chosen — {@link DEFAULT_CLAUDE_MODEL} unless
 * somebody changed it — which is Sonnet rates for a title whose whole
 * specification is "under six words".
 *
 * Only Anthropic has an entry, and deliberately. Haiku is a model this
 * deployment can name with confidence; guessing a cheap counterpart for
 * another vendor and being wrong turns every ceremonial call into an
 * unknown-model error, which costs far more than it saves. An absent entry
 * means "no override" — that provider keeps the account's own model, exactly
 * as before.
 */
const CEREMONIAL_MODELS: Partial<Record<ProviderId, string>> = {
  anthropic: "claude-haiku-4-5",
};

/**
 * The reasoning level a throwaway line runs at, per provider.
 *
 * The cheap model was only half the saving. Effort stayed the account's own —
 * {@link DEFAULT_CLAUDE_EFFORT} unless somebody changed it — so a call whose
 * entire answer is one word out of three was still reasoning at the level
 * somebody picked for writing code, and spent seconds thinking before saying
 * it. That time is paid in front of a person waiting in a chat window: the
 * unaddressed-message verdict is a ceremonial call, and until it comes back
 * the room shows nothing at all.
 *
 * Same rule as the model table: only where the value is one this deployment
 * can name with confidence. `low` is a real `--effort` the Claude CLI takes
 * (see {@link CLAUDE_EFFORTS}); an absent entry means the account's own
 * level, exactly as before, because a rejected effort would turn every
 * ceremonial call into an error rather than a faster answer.
 */
const CEREMONIAL_EFFORTS: Partial<Record<ProviderId, string>> = {
  anthropic: "low",
};
const DEFAULT_CLAUDE_EFFORT = "high";

/**
 * What a chat answer is allowed to do inside its checkout: look, and run
 * commands that only look.
 *
 * Claude Code denies every tool it was not granted when there is nobody to
 * ask, so an answer that needed `git ls-files` refused itself — "I don't have
 * permission to run shell commands" is not an answer to a question about the
 * code, and the person who asked cannot approve anything from a chat window.
 * `Bash` is granted for that reason, and it reaches whichever shell the host
 * runs: bash here, PowerShell on Windows.
 *
 * Granting the tool is not granting the intent. The prompt asks for commands
 * that only read, and the checkout it runs in is a throwaway copy destroyed
 * after the turn, so the worst a command can reach is a directory nobody will
 * look at again.
 */
const CLAUDE_CHAT_ALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
];
/**
 * What a chat answer may never do, whatever the prompt says.
 *
 * "Answer, do not code" is the promise, and a promise a flag can keep should
 * not be left to a sentence in a prompt. Named rather than left to the CLI's
 * default deny, so a future default that grants more cannot grant these.
 */
const CLAUDE_CHAT_DISALLOWED_TOOLS = [
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
];

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 32_000;
const CLI_TIMEOUT_MS = 240_000;
/**
 * A connect request is a person waiting on a form, and the probe is one
 * trivial prompt, so it gets a far shorter deadline than a real completion.
 */
const CREDENTIAL_PROBE_TIMEOUT_MS = 90_000;
/** Claude usage moves slowly; re-probing it on every render would be wasteful. */
const USAGE_CACHE_MS = 120_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// Square brackets appear in real Claude Code model values (e.g. the
// "claude-fable-5[1m]" context variant it caches for its own picker).
const MODEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/u;
/**
 * A reasoning level's shape, for when we have no list to check it against.
 *
 * The vendors keep adding levels — `xhigh`, `max`, `minimal` — and a control
 * plane that has never managed to read a model list cannot know which of them
 * this CLI takes. Refusing every value in that state was the strictly worse
 * answer: the picker offered three and the save rejected all three, so the
 * setting could not be changed at all. A bare word is enough of a guard when
 * the alternative is a feature nobody can use.
 */
const EFFORT_VALUE = /^[a-z][a-z0-9_-]{0,31}$/u;

/**
 * The vendor's own words for why a credential was refused.
 *
 * The CLIs put the useful line ("OAuth access token is invalid", "Not logged
 * in") on either stream and pad it with banners, so the first line that reads
 * like a diagnosis is preferred over the first line outright.
 */
function diagnosisLine(output: ProcessOutput): string | undefined {
  const lines = `${output.stderr}\n${output.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("{"));
  const diagnosis = lines.find((line) =>
    /error|invalid|expired|unauthor|denied|forbidden|not logged in|failed/iu.test(
      line,
    ),
  );
  return diagnosis ?? lines[0];
}

/** The same line, with something to say when the CLI printed nothing at all. */
function probeFailureDetail(output: ProcessOutput): string {
  return (
    diagnosisLine(output) ??
    (output.exitCode === 124
      ? "the CLI did not answer before the deadline"
      : `the CLI exited ${output.exitCode}`)
  ).slice(0, 300);
}

/**
 * The reason a CLI event gives for its own failure, if it gives one.
 *
 * Both CLIs mark the failure on their last event rather than on the process:
 * Claude Code ends a bad turn with `result`/`is_error`, Codex with
 * `turn.failed` or an `error` item. Objects are read for their `message` so a
 * structured vendor error does not come out as `[object Object]`.
 */
function cliEventFailure(event: Record<string, unknown>): string | undefined {
  const error = event["error"];
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }
  const message = event["message"];
  if (typeof message === "string" && message.trim().length > 0) {
    return message.trim();
  }
  if (
    event["is_error"] === true ||
    /error|fail/iu.test(String(event["subtype"] ?? event["type"] ?? ""))
  ) {
    const result = event["result"];
    if (typeof result === "string" && result.trim().length > 0) {
      return result.trim();
    }
  }
  return undefined;
}

/**
 * What to tell somebody when a CLI run exits non-zero.
 *
 * `stream-json` opens every run with an `init` event listing the cwd, the
 * session id and every tool name the CLI knows, so quoting the *head* of
 * stdout quoted that banner every single time: a chat reply that began
 * `{"type":"system","subtype":"init","cwd":"/tmp/coord-provider-chat"…` and
 * never reached the sentence saying what went wrong — which was then clipped
 * again downstream, so the reason was unreachable from the room it failed in.
 * The reason lives on the *last* event the CLI wrote, or on stderr, so those
 * are what get read.
 */
function cliFailureDetail(output: ProcessOutput): string | undefined {
  const lines = output.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(lines[index] as string) as Record<string, unknown>;
    } catch {
      continue;
    }
    const failure = cliEventFailure(event);
    if (failure !== undefined) {
      return failure.slice(0, 400);
    }
  }
  return diagnosisLine(output)?.slice(0, 400);
}

/**
 * A finished answer rescued from a run that still exited non-zero.
 *
 * A CLI can say everything it had to say and then fail on the way out — a
 * session file it could not write, a cleanup step, a broken pipe once the
 * stream was drained. Throwing on the exit code alone discarded a complete
 * reply and replaced it with the exit code, which is the one thing in the run
 * the reader cannot use. The answer wins; a stream with nothing usable in it
 * still becomes the error it was.
 */
function salvagedClaudeReply(
  stdout: string,
  model: string,
): ChatReply | undefined {
  try {
    const reply = parseClaudeStreamJson(stdout, model);
    return reply.text.trim().length > 0 ? reply : undefined;
  } catch {
    return undefined;
  }
}

/** The same rescue for `codex exec --json`. See {@link salvagedClaudeReply}. */
function salvagedCodexReply(
  stdout: string,
  model: string,
): ChatReply | undefined {
  try {
    const reply = parseCodexJsonl(stdout, model);
    return reply.text.trim().length > 0 ? reply : undefined;
  } catch {
    return undefined;
  }
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
  options: {
    env: NodeJS.ProcessEnv;
    cwd?: string;
    stdin?: "ignore" | "pipe";
    /** Run on a pseudo-terminal, for a CLI that refuses piped stdio. */
    pty?: boolean;
  },
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
 * Wraps a command so it runs on a pseudo-terminal instead of plain pipes.
 *
 * Some CLIs refuse the manual, paste-the-code sign-in unless they believe a
 * human is present, and they decide that from `stdin.isTTY`/`stdout.isTTY`.
 * Piped stdio therefore reads as headless no matter what else is set — see
 * {@link browserCliSpec} for the Gemini case this exists to serve.
 *
 * `script` is used rather than a native pty binding because it is part of
 * `bsdutils`, which Debian marks Essential, so it is already in the runtime
 * image and cannot be pruned out from under this.
 */
function ptyLaunch(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  const quoted = [command, ...args]
    .map((part) => `'${part.replaceAll("'", `'\\''`)}'`)
    .join(" ");
  // `stty -echo` is not cosmetic. A terminal echoes what is typed into it, so
  // without it the authorization code pasted by the user comes straight back
  // out on stdout — into the captured transcript, and from there into the
  // failure detail a refused sign-in shows on screen. Verified live: with
  // echo left on, the code appears in the output and the echo continues after
  // the child exits, growing the transcript without bound.
  //
  // -q silences script's own banner, -e returns the child's exit status
  // rather than script's, and the typescript file is discarded because the
  // transcript is already captured from the pipes below.
  return {
    command: "script",
    args: ["-qec", `stty -echo 2>/dev/null; ${quoted}`, "/dev/null"],
  };
}

/**
 * Default {@link LongRunningSpawner}: a plain child process whose stdout is
 * split into lines and whose handle stays available for cancellation.
 */
function spawnLongRunning(
  command: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    cwd?: string;
    stdin?: "ignore" | "pipe";
    pty?: boolean;
  },
  onLine: (line: string) => void,
): LongRunningProcess {
  const startedAt = Date.now();
  const launch = options.pty === true
    ? ptyLaunch(command, args)
    : { command, args: [...args] };
  const child = spawn(launch.command, launch.args, {
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
 * `approve` is Codex, Copilot and Kiro: the CLI shows a code, the user
 * approves it, and the CLI polls until the vendor says yes. Nothing comes
 * back to us.
 *
 * `code_exchange` is Claude, Gemini and Cursor: the CLI shows a URL, the user
 * signs in and may be handed a code, and that code can be given back to the
 * waiting CLI. A Cursor release that completes by polling simply finishes
 * before a code is submitted.
 */
export type DeviceAuthMode = "approve" | "code_exchange";

/** What the browser needs to show a device-authorization prompt. */
export interface DeviceAuthStart {
  flowId: string;
  verificationUrl: string;
  /** Usually absent on `code_exchange`; present if the CLI also prints one. */
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
    result.url = url[0].replace(/[),.;]+$/u, "");
  }
  // Deliberately anchored to the whole line: a bare grouped code on its own
  // line is the code, whereas the same shape inside prose is not.
  const code =
    /^(?:code:\s*)?([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?)$/iu.exec(clean) ??
    /\bcode(?: is)?[ :]+([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?)\b/iu.exec(
      clean,
    ) ??
    /\b(?:enter|use)[ :]+([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?)\b/iu.exec(
      clean,
    );
  // A device code either carries a digit or comes in hyphenated groups, and
  // usually both. An ordinary word that happens to follow "enter"/"code" in a
  // sentence — "Enter this one-time code", "Paste code here" — does neither,
  // and without this check that word is taken as the code.
  if (
    code !== null &&
    code[1] !== undefined &&
    (/\d/u.test(code[1]) || code[1].includes("-"))
  ) {
    result.code = code[1];
  }
  const expiry = /expires? in (\d{1,3}) minutes?/iu.exec(clean);
  if (expiry !== null && expiry[1] !== undefined) {
    result.expiresInMinutes = Number.parseInt(expiry[1], 10);
  }
  return result;
}

function isUserVerificationUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
  } catch {
    return false;
  }
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
/** How often a Gemini sign-in is checked for its finished credential file. */
const GEMINI_CREDENTIAL_POLL_MS = 1_000;
/**
 * How long a URL on an unrecognized host waits for a better one.
 *
 * Long enough that a banner printed just before the real sign-in link does
 * not win, short enough that a vendor changing hosts costs a pause rather
 * than the whole flow.
 */
const UNRECOGNIZED_SIGN_IN_URL_GRACE_MS = 2_000;
/** Fallback when the CLI does not state an expiry in its own output. */
const DEVICE_AUTH_DEFAULT_EXPIRY_MS = 15 * 60_000;

/**
 * Runs a CLI and hands back every stdout line the moment it arrives, while
 * still accumulating the whole output. The accumulated text goes through the
 * same parsers the non-streaming path uses, so live events and the final
 * reply can never disagree about what the CLI said.
 */
export type StreamRunnerOptions = {
  cwd?: string;
  input?: string;
  /**
   * Environment for the child, before harness variables are stripped. Carries
   * the per-user credential home, so dropping it silently falls the CLI back
   * to whatever login the host happens to hold.
   */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type StreamRunner = (
  command: string,
  args: readonly string[],
  options: StreamRunnerOptions,
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

/**
 * The runner every chat uses unless a test supplies its own. Exported so the
 * environment it hands the child can be pinned directly: a stubbed runner can
 * only show that the caller passed an environment, which is exactly the half
 * that was already true while this one dropped it.
 */
export async function streamProcess(
  command: string,
  args: readonly string[],
  options: StreamRunnerOptions,
  onLine: (line: string) => void,
): Promise<ProcessOutput> {
  const startedAt = Date.now();
  return await new Promise<ProcessOutput>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      // Same precedence as `runProcess`: the caller's environment when it
      // supplies one, the harness environment otherwise, sanitised either way.
      env: sanitizeChildEnv(options.env ?? process.env),
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
  /**
   * Where agent names outlive this machine.
   *
   * A call sign is handed out once, at connect, and then people learn it —
   * it is how an agent is addressed in every channel and how an @mention is
   * matched. It was kept only in `secrets/provider-connections.json`, on the
   * control plane's own disk beside the credentials, so a deployment whose
   * filesystem does not survive a restart came back with every name gone:
   * rosters and past messages that had said "Athena" all week fell back to
   * "Claude (Nathan)" while the database still held every channel they were
   * said in.
   *
   * The coordination store is where the rest of that durable state already
   * lives, so the names go there too. The file stays the fast path and is
   * reconciled against this on every read; omit this and the service behaves
   * exactly as it did before, file-only.
   */
  callSigns?: AgentCallSignStore;
  /** Creates the short-lived, read-only checkout used by repository chat. */
  workspaceManager?: Pick<WorkspaceManager, "create" | "destroy">;
}

/** Canonical state a chat answer may inspect without gaining write access. */
export interface RepositoryChatContext {
  repository: CanonicalRepository;
  baseVersion: CanonicalVersion;
  rootPath: string;
}

/**
 * The narrow slice of the coordination store this service needs for names.
 *
 * Declared structurally rather than imported as `CoordinationStore` so the
 * tests can hand over a two-method fake, and so nothing here depends on the
 * whole store surface to store one string.
 */
export interface AgentCallSignStore {
  listAgentCallSigns(): Promise<
    ReadonlyArray<{ userId: string; provider: string; callSign: string }>
  >;
  setAgentCallSign(
    userId: string,
    provider: string,
    callSign: string,
  ): Promise<unknown>;
  clearAgentCallSign(userId: string, provider: string): Promise<void>;
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

interface BrowserCliSpec {
  command: string;
  prefixArgs: string[];
  loginArgs: string[];
  label: string;
  /** Sign-in needs a pseudo-terminal; see {@link ptyLaunch}. */
  ptyLogin?: boolean;
  /**
   * Hosts whose pages are this vendor's own sign-in.
   *
   * A CLI prints more than one URL — docs, a status page, a repository — and
   * the first one out is not reliably the one to send somebody to. Cursor in
   * particular was sending people to github.com, which is Copilot's sign-in
   * and not Cursor's at all. An empty list means "take the first URL", which
   * is what the CLIs with a known single banner do.
   */
  signInHosts?: string[];
  /**
   * Other names the same CLI is installed under, tried in order when the
   * first one is not on the machine.
   *
   * Cursor's installer publishes `cursor-agent` — it is the name in its own
   * issue tracker and in the help text this file's tests quote back — while
   * this asked for `agent` and nothing else. Where only one of the two
   * exists, everything Cursor did here failed at once and silently: no
   * status, no usage, no model list, no sign-in. Codex has had a resolver
   * with candidates for exactly this reason; this is the same idea for a
   * name that cannot be found on disk because it is resolved through PATH.
   */
  commandAliases?: string[];
}

/**
 * Whether a run failed because the command is not installed, rather than
 * because the command ran and disliked something.
 *
 * Both shapes matter. A spawn that cannot find its target throws, and a shell
 * that cannot find it answers 127 with its own words — "not recognized" on
 * Windows, "not found" elsewhere. Treating only the throw as "missing" would
 * leave the second case looking like a real answer from a CLI that never ran.
 */
function missingCommand(outcome: {
  exitCode?: number;
  stderr?: string;
  error?: unknown;
}): boolean {
  const words = `${outcome.stderr ?? ""} ${
    outcome.error instanceof Error ? outcome.error.message : String(outcome.error ?? "")
  }`;
  if (/ENOENT|not recognized|not found|No such file/iu.test(words)) {
    return true;
  }
  return outcome.exitCode === 127;
}

/** Commands used by the browser-only agent connections. */
function browserCliSpec(provider: ProviderId): BrowserCliSpec | undefined {
  if (provider === "cursor") {
    return {
      command: "agent",
      // Tried after `agent`, so a machine that has the short name keeps
      // behaving exactly as it did and one that has only the published name
      // starts working instead of failing at every call.
      commandAliases: ["cursor-agent"],
      prefixArgs: [],
      loginArgs: ["login"],
      label: "Cursor",
      signInHosts: ["cursor.com", "cursor.sh"],
    };
  }
  if (provider === "copilot") {
    return {
      command: "copilot",
      prefixArgs: [],
      // The web flow redirects to a loopback listener on the server. From a
      // user's browser that is their own localhost, so it ends on a blank
      // page and can never reach the CLI. Device auth is made explicit rather
      // than relying on the CLI's changing idea of a headless environment.
      loginArgs: ["login", "--device-code"],
      label: "GitHub Copilot",
      signInHosts: ["github.com"],
    };
  }
  if (provider === "kiro") {
    return {
      command: "kiro-cli",
      prefixArgs: [],
      // As with Copilot, a local callback belongs to the server, not the
      // browser that pressed Connect. Kiro exposes its headless flow directly.
      loginArgs: ["login", "--use-device-flow"],
      label: "Kiro",
      signInHosts: ["kiro.dev", "amazon.com", "awsapps.com", "amazonaws.com"],
    };
  }
  if (provider === "google") {
    const gemini = resolveGeminiCommand();
    return {
      ...gemini,
      // Screen-reader mode keeps the OAuth URL in ordinary stdout rather than
      // an alternate terminal screen, which is what lets the web flow relay
      // it.
      //
      // Deliberately no `-p`. A prompt argument puts the CLI in headless
      // mode, and headless is exactly the mode that cannot finish this
      // sign-in: with NO_BROWSER set the CLI refuses outright ("Manual
      // authorization is required but the current session is
      // non-interactive"), and without it the CLI runs its *other* OAuth
      // path, which redirects to http://127.0.0.1:<port>/oauth2callback and
      // waits on a local HTTP listener. That listener is on this server,
      // while the browser completing the sign-in is on the user's own
      // machine, so the callback never arrives and the code the user is
      // holding has nothing to go to.
      //
      // Interactive plus NO_BROWSER selects the manual path instead: the CLI
      // prints a URL that redirects to codeassist.google.com/authcode, a real
      // page that shows the user a code, and reads that code back on stdin.
      //
      // Two independent things make it interactive, and both are kept. `--acp`
      // registers as a subcommand, which the CLI exempts from headless mode;
      // the pseudo-terminal below makes the isTTY check the CLI actually
      // starts from come out true in the first place. Either alone would do
      // it, and neither costs anything when the other already has.
      // Authentication happens before the protocol starts, so the URL and the
      // prompt are still ordinary lines on stdout.
      loginArgs: ["--screen-reader", "--acp"],
      label: "Gemini",
      ptyLogin: true,
      signInHosts: ["accounts.google.com", "google.com"],
    };
  }
  return undefined;
}

/**
 * Turns Google's tier refusal into something a person can act on.
 *
 * Google retired the Gemini CLI's browser sign-in for personal accounts, and
 * says so in a message that reads like a fault in this deployment: "This
 * client is no longer supported for Gemini Code Assist for individuals."
 * Nothing here can fix it, and there is no point in the user trying the
 * sign-in again — but an API key still works, and that is a route the connect
 * screen offers.
 */
function ineligibleTierHint(detail: string): string {
  return /ineligibletiererror|no longer supported for gemini code assist/iu.test(
    detail,
  )
    ? " — Google has retired browser sign-in for personal accounts, so this " +
      "cannot be fixed by signing in again. Connect an API key from Google " +
      "AI Studio instead, or use a paid Gemini Code Assist plan."
    : "";
}

/** How long a reported model list is reused before asking the CLI again. */
const MODEL_LIST_TTL_MS = 10 * 60_000;

/**
 * Reads `agent --list-models` output into model options.
 *
 * The shape it prints, colour codes stripped:
 *
 *     Available models
 *
 *     gpt-5 - GPT-5 (default)
 *     sonnet-4-thinking - Claude Sonnet 4 Thinking
 *
 *     Tip: use --model <id> ...
 *
 * Anything before the header and the closing tip are not models, and the
 * `(current, default)` marker is a note about the account rather than part of
 * the name.
 */
export function parseCursorModelList(stdout: string): ProviderModelOption[] {
  const models: ProviderModelOption[] = [];
  let started = false;
  for (const raw of stripAnsi(stdout).split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    if (!started) {
      started = /^available models\b/iu.test(line);
      continue;
    }
    if (/^tip:/iu.test(line)) {
      break;
    }
    // `id - Display Name (current, default)`, where both the name and the
    // marker are optional.
    const match = /^(\S+?)(?:\s+-\s+(.*?))?\s*(?:\((?:current|default)(?:,\s*(?:current|default))*\))?$/u.exec(
      line,
    );
    const id = match?.[1];
    if (id === undefined || !/^[A-Za-z0-9][\w.:\/-]*$/u.test(id)) {
      continue;
    }
    const label = match?.[2]?.trim();
    models.push({
      id,
      label: label === undefined || label.length === 0 ? id : label,
    });
  }
  return models;
}

/** Whether a URL is on one of the hosts this vendor signs in through. */
function isSignInUrl(value: string, hosts: string[] | undefined): boolean {
  if (hosts === undefined || hosts.length === 0) {
    return true;
  }
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

/** The Codex CLI may live off PATH; the actively-used install is a fallback. */
/**
 * Whether a CLI's own words say the account is signed in.
 *
 * Written down once because the obvious test is wrong: "logged in" is a
 * substring of "Not logged in", so asking whether the words appear reads a
 * refusal as a confirmation. Two readers here made that mistake — the usage
 * card's diagnosis and the connection detector — and one of them would have
 * reported a signed-out account as signed in.
 */
export function saysSignedIn(output: string): boolean {
  if (saysSignedOut(output)) {
    return false;
  }
  return /\b(?:logged in|signed in)\b/iu.test(output);
}

/**
 * The CLI saying, in so many words, that nobody is signed in.
 *
 * The half of the question that can be answered from text alone. Its opposite
 * cannot: a CLI that *is* signed in may say "Logged in using ChatGPT", or
 * "Authenticated", or print an account line and no verb at all, and demanding
 * one of two English phrases before believing it told a signed-in user they
 * were signed out — with the connect flow's only remedy being to sign in
 * again, which they had already done.
 *
 * So this is used as a veto over the exit code rather than as the whole test.
 * A refusal is stated; a success is merely exit zero.
 */
export function saysSignedOut(output: string): boolean {
  return /\b(?:not logged in|not signed in|no active session|please (?:log|sign) in)\b/iu.test(
    output,
  );
}

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
  /** Which name each browser CLI was actually found under. */
  private readonly browserCommands = new Map<string, string>();
  private readonly detectionCache = new Map<
    ProviderId,
    { at: number; state: ProviderCliState }
  >();
  /**
   * Keyed by caller *and* provider. Usage is now read under whoever asked,
   * so a key of provider alone would hand one person's consumption figures
   * to the next person who hovered.
   */
  /**
   * The last usage figure each machine reported for itself.
   *
   * Kept because the machine is not always on, and an agent asleep is exactly
   * when somebody looks at the card wondering where their quota went. A stale
   * number with a time on it is far more use than an empty card, so this is
   * never expired — it is replaced when a fresher reading arrives and
   * otherwise stands, labelled with when it was taken.
   *
   * In memory, so a deployment restart forgets it and the next reading fills
   * it in again. Worth saying plainly rather than implying durability this
   * does not have.
   */
  private readonly reportedUsage = new Map<
    string,
    { at: string; report: ProviderUsageReport }
  >();

  private readonly usageCache = new Map<
    string,
    { at: number; report: ProviderUsageReport }
  >();
  private readonly streamRunner: StreamRunner;
  private readonly longRunningSpawner: LongRunningSpawner;
  private readonly deviceAuthFlows = new Map<string, DeviceAuthFlow>();
  /** Cursor's reported model list; see {@link cursorModels}. */
  private cursorModelCache: { at: number; models: ProviderModelOption[] } | undefined;
  private credentialStorePromise: Promise<UserCredentialStore> | undefined;
  /** Durable home for call signs; absent means file-only, as before. */
  private readonly callSignStore: AgentCallSignStore | undefined;
  private readonly workspaceManager: Pick<WorkspaceManager, "create" | "destroy">;

  public constructor(
    private readonly project: CoordinatorProject,
    options: ProviderChatServiceOptions = {},
  ) {
    this.callSignStore = options.callSigns;
    this.workspaceManager =
      options.workspaceManager ?? new GitWorktreeWorkspaceManager();
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

  /**
   * Gives a newly connected account a name, if it has not got one.
   *
   * At connect rather than at channel-add, because a call sign belongs to the
   * account and not to a room — somebody who has met Icarus in one channel
   * should meet the same Icarus in the next, and a name handed out per room
   * cannot promise that.
   *
   * Only ever fills a gap. A user who has chosen their own name keeps it, and
   * re-connecting the same provider does not rename an agent people have
   * learned. That also makes this safe to run alongside anything else that
   * assigns names: whoever gets there first wins, and nobody is renamed.
   *
   * Signs already in use anywhere on the deployment are skipped so two agents
   * in one room are not both Hermes. When the pool is exhausted the vendor
   * label stands, which is the behaviour every account had before this.
   *
   * The free signs are drawn from uniformly rather than taken in list order.
   * Walking the list meant every fresh deployment produced Zeus, then Hera,
   * then Poseidon, in that order forever: the name said which account
   * connected first and nothing else, and two deployments side by side were
   * the same three agents. A random draw makes the pantheon feel dealt out.
   *
   * Signs already taken — in the file, or in the durable store, which knows
   * about names this machine's file has forgotten — are skipped. Returns the
   * sign it dealt, so the caller can record it where restarts cannot reach.
   */
  private assignCallSign(
    file: ConnectionFile,
    userId: string,
    provider: ProviderId,
    alsoTaken: ReadonlySet<string> = new Set(),
  ): string | undefined {
    const connection = file[userId]?.[provider];
    if (connection === undefined || connection.settings?.callSign !== undefined) {
      return undefined;
    }
    const taken = new Set<string>(alsoTaken);
    for (const byProvider of Object.values(file)) {
      for (const entry of Object.values(byProvider ?? {})) {
        const sign = entry?.settings?.callSign;
        if (sign !== undefined) {
          taken.add(sign.trim().toLowerCase());
        }
      }
    }
    // Derived from the agent's own identity rather than drawn, so the same
    // account gets the same name on a deployment that has forgotten every
    // name it ever handed out. See `deriveCallSign`.
    const sign = deriveCallSign(userId, provider, taken);
    if (sign === undefined) {
      return undefined;
    }
    connection.settings = { ...connection.settings, callSign: sign };
    return sign;
  }

  /**
   * This user's connections, with any that predate call signs given one and
   * any this machine has forgotten restored from the store.
   *
   * Naming happens at connect, and every route that reports a connection
   * reads through here, so an account connected before `assignCallSign`
   * existed is named the first time anything asks about it rather than
   * staying "Claude (Nathan)" for good. Nothing else would ever name it now:
   * the browser used to hand out a name as an agent joined a channel, and
   * that is exactly the per-channel naming this replaced.
   *
   * Written back only when something actually changed, so the ordinary case —
   * everything already named and already agreed with the store — touches no
   * disk. `assignCallSign` never renames, so a second caller racing this one
   * cannot change an answer somebody has already been shown.
   */
  private async namedConnections(
    userId: string,
  ): Promise<Partial<Record<ProviderId, StoredConnection>>> {
    const file = await this.readConnections();
    if (await this.nameUnnamedConnections(file, [userId])) {
      await this.writeConnections(file);
    }
    return file[userId] ?? {};
  }

  /**
   * Reconciles these users' names with the durable store and names whatever
   * is still unnamed, in place. True when the file changed, which is the
   * caller's cue to write it back.
   *
   * Three cases, in this order:
   *
   *  - the store knows a name this file does not — the file lost it (a
   *    restart on a filesystem that did not outlive the container, a moved
   *    project root), so it is restored rather than a *new* name being dealt
   *    out. This is the whole point: an agent people have been calling
   *    Athena comes back as Athena, not as "Claude (Nathan)" and not as
   *    Vesta.
   *  - the file knows a name the store does not, or a different one — the
   *    file is what the routes edit, so it wins and is written through.
   *  - neither knows one — a sign is dealt, avoiding everything taken on
   *    either side, and recorded in both.
   *
   * Store failures are swallowed on purpose: naming must not be able to make
   * connecting an account fail, and a name in the file alone is exactly the
   * behaviour this deployment had before the store existed.
   */
  private async nameUnnamedConnections(
    file: ConnectionFile,
    userIds: readonly string[],
  ): Promise<boolean> {
    const stored = await this.storedCallSigns();
    const byAgent = new Map<string, string>(
      stored.map((entry) => [
        `${entry.userId}\0${entry.provider}`,
        entry.callSign,
      ]),
    );
    const taken = new Set(
      stored.map((entry) => entry.callSign.trim().toLowerCase()),
    );
    let changed = false;
    for (const userId of userIds) {
      for (const id of PROVIDER_IDS) {
        const connection = file[userId]?.[id];
        if (connection === undefined) {
          continue;
        }
        const current = connection.settings?.callSign;
        const durable = byAgent.get(`${userId}\0${id}`);
        if (current === undefined && durable !== undefined) {
          connection.settings = { ...connection.settings, callSign: durable };
          changed = true;
          continue;
        }
        if (current !== undefined) {
          if (durable !== current) {
            await this.rememberCallSign(userId, id, current);
          }
          continue;
        }
        const assigned = this.assignCallSign(file, userId, id, taken);
        if (assigned === undefined) {
          continue;
        }
        taken.add(assigned.toLowerCase());
        changed = true;
        await this.rememberCallSign(userId, id, assigned);
      }
    }
    return changed;
  }

  /** Every name this deployment has handed out, or none if it cannot ask. */
  private async storedCallSigns(): Promise<
    ReadonlyArray<{ userId: string; provider: string; callSign: string }>
  > {
    if (this.callSignStore === undefined) {
      return [];
    }
    return await this.callSignStore.listAgentCallSigns().catch(() => []);
  }

  /** One account's remembered names, by provider. Empty when nothing is. */
  private async callSignsFor(
    userId: string,
  ): Promise<Map<ProviderId, string>> {
    const remembered = new Map<ProviderId, string>();
    for (const entry of await this.storedCallSigns()) {
      if (entry.userId === userId) {
        remembered.set(entry.provider as ProviderId, entry.callSign);
      }
    }
    return remembered;
  }

  /** Writes one name through to the store, best effort. */
  private async rememberCallSign(
    userId: string,
    provider: ProviderId,
    callSign: string,
  ): Promise<void> {
    await this.callSignStore
      ?.setAgentCallSign(userId, provider, callSign)
      .catch(() => undefined);
  }

  /** Forgets one name in the store, best effort. */
  private async forgetCallSign(
    userId: string,
    provider: ProviderId,
  ): Promise<void> {
    await this.callSignStore
      ?.clearAgentCallSign(userId, provider)
      .catch(() => undefined);
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
      } else if (provider === "google") {
        state = await this.detectGemini();
      } else {
        state = await this.detectBrowserCli(provider);
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
  /**
   * Takes a usage reading from the machine an agent actually runs on.
   *
   * The figure used to be read on the control plane, which needed a vendor
   * credential stored there — and that credential was the entire reason
   * connecting an agent asked for a second sign-in. Nothing else wanted it:
   * the agent runs on somebody's own machine under the login its CLI already
   * holds, so that is where the question has an answer.
   *
   * The raw text is parsed here rather than on the machine, because the
   * parsers already live here and vendors change their output without
   * warning; one copy is enough to keep in step. A reading that parses to
   * nothing is still kept, because "the CLI said it has nothing to report" is
   * a different card from "nobody has looked".
   */
  public async reportUsage(input: {
    userId: string;
    provider: ProviderId;
    raw: string;
  }): Promise<ProviderUsageReport> {
    const report = parseReportedUsage(input.provider, input.raw);
    this.reportedUsage.set(`${input.userId}:${input.provider}`, {
      at: new Date().toISOString(),
      report,
    });
    return report;
  }

  public async usage(input: {
    provider: ProviderId;
    /**
     * Whose usage. Without this the question was asked of whatever CLI login
     * the container itself happens to have — which, on a deployment where
     * everyone signs in as themselves, is nobody. `/usage` then had no
     * account to report on and said so, and the answer read as a fault in
     * the CLI rather than the question being addressed to the wrong account.
     */
    userId?: string;
    /**
     * Whose account to ask about, when that is not the caller.
     *
     * Any agent in the room is one somebody may @mention into real work, and
     * how much of its quota is left decides whether doing so accomplishes
     * anything — so that figure is readable by everyone here, whether the
     * connection behind it is org-wide or personal. The connection's
     * `visibility` still decides whose credential a prompt spends; it no
     * longer decides who may see how much of it is gone.
     */
    ownerId?: string;
  }): Promise<ProviderUsageReport> {
    const owner = input.ownerId ?? input.userId;
    if (owner !== undefined && owner !== input.userId) {
      // Read as the owner, then handed back with the one figure that is not
      // an operational fact removed: a credit balance is money on somebody
      // else's account, and knowing whether an agent can still do work does
      // not require knowing what is left in their wallet.
      const { creditBalance: withheld, ...report } = await this.usage({
        provider: input.provider,
        userId: owner,
      });
      void withheld;
      return report;
    }
    // What the machine itself last said, which beats anything this process can
    // work out. Asking here means running the vendor CLI on the control plane,
    // and without a credential of the caller's that lands on the container's
    // own login — the operator's account, reporting the operator's quota, as
    // an answer to a question about somebody else's. A reading from the
    // machine that holds the login is both cheaper and the only one that is
    // actually about the right account.
    //
    // Consulted before the per-vendor answers below, and for every vendor
    // rather than the two this process can run: a machine that reported
    // something has answered, and the reasons below exist for the case where
    // nobody has.
    const reported =
      input.userId === undefined
        ? undefined
        : this.reportedUsage.get(`${input.userId}:${input.provider}`);
    if (reported !== undefined) {
      return { ...reported.report, asOf: reported.at };
    }
    if (input.provider === "cursor") {
      // Cursor's CLI publishes no subscription figure: asking it produced a
      // card of account facts rather than a quota, so the honest answer is
      // that there is nothing to report, without running anything to find out.
      return {
        source: PROVIDER_NAMES.cursor,
        windows: [],
        unavailableReason: "Cursor usage not reported.",
      };
    }
    if (input.provider !== "anthropic" && input.provider !== "openai") {
      return {
        source: PROVIDER_NAMES[input.provider],
        windows: [],
        unavailableReason:
          "No usage figures are available for this provider.",
      };
    }
    // Caller and provider both, so one person's figures are never handed to
    // the next person who asks. "host" stands for a caller with no credential
    // of their own, which is the shared login the container itself carries.
    const usageKey = `${input.userId ?? "host"}:${input.provider}`;
    if (input.provider === "openai") {
      // The browser deliberately asks again whenever the agent specification
      // opens. Honour that request all the way through to Codex: caching here
      // made a fresh HTTP request return the previous app-server answer for
      // two minutes, so reopening the page did not actually run the quota
      // command the page exists to surface.
      return await this.codexUsage(input.userId);
    }
    const cached = this.usageCache.get(usageKey);
    if (cached !== undefined && Date.now() - cached.at < USAGE_CACHE_MS) {
      return cached.report;
    }
    let report: ProviderUsageReport;
    try {
      const credential =
        input.userId === undefined
          ? undefined
          : await this.ownCredential(input.userId, input.provider);
      // The same seam completions run through, so the figure reported is for
      // the account the prompts are actually billed to. Without a credential
      // of one's own this falls through to the ambient environment, which is
      // the host's shared login — the account being spent in that case too.
      const result = await this.withCompletionEnv(
        input.userId,
        input.provider,
        credential,
        async (env) =>
          await this.runner(
            resolveClaudeCommand("claude"),
            ["-p", "/usage", "--output-format", "json"],
            {
              timeoutMs: 60_000,
              maxOutputBytes: 262_144,
              ...(env === undefined ? {} : { env }),
            },
          ),
      );
      // Parsed whatever the exit code, for the same reason detection stopped
      // reading it: `claude` exits non-zero merely for being signed out while
      // still printing the status it was asked for. Throwing that away turned
      // a readable answer into "could not report usage", and `parseClaudeUsage`
      // already says plainly when there is no percentage in the output.
      report = parseClaudeUsage(result.stdout);
    } catch (error) {
      report = {
        windows: [],
        unavailableReason:
          error instanceof Error ? error.message : String(error),
      };
    }
    this.usageCache.set(usageKey, { at: Date.now(), report });
    return report;
  }

  /**
   * What the Codex account has consumed, asked of the account itself.
   *
   * The reading used to be second-hand: the CLI does not print rate limits on
   * stdout, but it records them in the rollout it writes per session, so the
   * newest rollout was parsed. On a deployment where every run gets its own
   * temporary credential home that record does not survive the run — the home
   * is removed at close — so the commonest answer this could give was "no
   * Codex session has recorded rate limits on this machine yet", which is a
   * fact about where we looked rather than about the account.
   *
   * So the account is asked directly through `codex --status --json`,
   * *inside* the credential home rather than after it: that is the only
   * moment the caller's own `CODEX_HOME` exists, and asking outside it would
   * ask on behalf of whatever login the host happens to carry. The app-server
   * and session readers remain, in order, for a CLI too old to answer and for
   * a host-login deployment.
   */
  private async codexUsage(userId?: string): Promise<ProviderUsageReport> {
    const source = "Codex CLI session records (~/.codex/sessions)";
    try {
      const credential =
        userId === undefined
          ? undefined
          : await this.ownCredential(userId, "openai").catch(() => undefined);
      // Captured rather than swallowed. Opening the caller's credential home
      // can fail outright — most often as "not connected" — and that error is
      // the whole answer to why the card is empty. It used to be discarded by
      // the catch below, and the card then blamed the account's quota for a
      // connection that was never there.
      const trace: string[] = [];
      let obstacle: string | undefined =
        userId !== undefined && credential === undefined
          ? "No Codex connection is stored for this account, so the quota " +
            "was asked of whatever login this machine carries rather than " +
            "of you. Connect Codex above to read your own."
          : undefined;
      const inHome = await this.withCompletionEnv(
        userId,
        "openai",
        credential,
        async (env) => {
          const live = await this.codexAccountRateLimits(env, trace);
          if (live !== undefined) {
            return { report: live };
          }
          // Sessions write their rollouts under whatever CODEX_HOME the run
          // was given, so the search follows the same home the runs use; the
          // ambient one stays as the fallback for a host-login deployment.
          const codexHome =
            typeof env?.["CODEX_HOME"] === "string" && env["CODEX_HOME"] !== ""
              ? env["CODEX_HOME"]
              : undefined;
          const newest = await this.newestCodexRollout(
            codexHome === undefined
              ? undefined
              : path.join(codexHome, "sessions"),
          );
          const parsed =
            newest === undefined
              ? undefined
              : parseCodexRateLimits(await readFile(newest, "utf8"));
          trace.push(
            newest === undefined
              ? "no session records under this home"
              : parsed === undefined
                ? "the newest session record carried no rate limits"
                : "read from a session record",
          );
          if (parsed !== undefined) {
            return { report: { ...parsed, source } };
          }
          // Nothing to show, so find out why while the caller's home still
          // exists. Asked here and nowhere else: outside this callback the
          // home is gone, and the question would be about the host's login.
          return { obstacle: await this.codexQuotaObstacle(env) };
        },
      ).catch((error: unknown) => {
        obstacle =
          error instanceof ProviderChatError && error.code === "not_connected"
            ? "This account is not connected to Codex here, so there is no " +
              "account to ask for a quota. Connect it from the row above."
            : `The Codex quota could not be read: ${
                error instanceof Error ? error.message : String(error)
              }`;
        return undefined;
      });
      if (inHome?.report !== undefined) {
        return inHome.report;
      }
      // The durable copy: credential homes are temporary, and the close hook
      // carries the newest rollout's tail out of one before it is removed.
      if (userId !== undefined) {
        const store = await this.credentialStore();
        const snapshot = await store.readUsageSnapshot(userId, "codex");
        const persisted =
          snapshot === undefined ? undefined : parseCodexRateLimits(snapshot);
        trace.push(
          snapshot === undefined
            ? "no snapshot kept from an earlier run"
            : persisted === undefined
              ? "the kept snapshot carried no rate limits"
              : "read from the kept snapshot",
        );
        if (persisted !== undefined) {
          return { ...persisted, source };
        }
      }
      return {
        source,
        windows: [],
        unavailableReason:
          inHome?.obstacle ??
          obstacle ??
          // Said as a fact where the connection settles it. The stored
          // credential's kind is known here, so "which is what an API-key
          // account returns" does not have to stay a hypothesis offered to
          // somebody who cannot check it: an API key has no subscription
          // quota to report, and that is the end of the question rather than
          // a symptom of something still to fix.
          (credential?.kind === "api_key"
            ? "This Codex connection signs in with an API key, which carries " +
              "no subscription quota — that usage is billed per token and " +
              "reported in the OpenAI dashboard rather than here."
            : "Codex reported no quota for this account, and no Codex " +
              "session has recorded rate limits on this machine yet. An " +
              "account billed by API key reports no subscription quota at " +
              "all.") +
            // What each source actually said, so the next reading of this
            // card is a diagnosis rather than another guess.
            (trace.length === 0 ? "" : ` Tried: ${trace.join("; ")}.`),
      };
    } catch (error) {
      return {
        source,
        windows: [],
        unavailableReason:
          error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Runs a browser CLI, trying the names it may be installed under.
   *
   * The winner is remembered, so the second name costs one extra spawn per
   * process rather than one per call. A failure that is not "no such command"
   * is returned as it stands: a CLI that ran and refused has answered, and
   * retrying it under another name would turn one real refusal into two.
   */
  private async runBrowserCli(
    spec: BrowserCliSpec,
    args: readonly string[],
    options: Parameters<ProcessRunner>[2],
  ): Promise<Awaited<ReturnType<ProcessRunner>>> {
    const remembered = this.browserCommands.get(spec.command);
    const candidates =
      remembered === undefined
        ? [spec.command, ...(spec.commandAliases ?? [])]
        : [remembered];
    let last: Awaited<ReturnType<ProcessRunner>> | undefined;
    let thrown: unknown;
    for (const command of candidates) {
      try {
        const result = await this.runner(command, args, options);
        if (!missingCommand({ exitCode: result.exitCode, stderr: result.stderr })) {
          this.browserCommands.set(spec.command, command);
          return result;
        }
        last = result;
      } catch (error) {
        if (!missingCommand({ error })) {
          throw error;
        }
        thrown = error;
      }
    }
    if (last !== undefined) {
      return last;
    }
    throw thrown ?? new Error(`${spec.command} is not installed here`);
  }

  /** Native status first, with the app-server retained for older CLIs. */
  /**
   * Why a quota read came back with nothing — asked of the caller's own home.
   *
   * Every reader above answers `undefined` for four different situations: the
   * CLI is not installed where Kumi runs, it is installed but signed out, it
   * is too old to have the method, or the account genuinely has no
   * subscription quota. The card said the last of those in all four cases,
   * which is untrue in three and unactionable in all: "Codex reported no
   * quota" describes a Codex that was never successfully asked.
   *
   * So when there is nothing to show, the obstacle is looked for and named.
   * Undefined means the CLI ran and is signed in, and the plain answer — this
   * account has no quota to report — is the true one after all.
   */
  private async codexQuotaObstacle(
    env: NodeJS.ProcessEnv | undefined,
  ): Promise<string | undefined> {
    const command = resolveCodexCommand(this.homeDirectory);
    const ask = async (args: readonly string[]): Promise<ProcessOutput> =>
      await this.runner(command, args, {
        timeoutMs: CODEX_QUOTA_TIMEOUT_MS,
        maxOutputBytes: 65_536,
        ...(env === undefined ? {} : { env }),
      });
    try {
      const version = await ask(["--version"]);
      if (version.exitCode !== 0) {
        return (
          "The Codex CLI on this machine could not be asked for its version, " +
          "so it cannot be asked for a quota either."
        );
      }
    } catch (error) {
      return (
        "The Codex CLI could not be run where Kumi is installed: " +
        `${error instanceof Error ? error.message : String(error)}. ` +
        "Usage comes from that CLI, so it stays empty until it is there."
      );
    }
    try {
      const login = await ask(["login", "status"]);
      // The same rule as `detectCodex`, so the quota card and the connection
      // row cannot disagree about whether this account is signed in.
      if (
        login.exitCode !== 0 ||
        saysSignedOut(`${login.stdout}\n${login.stderr}`)
      ) {
        return (
          "The Codex CLI is installed but this account is not signed in to " +
          "it, so it has no quota to report. Signing in again from the " +
          "connection above is what fills this."
        );
      }
    } catch {
      // Signed-in state could not be established either way. Say nothing
      // rather than accuse a working login of being absent.
    }
    return undefined;
  }

  private async codexAccountRateLimits(
    env: NodeJS.ProcessEnv | undefined,
    /**
     * What each source actually answered, appended as it goes.
     *
     * Three rounds of this card were spent guessing which step was failing,
     * because every one of them reports the same nothing. A reader that says
     * "the app-server replied with no rate limits" is a different problem
     * from one that says "the app-server could not be started", and the card
     * could not tell them apart — nor could anybody reading it.
     */
    trace?: string[],
  ): Promise<ProviderUsageReport | undefined> {
    // `account/rateLimits/read` is the interface OpenAI documents for reading
    // this, and it answers in the shape it promises. `--status` is a display
    // that happens to emit JSON today. Asking the display first would let a
    // rename inside it outrank the contract, and the wrong answer is the one
    // that parses — so it is the fallback, for a CLI whose app-server does
    // not answer.
    const live = await this.codexAppServerRateLimits(env, trace);
    if (live !== undefined) {
      return live;
    }
    try {
      const result = await this.runner(
        resolveCodexCommand(this.homeDirectory),
        ["--status", "--json"],
        {
          timeoutMs: CODEX_QUOTA_TIMEOUT_MS,
          maxOutputBytes: 262_144,
          ...(env === undefined ? {} : { env }),
        },
      );
      const parsed =
        result.exitCode === 0
          ? parseCodexStatusRateLimits(result.stdout)
          : undefined;
      trace?.push(
        result.exitCode !== 0
          ? `codex --status --json exited ${String(result.exitCode)}`
          : parsed === undefined
            ? "codex --status --json carried no rate limits"
            : "codex --status --json answered",
      );
      return parsed;
    } catch (error) {
      trace?.push(
        `codex --status --json could not run (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      return undefined;
    }
  }

  /**
   * One `account/rateLimits/read` against the app-server, batched.
   *
   * The whole conversation — initialize, initialized, the read — is written
   * to stdin at once and the answers are picked out of stdout, because that
   * keeps this on the same one-shot process seam every other CLI call here
   * uses (and therefore the same seam the tests stub). Every failure is
   * `undefined`: a quota figure is supplementary, and a CLI too old to have
   * the method, or missing entirely, must not turn the usage card into an
   * error.
   */
  private async codexAppServerRateLimits(
    env: NodeJS.ProcessEnv | undefined,
    trace?: string[],
  ): Promise<ProviderUsageReport | undefined> {
    const conversation = [
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          clientInfo: {
            name: "coord-web",
            title: "Kumi",
            version: "0.0.0",
          },
        },
      },
      { jsonrpc: "2.0", method: "initialized", params: {} },
      { jsonrpc: "2.0", id: 1, method: "account/rateLimits/read", params: {} },
    ]
      .map((message) => `${JSON.stringify(message)}\n`)
      .join("");
    try {
      const result = await this.runner(
        resolveCodexCommand(this.homeDirectory),
        ["app-server", "--stdio"],
        {
          input: conversation,
          timeoutMs: CODEX_QUOTA_TIMEOUT_MS,
          maxOutputBytes: 262_144,
          ...(env === undefined ? {} : { env }),
        },
      );
      // Parsed whatever the exit code: the app-server is killed at the
      // deadline and exits non-zero on EOF, both after it has already
      // answered.
      const parsed = parseCodexAppServerRateLimits(result.stdout);
      // Silence from the app-server is the one outcome that says nothing at
      // all about the account, so it carries the exit code and whatever the
      // process complained about. "Unknown subcommand" is a CLI too old to
      // have the interface; 124 is the deadline; anything else is the
      // server's own words about why it would not answer.
      // Long enough to carry a path. The first cut at this was 160
      // characters and sliced a `codex_home:` value in half, which read as
      // the home being the filesystem root and sent the diagnosis a whole
      // round in the wrong direction.
      const complaint = result.stderr.trim().split("\n")[0]?.slice(0, 400);
      trace?.push(
        parsed !== undefined
          ? "account/rateLimits/read answered"
          : result.stdout.trim() === ""
            ? `codex app-server said nothing (exit ${String(result.exitCode)}${
                complaint === undefined || complaint === ""
                  ? ""
                  : `: ${complaint}`
              })`
            : "account/rateLimits/read replied without rate limits, which is " +
              "what an API-key account returns",
      );
      return parsed;
    } catch (error) {
      trace?.push(
        `codex app-server could not run (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      return undefined;
    }
  }

  /** Rollouts live under sessions/YYYY/MM/DD; the newest one is the current. */
  private async newestCodexRollout(
    rootOverride?: string,
  ): Promise<string | undefined> {
    const root =
      rootOverride ?? path.join(this.homeDirectory, ".codex", "sessions");
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
    // Exit code is not the signal here. `claude auth status` exits non-zero
    // purely because nobody is signed in, while still printing the status
    // JSON, so reading it as "no CLI" made a working install look absent
    // exactly when it was needed — browser sign-in is offered only for a
    // detected CLI, so a host that had never signed in could never start.
    // A genuinely missing binary never reaches here: `runProcess` rejects on
    // spawn failure and `detect` turns that into `detected: false`.
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
      // Ran, but said nothing this understands. A clean exit still means a
      // working CLI; a non-zero one with no parseable status is the shape a
      // half-installed binary has, and claiming detection there would offer a
      // sign-in that cannot work.
      return { detected: result.exitCode === 0, loggedIn: false };
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
    // Exit code first, words only to veto. `codex login status` answers zero
    // when it has an account and non-zero when it does not; what it *says*
    // while doing so has changed between releases, and requiring one of two
    // phrasings is what told somebody with a live ChatGPT session that they
    // were not signed in.
    const loggedIn = login.exitCode === 0 && !saysSignedOut(output);
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

  private async detectBrowserCli(provider: "cursor" | "copilot" | "kiro"):
    Promise<ProviderCliState> {
    const spec = browserCliSpec(provider) as BrowserCliSpec;
    // Through the alias-aware runner, because this is the check that decides
    // whether the connection is usable at all: finding no `agent` on a
    // machine that has `cursor-agent` reported the CLI as absent, and every
    // later question was never asked.
    const version = await this.runBrowserCli(
      spec,
      [...spec.prefixArgs, "--version"],
      { timeoutMs: 30_000, maxOutputBytes: 65_536 },
    );
    return {
      detected: version.exitCode === 0,
      // Per-user sessions are always staged into a temporary home and are
      // reflected by `ownCredential`; ambient host login is intentionally not
      // treated as somebody else's connection for these browser-only agents.
      loggedIn: false,
    };
  }

  /* ------------------------------------------------------- statuses ----- */

  public async list(input: {
    userId: string;
    systemAdmin: boolean;
  }): Promise<ProviderStatus[]> {
    const connections = await this.namedConnections(input.userId);
    // What this deployment remembers, for the case the reconciler above
    // cannot repair: a connections file that lost the *record* as well as the
    // name, while the credential — and therefore the connection — survived.
    // The agent is still connected and still has a name; only this machine's
    // copy of the name is gone.
    const remembered = await this.callSignsFor(input.userId);
    const store = await this.credentialStore();
    const statuses: ProviderStatus[] = [];
    for (const id of PROVIDER_IDS) {
      const connection = connections[id];
      const cli = await this.detect(id);
      const settings = connection?.settings ?? {};
      // Copilot is connected when either its own sign-in landed or the user
      // has a GitHub token for it to borrow, in that order.
      let own: UserCredentialSummary | undefined;
      for (const source of credentialSourcesFor(PROVIDER_VENDORS[id])) {
        own = await store.summary(input.userId, source);
        if (own !== undefined) {
          break;
        }
      }
      // An own credential authenticates on its own and needs no host login,
      // so it is checked before the shared-login path and outranks it.
      const connected =
        own !== undefined ||
        (connection !== undefined && input.systemAdmin && cli.loggedIn);
      const callSign = settings.callSign ?? remembered.get(id);
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
        // Present for every connection: naming happens at connect, and
        // anything older is named on the way through `namedConnections`. Only
        // a provider this account has never connected has none, and sending
        // that as an empty string is impossible to distinguish from "named
        // the empty string", so it is simply omitted.
        ...(callSign === undefined ? {} : { callSign }),
        ...(SIGN_IN_FLOWS[id] === undefined
          ? {}
          : { signInFlow: SIGN_IN_FLOWS[id] }),
        model:
          settings.model ??
          (id === "anthropic"
            ? DEFAULT_CLAUDE_MODEL
            : id === "openai"
              ? (await this.codexModels())?.[0]?.id ?? "codex default"
              : id === "google"
                ? "gemini"
                : `${id} default`),
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
    Record<
      string,
      Array<{
        provider: ProviderId;
        visibility: CredentialVisibility;
        callSign?: string;
      }>
    >
  > {
    const store = await this.credentialStore();
    // The call sign travels with the connection because the channel roster is
    // built from this and has no other route to an account-level name. Without
    // it every agent fell back to its vendor label, which is why naming had to
    // be redone per room to have any effect at all.
    //
    // A teammate who connected before agents were named is named here rather
    // than left waiting until they next open their own dashboard: their agent
    // appears in everybody else's roster, and this is the only path that
    // reads it.
    const connections = await this.readConnections();
    if (await this.nameUnnamedConnections(connections, userIds)) {
      await this.writeConnections(connections);
    }
    // The durable copy, for the agent whose connections-file *record* went
    // missing along with its name — the reconciler above can only repair a
    // record that is still there. Without this the roster falls back to
    // "Claude (Nathan)" for an agent everybody in the channel knows by name.
    const remembered = new Map<string, string>(
      (await this.storedCallSigns()).map((entry) => [
        `${entry.userId}\0${entry.provider}`,
        entry.callSign,
      ]),
    );
    const result: Record<
      string,
      Array<{
        provider: ProviderId;
        visibility: CredentialVisibility;
        callSign?: string;
      }>
    > = {};
    for (const userId of userIds) {
      const summaries = await store.list(userId);
      result[userId] = summaries.flatMap((summary) => {
        if (summary.vendor === "github") {
          // A GitHub connection is a push credential, not an agent anybody
          // could @mention; a roster that listed it would offer a teammate a
          // name that can never answer.
          return [];
        }
        const provider = VENDOR_PROVIDERS[summary.vendor];
        const callSign =
          connections[userId]?.[provider]?.settings?.callSign ??
          remembered.get(`${userId}\0${provider}`);
        return [
          {
            provider,
            visibility: summary.visibility,
            ...(callSign === undefined ? {} : { callSign }),
          },
        ];
      });
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
     * "Personal" or "org-wide" — see {@link CredentialVisibility}. Chosen in
     * the connect modal; a caller that omits it keeps whatever this agent was
     * already configured as, and gets personal only when there is nothing
     * stored to keep.
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

    const store = await this.credentialStore();
    // Re-pasting a secret into an agent that already exists repairs it rather
    // than replaces it, so an unstated choice means the one already stored,
    // and only a first connection falls back to personal.
    const previous = await store.summary(input.userId, vendor);
    const account = await this.verifyCredential(input.provider, {
      vendor,
      kind: input.kind,
      secret,
      label: input.label,
      origin: input.kind === "session_file" ? "copied" : "pasted",
      createdAt: new Date().toISOString(),
      lastVerifiedAt: undefined,
      hint: credentialHint(input.kind, secret),
      visibility: input.visibility ?? previous?.visibility ?? "personal",
    });

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
      // Named through the reconciler rather than by `assignCallSign` alone,
      // so a returning account gets back the name the store remembers for it
      // instead of a fresh one from the pantheon — reconnecting must not
      // rename an agent the room has learned.
      await this.nameUnnamedConnections(file, [input.userId]);
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
    const openai = input.provider === "openai";
    const browser = browserCliSpec(input.provider);
    const home = await mkdtemp(path.join(os.tmpdir(), "coord-device-"));
    const env: NodeJS.ProcessEnv = {
      ...sanitizeChildEnv(process.env),
      ...(anthropic
        ? { CLAUDE_CONFIG_DIR: home }
        : openai
          ? { CODEX_HOME: home }
          : {
              HOME: home,
              USERPROFILE: home,
              // Make CLIs print the URL instead of opening it on the server.
              BROWSER: "echo",
              GH_BROWSER: "echo",
              // Keep the CLI's own program cache out of the home that is about
              // to be captured as this user's credential. Copilot unpacks ~200
              // files here otherwise, and capturing those instead of the token
              // is what produced a stored session the CLI could not load.
              ...programCacheEnv(PROVIDER_VENDORS[input.provider]),
              ...(input.provider === "google"
                ? {
                    GEMINI_CLI_TRUST_WORKSPACE: "true",
                    // Gemini's ordinary OAuth flow returns to a loopback
                    // listener. In a hosted deployment that listener is on
                    // the server while the browser is on the user's machine.
                    // Its manual flow returns a code that can cross that gap.
                    NO_BROWSER: "true",
                  }
                : {}),
            }),
    };
    // The host's own keys must not be visible to a sign-in: an inherited one
    // would let the CLI succeed without the user ever signing in, and the
    // credential captured afterwards would be the host owner's.
    for (const name of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "COPILOT_GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "CURSOR_API_KEY",
      "KIRO_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
    ]) {
      delete env[name];
    }

    if (input.provider === "google") {
      // Choose Google OAuth up front. Driving Gemini's full-screen auth menu
      // by writing "1" raced the menu listener and changed meaning whenever
      // the CLI reordered its choices. The same settings field is already
      // used when a stored Gemini session is staged for an agent run.
      const geminiDirectory = path.join(home, ".gemini");
      await mkdir(geminiDirectory, { recursive: true });
      await writeFile(
        path.join(geminiDirectory, "settings.json"),
        `${JSON.stringify({
          security: { auth: { selectedType: "oauth-personal" } },
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
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
    /** A URL the CLI printed that is not on a known sign-in host. */
    let fallbackUrl: string | undefined;

    flow.process = this.longRunningSpawner(
      anthropic
        ? resolveClaudeCommand("claude")
        : openai
          ? resolveCodexCommand(this.homeDirectory)
          : (browser as BrowserCliSpec).command,
      anthropic
        ? ["auth", "login"]
        : openai
          ? ["login", "--device-auth"]
          : [
              ...(browser as BrowserCliSpec).prefixArgs,
              ...(browser as BrowserCliSpec).loginArgs,
            ],
      // Code-exchange flows keep stdin open for the authorization code the
      // browser may hand the user. Codex approves by polling and never reads
      // stdin, so it stays closed.
      {
        env,
        cwd: home,
        ...(signInFlow === "code_exchange"
          ? { stdin: "pipe" as const }
          : {}),
        ...(browser?.ptyLogin === true ? { pty: true as const } : {}),
      },
      (line) => {
        const parsed = parseDeviceAuthLine(line);
        if (
          parsed.url !== undefined &&
          (input.provider === "anthropic" ||
            input.provider === "openai" ||
            isUserVerificationUrl(parsed.url))
        ) {
          // A URL on the vendor's own sign-in host is taken at once. Any
          // other is only held as a fallback, because the first URL a CLI
          // prints is often a banner, a docs page or a status link — Cursor
          // was sending people to github.com this way, which is Copilot's
          // sign-in and not Cursor's. The fallback is still promoted shortly
          // after, so a vendor moving to a host not listed here degrades to
          // the old behaviour instead of never showing a link at all.
          if (isSignInUrl(parsed.url, browser?.signInHosts)) {
            flow.verificationUrl ??= parsed.url;
          } else if (fallbackUrl === undefined) {
            fallbackUrl = parsed.url;
            const promote = setTimeout(() => {
              if (flow.verificationUrl === undefined) {
                flow.verificationUrl = fallbackUrl;
                if (flow.mode === "code_exchange" || flow.userCode !== undefined) {
                  announce();
                }
              }
            }, UNRECOGNIZED_SIGN_IN_URL_GRACE_MS);
            // Deliberately not unref'd: this timer *is* the sign-in prompt
            // when no recognized URL follows, and an unref'd one can be
            // dropped before it fires, leaving the flow waiting on a link
            // that was already in hand.
            void promote;
          }
        }
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
    // Gemini does not exit once it is signed in — it goes on to the chat it
    // would normally start, so waiting for the process to end waits forever.
    // The credential file appearing is the actual completion signal, so it is
    // watched for, and the CLI is stopped once it lands.
    if (input.provider === "google") {
      this.watchForGeminiCredential(flow);
    }
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
          "no code back in Kumi",
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
    if (flow.provider === "google") {
      // Gemini enters ACP after manual authentication and therefore does not
      // exit by itself. Wait until its token file is complete before stopping
      // it; `finishBrowserAuth` then validates and stores that file exactly as
      // it does for a naturally-exiting login process.
      void this.stopGeminiAfterCredential(flow);
    }
    return this.describeDeviceAuth(flow);
  }

  private async stopGeminiAfterCredential(flow: DeviceAuthFlow): Promise<void> {
    const credentialPath = path.join(
      flow.home,
      ".gemini",
      "oauth_creds.json",
    );
    while (flow.status === "pending" && Date.now() <= flow.expiresAtMs) {
      try {
        const secret = await readFile(credentialPath, "utf8");
        assertSessionFile("gemini", secret);
        flow.process.kill();
        return;
      } catch {
        // ENOENT is the usual case while Gemini exchanges the code. A partial
        // JSON write is treated the same way and retried rather than captured.
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
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
    if (flow.provider !== "openai") {
      await this.finishBrowserAuth(flow, output);
      return;
    }
    try {
      const authPath = path.join(flow.home, "auth.json");
      const secret = await readFile(authPath, "utf8");
      assertSessionFile("codex", secret);

      const store = await this.credentialStore();
      // Signing in again is how an expired session is repaired, and the agent
      // that comes back is the one that was there before — so whoever was
      // allowed to task it stays allowed to. Device authorization still has no
      // connect-modal step to offer the personal/org-wide choice in, so a
      // genuinely first sign-in keeps the safe default.
      const previous = await store.summary(flow.userId, "codex");
      const account = await this.verifyCredential(flow.provider, {
        vendor: "codex",
        kind: "session_file",
        secret,
        label: undefined,
        origin: "device_auth",
        createdAt: new Date().toISOString(),
        lastVerifiedAt: undefined,
        hint: credentialHint("session_file", secret),
        visibility: previous?.visibility ?? "personal",
      });

      // The one moment a real CODEX_HOME exists on this host. Sign-in runs
      // the CLI against a throwaway directory so the host's own keys stay out
      // of the captured credential — which also means anything the CLI writes
      // there, including the model list it caches, is discarded with it. The
      // reader looks in `~/.codex`, the writer only ever writes to a temp
      // directory, and the two can therefore never meet: that is why a
      // deployment offers suggested model names rather than the account's
      // own. Copying the cache out closes the gap for the next `options()`
      // call, and is best-effort in every direction — the CLI may not write
      // one at login, in which case nothing changes and the suggestions still
      // apply.
      await this.captureCodexModelCache(flow.home);
      await store.put(flow.userId, "codex", {
        kind: "session_file",
        secret,
        origin: "device_auth",
        label: account ?? "ChatGPT sign-in",
        // Stating it rather than leaning on the store's carry-forward, so the
        // record this flow writes says the same thing the probe above ran
        // under.
        ...(previous?.visibility === undefined
          ? {}
          : { visibility: previous.visibility }),
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

  /**
   * Finishes a Gemini sign-in the moment its credential file appears.
   *
   * Every other CLI here exits when its sign-in is done, so the process
   * ending is the signal. Gemini's manual flow runs inside the interactive
   * session — the only mode that offers it — and that session keeps running
   * afterwards, so there is nothing to wait for. What does happen, exactly
   * once, is `oauth_creds.json` being written.
   */
  private watchForGeminiCredential(flow: DeviceAuthFlow): void {
    const credentials = path.join(flow.home, ".gemini", "oauth_creds.json");
    const deadline = flow.expiresAtMs;
    const poll = async (): Promise<void> => {
      while (flow.status === "pending" && Date.now() < deadline) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, GEMINI_CREDENTIAL_POLL_MS);
          timer.unref?.();
        });
        if (flow.status !== "pending" || !existsSync(credentials)) {
          continue;
        }
        // The CLI writes the file and then carries on; stopping it here is
        // what lets the staged home be read and removed. `finishBrowserAuth`
        // is called directly rather than through `done` because a killed
        // process reports failure, and the credential is already on disk.
        flow.process.kill();
        await flow.process.done.catch(() => undefined);
        if (flow.status === "pending") {
          await this.finishBrowserAuth(flow, {
            exitCode: 0,
            stdout: "",
            stderr: "",
            durationMs: 0,
          });
        }
        return;
      }
    };
    void poll().catch((error: unknown) => {
      if (flow.status === "pending") {
        flow.status = "failed";
        flow.detail = error instanceof Error ? error.message : String(error);
      }
    });
  }

  /** Stores the browser session written by Cursor, Copilot, Kiro or Gemini. */
  private async finishBrowserAuth(
    flow: DeviceAuthFlow,
    output: ProcessOutput,
  ): Promise<void> {
    const vendor = PROVIDER_VENDORS[flow.provider];
    try {
      const secret =
        flow.provider === "google"
          ? await readFile(
              path.join(flow.home, ".gemini", "oauth_creds.json"),
              "utf8",
            )
          : await captureBrowserSession(flow.home);
      assertSessionFile(vendor, secret);
      const store = await this.credentialStore();
      const previous = await store.summary(flow.userId, vendor);
      const credential: UserCredential = {
        vendor,
        kind: "session_file",
        secret,
        origin: "device_auth",
        createdAt: new Date().toISOString(),
        lastVerifiedAt: undefined,
        hint: credentialHint("session_file", secret),
        visibility: previous?.visibility ?? "personal",
        label: undefined,
      };
      const account = await this.verifyCredential(flow.provider, credential);
      await store.put(flow.userId, vendor, {
        kind: "session_file",
        secret,
        origin: "device_auth",
        label: account ?? `${PROVIDER_NAMES[flow.provider]} sign-in`,
        ...(previous?.visibility === undefined
          ? {}
          : { visibility: previous.visibility }),
      });
      await store.markVerified(flow.userId, vendor, account);
      await this.ensureConnectionRecord(flow.userId, flow.provider);
      flow.status = "completed";
      flow.account = account;
    } catch (error) {
      flow.status = "failed";
      flow.detail =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? `The sign-in did not complete: ${probeFailureDetail(output)}`
          : error instanceof Error
            ? error.message
            : String(error);
    } finally {
      if (flow.timer !== undefined) {
        clearTimeout(flow.timer);
      }
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
      // No visibility stated, which the store reads as "whatever this agent
      // already was": signing in again after a session expired must not turn
      // an org-wide agent back into a personal one.
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

  /**
   * Creates the settings record a connection needs, if it has none yet, and
   * gives it its name in the same breath — restored from the store when this
   * account has been named before, dealt fresh when it has not.
   */
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
      await this.nameUnnamedConnections(file, [userId]);
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
          `${PROVIDER_NAMES[provider]} rejected that credential: ${probe.detail}${ineligibleTierHint(probe.detail)}`,
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

    const output =
      provider === "google"
        ? await (() => {
            const gemini = resolveGeminiCommand();
            return this.runner(
              gemini.command,
              [
                ...gemini.prefixArgs,
                "-p",
                "Reply with exactly: pong",
                "-o",
                "json",
              ],
              options,
            );
          })()
        : await this.runBrowserCliPrompt(
            provider as "cursor" | "copilot" | "kiro",
            "Reply with exactly: pong",
            undefined,
            options,
          );
    if (output.exitCode === 0 && output.stdout.includes("pong")) {
      return { ok: true, detail: "verified" };
    }
    return { ok: false, detail: probeFailureDetail(output) };
  }

  /** Runs one non-interactive turn for the browser-account CLIs. */
  private async runBrowserCliPrompt(
    provider: "cursor" | "copilot" | "kiro",
    prompt: string,
    settings: ProviderSettings | undefined,
    options: Parameters<ProcessRunner>[2],
  ): Promise<ProcessOutput> {
    const spec = browserCliSpec(provider) as BrowserCliSpec;
    const model = settings?.model;
    const args =
      provider === "cursor"
        ? [
            ...spec.prefixArgs,
            "-p",
            "--output-format",
            "json",
            "--force",
            ...(model === undefined ? [] : ["--model", model]),
            prompt,
          ]
        : provider === "copilot"
          ? [
              ...spec.prefixArgs,
              "--allow-all-tools",
              ...(model === undefined ? [] : ["--model", model]),
              "-p",
              prompt,
            ]
          : [
              ...spec.prefixArgs,
              "chat",
              "--no-interactive",
              "--trust-all-tools",
              ...(model === undefined ? [] : ["--model", model]),
              prompt,
            ];
    return await this.runBrowserCli(spec, args, options);
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
    const browser = browserCliSpec(input.provider) as BrowserCliSpec;
    this.detachedSpawner(browser.command, [
      ...browser.prefixArgs,
      ...browser.loginArgs,
    ]);
    return {
      started: true,
      note: `${browser.label} is starting; complete sign-in in the host browser, then press Check again.`,
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
    // Same reconciler the read paths use: a name the store already holds for
    // this account is restored, and only a genuinely new agent is dealt one.
    await this.nameUnnamedConnections(file, [input.userId]);
    await this.writeConnections(file);
    return await this.list(input);
  }

  /**
   * Disconnecting also destroys the user's stored credential. Leaving the
   * secret behind would mean a provider the user believes they detached still
   * holds a working key to their account.
   */
  /**
   * Removes an agent: its credential, its connection, and its record.
   *
   * Deleting the credential used to be the whole of disconnecting, because
   * until agents got their own durable record the credential *was* the
   * identity. It is not any more. The roster is a union of stored credentials
   * and call-sign records, so an agent whose credential this deleted stayed in
   * every channel, still mentionable, still answering to the name it was
   * dealt — disconnected everywhere except where it mattered.
   *
   * It is also what makes this work for an agent that never had a credential.
   * Local execution runs the vendor CLI under the machine's own login, so its
   * agent has no secret here to delete; the two steps above are no-ops for it
   * and the record is the only thing there is to remove. Without this there
   * was no way to remove such an agent at all.
   *
   * Every step is safe to run against nothing — `delete` returns early on a
   * vendor with no credential, the connections file is guarded, and
   * `forgetCallSign` swallows its own failure — so disconnecting an agent
   * that is already gone is a no-op rather than an error.
   *
   * Both of the last two steps are required, and neither is enough alone.
   * `nameUnnamedConnections` reconciles the durable record against the
   * connections file on the way through `list`, dealing a fresh name to any
   * connection that has none — so removing only the record leaves a connection
   * for the reconciler to rename, and the very next roster read brings the
   * agent back under a name nobody chose. It skips a provider with no entry in
   * that file, which is what makes removing the entry the other half of the
   * job. Their order does not matter: nothing reads between them.
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
    await this.forgetCallSign(input.userId, input.provider);
  }

  /* ----------------------------------------------- settings/options ----- */

  /**
   * Keeps a signed-in account's model list where `codexModels` will find it.
   *
   * Deployment-wide rather than per-user, because `options()` is asked about a
   * vendor and not about a person — so this is "what a Codex CLI on this host
   * last reported", and the last sign-in wins. Two accounts on different plans
   * would therefore see one list; that is a better failure than the current
   * one, where every account sees a hardcoded guess, and the value is only
   * ever a suggestion anyway — a name outside it still saves.
   */
  private async captureCodexModelCache(home: string): Promise<void> {
    try {
      const cached = await readFile(
        path.join(home, "models_cache.json"),
        "utf8",
      );
      // Parsed before it is kept: a half-written or unreadable file must not
      // replace a good cache from an earlier sign-in.
      const parsed = JSON.parse(cached) as { models?: unknown };
      if (!Array.isArray(parsed.models) || parsed.models.length === 0) {
        return;
      }
      const destination = path.join(this.homeDirectory, ".codex");
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, "models_cache.json"), cached, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // No cache written by this sign-in, or nowhere to put it. The suggested
      // list still covers the picker, so this is never worth failing on.
    }
  }

  /**
   * The models Cursor reports for the signed-in account.
   *
   * Asked, not guessed. The connect screen showed "cursor default" and no way
   * to change it, because `options()` returned no list and the control is a
   * dropdown — so an empty list is an empty control, whatever
   * `allowCustomModel` says. Inventing names to fill it is the one thing this
   * file already refuses to do, and the CLI can simply be asked:
   * `--list-models` prints "Available models", a blank line, then one line per
   * model as `id - Display Name` with a dim ` (current, default)` marker, then
   * a closing tip. There is no JSON mode, so this reads that.
   *
   * A failure returns undefined rather than throwing: not knowing the list is
   * the state this replaces, and it must not also break the settings screen.
   */
  private async cursorModels(
    userId: string,
  ): Promise<ProviderModelOption[] | undefined> {
    const cached = this.cursorModelCache;
    if (cached !== undefined && Date.now() - cached.at < MODEL_LIST_TTL_MS) {
      return cached.models;
    }
    const spec = browserCliSpec("cursor") as BrowserCliSpec;
    let output: ProcessOutput;
    try {
      const store = await this.credentialStore();
      const home = await store.openCredentialHome({
        userId,
        vendor: "cursor",
        baseEnv: sanitizeChildEnv(process.env),
        mode: "shared",
      });
      if (home === undefined) {
        return undefined;
      }
      try {
        output = await this.runner(
          spec.command,
          [...spec.prefixArgs, "--list-models"],
          { env: home.env, timeoutMs: 60_000, maxOutputBytes: MAX_OUTPUT_BYTES },
        );
      } finally {
        await home.close();
      }
    } catch {
      return undefined;
    }
    if (output.exitCode !== 0) {
      return undefined;
    }
    const models = parseCursorModelList(output.stdout);
    if (models.length === 0) {
      return undefined;
    }
    this.cursorModelCache = { at: Date.now(), models };
    return models;
  }

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
  private async claudeModels(): Promise<ProviderModelOption[]> {
    const models = new Map<string, ProviderModelOption>();
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
          label:
            option.label ??
            CLAUDE_MODEL_LABELS[option.value] ??
            option.value,
          ...(option.description === undefined
            ? {}
            : { description: option.description }),
        });
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
            models.set(value, {
              id: value,
              label: CLAUDE_MODEL_LABELS[value] ?? value,
            });
          }
        }
      }
    } catch {
      // Help unavailable; whatever the cache provided still stands.
    }
    return [...models.values()];
  }

  public async options(input: {
    provider: ProviderId;
    /**
     * Whose connection to ask. Cursor reports its models per account, so
     * without a caller this falls back to "the account's own default" rather
     * than answering for somebody else.
     */
    userId?: string;
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
        // A reported list stays authoritative — it is read from the account's
        // own cache, so a name outside it is a typo worth catching. With no
        // list there is nothing to be outside of, and refusing every name left
        // a deployment whose CLI had never cached one unable to pick any model
        // at all. The value reaches `codex exec -m <model>` unaltered either
        // way, exactly as it does for Claude.
        allowCustomModel: models === undefined,
        // Suggested names, where the CLI has cached none of its own. This
        // used to send nothing at all, on the reasoning that a suggestion is
        // a guess about somebody else's account — true, and it was the right
        // answer to `gpt-5`, which 400s on a ChatGPT-account Codex. But the
        // conclusion drawn from it was too wide. An empty control is not a
        // careful answer to an uncertain one: it leaves somebody who does not
        // already know an id with no way to name a model at all, which is the
        // state this shipped in. A named guess that fails at planning with
        // the CLI's own message is recoverable; a control with nothing in it
        // is not even wrong.
        //
        // What keeps it honest is that these never masquerade as reported.
        // `suggestedModels` and `models` are mutually exclusive, and
        // `providerOptionsNote` tells the reader which they have.
        ...(models === undefined
          ? {
              suggestedModels: [...SUGGESTED_MODELS.openai],
              suggestedEfforts: [...SUGGESTED_EFFORTS.openai],
            }
          : {}),
        notes:
          models === undefined
            ? [
                "Codex has not cached a model list on this machine, so these " +
                  "are the CLI's documented ids rather than what this account " +
                  "reports. Any other id can be typed instead.",
              ]
            : [],
      };
    }
    if (input.provider === "anthropic") {
      const models = await this.claudeModels();
      return {
        models: models.length > 0 ? models : null,
        efforts: [...CLAUDE_EFFORTS],
        allowCustomModel: true,
        ...(models.length > 0
          ? {}
          : { suggestedModels: [...SUGGESTED_MODELS.anthropic] }),
        notes: [],
      };
    }
    if (input.provider === "google") {
      return {
        models: null,
        efforts: null,
        allowCustomModel: false,
        suggestedModels: [...SUGGESTED_MODELS.google],
        suggestedEfforts: [...SUGGESTED_EFFORTS.google],
        notes: [
          "Gemini CLI settings become available once the signed-in account is eligible to use it.",
        ],
      };
    }
    if (input.provider === "cursor") {
      const models =
        input.userId === undefined
          ? undefined
          : await this.cursorModels(input.userId);
      return {
        models: models ?? null,
        // Cursor carries reasoning inside the model string rather than beside
        // it -- `--model 'claude-opus-4-8[context=1m,effort=high,fast=false]'`
        // -- so there is no separate level to offer, and a free-typed name is
        // how somebody reaches one.
        efforts: null,
        allowCustomModel: true,
        notes:
          models === undefined
            ? [
                "Cursor could not be asked for its model list, so it will use " +
                  "the account's own default. A model id typed here is still " +
                  "passed through.",
              ]
            : [
                "Reasoning rides on the model for Cursor: a parameterized " +
                  "model accepts overrides in brackets, such as " +
                  "claude-opus-4-8[context=1m,effort=high,fast=false].",
              ],
      };
    }
    return {
      models: null,
      efforts: null,
      allowCustomModel: true,
      notes: [
        `${PROVIDER_NAMES[input.provider]} uses the model selected by the signed-in account unless you provide one.`,
      ],
    };
  }

  public async setSettings(input: {
    userId: string;
    provider: ProviderId;
    model?: string;
    effort?: string;
    callSign?: string;
    visibility?: "personal" | "org";
  }): Promise<ProviderStatus[]> {
    const file = await this.readConnections();
    let connection = file[input.userId]?.[input.provider];
    if (connection === undefined) {
      // An agent exists without a credential, and its settings are still its
      // settings. This asked the old question — is a secret stored — and so
      // refused every change to an agent created by the local flow: its model,
      // its reasoning level, its name, and the visibility deciding whether
      // teammates may task it.
      //
      // The connections file holds *settings*; the credential store holds
      // credentials. They were always separate, so a settings row with no
      // credential behind it is an ordinary row.
      const exists = (await this.storedCallSigns()).some(
        (entry) =>
          entry.userId === input.userId && entry.provider === input.provider,
      );
      if (!exists) {
        throw new ProviderChatError(
          409,
          "not_connected",
          `Connect ${PROVIDER_NAMES[input.provider]} before changing its settings`,
        );
      }
      const byProvider = (file[input.userId] ??= {});
      connection = { kind: "account", createdAt: new Date().toISOString() };
      byProvider[input.provider] = connection;
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
      // Checked against what the provider reported, and only against that.
      // When it reported nothing — no provider-wide list and no models, which
      // is every deployment whose CLI has not cached one — the old `?? false`
      // made this reject every possible value, including the three the picker
      // was offering at the time. Not knowing is not the same as knowing it is
      // wrong, so an unreported vocabulary falls back to a shape check.
      const valid =
        options.efforts?.includes(input.effort) ??
        options.models?.some(
          (model) =>
            (settings.model === undefined || model.id === settings.model) &&
            model.efforts?.includes(input.effort as string),
        ) ??
        EFFORT_VALUE.test(input.effort);
      if (!valid) {
        throw new ProviderChatError(
          400,
          "invalid_effort",
          "That reasoning effort is not one the provider reports for this model",
        );
      }
      settings.effort = input.effort;
    }
    // A call sign is the agent's name and nothing more: no vocabulary to
    // validate against, so the only rules are that it is not blank and not an
    // essay. Clearing it back to the vendor label is done by sending an empty
    // string, the same way model and effort clear.
    if (input.model !== undefined && input.model !== "") {
      // Refused rather than stored when the CLI's own list disagrees. A
      // stored guess fails every future run with the vendor's 400 — Phoenix
      // spent an afternoon refusing "gpt-5" — and the person who clicked it
      // has no reason to connect the setting to the failure.
      const known = await this.options({ provider: input.provider }).catch(
        () => undefined,
      );
      const ids = (known?.models ?? known?.suggestedModels ?? []).map(
        (model) => model.id,
      );
      if (ids.length > 0 && !ids.includes(input.model)) {
        throw new ProviderChatError(
          400,
          "unknown_model",
          `${PROVIDER_NAMES[input.provider]} does not report a model "${input.model}" — ` +
            `choose one of: ${ids.join(", ")}`,
        );
      }
    }
    if (input.callSign !== undefined) {
      const trimmed = input.callSign.trim();
      if (trimmed.length > 40) {
        throw new ProviderChatError(
          400,
          "invalid_call_sign",
          "A call sign is at most 40 characters",
        );
      }
      if (trimmed === "") {
        delete settings.callSign;
        // Forgotten in the store too, or the next restart would restore the
        // name this just cleared — the same complaint as a name that
        // vanishes, pointed the other way.
        await this.forgetCallSign(input.userId, input.provider);
      } else {
        // Nobody else's name.
        //
        // A mention resolves by name and dispatches to *everyone* it matches,
        // so two agents sharing one makes a single @mention start two runs on
        // two accounts, and the second reply arrives from an agent the sender
        // never addressed. Deriving the default avoided that among defaults;
        // renaming went straight past it, because a typed name never consults
        // the taken set at all.
        //
        // Compared case-insensitively, because that is how a mention matches
        // and how a person reads a name.
        const clash = (await this.storedCallSigns()).find(
          (entry) =>
            entry.callSign.trim().toLowerCase() === trimmed.toLowerCase() &&
            !(entry.userId === input.userId && entry.provider === input.provider),
        );
        if (clash !== undefined) {
          throw new ProviderChatError(
            409,
            "call_sign_taken",
            `Another agent here is already called ${clash.callSign}. ` +
              "Two agents with one name both answer to it — pick another.",
          );
        }
        settings.callSign = trimmed;
        await this.rememberCallSign(input.userId, input.provider, trimmed);
      }
    }
    connection.settings = settings;
    await this.writeConnections(file);
    // Visibility lives on the stored credential, not on this settings record:
    // it is not a preference about how the agent answers but a decision about
    // whose credential a teammate's prompt may spend. Written after the
    // settings above so a rejection here — no credential of one's own, which
    // is the shared-login case — leaves model and effort already saved.
    if (input.visibility !== undefined) {
      if (input.visibility !== "personal" && input.visibility !== "org") {
        throw new ProviderChatError(
          400,
          "invalid_visibility",
          "Visibility must be personal or org",
        );
      }
      const vendor = PROVIDER_VENDORS[input.provider];
      const store = await this.credentialStore();
      try {
        await store.setVisibility(input.userId, vendor, input.visibility);
      } catch (error) {
        // No credential to carry it, which is the ordinary state of an agent
        // that runs on somebody's own machine. The agent record is where its
        // visibility lives then, and the settings route writes it there —
        // and `describeProviders` reads it back, which is the half this
        // lacked the first time: the setting saved and every read still
        // said personal.
        const owned = (await this.storedCallSigns()).some(
          (entry) =>
            entry.userId === input.userId && entry.provider === input.provider,
        );
        if (!owned) {
          throw new ProviderChatError(
            409,
            "not_connected",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
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
      /** A throwaway line — run it on {@link CEREMONIAL_MODELS}. */
      ceremonial?: boolean;
      /** Optional canonical checkout for a repository-grounded answer. */
      repository?: RepositoryChatContext;
    },
    onEvent: (event: ChatStreamEvent) => void,
  ): Promise<ChatReply> {
    const prompt = await this.prepareCompletion(input);
    return await this.withCompletionDirectory(
      input.repository,
      async (workingDirectory) =>
        await this.withCompletionEnv(
          input.userId,
          input.provider,
          prompt.credential,
          async (env) => {
            try {
              return input.provider === "anthropic"
                ? await this.streamViaClaudeCli(
                    prompt.text,
                    prompt.settings,
                    input.cliSessionId,
                    onEvent,
                    env,
                    workingDirectory,
                  )
                : input.provider === "openai"
                  ? await this.streamViaCodexCli(
                      prompt.text,
                      prompt.settings,
                      input.cliSessionId,
                      onEvent,
                      env,
                      workingDirectory,
                    )
                  : await this.completeViaBrowserProvider(
                      input.provider,
                      prompt.text,
                      prompt.settings,
                      env,
                      workingDirectory,
                      onEvent,
                    );
            } catch (error) {
              // Record a real auth failure while the completion still owns the
              // credential reservation. No task can rotate the session between
              // observing the failure and retiring the credential; if this CLI
              // itself rotated before failing, close writes it back and restores
              // the connection before releasing the reservation.
              await this.noteCredentialFailure(input.userId, input.provider, error);
              throw error;
            }
          },
        ),
    );
  }

  /**
   * Gives one answer a detached checkout of the exact canonical revision.
   *
   * Provider chat answers rather than edits: Codex still runs in its
   * read-only sandbox, Claude may read and run commands but is refused every
   * editing tool ({@link CLAUDE_CHAT_DISALLOWED_TOOLS}), and the checkout is
   * destroyed after the turn even when the CLI fails. Chat that is not
   * attached to a repository keeps using the empty scratch directory.
   */
  private async withCompletionDirectory<T>(
    context: RepositoryChatContext | undefined,
    use: (workingDirectory: string) => Promise<T>,
  ): Promise<T> {
    if (context === undefined) {
      return await use(await this.scratchDirectory());
    }

    let workspace: TaskWorkspace;
    try {
      workspace = await this.workspaceManager.create({
        taskId: `chat_${randomUUID()}`,
        rootPath: context.rootPath,
        repository: context.repository,
        baseVersion: context.baseVersion,
      });
    } catch (error) {
      throw new ProviderChatError(
        503,
        "repository_unavailable",
        `The repository could not be opened for this answer: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    try {
      return await use(workspace.path);
    } finally {
      await this.workspaceManager.destroy(workspace);
    }
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
    ceremonial?: boolean;
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
    const settings = connection?.settings ?? {};
    // A ceremonial turn overrides how hard the model works and which model
    // does it, and nothing else. Call sign and the rest stay the account's
    // own, so the line still sounds like this agent — it is just not worth a
    // frontier model, or seconds of reasoning, to say it.
    const ceremonialModel =
      input.ceremonial === true ? CEREMONIAL_MODELS[input.provider] : undefined;
    const ceremonialEffort =
      input.ceremonial === true ? CEREMONIAL_EFFORTS[input.provider] : undefined;
    const ceremonial =
      ceremonialModel === undefined && ceremonialEffort === undefined
        ? undefined
        : {
            ...(ceremonialModel === undefined ? {} : { model: ceremonialModel }),
            ...(ceremonialEffort === undefined
              ? {}
              : { effort: ceremonialEffort }),
          };
    return {
      text: latest.content,
      settings:
        ceremonial === undefined ? settings : { ...settings, ...ceremonial },
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
    userId: string | undefined,
    provider: ProviderId,
    credential: UserCredential | undefined,
    use: (env: NodeJS.ProcessEnv | undefined) => Promise<T>,
  ): Promise<T> {
    if (credential === undefined) {
      return await use(undefined);
    }
    if (userId === undefined) {
      return await use(undefined);
    }
    const store = await this.credentialStore();
    const home = await store.openCredentialHome({
      userId,
      vendor: PROVIDER_VENDORS[provider],
      baseEnv: sanitizeChildEnv(process.env),
    });
    if (home === undefined) {
      throw new ProviderChatError(
        409,
        "not_connected",
        `Connect ${PROVIDER_NAMES[provider]} before chatting`,
      );
    }
    try {
      return await use(home.env);
    } finally {
      await home.close();
    }
  }

  public async complete(input: {
    userId: string;
    systemAdmin: boolean;
    provider: ProviderId;
    messages: unknown;
    cliSessionId?: string;
    /** A throwaway line — run it on {@link CEREMONIAL_MODELS}. */
    ceremonial?: boolean;
    /** Optional canonical checkout for a repository-grounded answer. */
    repository?: RepositoryChatContext;
  }): Promise<ChatReply> {
    const prompt = await this.prepareCompletion(input);
    return await this.withCompletionDirectory(
      input.repository,
      async (workingDirectory) =>
        await this.withCompletionEnv(
          input.userId,
          input.provider,
          prompt.credential,
          async (env) => {
            try {
              return input.provider === "anthropic"
                ? await this.completeViaClaudeCli(
                    prompt.text,
                    prompt.settings,
                    input.cliSessionId,
                    env,
                    workingDirectory,
                  )
                : input.provider === "openai"
                  ? await this.completeViaCodexCli(
                      prompt.text,
                      prompt.settings,
                      input.cliSessionId,
                      env,
                      workingDirectory,
                    )
                  : await this.completeViaBrowserProvider(
                      input.provider,
                      prompt.text,
                      prompt.settings,
                      env,
                      workingDirectory,
                    );
            } catch (error) {
              // Keep the failure update inside the same reservation as the CLI;
              // see the streaming path above for the ordering guarantee.
              await this.noteCredentialFailure(input.userId, input.provider, error);
              throw error;
            }
          },
        ),
    );
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
    const detail = cliFailureDetail(output);
    return new ProviderChatError(
      502,
      "cli_failed",
      detail === undefined
        ? output.exitCode === 124
          ? `The ${name} CLI did not answer before the deadline`
          : `The ${name} CLI exited ${output.exitCode} without saying why`
        : `The ${name} CLI exited ${output.exitCode}: ${detail}`,
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
    workingDirectory: string,
  ): Promise<ChatReply> {
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
      "--allowedTools",
      CLAUDE_CHAT_ALLOWED_TOOLS.join(","),
      "--disallowedTools",
      CLAUDE_CHAT_DISALLOWED_TOOLS.join(","),
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
          cwd: workingDirectory,
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
      const salvaged = salvagedClaudeReply(output.stdout, model);
      if (salvaged !== undefined) {
        return salvaged;
      }
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
    workingDirectory: string,
  ): Promise<ChatReply> {
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
            workingDirectory,
            ...(settings.model === undefined ||
            // Already stored before the suggestion list was fixed: bare gpt
            // ids fail every ChatGPT-account run with the vendor's 400, and
            // the person who once clicked "GPT-5" has no reason to connect a
            // dead agent to a dropdown. Fall back to the CLI's own default
            // rather than failing on a setting nobody can see.
            /^gpt-5(\.\d+)?$/u.test(settings.model)
              ? []
              : ["-m", settings.model]),
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
          cwd: workingDirectory,
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
    const chosenModel = settings.model ?? "codex default";
    let reply: ChatReply;
    if (output.exitCode === 0) {
      reply = parseCodexJsonl(output.stdout, chosenModel);
    } else {
      const salvaged = salvagedCodexReply(output.stdout, chosenModel);
      if (salvaged === undefined) {
        throw this.cliFailure("codex", output);
      }
      reply = salvaged;
    }
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
   * and the process runs in either an empty scratch directory or a temporary
   * canonical checkout, granted the tools that look
   * ({@link CLAUDE_CHAT_ALLOWED_TOOLS}, shell included) and refused the ones
   * that write.
   */
  private async completeViaClaudeCli(
    prompt: string,
    settings: ProviderSettings,
    cliSessionId: string | undefined,
    env: NodeJS.ProcessEnv | undefined,
    workingDirectory: string,
  ): Promise<ChatReply> {
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
      "--allowedTools",
      CLAUDE_CHAT_ALLOWED_TOOLS.join(","),
      "--disallowedTools",
      CLAUDE_CHAT_DISALLOWED_TOOLS.join(","),
      "--model",
      model,
      "--effort",
      effort,
      ...(resume ? ["--resume", cliSessionId as string] : []),
    ];
    const runOnce = async (resume: boolean): Promise<ProcessOutput> =>
      await this.runner(resolveClaudeCommand("claude"), argsFor(resume), {
        cwd: workingDirectory,
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
      const salvaged = salvagedClaudeReply(output.stdout, model);
      if (salvaged !== undefined) {
        return salvaged;
      }
      throw this.cliFailure("claude", output);
    }
    return parseClaudeStreamJson(output.stdout, model);
  }

  /**
   * Codex CLI completion over the signed-in ChatGPT account.
   *
   * Runs `codex exec --json` in the read-only sandbox inside either an empty
   * scratch directory or a temporary canonical checkout: the model can
   * reason and answer but the CLI's own sandbox denies writes. Continuity uses
   * `codex exec resume <thread_id>`.
   */
  private async completeViaCodexCli(
    prompt: string,
    settings: ProviderSettings,
    cliSessionId: string | undefined,
    env: NodeJS.ProcessEnv | undefined,
    workingDirectory: string,
  ): Promise<ChatReply> {
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
            workingDirectory,
            ...(settings.model === undefined ? [] : ["-m", settings.model]),
            ...effortOverride,
            prompt,
          ];
    const runOnce = async (resume: boolean): Promise<ProcessOutput> =>
      await this.runner(command, argsFor(resume), {
        cwd: workingDirectory,
        ...(env === undefined ? {} : { env }),
        timeoutMs: CLI_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
    let output = await runOnce(resumable);
    if (output.exitCode !== 0 && resumable) {
      output = await runOnce(false);
    }
    const chosenModel = settings.model ?? "codex default";
    let reply: ChatReply;
    if (output.exitCode === 0) {
      reply = parseCodexJsonl(output.stdout, chosenModel);
    } else {
      const salvaged = salvagedCodexReply(output.stdout, chosenModel);
      if (salvaged === undefined) {
        throw this.cliFailure("codex", output);
      }
      reply = salvaged;
    }
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

  /** Completion path shared by Gemini and the browser-only coding CLIs. */
  private async completeViaBrowserProvider(
    provider: Exclude<ProviderId, "anthropic" | "openai">,
    prompt: string,
    settings: ProviderSettings,
    env: NodeJS.ProcessEnv | undefined,
    workingDirectory: string,
    onEvent?: (event: ChatStreamEvent) => void,
  ): Promise<ChatReply> {
    const options = {
      cwd: workingDirectory,
      ...(env === undefined ? {} : { env }),
      timeoutMs: CLI_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    };
    let output: ProcessOutput;
    if (provider === "google") {
      const gemini = resolveGeminiCommand();
      output = await this.runner(
        gemini.command,
        [
          ...gemini.prefixArgs,
          "-p",
          prompt,
          "--output-format",
          "json",
          ...(settings.model === undefined
            ? []
            : ["--model", settings.model]),
        ],
        options,
      );
    } else {
      output = await this.runBrowserCliPrompt(provider, prompt, settings, options);
    }
    if (output.exitCode !== 0) {
      throw this.cliFailure(PROVIDER_NAMES[provider], output);
    }
    const text = browserCliReplyText(output.stdout, PROVIDER_NAMES[provider]);
    onEvent?.({ type: "text", delta: text });
    return {
      provider,
      model: settings.model ?? `${provider} default`,
      text,
      usage: {},
    };
  }
}

/** Extracts answer text without inventing usage or reasoning metadata. */
function browserCliReplyText(stdout: string, name: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new ProviderChatError(502, "cli_failed", `${name} returned no answer`);
  }
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      for (const key of ["response", "result", "text", "message"]) {
        if (typeof record[key] === "string") {
          return record[key] as string;
        }
      }
    }
  } catch {
    // Copilot and Kiro intentionally use plain text in non-interactive mode.
  }
  return trimmed;
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
        | {
            input_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
            output_tokens?: number;
          }
        | undefined;
      // `input_tokens` is the *uncached remainder*, not the prompt. The whole
      // prompt is that plus what was read from cache plus what was written to
      // it, which is why the task path already sums all three (see
      // `context-pressure.ts`). Reading only the first here meant a turn that
      // sent 40k tokens and served 38k of them from cache reported 2k, and
      // the number people were shown got *smaller* the better caching worked.
      //
      // The read count is the diagnostic too: caching is on by default and
      // needs no flag, so the question is never "is it enabled" but "is the
      // prefix still identical". Zero reads across turns of one conversation
      // is the symptom of something rewriting the prefix, and until now this
      // deployment had no way to see it.
      const cachedInput =
        (eventUsage?.cache_read_input_tokens ?? 0) +
        (eventUsage?.cache_creation_input_tokens ?? 0);
      usage = {
        ...(eventUsage?.input_tokens === undefined
          ? {}
          : { inputTokens: eventUsage.input_tokens }),
        ...(eventUsage?.cache_read_input_tokens === undefined &&
        eventUsage?.cache_creation_input_tokens === undefined
          ? {}
          : { cachedInputTokens: cachedInput }),
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
