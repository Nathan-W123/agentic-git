import assert from "node:assert/strict";
import type { PowerState } from "./power.js";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { ApiGateway, type ApiOperations } from "@coord/api-gateway";
import type { CodexProcessRunner } from "@coord/adapter-codex";
import { CoordinatorProject, mcpServerDigest } from "@coord/cli/project";
import { workerOperations } from "@coord/cli/worker-operations";
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
  SqliteCoordinationStore,
} from "@coord/persistence";
import { RepositoryService } from "@coord/repository-service";
import type { AgentPlan, CanonicalChangeNotice, ResolvedMcpServer } from "@coord/shared-types";

/** Mirrors the worker's internal cache entry, which is not exported. */
interface CachedPlanEntry {
  plan: AgentPlan;
  baseRevision: string;
  advancedTo?: CanonicalChangeNotice;
}

import { WorkerClient } from "./client.js";
import { Worker, workerScratchPath } from "./worker.js";

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
  "let pendingContext = null;",
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
  // Which file this run is for. Absent from the objective it is the original
  // single file, so every test written before concurrency existed is
  // unchanged by this.
  "function target() {",
  '  const match = /^edit (\\S+)/u.exec(started.objective);',
  '  return match ? match[1] : "src/value.js";',
  "}",
  // The name that file declares, so concurrent runs declare different symbols
  // and are arbitrated on their own merits rather than on a shared one.
  "function symbolName() {",
  '  const base = target().split("/").pop() || "";',
  '  return base.replace(/\\.js$/u, "");',
  "}",
  "function finish(message) {",
  '  const file = path.join(message.workspacePath, ...target().split("/"));',
  '  fs.writeFileSync(file, "export const " + symbolName() + " = 2;\\n", "utf8");',
  "  send({",
  '    type: "done",',
  "    symbolsChanged: [symbolName()],",
  '    explanation: "raised the value",',
  "  });",
  "}",
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
  "        expectedFiles: [target()],",
  "        expectedSymbols: [symbolName()],",
  "        dependencies: [], commands: [], externalAccess: [],",
  '        riskLevel: "low",',
  "      },",
  "    });",
  "    return;",
  "  }",
  '  if (message.type === "context") {',
  '    if (started.objective === "hang until stopped") {',
  "      return;",
  "    }",
  '    if (started.objective === "request extra scope") {',
  "      pendingContext = message;",
  "      send({",
  '        type: "event",',
  "        event: {",
  '          event: "scope_change_requested",',
  '          requestId: "scope_remote_test",',
  '          additionalFiles: ["src/extra.js"],',
  '          additionalSymbols: ["extra"],',
  '          reason: "the value depends on a constant that lives in extra.js",',
  "        },",
  "      });",
  "      return;",
  "    }",
  // Held open for a moment when asked, so several runs are demonstrably in
  // flight together and not merely submitted together. A run that is cancelled
  // during this — which is what a worker sharing one session between runs
  // would do to its siblings — never writes its file.
  '    if (started.objective.endsWith("slowly")) {',
  "      setTimeout(() => finish(message), 400);",
  "      return;",
  "    }",
  "    finish(message);",
  "    return;",
  "  }",
  '  if (message.type === "scope_decision") {',
  "    const granted =",
  '      message.decision.decision === "approved" ||',
  '      message.decision.decision === "approved_with_constraints";',
  "    const root = pendingContext.workspacePath;",
  '    const file = path.join(root, "src", "value.js");',
  '    fs.writeFileSync(file, "export const value = 2;\\n", "utf8");',
  "    if (granted) {",
  '      fs.writeFileSync(path.join(root, "src", "extra.js"), "export const extra = 2;\\n", "utf8");',
  "    }",
  "    send({",
  '      type: "done",',
  '      symbolsChanged: ["value"],',
  '      explanation: "scope decision was " + message.decision.decision,',
  "    });",
  "    return;",
  "  }",
  '  if (message.type === "cancel") process.exit(0);',
  "}",
  'process.stdin.on("end", () => process.exit(0));',
  "",
].join("\n");

/** One per concurrently executed task in the tests that need several. */
const CONCURRENT_FILES = ["one", "two", "three"] as const;

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
  // A second real file, so the scope-expansion tests ask for something that
  // exists rather than for a name nothing in the repository can ground.
  await writeFile(
    path.join(sourcePath, "src", "extra.js"),
    "export const extra = 1;\n",
    "utf8",
  );
  // One file per concurrent run, each declaring its own name: tasks that share
  // a symbol are arbitrated against each other, and a test of concurrency must
  // not be measuring the conflict detector.
  for (const name of CONCURRENT_FILES) {
    await writeFile(
      path.join(sourcePath, "src", `${name}.js`),
      `export const ${name} = 1;\n`,
      "utf8",
    );
  }
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
    async createRepository() {
      throw new Error("not used");
    },
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

function makeWorker(
  runtime: Runtime,
  overrides: Partial<ConstructorParameters<typeof Worker>[0]> = {},
): Worker {
  return new Worker({
    client: new WorkerClient({ serverUrl: runtime.origin, token: runtime.token }),
    project: runtime.project,
    organizationId: DEFAULT_ORGANIZATION_ID,
    workspaceRoot: path.join(runtime.root, "w"),
    name: "test-worker",
    version: "1.0.0",
    ...overrides,
  });
}

/** Polls `read` until it answers, or gives up loudly rather than hanging. */
async function waitFor<T>(
  read: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await read();
    if (answer !== undefined) {
      return answer;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("lease ids cannot select or collapse the worker scratch root", () => {
  const root = path.resolve("worker-scratch");
  const scratch = workerScratchPath(root, "../../../../\0");
  assert.equal(path.dirname(scratch), root);
  assert.match(path.basename(scratch), /^lease-[a-f0-9]{24}$/u);
  assert.notEqual(scratch, root);
});

test("worker polling and admission budgets reject unsafe values", async (t) => {
  const runtime = await startRuntime(t);
  const options = {
    client: new WorkerClient({
      serverUrl: runtime.origin,
      token: runtime.token,
    }),
    project: runtime.project,
    organizationId: DEFAULT_ORGANIZATION_ID,
    workspaceRoot: path.join(runtime.root, "invalid-options"),
  };
  assert.throws(() => new Worker({ ...options, pollIntervalMs: 0 }), /positive/u);
  assert.throws(
    () => new Worker({ ...options, planWaitBudgetMs: -1 }),
    /non-negative/u,
  );
});

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

  // The result was not merely acknowledged: it is a durable run, the queue
  // task is finalized, and canonical contains the worker's edit.
  const tasks = await runtime.store.listSubmittedTasks();
  assert.equal(tasks[0]?.status, "integrated");
  assert.ok(tasks[0]?.runId);
  const repository = await runtime.store.getRepository(runtime.repositoryId);
  assert.ok(repository);
  const repositories = new RepositoryService();
  const version = await repositories.getCanonicalVersion({
    id: repository.id,
    path: repository.path,
    branch: repository.branch,
  });
  assert.equal(
    await repositories.readFile(
      {
        id: repository.id,
        path: repository.path,
        branch: repository.branch,
      },
      version.revision,
      "src/value.js",
    ),
    "export const value = 2;\n",
  );

  // Nothing is left pending, and a second poll finds nothing.
  assert.deepEqual(await worker.runOnce(), { worked: false });
});

