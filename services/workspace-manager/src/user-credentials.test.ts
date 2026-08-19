import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureClaudeSession,
  captureCredentialKey,
  openCredentialHome,
  resolveCredentialKey,
  supportedCredentialKinds,
  supportsUserCredential,
  UserCredentialError,
  UserCredentialStore,
  withCredentialHome,
} from "./user-credentials.js";

async function scratch(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coord-usercred-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function store(directory: string): UserCredentialStore {
  return new UserCredentialStore(
    path.join(directory, "user-credentials.json"),
    randomBytes(32),
  );
}

test("a stored credential round-trips and the secret is never in the summary", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);

  const summary = await vault.put("user-1", "claude", {
    kind: "oauth_token",
    secret: "sk-ant-oat01-alpha-secret-value",
    label: "personal",
  });

  assert.equal(summary.kind, "oauth_token");
  assert.equal(summary.label, "personal");
  assert.equal(summary.hint, "alue");
  assert.ok(!JSON.stringify(summary).includes("sk-ant-oat01"));

  const credential = await vault.get("user-1", "claude");
  assert.equal(credential?.secret, "sk-ant-oat01-alpha-secret-value");
});

test("the secret is not readable from the file on disk", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  await vault.put("user-1", "claude", {
    kind: "oauth_token",
    secret: "sk-ant-oat01-plaintext-canary",
  });

  const raw = await readFile(
    path.join(directory, "user-credentials.json"),
    "utf8",
  );
  assert.ok(!raw.includes("plaintext-canary"));
  assert.ok(!raw.includes("sk-ant-oat01-plaintext-canary"));
});

test("one user cannot read another user's credential", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  await vault.put("user-1", "claude", {
    kind: "oauth_token",
    secret: "first-user-secret",
  });
  await vault.put("user-2", "claude", {
    kind: "api_key",
    secret: "second-user-secret",
  });

  assert.equal((await vault.get("user-1", "claude"))?.secret, "first-user-secret");
  assert.equal(
    (await vault.get("user-2", "claude"))?.secret,
    "second-user-secret",
  );
  assert.equal(await vault.get("user-3", "claude"), undefined);

  await vault.delete("user-1", "claude");
  assert.equal(await vault.get("user-1", "claude"), undefined);
  // Deleting one user's credential must not disturb the other's.
  assert.equal(
    (await vault.get("user-2", "claude"))?.secret,
    "second-user-secret",
  );
});

test("a credential written under one key is refused under another", async (t) => {
  const directory = await scratch(t);
  const filePath = path.join(directory, "user-credentials.json");
  await new UserCredentialStore(filePath, randomBytes(32)).put(
    "user-1",
    "claude",
    { kind: "oauth_token", secret: "sk-ant-oat01-value" },
  );

  const wrongKey = new UserCredentialStore(filePath, randomBytes(32));
  // The summary is metadata and still reads; only the secret is unavailable.
  assert.equal((await wrongKey.summary("user-1", "claude"))?.kind, "oauth_token");
  await assert.rejects(
    () => wrongKey.get("user-1", "claude"),
    (error: unknown) =>
      error instanceof UserCredentialError && error.code === "undecryptable",
  );
});

test("the configured key is used and a key file is generated only without one", async (t) => {
  const directory = await scratch(t);
  const keyFilePath = path.join(directory, "credential-key");

  const raw = randomBytes(32);
  const configured = await resolveCredentialKey({
    keyFilePath,
    environment: { COORD_CREDENTIAL_KEY: raw.toString("base64") },
  });
  assert.deepEqual(configured, raw);
  await assert.rejects(() => stat(keyFilePath));

  // A passphrase is stretched rather than rejected.
  const stretched = await resolveCredentialKey({
    keyFilePath,
    environment: { COORD_CREDENTIAL_KEY: "not-thirty-two-bytes" },
  });
  assert.equal(stretched.length, 32);

  const generated = await resolveCredentialKey({ keyFilePath, environment: {} });
  assert.equal(generated.length, 32);
  const reread = await resolveCredentialKey({ keyFilePath, environment: {} });
  assert.deepEqual(reread, generated, "the generated key must be stable");
});

