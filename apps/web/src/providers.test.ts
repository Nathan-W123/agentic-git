import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoordinatorProject } from "@coord/cli/project";
import {
  UserCredentialStore,
  type CreateWorkspaceInput,
  type TaskWorkspace,
  type WorkspaceManager,
} from "@coord/workspace-manager";

import {
  AGENT_CALL_SIGNS,
  ProviderChatError,
  ProviderChatService,
  parseClaudeStreamJson,
  parseCursorModelList,
  parseCursorUsage,
  parseCodexAppServerRateLimits,
  parseCodexStatusRateLimits,
  parseCodexJsonl,
  streamProcess,
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
  assert.deepEqual(options.notes, []);
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
    // it answers 400 for. It gets a free-text field instead.
    if (provider === "openai" && options.models === null) {
      assert.equal(options.allowCustomModel, true);
      assert.deepEqual(options.notes, []);
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
  assert.deepEqual(options.notes, []);

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
  // The session record carries the same richer figures the app-server does.
  assert.equal(report.planType, "pro");
  assert.equal(report.windows[0]?.windowDurationMins, 10_080);
  assert.equal(report.windows[0]?.resetsAtEpoch, 1_785_902_966);

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

test("codex usage asks the account for its quota before reading session records", async () => {
  const harness = await createHarness();
  const seen: string[][] = [];
  const calls: Captured[] = [];
  const store = await UserCredentialStore.open(
    path.join(harness.project.directory, "secrets"),
  );
  await store.put("usage-user", "codex", {
    kind: "api_key",
    secret: "sk-openai-usage-user",
  });
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    credentials: store,
    runner: capturingRunner(
      {
        codex: (args) => {
          seen.push([...args]);
          if (args[0] !== "--status") {
            return output("", 127, "not scripted");
          }
          return output(
            JSON.stringify({
              rate_limits: {
                five_hour: {
                  remaining_percent: 87.5,
                  window_minutes: 300,
                  resets_at: 1_785_902_966,
                },
                weekly: { remaining_percent: 60, window_minutes: 10_080 },
                plan_type: "plus",
              },
            }),
          );
        },
      },
      calls,
    ),
  });
  const report = await service.usage({
    provider: "openai",
    userId: "usage-user",
  });
  assert.deepEqual(seen[0], ["--status", "--json"]);
  const quotaCall = calls.find((call) => call.args[0] === "--status");
  assert.ok((quotaCall?.env?.["CODEX_HOME"] ?? "").length > 0);
  assert.notEqual(quotaCall?.env?.["CODEX_HOME"], harness.home);
  // Codex reads its API key from auth.json inside that isolated home, never
  // from an inherited environment variable that could identify another user.
  assert.equal(quotaCall?.env?.["OPENAI_API_KEY"], undefined);
  assert.equal(report.unavailableReason, undefined);
  assert.equal(report.source, "Codex native status (plus)");
  assert.equal(report.windows.length, 2);
  assert.equal(report.windows[0]?.percentUsed, 12.5);
  assert.equal(report.windows[0]?.label, "5 hours");
  assert.ok((report.windows[0]?.resetsAt ?? "").length > 0);
  assert.equal(report.windows[1]?.label, "week");

  // Opening the agent specification again must reach the native quota read
  // again; a service cache here would make the browser's refresh ineffective.
  const reopened = await service.usage({
    provider: "openai",
    userId: "usage-user",
  });
  assert.equal(reopened.windows[0]?.percentUsed, 12.5);
  assert.deepEqual(seen, [
    ["--status", "--json"],
    ["--status", "--json"],
  ]);
});

test("native Codex status JSON maps five-hour and weekly balances", () => {
  const report = parseCodexStatusRateLimits(
    JSON.stringify({
      status: {
        usage: {
          fiveHour: {
            remainingPercentage: 72.5,
            resetsAt: 1_785_902_966,
          },
          weekly: {
            percentRemaining: -4,
            windowDurationMins: 10_080,
            resetAt: 1_786_402_966,
          },
        },
        planType: "team",
        credits: { balance: 7.5 },
      },
    }),
  );

  assert.equal(report?.source, "Codex native status (team)");
  assert.equal(report?.planType, "team");
  assert.equal(report?.creditBalance, 7.5);
  assert.deepEqual(
    report?.windows.map((window) => [
      window.label,
      window.percentUsed,
      window.windowDurationMins,
      window.resetsAtEpoch,
    ]),
    [
      ["5 hours", 27.5, 300, 1_785_902_966],
      ["week", 100, 10_080, 1_786_402_966],
    ],
  );
  assert.equal(parseCodexStatusRateLimits("not json"), undefined);
  assert.equal(
    parseCodexStatusRateLimits(JSON.stringify({ status: {} })),
    undefined,
  );
});

test("unsupported native status falls back without losing usage", async () => {
  const harness = await createHarness();
  const seen: string[][] = [];
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      codex: (args) => {
        seen.push([...args]);
        if (args[0] === "--status") {
          return output("", 2, "unexpected argument '--status'");
        }
        return output(
          `${JSON.stringify({
            id: 1,
            result: {
              rateLimits: {
                primary: { usedPercent: 9, windowDurationMins: 300 },
                secondary: { usedPercent: 31, windowDurationMins: 10_080 },
              },
            },
          })}\n`,
        );
      },
    }),
  });

  const report = await service.usage({ provider: "openai" });
  assert.deepEqual(seen, [
    ["--status", "--json"],
    ["app-server", "--stdio"],
  ]);
  assert.deepEqual(
    report.windows.map((window) => window.percentUsed),
    [9, 31],
  );
});

