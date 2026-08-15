import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { UserCredentialStore } from "@coord/workspace-manager";

import {
  GitHubConnectionError,
  GitHubConnectionService,
} from "./github-connection.js";

async function harness(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coord-ghconn-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const credentials = await UserCredentialStore.open(directory);
  return { directory, credentials };
}

/** A GitHub API that answers from a script instead of the network. */
function githubAnswering(
  handler: (token: string | null) => Response | Error,
): typeof fetch {
  return async (_input, init) => {
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    const token =
      authorization?.startsWith("Bearer ") === true
        ? authorization.slice("Bearer ".length)
        : null;
    const answer = handler(token);
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };
}

const OCTOCAT = () =>
  new Response(JSON.stringify({ login: "octocat" }), { status: 200 });

test("a token GitHub accepts is stored, encrypted, and labelled with its login", async (t) => {
  const { credentials } = await harness(t);
  const service = new GitHubConnectionService({
    credentials,
    fetchImpl: githubAnswering((token) =>
      token === "ghp_working_token" ? OCTOCAT() : new Response("", { status: 401 }),
    ),
  });

  const status = await service.connect({
    userId: "user-1",
    token: "ghp_working_token",
  });
  assert.equal(status.connected, true);
  assert.equal(status.login, "octocat");
  assert.equal(status.credential?.kind, "api_key");
  assert.equal(status.credential?.hint, "oken");
  // The response is what the browser sees; the secret must not be in it.
  assert.ok(!JSON.stringify(status).includes("ghp_working_token"));

  const stored = await credentials.get("user-1", "github");
  assert.equal(stored?.secret, "ghp_working_token");
  assert.equal(stored?.label, "octocat");
});

test("a token GitHub rejects is reported, not stored", async (t) => {
  const { credentials } = await harness(t);
  const service = new GitHubConnectionService({
    credentials,
    fetchImpl: githubAnswering(() => new Response("", { status: 401 })),
  });

  await assert.rejects(
    () => service.connect({ userId: "user-1", token: "ghp_revoked" }),
    (error: unknown) =>
      error instanceof GitHubConnectionError &&
      error.code === "credential_rejected" &&
      error.status === 409,
  );
  assert.equal(await credentials.get("user-1", "github"), undefined);
});

test("an unreachable GitHub refuses without storing anything", async (t) => {
  const { credentials } = await harness(t);
  const service = new GitHubConnectionService({
    credentials,
    fetchImpl: githubAnswering(() => new Error("connect ETIMEDOUT")),
  });

  await assert.rejects(
    () => service.connect({ userId: "user-1", token: "ghp_unverifiable" }),
    (error: unknown) =>
      error instanceof GitHubConnectionError &&
      error.code === "github_unreachable",
  );
  assert.equal(await credentials.get("user-1", "github"), undefined);
});

test("a token that names no user is refused — a push would carry an identity nobody recognizes", async (t) => {
  const { credentials } = await harness(t);
  const service = new GitHubConnectionService({
    credentials,
    fetchImpl: githubAnswering(
      () => new Response(JSON.stringify({}), { status: 200 }),
    ),
  });

  await assert.rejects(
    () => service.connect({ userId: "user-1", token: "ghs_installation" }),
    (error: unknown) =>
      error instanceof GitHubConnectionError &&
      error.code === "credential_rejected",
  );
  assert.equal(await credentials.get("user-1", "github"), undefined);
});

test("obviously malformed tokens are refused before any network call", async (t) => {
  const { credentials } = await harness(t);
  const service = new GitHubConnectionService({
    credentials,
    fetchImpl: githubAnswering(() => new Error("must not be called")),
  });

  for (const token of ["", "   ", "ghp_abc def"]) {
    await assert.rejects(
      () => service.connect({ userId: "user-1", token }),
      (error: unknown) =>
        error instanceof GitHubConnectionError &&
        error.code === "invalid_secret",
    );
  }
});

test("disconnecting destroys the stored token", async (t) => {
  const { credentials } = await harness(t);
  const service = new GitHubConnectionService({
    credentials,
    fetchImpl: githubAnswering(() => OCTOCAT()),
  });

  await service.connect({ userId: "user-1", token: "ghp_shortlived" });
  await service.disconnect({ userId: "user-1" });

  assert.equal((await service.status({ userId: "user-1" })).connected, false);
  assert.equal(await credentials.get("user-1", "github"), undefined);
});

test("tokenFor hands the push path the submitter's own secret and login", async (t) => {
  const { credentials } = await harness(t);
  const service = new GitHubConnectionService({
    credentials,
    fetchImpl: githubAnswering(() => OCTOCAT()),
  });

  assert.equal(await service.tokenFor("user-1"), undefined);
  await service.connect({ userId: "user-1", token: "ghp_pushable" });

  const connection = await service.tokenFor("user-1");
  assert.equal(connection?.token, "ghp_pushable");
  assert.equal(connection?.login, "octocat");
  // Another user's push must not find this credential.
  assert.equal(await service.tokenFor("user-2"), undefined);
});

