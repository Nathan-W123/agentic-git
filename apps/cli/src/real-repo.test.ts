import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepositoryService } from "@coord/repository-service";

import {
  repoAdd,
  runPendingTasks,
  taskSubmit,
} from "./commands.js";
import { CoordinatorProject } from "./project.js";

/**
 * End-to-end coverage for the path a user actually takes: register a real
 * repository, submit a task, and have a real agent process execute it.
 *
 * Everything else in the suite runs against synthetic benchmark fixtures, so
 * this is the only test that exercises repository registration, the submission
 * queue, and agent configuration together.
 */

const AGENT = [
  'import fs from "node:fs";',
  'import path from "node:path";',
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
  "function handle(message) {",
  '  if (message.type === "start") {',
  "    started = message;",
  "    return;",
  "  }",
  '  if (message.type === "plan_request") {',
  "    send({",
  '      type: "plan",',
  "      plan: {",
  "        taskId: started.taskId,",
  "        objective: started.objective,",
  '        expectedFiles: ["src/greet.js", "test/greet.test.js"],',
  '        expectedSymbols: ["greet"],',
  "        dependencies: [],",
  "        commands: [],",
  "        externalAccess: [],",
  '        riskLevel: "low",',
  "      },",
  "    });",
  "    return;",
  "  }",
  '  if (message.type === "context") {',
  "    const workspace = message.workspacePath;",
  '    const source = path.join(workspace, "src", "greet.js");',
  "    fs.writeFileSync(",
  "      source,",
  '      fs.readFileSync(source, "utf8").replace(',
  "        '\"Hello, \" + name',",
  "        '\"Hello, \" + name + \"!\"',",
  "      ),",
  '      "utf8",',
  "    );",
  '    const spec = path.join(workspace, "test", "greet.test.js");',
  "    fs.writeFileSync(",
  "      spec,",
  '      fs.readFileSync(spec, "utf8").replace(\'"Hello, world"\', \'"Hello, world!"\'),',
  '      "utf8",',
  "    );",
  "    send({",
  '      type: "done",',
  '      symbolsChanged: ["greet"],',
  '      explanation: "added an exclamation mark",',
  "    });",
  "    return;",
  "  }",
  '  if (message.type === "cancel") process.exit(0);',
  "}",
  "",
].join("\n");

const GREET_SOURCE = [
  "export function greet(name) {",
  '  return "Hello, " + name;',
  "}",
  "",
].join("\n");

const GREET_TEST = [
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  'import { greet } from "../src/greet.js";',
  "",
  'test("greets", () => {',
  '  assert.equal(greet("world"), "Hello, world");',
  "});",
  "",
].join("\n");

interface Harness {
  root: string;
  project: CoordinatorProject;
  sourcePath: string;
}

async function createHarness(): Promise<Harness> {
  // Kept short: git stores worktree metadata under a directory of the same
  // name inside the canonical repository, so deep roots exhaust MAX_PATH.
  const root = await mkdtemp(path.join(os.tmpdir(), "creal-"));
  const sourcePath = path.join(root, "src-repo");

  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await mkdir(path.join(sourcePath, "test"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "package.json"),
    `${JSON.stringify({ name: "greeter", private: true, type: "module" })}\n`,
    "utf8",
  );
  await writeFile(path.join(sourcePath, "src", "greet.js"), GREET_SOURCE, "utf8");
  await writeFile(
    path.join(sourcePath, "test", "greet.test.js"),
    GREET_TEST,
    "utf8",
  );
  await repositories.commitAll(sourcePath, "seed greeter");

  const projectRoot = path.join(root, "proj");
  await mkdir(projectRoot, { recursive: true });
  const agentPath = path.join(projectRoot, "agent.mjs");
  await writeFile(agentPath, AGENT, "utf8");

  const project = await CoordinatorProject.init(projectRoot);
  project.config.validationCommands = [
    { executable: process.execPath, args: ["--test"], label: "repository tests" },
  ];
  project.config.agents = {
    greeter: { command: process.execPath, args: [agentPath] },
  };
  project.config.defaultAgent = "greeter";
  await project.save();

  return { root, project, sourcePath };
}

