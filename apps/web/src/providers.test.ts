import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoordinatorProject } from "@coord/cli/project";

import {
  ProviderChatError,
  ProviderChatService,
  parseClaudeStreamJson,
  parseCodexJsonl,
  type ProcessRunner,
} from "./providers.js";

/**
 * Provider chat signs in with real vendor-CLI accounts and spends the host
 * owner's subscriptions, so the tests concentrate on the boundaries: nothing
 * connects without a detected, signed-in CLI; everything is admin-gated; a
 * signed-in-but-ineligible account (Google) is refused with the provider's
 * own reason; settings only accept what the account actually reports; and
 * every number shown traces to a field a CLI actually emitted.
 */

interface Harness {
  project: CoordinatorProject;
  home: string;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cproviders-"));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const project = await CoordinatorProject.init(path.join(root, "cp"));
  return { project, home };
}

function output(stdout: string, exitCode = 0, stderr = "") {
  return { exitCode, stdout, stderr, durationMs: 1 };
}

/** A runner scripted per command word (node+entry.js counts as the entry). */
function scriptedRunner(
  script: Record<string, (args: readonly string[]) => ReturnType<typeof output>>,
): ProcessRunner {
  return (async (command: string, args: readonly string[]) => {
    let name = path.basename(String(command)).replace(/\.exe$/iu, "");
    let effectiveArgs = args;
    if (name === "node" && typeof args[0] === "string") {
      name = path.basename(args[0]).replace(/\.js$/iu, "");
      effectiveArgs = args.slice(1);
    }
    const handler = script[name];
    if (handler === undefined) {
      return output("", 127, `${name}: not scripted`);
    }
    return handler(effectiveArgs);
  }) as ProcessRunner;
}

const CLAUDE_OK = {
  claude: (args: readonly string[]) =>
    args[0] === "auth"
      ? output(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }))
      : output(
          [
            JSON.stringify({
              type: "assistant",
              message: { content: [{ type: "text", text: "hi" }] },
            }),
            JSON.stringify({
              type: "result",
              is_error: false,
              result: "hi",
              session_id: "sess-1234",
              usage: { input_tokens: 1, output_tokens: 2 },
            }),
          ].join("\n"),
        ),
};

async function seedCodexCache(home: string): Promise<void> {
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(
    path.join(home, ".codex", "models_cache.json"),
    JSON.stringify({
      models: [
        {
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6-Sol",
          description: "Frontier",
          default_reasoning_level: "low",
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "high" },
            { effort: "xhigh" },
          ],
        },
        {
          slug: "gpt-5.5",
          display_name: "GPT-5.5",
          supported_reasoning_levels: [{ effort: "medium" }],
        },
      ],
    }),
    "utf8",
  );
}

test("nothing connects without a detected, signed-in CLI", async () => {
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      claude: (args) =>
        args[0] === "auth"
          ? output(JSON.stringify({ loggedIn: false }))
          : output(""),
    }),
  });
  await assert.rejects(
    service.connect({ userId: "u", systemAdmin: true, provider: "anthropic" }),
    (error: unknown) =>
      error instanceof ProviderChatError && error.code === "not_signed_in",
  );
  await assert.rejects(
    service.connect({ userId: "u", systemAdmin: true, provider: "openai" }),
    (error: unknown) =>
      error instanceof ProviderChatError && error.code === "cli_unavailable",
  );
});

test("connections are admin-only and per user", async () => {
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner(CLAUDE_OK),
  });
  await assert.rejects(
    service.connect({ userId: "u", systemAdmin: false, provider: "anthropic" }),
    (error: unknown) =>
      error instanceof ProviderChatError && error.code === "admin_required",
  );
  await service.connect({
    userId: "admin_a",
    systemAdmin: true,
    provider: "anthropic",
  });
  const forA = await service.list({ userId: "admin_a", systemAdmin: true });
  const forB = await service.list({ userId: "admin_b", systemAdmin: true });
  assert.equal(forA.find((p) => p.id === "anthropic")?.connected, true);
  assert.equal(forB.find((p) => p.id === "anthropic")?.connected, false);

  await service.disconnect({ userId: "admin_a", provider: "anthropic" });
  const after = await service.list({ userId: "admin_a", systemAdmin: true });
  assert.equal(after.find((p) => p.id === "anthropic")?.connected, false);
});

