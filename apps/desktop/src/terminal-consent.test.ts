/**
 * Whether this machine opens terminals, and the three states that answer it.
 *
 * The file these functions write is the one the worker trusts, and the two
 * ways to get it wrong are opposite and both bad: a machine that opens a
 * shell nobody agreed to, and a switch that will not stay off. The second is
 * the one worth naming, because it is the one a two-state design produces —
 * "not allowed" and "never asked" have to be different values, or every start
 * quietly turns the setting back on.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/* Imported by URL because on Windows an absolute path is not a valid import
   specifier, and this suite runs on the Windows runner during a release
   build. `terminal-consent.mjs` is importable at all because it deliberately
   holds no Electron. */
const electronDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "electron",
);

type Consent = "all" | string[] | undefined;

interface ConsentModule {
  terminalConfigPath: (root: string) => string;
  terminalConsent: (config: unknown) => Consent;
  readTerminalConsent: (root: string) => Promise<Consent>;
  withTerminalConsent: (
    config: unknown,
    allowed: boolean,
  ) => Record<string, unknown>;
  ensureTerminalConsent: (
    root: string,
  ) => Promise<{ wrote: boolean; allowed: boolean }>;
  setTerminalConsent: (
    root: string,
    allowed: boolean,
  ) => Promise<Record<string, unknown>>;
}

async function load(): Promise<ConsentModule> {
  return (await import(
    pathToFileURL(path.join(electronDir, "terminal-consent.mjs")).href
  )) as unknown as ConsentModule;
}

async function workspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "kumi-terminal-consent-"));
}

async function writeConfig(root: string, config: unknown): Promise<void> {
  const { terminalConfigPath } = await load();
  const target = terminalConfigPath(root);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(config, undefined, 2)}\n`, "utf8");
}

async function readConfig(root: string): Promise<Record<string, unknown>> {
  const { terminalConfigPath } = await load();
  return JSON.parse(await readFile(terminalConfigPath(root), "utf8")) as Record<
    string,
    unknown
  >;
}

test("a machine that has never been asked is opted in, and only once", async (t) => {
  const { ensureTerminalConsent, readTerminalConsent } = await load();
  const root = await workspace();
  t.after(async () => await rm(root, { recursive: true, force: true }));

  // Nothing on disk at all: no config, no directory. The first start writes
  // it, because installing the app and signing it in on this computer is the
  // consent — nothing here can open a shell on anybody else's machine.
  const first = await ensureTerminalConsent(root);
  assert.deepEqual(first, { wrote: true, allowed: true });
  assert.equal(await readTerminalConsent(root), "all");

  // And the second start finds an answer and leaves it alone. `wrote` is what
  // says which of the two happened, because a log reading "allowed terminals"
  // on every launch says nothing about whether anything changed.
  const second = await ensureTerminalConsent(root);
  assert.deepEqual(second, { wrote: false, allowed: true });
});

test("a machine whose owner turned terminals off stays off across starts", async (t) => {
  const { ensureTerminalConsent, readTerminalConsent, setTerminalConsent } =
    await load();
  const root = await workspace();
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await ensureTerminalConsent(root);
  await setTerminalConsent(root, false);
  assert.deepEqual(await readTerminalConsent(root), []);

  // The whole reason "off" is an empty list rather than a missing key. Delete
  // the key to say no and the next start reads "never asked" and says yes —
  // the switch would last exactly until the app was reopened.
  const restarted = await ensureTerminalConsent(root);
  assert.deepEqual(restarted, { wrote: false, allowed: false });
  assert.deepEqual(await readTerminalConsent(root), []);

  // And back on again, from the same switch.
  await setTerminalConsent(root, true);
  assert.equal(await readTerminalConsent(root), "all");
});

test("the switch keeps every other key in the file, cwd included", async (t) => {
  const { ensureTerminalConsent, setTerminalConsent } = await load();
  const root = await workspace();
  t.after(async () => await rm(root, { recursive: true, force: true }));

  // Several hands write this file — `ensureProject`, the MCP allowlist, this
  // — and a write that only knows about its own key must not take another's
  // away. `cwd` is the one under `terminal` itself: it pins where sessions
  // start, and losing it would move somebody's terminals without saying so.
  await writeConfig(root, {
    version: 4,
    agents: { claude: { adapter: "claude" } },
    mcp: { allow: [{ name: "github", digest: "abc" }] },
    terminal: { cwd: "/Users/nathan/code" },
  });

  await ensureTerminalConsent(root);
  const written = await readConfig(root);
  assert.equal(written["version"], 4);
  assert.deepEqual(written["agents"], { claude: { adapter: "claude" } });
  assert.deepEqual(written["mcp"], {
    allow: [{ name: "github", digest: "abc" }],
  });
  assert.deepEqual(written["terminal"], {
    cwd: "/Users/nathan/code",
    allow: "all",
  });

  await setTerminalConsent(root, false);
  assert.deepEqual((await readConfig(root))["terminal"], {
    cwd: "/Users/nathan/code",
    allow: [],
  });
});

test("a value nobody can read is not a decision", async (t) => {
  const { terminalConsent, ensureTerminalConsent, readTerminalConsent } =
    await load();

  // "I cannot tell what this says" and "nobody has said" lead to the same
  // place: refuse, and write the answer. Anything but "all" or a list of
  // names is the first of those.
  for (const allow of [undefined, null, 12, "some", {}, true]) {
    assert.equal(terminalConsent({ terminal: { allow } }), undefined, String(allow));
  }
  assert.equal(terminalConsent(undefined), undefined);
  assert.equal(terminalConsent({ terminal: "all" }), undefined);
  // A list is a decision, and the entries that are not names are dropped
  // the way the worker drops them rather than making the whole list unreadable.
  assert.deepEqual(terminalConsent({ terminal: { allow: ["demo", 4, ""] } }), [
    "demo",
  ]);

  const root = await workspace();
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeConfig(root, { terminal: { allow: "sure" } });
  assert.deepEqual(await ensureTerminalConsent(root), {
    wrote: true,
    allowed: true,
  });
  assert.equal(await readTerminalConsent(root), "all");
});

test("a config file that is not an object is replaced rather than merged into", async (t) => {
  const { ensureTerminalConsent, terminalConfigPath } = await load();
  const root = await workspace();
  t.after(async () => await rm(root, { recursive: true, force: true }));

  // A worker root holding a JSON array, or nothing that parses at all. The
  // spread of a non-object would produce a config with numeric keys; this
  // starts again from an empty one.
  await mkdir(path.dirname(terminalConfigPath(root)), { recursive: true });
  await writeFile(terminalConfigPath(root), "[1,2,3]", "utf8");
  await ensureTerminalConsent(root);
  assert.deepEqual(await readConfig(root), { terminal: { allow: "all" } });

  await writeFile(terminalConfigPath(root), "{ not json", "utf8");
  await ensureTerminalConsent(root);
  assert.deepEqual(await readConfig(root), { terminal: { allow: "all" } });
});
