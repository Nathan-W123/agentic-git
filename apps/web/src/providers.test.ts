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
  parseClaudeUsage,
  parseCursorAccount,
  parseReportedUsage,
  parseCursorModelList,
  saysSignedIn,
  saysSignedOut,
  parseCodexAppServerRateLimits,
  parseCodexRateLimits,
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
  // The CLI's documented ids stand in until the account reports its own. The
  // point of this test is what replaces them.
  assert.ok((before.suggestedModels ?? []).length > 0);

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
  // The CLI's documented ids, offered rather than withheld. This used to send
  // none of them, reasoning that a suggestion is a guess about somebody
  // else's entitlements — true, and the right answer to `gpt-5`, which a
  // ChatGPT-account Codex answers 400 for. But the conclusion was too wide:
  // it left anybody who did not already know an id unable to name a model at
  // all. A guess that fails at planning with the CLI's own words is
  // recoverable; an empty control is not even wrong.
  assert.deepEqual(options.suggestedModels?.map((model) => model.id), [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    // The older ids an account may still be on, so a deployment the newest
    // names fail for is not left picking between six dead options and typing.
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.3-codex",
  ]);
  // And never mistakable for the account's own answer.
  assert.match(
    (options.notes ?? []).join(" "),
    /has not cached a model list/u,
  );
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
    // Codex with no cached list is no longer the exception: it offers the
    // CLI's documented ids, keeps free text beside them, and says in its note
    // that they are suggestions rather than what the account reported.
    if (provider === "openai" && options.models === null) {
      assert.equal(options.allowCustomModel, true);
      assert.match(
        (options.notes ?? []).join(" "),
        /has not cached a model list/u,
      );
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
  assert.equal(options.modelListSource, undefined);
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

  // Codex records its limits per session, and this harness has none — and
  // says which of the several reasons for an empty card applies here.
  const codex = await service.usage({ provider: "openai" });
  assert.deepEqual(codex.windows, []);
  assert.match(codex.unavailableReason ?? "", /could not be asked|not signed in|no Codex session/iu);
});

test("parseClaudeUsage reports windows without a source line", () => {
  // The card is already the account's own usage card, so naming the command
  // it came from told the reader nothing they did not already know.
  const report = parseClaudeUsage(
    JSON.stringify({
      result: [
        "You are currently using your subscription",
        "Current session: 36% used \u00b7 resets Jul 29, 10:59am (America/Los_Angeles)",
      ].join("\n"),
    }),
  );
  assert.equal(report.source, undefined);
  assert.deepEqual(
    report.windows.map((window) => [window.label, window.percentUsed]),
    [["session", 36]],
  );
});

test("unavailable Claude usage reports carry no source line", () => {
  const report = parseClaudeUsage(
    JSON.stringify({ result: "This account uses an API key." }),
  );
  assert.equal(report.source, undefined);
  assert.deepEqual(report.windows, []);
  assert.match(report.unavailableReason ?? "", /API key/iu);
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
  assert.match(none.unavailableReason ?? "", /could not be asked|not signed in|no Codex session/iu);
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
  // The documented interface is asked first and is not scripted here, so the
  // status read answers. What this test is really holding down is below: the
  // question is put to the account, inside its own home, every time it is
  // asked.
  assert.deepEqual(seen[0], ["app-server", "--stdio"]);
  assert.deepEqual(seen[1], ["--status", "--json"]);
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
    ["app-server", "--stdio"],
    ["--status", "--json"],
    ["app-server", "--stdio"],
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
  // The app-server answers, so the status read is never reached.
  assert.deepEqual(seen, [["app-server", "--stdio"]]);
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

/**
 * Disconnecting has to remove the agent, not only its secret.
 *
 * The roster is a union of stored credentials and durable call-sign records,
 * so an agent whose credential was destroyed went on being listed in every
 * channel under the name it was dealt — disconnected everywhere except where
 * it mattered. The credential was the identity once; forgetting the record is
 * what makes the button mean what it says now.
 */
test("disconnecting forgets the agent's durable record too", async () => {
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
    secret: "sk-ant-oat01-named-then-removed",
  });
  // Connecting deals a name, which is the record this has to clear.
  await service.list({ userId: "u1", systemAdmin: false });
  assert.equal(callSigns.rows.size, 1, "connecting recorded the agent");

  await service.disconnect({ userId: "u1", provider: "anthropic" });
  assert.equal(callSigns.rows.size, 0, "and disconnecting removed it");
});