test("a signed-in but ineligible Google account is refused with its own reason", async () => {
  const harness = await createHarness();
  await mkdir(path.join(harness.home, ".gemini"), { recursive: true });
  await writeFile(
    path.join(harness.home, ".gemini", "google_accounts.json"),
    JSON.stringify({ active: "someone@corp.example" }),
    "utf8",
  );
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      gemini: (args) =>
        args[0] === "--version"
          ? output("0.9.0")
          : output(
              "",
              1,
              "Error authenticating: IneligibleTierError: Your current account is not eligible",
            ),
    }),
  });
  await assert.rejects(
    service.connect({ userId: "u", systemAdmin: true, provider: "google" }),
    (error: unknown) =>
      error instanceof ProviderChatError &&
      error.code === "provider_blocked" &&
      /someone@corp\.example/u.test(error.message) &&
      /IneligibleTierError/u.test(error.message),
  );
});

test("openai options come from the account's own models cache and settings are validated against them", async () => {
  const harness = await createHarness();
  await seedCodexCache(harness.home);
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      codex: (args) =>
        args[0] === "--version"
          ? output("codex-cli 0.146.0")
          : args[0] === "login"
            ? output("Logged in using ChatGPT")
            : output(""),
    }),
  });
  const options = await service.options({ provider: "openai" });
  assert.deepEqual(
    options.models?.map((model) => model.id),
    ["gpt-5.6-sol", "gpt-5.5"],
  );
  assert.deepEqual(options.models?.[0]?.efforts, ["low", "high", "xhigh"]);
  assert.equal(options.allowCustomModel, false);

  await service.connect({ userId: "u", systemAdmin: true, provider: "openai" });
  await service.setSettings({
    userId: "u",
    provider: "openai",
    model: "gpt-5.6-sol",
    effort: "xhigh",
  });
  await assert.rejects(
    service.setSettings({ userId: "u", provider: "openai", model: "gpt-9" }),
    (error: unknown) =>
      error instanceof ProviderChatError && error.code === "invalid_model",
  );
  await assert.rejects(
    service.setSettings({
      userId: "u",
      provider: "openai",
      model: "gpt-5.5",
      effort: "ultra",
    }),
    (error: unknown) =>
      error instanceof ProviderChatError && error.code === "invalid_effort",
  );
});

test("anthropic exposes no model list, says so, and validates effort against the real enum", async () => {
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner(CLAUDE_OK),
  });
  const options = await service.options({ provider: "anthropic" });
  assert.equal(options.models, null);
  assert.equal(options.allowCustomModel, true);
  assert.ok(options.notes.some((note) => /does not publish a model list/u.test(note)));
  assert.deepEqual(options.efforts, ["low", "medium", "high", "xhigh", "max"]);

  await service.connect({
    userId: "u",
    systemAdmin: true,
    provider: "anthropic",
  });
  await service.setSettings({
    userId: "u",
    provider: "anthropic",
    model: "claude-opus-5",
    effort: "max",
  });
  await assert.rejects(
    service.setSettings({ userId: "u", provider: "anthropic", effort: "ultra" }),
    (error: unknown) =>
      error instanceof ProviderChatError && error.code === "invalid_effort",
  );
});