test("an empty secret is rejected rather than stored", async (t) => {
  const directory = await scratch(t);
  await assert.rejects(
    () => store(directory).put("user-1", "claude", { kind: "api_key", secret: "  " }),
    (error: unknown) =>
      error instanceof UserCredentialError && error.code === "invalid_secret",
  );
});

test("a launch environment carries the user's secret in the vendor's variable", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  await vault.put("user-1", "claude", {
    kind: "oauth_token",
    secret: "sk-ant-oat01-token",
  });
  const credential = await vault.get("user-1", "claude");
  assert.ok(credential !== undefined);

  const home = await openCredentialHome({ vendor: "claude", credential });
  t.after(home.close);

  assert.equal(home.env["CLAUDE_CODE_OAUTH_TOKEN"], "sk-ant-oat01-token");
  assert.equal(home.env["ANTHROPIC_API_KEY"], undefined);
  assert.ok(
    home.env["CLAUDE_CONFIG_DIR"]?.startsWith(home.path),
    "the CLI must be pointed at the isolated configuration directory",
  );
  // The directory must already exist; the CLI will not create it.
  assert.ok((await stat(home.env["CLAUDE_CONFIG_DIR"] as string)).isDirectory());
});

test("credentials inherited from the host environment are stripped", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  await vault.put("user-1", "claude", {
    kind: "oauth_token",
    secret: "the-users-own-token",
  });
  const credential = await vault.get("user-1", "claude");
  assert.ok(credential !== undefined);

  await withCredentialHome(
    {
      vendor: "claude",
      credential,
      baseEnv: {
        PATH: "/usr/bin",
        // Everything below belongs to the host owner and must not survive.
        ANTHROPIC_API_KEY: "host-owner-api-key",
        ANTHROPIC_AUTH_TOKEN: "host-owner-auth-token",
        OPENAI_API_KEY: "host-owner-openai-key",
        GEMINI_API_KEY: "host-owner-gemini-key",
        GOOGLE_API_KEY: "host-owner-google-key",
      },
    },
    async (home) => {
      assert.equal(home.env["PATH"], "/usr/bin", "unrelated variables survive");
      assert.equal(home.env["CLAUDE_CODE_OAUTH_TOKEN"], "the-users-own-token");
      for (const leaked of [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
      ]) {
        assert.equal(home.env[leaked], undefined, `${leaked} must be stripped`);
      }
    },
  );
});

test("each launch gets its own home, and closing leaves nothing on disk", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  await vault.put("user-1", "claude", {
    kind: "oauth_token",
    secret: "token",
  });
  const credential = await vault.get("user-1", "claude");
  assert.ok(credential !== undefined);

  const first = await openCredentialHome({ vendor: "claude", credential });
  const second = await openCredentialHome({ vendor: "claude", credential });
  assert.notEqual(first.path, second.path);

  // One user's files must not be readable by the next user's process, so the
  // directory itself always goes. What the CLI *refreshed* is read back out
  // first — see the rotation tests below; this credential is an oauth_token,
  // which the CLI never rewrites, so there is nothing to carry forward here.
  const refreshed = path.join(first.env["CLAUDE_CONFIG_DIR"] as string, ".credentials.json");
  await writeFile(refreshed, '{"claudeAiOauth":{}}', "utf8");

  await first.close();
  await second.close();
  await assert.rejects(() => stat(refreshed));
});

test("codex gets an auth.json, because it ignores the environment variable", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  await vault.put("user-1", "codex", { kind: "api_key", secret: "sk-users-key" });
  const credential = await vault.get("user-1", "codex");
  assert.ok(credential !== undefined);

  const home = await openCredentialHome({ vendor: "codex", credential });
  t.after(home.close);

  // `codex exec` sends no credential at all when only the variable is set —
  // the API answers "Missing bearer or basic authentication in header" — so
  // the file is what actually authenticates.
  const authPath = path.join(home.env["CODEX_HOME"] as string, "auth.json");
  const auth = JSON.parse(await readFile(authPath, "utf8")) as {
    auth_mode?: string;
    OPENAI_API_KEY?: string;
  };
  assert.equal(auth.auth_mode, "apikey");
  assert.equal(auth.OPENAI_API_KEY, "sk-users-key");
  assert.ok(
    (home.env["CODEX_HOME"] ?? "").startsWith(home.path),
    "the file must live in the task's own home, not the host's",
  );
});

