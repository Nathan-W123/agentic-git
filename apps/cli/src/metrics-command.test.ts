import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/**
 * `coord metrics` prints its groups by hand, so a new group on
 * `CoordinationMetrics` is silent until this command learns about it — which
 * is exactly how the sharing group was computed and then dropped on the floor
 * for as long as it existed. Warm starts is a group people will look for the
 * first time somebody asks whether the pool is doing anything, so it is
 * pinned here in both shapes.
 */

const cli = path.join(import.meta.dirname, "index.js");

async function coord(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile(process.execPath, [cli, ...args], { cwd });
  return stdout;
}

test("coord metrics reports warm starts as text and as JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-metrics-cli-"));
  try {
    await coord(root, "init");

    const parsed = JSON.parse(await coord(root, "metrics", "--json")) as {
      warmStarts?: Record<string, number>;
    };
    assert.deepEqual(parsed.warmStarts, {
      workspaceWarm: 0,
      workspaceCold: 0,
      workspaceResumed: 0,
      indexWarm: 0,
      indexCold: 0,
    });

    const text = await coord(root, "metrics");
    assert.match(text, /Warm starts \(per task start\)/u);
    assert.match(text, /Workspace warm:/u);
    assert.match(text, /Index cold:/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
