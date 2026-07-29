// Live end-to-end proof: a real Codex worker completes a dispatched task
// through the real HTTP control plane, with real (paraphrased) model output.
// Run from apps/worker: node <this file>
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ApiGateway } from "@coord/api-gateway";
import { CoordinatorProject } from "@coord/cli/project";
import { workerOperations } from "@coord/cli/worker-operations";
import { SqliteCoordinationStore } from "@coord/persistence";
import { RepositoryService } from "@coord/repository-service";

import { WorkerClient } from "../dist/client.js";
import { Worker } from "../dist/worker.js";

const BOOTSTRAP_TOKEN = "bootstrap-token-live-objective-echo";
const CODEX = "C:\\Users\\nward\\.codex\\.sandbox-bin\\codex.exe";

const root = await mkdtemp(path.join(os.tmpdir(), "cwl-"));
try {
  const projectRoot = path.join(root, "cp");
  await mkdir(projectRoot, { recursive: true });
  const project = await CoordinatorProject.init(projectRoot);
  project.config.validationCommands = [];
  project.config.agents = {
    local: { adapter: "codex", command: CODEX, windowsSandbox: "unelevated" },
  };
  project.config.defaultAgent = "local";
  await project.save();

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
    "repo_live",
    "main",
  );

  const store = SqliteCoordinationStore.open(path.join(root, "state.db"));
  await store.saveRepository({
    id: canonical.id,
    path: canonical.path,
    branch: canonical.branch,
  });
  const operations = {
    async createRepository() { throw new Error("not used"); },
    async importGitHub() { throw new Error("not used"); },
    async submitTask() { throw new Error("not used"); },
    async runRepository() {},
    ...workerOperations(project, store),
  };
  const gateway = new ApiGateway({ store, operations, bootstrapToken: BOOTSTRAP_TOKEN });
  await new Promise((resolve, reject) => {
    gateway.server.once("error", reject);
    gateway.server.listen(0, "127.0.0.1", resolve);
  });
  const address = gateway.server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const cookies = [];
  const setup = await fetch(`${origin}/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bootstrap-Token": BOOTSTRAP_TOKEN },
    body: JSON.stringify({ email: "owner@example.com", displayName: "Owner", password: "RelayPassword123!" }),
  });
  assert.equal(setup.status, 201);
  for (const cookie of setup.headers.getSetCookie()) {
    cookies.push(cookie.split(";")[0] ?? "");
  }
  const csrf = /coord_csrf=([^;]+)/u.exec(cookies.join("; "))?.[1] ?? "";
  const issued = await fetch(`${origin}/api/v1/auth/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookies.join("; "), "X-CSRF-Token": csrf },
    body: JSON.stringify({ name: "fleet", scopes: ["view", "run_task"] }),
  });
  assert.equal(issued.status, 201);
  const token = (await issued.json()).token;

  const task = await store.submitTask({
    repositoryId: canonical.id,
    objective:
      "Raise the exported value constant so downstream consumers see a higher default",
    agentId: "local",
    validationCommands: [],
  });

  const worker = new Worker({
    client: new WorkerClient({ serverUrl: origin, token }),
    project,
    workspaceRoot: path.join(root, "w"),
    name: "live-proof-worker",
    version: "1.0.0",
  });
  await worker.register();
  const startedAt = Date.now();
  const result = await worker.runOnce();
  const elapsed = Math.round((Date.now() - startedAt) / 1000);

  const lease = (await store.listWorkLeases({}))[0];
  const settledTask = (await store.listSubmittedTasks()).find((entry) => entry.id === task.id);
  const version = await repositories.getCanonicalVersion(canonical);
  console.log(JSON.stringify({
    accepted: result.accepted,
    reason: result.reason,
    elapsedSeconds: elapsed,
    taskStatus: settledTask?.status,
    planObjective: lease?.plan?.plan.objective,
    assignedObjective: task.objective,
    objectiveEchoed: lease?.plan?.plan.objective === task.objective,
    modelIntent: lease?.plan?.plan.intent,
    expectedFiles: lease?.plan?.plan.expectedFiles,
    admissionStatus: lease?.plan?.admission.status,
    admissionExplanation: lease?.plan?.admission.explanation,
    canonicalRevision: version.revision,
  }, undefined, 2));
  await gateway.close();
  await store.close();
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