/**
 * And it stays removed once the reconciler has had a look.
 *
 * `nameUnnamedConnections` runs on the way through `list` and deals a fresh
 * name to any connection missing one, writing it back to the durable table. So
 * removing the record alone does not remove the agent: it leaves a connection
 * for the reconciler to rename, and the next roster read brings the agent back
 * under a name nobody chose. Verified by mutation — this test fails when the
 * connections-file removal is taken out of `disconnect`, and passes when the
 * two removals are swapped, which is how it is known that both are needed and
 * that their order is not what matters.
 */
test("a disconnected agent is not recreated by the next roster read", async () => {
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
    secret: "sk-ant-oat01-reconciled",
  });
  await service.list({ userId: "u1", systemAdmin: false });
  assert.equal(callSigns.rows.size, 1);

  await service.disconnect({ userId: "u1", provider: "anthropic" });

  // The read that would resurrect it.
  const after = await service.list({ userId: "u1", systemAdmin: false });
  assert.deepEqual(
    await callSigns.listAgentCallSigns(),
    [],
    "the reconciler must not deal a name to an agent that was removed",
  );
  assert.equal(
    after.find((entry) => entry.id === "anthropic")?.callSign,
    undefined,
  );
});

/**
 * The other half, and the reason this route exists at all: an agent that
 * never had a credential. Local execution runs the vendor CLI under the
 * machine's own login, so there is no secret here to destroy — the record is
 * the only thing there is, and without this there was no way to remove such
 * an agent at all.
 */
test("disconnecting removes an agent that never had a credential", async () => {
  const harness = await createHarness();
  const callSigns = fakeCallSignStore();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner(CLAUDE_PONG),
    callSigns,
  });
  await callSigns.setAgentCallSign("u1", "openai", "Eris");

  // No credential, no connection — every other step is a no-op, and this must
  // not throw on the nothing it finds.
  await service.disconnect({ userId: "u1", provider: "openai" });
  assert.deepEqual(await callSigns.listAgentCallSigns(), []);

  // And again, on an agent that is already gone.
  await service.disconnect({ userId: "u1", provider: "openai" });
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

/**
 * A card must not diagnose somebody's billing from evidence that says nothing
 * about it.
 *
 * `claude -p "/usage"` is a prompt that happens to begin with a slash, not an
 * invocation of the interactive `/usage` view. A CLI that does not recognise
 * it as a command answers with the ordinary end-of-session summary — "Total
 * cost", "Total duration", token counts — and no percentage is in it. The card
 * read that as "expected unless the account is on a subscription with limits",
 * so somebody on an ordinary subscription was told their plan was the reason
 * and had nowhere to go from there.
 */
test("a session summary is reported as the CLI not publishing a figure, not as a billing verdict", () => {
  const report = parseClaudeUsage(
    JSON.stringify({
      result: [
        "Total cost:            $0.0312",
        "Total duration (API):  4s",
        "Usage:                 120 input, 340 output",
      ].join("\n"),
    }),
  );
  assert.deepEqual(report.windows, []);
  assert.match(String(report.unavailableReason), /no subscription window to report/u);
  assert.match(String(report.unavailableReason), /machine that holds your CLI login/u);
  // Never the claim that the CLI cannot publish it: a subscription account
  // reports percentages perfectly well, and saying otherwise sent the reader
  // looking for a missing feature instead of a misdirected question.
  assert.doesNotMatch(String(report.unavailableReason), /does not publish/u);
  assert.doesNotMatch(String(report.unavailableReason), /unless the account is on a subscription/u);

  // An API-key account is still named as such, because that reading is
  // supported by what the CLI actually said.
  assert.match(
    String(parseClaudeUsage(JSON.stringify({ result: "Using API key billing" })).unavailableReason),
    /API key/u,
  );

  // And anything else is quoted rather than diagnosed.
  const odd = parseClaudeUsage(JSON.stringify({ result: "Not logged in." }));
  assert.match(String(odd.unavailableReason), /It said: Not logged in\./u);
});

