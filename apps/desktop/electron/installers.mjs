/**
 * Installing a vendor CLI, and getting signed into it, from inside the app.
 *
 * Local execution means the vendor's own CLI has to be present on this machine
 * and signed in before an agent can do anything. Until this existed the product
 * never said so: an agent with no CLI looked exactly like one that worked — it
 * took the mention, said it had started, and the task waited forever. The
 * remedy was a package name and a login the person had no way to learn from
 * inside Kumi.
 *
 * ### Why the commands live here and not in the page
 *
 * The dashboard is a *remote* document. It asks for a vendor by name and this
 * module decides what that means; a command string never travels from the page
 * to a shell. That is the whole security boundary, and it is why the plan the
 * page displays is read back from here rather than assembled there — what is
 * shown and what runs cannot drift, because they are the same value.
 *
 * ### Why a shell at all
 *
 * Two of these are the vendors' own published one-liners and pipe a downloaded
 * script into an interpreter. That is what the vendor documents and what a
 * person would otherwise paste by hand, so it is what runs — but only from the
 * fixed strings below, never from anything a caller supplies.
 */

import { spawn } from "node:child_process";
import path from "node:path";

/** Where Windows keeps the interpreters, resolved rather than trusted to PATH. */
function windowsSystem32(...parts) {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return path.join(root, "System32", ...parts);
}

/** Where the interpreter for a shell one-liner lives on this machine. */
function powershell() {
  return windowsSystem32("WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * `npm install -g <package>`, run in a way Windows will actually start.
 *
 * On Windows npm is not a program. It is `npm.cmd`, a batch shim — and since
 * the CVE-2024-27980 fix (Node 18.20.2, 20.12.2, 21.7.3, and everything
 * since) `child_process.spawn` refuses to execute a `.bat` or `.cmd` at all
 * unless it is told to go through a shell. It does not fail with a message
 * about batch files; it fails with `spawn EINVAL`, which reads like a bug in
 * this app rather than a rule about the platform. Electron 38 carries Node
 * 22, so every Windows install this app offered — Claude Code and Codex both
 * — died there, on the first machine that ever tried it.
 *
 * The remedy is to stop handing a batch file to `spawn` and start a real
 * program that knows how to run one. `cmd.exe` is that program, and it is
 * resolved from `SystemRoot` for the same reason `powershell.exe` is: a
 * machine whose PATH is broken is exactly the machine somebody is trying to
 * set up. `/d` skips any AutoRun command the registry has, so the install
 * runs in a shell nobody else has furnished.
 *
 * `shell: true` would also work and is one word shorter. It is not used
 * because it would build the command line by string concatenation out of
 * values this module owns today and might not tomorrow — and this is the one
 * module a remote document chooses an input for.
 */
function npmInstall(packageName, platform) {
  return platform === "win32"
    ? {
        command: windowsSystem32("cmd.exe"),
        args: ["/d", "/c", "npm", "install", "-g", packageName],
      }
    : { command: "npm", args: ["install", "-g", packageName] };
}

/**
 * Where a fresh Node lands, and where npm puts what it installs globally.
 *
 * Needed twice, for the same reason both times: a program's environment is
 * fixed when it starts. Installing Node writes its directory into the
 * *registry's* PATH on Windows, and into a shell profile everywhere else —
 * neither of which reaches a Kumi that was already running. So a person who
 * installs Node and comes back to the app is told, correctly and uselessly,
 * that npm is still not there; and a person who installs a CLI is told the
 * machine still has no CLI. Both were "restart Kumi", which is a fine
 * instruction and a terrible first five minutes.
 *
 * These are the standard locations, added to what PATH already says rather
 * than replacing it. A directory that does not exist costs a failed lookup.
 */
export function wellKnownBinDirectories(platform = process.platform) {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const localAppData =
      process.env.LOCALAPPDATA ?? (home === "" ? "" : path.join(home, "AppData", "Local"));
    const appData =
      process.env.APPDATA ?? (home === "" ? "" : path.join(home, "AppData", "Roaming"));
    return [
      path.join(programFiles, "nodejs"),
      ...(localAppData === "" ? [] : [path.join(localAppData, "Programs", "nodejs")]),
      // Where npm's own `-g` bin goes on Windows, which is where the vendor
      // CLIs land — so this is the one that decides whether an install this
      // app just ran is visible to it.
      ...(appData === "" ? [] : [path.join(appData, "npm")]),
    ];
  }
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(home === "" ? [] : [path.join(home, ".npm-global", "bin"), path.join(home, ".local", "bin")]),
  ];
}

