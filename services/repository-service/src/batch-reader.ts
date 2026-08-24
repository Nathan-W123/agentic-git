/**
 * One long-lived `git cat-file` for a whole pass over a revision.
 *
 * Reading a repository a file at a time costs one process launch per file,
 * and a launch is not cheap: profiling an index build over 435 sources put
 * ~1.8s of self time inside Node's `spawn` — more than any other single
 * thing the build did, parsing included. `git cat-file --batch` answers any
 * number of requests over one pair of pipes, so the per-file cost becomes a
 * write and a read.
 *
 * Requests are NUL-delimited (`-z`) rather than newline-delimited. A path is
 * allowed to contain a newline and is never allowed to contain a NUL — the
 * shared `normalizeRepositoryPath` rejects those outright — so NUL is the
 * only framing that cannot be forged by a file name.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

interface Waiter {
  resolve: (value: Buffer | undefined) => void;
  reject: (error: Error) => void;
}

/** What `cat-file` is part way through handing back. */
interface Expected {
  size: number;
  blob: boolean;
}

export class GitBatchReader {
  // stderr is `ignore`d, so the process type carries `null` for it.
  private readonly child: ChildProcessByStdio<Writable, Readable, null>;
  private readonly waiting: Waiter[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  private expected: Expected | undefined;
  private failure: Error | undefined;

  public constructor(
    gitDirectory: string,
    private readonly revision: string,
  ) {
    this.child = spawn(
      "git",
      [`--git-dir=${gitDirectory}`, "cat-file", "--batch", "-z"],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.absorb(chunk);
    });
    this.child.on("error", (error: Error) => {
      this.fail(error);
    });
    // Only a failure while requests are outstanding; a reader closed after its
    // last answer has nobody left to tell, which `fail` handles by finding the
    // queue empty.
    this.child.on("close", () => {
      this.fail(new Error("git cat-file exited while reads were outstanding"));
    });
  }

  /**
   * The blobs at these paths, in the order asked for.
   *
   * `undefined` where the path is absent at this revision or is not a blob —
   * a directory answers as a tree, and a caller asking for a file's contents
   * wants nothing rather than a listing.
   */
  public async read(
    paths: readonly string[],
  ): Promise<(Buffer | undefined)[]> {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    const answers = paths.map(
      async () =>
        await new Promise<Buffer | undefined>((resolve, reject) => {
          this.waiting.push({ resolve, reject });
        }),
    );
    for (const repositoryPath of paths) {
      this.child.stdin.write(`${this.revision}:${repositoryPath}\0`);
    }
    return await Promise.all(answers);
  }

  public async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.child.once("close", () => {
        resolve();
      });
      this.child.stdin.end();
    });
  }

  private absorb(chunk: Buffer): void {
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.expected === undefined) {
        const newline = this.buffer.indexOf(0x0a);
        if (newline === -1) {
          return;
        }
        const header = this.buffer.subarray(0, newline).toString("utf8");
        this.buffer = this.buffer.subarray(newline + 1);
        // `<request> missing` for anything this revision does not have. The
        // request is echoed back, so the line cannot be parsed as a triple.
        if (header.endsWith(" missing")) {
          this.deliver(undefined);
          continue;
        }
        const [, type = "", rawSize = ""] = header.split(" ");
        const size = Number(rawSize);
        if (!Number.isSafeInteger(size) || size < 0) {
          this.fail(
            new Error(`Unparsable git cat-file header: ${JSON.stringify(header)}`),
          );
          return;
        }
        this.expected = { size, blob: type === "blob" };
      }
      // Contents, then the newline `cat-file` writes after them.
      const needed = this.expected.size + 1;
      if (this.buffer.length < needed) {
        return;
      }
      const body = this.buffer.subarray(0, this.expected.size);
      const blob = this.expected.blob;
      // Copied out: `subarray` shares memory with the buffer this loop is
      // about to keep slicing, and the caller is handed the contents to keep.
      const answer = blob ? Buffer.from(body) : undefined;
      this.buffer = this.buffer.subarray(needed);
      this.expected = undefined;
      this.deliver(answer);
    }
  }

  private deliver(value: Buffer | undefined): void {
    this.waiting.shift()?.resolve(value);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    while (this.waiting.length > 0) {
      this.waiting.shift()?.reject(error);
    }
  }
}
