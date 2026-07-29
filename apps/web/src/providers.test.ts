import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoordinatorProject } from "@coord/cli/project";

import {
  ProviderChatError,
  ProviderChatService,
  parseClaudeStreamJson,
  type FetchLike,
} from "./providers.js";

/**
 * The provider chat spends other people's money with other people's keys, so
 * the tests concentrate on the boundaries: keys are validated before being
 * stored, users cannot see or use each other's connections, the local CLI
 * path is admin-only, and every number shown in the UI traces to a field a
 * provider actually returned.
 */

async function createProject(): Promise<CoordinatorProject> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cproviders-"));
  await mkdir(root, { recursive: true });
  return await CoordinatorProject.init(root);
}

function fakeResponse(input: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  const headers = new Map(
    Object.entries(input.headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  return {
    ok: input.ok ?? true,
    status: input.status ?? 200,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    json: async () => input.body ?? {},
    text: async () => JSON.stringify(input.body ?? {}),
  };
}

test("an API key is validated before it is stored, and rejection is loud", async () => {
  const project = await createProject();
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    return fakeResponse({ ok: false, status: 401 });
  };
  const service = new ProviderChatService(project, {
    fetchImpl,
    claudeCliDetector: async () => false,
  });

  await assert.rejects(
    service.connect({
      userId: "user_a",
      systemAdmin: false,
      provider: "anthropic",
      kind: "api-key",
      apiKey: "sk-ant-invalid-key",
    }),
    (error: unknown) =>
      error instanceof ProviderChatError && error.code === "key_rejected",
  );
  assert.ok(calls[0]?.includes("api.anthropic.com/v1/models"));

  const providers = await service.list({ userId: "user_a", systemAdmin: false });
  assert.equal(providers.find((p) => p.id === "anthropic")?.connected, false);
});

test("connections are per user and never leak between accounts", async () => {
  const project = await createProject();
  const fetchImpl: FetchLike = async () => fakeResponse({});
  const service = new ProviderChatService(project, {
    fetchImpl,
    claudeCliDetector: async () => false,
  });

  await service.connect({
    userId: "user_a",
    systemAdmin: false,
    provider: "openai",
    kind: "api-key",
    apiKey: "sk-user-a-key-000000",
  });

  const forA = await service.list({ userId: "user_a", systemAdmin: false });
  const forB = await service.list({ userId: "user_b", systemAdmin: false });
  assert.equal(forA.find((p) => p.id === "openai")?.connected, true);
  assert.equal(forB.find((p) => p.id === "openai")?.connected, false);

  await assert.rejects(
    service.complete({
      userId: "user_b",
      systemAdmin: false,
      provider: "openai",
      messages: [{ role: "user", content: "hi" }],
    }),
    (error: unknown) =>
      error instanceof ProviderChatError && error.code === "not_connected",
  );

  await service.disconnect({ userId: "user_a", provider: "openai" });
  const after = await service.list({ userId: "user_a", systemAdmin: false });
  assert.equal(after.find((p) => p.id === "openai")?.connected, false);
});

test("the local CLI connection is admin-only and Anthropic-only", async () => {
  const project = await createProject();
  const service = new ProviderChatService(project, {
    fetchImpl: async () => fakeResponse({}),
    claudeCliDetector: async () => true,
  });

  await assert.rejects(
    service.connect({
      userId: "user_a",
      systemAdmin: false,
      provider: "anthropic",
      kind: "local-cli",
    }),
    (error: unknown) =>
      error instanceof ProviderChatError && error.code === "admin_required",
  );
  await assert.rejects(
    service.connect({
      userId: "admin",
      systemAdmin: true,
      provider: "openai",
      kind: "local-cli",
    }),
    (error: unknown) =>
      error instanceof ProviderChatError &&
      error.code === "unsupported_connection",
  );

  await service.connect({
    userId: "admin",
    systemAdmin: true,
    provider: "anthropic",
    kind: "local-cli",
  });
  const asAdmin = await service.list({ userId: "admin", systemAdmin: true });
  assert.equal(asAdmin.find((p) => p.id === "anthropic")?.connected, true);
  // A demoted account no longer counts as connected through the host CLI.
  const demoted = await service.list({ userId: "admin", systemAdmin: false });
  assert.equal(demoted.find((p) => p.id === "anthropic")?.connected, false);
});

test("anthropic replies carry thinking, usage, and rate-limit headers", async () => {
  const project = await createProject();
  const service = new ProviderChatService(project, {
    fetchImpl: async (url) => {
      if (url.includes("/v1/models")) {
        return fakeResponse({});
      }
      return fakeResponse({
        body: {
          content: [
            { type: "thinking", thinking: "Let me reason about this." },
            { type: "text", text: "The answer is 42." },
          ],
          usage: { input_tokens: 17, output_tokens: 130 },
        },
        headers: {
          "anthropic-ratelimit-tokens-remaining": "39000",
          "anthropic-ratelimit-tokens-limit": "40000",
          "anthropic-ratelimit-requests-remaining": "58",
          "anthropic-ratelimit-requests-limit": "60",
        },
      });
    },
    claudeCliDetector: async () => false,
  });
  await service.connect({
    userId: "u",
    systemAdmin: false,
    provider: "anthropic",
    kind: "api-key",
    apiKey: "sk-ant-test-0000000",
  });
  const reply = await service.complete({
    userId: "u",
    systemAdmin: false,
    provider: "anthropic",
    messages: [{ role: "user", content: "What is the answer?" }],
  });
  assert.equal(reply.text, "The answer is 42.");
  assert.equal(reply.thinking, "Let me reason about this.");
  assert.deepEqual(reply.usage, { inputTokens: 17, outputTokens: 130 });
  assert.equal(reply.rateLimit?.source, "response-headers");
  assert.equal(reply.rateLimit?.tokensRemaining, 39000);
  assert.equal(reply.rateLimit?.tokensLimit, 40000);
});

test("openai reasoning tokens are counted but marked as hidden content", async () => {
  const project = await createProject();
  const service = new ProviderChatService(project, {
    fetchImpl: async (url) => {
      if (url.includes("/v1/models")) {
        return fakeResponse({});
      }
      return fakeResponse({
        body: {
          choices: [{ message: { content: "Done." } }],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 300,
            completion_tokens_details: { reasoning_tokens: 250 },
          },
        },
        headers: {
          "x-ratelimit-remaining-tokens": "199000",
          "x-ratelimit-limit-tokens": "200000",
        },
      });
    },
    claudeCliDetector: async () => false,
  });
  await service.connect({
    userId: "u",
    systemAdmin: false,
    provider: "openai",
    kind: "api-key",
    apiKey: "sk-test-000000000",
  });
  const reply = await service.complete({
    userId: "u",
    systemAdmin: false,
    provider: "openai",
    messages: [{ role: "user", content: "Do the thing" }],
  });
  assert.equal(reply.text, "Done.");
  assert.equal(reply.thinking, undefined);
  assert.equal(reply.thinkingHidden, true);
  assert.equal(reply.usage.thinkingTokens, 250);
  assert.equal(reply.rateLimit?.tokensRemaining, 199000);
});

