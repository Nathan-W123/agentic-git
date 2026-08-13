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
import { AttachmentStore } from "./attachments.js";
import { OverlayWorkspaceService } from "./overlay.js";
import { PreviewService } from "./preview.js";
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

/**
 * The first configured agent whose adapter runs the given vendor CLI, for a
 * caller (channel @mention dispatch) that knows only the vendor and not this
 * project's own agent names. `undefined` when nothing is configured for it.
 */
function resolveAgentIdForVendor(
  project: CoordinatorProject,
  vendor: "claude" | "codex" | "gemini",
): string | undefined {
  for (const [id, agent] of Object.entries(project.config.agents)) {
    if (agent.adapter === vendor) {
      return id;
    }
  }
  return undefined;
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
  // Unset means first-run setup is open, not "invent one". Generating a token
  // per boot made the deployment unenterable in the ordinary case: nothing
  // persists it, so it existed only in that boot's log, and every restart —
  // every redeploy, every crash-retry — replaced it with a new one while the
  // operator was still holding the old. A secret nobody can hold is not a
  // secret, it is a lockout. A deployment that wants the guard sets the
  // variable, and then it is stable because they chose it.
  const bootstrapToken = process.env["COORD_BOOTSTRAP_TOKEN"]?.trim();

  const repositories = new RepositoryService();
  const overlays = new OverlayWorkspaceService(project, store, repositories);
  // Loopback only, and stopped with the process: see PreviewService.
  const previews = new PreviewService(project, store, repositories);
  // Beside the database rather than inside it, so the volume that persists one
  // persists the other. See AttachmentStore.
  const attachments = new AttachmentStore(
    path.join(project.directory, "attachments"),
  );
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

  // Bound after construction: the gateway is built from these operations, and
  // one of them (a question put to a person) needs the gateway back. Only
  // read from inside a call, which cannot happen before it is serving.
  let servingGateway: ApiGateway | undefined;
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
        providerChat.usage({
          ...input,
          provider: input.provider as ProviderId,
        }),
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
      connectionsFor: (userIds) => providerChat.listConnectionsFor(userIds),
      noteAuthFailure: (input) =>
        providerChat.noteAuthFailure({
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
      moveFile: (input) => overlays.moveOverlayFile(input, input.from, input.to),
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
        ...(input.actorId === undefined ? {} : { createdBy: input.actorId }),
      });
    },
    async importGitHub(input) {
      return await repoImportGitHub(project, store, {
        repository: input.repository,
        projectId: input.projectId,
        ...(input.id === undefined ? {} : { id: input.id }),
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.token === undefined ? {} : { token: input.token }),
        ...(input.actorId === undefined ? {} : { createdBy: input.actorId }),
      });
    },
    async submitTask(input) {
      // `agentId` names one of this project's own configured agents and
      // wins when given explicitly (the ordinary submission path, where the
      // caller already knows which one). `vendor` is for a caller — the
      // channel @mention dispatcher — that knows only which vendor CLI the
      // mentioned agent runs (claude/codex/gemini), not this deployment's
      // internal agent names, and needs one resolved for it.
      const agentId =
        input.agentId ??
        (input.vendor === undefined
          ? undefined
          : resolveAgentIdForVendor(project, input.vendor));
      if (input.agentId === undefined && input.vendor !== undefined && agentId === undefined) {
        throw new Error(
          `No ${input.vendor} agent is configured on this deployment ` +
            `(see "agents" in .coordinator/config.json)`,
        );
      }
      return await taskSubmit(project, store, {
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        objective: input.objective,
        submittedBy: input.actorId,
        ...(agentId === undefined ? {} : { agentId }),
        ...(input.context === undefined ? {} : { context: input.context }),
      });
    },
    async runRepository(input) {
      await runPendingTasks(project, store, {
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        credentials,
        credentialPolicy,
        // What an agent may ask this deployment to do. A fixed list, not a
        // command channel: an agent may only ask for what its submitter could
        // do themselves on this repository, and an open channel would let it
        // ask the platform to do what it is itself forbidden to do. See
        // docs/architecture/agent-actions.md.
        actions: {
          async perform(request) {
            if (request.action === "preview_stop") {
              await previews.stopForTask(request.task.id);
              return { outcome: "done", explanation: "The preview is stopped." };
            }
            if (request.action !== "preview_start") {
              return {
                outcome: "refused",
                explanation:
                  `"${request.action}" is not something this deployment does. ` +
                  "Available actions: preview_start, preview_stop.",
              };
            }
            // The task's own workspace, never canonical. An agent looking at
            // canonical would be looking at the app without the change it has
            // just made, so anything it concluded — or screenshotted — would
            // be about the wrong version.
            const started = await previews.startForTask({
              taskId: request.task.id,
              repositoryId: request.repository.id,
              workspacePath: request.workspacePath,
            });
            return started.failed
              ? {
                  outcome: "refused",
                  detail: { output: started.output },
                  explanation:
                    "The app did not start. Its output is in `detail.output`.",
                }
              : {
                  outcome: "done",
                  detail: {
                    ...(started.url === undefined ? {} : { url: started.url }),
                    output: started.output,
                  },
                  explanation:
                    `The app is at ${started.url ?? "an unknown address"}. ` +
                    "It serves this task's workspace, so it includes changes " +
                    "that have not landed yet.",
                };
          },
        },
        // Where an agent's question goes. The gateway is the only thing here
        // that knows where people are watching, and it is the same object
        // serving the channel the answer will arrive in.
        questions: {
          awaitAnswer: async (ask) =>
            await (servingGateway?.awaitAgentAnswer(ask) ??
              Promise.resolve(undefined)),
        },
      });
    },
    async projectMetrics(input) {
      return await computeCoordinationMetrics(store, {
        projectId: input.projectId,
      });
    },
    async canonicalDiff(input) {
      const stored = await store.getRepository(input.repositoryId);
      if (stored === undefined) {
        throw new Error(`Unknown repository: ${input.repositoryId}`);
      }
      const repository = {
        id: stored.id,
        path: stored.path,
        branch: stored.branch,
      };
      const [files, diff] = await Promise.all([
        repositories.listChangedFiles(
          repository,
          input.fromRevision,
          input.toRevision,
        ),
        repositories.diffBetween(
          repository,
          input.fromRevision,
          input.toRevision,
        ),
      ]);
      // The file list comes from Git separately rather than being parsed back
      // out of the patch text, because the patch may have been truncated and
      // the list of what changed is the one part that must stay complete —
      // it is what tells a reader which of the changed files it did not get
      // to see.
      return { files, patch: diff.patch, truncated: diff.truncated };
    },
    async canonicalHead(input) {
      const stored = await store.getRepository(input.repositoryId);
      if (stored === undefined) {
        throw new Error(`Unknown repository: ${input.repositoryId}`);
      }
      const [newest] = await repositories.listCanonicalHistory(
        { id: stored.id, path: stored.path, branch: stored.branch },
        1,
      );
      return newest?.revision;
    },
    async previewStart(input) {
      return await previews.start({ repositoryId: input.repositoryId });
    },
    async previewStatus(input) {
      return previews.status(input.repositoryId);
    },
    async previewStop(input) {
      await previews.stop(input.repositoryId);
    },
    async attachmentSave(input) {
      return await attachments.save(input.bytes, input.contentType);
    },
    async attachmentRead(id) {
      return await attachments.read(id);
    },
    async canonicalFileBytes(input) {
      const stored = await store.getRepository(input.repositoryId);
      if (stored === undefined) {
        return undefined;
      }
      return await repositories.readFileBytes(
        { id: stored.id, path: stored.path, branch: stored.branch },
        input.revision,
        input.path,
      );
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
    // Omitted rather than passed as undefined: `exactOptionalPropertyTypes`
    // draws the distinction, and "absent" is what open setup means here.
    ...(bootstrapToken === undefined ? {} : { bootstrapToken }),
    allowedOrigins: configuredOrigins(),
    secureCookies: process.env["COORD_SECURE_COOKIES"] === "true",
    staticAssets: await loadStaticAssets(),
  });
  servingGateway = runningGateway;
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

  // Resume the queue this restart interrupted.
  //
  // Task execution had exactly four triggers — a mention, a retry, an
  // audit-fix dispatch, and the manual run route — and none of them is "the
  // process came back up". So a deploy mid-run stranded its task forever: the
  // worker died holding the lease, lease expiry only happens when a worker
  // polls, and the poll loop died with the worker. The task sat `claimed`,
  // then `submitted` once something else's dispatch expired the lease, and
  // nothing ever told the queue to run again. In the channel that read as an
  // agent thinking forever — dots with no work behind them.
  //
  // Expiry first, so tasks a dead worker was holding are back in `submitted`
  // before the queue is read. Fire-and-forget per repository, one run each:
  // `runPendingTasks` drains everything queued for that repository, and boot
  // must not block on agent work.
  void (async () => {
    await store.expireWorkLeases(new Date().toISOString());
    const pending = await store.listSubmittedTasks({ status: "submitted" });
    const repositories = new Map(
      pending.map((task) => [
        `${task.projectId} ${task.repositoryId}`,
        task,
      ]),
    );
    for (const task of repositories.values()) {
      // A row from before tasks carried a project cannot be routed to a run;
      // the default project is what those rows meant.
      const projectId = task.projectId ?? "proj_default";
      console.log(
        `Resuming queued work in ${task.repositoryId} (task ${task.id})`,
      );
      void operations
        .runRepository?.({
          projectId,
          repositoryId: task.repositoryId,
          // The person whose work is being resumed, not whoever restarted the
          // process: the run spends the same credential the original dispatch
          // chose, which is keyed off the submitter.
          actorId: task.submittedBy ?? "system",
        })
        .catch((error: unknown) => {
          console.error(
            `Resume failed for ${task.repositoryId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }
  })().catch((error: unknown) => {
    console.error(
      `Queue resume failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  if (setupRequired) {
    console.log(
      bootstrapToken === undefined
        ? "First-run setup is open — the first account created becomes the " +
            "owner. Set COORD_BOOTSTRAP_TOKEN to require a secret for it."
        : "First-run setup requires COORD_BOOTSTRAP_TOKEN.",
    );
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
      // Previews are child processes holding ports and checkouts. Nothing else
      // will reap them if this process goes without saying so.
      await previews.close();
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