test("the codex quota answer is read in either spelling, and nothing is invented", () => {
  const camel = parseCodexAppServerRateLimits(
    `${JSON.stringify({
      id: 1,
      result: {
        rateLimits: {
          primary: { usedPercent: 7, windowDurationMins: 60 },
          secondary: { usedPercent: 130, windowDurationMins: 43_200 },
        },
      },
    })}\n`,
  );
  assert.equal(camel?.source, "Codex account rate limits");
  assert.equal(camel?.windows[0]?.label, "hour");
  assert.equal(camel?.windows[0]?.percentUsed, 7);
  // A percentage past the end of the bar is clamped, not drawn off the edge.
  assert.equal(camel?.windows[1]?.percentUsed, 100);

  // A handshake with no quota in it, an error reply, and noise are all "no
  // answer" rather than an empty report that reads as a real zero.
  assert.equal(parseCodexAppServerRateLimits(""), undefined);
  assert.equal(
    parseCodexAppServerRateLimits(
      `${JSON.stringify({ id: 0, result: {} })}\nnot json\n`,
    ),
    undefined,
  );
  assert.equal(
    parseCodexAppServerRateLimits(
      `${JSON.stringify({ id: 1, error: { message: "unknown method" } })}\n`,
    ),
    undefined,
  );
});

test("codex quota reads every modern named limit without duplicating its legacy alias", () => {
  const report = parseCodexAppServerRateLimits(
    `${JSON.stringify({
      id: 1,
      result: {
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 17.25,
            windowDurationMins: 300,
            resetsAt: 1_785_902_966,
          },
          secondary: null,
          planType: "pro",
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: {
              usedPercent: 17.25,
              windowDurationMins: 300,
              resetsAt: 1_785_902_966,
            },
            secondary: null,
            planType: "pro",
          },
          codex_review: {
            limitId: "codex_review",
            limitName: "Code review",
            primary: { usedPercent: 43.5, windowDurationMins: 10_080 },
            secondary: null,
            planType: "pro",
          },
          future_limit: null,
        },
      },
    })}\n`,
  );
  assert.equal(report?.source, "Codex account rate limits (pro)");
  assert.deepEqual(
    report?.windows.map((window) => [window.label, window.percentUsed]),
    [
      ["codex · 5 hours", 17.25],
      ["Code review · week", 43.5],
    ],
  );
  assert.ok((report?.windows[0]?.resetsAt ?? "").length > 0);
});

test("codex quota ignores empty mapped windows and retains legacy fallback", () => {
  const mappedOnly = parseCodexAppServerRateLimits(
    `${JSON.stringify({
      id: 1,
      result: {
        rateLimits: null,
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: { usedPercent: 8, windowDurationMins: 300 },
            secondary: null,
            planType: "plus",
          },
          empty: { primary: null, secondary: null },
        },
      },
    })}\n`,
  );
  assert.deepEqual(
    mappedOnly?.windows.map((window) => [window.label, window.percentUsed]),
    [["5 hours", 8]],
  );

  const legacy = parseCodexAppServerRateLimits(
    `${JSON.stringify({
      id: 1,
      result: {
        rate_limits: {
          primary: { used_percent: 6, window_minutes: 60 },
          secondary: null,
        },
        rate_limits_by_limit_id: { codex: null },
      },
    })}\n`,
  );
  assert.deepEqual(
    legacy?.windows.map((window) => [window.label, window.percentUsed]),
    [["hour", 6]],
  );
  assert.equal(
    parseCodexAppServerRateLimits(
      `${JSON.stringify({
        id: 1,
        result: {
          rateLimits: { primary: null, secondary: null },
          rateLimitsByLimitId: { codex: null },
        },
      })}\n`,
    ),
    undefined,
  );
});

