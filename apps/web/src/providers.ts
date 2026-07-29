import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveClaudeCommand } from "@coord/adapter-prompt-cli";
import type { CoordinatorProject } from "@coord/cli/project";
import { runProcess, type ProcessOutput } from "@coord/repository-service";

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
 * Connections are stored per dashboard user. CLI-backed connections spend
 * the *host owner's* accounts, so they are restricted to system
 * administrators.
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
  kind?: "account";
  /** Effective model/effort after per-user settings. */
  model: string;
  effort?: string;
  cli: ProviderCliState;
  exposesThinking: boolean;
  requiresAdmin: boolean;
}

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

/** Real `--effort` values the Claude CLI accepts. */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";
const DEFAULT_CLAUDE_EFFORT = "high";

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 32_000;
const CLI_TIMEOUT_MS = 240_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// Square brackets appear in real Claude Code model values (e.g. the
// "claude-fable-5[1m]" context variant it caches for its own picker).
const MODEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/u;

export type ProcessRunner = typeof runProcess;
export type DetachedSpawner = (command: string, args: string[]) => void;

export interface ProviderChatServiceOptions {
  runner?: ProcessRunner;
  /** Launches a browser-opening login flow without holding the request. */
  detachedSpawner?: DetachedSpawner;
  homeDirectory?: string;
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

  public constructor(
    private readonly project: CoordinatorProject,
    options: ProviderChatServiceOptions = {},
  ) {
    this.runner = options.runner ?? runProcess;
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

  private get secretsPath(): string {
    return path.join(
      this.project.directory,
      "secrets",
      "provider-connections.json",
    );
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
    const statuses: ProviderStatus[] = [];
    for (const id of PROVIDER_IDS) {
      const connection = connections[id];
      const cli = await this.detect(id);
      const settings = connection?.settings ?? {};
      statuses.push({
        id,
        name: PROVIDER_NAMES[id],
        connected:
          connection !== undefined && input.systemAdmin && cli.loggedIn,
        ...(connection === undefined ? {} : { kind: "account" as const }),
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
        requiresAdmin: true,
      });
    }
    return statuses;
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

  public async disconnect(input: {
    userId: string;
    provider: ProviderId;
  }): Promise<void> {
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

  public async complete(input: {
    userId: string;
    systemAdmin: boolean;
    provider: ProviderId;
    messages: unknown;
    cliSessionId?: string;
  }): Promise<ChatReply> {
    const messages = assertMessages(input.messages);
    const connection = (await this.readConnections())[input.userId]?.[
      input.provider
    ];
    if (connection === undefined) {
      throw new ProviderChatError(
        409,
        "not_connected",
        `Connect ${PROVIDER_NAMES[input.provider]} before chatting`,
      );
    }
    if (!input.systemAdmin) {
      throw new ProviderChatError(
        403,
        "admin_required",
        "CLI-backed provider chat is restricted to system administrators",
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
    const settings = connection.settings ?? {};
    if (input.provider === "anthropic") {
      return await this.completeViaClaudeCli(
        latest.content,
        settings,
        input.cliSessionId,
      );
    }
    if (input.provider === "openai") {
      return await this.completeViaCodexCli(
        latest.content,
        settings,
        input.cliSessionId,
      );
    }
    throw new ProviderChatError(
      409,
      "provider_blocked",
      "Gemini chat is unavailable until the signed-in Google account is eligible",
    );
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
   * Headless Claude Code completion. The prompt is a positional argument —
   * verified live that a piped stdin prompt makes the CLI skip thinking —
   * and the process runs in an empty scratch directory under default
   * deny-by-request permissions, so it can answer but not act on the host.
   */
  private async completeViaClaudeCli(
    prompt: string,
    settings: ProviderSettings,
    cliSessionId: string | undefined,
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
