import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Coordinator } from "@coord/coordinator";
import { RepositoryService } from "@coord/repository-service";
import { assertAgentPlan, type AgentPlan } from "@coord/shared-types";
import { GitWorktreeWorkspaceManager } from "@coord/workspace-manager";

import { ScriptedAgentAdapter } from "./scripted-agent.js";

/**
 * Asking the agent that just did the work to redo only what collided.
 *
 * The behaviour this replaces is the expensive one: end the session, and let
 * a fresh agent rediscover the whole task from nothing — sixteen to
 * twenty-six times a run in the A/B series, at roughly 145k tokens each. The
 * session is still open when integration answers, and after salvage the
 * collision is usually a couple of lines.
 *
 * The collision here is real rather than simulated: while the agent is
 * "working", a separate commit is genuinely promoted to canonical over the
 * same line, exactly as another actor would.
 */

const WIDE = Array.from(
  { length: 30 },
  (_, index) => `line ${String(index + 1)}`,
).join("\n") + "\n";

async function fixture(root: string) {
  const sourcePath = path.join(root, "source");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await writeFile(path.join(sourcePath, "src", "shared.txt"), WIDE, "utf8");
  await writeFile(path.join(sourcePath, "src", "own.txt"), "own\n", "utf8");
  await repositories.commitAll(sourcePath, "seed");
  const repository = await repositories.importLocalRepository(
    sourcePath,
    path.join(root, "canonical.git"),
    "fixture",
  );
  return {
    repositories,
    repository,
    workspaces: new GitWorktreeWorkspaceManager(repositories.getGitClient()),
  };
}

/** Promotes a commit to canonical from outside the coordinator's view. */
async function landExternalChange(
  context: Awaited<ReturnType<typeof fixture>>,
  root: string,
  line: string,
) {
  const version = await context.repositories.getCanonicalVersion(
    context.repository,
  );
  const workspace = await context.workspaces.create({
    taskId: "external",
    rootPath: path.join(root, "external"),
    repository: context.repository,
    baseVersion: version,
  });
  const lines = WIDE.split("\n");
  lines[0] = line;
  await writeFile(
    path.join(workspace.path, "src", "shared.txt"),
    lines.join("\n"),
    "utf8",
  );
  const revision = await context.repositories.commitAll(
    workspace.path,
    "external change",
  );
  assert.ok(revision !== undefined);
  assert.equal(
    await context.repositories.promote(
      context.repository,
      revision,
      version.revision,
    ),
    true,
  );
  await context.workspaces.destroy(workspace);
}

function plan(taskId: string): AgentPlan {
  const value = {
    taskId,
    objective: "edit the shared and own files",
    expectedFiles: ["src/shared.txt", "src/own.txt"],
    expectedSymbols: [],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
    intent: "edit the shared and own files",
  };
  assertAgentPlan(value);
  return value;
}

