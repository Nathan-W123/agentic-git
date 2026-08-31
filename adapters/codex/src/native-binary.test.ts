import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveCodexCommand } from "./index.js";

/**
 * Laid out the way `@openai/codex/bin/codex.js` lays it out.
 *
 * The launcher resolves `@openai/codex-win32-<arch>/package.json`, then runs
 * `vendor/<target triple>/bin/codex.exe` beside it. This builds that, so the
 * test is checking against the vendor's real shape rather than against a
 * shape this repository invented.
 */
async function npmGlobal(
  root: string,
  options: { platformPackage: boolean; nested: boolean },
): Promise<{ shim: string; native: string }> {
  const bin = path.join(root, "npm");
  await mkdir(bin, { recursive: true });
  const shim = path.join(bin, "codex.cmd");
  await writeFile(shim, "@echo off\n");
  // Both extensionless and .cmd, exactly as npm installs them on Windows.
  await writeFile(path.join(bin, "codex"), "#!/bin/sh\n");

  const packageName = options.platformPackage
    ? path.join("@openai", "codex-win32-x64")
    : path.join("@openai", "codex");
  const root_ = options.nested ? path.join(bin, "node_modules") : bin;
  const native = path.join(
    root_,
    packageName,
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin",
    "codex.exe",
  );
  await mkdir(path.dirname(native), { recursive: true });
  await writeFile(native, "");
  return { shim, native };
}

async function withTemp(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-native-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The shim is not a slower path here, it is a closed one.
 *
 * Every Windows Codex invocation carries `-c windows.sandbox="…"`, and
 * `process-runner` refuses to put a double quote on a cmd.exe command line.
 * So a run that resolved to `codex.cmd` fails on the quoting guard even
 * though the CLI is installed and working — which is why finding the native
 * binary is the fix and not an optimisation.
 */
test("codex resolves to the native binary rather than the npm shim", async () => {
  await withTemp(async (dir) => {
    const { shim, native } = await npmGlobal(dir, {
      platformPackage: true,
      nested: true,
    });
    const bin = path.dirname(shim);

    // Found from a bare name, through PATH.
    assert.equal(resolveCodexCommand("codex", "win32", "x64", bin), native);
    // And from the pinned path the desktop writes into its config.
    assert.equal(resolveCodexCommand(shim, "win32", "x64", bin), native);
  });
});

test("codex falls back to the vendor directory inside the main package", async () => {
  await withTemp(async (dir) => {
    const { shim, native } = await npmGlobal(dir, {
      platformPackage: false,
      nested: true,
    });
    assert.equal(
      resolveCodexCommand("codex", "win32", "x64", path.dirname(shim)),
      native,
    );
  });
});

test("a shim inside node_modules/.bin finds its packages one level up", async () => {
  await withTemp(async (dir) => {
    const modules = path.join(dir, "node_modules");
    const bin = path.join(modules, ".bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "codex.cmd"), "@echo off\n");
    const native = path.join(
      modules,
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe",
    );
    await mkdir(path.dirname(native), { recursive: true });
    await writeFile(native, "");
    assert.equal(resolveCodexCommand("codex", "win32", "x64", bin), native);
  });
});

test("codex is left exactly as asked for when there is nothing better", async () => {
  await withTemp(async (dir) => {
    const bin = path.join(dir, "npm");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "codex.cmd"), "@echo off\n");

    // A shim with no native binary beside it: handed back untouched, so the
    // failure stays the one the caller can act on rather than a path nobody
    // wrote. It will fail on the quoting guard, which now says why.
    assert.equal(resolveCodexCommand("codex", "win32", "x64", bin), "codex");
    // Not Windows: none of this applies.
    assert.equal(resolveCodexCommand("codex", "linux", "x64", bin), "codex");
    // An architecture Codex publishes no Windows build for.
    assert.equal(resolveCodexCommand("codex", "win32", "ia32", bin), "codex");
    // Someone else's binary that happens to be configured for this adapter.
    assert.equal(
      resolveCodexCommand("my-codex-wrapper", "win32", "x64", bin),
      "my-codex-wrapper",
    );
    // Already native.
    assert.equal(
      resolveCodexCommand("C:\\tools\\codex.exe", "win32", "x64", bin),
      "C:\\tools\\codex.exe",
    );
  });
});
