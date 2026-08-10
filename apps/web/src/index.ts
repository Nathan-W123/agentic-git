#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import path from "node:path";

import { ApiGateway, type ApiOperations } from "@coord/api-gateway";
import { computeCoordinationMetrics } from "@coord/coordinator";
import {
  repoCreate,
  repoImportGitHub,
  runPendingTasks,
  taskSubmit,
} from "@coord/cli/commands";
import { CoordinatorProject } from "@coord/cli/project";
import { recoverCoordinationState } from "@coord/cli/recovery";
import { rollbackCanonical } from "@coord/cli/rollback";
import { workerOperations } from "@coord/cli/worker-operations";
import type { CoordinationStore } from "@coord/persistence";
import { RepositoryService, runProcess } from "@coord/repository-service";

import { loadStaticAssets } from "./assets.js";
import {
  acquireControlPlaneLock,
  type ControlPlaneLock,
} from "./control-plane-lock.js";
import { OverlayWorkspaceService } from "./overlay.js";
import { ProviderChatService, type ProviderId } from "./providers.js";
import {
  UserCredentialStore,
  type UserCredentialKind,
} from "@coord/workspace-manager";

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
      "Port must be an integer between 1 and 65535 (--port, COORD_PORT, or PORT)",
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
  const controlPlaneLock = await acquireControlPlaneLock(project.directory);
  const store = project.openStore();
  try {
    await serve(project, store, controlPlaneLock);
  } catch (error) {
    try {
      await store.close();
    } finally {
      await controlPlaneLock.release();
    }
    throw error;
  }
}

async function serve(
  project: CoordinatorProject,
  store: CoordinationStore,
  controlPlaneLock: ControlPlaneLock,
): Promise<void> {
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

  const setupRequired = (await store.countUsers()) === 0;
  const generatedToken =
    process.env["COORD_BOOTSTRAP_TOKEN"] === undefined
      ? randomBytes(32).toString("base64url")
      : undefined;
  const bootstrapToken =
    process.env["COORD_BOOTSTRAP_TOKEN"] ?? generatedToken ?? "";

  const repositories = new RepositoryService();
  const overlays = new OverlayWorkspaceService(project, store, repositories);
  // One store for the whole process: the chat panel writes credentials and
  // task runs read them, and opening it twice could race on generating the
  // key file.
  const credentials = await UserCredentialStore.open(
    path.join(project.directory, "secrets"),
  );
  const providerChat = new ProviderChatService(project, { credentials });
  // A deployment serving more than one person sets this so a task never
  // quietly bills the host owner for someone else's work.
  const credentialPolicy =
    process.env["COORD_CREDENTIAL_POLICY"] === "refuse"
      ? ("refuse" as const)
      : ("host-login" as const);

  const operations: ApiOperations = {
    chatProviders: {
      list: (input) => providerChat.list(input),
      signIn: (input) =>
        providerChat.signIn({
          ...input,
          provider: input.provider as ProviderId,
        }),
      connect: (input) =>
        providerChat.connect({
          ...input,
          provider: input.provider as ProviderId,
        }),
      connectCredential: (input) =>
        providerChat.connectOwnCredential({
          ...input,
          provider: input.provider as ProviderId,
          // The gateway already rejects any other value.
          kind: input.kind as UserCredentialKind,
        }),
      deviceAuth: {
        start: (input) =>
          providerChat.startDeviceAuth({
            ...input,
            provider: input.provider as ProviderId,
          }),
        status: (input) => providerChat.deviceAuthStatus(input),
        cancel: (input) => providerChat.cancelDeviceAuth(input),
        submitCode: (input) => providerChat.submitDeviceAuthCode(input),
      },
      disconnect: (input) =>
        providerChat.disconnect({
          ...input,
          provider: input.provider as ProviderId,
        }),
      options: (input) =>
        providerChat.options({ provider: input.provider as ProviderId }),
      usage: (input) =>
        providerChat.usage({ provider: input.provider as ProviderId }),
      completeStream: (input, onEvent) =>
        providerChat.completeStream(
          { ...input, provider: input.provider as ProviderId },
          onEvent,
        ),
      setSettings: (input) =>
        providerChat.setSettings({
          ...input,
          provider: input.provider as ProviderId,
        }),
      complete: (input) =>
        providerChat.complete({
          ...input,
          provider: input.provider as ProviderId,
        }),
    },
    workspace: {
      status: (input) => overlays.status(input),
      open: (input) => overlays.open(input),
      reset: (input) => overlays.reset(input),
      discard: (input) => overlays.discard(input),
      listFiles: (input) => overlays.listFiles(input),
      readFile: (input) => overlays.readOverlayFile(input, input.path),
      writeFile: (input) =>
        overlays.writeOverlayFile(input, input.path, input.content),
      exec: (input) => overlays.exec(input, input.command),
      submit: (input) => overlays.submit(input, input.objective),
    },
    async listAgents() {
      return Object.entries(project.config.agents).map(([id, agent]) => ({
        id,
        adapter: agent.adapter ?? "generic-cli",
        default: project.config.defaultAgent === id,
      }));
    },
    async createRepository(input) {
      return await repoCreate(project, store, {
        id: input.id,
        projectId: input.projectId,
        ...(input.branch === undefined ? {} : { branch: input.branch }),
      });
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
        credentials,
        credentialPolicy,
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

  const runningGateway = new ApiGateway({
    store,
    operations,
    bootstrapToken,
    allowedOrigins: configuredOrigins(),
    secureCookies: process.env["COORD_SECURE_COOKIES"] === "true",
    staticAssets: await loadStaticAssets(),
  });
  // Loopback locally, every interface when a platform is hosting us. `PORT`
  // is the signal: a platform that assigns a port also puts a router in front
  // of the container, and that router cannot reach 127.0.0.1 — the deploy
  // builds, starts, and then fails its health check with the server running
  // perfectly well somewhere nothing can see it.
  const platformPort = process.env["PORT"];
  const host =
    process.env["COORD_HOST"] ??
    (platformPort === undefined || platformPort === "" ? "127.0.0.1" : "0.0.0.0");
  // `PORT` last, and only as a fallback: it is what every container platform
  // assigns, and a deployment that ignores it listens where nothing is
  // looking. It stays behind the explicit flag and `COORD_PORT` so a local
  // run is never redirected by a `PORT` that happens to be exported in the
  // developer's shell for something else entirely.
  const port = portNumber(
    argument("port") ?? process.env["COORD_PORT"] ?? platformPort,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      runningGateway.server.once("error", reject);
      runningGateway.server.listen(port, host, () => {
        runningGateway.server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await runningGateway.close();
    throw error;
  }

  console.log(`Coordinator control room: http://${host}:${port}`);
  console.log(`Project: ${project.root}`);
  if (setupRequired && generatedToken !== undefined) {
    console.log(`First-run bootstrap token: ${generatedToken}`);
  }

  let closing = false;
  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    try {
      await runningGateway.close();
    } finally {
      try {
        await store.close();
      } finally {
        await controlPlaneLock.release();
      }
    }
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