/** This process's PATH with those directories appended. */
export function pathWithWellKnown(platform = process.platform) {
  const current = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extra = wellKnownBinDirectories(platform).filter(
    (dir) => !current.includes(dir),
  );
  return [...current, ...extra].join(path.delimiter);
}

/**
 * How to install Node itself, which is the dependency under two of the three.
 *
 * Offered rather than merely reported. "npm is not installed on this machine,
 * install Node.js first" is a true sentence and a dead end: it hands somebody
 * who came here to connect an agent a second piece of homework, on a different
 * website, in the middle of setting up something else. The app knows what to
 * run, so it offers to run it.
 *
 * Windows goes through `winget`, which ships with Windows 11 and with any
 * Windows 10 carrying App Installer. It is Microsoft's own package manager and
 * `OpenJS.NodeJS.LTS` is the Node Foundation's own published package, so this
 * is neither a URL this app invented nor a binary it chose. A machine without
 * winget says so in its own words and the offer becomes the sentence it was
 * before.
 *
 * macOS goes through Homebrew when Homebrew is there, and does not pretend
 * otherwise when it is not: the alternative is a `.pkg` that needs an
 * administrator, and asking for a password on somebody's behalf is further
 * than an app should reach. Linux is deliberately absent — the honest answer
 * spans a dozen package managers, and the desktop app's platform is Windows.
 */
const NODE_INSTALLERS = {
  win32: {
    display: "winget install OpenJS.NodeJS.LTS",
    argv: () => ({
      command: windowsSystem32("cmd.exe"),
      args: [
        "/d",
        "/c",
        "winget",
        "install",
        "--id",
        "OpenJS.NodeJS.LTS",
        "--exact",
        // The community source, explicitly: the Store carries packages by the
        // same name and this is the one the Node Foundation publishes.
        "--source",
        "winget",
        // Without these it waits for a keystroke nobody can see, behind a
        // window with no terminal in it.
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity",
      ],
    }),
  },
  darwin: {
    display: "brew install node",
    argv: () => ({ command: "brew", args: ["install", "node"] }),
  },
};

/** What installing Node would run here, or nothing if this app cannot. */
export function nodeInstallPlan(platform = process.platform) {
  const installer = Object.hasOwn(NODE_INSTALLERS, platform)
    ? NODE_INSTALLERS[platform]
    : undefined;
  return installer === undefined
    ? undefined
    : { command: installer.display, ...installer.argv() };
}

/**
 * What each vendor publishes as its install command, and what to run to sign
 * in afterwards.
 *
 * Only commands verified against the vendor's own documentation are here. A
 * wrong one is worse than none: npm carries a package called `cursor-agent`
 * that is somebody else's project entirely, and a person who installed it
 * would see Kumi fail and conclude Kumi was broken. A vendor without a
 * verified command simply is not in this table, and the page falls back to
 * showing its documentation link.
 *
 * `display` is what the person is shown before they agree to it, written the
 * way its vendor writes it rather than as this module's argv — the point of
 * showing it is that they can recognise it, and check it against the docs if
 * they want to.
 */
const INSTALLERS = {
  claude: {
    display: "npm install -g @anthropic-ai/claude-code",
    signIn: "claude",
    argv: (platform) => npmInstall("@anthropic-ai/claude-code", platform),
  },
  codex: {
    display: "npm install -g @openai/codex",
    signIn: "codex",
    argv: (platform) => npmInstall("@openai/codex", platform),
  },
  cursor: {
    display:
      process.platform === "win32"
        ? "irm 'https://cursor.com/install?win32=true' | iex"
        : "curl https://cursor.com/install -fsS | bash",
    signIn: "agent",
    argv: (platform) =>
      platform === "win32"
        ? {
            command: powershell(),
            args: [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              "irm 'https://cursor.com/install?win32=true' | iex",
            ],
          }
        : {
            command: "/bin/sh",
            args: ["-c", "curl https://cursor.com/install -fsS | bash"],
          },
  },
};

