import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveVendorCredentials } from "./vendor-credentials.js";
import { assertContainerIsSoleBoundary } from "./vendor-sandbox.js";

/** Builds a fake host home containing the files a vendor CLI authenticates with. */
async function fakeHome(
  files: Record<string, string>,
): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "coord-cred-test-"));
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(home, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return {
    home,
    cleanup: async () => {
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("only the named credential file is mounted, not the home directory", async (t) => {
  const { home, cleanup } = await fakeHome({
    ".claude/.credentials.json": '{"claudeAiOauth":{}}',
    // Everything below is deliberately present and must not be mounted:
    // project history, MCP configuration, and unrelated settings.
    ".claude.json": '{"projects":{"secret":true}}',
    ".claude/settings.json": "{}",
    ".ssh/id_ed25519": "PRIVATE KEY",
  });
  t.after(cleanup);

  const plan = await resolveVendorCredentials("claude", {
    home,
    mode: "read-only",
  });

  assert.equal(plan.mounts.length, 1);
  assert.equal(
    plan.mounts[0]?.containerPath,
    "/home/agent/.claude/.credentials.json",
  );
  assert.equal(plan.mounts[0]?.readOnly, true);
  assert.equal(plan.env["HOME"], "/home/agent");
  assert.equal(plan.env["CLAUDE_CONFIG_DIR"], "/home/agent/.claude");

  const mounted = plan.mounts.map((mount) => mount.hostPath);
  for (const excluded of [".claude.json", ".ssh/id_ed25519", ".claude/settings.json"]) {
    assert.ok(
      !mounted.some((entry) => entry.endsWith(excluded.replaceAll("/", path.sep))),
      `${excluded} must not be mounted`,
    );
  }
});

test("codex mounts auth.json and nothing else from ~/.codex", async (t) => {
  const { home, cleanup } = await fakeHome({
    ".codex/auth.json": '{"OPENAI_API_KEY":null}',
    ".codex/config.toml": "model = 'x'",
    ".codex/memories_1.sqlite": "binary",
    ".codex/session_index.jsonl": "{}",
  });
  t.after(cleanup);

  const plan = await resolveVendorCredentials("codex", {
    home,
    mode: "read-only",
  });

  assert.deepEqual(
    plan.mounts.map((mount) => mount.containerPath),
    ["/home/agent/.codex/auth.json"],
  );
  assert.equal(plan.env["CODEX_HOME"], "/home/agent/.codex");
});

test("gemini records which optional files were absent", async (t) => {
  const { home, cleanup } = await fakeHome({
    ".gemini/oauth_creds.json": '{"refresh_token":"x"}',
    ".gemini/projects.json": '{"projects":{}}',
  });
  t.after(cleanup);

  const plan = await resolveVendorCredentials("gemini", {
    home,
    mode: "read-only",
  });

  assert.deepEqual(
    plan.mounts.map((mount) => mount.containerPath).sort(),
    ["/home/agent/.gemini/oauth_creds.json", "/home/agent/.gemini/projects.json"],
  );
  assert.deepEqual([...plan.missing].sort(), [
    ".gemini/google_accounts.json",
    ".gemini/installation_id",
  ]);
});

test("a missing required credential fails loudly rather than at run time", async (t) => {
  const { home, cleanup } = await fakeHome({ ".codex/config.toml": "" });
  t.after(cleanup);

  await assert.rejects(
    async () => await resolveVendorCredentials("codex", { home, mode: "read-only" }),
    /credential \.codex\/auth\.json was not found/u,
  );
});

test("an ephemeral copy is writable and leaves the host credential untouched", async (t) => {
  const { home, cleanup } = await fakeHome({
    ".codex/auth.json": '{"last_refresh":"original"}',
  });
  const staging = await mkdtemp(path.join(os.tmpdir(), "coord-cred-stage-"));
  t.after(async () => {
    await cleanup();
    await rm(staging, { recursive: true, force: true });
  });

  const plan = await resolveVendorCredentials("codex", {
    home,
    mode: "ephemeral-copy",
    stagingDir: staging,
  });

  const mount = plan.mounts[0];
  assert.ok(mount !== undefined);
  // Writable, because all three vendors rewrite these files when the OAuth
  // access token is refreshed.
  assert.equal(mount.readOnly, false);
  assert.ok(
    mount.hostPath.startsWith(staging),
    "the mount source was not the staged copy",
  );
  assert.equal(
    await readFile(mount.hostPath, "utf8"),
    '{"last_refresh":"original"}',
  );

  // A refresh inside the container writes the copy; the host file is not it.
  await writeFile(mount.hostPath, '{"last_refresh":"rotated"}', "utf8");
  assert.equal(
    await readFile(path.join(home, ".codex/auth.json"), "utf8"),
    '{"last_refresh":"original"}',
  );
});

test("ephemeral-copy without a staging directory is refused", async (t) => {
  const { home, cleanup } = await fakeHome({ ".codex/auth.json": "{}" });
  t.after(cleanup);

  await assert.rejects(
    async () =>
      await resolveVendorCredentials("codex", { home, mode: "ephemeral-copy" }),
    /stagingDir/u,
  );
});

test("a weakened container is refused as the sole confinement boundary", () => {
  const base = { image: "coord/agent:1" };
  assert.doesNotThrow(() => assertContainerIsSoleBoundary(base));

  for (const [weakened, pattern] of [
    [{ ...base, readOnlyRootFilesystem: false }, /readOnlyRootFilesystem/u],
    [{ ...base, dropCapabilities: false }, /dropCapabilities/u],
    [{ ...base, noNewPrivileges: false }, /noNewPrivileges/u],
    [{ ...base, network: "bridge" }, /network is widened/u],
  ] as const) {
    assert.throws(() => assertContainerIsSoleBoundary(weakened), pattern);
  }
});
