import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConversationRegistry } from "@coord/coordinator";
import { RepositoryService } from "@coord/repository-service";

import { repoAdd, runPendingTasks, taskSubmit } from "./commands.js";
import { CoordinatorProject } from "./project.js";

/**
 * The deployed shape of a conversation, end to end: two dispatches through
 * `runPendingTasks` — the entry point `operations.runRepository` actually
 * calls — sharing one {@link ConversationRegistry}, the way the web process
 * shares one across every run it starts. Each dispatch builds its own
 * coordinator and its own adapter instance, which is exactly the situation
 * the registry exists for: the conversation's directory survives from one to
 * the next while the session, whose process belongs to the first run's
 * adapter, is closed and replaced.
 *
 * The store is asserted alongside: a landed turn leaves its task `open`, the
 * next turn's submission settles it, and ending the conversation is a
 * cancellation like any other.
 */

/**
 * A scripted agent for one turn: plans the file its objective names, writes
 * it, and reports where it worked so the test can see directory reuse from
 * the outside.
 */
const AGENT = [
  'import fs from "node:fs";',
  'import path from "node:path";',
  "",
  'const SIGNALS = process.env["CONV_SIGNAL_DIR"];',
  "",
  "let started = null;",
  'let buffer = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (chunk) => {',
  "  buffer += chunk;",
  '  let index = buffer.indexOf("\\n");',
  "  while (index !== -1) {",
  "    const line = buffer.slice(0, index).trim();",
  "    buffer = buffer.slice(index + 1);",
  "    if (line.length > 0) handle(JSON.parse(line));",
  '    index = buffer.indexOf("\\n");',
  "  }",
  "});",
  "",
  "function send(message) {",
  '  process.stdout.write(JSON.stringify(message) + "\\n");',
  "}",
  "",
  '// The objective is "write <repository-path>"; the file is the plan.',
  "function targetFile() {",
  '  return started.objective.split(" ")[1];',
  "}",
  "",
  "function handle(message) {",
  '  if (message.type === "start") {',
  "    started = message;",
  "    return;",
  "  }",
  '  if (message.type === "plan_request" || message.type === "replan_request") {',
  "    send({",
  '      type: "plan",',
  "      plan: {",
  "        taskId: started.taskId,",
  "        objective: started.objective,",
  "        expectedFiles: [targetFile()],",
  "        expectedSymbols: [],",
  "        dependencies: [],",
  "        commands: [],",
  "        externalAccess: [],",
  '        riskLevel: "low",',
  "      },",
  "    });",
  "    return;",
  "  }",
  '  if (message.type === "context") {',
  "    fs.writeFileSync(",
  '      path.join(SIGNALS, "workspace-" + started.taskId),',
  "      message.workspacePath,",
  '      "utf8",',
  "    );",
  "    fs.writeFileSync(",
  "      path.join(message.workspacePath, targetFile()),",
  '      started.taskId + "\\n",',
  '      "utf8",',
  "    );",
  "    send({",
  '      type: "done",',
  "      symbolsChanged: [],",
  '      explanation: "wrote " + targetFile(),',
  "    });",
  "    return;",
  "  }",
  '  if (message.type === "cancel") process.exit(0);',
  "}",
  "",
].join("\n");

interface Harness {
  root: string;
  project: CoordinatorProject;
  sourcePath: string;
  signalsPath: string;
}

async function createHarness(): Promise<Harness> {
  // Kept short: git stores worktree metadata under a directory of the same
  // name inside the canonical repository, so deep roots exhaust MAX_PATH.
  const root = await mkdtemp(path.join(os.tmpdir(), "cconv-"));
  const sourcePath = path.join(root, "src-repo");
  const signalsPath = path.join(root, "signals");
  await mkdir(signalsPath, { recursive: true });

  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await writeFile(path.join(sourcePath, "src", "seed.txt"), "seed\n", "utf8");
  await repositories.commitAll(sourcePath, "seed");

  const projectRoot = path.join(root, "proj");
  await mkdir(projectRoot, { recursive: true });
  const agentPath = path.join(projectRoot, "agent.mjs");
  await writeFile(agentPath, AGENT, "utf8");

  const project = await CoordinatorProject.init(projectRoot);
  // No validation commands: the subject is the conversation lifecycle, not
  // the repository's health, and every skipped command is seconds saved.
  project.config.validationCommands = [];
  project.config.agents = {
    turner: {
      command: process.execPath,
      args: [agentPath],
      env: { CONV_SIGNAL_DIR: signalsPath },
    },
  };
  project.config.defaultAgent = "turner";
  await project.save();

  return { root, project, sourcePath, signalsPath };
}

