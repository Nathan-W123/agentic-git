import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoordinatorProject } from "@coord/cli/project";

import { Worker } from "./worker.js";

/** Records what registration was asked to advertise, and nothing else. */
function recordingClient(): {
  adapters: string[] | undefined;
  register: (input: { adapters: readonly string[] }) => Promise<{ id: string }>;
} {
  const seen: { adapters: string[] | undefined } = { adapters: undefined };
  return {
    get adapters() {
      return seen.adapters;
    },
    register: async (input) => {
      seen.adapters = [...input.adapters];
      return { id: "worker-1" };
    },
  };
}

/**
 * A project whose config names one vendor.
 *
 * `CoordinatorProject.open` then backfills a default agent for every *other*
 * vendor it knows, which is the behaviour under test: it is right for a
 * deployment, and wrong for a laptop.
 */
async function projectWithCodexOnly(dir: string): Promise<CoordinatorProject> {
  await mkdir(path.join(dir, ".coordinator"), { recursive: true });
  await writeFile(
    path.join(dir, ".coordinator", "config.json"),
    JSON.stringify({
      version: 1,
      validationCommands: [],
      agents: { codex: { adapter: "codex", command: "C:\\npm\\codex.cmd" } },
    }),
    "utf8",
  );
  return await CoordinatorProject.open(dir);
}

async function withTemp(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "register-adapters-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function worker(
  project: CoordinatorProject,
  client: ReturnType<typeof recordingClient>,
  adapters?: readonly string[],
): Worker {
  return new Worker({
    client: client as never,
    project,
    organizationId: "org",
    workspaceRoot: path.join(project.directory, "worker"),
    ...(adapters === undefined ? {} : { adapters }),
  });
}

/**
 * The config is not a description of the machine.
 *
 * Backfill adds a default agent for every vendor the config lacks, on purpose,
 * so a deployment older than a vendor still answers for it. On a desktop that
 * makes the worker advertise Cursor and Kiro on a machine that has neither —
 * it is then offered their work, and can only fail it. That is the
 * "spawn <vendor> ENOENT" a desktop kept reporting for agents nobody had
 * installed.
 */
test("a host that knows what it has registers only that", async () => {
  await withTemp(async (dir) => {
    const project = await projectWithCodexOnly(dir);

    // The premise: backfill has already put the other vendors in.
    const backfilled = new Set(
      Object.values(project.config.agents).map((agent) => agent.adapter),
    );
    assert.ok(backfilled.has("cursor"), "backfill should have added cursor");
    assert.ok(backfilled.has("claude"), "backfill should have added claude");

    const declared = recordingClient();
    await worker(project, declared, ["codex"]).register();
    assert.deepEqual(declared.adapters, ["codex"]);
  });
});

test("a host that says nothing is taken at its config's word", async () => {
  await withTemp(async (dir) => {
    const project = await projectWithCodexOnly(dir);
    const silent = recordingClient();
    await worker(project, silent).register();

    // Unchanged for a server deployment, which is the config *and* the
    // machine, and has nothing more truthful to add.
    assert.ok((silent.adapters ?? []).includes("codex"));
    assert.ok((silent.adapters ?? []).includes("cursor"));
  });
});

test("declaring an adapter the config has no agent for advertises nothing extra", async () => {
  await withTemp(async (dir) => {
    const project = await projectWithCodexOnly(dir);
    const client = recordingClient();
    // The machine has Gemini installed; this project has no Gemini agent and
    // backfill does not add one. Registration is the intersection, so the
    // worker does not claim to run an agent that is not configured.
    await worker(project, client, ["codex", "gemini"]).register();
    assert.deepEqual(client.adapters, ["codex"]);
  });
});
