import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoordinatorProject } from "@coord/cli/project";
import { UserCredentialStore } from "@coord/workspace-manager";

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

/** Mirrors `MODEL_VALUE` in providers.ts: what the settings route will take. */
const MODEL_VALUE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/u;

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
  // A reported list is the authority, so nothing is suggested alongside it —
  // a guess sitting next to the account's own answer is the exact confusion
  // the separate field exists to prevent.
  assert.equal(options.suggestedModels, undefined);
  assert.equal(options.suggestedEfforts, undefined);

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

test("a sign-in's model list is kept, so the account's own models replace the suggestions", async () => {
  // The gap this closes: sign-in runs the CLI against a throwaway CODEX_HOME
  // so the host's keys stay out of the captured credential, and the model list
  // the CLI caches there is discarded with the directory. The reader looks in
  // `~/.codex`; the writer only ever writes to a temp dir; they never meet, so
  // every deployment fell back to suggested names no matter how many times
  // somebody signed in.
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      codex: (args) =>
        args[0] === "--version" ? output("codex-cli 0.146.0") : output(""),
    }),
  });

  // Before: nothing reported, so the picker runs on suggestions.
  const before = await service.options({ provider: "openai" });
  assert.equal(before.models, null);
  // Nothing offered before the account reports one — a suggested model name
  // is a guess about someone else's entitlements, and the point of this test
  // is what replaces it, not that a placeholder was there first.
  assert.equal((before.suggestedModels ?? []).length, 0);

  // A sign-in leaves a model list behind in its throwaway home.
  const flowHome = path.join(harness.home, "throwaway-device-home");
  await mkdir(flowHome, { recursive: true });
  await writeFile(
    path.join(flowHome, "models_cache.json"),
    JSON.stringify({
      models: [
        {
          slug: "codex-house-model",
          display_name: "Codex House Model",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
        },
      ],
    }),
    "utf8",
  );
  await (
    service as unknown as {
      captureCodexModelCache(home: string): Promise<void>;
    }
  ).captureCodexModelCache(flowHome);

  // After: the account's own list, and no suggestions beside it to be
  // mistaken for reported models.
  const after = await service.options({ provider: "openai" });
  assert.deepEqual(
    after.models?.map((model) => model.id),
    ["codex-house-model"],
  );
  assert.deepEqual(after.models?.[0]?.efforts, ["low", "high"]);
  assert.equal(after.suggestedModels, undefined);
  assert.equal(after.allowCustomModel, false);

  // A later unreadable or empty cache must not wipe a good one.
  await writeFile(path.join(flowHome, "models_cache.json"), "{oops", "utf8");
  await (
    service as unknown as {
      captureCodexModelCache(home: string): Promise<void>;
    }
  ).captureCodexModelCache(flowHome);
  assert.deepEqual(
    (await service.options({ provider: "openai" })).models?.map((m) => m.id),
    ["codex-house-model"],
  );
});

