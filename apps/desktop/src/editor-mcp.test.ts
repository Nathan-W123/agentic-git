import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/* By URL, for the reason the other two electron-free suites are: on Windows
   an absolute path is not a valid import specifier, and this runs on the
   Windows runner during a release build. */
const electronDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "electron",
);

interface Server {
  name: string;
  url: string;
  token: string;
}

interface Module {
  CODEX_TOKEN_VARIABLE: string;
  mergeClaudeConfig: (saved: unknown, server: Server) => Record<string, unknown>;
  mergeCursorConfig: (saved: unknown, server: Server) => Record<string, unknown>;
  mergeCodexToml: (text: string, server: Server) => string;
  configPathFor: (vendor: string, home: string) => string | undefined;
  connectEditor: (input: {
    vendor: string;
    home: string;
    server: Server;
  }) => Promise<{ path: string; variable?: string }>;
}

async function load(): Promise<Module> {
  return (await import(
    pathToFileURL(path.join(electronDir, "editor-mcp.mjs")).href
  )) as unknown as Module;
}

const KUMI: Server = {
  name: "kumi",
  url: "https://kumi.up.railway.app/api/v1/mcp",
  token: "coord_pat_abc.def",
};

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), "editor-mcp-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * The rule the whole module exists to keep.
 *
 * `~/.claude.json` is somebody's own file — their projects, their history,
 * their other MCP servers. A connect that replaced it, or that dropped a
 * server they had added by hand, would be worse than the command it saves
 * them typing.
 */
test("connecting Claude adds one server and touches nothing else", async () => {
  const { mergeClaudeConfig } = await load();
  const saved = {
    numStartups: 41,
    projects: { "/home/me/work": { allowedTools: ["Bash"] } },
    mcpServers: { linear: { type: "http", url: "https://mcp.linear.app" } },
  };
  const merged = mergeClaudeConfig(saved, KUMI);
  assert.equal(merged["numStartups"], 41);
  assert.deepEqual(merged["projects"], saved.projects);
  assert.deepEqual((merged["mcpServers"] as Record<string, unknown>)["linear"], {
    type: "http",
    url: "https://mcp.linear.app",
  });
  assert.deepEqual((merged["mcpServers"] as Record<string, unknown>)["kumi"], {
    type: "http",
    url: KUMI.url,
    headers: { Authorization: `Bearer ${KUMI.token}` },
  });

  // A file that does not exist yet, and one this build cannot read, both give
  // a config with exactly one server rather than a throw.
  assert.deepEqual(Object.keys(mergeClaudeConfig(undefined, KUMI)), ["mcpServers"]);
  assert.deepEqual(Object.keys(mergeClaudeConfig({ mcpServers: 7 }, KUMI)["mcpServers"] as object), [
    "kumi",
  ]);
});

test("connecting Cursor uses its own file and its own shape", async () => {
  const { mergeCursorConfig, configPathFor } = await load();
  const merged = mergeCursorConfig({ mcpServers: { other: { url: "https://x" } } }, KUMI);
  assert.deepEqual((merged["mcpServers"] as Record<string, unknown>)["kumi"], {
    url: KUMI.url,
    headers: { Authorization: `Bearer ${KUMI.token}` },
  });
  assert.equal((merged["mcpServers"] as Record<string, unknown>)["other"] !== undefined, true);
  assert.equal(configPathFor("cursor", "/home/me"), path.join("/home/me", ".cursor", "mcp.json"));
});

/**
 * Codex keeps model settings, sandbox settings and comments in this file, so
 * it is edited as text. Parsing and re-emitting would mean owning a TOML
 * writer and reformatting somebody's file to use it.
 */