test("a conversation spans dispatches: open in the store, warm on disk", async () => {
  const harness = await createHarness();
  const store = harness.project.openStore();
  try {
    const repository = await repoAdd(harness.project, store, {
      sourcePath: harness.sourcePath,
      id: "conv",
    });
    const conversations = new ConversationRegistry();

    const first = await taskSubmit(harness.project, store, {
      objective: "write src/one.txt",
      conversationId: "thread_root",
    });
    const runOne = await runPendingTasks(harness.project, store, {
      repositoryId: repository.id,
      conversations,
    });
    assert.equal(runOne.integrated, 1);

    // The turn landed and the task waits — open, not terminal — with its
    // lease settled so nothing else queues behind a finished turn.
    const afterFirst = (await store.listSubmittedTasks({})).find(
      (task) => task.id === first.id,
    );
    assert.equal(afterFirst?.status, "open");
    assert.ok(afterFirst?.openedAt !== undefined);
    assert.equal(afterFirst?.runId, runOne.runId);
    assert.deepEqual(await store.listWorkLeases({ status: "active" }), []);

    // The next turn is its own dispatch: a fresh runPendingTasks call, a
    // fresh coordinator, a fresh adapter instance — only the registry and
    // the store connect it to the last one.
    const second = await taskSubmit(harness.project, store, {
      objective: "write src/two.txt",
      conversationId: "thread_root",
    });
    // Submitting the next turn settled the previous one.
    const superseded = (await store.listSubmittedTasks({})).find(
      (task) => task.id === first.id,
    );
    assert.equal(superseded?.status, "integrated");

    const runTwo = await runPendingTasks(harness.project, store, {
      repositoryId: repository.id,
      conversations,
    });
    assert.equal(runTwo.integrated, 1);
    const afterSecond = (await store.listSubmittedTasks({})).find(
      (task) => task.id === second.id,
    );
    assert.equal(afterSecond?.status, "open");

    // The conversation's directory carried across the dispatches: both
    // turns report the same workspace path, and the second turn's checkout
    // began from the first turn's landing.
    const firstWorkspace = await readFile(
      path.join(harness.signalsPath, `workspace-${first.id}`),
      "utf8",
    );
    const secondWorkspace = await readFile(
      path.join(harness.signalsPath, `workspace-${second.id}`),
      "utf8",
    );
    assert.equal(secondWorkspace, firstWorkspace);
    assert.equal(
      await readFile(path.join(secondWorkspace, "src", "one.txt"), "utf8"),
      `${first.id}\n`,
    );

    // Ending the conversation is a decision, and it is terminal both in the
    // store and on disk.
    await store.cancelSubmittedTask(second.id);
    await conversations.endConversation("thread_root");
    await assert.rejects(lstat(firstWorkspace), { code: "ENOENT" });
  } finally {
    await store.close();
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("how long a conversation may wait is the deployment's to set", async () => {
  const harness = await createHarness();
  const store = harness.project.openStore();
  const previous = process.env["COORD_OPEN_CONVERSATION_MAX_AGE_MS"];
  try {
    const repository = await repoAdd(harness.project, store, {
      sourcePath: harness.sourcePath,
      id: "conv",
    });
    const conversations = new ConversationRegistry();

    const first = await taskSubmit(harness.project, store, {
      objective: "write src/one.txt",
      conversationId: "thread_root",
    });
    const runOne = await runPendingTasks(harness.project, store, {
      repositoryId: repository.id,
      conversations,
    });
    assert.equal(runOne.integrated, 1);
    assert.equal(
      (await store.listSubmittedTasks({})).find((task) => task.id === first.id)
        ?.status,
      "open",
    );
    const workspace = await readFile(
      path.join(harness.signalsPath, `workspace-${first.id}`),
      "utf8",
    );

    // Six hours of patience is a default, not a law. A deployment that says
    // a conversation is over the moment its turn lands gets exactly that,
    // on the next sweep — the work stays landed, only the waiting ends.
    process.env["COORD_OPEN_CONVERSATION_MAX_AGE_MS"] = "0";
    await runPendingTasks(harness.project, store, {
      repositoryId: repository.id,
      conversations,
    });
    assert.equal(
      (await store.listSubmittedTasks({})).find((task) => task.id === first.id)
        ?.status,
      "integrated",
    );
    // The sweep reaches the directory too, not just the row.
    await assert.rejects(lstat(workspace), { code: "ENOENT" });
  } finally {
    if (previous === undefined) {
      delete process.env["COORD_OPEN_CONVERSATION_MAX_AGE_MS"];
    } else {
      process.env["COORD_OPEN_CONVERSATION_MAX_AGE_MS"] = previous;
    }
    await store.close();
    await rm(harness.root, { recursive: true, force: true });
  }
});
