import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runProcess, sanitizeChildEnv } from "./process-runner.js";

test("the test-runner context is stripped from child environments", () => {
  const sanitized = sanitizeChildEnv({
    NODE_TEST_CONTEXT: "child-v8",
    PATH: "/usr/bin",
  });
  assert.equal(sanitized["NODE_TEST_CONTEXT"], undefined);
  assert.equal(sanitized["PATH"], "/usr/bin");
});

test("sanitizing does not mutate the source environment", () => {
  const source = { NODE_TEST_CONTEXT: "child-v8" };
  sanitizeChildEnv(source);
  assert.equal(source.NODE_TEST_CONTEXT, "child-v8");
});

test("a spawned child never sees NODE_TEST_CONTEXT", async () => {
  // This file runs under `node --test`, so the variable is set right now.
  assert.equal(process.env["NODE_TEST_CONTEXT"], "child-v8");

  const result = await runProcess(process.execPath, [
    "-e",
    "process.stdout.write(String(process.env.NODE_TEST_CONTEXT))",
  ]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "undefined");
});

test(
  "Windows batch shims run with argument boundaries preserved",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "coord batch test-"));
    try {
      const shim = path.join(root, "echo arguments.cmd");
      await writeFile(
        shim,
        '@echo off\r\n<nul set /p "=%~1|%~2"\r\nexit /b 0\r\n',
        "utf8",
      );

      const result = await runProcess(shim, ["alpha", "two words"]);

      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, "alpha|two words");
      await assert.rejects(
        runProcess(shim, ["safe&whoami", "ignored"]),
        /cannot contain quotes.*shell control operators/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

/**
 * The regression this guards: a nested `node --test` that inherits
 * NODE_TEST_CONTEXT reports through the parent's IPC channel and exits 0 even
 * when its own tests fail, which would silently disable the integration
 * validation gate whenever the coordinator runs under a test runner.
 */
test("a failing nested node --test still reports a non-zero exit code", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-nested-test-"));
  try {
    await mkdir(path.join(root, "test"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify({ name: "nested", private: true, type: "module" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(root, "test", "failing.test.js"),
      [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        "",
        'test("fails on purpose", () => {',
        "  assert.equal(1, 2);",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runProcess(process.execPath, ["--test"], { cwd: root });
    assert.notEqual(result.exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a process that exceeds its deadline is terminated", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "setInterval(() => undefined, 1000)"],
    { timeoutMs: 50 },
  );

  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /timed out/u);
});

test(
  "a Windows batch timeout cannot be held open by a native child",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "coord-tree-kill-"));
    try {
      const shim = path.join(root, "launch-child.cmd");
      const script = path.join(root, "child.mjs");
      const pidFile = path.join(root, "child.pid");
      await writeFile(
        shim,
        '@echo off\r\n"%~1" "%~2" "%~3"\r\n',
        "utf8",
      );
      await writeFile(
        script,
        [
          'import { writeFileSync } from "node:fs";',
          "writeFileSync(process.argv[2], String(process.pid));",
          // Never exits on its own. If the wrapper's descendant survived and
          // kept the inherited stdio handles open, `close` would never fire
          // and this test would hang rather than merely run slowly.
          "setInterval(() => undefined, 1000);",
        ].join("\n"),
        "utf8",
      );

      const result = await runProcess(
        shim,
        [process.execPath, script, pidFile],
        { timeoutMs: 500 },
      );
      const childPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);

      assert.equal(result.exitCode, 124);
      assert.equal(result.timedOut, true);
      // Deliberately not a tight wall-clock bound. Terminating the tree costs
      // a synchronous taskkill.exe launch, which is roughly a second on some
      // Windows hosts; that is teardown cost, not a missed deadline. The
      // claim under test is that the call returns at all and leaves nothing
      // behind, which the immortal child and the ESRCH check below establish.
      assert.ok(
        result.durationMs < 30_000,
        `timeout took ${result.durationMs} ms`,
      );
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        try {
          process.kill(childPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch {
          break;
        }
      }
      assert.throws(
        () => process.kill(childPid, 0),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ESRCH",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("captured output is bounded", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(1000)); process.stderr.write('y'.repeat(1000))"],
    { maxOutputBytes: 64 },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
  assert.ok(result.stdout.length < 100);
  assert.ok(result.stderr.length < 100);
});

test("tail retention keeps the end of the stream, where the payload lives", async () => {
  // The shape of a streamed agent transcript: megabytes of events, and the
  // one line that matters written last. Head retention was guaranteed to
  // discard it on exactly the runs that most needed to finish.
  const result = await runProcess(
    process.execPath,
    [
      "-e",
      "process.stdout.write('noise\\n'.repeat(500));" +
        "process.stdout.write('THE RESULT LINE\\n')",
    ],
    { maxOutputBytes: 256, retainOutput: "tail" },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutTruncated, true);
  assert.ok(result.stdout.includes("THE RESULT LINE"));
  // The marker sits on the missing side — the beginning.
  assert.match(result.stdout, /^\[output truncated\]\n/u);
  assert.ok(result.stdout.length < 400, String(result.stdout.length));
});

test("tail retention under the limit is a plain, unmarked capture", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('small\\n')"],
    { maxOutputBytes: 1024, retainOutput: "tail" },
  );
  assert.equal(result.stdout, "small\n");
  assert.equal(result.stdoutTruncated, undefined);
});

test("an abort signal terminates the child", async () => {
  const controller = new AbortController();
  const running = runProcess(
    process.execPath,
    ["-e", "setInterval(() => undefined, 1000)"],
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 100).unref();

  const result = await running;
  assert.equal(result.exitCode, 130);
  assert.equal(result.aborted, true);
  assert.match(result.stderr, /\[process aborted\]/u);
});

test("invalid resource limits fail before spawning", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["--version"], { timeoutMs: 0 }),
    RangeError,
  );
  await assert.rejects(
    runProcess(process.execPath, ["--version"], { maxOutputBytes: -1 }),
    RangeError,
  );
});

