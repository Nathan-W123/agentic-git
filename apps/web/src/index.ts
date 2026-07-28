#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import path from "node:path";

import { ApiGateway, type ApiOperations } from "@coord/api-gateway";
import { computeCoordinationMetrics } from "@coord/coordinator";
import {
  repoImportGitHub,
  runPendingTasks,
  taskSubmit,
} from "@coord/cli/commands";
import { CoordinatorProject } from "@coord/cli/project";
import { recoverCoordinationState } from "@coord/cli/recovery";
import { rollbackCanonical } from "@coord/cli/rollback";
import { workerOperations } from "@coord/cli/worker-operations";
import { RepositoryService, runProcess } from "@coord/repository-service";

import { loadStaticAssets } from "./assets.js";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length);
}

function portNumber(value: string | undefined): number {
  const port = Number.parseInt(value ?? "4317", 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      "Port must be an integer between 1 and 65535 (--port or COORD_PORT)",
    );
  }
  return port;
}

function configuredOrigins(): string[] {
  return (process.env["COORD_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function main(): Promise<void> {
  const root = path.resolve(
    argument("root") ?? process.env["COORD_PROJECT_ROOT"] ?? process.cwd(),
  );
  const project = await CoordinatorProject.open(root);
  const store = project.openStore();

  // Crash recovery precedes serving: everything found now is genuinely
  // orphaned. This assumes the documented single-control-plane deployment.
  const recovery = await recoverCoordinationState(project, store);
  if (
    recovery.failedRuns.length > 0 ||
    recovery.requeuedTasks.length > 0 ||
    recovery.expiredLeases.length > 0 ||
    recovery.removedDirectories.length > 0
  ) {
    console.log(
      "Recovered from a previous shutdown: " +
        `${recovery.failedRuns.length} run(s) failed, ` +
        `${recovery.requeuedTasks.length} task(s) requeued, ` +
        `${recovery.expiredLeases.length} lease(s) expired, ` +
        `${recovery.removedDirectories.length} scratch dir(s) removed`,
    );
  }
  for (const warning of recovery.warnings) {
    console.warn(`Recovery warning: ${warning}`);
  }

  const generatedToken =
    process.env["COORD_BOOTSTRAP_TOKEN"] === undefined
      ? randomBytes(32).toString("base64url")
      : undefined;
  const bootstrapToken =
    process.env["COORD_BOOTSTRAP_TOKEN"] ?? generatedToken ?? "";

  const repositories = new RepositoryService();

  const operations: ApiOperations = {
    async listAgents() {
      return Object.entries(project.config.agents).map(([id, agent]) => ({
        id,
        adapter: agent.adapter === "codex" ? "codex" : "generic-cli",
        default: project.config.defaultAgent === id,
      }));
    },
    async importGitHub(input) {
      return await repoImportGitHub(project, store, {
        repository: input.repository,
        projectId: input.projectId,
        ...(input.id === undefined ? {} : { id: input.id }),
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.token === undefined ? {} : { token: input.token }),
      });
    },
    async submitTask(input) {
      return await taskSubmit(project, store, {
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        objective: input.objective,
        submittedBy: input.actorId,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      });
    },
    async runRepository(input) {
      await runPendingTasks(project, store, {
        projectId: input.projectId,
        repositoryId: input.repositoryId,
      });
    },
    async projectMetrics(input) {
      return await computeCoordinationMetrics(store, {
        projectId: input.projectId,
      });
    },
    async repositoryVersions(input) {
      const stored = await store.getRepository(input.repositoryId);
      if (stored === undefined) {
        throw new Error(`Unknown repository: ${input.repositoryId}`);
      }
      return await repositories.listCanonicalHistory(
        {
          id: stored.id,
          path: stored.path,
          branch: stored.branch,
        },
        input.limit ?? 50,
      );
    },
    async rollbackRepository(input) {
      return await rollbackCanonical(project, store, {
        repositoryId: input.repositoryId,
        targetRevision: input.targetRevision,
        actorId: input.actorId,
        projectId: input.projectId,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
    },
    ...workerOperations(project, store),
    async dockerStatus() {
      try {
        const result = await runProcess(
          project.sandboxOptions()?.docker ?? "docker",
          ["version", "--format", "{{.Server.Version}}"],
          { timeoutMs: 5_000, maxOutputBytes: 8_192 },
        );
        if (result.exitCode !== 0) {
          return {
            available: false,
            explanation:
              result.stderr.trim() ||
              "Docker did not return a usable server version",
          };
        }
        return {
          available: true,
          version: result.stdout.trim(),
          explanation: "Docker workspace runtime is available",
        };
      } catch (error) {
        return {
          available: false,
          explanation:
            error instanceof Error ? error.message : "Docker is unavailable",
        };
      }
    },
  };

  const gateway = new ApiGateway({
    store,
    operations,
    bootstrapToken,
    allowedOrigins: configuredOrigins(),
    secureCookies: process.env["COORD_SECURE_COOKIES"] === "true",
    staticAssets: await loadStaticAssets(),
  });
  const host = process.env["COORD_HOST"] ?? "127.0.0.1";
  const port = portNumber(argument("port") ?? process.env["COORD_PORT"]);
  await new Promise<void>((resolve, reject) => {
    gateway.server.once("error", reject);
    gateway.server.listen(port, host, () => {
      gateway.server.removeListener("error", reject);
      resolve();
    });
  });

  console.log(`Coordinator control room: http://${host}:${port}`);
  console.log(`Project: ${root}`);
  if (generatedToken !== undefined) {
    console.log(`First-run bootstrap token: ${generatedToken}`);
  }

  let closing = false;
  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await gateway.close();
    await store.close();
  };
  process.once("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