/**
 * An agent that exists without a credential can still be configured.
 *
 * `setSettings` asked the old question — is a secret stored — and refused
 * every change to an agent created by the local flow: its model, its
 * reasoning level, its name, and the visibility that decides whether
 * teammates may task it. Somebody watching that agent do work was told to
 * connect the account it was plainly already using.
 */
test("settings can be changed on an agent that has no stored credential", async () => {
  const harness = await createHarness();
  const signs = new Map<string, string>();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner(CLAUDE_PONG),
    callSigns: {
      listAgentCallSigns: async () =>
        [...signs.entries()].map(([key, callSign]) => {
          const [userId = "", provider = ""] = key.split("\u0000");
          return { userId, provider, callSign };
        }),
      setAgentCallSign: async (userId, provider, callSign) => {
        signs.set(`${userId}\u0000${provider}`, callSign);
      },
      clearAgentCallSign: async (userId, provider) => {
        signs.delete(`${userId}\u0000${provider}`);
      },
    },
  });

  // No credential and no connection entry — but the agent record exists,
  // which is what having an agent means since local execution.
  signs.set("u1\u0000anthropic", "Nyx");
  await assert.doesNotReject(
    service.setSettings({ userId: "u1", provider: "anthropic", effort: "high" }),
  );

  // And an account with no agent at all is still told to connect one.
  await assert.rejects(
    service.setSettings({ userId: "u2", provider: "anthropic", effort: "high" }),
    /Connect Anthropic/u,
  );
});

/**
 * And visibility in particular, which had a second refusal behind the first:
 * it is written to the credential store, so with no credential it threw and
 * "only me" was permanent for every locally-run agent.
 */
test("visibility can be widened on an agent that has no stored credential", async () => {
  const harness = await createHarness();
  const signs = new Map<string, string>();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner(CLAUDE_PONG),
    callSigns: {
      listAgentCallSigns: async () =>
        [...signs.entries()].map(([key, callSign]) => {
          const [userId = "", provider = ""] = key.split("\u0000");
          return { userId, provider, callSign };
        }),
      setAgentCallSign: async (userId, provider, callSign) => {
        signs.set(`${userId}\u0000${provider}`, callSign);
      },
      clearAgentCallSign: async (userId, provider) => {
        signs.delete(`${userId}\u0000${provider}`);
      },
    },
  });
  signs.set("u1\u0000anthropic", "Nyx");

  await assert.doesNotReject(
    service.setSettings({
      userId: "u1",
      provider: "anthropic",
      visibility: "org",
    }),
  );
});

test("cursor usage reports that Cursor usage is not reported without running the CLI", async () => {
  // Cursor's `status` answers with an account, a plan and a version, and no
  // subscription figure — so the card was filled with facts nobody asked a
  // usage question to learn. It says the plain thing now, and asks nothing.
  const harness = await createHarness();
  const tried: string[] = [];
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: (async (command: string) => {
      tried.push(command);
      return output("");
    }) as ProcessRunner,
  });

  const report = await service.usage({ provider: "cursor" });
  assert.deepEqual(report.windows, []);
  assert.equal(report.unavailableReason, "Cursor usage not reported.");
  assert.equal(report.planType, undefined);
  assert.equal(report.notes, undefined);
  assert.deepEqual(tried, []);
});

/**
 * And a confirmation nobody recognises is not read as a refusal.
 *
 * The mirror of the test below, and the one that was missing. A signed-in
 * Codex may say "Logged in using ChatGPT", or "Authenticated", or print an
 * account line with no verb in it — the wording has changed between releases.
 * Demanding one of two English phrases before believing it told somebody with
 * a live ChatGPT session that they were not signed in, and offered them the
 * one remedy they had already carried out.
 *
 * So the exit code decides and the words only veto: a refusal is stated, a
 * success is merely exit zero.
 */
