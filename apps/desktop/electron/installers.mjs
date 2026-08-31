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

/** Where the interpreter for a shell one-liner lives on this machine. */
function powershell() {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return path.join(
    root,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
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
    argv: () => ({
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["install", "-g", "@anthropic-ai/claude-code"],
    }),
  },
  codex: {
    display: "npm install -g @openai/codex",
    signIn: "codex",
    argv: () => ({
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["install", "-g", "@openai/codex"],
    }),
  },
  cursor: {
    display:
      process.platform === "win32"
        ? "irm 'https://cursor.com/install?win32=true' | iex"
        : "curl https://cursor.com/install -fsS | bash",
    signIn: "agent",
    argv: () =>
      process.platform === "win32"
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
  const { command, args } = installer.argv();
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, detail: describe(error) });
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => onOutput(String(chunk)));
    child.stderr?.on("data", (chunk) => onOutput(String(chunk)));
    child.once("error", (error) => {
      // The usual one is npm missing entirely, which reads as ENOENT on a
      // name the person never typed. Said plainly instead.
      resolve({
        ok: false,
        detail:
          command.startsWith("npm") && /ENOENT/u.test(describe(error))
            ? "npm is not installed on this machine. Install Node.js first, " +
              "then try again."
            : describe(error),
      });
    });
    child.once("close", (code) => {
      resolve(
        code === 0
          ? { ok: true }
          : { ok: false, detail: `The installer exited with code ${String(code)}.` },
      );
    });
  });
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
      const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
      // `start` is a `cmd` builtin rather than a program, so `cmd /c` is what
      // reaches it. `/k` keeps the new window open after the CLI exits, which
      // is where the vendor prints whatever it wants read.
      spawn(
        path.join(root, "System32", "cmd.exe"),
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