test("gemini is told the redirected home is trusted", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  await vault.put("user-1", "gemini", { kind: "api_key", secret: "gem-key" });
  const credential = await vault.get("user-1", "gemini");
  assert.ok(credential !== undefined);

  const home = await openCredentialHome({ vendor: "gemini", credential });
  t.after(home.close);

  // Redirecting the home discards the user's trusted-directory list, and the
  // CLI then exits 55 before attempting authentication at all.
  assert.equal(home.env["GEMINI_CLI_TRUST_WORKSPACE"], "true");
});

test("gemini redirects the home directory because it has no config variable", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  await vault.put("user-1", "gemini", { kind: "api_key", secret: "gem-key" });
  const credential = await vault.get("user-1", "gemini");
  assert.ok(credential !== undefined);

  const home = await openCredentialHome({
    vendor: "gemini",
    credential,
    baseEnv: { HOME: "/home/hostowner", USERPROFILE: "C:\\Users\\hostowner" },
  });
  t.after(home.close);

  assert.equal(home.env["GEMINI_API_KEY"], "gem-key");
  assert.equal(home.env["HOME"], home.path);
  assert.equal(home.env["USERPROFILE"], home.path);
});

test("a kind the vendor cannot read from the environment is refused", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  // The Codex CLI keeps its subscription login in auth.json with no
  // environment equivalent, so an OAuth token cannot be carried per user.
  await vault.put("user-1", "codex", {
    kind: "oauth_token",
    secret: "whatever",
  });
  const credential = await vault.get("user-1", "codex");
  assert.ok(credential !== undefined);

  await assert.rejects(
    () => openCredentialHome({ vendor: "codex", credential }),
    (error: unknown) =>
      error instanceof UserCredentialError && error.code === "unsupported_kind",
  );

  assert.deepEqual(supportedCredentialKinds("claude"), [
    "oauth_token",
    "api_key",
  ]);
  assert.equal(supportsUserCredential("claude", "oauth_token"), true);
  assert.equal(supportsUserCredential("codex", "oauth_token"), false);
});

test("a codex subscription session is written to auth.json verbatim", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  // Shaped like the real file: auth_mode plus a token set, no API key.
  const session = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: "id",
      access_token: "access-abcd",
      refresh_token: "refresh",
      account_id: "acct",
    },
    last_refresh: "2026-08-03T00:00:00Z",
  });
  await vault.put("user-1", "codex", {
    kind: "session_file",
    secret: session,
    origin: "device_auth",
  });
  const credential = await vault.get("user-1", "codex");
  assert.ok(credential !== undefined);
  assert.equal(credential.origin, "device_auth");
  // The hint comes from the token inside, not the closing brace.
  assert.equal(credential.hint, "abcd");

  const home = await openCredentialHome({ vendor: "codex", credential });
  t.after(home.close);
  const written = JSON.parse(
    await readFile(path.join(home.env["CODEX_HOME"] as string, "auth.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(written, JSON.parse(session));
});

test("a gemini session gets its creds and a declared auth method", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  const session = JSON.stringify({
    access_token: "ya29.token",
    refresh_token: "1//refresh",
    expiry_date: 1,
  });
  await vault.put("user-1", "gemini", { kind: "session_file", secret: session });
  const credential = await vault.get("user-1", "gemini");
  assert.ok(credential !== undefined);
  assert.equal(credential.origin, "pasted");

  const home = await openCredentialHome({ vendor: "gemini", credential });
  t.after(home.close);

  const geminiDir = path.join(home.path, ".gemini");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(geminiDir, "oauth_creds.json"), "utf8")),
    JSON.parse(session),
  );
  // Without this the CLI refuses to start, naming its settings file — it does
  // not infer the method from the credentials sitting beside it.
  const settings = JSON.parse(
    await readFile(path.join(geminiDir, "settings.json"), "utf8"),
  ) as { security?: { auth?: { selectedType?: string } } };
  assert.equal(settings.security?.auth?.selectedType, "oauth-personal");
  assert.equal(home.env["GEMINI_API_KEY"], undefined);
});

