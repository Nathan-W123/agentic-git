import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoordinatorProject } from "@coord/cli/project";

import {
  ProviderChatError,
  ProviderChatService,
  parseDeviceAuthLine,
  type ProcessRunner,
} from "./providers.js";

/**
 * Device authorization is the one connection flow that is a real grant rather
 * than a copied secret: the CLI runs here, the user approves it in their own
 * browser, and the vendor issues *this deployment* a session.
 *
 * It is also the only flow that spans several requests, so these tests cover
 * the seams that creates — the code is parsed out of prose, the login cannot
 * reach the host's own credentials, one user cannot touch another's flow, and
 * a login that never lands stores nothing.
 */

async function createHarness(): Promise<{
  project: CoordinatorProject;
  home: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cdeviceauth-"));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const project = await CoordinatorProject.init(path.join(root, "cp"));
  return { project, home };
}

function output(stdout: string, exitCode = 0, stderr = "") {
  return { exitCode, stdout, stderr, durationMs: 1 };
}

function scriptedRunner(
  script: Record<
    string,
    (args: readonly string[]) => ReturnType<typeof output>
  >,
): ProcessRunner {
  return (async (command: string, args: readonly string[]) => {
    const name = path.basename(String(command)).replace(/\.exe$/iu, "");
    const handler = script[name];
    return handler === undefined
      ? output("", 127, `${name}: not scripted`)
      : handler(args);
  }) as ProcessRunner;
}

/**
 * The installed CLI's real device-auth banner, colour codes and all.
 *
 * Built with an explicit escape character rather than pasted, so the file
 * stays plain ASCII while the parser still faces exactly what it must survive:
 * numbered prose, ANSI wrappers, and an expiry stated in a sentence.
 */
const ESC = String.fromCharCode(27);
const DEVICE_AUTH_OUTPUT = [
  `Welcome to Codex [v${ESC}[90m0.146.0${ESC}[0m]`,
  "",
  "Follow these steps to sign in with ChatGPT using device code authorization:",
  "",
  "1. Open this link in your browser and sign in to your account",
  `   ${ESC}[94mhttps://auth.openai.com/codex/device${ESC}[0m`,
  "",
  `2. Enter this one-time code ${ESC}[90m(expires in 15 minutes)${ESC}[0m`,
  `   ${ESC}[94m7EH1-W9FEV${ESC}[0m`,
];

const CODEX_SESSION = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    id_token: "id",
    access_token: "access-wxyz",
    refresh_token: "refresh",
    account_id: "acct",
  },
});

/** A device-auth CLI under test control: it emits the real banner, then waits. */
function scriptedDeviceAuth(options: {
  writesAuthJson?: string;
  exitCode?: number;
}) {
  const calls: Array<{ env: NodeJS.ProcessEnv }> = [];
  let release: (() => void) | undefined;
  const spawner = (
    _command: string,
    _args: readonly string[],
    spawnOptions: { env: NodeJS.ProcessEnv },
    onLine: (line: string) => void,
  ) => {
    calls.push({ env: spawnOptions.env });
    for (const line of DEVICE_AUTH_OUTPUT) {
      onLine(line);
    }
    const done = new Promise<ReturnType<typeof output>>((resolve) => {
      release = () => {
        void (async () => {
          if (options.writesAuthJson !== undefined) {
            await writeFile(
              path.join(String(spawnOptions.env["CODEX_HOME"]), "auth.json"),
              options.writesAuthJson,
              "utf8",
            );
          }
          resolve(output("", options.exitCode ?? 0));
        })();
      };
    });
    return { done, kill: () => release?.(), write: () => undefined };
  };
  return { spawner, calls, finish: () => release?.() };
}