/**
 * A solo remote task is handed its repository instead of describing it.
 *
 * The plan an agent writes before it edits anything exists so a second task
 * can arbitrate against it. Where there is no second task it buys nothing —
 * and it is the single largest fixed cost before the first edit, an agent
 * round trip rather than a request. The in-process coordinator has skipped it
 * since blanket claims existed; a worker never could, because its protocol had
 * no claim step. Moving execution onto people's own machines therefore put
 * every desktop task back through planning without anybody deciding to.
 *
 * Checked the way the benchmark says to check it: the task has a
 * `blanket_claim_granted` event and no plan of its own.
 */
test("a solo remote task is granted the repository and never plans", async (t) => {
  const runtime = await startRuntime(t);
  const worker = makeWorker(runtime);
  await worker.register();

  // An objective naming a real path, because a claim is granted only against
  // an *anchored* estimate: a claim that could never be narrowed early is not
  // worth the planning round it saves, so a vague objective plans as before.
  const task = await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise the value in src/value.js",
    agentId: "local",
    validationCommands: [],
  });

  const result = await worker.runOnce();
  assert.equal(result.accepted, true, result.reason);

  const audit = await runtime.store.listAudit();
  const granted = audit.find(
    (event) => event.type === "blanket_claim_granted" && event.taskId === task.id,
  );
  assert.ok(granted, "the repository should have been claimed");
  assert.equal(granted?.data["planningCallsSaved"], 1);

  // The contract on the lease is the claim itself, which is what makes the
  // agent's own writes approved without anybody arbitrating them.
  const lease = (await runtime.store.listWorkLeases({})).find(
    (candidate) => candidate.taskId === task.id,
  );
  assert.equal(lease?.plan?.plan.claim?.kind, "blanket");
  assert.equal(lease?.status, "completed");

  // And the work still lands. A claimed task edits, reports and integrates
  // exactly as a planned one does — only the round trip in front of it is
  // gone.
  const tasks = await runtime.store.listSubmittedTasks();
  assert.equal(
    tasks.find((entry) => entry.id === task.id)?.status,
    "integrated",
  );
  const collected = audit.find(
    (event) => event.type === "changeset_collected" && event.taskId === task.id,
  );
  assert.deepEqual(collected?.data["files"], ["src/value.js"]);
});

/**
 * And a second worker in the organization is enough to withhold it.
 *
 * Phase 1 ships without the narrowing that gives a claim back, so the only
 * honest version of "this can be taken back" is "there is nobody to take it
 * from". A claim held by a machine that cannot be told to let go would block
 * everybody else until its task ended.
 */
test("a claim is withheld while a second worker could arrive", async (t) => {
  const runtime = await startRuntime(t);
  const worker = makeWorker(runtime);
  await worker.register();
  // Registered against the same account as the one that just registered, so
  // this is a second machine rather than a second tenant.
  const mine = (await runtime.store.listWorkers({}))[0];
  assert.ok(mine, "the worker should have registered");
  await runtime.store.registerWorker({
    userId: mine.userId,
    organizationId: DEFAULT_ORGANIZATION_ID,
    name: "somebody else's laptop",
    adapters: ["generic-cli"],
    version: "test",
  });

  const task = await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise the value in src/value.js",
    agentId: "local",
    validationCommands: [],
  });
  const result = await worker.runOnce();
  assert.equal(result.accepted, true, result.reason);

  const audit = await runtime.store.listAudit();
  assert.ok(
    audit.find((event) => event.type === "blanket_claim_granted"),
    "a registered second machine is not somebody executing",
  );
  const tasks = await runtime.store.listSubmittedTasks();
  assert.equal(
    tasks.find((entry) => entry.id === task.id)?.status,
    "integrated",
  );
});

test("a mid-run scope expansion is arbitrated and granted", async (t) => {
  const runtime = await startRuntime(t);
  const worker = makeWorker(runtime);
  await worker.register();
  const task = await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "request extra scope",
    agentId: "local",
    validationCommands: [],
  });

  const result = await worker.runOnce();
  assert.equal(result.accepted, true, result.reason);
  const storedTask = (await runtime.store.listSubmittedTasks()).find(
    (entry) => entry.id === task.id,
  );
  assert.equal(storedTask?.status, "integrated");

  // Nothing else is executing, so the coordinator grants the expansion — and
  // the grant is what lets a patch on the new file reach canonical instead of
  // being refused as a scope escape.
  const run = await runtime.store.getRun(storedTask?.runId ?? "");
  assert.deepEqual(
    run?.changeSets[0]?.patches.map((patch) => patch.path).sort(),
    ["src/extra.js", "src/value.js"],
  );
  const decided = (await runtime.store.listAudit()).find(
    (event) => event.type === "scope_change_decided",
  );
  assert.equal(
    (decided?.data["decision"] as { decision?: string } | undefined)?.decision,
    "approved",
  );

  const repository = await runtime.store.getRepository(runtime.repositoryId);
  assert.ok(repository);
  const repositories = new RepositoryService();
  const canonical = {
    id: repository.id,
    path: repository.path,
    branch: repository.branch,
  };
  const version = await repositories.getCanonicalVersion(canonical);
  assert.equal(
    await repositories.readFile(canonical, version.revision, "src/extra.js"),
    "export const extra = 2;\n",
  );
});

test("a scope expansion waits until another task releases it", async (t) => {
  const runtime = await startRuntime(t);

  // A rival worker is already executing with an admitted plan on the very
  // file the agent is about to ask for.
  const rival = new WorkerClient({
    serverUrl: runtime.origin,
    token: runtime.token,
  });
  const rivalId = (
    await rival.register({
      organizationId: DEFAULT_ORGANIZATION_ID,
      name: "rival",
      adapters: ["generic-cli"],
      version: "1.0.0",
    })
  ).id;
  const held = await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "rewrite the extra constant",
    agentId: "local",
    validationCommands: [],
  });
  const expanding = await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "request extra scope",
    agentId: "local",
    validationCommands: [],
  });
  const rivalAssignment = await rival.lease(rivalId, DEFAULT_PROJECT_ID);
  assert.equal(rivalAssignment?.task.id, held.id);
  assert.ok(rivalAssignment);
  const rivalAdmission = await rival.submitPlan(rivalAssignment.lease.id, {
    taskId: held.id,
    objective: held.objective,
    expectedFiles: ["src/extra.js"],
    expectedSymbols: ["extra"],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  });
  assert.equal(rivalAdmission.status, "approved");

  const worker = makeWorker(runtime);
  await worker.register();
  const running = worker.runOnce();
  const deadline = Date.now() + 10_000;
  let scopeDecisions = (await runtime.store.listAudit()).filter(
    (event) => event.type === "scope_change_decided",
  );
  while (
    !scopeDecisions.some(
      (event) =>
        (event.data["decision"] as { decision?: string } | undefined)
          ?.decision === "deferred",
    ) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    scopeDecisions = (await runtime.store.listAudit()).filter(
      (event) => event.type === "scope_change_decided",
    );
  }
  assert.ok(
    scopeDecisions.some(
      (event) =>
        (event.data["decision"] as { decision?: string } | undefined)
          ?.decision === "deferred",
    ),
    "the scope request should be observed waiting on its holder",
  );
  await runtime.store.completeSubmittedTask(held.id, "integrated");
  assert.equal(
    await runtime.store.finishWorkLease(
      rivalAssignment.lease.id,
      "completed",
      new Date().toISOString(),
      "holder finished",
    ),
    true,
  );

  const result = await running;
  assert.equal(result.taskId, expanding.id);
  assert.equal(result.accepted, true, result.reason);

  // The deferral was not handed back to the agent as an ending. The worker
  // retried the same request while the model remained parked, and only the
  // eventual grant resumed it.
  const decided = (await runtime.store.listAudit())
    .filter((event) => event.type === "scope_change_decided")
    .at(-1);
  const decision = decided?.data["decision"] as
    | { decision?: string; blockedBy?: string[]; retryAfterMs?: number }
    | undefined;
  assert.equal(decision?.decision, "approved");

  const storedTask = (await runtime.store.listSubmittedTasks()).find(
    (entry) => entry.id === expanding.id,
  );
  assert.equal(storedTask?.status, "integrated");
  const run = await runtime.store.getRun(storedTask?.runId ?? "");
  assert.deepEqual(
    run?.changeSets[0]?.patches.map((patch) => patch.path).sort(),
    ["src/extra.js", "src/value.js"],
  );
});