test("codex quota keeps the plan, the credit balance, and the raw window figures", () => {
  const report = parseCodexAppServerRateLimits(
    `${JSON.stringify({
      id: 1,
      result: {
        rateLimits: {
          primary: {
            usedPercent: 17.25,
            windowDurationMins: 300,
            resetsAt: 1_785_902_966,
          },
          secondary: {
            usedPercent: 43.5,
            windowDurationMins: 10_080,
            resetsAt: 1_786_402_966,
          },
          planType: "pro",
          credits: { hasCredits: true, unlimited: false, balance: 12.5 },
        },
      },
    })}\n`,
  );
  // The plan stops being only a phrase inside `source`.
  assert.equal(report?.planType, "pro");
  assert.equal(report?.source, "Codex account rate limits (pro)");
  assert.equal(report?.creditBalance, 12.5);
  assert.equal(report?.windows[0]?.windowDurationMins, 300);
  assert.equal(report?.windows[0]?.resetsAtEpoch, 1_785_902_966);
  assert.equal(report?.windows[1]?.windowDurationMins, 10_080);
  assert.equal(report?.windows[1]?.resetsAtEpoch, 1_786_402_966);
  // The formatted string stays beside the number rather than being replaced.
  assert.ok((report?.windows[0]?.resetsAt ?? "").length > 0);

  // Credits reported at the envelope rather than inside the limits object
  // answer the same question, and a credits object with no number in it is
  // absent rather than a balance of zero.
  const atEnvelope = parseCodexAppServerRateLimits(
    `${JSON.stringify({
      id: 1,
      result: {
        credits: { balance: 3 },
        rate_limits: {
          primary: { used_percent: 6, window_minutes: 60 },
          secondary: null,
        },
      },
    })}\n`,
  );
  assert.equal(atEnvelope?.creditBalance, 3);
  assert.equal(atEnvelope?.windows[0]?.windowDurationMins, 60);
  assert.equal(atEnvelope?.windows[0]?.resetsAtEpoch, undefined);

  const noBalance = parseCodexAppServerRateLimits(
    `${JSON.stringify({
      id: 1,
      result: {
        rateLimits: {
          primary: { usedPercent: 6, windowDurationMins: 60 },
          secondary: null,
          credits: { hasCredits: false, unlimited: true },
        },
      },
    })}\n`,
  );
  assert.equal(noBalance?.creditBalance, undefined);
  assert.equal(noBalance?.planType, undefined);
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

test("a streaming thread reply waits for the agent task's rotated session", async () => {
  const harness = await createHarness();
  const credentials = await UserCredentialStore.open(
    path.join(harness.project.directory, "secrets"),
  );
  const original = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "before", refresh_token: "refresh-before" },
  });
  const refreshed = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "after", refresh_token: "refresh-after" },
  });
  await credentials.put("u", "codex", {
    kind: "session_file",
    secret: original,
    origin: "device_auth",
  });
  const taskHome = await credentials.openCredentialHome({
    userId: "u",
    vendor: "codex",
    mode: "shared",
  });
  assert.ok(taskHome !== undefined);
  await writeFile(
    path.join(taskHome.env["CODEX_HOME"] as string, "auth.json"),
    `${refreshed}\n`,
    "utf8",
  );
  const openCredentialHome = credentials.openCredentialHome.bind(credentials);
  let signalHomeRequested: (() => void) | undefined;
  const completionHomeRequested = new Promise<void>((resolve) => {
    signalHomeRequested = resolve;
  });
  credentials.openCredentialHome = async (input) => {
    signalHomeRequested?.();
    signalHomeRequested = undefined;
    return await openCredentialHome(input);
  };

  let streamStarted = false;
  const service = new ProviderChatService(harness.project, {
    credentials,
    homeDirectory: harness.home,
    streamRunner: async (_command, _args, options, onLine) => {
      streamStarted = true;
      const staged = JSON.parse(
        await readFile(
          path.join(options.env?.["CODEX_HOME"] as string, "auth.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      assert.deepEqual(staged, JSON.parse(refreshed));
      const lines = [
        JSON.stringify({ type: "thread.started", thread_id: "th-reply" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item-1", type: "agent_message", text: "still here" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 2, output_tokens: 2 },
        }),
      ];
      for (const line of lines) onLine(line);
      return output(lines.join("\n"));
    },
  });
  const replyPromise = service.completeStream(
    {
      userId: "u",
      systemAdmin: false,
      provider: "openai",
      messages: [{ role: "user", content: "are you there?" }],
    },
    () => {},
  );
  await completionHomeRequested;
  assert.equal(streamStarted, false, "the reply must not copy a live task token");

  await taskHome.close();
  assert.equal((await replyPromise).text, "still here");
  assert.equal(streamStarted, true);
  assert.equal(
    (await credentials.summary("u", "codex"))?.unusableReason,
    undefined,
  );
});

test("the streaming runner spawns the child in the environment it was handed", async () => {
  // Staging a credential home is worth nothing if the runner then spawns the
  // CLI under the host's ambient login instead. The type used to omit `env`
  // altogether, so both call sites passed one that was silently discarded and
  // every stubbed-runner test still passed.
  const seen: string[] = [];
  const staged = await streamProcess(
    process.execPath,
    ["-e", "console.log(process.env['KUMI_STAGED_HOME'] ?? '<unset>')"],
    {
      env: { ...process.env, KUMI_STAGED_HOME: "/staged/codex-home" },
      timeoutMs: 30_000,
    },
    (line) => seen.push(line),
  );
  assert.equal(staged.exitCode, 0);
  assert.equal(seen.join("").trim(), "/staged/codex-home");

  // With nothing supplied the child still inherits the harness environment,
  // which is what the single-operator deployment relies on.
  const inherited: string[] = [];
  const ambient = await streamProcess(
    process.execPath,
    ["-e", "console.log(process.env['PATH'] === undefined ? 'bare' : 'inherited')"],
    { timeoutMs: 30_000 },
    (line) => inherited.push(line),
  );
  assert.equal(ambient.exitCode, 0);
  assert.equal(inherited.join("").trim(), "inherited");
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

test("provider stream parsing resets thinking and completion state between turns", () => {
  const claudeFirst = parseClaudeStreamJson(
    [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "thinking", thinking: "First turn reasoning." }],
        },
      }),
      JSON.stringify({
        type: "result",
        is_error: false,
        result: "first",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ].join("\n"),
    "claude-test",
  );
  assert.equal(claudeFirst.thinking, "First turn reasoning.");

  const claudeSecond = parseClaudeStreamJson(
    [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "second" }] },
      }),
      JSON.stringify({
        type: "result",
        is_error: false,
        result: "second",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ].join("\n"),
    "claude-test",
  );
  assert.equal(claudeSecond.thinking, undefined);
  assert.equal(claudeSecond.thinkingHidden, undefined);

  const completedCodexTurn = [
    JSON.stringify({ type: "thread.started", thread_id: "turn-one" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "first" },
    }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ].join("\n");
  assert.equal(parseCodexJsonl(completedCodexTurn, "codex-test").text, "first");
  assert.throws(
    () =>
      parseCodexJsonl(
        JSON.stringify({ type: "thread.started", thread_id: "turn-two" }),
        "codex-test",
      ),
    /no completed turn/u,
    "a completed prior turn must not make a truncated next turn complete",
  );
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
  cwd: string | undefined;
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
    options?: { env?: NodeJS.ProcessEnv; cwd?: string },
  ) => {
    calls.push({ command, args, env: options?.env, cwd: options?.cwd });
    return await inner(command, args, options);
  }) as ProcessRunner;
}