test("an unfamiliar success message is not read as a refusal", () => {
  // None of these say "logged in", and none of them are a refusal.
  assert.equal(saysSignedOut("Authenticated as nathan@example.com"), false);
  assert.equal(saysSignedOut("Account: nathan@example.com\nPlan: Plus"), false);
  assert.equal(saysSignedOut("gpt-5.6-terra medium"), false);
  assert.equal(saysSignedOut(""), false);

  // The refusals still are, in the phrasings the CLI has actually used.
  assert.equal(saysSignedOut("Not logged in. Run `codex login`."), true);
  assert.equal(saysSignedOut("not signed in"), true);
  assert.equal(saysSignedOut("No active session"), true);
  assert.equal(saysSignedOut("Please log in to continue"), true);
});

test("a refusal is not read as a confirmation", () => {
  // "logged in" is a substring of "Not logged in". Asking whether the words
  // appear reports a signed-out account as signed in, which is how an empty
  // usage card came to blame the account instead of the missing login.
  assert.equal(saysSignedIn("Not logged in. Run `codex login`."), false);
  assert.equal(saysSignedIn("not signed in"), false);
  assert.equal(saysSignedIn("No active session"), false);
  assert.equal(saysSignedIn("Please log in to continue"), false);
  assert.equal(saysSignedIn(""), false);

  assert.equal(saysSignedIn("Logged in using ChatGPT"), true);
  assert.equal(saysSignedIn("Signed in as nathan@example.com"), true);
});

test("a five-hour window survives a later event that omits it", async () => {
  // Codex emits rate_limits repeatedly through a session and the payloads are
  // not always complete. Reading only the last occurrence let one partial
  // event at the end of a rollout discard a figure sitting a few lines above
  // it, and the card showed a week with no five hours beside it.
  const rollout = [
    JSON.stringify({ type: "message", text: "…" }),
    JSON.stringify({
      type: "token_count",
      rate_limits: {
        primary: { used_percent: 34, window_minutes: 300, resets_at: 1_785_902_966 },
        secondary: { used_percent: 5, window_minutes: 10_080 },
        plan_type: "pro",
      },
    }),
    // Later, and weekly only.
    JSON.stringify({
      type: "token_count",
      rate_limits: { secondary: { used_percent: 9, window_minutes: 10_080 } },
    }),
  ].join("\n");

  const report = parseCodexRateLimits(rollout);
  assert.ok(report !== undefined);
  assert.deepEqual(
    report.windows.map((window) => [window.label, window.percentUsed]),
    [
      // The five-hour figure is kept from where it was last reported...
      ["5 hours", 34],
      // ...and the weekly one is the newer of the two readings, not the older.
      ["week", 9],
    ],
  );
  assert.equal(report.planType, "pro");
});

test("a window nobody ever reported stays absent", async () => {
  // The other half: this must not invent a window, only stop losing one.
  const report = parseCodexRateLimits(
    JSON.stringify({
      type: "token_count",
      rate_limits: { secondary: { used_percent: 9, window_minutes: 10_080 } },
    }),
  );

  assert.deepEqual(
    report?.windows.map((window) => window.label),
    ["week"],
  );
});