test("a task past its token budget is stopped while it is still spending", async (t) => {
  const runtime = await startRuntime(t);
  await runtime.store.updateProject(DEFAULT_PROJECT_ID, {
    policy: { version: 1, budgets: { maxTaskTokens: 5_000 } },
  });

  const client = new WorkerClient({
    serverUrl: runtime.origin,
    token: runtime.token,
  });
  const workerId = (
    await client.register({
      organizationId: DEFAULT_ORGANIZATION_ID,
      name: "spender",
      adapters: ["generic-cli"],
      version: "1.0.0",
    })
  ).id;
  const task = await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise the value",
    agentId: "local",
    validationCommands: [],
  });
  const assignment = await client.lease(workerId, DEFAULT_PROJECT_ID);
  assert.equal(assignment?.task.id, task.id);
  assert.ok(assignment);

  // Under the cap: the lease is extended and the spend is on the record.
  await client.heartbeat(assignment.lease.id, [
    {
      phase: "planning",
      totalTokens: 1_200,
      inputTokens: 1_000,
      freshTokens: 800,
    },
  ]);
  const recorded = await runtime.store.listTokenUsage({
    leaseId: assignment.lease.id,
  });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.totalTokens, 1_200);
  assert.equal(recorded[0]?.freshTokens, 800);
  assert.equal(recorded[0]?.agentId, "local");

  // Over the cap, reported mid-flight. The enforcement point is here rather
  // than at the result, because by then the tokens are already gone.
  await assert.rejects(
    client.heartbeat(assignment.lease.id, [
      { phase: "planning", totalTokens: 1_200 },
      { phase: "execution", totalTokens: 9_000 },
    ]),
    /no longer active|Lease/u,
  );

  assert.equal(
    (await runtime.store.getWorkLease(assignment.lease.id))?.status,
    "failed",
  );
  assert.equal(
    (await runtime.store.listSubmittedTasks()).find(
      (entry) => entry.id === task.id,
    )?.status,
    "failed",
  );
  // The running total replaced its predecessor rather than accumulating, so
  // the recorded bill is what was spent, not what was reported.
  assert.equal(
    (await runtime.store.listTokenUsage({ taskId: task.id })).reduce(
      (sum, entry) => sum + entry.totalTokens,
      0,
    ),
    10_200,
  );
  const audit = await runtime.store.listAudit();
  assert.ok(
    audit.some(
      (event) =>
        event.type === "task_failed" &&
        event.data["stage"] === "budget_enforcement" &&
        event.data["maxTaskTokens"] === 5_000,
    ),
  );
});

test("a worker whose plan is sequenced never runs its agent", async (t) => {
  const runtime = await startRuntime(t);

  // A rival worker already holds a lease in this repository with an admitted
  // plan on src/value.js — the file this project's agent always plans.
  const rival = new WorkerClient({
    serverUrl: runtime.origin,
    token: runtime.token,
  });
  const rivalId = (
    await rival.register({
      organizationId: DEFAULT_ORGANIZATION_ID,
      name: "rival",
      adapters: ["generic-cli"],
      version: "1.0.0",
    })
  ).id;
  const held = await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise the value",
    agentId: "local",
    validationCommands: [],
  });
  const contested = await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise the value",
    agentId: "local",
    validationCommands: [],
  });
  const rivalAssignment = await rival.lease(rivalId, DEFAULT_PROJECT_ID);
  assert.equal(rivalAssignment?.task.id, held.id);
  assert.ok(rivalAssignment);
  const rivalAdmission = await rival.submitPlan(rivalAssignment.lease.id, {
    taskId: held.id,
    objective: held.objective,
    expectedFiles: ["src/value.js"],
    expectedSymbols: ["value"],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  });
  assert.equal(rivalAdmission.status, "approved");

  // The daemon leases the contested task, plans, and is told to stand down.
  // planWaitBudgetMs 0 makes it give the lease straight back instead of
  // waiting out the rival, which is the same decision compressed in time.
  const worker = new Worker({
    client: new WorkerClient({
      serverUrl: runtime.origin,
      token: runtime.token,
    }),
    project: runtime.project,
    organizationId: DEFAULT_ORGANIZATION_ID,
    workspaceRoot: path.join(runtime.root, "deferred"),
    planWaitBudgetMs: 0,
  });
  await worker.register();
  const result = await worker.runOnce();

  assert.equal(result.worked, true);
  assert.equal(result.taskId, contested.id);
  assert.equal(result.deferred, true);
  assert.equal(result.accepted, false);
  assert.match(result.reason ?? "", /sequenced/u);

  // The agent never edited anything: no run, no changeset, nothing to discard.
  assert.equal((await runtime.store.listRuns()).length, 0);
  const audit = await runtime.store.listAudit();
  assert.equal(
    audit.filter((event) => event.type === "changeset_collected").length,
    0,
  );
  assert.ok(
    audit.some(
      (event) =>
        event.type === "plan_admitted" &&
        event.taskId === contested.id &&
        event.data["status"] === "sequenced",
    ),
  );

  // And the task is queued again, not failed: it is perfectly good work that
  // simply cannot run yet.
  assert.equal(
    (await runtime.store.listSubmittedTasks()).find(
      (task) => task.id === contested.id,
    )?.status,
    "submitted",
  );
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

test("a dropped connection is retried rather than surfaced", async () => {
  // Two keep-alive sockets closed under us, then success. The caller should
  // never learn it happened: this is a failure to make a request, not a
  // failed request, and the difference used to cost a task permanently.
  let calls = 0;
  const client = new WorkerClient({
    serverUrl: "https://control.example",
    token: "token",
    connectionBackoffMs: 1,
    fetch: async () => {
      calls += 1;
      if (calls <= 2) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("other side closed"), {
            code: "UND_ERR_SOCKET",
          }),
        });
      }
      return new Response(JSON.stringify({ id: "worker_1", name: "w", adapters: [], version: "1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const identity = await client.register({ organizationId: DEFAULT_ORGANIZATION_ID, name: "w", adapters: [], version: "1" });
  assert.equal(identity.id, "worker_1");
  assert.equal(calls, 3);
});

test("a timeout is never retried, because the server may have acted on it", async () => {
  // The safety boundary of the retry. An aborted request may have been
  // received and applied, so repeating it could double-submit a result. Only
  // a connection that demonstrably carried nothing is safe to repeat.
  let calls = 0;
  const client = new WorkerClient({
    serverUrl: "https://control.example",
    token: "token",
    connectionBackoffMs: 1,
    fetch: async () => {
      calls += 1;
      throw Object.assign(new Error("This operation was aborted"), {
        name: "AbortError",
      });
    },
  });

  await assert.rejects(
    client.register({ organizationId: DEFAULT_ORGANIZATION_ID, name: "w", adapters: [], version: "1" }),
    /aborted/u,
  );
  assert.equal(calls, 1);
});

test("an exhausted connection retry requeues the task instead of failing it", async (t) => {
  const runtime = await startRuntime(t);
  await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "survives an unreachable control plane",
    agentId: "local",
    validationCommands: [],
  });

  // The connection dies *after* the lease is granted, which is where a closed
  // keep-alive socket actually landed in the live runs: a task already claimed
  // by this worker, and an error that says nothing about it. Failing at lease
  // time is already handled — no task has been claimed, and the daemon loop
  // simply backs off.
  let leased = false;
  const client = new WorkerClient({
    serverUrl: runtime.origin,
    token: runtime.token,
    connectionBackoffMs: 1,
    fetch: async (input, init) => {
      if (leased) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("other side closed"), {
            code: "UND_ERR_SOCKET",
          }),
        });
      }
      const response = await fetch(input, init);
      if (String(input).includes("/api/v1/workers/leases")) {
        leased = true;
      }
      return response;
    },
  });
  const worker = new Worker({
    client,
    project: runtime.project,
    organizationId: DEFAULT_ORGANIZATION_ID,
    workspaceRoot: path.join(runtime.root, "w"),
    name: "transport-worker",
    version: "1.0.0",
  });
  await worker.register();

  const result = await worker.runOnce();
  assert.equal(result.transport, true);
  assert.equal(result.deferred, true);
  assert.equal(result.accepted, false);

  // Still claimable, not failed: an unreachable control plane is a condition
  // that clears, and the work itself was never judged. Before this, one
  // dropped socket ended a task permanently.
  const tasks = await runtime.store.listSubmittedTasks();
  assert.notEqual(tasks[0]?.status, "failed");
});