test("codex and claude inspect a temporary canonical checkout", async () => {
  const harness = await createHarness();
  await seedCodexCache(harness.home);
  const checkout = path.join(path.dirname(harness.home), "canonical-checkout");
  await mkdir(checkout, { recursive: true });
  const created: CreateWorkspaceInput[] = [];
  const destroyed: TaskWorkspace[] = [];
  const workspaceManager: Pick<WorkspaceManager, "create" | "destroy"> = {
    create: async (input) => {
      created.push(input);
      return {
        id: `workspace_${created.length}`,
        taskId: input.taskId,
        path: checkout,
        rootPath: input.rootPath,
        repository: input.repository,
        baseVersion: input.baseVersion,
        isolation: "git-worktree",
        createdAt: "2026-08-18T00:00:00.000Z",
      };
    },
    destroy: async (workspace) => {
      destroyed.push(workspace);
    },
  };
  const calls: Captured[] = [];
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    workspaceManager,
    runner: capturingRunner(
      {
        claude: (args) =>
          args[0] === "auth"
            ? output(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }))
            : output(
                [
                  JSON.stringify({
                    type: "assistant",
                    message: { content: [{ type: "text", text: "from files" }] },
                  }),
                  JSON.stringify({
                    type: "result",
                    is_error: false,
                    result: "from files",
                    session_id: "sess-repository",
                    usage: { input_tokens: 1, output_tokens: 2 },
                  }),
                ].join("\n"),
              ),
        codex: (args) =>
          args[0] === "--version"
            ? output("codex-cli 0.146.0")
            : args[0] === "login"
              ? output("Logged in using ChatGPT")
              : output(
                  [
                    JSON.stringify({
                      type: "thread.started",
                      thread_id: "thread-repository",
                    }),
                    JSON.stringify({
                      type: "item.completed",
                      item: { type: "agent_message", text: "from files" },
                    }),
                    JSON.stringify({ type: "turn.completed", usage: {} }),
                  ].join("\n"),
                ),
      },
      calls,
    ),
  });
  await service.connect({ userId: "u", systemAdmin: true, provider: "openai" });
  await service.connect({ userId: "u", systemAdmin: true, provider: "anthropic" });
  const repository = {
    repository: { id: "repo", path: "/canonical/repo.git", branch: "main" },
    baseVersion: {
      sequence: 7,
      revision: "a".repeat(40),
      branch: "main",
      createdAt: "2026-08-18T00:00:00.000Z",
    },
    rootPath: harness.project.planningRoot,
  };

  for (const provider of ["openai", "anthropic"] as const) {
    const reply = await service.complete({
      userId: "u",
      systemAdmin: true,
      provider,
      messages: [{ role: "user", content: "Which file handles chat?" }],
      repository,
    });
    assert.equal(reply.text, "from files");
  }

  assert.equal(created.length, 2);
  assert.deepEqual(
    created.map((entry) => entry.baseVersion.revision),
    [repository.baseVersion.revision, repository.baseVersion.revision],
  );
  assert.equal(destroyed.length, 2);
  const codex = calls.find((call) => call.args[0] === "exec");
  assert.ok(codex);
  assert.equal(codex.cwd, checkout);
  assert.ok(
    codex.args.includes("--sandbox") && codex.args.includes("read-only"),
  );
  assert.equal(codex.args[codex.args.indexOf("-C") + 1], checkout);
  const claude = calls.find(
    (call) =>
      path.basename(call.command).startsWith("claude") && call.args[0] !== "auth",
  );
  assert.ok(claude);
  assert.equal(claude.cwd, checkout);
});

test("repository chat failures clean up and report unavailable checkouts", async () => {
  const harness = await createHarness();
  const checkout = path.join(path.dirname(harness.home), "failed-checkout");
  const destroyed: TaskWorkspace[] = [];
  let failCreate = false;
  const workspaceManager: Pick<WorkspaceManager, "create" | "destroy"> = {
    create: async (input) => {
      if (failCreate) {
        throw new Error("canonical revision is missing");
      }
      return {
        id: "workspace_failure",
        taskId: input.taskId,
        path: checkout,
        rootPath: input.rootPath,
        repository: input.repository,
        baseVersion: input.baseVersion,
        isolation: "git-worktree",
        createdAt: "2026-08-18T00:00:00.000Z",
      };
    },
    destroy: async (workspace) => {
      destroyed.push(workspace);
    },
  };
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    workspaceManager,
    runner: scriptedRunner({
      claude: (args) =>
        args[0] === "auth"
          ? output(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }))
          : output("", 1, "file could not be read"),
    }),
  });
  await service.connect({ userId: "u", systemAdmin: true, provider: "anthropic" });
  const input = {
    userId: "u",
    systemAdmin: true,
    provider: "anthropic" as const,
    messages: [{ role: "user", content: "Read README.md" }],
    repository: {
      repository: { id: "repo", path: "/canonical/repo.git", branch: "main" },
      baseVersion: {
        sequence: 7,
        revision: "a".repeat(40),
        branch: "main",
        createdAt: "2026-08-18T00:00:00.000Z",
      },
      rootPath: harness.project.planningRoot,
    },
  };

  await assert.rejects(
    service.complete(input),
    (error: unknown) =>
      error instanceof ProviderChatError && error.code === "cli_failed",
  );
  assert.equal(
    destroyed.length,
    1,
    "the failed completion left no checkout behind",
  );

  failCreate = true;
  await assert.rejects(
    service.complete(input),
    (error: unknown) =>
      error instanceof ProviderChatError &&
      error.code === "repository_unavailable" &&
      /canonical revision is missing/u.test(error.message),
  );
  assert.equal(
    destroyed.length,
    1,
    "a checkout that was never created is not destroyed",
  );
});

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

test("call sign assignment picks randomly from the free Greek and Roman god names", async () => {
  // Taking the first free name meant the pool was really a queue: the first
  // account on any deployment was Zeus, the second Hera, the third Poseidon,
  // and the name carried nothing but join order.
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner(CLAUDE_PONG),
  });

  const signs: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const statuses = await service.connectOwnCredential({
      userId: `u${index}`,
      provider: "anthropic",
      kind: "oauth_token",
      secret: `sk-ant-oat01-user-${index}`,
    });
    const sign = statuses.find((entry) => entry.id === "anthropic")?.callSign;
    assert.ok(sign !== undefined, "a connected account is given a name");
    signs.push(sign);
  }

  const pantheon = new Set<string>(AGENT_CALL_SIGNS);
  for (const sign of signs) {
    assert.ok(pantheon.has(sign), `${sign} is not one of the gods`);
  }
  // Signs in use are still skipped, so a room cannot hold two Hermeses.
  assert.equal(new Set(signs).size, signs.length, "every sign is distinct");
  // Eight draws from seventy-two names land in list order roughly once in
  // 10^14 runs, so this asserts the draw is random without being flaky.
  assert.notDeepEqual(
    signs,
    [...AGENT_CALL_SIGNS].slice(0, signs.length),
    "call signs must not be handed out in list order",
  );
});

test("an account that already has a call sign is never renamed", async () => {
  // Assignment only ever fills a gap: a name people have learned survives a
  // reconnect, and a name somebody chose survives everything.
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner(CLAUDE_PONG),
  });

  const first = await service.connectOwnCredential({
    userId: "u1",
    provider: "anthropic",
    kind: "oauth_token",
    secret: "sk-ant-oat01-first",
  });
  const assigned = first.find((entry) => entry.id === "anthropic")?.callSign;
  assert.ok(assigned !== undefined);

  await service.setSettings({
    userId: "u1",
    provider: "anthropic",
    callSign: "Icarus",
  });
  const again = await service.connectOwnCredential({
    userId: "u1",
    provider: "anthropic",
    kind: "oauth_token",
    secret: "sk-ant-oat01-second",
  });
  assert.equal(
    again.find((entry) => entry.id === "anthropic")?.callSign,
    "Icarus",
  );
});