test("a teammate sees an agent's usage whether or not the connection is shared", async () => {
  // Usage was refused for anybody but the owner, which was one answer to a
  // real question — the route reported the *caller's* account, so showing it
  // beside somebody else's agent would have put your consumption under their
  // name. The route takes an owner now, so the figure shown beside an agent
  // is that agent's own, and everyone in the room may read it: how much of a
  // quota is left decides whether @mentioning that agent accomplishes
  // anything, and that is true of a personal connection too. The money on the
  // owner's account is the one thing that stays behind.
  const harness = await createHarness();
  const store = await UserCredentialStore.open(
    path.join(harness.project.directory, "secrets"),
  );
  await store.put("owner-user", "codex", {
    kind: "api_key",
    secret: "sk-openai-owner",
  });
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    credentials: store,
    runner: (async (_command: string, args: readonly string[]) =>
      args[0] === "--version"
        ? output("codex-cli 0.146.0")
        : args[0] === "login"
          ? output("Logged in using ChatGPT")
          : args[0] === "app-server"
            ? output(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  result: {
                    rateLimits: {
                      primary: { usedPercent: 61, windowDurationMins: 300 },
                      secondary: { usedPercent: 8, windowDurationMins: 10_080 },
                      planType: "pro",
                      // The key this parser reads: `credits.balance`.
                      credits: { balance: 1234 },
                    },
                  },
                }),
              )
            : output("", 2, "error")) as ProcessRunner,
  });

  // Personal by default, and readable all the same: the windows are the
  // owner's, not the watcher's.
  const personal = await service.usage({
    provider: "openai",
    userId: "watcher-user",
    ownerId: "owner-user",
  });
  assert.equal(personal.unavailableReason, undefined);
  assert.deepEqual(
    personal.windows.map((window) => window.percentUsed),
    [61, 8],
  );
  assert.equal(personal.creditBalance, undefined);

  // Set where `listConnectionsFor` reads it. Sharing the credential changes
  // whose account a teammate's prompt spends; it does not change what this
  // route answers.
  await store.put("owner-user", "codex", {
    kind: "api_key",
    secret: "sk-openai-owner",
    visibility: "org",
  });

  const shared = await service.usage({
    provider: "openai",
    userId: "watcher-user",
    ownerId: "owner-user",
  });
  assert.equal(shared.unavailableReason, undefined);
  assert.deepEqual(
    shared.windows.map((window) => window.percentUsed),
    [61, 8],
  );
  // Operational facts travel; a money balance on somebody else's account does
  // not, because knowing whether an agent can still work does not require it.
  assert.equal(shared.creditBalance, undefined);

  // And the owner still sees their own in full.
  const own = await service.usage({
    provider: "openai",
    userId: "owner-user",
  });
  assert.equal(own.creditBalance, 1234);
});

test("an API-key connection is told it has no quota, not left guessing", async () => {
  // The card offered "which is what an API-key account returns" as a
  // hypothesis to somebody with no way to check it, while the answer sat in
  // the stored credential the whole time. An API key has no subscription
  // quota; that closes the question rather than describing a symptom.
  const harness = await createHarness();
  const store = await UserCredentialStore.open(
    path.join(harness.project.directory, "secrets"),
  );
  await store.put("key-user", "codex", {
    kind: "api_key",
    secret: "sk-openai-key-user",
  });
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    credentials: store,
    runner: (async (_command: string, args: readonly string[]) =>
      args[0] === "--version"
        ? output("codex-cli 0.146.0")
        : args[0] === "login"
          ? output("Logged in")
          : args[0] === "app-server"
            ? output(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }))
            : output("", 2, "error: unexpected argument")) as ProcessRunner,
  });

  const said =
    (await service.usage({ provider: "openai", userId: "key-user" }))
      .unavailableReason ?? "";
  assert.match(said, /signs in with an API key/u);
  assert.match(said, /OpenAI dashboard/u);
  // And not the old hedge, which described the situation as a maybe.
  assert.doesNotMatch(said, /no Codex session has recorded/u);
});

test("an empty card names what each source answered", async () => {
  // Three rounds of this were spent guessing which step was failing, because
  // every step reports the same nothing. "The app-server replied without rate
  // limits" and "the app-server could not be started" are different problems
  // with different fixes, and the card could not tell them apart.
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: (async (_command: string, args: readonly string[]) => {
      if (args[0] === "--version") {
        return output("codex-cli 0.146.0");
      }
      if (args[0] === "login") {
        return output("Logged in using ChatGPT");
      }
      if (args[0] === "app-server") {
        // Answers, but with no rateLimits — what an API-key account returns.
        return output(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
        );
      }
      return output("", 1, "error: unknown flag --status");
    }) as ProcessRunner,
  });

  const report = await service.usage({ provider: "openai" });
  const said = report.unavailableReason ?? "";
  assert.match(said, /Tried:/u);
  assert.match(said, /rateLimits\/read replied without rate limits/u);
  assert.match(said, /--status --json exited 1/u);
  assert.match(said, /no session records/u);
});