test("stdout is observable while the child is still running", async () => {
  // The point of the callback: a decision that must be made during a run
  // cannot wait for the buffered result.
  const seen: string[] = [];
  let settled = false;
  let firstArrivedWhileRunning: boolean | undefined;

  const running = runProcess(
    process.execPath,
    [
      "-e",
      "process.stdout.write('first');" +
        "setTimeout(() => process.stdout.write('second'), 150);" +
        "setTimeout(() => process.exit(0), 300);",
    ],
    {
      onStdout: (chunk) => {
        firstArrivedWhileRunning ??= !settled;
        seen.push(chunk);
      },
    },
  );
  void running.then(() => {
    settled = true;
  });
  const result = await running;

  assert.equal(result.exitCode, 0);
  assert.equal(firstArrivedWhileRunning, true);
  // Two deliveries 150 ms apart, so the first was seen well before exit
  // rather than flushed alongside it.
  assert.ok(seen.length >= 2, `expected separate deliveries, got ${seen.length}`);
  assert.equal(seen.join(""), "firstsecond");
  // The buffered transcript is unchanged by observation.
  assert.equal(result.stdout, "firstsecond");
});

test("stderr has its own observer", async () => {
  const out: string[] = [];
  const err: string[] = [];
  await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('o');process.stderr.write('e')"],
    { onStdout: (chunk) => out.push(chunk), onStderr: (chunk) => err.push(chunk) },
  );
  assert.equal(out.join(""), "o");
  assert.equal(err.join(""), "e");
});

test("a multi-byte character split across reads is not corrupted", async () => {
  // Writing a byte at a time forces the split that a naive per-chunk toString
  // would turn into replacement characters.
  const observed: string[] = [];
  const result = await runProcess(
    process.execPath,
    [
      "-e",
      "const b=Buffer.from('héllo→世界','utf8');" +
        "let i=0;" +
        "const t=setInterval(()=>{" +
        "if(i>=b.length){clearInterval(t);process.exit(0);}" +
        "process.stdout.write(b.subarray(i,i+1));i+=1;},1);",
    ],
    { onStdout: (chunk) => observed.push(chunk) },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(observed.join(""), "héllo→世界");
  assert.ok(!observed.join("").includes("\uFFFD"));
});

test("an observer that throws cannot kill the run", async () => {
  // Watching a process must never be able to fail it.
  const result = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('still fine')"],
    {
      onStdout: () => {
        throw new Error("observer exploded");
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "still fine");
});

test("observers see output the retention cap declines to keep", async () => {
  // A monitor that went blind at the cap would fail on exactly the long runs
  // it exists to watch.
  let observedBytes = 0;
  const result = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(5000))"],
    {
      maxOutputBytes: 100,
      onStdout: (chunk) => {
        observedBytes += chunk.length;
      },
    },
  );

  assert.equal(observedBytes, 5000);
  assert.equal(result.stdoutTruncated, true);
  assert.ok(result.stdout.length < 5000);
});