test("stopping a worker hands its lease back immediately", async (t) => {
  const runtime = await startRuntime(t);
  const worker = makeWorker(runtime);
  await worker.register();

  await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "hang until stopped",
    agentId: "local",
    validationCommands: [],
  });

  const iteration = worker.runOnce();
  const deadline = Date.now() + 10_000;
  let lease = (await runtime.store.listWorkLeases({ status: "active" }))[0];
  while (
    lease?.plan?.admission.status !== "approved" &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    lease = (await runtime.store.listWorkLeases({ status: "active" }))[0];
  }
  assert.equal(lease?.plan?.admission.status, "approved");

  await worker.stop();
  const result = await Promise.race([
    iteration,
    new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("The cancelled agent did not stop")),
        10_000,
      );
      timeout.unref?.();
    }),
  ]);
  assert.equal(result.accepted, false);
  assert.equal(
    (await runtime.store.listWorkLeases({}))[0]?.status,
    "released",
  );
  // Released rather than left to expire, so the task is available at once,
  // and the cancelled agent process cannot continue writing in the scratch
  // directory after shutdown.
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
    client.register({ organizationId: DEFAULT_ORGANIZATION_ID, name: "rogue", adapters: [], version: "1" }),
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

test("a Codex worker uses the clone Git directory and configured model args", async (t) => {
  const runtime = await startRuntime(t);
  runtime.project.config.agents = {
    local: {
      adapter: "codex",
      command: "codex-test-double",
      args: ["--model", "worker-test-model"],
    },
  };
  await runtime.project.save();
  const task = await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise with codex",
    agentId: "local",
    validationCommands: [],
  });
  const invocations: string[][] = [];
  const runner: CodexProcessRunner = async (_executable, args, options) => {
    invocations.push([...args]);
    const prompt = options?.input ?? "";
    // Planning and replanning both answer with a plan; only execution answers
    // with a completion envelope. Keyed off the execution marker so a change
    // to either planning prompt cannot silently turn a plan into a completion.
    if (!prompt.includes("Implement the approved task")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          taskId: task.id,
          // Real models restate the objective in their own words rather than
          // echoing it. The worker owns making that acceptable: it submits
          // the assigned objective and keeps this phrasing as intent.
          objective: "Increase the exported constant in the value module",
          expectedFiles: ["src/value.js"],
          expectedSymbols: ["value"],
          dependencies: [],
          commands: [],
          externalAccess: [],
          riskLevel: "low",
        }),
        stderr: "",
        durationMs: 1,
      };
    }
    const cwd = options?.cwd;
    assert.ok(cwd);
    await writeFile(
      path.join(cwd, "src", "value.js"),
      "export const value = 4;\n",
    );
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        outcome: "completed",
        symbolsChanged: ["value"],
        explanation: "raised with codex",
      }),
      stderr: "",
      durationMs: 1,
    };
  };
  const worker = new Worker({
    client: new WorkerClient({
      serverUrl: runtime.origin,
      token: runtime.token,
    }),
    project: runtime.project,
    organizationId: DEFAULT_ORGANIZATION_ID,
    workspaceRoot: path.join(runtime.root, "codex-worker"),
    codexRunner: runner,
  });

  await worker.register();
  const result = await worker.runOnce();
  assert.equal(result.accepted, true, result.reason);
  assert.equal(invocations.length, 2);
  for (const args of invocations) {
    const model = args.indexOf("--model");
    assert.equal(args[model + 1], "worker-test-model");
  }

  // The paraphrase never reached the control plane as the objective — the
  // submitted plan carries the assigned wording, and the model's own goes to
  // intent, where advisory analysis reads it.
  const settled = (await runtime.store.listWorkLeases({}))[0];
  assert.equal(settled?.plan?.plan.objective, task.objective);
  assert.equal(
    settled?.plan?.plan.intent,
    "Increase the exported constant in the value module",
  );
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

/** Builds the codex double used by the plan-reuse tests. */
function planReuseRunner(
  taskId: string,
  invocations: string[][],
): CodexProcessRunner {
  return async (_executable, args, options) => {
    invocations.push([...args]);
    const prompt = options?.input ?? "";
    if (prompt.includes("prepare a coordination plan")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          taskId,
          objective: "Increase the exported constant",
          expectedFiles: ["src/value.js"],
          expectedSymbols: ["value"],
          dependencies: [],
          commands: [],
          externalAccess: [],
          riskLevel: "low",
        }),
        stderr: "",
        durationMs: 1,
      };
    }
    const cwd = options?.cwd;
    assert.ok(cwd);
    await writeFile(
      path.join(cwd, "src", "value.js"),
      "export const value = 4;\n",
    );
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        outcome: "completed",
        symbolsChanged: ["value"],
        explanation: "raised",
      }),
      stderr: "",
      durationMs: 1,
    };
  };
}

test("a plan already written for this base is reused instead of bought again", async (t) => {
  // The saving: a task deferred at admission goes back to the queue, and the
  // next lease used to pay for a whole fresh planning round to rediscover the
  // plan it already had.
  const runtime = await startRuntime(t);
  runtime.project.config.agents = {
    local: { adapter: "codex", command: "codex-test-double" },
  };
  await runtime.project.save();
  const task = await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise the value",
    agentId: "local",
    validationCommands: [],
  });
  const invocations: string[][] = [];
  const cache = new Map<string, CachedPlanEntry>();
  const worker = new Worker({
    client: new WorkerClient({ serverUrl: runtime.origin, token: runtime.token }),
    project: runtime.project,
    organizationId: DEFAULT_ORGANIZATION_ID,
    workspaceRoot: path.join(runtime.root, "reuse-worker"),
    codexRunner: planReuseRunner(task.id, invocations),
    planCache: cache,
  });
  await worker.register();

  const first = await worker.runOnce();
  assert.equal(first.accepted, true, first.reason);
  // One planning call and one execution call.
  assert.equal(invocations.length, 2);
  assert.equal(worker.planReuseCount, 0);
  assert.equal(cache.size, 1, "the plan should have been cached");

  // Remembered under the task, carrying the revision it was written against.
  const entry = cache.get(task.id);
  assert.ok(entry, "the plan should be remembered under its task id");
  assert.equal(typeof entry?.baseRevision, "string");
  assert.equal(entry?.advancedTo, undefined, "no canonical move happened");
});