test("openai with no cached model list stays usable instead of refusing everything", async () => {
  // The shipped control plane is this case, not the one above: every Codex
  // invocation runs against a throwaway CODEX_HOME, so nothing ever writes
  // `~/.codex/models_cache.json` for `options()` to read. With no list, the
  // settings validator's `?? false` rejected every effort — including the
  // three the picker was offering — and `allowCustomModel: false` rejected
  // every model name, so neither setting could be changed at all. Not knowing
  // what a CLI supports is not the same as knowing a value is wrong.
  const harness = await createHarness();
  // Deliberately no seedCodexCache: this is a host that has never cached one.
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
  assert.equal(options.models, null);
  assert.equal(options.allowCustomModel, true);
  // And it says why, rather than leaving the screen to invent a list.
  assert.match(options.notes.join(" "), /No model list yet for this account/u);
  // No suggested model names at all. A suggestion here is a guess about
  // somebody else's entitlements, and offering it in a picker reads as
  // offering something available — which is how a ChatGPT-account Codex came
  // to be set to a model it answers 400 for and fails at planning time.
  assert.equal((options.suggestedModels ?? []).length, 0);
  // Reasoning levels stay: fixed vocabulary the CLI defines, not entitlements
  // that vary by account, so suggesting them cannot mislead the same way.
  assert.ok((options.suggestedEfforts ?? []).length > 0);
  // Every suggestion must be a value the validator will actually accept —
  // offering one that saves as a 400 is worse than offering none.
  for (const effort of options.suggestedEfforts ?? []) {
    assert.match(effort, /^[a-z][a-z0-9_-]{0,31}$/u, effort);
  }

  await service.connect({ userId: "u", systemAdmin: true, provider: "openai" });
  const saved = await service.setSettings({
    userId: "u",
    provider: "openai",
    model: "gpt-5.6-sol",
    effort: "xhigh",
  });
  const openai = saved.find((entry) => entry.id === "openai");
  assert.equal(openai?.model, "gpt-5.6-sol");
  assert.equal(openai?.effort, "xhigh");

  // Permissive, not credulous: the shape guards still hold.
  await assert.rejects(
    service.setSettings({
      userId: "u",
      provider: "openai",
      effort: "not a level",
    }),
    (error: unknown) =>
      error instanceof ProviderChatError && error.code === "invalid_effort",
  );
  await assert.rejects(
    service.setSettings({ userId: "u", provider: "openai", model: "../etc" }),
    (error: unknown) =>
      error instanceof ProviderChatError && error.code === "invalid_model",
  );
});

test("every provider offers a model list to pick from, cached or not", async () => {
  // The property the pickers depend on, asserted here rather than left to the
  // browser: a dropdown with nothing in it is the bug this whole thread of
  // work is about, and it happened because `models` was allowed to be null
  // with nothing standing behind it. Either the account reported a list or a
  // suggested one is sent; never neither.
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      ...CLAUDE_OK,
      codex: (args) =>
        args[0] === "--version" ? output("codex-cli 0.146.0") : output(""),
      gemini: (args) => (args[0] === "--version" ? output("0.9.0") : output("")),
    }),
  });
  for (const provider of ["anthropic", "openai", "google"] as const) {
    const options = await service.options({ provider });
    const models = options.models ?? options.suggestedModels ?? [];
    // Codex is the exception, and deliberately: with no cached list there is
    // nothing to offer that is not a guess about this account's entitlements,
    // and a guess presented as a choice is how an account was set to a model
    // it answers 400 for. It gets a free-text field and a note instead.
    if (provider === "openai" && options.models === null) {
      assert.equal(options.allowCustomModel, true);
      assert.ok(options.notes.length > 0);
      continue;
    }
    assert.ok(
      models.length > 0,
      `${provider} offers no models at all: ${JSON.stringify(options)}`,
    );
    // Every entry is pickable and readable — an id the CLI takes, and a label
    // that is not just the id repeated back when a nicer one exists.
    for (const model of models) {
      assert.match(model.id, MODEL_VALUE_SHAPE, `${provider}: ${model.id}`);
      assert.ok((model.label ?? "").length > 0, `${provider}: ${model.id}`);
    }
  }

  // Reasoning is the one setting that legitimately has no list: the Gemini
  // CLI takes no effort flag at all, and the adapter refuses one. An empty
  // list there means the row is not rendered, which is right — unlike Codex,
  // where an empty list meant a label with nothing under it.
  const anthropic = await service.options({ provider: "anthropic" });
  assert.ok((anthropic.efforts ?? []).length > 0);
  const openai = await service.options({ provider: "openai" });
  assert.ok((openai.efforts ?? openai.suggestedEfforts ?? []).length > 0);
  const google = await service.options({ provider: "google" });
  assert.deepEqual(google.efforts ?? google.suggestedEfforts ?? [], []);
});