/**
 * The vendors this app can install, in the order worth offering them.
 *
 * Derived from the table rather than written twice: a vendor without a
 * verified command must not be offered, and the surest way to keep that true
 * is to have one list. Claude first because its installer is the plainest
 * `npm install` of the three, so it is the likeliest to succeed on a machine
 * nobody has set up yet.
 */
export const INSTALLABLE_VENDORS = ["claude", "codex", "cursor"].filter(
  (vendor) => Object.hasOwn(INSTALLERS, vendor),
);

/** What each vendor is called when a person is asked about it. */
export const VENDOR_LABELS = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

/**
 * The entry for a vendor name, and only ever a real entry.
 *
 * `INSTALLERS[name]` is not enough: `"__proto__"` resolves through the
 * prototype chain to an object, which is truthy, so a lookup that merely
 * checked for undefined handed back a plan with no command in it. Harmless
 * here by luck rather than design — and this is the one lookup in the app that
 * a remote document chooses the key for, so it is the last place to rely on
 * luck. `Object.hasOwn` asks the question actually meant.
 */
function installerFor(vendor) {
  return typeof vendor === "string" && Object.hasOwn(INSTALLERS, vendor)
    ? INSTALLERS[vendor]
    : undefined;
}

/**
 * What this machine would run for a vendor, or nothing if it has no verified
 * command. Read by the page so the confirmation shows the real thing.
 */
export function installPlan(vendor) {
  const installer = installerFor(vendor);
  return installer === undefined
    ? undefined
    : { vendor, command: installer.display, signIn: installer.signIn };
}

/**
 * Exactly what would be spawned for a vendor on a given platform.
 *
 * Takes the platform rather than reading it, so the Windows branch can be
 * exercised from a suite that is not running on Windows — the same shape
 * `CodexAdapter` uses for the same reason. It is a release build's Windows
 * runner that would otherwise be the only place this was ever checked, and
 * that is one machine, late.
 *
 * Exported for tests. Nothing in the app calls it: `runInstall` reads the
 * table directly, because a second caller is a second chance for the argv the
 * person agreed to and the argv that runs to be different things.
 */
export function installArgv(vendor, platform = process.platform) {
  return installerFor(vendor)?.argv(platform);
}

/**
 * Runs a vendor's install, reporting its output as it arrives.
 *
 * The output is relayed rather than summarised: these commands fail for
 * ordinary, legible reasons — no npm on the machine, a proxy in the way, a
 * policy blocking the script — and the vendor's own message says which. A
 * spinner that ends in "failed" would put the person back where they started.
 */
export async function runInstall(vendor, onOutput) {
  const installer = installerFor(vendor);
  if (installer === undefined) {
    return {
      ok: false,
      detail: `No install is published here for ${String(vendor)}.`,
    };
  }
  // Whether this vendor's install needs Node on the machine, which decides
  // what "it did not start" means. Read off the published command rather than
  // off the argv, because the argv is now an interpreter on Windows and the
  // interpreter is always there.
  return await run(installer.argv(process.platform), onOutput, {
    needsNpm: installer.display.startsWith("npm "),
  });
}

/**
 * Installs Node itself, so "npm is not installed" stops being the end of it.
 *
 * Separate from {@link runInstall} rather than another row in the vendor
 * table, because it is not a vendor: nobody signs into it, nothing runs
 * agents with it, and it is offered only in answer to a specific failure of
 * something else.
 */
export async function runNodeInstall(onOutput) {
  const plan = nodeInstallPlan();
  if (plan === undefined) {
    return {
      ok: false,
      detail:
        `Kumi cannot install Node.js on ${process.platform} for you. ` +
        "Install it from nodejs.org and try again — no restart needed.",
    };
  }
  return await run(plan, onOutput, { needsNpm: false });
}