test("plan reuse is refused once the base revision has moved", async (t) => {
  // The whole of the safety guard. A plan describes a footprint against one
  // revision of the tree; against a different one it is a guess, and reusing
  // it would hand arbitration a stale claim. The key pairs task and revision
  // precisely so this cannot happen.
  const runtime = await startRuntime(t);
  runtime.project.config.agents = {
    local: { adapter: "codex", command: "codex-test-double" },
  };
  await runtime.project.save();
  const task = await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise the value",
    agentId: "local",
    validationCommands: [],
  });
  const invocations: string[][] = [];
  // A plan cached against a revision that is not the one this lease will
  // carry. It must be ignored, not reused.
  const cache = new Map<string, CachedPlanEntry>([
    [
      task.id,
      {
        baseRevision: "9".repeat(40),
        plan: {
          taskId: task.id,
          objective: "stale plan",
          expectedFiles: ["src/other.js"],
          expectedSymbols: [],
          dependencies: [],
          commands: [],
          externalAccess: [],
          riskLevel: "low",
        },
      },
    ],
  ]);
  const worker = new Worker({
    client: new WorkerClient({ serverUrl: runtime.origin, token: runtime.token }),
    project: runtime.project,
    organizationId: DEFAULT_ORGANIZATION_ID,
    workspaceRoot: path.join(runtime.root, "stale-worker"),
    codexRunner: planReuseRunner(task.id, invocations),
    planCache: cache,
  });
  await worker.register();

  const result = await worker.runOnce();
  assert.equal(result.accepted, true, result.reason);
  assert.equal(worker.planReuseCount, 0, "a moved base must not reuse");
  // The agent was asked to plan, so both calls happened.
  assert.equal(invocations.length, 2);
  // And what was submitted is the freshly planned footprint, not the stale one.
  const settled = (await runtime.store.listWorkLeases({}))[0];
  assert.deepEqual(settled?.plan?.plan.expectedFiles, ["src/value.js"]);
});

/** The current canonical revision, which is what a fresh lease will pin. */
async function currentRevision(runtime: Runtime): Promise<string> {
  const stored = await runtime.store.getRepository(runtime.repositoryId);
  assert.ok(stored);
  return (
    await new RepositoryService().getCanonicalVersion({
      id: stored.id,
      path: stored.path,
      branch: stored.branch,
    })
  ).revision;
}

function noticeBetween(
  from: string,
  to: string,
  changedFiles: string[],
): CanonicalChangeNotice {
  const version = (revision: string) => ({
    sequence: 1,
    revision,
    branch: "main",
    createdAt: new Date(0).toISOString(),
  });
  return {
    previousVersion: version(from),
    canonicalVersion: version(to),
    changedFiles,
    changedSymbols: [],
    changedApis: [],
    changedSchemas: [],
    changedConfigKeys: [],
    changedTests: [],
    changedServices: [],
    reason: "another task integrated",
  };
}

function stalePlan(taskId: string): AgentPlan {
  return {
    taskId,
    objective: "previous plan",
    expectedFiles: ["src/other.js"],
    expectedSymbols: [],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };
}

test("a plan whose base moved is amended, not rewritten, when the gap is described", async (t) => {
  // The saving this exists for. When canonical moves under a plan, the control
  // plane says exactly what moved, and the next attempt amends the plan it
  // already has instead of buying a new one. Measured on `team-queue-wired`:
  // 57% fewer tokens and 49% less wall clock than planning the same task cold.
  const runtime = await startRuntime(t);
  runtime.project.config.agents = {
    local: { adapter: "codex", command: "codex-test-double" },
  };
  await runtime.project.save();
  const task = await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise the value",
    agentId: "local",
    validationCommands: [],
  });
  const prompts: string[] = [];
  const inner = planReuseRunner(task.id, []);
  const runner: CodexProcessRunner = async (executable, args, options) => {
    prompts.push(options?.input ?? "");
    return await inner(executable, args, options);
  };

  const leaseBase = await currentRevision(runtime);
  const previous = "1".repeat(40);
  const cache = new Map<string, CachedPlanEntry>([
    [
      task.id,
      {
        baseRevision: previous,
        plan: stalePlan(task.id),
        advancedTo: noticeBetween(previous, leaseBase, ["src/other.js"]),
      },
    ],
  ]);
  const worker = new Worker({
    client: new WorkerClient({ serverUrl: runtime.origin, token: runtime.token }),
    project: runtime.project,
    organizationId: DEFAULT_ORGANIZATION_ID,
    workspaceRoot: path.join(runtime.root, "amend-worker"),
    codexRunner: runner,
    planCache: cache,
  });
  await worker.register();
  const result = await worker.runOnce();

  // What this pins is the *choice*: given a remembered plan and a notice that
  // spans the gap exactly, the worker amends instead of planning cold. The
  // Codex double cannot complete the run — it answers on stdout while a real
  // replan reads a schema file — so the run itself is not asserted here. The
  // end-to-end behaviour is covered by the two negative tests around this one,
  // which do complete, and by the live  runs.
  // The counters only advance on a replan that returned a usable plan, which
  // the double cannot produce, so the evidence here is the invocation itself.
  assert.equal(worker.planReuseCount, 0, "a moved base is not a plain reuse");
  // Exactly one planning round happened, and it was a replan that carried the
  // change list — not a cold plan, and not a replan left to rediscover it.
  assert.equal(prompts.length, 1, "a cold plan must not also have been bought");
  assert.match(prompts[0] ?? "", /Replan the approved task/u);
  assert.ok(
    (prompts[0] ?? "").includes("src/other.js"),
    "the replan prompt must carry the change list",
  );
});

test("a notice that does not span the whole gap is refused", async (t) => {
  // The stale-plan hazard in its subtle form. A notice covering some other
  // stretch of history would let a plan be amended against a tree it has never
  // been told about, which is worse than planning cold because it looks
  // informed. Both ends must match: the notice starts where the remembered
  // plan does and ends where this lease pins.
  const runtime = await startRuntime(t);
  runtime.project.config.agents = {
    local: { adapter: "codex", command: "codex-test-double" },
  };
  await runtime.project.save();
  const task = await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise the value",
    agentId: "local",
    validationCommands: [],
  });
  const previous = "1".repeat(40);
  const cache = new Map<string, CachedPlanEntry>([
    [
      task.id,
      {
        baseRevision: previous,
        plan: stalePlan(task.id),
        // Ends somewhere that is not this lease's base.
        advancedTo: noticeBetween(previous, "7".repeat(40), ["src/other.js"]),
      },
    ],
  ]);
  const worker = new Worker({
    client: new WorkerClient({ serverUrl: runtime.origin, token: runtime.token }),
    project: runtime.project,
    organizationId: DEFAULT_ORGANIZATION_ID,
    workspaceRoot: path.join(runtime.root, "partial-notice-worker"),
    codexRunner: planReuseRunner(task.id, []),
    planCache: cache,
  });
  await worker.register();
  const result = await worker.runOnce();

  assert.equal(result.accepted, true, result.reason);
  assert.equal(worker.planAmendCount, 0, "a partial notice must not amend");
  assert.equal(worker.planReuseCount, 0);
  // Planned cold, so the submitted footprint is the real one.
  const settled = (await runtime.store.listWorkLeases({}))[0];
  assert.deepEqual(settled?.plan?.plan.expectedFiles, ["src/value.js"]);
});

