#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import path from "node:path";

import {
  ApiGateway,
  HttpStripeClient,
  paymentsEnabled,
  type ApiOperations,
} from "@coord/api-gateway";
import { CodeIntelligenceService } from "@coord/code-intelligence";
import {
  ConversationRegistry,
  TaskCancellationRegistry,
  computeCoordinationMetrics,
} from "@coord/coordinator";
import {
  cancelTasks,
  pauseTasks,
  repoCreate,
  repoImportGitHub,
  repoRemove,
  resumeTasks,
  runPendingTasks,
  taskSubmit,
} from "@coord/cli/commands";
import { repoSync } from "@coord/cli/repo-export";
import { CoordinatorProject } from "@coord/cli/project";
import {
  drainInFlightWork,
  reapStrandedWork,
  recoverCoordinationState,
} from "@coord/cli/recovery";
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
import { GitHubConnectionService } from "./github-connection.js";
import { OverlayWorkspaceService } from "./overlay.js";
import { PreviewService } from "./preview.js";
import { ProviderChatService, type ProviderId } from "./providers.js";
import { pullCanonical } from "./pull-canonical.js";
import {
  pushCanonical,
  pushCanonicalForActor,
} from "./push-canonical.js";
import {
  captureCredentialKey,
  UserCredentialStore,
  type UserCredentialKind,
} from "@coord/workspace-manager";

/** An environment value, or undefined when it is unset or blank. */
function trimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * Where Stripe sends a browser back to after checkout.
 *
 * Configured rather than derived from the request, because the thin desktop
 * shell's own origin is not somewhere Stripe can redirect to — the return has
 * to land on a real page, which then hands back to the app. Falls back to the
 * first allowed origin so a plain web deployment needs no extra variable.
 */
function appBaseUrl(): string {
  return (
    absoluteUrl(trimmedEnv("KUMI_APP_URL"), "KUMI_APP_URL") ??
    absoluteUrl(trimmedEnv("COORD_PUBLIC_URL"), "COORD_PUBLIC_URL") ??
    configuredOrigins()[0] ??
    ""
  );
}

/**
 * A value that is actually an address, or nothing and a word about why.
 *
 * Pasting a whole `NAME=value` line into a value field is an easy mistake to
 * make and an expensive one to find: the variable is set, every check that
 * asks whether it is set says yes, and the failure surfaces hours later as
 * Stripe refusing a checkout for a reason that names none of this. Better to
 * refuse the value here, say which variable it was, and fall through to the
 * next candidate.
 */
function absoluteUrl(value: string | undefined, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("not http");
    }
    return value;
  } catch {
    process.emitWarning(
      `${name} is not an absolute http(s) URL and was ignored: ${JSON.stringify(value)}. ` +
        `A value like "${name}=https://example.com" means the variable's name ` +
        `was pasted into its own value.`,
    );
    return undefined;
  }
}

/**
 * How often the queue is checked for work nothing is driving.
 *
 * Shorter than the five-minute work-lease TTL, so the sweep that reclaims a
 * dead run's lease and the sweep that dispatches what it freed are at most
 * one interval apart rather than a whole TTL. Long enough that an idle
 * deployment is doing one indexed read a minute.
 */