/** Writes a connection the way a deployment older than call signs left one. */
async function seedUnnamedConnection(
  harness: Harness,
  userId: string,
): Promise<void> {
  const secrets = path.join(harness.project.directory, "secrets");
  await mkdir(secrets, { recursive: true });
  await writeFile(
    path.join(secrets, "provider-connections.json"),
    JSON.stringify({
      [userId]: {
        anthropic: { kind: "account", createdAt: "2026-01-01T00:00:00.000Z" },
      },
    }),
    "utf8",
  );
}

test("a connection made before call signs existed is named on the next read", async () => {
  // Naming happens at connect, and the browser no longer hands out a name as
  // an agent joins a channel — so without this an account that connected
  // earlier would read as "Claude (Nathan)" in every channel for good, with
  // nothing left that could ever name it. Filling the gap on read names it
  // once, by the same rule connect applies.
  const harness = await createHarness();
  await seedUnnamedConnection(harness, "u1");
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner(CLAUDE_OK),
  });

  const named = (await service.list({ userId: "u1", systemAdmin: true })).find(
    (entry) => entry.id === "anthropic",
  )?.callSign;
  assert.ok(named !== undefined, "the older connection is given a name");
  assert.ok(new Set<string>(AGENT_CALL_SIGNS).has(named));

  // And it is the name from then on: a name that changed on every read would
  // be worse than no name at all.
  const again = (await service.list({ userId: "u1", systemAdmin: true })).find(
    (entry) => entry.id === "anthropic",
  )?.callSign;
  assert.equal(again, named);
});

/** The two-method slice of the coordination store, kept in memory. */
function fakeCallSignStore() {
  const rows = new Map<string, { userId: string; provider: string; callSign: string }>();
  return {
    rows,
    async listAgentCallSigns() {
      return [...rows.values()];
    },
    async setAgentCallSign(userId: string, provider: string, callSign: string) {
      const record = { userId, provider, callSign };
      rows.set(`${userId} ${provider}`, record);
      return record;
    },
    async clearAgentCallSign(userId: string, provider: string) {
      rows.delete(`${userId} ${provider}`);
    },
  };
}

test("a name survives losing the connections file", async () => {
  // The reported bug: reload into Kumi and every agent in every channel is
  // "Claude (Nathan)" again. The names only ever lived in
  // `secrets/provider-connections.json`, on the control plane's own disk, so
  // a deployment whose filesystem does not outlive a restart came back with
  // them gone while the database still held the channels they were used in.
  const harness = await createHarness();
  const callSigns = fakeCallSignStore();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner(CLAUDE_PONG),
    callSigns,
  });
  const connected = await service.connectOwnCredential({
    userId: "u1",
    provider: "anthropic",
    kind: "oauth_token",
    secret: "sk-ant-oat01-durable",
  });
  const assigned = connected.find((entry) => entry.id === "anthropic")?.callSign;
  assert.ok(assigned !== undefined, "a connected account is given a name");

  // The restart on a filesystem that did not keep the connections file. The
  // credential (`user-credentials.json`) is what the deployment restores, so
  // the agent is still connected — it is the name that went missing.
  await writeFile(
    path.join(harness.project.directory, "secrets", "provider-connections.json"),
    "{}",
    "utf8",
  );
  const afterRestart = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner(CLAUDE_OK),
    callSigns,
  });
  assert.equal(
    (await afterRestart.list({ userId: "u1", systemAdmin: true })).find(
      (entry) => entry.id === "anthropic",
    )?.callSign,
    assigned,
    "the agent comes back under the name the room learned",
  );
  // And the roster — the path a channel resolves every name through — agrees,
  // which is where "Claude (Nathan)" was being shown.
  const roster = await afterRestart.listConnectionsFor(["u1"]);
  assert.equal(roster["u1"]?.[0]?.callSign, assigned);
});

test("a chosen name is written through, and clearing it deals a new one", async () => {
  const harness = await createHarness();
  const callSigns = fakeCallSignStore();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner(CLAUDE_PONG),
    callSigns,
  });
  await service.connectOwnCredential({
    userId: "u1",
    provider: "anthropic",
    kind: "oauth_token",
    secret: "sk-ant-oat01-chosen",
  });
  await service.setSettings({
    userId: "u1",
    provider: "anthropic",
    callSign: "Icarus",
  });
  assert.equal(
    (await callSigns.listAgentCallSigns()).find(
      (entry) => entry.userId === "u1",
    )?.callSign,
    "Icarus",
  );

  // Cleared here means cleared everywhere: a name that came back after a
  // restart the user had deliberately removed is the same bug reversed.
  await service.setSettings({
    userId: "u1",
    provider: "anthropic",
    callSign: "",
  });
  const after = await callSigns.listAgentCallSigns();
  assert.ok(
    after.every((entry) => entry.callSign !== "Icarus"),
    "the removed name is gone from the store",
  );
  // And gone is not the same as nameless. There is no "deliberately unnamed"
  // state in this design and there should not be: an agent with no call sign
  // is one the channels label "Claude (Nathan)" again, which is the whole
  // complaint this naming exists to answer. So clearing a chosen name deals a
  // fresh one — from the pantheon, which "Icarus" is not a member of — and
  // records it, rather than leaving the agent to fall back.
  assert.equal(after.length, 1, "the agent is still named");
  assert.ok(
    new Set<string>(AGENT_CALL_SIGNS).has(after[0]?.callSign ?? ""),
    `a dealt sign, not ${String(after[0]?.callSign)}`,
  );
});

