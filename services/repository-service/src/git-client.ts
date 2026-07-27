import { runProcess, type ProcessOptions, type ProcessOutput } from "./process-runner.js";

export class GitCommandError extends Error {
  public readonly result: ProcessOutput;
  public readonly args: readonly string[];

  public constructor(args: readonly string[], result: ProcessOutput) {
    const detail = result.stderr.trim() || result.stdout.trim() || "unknown error";
    super(`git ${args.join(" ")} failed: ${detail}`);
    this.name = "GitCommandError";
    this.args = args;
    this.result = result;
  }
}

export interface GitRunOptions extends ProcessOptions {
  allowFailure?: boolean;
}

export class GitClient {
  public async run(
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<ProcessOutput> {
    const result = await runProcess("git", args, options);
    if (result.exitCode !== 0 && options.allowFailure !== true) {
      throw new GitCommandError(args, result);
    }
    return result;
  }
}