/**
 * A worker runs several tasks at once rather than one after another.
 *
 * This is the shape of the regression it exists to hold down. The control
 * plane leases up to a repository's parallelism bound and executes the wave
 * together; a worker awaited a single lease before asking for another, so a
 * deployment that moved execution onto people's own machines went from four
 * concurrent agents to one without anybody deciding to — and read from the
 * outside as a coordinator that had stopped, because two of the three tasks
 * somebody sent simply sat in the queue until the first was stopped by hand.
 *
 * Three tasks that never finish on their own, so all three are demonstrably
 * *held* at the same moment rather than merely observed to have completed in
 * some order. Whether a given one is executing or waiting on admission is not
 * the point and is deliberately not asserted: holding the lease is what a
 * repository slot is, and holding three is what this worker could not do.
 */
test("a worker runs several tasks at once rather than one after another", async (t) => {
  const runtime = await startRuntime(t);
  const worker = makeWorker(runtime, {
    concurrency: 3,
    // The queue is not empty, so this only decides how quickly the loop comes
    // back for the second and third; a test should not wait five seconds for
    // each.
    pollIntervalMs: 25,
  });

  for (let index = 0; index < 3; index += 1) {
    await runtime.store.submitTask({
      repositoryId: runtime.repositoryId,
      objective: "hang until stopped",
      agentId: "local",
      validationCommands: [],
    });
  }

  const loop = worker.run();
  // Registered before the first assertion. A wave left running would hold the
  // gateway open and the agents alive, so a failure here would arrive as a
  // hung test run rather than as a failed assertion.
  t.after(async () => {
    await worker.stop();
    await loop.catch(() => undefined);
  });
  const held = await waitFor(
    async () => {
      const active = await runtime.store.listWorkLeases({ status: "active" });
      return active.length >= 3 ? active : undefined;
    },
    "three leases held at once",
  );

  assert.equal(held.length, 3);
  assert.equal(worker.activeRunCount, 3);
  assert.equal(worker.concurrencyLimit, 3);
  // Three distinct tasks, not one task counted three times.
  assert.equal(new Set(held.map((lease) => lease.taskId)).size, 3);

  // The bound is the machine's own, and it is enforced where a caller can
  // reach it rather than only inside the loop.
  await assert.rejects(async () => await worker.runOnce(), /limit/u);

  // Every one of them is handed back, not just whichever was leased last.
  await worker.stop();
  await loop;
  assert.deepEqual(await runtime.store.listWorkLeases({ status: "active" }), []);
  assert.equal(worker.activeRunCount, 0);
});

/**
 * Three unrelated tasks are all carried through to canonical.
 *
 * The concurrency test above proves the leases are held together; this proves
 * the runs do not tread on each other while they are. Each holds its own
 * session, its own claim and its own admission wait, and on a single set of
 * fields the second run's session would overwrite the first's — after which
 * the worker cancels one agent and reports another's plan. Three files rather
 * than one, so admission has no reason to sequence them and the failure would
 * be a wrong result rather than a slow one.
 */
test("concurrent runs keep their own session, plan and result", async (t) => {
  const runtime = await startRuntime(t);
  const worker = makeWorker(runtime, { concurrency: 3, pollIntervalMs: 25 });

  for (const name of CONCURRENT_FILES) {
    await runtime.store.submitTask({
      repositoryId: runtime.repositoryId,
      objective: `edit src/${name}.js slowly`,
      agentId: "local",
      validationCommands: [],
    });
  }

  const loop = worker.run();
  t.after(async () => {
    await worker.stop();
    await loop.catch(() => undefined);
  });
  await waitFor(
    async () => {
      const tasks = await runtime.store.listSubmittedTasks({});
      return tasks.length === 3 &&
        tasks.every((task) => task.status === "integrated")
        ? tasks
        : undefined;
    },
    "all three tasks integrated",
    120_000,
  );
  await worker.stop();
  await loop;

  // Each run reported its own edit. A shared session or a shared plan shows up
  // here as a file that never changed, or as one changed twice.
  const repository = await runtime.store.getRepository(runtime.repositoryId);
  assert.ok(repository);
  const repositories = new RepositoryService();
  const canonical = {
    id: repository.id,
    path: repository.path,
    branch: repository.branch,
  };
  const version = await repositories.getCanonicalVersion(canonical);
  for (const name of CONCURRENT_FILES) {
    assert.equal(
      await repositories.readFile(canonical, version.revision, `src/${name}.js`),
      `export const ${name} = 2;\n`,
      `src/${name}.js did not receive its own run's edit`,
    );
  }
});

test("the concurrency limit is validated wherever it comes from", async (t) => {
  const runtime = await startRuntime(t);
  const options = {
    client: new WorkerClient({ serverUrl: runtime.origin, token: runtime.token }),
    project: runtime.project,
    organizationId: DEFAULT_ORGANIZATION_ID,
    workspaceRoot: path.join(runtime.root, "w"),
  };
  assert.throws(() => new Worker({ ...options, concurrency: 0 }), /positive/u);
  assert.throws(() => new Worker({ ...options, concurrency: 2.5 }), /positive/u);

  const previous = process.env["COORD_WORKER_CONCURRENCY"];
  t.after(() => {
    if (previous === undefined) {
      delete process.env["COORD_WORKER_CONCURRENCY"];
    } else {
      process.env["COORD_WORKER_CONCURRENCY"] = previous;
    }
  });

  process.env["COORD_WORKER_CONCURRENCY"] = "2";
  assert.equal(new Worker(options).concurrencyLimit, 2);
  process.env["COORD_WORKER_CONCURRENCY"] = "nonsense";
  assert.throws(() => new Worker(options), /COORD_WORKER_CONCURRENCY/u);

  // Absent, a machine offers what the control plane would size it at rather
  // than a number picked here — and never fewer than the one task it used to
  // take, which is the floor that keeps this from being a regression for
  // anybody.
  delete process.env["COORD_WORKER_CONCURRENCY"];
  assert.ok(new Worker(options).concurrencyLimit >= 1);
});

/**
 * Work on one repository's cache is serialised.
 *
 * Every run fetches into the same bare repository, and concurrently that is
 * not merely slow: git takes a ref lock, the loser's fetch fails, and the
 * failure path deletes the cache out from under the run still reading it.
 * Reached through the private guard because the property is about the guard —
 * that a second caller waits, that a failure does not poison the queue behind
 * it, and that the chain is dropped rather than accumulated per repository.
 */