test("google thought parts become the reasoning section; no rate limit is invented", async () => {
  const project = await createProject();
  const service = new ProviderChatService(project, {
    fetchImpl: async (url) => {
      if (url.includes("/v1beta/models?")) {
        return fakeResponse({});
      }
      return fakeResponse({
        body: {
          candidates: [
            {
              content: {
                parts: [
                  { text: "Considering the constraints…", thought: true },
                  { text: "Here is the plan." },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 11,
            candidatesTokenCount: 90,
            thoughtsTokenCount: 40,
          },
        },
      });
    },
    claudeCliDetector: async () => false,
  });
  await service.connect({
    userId: "u",
    systemAdmin: false,
    provider: "google",
    kind: "api-key",
    apiKey: "AIza-test-000000000",
  });
  const reply = await service.complete({
    userId: "u",
    systemAdmin: false,
    provider: "google",
    messages: [{ role: "user", content: "Plan something" }],
  });
  assert.equal(reply.text, "Here is the plan.");
  assert.equal(reply.thinking, "Considering the constraints…");
  assert.deepEqual(reply.usage, {
    inputTokens: 11,
    outputTokens: 90,
    thinkingTokens: 40,
  });
  assert.equal(reply.rateLimit, undefined);
});

test("messages are validated before any provider is called", async () => {
  const project = await createProject();
  let called = 0;
  const service = new ProviderChatService(project, {
    fetchImpl: async () => {
      called += 1;
      return fakeResponse({});
    },
    claudeCliDetector: async () => false,
  });
  await service.connect({
    userId: "u",
    systemAdmin: false,
    provider: "openai",
    kind: "api-key",
    apiKey: "sk-test-000000000",
  });
  const validationCalls = called;
  for (const bad of [
    [],
    [{ role: "system", content: "x" }],
    [{ role: "user", content: "" }],
    Array.from({ length: 41 }, () => ({ role: "user", content: "x" })),
  ]) {
    await assert.rejects(
      service.complete({
        userId: "u",
        systemAdmin: false,
        provider: "openai",
        messages: bad,
      }),
      (error: unknown) =>
        error instanceof ProviderChatError && error.code === "invalid_messages",
    );
  }
  assert.equal(called, validationCalls);
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
  assert.deepEqual(reply.usage, {
    inputTokens: 12,
    outputTokens: 88,
    costUsd: 0.0123,
  });
  assert.equal(reply.rateLimit?.source, "cli-window");
  assert.equal(reply.rateLimit?.windowKind, "five_hour");
  assert.equal(reply.rateLimit?.windowStatus, "allowed");
  assert.equal(reply.cliSessionId, "abc-123");

  assert.throws(
    () => parseClaudeStreamJson("not json at all", "m"),
    /no result event/u,
  );
  assert.throws(
    () =>
      parseClaudeStreamJson(
        JSON.stringify({ type: "result", is_error: true, result: "boom" }),
        "m",
      ),
    /reported an error/u,
  );
});