/** Polls until the flow leaves `pending`, the way the browser does. */
async function settledStatus(
  service: ProviderChatService,
  userId: string,
  flowId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await service.deviceAuthStatus({ userId, flowId });
    if (state.status !== "pending") {
      return state.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return "never-settled";
}

test("the device code and link are parsed out of the CLI's own banner", () => {
  const seen = DEVICE_AUTH_OUTPUT.map((line) => parseDeviceAuthLine(line));
  assert.equal(
    seen.find((entry) => entry.url)?.url,
    "https://auth.openai.com/codex/device",
    "the URL must not carry colour codes",
  );
  assert.equal(seen.find((entry) => entry.code)?.code, "7EH1-W9FEV");
  assert.equal(
    seen.find((entry) => entry.expiresInMinutes)?.expiresInMinutes,
    15,
  );
  // Prose that merely contains a hyphenated run is not a code.
  assert.equal(
    parseDeviceAuthLine("Follow these steps to sign-in NOW").code,
    undefined,
  );
});

test("device authorization stores the session the vendor issued", async () => {
  const harness = await createHarness();
  const device = scriptedDeviceAuth({ writesAuthJson: CODEX_SESSION });
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      codex: (args) =>
        args[0] === "login"
          ? output(JSON.stringify({ loggedIn: true }))
          : output(
              JSON.stringify({
                type: "item.completed",
                item: { type: "agent_message", text: "pong" },
              }),
            ),
    }),
    longRunningSpawner: device.spawner,
  });

  const started = await service.startDeviceAuth({
    userId: "u1",
    provider: "openai",
  });
  assert.equal(started.verificationUrl, "https://auth.openai.com/codex/device");
  assert.equal(started.userCode, "7EH1-W9FEV");

  // The login must not be able to reach the host's own Codex credentials.
  const spawnEnv = device.calls[0]?.env ?? {};
  assert.ok(String(spawnEnv["CODEX_HOME"] ?? "").length > 0);
  assert.notEqual(spawnEnv["CODEX_HOME"], path.join(harness.home, ".codex"));
  assert.equal(spawnEnv["OPENAI_API_KEY"], undefined);

  assert.equal(
    (await service.deviceAuthStatus({ userId: "u1", flowId: started.flowId }))
      .status,
    "pending",
  );

  device.finish();
  assert.equal(await settledStatus(service, "u1", started.flowId), "completed");

  const statuses = await service.list({ userId: "u1", systemAdmin: false });
  const openai = statuses.find((entry) => entry.id === "openai");
  assert.equal(openai?.ownCredential?.kind, "session_file");
  // Issued to this deployment, so it shares no refresh token with the user's
  // own machine and must not be labelled as though it does.
  assert.equal(openai?.ownCredential?.origin, "device_auth");
});

test("one user cannot poll or cancel another user's device flow", async () => {
  const harness = await createHarness();
  const device = scriptedDeviceAuth({ writesAuthJson: CODEX_SESSION });
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({ codex: () => output("{}") }),
    longRunningSpawner: device.spawner,
  });
  const started = await service.startDeviceAuth({
    userId: "owner",
    provider: "openai",
  });

  await assert.rejects(
    service.deviceAuthStatus({ userId: "intruder", flowId: started.flowId }),
    (error: unknown) =>
      error instanceof ProviderChatError && error.code === "unknown_flow",
  );
  // A cancel from the wrong user must be a no-op, not a denial of service.
  await service.cancelDeviceAuth({
    userId: "intruder",
    flowId: started.flowId,
  });
  assert.equal(
    (
      await service.deviceAuthStatus({
        userId: "owner",
        flowId: started.flowId,
      })
    ).status,
    "pending",
  );
});

test("a login that never writes auth.json fails instead of looking connected", async () => {
  const harness = await createHarness();
  const device = scriptedDeviceAuth({ exitCode: 1 });
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({ codex: () => output("{}") }),
    longRunningSpawner: device.spawner,
  });
  const started = await service.startDeviceAuth({
    userId: "u1",
    provider: "openai",
  });
  device.finish();

  assert.equal(await settledStatus(service, "u1", started.flowId), "failed");
  const statuses = await service.list({ userId: "u1", systemAdmin: false });
  assert.equal(
    statuses.find((entry) => entry.id === "openai")?.ownCredential,
    undefined,
    "nothing may be stored when the grant never landed",
  );
});

