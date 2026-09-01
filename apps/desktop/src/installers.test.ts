import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/* Imported by URL for the reason `worker-agents.test.ts` is: on Windows an
   absolute path is not a valid import specifier, and this suite runs on the
   Windows runner during a release build. */
const electronDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "electron",
);

interface Plan {
  vendor: string;
  command: string;
  signIn: string;
}

interface InstallersModule {
  installPlan: (vendor: unknown) => Plan | undefined;
  nodeInstallPlan: (
    platform?: string,
  ) => { command: string; args: string[] } | undefined;
  wellKnownBinDirectories: (platform?: string) => string[];
  runnable: (
    command: string,
    args: string[],
    platform?: string,
  ) => { command: string; args: string[] };
  installArgv: (
    vendor: unknown,
    platform: string,
  ) => { command: string; args: string[] } | undefined;
  openSignIn: (vendor: unknown) => boolean;
}

async function load(): Promise<InstallersModule> {
  return (await import(
    pathToFileURL(path.join(electronDir, "installers.mjs")).href
  )) as unknown as InstallersModule;
}

/**
 * The page names a vendor; this module decides what that means.
 *
 * That is the whole security boundary of installing from inside the app. The
 * dashboard is a remote document, so if a command could travel from it to a
 * shell, a compromised or hostile deployment would have arbitrary execution on
 * every machine running Kumi. Nothing here takes a command — only a name, and
 * only names it already knows.
 */
test("only known vendors resolve, and never to caller-supplied commands", async () => {
  const { installPlan, openSignIn } = await load();

  for (const vendor of ["claude", "codex", "cursor"]) {
    const plan = installPlan(vendor);
    assert.equal(plan?.vendor, vendor);
    assert.ok((plan?.command ?? "").length > 0, `${vendor} has no command`);
    assert.ok((plan?.signIn ?? "").length > 0, `${vendor} has no sign-in`);
  }

  // Anything else is nothing at all — not a passthrough, not a default.
  for (const hostile of [
    "gemini",
    "",
    "rm -rf /",
    "codex; calc.exe",
    "../claude",
    "__proto__",
    "constructor",
    undefined,
    null,
    42,
    { vendor: "codex" },
  ]) {
    assert.equal(
      installPlan(hostile),
      undefined,
      `installPlan accepted ${JSON.stringify(hostile)}`,
    );
    assert.equal(
      openSignIn(hostile),
      false,
      `openSignIn accepted ${JSON.stringify(hostile)}`,
    );
  }
});

/**
 * What is shown is what runs.
 *
 * The confirmation exists so somebody can recognise the command and check it
 * against the vendor's docs — two of these pipe a downloaded script into an
 * interpreter, which is a thing to agree to rather than discover. A display
 * string written separately from the invocation would eventually describe
 * something other than what executes, and the dialog would be theatre.
 */
test("the command shown is the vendor's own published one", async () => {
  const { installPlan } = await load();

  assert.match(
    installPlan("codex")?.command ?? "",
    /^npm install -g @openai\/codex$/u,
  );
  assert.match(
    installPlan("claude")?.command ?? "",
    /^npm install -g @anthropic-ai\/claude-code$/u,
  );
  // Cursor's differs by platform, and both forms come from its own docs.
  assert.match(
    installPlan("cursor")?.command ?? "",
    /cursor\.com\/install/u,
  );
  // `agent`, which is what Cursor's installer says to use — not
  // `cursor-agent`, which is a different npm package by a different author.
  assert.equal(installPlan("cursor")?.signIn, "agent");
});

/**
 * The offer has to be built from the table, not from a second list.
 *
 * A vendor named here but absent from the table would be offered and then
 * fail to install; one in the table but missing here could never be offered at
 * all. Both are silent, and the second is how the app came to have an install
 * flow that a person could only reach from a screen they had to go and find.
 */
