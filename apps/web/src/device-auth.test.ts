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

test("providers without a device flow say so rather than pretending", async () => {
  const harness = await createHarness();
  const service = new ProviderChatService(harness.project, {
    homeDirectory: harness.home,
    runner: scriptedRunner({
      claude: () => output(JSON.stringify({ loggedIn: true })),
    }),
  });
  for (const provider of ["anthropic", "google"] as const) {
    await assert.rejects(
      service.startDeviceAuth({ userId: "u1", provider }),
      (error: unknown) =>
        error instanceof ProviderChatError && error.code === "unsupported_flow",
    );
  }
});
