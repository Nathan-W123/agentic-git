import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import net from "node:net";
import test, { type TestContext } from "node:test";

import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
  InMemoryCoordinationStore,
  type CoordinationStore,
} from "@coord/persistence";

import { AGENT_ACCOUNT_PREFIX } from "@coord/shared-types";

import {
  agentIdentity,
  ApiGateway,
  describeTaskState,
  explainAnswerFailure,
  looksLikeTaskRequest,
  narrateTaskEvent,
  summariseObjective,
  type ApiOperations,
} from "./server.js";
import { hashPassword } from "./auth.js";

const BOOTSTRAP_TOKEN = "bootstrap-token-with-at-least-24-characters";
const PASSWORD = "RelayPassword123!";

interface TestRuntime {
  gateway: ApiGateway;
  store: CoordinationStore;
  origin: string;
  port: number;
  /**
   * The vendors each user has "connected", for the `channel/agents` roster
   * route to read back through `chatProviders.connectionsFor`. A real
   * deployment backs this with `UserCredentialStore`; the test fixture only
   * needs the same safe shape — vendor, visibility and the account's call
   * sign, and nothing else — since that route never reads a secret in the
   * first place. `visibility` defaults to "personal" when a test omits it,
   * same as the real store, and `callSign` is absent for a connection made
   * before agents were named.
   */
  chatConnections: Map<
    string,
    Array<{
      provider: string;
      visibility?: "personal" | "org";
      callSign?: string;
    }>
  >;
  /**
   * Every call the fake `submitTask` operation received, in order — for
   * asserting @mention dispatch submits under the *mentioned agent's owner*,
   * not the sender, and does so only when it should.
   */
  submittedTasks: Array<{
    projectId: string;
    repositoryId: string;
    objective: string;
    agentId?: string;
    vendor?: string;
    actorId: string;
    /** The thread the request was asked inside, when it was asked inside one. */
    context?: string;
    /** The thread root's id — the conversation every dispatch from it shares. */
    conversationId?: string;
    /** Whether the dispatch asked for the work to be held, not queued. */
    planOnly?: boolean;
    /** What the channel picked for this agent, if it picked anything. */
    model?: string;
    effort?: string;
  }>;
  /**
   * Every prompt the fake `complete` was asked, and what it should answer —
   * for asserting that a follow-up in a thread reaches the agent at all, and
   * that the thread's own history goes with it.
   */
  chatPrompts: Array<{ userId: string; provider: string; prompt: string }>;
  chatAnswer: {
    text?: string;
    fail?: string;
    delayMs?: number;
    streamEvents?: Array<Record<string, unknown>>;
    thinking?: string;
    thinkingHidden?: boolean;
    thinkingTokens?: number;
  };
  /** Every canonical diff the auditor asked for, in order. */
  canonicalDiffs: Array<{
    projectId: string;
    repositoryId: string;
    fromRevision: string;
    toRevision: string;
  }>;
  /** What `canonicalDiff` answers; mutated in place by tests. */
  canonicalDiff: { files: string[]; patch: string; truncated: boolean };
  /** Where `canonicalHead` says canonical stands; mutated in place. */
  canonicalState: { head: string | undefined };
  /** Set `reason` to make `runRepository` reject, as a run that cannot start does. */
  /** `error` throws exactly what it holds, for failures with a shape. */
  runFailure: { reason?: string; error?: unknown };
  /** When the gateway asked the repository to run, so ordering can be read. */
  runCalls: number[];
  /** Every rollback the gateway asked for, in order. */
  rollbacks: Array<{
    repositoryId: string;
    targetRevision: string;
    files?: readonly string[];
  }>;
  /** What the agent answers when asked whether a message is work. */
  setTaskClassification: (answer: string) => void;
  /** Makes the next revert answer with this instead of succeeding. */
  setRollbackOutcome: (
    outcome: { status: string; explanation: string } | undefined,
  ) => void;
  /** Every stop the gateway asked for, in order — scope, words and all. */
  cancelCalls: Array<{
    repositoryId: string;
    taskIds?: string[];
    vendor?: string;
    ownerId?: string;
    reason: string;
    actorId: string;
  }>;
}

class TestClient {
  private readonly cookies = new Map<string, string>();

  /** Public so a test can open a second, cookie-less client on the same server. */
  public constructor(public readonly origin: string) {}

  public get cookieHeader(): string {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  public async request(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      /** Sent verbatim, for the one route that takes bytes. */
      raw?: Buffer;
      rawType?: string;
      headers?: Record<string, string>;
      csrf?: boolean;
    } = {},
  ): Promise<{ status: number; data: any; headers: Headers }> {
    const method = options.method ?? "GET";
    const headers = new Headers(options.headers ?? {});
    if (this.cookieHeader.length > 0) {
      headers.set("Cookie", this.cookieHeader);
    }
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    // A raw body carries its own type. Images are the only thing sent this
    // way, and JSON-encoding them would be testing a route nothing uses.
    if (options.raw !== undefined) {
      headers.set("Content-Type", options.rawType ?? "application/octet-stream");
    }
    if (
      options.csrf !== false &&
      !["GET", "HEAD", "OPTIONS"].includes(method) &&
      this.cookies.has("coord_csrf")
    ) {
      headers.set("X-CSRF-Token", this.cookies.get("coord_csrf") ?? "");
    }
    const response = await fetch(`${this.origin}${path}`, {
      method,
      headers,
      ...(options.raw !== undefined
        ? { body: options.raw }
        : options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
    });
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair] = setCookie.split(";", 1);
      const separator = pair?.indexOf("=") ?? -1;
      if (pair === undefined || separator < 1) {
        continue;
      }
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value.length === 0) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
    const contentType = response.headers.get("content-type") ?? "";
    return {
      status: response.status,
      data: contentType.includes("application/json")
        ? await response.json()
        : await response.text(),
      headers: response.headers,
    };
  }
}

/**
 * Waits for something a fire-and-forget path will make true.
 *
 * The reply route answers the caller before the agent has been asked, on
 * purpose — so the assertion cannot read the answer straight after the POST.
 */
async function waitFor(
  condition: () => Promise<boolean>,
  message: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function rawHttp(port: number, request: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for raw HTTP response"));
    }, 4_000);
    socket.once("connect", () => socket.end(request));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function startRuntime(
  t: TestContext,
  options: {
    allowedOrigins?: readonly string[];
    webSocketPollIntervalMs?: number;
    webSocketReauthorizeIntervalMs?: number;
    auditorPollIntervalMs?: number;
    /**
     * Drops the optional `listAgents` operation, as a deployment that does
     * not implement it does — the fallback path for anything that joins
     * tasks to configured agents.
     */
    withoutListAgents?: boolean;
  } = {},
): Promise<TestRuntime> {
  const store = new InMemoryCoordinationStore();
  // Typed off `TestRuntime` rather than spelled out a second time, like every
  // fixture field below it. The shape was written twice, and adding
  // `callSign` to the interface left this copy behind: tests write through
  // the interface, `connectionsFor` reads through this map, and the build
  // broke on a field one had and the other did not. One declaration cannot
  // drift from itself.
  const chatConnections: TestRuntime["chatConnections"] = new Map();
  const submittedTasks: TestRuntime["submittedTasks"] = [];
  const chatPrompts: TestRuntime["chatPrompts"] = [];
  const chatAnswer: TestRuntime["chatAnswer"] = {};
  /** How the agent answers "is this work?" — "yes" unless a test says else. */
  let taskClassification = "yes";
  const canonicalDiffs: TestRuntime["canonicalDiffs"] = [];
  const rollbacks: TestRuntime["rollbacks"] = [];
  // What `rollbackRepository` answers. Undefined is the ordinary success; a
  // test sets it to make a revert fail the way a real one can.
  let rollbackOutcome: { status: string; explanation: string } | undefined;
  const runCalls: TestRuntime["runCalls"] = [];
  const cancelCalls: TestRuntime["cancelCalls"] = [];
  // Models canonical mirrors independently from persistence. Deleting only
  // the store record must not make this name reusable in the fixture: the
  // production bug was precisely that the mirror survived that deletion.
  const canonicalRepositoryNames = new Set<string>();
  const attachmentBytes = new Map<
    string,
    { bytes: Buffer; contentType: string }
  >();
  const canonicalState: TestRuntime["canonicalState"] = {
    head: "b".repeat(40),
  };
  const runFailure: TestRuntime["runFailure"] = {};
  const canonicalDiff: TestRuntime["canonicalDiff"] = {
    files: ["src/server.ts"],
    patch: "@@ -1 +1 @@\n-const ok = a && b;\n+const ok = a || b;",
    truncated: false,
  };
  const performChat = async (
    input: any,
    onEvent?: (event: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> => {
    const asked = String(input?.messages?.[0]?.content ?? "");
    chatPrompts.push({
      userId: String(input?.userId ?? ""),
      provider: String(input?.provider ?? ""),
      prompt: asked,
    });
    // The unnamed path asks the agent whether a message is work before it
    // offers to take it. Answered here rather than through `chatAnswer` so a
    // test about dispatch does not have to know the question exists; a test
    // about the check itself sets `taskClassification` to "no".
    if (/Answer with one word: yes or no/u.test(asked)) {
      return { text: taskClassification };
    }
    for (const event of chatAnswer.streamEvents ?? []) {
      onEvent?.(event);
    }
    if (chatAnswer.delayMs !== undefined) {
      // A slow provider, which is the ordinary case this exists to test:
      // anything the channel does *after* awaiting a completion is something
      // a person is waiting on.
      await new Promise((resolve) => setTimeout(resolve, chatAnswer.delayMs));
    }
    if (chatAnswer.fail !== undefined) {
      throw new Error(chatAnswer.fail);
    }
    return {
      ...(chatAnswer.text === undefined ? {} : { text: chatAnswer.text }),
      ...(chatAnswer.thinking === undefined
        ? {}
        : { thinking: chatAnswer.thinking }),
      ...(chatAnswer.thinkingHidden === undefined
        ? {}
        : { thinkingHidden: chatAnswer.thinkingHidden }),
      ...(chatAnswer.thinkingTokens === undefined
        ? {}
        : { usage: { thinkingTokens: chatAnswer.thinkingTokens } }),
    };
  };
  const operations: ApiOperations = {
    chatProviders: {
      async list() {
        return [];
      },
      async signIn() {
        return {};
      },
      async connect() {
        return {};
      },
      async disconnect() {},
      async options() {
        return {};
      },
      async usage() {
        return {};
      },
      async setSettings(input) {
        // Only the call sign, which is the one setting the gateway does more
        // than relay: a rename is account-wide, so the fixture has to behave
        // like the real service — refuse a vendor this account has not
        // connected, and otherwise write the name where both readers of it
        // look (the connection the roster resolves through, and the durable
        // store).
        const connections = chatConnections.get(input.userId) ?? [];
        const connection = connections.find(
          (entry) => entry.provider === input.provider,
        );
        if (connection === undefined) {
          throw Object.assign(
            new Error(`Connect ${input.provider} before changing its settings`),
            { status: 409, code: "not_connected" },
          );
        }
        if (input.callSign !== undefined) {
          const trimmed = input.callSign.trim();
          if (trimmed.length > 40) {
            throw Object.assign(
              new Error("A call sign is at most 40 characters"),
              { status: 400, code: "invalid_call_sign" },
            );
          }
          if (trimmed === "") {
            delete connection.callSign;
            await store.clearAgentCallSign(input.userId, input.provider);
          } else {
            connection.callSign = trimmed;
            await store.setAgentCallSign(input.userId, input.provider, trimmed);
          }
        }
        return {};
      },
      async complete(input: any) {
        return await performChat(input);
      },
      async completeStream(input: any, onEvent: (event: any) => void) {
        return await performChat(input, onEvent);
      },
      async connectionsFor(userIds) {
        const result: Record<
          string,
          Array<{
            provider: string;
            visibility: "personal" | "org";
            callSign?: string;
          }>
        > = {};
        for (const userId of userIds) {
          result[userId] = (chatConnections.get(userId) ?? []).map(
            (connection) => ({
              provider: connection.provider,
              visibility: connection.visibility ?? "personal",
              // Omitted rather than sent undefined, exactly as the real
              // service does: a connection with no name has no key, which is
              // what the roster's fallback keys off.
              ...(connection.callSign === undefined
                ? {}
                : { callSign: connection.callSign }),
            }),
          );
        }
        return result;
      },
    },
    async listAgents() {
      // One per vendor, as a deployment with several CLIs connected has, and
      // named to match what `submitTask` below resolves a vendor to — the
      // pairing a real deployment makes through `resolveAgentIdForVendor`.
      // Recent-activity attribution joins tasks to agents on exactly these
      // ids, so a fixture reporting only one agent could not tell two
      // vendors' work apart at all.
      return [
        { id: "test-agent", adapter: "generic-cli", default: true },
        { id: "test-agent-claude", adapter: "claude", default: false },
        { id: "test-agent-codex", adapter: "codex", default: false },
        { id: "test-agent-gemini", adapter: "gemini", default: false },
      ];
    },
    async createRepository(input) {
      if (canonicalRepositoryNames.has(input.id)) {
        throw new Error(`A repository named ${input.id} is already registered`);
      }
      const repository = {
        id: input.id,
        path: `/canonical/${input.id}.git`,
        branch: input.branch ?? "main",
        createdBy: input.actorId,
      };
      await store.saveRepository(repository);
      await store.linkRepository(input.projectId, repository.id);
      canonicalRepositoryNames.add(repository.id);
      return repository;
    },
    async deleteRepository(input) {
      await store.removeRepository(input.repositoryId);
      canonicalRepositoryNames.delete(input.repositoryId);
    },
    async importGitHub(input) {
      const repository = {
        id: input.id ?? "imported",
        path: "/canonical/imported.git",
        branch: input.branch ?? "main",
        provider: "github" as const,
        remoteUrl: `https://github.com/${input.repository}.git`,
        createdBy: input.actorId,
      };
      await store.saveRepository(repository);
      await store.linkRepository(input.projectId, repository.id);
      canonicalRepositoryNames.add(repository.id);
      return repository;
    },
    async submitTask(input) {
      submittedTasks.push({
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        objective: input.objective,
        actorId: input.actorId,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        ...(input.vendor === undefined ? {} : { vendor: input.vendor }),
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.conversationId === undefined
          ? {}
          : { conversationId: input.conversationId }),
        ...(input.planOnly === undefined ? {} : { planOnly: input.planOnly }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
      });
      return await store.submitTask({
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        objective: input.objective,
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.conversationId === undefined
          ? {}
          : { conversationId: input.conversationId }),
        // Carried through, because holding the row is the behaviour under
        // test: a fixture that dropped this would file every plan as
        // ordinary queued work and quietly pass.
        ...(input.planOnly === true ? { planOnly: true } : {}),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        // A real deployment resolves `vendor` to one of its own configured
        // agent ids (see `resolveAgentIdForVendor` in apps/web/src/index.ts);
        // the fixture only needs a stable, distinguishable id back.
        agentId: input.agentId ?? (input.vendor === undefined ? "test-agent" : `test-agent-${input.vendor}`),
        validationCommands: [],
        submittedBy: input.actorId,
      });
    },
    async runRepository() {
      runCalls.push(Date.now());
      if (runFailure.error !== undefined) {
        throw runFailure.error;
      }
      if (runFailure.reason !== undefined) {
        throw new Error(runFailure.reason);
      }
    },
    async cancelTasks(input) {
      cancelCalls.push({
        repositoryId: input.repositoryId,
        ...(input.taskIds === undefined ? {} : { taskIds: [...input.taskIds] }),
        ...(input.vendor === undefined ? {} : { vendor: input.vendor }),
        ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
        reason: input.reason,
        actorId: input.actorId,
      });
      // The store half of the real implementation (apps/cli's `cancelTasks`),
      // which is everything the gateway's own behavior depends on: rows go
      // terminal, and the audit events the channel narrates from land.
      const agentId =
        input.vendor === undefined ? undefined : `test-agent-${input.vendor}`;
      const explicit =
        input.taskIds === undefined ? undefined : new Set(input.taskIds);
      const cancellable = new Set(["submitted", "claimed", "planned", "open"]);
      const cancelled: Array<{
        id: string;
        agentId: string;
        objective: string;
        was: "running" | "queued" | "held" | "waiting";
      }> = [];
      for (const task of await store.listSubmittedTasks({
        repositoryId: input.repositoryId,
      })) {
        if (!cancellable.has(task.status)) {
          continue;
        }
        if (
          explicit !== undefined
            ? !explicit.has(task.id)
            : task.status === "open" ||
              (agentId !== undefined && task.agentId !== agentId) ||
              (input.ownerId !== undefined &&
                task.submittedBy !== input.ownerId)
        ) {
          continue;
        }
        const was =
          task.status === "claimed"
            ? ("running" as const)
            : task.status === "planned"
              ? ("held" as const)
              : task.status === "open"
                ? ("waiting" as const)
                : ("queued" as const);
        await store.cancelSubmittedTask(task.id);
        await store.appendAudit(undefined, {
          type: "task_cancelled",
          taskId: task.id,
          data: { actorId: input.actorId, reason: input.reason },
        });
        cancelled.push({
          id: task.id,
          agentId: task.agentId,
          objective: task.objective,
          was,
        });
      }
      return { cancelled };
    },
    async canonicalDiff(input) {
      canonicalDiffs.push(input);
      return canonicalDiff;
    },
    async canonicalHead() {
      return canonicalState.head;
    },
    async attachmentPath(id: string) {
      // Only the ids a test stored; anything else is genuinely missing, which
      // is the case the second attachment test covers.
      return /^a{32}\.(png|jpg|gif|webp)$/u.test(id)
        ? `/var/data/.coordinator/attachments/${id}`
        : undefined;
    },
    async rollbackRepository(input) {
      rollbacks.push({
        repositoryId: input.repositoryId,
        targetRevision: input.targetRevision,
        // Forwarded so a test can hold `/stop` to undoing its own task rather
        // than the whole tree.
        ...(input.files === undefined ? {} : { files: input.files }),
      });
      return (
        rollbackOutcome ?? {
          status: "integrated",
          explanation: "reverted",
          revision: input.targetRevision,
        }
      );
    },
    // The real store's allowlist, in miniature: the deployment decides what an
    // image is, and the gateway only ever passes bytes through.
    async attachmentSave(input) {
      const extension = { "image/png": "png", "image/jpeg": "jpg" }[
        input.contentType.split(";")[0]?.trim() ?? ""
      ];
      if (extension === undefined) {
        throw new Error(`Images must be PNG or JPEG (not ${input.contentType})`);
      }
      const id = `${"a".repeat(32)}.${extension}`;
      attachmentBytes.set(id, {
        bytes: input.bytes,
        contentType: input.contentType,
      });
      return id;
    },
    async attachmentRead(id) {
      return attachmentBytes.get(id);
    },
    async projectMetrics(input) {
      return { stub: true, projectId: input.projectId };
    },
    async leaseWork(input) {
      const leased = await store.leaseNextTask({
        workerId: input.workerId,
        projectId: input.projectId,
        baseRevision: "a".repeat(40),
        ttlMs: 5 * 60 * 1000,
        ...(input.repositoryId === undefined
          ? {}
          : { repositoryId: input.repositoryId }),
      });
      if (leased === undefined) {
        return undefined;
      }
      return {
        lease: leased.lease,
        task: leased.task,
        repository: { id: leased.task.repositoryId, branch: "main" },
        canonicalVersion: {
          sequence: 1,
          revision: "a".repeat(40),
          branch: "main",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        bundleUrl: `/api/v1/workers/leases/${leased.lease.id}/bundle`,
        bundleRef: `refs/coord/leases/${leased.lease.id}`,
        heartbeatIntervalMs: 60_000,
        protocolVersion: 2,
        planUrl: `/api/v1/workers/leases/${leased.lease.id}/plan`,
      };
    },
    async leaseBundle() {
      return Buffer.from("PACK-placeholder");
    },
    async admitWorkPlan(input) {
      const lease = await store.getWorkLease(input.leaseId);
      if (lease === undefined || lease.status !== "active") {
        return { outcome: "lease_lost", reason: "lease is not active" };
      }
      return {
        outcome: "admitted",
        admission: { status: "approved", taskId: lease.taskId },
      };
    },
    async acceptWorkResult(input) {
      await store.finishWorkLease(
        input.leaseId,
        input.status,
        new Date().toISOString(),
        input.detail,
      );
      return { accepted: true };
    },
  };
  if (options.withoutListAgents === true) {
    delete operations.listAgents;
  }
  const gateway = new ApiGateway({
    store,
    operations,
    bootstrapToken: BOOTSTRAP_TOKEN,
    ...(options.allowedOrigins === undefined
      ? {}
      : { allowedOrigins: options.allowedOrigins }),
    ...(options.webSocketPollIntervalMs === undefined
      ? {}
      : { webSocketPollIntervalMs: options.webSocketPollIntervalMs }),
    ...(options.webSocketReauthorizeIntervalMs === undefined
      ? {}
      : {
          webSocketReauthorizeIntervalMs:
            options.webSocketReauthorizeIntervalMs,
        }),
    ...(options.auditorPollIntervalMs === undefined
      ? {}
      : { auditorPollIntervalMs: options.auditorPollIntervalMs }),
    staticAssets: new Map([
      [
        "/index.html",
        { body: "<!doctype html><title>Relay</title>", contentType: "text/html" },
      ],
    ]),
  });
  await new Promise<void>((resolve, reject) => {
    gateway.server.once("error", reject);
    gateway.server.listen(0, "127.0.0.1", resolve);
  });
  const address = gateway.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test gateway did not bind a TCP port");
  }
  t.after(async () => {
    await gateway.close();
    await store.close();
  });
  return {
    gateway,
    store,
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    chatConnections,
    submittedTasks,
    chatPrompts,
    chatAnswer,
    canonicalDiffs,
    rollbacks,
    setRollbackOutcome: (outcome) => {
      rollbackOutcome = outcome;
    },
    setTaskClassification: (answer) => {
      taskClassification = answer;
    },
    runCalls,
    cancelCalls,
    canonicalDiff,
    canonicalState,
    runFailure,
  };
}

async function bootstrap(client: TestClient): Promise<any> {
  const response = await client.request("/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "X-Bootstrap-Token": BOOTSTRAP_TOKEN },
    body: {
      email: "owner@example.com",
      displayName: "Owner",
      password: PASSWORD,
      organizationName: "Relay Test",
    },
  });
  assert.equal(response.status, 201);
  return response.data;
}

/**
 * A repository to invite somebody to, since every invitation names one.
 *
 * Invitations are deliberately repository-scoped: there is no way to ask for
 * the whole organization, so a test that wants to invite anybody has to say
 * where to.
 */
async function invitableRepository(
  client: TestClient,
  id = "shared-repo",
): Promise<string> {
  const created = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
    { method: "POST", body: { id, branch: "main" } },
  );
  assert.equal(created.status, 201);
  return id;
}

/**
 * Puts every connected agent into a channel, the way the roster UI does.
 *
 * A repository created through the API now starts with nobody in its channel
 * — see `markChannelMembershipChosen`. Membership used to arrive by accident,
 * through a grandfather backfill meant for repositories that predate opt-in
 * and which a brand-new repository was also taking. So a test that wants a
 * roster now has to say so, exactly as a person does.
 */
async function joinAllConnectedAgents(
  runtime: TestRuntime,
  repositoryId: string,
): Promise<void> {
  for (const [userId, connections] of runtime.chatConnections) {
    for (const connection of connections) {
      await runtime.store.setChannelAgentMember(
        repositoryId,
        userId,
        connection.provider,
        true,
      );
    }
  }
}

/** The body every invitation needs: who, what role, and which repository. */
function inviteBody(
  email: string,
  role: string,
  repositoryId: string,
): Record<string, unknown> {
  return { email, role, repositoryId, projectId: DEFAULT_PROJECT_ID };
}

test("bootstrap, sessions, CSRF, static fallback, and logout work over HTTP", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);

  const initialHealth = await client.request("/api/v1/health");
  assert.equal(initialHealth.status, 200);
  assert.equal(initialHealth.data.setupRequired, true);

  const setup = await bootstrap(client);
  assert.equal(setup.user.email, "owner@example.com");
  assert.match(client.cookieHeader, /coord_session=/u);
  assert.match(client.cookieHeader, /coord_csrf=/u);

  const me = await client.request("/api/v1/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.user.displayName, "Owner");

  const createdRepository = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
    {
      method: "POST",
      body: { id: "greenfield", branch: "trunk" },
    },
  );
  assert.equal(createdRepository.status, 201);
  assert.equal(createdRepository.data.repository.id, "greenfield");
  assert.equal(createdRepository.data.repository.branch, "trunk");
  const repositories = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
  );
  assert.deepEqual(
    repositories.data.repositories.map(
      (repository: { id: string }) => repository.id,
    ),
    ["greenfield"],
  );
  assert.equal(
    (await runtime.store.listAuditEvents({ types: ["repository_created"] }))
      .length,
    1,
  );

  const missingCsrf = await client.request("/api/v1/organizations", {
    method: "POST",
    csrf: false,
    body: { slug: "blocked", name: "Blocked" },
  });
  assert.equal(missingCsrf.status, 403);
  assert.equal(missingCsrf.data.error.code, "csrf_failed");

  const created = await client.request("/api/v1/organizations", {
    method: "POST",
    body: { slug: "new-team", name: "New team" },
  });
  assert.equal(created.status, 201);

  const invalidEmail = await client.request("/api/v1/admin/users", {
    method: "POST",
    body: {
      email: "not-an-email",
      displayName: "Invalid",
      password: PASSWORD,
    },
  });
  assert.equal(invalidEmail.status, 400);
  assert.equal(invalidEmail.data.error.code, "invalid_email");

  const staticPage = await client.request("/some/client/route");
  assert.equal(staticPage.status, 200);
  assert.equal(staticPage.headers.get("cache-control"), "no-cache");
  assert.equal(staticPage.headers.get("content-security-policy")?.includes("object-src 'none'"), true);
  const etag = staticPage.headers.get("etag");
  assert.ok(etag);
  const unchangedPage = await client.request("/some/client/route", {
    headers: { "If-None-Match": etag },
  });
  assert.equal(unchangedPage.status, 304);

  const logout = await client.request("/api/v1/auth/logout", {
    method: "POST",
    body: {},
  });
  assert.equal(logout.status, 200);
  assert.equal((await client.request("/api/v1/auth/me")).status, 401);
});