test("a push auth failure surfaces on the connection instead of hiding in a task log", async (t) => {
  const { credentials } = await harness(t);
  const service = new GitHubConnectionService({
    credentials,
    fetchImpl: githubAnswering(() => OCTOCAT()),
  });

  await service.connect({ userId: "user-1", token: "ghp_expiring" });
  await service.noteAuthFailure("user-1", "GitHub refused this token during a push");

  const status = await service.status({ userId: "user-1" });
  assert.equal(status.connected, true);
  assert.match(status.credential?.unusableReason ?? "", /refused this token/u);
});

/** A GitHub whose OAuth endpoints answer from a script. */
function githubDeviceAnswering(script: {
  tokenAnswers: Array<Record<string, unknown>>;
  interval?: number;
}): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/login/device/code")) {
      return new Response(
        JSON.stringify({
          device_code: "dev_123",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: script.interval ?? 0,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/login/oauth/access_token")) {
      const answer = script.tokenAnswers.shift() ?? {
        error: "authorization_pending",
      };
      return new Response(JSON.stringify(answer), { status: 200 });
    }
    return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
  };
  return { fetchImpl, calls };
}

test("the device sign-in stores a verified grant, like a pasted token", async (t) => {
  const { credentials } = await harness(t);
  const github = githubDeviceAnswering({
    tokenAnswers: [
      { error: "authorization_pending" },
      { access_token: "gho_granted", token_type: "bearer", scope: "repo" },
    ],
  });
  const service = new GitHubConnectionService({
    credentials,
    deviceClientId: "Iv1_client",
    fetchImpl: github.fetchImpl,
  });

  assert.equal((await service.status({ userId: "user-1" })).signInAvailable, true);

  const started = await service.startDeviceAuth({ userId: "user-1" });
  assert.equal(started.userCode, "ABCD-1234");
  assert.match(started.verificationUrl, /github\.com\/login\/device/u);

  const first = await service.deviceAuthStatus({
    userId: "user-1",
    flowId: started.flowId,
  });
  assert.equal(first.status, "pending");

  const second = await service.deviceAuthStatus({
    userId: "user-1",
    flowId: started.flowId,
  });
  assert.equal(second.status, "granted");
  assert.equal(second.login, "octocat");

  const stored = await credentials.get("user-1", "github");
  assert.equal(stored?.secret, "gho_granted");
  assert.equal(stored?.kind, "oauth_token");
  assert.equal(stored?.label, "octocat");

  // The UI runs two watchers over one flow; the one that asks second must
  // still hear "granted". Only a third asker is told to start fresh.
  const replay = await service.deviceAuthStatus({
    userId: "user-1",
    flowId: started.flowId,
  });
  assert.equal(replay.status, "granted");
  assert.equal(replay.login, "octocat");
  await assert.rejects(
    () =>
      service.deviceAuthStatus({ userId: "user-1", flowId: started.flowId }),
    (error: unknown) =>
      error instanceof GitHubConnectionError && error.code === "unknown_flow",
  );
});

test("a declined sign-in stores nothing and says it was declined", async (t) => {
  const { credentials } = await harness(t);
  const github = githubDeviceAnswering({
    tokenAnswers: [{ error: "access_denied" }],
  });
  const service = new GitHubConnectionService({
    credentials,
    deviceClientId: "Iv1_client",
    fetchImpl: github.fetchImpl,
  });

  const started = await service.startDeviceAuth({ userId: "user-1" });
  const settled = await service.deviceAuthStatus({
    userId: "user-1",
    flowId: started.flowId,
  });
  assert.equal(settled.status, "failed");
  assert.match(settled.detail ?? "", /declined/u);
  assert.equal(await credentials.get("user-1", "github"), undefined);

  // The second watcher hears the same refusal, not "unknown flow".
  const replay = await service.deviceAuthStatus({
    userId: "user-1",
    flowId: started.flowId,
  });
  assert.equal(replay.status, "failed");
  assert.match(replay.detail ?? "", /declined/u);
});

test("polls are paced by GitHub's interval, not the browser's", async (t) => {
  const { credentials } = await harness(t);
  const github = githubDeviceAnswering({
    tokenAnswers: [{ access_token: "gho_early" }],
    interval: 5,
  });
  const service = new GitHubConnectionService({
    credentials,
    deviceClientId: "Iv1_client",
    fetchImpl: github.fetchImpl,
  });

  const started = await service.startDeviceAuth({ userId: "user-1" });
  const early = await service.deviceAuthStatus({
    userId: "user-1",
    flowId: started.flowId,
  });
  // Answered pending from memory: within the interval GitHub was not asked.
  assert.equal(early.status, "pending");
  assert.equal(
    github.calls.filter((url) => url.includes("access_token")).length,
    0,
  );
});

test("without an OAuth App the sign-in refuses and points at both fixes", async (t) => {
  const { credentials } = await harness(t);
  const service = new GitHubConnectionService({
    credentials,
    fetchImpl: githubAnswering(() => new Error("must not be called")),
  });

  assert.equal(
    (await service.status({ userId: "user-1" })).signInAvailable,
    false,
  );
  await assert.rejects(
    () => service.startDeviceAuth({ userId: "user-1" }),
    (error: unknown) =>
      error instanceof GitHubConnectionError &&
      error.code === "signin_unconfigured" &&
      /COORD_GITHUB_CLIENT_ID/u.test(error.message),
  );
});