test("the aliases the Claude CLI documents are shown as names, not as bare words", async () => {
  // `claude --help` documents its `--model` values as bare words, and they
  // were rendered into the picker exactly as parsed — a dropdown reading
  // "fable / sonnet / opus / claude-fable-5". Every value is real and every
  // one works; as a list it is unreadable, and it gives no clue that the
  // first three float to the newest release while the fourth pins one.
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      claude: (args) =>
        args[0] === "auth"
          ? output(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }))
          : args[0] === "--help"
            ? output(
                [
                  "Usage: claude [options]",
                  "",
                  "  --model <model>  Model for the session. Accepts an alias",
                  "                   ('fable', 'opus', 'sonnet') or a full name",
                  "                   ('claude-fable-5', 'claude-opus-5').",
                  "  --verbose        Print more",
                ].join("\n"),
              )
            : output(""),
    }),
  });

  const options = await service.options({ provider: "anthropic" });
  const byId = new Map((options.models ?? []).map((m) => [m.id, m.label]));
  // The value is the CLI's and travels unaltered; only the label is ours.
  assert.equal(byId.get("fable"), "Fable (latest)");
  assert.equal(byId.get("opus"), "Opus (latest)");
  assert.equal(byId.get("claude-fable-5"), "Fable 5");
  assert.equal(byId.get("claude-opus-5"), "Opus 5");
  // Nothing is dropped for lacking a label — an alias this deployment has
  // never heard of still has to be selectable.
  for (const model of options.models ?? []) {
    assert.ok((model.label ?? "").length > 0, model.id);
  }
});

test("anthropic reports no model list when the CLI offers neither source", async () => {
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner(CLAUDE_OK),
  });
  // CLAUDE_OK answers --help with the completion script, which names no
  // quoted aliases, and no ~/.claude.json exists in this harness.
  const options = await service.options({ provider: "anthropic" });
  assert.equal(options.models, null);
  assert.equal(options.modelListSource, undefined);
  assert.equal(options.allowCustomModel, true);
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

test("anthropic model options come only from what the CLI itself reports", async () => {
  const harness = await createHarness();
  await writeFile(
    path.join(harness.home, ".claude.json"),
    JSON.stringify({
      additionalModelOptionsCache: [
        {
          value: "claude-fable-5[1m]",
          label: "Fable",
          description: "Most capable",
        },
      ],
    }),
    "utf8",
  );
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      claude: (args) => {
        if (args[0] === "auth") {
          return output(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
        }
        if (args[0] === "--help") {
          return output(
            [
              "Options:",
              "  --model <model>                       Provide an alias for the",
              "                                        latest model (e.g. 'fable',",
              "                                        'opus', or 'sonnet').",
              "  --settings <file>                     Path to a settings file",
            ].join("\n"),
          );
        }
        return output("");
      },
    }),
  });
  const options = await service.options({ provider: "anthropic" });
  assert.ok(options.models !== null);
  assert.deepEqual(
    options.models.map((model) => model.id),
    ["claude-fable-5[1m]", "fable", "opus", "sonnet"],
  );
  // The cache entry keeps the label the CLI wrote for it.
  assert.equal(options.models[0]?.label, "Fable");
  assert.match(options.modelListSource ?? "", /model cache.*aliases documented/u);
  // A value from a different --help paragraph must not become a model.
  assert.ok(!options.models.some((model) => model.id === "file"));

  await service.connect({
    userId: "u",
    systemAdmin: true,
    provider: "anthropic",
  });
  // Bracketed values the CLI really reports must survive validation.
  await service.setSettings({
    userId: "u",
    provider: "anthropic",
    model: "claude-fable-5[1m]",
  });
  const status = (await service.list({ userId: "u", systemAdmin: true })).find(
    (provider) => provider.id === "anthropic",
  );
  assert.equal(status?.model, "claude-fable-5[1m]");
});