test("providers without a sign-in flow say so rather than pretending", async () => {
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      claude: () => output(JSON.stringify({ loggedIn: true })),
    }),
  });
  // Anthropic used to be on this list. It is not any more: `claude auth login`
  // can be driven from a server, and the test for that is below. Google stays,
  // because its CLI has no login subcommand at all — authentication is a menu
  // inside the interactive UI, so there is nothing here to drive.
  await assert.rejects(
    service.startDeviceAuth({ userId: "u1", provider: "google" }),
    (error: unknown) =>
      error instanceof ProviderChatError && error.code === "unsupported_flow",
  );
});

/**
 * The real `claude auth login` banner, as the installed CLI prints it when no
 * browser opens. The redirect target matters and is kept verbatim: it is
 * `platform.claude.com`, not a localhost port, which is the whole reason this
 * flow can be driven from a server the user's browser cannot reach.
 */
const CLAUDE_LOGIN_OUTPUT = [
  "Opening browser to sign in…",
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize" +
    "?code=true&client_id=9d1c250a&response_type=code" +
    "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback",
  "Paste code here if prompted > ",
];

/**
 * A Claude sign-in under test control: it prints the banner, waits on stdin,
 * and only writes its configuration once a code has been handed to it — which
 * is exactly the ordering the server has to get right.
 */
function scriptedClaudeLogin(options: { writesFiles?: Record<string, string> }) {
  const calls: Array<{ env: NodeJS.ProcessEnv }> = [];
  const submitted: string[] = [];
  let release: (() => void) | undefined;
  const spawner = (
    _command: string,
    _args: readonly string[],
    spawnOptions: { env: NodeJS.ProcessEnv; stdin?: string },
    onLine: (line: string) => void,
  ) => {
    calls.push({ env: spawnOptions.env });
    for (const line of CLAUDE_LOGIN_OUTPUT) {
      onLine(line);
    }
    const done = new Promise<ReturnType<typeof output>>((resolve) => {
      release = () => {
        void (async () => {
          const home = String(spawnOptions.env["CLAUDE_CONFIG_DIR"]);
          for (const [name, contents] of Object.entries(
            options.writesFiles ?? {},
          )) {
            await writeFile(path.join(home, name), contents, "utf8");
          }
          resolve(output("", 0));
        })();
      };
    });
    return {
      done,
      kill: () => release?.(),
      write: (value: string) => {
        submitted.push(value);
        // The real CLI exits once it has the code.
        release?.();
      },
    };
  };
  return { spawner, calls, submitted };
}

test("Claude sign-in shows a URL, takes a pasted code, and stores the session", async () => {
  const harness = await createHarness();
  const login = scriptedClaudeLogin({
    writesFiles: { ".credentials.json": '{"claudeAiOauth":{"accessToken":"x"}}' },
  });
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      claude: (args) =>
        args[0] === "auth" && args[1] === "status"
          ? output(JSON.stringify({ loggedIn: true, authMethod: "claudeai" }))
          : output(JSON.stringify({ result: "pong" })),
    }),
    longRunningSpawner: login.spawner,
  });

  const started = await service.startDeviceAuth({
    userId: "u1",
    provider: "anthropic",
  });
  // The browser issues the code for this flow, so none is shown here — the
  // screen has to render a paste box rather than a code to approve.
  assert.equal(started.mode, "code_exchange");
  assert.match(started.verificationUrl, /^https:\/\/claude\.com\/cai\/oauth/u);
  assert.equal(started.userCode, "");

  // The sign-in must not be able to reach the host's own Claude credentials,
  // or it would succeed as the host owner without anybody signing in.
  const spawnEnv = login.calls[0]?.env ?? {};
  assert.ok(String(spawnEnv["CLAUDE_CONFIG_DIR"] ?? "").length > 0);
  assert.equal(spawnEnv["ANTHROPIC_API_KEY"], undefined);
  assert.equal(spawnEnv["CLAUDE_CODE_OAUTH_TOKEN"], undefined);

  await service.submitDeviceAuthCode({
    userId: "u1",
    flowId: started.flowId,
    code: "abc123",
  });
  assert.deepEqual(login.submitted, ["abc123"]);

  assert.equal(await settledStatus(service, "u1", started.flowId), "completed");

  const statuses = await service.list({ userId: "u1", systemAdmin: false });
  const anthropic = statuses.find((entry) => entry.id === "anthropic");
  assert.ok(anthropic?.ownCredential !== undefined);
});

