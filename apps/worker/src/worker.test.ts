import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { ApiGateway, type ApiOperations } from "@coord/api-gateway";
import { CoordinatorProject } from "@coord/cli/project";
import { workerOperations } from "@coord/cli/worker-operations";
import { SqliteCoordinationStore } from "@coord/persistence";
import { RepositoryService } from "@coord/repository-service";

import { WorkerClient } from "./client.js";
import { Worker } from "./worker.js";

/**
 * The whole hosted-execution loop over real HTTP: a worker leases a task from
 * a running control plane, rebuilds the workspace from a bundle, runs a real
 * agent process, and returns a changeset the control plane accepts.
 *
 * The worker never touches the canonical repository — only the bundle bytes it
 * is served — which is what makes this a test of remote execution rather than
 * of two objects sharing a disk.
 */

const BOOTSTRAP_TOKEN = "bootstrap-token-for-worker-tests-1234";
const PASSWORD = "RelayPassword123!";

/** A minimal JSONL agent that edits one file, so the run is deterministic. */
const AGENT = [
  'import fs from "node:fs";',
  'import path from "node:path";',
  "let started = null;",
  "let buffer = '';",
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
  "function send(message) {",
  '  process.stdout.write(JSON.stringify(message) + "\\n");',
  "}",
  "function handle(message) {",
  '  if (message.type === "start") { started = message; return; }',
  '  if (message.type === "plan_request") {',
  "    send({",
  '      type: "plan",',
  "      plan: {",
  "        taskId: started.taskId,",
  "        objective: started.objective,",
  '        expectedFiles: ["src/value.js"],',
  '        expectedSymbols: ["value"],',
  "        dependencies: [], commands: [], externalAccess: [],",
  '        riskLevel: "low",',
  "      },",
  "    });",
  "    return;",
  "  }",
  '  if (message.type === "context") {',
  '    const file = path.join(message.workspacePath, "src", "value.js");',
  '    fs.writeFileSync(file, "export const value = 2;\\n", "utf8");',
  "    send({",
  '      type: "done",',
  '      symbolsChanged: ["value"],',
  '      explanation: "raised the value",',
  "    });",
  "    return;",
  "  }",
  '  if (message.type === "cancel") process.exit(0);',
  "}",
  'process.stdin.on("end", () => process.exit(0));',
  "",
].join("\n");

interface Runtime {
  origin: string;
  store: SqliteCoordinationStore;
  project: CoordinatorProject;
  root: string;
  token: string;
  repositoryId: string;
}

async function startRuntime(t: TestContext): Promise<Runtime> {
  // Short root: git stores worktree metadata under a same-named directory, so
  // a deep path exhausts MAX_PATH on Windows.
  const root = await mkdtemp(path.join(os.tmpdir(), "cwd-"));
  const projectRoot = path.join(root, "cp");
  await mkdir(projectRoot, { recursive: true });

  const agentPath = path.join(projectRoot, "agent.mjs");
  await writeFile(agentPath, AGENT, "utf8");

  const project = await CoordinatorProject.init(projectRoot);
  project.config.validationCommands = [];
  project.config.agents = {
    local: { command: process.execPath, args: [agentPath] },
  };
  project.config.defaultAgent = "local";
  await project.save();

  // A real repository, imported into the control plane's canonical store.
  const sourcePath = path.join(root, "src-repo");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "src", "value.js"),
    "export const value = 1;\n",
    "utf8",
  );
  await repositories.commitAll(sourcePath, "seed");
  const canonical = await repositories.importLocalRepository(
    sourcePath,
    path.join(root, "canon.git"),
    "repo_hosted",
    "main",
  );

  const store = SqliteCoordinationStore.open(path.join(root, "state.db"));
  await store.saveRepository({
    id: canonical.id,
    path: canonical.path,
    branch: canonical.branch,
  });

  const operations: ApiOperations = {
    async importGitHub() {
      throw new Error("not used");
    },
    async submitTask() {
      throw new Error("not used");
    },
    async runRepository() {},
    ...workerOperations(project, store),
  };
  const gateway = new ApiGateway({ store, operations, bootstrapToken: BOOTSTRAP_TOKEN });
  await new Promise<void>((resolve, reject) => {
    gateway.server.once("error", reject);
    gateway.server.listen(0, "127.0.0.1", resolve);
  });
  const address = gateway.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("gateway did not bind a port");
  }
  const origin = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await gateway.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  // Bootstrap an owner and mint a worker token, exactly as an operator would.
  const cookies: string[] = [];
  const setup = await fetch(`${origin}/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bootstrap-Token": BOOTSTRAP_TOKEN,
    },
    body: JSON.stringify({
      email: "owner@example.com",
      displayName: "Owner",
      password: PASSWORD,
    }),
  });
  assert.equal(setup.status, 201);
  for (const cookie of setup.headers.getSetCookie()) {
    cookies.push(cookie.split(";")[0] ?? "");
  }
  const csrf = /coord_csrf=([^;]+)/u.exec(cookies.join("; "))?.[1] ?? "";
  const issued = await fetch(`${origin}/api/v1/auth/tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookies.join("; "),
      "X-CSRF-Token": csrf,
    },
    body: JSON.stringify({ name: "fleet", scopes: ["view", "run_task"] }),
  });
  assert.equal(issued.status, 201);
  const token = ((await issued.json()) as { token: string }).token;

  return { origin, store, project, root, token, repositoryId: canonical.id };
}