test("a collision is repaired by the agent that hit it, not by a fresh replan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-repair-"));
  try {
    const context = await fixture(root);
    let repairCalls = 0;
    let repairedFiles: string[] = [];

    const agent = new ScriptedAgentAdapter({
      agentId: "scripted",
      repository: context.repository,
      workspaces: context.workspaces,
      behavior: {
        plan: plan("task_repair"),
        execute: async (workspacePath) => {
          // Somebody else takes the same line while this agent is working.
          await landExternalChange(context, root, "line 1 THEIRS");
          const target = path.join(workspacePath, "src", "shared.txt");
          const lines = (await readFile(target, "utf8")).split("\n");
          lines[0] = "line 1 MINE";
          await writeFile(target, lines.join("\n"), "utf8");
          await writeFile(
            path.join(workspacePath, "src", "own.txt"),
            "own edited\n",
            "utf8",
          );
        },
        repair: async (workspacePath, files) => {
          repairCalls += 1;
          repairedFiles = [...files];
          // What a real agent does: the file now holds the other change, so
          // the intent is re-applied on top of it rather than over it.
          const target = path.join(workspacePath, "src", "shared.txt");
          const lines = (await readFile(target, "utf8")).split("\n");
          assert.equal(lines[0], "line 1 THEIRS", "not reset to canonical");
          lines[0] = "line 1 THEIRS and MINE";
          await writeFile(target, lines.join("\n"), "utf8");
        },
      },
    });

    const result = await new Coordinator({
      repositories: context.repositories,
      workspaces: context.workspaces,
    }).run({
      repository: context.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        {
          task: {
            id: "task_repair",
            objective: "edit the shared and own files",
            agentId: "scripted",
            validationCommands: [],
          },
          adapter: agent,
        },
      ],
    });

    // The agent was asked to reconcile exactly the contested file, and only
    // that one — its other edit had already landed.
    assert.equal(repairCalls, 1);
    assert.deepEqual(repairedFiles, ["src/shared.txt"]);
    assert.equal(result.tasks[0]?.status, "integrated", result.tasks[0]?.explanation);

    const head = await context.repositories.getCanonicalVersion(
      context.repository,
    );
    const shared = await context.repositories.readFile(
      context.repository,
      head.revision,
      "src/shared.txt",
    );
    // Both intents survive: the repair reconciled rather than overwrote.
    assert.match(shared, /^line 1 THEIRS and MINE\n/u);
    assert.equal(
      await context.repositories.readFile(
        context.repository,
        head.revision,
        "src/own.txt",
      ),
      "own edited\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an agent that cannot repair keeps whatever already landed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-repair-"));
  try {
    const context = await fixture(root);
    const agent = new ScriptedAgentAdapter({
      agentId: "scripted",
      repository: context.repository,
      workspaces: context.workspaces,
      behavior: {
        plan: plan("task_norepair"),
        execute: async (workspacePath) => {
          await landExternalChange(context, root, "line 1 THEIRS");
          const target = path.join(workspacePath, "src", "shared.txt");
          const lines = (await readFile(target, "utf8")).split("\n");
          lines[0] = "line 1 MINE";
          await writeFile(target, lines.join("\n"), "utf8");
          await writeFile(
            path.join(workspacePath, "src", "own.txt"),
            "own edited\n",
            "utf8",
          );
        },
        // No repair behaviour: the scripted agent throws when asked.
      },
    });

    const result = await new Coordinator({
      repositories: context.repositories,
      workspaces: context.workspaces,
    }).run({
      repository: context.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        {
          task: {
            id: "task_norepair",
            objective: "edit the shared and own files",
            agentId: "scripted",
            validationCommands: [],
          },
          adapter: agent,
        },
      ],
    });

    // A repair that cannot even be attempted must not cost the work salvage
    // already promoted.
    const head = await context.repositories.getCanonicalVersion(
      context.repository,
    );
    assert.equal(
      await context.repositories.readFile(
        context.repository,
        head.revision,
        "src/own.txt",
      ),
      "own edited\n",
    );
    assert.match(
      await context.repositories.readFile(
        context.repository,
        head.revision,
        "src/shared.txt",
      ),
      /^line 1 THEIRS\n/u,
    );
    assert.equal(result.tasks.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("with repair switched off, a collision costs the whole result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-repair-"));
  try {
    const context = await fixture(root);
    let repairCalls = 0;
    const agent = new ScriptedAgentAdapter({
      agentId: "scripted",
      repository: context.repository,
      workspaces: context.workspaces,
      behavior: {
        plan: plan("task_off"),
        execute: async (workspacePath) => {
          await landExternalChange(context, root, "line 1 THEIRS");
          const target = path.join(workspacePath, "src", "shared.txt");
          const lines = (await readFile(target, "utf8")).split("\n");
          lines[0] = "line 1 MINE";
          await writeFile(target, lines.join("\n"), "utf8");
          await writeFile(
            path.join(workspacePath, "src", "own.txt"),
            "own edited\n",
            "utf8",
          );
        },
        repair: async () => {
          repairCalls += 1;
        },
      },
    });

    const result = await new Coordinator({
      repositories: context.repositories,
      workspaces: context.workspaces,
      repairConflicts: false,
    }).run({
      repository: context.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        {
          task: {
            id: "task_off",
            objective: "edit the shared and own files",
            agentId: "scripted",
            validationCommands: [],
          },
          adapter: agent,
        },
      ],
    });

    // The old behaviour, kept reachable: no repair, and the conflict takes
    // the whole changeset with it.
    assert.equal(repairCalls, 0);
    assert.equal(result.tasks[0]?.status, "failed");
    const head = await context.repositories.getCanonicalVersion(
      context.repository,
    );
    assert.equal(
      await context.repositories.readFile(
        context.repository,
        head.revision,
        "src/own.txt",
      ),
      "own\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