test("a teammate's older connection is named by the roster read too", async () => {
  // The roster is the only path that reads somebody else's connection, so an
  // agent belonging to a person who has not opened their own dashboard since
  // is named here or nowhere.
  const harness = await createHarness();
  await seedUnnamedConnection(harness, "teammate");
  // The roster is built from the credentials a person actually holds, so the
  // teammate needs one for their agent to be in it at all.
  const store = await UserCredentialStore.open(
    path.join(harness.project.directory, "secrets"),
  );
  await store.put("teammate", "claude", {
    kind: "oauth_token",
    secret: "sk-ant-oat01-teammates-own",
  });
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner(CLAUDE_OK),
    credentials: store,
  });

  const roster = await service.listConnectionsFor(["teammate"]);
  const sign = roster["teammate"]?.[0]?.callSign;
  assert.ok(sign !== undefined, "the teammate's agent is named");
  // Their own dashboard reports the same name, in every channel, forever.
  assert.equal(
    (await service.list({ userId: "teammate", systemAdmin: true })).find(
      (entry) => entry.id === "anthropic",
    )?.callSign,
    sign,
  );
});

test("a ceremonial line runs on the cheap model, and real work does not", async () => {
  const harness = await createHarness();
  const seen: string[][] = [];
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      claude: (args) => {
        if (args[0] === "auth") {
          return output(
            JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
          );
        }
        // Detection probes (`--help`, `--version`) run through the same
        // runner; only the completions are being measured here.
        if (args.includes("--output-format")) {
          seen.push([...args]);
        }
        return output(
          [
            JSON.stringify({
              type: "assistant",
              message: { content: [{ type: "text", text: "Retry loop" }] },
            }),
            JSON.stringify({ type: "result", is_error: false }),
          ].join("\n"),
        );
      },
    }),
  });
  await service.connect({
    userId: "u",
    systemAdmin: true,
    provider: "anthropic",
  });
  await service.setSettings({
    userId: "u",
    provider: "anthropic",
    model: "claude-opus-5",
  });

  const modelOf = (args: readonly string[]) =>
    args[args.indexOf("--model") + 1];
  const effortOf = (args: readonly string[]) =>
    args[args.indexOf("--effort") + 1];

  // The account chose Opus. A six-word thread title is not worth it, so a
  // ceremonial turn is answered by Haiku instead.
  await service.complete({
    userId: "u",
    systemAdmin: true,
    provider: "anthropic",
    messages: [{ role: "user", content: "name this task thread" }],
    ceremonial: true,
  });
  assert.equal(modelOf(seen[0] ?? []), "claude-haiku-4-5");
  // And it does not reason about it for seconds either. Somebody is waiting
  // on this line in a chat window, and it is one word long.
  assert.equal(effortOf(seen[0] ?? []), "low");

  // And the override reaches nothing else: a real turn is still the model the
  // account is paying for and chose on purpose.
  await service.complete({
    userId: "u",
    systemAdmin: true,
    provider: "anthropic",
    messages: [{ role: "user", content: "now do the actual work" }],
  });
  assert.equal(modelOf(seen[1] ?? []), "claude-opus-5");
  assert.equal(effortOf(seen[1] ?? []), "high");
});

test("claude's cache tokens are counted, not silently dropped", () => {
  // Claude Code reports the prompt in three parts. `input_tokens` alone is
  // the uncached remainder, so reading it as "the prompt" understates a
  // well-cached turn by however well the cache worked.
  const reply = parseClaudeStreamJson(
    [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "done" }] },
      }),
      JSON.stringify({
        type: "result",
        is_error: false,
        result: "done",
        usage: {
          input_tokens: 2_000,
          cache_read_input_tokens: 18_478,
          cache_creation_input_tokens: 7_284,
          output_tokens: 12,
        },
      }),
    ].join("\n"),
    "claude-sonnet-5",
  );
  assert.equal(reply.usage?.inputTokens, 2_000);
  assert.equal(reply.usage?.cachedInputTokens, 25_762);
  assert.equal(reply.usage?.outputTokens, 12);

  // A provider that reports no cache fields at all must not gain a zero —
  // "cached nothing" and "said nothing about caching" are different answers.
  const quiet = parseClaudeStreamJson(
    [
      JSON.stringify({
        type: "result",
        is_error: false,
        result: "done",
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    ].join("\n"),
    "claude-sonnet-5",
  );
  assert.equal(quiet.usage?.cachedInputTokens, undefined);
});

/**
 * A failed run has to say what went wrong in words the person reading a chat
 * can use. `stream-json` opens every run with an `init` event listing the
 * cwd, the session id and every tool name the CLI knows, so quoting the head
 * of stdout quoted that banner — which is how a channel reply came out as
 * `The claude CLI exited 1: {"type":"system","subtype":"init","cwd":...` with
 * the actual reason off the end of the line.
 */
test("a failed CLI run is reported by its own error, not by its opening banner", async () => {
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      claude: (args) => {
        if (args[0] === "auth") {
          return output(
            JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
          );
        }
        // Detection probes (`--version`, `--help`) run through the same
        // runner and must still succeed.
        if (!args.includes("--output-format")) {
          return output("claude 1.2.3");
        }
        return output(
          [
            JSON.stringify({
              type: "system",
              subtype: "init",
              cwd: "/tmp/coord-provider-chat",
              session_id: "7489ef88-8a9f-474d-a3bf-6fb01ea98bf4",
              tools: ["Task", "Bash", "CronCreate", "CronDelete", "CronList"],
            }),
            JSON.stringify({
              type: "result",
              subtype: "error_during_execution",
              is_error: true,
              result: "Prompt is too long for the selected model",
            }),
          ].join("\n"),
          1,
        );
      },
    }),
  });
  await service.connect({
    userId: "u",
    systemAdmin: true,
    provider: "anthropic",
  });
  await assert.rejects(
    service.complete({
      userId: "u",
      systemAdmin: true,
      provider: "anthropic",
      messages: [{ role: "user", content: "what does it actually mean?" }],
    }),
    (error: unknown) =>
      error instanceof ProviderChatError &&
      error.code === "cli_failed" &&
      /Prompt is too long for the selected model/u.test(error.message) &&
      // Not the banner the run opened with.
      !/"subtype":"init"|coord-provider-chat/u.test(error.message),
  );
});

/**
 * The CLI can say everything it had to say and still exit non-zero on the way
 * out. The answer is what was asked for, so it outlives the exit code.
 */