test("project authorization isolates tenants and enforces viewer permissions", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const firstOrganization = await owner.request("/api/v1/organizations", {
    method: "POST",
    body: { slug: "first", name: "First" },
  });
  const secondOrganization = await owner.request("/api/v1/organizations", {
    method: "POST",
    body: { slug: "second", name: "Second" },
  });
  const firstId = firstOrganization.data.organization.id;
  const secondId = secondOrganization.data.organization.id;
  const firstProject = await owner.request(
    `/api/v1/organizations/${firstId}/projects`,
    {
      method: "POST",
      body: { slug: "project-a", name: "Project A" },
    },
  );
  const secondProject = await owner.request(
    `/api/v1/organizations/${secondId}/projects`,
    {
      method: "POST",
      body: { slug: "project-b", name: "Project B" },
    },
  );
  const user = await owner.request("/api/v1/admin/users", {
    method: "POST",
    body: {
      email: "viewer@example.com",
      displayName: "Viewer",
      password: PASSWORD,
    },
  });
  await owner.request(`/api/v1/organizations/${firstId}/members`, {
    method: "POST",
    body: { userId: user.data.user.id, role: "viewer" },
  });

  const viewer = new TestClient(runtime.origin);
  const login = await viewer.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "viewer@example.com", password: PASSWORD },
  });
  assert.equal(login.status, 200);

  assert.equal(
    (
      await viewer.request(
        `/api/v1/projects/${firstProject.data.project.id}`,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await viewer.request(
        `/api/v1/projects/${secondProject.data.project.id}`,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await viewer.request(
        `/api/v1/projects/${firstProject.data.project.id}/tasks`,
        {
          method: "POST",
          body: {
            repositoryId: "missing",
            objective: "Viewer must not submit",
          },
        },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await viewer.request(
        `/api/v1/projects/${firstProject.data.project.id}/repositories`,
        {
          method: "POST",
          body: { id: "viewer-cannot-create" },
        },
      )
    ).status,
    403,
  );
  const agents = await viewer.request(
    `/api/v1/projects/${firstProject.data.project.id}/agents`,
  );
  assert.equal(agents.status, 200);
  assert.equal(agents.data.agents[0].id, "test-agent");
});

test("approval decisions are project-authorized and durably audited", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  const setup = await bootstrap(client);
  const approval = await runtime.store.createApproval({
    organizationId: DEFAULT_ORGANIZATION_ID,
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: "repo_test",
    runId: "run_test",
    taskId: "task_test",
    kind: "changeset",
    requestedBy: setup.user.id,
    requiredRole: "reviewer",
    reasons: ["Protected changeset"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const listed = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/approvals?status=pending`,
  );
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.data.approvals.map((entry: any) => entry.id),
    [approval.id],
  );

  const decided = await client.request(`/api/v1/approvals/${approval.id}`, {
    method: "POST",
    body: { status: "approved", comment: "Reviewed in the test" },
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.data.approval.status, "approved");
  assert.equal(
    (await runtime.store.getApproval(approval.id))?.decisionComment,
    "Reviewed in the test",
  );
  assert.equal(
    (await runtime.store.listAuditEvents()).some(
      (entry) =>
        entry.event.type === "approval_decided" &&
        entry.event.data["approvalId"] === approval.id,
    ),
    true,
  );
});

function decodeTextFrames(buffer: Buffer): string[] {
  const messages: string[] = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    if (first === undefined || second === undefined) {
      break;
    }
    let length = second & 0x7f;
    let header = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) {
        break;
      }
      length = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) {
        break;
      }
      length = Number(buffer.readBigUInt64BE(offset + 2));
      header = 10;
    }
    if (buffer.length - offset < header + length) {
      break;
    }
    if ((first & 0x0f) === 0x1) {
      messages.push(
        buffer.subarray(offset + header, offset + header + length).toString("utf8"),
      );
    }
    offset += header + length;
  }
  return messages;
}

function decodeCloseCode(buffer: Buffer): number | undefined {
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    if (first === undefined || second === undefined) {
      return undefined;
    }
    let length = second & 0x7f;
    let header = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) {
        return undefined;
      }
      length = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) {
        return undefined;
      }
      length = Number(buffer.readBigUInt64BE(offset + 2));
      header = 10;
    }
    if (buffer.length - offset < header + length) {
      return undefined;
    }
    if ((first & 0x0f) === 0x8 && length >= 2) {
      return buffer.readUInt16BE(offset + header);
    }
    offset += header + length;
  }
  return undefined;
}

test("authenticated WebSockets stream only project-visible audit events", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);
  await runtime.store.appendAudit(undefined, {
    type: "project_changed",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      organizationId: DEFAULT_ORGANIZATION_ID,
      action: "test-event",
    },
  });

  const payloads = await new Promise<any[]>((resolve, reject) => {
    const socket = net.createConnection(runtime.port, "127.0.0.1");
    let response = Buffer.alloc(0);
    let headersRead = false;
    let frameBytes = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for project audit WebSocket event"));
    }, 4_000);
    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write(
        `GET /api/v1/events?projectId=${DEFAULT_PROJECT_ID}&after=0 HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${runtime.port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n" +
          `Origin: ${runtime.origin}\r\n` +
          `Cookie: ${client.cookieHeader}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      if (!headersRead) {
        response = Buffer.concat([response, chunk]);
        const boundary = response.indexOf("\r\n\r\n");
        if (boundary < 0) {
          return;
        }
        const headers = response.subarray(0, boundary).toString("ascii");
        assert.match(headers, /^HTTP\/1\.1 101 /u);
        frameBytes = response.subarray(boundary + 4);
        headersRead = true;
      } else {
        frameBytes = Buffer.concat([frameBytes, chunk]);
      }
      const messages = decodeTextFrames(frameBytes).map((entry) =>
        JSON.parse(entry),
      );
      if (
        messages.some(
          (entry) =>
            entry.type === "audit" &&
            entry.event?.data?.action === "test-event",
        )
      ) {
        clearTimeout(timer);
        socket.destroy();
        resolve(messages);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  assert.equal(payloads[0]?.type, "connected");
  assert.equal(
    payloads.some((entry) => entry.type === "audit"),
    true,
  );
});

test("open WebSockets are closed when their user is disabled", async (t) => {
  const runtime = await startRuntime(t, {
    webSocketPollIntervalMs: 10,
    webSocketReauthorizeIntervalMs: 20,
  });
  const client = new TestClient(runtime.origin);
  const setup = await bootstrap(client);

  const closeCode = await new Promise<number>((resolve, reject) => {
    const socket = net.createConnection(runtime.port, "127.0.0.1");
    let response = Buffer.alloc(0);
    let headersRead = false;
    let frameBytes = Buffer.alloc(0);
    let disabled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for WebSocket authorization refresh"));
    }, 4_000);
    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write(
        `GET /api/v1/events?projectId=${DEFAULT_PROJECT_ID} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${runtime.port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n" +
          `Origin: ${runtime.origin}\r\n` +
          `Cookie: ${client.cookieHeader}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        if (!headersRead) {
          response = Buffer.concat([response, chunk]);
          const boundary = response.indexOf("\r\n\r\n");
          if (boundary < 0) {
            return;
          }
          assert.match(
            response.subarray(0, boundary).toString("ascii"),
            /^HTTP\/1\.1 101 /u,
          );
          frameBytes = response.subarray(boundary + 4);
          headersRead = true;
        } else {
          frameBytes = Buffer.concat([frameBytes, chunk]);
        }
        const connected = decodeTextFrames(frameBytes).some(
          (entry) => JSON.parse(entry).type === "connected",
        );
        if (connected && !disabled) {
          disabled = true;
          void runtime.store
            .updateUser(setup.user.id, { disabled: true })
            .catch(reject);
        }
        const code = decodeCloseCode(frameBytes);
        if (code !== undefined) {
          clearTimeout(timer);
          socket.destroy();
          resolve(code);
        }
      } catch (error) {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  assert.equal(closeCode, 1008);
});

/** A bare fetch with no cookies, standing in for a CLI, worker, or agent. */
async function bearer(
  origin: string,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; data: any }> {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    data: text.length === 0 ? undefined : JSON.parse(text),
  };
}

test("api tokens authenticate headless clients without cookies or CSRF", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const created = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: {
      name: "ci-worker",
      scopes: ["view", "run_task", "manage_organization"],
    },
  });
  assert.equal(created.status, 201);
  const token = created.data.token as string;
  assert.match(token, /^coord_pat_/u);
  assert.deepEqual(created.data.scopes, [
    "view",
    "run_task",
    "manage_organization",
  ]);

  // No cookie jar at all: this is what a CLI or worker looks like.
  const me = await bearer(runtime.origin, "/api/v1/auth/me", token);
  assert.equal(me.status, 200);
  assert.equal(me.data.credential, "api_token");
  assert.equal(me.data.user.email, "owner@example.com");
  assert.equal(me.data.sessionId, undefined);
  assert.equal(me.data.token.name, "ci-worker");

  // A write with no CSRF header at all. The same request over a cookie
  // session is rejected with csrf_failed, so this is the distinguishing case.
  const organizations = await bearer(
    runtime.origin,
    "/api/v1/organizations",
    token,
    { method: "POST", body: { slug: "by-token", name: "By token" } },
  );
  assert.equal(organizations.status, 201);

  const listed = await client.request("/api/v1/auth/tokens");
  assert.equal(listed.status, 200);
  assert.equal(listed.data.tokens.length, 1);
  // Listing must never expose the secret.
  assert.equal(listed.data.tokens[0].token, undefined);
  assert.equal(listed.data.tokens[0].active, true);
  assert.ok(!JSON.stringify(listed.data).includes(token));
});

test("a token is confined to the scopes it was granted", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const readOnly = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "read-only", scopes: ["view"] },
  });
  assert.equal(readOnly.status, 201);
  const token = readOnly.data.token as string;

  // "view" is granted, so reading is fine.
  const organizations = await bearer(runtime.origin, "/api/v1/organizations", token);
  assert.equal(organizations.status, 200);

  // The owner could create an organization, but this token cannot: the
  // effective permission is the intersection of role and scope.
  const denied = await bearer(runtime.origin, "/api/v1/organizations", token, {
    method: "POST",
    body: { slug: "nope", name: "Nope" },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error.code, "token_scope_missing");
});

test("a token cannot be granted more than its owner's role allows", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const organizationId = (await owner.request("/api/v1/organizations")).data
    .organizations[0].id as string;

  // Created directly so the test exercises scope bounding, not invite plumbing.
  const viewerUser = await runtime.store.createUser({
    email: "viewer@example.com",
    displayName: "Viewer",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId,
    userId: viewerUser.id,
    role: "viewer",
  });

  const viewer = new TestClient(runtime.origin);
  const login = await viewer.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "viewer@example.com", password: PASSWORD },
  });
  assert.equal(login.status, 200);

  // A viewer holds only "view", so a wider token must be refused outright.
  const escalation = await viewer.request("/api/v1/auth/tokens", {
    method: "POST",
    body: {
      name: "escalate",
      scopes: ["view", "manage_organization"],
      organizationId,
    },
  });
  assert.equal(escalation.status, 403);
  assert.equal(escalation.data.error.code, "scope_exceeds_role");

  const allowed = await viewer.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "fine", scopes: ["view"], organizationId },
  });
  assert.equal(allowed.status, 201);

  // And that token is confined to the organization it was bound to.
  const elsewhere = await bearer(
    runtime.origin,
    "/api/v1/organizations",
    allowed.data.token as string,
    { method: "POST", body: { slug: "other", name: "Other" } },
  );
  assert.equal(elsewhere.status, 403);
});

test("a token cannot mint another token", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const created = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "worker", scopes: ["view", "manage_organization"] },
  });
  const token = created.data.token as string;

  // Otherwise a leaked credential could refresh itself forever and revocation
  // would mean nothing.
  const minted = await bearer(runtime.origin, "/api/v1/auth/tokens", token, {
    method: "POST",
    body: { name: "child", scopes: ["view"] },
  });
  assert.equal(minted.status, 403);
  assert.equal(minted.data.error.code, "session_required");
});

test("revoking a token stops it immediately", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const created = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "temp", scopes: ["view"] },
  });
  const token = created.data.token as string;
  const tokenId = created.data.id as string;

  assert.equal((await bearer(runtime.origin, "/api/v1/auth/me", token)).status, 200);

  const revoked = await client.request(`/api/v1/auth/tokens/${tokenId}`, {
    method: "DELETE",
  });
  assert.equal(revoked.status, 200);

  const after = await bearer(runtime.origin, "/api/v1/auth/me", token);
  assert.equal(after.status, 401);

  const listed = await client.request("/api/v1/auth/tokens");
  assert.equal(listed.data.tokens[0].active, false);
  assert.notEqual(listed.data.tokens[0].revokedAt, undefined);
});

test("a bearer principal cannot sign out a session it does not have", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const created = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "worker", scopes: ["view"] },
  });
  const logout = await bearer(
    runtime.origin,
    "/api/v1/auth/logout",
    created.data.token as string,
    { method: "POST" },
  );
  assert.equal(logout.status, 400);
  assert.equal(logout.data.error.code, "not_a_session");
});

test("invalid and malformed tokens are refused", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  for (const candidate of [
    "coord_pat_unknown.secret",
    "coord_pat_malformed",
    "not-a-token",
  ]) {
    const response = await bearer(runtime.origin, "/api/v1/auth/me", candidate);
    assert.equal(response.status, 401, candidate);
  }
});

/**
 * The remote worker protocol, exercised the way a worker actually uses it:
 * bearer token only, no cookies, lease -> bundle -> result.
 */
async function workerRuntime(t: TestContext) {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);
  const created = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "fleet", scopes: ["view", "run_task"] },
  });
  assert.equal(created.status, 201);
  return { runtime, client, token: created.data.token as string };
}

test("a worker registers, leases exclusively, and heartbeats", async (t) => {
  const { runtime, token } = await workerRuntime(t);

  const registered = await bearer(runtime.origin, "/api/v1/workers/register", token, {
    method: "POST",
    body: { organizationId: DEFAULT_ORGANIZATION_ID, name: "worker-a", adapters: ["codex"], version: "1.0.0" },
  });
  assert.equal(registered.status, 201);
  const workerId = registered.data.id as string;

  const unscoped = await bearer(
    runtime.origin,
    "/api/v1/workers/leases",
    token,
    { method: "POST", body: { workerId } },
  );
  assert.equal(unscoped.status, 400);

  // Nothing queued yet, so the poll must say so without a body.
  const empty = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  assert.equal(empty.status, 204);

  await runtime.store.saveRepository({
    id: "repo_worker",
    path: "/canonical/worker.git",
    branch: "main",
  });
  const task = await runtime.store.submitTask({
    repositoryId: "repo_worker",
    objective: "cap the value",
    agentId: "codex",
    validationCommands: [],
  });

  const leased = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  assert.equal(leased.status, 200);
  assert.equal(leased.data.task.id, task.id);
  assert.equal(leased.data.lease.status, "active");
  assert.ok(leased.data.bundleUrl.includes(leased.data.lease.id));

  // A second poll finds nothing: the task is exclusively held.
  const second = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  assert.equal(second.status, 204);

  const beat = await bearer(
    runtime.origin,
    `/api/v1/workers/leases/${leased.data.lease.id}/heartbeat`,
    token,
    { method: "POST" },
  );
  assert.equal(beat.status, 200);
  assert.ok(beat.data.expiresAt > leased.data.lease.expiresAt);
});

test("releasing a lease returns the task to the queue", async (t) => {
  const { runtime, token } = await workerRuntime(t);
  const workerId = (
    await bearer(runtime.origin, "/api/v1/workers/register", token, {
      method: "POST",
      body: { organizationId: DEFAULT_ORGANIZATION_ID, name: "w", adapters: [], version: "1" },
    })
  ).data.id as string;

  await runtime.store.saveRepository({
    id: "repo_release",
    path: "/canonical/release.git",
    branch: "main",
  });
  await runtime.store.submitTask({
    repositoryId: "repo_release",
    objective: "objective",
    agentId: "codex",
    validationCommands: [],
  });

  const leased = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  const released = await bearer(
    runtime.origin,
    `/api/v1/workers/leases/${leased.data.lease.id}/release`,
    token,
    { method: "POST" },
  );
  assert.equal(released.status, 200);

  // Another poll now finds the work again.
  const relet = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  assert.equal(relet.status, 200);

  // A heartbeat on the abandoned lease must be refused, not silently accepted.
  const stale = await bearer(
    runtime.origin,
    `/api/v1/workers/leases/${leased.data.lease.id}/heartbeat`,
    token,
    { method: "POST" },
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, "lease_lost");
});

test("worker endpoints require the run_task scope", async (t) => {
  const { runtime, client } = await workerRuntime(t);
  const readOnly = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "read-only", scopes: ["view"] },
  });
  const token = readOnly.data.token as string;

  const denied = await bearer(runtime.origin, "/api/v1/workers/register", token, {
    method: "POST",
    body: { organizationId: DEFAULT_ORGANIZATION_ID, name: "w", adapters: [], version: "1" },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error.code, "token_scope_missing");
});

test("malformed hosts and encoded paths stay inside the HTTP error boundary", async (t) => {
  const runtime = await startRuntime(t);
  const hostResponse = await rawHttp(
    runtime.port,
    "GET /api/v1/health HTTP/1.1\r\n" +
      "Host: [malformed\r\n" +
      "Connection: close\r\n\r\n",
  );
  assert.match(hostResponse, /^HTTP\/1\.1 200 /u);

  const client = new TestClient(runtime.origin);
  await bootstrap(client);
  const malformedPath = await client.request("/api/v1/projects/%E0%A4%A");
  assert.equal(malformedPath.status, 400);
  assert.equal(malformedPath.data.error.code, "invalid_path");

  const healthy = await client.request("/api/v1/health");
  assert.equal(healthy.status, 200);
});

test("project metrics are served to members and refused across tenants", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const metrics = await owner.request(
    "/api/v1/projects/project_local/metrics",
  );
  assert.equal(metrics.status, 200);
  assert.equal(metrics.data.metrics.projectId, "project_local");

  // A signed-in user with no membership in the project's organization gets
  // the same generic refusal as for any other project-scoped resource.
  const outsiderUser = await runtime.store.createUser({
    email: "metrics-outsider@example.com",
    displayName: "Outsider",
    passwordDigest: await hashPassword(PASSWORD),
  });
  const outsider = new TestClient(runtime.origin);
  await outsider.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: outsiderUser.email, password: PASSWORD },
  });
  const denied = await outsider.request(
    "/api/v1/projects/project_local/metrics",
  );
  assert.equal(denied.status, 403);
});

test("project policy is validated, stored, and clearable through the API", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const invalid = await owner.request("/api/v1/projects/project_local", {
    method: "PATCH",
    body: { policy: { version: 2 } },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.error.code, "invalid_policy");

  const policy = {
    version: 1,
    approvals: { requireChangesetReview: true, protectedPaths: ["infra/**"] },
  };
  const set = await owner.request("/api/v1/projects/project_local", {
    method: "PATCH",
    body: { policy },
  });
  assert.equal(set.status, 200);
  assert.deepEqual(set.data.project.policy, policy);
  const fetched = await owner.request("/api/v1/projects/project_local");
  assert.deepEqual(fetched.data.project.policy, policy);

  const cleared = await owner.request("/api/v1/projects/project_local", {
    method: "PATCH",
    body: { policy: null },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.project.policy, undefined);
});

test("configured browser origins receive credentialed CORS and preflight", async (t) => {
  const allowedOrigin = "https://relay-client.example";
  const runtime = await startRuntime(t, {
    allowedOrigins: [allowedOrigin],
  });
  const preflight = await fetch(`${runtime.origin}/api/v1/auth/login`, {
    method: "OPTIONS",
    headers: {
      Origin: allowedOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-csrf-token",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    allowedOrigin,
  );
  assert.match(
    preflight.headers.get("access-control-allow-methods") ?? "",
    /POST/u,
  );
  assert.equal(
    preflight.headers.get("access-control-allow-credentials"),
    "true",
  );

  const allowed = await fetch(`${runtime.origin}/api/v1/health`, {
    headers: { Origin: allowedOrigin },
  });
  assert.equal(allowed.status, 200);
  assert.equal(
    allowed.headers.get("access-control-allow-origin"),
    allowedOrigin,
  );

  const denied = await fetch(`${runtime.origin}/api/v1/health`, {
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("a project-bound worker token cannot pull another tenant's queue", async (t) => {
  const { runtime } = await workerRuntime(t);
  const firstOrganization = await runtime.store.createOrganization({
    slug: "worker-first",
    name: "Worker First",
  });
  const secondOrganization = await runtime.store.createOrganization({
    slug: "worker-second",
    name: "Worker Second",
  });
  const firstProject = await runtime.store.createProject({
    organizationId: firstOrganization.id,
    slug: "first",
    name: "First",
  });
  const secondProject = await runtime.store.createProject({
    organizationId: secondOrganization.id,
    slug: "second",
    name: "Second",
  });
  const developer = await runtime.store.createUser({
    email: "fleet-developer@example.com",
    displayName: "Fleet Developer",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: firstOrganization.id,
    userId: developer.id,
    role: "developer",
  });
  const developerClient = new TestClient(runtime.origin);
  await developerClient.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: developer.email, password: PASSWORD },
  });
  const issued = await developerClient.request("/api/v1/auth/tokens", {
    method: "POST",
    body: {
      name: "tenant-worker",
      scopes: ["view", "run_task"],
      organizationId: firstOrganization.id,
    },
  });
  const token = issued.data.token as string;
  const worker = await bearer(
    runtime.origin,
    "/api/v1/workers/register",
    token,
    {
      method: "POST",
      body: {
        organizationId: firstOrganization.id,
        name: "tenant-worker",
        adapters: ["codex"],
        version: "1",
      },
    },
  );
  assert.equal(worker.status, 201);

  // A colleague's worker in the same organization. Fleet visibility is
  // org-wide, so this one must be visible to the developer even though they
  // did not register it.
  const colleague = await runtime.store.createUser({
    email: "colleague@example.com",
    displayName: "Colleague",
    passwordDigest: "unused",
  });
  await runtime.store.saveMembership({
    organizationId: firstOrganization.id,
    userId: colleague.id,
    role: "developer",
  });
  const colleagueWorker = await runtime.store.registerWorker({
    userId: colleague.id,
    organizationId: firstOrganization.id,
    name: "colleague-worker",
    adapters: ["codex"],
    version: "1",
  });

  // A worker in a different organization. Widening visibility within a tenant
  // must not widen it across one.
  const outsider = await runtime.store.createUser({
    email: "other-fleet@example.com",
    displayName: "Other Fleet",
    passwordDigest: "unused",
  });
  await runtime.store.registerWorker({
    userId: outsider.id,
    organizationId: secondOrganization.id,
    name: "other-worker",
    adapters: ["codex"],
    version: "1",
  });

  const visibleWorkers = await bearer(
    runtime.origin,
    `/api/v1/workers?organizationId=${firstOrganization.id}`,
    token,
  );
  assert.equal(visibleWorkers.status, 200);
  assert.deepEqual(
    visibleWorkers.data.workers
      .map((entry: { id: string }) => entry.id)
      .sort(),
    [worker.data.id, colleagueWorker.id].sort(),
  );
  // The colleague's worker is visible but not drivable: `own` is what the UI
  // uses to distinguish the two, and it must not be true here.
  assert.equal(
    visibleWorkers.data.workers.find(
      (entry: { id: string }) => entry.id === colleagueWorker.id,
    ).own,
    false,
  );

  // Naming the other tenant is refused outright rather than answered with an
  // empty list, and refused by the token binding before membership is even
  // consulted.
  const crossTenantFleet = await bearer(
    runtime.origin,
    `/api/v1/workers?organizationId=${secondOrganization.id}`,
    token,
  );
  assert.equal(crossTenantFleet.status, 403);
  assert.equal(crossTenantFleet.data.error.code, "token_organization_mismatch");

  await runtime.store.saveRepository({
    id: "repo_other_tenant",
    path: "/canonical/other-tenant.git",
    branch: "main",
  });
  await runtime.store.linkRepository(
    secondProject.id,
    "repo_other_tenant",
  );
  await runtime.store.submitTask({
    projectId: secondProject.id,
    repositoryId: "repo_other_tenant",
    objective: "private objective",
    agentId: "codex",
    validationCommands: [],
  });

  const ownQueue = await bearer(
    runtime.origin,
    "/api/v1/workers/leases",
    token,
    {
      method: "POST",
      body: {
        workerId: worker.data.id,
        projectId: firstProject.id,
      },
    },
  );
  assert.equal(ownQueue.status, 204);

  const crossTenant = await bearer(
    runtime.origin,
    "/api/v1/workers/leases",
    token,
    {
      method: "POST",
      body: {
        workerId: worker.data.id,
        projectId: secondProject.id,
      },
    },
  );
  assert.equal(crossTenant.status, 403);
  assert.equal(crossTenant.data.error.code, "token_organization_mismatch");
  assert.equal(
    (await runtime.store.listSubmittedTasks({ projectId: secondProject.id }))[0]
      ?.status,
    "submitted",
  );
});

/**
 * The fleet boundary, proved on the membership path rather than the token one.
 *
 * The neighbouring test authenticates with a token bound to one organization,
 * so it is refused by the credential's own binding before membership is ever
 * consulted. That check is worth having but it is not the boundary: a cookie
 * session carries no binding at all, so the only thing standing between a
 * signed-in user and another tenant's fleet is the membership lookup. This
 * test drives that path deliberately, and asserts the widening and the limit
 * together — seeing a colleague's worker and being refused a stranger's are
 * the same query differing only in which organization was named.
 */
test("org-wide worker visibility stops at the organization boundary", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const alpha = await runtime.store.createOrganization({
    slug: "alpha",
    name: "Alpha",
  });
  const beta = await runtime.store.createOrganization({
    slug: "beta",
    name: "Beta",
  });

  // Two members of Alpha, so "org-wide" is actually exercised: one registers a
  // worker, the other must still see it.
  const alphaUser = await runtime.store.createUser({
    email: "alpha-dev@example.com",
    displayName: "Alpha Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  const alphaColleague = await runtime.store.createUser({
    email: "alpha-colleague@example.com",
    displayName: "Alpha Colleague",
    passwordDigest: await hashPassword(PASSWORD),
  });
  const betaUser = await runtime.store.createUser({
    email: "beta-dev@example.com",
    displayName: "Beta Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  for (const [organizationId, userId] of [
    [alpha.id, alphaUser.id],
    [alpha.id, alphaColleague.id],
    [beta.id, betaUser.id],
  ] as const) {
    await runtime.store.saveMembership({
      organizationId,
      userId,
      role: "developer",
    });
  }

  const alphaOwn = await runtime.store.registerWorker({
    userId: alphaUser.id,
    organizationId: alpha.id,
    name: "alpha-own",
    adapters: ["codex"],
    version: "1",
  });
  const alphaOther = await runtime.store.registerWorker({
    userId: alphaColleague.id,
    organizationId: alpha.id,
    name: "alpha-colleague",
    adapters: ["codex"],
    version: "1",
  });
  const betaWorker = await runtime.store.registerWorker({
    userId: betaUser.id,
    organizationId: beta.id,
    name: "beta-secret",
    adapters: ["codex"],
    version: "1",
  });

  const client = new TestClient(runtime.origin);
  assert.equal(
    (
      await client.request("/api/v1/auth/login", {
        method: "POST",
        body: { email: alphaUser.email, password: PASSWORD },
      })
    ).status,
    200,
  );

  // The widening: a colleague's worker, which the old per-user filter hid.
  const visible = await client.request(
    `/api/v1/workers?organizationId=${alpha.id}`,
  );
  assert.equal(visible.status, 200);
  const visibleIds = visible.data.workers
    .map((entry: { id: string }) => entry.id)
    .sort();
  assert.deepEqual(visibleIds, [alphaOwn.id, alphaOther.id].sort());

  // The limit: Beta's worker is absent from Alpha's fleet, and naming Beta is
  // refused on membership — a plain `forbidden`, with no token binding
  // involved. Both are asserted because an endpoint that leaked the row while
  // refusing the request, or refused the request while leaking the row, would
  // pass only one of them.
  assert.equal(visibleIds.includes(betaWorker.id), false);
  const refused = await client.request(
    `/api/v1/workers?organizationId=${beta.id}`,
  );
  assert.equal(refused.status, 403);
  assert.equal(refused.data.error.code, "forbidden");

  // The counts endpoint reads the same fleet and must draw the same line;
  // a total that spans tenants reports how busy Beta is.
  const runningAlpha = await client.request(
    `/api/v1/agents/running?organizationId=${alpha.id}`,
  );
  assert.equal(runningAlpha.status, 200);
  assert.equal(runningAlpha.data.workers, 2);
  assert.equal(
    (await client.request(`/api/v1/agents/running?organizationId=${beta.id}`))
      .status,
    403,
  );

  // Naming no organization is refused rather than defaulted: an endpoint that
  // guessed a tenant would answer a request that never identified one.
  assert.equal((await client.request("/api/v1/workers")).status, 400);

  // Beta's own member sees Beta's fleet and only it, so the boundary is a
  // property of the organization asked about and not of this one user.
  const betaClient = new TestClient(runtime.origin);
  await betaClient.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: betaUser.email, password: PASSWORD },
  });
  const betaVisible = await betaClient.request(
    `/api/v1/workers?organizationId=${beta.id}`,
  );
  assert.equal(betaVisible.status, 200);
  assert.deepEqual(
    betaVisible.data.workers.map((entry: { id: string }) => entry.id),
    [betaWorker.id],
  );
  assert.equal(
    (
      await betaClient.request(
        `/api/v1/workers?organizationId=${alpha.id}`,
      )
    ).status,
    403,
  );
});

test("a task past its runtime budget is failed at heartbeat", async (t) => {
  const { runtime, token } = await workerRuntime(t);
  const workerId = (
    await bearer(runtime.origin, "/api/v1/workers/register", token, {
      method: "POST",
      body: { organizationId: DEFAULT_ORGANIZATION_ID, name: "budgeted", adapters: [], version: "1" },
    })
  ).data.id as string;
  await runtime.store.saveRepository({
    id: "repo_budget",
    path: "/canonical/budget.git",
    branch: "main",
  });
  await runtime.store.submitTask({
    repositoryId: "repo_budget",
    objective: "long-running objective",
    agentId: "codex",
    validationCommands: [],
  });
  await runtime.store.updateProject(DEFAULT_PROJECT_ID, {
    policy: { version: 1, budgets: { maxTaskRuntimeMs: 1 } },
  });

  const leased = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  assert.equal(leased.status, 200);
  const leaseId = leased.data.lease.id as string;

  await new Promise((resolve) => setTimeout(resolve, 20));
  const beat = await bearer(
    runtime.origin,
    `/api/v1/workers/leases/${leaseId}/heartbeat`,
    token,
    { method: "POST" },
  );
  assert.equal(beat.status, 409);
  assert.equal(beat.data.error.code, "budget_exceeded");

  // Failed, not requeued: rerunning the same runaway task would just burn
  // the budget again.
  assert.equal((await runtime.store.getWorkLease(leaseId))?.status, "failed");
  assert.equal(
    (await runtime.store.listSubmittedTasks())[0]?.status,
    "failed",
  );
  const audit = await runtime.store.listAudit();
  assert.ok(
    audit.some(
      (event) =>
        event.type === "task_failed" &&
        event.data["stage"] === "budget_enforcement",
    ),
  );
});

test("a worker cannot touch another user's lease", async (t) => {
  const { runtime, client, token } = await workerRuntime(t);
  const workerId = (
    await bearer(runtime.origin, "/api/v1/workers/register", token, {
      method: "POST",
      body: { organizationId: DEFAULT_ORGANIZATION_ID, name: "w", adapters: [], version: "1" },
    })
  ).data.id as string;

  await runtime.store.saveRepository({
    id: "repo_iso",
    path: "/canonical/iso.git",
    branch: "main",
  });
  await runtime.store.submitTask({
    repositoryId: "repo_iso",
    objective: "objective",
    agentId: "codex",
    validationCommands: [],
  });
  const leased = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });

  // A second tenant with a perfectly valid run_task token.
  const intruderUser = await runtime.store.createUser({
    email: "intruder@example.com",
    displayName: "Intruder",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: "org_local",
    userId: intruderUser.id,
    role: "developer",
  });
  const intruder = new TestClient(runtime.origin);
  await intruder.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "intruder@example.com", password: PASSWORD },
  });
  const intruderToken = (
    await intruder.request("/api/v1/auth/tokens", {
      method: "POST",
      body: { name: "theirs", scopes: ["view", "run_task"] },
    })
  ).data.token as string;

  for (const action of ["heartbeat", "release", "result"]) {
    const response = await bearer(
      runtime.origin,
      `/api/v1/workers/leases/${leased.data.lease.id}/${action}`,
      intruderToken,
      { method: "POST", body: { status: "failed" } },
    );
    assert.equal(response.status, 404, action);
  }
});

test("a member's agent colour is readable by the colleagues it identifies", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const setup = await bootstrap(owner);

  const chosen = await owner.request("/api/v1/auth/me/appearance", {
    method: "PATCH",
    body: { accent: "#4F8EF7", agentColor: "#E05F9E" },
  });
  assert.equal(chosen.status, 200);
  // Normalised on the way in, so two spellings of one colour compare equal.
  assert.equal(chosen.data.user.appearance.agentColor, "#e05f9e");
  assert.equal(chosen.data.user.appearance.accent, "#4f8ef7");

  const me = await owner.request("/api/v1/auth/me");
  assert.equal(me.data.user.appearance.agentColor, "#e05f9e");

  // The point of the colour is that other people can read it: a teammate
  // listing the organization's members has to see it, or "pink doodles are
  // Nathan's agents" is not a thing anyone can learn.
  const members = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/members`,
  );
  assert.equal(members.status, 200);
  const listed = members.data.members.find(
    (member: any) => member.userId === setup.user.id,
  );
  assert.equal(listed.user.appearance.agentColor, "#e05f9e");
});

test("changing one colour leaves the others alone", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  await client.request("/api/v1/auth/me/appearance", {
    method: "PATCH",
    body: { accent: "#2fae7f" },
  });
  await client.request("/api/v1/auth/me/appearance", {
    method: "PATCH",
    body: { accentSecondary: "#D7A13B" },
  });
  // A PATCH names only what it changes; the colours picked a moment ago must
  // survive a later choice of agent colour. Three of them now, and each is
  // written by its own wheel, so one wheel must not clear the other two.
  const third = await client.request("/api/v1/auth/me/appearance", {
    method: "PATCH",
    body: { agentColor: "#e05f9e" },
  });
  assert.equal(third.status, 200);
  assert.deepEqual(third.data.user.appearance, {
    accent: "#2fae7f",
    accentSecondary: "#d7a13b",
    agentColor: "#e05f9e",
  });
});

test("an agent colour must be a plain hex triple", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  // The value is written into a style attribute, so a CSS colour that happens
  // to carry a second declaration must not survive the edge. Every colour
  // field, not just the agent one: they all reach a style attribute, and a
  // field that skipped the check would be the one somebody found.
  for (const field of ["accent", "accentSecondary", "agentColor"]) {
    for (const value of [
      "red;background:url(https://x)",
      "rgb(1,2,3)",
      "#fff",
      "javascript:alert(1)",
    ]) {
      const rejected = await client.request("/api/v1/auth/me/appearance", {
        method: "PATCH",
        body: { [field]: value },
      });
      assert.equal(rejected.status, 400, `${field}: ${value} should be refused`);
    }
  }
});

test("an invitation brings in somebody who has no account yet", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner);

  const invited = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("newcomer@example.com", "developer", repo) },
  );
  assert.equal(invited.status, 201);
  const token = invited.data.token as string;
  assert.match(token, /^inv_[\w-]+\.[\w-]+$/u);
  // The secret is returned exactly once and is not stored recoverably.
  assert.equal(invited.data.invitation.status, "pending");
  assert.equal("secretHash" in invited.data.invitation, false);

  // The recipient can read the invitation before having any account at all.
  const anonymous = new TestClient(runtime.origin);
  const preview = await anonymous.request(`/api/v1/invitations/${token}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.invitation.email, "newcomer@example.com");
  assert.equal(preview.data.invitation.role, "developer");

  const accepted = await anonymous.request(`/api/v1/invitations/${token}/accept`, {
    method: "POST",
    body: { displayName: "Newcomer", password: PASSWORD },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.user.email, "newcomer@example.com");
  // No organization membership: an invitation grants its one repository and
  // nothing else, and any organization role would reach every repository.
  assert.deepEqual(accepted.data.memberships, []);
  // The grant they did get is the repository they were invited to.
  const reachable = await anonymous.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
  );
  assert.equal(reachable.status, 200);
  assert.deepEqual(
    reachable.data.repositories.map((entry: { id: string }) => entry.id),
    [repo],
  );

  // And they are signed in, so accepting lands them inside rather than at a
  // login screen with a fresh password they just chose.
  const me = await anonymous.request("/api/v1/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, "newcomer@example.com");
  // Nobody could have had an account for that address before this test made
  // one, which is what the preview said.
  assert.equal(preview.data.invitation.accountExists, false);
});

/**
 * Somebody already on Lattice, invited to a second repository.
 *
 * The account exists, so the invitation is not proof of who is holding the
 * link and a password in the body would only be a second way to be wrong
 * about that. Signing in is the proof, and the preview says which of the two
 * forms the recipient should be shown before they type anything into either.
 */
test("an invitation is claimed by an existing account by signing in", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner);

  const member = new TestClient(runtime.origin);
  const registered = await member.request("/api/v1/auth/register", {
    method: "POST",
    body: {
      email: "returning@example.com",
      displayName: "Returning",
      password: PASSWORD,
    },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.data));

  const invited = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("returning@example.com", "developer", repo) },
  );
  assert.equal(invited.status, 201, JSON.stringify(invited.data));
  const token = invited.data.token as string;

  // The preview tells the screen to offer sign-in rather than "choose a
  // password", which for a taken address can only ever fail.
  const anonymous = new TestClient(runtime.origin);
  const preview = await anonymous.request(`/api/v1/invitations/${token}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.invitation.accountExists, true);

  // Holding the link is still not enough on its own.
  const unauthenticated = await anonymous.request(
    `/api/v1/invitations/${token}/accept`,
    { method: "POST", body: { displayName: "Impostor", password: "NotTheirs123!" } },
  );
  assert.equal(unauthenticated.status, 409);
  assert.equal(unauthenticated.data.error.code, "account_exists");

  // Signing in as the invited address is, and the accept needs nothing in the
  // body: the session says who this is.
  const joiner = new TestClient(runtime.origin);
  const signedIn = await joiner.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "returning@example.com", password: PASSWORD },
  });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.data));
  const accepted = await joiner.request(`/api/v1/invitations/${token}/accept`, {
    method: "POST",
    body: {},
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.user.email, "returning@example.com");
  assert.equal(accepted.data.user.id, registered.data.user.id);

  // The repository they were invited to is now reachable, and no second
  // account was made for the address.
  const reachable = await joiner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
  );
  assert.equal(reachable.status, 200);
  assert.equal(
    reachable.data.repositories.some((entry: { id: string }) => entry.id === repo),
    true,
  );
  const me = await joiner.request("/api/v1/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.user.id, registered.data.user.id);
});

