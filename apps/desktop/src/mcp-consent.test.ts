import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/* Imported by URL for the reason `worker-agents.test.ts` is: on Windows an
   absolute path is not a valid import specifier, and this suite runs on the
   Windows runner during a release build. `mcp-consent.mjs` is importable at
   all because it deliberately holds no Electron. */
const electronDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "electron",
);

type Allow = "all" | string[];

interface ConsentModule {
  allowedMcp: (config: unknown) => Allow;
  missingMcpNames: (allow: Allow, names: unknown) => string[];
  mergeMcpAllow: (config: unknown, names: readonly string[]) => Record<string, unknown>;
  allowMcpServers: (
    root: string,
    names: readonly string[],
  ) => Promise<Record<string, unknown>>;
  readAllowedMcp: (root: string) => Promise<Allow>;
}

async function load(): Promise<ConsentModule> {
  return (await import(
    pathToFileURL(path.join(electronDir, "mcp-consent.mjs")).href
  )) as unknown as ConsentModule;
}

async function withTemp(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-consent-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function written(root: string): Promise<{ text: string; config: Record<string, unknown> }> {
  const text = await readFile(path.join(root, ".coordinator", "config.json"), "utf8");
  return { text, config: JSON.parse(text) as Record<string, unknown> };
}

/**
 * A "yes" lands in the file the worker reads, and nowhere else.
 *
 * The allowlist is the one thing standing between a project's decision and a
 * program starting under this person's account, so the write has to be
 * exactly what was agreed to: the names asked about, no more, on top of what
 * was there — and a first answer on a machine with no config yet must not
 * fail for want of a file to merge into.
 */
test("the owner's yes is written where the worker reads it", async () => {
  await withTemp(async (dir) => {
    const { allowMcpServers, readAllowedMcp } = await load();
    const root = path.join(dir, "worker");

    // Nothing saved yet: the first start has not happened, or the file was
    // unreadable. The answer still has to be recorded.
    assert.deepEqual(await readAllowedMcp(root), []);
    await allowMcpServers(root, ["linear", "github", "github"]);
    assert.deepEqual(await readAllowedMcp(root), ["github", "linear"]);
    const first = await written(root);
    assert.deepEqual(first.config, { mcp: { allow: ["github", "linear"] } });
    // The shape `ensureProject` writes, so the two never take turns
    // reformatting the file.
    assert.equal(first.text, `${JSON.stringify(first.config, undefined, 2)}\n`);

    // A second answer widens the list rather than replacing it.
    await allowMcpServers(root, ["atlassian", "github"]);
    assert.deepEqual(await readAllowedMcp(root), ["atlassian", "github", "linear"]);
  });
});

test("allowing part of a project never narrows a machine that allowed all of it", async () => {
  await withTemp(async (dir) => {
    const { allowMcpServers, missingMcpNames, readAllowedMcp } = await load();
    const root = path.join(dir, "worker");
    await mkdir(path.join(root, ".coordinator"), { recursive: true });
    await writeFile(
      path.join(root, ".coordinator", "config.json"),
      JSON.stringify({ version: 1, mcp: { allow: "all" } }),
      "utf8",
    );
    // Nothing to ask: "all" covers whatever is offered.
    assert.deepEqual(missingMcpNames(await readAllowedMcp(root), ["github"]), []);

    const config = await allowMcpServers(root, ["github"]);
    assert.deepEqual(config["mcp"], { allow: "all" });
    assert.equal(await readAllowedMcp(root), "all");
  });
});

/**
 * This file has several authors — the worker's own detection, the settings
 * window, a person with an editor — and a writer that knows about one key
 * must not be able to lose another's. A build that rewrote the config from
 * what it understood would drop the agents this machine was detected with,
 * and the worker would start advertising nothing.
 */
test("every other key survives the write verbatim", async () => {
  await withTemp(async (dir) => {
    const { allowMcpServers } = await load();
    const root = path.join(dir, "worker");
    await mkdir(path.join(root, ".coordinator"), { recursive: true });
    const saved = {
      version: 1,
      validationCommands: ["npm test"],
      agents: {
        codex: { adapter: "codex", command: "/opt/bin/codex" },
        house: { adapter: "generic-cli", command: "/usr/bin/house" },
      },
      // Keys this build does not know, and a sibling under `mcp` it does not
      // manage. Both have to come back untouched.
      future: { nested: [1, 2, 3] },
      mcp: { allow: ["github"], strict: true },
    };
    await writeFile(
      path.join(root, ".coordinator", "config.json"),
      JSON.stringify(saved),
      "utf8",
    );

    await allowMcpServers(root, ["linear"]);
    const { config } = await written(root);
    assert.deepEqual(config, {
      ...saved,
      mcp: { allow: ["github", "linear"], strict: true },
    });
  });
});

/**
 * What gets asked is exactly what is not yet allowed. Asking about a server
 * the person already said yes to is asking twice; asking about nothing is
 * a dialog with an empty list in it; and a malformed message from the child
 * is a reason to ask nothing rather than a reason to throw inside an event
 * handler nobody is awaiting.
 */
test("only the names not yet allowed are put to the owner", async () => {
  const { allowedMcp, mergeMcpAllow, missingMcpNames } = await load();

  assert.deepEqual(missingMcpNames([], ["linear", "github", "linear"]), ["github", "linear"]);
  assert.deepEqual(missingMcpNames(["github"], ["github", "linear"]), ["linear"]);
  assert.deepEqual(missingMcpNames(["github"], ["github"]), []);
  assert.deepEqual(missingMcpNames("all", ["github"]), []);
  assert.deepEqual(missingMcpNames([], ["", 7, undefined, "github"]), ["github"]);
  assert.deepEqual(missingMcpNames([], "github"), []);

  // A config the worker would refuse is read as allowing nothing, not as an
  // error — this runs in answer to a child message with nobody to catch it.
  assert.deepEqual(allowedMcp(undefined), []);
  assert.deepEqual(allowedMcp({ mcp: { allow: "some" } }), []);
  assert.deepEqual(allowedMcp({ mcp: { allow: ["github", 3, ""] } }), ["github"]);
  assert.equal(allowedMcp({ mcp: { allow: "all" } }), "all");

  // The merge itself, without a disk under it.
  assert.deepEqual(mergeMcpAllow(undefined, ["b", "a"]), { mcp: { allow: ["a", "b"] } });
  assert.deepEqual(mergeMcpAllow({ mcp: { allow: ["c"] } }, ["a", "c"]), {
    mcp: { allow: ["a", "c"] },
  });
  assert.deepEqual(mergeMcpAllow({ mcp: { allow: "all" } }, ["a"]), {
    mcp: { allow: "all" },
  });
});