test("claude usage percentages are read from the CLI's own /usage report", async () => {
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      claude: (args) => {
        if (args[0] === "auth") {
          return output(JSON.stringify({ loggedIn: true }));
        }
        if (args[1] === "/usage") {
          return output(
            JSON.stringify({
              result: [
                "You are currently using your subscription",
                "",
                "Current session: 36% used · resets Jul 29, 10:59am (America/Los_Angeles)",
                "Current week (all models): 19% used · resets Jul 31, 9:59am (America/Los_Angeles)",
                "Current week (Fable): 27% used · resets Jul 31, 10am (America/Los_Angeles)",
                "",
                "Last 24h · 1760 requests · 60 sessions",
                "  95% of your usage was at >150k context",
              ].join("\n"),
            }),
          );
        }
        return output("");
      },
    }),
  });
  const report = await service.usage({ provider: "anthropic" });
  assert.equal(report.unavailableReason, undefined);
  assert.deepEqual(
    report.windows.map((window) => [window.label, window.percentUsed]),
    [
      ["session", 36],
      ["week (all models)", 19],
      ["week (Fable)", 27],
    ],
  );
  assert.equal(report.windows[0]?.resetsAt, "Jul 29, 10:59am (America/Los_Angeles)");
  // The "95% of your usage was at >150k context" line is prose, not a window.
  assert.ok(!report.windows.some((window) => window.percentUsed === 95));

  // Codex records its limits per session, and this harness has none.
  const codex = await service.usage({ provider: "openai" });
  assert.deepEqual(codex.windows, []);
  assert.match(codex.unavailableReason ?? "", /no Codex session/iu);
});

test("codex usage comes from the rate limits its own session records", async () => {
  const harness = await createHarness();
  const day = path.join(harness.home, ".codex", "sessions", "2026", "07", "29");
  await mkdir(day, { recursive: true });
  // The shape the CLI really writes, including the null secondary window.
  const line = JSON.stringify({
    type: "event_msg",
    payload: {
      info: { total_token_usage: { input_tokens: 41_672 } },
      rate_limits: {
        limit_id: "codex",
        primary: {
          used_percent: 2,
          window_minutes: 10_080,
          resets_at: 1_785_902_966,
        },
        secondary: null,
        plan_type: "pro",
      },
    },
  });
  await writeFile(
    path.join(day, "rollout-2026-07-29T10-23-07-019faee6.jsonl"),
    `${JSON.stringify({ type: "session_meta" })}\n${line}\n`,
    "utf8",
  );
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({}),
  });
  const report = await service.usage({ provider: "openai" });
  assert.equal(report.unavailableReason, undefined);
  assert.equal(report.windows.length, 1);
  assert.equal(report.windows[0]?.label, "week");
  assert.equal(report.windows[0]?.percentUsed, 2);
  assert.ok((report.windows[0]?.resetsAt ?? "").length > 0);

  // With no rollouts at all, that is stated rather than guessed.
  const empty = await createHarness();
  const bare = new ProviderChatService(empty.project, {
    homeDirectory: empty.home,
    runner: scriptedRunner({}),
  });
  const none = await bare.usage({ provider: "openai" });
  assert.deepEqual(none.windows, []);
  assert.match(none.unavailableReason ?? "", /no Codex session/iu);
});

test("streaming relays real CLI events and ends with the parsed reply", async () => {
  const harness = await createHarness();
  await seedCodexCache(harness.home);
  const seenArgs: string[][] = [];
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      codex: (args) => {
        if (args[0] === "--version") return output("codex-cli 0.146.0");
        if (args[0] === "login") return output("Logged in using ChatGPT");
        return output("");
      },
    }),
    streamRunner: async (command, args, _options, onLine) => {
      seenArgs.push([path.basename(String(command)), ...args]);
      // Exactly the shape the real CLI emits, in the real order.
      const lines = [
        JSON.stringify({ type: "thread.started", thread_id: "th-123456789" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_0", type: "reasoning", text: "**Weighing options**" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_1", type: "agent_message", text: "Answer." },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 12, output_tokens: 3, reasoning_output_tokens: 7 },
        }),
      ];
      for (const line of lines) onLine(line);
      return output(lines.join("\n"));
    },
  });
  await service.connect({ userId: "u", systemAdmin: true, provider: "openai" });
  const events: Array<Record<string, unknown>> = [];
  const reply = await service.completeStream(
    {
      userId: "u",
      systemAdmin: true,
      provider: "openai",
      messages: [{ role: "user", content: "hi" }],
    },
    (event) => events.push(event as unknown as Record<string, unknown>),
  );
  // Reasoning text is forwarded verbatim, and only because the CLI sent it.
  assert.deepEqual(events, [
    { type: "status", status: "working" },
    { type: "reasoning_start", hidden: false },
    { type: "reasoning", text: "**Weighing options**" },
    { type: "text", delta: "Answer." },
  ]);
  assert.equal(reply.text, "Answer.");
  assert.equal(reply.usage.thinkingTokens, 7);
  // Reasoning summaries only arrive when the CLI is asked for them.
  assert.ok(
    seenArgs[0]?.includes('model_reasoning_summary="detailed"'),
    `expected the summary override, got ${JSON.stringify(seenArgs[0])}`,
  );
  assert.ok(seenArgs[0]?.includes("read-only"));
});