test("an invitation works once and stops working when revoked", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner);

  const first = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("once@example.com", "viewer", repo) },
  );
  const token = first.data.token as string;
  const joiner = new TestClient(runtime.origin);
  assert.equal(
    (
      await joiner.request(`/api/v1/invitations/${token}/accept`, {
        method: "POST",
        body: { displayName: "Once", password: PASSWORD },
      })
    ).status,
    200,
  );
  // A used link is spent, not a standing grant.
  const replay = new TestClient(runtime.origin);
  assert.equal(
    (
      await replay.request(`/api/v1/invitations/${token}/accept`, {
        method: "POST",
        body: { displayName: "Impostor", password: PASSWORD },
      })
    ).status,
    409,
  );

  const second = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("revoked@example.com", "viewer", repo) },
  );
  await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations/${second.data.invitation.id}`,
    { method: "DELETE" },
  );
  const late = new TestClient(runtime.origin);
  assert.equal(
    (
      await late.request(`/api/v1/invitations/${second.data.token}/accept`, {
        method: "POST",
        body: { displayName: "Late", password: PASSWORD },
      })
    ).status,
    409,
  );
});

test("a wrong or forged invitation link is indistinguishable from a missing one", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner);
  const made = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("probe@example.com", "viewer", repo) },
  );
  const id = made.data.invitation.id as string;
  const anonymous = new TestClient(runtime.origin);
  // A real id with the wrong secret must answer exactly as a made-up id does,
  // or the endpoint confirms which invitations exist.
  for (const token of [`${id}.wrong-secret`, "inv_nope.whatever", "garbage"]) {
    assert.equal(
      (await anonymous.request(`/api/v1/invitations/${token}`)).status,
      404,
      token,
    );
  }
});

test("an invitation cannot hand out a role its sender could not assign", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner);

  // Bring in a developer, who may not manage members at all.
  const invite = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("dev@example.com", "developer", repo) },
  );
  const developer = new TestClient(runtime.origin);
  await developer.request(`/api/v1/invitations/${invite.data.token}/accept`, {
    method: "POST",
    body: { displayName: "Dev", password: PASSWORD },
  });
  const refused = await developer.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("escalate@example.com", "owner", repo) },
  );
  assert.equal(refused.status, 403);
});

test("an existing member can still be invited to a repository", async (t) => {
  // The organization-wide invitation refused this with `already_a_member`,
  // and it was right to: a second one added nothing. A repository grant is a
  // different offer — being in the organization does not mean being able to
  // reach a particular repository — so it is worth making to someone who is
  // already here.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const setup = await bootstrap(owner);
  const repo = await invitableRepository(owner);
  const again = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody(setup.user.email, "developer", repo) },
  );
  assert.equal(again.status, 201, JSON.stringify(again.data));
});

test("an invitation must name a repository", async (t) => {
  // The whole point of the change: there is no way to ask for the whole
  // organization. Omitting the repository is a bad request, not a wider grant.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const refused = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: { email: "everywhere@example.com", role: "developer" } },
  );
  assert.equal(refused.status, 400, JSON.stringify(refused.data));
});

/** Invites somebody to one repository and returns a client signed in as them. */
async function joinRepository(
  runtime: TestRuntime,
  owner: TestClient,
  email: string,
  repositoryId: string,
  role = "developer",
): Promise<TestClient> {
  const invited = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    {
      method: "POST",
      body: { email, role, repositoryId, projectId: DEFAULT_PROJECT_ID },
    },
  );
  assert.equal(invited.status, 201, JSON.stringify(invited.data));
  const client = new TestClient(runtime.origin);
  const accepted = await client.request(
    `/api/v1/invitations/${invited.data.token}/accept`,
    { method: "POST", body: { displayName: "Guest", password: PASSWORD } },
  );
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  return client;
}

test("a repository invitation grants that repository and no other", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  for (const id of ["shared", "private"]) {
    assert.equal(
      (
        await owner.request(
          `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
          { method: "POST", body: { id, branch: "main" } },
        )
      ).status,
      201,
    );
  }

  const guest = await joinRepository(
    runtime,
    owner,
    "guest@example.com",
    "shared",
  );

  // The list is how the interface learns what exists, so it must not mention
  // the repository they were not given.
  const listed = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
  );
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.data.repositories.map((entry: { id: string }) => entry.id),
    ["shared"],
  );

  // And the routes enforce it independently of the list, answering exactly as
  // they would for a repository that does not exist.
  const refused = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/private/versions`,
  );
  assert.equal(refused.status, 404);
  const submitted = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks`,
    {
      method: "POST",
      body: { repositoryId: "private", objective: "Sneak a change in" },
    },
  );
  assert.equal(submitted.status, 404);

  // The one they were given genuinely works.
  const allowed = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks`,
    {
      method: "POST",
      body: { repositoryId: "shared", objective: "Do the work I was asked to" },
    },
  );
  assert.equal(allowed.status, 201, JSON.stringify(allowed.data));
});

test("a guest's task list shows only their own repository's work", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  for (const id of ["shared", "private"]) {
    await owner.request(`/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`, {
      method: "POST",
      body: { id, branch: "main" },
    });
    await owner.request(`/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks`, {
      method: "POST",
      body: { repositoryId: id, objective: `work on ${id}` },
    });
  }
  const guest = await joinRepository(
    runtime,
    owner,
    "reader@example.com",
    "shared",
  );
  const tasks = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks`,
  );
  assert.equal(tasks.status, 200);
  // Objectives are free text and often say more than a repository name does,
  // so a leak here would be a real disclosure rather than a cosmetic one.
  assert.deepEqual(
    tasks.data.tasks.map((task: { repositoryId: string }) => task.repositoryId),
    ["shared"],
  );

  const owned = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks`,
  );
  // The owner still sees everything: scoping an organization role down to
  // explicit grants would let owners lock themselves out of their own work.
  assert.equal(owned.data.tasks.length, 2);
});

test("an invitation reaches its own repository and no other", async (t) => {
  // This replaces a test asserting that an invitation reached *every*
  // repository the organization held. That was the upstream behaviour when an
  // invitation could omit its repository; it cannot any more, and the
  // guarantee is now the opposite one.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  for (const id of ["alpha", "beta"]) {
    await owner.request(`/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`, {
      method: "POST",
      body: { id, branch: "main" },
    });
  }
  const invited = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("staff@example.com", "developer", "alpha") },
  );
  assert.equal(invited.status, 201, JSON.stringify(invited.data));
  const member = new TestClient(runtime.origin);
  await member.request(`/api/v1/invitations/${invited.data.token}/accept`, {
    method: "POST",
    body: { displayName: "Staff", password: PASSWORD },
  });
  const listed = await member.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
  );
  assert.deepEqual(
    listed.data.repositories.map((entry: { id: string }) => entry.id).sort(),
    ["alpha"],
  );
});

test("a repository guest can find the project their repository is in", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  await owner.request(`/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`, {
    method: "POST",
    body: { id: "shared", branch: "main" },
  });
  const guest = await joinRepository(
    runtime,
    owner,
    "finder@example.com",
    "shared",
  );

  // A grant carries no organization membership, so listing organizations and
  // projects by membership alone would sign this person in successfully and
  // then show them nothing at all.
  const organizations = await guest.request("/api/v1/organizations");
  assert.equal(organizations.status, 200);
  assert.deepEqual(
    organizations.data.organizations.map((entry: { id: string }) => entry.id),
    [DEFAULT_ORGANIZATION_ID],
  );
  const projects = await guest.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/projects`,
  );
  assert.equal(projects.status, 200);
  assert.deepEqual(
    projects.data.projects.map((entry: { id: string }) => entry.id),
    [DEFAULT_PROJECT_ID],
  );
});

test("a stranger with no grant and no membership still sees nothing", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  // Reached through the admin path so this account has neither a membership
  // nor a grant — the case the projects fallback must not accidentally admit.
  await owner.request("/api/v1/admin/users", {
    method: "POST",
    body: {
      email: "stranger@example.com",
      displayName: "Stranger",
      password: PASSWORD,
    },
  });
  const stranger = new TestClient(runtime.origin);
  await stranger.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "stranger@example.com", password: PASSWORD },
  });
  assert.deepEqual(
    (await stranger.request("/api/v1/organizations")).data.organizations,
    [],
  );
  assert.equal(
    (
      await stranger.request(
        `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/projects`,
      )
    ).status,
    403,
  );
});

test("anybody can create an account, and it comes with somewhere to work", async (t) => {
  // Open registration: no invitation, no bootstrap token. What the new user
  // gets is their *own* organization and project, because an organization
  // role reaches every repository that organization holds — attaching them to
  // an existing one would hand a stranger everybody else's code.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  await invitableRepository(owner, "owners-repo");

  const newcomer = new TestClient(runtime.origin);
  const created = await newcomer.request("/api/v1/auth/register", {
    method: "POST",
    body: {
      email: "stranger@example.com",
      displayName: "Stranger",
      password: PASSWORD,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.user.email, "stranger@example.com");
  // Signed in already: registering lands them inside, not back at a form.
  const me = await newcomer.request("/api/v1/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, "stranger@example.com");

  // Their own organization, owned by them, and not the bootstrap one.
  assert.equal(created.data.memberships.length, 1);
  assert.equal(created.data.memberships[0].role, "owner");
  assert.notEqual(created.data.memberships[0].organizationId, DEFAULT_ORGANIZATION_ID);

  // A project to put repositories in, which is the first thing they came for.
  const organizationId = created.data.memberships[0].organizationId;
  const projects = await newcomer.request(
    `/api/v1/organizations/${organizationId}/projects`,
  );
  assert.equal(projects.status, 200);
  assert.equal(projects.data.projects.length, 1);

  // And none of the bootstrap owner's work is visible to them.
  const theirs = await newcomer.request(
    `/api/v1/projects/${projects.data.projects[0].id}/repositories`,
  );
  assert.equal(theirs.status, 200);
  assert.deepEqual(theirs.data.repositories, []);
  const notTheirs = await newcomer.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
  );
  assert.equal(notTheirs.status === 200, false, "another team's project must not be readable");
});

test("the repository channel round-trips messages, replies, reactions, reads, and agent overrides", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "channel-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const empty = await owner.request(`${base}/messages`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.messages, []);
  assert.deepEqual(empty.data.agentOverrides, {});
  assert.equal(empty.data.readAt, undefined);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "  Kicking off this channel.  " },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(posted.data.message.content, "Kicking off this channel.");
  assert.equal(posted.data.message.kind, "user");
  const messageId = posted.data.message.id;

  // An empty message is not a message at all.
  const blank = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "   " },
  });
  assert.equal(blank.status, 400);

  const reply = await owner.request(`${base}/messages/${messageId}/replies`, {
    method: "POST",
    body: { content: "First reply." },
  });
  assert.equal(reply.status, 201, JSON.stringify(reply.data));
  assert.equal(reply.data.reply.messageId, messageId);

  const reacted = await owner.request(
    `${base}/messages/${messageId}/reactions`,
    { method: "POST", body: { emoji: "🎉" } },
  );
  assert.equal(reacted.status, 200);
  assert.equal(reacted.data.message.reactions["🎉"].count, 1);
  assert.equal(reacted.data.message.reactions["🎉"].mine, true);

  // Toggling the same emoji again removes it.
  const unreacted = await owner.request(
    `${base}/messages/${messageId}/reactions`,
    { method: "POST", body: { emoji: "🎉" } },
  );
  assert.equal(unreacted.data.message.reactions["🎉"], undefined);

  const named = await owner.request(`${base}/agents/agent_1`, {
    method: "POST",
    body: { name: "Scout" },
  });
  assert.equal(named.status, 200);
  assert.equal(named.data.override.name, "Scout");

  const read = await owner.request(`${base}/read`, { method: "POST" });
  assert.equal(read.status, 200);
  assert.equal(typeof read.data.readAt, "string");

  const after = await owner.request(`${base}/messages`);
  assert.equal(after.data.messages.length, 1);
  assert.equal(after.data.messages[0].replies.length, 1);
  // Stored against the agent, not the vendor. A bare id reaching the write
  // can only be the caller's own agent, so it is resolved against them —
  // otherwise the row names every agent on that provider and one person's
  // rename lands on their colleague's agent too.
  assert.equal(
    after.data.agentOverrides[`${bootstrapped.user.id}:agent_1`].name,
    "Scout",
    JSON.stringify(after.data.agentOverrides),
  );
  assert.equal(after.data.agentOverrides["agent_1"], undefined);
  assert.equal(after.data.readAt, read.data.readAt);

  // Replying to, or reacting on, a message that does not exist is a 404, not
  // a crash.
  const missing = await owner.request(
    `${base}/messages/does-not-exist/replies`,
    { method: "POST", body: { content: "orphan" } },
  );
  assert.equal(missing.status, 404);
});

test("channel messages pin, surface in the payload, and unpin", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "pin-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "Deploy checklist lives here." },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const messageId = posted.data.message.id;

  const pinned = await owner.request(`${base}/messages/${messageId}/pin`, {
    method: "POST",
    body: {},
  });
  assert.equal(pinned.status, 200, JSON.stringify(pinned.data));
  assert.equal(typeof pinned.data.message.pinnedAt, "string");
  assert.equal(pinned.data.message.pinnedBy, bootstrapped.user.id);

  // The channel payload carries the pinned list alongside the transcript, so
  // the banner never depends on the pinned row being inside the page window.
  const listed = await owner.request(`${base}/messages`);
  assert.equal(listed.status, 200);
  assert.equal(listed.data.pinned.length, 1);
  assert.equal(listed.data.pinned[0].id, messageId);
  assert.equal(listed.data.pinned[0].pinnedBy, bootstrapped.user.id);

  const audit = await runtime.store.listAudit();
  assert.ok(
    audit.some(
      (event) =>
        event.type === "channel_message_pinned" &&
        event.data["messageId"] === messageId &&
        event.data["pinned"] === true &&
        event.data["repositoryId"] === repositoryId,
    ),
  );

  // The same route toggles: pinning again unpins, and the audit says so.
  const unpinned = await owner.request(`${base}/messages/${messageId}/pin`, {
    method: "POST",
    body: {},
  });
  assert.equal(unpinned.status, 200);
  assert.equal(unpinned.data.message.pinnedAt, undefined);
  assert.equal(unpinned.data.message.pinnedBy, undefined);

  const cleared = await owner.request(`${base}/messages`);
  assert.deepEqual(cleared.data.pinned, []);
  const auditAfter = await runtime.store.listAudit();
  assert.ok(
    auditAfter.some(
      (event) =>
        event.type === "channel_message_pinned" &&
        event.data["messageId"] === messageId &&
        event.data["pinned"] === false,
    ),
  );

  // Pinning a message that does not exist is a 404, not a crash.
  const missing = await owner.request(`${base}/messages/does-not-exist/pin`, {
    method: "POST",
    body: {},
  });
  assert.equal(missing.status, 404);
});

test("the repository channel is scoped by repository access, like everything else", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "private-repo");

  // Registration gives this account its own organization and project — it
  // has no membership, and no grant, on the owner's repository.
  const newcomer = new TestClient(runtime.origin);
  await newcomer.request("/api/v1/auth/register", {
    method: "POST",
    body: {
      email: "outsider@example.com",
      displayName: "Outsider",
      password: PASSWORD,
    },
  });

  // This newcomer has no membership and no grant in the owner's organization
  // at all, so `authorizeRepository` refuses at the project level — the same
  // 403 a totally unrelated stranger gets from every other project-scoped
  // route (see "a stranger with no grant and no membership still sees
  // nothing" above). The disguised-as-404 behavior is reserved for someone
  // who *can* reach the project but not this particular repository.
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const blockedList = await newcomer.request(`${base}/messages`);
  assert.equal(blockedList.status, 403);
  const blockedPost = await newcomer.request(`${base}/messages`, {
    method: "POST",
    body: { content: "sneaking in" },
  });
  assert.equal(blockedPost.status, 403);

  // The owner's own view is unaffected.
  const ownersView = await owner.request(`${base}/messages`);
  assert.equal(ownersView.status, 200);
});

test("the channel roster is the real connected agents of everyone with access to the repository", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "roster-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  // Reached through an organization role — the same source `authorizeProject`
  // reads when nobody named a narrower grant.
  const colleague = await runtime.store.createUser({
    email: "colleague@example.com",
    displayName: "Colleague Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: colleague.id,
    role: "developer",
  });

  // Reached through a per-repository grant and *no* organization role at
  // all — the other source `authorizeRepository` accepts, and the whole
  // reason grants exist: sharing one repository without joining the team.
  const guest = await runtime.store.createUser({
    email: "guest@example.com",
    displayName: "Guest Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveRepositoryGrant({
    repositoryId,
    userId: guest.id,
    role: "developer",
    grantedBy: bootstrapped.user.id,
    createdAt: new Date().toISOString(),
  });

  // Has agents connected, but no membership and no grant on this repository
  // at all. Their connections exist in the same fixture map everyone else's
  // do, so this only proves something if the route actually checks access
  // rather than just echoing whatever `connectionsFor` was asked about.
  const stranger = await runtime.store.createUser({
    email: "stranger-roster@example.com",
    displayName: "Stranger",
    passwordDigest: await hashPassword(PASSWORD),
  });

  runtime.chatConnections.set(bootstrapped.user.id, [{ provider: "anthropic" }]);
  runtime.chatConnections.set(colleague.id, [
    { provider: "openai" },
    { provider: "google" },
  ]);
  runtime.chatConnections.set(guest.id, [{ provider: "anthropic" }]);
  runtime.chatConnections.set(stranger.id, [{ provider: "anthropic" }]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const roster = await owner.request(`${base}/agents`);
  assert.equal(roster.status, 200);

  const byUser = new Map<string, string[]>();
  for (const entry of roster.data.agents as any[]) {
    assert.equal(entry.connected, true);
    // The safe-to-browser shape only: no secret, no hint, no credential kind,
    // no free-text label the credential's own owner chose for themselves.
    for (const forbidden of ["secret", "hint", "kind", "label"]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(entry, forbidden),
        false,
        `roster entry must not carry "${forbidden}"`,
      );
    }
    const list = byUser.get(entry.userId) ?? [];
    list.push(entry.provider);
    byUser.set(entry.userId, list);
  }

  assert.deepEqual(byUser.get(bootstrapped.user.id)?.sort(), ["anthropic"]);
  assert.deepEqual(byUser.get(colleague.id)?.sort(), ["google", "openai"]);
  assert.deepEqual(byUser.get(guest.id)?.sort(), ["anthropic"]);
  // The whole point: a stranger's connected agents never surface on a
  // repository they cannot reach, no matter what the credential store knows.
  assert.equal(byUser.has(stranger.id), false);

  const guestEntry = (roster.data.agents as any[]).find(
    (entry) => entry.userId === guest.id,
  );
  assert.equal(guestEntry.userName, "Guest Dev");

  // Every collaborator sees the same roster — a colleague's own agent is not
  // theirs, but a shared channel roster is meaningless if they cannot see it.
  const colleagueClient = new TestClient(runtime.origin);
  await colleagueClient.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: colleague.email, password: PASSWORD },
  });
  const colleagueView = await colleagueClient.request(`${base}/agents`);
  assert.equal(colleagueView.status, 200);
  assert.deepEqual(
    (colleagueView.data.agents as any[]).map((entry) => entry.userId).sort(),
    (roster.data.agents as any[]).map((entry) => entry.userId).sort(),
  );

  // The stranger cannot even ask: no membership and no grant on this
  // repository, the same 403 every other project-scoped route gives someone
  // who cannot reach the project at all.
  const strangerClient = new TestClient(runtime.origin);
  await strangerClient.request("/api/v1/auth/register", {
    method: "POST",
    body: {
      email: "outsider-roster@example.com",
      displayName: "Outsider",
      password: PASSWORD,
    },
  });
  const blocked = await strangerClient.request(`${base}/agents`);
  assert.equal(blocked.status, 403);
});

test("posting to the repository channel broadcasts over the existing event socket", async (t) => {
  const runtime = await startRuntime(t, { webSocketPollIntervalMs: 10 });
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "live-repo");

  // Simulates the case the frontend cares about: a second browser tab already
  // has the channel's event socket open when a message is posted, and must
  // see it appear without polling or a refresh.
  const payloads = await new Promise<any[]>((resolve, reject) => {
    const socket = net.createConnection(runtime.port, "127.0.0.1");
    let response = Buffer.alloc(0);
    let headersRead = false;
    let frameBytes = Buffer.alloc(0);
    let posted = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for the channel message to broadcast"));
    }, 4_000);
    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write(
        `GET /api/v1/events?projectId=${DEFAULT_PROJECT_ID}&after=0 HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${runtime.port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n" +
          `Origin: ${runtime.origin}\r\n` +
          `Cookie: ${owner.cookieHeader}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        if (!headersRead) {
          response = Buffer.concat([response, chunk]);
          const boundary = response.indexOf("\r\n\r\n");
          if (boundary < 0) {
            return;
          }
          assert.match(
            response.subarray(0, boundary).toString("ascii"),
            /^HTTP\/1\.1 101 /u,
          );
          frameBytes = response.subarray(boundary + 4);
          headersRead = true;
        } else {
          frameBytes = Buffer.concat([frameBytes, chunk]);
        }
        const messages = decodeTextFrames(frameBytes).map((entry) =>
          JSON.parse(entry),
        );
        if (messages.some((entry) => entry.type === "connected") && !posted) {
          posted = true;
          void owner
            .request(
              `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages`,
              { method: "POST", body: { content: "Hello, second tab." } },
            )
            .catch(reject);
        }
        if (
          messages.some(
            (entry) =>
              entry.type === "audit" &&
              entry.event?.type === "channel_message_posted" &&
              entry.event?.data?.repositoryId === repositoryId,
          )
        ) {
          clearTimeout(timer);
          socket.destroy();
          resolve(messages);
        }
      } catch (error) {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  assert.equal(
    payloads.some(
      (entry) => entry.type === "audit" && entry.event?.type === "channel_message_posted",
    ),
    true,
  );
});

/**
 * Adds a colleague with organization-role access to the owner's repository —
 * the same shape the roster tests above use — and returns a logged-in client
 * for them, for the @mention dispatch tests below.
 */
async function addColleague(
  runtime: TestRuntime,
  email: string,
): Promise<{ id: string; email: string; client: TestClient }> {
  const colleague = await runtime.store.createUser({
    email,
    displayName: "Colleague",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: colleague.id,
    role: "developer",
  });
  const client = new TestClient(runtime.origin);
  const login = await client.request("/api/v1/auth/login", {
    method: "POST",
    body: { email, password: PASSWORD },
  });
  assert.equal(login.status, 200);
  return { id: colleague.id, email: colleague.email, client };
}

test("a personal agent refuses a stranger's @mention and dispatches nothing", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "mention-personal-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  // "Owner"'s connected Claude is personal — the default, and what every
  // connection had before visibility existed.
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const colleague = await addColleague(runtime, "colleague-personal@example.com");

  // The exact text the frontend's mention-autocomplete would have inserted:
  // "@" + `${AGENT_LABEL[provider]} (${firstWord(displayName)})`.
  const posted = await colleague.client.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) please fix the login bug" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  // The whole point: nothing was submitted under anyone's account.
  assert.equal(runtime.submittedTasks.length, 0);

  const after = await owner.request(`${base}/messages`);
  const systemMessages = (after.data.messages as any[]).filter(
    (message) => message.kind === "system",
  );
  assert.equal(systemMessages.length, 1);
  assert.match(systemMessages[0].content, /personal to Owner/u);
  assert.match(systemMessages[0].content, /@Claude \(Owner\)/u);
  // The stranger's own message still posted — a refused mention must not
  // also swallow what they typed.
  assert.equal(
    (after.data.messages as any[]).some(
      (message) => message.content === "@Claude (Owner) please fix the login bug",
    ),
    true,
  );
});

test("an org-wide agent accepts a stranger's @mention and dispatches under the owner's credential", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "mention-org-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const colleague = await addColleague(runtime, "colleague-org@example.com");

  const posted = await colleague.client.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) please fix the login bug" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(runtime.submittedTasks.length, 1);
  const [task] = runtime.submittedTasks;
  assert.ok(task !== undefined);
  // Dispatched under the *mentioned agent's owner*, never the mentioner —
  // the whole reason `actorId` here is not simply `principal.user.id`.
  assert.equal(task.actorId, bootstrapped.user.id);
  assert.notEqual(task.actorId, colleague.id);
  assert.equal(task.vendor, "claude");
  assert.match(task.objective, /please fix the login bug/u);

  const after = await owner.request(`${base}/messages`);
  const systemMessages = (after.data.messages as any[]).filter(
    (message) => message.kind === "agent",
  );
  assert.equal(systemMessages.length, 1);
  assert.match(systemMessages[0].content, /On it/u);
});

test("the acknowledgement is the agent's own sentence, not the same line every time", async (t) => {
  // The line is asked of the model precisely so it is about the thing being
  // requested. It was read out of `content` — the shape of the *request*,
  // which the provider never fills — so every dispatch bought a sentence and
  // then posted the fixed fallback anyway, and every agent in the channel
  // said exactly the same thing under every request. `askAgent` had already
  // hit this and left a comment about it.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "ack-own-voice");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  runtime.chatAnswer.text = "Sure — starting with the token refresh in src/auth.ts.";
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) please fix the token refresh" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  const after = await owner.request(`${base}/messages`);
  const agentMessages = (after.data.messages as any[]).filter(
    (message) => message.kind === "agent",
  );
  assert.equal(agentMessages.length, 1, JSON.stringify(after.data.messages));
  assert.equal(
    agentMessages[0].content,
    "Sure — starting with the token refresh in src/auth.ts.",
  );
});

test("an agent that answers nothing still acknowledges", async (t) => {
  // The other half: the fallback exists because this line has to land inside
  // a couple of seconds whatever the model does, and a request met with
  // silence reads as a request that was not heard.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "ack-fallback");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // `chatAnswer.text` left unset: the fake `complete` answers with an empty
  // reply, as a model that returns nothing does.
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) please fix the token refresh" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  const after = await owner.request(`${base}/messages`);
  const agentMessages = (after.data.messages as any[]).filter(
    (message) => message.kind === "agent",
  );
  assert.equal(agentMessages.length, 1, JSON.stringify(after.data.messages));
  assert.equal(agentMessages[0].content, "On it.");
});

test("an agent's own owner can always @mention it, personal or org-wide", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "mention-self-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) kick off the release checklist" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(runtime.submittedTasks.length, 1);
  const [selfTask] = runtime.submittedTasks;
  assert.ok(selfTask !== undefined);
  assert.equal(selfTask.actorId, bootstrapped.user.id);
  assert.equal(selfTask.vendor, "claude");

  const after = await owner.request(`${base}/messages`);
  const systemMessages = (after.data.messages as any[]).filter(
    (message) => message.kind === "agent",
  );
  assert.equal(systemMessages.length, 1);
  assert.match(systemMessages[0].content, /On it/u);
});

test("a human channel participant can be @mentioned without an agent refusal", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "mention-human-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  await addColleague(runtime, "human-mention@example.com");

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Colleague could you take a look at this?" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 0);
  const colleague = (await runtime.store.listUsers()).find(
    (user) => user.email === "human-mention@example.com",
  );
  assert.ok(colleague !== undefined);
  assert.deepEqual(posted.data.message.mentions, [
    { kind: "user", id: colleague.id, name: "Colleague" },
  ]);

  const after = await owner.request(`${base}/messages`);
  assert.deepEqual(
    (after.data.messages as any[]).map((message) => message.content),
    ["@Colleague could you take a look at this?"],
  );
  assert.deepEqual((after.data.messages as any[])[0]?.mentions, [
    { kind: "user", id: colleague.id, name: "Colleague" },
  ]);
});


/**
 * What the agents actually said, minus the "want me to take this?" offer.
 *
 * An unnamed request draws an offer in the agent's own voice before anything
 * runs, so it is an agent message like any other. These assertions are about
 * what an agent says once it has the work.
 */
function agentSpeech(messages: unknown[]): any[] {
  return (messages as any[]).filter(
    (message) =>
      message.kind === "agent" &&
      !/^Want me to take this/u.test(String(message.content ?? "")),
  );
}

/**
 * Posts an unaddressed request and says yes to the offer it draws.
 *
 * An unnamed request is offered rather than started — picking the agent is a
 * guess, and a wrong guess spends somebody's account — so the two-step is the
 * behaviour, not scaffolding. These tests are about *which* agent a request
 * reaches, which is the same question either way.
 */
async function autoClaim(
  client: TestClient,
  base: string,
  content: string,
): Promise<void> {
  const posted = await client.request(`${base}/messages`, {
    method: "POST",
    body: { content },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const agreed = await client.request(`${base}/messages`, {
    method: "POST",
    body: { content: "yes" },
  });
  assert.equal(agreed.status, 201, JSON.stringify(agreed.data));
}

test("a human mention suppresses auto-claim but not an explicit agent mention", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "mention-human-agent-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  await addColleague(runtime, "mixed-mention@example.com");
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "@Colleague please update the release checklist" },
    })).status,
    201,
  );
  assert.equal(runtime.submittedTasks.length, 0);

  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: {
        content: "@Colleague please review while @Claude (Owner) updates the release checklist",
      },
    })).status,
    201,
  );
  assert.equal(runtime.submittedTasks.length, 1);
  assert.equal(runtime.submittedTasks[0]?.vendor, "claude");
  const after = await owner.request(`${base}/messages`);
  const mixed = (after.data.messages as any[]).find((message) =>
    message.content.includes("please review while"),
  );
  assert.deepEqual(
    mixed.mentions.map((mention: any) => mention.kind).sort(),
    ["agent", "user"],
  );
});

test("a user outside the repository cannot be resolved as a channel ping", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "mention-outsider-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  await runtime.store.createUser({
    email: "outsider-mention@example.com",
    displayName: "Outsider",
    passwordDigest: await hashPassword(PASSWORD),
  });

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Outsider please review this" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 0);
  assert.deepEqual(posted.data.message.mentions, []);

  const after = await owner.request(`${base}/messages`);
  const coordinator = (after.data.messages as any[]).filter(
    (message) => message.kind === "agent" || message.kind === "system",
  );
  assert.equal(coordinator.length, 1, JSON.stringify(after.data.messages));
  assert.match(coordinator[0].content, /Nobody here answers/u);
});

/**
 * Auto-claim (the no-@mention path in `dispatchChannelMentions` /
 * `maybeAutoClaimTask`): when a channel message reads as a task and exactly
 * one connected agent is a clear fit by role/name text, it is dispatched
 * automatically through the same `dispatchOneMention` an explicit @mention
 * uses. These tests cover the five scenarios called out in the brief: an
 * obvious single match, an ambiguous tie, plain chatter, a personal agent
 * that belongs to someone else, and an explicit @mention suppressing the
 * whole path even when an unmentioned agent would otherwise have matched.
 */
test("a clearly-scoped task message auto-claims to the one obviously-best agent", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "auto-claim-obvious");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  const backend = await addColleague(runtime, "backend-obvious@example.com");
  const database = await addColleague(runtime, "database-obvious@example.com");
  runtime.chatConnections.set(backend.id, [{ provider: "openai", visibility: "org" }]);
  runtime.chatConnections.set(database.id, [{ provider: "google", visibility: "org" }]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Rename each connected agent to reflect its lane, the same customization
  // `setChannelAgentOverride` already offers — see `scoreCandidate`'s doc
  // comment for why the auto-claim scorer matches against name text as well
  // as whatever role (if any) the channel has declared.
  const named = await owner.request(`${base}/agents/anthropic`, {
    method: "POST",
    body: { name: "Settings Page Layout Bot" },
  });
  assert.equal(named.status, 200, JSON.stringify(named.data));
  assert.equal(
    (await owner.request(`${base}/agents/${backend.id}:openai`, {
      method: "POST",
      body: { name: "Auth Billing Backend Bot" },
    })).status,
    200,
  );
  assert.equal(
    (await owner.request(`${base}/agents/${database.id}:google`, {
      method: "POST",
      body: { name: "Database Schema Migrations Bot" },
    })).status,
    200,
  );

  await autoClaim(owner, base, "please update the settings page layout");

  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  const [task] = runtime.submittedTasks;
  assert.ok(task !== undefined);
  assert.equal(task.actorId, bootstrapped.user.id);
  assert.equal(task.vendor, "claude");

  const after = await owner.request(`${base}/messages`);
  const systemMessages = agentSpeech(after.data.messages);
  assert.equal(systemMessages.length, 1, JSON.stringify(systemMessages));
  // The claim no longer names the agent in prose, because the message is
  // now written *by* it: the channel shows the author, so repeating the name
  // in the text would say the same thing twice. Asserting the author is the
  // stronger check anyway — it is what the screen actually renders from.
  assert.equal(
    systemMessages[0].authorId,
    `${bootstrapped.user.id}:anthropic`,
    JSON.stringify(systemMessages[0]),
  );
  assert.match(systemMessages[0].content, /On it/u);
  // No parenthetical about the auto-claim: the acknowledgement names the
  // agent that took it, and a sentence of process justification on every
  // unpinged request read as the system apologising for working.
  assert.doesNotMatch(systemMessages[0].content, /Nobody was @mentioned/u);
});

test("an ambiguous task message is dispatched anyway, deterministically", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "auto-claim-ambiguous");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const first = await addColleague(runtime, "first-ambiguous@example.com");
  const second = await addColleague(runtime, "second-ambiguous@example.com");
  runtime.chatConnections.set(first.id, [{ provider: "openai", visibility: "org" }]);
  runtime.chatConnections.set(second.id, [{ provider: "google", visibility: "org" }]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Same three content words in both names, in different order — a real
  // near-tie between two equally-plausible agents, not a contrived one.
  assert.equal(
    (await owner.request(`${base}/agents/${first.id}:openai`, {
      method: "POST",
      body: { name: "Error Handling API Bot" },
    })).status,
    200,
  );
  assert.equal(
    (await owner.request(`${base}/agents/${second.id}:google`, {
      method: "POST",
      body: { name: "Api Error Handling Service" },
    })).status,
    200,
  );

  await autoClaim(owner, base, "can we clean up the error handling for the api");

  // A near-tie used to mean silence, on the reasoning that a coin flip
  // spends somebody's account. With two agents connected — the ordinary
  // case — near-ties are the norm, and the channel answered nothing that
  // was not @mentioned. Never answering is the worse failure, so the tie is
  // broken rather than refused.
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  // Stable, not arbitrary: the same message must not land on a different
  // agent each time it is sent.
  await autoClaim(owner, base, "can we clean up the error handling for the api");
  assert.equal(runtime.submittedTasks.length, 2);
  assert.equal(
    runtime.submittedTasks[0]?.actorId,
    runtime.submittedTasks[1]?.actorId,
    "the same request must reach the same agent twice",
  );

  // The agent answers in its own voice, and that answer is the thread the
  // work hangs off — not a system aside.
  const after = await owner.request(`${base}/messages`);
  const agentMessages = agentSpeech(after.data.messages);
  assert.ok(agentMessages.length >= 1, JSON.stringify(after.data.messages));
  assert.match(agentMessages[0].content, /On it/u);
  // No thread yet, deliberately. The title and opening reasoning are held
  // until the run says something specific to this task, so a change small
  // enough to finish without explaining itself stays two lines in the
  // channel instead of a thread nobody needs to open. Nothing has been
  // narrated here, so nothing has been written.
  assert.deepEqual(agentMessages[0].replies ?? [], []);
});