test("a silent app-server is quoted, not read as an account with no quota", async () => {
  // "Returned nothing" was the one outcome that said nothing about the
  // account and still sat beside a sentence blaming it. An app-server that
  // does not answer is a CLI without the interface, a deadline, or a refusal
  // it can name — and which of those it is decides the fix.
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: (async (_command: string, args: readonly string[]) => {
      if (args[0] === "--version") {
        return output("codex-cli 0.146.0");
      }
      if (args[0] === "login") {
        return output("Logged in using ChatGPT");
      }
      if (args[0] === "app-server") {
        return output("", 2, "error: unrecognized subcommand 'app-server'");
      }
      return output("", 2, "error: unexpected argument '--status'");
    }) as ProcessRunner,
  });

  const said = (await service.usage({ provider: "openai" })).unavailableReason ?? "";
  assert.match(said, /codex app-server said nothing \(exit 2/u);
  assert.match(said, /unrecognized subcommand/u);
  // And it is not reported as the account having answered with no limits.
  assert.doesNotMatch(said, /replied without rate limits/u);
});

test("a connection failure is the answer, not a quota of zero", async () => {
  // The remaining way to reach the blanket sentence: opening the caller's
  // credential home fails, the whole in-home block is skipped, and the card
  // reported an account quota for a connection that was never established.
  const harness = await createHarness();
  const store = await UserCredentialStore.open(
    path.join(harness.project.directory, "secrets"),
  );
  await store.put("disconnected-user", "codex", {
    kind: "api_key",
    secret: "sk-openai-disconnected",
  });
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    // Delegating rather than spread: a spread of a class instance keeps none
    // of its prototype methods, and the reader needs the real ones.
    credentials: new Proxy(store, {
      get: (target, property) => {
        if (property === "openCredentialHome") {
          return async () => undefined;
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    runner: scriptedRunner({}),
  });

  const report = await service.usage({
    provider: "openai",
    userId: "disconnected-user",
  });
  assert.deepEqual(report.windows, []);
  assert.match(report.unavailableReason ?? "", /not connected to Codex/u);
  assert.doesNotMatch(report.unavailableReason ?? "", /reported no quota/u);
});

test("a caller with no stored connection is told whose quota was read", async () => {
  // A host-login deployment legitimately has no per-user credential, and the
  // read still happens — but against the machine's login, not this person's.
  // Saying so is the difference between "you have no quota" and "that was not
  // your account".
  const harness = await createHarness();
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

  const report = await service.usage({
    provider: "openai",
    userId: "no-connection-user",
  });
  assert.match(report.unavailableReason ?? "", /rather than of you/u);
});

test("an empty usage card says what is actually in the way", async () => {
  // One sentence used to cover four situations — the CLI missing, signed out,
  // too old, or an account with genuinely no subscription quota — and it
  // asserted the last of them every time. "Codex reported no quota" describes
  // a Codex that was never successfully asked, and leaves nothing to do about
  // it.
  const harness = await createHarness();

  const noBinary = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: (async () => {
      throw new Error("spawn codex ENOENT");
    }) as ProcessRunner,
  });
  const missing = await noBinary.usage({ provider: "openai" });
  assert.deepEqual(missing.windows, []);
  assert.match(missing.unavailableReason ?? "", /could not be run where Kumi/u);
  assert.match(missing.unavailableReason ?? "", /ENOENT/u);

  const signedOut = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: (async (_command: string, args: readonly string[]) => {
      if (args[0] === "--version") {
        return output("codex-cli 0.146.0");
      }
      if (args[0] === "login") {
        return output("Not logged in.");
      }
      // Neither quota source answers.
      return output("");
    }) as ProcessRunner,
  });
  const out = await signedOut.usage({ provider: "openai" });
  assert.deepEqual(out.windows, []);
  assert.match(out.unavailableReason ?? "", /not signed in/u);

  // Installed, signed in, and simply nothing to report: the plain answer is
  // the true one here, and it now says why that can legitimately happen.
  const noQuota = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: (async (_command: string, args: readonly string[]) =>
      args[0] === "--version"
        ? output("codex-cli 0.146.0")
        : args[0] === "login"
          ? output("Logged in using ChatGPT")
          : output("")) as ProcessRunner,
  });
  const quiet = await noQuota.usage({ provider: "openai" });
  assert.match(quiet.unavailableReason ?? "", /billed by API key/u);
});