test("connecting Codex rewrites only its own section", async () => {
  const { mergeCodexToml, CODEX_TOKEN_VARIABLE } = await load();
  const saved = [
    "model = \"gpt-5.6-terra\"",
    "",
    "[mcp_servers.jira]",
    'command = "npx"',
    "",
    "[sandbox]",
    'mode = "workspace-write"',
    "",
  ].join("\n");

  const added = mergeCodexToml(saved, KUMI);
  assert.match(added, /model = "gpt-5\.6-terra"/u);
  assert.match(added, /\[mcp_servers\.jira\]/u);
  assert.match(added, /\[sandbox\]/u);
  assert.match(added, /\[mcp_servers\.kumi\]/u);
  assert.match(added, new RegExp(`bearer_token_env_var = "${CODEX_TOKEN_VARIABLE}"`, "u"));
  // The token itself never reaches the file: Codex reads it from the
  // environment, and a config file is the wrong place for a credential.
  assert.doesNotMatch(added, /coord_pat_/u);

  // Connecting twice replaces its own section rather than appending a second.
  const again = mergeCodexToml(added, { ...KUMI, url: "https://elsewhere/mcp" });
  assert.equal(again.match(/\[mcp_servers\.kumi\]/gu)?.length, 1);
  assert.match(again, /https:\/\/elsewhere\/mcp/u);
  assert.doesNotMatch(again, /kumi\.up\.railway/u);
  // And the sections either side of it survive that replacement.
  assert.match(again, /\[mcp_servers\.jira\]/u);
  assert.match(again, /\[sandbox\]/u);
  assert.match(again, /mode = "workspace-write"/u);

  // An empty or absent file is a file with one section in it.
  assert.match(mergeCodexToml("", KUMI), /^\[mcp_servers\.kumi\]/u);
});

test("a name that could address a different table is refused", async () => {
  const { mergeCodexToml } = await load();
  for (const name of ["kumi.evil", "kumi]", "Kumi", "", "-kumi"]) {
    assert.throws(
      () => mergeCodexToml("", { ...KUMI, name }),
      /must be lower-case/u,
      name,
    );
  }
});

test("writing lands in the right file, owner-only, and says what is left to do", async () => {
  await withHome(async (home) => {
    const { connectEditor, CODEX_TOKEN_VARIABLE } = await load();

    const claude = await connectEditor({ vendor: "claude", home, server: KUMI });
    assert.equal(claude.path, path.join(home, ".claude.json"));
    assert.equal(claude.variable, undefined);
    const written = JSON.parse(await readFile(claude.path, "utf8")) as {
      mcpServers: Record<string, { url: string }>;
    };
    assert.equal(written.mcpServers["kumi"]?.url, KUMI.url);

    // Directories that do not exist yet are made, which is the ordinary case
    // for somebody who has never opened Cursor's config.
    const cursor = await connectEditor({ vendor: "cursor", home, server: KUMI });
    assert.equal(cursor.path, path.join(home, ".cursor", "mcp.json"));

    // Codex reports the variable, because writing the file is only half of
    // connecting it and a caller that said "done" would be lying.
    const codex = await connectEditor({ vendor: "codex", home, server: KUMI });
    assert.equal(codex.path, path.join(home, ".codex", "config.toml"));
    assert.equal(codex.variable, CODEX_TOKEN_VARIABLE);

    await assert.rejects(
      async () => await connectEditor({ vendor: "kiro", home, server: KUMI }),
      /cannot be connected automatically/u,
    );
  });
});

test("an existing file's other keys survive a real write", async () => {
  await withHome(async (home) => {
    const { connectEditor } = await load();
    const file = path.join(home, ".claude.json");
    await writeFile(
      file,
      JSON.stringify({ numStartups: 9, mcpServers: { linear: { url: "https://l" } } }),
      "utf8",
    );
    await connectEditor({ vendor: "claude", home, server: KUMI });
    const after = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    assert.equal(after["numStartups"], 9);
    assert.deepEqual(Object.keys(after["mcpServers"] as object).sort(), ["kumi", "linear"]);

    // Cursor's directory may already hold other things; only its own file is
    // touched.
    await mkdir(path.join(home, ".cursor"), { recursive: true });
    await writeFile(path.join(home, ".cursor", "rules.md"), "keep me", "utf8");
    await connectEditor({ vendor: "cursor", home, server: KUMI });
    assert.equal(await readFile(path.join(home, ".cursor", "rules.md"), "utf8"), "keep me");
  });
});