test("a plain non-task message auto-claims nothing", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "auto-claim-chatter");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "thanks!" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const after = await owner.request(`${base}/messages`);
  const systemMessages = (after.data.messages as any[]).filter(
    (message) => message.kind === "system",
  );
  assert.equal(systemMessages.length, 0, JSON.stringify(systemMessages));
});

test("a best-fit agent personal to someone else is never auto-claimed for a stranger's message", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "auto-claim-personal");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  // "Owner"'s connected Claude is personal, and its name would otherwise be
  // an obvious, unambiguous match for the message below.
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  assert.equal(
    (await owner.request(`${base}/agents/anthropic`, {
      method: "POST",
      body: { name: "Settings Page Layout Bot" },
    })).status,
    200,
  );

  const stranger = await addColleague(runtime, "stranger-personal@example.com");
  const posted = await stranger.client.request(`${base}/messages`, {
    method: "POST",
    body: { content: "please update the settings page layout" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  // Nothing was submitted under anyone's account, and — a deliberate design
  // choice, see `maybeAutoClaimTask`'s doc comment — no system message
  // reveals that a personal agent would otherwise have been the pick. The
  // stranger sees only their own message; asking for this agent by name is
  // still available to them, and gets the usual "personal to Owner" refusal.
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const after = await owner.request(`${base}/messages`);
  assert.equal((after.data.messages as any[]).length, 1);
  const systemMessages = (after.data.messages as any[]).filter(
    (message) => message.kind === "system",
  );
  assert.equal(systemMessages.length, 0, JSON.stringify(systemMessages));
});

test("an explicit @mention suppresses auto-claim even when an unmentioned agent would otherwise match", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "auto-claim-vs-mention");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  const backend = await addColleague(runtime, "backend-vs-mention@example.com");
  runtime.chatConnections.set(backend.id, [{ provider: "openai", visibility: "org" }]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Owner's own agent's name is the strongest textual match for the message
  // below, but it is not the one @mentioned.
  assert.equal(
    (await owner.request(`${base}/agents/anthropic`, {
      method: "POST",
      body: { name: "Settings Page Layout Bot" },
    })).status,
    200,
  );
  assert.equal(
    (await owner.request(`${base}/agents/${backend.id}:openai`, {
      method: "POST",
      body: { name: "Backend Bot (Bella)" },
    })).status,
    200,
  );

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: "@Backend Bot (Bella) please update the settings page layout",
    },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  // Only the explicitly mentioned agent was dispatched — the whole point.
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  const [task] = runtime.submittedTasks;
  assert.ok(task !== undefined);
  assert.equal(task.actorId, backend.id);
  assert.equal(task.vendor, "codex");
  assert.equal(
    task.context,
    undefined,
    "explicit mentions must not inherit ambient channel context",
  );

  const after = await owner.request(`${base}/messages`);
  const systemMessages = (after.data.messages as any[]).filter(
    (message) => message.kind === "agent",
  );
  assert.equal(systemMessages.length, 1, JSON.stringify(systemMessages));
  assert.match(systemMessages[0].content, /On it/u);
  // The auto-claim explanation text never appears — confirms the mention
  // path, not auto-claim, is what fired.
  assert.doesNotMatch(systemMessages[0].content, /is taking this/u);
});

test("registration can be closed off", async (t) => {
  // Some deployments want invitations to be the only way in; this is the
  // switch, and it works without a redeploy.
  const previous = process.env["COORD_DISABLE_REGISTRATION"];
  process.env["COORD_DISABLE_REGISTRATION"] = "1";
  try {
    const runtime = await startRuntime(t);
    const client = new TestClient(runtime.origin);
    const refused = await client.request("/api/v1/auth/register", {
      method: "POST",
      body: {
        email: "nope@example.com",
        displayName: "Nope",
        password: PASSWORD,
      },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.data.error.code, "registration_closed");
  } finally {
    if (previous === undefined) {
      delete process.env["COORD_DISABLE_REGISTRATION"];
    } else {
      process.env["COORD_DISABLE_REGISTRATION"] = previous;
    }
  }
});

/**
 * A question is not a task.
 *
 * "@Claude what are you working on" was being filed as a submitted task
 * named after the question, with a thread and a progress indicator attached
 * to work that would never exist — so the agent appeared to type forever.
 * Naming an agent is evidence the sender wants *something*; the question
 * mark is what says it is an answer rather than work.
 */
test("a question to an agent is answered in the channel, not turned into a task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "question-not-task");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) what are you working on" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  // No task, and therefore no thread and nothing to keep an indicator alive.
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const after = await owner.request(`${base}/messages`);
  const agentMessages = (after.data.messages as any[]).filter(
    (message) => message.kind === "agent",
  );
  assert.equal(agentMessages.length, 1, JSON.stringify(after.data.messages));
  assert.deepEqual(agentMessages[0].replies ?? [], []);
});

test("a request that names no verb this list knows is still work when an agent is named", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "mention-is-intent");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // "kick off" is in no verb list here. Naming the agent is the intent, and
  // answering this with chat instead of doing it would be the worse failure.
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) kick off the release checklist" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));

  const after = await owner.request(`${base}/messages`);
  const agentMessages = (after.data.messages as any[]).filter(
    (message) => message.kind === "agent",
  );
  assert.equal(agentMessages.length, 1);
  // The work was taken — but no thread is opened for it yet. The title and
  // reasoning wait until the run narrates something specific to this task,
  // so a one-line change never grows a thread to hold a title nobody reads.
  const replies = agentMessages[0].replies ?? [];
  assert.deepEqual(replies, []);
  // Whenever it is written, it is named after the work rather than an id.
  assert.ok(
    !replies.some((reply: any) => /task_[0-9a-f-]{8}/u.test(String(reply.content))),
    "a task id is not a name anybody can read",
  );
});

/**
 * The opening line is a summary, not an echo.
 *
 * Reading somebody's own sentence back to them says nothing about whether it
 * was understood, and a request usually arrives with context in front of it —
 * "this is a greenfield project… can you get started" is a request to get
 * started, and the first clause is background.
 */
test("an opening line summarises the request rather than repeating it", () => {
  assert.equal(
    summariseObjective("please create the initial skeleton for a browser chess game"),
    "create the initial skeleton for a browser chess game",
  );
  assert.equal(
    summariseObjective("can we make a simple chess game with a browser UI"),
    "make a simple chess game with a browser UI",
  );
  // Background first, ask second: the ask is what gets summarised.
  assert.equal(
    summariseObjective(
      "this is a greenfield project, the end goal is a chess engine browser based. can you get started on the skeleton",
    ),
    "get started on the skeleton",
  );
  // Nothing to strip is left alone rather than mangled.
  assert.equal(
    summariseObjective("kick off the release checklist"),
    "kick off the release checklist",
  );
  // Long requests are cut on a word boundary, never mid-word.
  const long = summariseObjective(
    "rewrite the entire authentication subsystem including session handling, token rotation, and the password reset flow end to end",
  );
  assert.ok(long.length <= 91, long);
  assert.ok(long.endsWith("…"), long);
  assert.ok(!/\w…$/u.test(long.replace(/\s\S*…$/u, "")), long);
});

/**
 * A request to the room, sharing no vocabulary with any agent's role.
 *
 * "can someone start building general infrastructure for a chess engine" is
 * unmistakably a task and was met with silence, because scoring required a
 * candidate to share a word with the message before anybody could take it.
 * Relevance decides who; it must not decide whether.
 */
test("an unaddressed task is taken even when it matches no agent's role", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "unmatched-but-taken");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  await autoClaim(
    owner,
    base,
    "can someone start building general infrastructure for a chess engine",
  );
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  assert.equal(runtime.submittedTasks[0]?.actorId, bootstrapped.user.id);

  const after = await owner.request(`${base}/messages`);
  const agentMessages = agentSpeech(after.data.messages);
  assert.equal(agentMessages.length, 1, JSON.stringify(after.data.messages));
  // Nobody was named, and the pickup still reads as an ordinary
  // acknowledgement — the explanation was removed as noise.
  assert.doesNotMatch(agentMessages[0].content, /Nobody was @mentioned/u);
});

test("recent activity is one agent's, not its owner's whole roster", async (t) => {
  // Every task a channel dispatches is submitted under the *agent's owner*,
  // deliberately, so work somebody else's agent takes never spends the
  // sender's account. Grouping the activity signal on that alone merged every
  // agent one person owns into a single history — connect an org-wide Claude
  // and an org-wide Codex and both score identically, with the signal unable
  // to say which of them did what. With org agents that is the ordinary case.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "per-agent-activity");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  // Two agents, one owner — the case the grouping key could not tell apart.
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Both names share the one word the message will match, so neither leads on
  // role and the activity signal is what decides. The idle one is named
  // longer on purpose: candidates sort by name length, so it is first in line
  // and would take the work on the tie that owner-grouping produces.
  assert.equal(
    (await owner.request(`${base}/agents/anthropic`, {
      method: "POST",
      body: { name: "Deploy Alpha" },
    })).status,
    200,
  );
  assert.equal(
    (await owner.request(`${base}/agents/${ownerId}:openai`, {
      method: "POST",
      body: { name: "Deploy Beta Nightly Runner" },
    })).status,
    200,
  );

  // History under the Claude agent alone. `test-agent-claude` is what the
  // fixture's `submitTask` resolves the claude vendor to, and what
  // `listAgents` reports for that adapter — the join the grouping makes.
  for (const objective of [
    "migrate the postgres schema for sessions",
    "fix the postgres migration ordering",
  ]) {
    await runtime.store.submitTask({
      repositoryId,
      objective,
      agentId: "test-agent-claude",
      validationCommands: [],
      submittedBy: ownerId,
    });
  }

  await autoClaim(owner, base, "please deploy the postgres migration");

  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
  // The agent that has actually been doing postgres migrations here, not the
  // one that happens to share its owner.
  assert.equal(runtime.submittedTasks[0]?.vendor, "claude");
});

test("with no configured agents to join on, activity falls back to its owner", async (t) => {
  // `listAgents` is optional on `ApiOperations`. Where it is absent there is
  // nothing to key a per-agent history on, and the scorer must still work —
  // grouping by owner, which is wrong only in the way the test above
  // describes and no worse than before.
  const runtime = await startRuntime(t, { withoutListAgents: true });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "owner-fallback");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  assert.equal(
    (await owner.request(`${base}/agents/anthropic`, {
      method: "POST",
      body: { name: "Deploy Alpha" },
    })).status,
    200,
  );
  await runtime.store.submitTask({
    repositoryId,
    objective: "migrate the postgres schema for sessions",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: ownerId,
  });

  await autoClaim(owner, base, "please deploy the postgres migration");
  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
  assert.equal(runtime.submittedTasks[0]?.vendor, "claude");
});

/**
 * A task that ends at integration records `explanation` and a `status`, not
 * `error` — so reading only `error` turned the most common ending into a bare
 * "I could not finish this." with nothing a reader could act on. Observed in a
 * real thread: a failed task, no reason given, and the question that followed
 * it went unanswered.
 */
test("a task that reported rather than changed reads as an ending, not a failure", () => {
  // "Changed no files" is failure for "fix the retry loop" and success for
  // "audit the codebase". The channel used to say the second was the first.
  assert.equal(
    narrateTaskEvent("task_reported", {
      explanation: "No logic errors in the diff; two naming nits, both safe.",
    }),
    "No logic errors in the diff; two naming nits, both safe.",
  );
  // The agent's own words are the deliverable, but their absence is not a
  // reason to say nothing.
  assert.equal(
    narrateTaskEvent("task_reported", {}),
    "Finished without needing to change anything.",
  );
});

test("a finished task says what it did, not that the pipeline worked", () => {
  // "Done — the change is in canonical." was the ending of every successful
  // task this system had ever run. It is true of all of them and says nothing
  // about any of them, so watching two tasks finish taught the reader
  // nothing — while the agent's own account of the work sat in the changeset,
  // carried all the way to promotion and never read.
  assert.equal(
    narrateTaskEvent("canonical_promoted", {
      agentExplanation:
        "Repointed six test imports at their new modules; collection passes.",
      files: ["a.py", "b.py"],
    }),
    "Repointed six test imports at their new modules; collection passes. " +
      "(a.py, b.py)",
  );
  // Named while there are few enough to name: "(1 file changed)" says
  // something landed without saying what, which is the one thing a reader
  // cannot check against the repository in front of them.
  assert.match(
    narrateTaskEvent("canonical_promoted", {
      agentExplanation: "Raised the retry ceiling to five.",
      files: ["retry.ts"],
    }) ?? "",
    /\(retry\.ts\)$/u,
  );
  // Past two, a count again — an ending that lists a dozen paths is not one.
  assert.match(
    narrateTaskEvent("canonical_promoted", {
      agentExplanation: "Split the module.",
      files: ["a.py", "b.py", "c.py"],
    }) ?? "",
    /\(3 files changed\)$/u,
  );
  // No files recorded is not a reason to withhold the summary.
  assert.equal(
    narrateTaskEvent("canonical_promoted", {
      agentExplanation: "Raised the retry ceiling to five.",
    }),
    "Raised the retry ceiling to five.",
  );

  // The adapters' fallback for a model that explained nothing is the vendor
  // name and the objective handed back — and the objective is already the
  // thread's title, so that is the canned line with extra steps. Say the
  // plain thing instead of dressing it up as a summary.
  for (const written of [
    "claude completed Repair stale test imports",
    "Codex completed the objective",
    "",
    "   ",
  ]) {
    assert.equal(
      narrateTaskEvent("canonical_promoted", { agentExplanation: written }),
      "Done — the change is in canonical.",
      written,
    );
  }

  // Bounded: a model that ignores "one sentence" must not paste an essay into
  // a channel everybody is reading.
  const essay = narrateTaskEvent("canonical_promoted", {
    agentExplanation: `${"word ".repeat(400)}end`,
  });
  assert.ok((essay ?? "").length < 450, String(essay?.length));
  assert.match(essay ?? "", /…$/u);

  // Newlines collapse: the ending is one line in a channel, and a multi-line
  // explanation would otherwise read as several messages.
  assert.equal(
    narrateTaskEvent("canonical_promoted", {
      agentExplanation: "Fixed the loop.\n\nAlso tidied the imports.",
    }),
    "Fixed the loop. Also tidied the imports.",
  );
});

test("a failed task says why, whichever shape the failure was recorded in", () => {
  const integration = narrateTaskEvent("task_failed", {
    status: "policy_failed",
    explanation: "the changeset touched a protected path",
  });
  assert.match(String(integration), /policy|rules would not let/iu);
  assert.match(String(integration), /protected path/u);

  // No explanation at all still names the outcome rather than shrugging.
  assert.equal(
    narrateTaskEvent("task_failed", { status: "conflict" }),
    "I could not finish this — the change clashed with work that landed " +
      "while I was writing it, and I could not merge the two.",
  );

  // The `error` shape every other emitter uses is unchanged.
  assert.equal(
    narrateTaskEvent("task_failed", { stage: "execution", error: "boom" }),
    "I could not finish this: boom",
  );

  // An expired sign-in keeps its own remedy, and does not get an integration
  // reason bolted onto it.
  assert.match(
    String(
      narrateTaskEvent("task_failed", {
        error: "OAuth session expired and could not be refreshed",
      }),
    ),
    /sign-in has expired\. Reconnect me from My Agents/u,
  );

  // Nothing to say at all is still the honest fallback.
  assert.equal(
    narrateTaskEvent("task_failed", {}),
    "I could not finish this.",
  );
});

/**
 * A read-only request that ends with no diff reaches the failure path with its
 * whole answer inside the failure: the coordinator appends the agent's own
 * account to the alarm rather than discarding it. Clipping that at 200
 * characters is how a channel showed "…What the URL act" and stopped — the
 * deliverable, cut mid-word, with nothing to open and read the rest in.
 */
test("a failure carrying the agent's own account keeps the account whole", () => {
  const account =
    "Diagnosis only — no files changed. Short answer: no, that URL does not " +
    "mean your pasted photos go into the codebase. What the URL actually " +
    "points at is the attachment route, which reads the bytes back out of " +
    "the attachment store; nothing on that path writes them into the " +
    "repository, so pasting a screenshot cannot bloat the checkout.";
  const said = String(
    narrateTaskEvent("task_failed", {
      status: "empty",
      explanation:
        "The agent produced no repository changes. " +
        `${AGENT_ACCOUNT_PREFIX} ${account}`,
    }),
  );
  // The alarm still leads — an empty run from a task meant to write is still
  // a failure, whatever it says for itself.
  assert.match(said, /^I could not finish this — I did not end up with any/u);
  // And the answer survives in full, unclipped and unbroken.
  assert.ok(said.includes(account), said);
  assert.doesNotMatch(said, /…/u);
});

test("a clipped failure detail still ends on a whole word", () => {
  // A bare slice cut mid-word, which reads as a model that stopped
  // mid-thought rather than as a quotation somebody shortened.
  const detail = Array.from({ length: 200 }, (_, index) => `token${index}`).join(
    " ",
  );
  const said = explainAnswerFailure(detail);
  assert.match(said, /…$/u);
  const quoted = said
    .replace("I could not answer that just now: ", "")
    .replace(/…$/u, "")
    .trim();
  for (const word of quoted.split(" ")) {
    assert.match(word, /^token\d+$/u, said);
  }
});

test("a refused GitHub push keeps GitHub's remedy, not the agent's", () => {
  // The push path fails in GitHub's name when the *submitter's* token is
  // refused. It speaks the same auth vocabulary — "401", "unauthorized" —
  // but "Reconnect me from My Agents" is the wrong door: it sends somebody
  // off to reconnect an agent that is working fine, while the actual fix
  // lives in Settings → GitHub and the failure's own words point there.
  const said = String(
    narrateTaskEvent("task_failed", {
      error:
        "GitHub refused the stored token during the push (401). " +
        "Reconnect GitHub in Settings and ask again.",
    }),
  );
  assert.doesNotMatch(said, /Reconnect me from My Agents/u);
  assert.match(said, /Reconnect GitHub in Settings/u);

  // The same guard where a question failed rather than a task.
  assert.doesNotMatch(
    explainAnswerFailure("GitHub answered 401 for the stored token"),
    /My Agents/u,
  );

  // And a genuine vendor sign-in failure still gets its remedy.
  assert.match(
    explainAnswerFailure("OAuth session expired and could not be refreshed"),
    /Reconnect me from My Agents/u,
  );
});

/**
 * A thread hangs off one agent's message about one task, so a reply in it is
 * addressed to that agent and needs no @mention. The route used to store the
 * reply and stop, which is why "what did you get done then?" got silence.
 */
test("a reply in an agent's thread is answered by that agent, with the thread as context", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic" }]);
  const repositoryId = await invitableRepository(owner, "thread-reply-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  // The thread as the task narrator leaves it: an agent-authored root, and a
  // failure with no detail — exactly the state the question follows.
  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it — scoping a chess engine architecture.",
  });
  await runtime.store.addChannelReply({
    repositoryId,
    messageId: root.id,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "I could not finish this.",
  });

  runtime.chatAnswer.text = "I got as far as the move generator and stopped.";
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "what did you get done then?" } },
  );
  assert.equal(replied.status, 201);

  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    const thread = listed.data.messages.find(
      (message: any) => message.id === root.id,
    );
    return thread?.replies?.some(
      (reply: any) => reply.content === runtime.chatAnswer.text,
    ) === true;
  }, "the agent never answered the question in its own thread");

  const asked = runtime.chatPrompts.at(-1);
  assert.equal(asked?.userId, ownerId);
  assert.equal(asked?.provider, "anthropic");
  // The thread went with the question: without it the agent is being asked
  // what it did with no record of what it did.
  assert.match(String(asked?.prompt), /what did you get done then\?/u);
  assert.match(String(asked?.prompt), /scoping a chess engine architecture/u);
  assert.match(String(asked?.prompt), /I could not finish this\./u);
  // The answer is attributed to the agent whose thread it is, not the asker.
  const listed = await owner.request(`${base}/messages`);
  const answer = listed.data.messages
    .find((message: any) => message.id === root.id)
    ?.replies?.at(-1);
  assert.equal(answer.kind, "outcome");
  assert.equal(answer.authorId, `${ownerId}:anthropic`);
});

test("a human channel reply extending an agent thread starts exactly one provider turn", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "openai" }]);
  const repositoryId = await invitableRepository(owner, "streamed-thread-reply");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:openai`,
    content: "I updated the retry helper.",
  });
  await runtime.store.addChannelReply({
    repositoryId,
    messageId: root.id,
    kind: "outcome",
    authorId: `${ownerId}:openai`,
    content: "The retry helper now backs off exponentially.",
  });

  runtime.chatAnswer.streamEvents = [
    { type: "status", status: "working" },
    { type: "reasoning_start", hidden: false },
    { type: "reasoning", text: "Checking the earlier result." },
    { type: "text", delta: "It still caps at five attempts." },
  ];
  runtime.chatAnswer.text = "It still caps at five attempts.";
  const before = runtime.chatPrompts.length;
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "does it still cap the attempts?" } },
  );
  assert.equal(replied.status, 201);

  await waitFor(async () => {
    const thread = await runtime.store.getChannelMessage(
      repositoryId,
      root.id,
      ownerId,
    );
    return (
      thread?.replies.some(
        (reply) =>
          reply.kind === "outcome" &&
          reply.content === "It still caps at five attempts.",
      ) === true
    );
  }, "the resumed provider turn never wrote its terminal reply");

  assert.equal(runtime.chatPrompts.length - before, 1);
  const prompt = runtime.chatPrompts.at(-1);
  assert.equal(prompt?.userId, ownerId);
  assert.equal(prompt?.provider, "openai");
  assert.match(prompt?.prompt ?? "", /backs off exponentially/u);
  assert.equal(
    (prompt?.prompt.match(/does it still cap the attempts\?/gu) ?? []).length,
    1,
    "the new prompt belongs in the provider turn once",
  );

  const thread = await runtime.store.getChannelMessage(
    repositoryId,
    root.id,
    ownerId,
  );
  const humanReply = thread?.replies.findIndex(
    (reply) => reply.content === "does it still cap the attempts?",
  ) ?? -1;
  const resumed = thread?.replies.slice(humanReply + 1) ?? [];
  assert.deepEqual(
    resumed.map((reply) => reply.kind),
    ["progress", "progress", "outcome"],
  );
  assert.equal(resumed[0]?.content, "Working…");
  assert.equal(resumed[1]?.content, "Checking the earlier result.");
  assert.equal(resumed[2]?.content, "It still caps at five attempts.");
});

test("each resumed turn emits fresh hidden reasoning and a terminal reply without recursion", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic" }]);
  const repositoryId = await invitableRepository(owner, "repeated-thread-turns");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "I finished the config migration.",
  });

  for (const [question, answer] of [
    ["which key changed?", "The key is now retryLimit."],
    ["what is its default?", "Its default is five."],
  ] as const) {
    runtime.chatAnswer.streamEvents = [
      { type: "reasoning_start", hidden: true },
      { type: "reasoning_tokens", tokens: 12 },
      { type: "text", delta: answer },
    ];
    runtime.chatAnswer.text = answer;
    const turnsBefore = runtime.chatPrompts.length;
    const posted = await owner.request(
      `${base}/messages/${encodeURIComponent(root.id)}/replies`,
      { method: "POST", body: { content: question } },
    );
    assert.equal(posted.status, 201);
    await waitFor(async () => {
      const thread = await runtime.store.getChannelMessage(
        repositoryId,
        root.id,
        ownerId,
      );
      return thread?.replies.some(
        (reply) => reply.kind === "outcome" && reply.content === answer,
      ) === true;
    }, `the turn for ${question} never finished`);
    assert.equal(runtime.chatPrompts.length - turnsBefore, 1);
  }

  const thread = await runtime.store.getChannelMessage(
    repositoryId,
    root.id,
    ownerId,
  );
  assert.equal(
    thread?.replies.filter(
      (reply) => reply.kind === "progress" && reply.content === "Thinking…",
    ).length,
    2,
  );
  assert.equal(
    thread?.replies.filter((reply) => reply.kind === "outcome").length,
    2,
  );
  const callsAfterAgentMessages = runtime.chatPrompts.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    runtime.chatPrompts.length,
    callsAfterAgentMessages,
    "agent-authored progress and outcomes must not start provider turns",
  );
  assert.match(
    runtime.chatPrompts.at(-1)?.prompt ?? "",
    /The key is now retryLimit\./u,
  );
});

/**
 * The reader's next move is different for each way an agent can go missing,
 * and one fixed sentence about reconnecting is wrong for three of them. These
 * two cover the pair that actually happen: a sign-in that went away, and an
 * agent taken out of the channel while its threads stayed behind.
 */
test("a reply whose agent is no longer connected says so, and says who can fix it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic" }]);
  const repositoryId = await invitableRepository(owner, "thread-gone-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it — scoping the move generator.",
  });

  // The credential goes away between the work and the question, which is what
  // an expired or revoked sign-in looks like from here.
  runtime.chatConnections.delete(ownerId);

  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "what did you get done then?" } },
  );
  assert.equal(replied.status, 201);

  await waitFor(async () => {
    const thread = (
      await runtime.store.listChannelMessages(repositoryId, ownerId)
    ).find((message) => message.id === root.id);
    return (thread?.replies ?? []).some((reply) => reply.kind === "system");
  }, "a reply to a disconnected agent got no answer at all");

  const thread = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.id === root.id);
  const said = (thread?.replies ?? []).find((reply) => reply.kind === "system");
  assert.match(String(said?.content), /not connected any more/u);
  assert.match(String(said?.content), /My Agents/u);
  // Not in the missing agent's voice: the news is that nobody answered, and
  // attributing it to the absent participant reads as though somebody did.
  assert.equal(said?.authorId, "system");
  assert.equal(
    (thread?.replies ?? []).some(
      (reply) => reply.kind === "agent" && reply.authorId.includes("anthropic"),
    ),
    false,
  );
});

test("a reply whose agent has left the channel says that, not that it is disconnected", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic" }]);
  const repositoryId = await invitableRepository(owner, "thread-left-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it — scoping the move generator.",
  });
  // Reading the roster first settles the one-time membership backfill, so
  // removing the row below is a removal rather than something the next read
  // grandfathers straight back in.
  assert.equal((await owner.request(`${base}/agents`)).status, 200);
  await runtime.store.setChannelAgentMember(
    repositoryId,
    ownerId,
    "anthropic",
    false,
  );

  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "what did you get done then?" } },
  );
  assert.equal(replied.status, 201);

  await waitFor(async () => {
    const thread = (
      await runtime.store.listChannelMessages(repositoryId, ownerId)
    ).find((message) => message.id === root.id);
    return (thread?.replies ?? []).some((reply) => reply.kind === "system");
  }, "a reply to an agent that left the channel got no answer at all");

  const thread = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.id === root.id);
  const said = (thread?.replies ?? []).find((reply) => reply.kind === "system");
  // The sign-in is fine. Telling somebody to reconnect it sends them to a
  // screen where nothing is wrong.
  assert.match(String(said?.content), /left this channel/u);
  assert.doesNotMatch(String(said?.content), /My Agents/u);
});

test("work asked for inside a thread travels with the thread, beside the objective", async (t) => {
  // Threads have had shared context for talking since agents began answering
  // follow-ups. Working was the gap: "now update the other file the same way"
  // reached the agent as an objective and nothing else, with no record of
  // what "the same way" referred to.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic" }]);
  const repositoryId = await invitableRepository(owner, "thread-context-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it — renaming the config loader.",
  });
  await runtime.store.addChannelReply({
    repositoryId,
    messageId: root.id,
    kind: "progress",
    authorId: `${ownerId}:anthropic`,
    content: "Editing src/config.ts",
  });
  await runtime.store.addChannelReply({
    repositoryId,
    messageId: root.id,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "Renamed loadConfig to readConfig in src/config.ts.",
  });

  runtime.chatAnswer.text = "On it — the endpoint file next.";
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "now update the endpoint file the same way" } },
  );
  assert.equal(replied.status, 201);

  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "asking for work inside a thread never dispatched anything",
  );
  const [task] = runtime.submittedTasks;
  assert.ok(task !== undefined);
  const context = task.context ?? "";
  assert.match(context, /renaming the config loader/u);
  assert.match(context, /Renamed loadConfig to readConfig/u);
  // Progress replies are the run narrating itself. Feeding an agent its own
  // commentary back is noise somebody has already paid for once.
  assert.doesNotMatch(context, /Editing src\/config\.ts/u);
  // The request itself is already the objective; sending it twice only tells
  // the model the same thing twice.
  assert.doesNotMatch(context, /now update the endpoint file the same way/u);

  // The whole reason this is a field of its own: the objective is rendered in
  // the channel, in task lists and in thread titles, and a transcript folded
  // into it would make every request unreadable in all three.
  assert.match(task.objective, /update the endpoint file/u);
  assert.doesNotMatch(task.objective, /config loader/u);
});

test("a request that merely opens a thread carries nothing; the follow-up in it does", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "thread-context-e2e");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  assert.equal(
    (await owner.request(`${base}/agents/anthropic`, {
      method: "POST",
      body: { name: "Rewriter" },
    })).status,
    200,
  );

  runtime.chatAnswer.text = "On it — rewriting the retry helper.";
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Rewriter please rewrite the retry helper in src/retry.ts" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mention never dispatched a task",
  );
  // A brand-new request has no history worth carrying — it merely happens to
  // open a thread.
  assert.equal(runtime.submittedTasks[0]?.context, undefined);

  const threadRoot = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.kind === "agent");
  assert.ok(threadRoot !== undefined, "the dispatch never opened a thread");

  // What the run narrates back into its own thread while it works, which is
  // the part a follow-up is usually about.
  await runtime.store.addChannelReply({
    repositoryId,
    messageId: threadRoot.id,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "Rewrote src/retry.ts to back off exponentially.",
  });

  const followUp = await owner.request(
    `${base}/messages/${encodeURIComponent(threadRoot.id)}/replies`,
    { method: "POST", body: { content: "now update the config loader the same way" } },
  );
  assert.equal(followUp.status, 201);
  await waitFor(
    async () => runtime.submittedTasks.length > 1,
    "the follow-up inside the thread never dispatched a task",
  );

  const context = runtime.submittedTasks[1]?.context ?? "";
  assert.match(context, /Rewrote src\/retry\.ts/u);
  // The request being dispatched is the objective, not part of its own
  // background.
  assert.doesNotMatch(context, /now update the config loader the same way/u);
  assert.match(
    runtime.submittedTasks[1]?.objective ?? "",
    /update the config loader/u,
  );
});

/** A thread on a person's message is a conversation between people. */
test("a reply in a person's thread does not summon an agent", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  runtime.chatConnections.set(bootstrapped.user.id, [{ provider: "anthropic" }]);
  const repositoryId = await invitableRepository(owner, "human-thread-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "Notes from standup." },
  });
  const before = runtime.chatPrompts.length;
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(posted.data.message.id)}/replies`,
    { method: "POST", body: { content: "what did you get done then?" } },
  );
  assert.equal(replied.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    runtime.chatPrompts.length,
    before,
    "a human thread must not spend somebody's model usage",
  );
});