test("an answer already written survives a non-zero exit", async () => {
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      claude: (args) => {
        if (args[0] === "auth") {
          return output(
            JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
          );
        }
        // Detection probes (`--version`, `--help`) run through the same
        // runner and must still succeed.
        if (!args.includes("--output-format")) {
          return output("claude 1.2.3");
        }
        return output(
          [
            JSON.stringify({
              type: "assistant",
              message: {
                content: [{ type: "text", text: "The whole answer." }],
              },
            }),
            JSON.stringify({
              type: "result",
              is_error: false,
              result: "The whole answer.",
              session_id: "sess-4321",
            }),
          ].join("\n"),
          1,
        );
      },
    }),
  });
  await service.connect({
    userId: "u",
    systemAdmin: true,
    provider: "anthropic",
  });
  const reply = await service.complete({
    userId: "u",
    systemAdmin: true,
    provider: "anthropic",
    messages: [{ role: "user", content: "what does it actually mean?" }],
  });
  assert.equal(reply.text, "The whole answer.");

  // A run that exits non-zero with nothing usable is still a failure: the
  // rescue is for answers, not for silence.
  const empty = parseClaudeStreamJson(
    [JSON.stringify({ type: "result", is_error: false, result: "" })].join("\n"),
    "claude-sonnet-5",
  );
  assert.equal(empty.text, "");
});

test("an expired org-wide agent comes back org-wide, not private", async () => {
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      claude: (args) =>
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
                  session_id: "sess-reconnect",
                  usage: { input_tokens: 1, output_tokens: 1 },
                }),
              ].join("\n"),
            ),
    }),
  });

  const connected = await service.connectOwnCredential({
    userId: "u1",
    provider: "anthropic",
    kind: "oauth_token",
    secret: "sk-ant-oat01-org-wide-token",
    visibility: "org",
  });
  assert.equal(
    connected.find((entry) => entry.id === "anthropic")?.ownCredential
      ?.visibility,
    "org",
  );

  // What expiry does to a stored agent: it is still there, and still the
  // agent the channel knows, but nothing it is asked to do authenticates.
  await service.noteAuthFailure({
    userId: "u1",
    provider: "anthropic",
    reason: "The sign-in has expired. Reconnect this agent.",
  });

  // The reconnect says nothing about who may task it — the dashboard's
  // connect box sends a visibility only to ask for something other than the
  // default — and that used to hand the agent back as personal, so every
  // teammate who could @mention it silently lost it.
  const reconnected = await service.connectOwnCredential({
    userId: "u1",
    provider: "anthropic",
    kind: "oauth_token",
    secret: "sk-ant-oat01-fresh-token",
  });
  assert.equal(
    reconnected.find((entry) => entry.id === "anthropic")?.ownCredential
      ?.visibility,
    "org",
  );

  // And the roster every other member reads agrees.
  const roster = await service.listConnectionsFor(["u1"]);
  assert.deepEqual(
    roster["u1"]?.map((entry) => [entry.provider, entry.visibility]),
    [["anthropic", "org"]],
  );
});

test("claude chat args carry --allowedTools including Bash and --disallowedTools for Edit/Write", async () => {
  // The permission boundary is the flags, not the prompt. Headless Claude Code
  // denies every tool it was not granted, and there is nobody at a chat window
  // to approve one — so "how many lines is this repository?" used to come back
  // as a refusal to run `git ls-files` rather than as a number.
  const harness = await createHarness();
  const completions: string[][] = [];
  const streams: string[][] = [];
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      claude: (args) => {
        if (args.includes("--output-format")) completions.push([...args]);
        return CLAUDE_OK.claude(args);
      },
    }),
    streamRunner: async (_command, args, _options, onLine) => {
      streams.push([...args]);
      const lines = [
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
      ];
      for (const line of lines) onLine(line);
      return output(lines.join("\n"));
    },
  });
  await service.connect({
    userId: "u",
    systemAdmin: true,
    provider: "anthropic",
  });
  assert.equal(
    (
      await service.complete({
        userId: "u",
        systemAdmin: true,
        provider: "anthropic",
        messages: [{ role: "user", content: "how many lines is this?" }],
      })
    ).text,
    "hi",
  );
  assert.equal(
    (
      await service.completeStream(
        {
          userId: "u",
          systemAdmin: true,
          provider: "anthropic",
          messages: [{ role: "user", content: "how many lines is this?" }],
        },
        () => {},
      )
    ).text,
    "hi",
  );

  const permitted = (args: string[]) => ({
    granted: (args[args.indexOf("--allowedTools") + 1] ?? "").split(","),
    refused: (args[args.indexOf("--disallowedTools") + 1] ?? "").split(","),
  });
  // Both halves of the answer path: a thread reply streams and a channel
  // answer does not, and a question must not be answered under different
  // rules depending on where it was typed.
  for (const args of [...completions, ...streams]) {
    const { granted, refused } = permitted(args);
    assert.ok(granted.includes("Bash"), `no shell in ${granted.join(",")}`);
    assert.ok(granted.includes("Read"));
    for (const tool of ["Edit", "Write", "NotebookEdit"]) {
      assert.ok(!granted.includes(tool), `${tool} was granted`);
      assert.ok(refused.includes(tool), `${tool} was not refused`);
    }
  }
  assert.ok(completions.length >= 1 && streams.length >= 1);
});

/**
 * Cursor's agent settings showed "cursor default" and no way to change it.
 * `options()` returned no model list, and the control is a dropdown — so an
 * empty list is an empty control, whatever `allowCustomModel` says. The CLI
 * can simply be asked, and this pins the shape it answers in.
 *
 * Taken from the CLI's own renderer: a dim "Available models" header, a blank
 * line, one line per model as `id - Display Name` with a dim
 * `(current, default)` marker, then a closing tip. Colour codes included,
 * because the real output carries them.
 */
