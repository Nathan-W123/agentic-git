import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