test("a reply in an open thread continues the conversation, whoever it mentions", async (t) => {
  // Stage four of docs/architecture/conversational-tasks.md: the open status
  // is a routing rule. A thread whose task is open is a conversation between
  // turns, and a work request replied into it goes back to the agent whose
  // conversation it is — mentioning somebody else in the reply is content
  // for the turn, not a re-assignment.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "open-thread-repo");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  assert.equal(
    (await owner.request(`${base}/agents/anthropic`, {
      method: "POST",
      body: { name: "Keeper" },
    })).status,
    200,
  );
  assert.equal(
    (await owner.request(`${base}/agents/openai`, {
      method: "POST",
      body: { name: "Other" },
    })).status,
    200,
  );

  runtime.chatAnswer.text = "On it — updating the retry helper.";
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Keeper please update the retry helper in src/retry.ts" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mention never dispatched a task",
  );

  const threadRoot = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.kind === "agent");
  assert.ok(threadRoot !== undefined, "the dispatch never opened a thread");
  // The first turn already carries the conversation — the thread root's own
  // id — so the task it leaves behind can wait as `open`.
  assert.equal(runtime.submittedTasks[0]?.conversationId, threadRoot.id);
  assert.ok(threadRoot.taskId !== undefined, "the thread never got its task");

  // The turn lands, the way the run loop lands a conversational turn: the
  // claimed task goes open instead of terminal. The store row is what the
  // replies route reads to route the next message.
  await runtime.store.claimSubmittedTasks(repositoryId);
  await runtime.store.openSubmittedTask(threadRoot.taskId);

  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(threadRoot.id)}/replies`,
    {
      method: "POST",
      body: { content: "@Other now update the config loader the same way" },
    },
  );
  assert.equal(replied.status, 201);
  await waitFor(
    async () => runtime.submittedTasks.length > 1,
    "the reply never continued the conversation",
  );

  // Same conversation, same agent — the mention of @Other rode along as
  // content rather than redirecting the work.
  assert.equal(runtime.submittedTasks[1]?.conversationId, threadRoot.id);
  assert.equal(
    runtime.submittedTasks[1]?.vendor,
    runtime.submittedTasks[0]?.vendor,
  );
  assert.match(
    runtime.submittedTasks[1]?.objective ?? "",
    /config loader/u,
  );
  // And the next turn's submission settled the previous open one: at most
  // one turn of a conversation is ever open.
  const settled = (
    await runtime.store.listSubmittedTasks({ repositoryId })
  ).find((task) => task.id === threadRoot.taskId);
  assert.equal(settled?.status, "integrated");
});

/*
 * Per-repository role labels: a `role` override on `setChannelAgentOverride`
 * (see `ChannelAgentOverride` in store.ts) is the only source of an agent's
 * role — there is no vendor-guessed default — and reaches the roster and,
 * for a dispatched task, the objective the agent actually receives.
 */

test("a channel's role override reaches the roster and the objective a dispatched task receives", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "role-override-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Before any override, the agent is unlabeled — no vendor-guessed default.
  // (The roster route itself carries no `role` field; the client resolves it
  // from `agentOverrides`, same as `name`/`model`/`effort` — see
  // `channelAgentsFor` in data.js. What this route needs to keep working is
  // just that it still answers normally with nothing set.)
  const beforeRoster = await owner.request(`${base}/agents`);
  assert.equal(beforeRoster.status, 200, JSON.stringify(beforeRoster.data));

  const overridden = await owner.request(`${base}/agents/anthropic`, {
    method: "POST",
    body: { role: "Frontend Agent" },
  });
  assert.equal(overridden.status, 200, JSON.stringify(overridden.data));
  assert.equal(overridden.data.override.role, "Frontend Agent");

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) please tidy up the settings layout" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  const [task] = runtime.submittedTasks;
  assert.ok(task !== undefined);
  // The role the channel declared reaches the actual prompt content, ahead
  // of the request itself — see `withRoleContext` and its call site in
  // `dispatchOneMention`.
  assert.match(task.objective, /^Your role in this repository: Frontend Agent\.\n\n/u);
  assert.match(task.objective, /tidy up the settings layout/u);

  // Clearing the role (an empty string, same as clearing model/effort) goes
  // back to unlabeled — there is no vendor-wide default to fall back to —
  // so the objective is left untouched rather than prefixing anything.
  const cleared = await owner.request(`${base}/agents/anthropic`, {
    method: "POST",
    body: { role: "" },
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  const postedAgain = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) one more thing please" },
  });
  assert.equal(postedAgain.status, 201);
  const [, second] = runtime.submittedTasks;
  assert.ok(second !== undefined);
  assert.equal(second.objective, "one more thing please");
});

test("a thread carries what its task changed, and keeps it", async (t) => {
  // What the thread could not previously answer. The narration said "wrote
  // changes to a.ts, b.ts and 2 more" once, in passing, and scrolled away;
  // there was nothing a reader could come back to.
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "thread-changes");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) please fix the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 1);
  const taskId = (await runtime.store.listSubmittedTasks({ repositoryId }))[0]?.id;
  assert.ok(taskId !== undefined);

  // The thread is joined to the work, so the summary stays attributable once
  // the process that watched the run is gone.
  const threadRoot = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.kind === "agent");
  assert.equal(threadRoot?.taskId, taskId);

  // What the run reports while it works.
  await runtime.store.appendAudit(undefined, {
    type: "workspace_changed",
    taskId,
    data: {
      files: [
        { path: "src/retry.ts", status: "modified" },
        { path: "src/retry.test.ts", status: "added" },
      ],
      changed: ["src/retry.ts"],
    },
  });

  await waitFor(async () => {
    const message = (await runtime.store.listChannelMessages(repositoryId, ownerId)).find(
      (entry) => entry.kind === "agent",
    );
    return (message?.changedFiles?.length ?? 0) > 0;
  }, "the thread never picked up what the run was changing");

  const listed = await owner.request(`${base}/messages`);
  const thread = (listed.data.messages as any[]).find(
    (message) => message.kind === "agent",
  );
  assert.deepEqual(thread.changedFiles, [
    { path: "src/retry.ts", status: "modified" },
    { path: "src/retry.test.ts", status: "added" },
  ]);

  // The final set replaces the live one rather than merging into it: an agent
  // that reverts itself leaves a file no longer changed, and a summary built
  // by accumulating deltas would keep claiming an edit that is gone.
  await runtime.store.appendAudit(undefined, {
    type: "changeset_collected",
    taskId,
    data: {
      changeSetId: "changeset_1",
      files: ["src/retry.ts"],
      changedFiles: [{ path: "src/retry.ts", status: "modified" }],
    },
  });
  await waitFor(async () => {
    const message = (await runtime.store.listChannelMessages(repositoryId, ownerId)).find(
      (entry) => entry.kind === "agent",
    );
    return message?.changedFiles?.length === 1;
  }, "the final changeset never replaced the live summary");
});

test("a command and a mention work together, and /plan holds the run", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "slash-commands");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // The command says how to treat the request; the "@" says who for. The
  // objective must survive both being taken off.
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/plan @Claude (Owner) rework the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  assert.match(runtime.submittedTasks[0]?.objective ?? "", /rework the retry loop/u);
  assert.doesNotMatch(runtime.submittedTasks[0]?.objective ?? "", /\/plan/u);

  // Filed as held, and deliberately not started. `planned` rather than
  // `submitted` is the whole point: `submitted` means "queued to run", which
  // is what every lease query selects on, so a hold spelled that way was
  // indistinguishable from ordinary queued work.
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.equal(task?.status, "planned");
  const root = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.kind === "agent");
  assert.match(
    (root?.replies ?? []).map((reply) => reply.content).join("\n"),
    /nothing is running yet/u,
  );

  // The browser retires the typing dots by looking this task up in the list
  // it polls and finding a status outside its working set. That only works if
  // the list carries the task at all — a held plan filtered out of the API
  // would leave `agentsThinkingIn` unable to find it, and the agent would
  // show as thinking for the full ten-minute backstop underneath a message
  // that says in words that nothing is running.
  const listed = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks`,
  );
  assert.equal(listed.status, 200);
  assert.equal(
    (listed.data.tasks as Array<{ id: string; status: string }>).find(
      (entry) => entry.id === task?.id,
    )?.status,
    "planned",
    JSON.stringify(listed.data.tasks),
  );
  // And the filter knows the status, so asking for held work is not a 400.
  const filtered = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks?status=planned`,
  );
  assert.equal(filtered.status, 200);
  assert.equal((filtered.data.tasks as unknown[]).length, 1);

  // And "go ahead" is what starts it.
  const go = await owner.request(
    `${base}/messages/${encodeURIComponent(root?.id ?? "")}/replies`,
    { method: "POST", body: { content: "go ahead" } },
  );
  assert.equal(go.status, 201);
  await waitFor(async () => {
    const thread = (
      await runtime.store.listChannelMessages(repositoryId, ownerId)
    ).find((message) => message.kind === "agent");
    return (thread?.replies ?? []).some((reply) =>
      /Starting now/u.test(reply.content),
    );
  }, "the approved plan never started");
});

test("a channel's chosen model and reasoning level travel to the task", async (t) => {
  // The pickers beside an agent in the roster wrote to a table nothing read:
  // name and role reached the dispatch, model and effort were stored and
  // dropped. Choosing a model moved a control and changed nothing about how
  // the run was performed, which is the one thing a model picker is for.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "picked-model");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel`;
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";

  const chosen = await owner.request(
    `${base}/agents/${encodeURIComponent(`${ownerId}:anthropic`)}`,
    { method: "POST", body: { model: "claude-opus-5", effort: "max" } },
  );
  assert.equal(chosen.status, 200, JSON.stringify(chosen.data));

  const mention = `Claude (${String(session.user.displayName).split(" ")[0]})`;
  assert.equal(
    (
      await owner.request(`${base}/messages`, {
        method: "POST",
        body: { content: `@${mention} raise the retry ceiling` },
      })
    ).status,
    201,
  );
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mention never dispatched a task",
  );
  assert.equal(runtime.submittedTasks[0]?.model, "claude-opus-5");
  assert.equal(runtime.submittedTasks[0]?.effort, "max");
  // And onto the row the runner actually reads when it builds the adapter.
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId: repo });
  assert.equal(task?.model, "claude-opus-5");
  assert.equal(task?.effort, "max");
});

test("an unrelated mention does not run somebody's held plan", async (t) => {
  // The approval that comes *before* the work is paid for is the only one of
  // its kind in the system, and it was being spent by strangers. A held plan
  // sat in `submitted` — the status every lease query selects on — and
  // `leaseNextTask` hands out the oldest queued row in the repository, not the
  // one the caller had in mind. So the next person to mention any agent in the
  // channel fired `runRepository`, which leased the older held plan and ran
  // it, against its author's credential, with nobody having said go.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "held-plan");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  assert.equal(
    (
      await owner.request(`${base}/messages`, {
        method: "POST",
        body: { content: "/plan @Claude (Owner) rewrite the auth module" },
      })
    ).status,
    201,
  );
  const held = (await runtime.store.listSubmittedTasks({ repositoryId }))[0];
  assert.equal(held?.status, "planned");

  // Somebody else's ordinary request, in the same channel, later.
  assert.equal(
    (
      await owner.request(`${base}/messages`, {
        method: "POST",
        body: { content: "@Claude (Owner) fix the typo in the README" },
      })
    ).status,
    201,
  );
  await waitFor(
    async () =>
      (await runtime.store.listSubmittedTasks({ repositoryId })).length === 2,
    "the second mention never dispatched",
  );

  // The queue may hand out the typo fix. It must not hand out the plan: a
  // lease naming the held task is the bypass itself.
  const worker = await runtime.store.registerWorker({
    userId: ownerId,
    organizationId: DEFAULT_ORGANIZATION_ID,
    name: "queue-probe",
    adapters: [],
    version: "1",
  });
  const leased = await runtime.store.leaseNextTask({
    workerId: worker.id,
    repositoryId,
    baseRevision: "rev_1",
    ttlMs: 60_000,
  });
  assert.notEqual(
    leased?.task.id,
    held?.id,
    "a held plan was leased without anybody approving it",
  );
  assert.equal(
    (await runtime.store.listSubmittedTasks({ repositoryId })).find(
      (task) => task.id === held?.id,
    )?.status,
    "planned",
    "the held plan left the held status without an approval",
  );
});

test("a slash inside a sentence is left alone, and /help answers", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "slash-prose");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const help = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/help" },
  });
  assert.equal(help.status, 201);
  const listed = await owner.request(`${base}/messages`);
  assert.match(
    (listed.data.messages as any[]).map((m) => m.content).join("\n"),
    /\/plan/u,
  );
  // The picker reads the same table the channel parses by, so they cannot
  // offer and accept different things.
  assert.ok(
    (listed.data.slashCommands as any[]).some((entry) => entry.name === "plan"),
    JSON.stringify(listed.data.slashCommands),
  );
  // /help answers the channel; it does not become work for an agent.
  assert.equal(runtime.submittedTasks.length, 0);

  // A path is a sentence, not syntax.
  const prose = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) please fix /usr/bin/env handling" },
  });
  assert.equal(prose.status, 201);
  assert.equal(runtime.submittedTasks.length, 1);
  assert.match(runtime.submittedTasks[0]?.objective ?? "", /usr\/bin\/env/u);
});

test("an investigator says why a task failed, and retries when told to", async (t) => {
  // A failure ended with one line and nobody read it. The reason was in the
  // audit trail, which nobody goes and reads either.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "investigator-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const promoted = await owner.request(`${base}/agents/${ownerId}:anthropic`, {
    method: "POST",
    body: { role: "investigator" },
  });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.data));

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) please fix the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const taskId = (await runtime.store.listSubmittedTasks({ repositoryId }))[0]?.id;
  assert.ok(taskId !== undefined);

  runtime.chatAnswer.text = [
    "VERDICT",
    "class: flaky_gate",
    "retry: yes",
    "detail: The gate failed on a timing assertion that passed twice before.",
    "END",
  ].join("\n");

  // A real failure is both: the row settles and the run traces it. The
  // investigator reads the trail; the retry reads the row.
  await runtime.store.claimSubmittedTasks(repositoryId);
  await runtime.store.completeSubmittedTask(taskId, "failed");
  await runtime.store.appendAudit(undefined, {
    type: "task_failed",
    taskId,
    data: { status: "validation_failed", explanation: "tests timed out" },
  });

  const thread = () =>
    runtime.store.listChannelMessages(repositoryId, ownerId).then((messages) =>
      messages.find((message) => message.kind === "agent"),
    );
  await waitFor(async () => {
    const root = await thread();
    return (root?.replies ?? []).some((reply) =>
      /timing assertion/u.test(reply.content),
    );
  }, "the investigator never said why the task failed");

  const root = await thread();
  const verdict = (root?.replies ?? []).find((reply) =>
    /timing assertion/u.test(reply.content),
  );
  // Named as a kind of failure, not just restated.
  assert.match(verdict?.content ?? "", /fails intermittently/u);
  assert.match(verdict?.content ?? "", /yes, retry/u);

  // It must not have retried on its own — that is a spend loop.
  assert.equal(
    (await runtime.store.listSubmittedTasks({ repositoryId }))[0]?.status,
    "failed",
  );

  // The person says so, and only then does it go back in the queue.
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root?.id ?? "")}/replies`,
    { method: "POST", body: { content: "yes, retry it" } },
  );
  assert.equal(replied.status, 201);
  await waitFor(async () => {
    const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
    return task?.status === "submitted";
  }, "the approved retry never re-queued the task");
});

test("a personal agent cannot be made investigator either", async (t) => {
  // Same rule as the auditor, for the same reason: nobody names it, so it
  // spends its owner's account unprompted.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "investigator-personal");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [{ provider: "anthropic" }]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const refused = await owner.request(`${base}/agents/${ownerId}:anthropic`, {
    method: "POST",
    body: { role: "investigator" },
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.data));
  assert.equal(refused.data.error.code, "investigator_must_be_org_wide");
});

test("asking to install a system package is answered, not queued for ten minutes", async (t) => {
  // What happened instead: the task planned no files, negotiated scope it
  // could never use, and was cancelled ten minutes later with "session
  // cancelled" — a sentence about the mechanism, with nothing in it the
  // reader could act on.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "system-install");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) apt-get install python3 and run the tests" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(
    runtime.submittedTasks.length,
    0,
    JSON.stringify(runtime.submittedTasks),
  );
  const after = await owner.request(`${base}/messages`);
  const answer = (after.data.messages as any[]).find(
    (message) => message.kind === "agent",
  );
  assert.ok(answer !== undefined, JSON.stringify(after.data.messages));
  // It names the file, because that is the real answer rather than a refusal.
  assert.match(answer.content, /control-plane\.Dockerfile/u);
});

test("an ordinary install of a dependency is still real work", async (t) => {
  // The refusal above has to be narrow. "install the eslint plugin" edits
  // package.json and is an ordinary change; guessing at intent from the word
  // "install" would refuse real work, which is worse than the wait it saves.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "dependency-install");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) install the eslint plugin we discussed" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
});

test("renaming your own agent does not rename everybody else's on that vendor", async (t) => {
  // A bare provider id names a *vendor*, not an agent, and the reader applied
  // it to every agent on that vendor. One person renaming their own Claude
  // renamed their colleague's too — and their role label travelled with it,
  // which for the auditor role is a permanent spend commitment.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "rename-isolation");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const colleague = await addColleague(runtime, "rename-colleague@example.com");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  runtime.chatConnections.set(colleague.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Renamed the way the owner's own agent card does it: a bare provider id.
  const renamed = await owner.request(`${base}/agents/anthropic`, {
    method: "POST",
    body: { name: "Eos" },
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));

  const roster = await owner.request(`${base}/agents`);
  assert.equal(roster.status, 200);
  const byUser = new Map(
    (roster.data.agents as any[]).map((entry) => [entry.userId, entry]),
  );
  assert.equal(byUser.get(ownerId)?.name, "Eos");
  // The colleague's agent keeps its own name.
  assert.notEqual(byUser.get(colleague.id)?.name, "Eos");
});

test("a renamed agent answers to its new name, and the roster says that name", async (t) => {
  // The bug in full: the server resolved overrides one way and the browser
  // another, so a rename showed on screen while the server still matched the
  // older per-agent name. Mentioning what you could see did nothing.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "rename-answers");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // An older per-agent override, the shape a teammate's rename writes.
  assert.equal(
    (await owner.request(`${base}/agents/${ownerId}:anthropic`, {
      method: "POST",
      body: { name: "Icarus" },
    })).status,
    200,
  );
  // Then the owner renames from their own agent card, which sends a bare id.
  assert.equal(
    (await owner.request(`${base}/agents/anthropic`, {
      method: "POST",
      body: { name: "Daedalus" },
    })).status,
    200,
  );

  // The roster reports the name the server will actually match, so the screen
  // and the matcher cannot disagree.
  const roster = await owner.request(`${base}/agents`);
  assert.equal(
    (roster.data.agents as any[])[0]?.name,
    "Daedalus",
    JSON.stringify(roster.data.agents),
  );

  // And mentioning that name dispatches.
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Daedalus please fix the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
});

/*
 * Opt-in channel membership: connecting a vendor CLI makes an agent usable,
 * not automatically present in every repository's channel. A repository that
 * predates opt-in grandfathers in whatever was reachable at its first roster
 * read (see `channelAgentConnections`'s doc comment). A repository created
 * after it has nothing predating it, so it grandfathers nothing — reported
 * from the app as "i created a new repo and my claude agent was already added
 * to it", which was the backfill firing on a channel with no prior roster to
 * protect.
 */

test("channel membership is opt-in: an older repository grandfathers once, a new one starts empty", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);

  // A repository that predates opt-in, written straight to the store the way
  // one already in the database at deploy time looks: never marked, so its
  // first roster read is the one-time backfill.
  await runtime.store.saveRepository({
    id: "legacy-repo",
    path: "/canonical/legacy-repo.git",
    branch: "main",
  });
  await runtime.store.linkRepository(DEFAULT_PROJECT_ID, "legacy-repo");
  const legacyBase = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/legacy-repo/channel`;
  const grandfathered = await owner.request(`${legacyBase}/agents`);
  assert.equal(grandfathered.status, 200, JSON.stringify(grandfathered.data));
  assert.deepEqual(
    grandfathered.data.agents.map((agent: any) => agent.provider).sort(),
    ["anthropic"],
    "an agent already working in a repository must not vanish mid-session",
  );

  // A repository created now has nothing predating it. Its roster is empty
  // until somebody chooses, even though the same agent is connected.
  const repositoryId = await invitableRepository(owner, "membership-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const fresh = await owner.request(`${base}/agents`);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
  assert.deepEqual(
    fresh.data.agents,
    [],
    "a repository created just now has nothing to grandfather in",
  );

  // A second agent connects. It must not appear automatically either.
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  const stillEmpty = await owner.request(`${base}/agents`);
  assert.deepEqual(
    stillEmpty.data.agents,
    [],
    "a newly connected agent must not silently join a channel it was never added to",
  );

  // Explicitly adding works, and is idempotent.
  const added = await owner.request(`${base}/agents/openai/membership`, {
    method: "POST",
  });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.equal(added.data.member, true);
  const addedAgain = await owner.request(`${base}/agents/openai/membership`, {
    method: "POST",
  });
  assert.equal(addedAgain.status, 200);

  const afterAdd = await owner.request(`${base}/agents`);
  assert.deepEqual(
    afterAdd.data.agents.map((agent: any) => agent.provider).sort(),
    ["openai"],
    "adding one agent adds exactly it",
  );

  // Removing takes it back out, and it also stops being @mentionable —
  // `channelAgentConnections` backs both the roster route and mention
  // resolution with the same membership-filtered set.
  const removed = await owner.request(`${base}/agents/openai/membership`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.member, false);
  const afterRemove = await owner.request(`${base}/agents`);
  assert.deepEqual(afterRemove.data.agents, []);
});

/** Logs a store-created user into a fresh client, the way every test below needs. */
async function loginAs(
  origin: string,
  email: string,
  password = PASSWORD,
): Promise<TestClient> {
  const client = new TestClient(origin);
  const response = await client.request("/api/v1/auth/login", {
    method: "POST",
    body: { email, password },
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return client;
}

test("a repository's creator can delete it without manage_project, but a colleague who did not create it cannot", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const developer = await runtime.store.createUser({
    email: "creator-dev@example.com",
    displayName: "Creator Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: developer.id,
    role: "developer",
  });
  const devClient = await loginAs(runtime.origin, developer.email);
  await invitableRepository(devClient, "dev-created-repo");
  assert.equal(
    (await runtime.store.getRepository("dev-created-repo"))?.createdBy,
    developer.id,
  );

  // A colleague who is also only a developer — not the creator, and no
  // manage_project — cannot delete it.
  const colleague = await runtime.store.createUser({
    email: "colleague-dev@example.com",
    displayName: "Colleague Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: colleague.id,
    role: "developer",
  });
  const colleagueClient = await loginAs(runtime.origin, colleague.email);
  const colleagueAttempt = await colleagueClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/dev-created-repo`,
    { method: "DELETE" },
  );
  assert.equal(colleagueAttempt.status, 403);
  assert.notEqual(
    await runtime.store.getRepository("dev-created-repo"),
    undefined,
  );

  // A total stranger — no membership, no grant — gets the same refusal.
  const stranger = new TestClient(runtime.origin);
  await stranger.request("/api/v1/auth/register", {
    method: "POST",
    body: {
      email: "stranger-delete@example.com",
      displayName: "Stranger",
      password: PASSWORD,
    },
  });
  const strangerAttempt = await stranger.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/dev-created-repo`,
    { method: "DELETE" },
  );
  assert.equal(strangerAttempt.status, 403);

  // The developer who created it can delete it, despite lacking
  // manage_project — the creator's own additional path in.
  const deleted = await devClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/dev-created-repo`,
    { method: "DELETE" },
  );
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal(deleted.data.removed, true);
  assert.equal(
    await runtime.store.getRepository("dev-created-repo"),
    undefined,
  );
  const events = await runtime.store.listAuditEvents({
    types: ["repository_deleted"],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event.data["repositoryId"], "dev-created-repo");
});

test("an organization admin can delete a repository they did not create", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  await invitableRepository(owner, "owner-created-repo");

  const admin = await runtime.store.createUser({
    email: "admin-not-creator@example.com",
    displayName: "Admin",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: admin.id,
    role: "admin",
  });
  const adminClient = await loginAs(runtime.origin, admin.email);

  const deleted = await adminClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/owner-created-repo`,
    { method: "DELETE" },
  );
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal(
    await runtime.store.getRepository("owner-created-repo"),
    undefined,
  );
});

test("an active repository name is unique and becomes reusable after deletion", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositories = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`;

  const created = await owner.request(repositories, {
    method: "POST",
    body: { id: "reusable-repo" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  const duplicate = await owner.request(repositories, {
    method: "POST",
    body: { id: "reusable-repo" },
  });
  assert.equal(duplicate.status, 422, JSON.stringify(duplicate.data));
  assert.equal(duplicate.data.error.code, "repository_creation_failed");

  const removed = await owner.request(`${repositories}/reusable-repo`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));

  const recreated = await owner.request(repositories, {
    method: "POST",
    body: { id: "reusable-repo" },
  });
  assert.equal(recreated.status, 201, JSON.stringify(recreated.data));
});

test("deleting a missing repository still reports not found", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const missing = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/missing-repo`,
    { method: "DELETE" },
  );
  assert.equal(missing.status, 404, JSON.stringify(missing.data));
  assert.equal(missing.data.error.code, "not_found");
});

test("the auditor is told what the work was asked to do", async (t) => {
  // A diff can only be judged against itself, which leaves the most valuable
  // defect invisible: code that is perfectly reasonable and does something
  // other than what was requested. The investigator has always been given the
  // objective; the auditor, whose whole job is judging whether work is right,
  // never was.
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "intent");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents/${ownerId}:openai`,
    { method: "POST", body: { role: "auditor" } },
  );

  const submitted = await runtime.store.submitTask({
    repositoryId: repo,
    objective: "Log the raw API key so failed shares can be debugged",
    agentId: "test-agent",
    validationCommands: [],
    submittedBy: ownerId,
  });
  // The reply is beside the point here; what is under test is the prompt.
  runtime.chatAnswer.text = "NO FINDINGS";
  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: submitted.id,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });

  await waitFor(
    async () => runtime.chatPrompts.length > 0,
    "the auditor never ran",
  );
  assert.match(
    runtime.chatPrompts[0]?.prompt ?? "",
    /Log the raw API key so failed shares can be debugged/u,
  );
});

test("an image posted to a channel comes back as an image, and nothing else does", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "with-pictures");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/attachments`;

  const stored = await owner.request(base, {
    method: "POST",
    raw: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    rawType: "image/png",
  });
  assert.equal(stored.status, 200, JSON.stringify(stored.data));
  const id = (stored.data as { id?: string }).id ?? "";
  assert.match(id, /\.png$/u);

  const fetched = await owner.request(`${base}/${id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get("content-type"), "image/png");
  // The type is derived from an allowlist rather than from whoever uploaded
  // the bytes, and this header is what stops a browser overriding it and
  // treating them as something it will execute.
  assert.equal(fetched.headers.get("x-content-type-options"), "nosniff");

  // SVG is a document that can carry script, so serving one from this origin
  // would be self-inflicted cross-site scripting. Refused, not stored.
  const refused = await owner.request(base, {
    method: "POST",
    raw: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>", "utf8"),
    rawType: "image/svg+xml",
  });
  assert.notEqual(refused.status, 200);

  const missing = await owner.request(`${base}/${"b".repeat(32)}.png`);
  assert.equal(missing.status, 404);
});

test("reverting a task rolls back to the state before that task landed", async (t) => {
  // The channel knows which task a message belongs to and nothing about
  // revisions, so "revert this" travels as a task id and the server is what
  // turns it into the revision that task moved canonical away from.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "revertible");

  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-planted",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });
  runtime.canonicalState.head = "b".repeat(40);

  const reverted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/rollback`,
    { method: "POST", body: { taskId: "task-planted" } },
  );
  assert.equal(reverted.status, 200, JSON.stringify(reverted.data));
  // The revision before that task, not the one it produced.
  assert.deepEqual(runtime.rollbacks, [
    { repositoryId: repo, targetRevision: "a".repeat(40) },
  ]);
});

test("reverting a task is refused once canonical has moved past it", async (t) => {
  // Undoing this task would take the work that landed after it with it. The
  // button says "revert this task", so doing more than that is refused rather
  // than done quietly — and refused with a reason, since a rollback that will
  // not happen is a considered answer, not a transport failure.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "moved-on");

  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-early",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });
  // Somebody else landed something afterwards.
  runtime.canonicalState.head = "c".repeat(40);

  const refused = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/rollback`,
    { method: "POST", body: { taskId: "task-early" } },
  );
  assert.equal(refused.status, 200, JSON.stringify(refused.data));
  assert.equal(
    (refused.data as { rollback?: { status?: string } }).rollback?.status,
    "blocked",
  );
  assert.deepEqual(runtime.rollbacks, []);
});

test("deleting a repository takes its queued work with it", async (t) => {
  // This asserted the opposite until the cascade landed: that a task
  // referencing the repository refused the deletion. In production that
  // refusal arrived as a raw foreign-key error with nothing offering to clear
  // the history behind it, so a repository that had ever done work could not
  // be removed at all. The store-contract tests carry the same reversal and
  // the reasoning for it.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  await invitableRepository(owner, "cascading-repo");

  await runtime.store.submitTask({
    repositoryId: "cascading-repo",
    objective: "Do something",
    agentId: "test-agent",
    validationCommands: [],
    submittedBy: bootstrapped.user.id,
  });

  const removed = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/cascading-repo`,
    { method: "DELETE" },
  );
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(await runtime.store.getRepository("cascading-repo"), undefined);
  // The queue went with it rather than being left pointing at a repository
  // that no longer exists.
  assert.deepEqual(
    await runtime.store.listSubmittedTasks({
      repositoryId: "cascading-repo",
    }),
    [],
  );
});

test("deleting a repository with no task or run referencing it cascades its channel", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  await invitableRepository(owner, "cascade-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/cascade-repo/channel`;

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "A message that had better not survive deletion." },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  const deleted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/cascade-repo`,
    { method: "DELETE" },
  );
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal(await runtime.store.getRepository("cascade-repo"), undefined);
  assert.deepEqual(
    await runtime.store.listChannelMessages("cascade-repo", bootstrapped.user.id),
    [],
  );
});

test("promoting an existing member to repository owner actually grants the capability, through the real authorization pipeline", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  await invitableRepository(owner, "promote-repo");

  const member = await runtime.store.createUser({
    email: "viewer-to-promote@example.com",
    displayName: "Viewer",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: member.id,
    role: "viewer",
  });
  const memberClient = await loginAs(runtime.origin, member.email);

  // Before promotion: a plain viewer cannot delete (proxy for manage_project).
  const before = await memberClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/promote-repo`,
    { method: "DELETE" },
  );
  assert.equal(before.status, 403);

  // A non-member/non-admin cannot promote anybody either.
  const unauthorizedPromote = await memberClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/promote-repo/grants/${member.id}`,
    { method: "POST", body: { role: "owner" } },
  );
  assert.equal(unauthorizedPromote.status, 403);

  // The owner promotes the viewer to repository-scoped owner.
  const promoted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/promote-repo/grants/${member.id}`,
    { method: "POST", body: { role: "owner" } },
  );
  assert.equal(promoted.status, 200, JSON.stringify(promoted.data));
  assert.equal(promoted.data.grant.role, "owner");

  const grants = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/promote-repo/grants`,
  );
  assert.equal(grants.status, 200);
  assert.equal(grants.data.grants.length, 1);
  assert.equal(grants.data.grants[0].userId, member.id);
  assert.equal(grants.data.grants[0].user.displayName, "Viewer");

  // After promotion: the same viewer — organization role unchanged — can now
  // do something that requires manage_project on this one repository. This
  // proves the grant actually composes with organization role through
  // `authorizeRepository`, not just that the grant row exists.
  const after = await memberClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/promote-repo`,
    { method: "DELETE" },
  );
  assert.equal(after.status, 200, JSON.stringify(after.data));
  assert.equal(
    await runtime.store.getRepository("promote-repo"),
    undefined,
  );
});

test("revoking a repository grant does not orphan the repository — organization role still reaches it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  await invitableRepository(owner, "revoke-repo");

  const member = await runtime.store.createUser({
    email: "revoke-target@example.com",
    displayName: "Target",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: member.id,
    role: "viewer",
  });

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/revoke-repo/grants/${member.id}`,
    { method: "POST", body: { role: "owner" } },
  );
  assert.equal((await runtime.store.listRepositoryGrants("revoke-repo")).length, 1);

  const revoked = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/revoke-repo/grants/${member.id}`,
    { method: "DELETE" },
  );
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  assert.equal((await runtime.store.listRepositoryGrants("revoke-repo")).length, 0);

  // The promoted member lost the elevation the grant gave them...
  const memberClient = await loginAs(runtime.origin, member.email);
  const memberAttempt = await memberClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/revoke-repo`,
    { method: "DELETE" },
  );
  assert.equal(memberAttempt.status, 403);

  // ...but the repository is not stranded: the organization owner's
  // blanket, role-based access was never routed through the grant, so it
  // still reaches the repository — no "last owner" guard is needed here the
  // way organization membership needs one.
  const ownerStillWorks = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/revoke-repo`,
    { method: "DELETE" },
  );
  assert.equal(ownerStillWorks.status, 200, JSON.stringify(ownerStillWorks.data));
});

