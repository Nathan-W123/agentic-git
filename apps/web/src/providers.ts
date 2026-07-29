import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveClaudeCommand } from "@coord/adapter-prompt-cli";
import type { CoordinatorProject } from "@coord/cli/project";
import { runProcess, type ProcessOutput } from "@coord/repository-service";

/**
 * Direct provider chat for the dashboard's agent panel.
 *
 * Three providers (Anthropic, OpenAI, Google), two connection kinds:
 *
 * - **api-key** — the user pastes their own API key on a connection screen.
 *   The key is validated with a free models-list call, stored server-side per
 *   user, and every completion is a direct HTTPS call whose response supplies
 *   the numbers the UI shows: token usage from the response body, reasoning
 *   content where the provider exposes it, and rate-limit state from response
 *   headers where the provider sends them. Nothing is synthesized: a field
 *   the provider does not return is absent here too.
 *
 * - **local-cli** — Anthropic only, and only for system administrators: the
 *   host's logged-in `claude` CLI runs in headless mode inside an empty
 *   scratch directory with default (deny-by-request) permissions, so it can
 *   answer but not execute tools against the host. Usage, cost, thinking
 *   blocks, and the subscription rate-limit window all come from the CLI's
 *   own stream-json events. Admin-gated because it spends the *host owner's*
 *   subscription, not the signed-in dashboard user's.
 *
 * Keys are stored in `.coordinator/secrets/provider-connections.json`, keyed
 * by user id, in plain text — the same trust level as the rest of the
 * `.coordinator` directory. They are never returned to the browser.
 */

export type ProviderId = "anthropic" | "openai" | "google";
export const PROVIDER_IDS: readonly ProviderId[] = [
  "anthropic",
  "openai",
  "google",
];

export type ConnectionKind = "api-key" | "local-cli";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Reasoning/thought tokens, when the provider accounts for them. */
  thinkingTokens?: number;
  costUsd?: number;
}

export interface ChatRateLimit {
  /** Where the numbers came from, so the UI can label them honestly. */
  source: "response-headers" | "cli-window";
  requestsRemaining?: number;
  requestsLimit?: number;
  tokensRemaining?: number;
  tokensLimit?: number;
  /** CLI subscription window, e.g. "five_hour". */
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
  /**
   * True when the provider counted reasoning tokens but does not expose the
   * content (OpenAI), so the UI can say so instead of showing nothing.
   */
  thinkingHidden?: boolean;
  usage: ChatUsage;
  rateLimit?: ChatRateLimit;
  /** Continues a local-cli conversation server-side. */
  cliSessionId?: string;
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  connected: boolean;
  kind?: ConnectionKind;
  model: string;
  /** Whether this provider can expose reasoning content at all. */
  exposesThinking: boolean;
  /** Anthropic only: a logged-in local claude CLI was detected. */
  localCliAvailable?: boolean;
  /** Local CLI connections are restricted to system administrators. */
  localCliRequiresAdmin?: boolean;
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
  kind: ConnectionKind;
  apiKey?: string;
  createdAt: string;
}

type ConnectionFile = Record<string, Partial<Record<ProviderId, StoredConnection>>>;

const PROVIDER_NAMES: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

/**
 * Default model per provider, overridable per deployment. These are the
 * providers' current general models with reasoning support where offered.
 */
function defaultModel(provider: ProviderId): string {
  const override = process.env[`COORD_CHAT_MODEL_${provider.toUpperCase()}`];
  if (override !== undefined && override.trim().length > 0) {
    return override.trim();
  }
  switch (provider) {
    case "anthropic":
      return "claude-sonnet-5";
    case "openai":
      return "gpt-5";
    case "google":
      return "gemini-2.5-pro";
  }
}

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 32_000;
const HTTP_TIMEOUT_MS = 120_000;
const CLI_TIMEOUT_MS = 180_000;
const ANTHROPIC_MAX_TOKENS = 8_192;
const ANTHROPIC_THINKING_BUDGET = 4_096;