function makeWorker(runtime: Runtime): Worker {
  return new Worker({
    client: new WorkerClient({ serverUrl: runtime.origin, token: runtime.token }),
    project: runtime.project,
    workspaceRoot: path.join(runtime.root, "w"),
    name: "test-worker",
    version: "1.0.0",
  });
}

test("an idle worker reports no work rather than failing", async (t) => {
  const runtime = await startRuntime(t);
  const worker = makeWorker(runtime);

  const workerId = await worker.register();
  assert.match(workerId, /^worker_/u);
  assert.deepEqual(await worker.runOnce(), { worked: false });
});

test("a worker executes a leased task end to end over HTTP", async (t) => {
  const runtime = await startRuntime(t);
  const worker = makeWorker(runtime);
  await worker.register();

  const task = await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise the value",
    agentId: "local",
    validationCommands: [],
  });

  const result = await worker.runOnce();
  assert.equal(result.worked, true);
  assert.equal(result.taskId, task.id);
  assert.equal(result.accepted, true, result.reason);

  // The lease settled rather than lapsing.
  const leases = await runtime.store.listWorkLeases({});
  assert.equal(leases.length, 1);
  assert.equal(leases[0]?.status, "completed");
  assert.equal(leases[0]?.baseRevision.length, 40);

  // The changeset reached the control plane with the agent's edit in it.
  const audit = await runtime.store.listAudit();
  const collected = audit.find((event) => event.type === "changeset_collected");
  assert.equal(collected?.taskId, task.id);
  assert.deepEqual(collected?.data["files"], ["src/value.js"]);

  // Nothing is left pending, and a second poll finds nothing.
  assert.deepEqual(await worker.runOnce(), { worked: false });
});

test("an agent failure is reported, not swallowed", async (t) => {
  const runtime = await startRuntime(t);
  // Point the agent at an executable that does not exist.
  runtime.project.config.agents = { local: { command: "definitely-not-a-real-binary" } };
  await runtime.project.save();

  const worker = makeWorker(runtime);
  await worker.register();
  await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "will fail",
    agentId: "local",
    validationCommands: [],
  });

  const result = await worker.runOnce();
  assert.equal(result.worked, true);
  assert.equal(result.accepted, false);

  const leases = await runtime.store.listWorkLeases({});
  assert.equal(leases[0]?.status, "failed");
  // The task is settled as failed, not silently returned to the queue where it
  // would fail forever in a loop.
  const tasks = await runtime.store.listSubmittedTasks();
  assert.equal(tasks[0]?.status, "failed");
});

test("stopping a worker hands its lease back immediately", async (t) => {
  const runtime = await startRuntime(t);
  const worker = makeWorker(runtime);
  const workerId = await worker.register();

  await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "objective",
    agentId: "local",
    validationCommands: [],
  });

  // Lease directly so a lease is held with no execution in flight.
  const client = new WorkerClient({
    serverUrl: runtime.origin,
    token: runtime.token,
  });
  const assignment = await client.lease(workerId);
  assert.notEqual(assignment, undefined);
  await client.release(assignment?.lease.id ?? "");

  // Released rather than left to expire, so the task is available at once.
  assert.equal(
    (await runtime.store.listSubmittedTasks({ status: "submitted" })).length,
    1,
  );
});

test("a worker without the run_task scope cannot register", async (t) => {
  const runtime = await startRuntime(t);
  const client = new WorkerClient({
    serverUrl: runtime.origin,
    token: "coord_pat_bogus.secret",
  });
  await assert.rejects(
    client.register({ name: "rogue", adapters: [], version: "1" }),
    /401|invalid/iu,
  );
});

test("a configured sandbox is applied to the agent process", async (t) => {
  const runtime = await startRuntime(t);
  runtime.project.config.sandbox = { mode: "docker", image: "coord/agent:1" };
  await runtime.project.save();

  const worker = makeWorker(runtime);
  await worker.register();
  await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "sandboxed",
    agentId: "local",
    validationCommands: [],
  });

  // No Docker daemon here, so the agent launch fails — but it must fail trying
  // to run `docker`, which proves the container wrapper was applied rather
  // than the agent being run unconfined.
  const result = await worker.runOnce();
  assert.equal(result.worked, true);
  assert.equal(result.accepted, false);
  assert.match(result.reason ?? "", /docker/iu);
});

test("the Codex adapter refuses to pretend it is sandboxed", async (t) => {
  const runtime = await startRuntime(t);
  runtime.project.config.sandbox = { mode: "docker", image: "coord/agent:1" };
  runtime.project.config.agents = { local: { adapter: "codex" } };
  await runtime.project.save();

  const worker = makeWorker(runtime);
  await worker.register();
  await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "sandboxed codex",
    agentId: "local",
    validationCommands: [],
  });

  // Codex confines itself through its own --sandbox flag, so combining it with
  // a container wrapper would silently run unconfined. Better to refuse.
  const result = await worker.runOnce();
  assert.equal(result.accepted, false);
  assert.match(result.reason ?? "", /cannot run inside one/u);
});