test("the wrong JSON file is rejected with the name of the right one", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);

  for (const [vendor, wrong, expected] of [
    ["codex", '{"cached_at":1}', "auth.json"],
    ["gemini", '{"active":"me@example.com"}', "oauth_creds.json"],
  ] as const) {
    await assert.rejects(
      () => vault.put("user-1", vendor, { kind: "session_file", secret: wrong }),
      (error: unknown) =>
        error instanceof UserCredentialError &&
        error.code === "invalid_session_file" &&
        error.message.includes(expected),
      `${vendor} must name the file it wants`,
    );
  }

  await assert.rejects(
    () =>
      vault.put("user-1", "codex", {
        kind: "session_file",
        secret: "not json at all",
      }),
    (error: unknown) =>
      error instanceof UserCredentialError &&
      error.code === "invalid_session_file",
  );
});

test("a session file records the recommended kind ordering", async () => {
  // The connect UI offers [0] by default, so API keys must lead for the two
  // vendors whose session files share a refresh token with the user's machine.
  assert.deepEqual(supportedCredentialKinds("codex"), ["api_key", "session_file"]);
  assert.deepEqual(supportedCredentialKinds("gemini"), ["api_key", "session_file"]);
  // Claude can hold a session file now — a browser sign-in captures one — but
  // it is never offered for pasting, because no file on the user's machine is
  // one. Delivery accepts it; the connect UI does not list it.
  assert.equal(supportsUserCredential("claude", "session_file"), true);
  assert.ok(!supportedCredentialKinds("claude").includes("session_file"));
});

/**
 * A captured browser sign-in has to survive the round trip, because the CLI
 * is only ever given the copy: the directory it signed into is destroyed as
 * soon as the credential is stored, so anything lost here is lost for good.
 */
test("a captured Claude sign-in is restored into the CLI's own config directory", async (t) => {
  const directory = await scratch(t);
  const signedIn = path.join(directory, "signed-in");
  await mkdir(signedIn, { recursive: true });
  await writeFile(
    path.join(signedIn, ".credentials.json"),
    '{"claudeAiOauth":{"accessToken":"secret-token"}}',
    "utf8",
  );
  await writeFile(path.join(signedIn, ".claude.json"), '{"theme":"dark"}', "utf8");
  // A directory alongside the files must not derail the capture.
  await mkdir(path.join(signedIn, "backups"), { recursive: true });

  const secret = await captureClaudeSession(signedIn);
  const vault = store(directory);
  await vault.put("user-1", "claude", { kind: "session_file", secret });
  const credential = await vault.get("user-1", "claude");
  assert.ok(credential !== undefined);

  const home = await openCredentialHome({ vendor: "claude", credential });
  try {
    const configDirectory = String(home.env["CLAUDE_CONFIG_DIR"]);
    assert.equal(
      await readFile(path.join(configDirectory, ".credentials.json"), "utf8"),
      '{"claudeAiOauth":{"accessToken":"secret-token"}}',
    );
    assert.equal(
      await readFile(path.join(configDirectory, ".claude.json"), "utf8"),
      '{"theme":"dark"}',
    );
    // The host's own credentials must not be reachable from that environment.
    assert.equal(home.env["ANTHROPIC_API_KEY"], undefined);
    assert.equal(home.env["CLAUDE_CODE_OAUTH_TOKEN"], undefined);
  } finally {
    await home.close();
  }
});

test("a capture of a directory with nothing in it is refused", async (t) => {
  const directory = await scratch(t);
  const empty = path.join(directory, "empty");
  await mkdir(empty, { recursive: true });
  await assert.rejects(
    () => captureClaudeSession(empty),
    (error: unknown) =>
      error instanceof UserCredentialError &&
      error.code === "invalid_session_file",
  );
});

/*
 * A stored session file is a snapshot taken once at sign-in. The vendor CLIs
 * refresh their own OAuth token mid-run and write the new one into the home
 * they were handed — the home that is then deleted. Discarding it left a
 * credential that verified perfectly at sign-in and then failed every run
 * with 401 about an hour later, which reconnecting appeared to fix.
 */
