import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ResolvedMcpServer } from "@coord/shared-types";

import { stageMcpServers } from "./mcp-config.js";

const GITHUB: ResolvedMcpServer = {
  name: "github",
  transport: "http",
  url: "https://mcp.example/github",
  headers: { Authorization: "Bearer ghp_opened_secret" },
};

const JIRA: ResolvedMcpServer = {
  name: "jira",
  transport: "stdio",
  command: "jira-mcp",
  args: ["--site", "example"],
  env: { JIRA_TOKEN: "jira_opened_secret" },
};

async function withScratch(
  run: (scratch: string) => Promise<void>,
): Promise<void> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "cmcp-"));
  try {
    await run(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test("claude: the config is written beside the workspace, owner-only, secrets inside", async () => {
  await withScratch(async (scratch) => {
    const staged = await stageMcpServers({
      scratch,
      vendor: "claude",
      servers: [GITHUB, JIRA],
      allow: { allow: "all" },
    });
    assert.deepEqual(staged.withheld, []);
    assert.deepEqual(staged.staged, ["github", "jira"]);
    assert.ok(staged.codex === undefined);
    const configPath = staged.claude?.configPath;
    assert.ok(configPath !== undefined);

    // Under the run's scratch root and never under its workspace: everything
    // untracked in the workspace is staged into the changeset, and this file
    // holds opened secrets.
    assert.equal(path.dirname(path.dirname(configPath)), scratch);
    assert.equal(
      configPath.startsWith(path.join(scratch, "workspace") + path.sep),
      false,
    );
    assert.equal(configPath.includes(`${path.sep}workspace${path.sep}`), false);
    if (process.platform !== "win32") {
      assert.equal((await stat(configPath)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(configPath))).mode & 0o777, 0o700);
    }

    const written = JSON.parse(await readFile(configPath, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(written, {
      mcpServers: {
        github: {
          type: "http",
          url: "https://mcp.example/github",
          headers: { Authorization: "Bearer ghp_opened_secret" },
        },
        jira: {
          command: "jira-mcp",
          args: ["--site", "example"],
          env: { JIRA_TOKEN: "jira_opened_secret" },
        },
      },
    });
  });
});

test("an absent allowlist withholds everything and writes nothing", async () => {
  await withScratch(async (scratch) => {
    const staged = await stageMcpServers({
      scratch,
      vendor: "claude",
      servers: [GITHUB, JIRA],
      allow: undefined,
    });
    assert.deepEqual(staged, { withheld: ["github", "jira"], staged: [] });
    // Not even an empty config: a machine that has not been asked leaves no
    // trace of the offer on its disk.
    await assert.rejects(access(path.join(scratch, "mcp")));
  });
});

test("a named allowlist stages what it names and reports the rest", async () => {
  await withScratch(async (scratch) => {
    const staged = await stageMcpServers({
      scratch,
      vendor: "claude",
      servers: [GITHUB, JIRA],
      allow: { allow: ["jira"] },
    });
    assert.deepEqual(staged.withheld, ["github"]);
    assert.deepEqual(staged.staged, ["jira"]);
    const written = JSON.parse(
      await readFile(staged.claude?.configPath ?? "", "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(Object.keys(written.mcpServers), ["jira"]);
  });
});

test("codex: the servers are handed back for the adapter to carry", async () => {
  await withScratch(async (scratch) => {
    const staged = await stageMcpServers({
      scratch,
      vendor: "codex",
      servers: [GITHUB, JIRA],
      allow: { allow: "all" },
    });
    assert.deepEqual(staged.codex?.servers, [GITHUB, JIRA]);
    assert.ok(staged.claude === undefined);
    assert.deepEqual(staged.staged, ["github", "jira"]);
    await assert.rejects(access(path.join(scratch, "mcp")));
  });
});

test("a vendor that cannot load servers is refused loudly, and only when there is something to load", async () => {
  await withScratch(async (scratch) => {
    // Cursor reads only <workspace>/.cursor/mcp.json — inside the changeset.
    await assert.rejects(
      stageMcpServers({
        scratch,
        vendor: "cursor",
        servers: [GITHUB],
        allow: { allow: "all" },
      }),
      /cursor cannot be given managed MCP servers yet/u,
    );
    await assert.rejects(
      stageMcpServers({
        scratch,
        vendor: "gemini",
        servers: [JIRA],
        allow: { allow: ["jira"] },
      }),
      /gemini cannot be given managed MCP servers yet/u,
    );
    // Nothing allowed is nothing to refuse: the run proceeds, and the room
    // hears what was withheld rather than an error about a vendor.
    assert.deepEqual(
      await stageMcpServers({
        scratch,
        vendor: "cursor",
        servers: [GITHUB],
        allow: undefined,
      }),
      { withheld: ["github"], staged: [] },
    );
    assert.deepEqual(
      await stageMcpServers({
        scratch,
        vendor: "cursor",
        servers: [],
        allow: { allow: "all" },
      }),
      { withheld: [], staged: [] },
    );
  });
});