test("every offerable vendor is one this app can actually install", async () => {
  const module = (await import(
    pathToFileURL(path.join(electronDir, "installers.mjs")).href
  )) as unknown as {
    INSTALLABLE_VENDORS: readonly string[];
    VENDOR_LABELS: Record<string, string>;
    installPlan: (vendor: unknown) => Plan | undefined;
  };

  assert.ok(module.INSTALLABLE_VENDORS.length > 0, "something must be offerable");
  for (const vendor of module.INSTALLABLE_VENDORS) {
    const plan = module.installPlan(vendor);
    assert.ok(plan !== undefined, `${vendor} is offered but has no installer`);
    assert.equal(plan.vendor, vendor);
    // Named for a person, because these go on buttons in a dialog.
    assert.ok(
      (module.VENDOR_LABELS[vendor] ?? "").length > 0,
      `${vendor} is offered with no human label`,
    );
  }
  // Only the three verified vendors. npm carries a package called
  // `cursor-agent` that is somebody else's project entirely, and a wrong
  // command here would have somebody install it, watch Kumi fail, and
  // conclude Kumi was broken.
  assert.deepEqual([...module.INSTALLABLE_VENDORS].sort(), [
    "claude",
    "codex",
    "cursor",
  ]);
});

/**
 * The bug that made this app impossible to set up on Windows.
 *
 * On Windows npm is `npm.cmd`, a batch shim — and since the CVE-2024-27980
 * fix (Node 18.20.2, 20.12.2, 21.7.3 and everything after) `spawn` refuses to
 * execute a `.bat` or `.cmd` unless it is told to use a shell. It does not
 * say so: it fails with `spawn EINVAL`, which reads like a fault in Kumi. The
 * app shipped `spawn("npm.cmd", ...)`, so both npm-based installs — Claude
 * Code and Codex — died on the first Windows machine that tried them, at the
 * exact moment somebody was being onboarded.
 *
 * Asserted per platform rather than per runner, because the alternative is
 * finding out on a release build's Windows job, which is one machine and
 * late.
 */
test("no install hands a batch file to spawn", async () => {
  const { installArgv } = await load();

  for (const vendor of ["claude", "codex", "cursor"]) {
    for (const platform of ["win32", "darwin", "linux"]) {
      const plan = installArgv(vendor, platform);
      assert.ok(plan !== undefined, `${vendor} has no argv on ${platform}`);
      assert.doesNotMatch(
        plan.command.toLowerCase(),
        /\.(?:bat|cmd)$/u,
        `${vendor} on ${platform} spawns a batch file, which is EINVAL`,
      );
    }
  }

  // And what the npm ones run instead: a real program, resolved rather than
  // trusted to PATH, with the batch file as its argument.
  for (const vendor of ["claude", "codex"]) {
    const plan = installArgv(vendor, "win32");
    assert.match(String(plan?.command), /System32.cmd\.exe$/u);
    assert.deepEqual(plan?.args.slice(0, 3), ["/d", "/c", "npm"]);
    // Off Windows it is still plain npm — nothing about this fix reaches the
    // platforms that never had the problem.
    assert.equal(installArgv(vendor, "darwin")?.command, "npm");
  }
});

/**
 * The package names are the vendors' own, and a typo in one is not a typo —
 * npm carries a `cursor-agent` that is somebody else's project entirely, and
 * a person who installed it would see Kumi fail and conclude Kumi was broken.
 */
test("the argv installs the package the plan says it installs", async () => {
  const { installArgv, installPlan } = await load();

  for (const vendor of ["claude", "codex"]) {
    const shown = String(installPlan(vendor)?.command);
    const packageName = shown.split(" ").at(-1);
    for (const platform of ["win32", "linux"]) {
      assert.ok(
        installArgv(vendor, platform)?.args.includes(String(packageName)),
        `${vendor} on ${platform} does not install ${String(packageName)}`,
      );
    }
  }
});