test("codex completions carry the chosen model, effort, and read-only sandbox", async () => {
  const harness = await createHarness();
  await seedCodexCache(harness.home);
  const seen: string[][] = [];
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      codex: (args) => {
        if (args[0] === "--version") return output("codex-cli 0.146.0");
        if (args[0] === "login") return output("Logged in using ChatGPT");
        seen.push([...args]);
        return output(
          [
            JSON.stringify({ type: "thread.started", thread_id: "th-1" }),
            JSON.stringify({
              type: "item.completed",
              item: { type: "reasoning", text: "Summarised reasoning." },
            }),
            JSON.stringify({
              type: "item.completed",
              item: { type: "agent_message", text: "pong" },
            }),
            JSON.stringify({
              type: "turn.completed",
              usage: {
                input_tokens: 11484,
                cached_input_tokens: 1920,
                output_tokens: 5,
                reasoning_output_tokens: 64,
              },
            }),
          ].join("\n"),
        );
      },
    }),
  });
  await service.connect({ userId: "u", systemAdmin: true, provider: "openai" });
  await service.setSettings({
    userId: "u",
    provider: "openai",
    model: "gpt-5.6-sol",
    effort: "high",
  });
  const reply = await service.complete({
    userId: "u",
    systemAdmin: true,
    provider: "openai",
    messages: [{ role: "user", content: "ping" }],
  });
  assert.equal(reply.text, "pong");
  assert.equal(reply.thinking, "Summarised reasoning.");
  assert.deepEqual(reply.usage, {
    inputTokens: 11484,
    cachedInputTokens: 1920,
    outputTokens: 5,
    thinkingTokens: 64,
  });
  assert.equal(reply.cliSessionId, "th-1");
  const args = seen[0] ?? [];
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--sandbox") && args.includes("read-only"));
  assert.ok(args.includes("-m") && args.includes("gpt-5.6-sol"));
  assert.ok(args.some((a) => a.includes("model_reasoning_effort")));
});

test("messages are validated before any CLI is spawned", async () => {
  const harness = await createHarness();
  let completions = 0;
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      claude: (args) => {
        if (args[0] === "auth") {
          return output(JSON.stringify({ loggedIn: true }));
        }
        completions += 1;
        return output("");
      },
    }),
  });
  await service.connect({
    userId: "u",
    systemAdmin: true,
    provider: "anthropic",
  });
  for (const bad of [
    [],
    [{ role: "system", content: "x" }],
    [{ role: "user", content: "" }],
    Array.from({ length: 41 }, () => ({ role: "user", content: "x" })),
  ]) {
    await assert.rejects(
      service.complete({
        userId: "u",
        systemAdmin: true,
        provider: "anthropic",
        messages: bad,
      }),
      (error: unknown) =>
        error instanceof ProviderChatError && error.code === "invalid_messages",
    );
  }
  assert.equal(completions, 0);
});

test("claude stream-json parsing keeps every number the CLI reported", () => {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1_785_348_000,
        rateLimitType: "five_hour",
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "23*19 = 23*20 - 23." },
          { type: "text", text: "437" },
        ],
      },
    }),
    JSON.stringify({
      type: "result",
      is_error: false,
      result: "437",
      session_id: "abc-123",
      total_cost_usd: 0.0123,
      usage: { input_tokens: 12, output_tokens: 88 },
    }),
  ].join("\n");
  const reply = parseClaudeStreamJson(lines, "claude-sonnet-5");
  assert.equal(reply.text, "437");
  assert.equal(reply.thinking, "23*19 = 23*20 - 23.");
  assert.equal(reply.thinkingHidden, undefined);
  assert.deepEqual(reply.usage, {
    inputTokens: 12,
    outputTokens: 88,
    costUsd: 0.0123,
  });
  assert.equal(reply.rateLimit?.windowKind, "five_hour");
  assert.equal(reply.cliSessionId, "abc-123");
});

test("redacted CLI thinking becomes hidden reasoning with real token counts", () => {
  const lines = [
    JSON.stringify({
      type: "system",
      subtype: "thinking_tokens",
      estimated_tokens: 85,
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "", signature: "abc" },
          { type: "text", text: "306,614" },
        ],
      },
    }),
    JSON.stringify({
      type: "result",
      is_error: false,
      result: "306,614",
      session_id: "s-1",
      usage: { input_tokens: 5, output_tokens: 40 },
    }),
  ].join("\n");
  const reply = parseClaudeStreamJson(lines, "claude-sonnet-5");
  assert.equal(reply.thinking, undefined);
  assert.equal(reply.thinkingHidden, true);
  assert.equal(reply.usage.thinkingTokens, 85);
});

test("codex jsonl failures and truncated streams are loud", () => {
  assert.throws(
    () => parseCodexJsonl("", "m"),
    /no completed turn/u,
  );
  assert.throws(
    () =>
      parseCodexJsonl(
        JSON.stringify({ type: "error", message: "stream disconnected" }),
        "m",
      ),
    /stream disconnected/u,
  );
});