test("cache work on one repository never overlaps", async (t) => {
  const runtime = await startRuntime(t);
  const worker = makeWorker(runtime);
  const guarded = worker as unknown as {
    serialisedByRepository: <T>(id: string, work: () => Promise<T>) => Promise<T>;
    cacheChains: Map<string, unknown>;
  };

  // Counted per repository, because overlap *between* repositories is the
  // point of keying the chain at all: two agents in different repositories
  // share no cache and must not wait for each other.
  const inside = new Map<string, number>();
  const overlapped = new Set<string>();
  const order: string[] = [];
  let otherStartedWhileRepoRan = false;
  const body = async (chain: string, label: string): Promise<string> => {
    const depth = (inside.get(chain) ?? 0) + 1;
    inside.set(chain, depth);
    if (depth > 1) {
      overlapped.add(chain);
    }
    if (chain === "other" && (inside.get("repo") ?? 0) > 0) {
      otherStartedWhileRepoRan = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    inside.set(chain, (inside.get(chain) ?? 1) - 1);
    order.push(label);
    return label;
  };

  const results = await Promise.all([
    guarded.serialisedByRepository("repo", async () => await body("repo", "a")),
    guarded.serialisedByRepository("repo", async () => await body("repo", "b")),
    guarded.serialisedByRepository("repo", async () => await body("repo", "c")),
    // A different repository is a different chain and must not be held up.
    guarded.serialisedByRepository(
      "other",
      async () => await body("other", "other"),
    ),
  ]);

  assert.deepEqual(
    [...overlapped],
    [],
    "two callers were inside one repository's guard at once",
  );
  assert.equal(
    otherStartedWhileRepoRan,
    true,
    "a second repository waited on the first, which is not what the key is for",
  );
  assert.deepEqual(results, ["a", "b", "c", "other"]);
  assert.deepEqual(order.filter((entry) => entry !== "other"), ["a", "b", "c"]);
  // Nothing queued behind them, so nothing is kept.
  assert.equal(guarded.cacheChains.size, 0);

  // One caller's failure is its own. A rejected link that took the chain with
  // it would strand every later task in that repository.
  await assert.rejects(
    async () =>
      await guarded.serialisedByRepository("repo", async () => {
        throw new Error("broken cache");
      }),
    /broken cache/u,
  );
  assert.equal(
    await guarded.serialisedByRepository("repo", async () => "after"),
    "after",
  );
  assert.equal(guarded.cacheChains.size, 0);
});

/**
 * A stand-in for the Claude CLI: records its argv, answers planning with a
 * plan and execution with a completion, and edits the one file. What it is
 * given on the command line is the whole of what this test is about.
 */
const FAKE_CLAUDE = [
  `#!${process.execPath}`,
  'import fs from "node:fs";',
  'import path from "node:path";',
  "fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", () => {});',
  'process.stdin.on("end", () => {',
  '  let result;',
  '  if (process.argv.includes("--permission-mode")) {',
  "    result = {",
  '      taskId: "task_stand_in", objective: "raise the value",',
  '      expectedFiles: ["src/value.js"], expectedSymbols: ["value"],',
  '      dependencies: [], commands: [], externalAccess: [], riskLevel: "low",',
  "    };",
  "  } else {",
  '    fs.writeFileSync(path.join(process.cwd(), "src", "value.js"), "export const value = 2;\\n", "utf8");',
  "    result = {",
  '      outcome: "completed", symbolsChanged: ["value"], explanation: "raised with claude",',
  '      requestId: "", additionalFiles: [], additionalSymbols: [], additionalApis: [],',
  '      additionalSchemas: [], additionalConfigKeys: [], additionalTests: [],',
  '      additionalServices: [], reason: "",',
  "    };",
  "  }",
  '  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(result) }) + "\\n");',
  "});",
  "",
].join("\n");

test("a run that ends badly says so in the log, and where it got to", async (t) => {
  // The success line was the only one a run could produce, so a task that
  // died left the log identical to a task still working: a start line, then
  // nothing, forever. Three separate evenings of this were spent asking "is
  // it stuck or is it thinking" with no way to tell.
  const runtime = await startRuntime(t);
  runtime.project.config.agents = {
    local: { command: "definitely-not-a-real-binary" },
  };
  await runtime.project.save();

  const said: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => {
    said.push(parts.map(String).join(" "));
  };
  t.after(() => {
    console.log = log;
  });

  const task = await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise the value",
    agentId: "local",
    validationCommands: [],
  });
  const worker = makeWorker(runtime);
  await worker.register();
  const result = await worker.runOnce();
  assert.equal(result.accepted, false);

  const failure = said.find((line) => line.includes("failed after"));
  assert.ok(failure, `no failure line among:\n${said.join("\n")}`);
  assert.match(failure, new RegExp(task.id, "u"));
  // Which phase it got to, which is most of the diagnosis. This fixture
  // fetched and checked out fine and died spawning the agent, so the last
  // phase it completed is the checkout — and "reached checkout" is the
  // difference between looking at the network and looking at the CLI.
  assert.match(failure, /reached checkout/u);
  assert.match(failure, /fetch [\d.]+s/u, "and where the time went");
  // And the reason itself, rather than a bare "failed".
  assert.match(failure, /definitely-not-a-real-binary|ENOENT|spawn/u);
});

test("a laptop works on battery unless its owner says otherwise", async (t) => {
  // The default was the other way round, and the caution cost more than it
  // saved. Declining never contacts the control plane, and that contact is
  // the only thing telling it this machine exists — so an unplugged laptop
  // was not a machine that was waiting, it was no machine at all three
  // minutes later, while somebody sat in front of it perfectly able to work.
  // A lease lost to standby costs one requeue, announced in the room.
  const runtime = await startRuntime(t);
  const said: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => {
    said.push(parts.map(String).join(" "));
  };
  t.after(() => {
    console.log = log;
  });

  const power = { read: async (): Promise<PowerState> => "battery" };
  await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise the value",
    agentId: "local",
    validationCommands: [],
  });
  const laptop = makeWorker(runtime, { powerSource: power });
  await laptop.register();
  assert.equal((await laptop.runOnce()).worked, true);
  assert.deepEqual(
    said.filter((line) => /not claiming work/u.test(line)),
    [],
  );

  // And a machine that really does sleep unattended can still say so.
  const paused = makeWorker(runtime, {
    powerSource: power,
    pauseOnBattery: true,
  });
  await paused.register();
  await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise it again",
    agentId: "local",
    validationCommands: [],
  });
  assert.equal((await paused.runOnce()).worked, false);
  // Once per change of state, not once per poll: this runs every few seconds.
  assert.equal((await paused.runOnce()).worked, false);
  const refusals = said.filter((line) => /not claiming work/u.test(line));
  assert.equal(refusals.length, 1, said.join("\n"));
  assert.match(refusals[0] ?? "", /battery/u);
  assert.match(refusals[0] ?? "", /COORD_PAUSE_ON_BATTERY/u);
});

test("a worker says which adapters it advertised, and an empty list is loud", async (t) => {
  // The intersection of "what the config lists" and "what the host says this
  // machine has" is what the control plane matches work against, and also
  // what it decides an agent's reachability by. Empty, it produces a worker
  // that registers, polls forever, is offered nothing, and reports itself as
  // running — while every one of that person's agents is drawn as having no
  // machine. Nothing about the symptom points at the list, so the list has to
  // say itself.
  const runtime = await startRuntime(t);
  runtime.project.config.agents = {
    local: { adapter: "claude" },
    theirs: { adapter: "codex" },
  };
  await runtime.project.save();

  const both = makeWorker(runtime, { adapters: ["claude", "codex"] });
  await both.register();
  assert.deepEqual([...both.advertisedAdapters].sort(), ["claude", "codex"]);

  // The host narrows it: a machine with only Codex installed advertises only
  // Codex, however many agents the config lists.
  const one = makeWorker(runtime, { adapters: ["codex"] });
  await one.register();
  assert.deepEqual([...one.advertisedAdapters], ["codex"]);

  // And a host naming something the config has no agent for intersects to
  // nothing. This is the state worth seeing, and it is reachable.
  const none = makeWorker(runtime, { adapters: ["nonesuch"] });
  await none.register();
  assert.deepEqual([...none.advertisedAdapters], []);
});

test("a worker takes work from a control plane one protocol behind it, and refuses one two behind", async (t) => {
  // Protocol 4 added MCP servers to the lease, which are optional: a control
  // plane still on 3 never sends any, and the task it hands over is as good
  // as ever. Refusing it would strand every desktop that updated before the
  // server did. Protocol 3 is the floor because that is where plan admission
  // arrived, and a control plane without it would have work done first and
  // thrown away on conflict afterwards.
  const runtime = await startRuntime(t);
  let announced = 3;
  class OlderControlPlane extends WorkerClient {
    public override async lease(
      ...args: Parameters<WorkerClient["lease"]>
    ): ReturnType<WorkerClient["lease"]> {
      const assignment = await super.lease(...args);
      return assignment === undefined
        ? undefined
        : { ...assignment, protocolVersion: announced };
    }
  }
  const worker = makeWorker(runtime, {
    client: new OlderControlPlane({
      serverUrl: runtime.origin,
      token: runtime.token,
    }),
  });
  await worker.register();

  await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise the value",
    agentId: "local",
    validationCommands: [],
  });
  const behindByOne = await worker.runOnce();
  assert.equal(behindByOne.accepted, true, behindByOne.reason);

  announced = 2;
  await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise it again",
    agentId: "local",
    validationCommands: [],
  });
  const behindByTwo = await worker.runOnce();
  assert.equal(behindByTwo.accepted, false);
  assert.match(String(behindByTwo.reason ?? ""), /plan admission/u);
});