test("a human can leave a repository held only through a grant, but not one reached through an organization role", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  await invitableRepository(owner, "leave-repo");

  const guest = await runtime.store.createUser({
    email: "leave-guest@example.com",
    displayName: "Guest",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveRepositoryGrant({
    repositoryId: "leave-repo",
    userId: guest.id,
    role: "developer",
    grantedBy: bootstrapped.user.id,
    createdAt: new Date().toISOString(),
  });
  const guestClient = await loginAs(runtime.origin, guest.email);

  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/leave-repo/channel`;
  assert.equal((await guestClient.request(`${base}/messages`)).status, 200);

  const left = await guestClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/leave-repo/grants/${guest.id}`,
    { method: "DELETE" },
  );
  assert.equal(left.status, 200, JSON.stringify(left.data));
  assert.equal(
    await guestClient.request(`${base}/messages`).then((r) => r.status),
    403,
  );

  // A colleague reached through an ordinary organization role — not a
  // grant — gets a legible refusal instead of a silent no-op or a 404 that
  // reads as "you were never here".
  const colleague = await runtime.store.createUser({
    email: "leave-colleague@example.com",
    displayName: "Colleague",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: colleague.id,
    role: "developer",
  });
  const colleagueClient = await loginAs(runtime.origin, colleague.email);
  const colleagueLeave = await colleagueClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/leave-repo/grants/${colleague.id}`,
    { method: "DELETE" },
  );
  assert.equal(colleagueLeave.status, 409);
  assert.equal(
    colleagueLeave.data.error.code,
    "org_membership_reaches_repository",
  );
});

test("loosening agent-membership removal to manage_project+ does not let an unrelated viewer remove someone's agent, and self-removal keeps working for everyone", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  await invitableRepository(owner, "moderation-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/moderation-repo/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [{ provider: "anthropic" }]);
  // Consumes the one-time grandfather backfill (see `channelAgentConnections`
  // in server.ts) so the explicit add/remove below is testing opt-in
  // membership, not whatever the first-ever read happened to grandfather in.
  await owner.request(`${base}/agents`);
  const added = await owner.request(`${base}/agents/anthropic/membership`, {
    method: "POST",
  });
  assert.equal(added.status, 200, JSON.stringify(added.data));

  // A developer with no elevated permission cannot remove the owner's agent.
  const developer = await runtime.store.createUser({
    email: "mod-dev@example.com",
    displayName: "Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: developer.id,
    role: "developer",
  });
  const devClient = await loginAs(runtime.origin, developer.email);
  const devAttempt = await devClient.request(
    `${base}/agents/anthropic/membership?userId=${bootstrapped.user.id}`,
    { method: "DELETE" },
  );
  assert.equal(devAttempt.status, 403);

  // An admin (manage_project) can remove somebody else's agent.
  const admin = await runtime.store.createUser({
    email: "mod-admin@example.com",
    displayName: "Admin",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: admin.id,
    role: "admin",
  });
  const adminClient = await loginAs(runtime.origin, admin.email);
  const adminRemoval = await adminClient.request(
    `${base}/agents/anthropic/membership?userId=${bootstrapped.user.id}`,
    { method: "DELETE" },
  );
  assert.equal(adminRemoval.status, 200, JSON.stringify(adminRemoval.data));
  const rosterAfterModeration = await owner.request(`${base}/agents`);
  assert.deepEqual(rosterAfterModeration.data.agents, []);

  // Self-service removal still needs only submit_task — the plain developer
  // above, with no manage_project, can remove their own membership.
  runtime.chatConnections.set(developer.id, [{ provider: "openai" }]);
  const devAdded = await devClient.request(`${base}/agents/openai/membership`, {
    method: "POST",
  });
  assert.equal(devAdded.status, 200, JSON.stringify(devAdded.data));
  const devSelfRemoval = await devClient.request(
    `${base}/agents/openai/membership`,
    { method: "DELETE" },
  );
  assert.equal(devSelfRemoval.status, 200, JSON.stringify(devSelfRemoval.data));
});

test("creating a repository ignores a mode field rather than importing", async (t) => {
  // The bug this pins. The dashboard used to post `{mode: "github", …}` to
  // the plain creation route, which reads no `mode` at all: the request
  // succeeded, answered 201 with a repository, and produced an *empty* one —
  // a single "Initial commit" and none of the remote's history. It looked
  // exactly like a working import until somebody opened the files.
  //
  // Creation keeping its behaviour is correct; what was wrong was the caller.
  // So this asserts the shape that misled, so the next person to add a `mode`
  // sees that nothing consumes it.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const created = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
    {
      method: "POST",
      body: {
        id: "looks-imported",
        mode: "github",
        repository: "octocat/Hello-World",
      },
    },
  );
  assert.equal(created.status, 201);
  // No remote was recorded, because none was read: this is a local creation.
  assert.equal(created.data.repository.provider, undefined);
  assert.equal(created.data.repository.remoteUrl, undefined);
});

test("auditor is a reserved role: owner-only, and one to a repository", async (t) => {
  // Every other role is free text the agent only ever reads as a sentence.
  // This one changes what the system does — the holder audits unprompted,
  // spending tokens nobody asked for — so granting it needs more than the
  // permission to type in a text box, and two holders in one repository would
  // mean two of them doing that.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "audited");
  const channel = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`;

  // An ordinary role is unrestricted, as before.
  const ordinary = await owner.request(`${channel}/anthropic`, {
    method: "POST",
    body: { role: "Backend Engineer" },
  });
  assert.equal(ordinary.status, 200, JSON.stringify(ordinary.data));

  // The owner may promote one agent to auditor.
  const promoted = await owner.request(`${channel}/anthropic`, {
    method: "POST",
    body: { role: "auditor" },
  });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.data));

  // A second agent cannot also hold it.
  const second = await owner.request(`${channel}/openai`, {
    method: "POST",
    body: { role: "auditor" },
  });
  assert.equal(second.status, 409, JSON.stringify(second.data));
  assert.equal(second.data.error.code, "auditor_exists");

  // Re-asserting it on the agent that already holds it is not a conflict:
  // saving the same row again must not become an error.
  const again = await owner.request(`${channel}/anthropic`, {
    method: "POST",
    body: { role: "auditor" },
  });
  assert.equal(again.status, 200, JSON.stringify(again.data));

  // And the reservation cannot be walked around with a capital letter.
  const shouted = await owner.request(`${channel}/openai`, {
    method: "POST",
    body: { role: "  Auditor " },
  });
  assert.equal(shouted.status, 409, JSON.stringify(shouted.data));
});

test("a bootstrap token survives the whitespace pasting adds to it", async (t) => {
  // The token is copied out of a hosting provider's variable editor and
  // pasted into a form. Both boxes attract a trailing newline, neither shows
  // it, and the comparison used to fail on it — while the startup length
  // check trimmed first, so a server configured with a trailing newline
  // started happily and then rejected the very token it was configured with.
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  const response = await client.request("/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "X-Bootstrap-Token": `  ${BOOTSTRAP_TOKEN}\t ` },
    body: {
      email: "owner@example.com",
      displayName: "Owner",
      password: PASSWORD,
      organizationName: "Relay Test",
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));

  // Still not a way in for a token that is merely close.
  const wrong = new TestClient(runtime.origin);
  const refused = await wrong.request("/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "X-Bootstrap-Token": `${BOOTSTRAP_TOKEN}x` },
    body: {
      email: "other@example.com",
      displayName: "Other",
      password: PASSWORD,
      organizationName: "Nope",
    },
  });
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
  assert.equal(refused.data.error.code, "invalid_bootstrap_token");
});

test("a gateway configured with a padded token still starts and accepts it", async (t) => {
  // The other half: the padding is on the *server's* value, which is what a
  // pasted `COORD_BOOTSTRAP_TOKEN` actually looks like.
  const store = new InMemoryCoordinationStore();
  const gateway = new ApiGateway({
    store,
    operations: { async createRepository() { throw new Error("unused"); } } as unknown as ApiOperations,
    bootstrapToken: `${BOOTSTRAP_TOKEN}\n`,
  });
  t.after(async () => {
    await gateway.close();
    await store.close();
  });
  await new Promise<void>((resolve, reject) => {
    gateway.server.once("error", reject);
    gateway.server.listen(0, "127.0.0.1", resolve);
  });
  const address = gateway.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test gateway did not bind a TCP port");
  }
  const client = new TestClient(`http://127.0.0.1:${address.port}`);
  const response = await client.request("/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "X-Bootstrap-Token": BOOTSTRAP_TOKEN },
    body: {
      email: "owner@example.com",
      displayName: "Owner",
      password: PASSWORD,
      organizationName: "Relay Test",
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
});

/** A gateway with whatever bootstrap configuration a test wants. */
async function startBareGateway(
  t: TestContext,
  options: { bootstrapToken?: string },
): Promise<{ client: TestClient; store: CoordinationStore }> {
  const store = new InMemoryCoordinationStore();
  const gateway = new ApiGateway({
    store,
    operations: {} as unknown as ApiOperations,
    ...(options.bootstrapToken === undefined
      ? {}
      : { bootstrapToken: options.bootstrapToken }),
  });
  t.after(async () => {
    await gateway.close();
    await store.close();
  });
  await new Promise<void>((resolve, reject) => {
    gateway.server.once("error", reject);
    gateway.server.listen(0, "127.0.0.1", resolve);
  });
  const address = gateway.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test gateway did not bind a TCP port");
  }
  return { client: new TestClient(`http://127.0.0.1:${address.port}`), store };
}

test("with no token configured, first-run setup is open", async (t) => {
  const { client } = await startBareGateway(t, {});

  // The form is told not to ask for one, rather than asking for a value that
  // cannot be supplied.
  const health = await client.request("/api/v1/health");
  assert.equal(health.data.setupRequired, true);
  assert.equal(health.data.bootstrapTokenRequired, false);

  const created = await client.request("/api/v1/auth/bootstrap", {
    method: "POST",
    body: {
      email: "owner@example.com",
      displayName: "Owner",
      password: PASSWORD,
      organizationName: "Relay Test",
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  // And the door locks behind the first person through it: open setup is a
  // window that closes, not a permanently unauthenticated route.
  const second = await new TestClient(client.origin).request(
    "/api/v1/auth/bootstrap",
    {
      method: "POST",
      body: {
        email: "intruder@example.com",
        displayName: "Intruder",
        password: PASSWORD,
        organizationName: "Theirs",
      },
    },
  );
  assert.equal(second.status === 201, false, "setup must not run twice");
  const afterwards = await client.request("/api/v1/health");
  assert.equal(afterwards.data.setupRequired, false);
});

test("an empty token is the same as none, not a token nobody can send", async (t) => {
  // `COORD_BOOTSTRAP_TOKEN=` in a hosting provider's variable editor is the
  // ordinary way to clear one, and it arrives as an empty string.
  const { client } = await startBareGateway(t, { bootstrapToken: "   " });
  const health = await client.request("/api/v1/health");
  assert.equal(health.data.bootstrapTokenRequired, false);
  const created = await client.request("/api/v1/auth/bootstrap", {
    method: "POST",
    body: {
      email: "owner@example.com",
      displayName: "Owner",
      password: PASSWORD,
      organizationName: "Relay Test",
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
});

test("a configured token is still required, and still says so", async (t) => {
  const { client } = await startBareGateway(t, {
    bootstrapToken: BOOTSTRAP_TOKEN,
  });
  const health = await client.request("/api/v1/health");
  assert.equal(health.data.bootstrapTokenRequired, true);

  const withoutToken = await client.request("/api/v1/auth/bootstrap", {
    method: "POST",
    body: {
      email: "owner@example.com",
      displayName: "Owner",
      password: PASSWORD,
      organizationName: "Relay Test",
    },
  });
  assert.equal(withoutToken.status, 403, JSON.stringify(withoutToken.data));
  assert.equal(withoutToken.data.error.code, "invalid_bootstrap_token");
});

test("a token short enough to guess is refused at startup", async (t) => {
  // Only when one is set. A short token reads as protection and is not.
  const store = new InMemoryCoordinationStore();
  t.after(async () => {
    await store.close();
  });
  assert.throws(
    () =>
      new ApiGateway({
        store,
        operations: {} as unknown as ApiOperations,
        bootstrapToken: "too-short",
      }),
    /at least 24 characters/u,
  );
});

test("an agent is told its own name, so a mention of it is not a product", async (t) => {
  // Asked "@Apollo can you audit the codebase", Codex — which *is* Apollo —
  // replied that "the Apollo integration isn't installed" and that it had
  // requested installation. With no other context, a call sign is a product.
  const identity = agentIdentity({
    name: "Apollo",
    role: "auditor",
    userName: "Nathan",
  });
  assert.match(identity, /You are "Apollo"/u);
  assert.match(identity, /@Apollo" is addressed to you/u);
  assert.match(identity, /not a reference to some product or integration/u);
  assert.match(identity, /You belong to Nathan/u);
  assert.match(identity, /Your role in this channel is: auditor/u);

  // An unlabelled agent still gets a name, just no role sentence.
  const bare = agentIdentity({ name: "Icarus", role: "  ", userName: "Sam" });
  assert.match(bare, /You are "Icarus"/u);
  assert.doesNotMatch(bare, /Your role in this channel/u);
});

test("a direct message reaches its recipient and nobody else", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const organizationId = (await owner.request("/api/v1/organizations")).data
    .organizations[0].id as string;

  // Two more people in the same organization: one to write to, one who must
  // not be able to read what was written.
  const people: Record<string, string> = {};
  for (const name of ["bystander", "friend"]) {
    const user = await runtime.store.createUser({
      email: `${name}@example.com`,
      displayName: name,
      passwordDigest: await hashPassword(PASSWORD),
    });
    await runtime.store.saveMembership({
      organizationId,
      userId: user.id,
      role: "developer",
    });
    people[name] = user.id;
  }
  const sign = async (name: string): Promise<TestClient> => {
    const client = new TestClient(runtime.origin);
    const login = await client.request("/api/v1/auth/login", {
      method: "POST",
      body: { email: `${name}@example.com`, password: PASSWORD },
    });
    assert.equal(login.status, 200);
    return client;
  };
  const friend = await sign("friend");
  const bystander = await sign("bystander");
  const friendId = people["friend"] ?? "";
  const bystanderId = people["bystander"] ?? "";

  const sent = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${friendId}`,
    { method: "POST", body: { content: "  Just between us.  " } },
  );
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal(sent.data.message.content, "Just between us.");

  // The conversation reads the same from either side.
  for (const [client, other] of [
    [owner, friendId],
    [friend, session.user.id],
  ] as const) {
    const thread = await client.request(
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${other}`,
    );
    assert.equal(thread.status, 200);
    assert.deepEqual(
      thread.data.messages.map((message: { content: string }) => message.content),
      ["Just between us."],
    );
  }

  // The bystander is in the same organization and can reach the route, but
  // asking for either participant returns their own (empty) conversation
  // rather than anyone else's.
  for (const other of [friendId, session.user.id]) {
    const peek = await bystander.request(
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${other}`,
    );
    assert.equal(peek.status, 200);
    assert.deepEqual(peek.data.messages, []);
  }

  // Unread is counted for the recipient only, and clears when they read it.
  const inbox = await friend.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages`,
  );
  assert.equal(inbox.status, 200);
  assert.equal(inbox.data.conversations[0].unread, 1);
  assert.equal(
    (await owner.request(`/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages`))
      .data.conversations[0].unread,
    0,
  );
  // The roster names everyone else, and never the person asking.
  assert.deepEqual(
    (inbox.data.people as { id: string }[]).map((person) => person.id).sort(),
    [session.user.id, bystanderId].sort(),
  );

  const read = await friend.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${session.user.id}/read`,
    { method: "POST" },
  );
  assert.equal(read.data.marked, 1);
  assert.equal(
    (await friend.request(`/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages`))
      .data.conversations[0].unread,
    0,
  );

  // Writing to yourself, to a stranger, or saying nothing are all refused.
  assert.equal(
    (
      await owner.request(
        `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${session.user.id}`,
        { method: "POST", body: { content: "hello me" } },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await owner.request(
        `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/user_nobody`,
        { method: "POST", body: { content: "hello?" } },
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await owner.request(
        `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${friendId}`,
        { method: "POST", body: { content: "   " } },
      )
    ).status,
    400,
  );
});

test("asking an agent to audit dispatches work instead of discussing it", async (t) => {
  // `audit` was not among the task verbs, so "can you audit the codebase" was
  // classified as a question and answered by a model with no repository in
  // front of it — which produced a chat about auditing rather than an audit.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "examined");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";

  const roster = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`,
  );
  const agent = roster.data.agents[0];
  const mention = `Codex (${String(session.user.displayName).split(" ")[0]})`;
  assert.notEqual(agent, undefined);

  const posted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: `@${mention} can you audit the codebase` } },
  );
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "asking for an audit never became work",
  );
  assert.match(runtime.submittedTasks[0]?.objective ?? "", /audit/iu);
});

test("a question in the channel carries the agent's own work with it", async (t) => {
  // "@Apollo what are you working on" was answered with the question echoed
  // back, because the prompt held the question and nothing else. The store
  // knew the answer the whole time.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "asked");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "Still on the retry loop.";
  const mention = `Codex (${String(session.user.displayName).split(" ")[0]})`;

  // Give the agent a task to be working on.
  await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "Fix the retry loop in worker.ts",
    agentId: "test-agent",
    validationCommands: [],
    submittedBy: ownerId,
  });

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: `@${mention} what are you working on?` } },
  );

  await waitFor(
    async () => runtime.chatPrompts.length > 0,
    "the question never reached the agent",
  );
  const prompt = runtime.chatPrompts.at(-1)?.prompt ?? "";
  // Who it is, and what it is doing — the two things the bare prompt lacked.
  assert.match(prompt, new RegExp(`You are "${mention.replace(/[()]/gu, "\\$&")}"`, "u"));
  assert.match(prompt, /Fix the retry loop in worker\.ts/u);
  assert.match(prompt, /Your tasks in this repository/u);
  // And it is told not to invent, since it cannot read the repository here.
  assert.match(prompt, /never claim to have started or requested anything/u);
});

test("a run that cannot start says so, instead of an hour of silence", async (t) => {
  // The channel said "On it." and then nothing. The run rejected before it
  // wrote a single audit event, so the progress watcher had nothing to follow
  // and held its opening line until the one-hour watchdog gave up — and the
  // reason, which the failing call had in hand, went to stderr where nobody
  // reading the channel can see it.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "cannotstart");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";
  runtime.runFailure.reason =
    "Repository id cannotstart is already mapped to a different canonical repository";
  const mention = `Codex (${String(session.user.displayName).split(" ")[0]})`;

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: `@${mention} please fix the retry loop` } },
  );

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) =>
      message.replies.some((reply) =>
        reply.content.includes("I could not start this"),
      ),
    );
  }, "the channel never said why the run did not start");

  const messages = await runtime.store.listChannelMessages(repo, ownerId);
  const said = messages
    .flatMap((message) => message.replies)
    .map((reply) => reply.content)
    .join("\n");
  // The actual reason, not a generic apology — it is the only thing that
  // tells the reader what to do next.
  assert.match(said, /already mapped to a different canonical repository/u);
});

test("a planning failure names the cause, not just the wrapper", async (t) => {
  // What a wave failing during planning actually rejects with. Its own message
  // says only that something failed; which task and why are in `errors`, and
  // reading `.message` dropped them — so the channel reported the shape of the
  // failure and never its cause, and the one place the answer existed was a
  // log nobody reading the thread can open.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "aggregatecause");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";
  runtime.runFailure.error = new AggregateError(
    [new Error("codex exited before writing a plan")],
    "One or more tasks failed during planning",
  );
  const mention = `Codex (${String(session.user.displayName).split(" ")[0]})`;

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: `@${mention} build the render half` } },
  );

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) =>
      message.replies.some((reply) =>
        reply.content.includes("I could not start this"),
      ),
    );
  }, "the channel never said the run did not start");

  const messages = await runtime.store.listChannelMessages(repo, ownerId);
  const said = messages
    .flatMap((message) => message.replies)
    .map((reply) => reply.content)
    .join("\n");
  // Both halves: the wrapper still orients the reader, and the cause is what
  // they can actually act on.
  assert.match(said, /One or more tasks failed during planning/u);
  assert.match(said, /codex exited before writing a plan/u);
});

test("a finished thread carries its summary and its line counts", async (t) => {
  // Two failures with one cause between them, both about a thread that has
  // finished. The ending is the agent's own account of the work now, and
  // nothing a model writes begins "Done —" — so the browser, which decided
  // what an ending was by matching that text, filed the summary inside the
  // collapsed thinking block and left the typing dots running. And the counts
  // that go beside the file list were emitted by one executor and not the
  // other, so whether a thread showed "+12 −3" or bare paths came down to
  // which code path had run the task.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "threadending");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel`;
  const mention = `Claude (${String(session.user.displayName).split(" ")[0]})`;

  assert.equal(
    (
      await owner.request(`${base}/messages`, {
        method: "POST",
        body: { content: `@${mention} raise the retry ceiling in worker.ts` },
      })
    ).status,
    201,
  );
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mention never dispatched a task",
  );
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId: repo });
  assert.ok(task !== undefined, "the dispatch stored no task");

  // The run as the log records it, in order: an edit in flight, the collected
  // changeset, and the promotion that ends it. Written in one go so a single
  // poll of the watcher consumes all three.
  await runtime.store.appendAudit(undefined, {
    type: "workspace_changed",
    taskId: task.id,
    data: {
      files: [
        { path: "worker.ts", status: "modified" },
        { path: "worker.test.ts", status: "modified" },
      ],
    },
  });
  await runtime.store.appendAudit(undefined, {
    type: "changeset_collected",
    taskId: task.id,
    data: {
      changeSetId: "cs_1",
      // Two files on purpose: a single-file run with a one-line account now
      // ends as a channel `outcome` line rather than a thread — a room is for
      // work with a story. This test is about the thread-shaped ending, so
      // its run does thread-shaped work.
      files: ["worker.ts", "worker.test.ts"],
      changedFiles: [
        { path: "worker.ts", status: "modified", added: 12, removed: 3 },
        { path: "worker.test.ts", status: "modified", added: 6, removed: 1 },
      ],
    },
  });
  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: task.id,
    data: {
      files: ["worker.ts"],
      agentExplanation: "Raised the retry ceiling to five.",
    },
  });

  await waitFor(
    async () => {
      const messages = await runtime.store.listChannelMessages(repo, ownerId);
      return messages.some((message) =>
        message.replies.some((reply) => reply.kind === "outcome"),
      );
    },
    "the run's ending was never marked as one",
    8_000,
  );

  const listed = await owner.request(`${base}/messages`);
  const thread = listed.data.messages.find(
    (message: any) => (message.replies ?? []).length > 0,
  );
  const ending = (thread?.replies ?? []).find(
    (reply: any) => reply.kind === "outcome",
  );
  // The agent's own words, not the sentence that was true of every task this
  // system has ever finished — and marked, so the browser does not have to
  // recognise those words to know the thread is done.
  assert.match(String(ending?.content), /Raised the retry ceiling to five\./u);
  assert.doesNotMatch(String(ending?.content), /the change is in canonical/u);
  // Everything before it is the run narrating itself, and stays marked as
  // such: if the ending were `progress` too the thread would have no visible
  // conclusion at all.
  const kinds = (thread?.replies ?? []).map((reply: any) => reply.kind);
  assert.equal(kinds.filter((kind: string) => kind === "outcome").length, 1);
  assert.ok(
    kinds.includes("progress"),
    `the narration lost its progress mark: ${JSON.stringify(kinds)}`,
  );

  // And the file summary survives the round trip with its counts. The final
  // `changeset_collected` is what carries them; the live workspace poll before
  // it cannot count lines, and must not be what the thread is left showing.
  assert.deepEqual(thread?.changedFiles, [
    { path: "worker.ts", status: "modified", added: 12, removed: 3 },
    { path: "worker.test.ts", status: "modified", added: 6, removed: 1 },
  ]);
});

test("a quick task ends as two lines in the room, with no thread at all", async (t) => {
  // The counterpart of the test above, and the one that was missing while the
  // feature it covers sat inert. Holding the ceremony is only half of it: the
  // held set has to name *every* line that is true of all runs, and
  // `plan_received` — the first thing narrated after the opening, traced by
  // every planned turn — was not in it. So the first poll flushed the held
  // opening into a thread and marked the run threaded before any ending
  // existed, and "change this 1 to a 2" got the room, the title and the
  // running commentary the whole mechanism was written to prevent.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "quicktask");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel`;
  const mention = `Claude (${String(session.user.displayName).split(" ")[0]})`;

  assert.equal(
    (
      await owner.request(`${base}/messages`, {
        method: "POST",
        body: { content: `@${mention} change the retry count to 2` },
      })
    ).status,
    201,
  );
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mention never dispatched a task",
  );
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId: repo });
  assert.ok(task !== undefined, "the dispatch stored no task");

  // The whole life of an ordinary one-file run, in the order the coordinator
  // traces it. Every one of these is true of every run that has ever
  // succeeded, so not one of them is a reason to open a room.
  for (const event of [
    { type: "plan_received" as const, data: { expectedFiles: ["retry.ts"] } },
    { type: "plan_admitted" as const, data: { status: "approved" } },
    { type: "task_started" as const, data: {} },
    {
      type: "changeset_collected" as const,
      data: {
        changeSetId: "cs_quick",
        files: ["retry.ts"],
        changedFiles: [
          { path: "retry.ts", status: "modified", added: 1, removed: 1 },
        ],
      },
    },
    {
      type: "canonical_promoted" as const,
      data: { files: ["retry.ts"], agentExplanation: "Changed the retry count to 2." },
    },
  ]) {
    await runtime.store.appendAudit(undefined, {
      type: event.type,
      taskId: task.id,
      data: event.data,
    });
  }

  await waitFor(
    async () => {
      const messages = await runtime.store.listChannelMessages(repo, ownerId);
      return messages.some((message) => message.kind === "outcome");
    },
    "the run never produced an ending",
    8_000,
  );

  const messages = await runtime.store.listChannelMessages(repo, ownerId);
  // Two lines: the agent taking the work, and the agent reporting it done.
  const ending = messages.find((message) => message.kind === "outcome");
  assert.match(
    String(ending?.content),
    /Changed the retry count to 2\./u,
    `the ending did not carry the agent's own words: ${JSON.stringify(ending)}`,
  );
  // And not one reply anywhere in the room. This is the assertion that fails
  // the moment a run-generic event goes missing from the held set again.
  assert.deepEqual(
    messages.flatMap((message) =>
      (message.replies ?? []).map((reply) => reply.content),
    ),
    [],
    "a quick task was given a thread",
  );
});

/**
 * Puts one dispatched task in the room, which is what starts the fast pump.
 *
 * `narrateConflicts` rides on `pumpChannelProgress`, and that timer only
 * exists while some task is being watched — so a conflict test needs a real
 * mention dispatch before an appended `conflict_detected` can be narrated.
 */
async function roomWithTwoAgents(
  runtime: TestRuntime,
  client: TestClient,
  repo: string,
  ownerId: string,
  firstName: string,
): Promise<{ claude: string; codex: string }> {
  runtime.chatAnswer.text = "On it.";
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel`;
  const posted = await client.request(`${base}/messages`, {
    method: "POST",
    body: { content: `@Claude (${firstName}) tidy the retry helper` },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mention never dispatched a task",
  );
  const [claude] = await runtime.store.listSubmittedTasks({
    repositoryId: repo,
  });
  assert.ok(claude !== undefined, "the dispatch stored no task");
  // The other side of every collision below. Submitted directly because only
  // one watched task is needed to run the pump, and `agentId` is the fixture's
  // own vendor-resolved id — the shape `resolveAgentIdForVendor` produces.
  const codex = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "paste the 72 possible names an agent can get please",
    agentId: "test-agent-codex",
    validationCommands: [],
    submittedBy: ownerId,
  });
  return { claude: claude.id, codex: codex.id };
}

test("a file collision and its admission produce one authoritative ordering", async (t) => {
  // The bug this covers, in the words of the person who hit it: the room said
  // '⚖️ "paste the 72 possible names an agent …" is waiting — "when a prompt
  // gets added to a thread …" has the files it needs. It starts the moment
  // that lands.' Two truncated walls of somebody's own prompt and three
  // clauses of justification, to say that one agent goes after another.
  //
  // Two separate faults produced that. `narrateConflicts` never resolved a
  // name at all, and the resolver `announceArbitration` did use matched a
  // task's `agentId` against the *provider* id ("anthropic") when a real
  // agentId is named after the vendor ("test-agent-claude") — so it missed
  // every task and fell through to the objective it was written to replace.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "collisionroom");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const tasks = await roomWithTwoAgents(
    runtime,
    owner,
    repo,
    ownerId,
    firstName,
  );

  await runtime.store.appendAudit(undefined, {
    type: "conflict_detected",
    taskId: tasks.claude,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      taskIds: [tasks.claude, tasks.codex],
      disposition: "sequence",
      evidence: [
        {
          kind: "file_overlap",
          resources: ["services/api-gateway/src/server.ts"],
        },
      ],
      explanation: "file_overlap: services/api-gateway/src/server.ts (+20)",
    },
  });
  // The detector only identifies a conflicting pair. The admission is the
  // authoritative ordering: it says which task was actually held. These two
  // events used to produce opposite announcements for the same collision.
  await runtime.store.appendAudit(undefined, {
    type: "plan_admitted",
    taskId: tasks.claude,
    data: {
      status: "sequenced",
      blockedBy: [tasks.codex],
      explanation:
        "Sequenced behind executing work on the same resources: " +
        "services/api-gateway/src/server.ts",
    },
  });

  await waitFor(
    async () => {
      const messages = await runtime.store.listChannelMessages(repo, ownerId);
      return messages.some((message) => message.authorId === "coordinator");
    },
    "the collision was never announced in the room",
    8_000,
  );

  const messages = await runtime.store.listChannelMessages(repo, ownerId);
  const lines = messages
    .filter((message) => message.authorId === "coordinator")
    .map((message) => String(message.content));
  assert.deepEqual(
    lines,
    [
      `⚖️ @Claude (${firstName}) and @Codex (${firstName}) have conflicting ` +
        `files — @Claude (${firstName}) starts once @Codex (${firstName}) is done.`,
    ],
    `the collision did not produce one authoritative order: ${JSON.stringify(lines)}`,
  );
  const line = lines[0] ?? "";
  // The specific things that made it unreadable, each named so a rewrite that
  // reintroduces one fails here rather than in somebody's channel.
  assert.doesNotMatch(
    line,
    /paste the 72 possible names/u,
    "the line quoted a task's objective back at the room",
  );
  assert.doesNotMatch(
    line,
    /nobody is surprised|the moment that lands|one at a time|both touch/u,
    "the line kept a justification clause",
  );
});

test("a collision that can run together is one line, and one that cannot say so is silent", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "advisoryroom");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const tasks = await roomWithTwoAgents(
    runtime,
    owner,
    repo,
    ownerId,
    firstName,
  );

  // Advisory intent overlap admits both tasks untouched, so this one is never
  // spoken at all — saying "conflict" about work that is running anyway would
  // teach readers to ignore the times it matters.
  await runtime.store.appendAudit(undefined, {
    type: "conflict_detected",
    taskId: tasks.claude,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      taskIds: [tasks.claude, tasks.codex],
      disposition: "concurrent",
      evidence: [],
    },
  });
  await runtime.store.appendAudit(undefined, {
    type: "conflict_detected",
    taskId: tasks.claude,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      taskIds: [tasks.claude, tasks.codex],
      disposition: "concurrent_with_notification",
      evidence: [
        { kind: "file_overlap", resources: ["apps/web/public/app.js"] },
      ],
    },
  });

  await waitFor(
    async () => {
      const messages = await runtime.store.listChannelMessages(repo, ownerId);
      return messages.some((message) => message.authorId === "coordinator");
    },
    "the advisory collision was never announced",
    8_000,
  );

  const messages = await runtime.store.listChannelMessages(repo, ownerId);
  const lines = messages
    .filter((message) => message.authorId === "coordinator")
    .map((message) => String(message.content));
  // Exactly one: the `concurrent` event above is deliberately not narrated.
  assert.deepEqual(
    lines,
    [
      `⚖️ @Claude (${firstName}) and @Codex (${firstName}) have conflicting ` +
        `files but can run together.`,
    ],
    `the advisory collision did not read as one short line: ${JSON.stringify(lines)}`,
  );
});

test("a sequenced admission is removed silently when the held task can start", async (t) => {
  // The other half of the same complaint. This path already tried to resolve a
  // name and always failed, so every hold in the room was two truncated
  // prompts; and having resolved one it then spent two more clauses on why.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "holdroom");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const tasks = await roomWithTwoAgents(
    runtime,
    owner,
    repo,
    ownerId,
    firstName,
  );

  await runtime.store.appendAudit(undefined, {
    type: "plan_admitted",
    taskId: tasks.claude,
    data: {
      status: "sequenced",
      blockedBy: [tasks.codex],
      explanation:
        "Sequenced behind executing work on the same resources: " +
        "services/api-gateway/src/server.ts",
    },
  });

  await waitFor(
    async () => {
      const messages = await runtime.store.listChannelMessages(repo, ownerId);
      return messages.some((message) => message.authorId === "coordinator");
    },
    "the hold was never announced in the room",
    8_000,
  );

  const messages = await runtime.store.listChannelMessages(repo, ownerId);
  const line = String(
    messages.find((message) => message.authorId === "coordinator")?.content,
  );
  assert.equal(
    line,
    `⚖️ @Claude (${firstName}) and @Codex (${firstName}) have conflicting ` +
      `files — @Claude (${firstName}) starts once @Codex (${firstName}) is done.`,
    `the hold did not read as two names and an order: ${line}`,
  );
  assert.doesNotMatch(
    line,
    /paste the 72 possible names|has the files it needs|the moment that lands/u,
    "the hold kept the quoted objective or its justification clause",
  );

  await runtime.store.appendAudit(undefined, {
    type: "plan_admitted",
    taskId: tasks.claude,
    data: {
      status: "approved",
      explanation: "The blocking work landed",
    },
  });
  await waitFor(
    async () => {
      const current = await runtime.store.listChannelMessages(repo, ownerId);
      return current.every((message) => message.authorId !== "coordinator");
    },
    "the expired hold notice stayed in the room",
    8_000,
  );
  const afterRelease = await runtime.store.listChannelMessages(repo, ownerId);
  assert.equal(
    afterRelease.some((message) => /starts now/iu.test(message.content)),
    false,
    "releasing the hold added a redundant starts-now message",
  );
});

test("an agent with no connection this channel knows still falls back to its objective", async (t) => {
  // The fallback is the whole reason the resolver can be trusted: it names an
  // agent or it says nothing confident. A task submitted by somebody with no
  // matching connection has no name to use, and quoting a short objective
  // beats naming the wrong agent.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "namelessroom");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const tasks = await roomWithTwoAgents(
    runtime,
    owner,
    repo,
    ownerId,
    firstName,
  );

  await runtime.store.appendAudit(undefined, {
    type: "conflict_detected",
    taskId: tasks.claude,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      taskIds: [tasks.claude, tasks.codex],
      disposition: "sequence",
      evidence: [],
    },
  });
  await runtime.store.appendAudit(undefined, {
    type: "plan_admitted",
    taskId: tasks.claude,
    data: {
      status: "sequenced",
      blockedBy: [tasks.codex],
      explanation: "Sequenced behind executing work on the same resources",
    },
  });

  await waitFor(
    async () => {
      const messages = await runtime.store.listChannelMessages(repo, ownerId);
      return messages.some((message) => message.authorId === "coordinator");
    },
    "the collision was never announced in the room",
    8_000,
  );

  const messages = await runtime.store.listChannelMessages(repo, ownerId);
  const line = String(
    messages.find((message) => message.authorId === "coordinator")?.content,
  );
  // The named agent is still named; only the one nobody is connected for
  // falls back, and it falls back quoted and short rather than to a wrong name.
  assert.match(line, new RegExp(`@Claude \\(${firstName}\\)`, "u"), line);
  // 37 characters and an ellipsis — the exact shape the room was showing when
  // this was reported, which is how the fallback was identified as the path
  // every hold was taking.
  assert.match(line, /"paste the 72 possible names an agent …"/u, line);
  assert.doesNotMatch(
    line,
    new RegExp(`@Codex \\(${firstName}\\)`, "u"),
    "an agent nobody is connected for was named anyway",
  );
});

test("the sweep leaves a quiet task alone, and closes a thread its watcher abandoned", async (t) => {
  // Two halves of one confusion. The sweep decides a thread still needs an
  // ending from its replies, and a quick task's ending is deliberately not a
  // reply — so it pasted a second, canned one underneath, duplicating the
  // outcome and handing the task the room the narrator had spared it. And it
  // reads the task's status to know an ending is due, but a landed
  // conversational turn settles `open`, which was in no table here — so the
  // orphaned threads this sweep exists for were skipped on every pass.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "sweeproom");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel`;
  const mention = `Claude (${String(session.user.displayName).split(" ")[0]})`;

  assert.equal(
    (
      await owner.request(`${base}/messages`, {
        method: "POST",
        body: { content: `@${mention} fix the typo in the README` },
      })
    ).status,
    201,
  );
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mention never dispatched a task",
  );
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId: repo });
  assert.ok(task !== undefined);

  await runtime.store.appendAudit(undefined, {
    type: "task_started",
    taskId: task.id,
    data: {},
  });
  await runtime.store.appendAudit(undefined, {
    type: "task_failed",
    taskId: task.id,
    data: { error: "npm test exited 1" },
  });
  await waitFor(
    async () =>
      (await runtime.store.listChannelMessages(repo, ownerId)).some(
        (message) => message.kind === "outcome",
      ),
    "the quiet ending never reached the room",
    8_000,
  );

  // The run is over and its watcher is gone — the state a restart leaves.
  await runtime.store.claimSubmittedTasks(repo);
  await runtime.store.completeSubmittedTask(task.id, "failed");
  await (runtime.gateway as unknown as {
    reconcileFinishedThreads(): Promise<void>;
  }).reconcileFinishedThreads();

  const swept = await runtime.store.listChannelMessages(repo, ownerId);
  assert.deepEqual(
    swept.flatMap((message) =>
      (message.replies ?? []).map((reply) => reply.content),
    ),
    [],
    "the sweep gave a thread to a task that had already reported in the room",
  );
  assert.equal(
    swept.filter((message) => message.kind === "outcome").length,
    1,
    "the ending was said twice",
  );

  // And the other half: a thread that really was left mid-sentence, on a turn
  // that landed conversationally and so sits `open`.
  const stranded = await runtime.store.appendChannelMessage({
    repositoryId: repo,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it.",
  });
  const turn = await runtime.store.submitTask({
    repositoryId: repo,
    projectId: DEFAULT_PROJECT_ID,
    objective: "refactor the auth module",
    agentId: "test-agent",
    validationCommands: [],
    conversationId: stranded.id,
  });
  await runtime.store.setChannelMessageTask(repo, stranded.id, turn.id);
  await runtime.store.addChannelReply({
    repositoryId: repo,
    messageId: stranded.id,
    authorId: `${ownerId}:anthropic`,
    content: "Working on it…",
    kind: "progress",
  });
  await runtime.store.claimSubmittedTasks(repo);
  await runtime.store.openSubmittedTask(turn.id);

  await (runtime.gateway as unknown as {
    reconcileFinishedThreads(): Promise<void>;
  }).reconcileFinishedThreads();

  const closed = (
    await runtime.store.listChannelMessages(repo, ownerId)
  ).find((message) => message.id === stranded.id);
  assert.ok(
    (closed?.replies ?? []).some((reply) => reply.kind === "outcome"),
    `an orphaned open turn was never given an ending: ${JSON.stringify(
      closed?.replies,
    )}`,
  );
});