test("Cursor is found under the name its installer actually uses", async () => {
  // The spec asked for `agent` and nothing else, while Cursor publishes
  // `cursor-agent` — the name in its own issue tracker and in the help text
  // these tests quote back. On a machine with only the published name, every
  // Cursor call failed at once and silently: no detection, no sign-in, no
  // model list.
  const harness = await createHarness();
  const tried: string[] = [];
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: (async (command: string) => {
      if (command === "agent" || command === "cursor-agent") {
        tried.push(command);
      }
      if (command === "agent") {
        // What a shell says about a command it cannot find.
        return output("", 127, "'agent' is not recognized as an internal or external command");
      }
      return output("2026.08.20");
    }) as ProcessRunner,
  });

  const cursor = (await service.list({ userId: "u", systemAdmin: true })).find(
    (status) => status.id === "cursor",
  );
  assert.deepEqual(tried, ["agent", "cursor-agent"]);
  assert.equal(cursor?.cli.detected, true);
});

test("a CLI that ran and refused is not retried under another name", async () => {
  // The other half. Exit 127 with a shell's "not recognized" means nothing
  // ran; any other refusal is an answer, and asking a second binary the same
  // question would turn one real failure into two.
  const harness = await createHarness();
  const tried: string[] = [];
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: (async (command: string) => {
      if (command === "agent" || command === "cursor-agent") {
        tried.push(command);
      }
      return output("", 1, "error: you are not authorized");
    }) as ProcessRunner,
  });

  const cursor = (await service.list({ userId: "u", systemAdmin: true })).find(
    (status) => status.id === "cursor",
  );
  assert.deepEqual([...new Set(tried)], ["agent"]);
  assert.equal(cursor?.cli.detected, false);
});

test("an account with no models reads as no list rather than a bad one", () => {
  assert.deepEqual(parseCursorModelList("No models available for this account."), []);
  assert.deepEqual(parseCursorModelList(""), []);
  // The tip alone, with no header, is not a model list either.
  assert.deepEqual(parseCursorModelList("Tip: use --model <id> to switch."), []);
});

/**
 * The quota figure comes from the machine that holds the login.
 *
 * Reading it here needed a vendor credential stored here, and that credential
 * was the whole reason connecting an agent asked for a second sign-in —
 * nothing else wanted it, since the agent runs on somebody's own machine under
 * the login its CLI already has. Worse, with no credential the question was
 * put to the container's own login, so the card answered a question about one
 * account with another account's numbers.
 */
test("a usage reading from the machine is preferred over asking here", async () => {
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner(CLAUDE_PONG),
  });

  const parsed = await service.reportUsage({
    userId: "u1",
    provider: "anthropic",
    raw: JSON.stringify({
      result:
        "Current session: 36% used · resets Jul 29, 10:59am (America/Los_Angeles)",
    }),
  });
  assert.equal(parsed.windows.length, 1);
  assert.equal(parsed.windows[0]?.percentUsed, 36);

  const shown = await service.usage({ userId: "u1", provider: "anthropic" });
  assert.equal(shown.windows[0]?.percentUsed, 36);
  // Stamped, because a machine that has been asleep for a day is not
  // reporting today's quota and the card has to be able to say so.
  assert.ok(shown.asOf !== undefined, JSON.stringify(shown));
  assert.doesNotThrow(() => new Date(String(shown.asOf)).toISOString());
});

/**
 * And it stands while the machine is off. That is the point of keeping it: an
 * agent asleep is exactly when somebody looks at the card wondering where
 * their quota went, and an empty card answers nothing.
 */
test("the last reading survives the machine going away", async () => {
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    // A runner that fails every call, standing in for a machine that is gone
    // and a control plane with no credential to fall back on.
    runner: async () => {
      throw new Error("no CLI here");
    },
  });
  await service.reportUsage({
    userId: "u1",
    provider: "anthropic",
    raw: JSON.stringify({ result: "Current week (all models): 19% used · resets Jul 31, 9:59am (x)" }),
  });

  const shown = await service.usage({ userId: "u1", provider: "anthropic" });
  assert.equal(shown.windows[0]?.percentUsed, 19);
  assert.equal(shown.unavailableReason, undefined, "a kept figure is not a failure");

  // One person's figure is never handed to the next person who asks.
  const other = await service.usage({ userId: "u2", provider: "anthropic" });
  assert.notEqual(other.windows[0]?.percentUsed, 19);
});