test("a token the CLI refreshes during a run is kept, not deleted with the home", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  const original = JSON.stringify({ tokens: { access_token: "first" } });
  await vault.put("user-1", "codex", { kind: "session_file", secret: original });
  const credential = await vault.get("user-1", "codex");
  assert.ok(credential !== undefined);

  const home = await openCredentialHome({ vendor: "codex", credential });
  const authPath = path.join(home.env["CODEX_HOME"] as string, "auth.json");
  assert.equal(
    JSON.parse(await readFile(authPath, "utf8")).tokens.access_token,
    "first",
    "the run must start from the stored credential",
  );

  // Exactly what the CLI does when it refreshes: rewrite the file in place.
  const refreshed = JSON.stringify({ tokens: { access_token: "second" } });
  await writeFile(authPath, `${refreshed}\n`, "utf8");

  const { rotatedSecret } = await home.close();
  assert.equal(
    rotatedSecret,
    refreshed,
    "the refreshed token must survive the home it was written into",
  );
});

test("a session file the CLI left alone is not written back", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  const original = JSON.stringify({ tokens: { access_token: "unchanged" } });
  await vault.put("user-1", "codex", { kind: "session_file", secret: original });
  const credential = await vault.get("user-1", "codex");
  assert.ok(credential !== undefined);

  const home = await openCredentialHome({ vendor: "codex", credential });
  const { rotatedSecret } = await home.close();
  assert.equal(
    rotatedSecret,
    undefined,
    "an untouched credential must not be rewritten on every run",
  );
});

test("an API key is never treated as something that could rotate", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  await vault.put("user-1", "codex", { kind: "api_key", secret: "sk-key" });
  const credential = await vault.get("user-1", "codex");
  assert.ok(credential !== undefined);

  const home = await openCredentialHome({ vendor: "codex", credential });
  const { rotatedSecret } = await home.close();
  assert.equal(rotatedSecret, undefined);
});

test("withCredentialHome hands a rotated token to the caller that can store it", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  const original = JSON.stringify({ tokens: { access_token: "before" } });
  await vault.put("user-1", "codex", { kind: "session_file", secret: original });
  const credential = await vault.get("user-1", "codex");
  assert.ok(credential !== undefined);

  const refreshed = JSON.stringify({ tokens: { access_token: "after" } });
  const rotations: string[] = [];
  await withCredentialHome(
    {
      vendor: "codex",
      credential,
      onRotate: (secret) => {
        rotations.push(secret);
      },
    },
    async (home) => {
      await writeFile(
        path.join(home.env["CODEX_HOME"] as string, "auth.json"),
        `${refreshed}\n`,
        "utf8",
      );
    },
  );
  assert.deepEqual(rotations, [refreshed]);

  // And the caller storing it is what makes the next run start from the new
  // token rather than the expired one.
  await vault.put("user-1", "codex", {
    kind: "session_file",
    secret: rotations[0] as string,
  });
  assert.equal((await vault.get("user-1", "codex"))?.secret, refreshed);
});

test("exclusive credential homes wait for a task rotation and then load it", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  const original = JSON.stringify({ tokens: { access_token: "before" } });
  const refreshed = JSON.stringify({ tokens: { access_token: "after" } });
  await vault.put("user-1", "codex", {
    kind: "session_file",
    secret: original,
  });

  const taskHome = await vault.openCredentialHome({
    userId: "user-1",
    vendor: "codex",
    mode: "shared",
  });
  assert.ok(taskHome !== undefined);
  let replyOpened = false;
  const replyHomePromise = vault
    .openCredentialHome({ userId: "user-1", vendor: "codex" })
    .then((home) => {
      replyOpened = true;
      return home;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(replyOpened, false, "the reply must wait for the task home");
  const secondTaskHome = await vault.openCredentialHome({
    userId: "user-1",
    vendor: "codex",
    mode: "shared",
  });
  assert.ok(
    secondTaskHome !== undefined,
    "a coordinator can keep staging tasks while the reply waits",
  );

  await writeFile(
    path.join(taskHome.env["CODEX_HOME"] as string, "auth.json"),
    `${refreshed}\n`,
    "utf8",
  );
  await taskHome.close();
  assert.equal(replyOpened, false, "the reply waits for every staged task");
  await secondTaskHome.close();

  const replyHome = await replyHomePromise;
  assert.ok(replyHome !== undefined);
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(replyHome.env["CODEX_HOME"] as string, "auth.json"),
        "utf8",
      ),
    ),
    JSON.parse(refreshed),
  );
  await replyHome.close();
});

