import { spawn } from "node:child_process";

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

  return await new Promise<ProcessOutput>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: sanitizeChildEnv(options.env ?? process.env),
      shell: false,
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

    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);
    timeout?.unref?.();

    const abort = () => {
      aborted = true;
      child.kill("SIGKILL");
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