test("Cursor's reported model list is read back, markers and colours and all", () => {
  const esc = String.fromCharCode(27);
  const dim = (text: string) => `${esc}[2m${text}${esc}[0m`;
  const cyan = (text: string) => `${esc}[36m${text}${esc}[0m`;
  const stdout = [
    dim("Available models"),
    "",
    `${cyan("gpt-5")} ${dim("- GPT-5")}${dim(" (default)")}`,
    `${cyan("sonnet-4-thinking")} ${dim("- Claude Sonnet 4 Thinking")}${dim(" (current)")}`,
    `${cyan("claude-opus-4-8")} ${dim("- Claude Opus 4.8")}`,
    // A model the CLI lists with no display name at all.
    cyan("composer-1"),
    "",
    dim("Tip: use --model <id> (or /model <id> in interactive mode) to switch."),
  ].join("\n");

  assert.deepEqual(parseCursorModelList(stdout), [
    { id: "gpt-5", label: "GPT-5" },
    { id: "sonnet-4-thinking", label: "Claude Sonnet 4 Thinking" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "composer-1", label: "composer-1" },
  ]);
});

test("cursor status becomes a usage report of the facts Cursor actually reports", () => {
  const report = parseCursorUsage(
    JSON.stringify({
      loggedIn: true,
      email: "nathan@example.com",
      plan: "pro",
      version: "2026.08.20",
      // A secret is never a fact to put on a card, however the CLI labels it.
      accessToken: "cur-secret-token",
      quota: { usedPercent: 42 },
    }),
  );

  assert.equal(report.unavailableReason, undefined);
  assert.equal(report.planType, "pro");
  assert.equal(report.windows[0]?.percentUsed, 42);
  assert.equal(report.windows[0]?.label, "Quota");
  assert.deepEqual(report.notes, [
    "Logged in: yes",
    "Email: nathan@example.com",
    "Version: 2026.08.20",
  ]);
  assert.ok(!JSON.stringify(report).includes("cur-secret-token"));
});

test("the plain-text status is read too, and a rejected flag is not an account", () => {
  const plain = parseCursorUsage(
    [
      "Cursor Agent Status",
      "",
      "Logged in: yes",
      "Account: nathan@example.com",
      "Plan: pro",
      "Usage this month: 42% used",
    ].join("\n"),
  );
  assert.equal(plain.unavailableReason, undefined);
  assert.equal(plain.planType, "pro");
  assert.equal(plain.windows[0]?.label, "Usage this month");
  assert.equal(plain.windows[0]?.percentUsed, 42);
  assert.deepEqual(plain.notes, [
    "Logged in: yes",
    "Account: nathan@example.com",
  ]);

  // A CLI that does not know `--format json` prints its own help. That is a
  // fact about the command, and reading it as fields would fill the card with
  // "Error: unknown option" as though Cursor had answered.
  const refused = parseCursorUsage(
    "error: unknown option '--format'\nUsage: cursor-agent status [options]\n",
  );
  assert.ok((refused.unavailableReason ?? "").length > 0);
  assert.deepEqual(refused.windows, []);
  assert.equal(refused.notes, undefined);

  // Signed out is said in Cursor's own terms rather than as a fault.
  assert.match(
    parseCursorUsage("Not logged in. Run `cursor-agent login`.").unavailableReason ?? "",
    /signed out/iu,
  );
});

test("cursor usage asks the CLI in the caller's own home, every time it is asked", async () => {
  const harness = await createHarness();
  const seen: string[][] = [];
  const calls: Captured[] = [];
  const store = await UserCredentialStore.open(
    path.join(harness.project.directory, "secrets"),
  );
  await store.put("cursor-user", "cursor", {
    kind: "session_file",
    secret: JSON.stringify({
      files: {
        ".cursor/cli-config.json": JSON.stringify({ token: "cursor-session" }),
      },
    }),
  });
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    credentials: store,
    runner: capturingRunner(
      {
        agent: (args) => {
          seen.push([...args]);
          return args.includes("--format")
            ? output(
                JSON.stringify({ loggedIn: true, email: "nathan@example.com" }),
              )
            : output("", 1, "not scripted");
        },
      },
      calls,
    ),
  });

  const report = await service.usage({
    provider: "cursor",
    userId: "cursor-user",
  });
  assert.deepEqual(seen, [["status", "--format", "json"]]);
  const statusCall = calls.find((call) => call.args[0] === "status");
  // The CLI reads Cursor's configuration out of the home it is handed, so a
  // usage figure is the caller's own account rather than the host's login.
  assert.ok((statusCall?.env?.["HOME"] ?? "").length > 0);
  assert.notEqual(statusCall?.env?.["HOME"], harness.home);
  assert.equal(report.unavailableReason, undefined);
  assert.deepEqual(report.notes, ["Logged in: yes", "Email: nathan@example.com"]);

  // Opening the specification again runs the command again: a cache here
  // would make the page's own refresh show a figure from minutes ago.
  await service.usage({ provider: "cursor", userId: "cursor-user" });
  assert.equal(seen.length, 2);
});

test("cursor usage falls back to plain status, and stays unavailable when there is none", async () => {
  const harness = await createHarness();
  const seen: string[][] = [];
  const olderCli = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: (async (_command: string, args: readonly string[]) => {
      seen.push([...args]);
      return args.includes("--format")
        ? output("", 1, "error: unknown option '--format'")
        : output("Logged in: yes\nPlan: pro\n");
    }) as ProcessRunner,
  });
  const older = await olderCli.usage({ provider: "cursor" });
  assert.deepEqual(seen, [["status", "--format", "json"], ["status"]]);
  assert.equal(older.unavailableReason, undefined);
  assert.equal(older.planType, "pro");

  // A CLI that is not installed, or one that never answers, leaves the card
  // saying so rather than turning the usage route into an error.
  const missing = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: (async () => {
      throw new Error("spawn agent ENOENT");
    }) as ProcessRunner,
  });
  const report = await missing.usage({ provider: "cursor" });
  assert.deepEqual(report.windows, []);
  assert.match(report.unavailableReason ?? "", /cursor/iu);
});

test("an account with no models reads as no list rather than a bad one", () => {
  assert.deepEqual(parseCursorModelList("No models available for this account."), []);
  assert.deepEqual(parseCursorModelList(""), []);
  // The tip alone, with no header, is not a model list either.
  assert.deepEqual(parseCursorModelList("Tip: use --model <id> to switch."), []);
});
