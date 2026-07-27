#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import path from "node:path";

import { ApiGateway, type ApiOperations } from "@coord/api-gateway";
import {
  repoImportGitHub,
  runPendingTasks,
  taskSubmit,
} from "@coord/cli/commands";
import { CoordinatorProject } from "@coord/cli/project";
import { runProcess } from "@coord/repository-service";

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
    throw new Error("COORD_PORT must be an integer between 1 and 65535");
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
  const generatedToken =
    process.env["COORD_BOOTSTRAP_TOKEN"] === undefined
      ? randomBytes(32).toString("base64url")
      : undefined;
  const bootstrapToken =
    process.env["COORD_BOOTSTRAP_TOKEN"] ?? generatedToken ?? "";

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
  const port = portNumber(process.env["COORD_PORT"]);
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