export type FetchLike = (
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export type ProcessRunner = typeof runProcess;

export interface ProviderChatServiceOptions {
  fetchImpl?: FetchLike;
  runner?: ProcessRunner;
  /** Overrides local claude CLI detection in tests. */
  claudeCliDetector?: () => Promise<boolean>;
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

function headerNumber(
  headers: { get(name: string): string | null },
  name: string,
): number | undefined {
  const raw = headers.get(name);
  if (raw === null) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export class ProviderChatService {
  private readonly fetchImpl: FetchLike;
  private readonly runner: ProcessRunner;
  private readonly claudeCliDetector: (() => Promise<boolean>) | undefined;
  private claudeCliProbe: { at: number; available: boolean } | undefined;

  public constructor(
    private readonly project: CoordinatorProject,
    options: ProviderChatServiceOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    this.runner = options.runner ?? runProcess;
    this.claudeCliDetector = options.claudeCliDetector;
  }

  private get secretsPath(): string {
    return path.join(this.project.directory, "secrets", "provider-connections.json");
  }

  private async readConnections(): Promise<ConnectionFile> {
    try {
      return JSON.parse(await readFile(this.secretsPath, "utf8")) as ConnectionFile;
    } catch {
      return {};
    }
  }

  private async writeConnections(file: ConnectionFile): Promise<void> {
    await mkdir(path.dirname(this.secretsPath), { recursive: true });
    await writeFile(this.secretsPath, JSON.stringify(file, undefined, 2), "utf8");
  }

  private async connectionFor(
    userId: string,
    provider: ProviderId,
  ): Promise<StoredConnection | undefined> {
    return (await this.readConnections())[userId]?.[provider];
  }

  private async localClaudeAvailable(): Promise<boolean> {
    if (this.claudeCliDetector !== undefined) {
      return await this.claudeCliDetector();
    }
    const now = Date.now();
    if (this.claudeCliProbe !== undefined && now - this.claudeCliProbe.at < 300_000) {
      return this.claudeCliProbe.available;
    }
    let available = false;
    try {
      // Windows npm shims need resolving to the native executable before a
      // shell-less spawn can find them.
      const result = await this.runner(resolveClaudeCommand("claude"), ["--version"], {
        timeoutMs: 30_000,
        maxOutputBytes: 65_536,
      });
      available = result.exitCode === 0;
    } catch {
      available = false;
    }
    this.claudeCliProbe = { at: now, available };
    return available;
  }

  public async list(input: {
    userId: string;
    systemAdmin: boolean;
  }): Promise<ProviderStatus[]> {
    const connections = (await this.readConnections())[input.userId] ?? {};
    const localCli = await this.localClaudeAvailable();
    return PROVIDER_IDS.map((id) => {
      const connection = connections[id];
      return {
        id,
        name: PROVIDER_NAMES[id],
        connected:
          connection !== undefined &&
          // A local-cli connection is only usable by an administrator; a
          // demoted account sees it as disconnected rather than broken.
          (connection.kind !== "local-cli" || input.systemAdmin),
        ...(connection === undefined ? {} : { kind: connection.kind }),
        model: defaultModel(id),
        exposesThinking: id !== "openai",
        ...(id === "anthropic"
          ? { localCliAvailable: localCli, localCliRequiresAdmin: true }
          : {}),
      };
    });
  }

  public async connect(input: {
    userId: string;
    systemAdmin: boolean;
    provider: ProviderId;
    kind: ConnectionKind;
    apiKey?: string;
  }): Promise<ProviderStatus[]> {
    if (input.kind === "local-cli") {
      if (input.provider !== "anthropic") {
        throw new ProviderChatError(
          400,
          "unsupported_connection",
          "Only Anthropic supports the local CLI connection on this host",
        );
      }
      if (!input.systemAdmin) {
        throw new ProviderChatError(
          403,
          "admin_required",
          "The local claude CLI belongs to the host owner; only a system administrator can connect it",
        );
      }
      if (!(await this.localClaudeAvailable())) {
        throw new ProviderChatError(
          409,
          "cli_unavailable",
          "No usable claude CLI was found on this host",
        );
      }
    } else {
      const apiKey = (input.apiKey ?? "").trim();
      if (apiKey.length < 8 || apiKey.length > 512 || /\s/u.test(apiKey)) {
        throw new ProviderChatError(400, "invalid_key", "API key looks invalid");
      }
      await this.validateApiKey(input.provider, apiKey);
    }

    const file = await this.readConnections();
    file[input.userId] = {
      ...file[input.userId],
      [input.provider]: {
        kind: input.kind,
        ...(input.kind === "api-key" ? { apiKey: input.apiKey?.trim() } : {}),
        createdAt: new Date().toISOString(),
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

  /** A free authenticated call proves the key without spending tokens. */
  private async validateApiKey(
    provider: ProviderId,
    apiKey: string,
  ): Promise<void> {
    const targets: Record<ProviderId, { url: string; headers: Record<string, string> }> = {
      anthropic: {
        url: "https://api.anthropic.com/v1/models?limit=1",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      },
      openai: {
        url: "https://api.openai.com/v1/models",
        headers: { Authorization: `Bearer ${apiKey}` },
      },
      google: {
        url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
        headers: { "x-goog-api-key": apiKey },
      },
    };
    const target = targets[provider];
    let response;
    try {
      response = await this.fetchImpl(target.url, {
        method: "GET",
        headers: target.headers,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ProviderChatError(
        502,
        "provider_unreachable",
        `${PROVIDER_NAMES[provider]} could not be reached: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!response.ok) {
      throw new ProviderChatError(
        response.status === 401 || response.status === 403 ? 401 : 502,
        "key_rejected",
        `${PROVIDER_NAMES[provider]} rejected the key (HTTP ${response.status})`,
      );
    }
  }

  public async complete(input: {
    userId: string;
    systemAdmin: boolean;
    provider: ProviderId;
    messages: unknown;
    cliSessionId?: string;
  }): Promise<ChatReply> {
    const messages = assertMessages(input.messages);
    const connection = await this.connectionFor(input.userId, input.provider);
    if (connection === undefined) {
      throw new ProviderChatError(
        409,
        "not_connected",
        `Connect ${PROVIDER_NAMES[input.provider]} before chatting`,
      );
    }
    if (connection.kind === "local-cli") {
      if (!input.systemAdmin) {
        throw new ProviderChatError(
          403,
          "admin_required",
          "The local CLI connection is restricted to system administrators",
        );
      }
      return await this.completeViaClaudeCli(messages, input.cliSessionId);
    }
    const apiKey = connection.apiKey ?? "";
    switch (input.provider) {
      case "anthropic":
        return await this.completeAnthropic(apiKey, messages);
      case "openai":
        return await this.completeOpenAi(apiKey, messages);
      case "google":
        return await this.completeGoogle(apiKey, messages);
    }
  }

  private async providerFetch(
    provider: ProviderId,
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ) {
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ProviderChatError(
        502,
        "provider_unreachable",
        `${PROVIDER_NAMES[provider]} could not be reached: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new ProviderChatError(
        response.status === 401 || response.status === 403 ? 401 : 502,
        "provider_error",
        `${PROVIDER_NAMES[provider]} answered HTTP ${response.status}: ${detail}`,
      );
    }
    return response;
  }

  private async completeAnthropic(
    apiKey: string,
    messages: ChatMessage[],
  ): Promise<ChatReply> {
    const model = defaultModel("anthropic");
    const response = await this.providerFetch(
      "anthropic",
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      {
        model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        thinking: { type: "enabled", budget_tokens: ANTHROPIC_THINKING_BUDGET },
        messages,
      },
    );
    const body = (await response.json()) as {
      content?: Array<{ type: string; text?: string; thinking?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const blocks = body.content ?? [];
    const thinking = blocks
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking ?? "")
      .join("\n\n");
    const text = blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    const rateLimit: ChatRateLimit = { source: "response-headers" };
    const requestsRemaining = headerNumber(
      response.headers,
      "anthropic-ratelimit-requests-remaining",
    );
    const requestsLimit = headerNumber(
      response.headers,
      "anthropic-ratelimit-requests-limit",
    );
    const tokensRemaining = headerNumber(
      response.headers,
      "anthropic-ratelimit-tokens-remaining",
    );
    const tokensLimit = headerNumber(
      response.headers,
      "anthropic-ratelimit-tokens-limit",
    );
    if (requestsRemaining !== undefined) rateLimit.requestsRemaining = requestsRemaining;
    if (requestsLimit !== undefined) rateLimit.requestsLimit = requestsLimit;
    if (tokensRemaining !== undefined) rateLimit.tokensRemaining = tokensRemaining;
    if (tokensLimit !== undefined) rateLimit.tokensLimit = tokensLimit;
    return {
      provider: "anthropic",
      model,
      text,
      ...(thinking.length > 0 ? { thinking } : {}),
      usage: {
        ...(body.usage?.input_tokens === undefined
          ? {}
          : { inputTokens: body.usage.input_tokens }),
        ...(body.usage?.output_tokens === undefined
          ? {}
          : { outputTokens: body.usage.output_tokens }),
      },
      ...(Object.keys(rateLimit).length > 1 ? { rateLimit } : {}),
    };
  }

  private async completeOpenAi(
    apiKey: string,
    messages: ChatMessage[],
  ): Promise<ChatReply> {
    const model = defaultModel("openai");
    const response = await this.providerFetch(
      "openai",
      "https://api.openai.com/v1/chat/completions",
      { Authorization: `Bearer ${apiKey}` },
      { model, messages, max_completion_tokens: 4_096 },
    );
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    const reasoningTokens = body.usage?.completion_tokens_details?.reasoning_tokens;
    const rateLimit: ChatRateLimit = { source: "response-headers" };
    const requestsRemaining = headerNumber(response.headers, "x-ratelimit-remaining-requests");
    const requestsLimit = headerNumber(response.headers, "x-ratelimit-limit-requests");
    const tokensRemaining = headerNumber(response.headers, "x-ratelimit-remaining-tokens");
    const tokensLimit = headerNumber(response.headers, "x-ratelimit-limit-tokens");
    if (requestsRemaining !== undefined) rateLimit.requestsRemaining = requestsRemaining;
    if (requestsLimit !== undefined) rateLimit.requestsLimit = requestsLimit;
    if (tokensRemaining !== undefined) rateLimit.tokensRemaining = tokensRemaining;
    if (tokensLimit !== undefined) rateLimit.tokensLimit = tokensLimit;
    return {
      provider: "openai",
      model,
      text: body.choices?.[0]?.message?.content ?? "",
      // OpenAI counts reasoning tokens but does not return the content.
      ...(reasoningTokens !== undefined && reasoningTokens > 0
        ? { thinkingHidden: true }
        : {}),
      usage: {
        ...(body.usage?.prompt_tokens === undefined
          ? {}
          : { inputTokens: body.usage.prompt_tokens }),
        ...(body.usage?.completion_tokens === undefined
          ? {}
          : { outputTokens: body.usage.completion_tokens }),
        ...(reasoningTokens === undefined
          ? {}
          : { thinkingTokens: reasoningTokens }),
      },
      ...(Object.keys(rateLimit).length > 1 ? { rateLimit } : {}),
    };
  }

  private async completeGoogle(
    apiKey: string,
    messages: ChatMessage[],
  ): Promise<ChatReply> {
    const model = defaultModel("google");
    const response = await this.providerFetch(
      "google",
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { "x-goog-api-key": apiKey },
      {
        contents: messages.map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.content }],
        })),
        generationConfig: { thinkingConfig: { includeThoughts: true } },
      },
    );
    const body = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
      };
    };
    const parts = body.candidates?.[0]?.content?.parts ?? [];
    const thinking = parts
      .filter((part) => part.thought === true)
      .map((part) => part.text ?? "")
      .join("\n\n");
    const text = parts
      .filter((part) => part.thought !== true)
      .map((part) => part.text ?? "")
      .join("");
    const usage = body.usageMetadata;
    return {
      provider: "google",
      model,
      text,
      ...(thinking.length > 0 ? { thinking } : {}),
      usage: {
        ...(usage?.promptTokenCount === undefined
          ? {}
          : { inputTokens: usage.promptTokenCount }),
        ...(usage?.candidatesTokenCount === undefined
          ? {}
          : { outputTokens: usage.candidatesTokenCount }),
        ...(usage?.thoughtsTokenCount === undefined
          ? {}
          : { thinkingTokens: usage.thoughtsTokenCount }),
      },
      // Google sends no rate-limit headers on this API; the UI falls back to
      // session totals rather than inventing a quota.
    };
  }

  /**
   * Headless claude CLI completion.
   *
   * Multi-turn continuity uses the CLI's own `--resume <session>`; only the
   * newest user message travels each call. The process runs in a per-call
   * empty scratch directory with default permissions: read-only tools see an
   * empty folder and anything needing approval is denied because nothing can
   * grant it. Verified live: a prompt asking for a bash write is refused.
   */
  private async completeViaClaudeCli(
    messages: ChatMessage[],
    cliSessionId: string | undefined,
  ): Promise<ChatReply> {
    const latest = messages.at(-1);
    if (latest === undefined || latest.role !== "user") {
      throw new ProviderChatError(
        400,
        "invalid_messages",
        "The last message must be from the user",
      );
    }
    // One stable, empty directory for every chat call: claude scopes its
    // session store to the working directory, so --resume only works when
    // the continuation runs from the same place.
    const scratch = path.join(os.tmpdir(), "coord-provider-chat");
    await mkdir(scratch, { recursive: true });
    const model = defaultModel("anthropic");
    const resumable =
      cliSessionId !== undefined && /^[A-Za-z0-9-]{8,64}$/u.test(cliSessionId);
    // The prompt travels as a positional argument, not stdin: verified live
    // that piped prompts make the CLI suppress its thinking blocks, and the
    // reasoning display is the point. Cost: the prompt is visible in the
    // host's process list for the duration of the call — acceptable for a
    // single-owner control plane, and the reason this connection is
    // admin-only. Very long prompts fall back to stdin (argv limits), which
    // silently loses thinking for that one turn.
    const usePositional = latest.content.length <= 8_000;
    const argsFor = (resume: boolean) => [
      "-p",
      ...(usePositional ? [latest.content] : []),
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      model,
      // High effort turns on the model's extended thinking, which is what
      // makes reasoning content appear in the stream to display.
      "--effort",
      "high",
      ...(resume ? ["--resume", cliSessionId as string] : []),
    ];
    const runOnce = async (resume: boolean): Promise<ProcessOutput> => {
      try {
        return await this.runner(resolveClaudeCommand("claude"), argsFor(resume), {
          cwd: scratch,
          ...(usePositional ? {} : { input: latest.content }),
          timeoutMs: CLI_TIMEOUT_MS,
          maxOutputBytes: 8 * 1024 * 1024,
        });
      } catch (error) {
        throw new ProviderChatError(
          502,
          "cli_failed",
          `The local claude CLI failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    };
    let output = await runOnce(resumable);
    if (output.exitCode !== 0 && resumable) {
      // A session id can go stale (server restart, CLI cleanup). Losing the
      // model-side memory of the thread beats failing the message.
      output = await runOnce(false);
    }
    if (output.exitCode !== 0) {
      throw new ProviderChatError(
        502,
        "cli_failed",
        `The local claude CLI exited ${output.exitCode}: ${
          output.stderr.trim().slice(0, 400) || output.stdout.trim().slice(0, 400)
        }`,
      );
    }
    return parseClaudeStreamJson(output.stdout, model);
  }
}

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
        | { content?: Array<{ type?: string; text?: string; thinking?: string }> }
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
        | {
            status?: string;
            resetsAt?: number;
            rateLimitType?: string;
          }
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
  };
}