test("streaming refuses the same cases the non-streaming path refuses", async () => {
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner(CLAUDE_OK),
    streamRunner: async () => {
      throw new Error("no CLI may be spawned for a refused request");
    },
  });
  await assert.rejects(
    service.completeStream(
      {
        userId: "u",
        systemAdmin: true,
        provider: "anthropic",
        messages: [{ role: "user", content: "hi" }],
      },
      () => {},
    ),
    (error: unknown) =>
      error instanceof ProviderChatError && error.code === "not_connected",
  );
  await service.connect({
    userId: "u",
    systemAdmin: true,
    provider: "anthropic",
  });
  await assert.rejects(
    service.completeStream(
      {
        userId: "u",
        systemAdmin: false,
        provider: "anthropic",
        messages: [{ role: "user", content: "hi" }],
      },
      () => {},
    ),
    (error: unknown) =>
      error instanceof ProviderChatError && error.code === "admin_required",
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

/* --------------------------------------------- per-user credentials ----- */

/**
 * A user's own credential is the whole point of the multi-tenant path, so
 * these tests pin the properties that make it trustworthy: it is proven
 * against the CLI before being stored, it reaches the CLI in the vendor's own
 * variable with the host's login unreachable, it lifts the administrator gate
 * only for the user who supplied it, and disconnecting destroys it.
 */

interface Captured {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv | undefined;
}

/**
 * A signed-in host CLI that answers the connect probe.
 *
 * Distinct from {@link CLAUDE_OK} because verification asks for a specific
 * sentinel reply: a CLI can exit zero while printing an authentication
 * failure, so the probe insists on seeing the answer it asked for.
 */
const CLAUDE_PONG = {
  claude: (args: readonly string[]) =>
    args[0] === "auth"
      ? output(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }))
      : output(
          [
            JSON.stringify({
              type: "assistant",
              message: { content: [{ type: "text", text: "pong" }] },
            }),
            JSON.stringify({
              type: "result",
              is_error: false,
              result: "pong",
              session_id: "sess-abcd1234",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          ].join("\n"),
        ),
};

/** Like {@link scriptedRunner} but keeps what each call was launched with. */
function capturingRunner(
  script: Record<string, (args: readonly string[]) => ReturnType<typeof output>>,
  calls: Captured[],
): ProcessRunner {
  const inner = scriptedRunner(script) as (
    command: string,
    args: readonly string[],
    options?: unknown,
  ) => ReturnType<ProcessRunner>;
  return (async (
    command: string,
    args: readonly string[],
    options?: { env?: NodeJS.ProcessEnv },
  ) => {
    calls.push({ command, args, env: options?.env });
    return await inner(command, args, options);
  }) as ProcessRunner;
}

test("a credential the CLI rejects is reported, not stored", async () => {
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      claude: (args) =>
        args[0] === "auth"
          ? output(JSON.stringify({ loggedIn: false, authMethod: "none" }))
          : output(
              "",
              1,
              "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
            ),
    }),
  });

  await assert.rejects(
    service.connectOwnCredential({
      userId: "u1",
      provider: "anthropic",
      kind: "oauth_token",
      secret: "sk-ant-oat01-wrong",
    }),
    (error: unknown) =>
      error instanceof ProviderChatError &&
      error.code === "credential_rejected" &&
      /OAuth access token is invalid/u.test(error.message),
  );

  const statuses = await service.list({ userId: "u1", systemAdmin: false });
  const anthropic = statuses.find((entry) => entry.id === "anthropic");
  assert.equal(anthropic?.connected, false);
  assert.equal(anthropic?.ownCredential, undefined);
});

