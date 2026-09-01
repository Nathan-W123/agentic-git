import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  // A URL, not a path. On Windows an absolute path is not a valid import
  // specifier — the ESM loader reads `C:\\...` as a URL whose scheme is `c`,
  // and throws. This suite runs on the Windows runner during a release build,
  // which is the one place these Windows rules can actually be exercised, so
  // it has to load there.
  return (await import(
    pathToFileURL(path.join(electronDir, "agents.mjs")).href
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

/**
 * A machine with no CLI must not be a dead end.
 *
 * The worker refuses to start without one, and correctly — a worker
 * advertising adapters it cannot drive takes work it will then fail. But
 * refusing was the whole of it: the reason went into the application menu, the
 * dashboard said nothing, and an agent connected from such a machine accepted
 * every task and did none of them. Somebody installed the app, connected three
 * agents, and had no way to discover that nothing on the machine could run
 * them.
 *
 * Read as text rather than executed, because both files reach for Electron.
 * The contract is small and worth pinning anyway: the worker names this stop,
 * and the main process acts on that name.
 */
test("no CLI on the machine is a named stop the app offers to fix", async () => {
  const worker = await readFile(path.join(electronDir, "worker.mjs"), "utf8");
  const main = await readFile(path.join(electronDir, "main.mjs"), "utf8");

  // Named, so it can be told apart from a crash, a bad token, or a server that
  // did not answer — none of which installing anything would fix.
  assert.match(worker, /reason: "no-cli"/u);
  assert.match(worker, /No agent CLI found on this machine/u);

  // And acted on, rather than only written into the menu.
  assert.match(main, /event\.reason === "no-cli"/u);
  assert.match(main, /offerToInstallACli/u);
  // Offered from the same table the dashboard installs from, so there is one
  // set of commands rather than a second copy that drifts out of step.
  assert.match(main, /INSTALLABLE_VENDORS/u);
  assert.match(main, /await runInstall\(vendor/u);
  // Once per run: the worker restarts, and every restart on a bare machine
  // would otherwise ask again.
  assert.match(main, /if \(offeredInstall/u);
  // Installing is not the end of it — the vendor's own sign-in still has to
  // happen, and the machine has to start advertising what it just got.
  assert.match(main, /startWorker\(here, session, noteWorkerState\)/u);
  assert.match(main, /openSignIn\(vendor\)/u);
  // A failed install is said out loud rather than swallowed — and said with
  // whatever the installer printed, which is where the reason always is.
  assert.match(main, /Could not install \$\{label\}/u);
  assert.match(main, /runInstall\(vendor, \(chunk\) => conversation\.log\(chunk\)\)/u);
  // In Kumi's own window rather than the operating system's. The native
  // message box was the first thing a new person saw of this product, and it
  // did not look like this product — a white Win32 error box with a red
  // circle in it, asking them to choose a vendor.
  assert.doesNotMatch(main, /dialog\.showMessageBox/u);
  assert.match(main, /openDialog\(\{/u);
  // And it is one window for the whole exchange: the offer becomes the run
  // becomes the result, instead of a modal each and nothing in between.
  assert.match(main, /conversation\.update\(\{[\s\S]*?kind: "progress"/u);
});

/**
 * One preload, three globals, and no shared fate between them.
 *
 * A preload is a single script: an exception part-way through stops everything
 * after it, silently, and the page comes up with whichever globals were
 * exposed before the throw. The token is fetched with a synchronous IPC call,
 * so the value most likely to fail sat between the other two — and when it
 * did, the page kept `KUMI_SERVER` and lost `KUMI_INSTALL`, which looks exactly
 * like an app too old to have the bridge. Every agent connected from such a
 * window looks connected and can run nothing.
 */
test("each preload global is exposed independently of the others", async () => {
  const preload = await readFile(path.join(electronDir, "preload.cjs"), "utf8");

  // Every exposure goes through the guard, so none can be fatal to the rest.
  assert.equal(
    (preload.match(/^expose\(/gmu) ?? []).length,
    3,
    "all three globals must be exposed through the guard",
  );
  assert.doesNotMatch(
    preload,
    /^contextBridge\.exposeInMainWorld/mu,
    "a bare exposure is one that can take the others down with it",
  );
  // The one that can genuinely fail, and the one whose loss is invisible.
  assert.match(preload, /expose\("KUMI_TOKEN", \(\) => ipcRenderer\.sendSync/u);
  assert.match(preload, /expose\("KUMI_INSTALL", \(\) => \(\{/u);
  // A failure is said somewhere a person can find it, not swallowed.
  assert.match(preload, /could not expose \$\{name\}/u);
});

/**
 * Everything main.mjs calls from a sibling module has to be imported from it.
 *
 * `detectAgents` was not. It was called by the handler the dashboard asks
 * "what is installed here", and by the menu that reports the same, and was
 * never brought into the module — so both threw ReferenceError on every call,
 * on every launch, from the day the handler was written.
 *
 * Nothing said so, because the renderer catches that rejection and treats it
 * as "no answer". The setup that answer gates — the CLI check, the install
 * offer, the sign-in — was skipped in silence, so agents connected, looked
 * connected, and could run nothing. It took reading a live main process to
 * see it.
 *
 * Checked generically rather than by name: the same mistake in any other
 * sibling call would be just as quiet.
 */
test("main.mjs imports every sibling function it calls", async () => {
  const main = await readFile(path.join(electronDir, "main.mjs"), "utf8");
  const siblings = [
    "agents.mjs",
    "dialog.mjs",
    "installers.mjs",
    "worker.mjs",
    "usage.mjs",
  ];

  // What each sibling offers.
  const exported = new Map<string, string>();
  for (const file of siblings) {
    const source = await readFile(path.join(electronDir, file), "utf8");
    for (const m of source.matchAll(
      /^export (?:async )?function ([A-Za-z_$][\w$]*)/gmu,
    )) {
      exported.set(String(m[1]), file);
    }
  }
  assert.ok(exported.size > 5, "the siblings should export a good few things");

  // What main.mjs has actually imported, from anywhere.
  const imported = new Set<string>();
  for (const m of main.matchAll(/import \{([^}]*)\} from/gu)) {
    for (const name of String(m[1]).split(",")) {
      const clean = name.trim().split(/\s+as\s+/u)[0]?.trim();
      if (clean) imported.add(clean);
    }
  }

  // Anything it calls that a sibling exports must be one of those.
  const missing: string[] = [];
  for (const [name, file] of exported) {
    const called = new RegExp(`(?<![\\w$.])${name}\\s*\\(`, "u").test(main);
    if (called && !imported.has(name)) {
      missing.push(`${name} (exported by ${file})`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `main.mjs calls these without importing them: ${missing.join(", ")}`,
  );
});

interface UsageModule {
  readVendorUsage: (vendor: string) => Promise<{
    ok: boolean;
    raw?: string;
    exitCode?: number;
    detail?: string;
  }>;
}

/**
 * A directory of fake CLIs, put on `PATH` for the duration of one test.
 *
 * Written the way each platform actually installs one, because that is the
 * whole thing under test. On POSIX a vendor CLI is an executable script with a
 * shebang. On Windows it is a `.cmd` shim beside a `.js` — which is exactly
 * what npm writes for a global install, and exactly the shape `spawn` refuses
 * to execute without a shell. A harness that wrote shebang scripts on Windows
 * would fail with `spawn ENOENT` for a reason no real machine has, and would
 * say nothing about the reason a real machine fails.
 */
async function withFakeClis(
  files: Record<string, string>,
  run: (usage: UsageModule) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kumi-usage-"));
  const previous = process.env["PATH"];
  try {
    for (const [name, body] of Object.entries(files)) {
      if (process.platform === "win32") {
        // The shim npm writes, and the script it points at. `detectAgents`
        // looks for `<name>.cmd` before the extensionless file, so this is
        // also what it will find.
        await writeFile(path.join(dir, `${name}.js`), body, "utf8");
        await writeFile(
          path.join(dir, `${name}.cmd`),
          `@echo off
node "%~dp0${name}.js" %*
`,
          "utf8",
        );
        continue;
      }
      const file = path.join(dir, name);
      await writeFile(file, body, { mode: 0o755 });
    }
    process.env["PATH"] = onlyTheFakes(dir);
    const usage = (await import(
      pathToFileURL(path.join(electronDir, "usage.mjs")).href
    )) as UsageModule;
    await run(usage);
  } finally {
    if (previous === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A `PATH` holding the fakes, node, and the operating system — and nothing
 * else.
 *
 * The "nothing else" is the point: a real vendor CLI installed on the machine
 * running this suite must never be the thing these tests spawn. But the first
 * cut took that literally and dropped `System32` along with it, which is where
 * `taskkill.exe` lives — so on Windows the one tool that ends a process tree
 * could not be found, the fakes below were never killed, and the pipes they
 * had inherited held the test process open. `node --test` waits on a child
 * that will not exit, with no deadline of its own, so the Windows release job
 * sat on a four-second step until somebody cancelled it.
 *
 * Removing a vendor's directory is the requirement. Removing the platform's
 * own was a mistake that the platform then charged twenty-five minutes for.
 */
function onlyTheFakes(dir: string): string {
  const parts = [dir, path.dirname(process.execPath)];
  if (process.platform === "win32") {
    const root = process.env["SystemRoot"] ?? "C:\\Windows";
    parts.push(path.join(root, "System32"), root);
  }
  return parts.join(path.delimiter);
}

/**
 * A CLI too old for the documented interface must fall through to the older
 * one, not win the attempt by complaining.
 *
 * Codex is asked for its quota twice: `account/rateLimits/read` on the
 * app-server, which is the interface OpenAI documents, and `--status --json`
 * for a CLI that predates it. The first cut merged the two output streams, so
 * `error: unrecognized subcommand 'app-server'` counted as an answer — the
 * fallback was never reached, and the card then blamed an API-key account for
 * a CLI that had simply never been asked the question it understands.
 *
 * The exit code cannot settle it either: Claude exits non-zero merely for
 * being signed out, while printing the status it was asked for. Which stream
 * carried the words is what decides.
 */
test("a complaint on stderr is not an answer, so the older reader is reached", async () => {
  await withFakeClis(
    {
      codex: [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'app-server') {",
        "  process.stderr.write(\"error: unrecognized subcommand 'app-server'\\n\");",
        "  process.exit(2);",
        "}",
        "process.stdout.write(JSON.stringify({ rate_limits: { primary: { used_percent: 55 } } }));",
      ].join("\n"),
    },
    async (usage) => {
      const reading = await usage.readVendorUsage("codex");
      assert.equal(reading.ok, true, JSON.stringify(reading));
      assert.match(String(reading.raw), /used_percent/u);
      assert.doesNotMatch(String(reading.raw), /unrecognized subcommand/u);
    },
  );
});

/**
 * And the app-server reader has to stop when it has answered.
 *
 * It does not exit on its own — it waits for the next request — so an attempt
 * that only ends on `close` spends its whole deadline after the answer is
 * already in hand, and on a machine whose CLI predates the method the
 * fallback is not reached until that deadline passes. Reading the card is not
 * worth an eight-second stall, still less two.
 */
test("the app-server reader returns as soon as it has the answer", async () => {
  await withFakeClis(
    {
      codex: [
        "#!/usr/bin/env node",
        "let seen = '';",
        "process.stdin.on('data', (chunk) => {",
        "  seen += chunk;",
        "  if (!seen.includes('account/rateLimits/read')) return;",
        "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1,",
        "    result: { rateLimits: { primary: { usedPercent: 41, windowDurationMins: 300 } } } }) + '\\n');",
        // Exactly what the real app-server does: waits for more work.
        "  setInterval(() => {}, 1000);",
        "});",
      ].join("\n"),
    },
    async (usage) => {
      const started = Date.now();
      const reading = await usage.readVendorUsage("codex");
      assert.equal(reading.ok, true, JSON.stringify(reading));
      assert.match(String(reading.raw), /usedPercent/u);
      assert.ok(
        Date.now() - started < 5_000,
        "it must not sit out the deadline after answering",
      );
    },
  );
});

/**
 * Claude is asked in the format that publishes the windows, and let go the
 * moment it has.
 *
 * `claude -p "/usage"` sends the slash command as a prompt — the interactive
 * usage view is never opened — so the reply is a session summary with no
 * percentage in it, which is why the card had been empty since agents moved
 * off the control plane. `--output-format stream-json` is what carries the
 * numbers: a `rate_limit_event` whose `unifiedWindows` holds the five-hour
 * and seven-day figures. Killing the run there is not just tidiness — it ends
 * the turn the question started, so asking costs less than it did before.
 */
test("the claude reader asks in stream-json and stops at the rate limit event", async () => {
  await withFakeClis(
    {
      claude: [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (!args.includes('stream-json')) {",
        "  process.stdout.write(JSON.stringify({ result: 'Total cost: $0.01' }));",
        "  return;",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'rate_limit_event',",
        "  rate_limit_info: { unifiedWindows: { five_hour: { utilization: 36 },",
        "    seven_day: { utilization: 71 } } } }) + '\\n');",
        // The real CLI carries on with the turn it started; this must not.
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    },
    async (usage) => {
      const started = Date.now();
      const reading = await usage.readVendorUsage("claude");
      assert.equal(reading.ok, true, JSON.stringify(reading));
      assert.match(String(reading.raw), /rate_limit_event/u);
      assert.match(String(reading.raw), /seven_day/u);
      assert.ok(
        Date.now() - started < 10_000,
        "it must not sit out the deadline once the windows have arrived",
      );
    },
  );
});

/**
 * A CLI that is not here has not reported anything, and saying so is the
 * whole answer. Reporting an empty reading would file "nothing to show" as
 * this account's usage until something replaced it.
 */
test("an absent CLI reports nothing rather than an empty reading", async () => {
  await withFakeClis({}, async (usage) => {
    const reading = await usage.readVendorUsage("codex");
    assert.equal(reading.ok, false);
    assert.match(String(reading.detail), /not installed on this machine/u);

    // And a vendor with no usage command at all is a different sentence.
    const none = await usage.readVendorUsage("gemini");
    assert.equal(none.ok, false);
    assert.match(String(none.detail), /publishes no usage command/u);
  });
});
