import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveCursorLauncher } from "./index.js";

/**
 * Cursor's real install, as found on the machine this was written for.
 *
 * `agent.cmd` runs PowerShell, which runs `cursor-agent.ps1`, which picks the
 * newest directory under `versions\` and runs that copy's own `node.exe`
 * against its `index.js`. There is no native CLI binary anywhere in it — so
 * the trick that fixed Claude and Codex does not apply, and the first shim in
 * the chain is a batch file that cannot carry a quoted argument.
 */
async function install(
  root: string,
  versions: readonly string[],
): Promise<string> {
  const home = path.join(root, "cursor-agent");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "agent.cmd"), "@echo off\n");
  for (const version of versions) {
    const directory = path.join(home, "versions", version);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "node.exe"), "");
    await writeFile(path.join(directory, "index.js"), "");
  }
  return path.join(home, "agent.cmd");
}

async function withTemp(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cursor-launcher-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("cursor is launched through its newest version's own interpreter", async () => {
  await withTemp(async (dir) => {
    // Deliberately unordered, and mixing both naming forms the launcher
    // accepts — the newest by date wins, not the newest by directory listing.
    const shim = await install(dir, [
      "2026.8.25-3e8eec8",
      "2026.9.2-11-30-05-aa11bb2",
      "2026.7.1-cafe123",
    ]);
    const resolved = resolveCursorLauncher(shim, "win32");
    const expected = path.join(
      path.dirname(shim),
      "versions",
      "2026.9.2-11-30-05-aa11bb2",
    );
    assert.equal(resolved?.executable, path.join(expected, "node.exe"));
    assert.deepEqual(resolved?.args, [path.join(expected, "index.js")]);
  });
});

test("an interpreter beside the shim is preferred, as the launcher does", async () => {
  await withTemp(async (dir) => {
    const shim = await install(dir, ["2026.8.25-3e8eec8"]);
    const home = path.dirname(shim);
    await writeFile(path.join(home, "node.exe"), "");
    await writeFile(path.join(home, "index.js"), "");
    const resolved = resolveCursorLauncher(shim, "win32");
    assert.equal(resolved?.executable, path.join(home, "node.exe"));
  });
});

test("anything it cannot resolve is left to the caller", async () => {
  await withTemp(async (dir) => {
    const shim = await install(dir, ["2026.8.25-3e8eec8"]);

    // Not Windows: none of this applies.
    assert.equal(resolveCursorLauncher(shim, "linux"), undefined);
    // A bare name has no install directory to read.
    assert.equal(resolveCursorLauncher("agent", "win32"), undefined);
    // Someone else's binary configured for this adapter.
    assert.equal(
      resolveCursorLauncher(path.join(dir, "my-agent.exe"), "win32"),
      undefined,
    );
    // A version directory with no interpreter in it is skipped rather than
    // returned half-formed.
    const empty = await install(path.join(dir, "other"), []);
    await mkdir(path.join(path.dirname(empty), "versions", "2026.8.25-abc123"), {
      recursive: true,
    });
    assert.equal(resolveCursorLauncher(empty, "win32"), undefined);
  });
});