/**
 * The other two vendors, read the same way.
 *
 * Claude was the only one a machine could report, which left Codex still
 * shelling out on the control plane — against the operator's login, on a
 * deployment where everybody signs in as themselves — and Cursor showing
 * nothing at all. All three are asked on the machine now, and the parsing
 * here is the same parsing that already ran when this process did the asking.
 */
test("a machine can report Codex quota, through whichever reader answered", () => {
  // What `account/rateLimits/read` replies with: the documented interface,
  // tried first because a rename inside the status view must not outrank it.
  const appServer = parseReportedUsage(
    "openai",
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        rateLimits: {
          primary: { usedPercent: 41, windowDurationMins: 300 },
          secondary: { usedPercent: 12, windowDurationMins: 10_080 },
        },
      },
    })}\n`,
  );
  assert.equal(appServer.windows.length, 2);
  assert.equal(appServer.windows[0]?.percentUsed, 41);

  // And the fallback, for a CLI too old to have that method.
  const status = parseReportedUsage(
    "openai",
    JSON.stringify({
      rate_limits: { primary: { used_percent: 55, window_minutes: 300 } },
    }),
  );
  assert.equal(status.windows[0]?.percentUsed, 55);
});

/**
 * An account with no subscription quota is not a fault to go looking for.
 *
 * A Codex account billed by API key answers the quota question with a
 * perfectly healthy reply carrying no rate limits, and an empty card sent
 * three rounds of diagnosis after a break that was never there.
 */
test("a Codex reply with no rate limits says why rather than showing nothing", () => {
  const report = parseReportedUsage("openai", JSON.stringify({ result: {} }));
  assert.deepEqual(report.windows, []);
  assert.match(String(report.unavailableReason), /API key/u);

  const silent = parseReportedUsage("openai", "");
  assert.match(String(silent.unavailableReason), /reported nothing/u);

  // And a CLI that complained instead of replying is quoted rather than
  // diagnosed. Saying "API key" about this blamed a healthy account's billing
  // for a CLI too old to have the method that was asked.
  const complaint = parseReportedUsage(
    "openai",
    "error: unrecognized subcommand 'app-server'",
  );
  assert.doesNotMatch(String(complaint.unavailableReason), /API key/u);
  assert.match(String(complaint.unavailableReason), /unrecognized subcommand/u);
});

/**
 * Cursor publishes no quota, so the machine reports the one fact its status
 * view does carry: which account is signed in there. That is what somebody is
 * actually checking when they open this card, and it is a reading rather than
 * a number invented to fill the space.
 */
test("Cursor reports the signed-in account, and no invented quota", () => {
  const report = parseReportedUsage(
    "cursor",
    ["Cursor Agent CLI 2026.4.1", "Logged in as: dev@example.com", "Plan: pro"].join("\n"),
  );
  assert.deepEqual(report.windows, []);
  assert.match(String(report.unavailableReason), /dev@example\.com/u);
  assert.match(String(report.unavailableReason), /no usage figure/u);

  // An unrecognised status view is reported as no account, not guessed at.
  const unknown = parseReportedUsage("cursor", "Cursor Agent CLI 2026.4.1");
  assert.equal(parseCursorAccount("Cursor Agent CLI 2026.4.1"), undefined);
  assert.match(String(unknown.unavailableReason), /no quota to show/u);
});

/**
 * And a reading beats the per-vendor answer this process would otherwise
 * give. Cursor is the one that proves it: the reasoning used to return before
 * the kept reading was even consulted, so a machine could report and the card
 * would still say Cursor usage is not reported.
 */
test("a machine reading is preferred for every vendor, not only the two we can run", async () => {
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: async () => {
      throw new Error("nothing runs here");
    },
  });
  await service.reportUsage({
    userId: "u1",
    provider: "cursor",
    raw: "Logged in as: dev@example.com",
  });

  const shown = await service.usage({ userId: "u1", provider: "cursor" });
  assert.match(String(shown.unavailableReason), /dev@example\.com/u);
  assert.ok(shown.asOf !== undefined);

  // Nobody has reported for this one, so it still says the plain thing.
  const unreported = await service.usage({ userId: "u2", provider: "cursor" });
  assert.equal(unreported.unavailableReason, "Cursor usage not reported.");
});
