#!/usr/bin/env node
/**
 * Manual verification for hosted execution with container isolation.
 *
 * `verify-docker-sandbox.mjs` covers the local path: one process that owns the
 * canonical repository, creates worktrees, and runs an agent in a container.
 * This script covers the case the sandbox actually exists for — an untrusted
 * agent on a worker that owns nothing, talking to a control plane over HTTP.
 *
 * Nothing here is a stub. A real control plane binds a port, a real worker
 * daemon leases a task, downloads a Git bundle, clones it, runs the reference
 * agent inside a container, and posts a changeset the control plane validates
 * and promotes to canonical.
 *
 * Isolation is asserted from inside the container rather than from the flags
 * the host passed: with COORD_SANDBOX_PROBE=1 the reference agent probes its
 * own confinement and reports the verdicts in its completion explanation,
 * which travels with the changeset and is persisted. A run that integrates
 * therefore carries its own evidence.
 *
 * Usage:
 *   docker build -f infrastructure/docker/agent.Dockerfile -t coord/reference-agent:1 .
 *   npm run verify:remote-docker
 *
 * Environment:
 *   COORD_AGENT_IMAGE  Image to verify. Defaults to coord/reference-agent:1.
 *   COORD_AGENT_USER   Passed through as --user. Needed on Linux when the
 *                      container uid cannot write the host worktree.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ApiGateway } from "@coord/api-gateway";
import { CoordinatorProject } from "@coord/cli/project";
import { workerOperations } from "@coord/cli/worker-operations";
import { SqliteCoordinationStore } from "@coord/persistence";
import { RepositoryService, runProcess } from "@coord/repository-service";
import { DockerWorkspaceManager } from "@coord/workspace-manager";
import { Worker } from "@coord/worker/worker";
import { WorkerClient } from "@coord/worker/client";

const IMAGE = process.env.COORD_AGENT_IMAGE ?? "coord/reference-agent:1";
const USER = process.env.COORD_AGENT_USER;
const BOOTSTRAP_TOKEN = "bootstrap-token-for-remote-docker-verification";
const PASSWORD = "RelayPassword123!";

const COUNTER = [
  "export function increment(value) {",
  "  return Number(value) + 1;",
  "}",
  "",
].join("\n");

let failures = 0;

function report(name, ok, detail) {
  const status = ok ? "PASS" : "FAIL";
  console.log(`[${status}] ${name}${detail === undefined ? "" : ` - ${detail}`}`);
  if (!ok) {
    failures += 1;
  }
}

async function check(name, run) {
  try {
    const detail = await run();
    report(name, true, detail);
  } catch (error) {
    report(name, false, error instanceof Error ? error.message : String(error));
  }
}

function sandboxOptions() {
  return { image: IMAGE, ...(USER === undefined ? {} : { user: USER }) };
}

/**
 * A control plane on a real port with a Docker-sandboxed project, and the
 * bearer token a worker outside it would authenticate with.
 */
