import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireControlPlaneLock } from "./control-plane-lock.js";

async function withDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coord-lock-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("only one control plane can own a project directory", async () => {
  await withDirectory(async (directory) => {
    const first = await acquireControlPlaneLock(directory);
    await assert.rejects(
      acquireControlPlaneLock(directory),
      new RegExp(`already running.*PID ${process.pid}`, "su"),
    );
    await first.release();

    const replacement = await acquireControlPlaneLock(directory);
    await replacement.release();
  });
});

test("a dead control-plane owner's lock is recovered", async () => {
  await withDirectory(async (directory) => {
    await writeFile(
      path.join(directory, "control-plane.lock"),
      JSON.stringify({
        instanceId: "stale",
        pid: 2_147_483_647,
        startedAt: "2020-01-01T00:00:00.000Z",
      }),
      "utf8",
    );

    const lock = await acquireControlPlaneLock(directory);
    await lock.release();
  });
});
