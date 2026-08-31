import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/* Imported by path rather than by specifier: `electron/agents.mjs` is shipped
   as plain JavaScript beside the app's own main process, with no build step
   between the file and the packaged copy. It is imported at all — rather than
   read as text like the browser-module tests do — because it deliberately
   holds no Electron, which is the point of it being a separate file. */
const electronDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "electron",
);

interface AgentEntry {
  adapter: string;
  command?: string;
}

interface AgentsModule {
  detectAgents: () => Promise<Record<string, AgentEntry>>;
  ensureProject: (
    root: string,
    agents: Record<string, AgentEntry>,
  ) => Promise<{ agents: Record<string, AgentEntry> }>;
}

async function load(): Promise<AgentsModule> {
  return (await import(
    path.join(electronDir, "agents.mjs")
  )) as unknown as AgentsModule;
}

async function withTemp(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "worker-agents-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The detour that made three vendors look broken at once.
 *
 * This process has just walked `PATH` and found the exact file. Handing the
 * worker the bare name instead threw that answer away and asked a child — with
 * a sanitised environment, on a platform where `spawn` resolves neither
 * `PATHEXT` nor a `.cmd` shim — to find it again. Writing the path down means
 * the second lookup does not have to succeed for the agent to run.
 */
test("a detected CLI is recorded by the path it was found at", async () => {
  await withTemp(async (dir) => {
    const bin = path.join(dir, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "codex"), "#!/bin/sh\n");
    await writeFile(path.join(bin, "claude"), "#!/bin/sh\n");
    const previous = process.env["PATH"];
    process.env["PATH"] = bin;
    try {
      const { detectAgents } = await load();
      const agents = await detectAgents();
      assert.deepEqual(agents["codex"], {
        adapter: "codex",
        command: path.join(bin, "codex"),
      });
      // Claude is the exception, and stays one: its npm shim cannot be
      // spawned on Windows, so its adapter goes looking for the native binary
      // and naming the shim here would override the lookup that knows better.
      assert.deepEqual(agents["claude"], { adapter: "claude" });
      assert.equal(agents["cursor"], undefined);
    } finally {
      if (previous === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = previous;
      }
    }
  });
});

test("the saved config is reconciled with the machine, not frozen at first run", async () => {
  await withTemp(async (dir) => {
    const { ensureProject } = await load();
    const root = path.join(dir, "worker");
    const configPath = path.join(root, ".coordinator", "config.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    const stale = path.join(dir, "gone", "codex");
    const live = path.join(dir, "here", "cursor-agent");
    await mkdir(path.dirname(live), { recursive: true });
    await writeFile(live, "#!/bin/sh\n");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        validationCommands: ["npm test"],
        agents: {
          // Written by an older build, before paths were recorded at all.
          claude: { adapter: "claude" },
          // A path that no longer resolves: an npm prefix that moved, or a
          // CLI uninstalled since. Detection's answer has to win.
          codex: { adapter: "codex", command: stale },
          // Chosen deliberately, off `PATH`, and still there. Left alone.
          cursor: { adapter: "cursor", command: live },
          // Not an agent this build knows about. Not this function's to touch.
          house: { adapter: "generic-cli", command: "/usr/bin/house" },
        },
      }),
      "utf8",
    );

    const config = await ensureProject(root, {
      codex: { adapter: "codex", command: path.join(dir, "here", "codex") },
    });

    assert.equal(config.agents["codex"]?.command, path.join(dir, "here", "codex"));
    assert.equal(config.agents["cursor"]?.command, live);
    assert.equal(config.agents["house"]?.command, "/usr/bin/house");
    // Claude was not detected and carries no path that resolves, so the
    // worker stops advertising it: leasing work it cannot run is worse than
    // never being offered it.
    assert.equal(config.agents["claude"], undefined);

    const written = JSON.parse(await readFile(configPath, "utf8")) as {
      validationCommands: string[];
      agents: Record<string, AgentEntry>;
    };
    assert.deepEqual(written.validationCommands, ["npm test"]);
    assert.deepEqual(written.agents, config.agents);
  });
});

/**
 * npm writes two files, and only one of them is executable by Windows.
 *
 * A global install puts both an extensionless shell script and a `.cmd` into
 * the same directory. Pinning the script would hand the worker a file Windows
 * cannot start, so the real executables are searched for first — which is
 * also the order a default `PATHEXT` implies.
 */
test("a real executable is pinned ahead of the extensionless npm script", async () => {
  await withTemp(async (dir) => {
    const bin = path.join(dir, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "codex"), "#!/bin/sh\n");
    await writeFile(path.join(bin, "codex.cmd"), "@echo off\n");
    const previous = process.env["PATH"];
    process.env["PATH"] = bin;
    try {
      const { detectAgents } = await load();
      const agents = await detectAgents();
      assert.equal(agents["codex"]?.command, path.join(bin, "codex.cmd"));
    } finally {
      if (previous === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = previous;
      }
    }
  });
});
