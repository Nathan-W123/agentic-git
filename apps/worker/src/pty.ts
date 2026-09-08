/**
 * A terminal on this machine, for somebody reading Kumi in a browser.
 *
 * Two decisions shape everything here.
 *
 * **It runs on the worker, not on the control plane.** Kumi's execution is
 * local by design — agents run on people's own machines against their own
 * subscriptions, and the control plane never starts one. A shell is the same
 * question with a sharper edge, and the same answer: it runs where the person
 * is. That is also the only way `powershell` and `cmd` can be real choices
 * rather than words in a menu, because the shells on offer are the shells
 * this machine actually has.
 *
 * **It gets a real terminal without a native module.** Node cannot open a
 * pseudo-terminal on its own; `node-pty` is the usual answer and is exactly
 * what this avoids. The desktop app is packaged with no dependencies and so
 * nothing to rebuild — adding a compiled `.node` binary would mean
 * per-platform builds, an ABI that has to match Electron's, and a new way for
 * the installer to fail. Instead something that *can* allocate a PTY does it,
 * and this speaks to it over ordinary pipes. See {@link pty-helper.py}.
 *
 * What that buys, measured rather than assumed (`pty.test.ts`): `isatty` is
 * true, the window size is what was asked for, resize reaches the foreground
 * program, colour comes on, and Ctrl-C arrives as SIGINT — `$?` is 130, which
 * is the difference between a terminal and a pipe stated as a number.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

/** A shell this machine can offer. */
export interface DetectedShell {
  /** Stable identifier the browser sends back to choose this one. */
  id: string;
  /** What a person calls it. */
  label: string;
  /** The executable, resolved. */
  command: string;
  /** Arguments that make it an interactive login-ish shell. */
  args: string[];
}

/**
 * How the terminal was obtained, which decides what works inside it.
 *
 * `python` and `script` are real terminals and differ only in whether a
 * later resize can reach the child. `pipes` is not a terminal at all: the
 * shell runs, ordinary commands work, and everything resting on `isatty`
 * does not. It is the honest floor rather than a pretence.
 */
export type TerminalBackend = "python" | "script" | "pipes";

export interface TerminalOptions {
  shell: DetectedShell;
  cwd: string;
  cols: number;
  rows: number;
  env?: NodeJS.ProcessEnv;
}

export interface TerminalHandle {
  backend: TerminalBackend;
  /**
   * The process holding the terminal, where one started.
   *
   * Exposed so a caller that has to be certain can be: `close()` asks
   * politely and then kills, but a supervisor tearing down — or a test
   * proving that teardown works — needs a handle that does not depend on the
   * thing it is testing.
   */
  pid?: number;
  /** Bytes typed by the reader, written into the terminal verbatim. */
  write(data: string): void;
  /** Tells the terminal its new shape, where the backend can carry one. */
  resize(cols: number, rows: number): void;
  /** Ends the session and everything running in it. */
  close(): void;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (code: number) => void): void;
}

/** Candidate shells per platform, best first. */
const POSIX_SHELLS: readonly Omit<DetectedShell, "command">[] = [
  { id: "zsh", label: "zsh", args: ["-i", "-l"] },
  { id: "bash", label: "bash", args: ["-i", "-l"] },
  { id: "fish", label: "fish", args: ["-i", "-l"] },
  { id: "sh", label: "sh", args: ["-i"] },
];

const WINDOWS_SHELLS: readonly Omit<DetectedShell, "command">[] = [
  { id: "pwsh", label: "PowerShell", args: ["-NoLogo"] },
  { id: "powershell", label: "Windows PowerShell", args: ["-NoLogo"] },
  { id: "cmd", label: "Command Prompt", args: [] },
];

/**
 * Whether a program exists, asked the way a shell asks.
 *
 * `spawnSync` of the lookup rather than reading PATH by hand: PATHEXT on
 * Windows and the difference between a symlink, a shim and a shell function
 * are somebody else's problem already solved.
 */
function resolveProgram(name: string, platform: NodeJS.Platform): string | undefined {
  const lookup = platform === "win32" ? "where" : "which";
  const found = spawnSync(lookup, [name], { encoding: "utf8" });
  if (found.status !== 0) {
    return undefined;
  }
  const first = String(found.stdout ?? "").split("\n")[0]?.trim();
  return first === undefined || first === "" ? undefined : first;
}

/**
 * The shells this machine actually has.
 *
 * Detected rather than assumed, because the alternative is a menu offering
 * `cmd` on a Mac — a choice that can only fail, made to look available.
 */
export function detectShells(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): DetectedShell[] {
  const candidates = platform === "win32" ? WINDOWS_SHELLS : POSIX_SHELLS;
  const found: DetectedShell[] = [];
  for (const candidate of candidates) {
    const command = resolveProgram(candidate.id, platform);
    if (command !== undefined) {
      found.push({ ...candidate, command });
    }
  }
  // Whatever this account's own shell is, first — it is the one with their
  // prompt, their aliases and their PATH, and the one they expect.
  const preferred = platform === "win32" ? undefined : env["SHELL"];
  if (preferred !== undefined && preferred !== "") {
    const name = path.basename(preferred);
    const index = found.findIndex((shell) => shell.id === name);
    if (index > 0) {
      const [own] = found.splice(index, 1);
      if (own !== undefined) {
        found.unshift(own);
      }
    } else if (index === -1 && existsSync(preferred)) {
      // A shell not on the candidate list — nushell, xonsh, something built
      // from source. It is still what this person uses.
      found.unshift({
        id: name,
        label: name,
        command: preferred,
        args: ["-i"],
      });
    }
  }
  return found;
}