test("a submitted task is executed against a registered repository", async () => {
  const harness = await createHarness();
  const store = harness.project.openStore();

  try {
    const repository = await repoAdd(harness.project, store, {
      sourcePath: harness.sourcePath,
      id: "greeter",
    });
    assert.equal(repository.id, "greeter");
    assert.equal(repository.branch, "main");
    assert.equal(harness.project.config.defaultRepository, "greeter");

    const submitted = await taskSubmit(harness.project, store, {
      objective: "Add an exclamation mark to the greeting",
    });
    assert.equal(submitted.status, "submitted");
    assert.equal(submitted.agentId, "greeter");

    const pending = await store.listSubmittedTasks({ status: "submitted" });
    assert.equal(pending.length, 1);

    const summary = await runPendingTasks(harness.project, store);
    assert.equal(summary.claimed.length, 1);
    assert.equal(summary.integrated, 1, JSON.stringify(summary));
    assert.equal(summary.failed, 0);
    assert.notEqual(summary.runId, undefined);

    // The canonical branch actually advanced, with the agent's edit in it.
    const repositories = new RepositoryService();
    const source = await repositories.readFile(
      { id: repository.id, path: repository.path, branch: repository.branch },
      summary.finalRevision,
      "src/greet.js",
    );
    assert.match(source, /"Hello, " \+ name \+ "!"/u);

    // The queue reflects the outcome and points at the run that did it.
    const completed = await store.listSubmittedTasks();
    assert.equal(completed[0]?.status, "integrated");
    assert.equal(completed[0]?.runId, summary.runId);

    // Nothing is left pending, so a second run is a no-op.
    const second = await runPendingTasks(harness.project, store);
    assert.equal(second.claimed.length, 0);

    // The run is queryable after the fact with its patch text intact.
    const detail = await store.getRun(summary.runId ?? "");
    assert.equal(detail?.tasks[0]?.status, "integrated");
    assert.deepEqual(
      detail?.changeSets[0]?.patches.map((patch) => patch.path).sort(),
      ["src/greet.js", "test/greet.test.js"],
    );
    assert.equal((await store.verifyAudit()).valid, true);
  } finally {
    await store.close();
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("registering the same repository id twice is refused", async () => {
  const harness = await createHarness();
  const store = harness.project.openStore();
  try {
    await repoAdd(harness.project, store, {
      sourcePath: harness.sourcePath,
      id: "greeter",
    });
    await assert.rejects(
      repoAdd(harness.project, store, {
        sourcePath: harness.sourcePath,
        id: "greeter",
      }),
      /already registered/u,
    );
  } finally {
    await store.close();
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("repository ids that could escape the project directory are refused", async () => {
  const harness = await createHarness();
  const store = harness.project.openStore();
  try {
    for (const id of [
      "../escape",
      "has space",
      "with/slash",
      ".hidden",
      "a".repeat(81),
    ]) {
      await assert.rejects(
        repoAdd(harness.project, store, {
          sourcePath: harness.sourcePath,
          id,
        }),
        /Repository id must be at most 80 characters/u,
        `expected ${id} to be refused`,
      );
    }
  } finally {
    await store.close();
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("submitting against an unknown repository lists the known ones", async () => {
  const harness = await createHarness();
  const store = harness.project.openStore();
  try {
    await repoAdd(harness.project, store, {
      sourcePath: harness.sourcePath,
      id: "greeter",
    });
    await assert.rejects(
      taskSubmit(harness.project, store, {
        objective: "x",
        repositoryId: "nope",
      }),
      /Unknown repository: nope.*Registered: greeter/su,
    );
    await assert.rejects(
      taskSubmit(harness.project, store, { objective: "   " }),
      /non-empty --objective/u,
    );
  } finally {
    await store.close();
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("setup failures do not strand tasks in claimed state", async () => {
  const harness = await createHarness();
  const store = harness.project.openStore();
  try {
    await repoAdd(harness.project, store, {
      sourcePath: harness.sourcePath,
      id: "greeter",
    });
    const submitted = await taskSubmit(harness.project, store, {
      objective: "Fail before an agent can start",
    });
    harness.project.config.agents = {};
    delete harness.project.config.defaultAgent;

    await assert.rejects(
      runPendingTasks(harness.project, store),
      /Unknown agent: greeter/u,
    );
    const [failed] = await store.listSubmittedTasks();
    assert.equal(failed?.status, "failed");
    assert.ok(failed?.completedAt !== undefined);

    const retried = await store.retrySubmittedTask(submitted.id);
    assert.equal(retried.status, "submitted");
    assert.equal(retried.completedAt, undefined);
  } finally {
    await store.close();
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("repository registration rolls back a partially persisted import", async () => {
  const harness = await createHarness();
  const store = harness.project.openStore();
  const originalSaveVersion = store.saveCanonicalVersion.bind(store);
  store.saveCanonicalVersion = async () => {
    throw new Error("simulated version persistence failure");
  };

  try {
    await assert.rejects(
      repoAdd(harness.project, store, {
        sourcePath: harness.sourcePath,
        id: "greeter",
      }),
      /simulated version persistence failure/u,
    );
    assert.equal(await store.getRepository("greeter"), undefined);
    await assert.rejects(
      access(path.join(harness.project.repositoriesPath, "greeter.git")),
    );
  } finally {
    store.saveCanonicalVersion = originalSaveVersion;
    await store.close();
    await rm(harness.root, { recursive: true, force: true });
  }
});