async function startControlPlane(root) {
  const projectRoot = path.join(root, "cp");
  await mkdir(projectRoot, { recursive: true });

  const project = await CoordinatorProject.init(projectRoot);
  // Validation runs on the control plane, and with a sandbox configured it
  // runs inside a container rather than as the control-plane process. A
  // command the reference image can actually execute is what makes that
  // visible rather than assumed.
  project.config.validationCommands = [
    // No positional arguments: the runner discovers `**/*.test.js` from the
    // working directory, which is the workspace mount. Commands are argument
    // arrays run without a shell, so a glob here would arrive as a literal.
    { executable: "node", args: ["--test"], label: "repository tests" },
  ];
  project.config.agents = {
    sandboxed: {
      adapter: "generic-cli",
      command: "node",
      args: ["/opt/agent/reference-agent.mjs"],
      env: { COORD_SANDBOX_PROBE: "1" },
    },
  };
  project.config.defaultAgent = "sandboxed";
  project.config.sandbox = {
    mode: "docker",
    image: IMAGE,
    ...(USER === undefined ? {} : { user: USER }),
  };
  await project.save();

  const sourcePath = path.join(root, "src-repo");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await mkdir(path.join(sourcePath, "test"), { recursive: true });
  await writeFile(path.join(sourcePath, "src", "counter.js"), COUNTER, "utf8");
  await writeFile(
    path.join(sourcePath, "test", "placeholder.test.js"),
    ['import test from "node:test";', 'test("seed", () => {});', ""].join("\n"),
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

  const operations = {
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
  const gateway = new ApiGateway({
    store,
    operations,
    bootstrapToken: BOOTSTRAP_TOKEN,
  });
  await new Promise((resolve, reject) => {
    gateway.server.once("error", reject);
    gateway.server.listen(0, "127.0.0.1", resolve);
  });
  const address = gateway.server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  // Bootstrap an owner and mint a run_task token, exactly as an operator would.
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
  if (setup.status !== 201) {
    throw new Error(`bootstrap failed with ${setup.status}`);
  }
  const cookies = setup.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "");
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
  if (issued.status !== 201) {
    throw new Error(`token issue failed with ${issued.status}`);
  }
  const { token } = await issued.json();

  return {
    origin,
    store,
    project,
    gateway,
    token,
    repositories,
    repositoryId: canonical.id,
    canonical,
  };
}

async function main() {
  console.log(`Verifying hosted execution with image ${IMAGE}\n`);

  const probe = new DockerWorkspaceManager(sandboxOptions());
  await check("docker daemon is reachable", async () => {
    await probe.assertAvailable();
    return "docker version responded";
  });
  if (failures > 0) {
    console.log("\nDocker is unavailable; skipping the remaining checks.");
    process.exitCode = 1;
    return;
  }

  // The first container off a freshly built image can take longer to start
  // than an agent's planning timeout allows, which would be reported as an
  // agent that never answered rather than as the cold start it is. Paying
  // that cost here keeps the measurement about the coordinator.
  await check("the agent image starts", async () => {
    const launch = probe.wrapLaunch({
      command: "node",
      args: ["-e", "process.stdout.write('ready')"],
    });
    const result = await runProcess(launch.command, launch.args, {
      timeoutMs: 180_000,
    });
    if (result.exitCode !== 0 || !result.stdout.includes("ready")) {
      throw new Error(
        result.stderr.trim() || `image did not start (exit ${result.exitCode})`,
      );
    }
    return `${IMAGE} is warm`;
  });
  if (failures > 0) {
    console.log("\nThe agent image is unusable; skipping the remaining checks.");
    process.exitCode = 1;
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "coord-remote-"));
  let plane;
  try {
    plane = await startControlPlane(root);

    const worker = new Worker({
      client: new WorkerClient({
        serverUrl: plane.origin,
        token: plane.token,
      }),
      project: plane.project,
      workspaceRoot: path.join(root, "w"),
      name: "verify-remote-docker",
      version: "1.0.0",
    });

    await check("a worker registers against the live control plane", async () => {
      const id = await worker.register();
      const fleet = await plane.store.listWorkers();
      if (!fleet.some((entry) => entry.id === id)) {
        throw new Error("the registered worker is not in the fleet listing");
      }
      return `${id} advertises ${fleet[0]?.adapters.join(", ")}`;
    });

    const task = await plane.store.submitTask({
      repositoryId: plane.repositoryId,
      objective: "Cap the incremented value at ten",
      agentId: "sandboxed",
      validationCommands: plane.project.config.validationCommands,
    });

    let iteration;
    await check(
      "the worker plans, is admitted, and executes inside a container",
      async () => {
        const startedAt = Date.now();
        iteration = await worker.runOnce();
        const elapsedMs = Date.now() - startedAt;
        if (iteration.worked !== true || iteration.taskId !== task.id) {
          throw new Error(
            `worker did not take the task: ${JSON.stringify(iteration)}`,
          );
        }
        if (iteration.accepted !== true) {
          throw new Error(iteration.reason ?? "the result was not accepted");
        }
        return `leased, planned, admitted, executed, reported in ${elapsedMs} ms`;
      },
    );

    await check(
      "the containerized agent reported denied network, read-only root, and masked git",
      async () => {
        const tasks = await plane.store.listSubmittedTasks();
        const runId = tasks.find((entry) => entry.id === task.id)?.runId;
        if (runId === undefined) {
          throw new Error("the accepted result produced no durable run");
        }
        const detail = await plane.store.getRun(runId);
        const explanation = detail?.changeSets.at(-1)?.agentExplanation ?? "";
        const probe = /\[sandbox ([^\]]+)\]/u.exec(explanation)?.[1];
        if (probe === undefined) {
          throw new Error(
            `the agent reported no confinement probe: ${explanation}`,
          );
        }
        const verdicts = new Set(probe.split(" "));
        for (const expected of [
          "rootfs=readonly",
          "git=masked",
          "network=denied",
        ]) {
          if (!verdicts.has(expected)) {
            throw new Error(`expected ${expected}, agent reported: ${probe}`);
          }
        }
        return probe;
      },
    );

    await check(
      "the repository's own tests ran in a container, not as the control plane",
      async () => {
        const tasks = await plane.store.listSubmittedTasks();
        const runId = tasks.find((entry) => entry.id === task.id)?.runId;
        const detail = await plane.store.getRun(runId ?? "");
        const integration = detail?.integrations.at(-1);
        const validation = integration?.validation ?? [];
        if (validation.length === 0) {
          throw new Error("the integration ran no validation commands");
        }
        const failed = validation.filter((entry) => entry.exitCode !== 0);
        if (failed.length > 0) {
          throw new Error(
            `${failed[0]?.command.label} exited ${failed[0]?.exitCode}: ${
              failed[0]?.stderr.trim() || failed[0]?.stdout.trim()
            }`,
          );
        }
        // The agent's new test is what proves the command saw the candidate
        // tree: it does not exist at the base revision.
        const output = validation.map((entry) => entry.stdout).join("");
        if (!/cap\.test\.js|caps incremented values/u.test(output)) {
          throw new Error(
            "validation output does not mention the test the agent added",
          );
        }
        return `${validation.length} command(s) passed inside ${IMAGE}`;
      },
    );

    await check("canonical holds the containerized agent's edit", async () => {
      const version = await plane.repositories.getCanonicalVersion(
        plane.canonical,
      );
      const source = await plane.repositories.readFile(
        plane.canonical,
        version.revision,
        "src/counter.js",
      );
      if (!/Math\.min\(Number\(value\) \+ 1, 10\)/u.test(source)) {
        throw new Error(`unexpected canonical source: ${source.trim()}`);
      }
      const tasks = await plane.store.listSubmittedTasks();
      if (tasks.find((entry) => entry.id === task.id)?.status !== "integrated") {
        throw new Error("the queue task did not finalize as integrated");
      }
      return `promoted ${version.revision.slice(0, 12)}`;
    });

    await check("the lease settled and left nothing behind", async () => {
      const leases = await plane.store.listWorkLeases({});
      if (leases.length !== 1 || leases[0]?.status !== "completed") {
        throw new Error(
          `expected one completed lease, saw ${JSON.stringify(
            leases.map((entry) => entry.status),
          )}`,
        );
      }
      const idle = await worker.runOnce();
      if (idle.worked !== false) {
        throw new Error("a second poll found work that should not exist");
      }
      return "lease completed; the queue is empty";
    });
  } finally {
    if (plane !== undefined) {
      await plane.gateway.close();
      await plane.store.close();
    }
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(
    `\n${failures === 0 ? "All hosted-execution checks passed." : `${failures} check(s) failed.`}`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