/**
 * "npm is not installed on this machine" was a true sentence and a dead end.
 *
 * Two of the three vendor CLIs are npm packages, so a machine without Node
 * cannot install them — and what the app did about that was hand somebody who
 * came here to connect an agent a second piece of homework, on a different
 * website, with no way back into the flow they were in. It knows the command.
 * It offers to run it.
 */
test("Node itself is something the app can install, on the platforms where that is honest", async () => {
  const { nodeInstallPlan } = await load();

  // Windows through winget — Microsoft's own package manager, shipped with the
  // OS, installing the Node Foundation's own published package. Not a URL this
  // app invented and not a binary it chose.
  const windows = nodeInstallPlan("win32");
  assert.match(String(windows?.command), /System32.cmd\.exe$/u);
  assert.ok(windows?.args.includes("winget"));
  assert.ok(windows?.args.includes("OpenJS.NodeJS.LTS"));
  // Non-interactive, or it waits for a keystroke behind a window with no
  // terminal in it.
  for (const flag of ["--accept-package-agreements", "--accept-source-agreements"]) {
    assert.ok(windows?.args.includes(flag), `winget needs ${flag}`);
  }

  assert.equal(nodeInstallPlan("darwin")?.command, "brew");

  // And Linux is deliberately absent rather than guessed at: the honest answer
  // spans a dozen package managers. The caller says so plainly instead.
  assert.equal(nodeInstallPlan("linux"), undefined);
});

/**
 * A process's environment is fixed when it starts.
 *
 * Installing Node writes its directory into the registry's PATH on Windows;
 * installing a CLI puts it in npm's global bin. Neither reaches a Kumi that
 * was already running — so the app installed something, scanned for it, did
 * not find it, and reported that the machine had no agent. At the one moment
 * in the product where it had just done the thing itself.
 */
test("the standard places Node and npm's globals live are searched too", async () => {
  const { wellKnownBinDirectories } = await load();

  const windows = wellKnownBinDirectories("win32").join("|");
  assert.match(windows, /nodejs/u, "Node's own directory");
  assert.match(windows, /npm/u, "and where npm puts what it installs globally");

  const unix = wellKnownBinDirectories("darwin").join("|");
  assert.match(unix, /homebrew/u);
  assert.match(unix, /usr.local.bin/u);
});

/**
 * The rule that made the installer impossible, applied everywhere it bites.
 *
 * `npm install -g` writes its Windows binaries as `.cmd` shims, so the thing
 * `detectAgents` finds and pins for Codex and Cursor is a batch file — and
 * spawning one is the same `spawn EINVAL` that killed every install. The
 * installer was only the first place this reached. Anything that starts a CLI
 * found on PATH reaches it too, which on Windows is all of them.
 */
test("a detected batch shim is run through an interpreter, everything else untouched", async () => {
  const { runnable } = await load();

  const shim = runnable("C:\\Users\\n\\AppData\\Roaming\\npm\\codex.cmd", ["--status"], "win32");
  assert.match(shim.command, /System32.cmd\.exe$/u);
  assert.deepEqual(shim.args.slice(0, 2), ["/d", "/c"]);
  assert.equal(shim.args.at(-1), "--status");
  assert.ok(
    shim.args.includes("C:\\Users\\n\\AppData\\Roaming\\npm\\codex.cmd"),
    "the shim itself becomes the interpreter's argument",
  );

  // A real program is started directly, on Windows as anywhere else — this
  // must not put an interpreter in front of things that never needed one.
  for (const [command, platform] of [
    ["C:\\Program Files\\nodejs\\claude.exe", "win32"],
    ["/usr/local/bin/codex", "darwin"],
    ["codex", "linux"],
  ] as const) {
    const direct = runnable(command, ["--status"], platform);
    assert.equal(direct.command, command);
    assert.deepEqual(direct.args, ["--status"]);
  }

  // `.bat` is the same rule; case does not save it.
  assert.match(runnable("x\\agent.BAT", [], "win32").command, /cmd\.exe$/u);
});
