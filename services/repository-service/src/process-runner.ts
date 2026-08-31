import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface ProcessOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
  aborted?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface ProcessOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  /** Kills the child and returns exit code 124 when the deadline expires. */
  timeoutMs?: number;
  /** Retains at most this many bytes from each output stream. */
  maxOutputBytes?: number;
  /**
   * Which end of an over-limit stream survives. `head` (the default) keeps
   * the first `maxOutputBytes` and drops the rest — right for build logs,
   * where the first error is the story. `tail` keeps the last: right for a
   * streamed agent transcript, whose one durable payload — the result
   * envelope — is the final line, and which head retention was guaranteed
   * to discard on exactly the long runs that needed it most. Truncation is
   * still reported either way; only what is kept changes.
   */
  retainOutput?: "head" | "tail";
  /** Terminates the child when the operation is cancelled. */
  signal?: AbortSignal;
  /**
   * Called with decoded stdout text as it arrives, rather than at exit.
   *
   * The buffered {@link ProcessOutput} is the record of what a run produced;
   * this is for deciding something *during* it. A caller watching an agent CLI
   * for context pressure cannot wait for `close`, because by then the run it
   * would have intervened in is over.
   *
   * Observers see every byte the child wrote, including bytes `maxOutputBytes`
   * declines to retain: a monitor that went blind at the retention cap would
   * fail exactly on the long runs it exists to watch. Chunk boundaries carry no
   * meaning — a multi-byte character or a line may be split across two calls,
   * so an observer that needs whole lines must reassemble them itself.
   *
   * Throwing from an observer is contained and ignored. Watching a process must
   * never be able to kill it.
   */
  onStdout?: (chunk: string) => void;
  /** Stderr counterpart to {@link onStdout}, with identical semantics. */
  onStderr?: (chunk: string) => void;
}

/**
 * Variables that must never be inherited by a spawned child.
 *
 * Node's test runner sets `NODE_TEST_CONTEXT` in the processes it starts. A
 * nested `node --test` that sees it reports results over the parent's IPC
 * channel and exits 0 regardless of whether its own tests failed. Since
 * validation commands are frequently `node --test`, inheriting this variable
 * would silently disable the integration gate whenever the coordinator itself
 * runs under a test runner.
 */
const DENIED_CHILD_ENV = ["NODE_TEST_CONTEXT"];

/**
 * Variables a child may inherit from *this* process's own environment.
 *
 * An allow-list rather than a deny-list, because the deny-list was one entry
 * long and everything else came through: a spawned agent CLI, a repository's
 * own test command and a preview server all started from a copy of the
 * control plane's environment, which carries `COORD_CREDENTIAL_KEY` (the key
 * that decrypts every user's stored vendor and GitHub credentials),
 * `COORD_DATABASE_URL` and `COORD_BOOTSTRAP_TOKEN`. Any of those reaching a
 * subprocess turns "code ran here" into "every account's third-party
 * credentials are readable", so the question this answers is not "what is
 * dangerous" — that list is never finished — but "what does a child actually
 * need".
 *
 * What it needs is: how to find an executable, where the user's files are,
 * how to talk to the network through a proxy, and what language and terminal
 * to speak. The vendor variables at the end are the exception that has to be
 * stated: `host-login` is a supported credential policy, and it is precisely
 * "run the agent CLI under the host's own vendor session". A per-user run
 * never sees them anyway — `openCredentialHome` strips every one of them from
 * the base environment before adding the caller's own — so keeping them here
 * costs nothing on the path that matters and keeps single-operator
 * deployments working.
 *
 * Anything a caller puts into `options.env` itself passes through untouched;
 * see {@link sanitizeChildEnv}. This list governs inheritance only.
 */
const ALLOWED_CHILD_ENV: ReadonlySet<string> = new Set([
  // Finding the executable and the user's own files.
  "PATH",
  "Path",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  // Windows counterparts of the same four questions.
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
  "windir",
  "WINDIR",
  "COMSPEC",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  // Somewhere to write scratch files.
  "TMPDIR",
  "TEMP",
  "TMP",
  // Language, time and terminal.
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  // How to reach the network, including the sandbox's own egress proxy.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  // A host vendor login, for the `host-login` credential policy.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "OPENAI_API_KEY",
  "CODEX_HOME",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
]);