test("an own credential connects without admin rights and reaches the CLI alone", async () => {
  const harness = await createHarness();
  const calls: Captured[] = [];
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: capturingRunner(
      {
        claude: (args) =>
          args[0] === "auth"
            ? // The host itself is signed in as somebody else entirely.
              output(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }))
            : output(
                [
                  JSON.stringify({
                    type: "assistant",
                    message: { content: [{ type: "text", text: "pong" }] },
                  }),
                  JSON.stringify({
                    type: "result",
                    is_error: false,
                    result: "pong",
                    session_id: "sess-abcd1234",
                    usage: { input_tokens: 1, output_tokens: 1 },
                  }),
                ].join("\n"),
              ),
      },
      calls,
    ),
  });

  const statuses = await service.connectOwnCredential({
    userId: "u1",
    provider: "anthropic",
    kind: "oauth_token",
    secret: "sk-ant-oat01-users-own-token",
    label: "personal",
  });
  const anthropic = statuses.find((entry) => entry.id === "anthropic");
  assert.equal(anthropic?.connected, true);
  assert.equal(anthropic?.kind, "own-credential");
  assert.equal(anthropic?.requiresAdmin, false, "no admin rights are needed");
  assert.equal(anthropic?.ownCredential?.label, "personal");
  assert.equal(anthropic?.ownCredential?.hint, "oken");
  assert.ok(
    !JSON.stringify(statuses).includes("users-own-token"),
    "the secret must never travel back to the browser",
  );

  // A non-administrator can now actually use it.
  calls.length = 0;
  const reply = await service.complete({
    userId: "u1",
    systemAdmin: false,
    provider: "anthropic",
    messages: [{ role: "user", content: "ping" }],
  });
  assert.equal(reply.text, "pong");

  const completion = calls.find((call) => call.args[0] === "-p");
  assert.ok(completion !== undefined, "the CLI ran the completion");
  assert.equal(
    completion.env?.["CLAUDE_CODE_OAUTH_TOKEN"],
    "sk-ant-oat01-users-own-token",
  );
  // The isolated configuration directory is what keeps the host's own login
  // out of reach; without it the CLI could answer as the host owner instead.
  assert.ok(
    (completion.env?.["CLAUDE_CONFIG_DIR"] ?? "").length > 0,
    "the CLI must be pointed away from the host's configuration",
  );
  assert.equal(completion.env?.["ANTHROPIC_API_KEY"], undefined);
});

test("one user's credential never answers another user's prompt", async () => {
  const harness = await createHarness();
  const calls: Captured[] = [];
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: capturingRunner(CLAUDE_PONG, calls),
  });

  await service.connectOwnCredential({
    userId: "u1",
    provider: "anthropic",
    kind: "oauth_token",
    secret: "sk-ant-oat01-belongs-to-u1",
  });
  // Only what runs on u2's behalf is of interest; u1's own connect probe
  // legitimately carried u1's token.
  calls.length = 0;

  // u2 has connected nothing, so the only account available to them is the
  // shared host login, which stays administrator-only.
  const forU2 = await service.list({ userId: "u2", systemAdmin: false });
  assert.equal(
    forU2.find((entry) => entry.id === "anthropic")?.connected,
    false,
  );
  await assert.rejects(
    service.complete({
      userId: "u2",
      systemAdmin: false,
      provider: "anthropic",
      messages: [{ role: "user", content: "ping" }],
    }),
    (error: unknown) => error instanceof ProviderChatError,
  );
  assert.ok(
    !calls.some((call) =>
      Object.values(call.env ?? {}).includes("sk-ant-oat01-belongs-to-u1"),
    ),
    "one user's token must never be handed to a process run for another",
  );
});

