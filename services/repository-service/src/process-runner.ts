import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

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
  /** Terminates the child when the operation is cancelled. */
  signal?: AbortSignal;
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
function processInvocation(
  executable: string,
  args: readonly string[],
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): ProcessInvocation {
  if (process.platform !== "win32" || !WINDOWS_BATCH_FILE.test(executable)) {
    return { executable, args: [...args] };
  }

  const hasPathSegment =
    path.isAbsolute(executable) ||
    executable.includes("\\") ||
    executable.includes("/");
  let resolvedExecutable = hasPathSegment
    ? path.resolve(cwd ?? process.cwd(), executable)
    : executable;
  if (!hasPathSegment) {
    const searchPath = Object.entries(env).find(
      ([name]) => name.toUpperCase() === "PATH",
    )?.[1];
    for (const directory of searchPath?.split(path.delimiter) ?? []) {
      const unquoted = directory.replace(/^"(.*)"$/u, "$1");
      const candidate = path.resolve(unquoted, executable);
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

/** Strips harness variables that would change how a child interprets itself. */
export function sanitizeChildEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...env };
  for (const name of DENIED_CHILD_ENV) {
    delete sanitized[name];
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

    const capture = (
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

    child.stdout.on("data", (chunk: Buffer) => {
      const captured = capture(stdout, chunk, stdoutBytes);
      stdoutBytes = captured.bytes;
      stdoutTruncated ||= captured.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
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
      const timeoutMarker =
        `\n[process timed out after ${String(options.timeoutMs)} ms]`;
      resolve({
        exitCode: timedOut ? 124 : aborted ? 130 : (exitCode ?? 1),
        stdout:
          Buffer.concat(stdout).toString("utf8") +
          (stdoutTruncated ? truncationMarker : ""),
        stderr:
          Buffer.concat(stderr).toString("utf8") +
          (stderrTruncated ? truncationMarker : "") +
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
