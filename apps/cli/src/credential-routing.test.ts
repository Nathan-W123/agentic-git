import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SubmittedTask } from "@coord/persistence";
import type { TaskId } from "@coord/shared-types";
import { UserCredentialStore } from "@coord/workspace-manager";

import { openSubmitterCredentialHome } from "./commands.js";
import type { AgentConfig } from "./project.js";

/**
 * Which account a queued task runs under.
 *
 * Build-mode dispatch with no worker registered executes on the control-plane
 * host, which historically meant every user's task ran under whatever account
 * that machine was logged into. These tests pin the replacement: a task runs
 * under its submitter's own credential, and a deployment can choose whether a
 * task with no such credential falls back to the host login or is refused.
 */

const CLAUDE_AGENT: AgentConfig = { adapter: "claude" };

function submittedTask(overrides: Partial<SubmittedTask> = {}): SubmittedTask {
  return {
    id: "task-1" as TaskId,
    repositoryId: "repo",
    projectId: undefined,
    objective: "do the thing",
    agentId: "claude",
    validationCommands: [],
    submittedBy: undefined,
    status: "claimed",
    submittedAt: new Date(0).toISOString(),
    claimedAt: undefined,
    completedAt: undefined,
    runId: undefined,
    ...overrides,
  } as SubmittedTask;
}

async function vault(t: {
  after: (fn: () => Promise<void>) => void;
}): Promise<UserCredentialStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coord-routing-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return new UserCredentialStore(
    path.join(directory, "user-credentials.json"),
    randomBytes(32),
  );
}

test("a task runs under the credential of whoever submitted it", async (t) => {
  const credentials = await vault(t);
  await credentials.put("alice", "claude", {
    kind: "oauth_token",
    secret: "alice-token",
  });
  await credentials.put("bob", "claude", {
    kind: "oauth_token",
    secret: "bob-token",
  });

  for (const [user, expected] of [
    ["alice", "alice-token"],
    ["bob", "bob-token"],
  ] as const) {
    const home = await openSubmitterCredentialHome(
      CLAUDE_AGENT,
      submittedTask({ submittedBy: user }),
      { credentials },
    );
    assert.ok(home !== undefined);
    t.after(home.close);
    assert.equal(home.env["CLAUDE_CODE_OAUTH_TOKEN"], expected);
    assert.ok(
      (home.env["CLAUDE_CONFIG_DIR"] ?? "").length > 0,
      "the host's own login must be out of reach",
    );
  }
});

test("without a credential store nothing changes for existing projects", async () => {
  const home = await openSubmitterCredentialHome(
    CLAUDE_AGENT,
    submittedTask({ submittedBy: "alice" }),
    {},
  );
  assert.equal(
    home,
    undefined,
    "the trusted local CLI keeps running under the host login",
  );
});

test("a submitter who has connected nothing falls back to the host login", async (t) => {
  const credentials = await vault(t);
  const home = await openSubmitterCredentialHome(
    CLAUDE_AGENT,
    submittedTask({ submittedBy: "carol" }),
    { credentials },
  );
  assert.equal(home, undefined);
});

test("a refusing deployment fails the task rather than billing the host owner", async (t) => {
  const credentials = await vault(t);

  await assert.rejects(
    openSubmitterCredentialHome(
      CLAUDE_AGENT,
      submittedTask({ submittedBy: "carol" }),
      { credentials, credentialPolicy: "refuse" },
    ),
    /has connected no claude account/u,
  );

  // A task with no submitter at all has nobody to charge, so it is refused
  // for the same reason rather than silently falling through.
  await assert.rejects(
    openSubmitterCredentialHome(CLAUDE_AGENT, submittedTask(), {
      credentials,
      credentialPolicy: "refuse",
    }),
    /records no submitter/u,
  );
});

test("a generic-cli agent is left alone", async (t) => {
  const credentials = await vault(t);
  await credentials.put("alice", "claude", {
    kind: "oauth_token",
    secret: "alice-token",
  });

  // Its executable authenticates however the deployment configured it, so
  // injecting a vendor credential would be meaningless at best.
  const home = await openSubmitterCredentialHome(
    { command: "./run-agent" },
    submittedTask({ submittedBy: "alice" }),
    { credentials, credentialPolicy: "refuse" },
  );
  assert.equal(home, undefined);
});

test("each vendor gets its credential the way that vendor reads it", async (t) => {
  const credentials = await vault(t);
  await credentials.put("alice", "codex", {
    kind: "api_key",
    secret: "openai-key",
  });
  await credentials.put("alice", "gemini", {
    kind: "api_key",
    secret: "google-key",
  });

  const codex = await openSubmitterCredentialHome(
    { adapter: "codex" },
    submittedTask({ submittedBy: "alice" }),
    { credentials },
  );
  assert.ok(codex !== undefined);
  t.after(codex.close);
  // Codex ignores OPENAI_API_KEY entirely — with only the variable set it
  // sends no credential at all — so the key must arrive in auth.json.
  assert.ok((codex.env["CODEX_HOME"] ?? "").length > 0);
  const auth = JSON.parse(
    await readFile(path.join(codex.env["CODEX_HOME"] as string, "auth.json"), "utf8"),
  ) as { auth_mode?: string; OPENAI_API_KEY?: string };
  assert.equal(auth.auth_mode, "apikey");
  assert.equal(auth.OPENAI_API_KEY, "openai-key");

  const gemini = await openSubmitterCredentialHome(
    { adapter: "gemini" },
    submittedTask({ submittedBy: "alice" }),
    { credentials },
  );
  assert.ok(gemini !== undefined);
  t.after(gemini.close);
  assert.equal(gemini.env["GEMINI_API_KEY"], "google-key");
  assert.equal(gemini.env["OPENAI_API_KEY"], undefined);
});

test("task credential homes share a lease and persist rotation on close", async (t) => {
  const credentials = await vault(t);
  const original = JSON.stringify({ tokens: { access_token: "before" } });
  const refreshed = JSON.stringify({ tokens: { access_token: "after" } });
  await credentials.put("alice", "codex", {
    kind: "session_file",
    secret: original,
  });
  const task = submittedTask({ submittedBy: "alice" });
  const first = await openSubmitterCredentialHome(
    { adapter: "codex" },
    task,
    { credentials },
  );
  assert.ok(first !== undefined);

  let secondOpened = false;
  const secondPromise = openSubmitterCredentialHome(
    { adapter: "codex" },
    submittedTask({ id: "task-2" as TaskId, submittedBy: "alice" }),
    { credentials },
  ).then((home) => {
    secondOpened = true;
    return home;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const openedBeforeRelease = secondOpened;

  await writeFile(
    path.join(first.env["CODEX_HOME"] as string, "auth.json"),
    `${refreshed}\n`,
    "utf8",
  );
  await first.close();
  const second = await secondPromise;
  assert.ok(second !== undefined);
  await second.close();

  assert.equal(
    openedBeforeRelease,
    true,
    "one coordinator must be able to stage multiple task homes",
  );
  assert.equal((await credentials.get("alice", "codex"))?.secret, refreshed);
});