const QUEUE_RESUME_INTERVAL_MS = 60_000;

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
  vendor: "claude" | "codex" | "gemini" | "cursor" | "copilot" | "kiro",
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
  // The switch the whole payment pathway hangs from, read here so the Stripe
  // client is not even constructed while it is off — no key in memory, no
  // outbound call possible, and nothing for a stray route to reach for.
  const payments = paymentsEnabled(process.env);
  const stripeSecretKey = payments ? trimmedEnv("STRIPE_SECRET_KEY") : undefined;
  const stripeWebhookSecret = payments
    ? trimmedEnv("STRIPE_WEBHOOK_SECRET")
    : undefined;
  const stripePriceId = payments ? trimmedEnv("STRIPE_PRICE_ID") : undefined;
  if (!payments) {
    console.info(
      "[billing] KUMI_PAYMENTS_ENABLED is not set, so this deployment takes " +
        "no payments: sign-up is a waitlist, nothing is gated on a " +
        "subscription, and Stripe is never called.",
    );
  }

  const repositories = new RepositoryService();
  // One index for the whole process, like the credential store below.
  //
  // The service caches a built index on `(repository path, revision)`, and
  // building one is the expensive part of grounding and admitting a plan —
  // full arbitration measured around ten seconds against a fast path of a
  // couple of hundred milliseconds, nearly all of it the walk. Every caller
  // used to construct its own service, so every caller started from an empty
  // cache and paid for that walk again at a revision the last one had just
  // indexed. Shared here, the first admission after canonical moves pays for
  // the build and the rest of that revision's work reads it.
  //
  // Nothing about what is built changes: the key still carries the revision,
  // so a canonical that moves misses and rebuilds, and the entry bound still
  // evicts the oldest — now for the first time actually reached, since the
  // instance outlives the call.
  const intelligence = new CodeIntelligenceService(repositories);
  // Started now, while nothing is waiting on it. The parse threads cannot
  // answer until they have loaded the TypeScript compiler, and paying for that
  // inside the first index build makes that build slower than never threading
  // at all — so it is paid here, at startup, against an idle process. A build
  // that arrives before they are ready simply parses on its own thread.
  void intelligence.warmUp();
  const overlays = new OverlayWorkspaceService(
    project,
    store,
    repositories,
    intelligence,
  );
  // Loopback only, and stopped with the process: see PreviewService.
  const previews = new PreviewService(project, store, repositories);
  // Beside the database rather than inside it, so the volume that persists one
  // persists the other. See AttachmentStore.
  const attachments = new AttachmentStore(
    path.join(project.directory, "attachments"),
  );
  // Before anything opens a credential store, and before anything spawns a
  // child: this moves `COORD_CREDENTIAL_KEY` out of the process environment
  // and into the module that needs it, so no subprocess can read the key that
  // decrypts every user's stored provider and GitHub credentials. Stores
  // opened later — including the one `ProviderChatService` opens lazily — still
  // resolve the configured key.
  captureCredentialKey();
  // One store for the whole process: the chat panel writes credentials and
  // task runs read them, and opening it twice could race on generating the
  // key file.
  const credentials = await UserCredentialStore.open(
    path.join(project.directory, "secrets"),
  );
  // The call signs go in the coordination store, not only in the secrets
  // file beside the credentials: that file lives on this machine's disk, and
  // a deployment whose filesystem does not outlive a restart came back with
  // every agent name gone — rosters and old messages falling back to
  // "Claude (Nathan)" in channels the database remembered perfectly.
  const providerChat = new ProviderChatService(project, {
    credentials,
    callSigns: store,
  });
  const repositoryChatContext = async (repositoryId: string | undefined) => {
    if (repositoryId === undefined) {
      return undefined;
    }
    const stored = await store.getRepository(repositoryId);
    if (stored === undefined) {
      throw new Error(`Unknown repository: ${repositoryId}`);
    }
    const repository = {
      id: stored.id,
      path: stored.path,
      branch: stored.branch,
    };
    return {
      repository,
      baseVersion: await repositories.getCanonicalVersion(repository),
      rootPath: project.planningRoot,
    };
  };
  // Beside the agent connections and in the same store: a push runs as the
  // task's submitter, so their GitHub token is scoped, stored and shown
  // exactly the way their agent credentials are. With a GitHub OAuth App's
  // client id configured, connecting is a browser sign-in like the Codex
  // one; without it, a pasted personal access token.
  const github = new GitHubConnectionService({
    credentials,
    ...(process.env["COORD_GITHUB_CLIENT_ID"] === undefined
      ? {}
      : { deviceClientId: process.env["COORD_GITHUB_CLIENT_ID"] }),
  });
  // Refusing is the default because the alternative is a silent one: with
  // `host-login`, a task submitted by somebody who has connected no provider
  // account runs on the host owner's own vendor session and spends their
  // credit, and nothing in the run says so. A single-operator deployment that
  // wants that behaviour asks for it by name with
  // `COORD_CREDENTIAL_POLICY=host-login`.
  const credentialPolicy =
    process.env["COORD_CREDENTIAL_POLICY"] === "host-login"
      ? ("host-login" as const)
      : ("refuse" as const);

  // Where open conversations live between runs. One per process, because a
  // coordinator is built per run and a conversation has to survive from one
  // run to the next; every dispatch below hands its coordinator this same
  // registry. The interval is the quiet-deployment bound: runs sweep idle
  // sessions on entry, but a deployment with no runs would otherwise hold
  // its conversation processes until the next dispatch.
  const conversations = new ConversationRegistry();
  // Where a person's "stop" reaches a running session. One per process for
  // the same reason: the gateway that hears the stop and the run that holds
  // the session only meet through this.
  const cancellations = new TaskCancellationRegistry();
  const conversationSweep = setInterval(() => {
    void conversations.closeIdleSessions().catch(() => undefined);
  }, 60_000);
  conversationSweep.unref?.();

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
        providerChat.options({
          provider: input.provider as ProviderId,
          ...(input.userId === undefined ? {} : { userId: input.userId }),
        }),
      usage: (input) =>
        providerChat.usage({
          ...input,
          provider: input.provider as ProviderId,
        }),
      completeStream: async (input, onEvent) => {
        const repository = await repositoryChatContext(input.repositoryId);
        return await providerChat.completeStream(
          {
            userId: input.userId,
            systemAdmin: input.systemAdmin,
            provider: input.provider as ProviderId,
            messages: input.messages,
            ...(input.cliSessionId === undefined
              ? {}
              : { cliSessionId: input.cliSessionId }),
            ...(repository === undefined ? {} : { repository }),
          },
          onEvent,
        );
      },
      setSettings: (input) =>
        providerChat.setSettings({
          ...input,
          provider: input.provider as ProviderId,
        }),
      complete: async (input) => {
        const repository = await repositoryChatContext(input.repositoryId);
        return await providerChat.complete({
          userId: input.userId,
          systemAdmin: input.systemAdmin,
          provider: input.provider as ProviderId,
          messages: input.messages,
          ...(input.cliSessionId === undefined
            ? {}
            : { cliSessionId: input.cliSessionId }),
          ...(input.ceremonial === undefined
            ? {}
            : { ceremonial: input.ceremonial }),
          ...(repository === undefined ? {} : { repository }),
        });
      },
      connectionsFor: (userIds) => providerChat.listConnectionsFor(userIds),
      noteAuthFailure: (input) =>
        providerChat.noteAuthFailure({
          ...input,
          provider: input.provider as ProviderId,
        }),
    },
    githubCredential: {
      status: (input) => github.status(input),
      connect: (input) => github.connect(input),
      disconnect: (input) => github.disconnect(input),
      deviceAuth: {
        start: (input) => github.startDeviceAuth(input),
        status: (input) => github.deviceAuthStatus(input),
        cancel: (input) => github.cancelDeviceAuth(input),
      },
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
    async deleteRepository(input) {
      await repoRemove(project, store, { id: input.repositoryId });
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
    async syncRepository(input) {
      // The caller's own stored GitHub token, when they have connected one —
      // a public repository syncs without any. Same identity rule as a push,
      // relaxed only because a fetch reads rather than writes.
      const connection = await github.tokenFor(input.actorId);
      return await repoSync(project, store, {
        repositoryId: input.repositoryId,
        projectId: input.projectId,
        actorId: input.actorId,
        ...(input.conflictResolution === undefined
          ? {}
          : { conflictResolution: input.conflictResolution }),
        ...(connection === undefined
          ? {}
          : { credentials: { token: connection.token } }),
      });
    },
    async pushRepository(input) {
      return await pushCanonicalForActor(project, store, github, {
        repositoryId: input.repositoryId,
        actorId: input.actorId,
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
        ...(input.queueAfterCurrent === true
          ? { queueAfterCurrent: true }
          : {}),
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.conversationId === undefined
          ? {}
          : { conversationId: input.conversationId }),
        ...(input.planOnly === true ? { planOnly: true } : {}),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
      });
    },
    async cancelTasks(input) {
      // Same resolution as submitTask, because the channel names agents the
      // same way in both directions: it knows the mentioned agent's vendor,
      // never this deployment's internal agent ids.
      const agentId =
        input.agentId ??
        (input.vendor === undefined
          ? undefined
          : resolveAgentIdForVendor(project, input.vendor));
      if (
        input.agentId === undefined &&
        input.vendor !== undefined &&
        agentId === undefined
      ) {
        // A vendor nothing is configured for can have no tasks; "nothing
        // stopped" is the honest answer and the caller words it.
        return { cancelled: [] };
      }
      const cancelled = await cancelTasks(store, {
        repositoryId: input.repositoryId,
        projectId: input.projectId,
        ...(input.taskIds === undefined ? {} : { taskIds: input.taskIds }),
        ...(agentId === undefined ? {} : { agentId }),
        // The persona's owner, when a name was targeted: agentId narrows to
        // the vendor, and this narrows to whose work it was.
        ...(input.ownerId === undefined ? {} : { submittedBy: input.ownerId }),
        reason: input.reason,
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        cancellations,
      });
      return { cancelled };
    },
    async pauseTasks(input) {
      const paused = await pauseTasks(store, {
        repositoryId: input.repositoryId,
        projectId: input.projectId,
        taskIds: input.taskIds,
        reason: input.reason,
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        // The same registry the cancel path uses: one bridge to the live
        // session, so a pause and a stop cannot reach different runs.
        cancellations,
      });
      return { paused };
    },
    async resumeTask(input) {
      const resumed = await resumeTasks(store, {
        repositoryId: input.repositoryId,
        projectId: input.projectId,
        taskIds: [input.taskId],
        reason: "Resumed from the thread",
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      });
      return { resumed: resumed.length > 0 };
    },
    async runRepository(input) {
      // A run claims the work eligible at its start. Explicit follow-ups
      // become eligible only when that batch finishes, so keep draining until
      // one pass finds nothing rather than leaving the newly-unblocked task
      // waiting for an unrelated future dispatch.
      for (;;) {
        const result = await runPendingTasks(project, store, {
          projectId: input.projectId,
          repositoryId: input.repositoryId,
          credentials,
          credentialPolicy,
          conversations,
          cancellations,
          intelligence,
          // What an agent may ask this deployment to do. A fixed list, not a
          // command channel: an agent may only ask for what its submitter could
          // do themselves on this repository, and an open channel would let it
          // ask the platform to do what it is itself forbidden to do. See
          // docs/architecture/agent-actions.md.
          actions: {
            async perform(request) {
              if (request.action === "preview_stop") {
                await previews.stopForTask(request.task.id);
                return {
                  outcome: "done",
                  explanation: "The preview is stopped.",
                };
              }
              if (request.action === "push") {
                // Canonical, never the task's workspace. What an agent has in
                // its checkout has not been integrated or validated yet, and
                // publishing it would put work on a remote that this repository
                // has not accepted — the one place where "the agent's version"
                // and "the project's version" must not be confused.
                return await pushCanonical(project, store, github, request);
              }
              if (request.action === "pull") {
                // Canonical again, and for the matching reason: "pull from
                // GitHub" means the platform's copy of the repository, not the
                // agent's checkout — a fetch inside the workspace reaches only
                // the local mirror and updates nothing anyone else can see.
                return await pullCanonical(project, store, github, request);
              }
              if (request.action !== "preview_start") {
                return {
                  outcome: "refused",
                  explanation:
                    `"${request.action}" is not something this deployment does. ` +
                    "Available actions: preview_start, preview_stop, push, pull.",
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
                      ...(started.url === undefined
                        ? {}
                        : { url: started.url }),
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
        if (result.claimed.length === 0) {
          return;
        }
      }
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
      return await previews.status(input.repositoryId);
    },
    async previewStop(input) {
      await previews.stop(input.repositoryId);
    },
    async previewConfigure(input) {
      // One string rather than an executable and an argument list, because the
      // person answering is reading a prompt and knows the command they type
      // in a terminal.
      const command = input.command.trim();
      if (command === "") {
        throw new Error("A start command is required");
      }
      // Split on whitespace where that is the whole of it — a program and some
      // flags — and handed to a shell where it is not. Somebody asked how an
      // app starts answers with what they type in a terminal, and a fair share
      // of those are `cd apps/web && npm run dev` or `PORT=3000 rails s`:
      // splitting those on spaces produces an executable called `cd` with an
      // argument called `&&`, which fails in a way that reads as the answer
      // having been wrong. `sh -c` is what the Procfile rung already does with
      // a line of the same kind.
      const parts = command.split(/\s+/u);
      const [executable, ...args] = parts;
      const shellish =
        /[|&;<>()$`"'\\*?~\n]/u.test(command) ||
        // A leading `NAME=value` is an assignment, which only a shell knows
        // how to apply. `--flag=value` is never the first word, so this does
        // not catch an ordinary command carrying one.
        /^[A-Za-z_][A-Za-z0-9_]*=/u.test(executable ?? "");
      project.config.previewCommands = {
        ...project.config.previewCommands,
        [input.repositoryId]: shellish
          ? { executable: "sh", args: ["-c", command], label: command }
          : { executable: executable ?? command, args, label: command },
      };
      await project.save();
    },
    async attachmentSave(input) {
      return await attachments.save(input.bytes, input.contentType);
    },
    async attachmentPath(id) {
      return await attachments.pathFor(id);
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
      return await rollbackCanonical(
        project,
        store,
        {
          repositoryId: input.repositoryId,
          targetRevision: input.targetRevision,
          actorId: input.actorId,
          projectId: input.projectId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.files === undefined ? {} : { files: input.files }),
        },
        { repositories, intelligence },
      );
    },
    ...workerOperations(project, store, { repositories, intelligence }),
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
    // Billing is opt-in twice over: the switch above, and then a secret key.
    // With either missing every billing route answers 501, and with the
    // switch off nothing is gated on a subscription at all — so a deployment
    // runs exactly as it did before payment existed.
    paymentsEnabled: payments,
    ...(stripeSecretKey === undefined
      ? {}
      : { stripe: new HttpStripeClient(stripeSecretKey) }),
    ...(stripeWebhookSecret === undefined ? {} : { stripeWebhookSecret }),
    ...(stripePriceId === undefined ? {} : { stripePriceId }),
    appBaseUrl: appBaseUrl(),
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

  // Resume the queue nothing is driving.
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
  // On a timer rather than once at boot, which is what made the boot-only
  // version miss the case it was written for. A lease is minted for
  // `WORK_LEASE_TTL_MS` — five minutes — and heartbeated for as long as its
  // run lives, so the lease of a process that died seconds ago does not
  // expire for another five minutes. A container restart takes about ten
  // seconds. The one expiry sweep at boot therefore ran while the stranded
  // lease was still comfortably active, reclaimed nothing, read a queue that
  // did not yet contain the stranded task, and never looked again. The task
  // reached `submitted` minutes later, off the back of some unrelated lazy
  // sweep, with nothing left in the process that would ever dispatch it.
  //
  // Every pass is the whole recovery, in order: expire the leases that have
  // now lapsed, then run whatever that put back in the queue. Reaching the
  // stranded task takes as long as its last lease had left, so a deploy
  // mid-run costs a delay rather than the task.
  //
  // Expiry first, so tasks a dead worker was holding are back in `submitted`
  // before the queue is read. Fire-and-forget per repository, one run each:
  // `runPendingTasks` drains everything queued for that repository, and boot
  // must not block on agent work.
  //
  // Repositories with a resume already in flight are skipped. A run holds its
  // leases for as long as it takes, and an agent takes far longer than one
  // sweep interval, so without this every pass would stack another run on the
  // same repository — each of which reads canonical, leases nothing, and
  // returns. Correct but wasteful, and the waste is proportional to how long
  // the work takes.
  const resuming = new Set<string>();
  const resumeQueuedWork = async (): Promise<void> => {
    const sweptAt = new Date().toISOString();
    await store.expireWorkLeases(sweptAt);
    // Approvals go stale the same way leases do, and for the same reason:
    // nothing but the waiter was ever watching the deadline.
    //
    // `StoreApprovalController` polls its own request and expires it when the
    // clock runs out — which works exactly as long as the process doing the
    // polling is alive. A redeploy while somebody's run is stopped on a
    // review kills the only thing that would ever have ended it, and the row
    // is then pending forever: past its `expiresAt`, invisible to every
    // deadline, holding a task that no sweep will settle because the task is
    // not the thing that is stuck. The count of approvals requested rises and
    // the count decided never moves.
    //
    // Only rows already past their own deadline are touched, so this can
    // never take a decision away from somebody still thinking about one — it
    // does what the waiter would have done on its next poll, for the waiters
    // that are no longer there.
    await store.expireApprovals(sweptAt).catch(() => undefined);
    const pending = await store.listSubmittedTasks({ status: "submitted" });
    const repositories = new Map(
      pending.map((task) => [
        `${task.projectId} ${task.repositoryId}`,
        task,
      ]),
    );
    for (const [key, task] of repositories) {
      if (resuming.has(key)) {
        continue;
      }
      // A row from before tasks carried a project cannot be routed to a run;
      // the default project is what those rows meant.
      const projectId = task.projectId ?? "proj_default";
      console.log(
        `Resuming queued work in ${task.repositoryId} (task ${task.id})`,
      );
      resuming.add(key);
      void Promise.resolve(
        operations.runRepository?.({
          projectId,
          repositoryId: task.repositoryId,
          // The person whose work is being resumed, not whoever restarted the
          // process: the run spends the same credential the original dispatch
          // chose, which is keyed off the submitter.
          actorId: task.submittedBy ?? "system",
        }),
      )
        .catch((error: unknown) => {
          console.error(
            `Resume failed for ${task.repositoryId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        })
        .finally(() => {
          resuming.delete(key);
        });
    }
  };
  const queueSweep = setInterval(() => {
    void resumeQueuedWork().catch((error: unknown) => {
      console.error(
        `Queue resume failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, QUEUE_RESUME_INTERVAL_MS);
  queueSweep.unref?.();
  // And immediately, for the work that was already queued when this started.
  void resumeQueuedWork().catch((error: unknown) => {
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
      // Before anything else stops: this process is holding leases on work it
      // is no longer going to do, and a lease nobody renews still reads as a
      // live agent for the five minutes it takes to expire. Handing it back
      // now is what lets the container that replaces this one find the task
      // queued and resume it in seconds — the difference between a redeploy
      // costing a restart and a redeploy stranding whatever was mid-flight.
      //
      // Before the gateway rather than after it, and best effort. Closing the
      // gateway takes as long as its slowest connection; the drain is two
      // indexed writes and is the one thing here that must not be missed. The
      // cost of that order is a dispatch landing in the milliseconds between
      // the two, whose lease then expires the old way.
      await drainInFlightWork(store).catch((error: unknown) => {
        console.error(
          `Could not release in-flight work: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
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