test("an admin on the shared login still runs under the host's own environment", async () => {
  const harness = await createHarness();
  const calls: Captured[] = [];
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: capturingRunner(CLAUDE_OK, calls),
  });
  await service.connect({
    userId: "admin",
    systemAdmin: true,
    provider: "anthropic",
  });

  calls.length = 0;
  await service.complete({
    userId: "admin",
    systemAdmin: true,
    provider: "anthropic",
    messages: [{ role: "user", content: "ping" }],
  });
  const completion = calls.find((call) => call.args[0] === "-p");
  assert.equal(
    completion?.env,
    undefined,
    "the shared-login path inherits the host environment as it always did",
  );
});

test("disconnecting destroys the stored credential", async () => {
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner(CLAUDE_PONG),
  });
  await service.connectOwnCredential({
    userId: "u1",
    provider: "anthropic",
    kind: "oauth_token",
    secret: "sk-ant-oat01-to-be-destroyed",
  });
  await service.disconnect({ userId: "u1", provider: "anthropic" });

  const after = await service.list({ userId: "u1", systemAdmin: false });
  const anthropic = after.find((entry) => entry.id === "anthropic");
  assert.equal(anthropic?.connected, false);
  assert.equal(anthropic?.ownCredential, undefined);
  // A prompt after disconnecting must not still find a working key.
  await assert.rejects(
    service.complete({
      userId: "u1",
      systemAdmin: false,
      provider: "anthropic",
      messages: [{ role: "user", content: "ping" }],
    }),
    (error: unknown) =>
      error instanceof ProviderChatError && error.code === "not_connected",
  );
});

test("connecting one account does not hide an admin's other shared logins", async () => {
  const harness = await createHarness();
  await seedCodexCache(harness.home);
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      ...CLAUDE_PONG,
      codex: (args) =>
        args[0] === "--version" ? output("codex 1.0.0") : output("logged in"),
    }),
  });
  await service.connect({
    userId: "admin",
    systemAdmin: true,
    provider: "openai",
  });

  const statuses = await service.connectOwnCredential({
    userId: "admin",
    systemAdmin: true,
    provider: "anthropic",
    kind: "oauth_token",
    secret: "sk-ant-oat01-admins-own",
  });

  assert.equal(
    statuses.find((entry) => entry.id === "anthropic")?.kind,
    "own-credential",
  );
  assert.equal(
    statuses.find((entry) => entry.id === "openai")?.connected,
    true,
    "the shared login the admin already had must still read as connected",
  );
});

test("a vendor that cannot take a credential per user says so", async () => {
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner(CLAUDE_OK),
  });
  await assert.rejects(
    service.connectOwnCredential({
      userId: "u1",
      provider: "openai",
      kind: "oauth_token",
      secret: "whatever",
    }),
    (error: unknown) =>
      error instanceof ProviderChatError && error.code === "unsupported_kind",
  );
});

test("a github connection never appears in the channel roster", async () => {
  const harness = await createHarness();
  const store = await UserCredentialStore.open(
    path.join(harness.project.directory, "secrets"),
  );
  await store.put("user-1", "claude", {
    kind: "oauth_token",
    secret: "sk-ant-oat01-agent-token",
  });
  // Same store, different kind of thing: a push credential, not an agent.
  // The roster is a list of names a teammate can @mention into work, and a
  // GitHub token can never answer one.
  await store.put("user-1", "github", {
    kind: "api_key",
    secret: "ghp_pushtoken",
  });

  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    credentials: store,
  });
  const connections = await service.listConnectionsFor(["user-1"]);
  assert.deepEqual(
    connections["user-1"]?.map((entry) => entry.provider),
    ["anthropic"],
  );
});