/**
 * Runs one install, relaying what it says and keeping the last of it.
 *
 * The PATH it runs under is this process's plus the standard places Node and
 * npm's global bin live. That is what lets an install work in the session
 * that installed Node a minute earlier: this app's environment was fixed when
 * it launched, and nothing a Windows installer writes to the registry reaches
 * a process that is already running.
 */
async function run({ command, args }, onOutput, { needsNpm }) {
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: pathWithWellKnown() },
      });
    } catch (error) {
      resolve({ ok: false, detail: describe(error) });
      return;
    }
    // Kept as well as relayed. The exit code alone was the whole of what a
    // failure used to say, and "exited with code 1" is not something anybody
    // can act on — the reason was in the output, being streamed past.
    let tail = "";
    const heard = (chunk) => {
      const text = String(chunk);
      tail = `${tail}${text}`.slice(-OUTPUT_TAIL);
      onOutput(text);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", heard);
    child.stderr?.on("data", heard);
    // Named rather than described, so the caller can offer the remedy instead
    // of printing the diagnosis. `reason` is the whole of what main.mjs reads;
    // `detail` is for the person.
    const failed = (text, fallback) => {
      const noNode = missingNode(needsNpm, text);
      return noNode === undefined
        ? { ok: false, detail: lastLines(text) ?? fallback }
        : { ok: false, reason: "no-node", detail: noNode };
    };
    child.once("error", (error) => {
      const said = describe(error);
      resolve(failed(said, said));
    });
    child.once("close", (code) => {
      resolve(
        code === 0
          ? { ok: true }
          : // Through an interpreter, a missing npm is not an `error` event at
            // all: the interpreter starts perfectly well and then reports that
            // it could not find the command. So the same reading has to be
            // reachable from the output as well as from the errno.
            failed(tail, `The installer exited with code ${String(code)}.`),
      );
    });
  });
}

/** The most recent output worth quoting back; an installer says a lot. */
const OUTPUT_TAIL = 8_000;

/**
 * The one failure worth naming rather than quoting: no Node on the machine.
 *
 * Recognised from either half of the evidence — the errno when nothing
 * started, or the interpreter's own complaint when it did — because which one
 * arrives depends on the platform rather than on what went wrong. Returns
 * nothing for every other failure, which is then handed back as the vendor
 * wrote it: these commands fail for ordinary, legible reasons and the
 * vendor's own message says which.
 */
function missingNode(needsNpm, text) {
  return needsNpm &&
    /ENOENT|is not recognized as an internal or external command|command not found/iu.test(
      text,
    )
    ? "npm is not installed on this machine — the vendor CLIs are npm " +
      "packages, so Node.js has to be here first."
    : undefined;
}

/** The last few lines that said something, for a failure with no name. */
function lastLines(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length === 0 ? undefined : lines.slice(-4).join("\n");
}

/**
 * Opens a terminal already running the vendor's CLI, so its sign-in starts.
 *
 * This is the one step that cannot be done for somebody. Every vendor's login
 * is an interactive flow it owns — a browser round trip, a code to paste — and
 * the most the app can do is put them in front of it with nothing left to
 * type. A detached console, because the sign-in outlives this call and must
 * not die with the window that started it.
 */
export function openSignIn(vendor) {
  const installer = installerFor(vendor);
  if (installer === undefined) {
    return false;
  }
  const { signIn } = installer;
  try {
    if (process.platform === "win32") {
      // `start` is a `cmd` builtin rather than a program, so `cmd /c` is what
      // reaches it. `/k` keeps the new window open after the CLI exits, which
      // is where the vendor prints whatever it wants read.
      spawn(
        windowsSystem32("cmd.exe"),
        ["/c", "start", "", "cmd", "/k", signIn],
        { detached: true, stdio: "ignore", windowsHide: false },
      ).unref();
      return true;
    }
    if (process.platform === "darwin") {
      spawn("open", ["-a", "Terminal", "/bin/sh"], {
        detached: true,
        stdio: "ignore",
      }).unref();
      return true;
    }
    // Linux has no single terminal to ask for. `x-terminal-emulator` is the
    // Debian alternative most desktops register; anything else is the
    // person's own shell, and saying so beats guessing at six of them.
    spawn("x-terminal-emulator", ["-e", signIn], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return true;
  } catch {
    return false;
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