test("credential reservations are released when staging fails", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  await vault.put("user-1", "codex", {
    kind: "oauth_token",
    secret: "unsupported",
  });

  await assert.rejects(
    vault.openCredentialHome({ userId: "user-1", vendor: "codex" }),
    (error: unknown) =>
      error instanceof UserCredentialError && error.code === "unsupported_kind",
  );
  await assert.rejects(
    vault.openCredentialHome({ userId: "user-1", vendor: "codex" }),
    (error: unknown) =>
      error instanceof UserCredentialError && error.code === "unsupported_kind",
  );
});

test("different users do not block one another's credential homes", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  for (const userId of ["user-1", "user-2"]) {
    await vault.put(userId, "claude", {
      kind: "oauth_token",
      secret: `sk-ant-oat01-${userId}`,
    });
  }

  const first = await vault.openCredentialHome({
    userId: "user-1",
    vendor: "claude",
  });
  assert.ok(first !== undefined);
  const second = await vault.openCredentialHome({
    userId: "user-2",
    vendor: "claude",
  });
  assert.ok(second !== undefined);
  await Promise.all([first.close(), second.close()]);
});

test("a run that fails still keeps the token it refreshed on the way down", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  await vault.put("user-1", "codex", {
    kind: "session_file",
    secret: JSON.stringify({ tokens: { access_token: "start" } }),
  });
  const credential = await vault.get("user-1", "codex");
  assert.ok(credential !== undefined);

  const refreshed = JSON.stringify({ tokens: { access_token: "rotated" } });
  const rotations: string[] = [];
  await assert.rejects(
    withCredentialHome(
      {
        vendor: "codex",
        credential,
        onRotate: (secret) => {
          rotations.push(secret);
        },
      },
      async (home) => {
        await writeFile(
          path.join(home.env["CODEX_HOME"] as string, "auth.json"),
          `${refreshed}\n`,
          "utf8",
        );
        throw new Error("the run failed after refreshing");
      },
    ),
    /the run failed after refreshing/u,
  );
  assert.deepEqual(
    rotations,
    [refreshed],
    "a failed run refreshes the token just the same, and losing it costs a reconnect",
  );
});

/*
 * Not a Codex quirk. Any vendor CLI that rotates its own token has this, and
 * Claude only looked exempt because `claude setup-token` issues something
 * long-lived enough that discarding the refresh costs far longer to notice.
 */
test("a refreshed Claude session is carried forward too", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  const original = JSON.stringify({
    files: { ".credentials.json": '{"claudeAiOauth":{"accessToken":"first"}}' },
  });
  await vault.put("user-1", "claude", {
    kind: "session_file",
    secret: original,
  });
  const credential = await vault.get("user-1", "claude");
  assert.ok(credential !== undefined);

  const home = await openCredentialHome({ vendor: "claude", credential });
  const configDirectory = home.env["CLAUDE_CONFIG_DIR"] as string;
  await writeFile(
    path.join(configDirectory, ".credentials.json"),
    '{"claudeAiOauth":{"accessToken":"second"}}',
    "utf8",
  );

  const { rotatedSecret } = await home.close();
  assert.ok(rotatedSecret !== undefined, "the refreshed session must survive");
  assert.match(rotatedSecret, /second/u);
  assert.doesNotMatch(rotatedSecret, /first/u);
});

test("a refreshed Gemini session is carried forward too", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  await vault.put("user-1", "gemini", {
    kind: "session_file",
    secret: JSON.stringify({ access_token: "first", refresh_token: "r1" }),
  });
  const credential = await vault.get("user-1", "gemini");
  assert.ok(credential !== undefined);

  const home = await openCredentialHome({ vendor: "gemini", credential });
  const refreshed = JSON.stringify({ access_token: "second", refresh_token: "r1" });
  await writeFile(
    path.join(home.path, ".gemini", "oauth_creds.json"),
    `${refreshed}\n`,
    "utf8",
  );

  const { rotatedSecret } = await home.close();
  assert.equal(rotatedSecret, refreshed);
});