test("a Claude sign-in the CLI does not confirm is refused", async () => {
  const harness = await createHarness();
  // The process exits and writes something, but the CLI itself reports that
  // nobody is signed in. Storing that would produce a credential that fails
  // silently the first time a task tried to use it.
  const login = scriptedClaudeLogin({ writesFiles: { ".claude.json": "{}" } });
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      claude: () => output(JSON.stringify({ loggedIn: false, authMethod: "none" })),
    }),
    longRunningSpawner: login.spawner,
  });

  const started = await service.startDeviceAuth({
    userId: "u1",
    provider: "anthropic",
  });
  await service.submitDeviceAuthCode({
    userId: "u1",
    flowId: started.flowId,
    code: "wrong",
  });
  assert.equal(await settledStatus(service, "u1", started.flowId), "failed");

  const statuses = await service.list({ userId: "u1", systemAdmin: false });
  assert.equal(
    statuses.find((entry) => entry.id === "anthropic")?.ownCredential,
    undefined,
  );
});

test("one user cannot hand a code to another user's sign-in", async () => {
  const harness = await createHarness();
  const login = scriptedClaudeLogin({});
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({ claude: () => output("{}") }),
    longRunningSpawner: login.spawner,
  });
  const started = await service.startDeviceAuth({
    userId: "u1",
    provider: "anthropic",
  });

  await assert.rejects(
    service.submitDeviceAuthCode({
      userId: "u2",
      flowId: started.flowId,
      code: "abc123",
    }),
    /No such sign-in/u,
  );
  assert.deepEqual(login.submitted, []);
});

test("Google has no sign-in flow to drive, and says so", async () => {
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({}),
    longRunningSpawner: scriptedClaudeLogin({}).spawner,
  });
  await assert.rejects(
    service.startDeviceAuth({ userId: "u1", provider: "google" }),
    /no sign-in flow that can be driven from a server/u,
  );
});

test("signing in again after an expired session keeps an org-wide agent org-wide", async () => {
  const harness = await createHarness();
  const device = scriptedDeviceAuth({ writesAuthJson: CODEX_SESSION });
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      codex: (args) =>
        args[0] === "login"
          ? output(JSON.stringify({ loggedIn: true }))
          : output(
              JSON.stringify({
                type: "item.completed",
                item: { type: "agent_message", text: "pong" },
              }),
            ),
    }),
    longRunningSpawner: device.spawner,
  });

  const first = await service.startDeviceAuth({
    userId: "u1",
    provider: "openai",
  });
  device.finish();
  assert.equal(await settledStatus(service, "u1", first.flowId), "completed");

  // The owner opens this agent up to the whole organization, which is what
  // makes it @mentionable in the channels it works in.
  await service.setSettings({
    userId: "u1",
    provider: "openai",
    visibility: "org",
  });

  // Then the session expires, which is exactly why they sign in again. This
  // flow never asks about visibility, and answering "personal" on its behalf
  // quietly took the agent away from everyone who had been tasking it.
  await service.noteAuthFailure({
    userId: "u1",
    provider: "openai",
    reason: "The sign-in has expired. Reconnect this agent.",
  });

  const again = await service.startDeviceAuth({
    userId: "u1",
    provider: "openai",
  });
  device.finish();
  assert.equal(await settledStatus(service, "u1", again.flowId), "completed");

  const statuses = await service.list({ userId: "u1", systemAdmin: false });
  const openai = statuses.find((entry) => entry.id === "openai");
  assert.equal(openai?.ownCredential?.visibility, "org");
  assert.equal(openai?.ownCredential?.unusableReason, undefined);
  const roster = await service.listConnectionsFor(["u1"]);
  assert.deepEqual(
    roster["u1"]?.map((entry) => [entry.provider, entry.visibility]),
    [["openai", "org"]],
  );
});