test("a mention nobody answers to says so, instead of vanishing", async (t) => {
  // The browser roster layers this account's own agents on top of the
  // server's, so an agent connected in a way that stored no per-user
  // credential is offered by the composer's autocomplete while
  // `connectionsFor` has never heard of it. Every mention then disappeared,
  // in every channel, with nothing to distinguish "thinking" from "was never
  // there".
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "nobodyhome");
  // Deliberately no connections: this is the state being reproduced.
  runtime.chatConnections.set(ownerId, []);

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: "@Notus can you run an audit" } },
  );

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) =>
      message.content.includes("Nobody here answers to that"),
    );
  }, "the channel stayed silent about an unresolvable mention");

  const said = (await runtime.store.listChannelMessages(repo, ownerId))
    .map((message) => message.content)
    .join("\n");
  // It names the way out, not just the problem.
  assert.match(said, /this channel has no agents the server can reach/u);
  assert.match(said, /add it to this channel/u);
  assert.equal(runtime.submittedTasks.length, 0);
});

test("an ordinary @ in a message is not treated as addressing anyone", async (t) => {
  // The silence was right for these, which is why it was there. An email
  // address or a scoped package must not draw an answer about the roster.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "atsign");
  runtime.chatConnections.set(ownerId, []);

  for (const content of [
    "mail me at nathan@example.com when it lands",
    "run npm i @scope/package first",
  ]) {
    await owner.request(
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
      { method: "POST", body: { content } },
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 250));

  const said = (await runtime.store.listChannelMessages(repo, ownerId))
    .map((message) => message.content)
    .join("\n");
  assert.doesNotMatch(said, /Nobody here answers to that/u);
});

test("a personal agent cannot be made auditor, an org-wide one can", async (t) => {
  // An auditor spends its owner's account continuously and unprompted, and
  // promotion needs only `manage_project` — so without this rule an admin
  // could commit a colleague's personal subscription to a permanent cost
  // they never agreed to. An org-wide credential is already published as
  // spendable by other people's requests; that is the consent this needs.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "spend");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "personal" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const channel = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`;

  const personal = await owner.request(`${channel}/${ownerId}:anthropic`, {
    method: "POST",
    body: { role: "auditor" },
  });
  assert.equal(personal.status, 409, JSON.stringify(personal.data));
  assert.equal(personal.data.error.code, "auditor_must_be_org_wide");

  // The same agent may still hold any ordinary role: the restriction is on
  // the one role that spends without being asked, not on the agent.
  const plain = await owner.request(`${channel}/${ownerId}:anthropic`, {
    method: "POST",
    body: { role: "Backend Engineer" },
  });
  assert.equal(plain.status, 200, JSON.stringify(plain.data));

  const orgWide = await owner.request(`${channel}/${ownerId}:openai`, {
    method: "POST",
    body: { role: "auditor" },
  });
  assert.equal(orgWide.status, 200, JSON.stringify(orgWide.data));
});

test("the roster falls back to the stored call sign, not the vendor label", async (t) => {
  // The reported bug: reload into Lattice and the channel roster calls every
  // agent "Claude (Nathan)" again. Names lived only in the control plane's
  // local `provider-connections.json` — the file `connectionsFor` reads — so
  // a restart on a filesystem that did not keep it lost every name while the
  // database still held the channel. The store remembers, so the roster does.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "named");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  await runtime.store.setAgentCallSign(ownerId, "anthropic", "Athena");

  const roster = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`,
  );
  assert.equal(roster.status, 200, JSON.stringify(roster.data));
  assert.equal(roster.data.agents.length, 1);
  assert.equal(roster.data.agents[0].name, "Athena");

  // Renaming your own agent from a channel renames it everywhere: the name is
  // the account's call sign, not a label this room happens to use, so the
  // second repository below answers to it without ever having been told.
  const second = await invitableRepository(owner, "named-too");
  await joinAllConnectedAgents(runtime, second);
  const renamed = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents/${ownerId}:anthropic`,
    { method: "POST", body: { name: "Scout" } },
  );
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.scope, "account");
  assert.equal(renamed.data.override.name, "Scout");
  const afterRename = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`,
  );
  assert.equal(afterRename.data.agents[0].name, "Scout");
  const elsewhere = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${second}/channel/agents`,
  );
  assert.equal(elsewhere.data.agents[0].name, "Scout");
  // Written where the account holds it, not as a per-room shadow of it.
  const signs = await runtime.store.listAgentCallSigns();
  assert.equal(signs.find((sign) => sign.userId === ownerId)?.callSign, "Scout");
  const overrides = await runtime.store.listChannelAgentOverrides(repo);
  assert.equal(overrides[`${ownerId}:anthropic`]?.name, undefined);
});

test("renaming an agent in Settings renames it in every repository", async (t) => {
  // The reported bug, from the other side: an agent renamed in one channel
  // kept its old name in the next, and Settings — which reads the account's
  // own connection — never showed the new one at all. One name, written
  // account-wide, and the per-repository names that used to shadow it are
  // cleared as part of the same write.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const first = await invitableRepository(owner, "one");
  const second = await invitableRepository(owner, "two");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "personal", callSign: "Athena" },
  ]);
  await joinAllConnectedAgents(runtime, first);
  await joinAllConnectedAgents(runtime, second);
  // A name this room had given it before any of this existed, which is
  // exactly what used to survive a rename and keep answering to the old name.
  await runtime.store.setChannelAgentOverride(second, `${ownerId}:anthropic`, {
    name: "Vesta",
    role: "Backend Engineer",
  });

  const renamed = await owner.request("/api/v1/chat/providers/anthropic/settings", {
    method: "POST",
    body: { callSign: "Hermes" },
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));

  for (const repositoryId of [first, second]) {
    const roster = await owner.request(
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/agents`,
    );
    assert.equal(roster.status, 200, JSON.stringify(roster.data));
    assert.equal(roster.data.agents[0].name, "Hermes");
  }
  // The role that room set is its own decision and survives the rename.
  const overrides = await runtime.store.listChannelAgentOverrides(second);
  assert.equal(overrides[`${ownerId}:anthropic`]?.name, undefined);
  assert.equal(overrides[`${ownerId}:anthropic`]?.role, "Backend Engineer");

  // And the name is the one a mention resolves against, everywhere.
  const posted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${second}/channel/messages`,
    { method: "POST", body: { content: "@Hermes please look at this" } },
  );
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 1);
});

test("a call sign longer than the account allows is refused, not half-written", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "long-name");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "personal", callSign: "Athena" },
  ]);
  await joinAllConnectedAgents(runtime, repo);

  const refused = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents/${ownerId}:anthropic`,
    { method: "POST", body: { name: "N".repeat(41) } },
  );
  assert.equal(refused.status, 400, JSON.stringify(refused.data));
  assert.equal(refused.data.error.code, "invalid_call_sign");
  const roster = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`,
  );
  assert.equal(roster.data.agents[0].name, "Athena");
});

test("the roster reports the connection's own call sign, and that name answers", async (t) => {
  // The half the store's copy could not fix: the roster route rebuilt
  // `${AGENT_LABEL} (${owner})` for every agent and never looked at the name
  // the connection carries, so a deployment that still *had* every name showed
  // "Claude (Owner)" in every channel while the settings screen showed Athena.
  // The browser takes this route's answer as the single authority for what an
  // agent is called (`channelAgentsFor` in data.js), so this is the name.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "call-signs");
  runtime.chatConnections.set(session.user.id, [
    { provider: "anthropic", visibility: "personal", callSign: "Athena" },
    // Never named — the pre-call-sign connection whose fallback must stay.
    { provider: "openai", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const roster = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/agents`,
  );
  assert.equal(roster.status, 200, JSON.stringify(roster.data));
  const agents = roster.data.agents as any[];
  const named = agents.find((agent) => agent.provider === "anthropic");
  const unnamed = agents.find((agent) => agent.provider === "openai");
  assert.equal(named?.name, "Athena");
  assert.equal(unnamed?.name, "Codex (Owner)");

  // And the matcher agrees with the screen: the name the roster reports is
  // the name a mention resolves against, or people @mention what they can see
  // and nothing answers.
  const posted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages`,
    { method: "POST", body: { content: "@Athena please fix the login bug" } },
  );
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 1);
  assert.equal(runtime.submittedTasks[0]?.vendor, "claude");
});

test("the auditor audits a canonical advance and posts what it finds", async (t) => {
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "watched");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const channel = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`;
  const promoted = await owner.request(`${channel}/${ownerId}:openai`, {
    method: "POST",
    body: { role: "auditor" },
  });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.data));

  runtime.chatAnswer.text = [
    "FINDING",
    "severity: high",
    "files: src/server.ts",
    "selffix: no",
    "title: Inverted condition admits unauthorized callers",
    "detail: The guard was changed from && to ||, so either check passing is",
    "enough where both were required.",
    "END",
  ].join("\n");

  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-1",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });

  await waitFor(
    async () =>
      (
        await runtime.store.listChannelMessages(repo, ownerId)
      ).some((message) =>
        message.replies.some((reply) => reply.content.includes("Audited")),
      ),
    "the auditor never posted its findings",
  );

  // It read the change it was woken by, not the whole tree.
  assert.equal(runtime.canonicalDiffs.length, 1);
  assert.equal(runtime.canonicalDiffs[0]?.fromRevision, "a".repeat(40));
  assert.equal(runtime.canonicalDiffs[0]?.toRevision, "b".repeat(40));
  // And it audited on its own account, unprompted.
  assert.equal(runtime.chatPrompts[0]?.userId, ownerId);
  assert.match(runtime.chatPrompts[0]?.prompt ?? "", /const ok = a \|\| b;/u);

  // One thread for every audit this repository will ever have, with the run's
  // summary and each finding inside it — not a thread per merge. Alongside it,
  // one line in the room: a bumped thread says something happened but not
  // whether it mattered, and a high finding read exactly like a routine
  // all-clear until somebody opened it.
  const posted = await runtime.store.listChannelMessages(repo, ownerId);
  assert.equal(posted.length, 2);
  const message = posted.find((entry) =>
    String(entry.content).startsWith("Audit log"),
  );
  // From the auditor rather than the deployment: an audit is an agent's own
  // reading of a change, so it arrives with a face like anything else said in
  // the room.
  const announced = posted.find((entry) =>
    String(entry.content).startsWith("Audit of"),
  );
  assert.equal(announced?.kind, "agent");
  assert.equal(announced?.authorId, `${ownerId}:openai`);
  assert.match(String(announced?.content), /1 issue \(1 high\)/u);
  assert.match(
    String(announced?.content),
    /Inverted condition admits unauthorized callers/u,
  );
  assert.equal(message?.authorId, `${ownerId}:openai`);
  assert.match(String(message?.content), /^Audit log/u);
  assert.equal(message?.replies.length, 2);
  assert.match(String(message?.replies[0]?.content), /Audited/u);
  assert.match(
    message?.replies[1]?.content ?? "",
    /1\. Inverted condition admits unauthorized callers/u,
  );

  // The cursor moved, so a restart does not audit this advance again.
  const cursor = await runtime.store.getAuditorCursor(repo);
  assert.equal(cursor?.revision, "b".repeat(40));
});

test("a clean audit reports that it ran, inside the audit thread", async (t) => {
  // Silence and "not running" look identical from outside, and until an
  // auditor has been watched working once, the difference is the only thing
  // anybody wants to know. It goes in the thread rather than the room, so the
  // channel is not the thing paying for it.
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "clean");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents/${ownerId}:openai`,
    { method: "POST", body: { role: "auditor" } },
  );
  runtime.chatAnswer.text = "NO FINDINGS";

  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-1",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });

  await waitFor(
    async () => runtime.canonicalDiffs.length > 0,
    "the auditor never looked at the change",
  );
  await waitFor(
    async () => (await runtime.store.getAuditorCursor(repo)) !== undefined,
    "the auditor never recorded that it had looked",
  );
  const posted = await runtime.store.listChannelMessages(repo, ownerId);
  // One message in the channel — the thread root — and the outcome inside it.
  assert.equal(posted.length, 1);
  assert.match(String(posted[0]?.content), /^Audit log/u);
  assert.equal(posted[0]?.replies.length, 1);
  assert.match(String(posted[0]?.replies[0]?.content), /nothing to report/u);
});

test("a repository with no auditor is never audited", async (t) => {
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "unwatched");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);

  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-1",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });

  // Nothing to wait on, so this waits for the poller to have run at all and
  // then asserts it did nothing.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(runtime.canonicalDiffs, []);
  assert.deepEqual(await runtime.store.listChannelMessages(repo, ownerId), []);
});

test('approving a finding with "yes, do it" dispatches the fix', async (t) => {
  // The wording matters: `looksLikeTaskRequest` returns false for this, so
  // without the auditor's own approval reading the reply would fall through
  // to the agent answering a question about its own finding — which looks
  // exactly like it worked.
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "approved");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents/${ownerId}:openai`,
    { method: "POST", body: { role: "auditor" } },
  );
  runtime.chatAnswer.text = [
    "FINDING",
    "severity: medium",
    "files: src/retry.ts",
    "selffix: yes",
    "title: Retry loop runs one time too many",
    "detail: The bound is inclusive where it should be exclusive.",
    "END",
  ].join("\n");

  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-1",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });
  await waitFor(
    async () =>
      (await runtime.store.listChannelMessages(repo, ownerId)).length > 0,
    "the auditor never posted its findings",
  );
  const [audit] = await runtime.store.listChannelMessages(repo, ownerId);
  assert.notEqual(audit, undefined);

  const reply = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages/${audit?.id}/replies`,
    { method: "POST", body: { content: "yes, do it" } },
  );
  assert.equal(reply.status, 201, JSON.stringify(reply.data));

  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "approving the finding never dispatched a fix",
  );
  const [task] = runtime.submittedTasks;
  assert.match(task?.objective ?? "", /Retry loop runs one time too many/u);
  assert.match(task?.objective ?? "", /src\/retry\.ts/u);
  // Submitted against the auditor's owner, which is who agreed to spend.
  assert.equal(task?.actorId, ownerId);
  // The finding was marked self-fixable and nobody else was named, so the
  // auditor took it rather than handing it on.
  assert.equal(task?.repositoryId, repo);
});

test("a number is read against the newest audit, not the whole thread", async (t) => {
  // Every audit of a repository lands in one thread and findings are numbered
  // per audit, so the replies hold 1, 2, then 1 again. Read as one list, "fix
  // 1" matched two different findings and dispatched both.
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "renumbered");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents/${ownerId}:openai`,
    { method: "POST", body: { role: "auditor" } },
  );

  const finding = (title: string) =>
    [
      "FINDING",
      "severity: medium",
      "files: src/one.ts",
      "selffix: yes",
      `title: ${title}`,
      "detail: Something worth fixing.",
      "END",
    ].join("\n");

  // Two audits into the same thread, each with its own finding numbered 1.
  const audits = [
    { title: "First audit finding", from: "a", to: "b" },
    { title: "Second audit finding", from: "b", to: "c" },
  ];
  for (const [index, entry] of audits.entries()) {
    runtime.chatAnswer.text = finding(entry.title);
    await runtime.store.appendAudit(undefined, {
      type: "canonical_promoted",
      taskId: `task-${String(index + 1)}`,
      data: {
        projectId: DEFAULT_PROJECT_ID,
        repositoryId: repo,
        previousRevision: entry.from.repeat(40),
        revision: entry.to.repeat(40),
      },
    });
    await waitFor(
      async () =>
        (await runtime.store.listChannelMessages(repo, ownerId)).some(
          (message) =>
            message.replies.some((r) => r.content.includes(entry.title)),
        ),
      `audit ${String(index + 1)} never posted`,
    );
  }

  // One thread holding both audits, which is the condition being tested. The
  // two room lines the findings announced are beside it, not more threads.
  const posted = await runtime.store.listChannelMessages(repo, ownerId);
  const audit = posted.find((entry) =>
    String(entry.content).startsWith("Audit log"),
  );
  assert.equal(
    posted.filter((entry) => String(entry.content).startsWith("Audit log"))
      .length,
    1,
  );
  assert.equal(audit?.replies.length, 4);

  const reply = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages/${audit?.id}/replies`,
    { method: "POST", body: { content: "yes, fix 1" } },
  );
  assert.equal(reply.status, 201, JSON.stringify(reply.data));

  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "approving finding 1 never dispatched anything",
  );
  // Exactly one task, and it is the newest audit's finding — not both, and
  // not the older one that also happens to be numbered 1.
  assert.equal(runtime.submittedTasks.length, 1);
  assert.match(
    runtime.submittedTasks[0]?.objective ?? "",
    /Second audit finding/u,
  );
});

test("a rejection in an auditor thread dispatches nothing", async (t) => {
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "declined");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents/${ownerId}:openai`,
    { method: "POST", body: { role: "auditor" } },
  );
  runtime.chatAnswer.text = [
    "FINDING",
    "severity: low",
    "files: src/a.ts",
    "selffix: yes",
    "title: Redundant null check",
    "detail: The value cannot be null here.",
    "END",
  ].join("\n");

  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-1",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });
  await waitFor(
    async () =>
      (await runtime.store.listChannelMessages(repo, ownerId)).length > 0,
    "the auditor never posted its findings",
  );
  const [audit] = await runtime.store.listChannelMessages(repo, ownerId);

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages/${audit?.id}/replies`,
    { method: "POST", body: { content: "no, that is a false positive" } },
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(runtime.submittedTasks, []);
});

/** Promotes an org-wide agent to auditor and returns the owner's id. */
async function repositoryWithAuditor(
  runtime: TestRuntime,
  owner: TestClient,
  ownerId: string,
  repositoryId: string,
): Promise<void> {
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const promoted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/agents/${ownerId}:openai`,
    { method: "POST", body: { role: "auditor" } },
  );
  assert.equal(promoted.status, 200, JSON.stringify(promoted.data));
}

test("auditing can be switched off, and merges during the pause are not audited", async (t) => {
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "paused");
  await repositoryWithAuditor(runtime, owner, ownerId, repo);
  runtime.chatAnswer.text = "NO FINDINGS";

  const off = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/auditor`,
    { method: "POST", body: { paused: true } },
  );
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.data.paused, true);

  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-1",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(runtime.canonicalDiffs, []);

  // The roster reports the switch, so the toggle can be drawn from one read.
  const roster = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`,
  );
  assert.equal(roster.data.auditorPaused, true);
});

test("switching auditing back on audits the gap immediately", async (t) => {
  // The point of a pause rather than a demotion: the cursor is kept, so
  // resuming reviews what landed while it was off instead of skipping it.
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "resumed");
  await repositoryWithAuditor(runtime, owner, ownerId, repo);
  runtime.chatAnswer.text = "NO FINDINGS";

  // One audit first, so there is a real revision to resume from.
  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-1",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });
  await waitFor(
    async () => (await runtime.store.getAuditorCursor(repo)) !== undefined,
    "the first audit never ran",
  );
  assert.equal(runtime.canonicalDiffs.length, 1);

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/auditor`,
    { method: "POST", body: { paused: true } },
  );
  // Two merges land unseen while it is off.
  runtime.canonicalState.head = "d".repeat(40);
  runtime.chatAnswer.text = [
    "FINDING",
    "severity: high",
    "files: src/server.ts",
    "selffix: no",
    "title: Something landed while auditing was off",
    "detail: Found on resume.",
    "END",
  ].join("\n");

  const on = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/auditor`,
    { method: "POST", body: { paused: false } },
  );
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.paused, false);
  assert.equal(on.data.resumed, "audited");

  await waitFor(
    async () =>
      (await runtime.store.listChannelMessages(repo, ownerId)).length > 0,
    "resuming never produced an audit",
  );
  // The gap, in one range: from where it last finished to where canonical is
  // now — not from the event it missed, and not from the beginning.
  const resumeDiff = runtime.canonicalDiffs[1];
  assert.equal(resumeDiff?.fromRevision, "b".repeat(40));
  assert.equal(resumeDiff?.toRevision, "d".repeat(40));
  assert.equal((await runtime.store.getAuditorCursor(repo))?.paused, false);
});

test("resuming with nothing new to review says so and spends nothing", async (t) => {
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "quiet");
  await repositoryWithAuditor(runtime, owner, ownerId, repo);
  runtime.chatAnswer.text = "NO FINDINGS";

  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-1",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });
  await waitFor(
    async () => (await runtime.store.getAuditorCursor(repo)) !== undefined,
    "the first audit never ran",
  );

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/auditor`,
    { method: "POST", body: { paused: true } },
  );
  // Canonical has not moved since the last audit.
  const on = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/auditor`,
    { method: "POST", body: { paused: false } },
  );
  assert.equal(on.data.resumed, "nothing_to_audit");
  assert.equal(runtime.canonicalDiffs.length, 1, "no second diff was read");
});

test("the auditor switch needs manage_project, and an auditor to switch", async (t) => {
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "switchguard");

  // Nothing holds the role yet.
  const none = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/auditor`,
    { method: "POST", body: { paused: true } },
  );
  assert.equal(none.status, 404, JSON.stringify(none.data));
  assert.equal(none.data.error.code, "no_auditor");

  await repositoryWithAuditor(runtime, owner, ownerId, repo);
  const guest = await joinRepository(
    runtime,
    owner,
    "switchguest@example.com",
    repo,
  );
  const refused = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/auditor`,
    { method: "POST", body: { paused: true } },
  );
  assert.equal(
    refused.status === 200,
    false,
    "a collaborator must not switch auditing",
  );

  const bad = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/auditor`,
    { method: "POST", body: { paused: "yes" } },
  );
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
});

test("a collaborator cannot promote an auditor, but can still set a plain role", async (t) => {
  // The permission line: naming an agent's role is ordinary collaboration,
  // handing one the ability to spend on its own initiative is administration.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "guarded");
  const guest = await joinRepository(runtime, owner, "guest@example.com", repo);
  const channel = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`;

  const plain = await guest.request(`${channel}/anthropic`, {
    method: "POST",
    body: { role: "Reviewer" },
  });
  assert.equal(plain.status, 200, JSON.stringify(plain.data));

  const promotion = await guest.request(`${channel}/anthropic`, {
    method: "POST",
    body: { role: "auditor" },
  });
  assert.equal(promotion.status === 200, false, "a guest must not promote");
});

/**
 * Asked for a status report, agents called finished work outstanding.
 *
 * They were right about what they were shown. A conversational turn that
 * lands is set to `open` — the work is in canonical and the thread stays warm
 * for a follow-up — and the status list handed the model that word raw. "Open"
 * has a plain English meaning and it is the opposite of the one intended.
 */
test("a landed conversational task is described as done, not as open", () => {
  assert.match(describeTaskState("open"), /^done\b/u);
  assert.match(describeTaskState("integrated"), /^done\b/u);
  // The word itself must not survive into the sentence: it is the whole bug.
  assert.doesNotMatch(describeTaskState("open"), /^open$/u);

  // And the states that genuinely are not finished must not read as done.
  for (const status of ["submitted", "claimed", "planned", "failed", "cancelled"]) {
    assert.doesNotMatch(
      describeTaskState(status),
      /^done\b/u,
      `${status} must not be reported as finished`,
    );
  }
  // A status this function has not been taught is passed through rather than
  // guessed at: a wrong plain-English gloss would be worse than the raw word.
  assert.equal(describeTaskState("something_new"), "something_new");
});

test("a reply to an agent's own ending is answered, not swallowed", async (t) => {
  // Reported as "if I send an additional message in a thread the agent never
  // responds". A task that ends without being thread-worthy — the ordinary
  // one-file change whose account fits in a sentence — has its ending posted
  // as a top-level channel message of kind `outcome`, authored by the agent.
  // The dashboard offers a reply on every message, so replying to an agent's
  // last visible word opened a thread the server classified as a conversation
  // between people, and every follow-up was stored and answered by nobody.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic" }]);
  const repositoryId = await invitableRepository(owner, "outcome-thread-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    // The kind the gateway itself writes for a task that ended quietly.
    kind: "outcome",
    authorId: `${ownerId}:anthropic`,
    content: "Renamed the helper and updated its one caller. (1 file changed)",
  });

  runtime.chatAnswer.text = "Yes — it was only used in the one place.";
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "did anything else use it?" } },
  );
  assert.equal(replied.status, 201);

  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    const thread = (listed.data.messages as { id: string; replies: unknown[] }[])
      .find((message) => message.id === root.id);
    const replies = (thread?.replies ?? []) as Array<{
      authorId: string;
      kind: string;
    }>;
    // The agent answers in its own voice, in its own thread, and finishes the
    // streamed turn rather than satisfying this wait with its progress line.
    return replies.some(
      (reply) =>
        reply.authorId === `${ownerId}:anthropic` && reply.kind === "outcome",
    );
  }, "the agent never answered a reply to its own outcome message");
});

test("a reply to an agent's thread naming nobody is told why, not ignored", async (t) => {
  // The other half: a root an agent produced but that resolves to no reachable
  // agent must still say something. Storing a reply and returning silently is
  // indistinguishable, from the outside, from the product being broken.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "unowned-thread-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  // Kind `user`, but carrying a task — so it is work somebody is following,
  // not a standup note between people.
  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "user",
    authorId: bootstrapped.user.id,
    content: "Tracking the migration here.",
    taskId: "task_missing",
  });

  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "any progress?" } },
  );
  assert.equal(replied.status, 201);

  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    const thread = (listed.data.messages as { id: string; replies: unknown[] }[])
      .find((message) => message.id === root.id);
    return ((thread?.replies ?? []) as unknown[]).length > 1;
  }, "a reply on a task thread nobody owns was stored with no explanation");
});

test("/stop cancels an agent's work and undoes only what that task promoted", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic", visibility: "org" }]);
  const repositoryId = await invitableRepository(owner, "stop-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "rework the retry loop",
    agentId: "anthropic",
    validationCommands: [],
    submittedBy: ownerId,
  });
  // Work that already reached canonical, recorded the way a promotion is.
  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: task.id,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
      files: ["src/retry.ts"],
    },
  });

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/stop" },
  });
  assert.equal(posted.status, 201);

  await waitFor(async () => {
    const listed = await runtime.store.listSubmittedTasks({ repositoryId });
    return listed.find((entry) => entry.id === task.id)?.status === "cancelled";
  }, "/stop did not cancel the in-flight task");

  const rolled = runtime.rollbacks.at(-1);
  assert.ok(rolled, "/stop did not ask for the task's changes to be undone");
  // Back to the revision before this task, and scoped to its own files — not a
  // whole-tree revert that would take other agents' work with it.
  assert.equal(rolled.targetRevision, "a".repeat(40));
  assert.deepEqual([...(rolled.files ?? [])], ["src/retry.ts"]);
});

test("/stop on a task that changed nothing cancels without a rollback", async (t) => {
  // The ordinary case: work only reaches canonical at settlement, so a task
  // stopped while running has nothing to put back and must not ask for one.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic", visibility: "org" }]);
  const repositoryId = await invitableRepository(owner, "stop-clean-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "look at the flaky test",
    agentId: "anthropic",
    validationCommands: [],
    submittedBy: ownerId,
  });
  const before = runtime.rollbacks.length;

  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/stop" },
  });
  await waitFor(async () => {
    const listed = await runtime.store.listSubmittedTasks({ repositoryId });
    return listed.find((entry) => entry.id === task.id)?.status === "cancelled";
  }, "/stop did not cancel the task");
  assert.equal(
    runtime.rollbacks.length,
    before,
    "a task that promoted nothing must not trigger a rollback",
  );
});

test("'/cancel' in the channel stops the room's work and says so", async (t) => {
  // The failure mode this exists for: agents running, and nothing a person
  // could type that reached them. The channel verb has to stop the work AND
  // say what it stopped — a silent stop is indistinguishable from a stop
  // that never happened.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const repo = await invitableRepository(owner, "stoppable");

  const first = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "first job",
    agentId: "test-agent-codex",
    validationCommands: [],
    submittedBy: session.user.id,
  });
  const second = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "second job",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: session.user.id,
  });

  const posted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: "/cancel" } },
  );
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(
      repo,
      session.user.id,
    );
    return messages.some((message) =>
      message.content.includes("Stopped 2 queued tasks in this channel."),
    );
  }, "the channel never reported the stop");

  assert.equal(runtime.cancelCalls.length, 1);
  assert.equal(runtime.cancelCalls[0]?.actorId, session.user.id);
  assert.equal(runtime.cancelCalls[0]?.vendor, undefined);
  const statuses = new Map(
    (
      await runtime.store.listSubmittedTasks({ repositoryId: repo })
    ).map((task) => [task.id, task.status]),
  );
  assert.equal(statuses.get(first.id), "cancelled");
  assert.equal(statuses.get(second.id), "cancelled");
});

test("'/cancel @agent' stops that agent's work and nobody else's", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "scoped-stop");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const mention = `Codex (${String(session.user.displayName).split(" ")[0]})`;

  const codexTask = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "codex job",
    agentId: "test-agent-codex",
    validationCommands: [],
    submittedBy: ownerId,
  });
  const claudeTask = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "claude job",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: ownerId,
  });

  const posted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: `/cancel @${mention}` } },
  );
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) =>
      message.content.includes(`Stopped 1 queued task for @${mention}.`),
    );
  }, "the channel never reported the scoped stop");

  assert.equal(runtime.cancelCalls[0]?.vendor, "codex");
  const statuses = new Map(
    (
      await runtime.store.listSubmittedTasks({ repositoryId: repo })
    ).map((task) => [task.id, task.status]),
  );
  assert.equal(statuses.get(codexTask.id), "cancelled");
  assert.equal(statuses.get(claudeTask.id), "submitted");
});

test("'/stop @agent' spares another persona's same-vendor work", async (t) => {
  // The reported bug: two personas run the same vendor CLI, so both resolve
  // to the same configured agent id — and a vendor-scoped stop swept both.
  // A persona is the (owner, vendor) pair, and the stop must honour it.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "persona-stop");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  const colleague = await addColleague(runtime, "persona-stop@example.com");
  runtime.chatConnections.set(colleague.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  assert.equal(
    (
      await owner.request(`${base}/agents/anthropic`, {
        method: "POST",
        body: { name: "Medea" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await owner.request(`${base}/agents/${colleague.id}:anthropic`, {
        method: "POST",
        body: { name: "Andromeda" },
      })
    ).status,
    200,
  );

  const mine = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "my own claude job",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: ownerId,
  });
  const theirs = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "the colleague's claude job",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: colleague.id,
  });

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/stop @Medea" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) =>
      message.content.includes("Stopped 1 queued task for @Medea."),
    );
  }, "the channel never reported the persona-scoped stop");

  assert.equal(runtime.cancelCalls[0]?.ownerId, ownerId);
  const statuses = new Map(
    (
      await runtime.store.listSubmittedTasks({ repositoryId: repo })
    ).map((task) => [task.id, task.status]),
  );
  assert.equal(statuses.get(mine.id), "cancelled");
  // The other persona's task is untouched — same vendor, different person.
  assert.equal(statuses.get(theirs.id), "submitted");
});

test("'/cancel' for a name nobody answers to stops nothing and says who it could", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "misnamed-stop");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);

  const task = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "still wanted",
    agentId: "test-agent-codex",
    validationCommands: [],
    submittedBy: ownerId,
  });

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: "/cancel @Nobody" } },
  );

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) =>
      message.content.includes('Nobody here answers to "Nobody"'),
    );
  }, "the channel never explained the unknown name");

  assert.equal(runtime.cancelCalls.length, 0);
  const [row] = await runtime.store.listSubmittedTasks({ repositoryId: repo });
  assert.equal(row?.id, task.id);
  assert.equal(row?.status, "submitted");
});

test("a reply naming an option routes back to the waiting question", async (t) => {
  // The round trip the owner could not verify: "1" typed in the thread must
  // reach the paused coordinator as a chosen index, not as conversation.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "asked-and-answered");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";
  const mention = `Codex (${String(session.user.displayName).split(" ")[0]})`;

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: `@${mention} please fix the retry loop` } },
  );
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mention never became work",
  );
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId: repo });
  assert.notEqual(task, undefined);

  // The acknowledgement message is the thread the question will be asked in.
  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) => message.taskId === task?.id);
  }, "the dispatch never acknowledged in the channel");
  const ack = (
    await runtime.store.listChannelMessages(repo, ownerId)
  ).find((message) => message.taskId === task?.id);
  assert.notEqual(ack, undefined);

  const waiting = runtime.gateway.awaitAgentAnswer({
    requestId: "q-route",
    taskId: task?.id ?? "",
    repositoryId: repo,
    projectId: DEFAULT_PROJECT_ID,
    question: "Which approach?",
    options: ["Both modules", "One and a shim"],
    deadlineMs: 4_000,
  });
  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) =>
      message.replies.some((reply) => reply.content.includes("Which approach?")),
    );
  }, "the question never reached the thread");

  const replied = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages/${ack?.id}/replies`,
    { method: "POST", body: { content: "1" } },
  );
  assert.equal(replied.status, 201, JSON.stringify(replied.data));

  assert.deepEqual(await waiting, { chosen: 0 });
});

