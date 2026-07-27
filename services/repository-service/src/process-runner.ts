import { spawn } from "node:child_process";

export interface ProcessOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ProcessOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
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
  const startedAt = performance.now();

  return await new Promise<ProcessOutput>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: sanitizeChildEnv(options.env ?? process.env),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Math.round(performance.now() - startedAt),
      });
    });

    child.stdin.end(options.input);
  });
}