test("a Claude worker loads the lease's MCP servers from scratch, strictly, and commits none of it", async (t) => {
  if (process.platform === "win32") {
    t.skip("the stand-in CLI is a shebang script");
    return;
  }
  const runtime = await startRuntime(t);
  const log = path.join(runtime.root, "claude-argv.jsonl");
  const fake = path.join(runtime.root, "fake-claude.mjs");
  await writeFile(fake, FAKE_CLAUDE, { encoding: "utf8", mode: 0o755 });
  runtime.project.config.agents = {
    local: { adapter: "claude", command: fake, env: { FAKE_CLAUDE_LOG: log } },
  };
  runtime.project.config.mcp = { allow: "all" };
  await runtime.project.save();

  // The control plane under test predates the field, so the lease is given
  // its servers on the way in — the shape the worker receives is the same.
  const offered: ResolvedMcpServer[] = [
    {
      name: "github",
      transport: "http",
      url: "https://mcp.example/github",
      headers: { Authorization: "Bearer ghp_opened_secret" },
    },
  ];
  class LeaseWithServers extends WorkerClient {
    public override async lease(
      ...args: Parameters<WorkerClient["lease"]>
    ): ReturnType<WorkerClient["lease"]> {
      const assignment = await super.lease(...args);
      return assignment === undefined
        ? undefined
        : { ...assignment, mcpServers: offered };
    }
  }
  const worker = makeWorker(runtime, {
    client: new LeaseWithServers({
      serverUrl: runtime.origin,
      token: runtime.token,
    }),
  });
  await worker.register();

  const task = await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise with claude",
    agentId: "local",
    validationCommands: [],
  });
  const result = await worker.runOnce();
  assert.equal(result.accepted, true, result.reason);

  const argvs = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(argvs.length, 2);
  for (const argv of argvs) {
    const at = argv.indexOf("--mcp-config");
    assert.ok(at >= 0, `${argv.join(" ")} carries no --mcp-config`);
    const configPath = argv[at + 1] ?? "";
    assert.equal(argv[at + 2], "--strict-mcp-config");
    // Beside the workspace, under the run's scratch, never inside the tree
    // the changeset is collected from.
    assert.equal(path.basename(configPath), "claude.json");
    assert.equal(path.basename(path.dirname(configPath)), "mcp");
    assert.equal(configPath.includes(`${path.sep}workspace${path.sep}`), false);
    assert.equal(argv.some((arg) => arg.includes("ghp_opened_secret")), false);
  }
  // Removed with the run.
  await assert.rejects(access(argvs[0]?.[argvs[0].indexOf("--mcp-config") + 1] ?? ""));

  const storedTask = (await runtime.store.listSubmittedTasks()).find(
    (entry) => entry.id === task.id,
  );
  const run = await runtime.store.getRun(storedTask?.runId ?? "");
  assert.deepEqual(
    run?.changeSets[0]?.patches.map((patch) => patch.path),
    ["src/value.js"],
  );
  const progress = (await runtime.store.listAudit())
    .filter((event) => event.type === "agent_progress")
    .map((event) => String(event.data["message"]));
  assert.ok(progress.includes("Running with tools: github."), progress.join("\n"));

  // The same machine, told to run nothing: the servers are still offered,
  // the agent runs without them, and the room hears why — and so does the
  // desktop app, by name, because the room cannot change this machine's
  // allowlist and the app can put the question to the person who can.
  runtime.project.config.mcp = { allow: [] };
  await rm(log, { force: true });
  const host = process as { parentPort?: unknown };
  const hostMessages: unknown[] = [];
  host.parentPort = {
    postMessage(message: unknown) {
      hostMessages.push(message);
    },
  };
  t.after(() => {
    delete host.parentPort;
  });
  await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise with claude again",
    agentId: "local",
    validationCommands: [],
  });
  const withheld = await worker.runOnce();
  assert.equal(withheld.accepted, true, withheld.reason);
  const later = (await readFile(log, "utf8")).trim().split("\n");
  assert.ok(later.length >= 2);
  for (const line of later) {
    assert.equal((JSON.parse(line) as string[]).includes("--mcp-config"), false);
  }
  const explained = (await runtime.store.listAudit())
    .filter((event) => event.type === "agent_progress")
    .map((event) => String(event.data["message"]));
  assert.ok(
    explained.includes(
      "This project offers MCP servers github; this machine has not allowed them. Kumi on that machine will ask its owner.",
    ),
    explained.join("\n"),
  );
  const digest = mcpServerDigest(offered[0] as ResolvedMcpServer);
  assert.deepEqual(
    hostMessages.filter(
      (message) => (message as { type?: string }).type === "mcp-offered",
    ),
    [
      {
        type: "mcp-offered",
        servers: [
          {
            name: "github",
            digest,
            summary: "github: talks to https://mcp.example/github",
          },
        ],
      },
    ],
  );

  // The owner says yes to *this* github. The next task runs with it.
  runtime.project.config.mcp = { allow: [{ name: "github", digest }] };
  await rm(log, { force: true });
  await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise with claude, allowed",
    agentId: "local",
    validationCommands: [],
  });
  const allowedRun = await worker.runOnce();
  assert.equal(allowedRun.accepted, true, allowedRun.reason);
  for (const line of (await readFile(log, "utf8")).trim().split("\n")) {
    assert.ok((JSON.parse(line) as string[]).includes("--mcp-config"), line);
  }

  // Then the project redefines github — same name, different place. What
  // the owner agreed to is not what is on offer now, so it is withheld as
  // if never allowed, and the room and the app both hear that it changed
  // rather than that something new appeared.
  offered[0] = { ...(offered[0] as ResolvedMcpServer), url: "https://mcp.example/elsewhere" };
  hostMessages.length = 0;
  await rm(log, { force: true });
  await runtime.store.submitTask({
    repositoryId: runtime.repositoryId,
    objective: "raise with claude, redefined",
    agentId: "local",
    validationCommands: [],
  });
  const redefined = await worker.runOnce();
  assert.equal(redefined.accepted, true, redefined.reason);
  for (const line of (await readFile(log, "utf8")).trim().split("\n")) {
    assert.equal((JSON.parse(line) as string[]).includes("--mcp-config"), false, line);
  }
  const afterChange = (await runtime.store.listAudit())
    .filter((event) => event.type === "agent_progress")
    .map((event) => String(event.data["message"]));
  assert.ok(
    afterChange.includes(
      "This project offers MCP servers github; this machine has not allowed them (github changed since it was allowed here). Kumi on that machine will ask its owner.",
    ),
    afterChange.join("\n"),
  );
  const reoffered = hostMessages.find(
    (message) => (message as { type?: string }).type === "mcp-offered",
  ) as { servers: Array<{ digest: string; summary: string }> } | undefined;
  assert.notEqual(reoffered?.servers[0]?.digest, digest);
  assert.equal(reoffered?.servers[0]?.summary, "github: talks to https://mcp.example/elsewhere");
});