/**
 * Families inherited whole.
 *
 * `LC_` and `XDG_` are locale and directory conventions with an open set of
 * names. `GIT_` and `SSH_` are how an operator configures the transport a
 * repository command uses — `GIT_SSH_COMMAND`, `SSH_AUTH_SOCK` — and they are
 * also how this codebase hands a scoped push token to git, so a child that
 * could not see them could not clone.
 */
const ALLOWED_CHILD_ENV_PREFIXES = ["LC_", "XDG_", "GIT_", "SSH_"];

/** Whether a variable of this name may be inherited from `process.env`. */
function inheritableChildEnv(name: string): boolean {
  if (DENIED_CHILD_ENV.includes(name)) {
    return false;
  }
  return (
    ALLOWED_CHILD_ENV.has(name) ||
    ALLOWED_CHILD_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

const WINDOWS_BATCH_FILE = /\.(?:bat|cmd)$/iu;
const UNSAFE_WINDOWS_BATCH_TOKEN = /[\0\r\n"&|<>^%!]/u;

interface ProcessInvocation {
  executable: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/**
 * Kills the wrapper and descendants together on Windows.
 *
 * Batch shims such as `claude.cmd` launch a native child. Killing only
 * `cmd.exe` orphans that child, which keeps inherited stdout/stderr handles
 * open and makes a timed-out coordinator wait indefinitely.
 */
function terminateProcessTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    const systemRoot =
      process.env["SystemRoot"] ?? process.env["SYSTEMROOT"] ?? "C:\\Windows";
    const result = spawnSync(
      path.join(systemRoot, "System32", "taskkill.exe"),
      ["/pid", String(child.pid), "/t", "/f"],
      {
        windowsHide: true,
        stdio: "ignore",
      },
    );
    if (result.error === undefined && result.status === 0) {
      return;
    }
  }
  child.kill("SIGKILL");
}

/**
 * Windows cannot execute `.cmd` or `.bat` files directly. Launch them through
 * `cmd.exe`, but reject expansion and control characters instead of enabling
 * Node's argument-interpolating `shell` option.
 */
/**
 * The extensions Windows itself would try for a name given without one.
 *
 * `PATHEXT` is the operating system's own answer and is respected where it is
 * set; the fallback is the default Windows ships. `.cmd` and `.bat` matter
 * most here — every CLI installed by npm is a `.cmd` shim, which is why a
 * bare name that works in a terminal fails from `spawn`.
 */
function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const configured = Object.entries(env).find(
    ([name]) => name.toUpperCase() === "PATHEXT",
  )?.[1];
  return (configured ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("."));
}

/**
 * What a bare command name means on Windows.
 *
 * A shell resolves `codex` by walking `PATH` and trying every `PATHEXT`
 * suffix; `spawn` does neither, so it looks for a file literally called
 * `codex`, does not find one, and fails with `ENOENT`. Every vendor CLI
 * installed by npm is a `.cmd` shim, so on Windows that is *every* agent —
 * which is how a desktop worker came to report "spawn codex ENOENT", "spawn
 * agent ENOENT" and a claude failure in the same afternoon, and why it looked
 * like three vendors breaking at once rather than one missing lookup.
 *
 * Only names given without an extension are resolved. A caller that named
 * `foo.cmd`, or gave a path, has already said what it means and keeps the
 * behaviour it had.
 */
export function resolveWindowsExecutable(
  executable: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  if (path.extname(executable) !== "") {
    return executable;
  }
  const hasPathSegment =
    path.isAbsolute(executable) ||
    executable.includes("\\") ||
    executable.includes("/");
  if (hasPathSegment) {
    const absolute = path.resolve(cwd ?? process.cwd(), executable);
    for (const extension of windowsExtensions(env)) {
      if (existsSync(absolute + extension)) {
        return absolute + extension;
      }
    }
    return executable;
  }
  const searchPath = Object.entries(env).find(
    ([name]) => name.toUpperCase() === "PATH",
  )?.[1];
  for (const directory of searchPath?.split(path.delimiter) ?? []) {
    const unquoted = directory.replace(/^"(.*)"$/u, "$1");
    for (const extension of windowsExtensions(env)) {
      const candidate = path.resolve(unquoted, executable + extension);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  // Unresolved names are handed back untouched, so the failure stays the
  // operating system's own `ENOENT` on the name the caller asked for rather
  // than becoming an error about a path nobody wrote.
  return executable;
}

function processInvocation(
  executable: string,
  args: readonly string[],
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): ProcessInvocation {
  if (process.platform !== "win32") {
    return { executable, args: [...args] };
  }
  const named = resolveWindowsExecutable(executable, cwd, env);
  if (!WINDOWS_BATCH_FILE.test(named)) {
    return { executable: named, args: [...args] };
  }

  const hasPathSegment =
    path.isAbsolute(named) || named.includes("\\") || named.includes("/");
  let resolvedExecutable = hasPathSegment
    ? path.resolve(cwd ?? process.cwd(), named)
    : named;
  if (!hasPathSegment) {
    const searchPath = Object.entries(env).find(
      ([name]) => name.toUpperCase() === "PATH",
    )?.[1];
    for (const directory of searchPath?.split(path.delimiter) ?? []) {
      const unquoted = directory.replace(/^"(.*)"$/u, "$1");
      const candidate = path.resolve(unquoted, named);
      if (existsSync(candidate)) {
        resolvedExecutable = candidate;
        break;
      }
    }
  }

  const tokens = [resolvedExecutable, ...args];
  for (const token of tokens) {
    if (UNSAFE_WINDOWS_BATCH_TOKEN.test(token)) {
      throw new Error(
        "Windows batch commands cannot contain quotes, expansion characters, " +
          "line breaks, or shell control operators",
      );
    }
  }

  const commandLine = `"${tokens.map((token) => `"${token}"`).join(" ")}"`;
  return {
    executable:
      process.env["ComSpec"] ?? process.env["COMSPEC"] ?? "cmd.exe",
    args: ["/d", "/s", "/v:off", "/c", commandLine],
    windowsVerbatimArguments: true,
  };
}

/**
 * The environment a child may have, built from what it needs rather than from
 * what this process happens to be carrying.
 *
 * Two rules. A variable whose value is the one this process is holding is
 * *inheritance*, and survives only if {@link ALLOWED_CHILD_ENV} names it. A
 * variable the caller put in `env` itself — absent here, or set to something
 * else — is a deliberate per-run addition and always survives: that is how a
 * scoped git token, a per-user `CLAUDE_CONFIG_DIR` or a preview's own `PORT`
 * reaches the child it was assembled for. Composing sanitised environments
 * therefore stays safe, which matters because callers routinely spread one
 * and then add to it.
 */
export function sanitizeChildEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || DENIED_CHILD_ENV.includes(name)) {
      continue;
    }
    if (inheritableChildEnv(name) || process.env[name] !== value) {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

export async function runProcess(
  executable: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessOutput> {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
  ) {
    throw new RangeError("Process timeout must be a positive safe integer");
  }
  if (
    options.maxOutputBytes !== undefined &&
    (!Number.isSafeInteger(options.maxOutputBytes) ||
      options.maxOutputBytes < 1)
  ) {
    throw new RangeError(
      "Process output limit must be a positive safe integer",
    );
  }

  const startedAt = performance.now();
  const childEnv = sanitizeChildEnv(options.env ?? process.env);
  const invocation = processInvocation(
    executable,
    args,
    options.cwd,
    childEnv,
  );

  return await new Promise<ProcessOutput>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let terminationRequested = false;
    const child = spawn(invocation.executable, invocation.args, {
      cwd: options.cwd,
      env: childEnv,
      shell: false,
      windowsVerbatimArguments:
        invocation.windowsVerbatimArguments ?? false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const maxOutputBytes = options.maxOutputBytes;

    const captureHead = (
      target: Buffer[],
      chunk: Buffer,
      currentBytes: number,
    ): { bytes: number; truncated: boolean } => {
      if (maxOutputBytes === undefined) {
        target.push(chunk);
        return { bytes: currentBytes + chunk.length, truncated: false };
      }

      const remaining = Math.max(0, maxOutputBytes - currentBytes);
      if (remaining > 0) {
        target.push(chunk.subarray(0, remaining));
      }
      return {
        bytes: currentBytes + Math.min(chunk.length, remaining),
        truncated: chunk.length > remaining,
      };
    };
    // A rolling window over the end of the stream: old buffers are shed from
    // the front as new ones arrive, so retention is O(cap) memory however
    // much the child writes. Trimming may split a multi-byte character at
    // the window's leading edge; the seam decodes as a replacement character
    // in a line the caller was going to skip anyway.
    const captureTail = (
      target: Buffer[],
      chunk: Buffer,
      currentBytes: number,
    ): { bytes: number; truncated: boolean } => {
      target.push(chunk);
      let bytes = currentBytes + chunk.length;
      if (maxOutputBytes === undefined) {
        return { bytes, truncated: false };
      }
      let truncated = false;
      while (bytes > maxOutputBytes) {
        const first = target[0];
        if (first === undefined) {
          break;
        }
        const excess = bytes - maxOutputBytes;
        if (first.length <= excess) {
          target.shift();
          bytes -= first.length;
        } else {
          target[0] = first.subarray(excess);
          bytes -= excess;
        }
        truncated = true;
      }
      return { bytes, truncated };
    };
    const retainTail = options.retainOutput === "tail";
    const capture = retainTail ? captureTail : captureHead;

    // Decoders are per-stream and stateful: a UTF-8 character split across two
    // reads must not reach an observer as two replacement characters.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const observe = (
      observer: ((chunk: string) => void) | undefined,
      decoder: StringDecoder,
      chunk: Buffer,
    ): void => {
      if (observer === undefined) {
        return;
      }
      const text = decoder.write(chunk);
      if (text.length === 0) {
        return;
      }
      try {
        observer(text);
      } catch {
        // Watching a process must never be able to kill it.
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      observe(options.onStdout, stdoutDecoder, chunk);
      const captured = capture(stdout, chunk, stdoutBytes);
      stdoutBytes = captured.bytes;
      stdoutTruncated ||= captured.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      observe(options.onStderr, stderrDecoder, chunk);
      const captured = capture(stderr, chunk, stderrBytes);
      stderrBytes = captured.bytes;
      stderrTruncated ||= captured.truncated;
    });
    child.stdin.on("error", () => undefined);

    const terminate = () => {
      if (terminationRequested) {
        return;
      }
      terminationRequested = true;
      terminateProcessTree(child);
      // A descendant may have inherited these handles before a wrapper dies.
      // Closing our ends prevents that orphan from holding `close` open after
      // the deadline even when local policy denies process-tree termination.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };

    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminate();
          }, options.timeoutMs);
    timeout?.unref?.();

    const abort = () => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted === true) {
      abort();
    }

    const cleanUp = () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      options.signal?.removeEventListener("abort", abort);
    };

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanUp();
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanUp();

      const truncationMarker = "\n[output truncated]";
      // Tail retention loses the beginning, so its marker leads; head
      // retention loses the end, so its marker trails. Either way the
      // marker sits on the missing side.
      const leadingMarker = "[output truncated]\n";
      const timeoutMarker =
        `\n[process timed out after ${String(options.timeoutMs)} ms]`;
      resolve({
        exitCode: timedOut ? 124 : aborted ? 130 : (exitCode ?? 1),
        stdout:
          (retainTail && stdoutTruncated ? leadingMarker : "") +
          Buffer.concat(stdout).toString("utf8") +
          (!retainTail && stdoutTruncated ? truncationMarker : ""),
        stderr:
          (retainTail && stderrTruncated ? leadingMarker : "") +
          Buffer.concat(stderr).toString("utf8") +
          (!retainTail && stderrTruncated ? truncationMarker : "") +
          (timedOut ? timeoutMarker : "") +
          (aborted ? "\n[process aborted]" : ""),
        durationMs: Math.round(performance.now() - startedAt),
        ...(timedOut ? { timedOut: true } : {}),
        ...(aborted ? { aborted: true } : {}),
        ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
        ...(stderrTruncated ? { stderrTruncated: true } : {}),
      });
    });

    child.stdin.end(options.input);
  });
}