/** Where the helper lives, resolved the way the web app resolves `public/`. */
export function helperPath(): string | undefined {
  for (const relative of ["../src/pty-helper.py", "./pty-helper.py"]) {
    const candidate = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Which way this machine can give somebody a terminal.
 *
 * Ordered by what survives inside it, and reported rather than inferred: a
 * reader who cannot run `vim` should be told why, not left to discover it.
 */
export function detectBackend(
  platform: NodeJS.Platform = process.platform,
): TerminalBackend {
  if (platform === "win32") {
    // Windows' equivalent is ConPTY, and reaching it means passing HANDLEs,
    // which is native work. PowerShell and cmd are line-oriented in ordinary
    // use, so this is a smaller loss here than it would be on a Mac.
    return "pipes";
  }
  if (
    helperPath() !== undefined &&
    resolveProgram("python3", platform) !== undefined
  ) {
    return "python";
  }
  if (resolveProgram("script", platform) !== undefined) {
    return "script";
  }
  return "pipes";
}

/** What `script(1)` takes, which differs between util-linux and BSD. */
function scriptInvocation(
  shell: DetectedShell,
  platform: NodeJS.Platform,
): { command: string; args: string[] } {
  const inner = [shell.command, ...shell.args].join(" ");
  return platform === "darwin"
    ? { command: "script", args: ["-q", "/dev/null", shell.command, ...shell.args] }
    : { command: "script", args: ["-qfc", inner, "/dev/null"] };
}

/**
 * Opens a terminal, or the closest thing this machine can manage.
 *
 * The caller is told which it got. Every backend produces the same handle, so
 * nothing above here branches on it except to say so.
 */
export function openTerminal(
  options: TerminalOptions,
  platform: NodeJS.Platform = process.platform,
): TerminalHandle {
  const backend = detectBackend(platform);
  const environment: NodeJS.ProcessEnv = {
    ...options.env,
    TERM: options.env?.["TERM"] ?? "xterm-256color",
    COLUMNS: String(options.cols),
    LINES: String(options.rows),
  };

  let child: ChildProcess;
  if (backend === "python") {
    child = spawn(
      "python3",
      [
        helperPath() ?? "",
        String(options.cols),
        String(options.rows),
        options.shell.command,
        ...options.shell.args,
      ],
      {
        cwd: options.cwd,
        env: environment,
        // fd 3 is the helper's control channel, so a resize never has to be
        // escaped out of the data the reader typed.
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      },
    );
  } else if (backend === "script") {
    const invocation = scriptInvocation(options.shell, platform);
    child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } else {
    child = spawn(options.shell.command, options.shell.args, {
      cwd: options.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  // A terminal emits bytes, and a multi-byte character can straddle two
  // reads. Decoding per chunk would put a replacement character through the
  // middle of anybody's non-ASCII output.
  const decoder = new StringDecoder("utf8");
  const dataListeners: ((chunk: string) => void)[] = [];
  const exitListeners: ((code: number) => void)[] = [];
  const emit = (chunk: Buffer): void => {
    const text = decoder.write(chunk);
    if (text !== "") {
      for (const listener of dataListeners) {
        listener(text);
      }
    }
  };
  child.stdout?.on("data", emit);
  // Under `python` and `script` the child's stderr is the terminal itself, so
  // this carries only the helper's own failures — which are the reader's
  // business, since they explain an empty screen.
  child.stderr?.on("data", emit);
  child.on("exit", (code, signal) => {
    const tail = decoder.end();
    if (tail !== "") {
      for (const listener of dataListeners) {
        listener(tail);
      }
    }
    const status =
      code ?? (signal === undefined || signal === null ? 0 : 128);
    for (const listener of exitListeners) {
      listener(status);
    }
  });

  return {
    backend,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    write(data) {
      child.stdin?.write(data);
    },
    resize(cols, rows) {
      if (backend !== "python") {
        // `script` has no channel for it and pipes have no terminal to
        // resize. Silent rather than thrown: a reader dragging a pane is not
        // asking a question that deserves an error.
        return;
      }
      const control = child.stdio[3];
      if (control !== null && control !== undefined && "write" in control) {
        (control as NodeJS.WritableStream).write(
          `${JSON.stringify({ resize: [cols, rows] })}\n`,
        );
      }
    },
    close() {
      // The helper hangs up on the child when its own stdin closes, which is
      // the ordinary way a terminal ends. The kill is for the case where it
      // does not.
      child.stdin?.end();
      // Asked, then insisted. The helper hangs up on its child when its own
      // stdin closes, which is how a terminal ordinarily ends; the kill is
      // for when it does not, and it has to actually arrive — a session left
      // holding an open pipe keeps this process alive with it.
      const insist = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 1000);
      insist.unref?.();
      child.once("exit", () => {
        clearTimeout(insist);
      });
    },
    onData(listener) {
      dataListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
  };
}