test("an answer after the deadline is told it was late, not chatted at", async (t) => {
  // The undiagnosable half of the incident: the owner answered "1", nothing
  // happened, and nothing recorded whether the reply failed to route or the
  // question had already cancelled. Now the late reply gets the account.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "answered-late");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";
  const mention = `Codex (${String(session.user.displayName).split(" ")[0]})`;

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: `@${mention} please fix the retry loop` } },
  );
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mention never became work",
  );
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId: repo });
  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) => message.taskId === task?.id);
  }, "the dispatch never acknowledged in the channel");
  const ack = (
    await runtime.store.listChannelMessages(repo, ownerId)
  ).find((message) => message.taskId === task?.id);

  // The deadline lapses with nobody answering.
  const lapsed = await runtime.gateway.awaitAgentAnswer({
    requestId: "q-late",
    taskId: task?.id ?? "",
    repositoryId: repo,
    projectId: DEFAULT_PROJECT_ID,
    question: "Which approach?",
    options: ["Both modules", "One and a shim"],
    deadlineMs: 30,
  });
  assert.equal(lapsed, undefined);

  // The answer arrives late — the exact shape of the incident.
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages/${ack?.id}/replies`,
    { method: "POST", body: { content: "1" } },
  );

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) =>
      message.replies.some((reply) =>
        reply.content.includes("after the question's deadline"),
      ),
    );
  }, "the late answer was never told what happened to it");
  // And it never fell through to the chat model as a question about "1":
  // the only prompt the fixture saw is the dispatch acknowledgement.
  assert.equal(
    runtime.chatPrompts.filter((entry) => entry.prompt.includes("The question: 1"))
      .length,
    0,
  );
});

test("the thread exists before the agent's opening line has been written", async (t) => {
  // Reported as "it usually takes a while for the thread to come up". The
  // acknowledgement is composed by a model and *is* the thread root, so the
  // thread did not exist until that call returned — up to six seconds of an
  // empty room after somebody asked for something.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic", visibility: "org" }]);
  const repositoryId = await invitableRepository(owner, "fast-thread-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const agents = await owner.request(`${base}/agents`);
  const name = (agents.data.agents as { name: string }[])[0]?.name ?? "";

  // Slower than anyone will wait, and far slower than the thread may take.
  // Every completion pays it: the acknowledgement and the opening thoughts.
  runtime.chatAnswer.delayMs = 1_500;
  runtime.chatAnswer.text = "Picking this up — reading the retry loop first.";

  // Measured across the POST, because the route awaits the whole dispatch —
  // so anything the dispatch waits for is time the browser spends blocked
  // before it can render anything at all.
  const startedAt = Date.now();
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: `@${name} rework the retry loop` },
  });
  const posted = Date.now() - startedAt;

  const listed = await owner.request(`${base}/messages`);
  assert.ok(
    (listed.data.messages as { kind: string }[]).some(
      (message) => message.kind === "agent",
    ),
    "the thread did not exist by the time the post returned",
  );
  // No completion's worth of waiting at all. Both model calls this dispatch
  // makes — the acknowledgement and the opening thoughts — now run behind the
  // response rather than in front of it, so a slow provider cannot be felt
  // here at all.
  assert.ok(
    posted < 1_000,
    `posting waited ${String(posted)}ms — it is still blocked on a model call`,
  );

  // And the composed sentence still arrives, in place, on the same message.
  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    return (listed.data.messages as { kind: string; content: string }[]).some(
      (message) =>
        message.kind === "agent" && message.content.startsWith("Picking this up"),
    );
  }, "the agent's own wording never replaced the placeholder");
});

test("the work is queued without waiting for the thread's opening thoughts", async (t) => {
  // The second half of the same complaint. `planOpening` is a model call
  // allowed two minutes, and the run used to start only after it returned —
  // so a thread could say it had picked something up while nothing ran.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic", visibility: "org" }]);
  const repositoryId = await invitableRepository(owner, "fast-start-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const agents = await owner.request(`${base}/agents`);
  const name = (agents.data.agents as { name: string }[])[0]?.name ?? "";

  runtime.chatAnswer.delayMs = 1_500;
  runtime.chatAnswer.text = "On it.";

  const startedAt = Date.now();
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: `@${name} rework the retry loop` },
  });
  await waitFor(
    async () => runtime.runCalls.length > 0,
    "the repository was never asked to run",
  );
  assert.ok(
    Date.now() - startedAt < 1_000,
    "starting the work waited on a model call rather than on none",
  );
});

test("an image in a request reaches the agent as a file it can open", async (t) => {
  // The point of attaching one. The channel writes `![alt](attachment:<id>)`,
  // which the dashboard turns into an <img> and an agent could only read as
  // punctuation — so the objective names the path instead, and the bytes are
  // already on the filesystem the task runs on.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic", visibility: "org" }]);
  const repositoryId = await invitableRepository(owner, "attachment-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const agents = await owner.request(`${base}/agents`);
  const name = (agents.data.agents as { name: string }[])[0]?.name ?? "";

  const id = "a".repeat(32) + ".png";
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: `@${name} fix the header spacing to match this ![screenshot](attachment:${id})`,
    },
  });

  await waitFor(async () => {
    const listed = await runtime.store.listSubmittedTasks({ repositoryId });
    return listed.length > 0;
  }, "the mention never became a task");
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  // The path the stub answers with, not the upload id.
  assert.match(task!.objective, /\/attachments\/a{32}\.png/u);
  assert.match(task!.objective, /open this file to see it/u);
  // And the markdown is gone, because an agent cannot do anything with it.
  assert.doesNotMatch(task!.objective, /attachment:/u);
});

test("an image the deployment cannot place is left as it was written", async (t) => {
  // A wrong path is worse than a visible id: one is a puzzle, the other is a
  // lie about a file. An unknown id keeps its reference.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic", visibility: "org" }]);
  const repositoryId = await invitableRepository(owner, "attachment-missing-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const agents = await owner.request(`${base}/agents`);
  const name = (agents.data.agents as { name: string }[])[0]?.name ?? "";

  const missing = "b".repeat(32) + ".png";
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: `@${name} update the button styling to match ![gone](attachment:${missing})`,
    },
  });

  await waitFor(async () => {
    const listed = await runtime.store.listSubmittedTasks({ repositoryId });
    return listed.length > 0;
  }, "the mention never became a task");
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.match(task!.objective, /attachment:b{32}\.png/u);
});

test("a thread opens while the agent is working, not once it has finished", async (t) => {
  // Reported as: threads do not appear until the task completes, which is
  // backwards for a room whose purpose is watching the work happen. The agent's
  // own progress message is the first thing about *this* run rather than about
  // every run, so it is what opens the thread — and the held preamble flushes
  // in above it.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic", visibility: "org" }]);
  const repositoryId = await invitableRepository(owner, "live-thread-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const agents = await owner.request(`${base}/agents`);
  const name = (agents.data.agents as { name: string }[])[0]?.name ?? "";

  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: `@${name} rework the retry loop` },
  });
  await waitFor(async () => {
    const listed = await runtime.store.listSubmittedTasks({ repositoryId });
    return listed.length > 0;
  }, "the mention never became a task");
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });

  // The run says what it is doing. Nothing has ended.
  await runtime.store.appendAudit(undefined, {
    type: "agent_progress",
    taskId: task!.id,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      message: "Reading retry.ts and mapping every caller",
    },
  });

  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    const thread = (listed.data.messages as { taskId?: string; replies: unknown[] }[])
      .find((message) => message.taskId === task!.id);
    const replies = (thread?.replies ?? []) as { content: string }[];
    return replies.some((reply) => reply.content.includes("mapping every caller"));
  }, "the thread stayed empty while the agent was working");
});

test("asking about work is not asking for it", () => {
  // The verb list carries past tenses — "changed", "fixed", "updated" — so a
  // question about work already done matched it and was dispatched as new
  // work. In a thread that meant checking out the repository and running a
  // whole task to answer three words, on somebody's own account.
  for (const question of [
    "which key changed?",
    "what did you fix?",
    "which files were updated?",
    "why was the retry loop removed?",
    "has anyone updated the readme?",
    "what is its default?",
  ]) {
    assert.equal(looksLikeTaskRequest(question), false, question);
  }

  // A question mark is grammar, not intent. Everything here still dispatches:
  // the polite interrogatives are imperatives, the last is a question with a
  // request stapled to it, and "handle" is present tense in a sentence that
  // asks for nothing already done.
  for (const request of [
    "can you fix the retry loop?",
    "could you add a hello to the readme?",
    "would you rename the auth module?",
    "please update the readme",
    "fix the login bug",
    "why not just delete that file?",
    "did you see the bug? fix it",
    "which key changed, and can you revert it?",
  ]) {
    assert.equal(looksLikeTaskRequest(request), true, request);
  }
});

test("/stop names one agent even with words after the name", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  const repositoryId = await invitableRepository(owner, "stop-named");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  // An agent nobody has renamed is "Claude (Nathan)" — a space and a bracket
  // inside the name, which is exactly what a first-word split would lose.
  const mention = `Claude (${String(session.user.displayName).split(" ")[0]})`;

  // Each of these is one person saying "stop that agent". Matching the whole
  // remainder against the roster meant everything but the bare name found
  // nobody and stopped nothing, while saying so in the channel.
  for (const [index, rest] of [
    `@${mention}`,
    `@${mention} please`,
    `@${mention}, that's wrong`,
  ].entries()) {
    const task = await runtime.store.submitTask({
      repositoryId,
      projectId: DEFAULT_PROJECT_ID,
      objective: `rework number ${index}`,
      // The fixture's `cancelTasks` matches a vendor-scoped stop against
      // `test-agent-<vendor>`; a name-targeted stop resolves to the claude
      // vendor, so this is the agent it has to be looking for.
      agentId: "test-agent-claude",
      validationCommands: [],
      submittedBy: ownerId,
    });
    const posted = await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: `/stop ${rest}` },
    });
    assert.equal(posted.status, 201, rest);
    await waitFor(async () => {
      const listed = await runtime.store.listSubmittedTasks({ repositoryId });
      return listed.find((entry) => entry.id === task.id)?.status === "cancelled";
    }, `"/stop ${rest}" did not stop the named agent`);
  }

  const said = (await owner.request(`${base}/messages`)).data.messages
    .map((message: any) => String(message.content))
    .join("\n");
  assert.doesNotMatch(said, /Nobody here answers/u);
});

test("an unnamed request is offered before it is started, and yes starts it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "offer-first");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "please update the settings page layout" },
  });
  assert.equal(posted.status, 201);
  // Nothing has run. Choosing the agent is a guess, and a wrong guess costs a
  // checkout, a run and somebody's usage; a slow one costs a word.
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const offered = await owner.request(`${base}/messages`);
  // In the agent's own voice, not the channel's: it is the one being asked,
  // and the author line is how a reader sees whose usage this would spend.
  const offer = (offered.data.messages as any[]).find(
    (message) => message.kind === "agent",
  );
  assert.ok(offer !== undefined, JSON.stringify(offered.data.messages));
  assert.match(offer.content, /Want me to take this, Owner\?/u);
  assert.match(offer.content, /Say "yes"/u);
  assert.match(offer.content, /@mention someone else/u);

  const agreed = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "yes" },
  });
  assert.equal(agreed.status, 201);
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  // The sender's own words are the objective, not "yes".
  assert.match(
    String(runtime.submittedTasks[0]?.objective),
    /settings page layout/u,
  );
});

test("a proactive offer reads lean channel context and carries it into accepted work", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "offer-context");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // More than the bound, so this proves the model gets the nearby exchange
  // rather than the whole room. Stored directly because these are setup
  // conversation lines, not requests whose dispatch behaviour is under test.
  for (let index = 0; index < 10; index += 1) {
    await runtime.store.appendChannelMessage({
      repositoryId,
      projectId: DEFAULT_PROJECT_ID,
      kind: "user",
      authorId: ownerId,
      content: `context marker ${index}: checkout flow detail`,
    });
  }

  const request = "please fix that flow";
  const before = runtime.chatPrompts.length;
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: request },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  const classification = runtime.chatPrompts.slice(before).at(-1)?.prompt ?? "";
  assert.match(classification, /Recent channel context before this request/u);
  assert.doesNotMatch(classification, /context marker 1:/u);
  assert.match(classification, /context marker 2:/u);
  assert.match(classification, /context marker 9:/u);
  assert.ok(
    classification.indexOf("context marker 9:") <
      classification.indexOf("Current message:"),
    classification,
  );
  assert.equal(
    classification.match(/please fix that flow/gu)?.length,
    1,
    "the current request should be classified once, outside the background",
  );

  const offered = await owner.request(`${base}/messages`);
  const offer = (offered.data.messages as any[]).find((message) =>
    /^Want me to take this/u.test(String(message.content)),
  );
  assert.ok(offer !== undefined, JSON.stringify(offered.data.messages));
  assert.match(String(offer.content), /Want me to take this, Owner\?/u);

  const agreed = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "yes" },
  });
  assert.equal(agreed.status, 201, JSON.stringify(agreed.data));
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  const task = runtime.submittedTasks[0];
  assert.match(String(task?.objective), /please fix that flow/u);
  const context = task?.context ?? "";
  assert.doesNotMatch(context, /context marker 1:/u);
  assert.match(context, /context marker 2:/u);
  assert.match(context, /context marker 9:/u);
  assert.doesNotMatch(context, /please fix that flow/u);
  assert.doesNotMatch(context, /Want me to take this/u);
  assert.doesNotMatch(context, /\byes\b/iu);
});

test("a generic proactive follow-up uses recent context to choose its agent", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "offer-context-route");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const settings = await addColleague(runtime, "context-settings@example.com");
  const database = await addColleague(runtime, "context-database@example.com");
  runtime.chatConnections.set(settings.id, [
    { provider: "openai", visibility: "org" },
  ]);
  runtime.chatConnections.set(database.id, [
    { provider: "google", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // The unrelated agent has the longer name and therefore wins the stable
  // zero-score fallback. Only the preceding database discussion can make the
  // database agent the better fit for the deliberately generic request.
  assert.equal(
    (await owner.request(`${base}/agents/${settings.id}:openai`, {
      method: "POST",
      body: { name: "Settings Page Layout Frontend Accessibility Assistant" },
    })).status,
    200,
  );
  assert.equal(
    (await owner.request(`${base}/agents/${database.id}:google`, {
      method: "POST",
      body: { name: "Database Migration Agent" },
    })).status,
    200,
  );
  await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "user",
    authorId: bootstrapped.user.id,
    content: "The billing database migration keeps failing in CI.",
  });

  await autoClaim(owner, base, "please fix that");

  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  assert.equal(runtime.submittedTasks[0]?.actorId, database.id);
  assert.equal(runtime.submittedTasks[0]?.vendor, "gemini");
  assert.match(
    runtime.submittedTasks[0]?.context ?? "",
    /billing database migration keeps failing/u,
  );

  // Context is only the fallback for a generic request. Once the current
  // message names a lane, its own words win over the database discussion.
  await autoClaim(owner, base, "please update the settings page layout");
  assert.equal(runtime.submittedTasks.length, 2);
  assert.equal(runtime.submittedTasks[1]?.actorId, settings.id);
  assert.equal(runtime.submittedTasks[1]?.vendor, "codex");
});

test("only the person who asked can accept the offer", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "offer-mine");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  const teammate = await runtime.store.createUser({
    email: "offer-mine-colleague@example.com",
    displayName: "Colleague Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: teammate.id,
    role: "developer",
  });
  const colleague = new TestClient(runtime.origin);
  await colleague.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: teammate.email, password: PASSWORD },
  });
  await joinAllConnectedAgents(runtime, repositoryId);

  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "please update the settings page layout" },
  });
  assert.equal(runtime.submittedTasks.length, 0);

  // "yes" is a common word in a busy channel, and the pick was made on the
  // question of whose account pays. Somebody else agreeing is not that person
  // agreeing.
  const theirs = await colleague.request(`${base}/messages`, {
    method: "POST",
    body: { content: "yes" },
  });
  assert.equal(theirs.status, 201);
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));

  const mine = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "yes" },
  });
  assert.equal(mine.status, 201);
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
});

test("a remark about work is not a request, and is offered nothing", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "not-a-request");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Every one of these is about work and asks for none. The verb list alone
  // could not tell them from an instruction, which is why the unnamed path
  // wants an imperative or a phrase handing the work over.
  for (const remark of [
    "the retry loop was rewritten last week",
    "I updated the readme this morning",
    "we should probably refactor this at some point",
    "that migration broke the build yesterday",
  ]) {
    const posted = await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: remark },
    });
    assert.equal(posted.status, 201, remark);
  }
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const after = await owner.request(`${base}/messages`);
  const offers = (after.data.messages as any[]).filter(
    (message) =>
      message.kind === "agent" &&
      /Want me to take this/u.test(message.content),
  );
  assert.deepEqual(offers, [], JSON.stringify(offers));
});

test("a revert reports that it worked, and takes the thread's file list back with it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "revert-files");
  const landed = "b".repeat(40);
  const before = "a".repeat(40);

  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "rework the retry loop",
    agentId: "anthropic",
    validationCommands: [],
    submittedBy: ownerId,
  });
  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: task.id,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      previousRevision: before,
      revision: landed,
      files: ["src/retry.ts"],
    },
  });
  runtime.canonicalState.head = landed;
  // What the summary backfill rebuilds from. Without this the durability
  // assertion below passes whether or not the revert is respected, because
  // there would be nothing to rebuild the list out of.
  await runtime.store.appendAudit(undefined, {
    type: "workspace_changed",
    taskId: task.id,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      changedFiles: [{ path: "src/retry.ts", status: "modified" }],
    },
  });

  // The thread this work was narrated in, carrying the file summary a reader
  // sees under it.
  const thread = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it.",
  });
  await runtime.store.setChannelMessageTask(repositoryId, thread.id, task.id);
  await runtime.store.setChannelMessageChangedFiles(repositoryId, thread.id, [
    { path: "src/retry.ts", status: "modified" },
  ]);

  const reverted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/rollback`,
    { method: "POST", body: { taskId: task.id } },
  );
  assert.equal(reverted.status, 200, JSON.stringify(reverted.data));
  // The one status that means it happened. Everything else — conflict,
  // validation_failed, stale, empty — is a revert that did not.
  assert.equal(reverted.data.rollback.status, "integrated");
  // Back to the state before this task, not to some other revision.
  assert.equal(runtime.rollbacks.at(-1)?.targetRevision, before);

  // And the thread stops claiming the file it no longer changes. The stores
  // normalise an empty list to "nothing recorded", so this reads back as
  // absent rather than as an empty array.
  const after = await runtime.store.getChannelMessage(
    repositoryId,
    thread.id,
    ownerId,
  );
  assert.equal(after?.changedFiles, undefined);

  // And it stays gone across a channel read. A thread with no file list is
  // what the summary backfill goes looking for, and the events it rebuilds
  // from are the very ones this revert undid.
  //
  // Honest about its own strength: the backfill needs line counts this
  // fixture cannot produce, so it currently writes nothing here either way —
  // disabling the `task_reverted` guard does not fail this assertion. It is a
  // regression guard, not a proof: if the rebuild ever starts working in this
  // fixture, or somebody removes the guard *and* fixes the counts, the file
  // comes back and this catches it.
  const listed = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages`,
  );
  assert.equal(listed.status, 200);
  const rebuilt = (listed.data.messages as any[]).find(
    (message) => message.id === thread.id,
  );
  assert.equal(
    rebuilt?.changedFiles ?? undefined,
    undefined,
    JSON.stringify(rebuilt?.changedFiles),
  );
});

test("a revert that fails validation is not reported as one that worked", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "revert-refused");
  const landed = "d".repeat(40);

  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "rework the retry loop",
    agentId: "anthropic",
    validationCommands: [],
    submittedBy: ownerId,
  });
  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: task.id,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      previousRevision: "c".repeat(40),
      revision: landed,
      files: ["src/retry.ts"],
    },
  });
  runtime.canonicalState.head = landed;

  const thread = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it.",
  });
  await runtime.store.setChannelMessageTask(repositoryId, thread.id, task.id);
  await runtime.store.setChannelMessageChangedFiles(repositoryId, thread.id, [
    { path: "src/retry.ts", status: "modified" },
  ]);

  runtime.setRollbackOutcome({
    status: "validation_failed",
    explanation: "The tests do not pass on the older tree",
  });
  const refused = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/rollback`,
    { method: "POST", body: { taskId: task.id } },
  );
  assert.equal(refused.status, 200);
  assert.equal(refused.data.rollback.status, "validation_failed");

  // Nothing was put back, so the thread still reports what this task changed.
  // Clearing it here would tell a reader the files are safe when they are not.
  const after = await runtime.store.getChannelMessage(
    repositoryId,
    thread.id,
    ownerId,
  );
  assert.deepEqual(after?.changedFiles, [
    { path: "src/retry.ts", status: "modified" },
  ]);
});

test("the agent reads the message before offering, and a remark gets no offer", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "reads-first");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Half the work vocabulary is also ordinary nouns, so no word list tells
  // "update the readme" from "the update went out". These clear the free
  // checks and are still not requests; the agent that would take them is
  // asked, and says no.
  runtime.setTaskClassification("no");
  const before = runtime.chatPrompts.length;
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "please update the settings page layout" },
  });
  assert.equal(posted.status, 201);

  // It was read — one prompt, and it asked the question this gate asks.
  const asked = runtime.chatPrompts.slice(before);
  assert.equal(asked.length, 1, JSON.stringify(asked));
  assert.match(String(asked[0]?.prompt), /Answer with one word: yes or no/u);
  assert.match(String(asked[0]?.prompt), /settings page layout/u);

  // And nothing was offered or started.
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const after = await owner.request(`${base}/messages`);
  assert.deepEqual(agentSpeech(after.data.messages), []);
  assert.deepEqual(
    (after.data.messages as any[]).filter((message) =>
      /Want me to take this/u.test(String(message.content)),
    ),
    [],
  );
});

test("a remark that opens with a noun from the verb list is never read at all", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "free-checks-first");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // The reason the word list stays in front of the model: these cost nothing
  // to refuse, and a channel that is only talking must not spend an account
  // per sentence to find that out. "Changes look good" opens with a word from
  // the verb list and is a person saying the changes look good.
  const before = runtime.chatPrompts.length;
  for (const remark of [
    "Changes have been made and look good",
    "Changes look good",
    "Yo what's up",
    "the update went out this morning",
    "the build is fixed now",
  ]) {
    const posted = await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: remark },
    });
    assert.equal(posted.status, 201, remark);
  }
  assert.deepEqual(
    runtime.chatPrompts.slice(before),
    [],
    "no agent was asked about any of these",
  );
  assert.equal(runtime.submittedTasks.length, 0);
});

test("a thread opens on the request that caused it, in the words it was asked in", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  const repositoryId = await invitableRepository(owner, "thread-opener");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const agents = await owner.request(`${base}/agents`);
  const name = (agents.data.agents as { name: string }[])[0]?.name ?? "";
  const asked = `@${name} rework the retry loop`;

  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: asked },
  });
  await waitFor(async () => {
    const listed = await runtime.store.listSubmittedTasks({ repositoryId });
    return listed.length > 0;
  }, "the mention never became a task");
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });

  // Held until here, deliberately: posting it at dispatch would open a thread
  // for every task, and a task small enough to finish without narrating
  // itself is meant to stay two lines in the room.
  const beforeNarration = await owner.request(`${base}/messages`);
  const quiet = (beforeNarration.data.messages as any[]).find(
    (message) => message.taskId === task!.id,
  );
  assert.deepEqual(quiet?.replies ?? [], [], "no thread before there is news");

  await runtime.store.appendAudit(undefined, {
    type: "agent_progress",
    taskId: task!.id,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      message: "Reading retry.ts and mapping every caller",
    },
  });

  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    const thread = (listed.data.messages as any[]).find(
      (message) => message.taskId === task!.id,
    );
    return ((thread?.replies ?? []) as any[]).some((reply) =>
      String(reply.content).includes("mapping every caller"),
    );
  }, "the run never narrated");

  const listed = await owner.request(`${base}/messages`);
  const thread = (listed.data.messages as any[]).find(
    (message) => message.taskId === task!.id,
  );
  const replies = (thread?.replies ?? []) as any[];
  // First, and attributed to the person who asked rather than to the agent —
  // opening a thread showed the work with no visible cause before this.
  assert.equal(replies[0]?.kind, "user", JSON.stringify(replies));
  assert.equal(replies[0]?.content, asked);
  assert.equal(replies[0]?.authorId, ownerId);
});

test("work merged into an existing thread says what asked for it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  const repositoryId = await invitableRepository(owner, "thread-merge-opener");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  // A thread that already exists, with a task hanging off it.
  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it.",
  });
  const agents = await owner.request(`${base}/agents`);
  const name = (agents.data.agents as { name: string }[])[0]?.name ?? "";
  const asked = `@${name} and also raise the retry ceiling`;

  await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: asked } },
  );

  // Asked inside the thread, so it is a reply and is in there by definition —
  // the dispatch must not post a second copy of it.
  await waitFor(async () => {
    const thread = await runtime.store.getChannelMessage(
      repositoryId,
      root.id,
      ownerId,
    );
    return (thread?.replies ?? []).some(
      (reply) => reply.content === asked && reply.kind === "user",
    );
  }, "the request never landed in the thread");
  const thread = await runtime.store.getChannelMessage(
    repositoryId,
    root.id,
    ownerId,
  );
  assert.equal(
    (thread?.replies ?? []).filter((reply) => reply.content === asked).length,
    1,
    JSON.stringify(thread?.replies),
  );
});

test("deleting your own channel message removes it, and somebody else's does not", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "deletable");
  const guest = await joinRepository(
    runtime,
    owner,
    "guest@example.com",
    repositoryId,
  );
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const posted = await guest.request(`${base}/messages`, {
    method: "POST",
    body: { content: "A thought, quickly regretted." },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const messageId = posted.data.message.id;

  // The guest is a developer: in the room, and no reach over anybody else's
  // words in it. The owner's line is the owner's to unsay.
  const owners = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "The owner's own line." },
  });
  const guestTryingOwners = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages/${owners.data.message.id}`,
    { method: "DELETE" },
  );
  assert.equal(
    guestTryingOwners.status,
    403,
    JSON.stringify(guestTryingOwners.data),
  );

  // The author's own goes outright — nothing hangs off it.
  const removed = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages/${messageId}`,
    { method: "DELETE" },
  );
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(removed.data.redacted, false);
  assert.equal(removed.data.cancelledTask, false);
  assert.equal(
    await runtime.store.getChannelMessage(
      repositoryId,
      messageId,
      session.user.id,
    ),
    undefined,
  );

  // Gone is gone: a second delete has nothing to find.
  const again = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages/${messageId}`,
    { method: "DELETE" },
  );
  assert.equal(again.status, 404, JSON.stringify(again.data));

  // And a manager reaches anybody's — the other half of the rule.
  const guestsSecond = await guest.request(`${base}/messages`, {
    method: "POST",
    body: { content: "Something for a moderator to remove." },
  });
  const moderated = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages/${guestsSecond.data.message.id}`,
    { method: "DELETE" },
  );
  assert.equal(moderated.status, 200, JSON.stringify(moderated.data));
  assert.equal(
    await runtime.store.getChannelMessage(
      repositoryId,
      guestsSecond.data.message.id,
      session.user.id,
    ),
    undefined,
  );
});

test("deleting a message that carries a thread blanks it and stops its task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repositoryId = await invitableRepository(owner, "thread-delete");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "Rename the config key everywhere." },
  });
  const messageId = posted.data.message.id;
  const reply = await owner.request(
    `${base}/messages/${messageId}/replies`,
    { method: "POST", body: { content: "On it." } },
  );
  assert.equal(reply.status, 201, JSON.stringify(reply.data));

  const task = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId,
    objective: "rename the config key",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: ownerId,
  });
  await runtime.store.setChannelMessageTask(repositoryId, messageId, task.id);

  const removed = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages/${messageId}`,
    { method: "DELETE" },
  );
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  // Blanked rather than removed: the reply under it is somebody's reading.
  assert.equal(removed.data.redacted, true);
  assert.equal(removed.data.removed, 0);
  // And the work it asked for was stopped, because the message was the ask.
  assert.equal(removed.data.cancelledTask, true);
  assert.equal(
    runtime.cancelCalls.some((call) => call.taskIds?.includes(task.id)),
    true,
    JSON.stringify(runtime.cancelCalls),
  );

  const tombstone = await runtime.store.getChannelMessage(
    repositoryId,
    messageId,
    ownerId,
  );
  assert.equal(tombstone?.content, "");
  assert.ok(tombstone?.deletedAt !== undefined);
  assert.equal(tombstone?.deletedBy, ownerId);
  assert.equal(
    (tombstone?.replies ?? []).some(
      (entry) => entry.id === reply.data.reply.id,
    ),
    true,
  );

  // The reply is its own decision, and its own delete. The tombstone stays:
  // the two are separate rows and separate asks.
  const replyGone = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages/${messageId}/replies/${reply.data.reply.id}`,
    { method: "DELETE" },
  );
  assert.equal(replyGone.status, 200, JSON.stringify(replyGone.data));
  const after = await runtime.store.getChannelMessage(
    repositoryId,
    messageId,
    ownerId,
  );
  assert.equal(
    (after?.replies ?? []).some((entry) => entry.id === reply.data.reply.id),
    false,
  );
  assert.ok(after?.deletedAt !== undefined);

  // `?purge=1` is the thread panel's own delete: the whole thread goes,
  // replies included, which is what that button has always promised.
  const second = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "A second thread." },
  });
  const secondId = second.data.message.id;
  await owner.request(`${base}/messages/${secondId}/replies`, {
    method: "POST",
    body: { content: "With something under it." },
  });
  const purged = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages/${secondId}?purge=1`,
    { method: "DELETE" },
  );
  assert.equal(purged.status, 200, JSON.stringify(purged.data));
  assert.equal(purged.data.redacted, false);
  assert.equal(
    await runtime.store.getChannelMessage(repositoryId, secondId, ownerId),
    undefined,
  );
});

test("a direct message can be unsent by its sender and nobody else", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "dm-delete");
  const guest = await joinRepository(
    runtime,
    owner,
    "dm-guest@example.com",
    repositoryId,
  );
  const guestId = (await guest.request("/api/v1/auth/me")).data.user.id;

  const sent = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${guestId}`,
    { method: "POST", body: { content: "Sent too soon." } },
  );
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  const messageId = sent.data.message.id;

  // The recipient cannot unsend what they did not send.
  const refused = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${session.user.id}/messages/${messageId}`,
    { method: "DELETE" },
  );
  assert.equal(refused.status, 404, JSON.stringify(refused.data));

  const removed = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${guestId}/messages/${messageId}`,
    { method: "DELETE" },
  );
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  // Gone for both sides, because both sides are the whole audience.
  assert.deepEqual(
    await runtime.store.listDirectMessages(
      DEFAULT_PROJECT_ID,
      guestId,
      session.user.id,
    ),
    [],
  );
});
