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

interface Entry {
  name: string;
  digest: string;
}
interface Offered extends Entry {
  summary?: string;
}
interface Missing extends Entry {
  summary: string;
  changed: boolean;
}
type Allow = "all" | Entry[];

interface ConsentModule {
  allowedMcp: (config: unknown) => Allow;
  missingMcpServers: (allow: Allow, servers: unknown) => Missing[];
  mergeMcpAllow: (config: unknown, servers: readonly Offered[]) => Record<string, unknown>;
  allowMcpServers: (
    root: string,
    servers: readonly Offered[],
  ) => Promise<Record<string, unknown>>;
  forgetMcpAllow: (root: string) => Promise<Record<string, unknown>>;
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

const github = { name: "github", digest: "d-github-1", summary: "github: talks to https://mcp.example/github" };
const linear = { name: "linear", digest: "d-linear-1", summary: "linear: runs npx -y @linear/mcp" };
const atlassian = { name: "atlassian", digest: "d-atl-1", summary: "atlassian: runs atlassian-mcp" };

/**
 * A "yes" lands in the file the worker reads, and nowhere else.
 *
 * The allowlist is the one thing standing between a project's decision and a
 * program starting under this person's account, so the write has to be
 * exactly what was agreed to: the servers asked about, by name and digest,
 * no more, on top of what was there — and a first answer on a machine with
 * no config yet must not fail for want of a file to merge into. The summary
 * is for the dialog and is not written: the worker recomputes the digest
 * from every lease, and a description on disk would only drift from it.
 */
test("the owner's yes is written where the worker reads it", async () => {
  await withTemp(async (dir) => {
    const { allowMcpServers, readAllowedMcp } = await load();
    const root = path.join(dir, "worker");

    // Nothing saved yet: the first start has not happened, or the file was
    // unreadable. The answer still has to be recorded.
    assert.deepEqual(await readAllowedMcp(root), []);
    await allowMcpServers(root, [linear, github, github]);
    assert.deepEqual(await readAllowedMcp(root), [
      { name: "github", digest: "d-github-1" },
      { name: "linear", digest: "d-linear-1" },
    ]);
    const first = await written(root);
    assert.deepEqual(first.config, {
      mcp: {
        allow: [
          { name: "github", digest: "d-github-1" },
          { name: "linear", digest: "d-linear-1" },
        ],
      },
    });
    // The shape `ensureProject` writes, so the two never take turns
    // reformatting the file.
    assert.equal(first.text, `${JSON.stringify(first.config, undefined, 2)}\n`);

    // A second answer widens the list rather than replacing it.
    await allowMcpServers(root, [atlassian, github]);
    assert.deepEqual(await readAllowedMcp(root), [
      { name: "atlassian", digest: "d-atl-1" },
      { name: "github", digest: "d-github-1" },
      { name: "linear", digest: "d-linear-1" },
    ]);
  });
});

/**
 * A yes to the new `github` withdraws the yes to the old one.
 *
 * Keeping both would let the project swap between two definitions without
 * ever asking again; the list holds one digest per name, the one most
 * recently agreed to.
 */
test("allowing a server again under a new digest replaces the old one", async () => {
  await withTemp(async (dir) => {
    const { allowMcpServers, missingMcpServers, readAllowedMcp } = await load();
    const root = path.join(dir, "worker");
    await allowMcpServers(root, [github]);
    const moved = { ...github, digest: "d-github-2", summary: "github: talks to https://elsewhere" };
    assert.deepEqual(missingMcpServers(await readAllowedMcp(root), [moved]), [
      { name: "github", digest: "d-github-2", summary: moved.summary, changed: true },
    ]);
    await allowMcpServers(root, [moved]);
    assert.deepEqual(await readAllowedMcp(root), [{ name: "github", digest: "d-github-2" }]);
    // The old definition is no longer allowed.
    assert.equal(missingMcpServers(await readAllowedMcp(root), [github]).length, 1);
  });
});

test("allowing part of a project never narrows a machine that allowed all of it", async () => {
  await withTemp(async (dir) => {
    const { allowMcpServers, missingMcpServers, readAllowedMcp } = await load();
    const root = path.join(dir, "worker");
    await mkdir(path.join(root, ".coordinator"), { recursive: true });
    await writeFile(
      path.join(root, ".coordinator", "config.json"),
      JSON.stringify({ version: 1, mcp: { allow: "all" } }),
      "utf8",
    );
    // Nothing to ask: "all" covers whatever is offered.
    assert.deepEqual(missingMcpServers(await readAllowedMcp(root), [github]), []);

    const config = await allowMcpServers(root, [github]);
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
test("every other key survives the write verbatim, and forgetting takes only the list", async () => {
  await withTemp(async (dir) => {
    const { allowMcpServers, forgetMcpAllow, readAllowedMcp } = await load();
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
      mcp: { allow: [{ name: "github", digest: "d-github-1" }], strict: true },
    };
    await writeFile(
      path.join(root, ".coordinator", "config.json"),
      JSON.stringify(saved),
      "utf8",
    );

    await allowMcpServers(root, [linear]);
    const { config } = await written(root);
    assert.deepEqual(config, {
      ...saved,
      mcp: {
        allow: [
          { name: "github", digest: "d-github-1" },
          { name: "linear", digest: "d-linear-1" },
        ],
        strict: true,
      },
    });

    // Forgetting is the owner taking every yes back: the list goes, the
    // sibling stays, and the worker reads absent as "run nothing".
    await forgetMcpAllow(root);
    const after = await written(root);
    assert.deepEqual(after.config, { ...saved, mcp: { strict: true } });
    assert.equal(after.text, `${JSON.stringify(after.config, undefined, 2)}\n`);
    assert.deepEqual(await readAllowedMcp(root), []);

    // Nothing to forget is not an error, and writes nothing new.
    await rm(path.join(root, ".coordinator", "config.json"));
    assert.deepEqual(await forgetMcpAllow(root), {});
  });
});

/**
 * What gets asked is exactly what is not yet allowed as it now is. Asking
 * about a server the person already said yes to is asking twice; asking
 * about nothing is a dialog with an empty list in it; and a malformed
 * message from the child is a reason to ask nothing rather than a reason to
 * throw inside an event handler nobody is awaiting.
 */
test("only the servers not yet allowed are put to the owner", async () => {
  const { allowedMcp, mergeMcpAllow, missingMcpServers } = await load();

  const missing = (allow: Allow, servers: unknown): string[] =>
    missingMcpServers(allow, servers).map((entry) => `${entry.name}@${entry.digest}`);
  assert.deepEqual(missing([], [linear, github, linear]), ["github@d-github-1", "linear@d-linear-1"]);
  assert.deepEqual(missing([github], [github, linear]), ["linear@d-linear-1"]);
  assert.deepEqual(missing([github], [github]), []);
  assert.deepEqual(missing("all", [github]), []);
  assert.deepEqual(missing([], ["", 7, undefined, { name: "x" }, github]), ["github@d-github-1"]);
  assert.deepEqual(missing([], "github"), []);
  // The summary rides along for the dialog; a server sent without one is
  // shown by name rather than dropped.
  assert.deepEqual(missingMcpServers([], [{ name: "bare", digest: "d" }]), [
    { name: "bare", digest: "d", summary: "bare", changed: false },
  ]);

  // A config the worker would refuse is read as allowing nothing, not as an
  // error — this runs in answer to a child message with nobody to catch it.
  // A bare name, from before entries carried a digest, is dropped the way
  // the worker drops it.
  assert.deepEqual(allowedMcp(undefined), []);
  assert.deepEqual(allowedMcp({ mcp: { allow: "some" } }), []);
  assert.deepEqual(
    allowedMcp({ mcp: { allow: ["github", 3, "", { name: "linear", digest: "d" }, { name: "x" }] } }),
    [{ name: "linear", digest: "d" }],
  );
  assert.equal(allowedMcp({ mcp: { allow: "all" } }), "all");

  // The merge itself, without a disk under it.
  assert.deepEqual(mergeMcpAllow(undefined, [{ name: "b", digest: "1" }, { name: "a", digest: "2" }]), {
    mcp: { allow: [{ name: "a", digest: "2" }, { name: "b", digest: "1" }] },
  });
  assert.deepEqual(
    mergeMcpAllow({ mcp: { allow: [{ name: "c", digest: "1" }] } }, [
      { name: "a", digest: "2" },
      { name: "c", digest: "3" },
    ]),
    { mcp: { allow: [{ name: "a", digest: "2" }, { name: "c", digest: "3" }] } },
  );
  assert.deepEqual(mergeMcpAllow({ mcp: { allow: "all" } }, [{ name: "a", digest: "1" }]), {
    mcp: { allow: "all" },
  });
});