test("github rides in the store beside the vendor CLIs", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);

  const summary = await vault.put("user-1", "github", {
    kind: "api_key",
    secret: "ghp_abcdefghijklmnop",
    origin: "pasted",
  });
  assert.equal(summary.vendor, "github");
  assert.equal(summary.hint, "mnop");
  assert.ok(!JSON.stringify(summary).includes("ghp_abcdefghijklmnop"));

  // The verified GitHub login lands in the label, which is what makes the
  // connection read as an identity rather than an anonymous secret.
  await vault.markVerified("user-1", "github", "octocat");
  const stored = await vault.get("user-1", "github");
  assert.equal(stored?.secret, "ghp_abcdefghijklmnop");
  assert.equal(stored?.label, "octocat");

  const listed = await vault.list("user-1");
  assert.ok(listed.some((entry) => entry.vendor === "github"));

  await vault.delete("user-1", "github");
  assert.equal(await vault.get("user-1", "github"), undefined);
});

test("github accepts a pasted token or a device-flow grant, never a session file", () => {
  assert.deepEqual(supportedCredentialKinds("github"), [
    "api_key",
    "oauth_token",
  ]);
  assert.equal(supportsUserCredential("github", "api_key"), true);
  assert.equal(supportsUserCredential("github", "oauth_token"), true);
  assert.equal(supportsUserCredential("github", "session_file"), false);
});

test("a session file for github is refused at the door", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);
  await assert.rejects(
    () =>
      vault.put("user-1", "github", { kind: "session_file", secret: "{}" }),
    (error: unknown) =>
      error instanceof UserCredentialError && error.code === "unsupported_kind",
  );
  assert.equal(await vault.get("user-1", "github"), undefined);
});

test("the credential key leaves the process environment and still resolves", async (t) => {
  // The key that decrypts every user's stored provider credential used to sit
  // in `process.env` for the whole run, where every spawned child could read
  // it. It is taken out at boot instead — and a store opened *after* that has
  // to still find it, or it would quietly generate a new key and fail to
  // decrypt everything written under the old one.
  const directory = await mkdtemp(path.join(os.tmpdir(), "coord-key-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const configured = randomBytes(32).toString("base64");
  const environment: NodeJS.ProcessEnv = {
    COORD_CREDENTIAL_KEY: configured,
  };

  captureCredentialKey(environment);
  assert.equal(environment["COORD_CREDENTIAL_KEY"], undefined);

  const keyFilePath = path.join(directory, "credential-key");
  const resolved = await resolveCredentialKey({ keyFilePath });
  assert.equal(resolved.toString("base64"), configured);
  // Nothing was written beside the ciphertext, because nothing had to be.
  await assert.rejects(readFile(keyFilePath, "utf8"));
});

test("reconnecting an org-wide agent keeps it org-wide", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);

  await vault.put("user-1", "claude", {
    kind: "oauth_token",
    secret: "sk-ant-oat01-original",
    visibility: "org",
  });
  // What an expired sign-in looks like in the vault: still stored, no longer
  // usable, and about to be replaced by the same person signing in again.
  await vault.markUnusable("user-1", "claude", "The sign-in has expired.");

  // The reconnect states no visibility — neither the sign-in flow nor an
  // older client sends one — and that must not read as "make it personal".
  const reconnected = await vault.put("user-1", "claude", {
    kind: "oauth_token",
    secret: "sk-ant-oat01-replacement",
  });
  assert.equal(reconnected.visibility, "org");
  assert.equal((await vault.summary("user-1", "claude"))?.visibility, "org");

  // Saying so explicitly is still how the owner changes their mind.
  const narrowed = await vault.put("user-1", "claude", {
    kind: "oauth_token",
    secret: "sk-ant-oat01-replacement",
    visibility: "personal",
  });
  assert.equal(narrowed.visibility, "personal");
});

test("a first connection is personal until its owner says otherwise", async (t) => {
  const directory = await scratch(t);
  const vault = store(directory);

  const summary = await vault.put("user-1", "codex", {
    kind: "api_key",
    secret: "sk-first-connection",
  });
  assert.equal(summary.visibility, "personal");

  // And a credential deleted outright takes its choice with it: reconnecting
  // after a disconnect is a new agent, not a returning one.
  await vault.setVisibility("user-1", "codex", "org");
  await vault.delete("user-1", "codex");
  const fresh = await vault.put("user-1", "codex", {
    kind: "api_key",
    secret: "sk-second-connection",
  });
  assert.equal(fresh.visibility, "personal");
});
