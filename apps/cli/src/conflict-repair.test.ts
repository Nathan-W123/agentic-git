import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  Coordinator,
  type SalvagedConflictRequest,
} from "@coord/coordinator";
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

test("a remainder the repair could not land becomes work of its own", async () => {
  // The hole this closes. Salvage promotes what still applies and hands back
  // what collided, which is safe precisely because the agent is still open
  // and is asked to redo the remainder. When that repair cannot be attempted
  // — the case directly above — the first result stands: status `integrated`,
  // carrying a remainder that nothing downstream read. The task reported
  // success, and the file it planned and could not land was written by
  // nobody. The remote worker path has queued this since salvage was built;
  // the in-process path, which is every dispatch a channel makes, never did.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-repair-"));
  try {
    const context = await fixture(root);
    const collide = async (workspacePath: string) => {
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
    };

    const deferred: SalvagedConflictRequest[] = [];
    const result = await new Coordinator({
      repositories: context.repositories,
      workspaces: context.workspaces,
      planAuthority: {
        async admit(request) {
          return { outcome: "admitted", plan: request.plan };
        },
        async deferSalvagedConflict(request) {
          deferred.push(request);
          return "task_followup";
        },
      },
    }).run({
      repository: context.repository,
      workspaceRoot: path.join(root, "workspaces"),
      integrationRoot: path.join(root, "integration"),
      tasks: [
        {
          task: {
            id: "task_deferred",
            objective: "edit the shared and own files",
            agentId: "scripted",
            validationCommands: [],
          },
          adapter: new ScriptedAgentAdapter({
            agentId: "scripted",
            repository: context.repository,
            workspaces: context.workspaces,
            // No repair behaviour: the scripted agent throws when asked, which
            // is what leaves the remainder outstanding.
            behavior: { plan: plan("task_deferred"), execute: collide },
          }),
        },
      ],
    });

    // Still integrated — the promoted half is in canonical and failing the
    // task would send a replan back over work that already landed.
    assert.equal(result.tasks[0]?.status, "integrated");
    // And the half that did not land is queued rather than dropped.
    assert.equal(deferred.length, 1);
    assert.deepEqual(
      [...new Set(deferred[0]?.deferred.map((patch) => patch.path) ?? [])],
      ["src/shared.txt"],
      "only the contested file, not the one that promoted",
    );
    assert.equal(deferred[0]?.task.id, "task_deferred");
    assert.equal(deferred[0]?.repository.id, context.repository.id);

    // The withholding is on the run's audit log too, against the follow-up
    // that will carry it, with the patches kept as context.
    const withheld = result.audit.filter(
      (entry) => entry.type === "changeset_withheld",
    );
    assert.equal(withheld.length, 1);
    assert.equal(withheld[0]?.taskId, "task_followup");
    assert.equal(withheld[0]?.data["deferredFrom"], "task_deferred");
    assert.equal(withheld[0]?.data["queued"], true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("with nowhere to queue the remainder, the task says so rather than done", async () => {
  // An authority that cannot take a remainder — or no authority at all, which
  // is a benchmark or a bare CLI run — leaves the contested file genuinely
  // outstanding. Canonical still advanced, so the task is not failed; what
  // changes is that it stops claiming the whole job.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-repair-"));
  try {
    const context = await fixture(root);
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
            id: "task_unqueued",
            objective: "edit the shared and own files",
            agentId: "scripted",
            validationCommands: [],
          },
          adapter: new ScriptedAgentAdapter({
            agentId: "scripted",
            repository: context.repository,
            workspaces: context.workspaces,
            behavior: {
              plan: plan("task_unqueued"),
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
            },
          }),
        },
      ],
    });

    assert.equal(result.tasks[0]?.status, "integrated");
    assert.match(
      result.tasks[0]?.explanation ?? "",
      /Still outstanding: src\/shared\.txt/u,
      "a task that did half the job must not report the whole one",
    );
    const withheld = result.audit.filter(
      (entry) => entry.type === "changeset_withheld",
    );
    assert.equal(withheld.length, 1);
    assert.equal(withheld[0]?.data["queued"], false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
