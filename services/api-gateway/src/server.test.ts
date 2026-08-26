import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
} from "node:http";
import net from "node:net";
import { createHmac } from "node:crypto";
import test, { type TestContext } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
  InMemoryCoordinationStore,
  type CoordinationStore,
} from "@coord/persistence";

import { AGENT_ACCOUNT_PREFIX } from "@coord/shared-types";

import type { StripeClient } from "./stripe.js";
import { effectiveRole, subscriptionAllowsWork } from "./billing.js";

import {
  agentIdentity,
  ApiGateway,
  autoClaimProposal,
  describeTaskState,
  elidedHistoryNotice,
  estimateTokens,
  explainAnswerFailure,
  isLoopbackCallback,
  looksLikeTaskRequest,
  narrateTaskEvent,
  normaliseThreadTitle,
  parseAnswerTaskDirective,
  parseAutoClaimVerdict,
  readsAsEchoOfRequest,
  reportedFreshTokens,
  requestFromObjective,
  selectChannelMemo,
  selectThreadContext,
  summariseAuditData,
  summariseChannelThread,
  summariseObjective,
  summariseThreadTitle,
  textOverlap,
  truncateToTokens,
  withRoleContext,
  type ApiOperations,
  type ChannelMemoThread,
} from "./server.js";
import { hashPassword, hashSecret } from "./auth.js";
import { createMailer, type MailMessage, type Mailer } from "./mailer.js";
import type { CodexUsageReader } from "./codex-subscription-usage.js";
import type { CatchUpSummariser } from "./catch-up.js";

const BOOTSTRAP_TOKEN = "bootstrap-token-with-at-least-24-characters";
const PASSWORD = "RelayPassword123!";

// Keep registration explicit for fixtures so a caller's environment cannot
// change their result. The test that pins the product default clears it for
// its own runtime.
process.env["COORD_ALLOW_REGISTRATION"] = "1";
// The mailed-code step is off by default in the product. The fixtures below
// exercise it, so they ask for it explicitly; the test that pins the default
// clears it for its own runtime.
process.env["COORD_REQUIRE_EMAIL_CONFIRMATION"] = "1";

interface TestRuntime {
  gateway: ApiGateway;
  store: CoordinationStore;
  origin: string;
  port: number;
  /** Every message accepted by the gateway's in-memory test mailer. */
  mail: MailMessage[];
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
   * Every call the fake `syncRepository` operation reached, in order. A route
   * that authorizes badly is only visible here: the refusal has to happen
   * before the operation, because the operation resolves a repository id
   * globally and would happily move somebody else's mirror.
   */
  syncCalls: Array<{ projectId: string; repositoryId: string; actorId: string }>;
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
    /** Whether the dispatch asked to follow this agent's active work. */
    queueAfterCurrent?: boolean;
    /** What the channel picked for this agent, if it picked anything. */
    model?: string;
    effort?: string;
  }>;
  /** Every direct canonical push requested through the channel command. */
  pushCalls: Array<{
    projectId: string;
    repositoryId: string;
    actorId: string;
  }>;
  /**
   * Every prompt the fake `complete` was asked, and what it should answer —
   * for asserting that a follow-up in a thread reaches the agent at all, and
   * that the thread's own history goes with it.
   */
  chatPrompts: Array<{
    userId: string;
    provider: string;
    prompt: string;
    repositoryId?: string;
  }>;
  chatAnswer: {
    text?: string;
    /** A channel-answer reply when it needs routing syntax of its own. */
    channelAnswerText?: string;
    fail?: string;
    delayMs?: number;
    streamEvents?: Array<Record<string, unknown>>;
    thinking?: string;
    thinkingHidden?: boolean;
    thinkingTokens?: number;
  };
  /** Provider usage returned before the Codex live-snapshot fallback. */
  providerUsage: Map<string, unknown>;
  /** Usage calls, so a live lookup can be shown to leave recorded data first. */
  usageCalls: string[];
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
  /**
   * What the local pass says about a message, before any agent is asked.
   *
   * Defaults to "not sure about anything", which is the answer that changes
   * nothing: every message goes on to the agent, exactly as it did before
   * there was a local pass. A test about the filter says otherwise.
   */
  setLocalChatter: (reads: (text: string) => boolean) => void;
  /**
   * Holds every classify call open until the test releases it — a stand-in
   * for the case this fixture cannot otherwise reach: a real CLI spin-up
   * contending with another process on the same host for however long that
   * takes. Undefined answers immediately, which is every other test's
   * default.
   */
  setClassifyGate: () => { release: () => void };
  /**
   * Makes the next `count` classify calls answer with nothing, as a timeout
   * or an unreachable CLI would. Calls after that answer normally again.
   */
  setClassifyFailures: (count: number) => void;
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

/**
 * Stands in for the dashboard's JavaScript: text, and large enough that
 * compressing it is worth the header it costs.
 */
const SCRIPT_ASSET = `export const screens = ${JSON.stringify(
  Array.from({ length: 400 }, (_, index) => `screen-${index}`),
)};\n`.repeat(4);

/** The digest a build would put in that module's name. */
const SCRIPT_DIGEST = "0123456789ab";

/**
 * One static request, made with `http` rather than `fetch` so the test decides
 * what it accepts and reads what comes back byte for byte. `fetch` rewrites
 * `Accept-Encoding` and silently decompresses, which hides the two things
 * these tests are about.
 */
async function fetchAsset(
  origin: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${path}`, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
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
     * How often finished threads and stale plan holds are swept. Tests that
     * are about the sweep cannot wait out the production minute.
     */
    threadReconcileIntervalMs?: number;
    /** How long a held `/plan` waits before it lapses. */
    planHoldTtlMs?: number;
    codexUsageReader?: CodexUsageReader;
    /**
     * Stands in for Stripe, so a test can watch what the seat count does to
     * a live subscription. Absent for every other test, which is also what a
     * deployment without billing configured looks like.
     */
    stripe?: StripeClient;
    /**
     * Drops the optional `listAgents` operation, as a deployment that does
     * not implement it does — the fallback path for anything that joins
     * tasks to configured agents.
     */
    withoutListAgents?: boolean;
    /** Drops direct push support, as an older or limited deployment may. */
    withoutPushRepository?: boolean;
    /**
     * Writes the catch-up's prose, standing in for the local model.
     *
     * Defaults to one that answers nothing, which is both what a machine
     * without the model does and what keeps every other test in this file
     * from loading one to prove something unrelated.
     */
    catchUpSummariser?: CatchUpSummariser;
    /** Writes thread names without loading the real local model in tests. */
    threadTitleSummariser?: CatchUpSummariser;
    /** The direct push result returned to the channel. */
    pushOutcome?: {
      outcome: "done" | "refused";
      detail?: {
        url?: string;
        output?: string[];
        syncConflict?: true;
        conflicts?: string[];
      };
      explanation: string;
    };
    /** Consecutive direct push results, for a conflict followed by its retry. */
    pushOutcomes?: Array<{
      outcome: "done" | "refused";
      detail?: {
        url?: string;
        output?: string[];
        syncConflict?: true;
        conflicts?: string[];
      };
      explanation: string;
    }>;
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
  const pushCalls: TestRuntime["pushCalls"] = [];
  const syncCalls: TestRuntime["syncCalls"] = [];
  const pushOutcomes = [...(options.pushOutcomes ?? [])];
  const chatPrompts: TestRuntime["chatPrompts"] = [];
  const chatAnswer: TestRuntime["chatAnswer"] = {};
  const providerUsage: TestRuntime["providerUsage"] = new Map();
  const usageCalls: TestRuntime["usageCalls"] = [];
  const mail: TestRuntime["mail"] = [];
  /** How the agent answers "is this work?" — "yes" unless a test says else. */
  // The unnamed path now asks for a decision, not a yes/no: ACT, OFFER with
  // a proposal, or IGNORE. The default keeps the offer flow every dispatch
  // test was written against, and the proposal is worded the way the fixed
  // sentence used to be so those assertions still describe what is posted.
  let taskClassification = "OFFER: Want me to take this on?";
  // The real filter loads a 22 MB model. Every test that is not about the
  // filter gets one that decides nothing, which is also the honest default:
  // "unsure" is what it answers for anything it is not certain about.
  let localChatter: (text: string) => boolean = () => false;
  // A gate a test can hold shut, so a classify call takes real, controllable
  // time rather than always resolving on the same tick every other test
  // relies on.
  let classifyGate: Promise<void> | undefined;
  let classifyFailuresRemaining = 0;
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
      ...(input?.repositoryId === undefined
        ? {}
        : { repositoryId: String(input.repositoryId) }),
    });
    // The unnamed path asks the agent what to do about a message before it
    // does anything. Answered here rather than through `chatAnswer` so a test
    // about dispatch does not have to know the question exists; a test about
    // the decision itself sets `taskClassification`.
    if (/Reply with exactly one of these three lines/u.test(asked)) {
      if (classifyGate !== undefined) {
        await classifyGate;
      }
      if (classifyFailuresRemaining > 0) {
        classifyFailuresRemaining -= 1;
        // Empty, not missing: this is the exact shape `askAgent` sees from a
        // real provider that answered with nothing, which is what a timeout
        // or an unreachable CLI looks like once it reaches this layer.
        return { text: "" };
      }
      // An acknowledgement is never work, and a fake that answered otherwise
      // would be unfaithful in the one way that matters: with no word list in
      // front of it, every "yes", "ok" and "thanks" in a channel now reaches
      // the model, and a model reads those for what they are.
      const current = /Current message: ([\s\S]*)$/u.exec(asked)?.[1] ?? "";
      if (
        /^\s*(yes|yeah|yep|ok|okay|sure|thanks|thx|no|nope)\b[\s!.,?]*$/iu.test(
          current,
        )
      ) {
        return { text: "IGNORE" };
      }
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
    const responseText =
      /This final line is private routing data/u.test(asked)
        ? (chatAnswer.channelAnswerText ?? chatAnswer.text)
        : chatAnswer.text;
    return {
      ...(responseText === undefined ? {} : { text: responseText }),
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
      async usage(input) {
        usageCalls.push(input.provider);
        return providerUsage.get(input.provider) ?? {};
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
    async syncRepository(input) {
      syncCalls.push({
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        actorId: input.actorId,
      });
      return {
        status: "already_current" as const,
        remoteUrl: "https://github.com/coord/example.git",
        upstreamBranch: "main",
        upstreamRevision: "rev1",
        previousRevision: "rev1",
        revision: "rev1",
      };
    },
    async pushRepository(input) {
      pushCalls.push(input);
      return (
        pushOutcomes.shift() ??
        options.pushOutcome ?? {
          outcome: "done",
          explanation: "Pushed canonical to coord/export-test on GitHub.",
        }
      );
    },
    async submitTask(input) {
      const agentId =
        input.agentId ??
        (input.vendor === undefined
          ? "test-agent"
          : `test-agent-${input.vendor}`);
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
        ...(input.queueAfterCurrent === undefined
          ? {}
          : { queueAfterCurrent: input.queueAfterCurrent }),
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
        agentId,
        validationCommands: [],
        submittedBy: input.actorId,
        ...(input.queueAfterCurrent === true
          ? { queueAfterCurrent: true }
          : {}),
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
  if (options.withoutPushRepository === true) {
    delete operations.pushRepository;
  }
  const gateway = new ApiGateway({
    store,
    operations,
    bootstrapToken: BOOTSTRAP_TOKEN,
    chatterFilter: {
      readsAsChatter: async (text: string) => localChatter(text),
      available: async () => true,
    },
    catchUpSummariser: options.catchUpSummariser ?? (async () => undefined),
    threadTitleSummariser:
      options.threadTitleSummariser ?? (async () => undefined),
    mailer: async (message) => {
      mail.push(message);
    },
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
    ...(options.threadReconcileIntervalMs === undefined
      ? {}
      : { threadReconcileIntervalMs: options.threadReconcileIntervalMs }),
    ...(options.planHoldTtlMs === undefined
      ? {}
      : { planHoldTtlMs: options.planHoldTtlMs }),
    ...(options.codexUsageReader === undefined
      ? {}
      : { codexUsageReader: options.codexUsageReader }),
    ...(options.stripe === undefined ? {} : { stripe: options.stripe }),
    staticAssets: new Map([
      [
        "/index.html",
        { body: "<!doctype html><title>Relay</title>", contentType: "text/html" },
      ],
      // A module big enough to be worth compressing, under both the stable
      // name and the digested one the document actually points at.
      ["/app.js", { body: SCRIPT_ASSET, contentType: "text/javascript" }],
      [
        `/app.${SCRIPT_DIGEST}.js`,
        {
          body: SCRIPT_ASSET,
          contentType: "text/javascript",
          immutable: true,
        },
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
    mail,
    chatConnections,
    submittedTasks,
    pushCalls,
    syncCalls,
    chatPrompts,
    chatAnswer,
    providerUsage,
    usageCalls,
    canonicalDiffs,
    rollbacks,
    setRollbackOutcome: (outcome) => {
      rollbackOutcome = outcome;
    },
    setTaskClassification: (answer) => {
      taskClassification = answer;
    },
    setLocalChatter: (reads) => {
      localChatter = reads;
    },
    setClassifyGate: () => {
      let release: () => void = () => undefined;
      classifyGate = new Promise((resolve) => {
        release = () => {
          classifyGate = undefined;
          resolve();
        };
      });
      return { release };
    },
    setClassifyFailures: (count) => {
      classifyFailuresRemaining = count;
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

function registrationCode(message: MailMessage | undefined): string {
  return /\b([0-9]{6})\b/u.exec(message?.text ?? "")?.[1] ?? "";
}

/**
 * A second person with an account and a session.
 *
 * It used to drive the public registration routes. Those are retired — an
 * account takes a card now — and every test below wanted the same thing from
 * them, which was somebody other than the owner who exists and is signed in.
 * So it provisions directly and signs in, which is also what accepting an
 * invitation does: `createUser` then a session, no checkout involved.
 *
 * Anything actually testing how accounts are created belongs on the paid
 * sign-up, which has its own tests.
 */
async function registerAccount(
  store: CoordinationStore,
  client: TestClient,
  body: Record<string, unknown>,
): Promise<{ status: number; data: any; headers: Headers }> {
  const email = String(body["email"] ?? "").trim().toLowerCase();
  const displayName = String(body["displayName"] ?? "");
  const user = await store.createUser({
    email,
    displayName,
    passwordDigest: await hashPassword(String(body["password"] ?? "")),
    systemAdmin: false,
  });
  // The same home registration used to build, because that is what the tests
  // below are relying on: their own team, a project to put a repository in,
  // and an entitlement, since a missing subscription row is no longer read as
  // a trial.
  const organization = await store.createOrganization({
    slug: `team-${user.id.replace(/^user_/u, "").slice(0, 12)}`,
    name:
      String(body["organizationName"] ?? "") !== ""
        ? String(body["organizationName"])
        : `${displayName}'s team`,
  });
  await store.saveMembership({
    organizationId: organization.id,
    userId: user.id,
    role: "owner",
  });
  await store.createProject({
    organizationId: organization.id,
    slug: "default",
    name: "My Project",
    description: "Repositories you create live here.",
  });
  await store.saveSubscription({
    organizationId: organization.id,
    status: "trialing",
    trialEndsAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  });
  const signedIn = await client.request("/api/v1/auth/login", {
    method: "POST",
    body: { email, password: String(body["password"] ?? "") },
  });
  // Answered 201 the way the registration route did, so callers that assert
  // on the status keep reading as they did.
  return { ...signedIn, status: signedIn.status === 200 ? 201 : signedIn.status };
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
  assert.deepEqual(
    me.data.slashCommands.map((command: { name: string }) => command.name),
    [
      "plan",
      "queue",
      "ask",
      "dnc",
      "simple",
      "push",
      "retry",
      "cancel",
      "stop",
      "help",
    ],
  );

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
  // A desktop shell cannot put a token on an `<img>` tag, so it fetches
  // attachments the way it fetches everything else and hands the element an
  // object URL. Tightening this back to `img-src 'self' data:` would leave
  // every image in the app broken, and nothing would say why.
  assert.equal(
    staticPage.headers.get("content-security-policy")?.includes("img-src 'self' data: blob:"),
    true,
  );
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
    requiredRole: "admin",
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

/**
 * A POST with no credential of any kind, standing in for an app that does not
 * have one yet.
 */
async function bareRequest(
  origin: string,
  path: string,
  body: unknown,
): Promise<{ status: number; data: any }> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    data: text.length === 0 ? undefined : JSON.parse(text),
  };
}

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

test("a task whose worker died stops being served as one still running", async (t) => {
  const { runtime, client, token } = await workerRuntime(t);
  const workerId = (
    await bearer(runtime.origin, "/api/v1/workers/register", token, {
      method: "POST",
      body: {
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "w",
        adapters: [],
        version: "1",
      },
    })
  ).data.id as string;

  await client.request(`/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`, {
    method: "POST",
    body: { id: "repo_sweep", branch: "main" },
  });
  await client.request(`/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks`, {
    method: "POST",
    body: { repositoryId: "repo_sweep", objective: "work on it" },
  });

  const leased = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  assert.equal(leased.status, 200, JSON.stringify(leased.data));
  const leaseId = leased.data.lease.id as string;

  // A live lease is untouched: reading the list must not reclaim work from a
  // worker that is still holding it.
  const held = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks`,
  );
  assert.equal(held.data.tasks[0].status, "claimed");

  // The worker dies. Its lease lapses where it lies, and every other caller
  // that would expire one is itself a worker route — so with the worker gone,
  // nothing ran, and the task stayed `claimed` forever. Everything that reads
  // it, from the browser's working dot to a status report, then said an agent
  // was running work that had stopped.
  await runtime.store.heartbeatWorkLease(
    leaseId,
    "2000-01-01T00:00:00.000Z",
    "2000-01-01T00:01:00.000Z",
  );

  const after = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks`,
  );
  assert.equal(after.status, 200);
  assert.equal(
    after.data.tasks[0].status,
    "submitted",
    "a lapsed lease should return its task to the queue before it is listed",
  );
  assert.equal((await runtime.store.getWorkLease(leaseId))?.status, "expired");
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

test("the catch-up says what changed while somebody was away, then clears", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "catch-up-repo");
  const catchUpPath = `/api/v1/projects/${DEFAULT_PROJECT_ID}/catch-up`;

  // Nobody's first sign-in has a "while you were away": handing somebody the
  // project's whole history the first time they arrive is not catching them
  // up on anything. It starts their clock instead, or the second visit would
  // have nothing to measure from either.
  const first = await owner.request(catchUpPath);
  assert.equal(first.status, 200);
  assert.equal(first.data.catchUp.empty, true);
  assert.deepEqual(first.data.catchUp.lines, []);
  assert.notEqual(
    await runtime.store.getCatchUpCursor(DEFAULT_PROJECT_ID, ownerId),
    undefined,
  );

  // Somebody who was here yesterday and has been away since.
  const colleague = await runtime.store.createUser({
    email: "catch-up-colleague@example.com",
    displayName: "Colleague",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: colleague.id,
    role: "developer",
  });
  await runtime.store.markCatchUpSeen(
    DEFAULT_PROJECT_ID,
    colleague.id,
    "2026-01-01T00:00:00.000Z",
  );

  await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "user",
    authorId: ownerId,
    content: "pushed the retry fix",
  });
  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "Fix the retry loop",
    agentId: "codex",
    validationCommands: [],
  });
  await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
  await runtime.store.completeSubmittedTask(task.id, "integrated");
  await runtime.store.appendDirectMessage({
    projectId: DEFAULT_PROJECT_ID,
    authorId: ownerId,
    recipientId: colleague.id,
    content: "have a look when you are back",
  });

  const client = new TestClient(runtime.origin);
  await client.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: colleague.email, password: PASSWORD },
  });
  const caught = await client.request(catchUpPath);
  assert.equal(caught.status, 200);
  assert.equal(caught.data.catchUp.empty, false);
  assert.equal(
    caught.data.catchUp.headline,
    "1 change landed while you were away",
  );
  // Landed work is named; everything else is counted, which is the whole
  // difference between this and reading the channel again.
  assert.deepEqual(
    caught.data.catchUp.lines.map((line: { text: string }) => line.text),
    ["Fix the retry loop", "1 new message", "1 unread direct message"],
  );
  assert.deepEqual(caught.data.catchUp.counts, {
    landed: 1,
    failed: 0,
    messages: 1,
    direct: 1,
  });
  // No local model answered here, so the prose is the deterministic wording —
  // the headline and the same lines, which is what a deployment without a
  // model shows.
  assert.equal(
    caught.data.catchUp.summary,
    [
      "1 change landed while you were away",
      "• Fix the retry loop",
      "• 1 new message",
      "• 1 unread direct message",
    ].join("\n"),
  );

  // Saying it has been read is its own call, so a popup that never rendered
  // does not silently swallow the news.
  const seen = await client.request(`${catchUpPath}/seen`, { method: "POST" });
  assert.equal(seen.status, 200);
  assert.ok(seen.data.seenAt > caught.data.catchUp.since);

  const again = await client.request(catchUpPath);
  assert.equal(again.data.catchUp.empty, true);
});

test("the local model writes the catch-up's prose, and only its prose", async (t) => {
  const prompts: string[] = [];
  const runtime = await startRuntime(t, {
    catchUpSummariser: async (prompt) => {
      prompts.push(prompt);
      return prompt.includes("User request:")
        ? "Fixed the retry loop and verified the recovery path."
        : "Somebody fixed the retry loop while you were out.";
    },
  });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "catch-up-summarised");
  const catchUpPath = `/api/v1/projects/${DEFAULT_PROJECT_ID}/catch-up`;

  const colleague = await runtime.store.createUser({
    email: "catch-up-reader@example.com",
    displayName: "Reader",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: colleague.id,
    role: "developer",
  });
  await runtime.store.markCatchUpSeen(
    DEFAULT_PROJECT_ID,
    colleague.id,
    "2026-01-01T00:00:00.000Z",
  );
  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "Fix the retry loop",
    agentId: "codex",
    validationCommands: [],
  });
  await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
  await runtime.store.completeSubmittedTask(task.id, "integrated");
  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: task.id,
    data: {
      agentExplanation: "Raised the retry limit and added recovery coverage.",
      files: ["retry.ts", "retry.test.ts"],
    },
  });

  const client = new TestClient(runtime.origin);
  await client.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: colleague.email, password: PASSWORD },
  });
  const caught = await client.request(catchUpPath);
  assert.equal(caught.status, 200);
  assert.equal(
    caught.data.catchUp.summary,
    "Somebody fixed the retry loop while you were out.",
  );
  // The model was handed the facts, not asked to go and find them.
  assert.ok((prompts[0] ?? "").includes("Fix the retry loop"), prompts[0]);
  const taskPrompt =
    prompts.find((prompt) => prompt.includes("User request:")) ?? "";
  assert.match(taskPrompt, /Fix the retry loop/u);
  assert.match(taskPrompt, /Raised the retry limit and added recovery coverage/u);
  assert.equal(caught.data.catchUp.tasks[0]?.id, task.id);
  assert.equal(caught.data.catchUp.tasks[0]?.repositoryId, repositoryId);
  assert.equal(
    caught.data.catchUp.tasks[0]?.summary,
    "Fixed the retry loop and verified the recovery path.",
  );
  assert.deepEqual(
    caught.data.catchUp.tasks[0]?.changedFiles,
    ["retry.ts", "retry.test.ts"],
  );
  // And it rewrote only the prose: the list and the counts are still the
  // measured ones, so a wrong sentence cannot become a wrong catch-up.
  assert.deepEqual(
    caught.data.catchUp.lines.map((line: { text: string }) => line.text),
    ["Fix the retry loop"],
  );
  assert.deepEqual(caught.data.catchUp.counts, {
    landed: 1,
    failed: 0,
    messages: 0,
    direct: 0,
  });
  assert.equal(
    caught.data.catchUp.headline,
    "1 change landed while you were away",
  );
});

test("a conversational turn that landed is described, not left to its prompt", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "catch-up-open-thread");
  const catchUpPath = `/api/v1/projects/${DEFAULT_PROJECT_ID}/catch-up`;

  const colleague = await runtime.store.createUser({
    email: "catch-up-thread-reader@example.com",
    displayName: "Reader",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: colleague.id,
    role: "developer",
  });
  await runtime.store.markCatchUpSeen(
    DEFAULT_PROJECT_ID,
    colleague.id,
    "2026-01-01T00:00:00.000Z",
  );

  // Work asked for inside a thread lands and then waits for the next message,
  // so its row stays `open` and never gets a `completedAt`. Skipping those
  // left the client with nothing but the request to caption them with.
  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "can you fix the notification on the bottom left",
    agentId: "claude",
    validationCommands: [],
    conversationId: "conversation-1",
  });
  await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: task.id,
    data: {
      agentExplanation:
        "The unread count now sits on the avatar instead of floating away from it.",
      files: ["app.js"],
    },
  });
  await runtime.store.openSubmittedTask(task.id);

  const client = new TestClient(runtime.origin);
  await client.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: colleague.email, password: PASSWORD },
  });
  const caught = await client.request(catchUpPath);
  assert.equal(caught.status, 200);
  assert.equal(caught.data.catchUp.tasks.length, 1);
  assert.equal(caught.data.catchUp.tasks[0]?.id, task.id);
  assert.equal(
    caught.data.catchUp.tasks[0]?.summary,
    "The unread count now sits on the avatar instead of floating away from it.",
  );
  assert.deepEqual(caught.data.catchUp.tasks[0]?.changedFiles, ["app.js"]);
  assert.equal(caught.data.catchUp.counts.landed, 1);
});

test("a catch-up carries only what its reader may see", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const granted = await invitableRepository(owner, "catch-up-granted");
  const hidden = await invitableRepository(owner, "catch-up-hidden");

  // Reached through a per-repository grant and no organization role: the
  // catch-up has to narrow the same way the repository list does, or it
  // becomes a way to read the activity of a repository nobody shared.
  const guest = await runtime.store.createUser({
    email: "catch-up-guest@example.com",
    displayName: "Guest",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveRepositoryGrant({
    repositoryId: granted,
    userId: guest.id,
    role: "developer",
    grantedBy: bootstrapped.user.id,
    comped: false,
    createdAt: new Date().toISOString(),
  });
  await runtime.store.markCatchUpSeen(
    DEFAULT_PROJECT_ID,
    guest.id,
    "2026-01-01T00:00:00.000Z",
  );
  for (const [repositoryId, objective] of [
    [granted, "Shared work"],
    [hidden, "Work behind a wall"],
  ] as const) {
    const task = await runtime.store.submitTask({
      repositoryId,
      projectId: DEFAULT_PROJECT_ID,
      objective,
      agentId: "codex",
      validationCommands: [],
    });
    await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
    await runtime.store.completeSubmittedTask(task.id, "integrated");
  }

  const guestClient = new TestClient(runtime.origin);
  await guestClient.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: guest.email, password: PASSWORD },
  });
  const caught = await guestClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/catch-up`,
  );
  assert.equal(caught.status, 200);
  assert.deepEqual(
    caught.data.catchUp.lines.map((line: { text: string }) => line.text),
    ["Shared work"],
  );

  // Somebody with no membership and no grant is refused, as they are for
  // every other project-scoped route.
  const outsider = await runtime.store.createUser({
    email: "catch-up-outsider@example.com",
    displayName: "Outsider",
    passwordDigest: await hashPassword(PASSWORD),
  });
  const stranger = new TestClient(runtime.origin);
  await stranger.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: outsider.email, password: PASSWORD },
  });
  const denied = await stranger.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/catch-up`,
  );
  assert.equal(denied.status, 403);
  const deniedSeen = await stranger.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/catch-up/seen`,
    { method: "POST" },
  );
  assert.equal(deniedSeen.status, 403);
});

test("muting a channel silences it for one person and nobody else", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const noisy = await invitableRepository(owner, "mute-noisy");
  const quiet = await invitableRepository(owner, "mute-quiet");
  const mutesPath = `/api/v1/projects/${DEFAULT_PROJECT_ID}/channel/mutes`;
  const mutePath = (repositoryId: string) =>
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/mute`;

  const before = await owner.request(mutesPath);
  assert.equal(before.status, 200);
  assert.deepEqual(before.data.repositoryIds, []);

  const muted = await owner.request(mutePath(noisy), {
    method: "POST",
    body: { muted: true },
  });
  assert.equal(muted.status, 200);
  assert.equal(muted.data.muted, true);
  const after = await owner.request(mutesPath);
  assert.deepEqual(after.data.repositoryIds, [noisy]);

  // Somebody else in the same rooms hears them exactly as before: a mute is a
  // preference, not a property of the channel.
  const colleague = await runtime.store.createUser({
    email: "mute-colleague@example.com",
    displayName: "Colleague",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveRepositoryGrant({
    repositoryId: noisy,
    userId: colleague.id,
    role: "developer",
    grantedBy: bootstrapped.user.id,
    comped: false,
    createdAt: new Date().toISOString(),
  });
  const colleagueClient = new TestClient(runtime.origin);
  await colleagueClient.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: colleague.email, password: PASSWORD },
  });
  const theirs = await colleagueClient.request(mutesPath);
  assert.equal(theirs.status, 200);
  assert.deepEqual(theirs.data.repositoryIds, []);

  // A grant holder is told about their own mutes on the repositories they can
  // see, and never about one they cannot.
  await colleagueClient.request(mutePath(noisy), {
    method: "POST",
    body: { muted: true },
  });
  // The same answer a repository that does not exist gets: somebody who
  // reaches this project through one grant is not told what else is in it.
  const refused = await colleagueClient.request(mutePath(quiet), {
    method: "POST",
    body: { muted: true },
  });
  assert.equal(refused.status, 404);
  const narrowed = await colleagueClient.request(mutesPath);
  assert.deepEqual(narrowed.data.repositoryIds, [noisy]);

  // Unmuting is the same call the other way round, and the owner's own list
  // is untouched by anything the colleague did.
  const unmuted = await owner.request(mutePath(noisy), {
    method: "POST",
    body: { muted: false },
  });
  assert.equal(unmuted.status, 200);
  assert.equal(unmuted.data.muted, false);
  assert.deepEqual((await owner.request(mutesPath)).data.repositoryIds, []);
  assert.deepEqual(
    (await colleagueClient.request(mutesPath)).data.repositoryIds,
    [noisy],
  );

  // The flag has to be a boolean: an absent or misspelled one would otherwise
  // read as "unmute" and quietly undo somebody's setting.
  const malformed = await owner.request(mutePath(noisy), {
    method: "POST",
    body: { muted: "yes" },
  });
  assert.equal(malformed.status, 400);
  const missing = await owner.request(mutePath("repo_does_not_exist"), {
    method: "POST",
    body: { muted: true },
  });
  assert.equal(missing.status, 404);

  const stranger = new TestClient(runtime.origin);
  assert.equal((await stranger.request(mutesPath)).status, 401);
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
  // These are made straight through the store, which every production path
  // that creates an organization now does alongside writing a subscription
  // row — a missing row is no entitlement, so without this both tenants fold
  // to `viewer` and the test measures the billing gate rather than the tenant
  // boundary it is about.
  for (const organization of [firstOrganization, secondOrganization]) {
    await runtime.store.saveSubscription({
      organizationId: organization.id,
      status: "comped",
    });
  }
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

test("an accepted repository invitation moves the seat count at Stripe", async (t) => {
  // The bug this pins: every invitation a customer can create is
  // repository-scoped — the route requires one — and that branch was the one
  // branch that never called `syncSeatQuantity`. So a team could invite its
  // whole staff, each of them able to work, and the subscription stayed at
  // the quantity checkout happened to capture. Nobody would notice from
  // inside the product; it shows up only as an invoice that is too small.
  const writes: number[] = [];
  // What Stripe currently holds, so the "already correct, do not write"
  // shortcut is exercised by the same stub rather than assumed.
  let held = 2;
  const stripe = {
    getSubscription: async (id: string) => ({
      id,
      status: "active",
      customerId: "cus_seats",
      currentPeriodEnd: undefined,
      trialEnd: undefined,
      quantity: held,
      metadata: {},
    }),
    getSubscriptionItemId: async () => "si_seats",
    updateSubscriptionQuantity: async (input: {
      subscriptionId: string;
      subscriptionItemId: string;
      quantity: number;
    }) => {
      assert.equal(input.subscriptionId, "sub_seats");
      assert.equal(input.subscriptionItemId, "si_seats");
      writes.push(input.quantity);
      held = input.quantity;
    },
  } as unknown as StripeClient;
  const runtime = await startRuntime(t, { stripe });
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "seat-repo");

  // The invitation has to come from somebody who is not the operator: an
  // operator's repository invitation is deliberately comped, and a comped
  // grant is exactly the one that must not move the count.
  const founder = await runtime.store.createUser({
    email: "founder@example.com",
    displayName: "Founder",
    passwordDigest: await hashPassword(PASSWORD),
    systemAdmin: false,
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: founder.id,
    role: "owner",
  });
  // A real paying organization, which bootstrap's comped row is not.
  await runtime.store.saveSubscription({
    organizationId: DEFAULT_ORGANIZATION_ID,
    status: "active",
    stripeCustomerId: "cus_seats",
    stripeSubscriptionId: "sub_seats",
  });
  const founderClient = new TestClient(runtime.origin);
  const signedIn = await founderClient.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "founder@example.com", password: PASSWORD },
  });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.data));

  const invited = await founderClient.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    {
      method: "POST",
      body: inviteBody("hired@example.com", "developer", repo),
    },
  );
  assert.equal(invited.status, 201, JSON.stringify(invited.data));
  // Issuing the invitation is not a seat. Nobody holds it yet, and billing
  // for an unopened email is how a team ends up paying for a typo.
  assert.deepEqual(writes, []);

  const joiner = new TestClient(runtime.origin);
  const accepted = await joiner.request(
    `/api/v1/invitations/${String(invited.data.token)}/accept`,
    { method: "POST", body: { displayName: "Hired", password: PASSWORD } },
  );
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  // Two members and one ordinary grant, by person: three seats.
  assert.deepEqual(
    writes,
    [3],
    "the grant branch has to reach Stripe, not only the membership one",
  );

  // And an operator's invitation to the same repository is free, so the
  // quantity does not move again — the comp is the point of that path.
  const comped = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("guest@example.com", "developer", repo) },
  );
  assert.equal(comped.status, 201, JSON.stringify(comped.data));
  const guest = new TestClient(runtime.origin);
  const joinedFree = await guest.request(
    `/api/v1/invitations/${String(comped.data.token)}/accept`,
    { method: "POST", body: { displayName: "Guest", password: PASSWORD } },
  );
  assert.equal(joinedFree.status, 200, JSON.stringify(joinedFree.data));
  assert.deepEqual(
    writes,
    [3],
    "a comped grant is free, and writing the same quantity would prorate",
  );
});

test("syncing checks the repository, not only the project it was named under", async (t) => {
  // `/sync` authorized the project and then handed the path's repository id
  // to the operation, which resolves it globally. So an owner of any project
  // anywhere could name somebody else's repository under their own project
  // and move that mirror — a write, on a repository they cannot even read.
  // The sibling `/push` has always checked both halves.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const theirs = await invitableRepository(owner, "sync-target");

  const outsider = await runtime.store.createUser({
    email: "sync-outsider@example.com",
    displayName: "Sync Outsider",
    passwordDigest: await hashPassword(PASSWORD),
    systemAdmin: false,
  });
  const other = await runtime.store.createOrganization({
    slug: "sync-tenant",
    name: "Sync Tenant",
  });
  await runtime.store.saveMembership({
    organizationId: other.id,
    userId: outsider.id,
    role: "owner",
  });
  await runtime.store.saveSubscription({
    organizationId: other.id,
    status: "active",
  });
  const mine = await runtime.store.createProject({
    organizationId: other.id,
    slug: "sync-project",
    name: "Sync Project",
  });
  const client = new TestClient(runtime.origin);
  const signedIn = await client.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "sync-outsider@example.com", password: PASSWORD },
  });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.data));

  // Their own project, somebody else's repository.
  const crossed = await client.request(
    `/api/v1/projects/${mine.id}/repositories/${theirs}/sync`,
    { method: "POST", body: {} },
  );
  assert.equal(
    crossed.status,
    404,
    JSON.stringify(crossed.data),
  );

  // The project it really belongs to, which they cannot reach at all.
  const direct = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${theirs}/sync`,
    { method: "POST", body: {} },
  );
  assert.equal(direct.status, 403, JSON.stringify(direct.data));

  // Neither refusal reached the operation, which is the only place the
  // damage would have happened.
  assert.equal(runtime.syncCalls.length, 0);

  // And the owner can still sync their own, or the guard would be a
  // regression rather than a fix.
  const allowed = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${theirs}/sync`,
    { method: "POST", body: {} },
  );
  assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
  assert.deepEqual(
    runtime.syncCalls.map((call) => call.repositoryId),
    [theirs],
  );
});

test("an invitation cannot name a repository the sender does not own", async (t) => {
  // Two holes, one route. The repository was looked up with
  // `listProjectRepositories(body.projectId)` — keyed on the project alone —
  // so the only question asked was whether the repository existed under the
  // project id in the body. Nothing asked whether the sender could reach it,
  // and nothing asked whether it belonged to the organization in the path.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const theirs = await invitableRepository(owner, "tenant-a-repo");

  // Somebody who runs a different organization entirely, with no reach into
  // the first one.
  const outsider = await runtime.store.createUser({
    email: "outsider@example.com",
    displayName: "Outsider",
    passwordDigest: await hashPassword(PASSWORD),
    systemAdmin: false,
  });
  const other = await runtime.store.createOrganization({
    slug: "other-tenant",
    name: "Other Tenant",
  });
  await runtime.store.saveMembership({
    organizationId: other.id,
    userId: outsider.id,
    role: "owner",
  });
  // Paid up, so nothing below is refused for the wrong reason: an
  // organization with no subscription row folds every role to `viewer`, and
  // this test is about tenancy, not entitlement.
  await runtime.store.saveSubscription({
    organizationId: other.id,
    status: "active",
  });
  const client = new TestClient(runtime.origin);
  const signedIn = await client.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "outsider@example.com", password: PASSWORD },
  });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.data));

  // 1. No access to that repository at all. The route used to answer 201 for
  //    a repository that existed and 404 for one that did not, which also
  //    made it an existence oracle for someone else's code.
  const stranger = await client.request(
    `/api/v1/organizations/${other.id}/invitations`,
    {
      method: "POST",
      body: inviteBody("friend@example.com", "developer", theirs),
    },
  );
  assert.equal(
    stranger.status,
    403,
    JSON.stringify(stranger.data),
  );

  // 2. Now they can reach it — an ordinary owner grant, the access a
  //    repository invitation itself hands out. Sharing it under their *own*
  //    organization would be laundering: the invitation, the audit line and
  //    the seat all land on the wrong organization, while the repository
  //    stays on the other one.
  await runtime.store.saveRepositoryGrant({
    repositoryId: theirs,
    userId: outsider.id,
    role: "owner",
    grantedBy: outsider.id,
    comped: false,
    createdAt: new Date().toISOString(),
  });
  const launder = await client.request(
    `/api/v1/organizations/${other.id}/invitations`,
    {
      method: "POST",
      body: inviteBody("friend@example.com", "developer", theirs),
    },
  );
  assert.equal(launder.status, 404, JSON.stringify(launder.data));

  // And nothing was written on the way to either refusal.
  assert.deepEqual(
    (await runtime.store.listInvitations(other.id)).map(
      (invitation) => invitation.id,
    ),
    [],
  );

  // A repository is still required: an invitation with no repository would be
  // an organization-wide one, which is the thing this route no longer offers.
  const wide = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    {
      method: "POST",
      body: {
        email: "friend@example.com",
        role: "developer",
        projectId: DEFAULT_PROJECT_ID,
      },
    },
  );
  assert.equal(wide.status, 400, JSON.stringify(wide.data));
});

test("a recipient name makes a readable invitation link", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "readable-invite");

  const invited = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    {
      method: "POST",
      body: {
        ...inviteBody("", "developer", repo),
        recipientName: "Nathan",
      },
    },
  );
  assert.equal(invited.status, 201, JSON.stringify(invited.data));
  assert.equal(invited.data.token, "NATHAN");

  // The readable token remains a bearer credential, and only its hash is
  // kept. The deterministic internal id is what makes the code resolvable
  // without adding a second persisted field.
  const stored = await runtime.store.getInvitation(
    invited.data.invitation.id as string,
  );
  assert.ok(stored);
  assert.notEqual(stored.secretHash, "NATHAN");
  assert.notEqual(stored.id, "NATHAN");

  const joiner = new TestClient(runtime.origin);
  const preview = await joiner.request("/api/v1/invitations/NATHAN");
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.invitation.repositoryId, repo);
  assert.equal(preview.data.invitation.open, true);

  const accepted = await joiner.request("/api/v1/invitations/NATHAN/accept", {
    method: "POST",
    body: {
      email: "nathan@example.com",
      displayName: "Nathan",
      password: PASSWORD,
    },
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.user.email, "nathan@example.com");
  assert.equal(
    (await runtime.store.listRepositoryGrants(repo)).some(
      (grant) => grant.userId === accepted.data.user.id,
    ),
    true,
  );
});

test("invalid and reserved readable invitation names are refused", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "readable-invite-collisions");
  const endpoint =
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`;

  const invalid = await owner.request(endpoint, {
    method: "POST",
    body: {
      ...inviteBody("", "viewer", repo),
      recipientName: "Amy!",
    },
  });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.data));
  assert.equal(
    invalid.data.error?.code ?? invalid.data.code,
    "invalid_invitation_code",
  );

  const first = await owner.request(endpoint, {
    method: "POST",
    body: {
      ...inviteBody("", "viewer", repo),
      recipientName: "Nathan",
    },
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.token, "NATHAN");

  const reserved = await owner.request(endpoint, {
    method: "POST",
    body: {
      ...inviteBody("", "viewer", repo),
      recipientName: "  nathan  ",
    },
  });
  assert.equal(reserved.status, 409, JSON.stringify(reserved.data));
  assert.equal(
    reserved.data.error?.code ?? reserved.data.code,
    "invitation_code_unavailable",
  );
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
  const registered = await registerAccount(runtime.store, member, {
    email: "returning@example.com",
    displayName: "Returning",
    password: PASSWORD,
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
  assert.equal(preview.data.invitation.signedIn, false);

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
  const signedInPreview = await joiner.request(`/api/v1/invitations/${token}`);
  assert.equal(signedInPreview.status, 200);
  assert.equal(signedInPreview.data.invitation.signedIn, true);
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

test("a removed member can use a new invite link to regain project access", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "returning-member-repo");

  const returning = new TestClient(runtime.origin);
  const registered = await registerAccount(runtime.store, returning, {
    email: "removed@example.com",
    displayName: "Removed Member",
    password: PASSWORD,
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.data));
  const added = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/members`,
    {
      method: "POST",
      body: { userId: registered.data.user.id, role: "developer" },
    },
  );
  assert.equal(added.status, 201, JSON.stringify(added.data));

  // Refresh the member's session while the organization role exists, then
  // remove it. This is the real returning-member shape: the browser may still
  // hold the old session when the owner sends the replacement invitation.
  assert.equal(
    (
      await returning.request("/api/v1/auth/login", {
        method: "POST",
        body: { email: "removed@example.com", password: PASSWORD },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await owner.request(
        `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/members/${registered.data.user.id}`,
        { method: "DELETE" },
      )
    ).status,
    200,
  );

  const invited = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    {
      method: "POST",
      body: {
        role: "developer",
        repositoryId: repo,
        projectId: DEFAULT_PROJECT_ID,
      },
    },
  );
  assert.equal(invited.status, 201, JSON.stringify(invited.data));
  const token = invited.data.token as string;
  const preview = await returning.request(`/api/v1/invitations/${token}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.invitation.signedIn, true);

  const accepted = await returning.request(`/api/v1/invitations/${token}/accept`, {
    method: "POST",
    body: {},
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  const organizations = await returning.request("/api/v1/organizations");
  assert.equal(organizations.status, 200);
  assert.equal(
    organizations.data.organizations.some(
      (entry: { id: string }) => entry.id === DEFAULT_ORGANIZATION_ID,
    ),
    true,
  );
  const projects = await returning.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/projects`,
  );
  assert.equal(projects.status, 200, JSON.stringify(projects.data));
  assert.equal(
    projects.data.projects.some(
      (entry: { id: string }) => entry.id === DEFAULT_PROJECT_ID,
    ),
    true,
  );
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
  const created = await registerAccount(runtime.store, newcomer, {
    email: "stranger@example.com",
    displayName: "Stranger",
    password: PASSWORD,
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
    // References are trusted server metadata, not a new client-authored
    // field. An extra body key is ignored just as unknown keys were before.
    body: {
      content: "  Kicking off this channel.  ",
      referencedMessageId: "chanmsg_spoofed",
    },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(posted.data.message.content, "Kicking off this channel.");
  assert.equal(posted.data.message.kind, "user");
  assert.equal(posted.data.message.referencedMessageId, undefined);
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
  await registerAccount(runtime.store, newcomer, {
    email: "outsider@example.com",
    displayName: "Outsider",
    password: PASSWORD,
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
    comped: false,
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
  await registerAccount(runtime.store, strangerClient, {
    email: "outsider-roster@example.com",
    displayName: "Outsider",
    password: PASSWORD,
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
  const [acknowledgement] = agentSpeech(after.data.messages);
  assert.equal(
    acknowledgement?.content,
    "I've taken this task and I'm working on it.",
  );
  assert.equal(
    acknowledgement?.authorId,
    `${bootstrapped.user.id}:anthropic`,
  );
});

test("dispatch locally names the thread, then contextualizes the same reply", async (t) => {
  const titlePrompts: string[] = [];
  const runtime = await startRuntime(t, {
    threadTitleSummariser: async (prompt) => {
      titlePrompts.push(prompt);
      return "Token refresh reliability";
    },
  });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "ack-own-voice");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const assigned = await owner.request(`${base}/agents/anthropic`, {
    method: "POST",
    body: { role: "Token Reliability Engineer" },
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
  runtime.chatAnswer.text =
    "I'll inspect the refresh flow, update the retry behavior, and verify it with focused tests.";
  // The acknowledgement must not wait for this contextual opening to finish.
  runtime.chatAnswer.delayMs = 500;

  const attachmentId = `${"a".repeat(32)}.png`;
  const visibleRequest =
    `please fix the token refresh ` +
    `![trace](attachment:${attachmentId})`;
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: `@Claude (Owner) ${visibleRequest}` },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  const after = await owner.request(`${base}/messages`);
  const speech = agentSpeech(after.data.messages);
  assert.equal(speech.length, 1, JSON.stringify(after.data.messages));
  assert.equal(
    speech[0]?.content,
    "I've taken this task and I'm working on it.",
  );
  const acknowledgementId = speech[0]?.id;
  const acknowledgementCreatedAt = speech[0]?.createdAt;
  const auditCountBeforeContext = (await runtime.store.listAudit()).filter(
    (event) =>
      event.type === "channel_message_posted" &&
      event.data["messageId"] === posted.data.message.id,
  ).length;
  assert.equal(runtime.submittedTasks.length, 1);
  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    return (listed.data.messages as any[]).some((message) =>
      (message.replies ?? []).some(
        (reply: any) => reply.content === "Task: Token refresh reliability",
      ),
    );
  }, "the local title was not persisted in the task thread");
  assert.equal(titlePrompts.length, 1);
  assert.ok((titlePrompts[0] ?? "").endsWith(`Request:\n${visibleRequest}`));
  assert.doesNotMatch(
    titlePrompts[0] ?? "",
    /@Claude|Token Reliability Engineer|Your final message|open this file|\/var\/data/u,
  );
  const executionObjective = runtime.submittedTasks[0]?.objective ?? "";
  assert.match(executionObjective, /Token Reliability Engineer/u);
  assert.match(executionObjective, /Your final message/u);
  assert.match(executionObjective, /open this file/u);
  assert.match(executionObjective, /\/var\/data/u);
  assert.ok(
    runtime.chatPrompts.every(
      (entry) => !/only the acknowledgement|picking it up/iu.test(entry.prompt),
    ),
    JSON.stringify(runtime.chatPrompts),
  );

  const intent =
    "I'll inspect the refresh flow, update the retry behavior, and verify it with focused tests.";
  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    return agentSpeech(listed.data.messages)[0]?.content === intent;
  }, "the generic acknowledgement was not contextualized");
  const contextualized = agentSpeech(
    (await owner.request(`${base}/messages`)).data.messages,
  );
  assert.equal(contextualized.length, 1);
  assert.equal(contextualized[0]?.id, acknowledgementId);
  assert.equal(contextualized[0]?.createdAt, acknowledgementCreatedAt);
  assert.equal(contextualized[0]?.content, intent);
  const auditCountAfterContext = (await runtime.store.listAudit()).filter(
    (event) =>
      event.type === "channel_message_posted" &&
      event.data["messageId"] === posted.data.message.id,
  ).length;
  assert.equal(auditCountAfterContext, auditCountBeforeContext + 1);
});

test("provider opening failure does not prevent the local thread title", async (t) => {
  const runtime = await startRuntime(t, {
    threadTitleSummariser: async () => "Token refresh repair",
  });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "ack-context-failure");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.fail = "opening unavailable";

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) please fix the token refresh" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  await waitFor(
    async () =>
      runtime.chatPrompts.some((entry) =>
        entry.prompt.includes("Reply with one or two concise first-person lines"),
      ),
    "the contextual opening was not attempted",
  );

  const speech = agentSpeech(
    (await owner.request(`${base}/messages`)).data.messages,
  );
  assert.equal(speech.length, 1);
  assert.equal(
    speech[0]?.content,
    "I've taken this task and I'm working on it.",
  );
  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    return (listed.data.messages as any[]).some((message) =>
      (message.replies ?? []).some(
        (reply: any) => reply.content === "Task: Token refresh repair",
      ),
    );
  }, "the local title disappeared with the failed provider opening");
});

test("work acknowledges inside the user request's thread", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "ack-reference");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) tighten the retry policy" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const listed = await owner.request(`${base}/messages`);
  const thread = (listed.data.messages as any[]).find(
    (message) => message.id === posted.data.message.id,
  );
  assert.equal(thread?.kind, "user");
  assert.equal(thread?.content, "@Claude (Owner) tighten the retry policy");
  const acknowledgement = (thread?.replies ?? []).find(
    (reply: any) => reply.kind === "agent",
  );
  assert.equal(
    acknowledgement?.content,
    "I've taken this task and I'm working on it.",
  );
  assert.equal(
    acknowledgement?.authorId,
    `${bootstrapped.user.id}:anthropic`,
  );
  assert.equal(runtime.submittedTasks.length, 1);
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.equal(thread?.taskId, task?.id);
  const events = (await runtime.store.listAudit()).filter(
    (entry) =>
      entry.type === "channel_message_posted" &&
      entry.data["messageId"] === posted.data.message.id,
  );
  assert.ok(events.length >= 2, JSON.stringify(events));

  // A bare follow-up still reaches the agent attributed by the persisted
  // task and the acknowledgement.
  runtime.chatAnswer.text = "I'm working through the retry callers.";
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(posted.data.message.id)}/replies`,
    { method: "POST", body: { content: "what did you get done then?" } },
  );
  assert.equal(replied.status, 201);
  await waitFor(async () => {
    const root = await runtime.store.getChannelMessage(
      repositoryId,
      posted.data.message.id,
      bootstrapped.user.id,
    );
    return (root?.replies ?? []).some(
      (reply) => reply.content === runtime.chatAnswer.text,
    );
  }, "the request-rooted thread lost its agent identity");
});

test("automatic continuation matches an existing user-rooted task thread", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "user-root-continue");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const content = "@Claude (Owner) rework the retry policy and its tests";

  const first = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content },
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const bumpedRoots: string[] = [];
  const bumpChannelMessage = runtime.store.bumpChannelMessage.bind(
    runtime.store,
  );
  runtime.store.bumpChannelMessage = async (repo, messageId, at) => {
    bumpedRoots.push(messageId);
    await bumpChannelMessage(repo, messageId, at);
  };
  const second = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content },
  });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  assert.equal(runtime.submittedTasks.length, 2);

  const [firstSubmission, secondSubmission] = runtime.submittedTasks;
  assert.equal(firstSubmission?.conversationId, first.data.message.id);
  assert.equal(secondSubmission?.conversationId, first.data.message.id);
  const messages = await runtime.store.listChannelMessages(
    repositoryId,
    bootstrapped.user.id,
  );
  const root = messages.find((message) => message.id === first.data.message.id);
  const repeated = messages.find(
    (message) => message.id === second.data.message.id,
  );
  assert.equal(root?.kind, "user");
  assert.ok(root?.taskId !== undefined);
  assert.ok(repeated !== undefined);
  assert.equal(repeated.taskId, undefined);
  assert.deepEqual(
    bumpedRoots,
    [root.id],
    "a channel-originated continuation must still refresh the existing thread",
  );
  assert.ok(
    (root?.replies ?? []).some(
      (reply) => reply.kind === "user" && reply.content === content,
    ),
  );
  assert.equal(
    (root?.replies ?? []).filter((reply) => reply.kind === "agent").length,
    2,
    JSON.stringify(root?.replies),
  );
  assert.equal(
    (root?.replies ?? [])
      .filter((reply) => reply.kind === "agent")
      .every(
        (reply) =>
          reply.content === "I've taken this task and I'm working on it.",
      ),
    true,
  );
});

test("matching integrated work names its agent and points back without submitting a duplicate", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "completed-work-reference");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org", callSign: "Alpha" },
    { provider: "openai", visibility: "org", callSign: "Beta" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const objective = "implement the token refresh retry circuit breaker guard";

  const first = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: `@Alpha ${objective}` },
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.ok(task !== undefined);
  await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
  await runtime.store.completeSubmittedTask(task.id, "integrated");
  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: task.id,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
      files: ["src/token-refresh.ts"],
    },
  });

  const submittedBefore = runtime.submittedTasks.length;
  const repeated = await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: "@Beta update the token refresh retry circuit breaker guard",
    },
  });
  assert.equal(repeated.status, 201, JSON.stringify(repeated.data));
  assert.equal(runtime.submittedTasks.length, submittedBefore);

  const after = await owner.request(`${base}/messages?limit=50`);
  const reference = (after.data.messages as any[]).find(
    (message) =>
      message.kind === "agent" &&
      message.referencedMessageId === first.data.message.id,
  );
  assert.ok(reference !== undefined, JSON.stringify(after.data.messages));
  assert.equal(reference.authorId, `${bootstrapped.user.id}:openai`);
  assert.match(reference.content, /@Alpha already took care of that\.$/u);
});

test("completed-work recognition requires a canonical change", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "completed-work-proof");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org", callSign: "Alpha" },
    { provider: "openai", visibility: "org", callSign: "Beta" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const objective = "implement the session refresh timeout guard";

  const first = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: `@Alpha ${objective}` },
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.ok(task !== undefined);
  await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
  // Reports use this same terminal status. With no promotion in the audit
  // record, it is not proof that the requested implementation exists.
  await runtime.store.completeSubmittedTask(task.id, "integrated");
  await runtime.store.appendAudit(undefined, {
    type: "task_reported",
    taskId: task.id,
    data: { projectId: DEFAULT_PROJECT_ID, repositoryId },
  });

  const submittedBefore = runtime.submittedTasks.length;
  const repeated = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: `@Beta ${objective}` },
  });
  assert.equal(repeated.status, 201, JSON.stringify(repeated.data));
  assert.equal(runtime.submittedTasks.length, submittedBefore + 1);
  const listed = await owner.request(`${base}/messages?limit=50`);
  assert.doesNotMatch(
    (listed.data.messages as any[])
      .map((message) => String(message.content))
      .join("\n"),
    /Already handled/u,
  );
});

test("reports receive current agent context instead of completed-work guesses", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "completed-work-report");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org", callSign: "Alpha" },
    { provider: "openai", visibility: "org", callSign: "Beta" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const first = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Alpha audit the session timeout guard" },
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.ok(task !== undefined);
  await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
  await runtime.store.completeSubmittedTask(task.id, "integrated");
  await runtime.store.appendAudit(undefined, {
    type: "task_reported",
    taskId: task.id,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      explanation: "The earlier report is complete.",
    },
  });

  // An audit asks for a fresh report, even if an earlier audit happened to
  // use the same words. It must not be treated as an implementation that can
  // satisfy future requests by textual similarity.
  const submittedBefore = runtime.submittedTasks.length;
  const repeatedAudit = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Beta audit the session timeout guard" },
  });
  assert.equal(repeatedAudit.status, 201, JSON.stringify(repeatedAudit.data));
  assert.equal(runtime.submittedTasks.length, submittedBefore + 1);

  runtime.chatAnswer.text =
    "The earlier audit is complete, and a fresh audit is queued.";
  const submittedBeforeStatus = runtime.submittedTasks.length;
  const report = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Beta status report" },
  });
  assert.equal(report.status, 201, JSON.stringify(report.data));
  assert.equal(runtime.submittedTasks.length, submittedBeforeStatus);

  const listed = await owner.request(`${base}/messages?limit=50`);
  const response = (listed.data.messages as any[]).find(
    (message) => message.content === runtime.chatAnswer.text,
  );
  assert.ok(response !== undefined, JSON.stringify(listed.data.messages));
  assert.equal(response.referencedMessageId, report.data.message.id);
  const reportPrompt = [...runtime.chatPrompts]
    .reverse()
    .find((entry) => entry.prompt.includes("The message: @Beta status report"));
  assert.match(reportPrompt?.prompt ?? "", /finished and landed/u);
  assert.doesNotMatch(
    (listed.data.messages as any[])
      .map((message) => String(message.content))
      .join("\n"),
    /Already handled/u,
  );
});

test("duplicate recognition leaves unfinished, unsuccessful, opposed, uncertain, and thread work dispatchable", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org", callSign: "Alpha" },
    { provider: "openai", visibility: "org", callSign: "Beta" },
  ]);

  const scenarios: Array<{
    name: string;
    status: "submitted" | "integrated" | "failed" | "cancelled";
    first: string;
    second: string;
    inThread?: boolean;
  }> = [
    {
      name: "unfinished",
      status: "submitted",
      first: "implement the unfinished token refresh retry guard",
      second: "implement the unfinished token refresh retry guard",
    },
    {
      name: "failed",
      status: "failed",
      first: "implement the failed token refresh retry guard",
      second: "implement the failed token refresh retry guard",
    },
    {
      name: "cancelled",
      status: "cancelled",
      first: "implement the cancelled token refresh retry guard",
      second: "implement the cancelled token refresh retry guard",
    },
    {
      name: "opposed",
      status: "integrated",
      first: "add the opposed token refresh retry policy circuit breaker guard",
      second: "remove the opposed token refresh retry policy circuit breaker guard",
    },
    {
      name: "low-confidence",
      status: "integrated",
      first: "implement the uncertain cache retry policy",
      second: "implement retry dashboard metrics",
    },
    {
      name: "thread-follow-up",
      status: "integrated",
      first: "implement the threaded token refresh retry guard",
      second: "implement the threaded token refresh retry guard",
      inThread: true,
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const repositoryId = await invitableRepository(
      owner,
      `completed-work-${String(index)}`,
    );
    await joinAllConnectedAgents(runtime, repositoryId);
    const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
    const first = await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: `@Alpha ${scenario.first}` },
    });
    assert.equal(first.status, 201, scenario.name);
    const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
    assert.ok(task !== undefined, scenario.name);
    if (scenario.status !== "submitted") {
      await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
      await runtime.store.completeSubmittedTask(task.id, scenario.status);
    }

    const submittedBefore = runtime.submittedTasks.length;
    const second = scenario.inThread === true
      ? await owner.request(
          `${base}/messages/${encodeURIComponent(first.data.message.id)}/replies`,
          { method: "POST", body: { content: `@Beta ${scenario.second}` } },
        )
      : await owner.request(`${base}/messages`, {
          method: "POST",
          body: { content: `@Beta ${scenario.second}` },
        });
    assert.equal(second.status, 201, scenario.name);
    if (scenario.inThread === true) {
      await waitFor(
        async () => runtime.submittedTasks.length === submittedBefore + 1,
        `${scenario.name} did not dispatch`,
      );
    }
    assert.equal(
      runtime.submittedTasks.length,
      submittedBefore + 1,
      `${scenario.name} was mistaken for completed work`,
    );
  }
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
  assert.equal(
    agentSpeech(after.data.messages)[0]?.content,
    "I've taken this task and I'm working on it.",
  );
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


/** What the agents actually said, including replies inside task threads. */
function agentSpeech(messages: unknown[]): any[] {
  return (messages as any[])
    .flatMap((message) => [message, ...(message.replies ?? [])])
    .filter((message) => message.kind === "agent");
}

/**
 * Posts an unaddressed request and lets the no-mention route dispatch it.
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

test("@everyone pings every person in the channel and files no task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "mention-everyone-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const colleague = await addColleague(runtime, "everyone-ping@example.com");
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@everyone standup moved to ten" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  // A ping is the whole of it. Mentioning one person has never submitted work
  // on their behalf, and saying it to the room at once cannot mean more.
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));

  const listed = await owner.request(`${base}/messages`);
  const broadcast = (listed.data.messages as any[]).find((message) =>
    String(message.content).includes("standup moved"),
  );
  const pinged = (broadcast.mentions as any[])
    .filter((mention) => mention.kind === "user")
    .map((mention) => mention.id)
    .sort();
  assert.deepEqual(pinged, [bootstrapped.user.id, colleague.id].sort());
  // The room's agents are `@agents`. This word is for its people.
  assert.equal(
    (broadcast.mentions as any[]).some((mention) => mention.kind === "agent"),
    false,
  );
  // And a valid broadcast is never the unresolved-name error.
  assert.doesNotMatch(
    (listed.data.messages as any[]).map((message) => String(message.content)).join("\n"),
    /Nobody here answers/u,
  );
});

test("@everyone still lets a named agent take work while /push stays direct", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "mention-everyone-agent-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  await addColleague(runtime, "everyone-and-agent@example.com");
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: {
        content: "@everyone heads up — @Claude (Owner) please update the release checklist",
      },
    })).status,
    201,
  );
  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
  assert.equal(runtime.submittedTasks[0]?.vendor, "claude");

  // `/push` is a repository operation. Text after the command cannot turn it
  // into an agent task, even when that text is an agent-style broadcast.
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "/push @everyone" },
    })).status,
    201,
  );
  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
  assert.equal(runtime.pushCalls.length, 1);
  const listed = await owner.request(`${base}/messages`);
  assert.match(
    (listed.data.messages as any[]).map((message) => String(message.content)).join("\n"),
    /Pushed canonical/u,
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
    (await backend.client.request(`${base}/agents/${backend.id}:openai`, {
      method: "POST",
      body: { name: "Auth Billing Backend Bot" },
    })).status,
    200,
  );
  assert.equal(
    (await database.client.request(`${base}/agents/${database.id}:google`, {
      method: "POST",
      body: { name: "Database Schema Migrations Bot" },
    })).status,
    200,
  );

  // Which agent gets it is what this test is about; whether the message is
  // clear enough to act on outright is a different question, covered where
  // the classify prompt itself is tested.
  runtime.setTaskClassification("ACT");
  await autoClaim(owner, base, "please update the settings page layout");

  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  const [task] = runtime.submittedTasks;
  assert.ok(task !== undefined);
  assert.equal(task.actorId, bootstrapped.user.id);
  assert.equal(task.vendor, "claude");

  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    return agentSpeech(listed.data.messages).length === 1;
  }, "the auto-claimed task was not acknowledged");
  const after = await owner.request(`${base}/messages`);
  assert.equal(
    agentSpeech(after.data.messages)[0]?.content,
    "I've taken this task and I'm working on it.",
  );
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
    (await first.client.request(`${base}/agents/${first.id}:openai`, {
      method: "POST",
      body: { name: "Error Handling API Bot" },
    })).status,
    200,
  );
  assert.equal(
    (await second.client.request(`${base}/agents/${second.id}:google`, {
      method: "POST",
      body: { name: "Api Error Handling Service" },
    })).status,
    200,
  );

  runtime.setTaskClassification("ACT");
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

  // Each chosen agent confirms its handoff in the request's thread.
  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    return agentSpeech(listed.data.messages).length === 2;
  }, "the auto-claimed tasks were not acknowledged");
  const after = await owner.request(`${base}/messages`);
  const agentMessages = agentSpeech(after.data.messages);
  assert.equal(agentMessages.length, 2, JSON.stringify(after.data.messages));
  assert.equal(
    agentMessages.every(
      (message) =>
        message.content === "I've taken this task and I'm working on it.",
    ),
    true,
  );
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
    (await backend.client.request(`${base}/agents/${backend.id}:openai`, {
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
  const [acknowledgement] = agentSpeech(after.data.messages);
  assert.equal(
    acknowledgement?.content,
    "I've taken this task and I'm working on it.",
  );
  assert.equal(acknowledgement?.authorId, `${backend.id}:openai`);
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
test("a question about repository files is answered in the channel, not turned into a task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "question-not-task");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.text =
    "The API gateway handles channel questions.\nANSWER_TASK: NONE";

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: "@Claude (Owner) which file contains channel question routing?",
    },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  // No task, and therefore no thread and nothing to keep an indicator alive.
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const after = await owner.request(`${base}/messages`);
  const agentMessages = (after.data.messages as any[]).filter(
    (message) => message.kind === "agent",
  );
  assert.equal(agentMessages.length, 1, JSON.stringify(after.data.messages));
  assert.equal(
    agentMessages[0]?.content,
    "The API gateway handles channel questions.",
  );
  assert.doesNotMatch(String(agentMessages[0]?.content), /ANSWER_TASK/u);
  assert.deepEqual(agentMessages[0].replies ?? [], []);
  assert.equal(runtime.chatPrompts.at(-1)?.repositoryId, repositoryId);
});

test("a question answer that proposes a repository change starts one scoped task and announces the handoff", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "answer-proposes-task");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.channelAnswerText =
    "The retry routes currently have no cap, so malformed clients can loop forever.\n" +
    "ANSWER_TASK: Add a three-attempt cap to retry routes and cover it with API gateway tests";
  // The task-opening call is separate from the answer and should not repeat
  // the answer's private routing line.
  runtime.chatAnswer.text =
    "I will update the retry guard and verify its route tests.";

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: "@Claude (Owner) should retry routes cap malformed clients?",
    },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  const [task] = runtime.submittedTasks;
  // The request, out of the objective the worker is sent. Every task now
  // carries the answer-not-a-status-report directive behind what was asked,
  // which is coordinator plumbing rather than part of the scope this test is
  // about — and `requestFromObjective` is how every other reader takes it off.
  assert.equal(
    requestFromObjective(task?.objective ?? ""),
    "Add a three-attempt cap to retry routes and cover it with API gateway tests",
  );
  assert.equal(task?.conversationId, posted.data.message.id);
  assert.equal(runtime.runCalls.length, 1);

  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    const root = (listed.data.messages as any[]).find(
      (message) => message.id === posted.data.message.id,
    );
    return root?.replies?.some(
      (reply: any) =>
        /update the retry guard|taken this task and.*working on it/iu.test(
          String(reply.content),
        ),
    ) === true;
  }, "the answer's task handoff was never announced");

  const listed = await owner.request(`${base}/messages`);
  const visibleAnswer = (listed.data.messages as any[]).find(
    (message) =>
      message.kind === "agent" &&
      message.content.startsWith("The retry routes currently"),
  );
  assert.equal(
    visibleAnswer?.content,
    "The retry routes currently have no cap, so malformed clients can loop forever.",
  );
  const allVisible = (listed.data.messages as any[])
    .flatMap((message) => [
      String(message.content),
      ...(message.replies ?? []).map((reply: any) => String(reply.content)),
    ])
    .join("\n");
  assert.doesNotMatch(allVisible, /ANSWER_TASK/u);
});

test("an agent's answer carries a reference to the message it answers", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "answer-reference");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.text = "I am checking the current task queue.";

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) what are you working on?" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const listed = await owner.request(`${base}/messages`);
  const answer = (listed.data.messages as any[]).find(
    (message) => message.kind === "agent",
  );

  assert.equal(answer?.content, runtime.chatAnswer.text);
  assert.equal(answer?.referencedMessageId, posted.data.message.id);
  assert.deepEqual(answer?.replies ?? [], []);
  assert.equal(runtime.submittedTasks.length, 0);
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
  const taskRoot = (after.data.messages as any[]).find(
    (message) => message.id === posted.data.message.id,
  );
  // The request remains the root and the agent confirms the handoff beneath
  // it before the run has anything task-specific to narrate.
  const replies = taskRoot?.replies ?? [];
  const [acknowledgement] = replies.filter(
    (reply: any) => reply.kind === "agent",
  );
  assert.equal(
    acknowledgement?.content,
    "I've taken this task and I'm working on it.",
  );
  assert.equal(taskRoot?.kind, "user");
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.equal(taskRoot?.taskId, task?.id);
  // Whenever something is written here, it is named after the work rather
  // than after an id.
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

test("thread titles use one short clean line or a bounded fallback", () => {
  assert.equal(
    normaliseThreadTitle(
      '"Title: Token refresh reliability."\nThis line is explanation.',
      "fix token refresh",
    ),
    "Token refresh reliability",
  );
  assert.equal(
    normaliseThreadTitle(
      "This model response contains far too many words to be a thread title",
      "repair token rotation and refresh retry handling across the application",
    ),
    "repair token rotation and refresh retry",
  );
  assert.equal(
    normaliseThreadTitle("\n\n", "repair token refresh behavior"),
    "repair token refresh behavior",
  );
  assert.equal(normaliseThreadTitle("Task:", ""), "Software task");
});

test("the local thread-title writer receives only the visible request", async () => {
  let received = "";
  const title = await summariseThreadTitle(
    "please repair token refresh behavior",
    async (prompt) => {
      received = prompt;
      return "- Refresh token reliability";
    },
  );
  assert.equal(title, "Refresh token reliability");
  assert.match(received, /Request:\nplease repair token refresh behavior$/u);

  const fallback = await summariseThreadTitle(
    "please repair token refresh behavior",
    async () => {
      throw new Error("local model unavailable");
    },
  );
  assert.equal(fallback, "repair token refresh behavior");
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

  runtime.setTaskClassification("ACT");
  await autoClaim(
    owner,
    base,
    "can someone start building general infrastructure for a chess engine",
  );
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  assert.equal(runtime.submittedTasks[0]?.actorId, bootstrapped.user.id);

  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    return agentSpeech(listed.data.messages).length === 1;
  }, "the unmatched auto-claimed task was not acknowledged");
  const after = await owner.request(`${base}/messages`);
  assert.equal(
    agentSpeech(after.data.messages)[0]?.content,
    "I've taken this task and I'm working on it.",
  );
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

  runtime.setTaskClassification("ACT");
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

  runtime.setTaskClassification("ACT");
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

test("a channel stop is not repeated by every affected agent", () => {
  assert.equal(
    narrateTaskEvent("task_cancelled", {
      reason: "Stopped from the channel",
    }),
    undefined,
  );
  assert.equal(
    narrateTaskEvent("task_cancelled", {
      reason: "Cancelled because a dependency failed",
    }),
    "This was cancelled.",
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

  // A long account reaches the reader whole. It used to be cut back to the
  // sentences that fit inside 200 characters, which dropped the half of it
  // somebody had asked for — a diagnosis, a caveat, what was left undone —
  // with nowhere in the channel to read the rest.
  const long = narrateTaskEvent("canonical_promoted", {
    agentExplanation:
      "Your own messages now sit on the right on a phone. " +
      "Everybody else's stay on the left, and the desktop layout is " +
      "unchanged. The reader's own id decides which side a message takes, " +
      "so a signed-out reader sees every message on the left as before.",
  });
  assert.equal(
    long,
    "Your own messages now sit on the right on a phone. Everybody else's " +
      "stay on the left, and the desktop layout is unchanged. The reader's " +
      "own id decides which side a message takes, so a signed-out reader " +
      "sees every message on the left as before.",
  );
  assert.doesNotMatch(long ?? "", /…/u);

  // A paragraph — several hundred characters, far past every bound this used
  // to keep — survives byte for byte.
  const paragraph = `${"This sentence says something worth reading. ".repeat(14)}And this one ends it.`;
  assert.ok(paragraph.length > 600, String(paragraph.length));
  assert.equal(
    narrateTaskEvent("canonical_promoted", { agentExplanation: paragraph }),
    paragraph,
  );

  // A runaway wall of text used to be cut at a char bound mid-thought. Agent
  // endings are left whole now — the channel gets what the agent wrote.
  const novelBody = `${"word ".repeat(1200)}end`;
  assert.ok(novelBody.length > 4_100, String(novelBody.length));
  const novel = narrateTaskEvent("canonical_promoted", {
    agentExplanation: novelBody,
  });
  assert.equal(novel, novelBody);
  assert.doesNotMatch(novel ?? "", /…/u);

  // Newlines collapse: the ending is one line in a channel, and a multi-line
  // explanation would otherwise read as several messages.
  assert.equal(
    narrateTaskEvent("canonical_promoted", {
      agentExplanation: "Fixed the loop.\n\nAlso tidied the imports.",
    }),
    "Fixed the loop. Also tidied the imports.",
  );
});

test("agent progress reaches the channel whole, never cut mid-word", () => {
  // Progress used to be sliced at 300 characters with no ellipsis — the exact
  // cut that left answers ending on "what tech s" while the agent was still
  // thinking. The full message is the progress line.
  const message =
    "I don't see any project files in the current directory. Could you share " +
    "the app code (as a file, zip, or by pointing me to a repository) so I " +
    "can investigate the latency issues? Alternatively, if you'd like me to " +
    "set up a sample project to demonstrate latency troubleshooting, let me " +
    "know what tech stack you prefer.";
  assert.ok(message.length > 300, String(message.length));
  assert.equal(
    narrateTaskEvent("agent_progress", { message }),
    message,
  );
  assert.doesNotMatch(
    narrateTaskEvent("agent_progress", { message }) ?? "",
    /what tech s$/u,
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

test("animation work asked for inside a thread is dispatched with its context", async (t) => {
  // Threads have had shared context for talking since agents began answering
  // follow-ups. Working was the gap, and desired animation phrased as how the
  // UI "should be" behaved like a question instead of entering the task path.
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
    content: "The pullout toggle and icon row are ready.",
  });
  await runtime.store.addChannelReply({
    repositoryId,
    messageId: root.id,
    kind: "progress",
    authorId: `${ownerId}:anthropic`,
    content: "Inspecting the pullout styles.",
  });
  await runtime.store.addChannelReply({
    repositoryId,
    messageId: root.id,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "The icons currently appear and disappear without a transition.",
  });

  runtime.chatAnswer.text = "On it — animating the pullout icons.";
  const request =
    "when toggling this pullout the icons should be animated pulling out " +
    "from the arrow and vice versa when coming back in";
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: request } },
  );
  assert.equal(replied.status, 201);

  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "asking for work inside a thread never dispatched anything",
  );
  const [task] = runtime.submittedTasks;
  assert.ok(task !== undefined);
  const context = task.context ?? "";
  assert.match(context, /pullout toggle and icon row/u);
  assert.match(context, /appear and disappear without a transition/u);
  // Progress replies are the run narrating itself. Feeding an agent its own
  // commentary back is noise somebody has already paid for once.
  assert.doesNotMatch(context, /Inspecting the pullout styles/u);
  // The request itself is already the objective; sending it twice only tells
  // the model the same thing twice.
  assert.doesNotMatch(context, /icons should be animated/u);

  // The whole reason this is a field of its own: the objective is rendered in
  // the channel, in task lists and in thread titles, and a transcript folded
  // into it would make every request unreadable in all three.
  assert.match(task.objective, /icons should be animated/u);
  assert.doesNotMatch(task.objective, /currently appear and disappear/u);
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
  ).find((message) => message.kind === "user" && message.taskId !== undefined);
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

test("a follow-up to a busy thread agent queues behind its active task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "busy-thread-follow-up");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) handle the current work" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  await waitFor(
    async () => runtime.submittedTasks.length === 1 && runtime.runCalls.length === 1,
    "the active task never started",
  );
  const current = (
    await runtime.store.listSubmittedTasks({ repositoryId })
  ).find((task) => task.objective.includes("current work"));
  assert.ok(current !== undefined);
  await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
  const root = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.taskId === current.id);
  assert.ok(root !== undefined, "the active task never opened its thread");

  // This is the shape that used to miss the verb-list task check and enter a
  // provider answer turn. Because that provider is occupied by `current`, it
  // waited for the 180-second question timeout instead of retaining the work.
  const followUp =
    "when I give you another task while this one is in progress, queue it " +
    "for afterward";
  assert.equal(looksLikeTaskRequest(followUp), false);
  const promptsBefore = runtime.chatPrompts.length;
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: followUp } },
  );
  assert.equal(replied.status, 201, JSON.stringify(replied.data));
  await waitFor(
    async () => runtime.submittedTasks.length === 2,
    "the busy agent's follow-up was not retained as queued work",
  );

  assert.equal(
    runtime.chatPrompts.length,
    promptsBefore,
    "a busy provider should not receive a competing direct-answer turn",
  );
  assert.equal(runtime.submittedTasks[1]?.queueAfterCurrent, true);
  assert.equal(
    runtime.runCalls.length,
    1,
    "queued work must not ask the repository to run before its predecessor",
  );
  const queued = (
    await runtime.store.listSubmittedTasks({ repositoryId })
  ).find((task) => task.id !== current.id);
  assert.equal(queued?.afterTaskId, current.id);
  assert.deepEqual(
    await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID),
    [],
  );

  await runtime.store.completeSubmittedTask(current.id, "integrated");
  await runtime.store.appendAudit(undefined, {
    type: "task_reported",
    taskId: current.id,
    data: { explanation: "Current work finished." },
  });
  await waitFor(
    async () => runtime.runCalls.length === 2,
    "the queued follow-up did not start after its predecessor finished",
  );
  const [claimed] = await runtime.store.claimSubmittedTasks(
    repositoryId,
    DEFAULT_PROJECT_ID,
  );
  assert.equal(claimed?.id, queued?.id);
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
  ).find((message) => message.kind === "user" && message.taskId !== undefined);
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

  // This thread is now older than another room message. Continuing inside it
  // should update the conversation without changing either root's position.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newerRoot = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "user",
    authorId: ownerId,
    content: "A newer room message that should remain below the thread.",
  });
  const beforeReply = await runtime.store.listChannelMessages(
    repositoryId,
    ownerId,
  );
  assert.ok(
    beforeReply.findIndex((message) => message.id === threadRoot.id) <
      beforeReply.findIndex((message) => message.id === newerRoot.id),
    "the test needs an older thread followed by a newer room message",
  );

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
  const afterReply = await runtime.store.listChannelMessages(
    repositoryId,
    ownerId,
  );
  assert.deepEqual(
    afterReply.map((message) => message.id),
    beforeReply.map((message) => message.id),
    "replying inside a thread must preserve its channel position",
  );
  const updatedRoot = afterReply.find(
    (message) => message.id === threadRoot.id,
  );
  assert.ok(
    updatedRoot?.replies.some(
      (reply) =>
        reply.kind === "user" &&
        reply.content === "@Other now update the config loader the same way",
    ),
    "the reply must still append to the intended thread",
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
  // The request opens the objective with nothing prefixed to it; the
  // directives every task carries follow it.
  assert.match(second.objective, /^one more thing please\n\n/u);
  assert.doesNotMatch(second.objective, /^Your role in this repository/u);
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
  ).find((message) => message.kind === "user" && message.taskId !== undefined);
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
      (entry) => entry.kind === "user" && entry.taskId !== undefined,
    );
    return (message?.changedFiles?.length ?? 0) > 0;
  }, "the thread never picked up what the run was changing");

  const listed = await owner.request(`${base}/messages`);
  const thread = (listed.data.messages as any[]).find(
    (message) => message.kind === "user" && message.taskId !== undefined,
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
      (entry) => entry.kind === "user" && entry.taskId !== undefined,
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
  ).find((message) => message.kind === "user" && message.taskId !== undefined);
  assert.equal(
    root?.replies[0]?.content,
    "I've taken this task and I'm working on the plan.",
  );
  const replies = (root?.replies ?? []).map((reply) => reply.content).join("\n");
  assert.doesNotMatch(replies, /That's the plan/u);
  assert.match(replies, /Waiting on you/u);
  assert.match(replies, /reply "go ahead" and I'll start/iu);
  // The plan itself is a reply of its own kind, not another agent remark:
  // that mark is what lets the browser keep the document out of the thread
  // and open it in its own panel beside the room.
  const plan = (root?.replies ?? []).filter((reply) => reply.kind === "plan");
  assert.equal(plan.length, 1, JSON.stringify(root?.replies));
  assert.ok((plan[0]?.content ?? "").trim().length > 0);
  // And the thread still names itself, so every surface that reads a title
  // off the "Task:" line keeps working.
  assert.equal(
    (root?.replies ?? []).filter((reply) => /^Task: /u.test(reply.content)).length,
    1,
    JSON.stringify(root?.replies),
  );
  // The plan was thought about with the code open. `/plan` used to be
  // answered by the same cheap ceremonial call that writes a thread's opening
  // caption — no repository, low effort — so it could only restate the
  // request back. This is the check that it asks with the checkout in hand.
  const planning = runtime.chatPrompts.find((entry) =>
    /read-only checkout of this repository/u.test(entry.prompt),
  );
  assert.notEqual(planning, undefined, JSON.stringify(runtime.chatPrompts));
  assert.equal(planning?.repositoryId, repositoryId);

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
    ).find((message) => message.kind === "user" && message.taskId !== undefined);
    return (thread?.replies ?? []).some((reply) =>
      /Starting now/u.test(reply.content),
    );
  }, "the approved plan never started");
});

test("only the person who asked can start a held plan", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "plan-hold-owner");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const bystander = await addColleague(runtime, "bystander@example.com");

  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/plan @Claude (Owner) rework the retry loop" },
  });
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.equal(task?.status, "planned");
  const root = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.kind === "user" && message.taskId !== undefined);
  const thread = `${base}/messages/${encodeURIComponent(root?.id ?? "")}/replies`;

  // Somebody else in the room says go. The plan is not theirs to spend: it
  // runs on the account of whoever asked for it, and nothing about the
  // thread tells them that, so the refusal has to.
  const notTheirs = await bystander.client.request(thread, {
    method: "POST",
    body: { content: "go ahead" },
  });
  assert.equal(notTheirs.status, 201);
  await waitFor(async () => {
    const held = (
      await runtime.store.listChannelMessages(repositoryId, ownerId)
    ).find((message) => message.kind === "user" && message.taskId !== undefined);
    return (held?.replies ?? []).some((reply) => /Owner's to start/u.test(reply.content));
  }, "the bystander was never told whose plan this is");

  // And it really is still held — the refusal is the point, not the wording.
  assert.equal(
    (await runtime.store.listSubmittedTasks({ repositoryId }))[0]?.status,
    "planned",
  );

  // The person who asked says the same words, and it starts.
  const theirs = await owner.request(thread, {
    method: "POST",
    body: { content: "go ahead" },
  });
  assert.equal(theirs.status, 201);
  await waitFor(async () => {
    const started = (
      await runtime.store.listChannelMessages(repositoryId, ownerId)
    ).find((message) => message.kind === "user" && message.taskId !== undefined);
    return (started?.replies ?? []).some((reply) =>
      /Starting now/u.test(reply.content),
    );
  }, "the plan's own author could not start it");
});

test("a held plan nobody is recorded as asking for still starts", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "plan-hold-orphan");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Work filed outside a channel — over the API, or from the command line —
  // records nobody as having asked. Held plans like that predate this rule
  // and would otherwise be unstartable by anyone, which is worse than the
  // thing the rule prevents.
  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "rework the retry loop",
    agentId: "hud-agent",
    validationCommands: [],
    planOnly: true,
  });
  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "That's the plan — nothing is running yet.",
  });
  await runtime.store.setChannelMessageTask(repositoryId, root.id, task.id);

  const go = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "go ahead" } },
  );
  assert.equal(go.status, 201);
  await waitFor(async () => {
    const released = (
      await runtime.store.listSubmittedTasks({ repositoryId })
    ).find((entry) => entry.id === task.id);
    return released?.status !== "planned";
  }, "a plan with no recorded requester was stranded");
});

test("a plan nobody starts is let go, and a late go-ahead is told why", async (t) => {
  const runtime = await startRuntime(t, {
    // The deadline itself, compressed. This is about what happens when a hold
    // runs out, not about how long fifteen minutes is — but long enough that
    // the hold below is fully written before its clock can run out, which is
    // the one thing a zero would make racy.
    planHoldTtlMs: 250,
    threadReconcileIntervalMs: 25,
  });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "plan-hold-lapse");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Filed straight into the store, which is also the shape a hold has after
  // the deploy that killed the process holding it: a `planned` row, a thread,
  // and nothing in this gateway's memory that knows either exists. If the
  // deadline lived in a timer this is exactly the case it would miss.
  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "rework the retry loop",
    agentId: "hud-agent",
    validationCommands: [],
    planOnly: true,
  });
  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "That's the plan — nothing is running yet.",
  });
  await runtime.store.setChannelMessageTask(repositoryId, root.id, task.id);

  const lapseNotices = async (): Promise<string[]> =>
    (
      (await runtime.store.getChannelMessage(repositoryId, root.id, ownerId))
        ?.replies ?? []
    )
      .map((reply) => reply.content)
      .filter((content) => /Plan expired/u.test(content));

  await waitFor(
    async () => (await lapseNotices()).length > 0,
    "a plan nobody started was still held after its deadline",
  );
  assert.equal(
    (await runtime.store.listSubmittedTasks({ repositoryId })).find(
      (entry) => entry.id === task.id,
    )?.status,
    "cancelled",
    "the thread said the plan had lapsed while the task was still held",
  );

  const said = await lapseNotices();
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.match(said[0] ?? "", /nobody started this/iu);
  // Not the hold's own opening: the browser recognises that one and would go
  // on drawing this as a thread still waiting on somebody.
  assert.doesNotMatch(said[0] ?? "", /Waiting on you/u);

  // The sweep runs on a timer, so it sees this thread again and again. One
  // lapse, one line.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await lapseNotices()).length, 1);

  // And the answer that arrives too late is answered, rather than dropped
  // into the chat model as a stray "go ahead".
  const late = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "go ahead" } },
  );
  assert.equal(late.status, 201);
  await waitFor(async () => {
    const answered = await runtime.store.getChannelMessage(
      repositoryId,
      root.id,
      ownerId,
    );
    return (answered?.replies ?? []).some((reply) =>
      /ran out of time/u.test(reply.content),
    );
  }, "a go-ahead after the deadline was met with silence");
  assert.equal(
    (await runtime.store.listSubmittedTasks({ repositoryId })).find(
      (entry) => entry.id === task.id,
    )?.status,
    "cancelled",
    "a lapsed plan was started by a late go-ahead",
  );
});

test("a plan still inside its deadline is left alone", async (t) => {
  const runtime = await startRuntime(t, {
    // A minute, so the sweep below is running against a deadline that has
    // certainly not passed — and the test never depends on what the
    // environment has configured.
    planHoldTtlMs: 60_000,
    threadReconcileIntervalMs: 25,
  });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "plan-hold-live");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/plan @Claude (Owner) rework the retry loop" },
  });
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.equal(task?.status, "planned");

  // Several sweeps, all of them a long way inside the deadline.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    (await runtime.store.listSubmittedTasks({ repositoryId }))[0]?.status,
    "planned",
    "a plan well inside its deadline was let go",
  );
  const root = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.kind === "user" && message.taskId !== undefined);
  assert.ok(
    !(root?.replies ?? []).some((reply) => /Plan expired/u.test(reply.content)),
    JSON.stringify(root?.replies),
  );

  // And it still starts, which is the behaviour the deadline must not cost.
  const go = await owner.request(
    `${base}/messages/${encodeURIComponent(root?.id ?? "")}/replies`,
    { method: "POST", body: { content: "go ahead" } },
  );
  assert.equal(go.status, 201);
  await waitFor(async () => {
    const started = (
      await runtime.store.listChannelMessages(repositoryId, ownerId)
    ).find((message) => message.kind === "user" && message.taskId !== undefined);
    return (started?.replies ?? []).some((reply) =>
      /Starting now/u.test(reply.content),
    );
  }, "a live plan could no longer be started");
});

test("/queue chains one agent's follow-up work without claiming it early", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "slash-queue");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Bad queue commands are explained and never create empty or unroutable
  // work.
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/queue do this later" },
  });
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/queue @Claude (Owner)" },
  });
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: "/queue @Claude (Owner) @Codex (Owner) duplicate work",
    },
  });
  assert.equal(runtime.submittedTasks.length, 0);
  const rejected = await owner.request(`${base}/messages`);
  assert.match(
    (rejected.data.messages as Array<{ content: string }>)
      .map((message) => message.content)
      .join("\n"),
    /\/queue @agent what should run next/u,
  );

  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) handle current work" },
  });
  const current = (await runtime.store.listSubmittedTasks({ repositoryId }))[0];
  assert.ok(current !== undefined);
  await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);

  for (const objective of ["first follow-up", "second follow-up"]) {
    const posted = await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: `/queue @Claude (Owner) ${objective}` },
    });
    assert.equal(posted.status, 201, JSON.stringify(posted.data));
  }
  assert.equal(runtime.submittedTasks.length, 3);
  assert.ok(
    runtime.submittedTasks
      .slice(1)
      .every((task) => task.queueAfterCurrent === true),
  );
  assert.equal(runtime.runCalls.length, 1);
  const tasks = await runtime.store.listSubmittedTasks({ repositoryId });
  const first = tasks.find((task) => task.objective.includes("first follow-up"));
  const second = tasks.find((task) => task.objective.includes("second follow-up"));
  assert.equal(first?.afterTaskId, current.id);
  assert.equal(second?.afterTaskId, first?.id);
  const queuedRoots = await runtime.store.listChannelMessages(
    repositoryId,
    ownerId,
  );
  assert.equal(
    queuedRoots
      .flatMap((root) => root.replies)
      .filter(
        (reply) =>
          reply.content ===
          "I've taken this task and queued it behind my current work.",
      ).length,
    2,
  );
  assert.deepEqual(
    await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID),
    [],
  );

  await runtime.store.completeSubmittedTask(current.id, "integrated");
  await runtime.store.appendAudit(undefined, {
    type: "task_reported",
    taskId: current.id,
    data: { explanation: "Current work finished." },
  });
  await waitFor(
    async () => runtime.runCalls.length === 2,
    "the first queued task was not started after its predecessor finished",
  );
  const [firstClaim] = await runtime.store.claimSubmittedTasks(
    repositoryId,
    DEFAULT_PROJECT_ID,
  );
  assert.equal(firstClaim?.id, first?.id);
  assert.ok(first !== undefined);
  await runtime.store.completeSubmittedTask(first.id, "integrated");
  await runtime.store.appendAudit(undefined, {
    type: "task_reported",
    taskId: first.id,
    data: { explanation: "First follow-up finished." },
  });
  await waitFor(
    async () => runtime.runCalls.length === 3,
    "the second queued task was not started after the first finished",
  );
  const [secondClaim] = await runtime.store.claimSubmittedTasks(
    repositoryId,
    DEFAULT_PROJECT_ID,
  );
  assert.equal(secondClaim?.id, second?.id);
  assert.ok(second !== undefined);
  await runtime.store.completeSubmittedTask(second.id, "integrated");

  // With no unfinished task, the same command is submitted normally and is
  // immediately claimable.
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/queue @Claude (Owner) idle follow-up" },
  });
  const idle = (await runtime.store.listSubmittedTasks({ repositoryId })).find(
    (task) => task.objective.includes("idle follow-up"),
  );
  assert.equal(idle?.afterTaskId, undefined);
  assert.equal(runtime.runCalls.length, 4);
  const [idleClaim] = await runtime.store.claimSubmittedTasks(
    repositoryId,
    DEFAULT_PROJECT_ID,
  );
  assert.equal(idleClaim?.id, idle?.id);
});

test("/dnc is answered without announcing the constraint and files no task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "dnc-answers-only");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.text = "The retry loop backs off twice and then gives up.";

  // Worded as work on purpose: without the command this sentence is a task.
  // "Do not code" has to beat the verb reading, not just accompany it.
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/dnc @Claude (Owner) rework the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  // An answer, not a task: nothing submitted, nothing to open a thread for.
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const listed = await owner.request(`${base}/messages`);
  const answer = (listed.data.messages as any[]).find(
    (message) => message.kind === "agent",
  );
  assert.equal(answer?.content, runtime.chatAnswer.text);

  // The prompt makes the constraint silent, and the command word was lifted
  // out, so the message the agent is asked to answer is the sentence, not the
  // syntax. (The prompt's channel-context section may still quote the raw
  // "/dnc" line; "The message:" is the part that must be clean.)
  const prompt = runtime.chatPrompts.at(-1)?.prompt ?? "";
  assert.match(prompt, /Silently treat this as read-only/u);
  assert.match(prompt, /without mentioning `\/dnc`/u);
  assert.match(prompt, /calling it a do-not-code request/u);
  assert.match(prompt, /The message: @Claude \(Owner\) rework the retry loop/u);
});

test("/dnc and @agents answers never auto-dispatch suggested work", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "answer-task-guards");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.channelAnswerText =
    "The retry loop should use a bounded backoff.\n" +
    "ANSWER_TASK: Bound the retry loop and add regression coverage";

  const readOnly = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/dnc @Claude (Owner) should the retry loop be bounded?" },
  });
  assert.equal(readOnly.status, 201, JSON.stringify(readOnly.data));

  const broadcast = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@agents should the retry loop be bounded?" },
  });
  assert.equal(broadcast.status, 201, JSON.stringify(broadcast.data));

  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const listed = await owner.request(`${base}/messages`);
  const answers = (listed.data.messages as any[]).filter(
    (message) => message.kind === "agent",
  );
  assert.equal(answers.length, 2, JSON.stringify(listed.data.messages));
  assert.ok(
    answers.every(
      (message) =>
        message.content === "The retry loop should use a bounded backoff.",
    ),
    JSON.stringify(answers),
  );
  assert.ok(
    answers.every((message) => !String(message.content).includes("ANSWER_TASK")),
    JSON.stringify(answers),
  );
});

test("/dnc prompt permits read-only shell inspection but forbids edits", async (t) => {
  // "Do not code" is not "do not look". Asked for a line count, the agent used
  // to answer that it had no permission to run a shell command — a refusal the
  // reader could do nothing about, in place of the number they asked for.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "dnc-may-look");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.text = "About 90,000 lines across 400 files.";

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/dnc @Claude (Owner) just give me a LOC report" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));

  const prompt = runtime.chatPrompts.at(-1)?.prompt ?? "";
  // Commands are asked for by name, in either shell the host might run.
  assert.match(prompt, /run whatever shell commands you need/u);
  assert.match(prompt, /bash or PowerShell/u);
  // And the half that has to survive: reading only, and no code.
  assert.match(prompt, /as long as they only read/u);
  assert.match(prompt, /Do not write or change code/u);
  assert.doesNotMatch(prompt, /Do not write, change, or run anything/u);
});

test("/dnc in a thread is answered without announcing the constraint or filing a task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic" }]);
  const repositoryId = await invitableRepository(owner, "dnc-thread-answers-only");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  // An agent-authored thread: the place where a work-verbed reply used to be
  // dispatched as a task even when the command promised it would not be.
  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it — reworking the retry helper.",
  });

  runtime.chatAnswer.text = "It retries twice and then backs off for good.";
  // Worded as work on purpose, like the channel test above: the command has
  // to beat the verb reading in a thread too.
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "/dnc rework the retry loop" } },
  );
  assert.equal(replied.status, 201, JSON.stringify(replied.data));

  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    const thread = (listed.data.messages as any[]).find(
      (message) => message.id === root.id,
    );
    return thread?.replies?.some(
      (reply: any) => reply.content === runtime.chatAnswer.text,
    ) === true;
  }, "the do-not-code reply was never answered in its thread");

  // Answered, never dispatched — no task is the whole guarantee: nothing to
  // plan, nothing for the coordinator to run.
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const prompt = runtime.chatPrompts.at(-1)?.prompt ?? "";
  assert.match(prompt, /Silently treat this as read-only/u);
  assert.match(prompt, /calling it a do-not-code request/u);
  // The command word is lifted out of the question slot, as in the channel.
  assert.match(prompt, /The question: rework the retry loop/u);
});

test("/ask always submits a task marked for a forced question round", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "ask-forces-questions");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // The command written last must be lifted out and remembered structurally,
  // not lost because it was not the first word in the message.
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) change the background color /ask" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  assert.match(
    runtime.submittedTasks[0]?.objective ?? "",
    /change the background color/u,
  );
  assert.match(
    runtime.submittedTasks[0]?.objective ?? "",
    /force a question round before implementation/u,
  );
  assert.doesNotMatch(runtime.submittedTasks[0]?.objective ?? "", /\/ask/u);
});

test("/ask bypasses the direct-answer path even when its objective is a question", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "ask-question-task");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: "/ask @Claude (Owner) which background color should we use?",
    },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  assert.match(
    runtime.submittedTasks[0]?.objective ?? "",
    /which background color should we use\?/u,
  );
  assert.match(
    runtime.submittedTasks[0]?.objective ?? "",
    /force a question round before implementation/u,
  );
});

test("/ask in a thread reply starts the same forced question task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic" }]);
  const repositoryId = await invitableRepository(owner, "ask-thread-questions");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it — reworking the dashboard styles.",
  });

  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "change the background color /ask" } },
  );
  assert.equal(replied.status, 201, JSON.stringify(replied.data));

  await waitFor(async () => {
    return runtime.submittedTasks.length === 1;
  }, "the thread /ask was never dispatched");

  assert.equal(runtime.submittedTasks[0]?.conversationId, root.id);
  assert.match(
    runtime.submittedTasks[0]?.objective ?? "",
    /force a question round before implementation/u,
  );
});

test("only a reply that adds nothing counts as the request repeated back", () => {
  // The reported case, quotes and capitals and all.
  assert.equal(
    readsAsEchoOfRequest("@Zeus change the background color", '"Change the background"'),
    true,
  );
  assert.equal(
    readsAsEchoOfRequest("change the background color", "change the background color"),
    true,
  );
  // Anything that says something is an answer, however short.
  assert.equal(
    readsAsEchoOfRequest(
      "change the background color",
      "Changing the background means editing the dashboard stylesheet.",
    ),
    false,
  );
  assert.equal(readsAsEchoOfRequest("is the retry loop bounded?", "Yes."), false);
  assert.equal(readsAsEchoOfRequest("", "Change the background"), false);
});

test("/dnc with nobody mentioned never auto-claims, and says how to ask", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "dnc-no-mention");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Task-worded and unaddressed — without the command this is exactly the
  // message auto-claim dispatches. The command's promise has to hold on this
  // path too.
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/dnc fix the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const after = await owner.request(`${base}/messages`);
  const contents = (after.data.messages as any[]).map((message) =>
    String(message.content),
  );
  assert.ok(
    contents.every((line) => !/^Want me to take this/u.test(line)),
    JSON.stringify(contents),
  );
  // Not silence either: the sender is told what a do-not-code ask needs.
  const hint = (after.data.messages as any[]).find(
    (message) => message.kind === "system",
  );
  assert.match(String(hint?.content), /`\/dnc` answers without starting work/u);
  assert.match(String(hint?.content), /\/dnc @agent your question/u);
});

test("@agents /dnc silently keeps every answer read-only and files no task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "dnc-broadcast");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.text = "The retry loop caps at five attempts.";

  // Task-worded and not a question: without the command the broadcast gate
  // refuses this outright as a would-be broadcast task. The command says it
  // is a question, so the verb reading must give way here as everywhere.
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/dnc @agents rework the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const listed = await owner.request(`${base}/messages`);
  const answer = (listed.data.messages as any[]).find(
    (message) => message.kind === "agent",
  );
  assert.equal(answer?.content, runtime.chatAnswer.text);
  // The silent read-only constraint reaches every answer of the fan-out, in
  // the same directive slot the single-mention path fills.
  const prompt = runtime.chatPrompts.at(-1)?.prompt ?? "";
  assert.match(prompt, /Silently treat this as read-only/u);
  assert.match(prompt, /without mentioning `\/dnc`/u);
});

test("/simple keeps it brief in both places a reply is written from", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "personal" },
  ]);

  // Work: the directive rides inside the objective string itself, so it
  // reaches the worker with no new field anywhere between here and there.
  const taskRepo = await invitableRepository(owner, "simple-brief-task");
  await joinAllConnectedAgents(runtime, taskRepo);
  const taskBase = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${taskRepo}/channel`;
  const work = await owner.request(`${taskBase}/messages`, {
    method: "POST",
    body: { content: "/simple @Claude (Owner) rework the retry loop" },
  });
  assert.equal(work.status, 201, JSON.stringify(work.data));
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  const objective = runtime.submittedTasks[0]?.objective ?? "";
  assert.match(objective, /rework the retry loop/u);
  assert.match(objective, /short and simple/u);
  assert.doesNotMatch(objective, /\/simple/u);

  // A question: the same ask lands in the answer prompt instead, and still
  // never becomes a task.
  const askRepo = await invitableRepository(owner, "simple-brief-question");
  await joinAllConnectedAgents(runtime, askRepo);
  const askBase = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${askRepo}/channel`;
  const asked = await owner.request(`${askBase}/messages`, {
    method: "POST",
    body: { content: "/simple @Claude (Owner) what are you working on?" },
  });
  assert.equal(asked.status, 201, JSON.stringify(asked.data));
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  // Found by content rather than taken from the end: the task above owes an
  // un-awaited opening-thoughts call that could land in `chatPrompts` at any
  // time.
  const prompt = runtime.chatPrompts
    .map((entry) => entry.prompt)
    .find((entry) => entry.includes("what are you working on?"));
  assert.ok(prompt, JSON.stringify(runtime.chatPrompts));
  assert.match(prompt ?? "", /short and simple/u);

  // A terse answer request has no question mark or interrogative opener, but
  // it is still asking for information. Keep it on the same read-only answer
  // path instead of manufacturing an empty edit task whose result starts with
  // "No files changed".
  const summaryRepo = await invitableRepository(owner, "simple-brief-summary");
  await joinAllConnectedAgents(runtime, summaryRepo);
  const summaryBase = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${summaryRepo}/channel`;
  const summarized = await owner.request(`${summaryBase}/messages`, {
    method: "POST",
    body: { content: "/simple @Claude (Owner) summary of the codebase" },
  });
  assert.equal(summarized.status, 201, JSON.stringify(summarized.data));
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  const summaryPrompt = runtime.chatPrompts
    .map((entry) => entry.prompt)
    .find((entry) => entry.includes("summary of the codebase"));
  assert.ok(summaryPrompt, JSON.stringify(runtime.chatPrompts));
  assert.match(summaryPrompt ?? "", /short and simple/u);
});

test("every task and every answer is told to end on the answer, not a status", async (t) => {
  // What was reaching the room: "I'll wait for the search agent to finish and
  // report back", posted verbatim as the reply, read as the answer by
  // everybody in the channel. No command asks for this and none can turn it
  // off — it rides with plain work and plain questions alike.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);

  const taskRepo = await invitableRepository(owner, "answer-not-status-task");
  await joinAllConnectedAgents(runtime, taskRepo);
  const taskBase = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${taskRepo}/channel`;
  const work = await owner.request(`${taskBase}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) rework the retry loop" },
  });
  assert.equal(work.status, 201, JSON.stringify(work.data));
  const objective = runtime.submittedTasks[0]?.objective ?? "";
  assert.match(objective, /final message is the answer, not a status report/u);
  assert.match(objective, /never end a turn saying a search is running/u);

  const askRepo = await invitableRepository(owner, "answer-not-status-question");
  await joinAllConnectedAgents(runtime, askRepo);
  const askBase = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${askRepo}/channel`;
  const asked = await owner.request(`${askBase}/messages`, {
    method: "POST",
    body: { content: "/simple @Claude (Owner) what are you working on?" },
  });
  assert.equal(asked.status, 201, JSON.stringify(asked.data));
  const prompt = runtime.chatPrompts
    .map((entry) => entry.prompt)
    .find((entry) => entry.includes("what are you working on?"));
  assert.ok(prompt, JSON.stringify(runtime.chatPrompts));
  assert.match(prompt ?? "", /final message is the answer, not a status report/u);
  // `/simple` still applies, and reads after it: brevity is the outer
  // instruction, and the shortest true answer satisfies both.
  assert.match(prompt ?? "", /short and simple/u);
  assert.ok(
    (prompt ?? "").indexOf("final message is the answer") <
      (prompt ?? "").indexOf("short and simple"),
    prompt ?? "",
  );
});

test("/push publishes directly as the sender without planning or running a task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "push-command");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/push" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.deepEqual(runtime.pushCalls, [
    {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      actorId: bootstrapped.user.id,
    },
  ]);
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  assert.equal(runtime.runCalls.length, 0);
  const listed = await owner.request(`${base}/messages`);
  assert.match(
    (listed.data.messages as any[]).map((message) => String(message.content)).join("\n"),
    /Pushed canonical to coord\/export-test on GitHub/u,
  );
});

test("/push returns a sync choice and its retry publishes after that choice", async (t) => {
  const runtime = await startRuntime(t, {
    pushOutcomes: [
      {
        outcome: "refused",
        detail: {
          syncConflict: true,
          conflicts: ["src/shared.ts"],
        },
        explanation: "Both sides changed src/shared.ts.",
      },
      {
        outcome: "done",
        explanation: "Pushed to coord/resolved-sync on GitHub.",
      },
    ],
  });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "push-sync-choice");
  const messages =
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages`;

  const posted = await owner.request(messages, {
    method: "POST",
    body: { content: "/push" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.deepEqual(posted.data.command, {
    name: "push",
    result: {
      outcome: "refused",
      detail: {
        syncConflict: true,
        conflicts: ["src/shared.ts"],
      },
      explanation: "Both sides changed src/shared.ts.",
    },
  });
  const beforeRetry = await owner.request(messages);
  assert.doesNotMatch(
    (beforeRetry.data.messages as any[])
      .map((message) => String(message.content))
      .join("\n"),
    /Both sides changed/u,
  );

  const retried = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/push`,
    { method: "POST", body: {} },
  );
  assert.equal(retried.status, 200, JSON.stringify(retried.data));
  assert.equal(retried.data.push.outcome, "done");
  assert.deepEqual(runtime.pushCalls, [
    {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      actorId: bootstrapped.user.id,
    },
    {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      actorId: bootstrapped.user.id,
    },
  ]);
  const afterRetry = await owner.request(messages);
  assert.match(
    (afterRetry.data.messages as any[])
      .map((message) => String(message.content))
      .join("\n"),
    /Pushed to coord\/resolved-sync on GitHub/u,
  );
});

test("/push reports refusals and unsupported deployments in the channel", async (t) => {
  const runtime = await startRuntime(t, {
    pushOutcome: {
      outcome: "refused",
      explanation: "You haven't connected GitHub, so nothing was pushed.",
    },
  });
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "push-refused");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "/push" },
    })).status,
    201,
  );
  const listed = await owner.request(`${base}/messages`);
  assert.match(
    (listed.data.messages as any[]).map((message) => String(message.content)).join("\n"),
    /haven't connected GitHub/u,
  );
  assert.equal(runtime.submittedTasks.length, 0);

  const limitedRuntime = await startRuntime(t, { withoutPushRepository: true });
  const limitedOwner = new TestClient(limitedRuntime.origin);
  await bootstrap(limitedOwner);
  const limitedRepository = await invitableRepository(
    limitedOwner,
    "push-unsupported",
  );
  const limitedBase =
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${limitedRepository}/channel`;
  assert.equal(
    (await limitedOwner.request(`${limitedBase}/messages`, {
      method: "POST",
      body: { content: "/push" },
    })).status,
    201,
  );
  const limitedListed = await limitedOwner.request(`${limitedBase}/messages`);
  assert.match(
    (limitedListed.data.messages as any[])
      .map((message) => String(message.content))
      .join("\n"),
    /cannot push repositories from the channel/u,
  );
  assert.equal(limitedRuntime.submittedTasks.length, 0);
});

test("a held run keeps its waiting status inside the task thread", async (t) => {
  // Workflow state belongs to the task's story. The thread and task status
  // make the hold visible without interrupting the repository-wide transcript
  // with a standalone agent message.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "held-plan-visible");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/plan @Claude (Owner) rework the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(
      repositoryId,
      ownerId,
    );
    const thread = messages.find(
      (message) => message.kind === "user" && message.taskId !== undefined,
    );
    return (thread?.replies ?? []).some((reply) =>
      /Waiting on you/u.test(reply.content),
    );
  }, "the plan's thread never recorded that it was held");

  const messages = await runtime.store.listChannelMessages(
    repositoryId,
    ownerId,
  );
  const thread = messages.find(
    (message) => message.kind === "user" && message.taskId !== undefined,
  );
  const announced = (thread?.replies ?? []).find((reply) =>
    /Waiting on you/u.test(reply.content),
  );
  assert.equal(announced?.kind, "outcome");
  assert.match(announced?.content ?? "", /go ahead/u);
  assert.equal(
    messages.some((message) => /Waiting on you/u.test(message.content)),
    false,
    JSON.stringify(messages.map((message) => message.content)),
  );
});

test('"go ahead" releases a review gate from the thread it was announced in', async (t) => {
  // The other hold. It could only be released through `POST /approvals/:id`,
  // a screen nobody watching a channel is on, so "go ahead" in the thread
  // fell through to the agent answering a question *about* the gate — which
  // reads exactly like it did something, while the run stayed held.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "gated-run");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it.",
  });
  await runtime.store.addChannelReply({
    repositoryId,
    messageId: root.id,
    kind: "progress",
    authorId: `${ownerId}:anthropic`,
    content: "Waiting on a human review before this can land.",
  });
  await runtime.store.setChannelMessageTask(repositoryId, root.id, "task_gated");
  const approval = await runtime.store.createApproval({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId,
    runId: "run_gated",
    taskId: "task_gated",
    kind: "policy_override",
    requestedBy: "claude",
    requiredRole: "admin",
    reasons: ["schema change"],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

  const go = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "go ahead" } },
  );
  assert.equal(go.status, 201, JSON.stringify(go.data));

  await waitFor(async () => {
    const current = await runtime.store.getApproval(approval.id);
    return current?.status === "approved";
  }, "the gate was never released by the go-ahead");
  const decided = await runtime.store.getApproval(approval.id);
  assert.equal(decided?.decidedBy, ownerId);

  // And the thread says it happened, rather than leaving the reader to guess
  // from a run that quietly resumed.
  const thread = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.id === root.id);
  assert.match(
    (thread?.replies ?? []).map((reply) => reply.content).join("\n"),
    /Approved/u,
  );
});

test("a released hold keeps both workflow markers inside the task thread", async (t) => {
  // The release follows the hold in the same task story. Neither lifecycle
  // marker becomes a standalone group-chat message.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "released-plan");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/plan @Claude (Owner) rework the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(
      repositoryId,
      ownerId,
    );
    return messages.some((message) =>
      (message.replies ?? []).some((reply) =>
        /Waiting on you/u.test(reply.content),
      ),
    );
  }, "the thread was never told the plan was held");

  const root = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.kind === "user" && message.taskId !== undefined);
  const go = await owner.request(
    `${base}/messages/${encodeURIComponent(root?.id ?? "")}/replies`,
    { method: "POST", body: { content: "go ahead" } },
  );
  assert.equal(go.status, 201, JSON.stringify(go.data));

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(
      repositoryId,
      ownerId,
    );
    return messages.some((message) =>
      (message.replies ?? []).some((reply) =>
        /Go-ahead received/u.test(reply.content),
      ),
    );
  }, "the thread was never told the hold had been released");

  // Exactly one ordered pair in the thread, and neither status in the room.
  const messages = await runtime.store.listChannelMessages(
    repositoryId,
    ownerId,
  );
  assert.equal(
    messages.some((message) =>
      /Waiting on you|Go-ahead received/u.test(message.content),
    ),
    false,
    JSON.stringify(messages.map((message) => message.content)),
  );
  const updatedRoot = messages.find((message) => message.id === root?.id);
  const replies = updatedRoot?.replies ?? [];
  assert.equal(
    replies.filter((reply) => /Waiting on you/u.test(reply.content)).length,
    1,
    JSON.stringify(replies.map((reply) => reply.content)),
  );
  const held = replies.findIndex((reply) =>
    /Waiting on you/u.test(reply.content),
  );
  const released = replies.findIndex((reply) =>
    /Go-ahead received/u.test(reply.content),
  );
  assert.ok(released > held, "the release did not follow the hold");
});

test("a gate's hold and release stay ordered and deduplicated in its thread", async (t) => {
  // Two ways in and one way out. The audit stream is polled rather than
  // delivered once, and a run can ask for a second gate while the first is
  // still up — both would put the same sentence in the thread twice, which
  // reads as two separate things waiting on the reader. And a reviewer who
  // clears the gate from the Approvals screen never touches the thread, so
  // the withdrawal has to be read from the stream both routes report to.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "gate-withdrawn");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) rework the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const taskId = (await runtime.store.listSubmittedTasks({ repositoryId }))[0]
    ?.id;
  assert.ok(taskId !== undefined);

  const gate = {
    projectId: DEFAULT_PROJECT_ID,
    repositoryId,
    approvalId: "approval_gate",
    requiredRole: "admin",
  };
  await runtime.store.appendAudit(undefined, {
    type: "approval_requested",
    taskId,
    data: gate,
  });
  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(
      repositoryId,
      ownerId,
    );
    return messages.some((message) =>
      (message.replies ?? []).some((reply) =>
        /Waiting on you/u.test(reply.content),
      ),
    );
  }, "the thread was never told the run was gated");

  // Asked for again while the first is still up: still one line.
  await runtime.store.appendAudit(undefined, {
    type: "approval_requested",
    taskId,
    data: gate,
  });
  await runtime.store.appendAudit(undefined, {
    type: "approval_decided",
    taskId,
    data: { ...gate, status: "approved", actorId: ownerId },
  });
  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(
      repositoryId,
      ownerId,
    );
    return messages.some((message) =>
      (message.replies ?? []).some((reply) =>
        /Go-ahead received/u.test(reply.content),
      ),
    );
  }, "the thread was never told the gate had been cleared");

  const messages = await runtime.store.listChannelMessages(
    repositoryId,
    ownerId,
  );
  assert.equal(
    messages.some((message) =>
      /Waiting on you|Go-ahead received/u.test(message.content),
    ),
    false,
    JSON.stringify(messages.map((message) => message.content)),
  );
  const thread = messages.find((message) => message.taskId === taskId);
  const replies = thread?.replies ?? [];
  assert.equal(
    replies.filter((reply) => /Waiting on you/u.test(reply.content)).length,
    1,
    JSON.stringify(replies.map((reply) => reply.content)),
  );
  assert.equal(
    replies.filter((reply) => /Go-ahead received/u.test(reply.content)).length,
    1,
    JSON.stringify(replies.map((reply) => reply.content)),
  );
  const held = replies.findIndex((reply) =>
    /Waiting on you/u.test(reply.content),
  );
  const released = replies.findIndex((reply) =>
    /Go-ahead received/u.test(reply.content),
  );
  assert.ok(released > held, "the release did not follow the hold");
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
  assert.match(
    (listed.data.messages as any[]).map((m) => m.content).join("\n"),
    /\/push\b/u,
  );
  // The picker reads the same table the channel parses by, so they cannot
  // offer and accept different things.
  assert.ok(
    (listed.data.slashCommands as any[]).some((entry) => entry.name === "plan"),
    JSON.stringify(listed.data.slashCommands),
  );
  assert.ok(
    (listed.data.slashCommands as any[]).some((entry) => entry.name === "push"),
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
      messages.find(
        (message) => message.kind === "user" && message.taskId !== undefined,
      ),
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

test("only the user who added an agent can rename it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "rename-owner-only");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const colleague = await addColleague(runtime, "agent-owner@example.com");
  runtime.chatConnections.set(colleague.id, [
    { provider: "anthropic", visibility: "org", callSign: "Athena" },
  ]);
  const added = await colleague.client.request(
    `${base}/agents/anthropic/membership`,
    { method: "POST" },
  );
  assert.equal(added.status, 200, JSON.stringify(added.data));

  // Even the organization owner cannot rename a connection a colleague
  // brought in. Repository authority is not ownership of their agent.
  const refused = await owner.request(
    `${base}/agents/${colleague.id}:anthropic`,
    { method: "POST", body: { name: "Apollo" } },
  );
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
  assert.equal(refused.data.error.code, "forbidden");

  const renamed = await colleague.client.request(
    `${base}/agents/${colleague.id}:anthropic`,
    { method: "POST", body: { name: "Artemis" } },
  );
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.scope, "account");
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

  // An older per-agent override, from before names became account-wide.
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

test("a repository can be renamed without its id moving, and only by somebody who may manage it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  await invitableRepository(owner, "renamable-repo");
  const repoPath = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/renamable-repo`;

  const renamed = await owner.request(repoPath, {
    method: "PATCH",
    body: { name: "Lattice Web" },
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.repository.displayName, "Lattice Web");
  // The id is what every other row and route addresses, so it never moves.
  assert.equal(renamed.data.repository.id, "renamable-repo");
  assert.equal(
    (await runtime.store.getRepository("renamable-repo"))?.displayName,
    "Lattice Web",
  );
  const events = await runtime.store.listAuditEvents({
    types: ["repository_renamed"],
  });
  assert.equal(events.length, 1);

  // An empty name is a clear rather than an error: back to being called by
  // the id, which is the only way to undo a rename.
  const cleared = await owner.request(repoPath, {
    method: "PATCH",
    body: { name: "" },
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  assert.equal(cleared.data.repository.displayName, undefined);
  assert.equal(
    (await runtime.store.getRepository("renamable-repo"))?.displayName,
    undefined,
  );

  const tooLong = await owner.request(repoPath, {
    method: "PATCH",
    body: { name: "x".repeat(81) },
  });
  assert.equal(tooLong.status, 400);

  // A developer who neither created it nor holds manage_project is refused,
  // exactly as they are for deletion.
  const developer = await runtime.store.createUser({
    email: "renamer-dev@example.com",
    displayName: "Renamer Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: developer.id,
    role: "developer",
  });
  const devClient = await loginAs(runtime.origin, developer.email);
  const refused = await devClient.request(repoPath, {
    method: "PATCH",
    body: { name: "Not Mine" },
  });
  assert.equal(refused.status, 403);
  assert.equal(
    (await runtime.store.getRepository("renamable-repo"))?.displayName,
    undefined,
  );
});

test("a repository's creator can rename it without manage_project, but deleting it is the owner's alone", async (t) => {
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
  await registerAccount(runtime.store, stranger, {
    email: "stranger-delete@example.com",
    displayName: "Stranger",
    password: PASSWORD,
  });
  const strangerAttempt = await stranger.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/dev-created-repo`,
    { method: "DELETE" },
  );
  assert.equal(strangerAttempt.status, 403);

  // The developer who created it can still rename it, despite lacking
  // manage_project — the creator's own additional path in.
  const renamed = await devClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/dev-created-repo`,
    { method: "PATCH", body: { name: "Their own repository" } },
  );
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));

  // Deleting it is another matter: it is irreversible and cascades the
  // channel, the grants and the history, so creating a repository does not
  // by itself entitle anyone to destroy it. Ownership does.
  const creatorAttempt = await devClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/dev-created-repo`,
    { method: "DELETE" },
  );
  assert.equal(creatorAttempt.status, 403, JSON.stringify(creatorAttempt.data));
  assert.notEqual(
    await runtime.store.getRepository("dev-created-repo"),
    undefined,
  );

  // The organization's owner can, and the deletion is audited.
  const deleted = await owner.request(
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

test("an organization admin cannot delete a repository they did not create", async (t) => {
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

  // manage_project is enough to administer a repository — renaming it,
  // moderating it, deciding who is on it — and deliberately not enough to
  // delete it out from under everyone working there.
  const refused = await adminClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/owner-created-repo`,
    { method: "DELETE" },
  );
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
  assert.notEqual(
    await runtime.store.getRepository("owner-created-repo"),
    undefined,
  );

  const renamed = await adminClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/owner-created-repo`,
    { method: "PATCH", body: { name: "Still theirs to rename" } },
  );
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
});

test("only an organization owner or a repository co-owner can delete a repository", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  await invitableRepository(owner, "co-owned-repo");

  // Somebody whose whole access is one repository-scoped grant: no
  // organization membership at all. At `developer` the grant reaches the
  // repository but not its deletion.
  const guest = await runtime.store.createUser({
    email: "co-owner-guest@example.com",
    displayName: "Guest",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveRepositoryGrant({
    repositoryId: "co-owned-repo",
    userId: guest.id,
    role: "developer",
    grantedBy: undefined,
    comped: false,
    createdAt: new Date().toISOString(),
  });
  const guestClient = await loginAs(runtime.origin, guest.email);
  const refused = await guestClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/co-owned-repo`,
    { method: "DELETE" },
  );
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
  assert.notEqual(
    await runtime.store.getRepository("co-owned-repo"),
    undefined,
  );

  // Promoted to co-owner — an `owner` grant on this repository, which is what
  // the People row's "Promote to co-owner" writes — the same person can.
  await runtime.store.saveRepositoryGrant({
    repositoryId: "co-owned-repo",
    userId: guest.id,
    role: "owner",
    grantedBy: undefined,
    comped: false,
    createdAt: new Date().toISOString(),
  });
  const deleted = await guestClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/co-owned-repo`,
    { method: "DELETE" },
  );
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal(
    await runtime.store.getRepository("co-owned-repo"),
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

test("promoting a repository-only guest to co-owner does not require organization membership", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  await invitableRepository(owner, "promote-guest-repo");

  const guest = await runtime.store.createUser({
    email: "guest-to-promote@example.com",
    displayName: "Repository Guest",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveRepositoryGrant({
    repositoryId: "promote-guest-repo",
    userId: guest.id,
    role: "viewer",
    grantedBy: bootstrapped.user.id,
    comped: false,
    createdAt: new Date().toISOString(),
  });

  const promoted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/promote-guest-repo/grants/${guest.id}`,
    { method: "POST", body: { role: "owner" } },
  );
  assert.equal(promoted.status, 200, JSON.stringify(promoted.data));
  assert.equal(promoted.data.grant.role, "owner");
  assert.equal(
    await runtime.store.getMembership(DEFAULT_ORGANIZATION_ID, guest.id),
    undefined,
  );

  // An unrelated account still cannot be added merely by knowing its id.
  const stranger = await runtime.store.createUser({
    email: "stranger-not-in-repo@example.com",
    displayName: "Stranger",
    passwordDigest: await hashPassword(PASSWORD),
  });
  const rejected = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/promote-guest-repo/grants/${stranger.id}`,
    { method: "POST", body: { role: "owner" } },
  );
  assert.equal(rejected.status, 404, JSON.stringify(rejected.data));
  assert.equal(rejected.data.error.code, "not_found");
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
    comped: false,
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

test("only the user who added an agent can remove it", async (t) => {
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

  // An admin still cannot remove somebody else's agent. Repository authority
  // does not transfer ownership of the connection that powers it.
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
  assert.equal(adminRemoval.status, 403, JSON.stringify(adminRemoval.data));
  assert.equal(adminRemoval.data.error.code, "forbidden");
  const rosterAfterModeration = await owner.request(`${base}/agents`);
  assert.equal(rosterAfterModeration.data.agents.length, 1);

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
  options: {
    bootstrapToken?: string;
    mailer?: Mailer;
    authRateLimitPerMinute?: number;
    allowedOrigins?: readonly string[];
    stripe?: StripeClient;
    stripeWebhookSecret?: string;
    stripePriceId?: string;
    appBaseUrl?: string;
    billingReconcileIntervalMs?: number;
  },
): Promise<{
  client: TestClient;
  store: CoordinationStore;
  sent: MailMessage[];
}> {
  const store = new InMemoryCoordinationStore();
  const sent: MailMessage[] = [];
  const gateway = new ApiGateway({
    store,
    operations: {} as unknown as ApiOperations,
    ...(options.bootstrapToken === undefined
      ? {}
      : { bootstrapToken: options.bootstrapToken }),
    ...(options.authRateLimitPerMinute === undefined
      ? {}
      : { authRateLimitPerMinute: options.authRateLimitPerMinute }),
    ...(options.allowedOrigins === undefined
      ? {}
      : { allowedOrigins: options.allowedOrigins }),
    ...(options.stripe === undefined ? {} : { stripe: options.stripe }),
    ...(options.stripeWebhookSecret === undefined
      ? {}
      : { stripeWebhookSecret: options.stripeWebhookSecret }),
    ...(options.stripePriceId === undefined
      ? {}
      : { stripePriceId: options.stripePriceId }),
    ...(options.billingReconcileIntervalMs === undefined
      ? {}
      : { billingReconcileIntervalMs: options.billingReconcileIntervalMs }),
    // Stripe needs somewhere absolute to send a browser back to, and the
    // sign-up route refuses without one rather than letting Stripe answer
    // that for it.
    appBaseUrl: options.appBaseUrl ?? "https://kumi.test",
    // Never the real one: a test that opens a socket to a mail relay is a test
    // that fails on somebody else's network.
    mailer:
      options.mailer ??
      (async (message) => {
        sent.push(message);
      }),
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
  return {
    client: new TestClient(`http://127.0.0.1:${address.port}`),
    store,
    sent,
  };
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

test("a paid sign-up takes the card first and builds the account last", async (t) => {
  // The whole flow, in the order a person meets it: an address, a card, then
  // a name and a password. Nothing anybody can sign in to exists until the
  // money has cleared, which is what makes the public route safe to expose
  // and what stops a failed payment leaving an account behind.
  const secret = "whsec_example";
  let checkout: Record<string, unknown> | undefined;
  const stripe = {
    createCheckoutSession: async (input: Record<string, unknown>) => {
      checkout = input;
      return { id: "cs_paid", url: "https://checkout.example/cs_paid" };
    },
  } as unknown as StripeClient;
  const { client, store, sent } = await startBareGateway(t, {
    stripe,
    stripeWebhookSecret: secret,
    stripePriceId: "price_example",
  });

  // 1. An address. No account, no organization — only an intent naming an id
  //    that does not exist yet.
  const started = await client.request("/api/v1/auth/signup", {
    method: "POST",
    body: { email: "Buyer@Example.com", organizationName: "Buyer's team" },
  });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.equal(started.data.url, "https://checkout.example/cs_paid");
  assert.equal(await store.countUsers(), 0, "paying comes before the account");
  // The card is taken today and the trial is Stripe's to run.
  assert.equal(checkout?.["trialPeriodDays"], 14);
  assert.equal(checkout?.["customerEmail"], "buyer@example.com");
  const organizationId = String(checkout?.["organizationId"] ?? "");
  assert.match(organizationId, /^org_/u);
  assert.equal(await store.getOrganization(organizationId), undefined);

  // The claim link is the checkout's return address — and it is also mailed,
  // so the browser tab is not the only copy. Somebody who pays and closes the
  // tab has otherwise bought an organization they can never reach.
  const token = String(checkout?.["successUrl"] ?? "").split("#welcome/")[1] ?? "";
  assert.notEqual(token, "");
  assert.equal(sent.length, 1, "the link is mailed as well as redirected to");
  assert.equal(sent[0]?.to, "buyer@example.com");
  assert.match(sent[0]?.text ?? "", /#welcome\//u);
  assert.match(
    sent[0]?.text ?? "",
    new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    "the mailed link is the same claim link",
  );

  // 2. Stripe confirms. The organization it paid for is built now — and
  //    still no account, because they have not chosen a password yet.
  const body = JSON.stringify({
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_paid",
        status: "trialing",
        customer: "cus_paid",
        trial_end: 1_800_000_000,
        metadata: { organizationId },
      },
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const delivered = await client.request("/api/v1/stripe/webhook", {
    method: "POST",
    raw: Buffer.from(body, "utf8"),
    rawType: "application/json",
    headers: {
      "Stripe-Signature": `t=${String(timestamp)},v1=${createHmac("sha256", secret)
        .update(`${String(timestamp)}.${body}`, "utf8")
        .digest("hex")}`,
    },
  });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.data));
  assert.notEqual(await store.getOrganization(organizationId), undefined);
  assert.equal(await store.countUsers(), 0, "still nobody to sign in as");
  const subscription = await store.getSubscription(organizationId);
  assert.equal(subscription?.status, "trialing");
  assert.notEqual(subscription?.trialEndsAt, undefined, "the trial date is kept");

  // Stripe redelivers. Provisioning is one transaction that re-reads the
  // intent inside it and sets the latch last, so a second delivery of the
  // same payment finds the work done and builds nothing on top of it.
  const redelivered = await client.request("/api/v1/stripe/webhook", {
    method: "POST",
    raw: Buffer.from(body, "utf8"),
    rawType: "application/json",
    headers: {
      "Stripe-Signature": `t=${String(timestamp)},v1=${createHmac("sha256", secret)
        .update(`${String(timestamp)}.${body}`, "utf8")
        .digest("hex")}`,
    },
  });
  assert.equal(redelivered.status, 200, JSON.stringify(redelivered.data));
  assert.deepEqual(
    (await store.listProjects(organizationId)).map((project) => project.slug),
    ["default"],
    "a redelivered payment must not build a second project",
  );

  // The welcome screen can tell them the payment landed.
  const waiting = await client.request(
    `/api/v1/auth/signup/${encodeURIComponent(token)}`,
  );
  assert.equal(waiting.data.paid, true);
  assert.equal(waiting.data.claimed, false);

  // 3. Name and password. Only now does an account exist, and they are signed
  //    straight in to the organization their card already paid for.
  const finished = await client.request(
    `/api/v1/auth/signup/${encodeURIComponent(token)}/complete`,
    {
      method: "POST",
      body: { displayName: "Buyer", password: "PaidSignupPassword123!" },
    },
  );
  assert.equal(finished.status, 201, JSON.stringify(finished.data));
  assert.equal(finished.data.user.email, "buyer@example.com");
  assert.equal(finished.data.memberships.length, 1);
  assert.equal(finished.data.memberships[0]?.organizationId, organizationId);
  assert.equal(finished.data.memberships[0]?.role, "owner");
  assert.deepEqual(
    (await store.listProjects(organizationId)).map((project) => project.slug),
    ["default"],
  );

  // Pressing the link twice is one account, not two.
  const again = await client.request(
    `/api/v1/auth/signup/${encodeURIComponent(token)}/complete`,
    {
      method: "POST",
      body: { displayName: "Buyer", password: "PaidSignupPassword123!" },
    },
  );
  assert.equal(again.status, 201);
  assert.equal(again.data.user.id, finished.data.user.id);
  assert.equal(await store.countUsers(), 1);
});

test("a sign-up latched before its organization existed repairs itself", async (t) => {
  // The state the old latch-first provisioning could leave behind, and which
  // nothing in the product could undo: `completed_at` set, no organization,
  // a payment that had bought nothing and a claim link that could never
  // work. `completeSignupIntent` has no inverse, so reading the latch as the
  // answer made it permanent.
  const { client, store } = await startBareGateway(t, {
    stripe: {} as unknown as StripeClient,
    stripeWebhookSecret: "whsec_example",
    stripePriceId: "price_example",
  });
  const organizationId = "org_burned";
  const secret = "burned-secret";
  const created = new Date();
  await store.createSignupIntent({
    id: "signup_burned",
    organizationId,
    email: "burned@example.com",
    organizationName: "Burned Team",
    secretHash: hashSecret(secret),
    stripeSessionId: undefined,
    userId: undefined,
    createdAt: created.toISOString(),
    expiresAt: new Date(created.getTime() + 86_400_000).toISOString(),
    // Latched, with nothing behind it.
    completedAt: created.toISOString(),
  });
  assert.equal(await store.getOrganization(organizationId), undefined);

  const finished = await client.request(
    `/api/v1/auth/signup/${encodeURIComponent(`signup_burned.${secret}`)}/complete`,
    {
      method: "POST",
      body: { displayName: "Burned", password: "BurnedSignupPassword123!" },
    },
  );
  assert.equal(finished.status, 201, JSON.stringify(finished.data));
  assert.equal(finished.data.user.email, "burned@example.com");
  // The organization the payment bought, built on the id the subscription
  // already points at rather than a new one.
  assert.equal(finished.data.memberships[0]?.organizationId, organizationId);
  assert.equal(finished.data.memberships[0]?.role, "owner");
  assert.deepEqual(
    (await store.listProjects(organizationId)).map((project) => project.slug),
    ["default"],
  );
});

test("day fifteen bills the trial and the team keeps working", async (t) => {
  // The half of the money nobody has watched happen. Everything up to here
  // has been proved by a real checkout; what follows it is a fortnight away
  // and arrives entirely as webhooks, so it is proved here instead.
  const secret = "whsec_example";
  const stripe = {
    createCheckoutSession: async () => ({ id: "cs_1", url: "https://x/1" }),
    getSubscription: async () => ({
      id: "sub_trial",
      status: "active",
      customerId: "cus_trial",
      currentPeriodEnd: 1_800_000_000,
      // Stripe keeps `trial_end` on a subscription after it converts — it
      // records when the trial ended, it is not cleared. The invoice path
      // builds a synthetic subscription object to re-record, and the row is
      // written whole, so a copy that dropped this erased the date.
      trialEnd: 1_700_000_000,
      quantity: 1,
      metadata: {},
    }),
  } as unknown as StripeClient;
  const { client, store } = await startBareGateway(t, {
    stripe,
    stripeWebhookSecret: secret,
    stripePriceId: "price_example",
  });
  const organization = await store.createOrganization({
    slug: "trialing-team",
    name: "Trialing Team",
  });
  const owner = await store.createUser({
    email: "owner@example.com",
    displayName: "Owner",
    passwordDigest: "digest",
    systemAdmin: false,
  });
  await store.saveMembership({
    organizationId: organization.id,
    userId: owner.id,
    role: "owner",
  });

  const deliver = async (body: string) => {
    const timestamp = Math.floor(Date.now() / 1000);
    return await client.request("/api/v1/stripe/webhook", {
      method: "POST",
      raw: Buffer.from(body, "utf8"),
      rawType: "application/json",
      headers: {
        "Stripe-Signature": `t=${String(timestamp)},v1=${createHmac(
          "sha256",
          secret,
        )
          .update(`${String(timestamp)}.${body}`, "utf8")
          .digest("hex")}`,
      },
    });
  };
  const subscriptionEvent = (type: string, status: string, trialEnd?: number) =>
    JSON.stringify({
      type,
      data: {
        object: {
          id: "sub_trial",
          status,
          customer: "cus_trial",
          ...(trialEnd === undefined ? {} : { trial_end: trialEnd }),
          current_period_end: 1_800_000_000,
          metadata: { organizationId: organization.id },
        },
      },
    });

  // Day 0: the card was taken and Stripe is running the trial.
  const trialEnd = Math.floor(Date.now() / 1000) + 14 * 86_400;
  assert.equal(
    (await deliver(subscriptionEvent("customer.subscription.created", "trialing", trialEnd))).status,
    200,
  );
  const trialing = await store.getSubscription(organization.id);
  // Stored as the trial it is. Folded into `active` — which is what this
  // pinned before — the countdown banner never fired for anybody and the
  // settings card told a day-two customer their subscription was running.
  assert.equal(trialing?.status, "trialing");
  assert.notEqual(
    trialing?.trialEndsAt,
    undefined,
    "the trial's end date is kept, not erased by the write",
  );
  assert.equal(
    subscriptionAllowsWork(trialing, organization.createdAt),
    true,
    "working during the trial",
  );

  // Day 15: Stripe charges the card. Both events fire and the order between
  // them is not guaranteed, so each is delivered and each must be harmless.
  assert.equal(
    (await deliver(JSON.stringify({
      type: "invoice.paid",
      data: { object: { subscription: "sub_trial", subscription_details: {} } },
    }))).status,
    200,
  );
  assert.equal(
    (await deliver(subscriptionEvent("customer.subscription.updated", "active"))).status,
    200,
  );

  const paying = await store.getSubscription(organization.id);
  assert.equal(paying?.status, "active");
  assert.notEqual(
    paying?.trialEndsAt,
    undefined,
    "the invoice path must not erase the date on the way through",
  );
  assert.equal(
    subscriptionAllowsWork(paying, organization.createdAt),
    true,
    "still working the day after the trial converts",
  );
  assert.equal(
    effectiveRole("owner", paying, organization.createdAt),
    "owner",
    "and not folded to viewer by the conversion",
  );
});

test("the reconciler finds seat drift nothing else would have", async (t) => {
  // "Every call site syncs" is a claim about code, and for a long time three
  // of the eight did not. An invoice is a claim about money, and until
  // something compares the two a missed call site is invisible from inside
  // the product. The promise that drift "heals at the next purchase or seat
  // change" has nothing behind it: a steady team makes neither for months.
  const writes: number[] = [];
  // What Stripe holds — one seat, as if the second person had joined while a
  // sync was missing.
  let held = 1;
  const stripe = {
    getSubscription: async (id: string) => ({
      id,
      status: "active",
      customerId: "cus_drift",
      currentPeriodEnd: undefined,
      trialEnd: undefined,
      quantity: held,
      metadata: {},
    }),
    getSubscriptionItemId: async () => "si_drift",
    updateSubscriptionQuantity: async (input: { quantity: number }) => {
      writes.push(input.quantity);
      held = input.quantity;
    },
  } as unknown as StripeClient;

  const { store } = await startBareGateway(t, {
    stripe,
    stripeWebhookSecret: "whsec_example",
    stripePriceId: "price_example",
    // The pass runs once at construction as well, which is what this is
    // really testing; a short interval only keeps a stuck one from hiding.
    billingReconcileIntervalMs: 50,
  });
  const organization = await store.createOrganization({
    slug: "drifted",
    name: "Drifted",
  });
  await store.saveSubscription({
    organizationId: organization.id,
    status: "active",
    stripeCustomerId: "cus_drift",
    stripeSubscriptionId: "sub_drift",
  });
  for (const name of ["one", "two", "three"]) {
    const user = await store.createUser({
      email: `${name}@example.com`,
      displayName: name,
      passwordDigest: "digest",
      systemAdmin: false,
    });
    await store.saveMembership({
      organizationId: organization.id,
      userId: user.id,
      role: "developer",
    });
  }

  // A cancelled organization beside it, which must not be touched: it is not
  // being charged, and writing a quantity to it would be a proration on a
  // subscription nobody holds.
  const gone = await store.createOrganization({ slug: "gone", name: "Gone" });
  await store.saveSubscription({
    organizationId: gone.id,
    status: "canceled",
    stripeSubscriptionId: "sub_gone",
  });

  // An abandoned checkout, swept on the way past. `deleteExpiredSignupIntents`
  // had no caller at all, so these accumulated forever — each one holding an
  // email address that then reads as taken when its owner tries again.
  const abandoned = new Date(Date.now() - 86_400_000).toISOString();
  await store.createSignupIntent({
    id: "signup_abandoned",
    organizationId: "org_never",
    email: "abandoned@example.com",
    organizationName: undefined,
    secretHash: "hash",
    stripeSessionId: undefined,
    userId: undefined,
    createdAt: abandoned,
    expiresAt: abandoned,
    completedAt: undefined,
  });

  await waitFor(
    async () => writes.length > 0,
    "the reconciler never corrected the seat count",
  );
  assert.deepEqual(writes, [3], "three people who can work, three seats");
  await waitFor(
    async () => (await store.getSignupIntent("signup_abandoned")) === undefined,
    "the expired sign-up was never swept",
  );

  // And it settles: once Stripe holds the right number the pass writes
  // nothing, because every write prorates.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(writes, [3], "a settled subscription is not rewritten");
});

test("three days out, the people who can cancel are told", async (t) => {
  // The only notice reaching a customer who has not opened the app since
  // signing up. The in-product countdown is real, but it has to be looked at,
  // and the alternative is a first charge with no warning at all.
  const secret = "whsec_example";
  const { client, store, sent } = await startBareGateway(t, {
    stripe: {} as unknown as StripeClient,
    stripeWebhookSecret: secret,
    stripePriceId: "price_example",
  });
  const organization = await store.createOrganization({
    slug: "ending-team",
    name: "Ending Team",
  });
  const roles = ["owner", "admin", "developer", "viewer"] as const;
  for (const role of roles) {
    const user = await store.createUser({
      email: `${role}@example.com`,
      displayName: role,
      passwordDigest: "digest",
      systemAdmin: false,
    });
    await store.saveMembership({
      organizationId: organization.id,
      userId: user.id,
      role,
    });
  }

  const body = JSON.stringify({
    type: "customer.subscription.trial_will_end",
    data: {
      object: {
        id: "sub_ending",
        status: "trialing",
        customer: "cus_ending",
        trial_end: 1_800_000_000,
        metadata: { organizationId: organization.id },
      },
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const delivered = await client.request("/api/v1/stripe/webhook", {
    method: "POST",
    raw: Buffer.from(body, "utf8"),
    rawType: "application/json",
    headers: {
      "Stripe-Signature": `t=${String(timestamp)},v1=${createHmac("sha256", secret)
        .update(`${String(timestamp)}.${body}`, "utf8")
        .digest("hex")}`,
    },
  });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.data));

  // Only the people who can act on it. A developer who cannot reach billing
  // has nothing to do with the message.
  assert.deepEqual(
    sent.map((message) => message.to).sort(),
    ["admin@example.com", "owner@example.com"],
  );
  assert.match(sent[0]?.subject ?? "", /trial ends soon/iu);
  // The date Stripe named, not a guess.
  assert.match(sent[0]?.text ?? "", /2027-01-15/u);

  // And the notice writes nothing: the entitlement is still whatever the
  // subscription events said it was.
  assert.equal(await store.getSubscription(organization.id), undefined);
});

test("a card that fails on day fifteen goes past due, not dark", async (t) => {
  // The other ending. A failed payment is a card problem, and locking a team
  // out of their repository over one is a worse answer than letting Stripe
  // retry — so `past_due` still works, and only a cancellation stops it.
  const secret = "whsec_example";
  // Stamped at checkout and carried by the subscription ever after, which is
  // exactly why it is stamped there: an invoice months later names the
  // organization with no lookup table in between.
  let organizationId = "";
  const stripe = {
    getSubscription: async () => ({
      id: "sub_late",
      status: "past_due",
      customerId: "cus_late",
      currentPeriodEnd: 1_800_000_000,
      trialEnd: undefined,
      quantity: 1,
      metadata: { organizationId },
    }),
  } as unknown as StripeClient;
  const { client, store } = await startBareGateway(t, {
    stripe,
    stripeWebhookSecret: secret,
    stripePriceId: "price_example",
  });
  const organization = await store.createOrganization({
    slug: "late-team",
    name: "Late Team",
  });
  organizationId = organization.id;

  const deliver = async (body: string) => {
    const timestamp = Math.floor(Date.now() / 1000);
    return await client.request("/api/v1/stripe/webhook", {
      method: "POST",
      raw: Buffer.from(body, "utf8"),
      rawType: "application/json",
      headers: {
        "Stripe-Signature": `t=${String(timestamp)},v1=${createHmac("sha256", secret)
          .update(`${String(timestamp)}.${body}`, "utf8")
          .digest("hex")}`,
      },
    });
  };

  await deliver(JSON.stringify({
    type: "invoice.payment_failed",
    data: { object: { subscription: "sub_late", subscription_details: {} } },
  }));
  const late = await store.getSubscription(organization.id);
  assert.equal(late?.status, "past_due");
  assert.equal(subscriptionAllowsWork(late, organization.createdAt), true);

  // Cancelled is where it stops.
  await deliver(JSON.stringify({
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: "sub_late",
        status: "canceled",
        customer: "cus_late",
        metadata: { organizationId: organization.id },
      },
    },
  }));
  const gone = await store.getSubscription(organization.id);
  assert.equal(gone?.status, "canceled");
  assert.equal(subscriptionAllowsWork(gone, organization.createdAt), false);
  assert.equal(
    effectiveRole("owner", gone, organization.createdAt),
    "viewer",
    "read-only rather than dark",
  );
});

test("a paid sign-up refuses an address that already has an account", async (t) => {
  // Checked before any money moves. Telling somebody they already have an
  // account is kinder and cheaper than charging them for a second one, and
  // the sign-in form beside it is no less of an address oracle.
  const stripe = {
    createCheckoutSession: async () => {
      throw new Error("checkout must not be reached");
    },
  } as unknown as StripeClient;
  const { client, store } = await startBareGateway(t, {
    stripe,
    stripeWebhookSecret: "whsec_example",
    stripePriceId: "price_example",
  });
  await store.createUser({
    email: "taken@example.com",
    displayName: "Taken",
    passwordDigest: "digest",
    systemAdmin: false,
  });

  const refused = await client.request("/api/v1/auth/signup", {
    method: "POST",
    body: { email: "Taken@Example.com" },
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error.code, "account_exists");
});

test("a forged webhook buys nothing, through the route rather than the verifier", async (t) => {
  // The verifier has unit tests; the route is where it matters. This URL is
  // public, it is the only thing that provisions a paid organization, and it
  // writes entitlement — so an unsigned body reaching `applyStripeEvent`
  // would be free service for anybody who found the path.
  const secret = "whsec_example";
  const { client, store } = await startBareGateway(t, {
    stripe: {} as unknown as StripeClient,
    stripeWebhookSecret: secret,
    stripePriceId: "price_example",
  });
  const organization = await store.createOrganization({
    slug: "victim",
    name: "Victim",
  });
  await store.saveSubscription({
    organizationId: organization.id,
    status: "active",
    stripeSubscriptionId: "sub_victim",
  });

  const body = JSON.stringify({
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: "sub_victim",
        status: "canceled",
        customer: "cus_victim",
        metadata: { organizationId: organization.id },
      },
    },
  });
  const raw = Buffer.from(body, "utf8");
  const now = Math.floor(Date.now() / 1000);
  const sign = (payload: string, key: string, at: number) =>
    `t=${String(at)},v1=${createHmac("sha256", key)
      .update(`${String(at)}.${payload}`, "utf8")
      .digest("hex")}`;
  const post = async (headers: Record<string, string>) =>
    await client.request("/api/v1/stripe/webhook", {
      method: "POST",
      raw,
      rawType: "application/json",
      headers,
    });

  // No header at all.
  assert.equal((await post({})).status, 400);
  // A header that is not a signature.
  assert.equal((await post({ "Stripe-Signature": "nonsense" })).status, 400);
  // Signed, correctly, with the wrong secret — somebody else's deployment,
  // or a guess.
  assert.equal(
    (await post({ "Stripe-Signature": sign(body, "whsec_wrong", now) })).status,
    400,
  );
  // A real signature over a different body: the tamper case, where a captured
  // header is reused on a payload of the attacker's choosing.
  assert.equal(
    (await post({
      "Stripe-Signature": sign('{"type":"ping"}', secret, now),
    })).status,
    400,
  );
  // A real signature that is too old to still be one — a captured replay.
  assert.equal(
    (await post({ "Stripe-Signature": sign(body, secret, now - 86_400) }))
      .status,
    400,
  );

  // Nothing any of them said was applied.
  assert.equal(
    (await store.getSubscription(organization.id))?.status,
    "active",
    "a refused webhook must not reach the entitlement",
  );

  // And the same body, signed properly, does apply — or the assertions above
  // would pass on a route that refuses everything.
  assert.equal(
    (await post({ "Stripe-Signature": sign(body, secret, now) })).status,
    200,
  );
  assert.equal(
    (await store.getSubscription(organization.id))?.status,
    "canceled",
  );
});

test("a Stripe event never overwrites a comped organization", async (t) => {
  // The destructive path needs no bad luck. Every organization that predates
  // billing was comped by migration; `subscriptionStatusFrom` reads every
  // status it does not recognise as `canceled`, `incomplete` among them; and
  // `incomplete` is exactly what an abandoned checkout leaves behind. The
  // subscription row is written whole, so one stray event would turn a
  // permanently free team into a cancelled one — and nothing in the product
  // grants a comp, so there would be no way back from inside.
  const secret = "whsec_example";
  const { client, store } = await startBareGateway(t, {
    stripe: {} as unknown as StripeClient,
    stripeWebhookSecret: secret,
    stripePriceId: "price_example",
  });
  const organization = await store.createOrganization({
    slug: "grandfathered",
    name: "Grandfathered",
  });
  await store.saveSubscription({
    organizationId: organization.id,
    status: "comped",
  });

  // A real signed event, through the real route: the guard has to hold where
  // Stripe actually reaches it, not where a test can call it directly.
  const body = JSON.stringify({
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_abandoned",
        status: "incomplete",
        customer: "cus_abandoned",
        metadata: { organizationId: organization.id },
      },
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret)
    .update(`${String(timestamp)}.${body}`, "utf8")
    .digest("hex");
  const delivered = await client.request("/api/v1/stripe/webhook", {
    method: "POST",
    raw: Buffer.from(body, "utf8"),
    rawType: "application/json",
    headers: { "Stripe-Signature": `t=${String(timestamp)},v1=${signature}` },
  });

  // Accepted, because refusing would make Stripe retry it for days.
  assert.equal(delivered.status, 200, JSON.stringify(delivered.data));
  assert.equal(
    (await store.getSubscription(organization.id))?.status,
    "comped",
    "a comp is a decision a person made; Stripe has no opinion about it",
  );
});

test("health says which billing variables reached the process", async (t) => {
  // The symptom this exists for: every way of misconfiguring Stripe — a name
  // typo, the variables on the wrong service, a save that never redeployed —
  // looks identical from outside, a 501 on the webhook. Three booleans, and
  // never any part of a value.
  const bare = await startBareGateway(t, {});
  const unset = await bare.client.request("/api/v1/health");
  assert.deepEqual(unset.data.billing, {
    secretKey: false,
    webhookSecret: false,
    priceId: false,
    appUrl: "https://kumi.test",
  });

  const configured = await startBareGateway(t, {
    // The gateway is handed a constructed client rather than the key, so a
    // stub standing in for one is exactly what "a secret key was configured"
    // means from in here.
    stripe: {} as unknown as StripeClient,
    stripeWebhookSecret: "whsec_example",
    stripePriceId: "price_example",
  });
  const set = await configured.client.request("/api/v1/health");
  assert.deepEqual(set.data.billing, {
    secretKey: true,
    webhookSecret: true,
    priceId: true,
    appUrl: "https://kumi.test",
  });

  // Never the values themselves, however the payload grows later.
  const body = JSON.stringify(set.data);
  assert.ok(!body.includes("whsec_example"), "the signing secret must not leak");
  assert.ok(!body.includes("price_example"), "no configured value is echoed");
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
  await invitableRepository(owner, "dm-shared");
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

  const reply = await friend.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${session.user.id}`,
    {
      method: "POST",
      body: {
        content: "I agree.",
        referencedMessageId: sent.data.message.id,
      },
    },
  );
  assert.equal(reply.status, 201, JSON.stringify(reply.data));
  assert.equal(reply.data.message.referencedMessageId, sent.data.message.id);

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
      ["Just between us.", "I agree."],
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
  const unrelatedReference = await bystander.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${friendId}`,
    {
      method: "POST",
      body: {
        content: "Can I join in?",
        referencedMessageId: sent.data.message.id,
      },
    },
  );
  assert.equal(unrelatedReference.status, 400);

  // Unread is counted for each recipient only, and clears when they read it.
  const inbox = await friend.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages`,
  );
  assert.equal(inbox.status, 200);
  assert.equal(inbox.data.conversations[0].unread, 1);
  assert.equal(
    (await owner.request(`/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages`))
      .data.conversations[0].unread,
    1,
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

  // A conversation may remain in storage after its other participant leaves
  // the project, but it is no longer a destination the viewer can open. The
  // inbox must drop it along with the departed profile; otherwise the browser
  // can only label the row with its internal `user_…` id.
  await runtime.store.removeMembership(organizationId, friendId);
  const afterFriendLeft = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages`,
  );
  assert.equal(afterFriendLeft.status, 200);
  assert.equal(
    (afterFriendLeft.data.conversations as { userId: string }[]).some(
      (conversation) => conversation.userId === friendId,
    ),
    false,
  );
  assert.equal(
    (afterFriendLeft.data.people as { id: string }[]).some(
      (person) => person.id === friendId,
    ),
    false,
  );
});

test("direct messages require a shared repository channel", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const sharedRepository = await invitableRepository(owner, "dm-room-shared");
  const isolatedRepository = await invitableRepository(
    owner,
    "dm-room-isolated",
  );
  const first = await joinRepository(
    runtime,
    owner,
    "dm-first@example.com",
    sharedRepository,
  );
  const shared = await joinRepository(
    runtime,
    owner,
    "dm-shared@example.com",
    sharedRepository,
  );
  const isolated = await joinRepository(
    runtime,
    owner,
    "dm-isolated@example.com",
    isolatedRepository,
  );
  const sharedId = (await shared.request("/api/v1/auth/me")).data.user.id;
  const isolatedId = (await isolated.request("/api/v1/auth/me")).data.user.id;

  const inbox = await first.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages`,
  );
  assert.equal(inbox.status, 200, JSON.stringify(inbox.data));
  const reachable = new Set(
    (inbox.data.people as { id: string }[]).map((person) => person.id),
  );
  assert.equal(reachable.has(sharedId), true);
  assert.equal(reachable.has(isolatedId), false);

  const sent = await first.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${sharedId}`,
    { method: "POST", body: { content: "We share this room." } },
  );
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal(
    (
      await first.request(
        `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${sharedId}`,
      )
    ).status,
    200,
  );

  for (const method of ["GET", "POST"] as const) {
    const refused = await first.request(
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${isolatedId}`,
      method === "POST"
        ? { method, body: { content: "We do not share a room." } }
        : { method },
    );
    assert.equal(refused.status, 404, JSON.stringify(refused.data));
  }
});

test("channel stats count every root and reply, past the read page", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "counted-room");

  // Past the 200-row page the channel read is capped at. The stats line used
  // to be the length of that page, so a room this size reported "200+" — a
  // figure that stops being true the moment the room gets busy.
  for (let index = 0; index < 205; index += 1) {
    const root = await runtime.store.appendChannelMessage({
      repositoryId,
      projectId: DEFAULT_PROJECT_ID,
      authorId: ownerId,
      content: `Line ${index}`,
    });
    if (index % 5 === 0) {
      await runtime.store.addChannelReply({
        repositoryId,
        messageId: root.id,
        authorId: ownerId,
        content: `Reply to ${index}`,
      });
    }
  }

  const response = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/stats`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.data.messages, 205);
  assert.equal(response.data.replies, 41);
  // Nothing is approximated any more, so there is no "and more" flag left.
  assert.equal(response.data.capped, undefined);
});

test("channel stats exclude cached context from the token activity total", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "token-stats");

  await runtime.store.recordTokenUsage({
    usageKey: "fresh:planning",
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    taskId: "task_fresh",
    agentId: "codex",
    phase: "planning",
    inputTokens: 10_000,
    outputTokens: 500,
    freshTokens: 2_500,
    totalTokens: 25_000,
    recordedAt: "2026-08-20T00:00:00.000Z",
  });
  // Historical rows have no explicit cache-adjusted value. Their output is
  // still certainly fresh, so it contributes as a lower bound rather than
  // falling back to the much larger billed total.
  await runtime.store.recordTokenUsage({
    usageKey: "legacy:execution",
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    taskId: "task_legacy",
    agentId: "claude",
    phase: "execution",
    inputTokens: 90_000,
    outputTokens: 700,
    totalTokens: 90_700,
    recordedAt: "2026-08-20T00:01:00.000Z",
  });

  const response = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/stats`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.data.tokens, 3_200);
  assert.equal(response.data.tokensIncomplete, true);
});

test("channel stats keep an inconsistent token report inside its own bounds", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "token-bounds");

  // A fresh figure larger than what was billed is impossible, and letting it
  // through is how the line reads high; the billed total is the ceiling.
  await runtime.store.recordTokenUsage({
    usageKey: "over:planning",
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    taskId: "task_over",
    agentId: "codex",
    phase: "planning",
    inputTokens: 4_000,
    outputTokens: 100,
    freshTokens: 9_000,
    totalTokens: 5_000,
    recordedAt: "2026-08-20T00:00:00.000Z",
  });
  // Output is always new work, so it is the floor even when the reported
  // fresh figure somehow lands beneath it.
  await runtime.store.recordTokenUsage({
    usageKey: "under:execution",
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    taskId: "task_under",
    agentId: "claude",
    phase: "execution",
    inputTokens: 30_000,
    outputTokens: 400,
    freshTokens: 50,
    totalTokens: 31_000,
    recordedAt: "2026-08-20T00:01:00.000Z",
  });

  const response = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/stats`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.data.tokens, 5_400);
  // Both rows carry a cache split, so nothing here is a lower bound.
  assert.equal(response.data.tokensIncomplete, false);
});

test("a channel route will not read a repository from another project", async (t) => {
  // The last two `/channel/*` routes that authorized the repository without
  // checking it belongs to the project in the path. An organization role
  // reaches every repository the organization has, so `authorizeRepository`
  // alone lets any member name any repository under any project id — and
  // `channel/stats` answers with that room's message counts and an
  // afternoon's token spend.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "channel-tenancy");
  // A second project in the same organization, so the caller is genuinely
  // authorized and only the pairing is wrong.
  const elsewhere = await runtime.store.createProject({
    organizationId: DEFAULT_ORGANIZATION_ID,
    slug: "elsewhere",
    name: "Elsewhere",
  });

  const stats = await owner.request(
    `/api/v1/projects/${elsewhere.id}/repositories/${repo}/channel/stats`,
  );
  assert.equal(stats.status, 404, JSON.stringify(stats.data));

  const simplify = await owner.request(
    `/api/v1/projects/${elsewhere.id}/repositories/${repo}/channel/replies/reply_1/simplify`,
    { method: "POST", body: { text: "something long" } },
  );
  assert.equal(simplify.status, 404, JSON.stringify(simplify.data));

  // The same calls under the project it really belongs to still work, or the
  // guard would be a regression rather than a fix.
  const paired = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/stats`,
  );
  assert.equal(paired.status, 200, JSON.stringify(paired.data));
});

test("a stored objective reads back as the request, not the coordinator's script", () => {
  // What a worker is sent is the request wrapped in instructions: a role
  // preamble in front, and behind it whichever directives applied — the
  // answer-not-a-status-report one on every task, and `/simple` or `/dnc`
  // when asked for. Six places read that string back as if it were the
  // request. Some show it to people; some compare it, and those are the ones
  // that broke, because boilerplate every objective shares drags every
  // similarity score toward each other and away from the words that differ.
  const request = "rework the retry policy and its tests";
  const sent = withRoleContext(
    "senior engineer",
    [
      request,
      "Your final message is the answer, not a status report. If you " +
        "delegated to a subagent, wait for its result before finishing — " +
        "never end a turn saying a search is running or that you will " +
        "report back. Do not state a conclusion while work you started is " +
        "still outstanding. If you cannot answer, say what you checked and " +
        "what would settle it.",
      "Keep every reply as short and simple as it can possibly be: the " +
        "fewest, plainest words that still say it, one short sentence when " +
        "one is enough — no preamble, no restating the request, nothing " +
        "extra.",
    ].join("\n\n"),
  );
  assert.equal(requestFromObjective(sent), request);

  // The measurement: against a merge bar of 0.42, two identical requests
  // scored 0.11 while the directives were in the comparison.
  assert.ok(
    textOverlap(request, sent) < 0.42,
    "the whole objective is what dropped the score under the bar",
  );
  assert.ok(textOverlap(request, requestFromObjective(sent)) > 0.9);

  // A request that quotes a directive keeps it: the paragraphs are matched
  // whole, not searched for.
  const quoting = `${request}\n\nKeep every reply short.`;
  assert.equal(requestFromObjective(quoting), quoting);

  // And an objective that is nothing but a directive still reads back as
  // something, rather than as an empty string a caller would render blank.
  assert.notEqual(
    requestFromObjective(
      "Keep every reply as short and simple as it can possibly be: the " +
        "fewest, plainest words that still say it, one short sentence when " +
        "one is enough — no preamble, no restating the request, nothing " +
        "extra.",
    ),
    "",
  );
});

test("a worker report without a fresh figure still separates cached context", () => {
  // Rollout reality: a worker built before the fresh field existed reports
  // the split and nothing else. Its total exceeding the two sides means the
  // cache is accounted for separately, so input plus output is new work.
  assert.equal(reportedFreshTokens(undefined, 2_000, 500, 25_000), 2_500);
  // A total that is exactly the two sides is the ambiguous case — cache
  // folded into the input reads identically — so no figure is claimed and
  // the row counts as a lower bound instead.
  assert.equal(reportedFreshTokens(undefined, 2_000, 500, 2_500), undefined);
  // An explicit figure is taken as given, unless it exceeds what was billed.
  assert.equal(reportedFreshTokens(1_200, 2_000, 500, 25_000), 1_200);
  assert.equal(reportedFreshTokens(30_000, 2_000, 500, 25_000), undefined);
  assert.equal(
    reportedFreshTokens(undefined, undefined, 500, 25_000),
    undefined,
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
  // Repository-backed questions can inspect files without claiming a change.
  assert.match(prompt, /read-only checkout/u);
  assert.match(prompt, /Inspect it whenever the answer depends on the code/u);
});

test("a run that cannot start says so, instead of an hour of silence", async (t) => {
  // The channel showed a working indicator and then nothing. The run rejected
  // before it wrote a single audit event, so the progress watcher had nothing
  // to follow and held its opening line until the one-hour watchdog gave up —
  // and the reason, which the failing call had in hand, went to stderr where
  // nobody reading the channel can see it.
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

test("a quick task keeps its outcome inline after acknowledging the handoff", async (t) => {
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
  // The ending stays flat in the room.
  const ending = messages.find((message) => message.kind === "outcome");
  assert.match(
    String(ending?.content),
    /Changed the retry count to 2\./u,
    `the ending did not carry the agent's own words: ${JSON.stringify(ending)}`,
  );
  // The request has only the immediate handoff reply; routine run ceremony is
  // still held back and the concise outcome stays in the room.
  const root = messages.find(
    (message) => message.kind === "user" && message.taskId === task.id,
  );
  // Two immediate lines, and nothing from the run.
  //
  // The handoff reply is posted as a canned sentence and then contextualised
  // in place by the agent's own opening — `chatAnswer.text` here — so its
  // final wording is the agent's, not the placeholder's. The `Task:` line is
  // the thread's name, which every surface reads a title off. Neither is run
  // ceremony, which is what this test is about: no `plan_received`, no
  // `plan_admitted`, no `task_started`, no changeset narration. Comparing the
  // whole list is what keeps that true — a ceremony line leaking in fails
  // here.
  assert.deepEqual(
    (root?.replies ?? []).map((reply) => ({
      kind: reply.kind,
      content: reply.content,
    })),
    [
      { kind: "agent", content: "On it." },
      { kind: "progress", content: "Task: change the retry count to 2" },
    ],
    JSON.stringify(root),
  );
});

/**
 * Puts one dispatched task in the room, which is what starts the fast pump.
 *
 * `announceArbitration` rides on `pumpChannelProgress`, and that timer only
 * exists while some task is being watched — so a conflict test needs a real
 * mention dispatch before an appended admission can be narrated.
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
  // Two separate faults produced that. The detector's own line never resolved
  // a name at all, and the resolver `announceArbitration` did use matched a
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

test("a collision no admission acts on is not announced at all", async (t) => {
  // This used to be the one line `narrateConflicts` existed for: "@Claude and
  // @Codex are working on related things but can run together." Both plans
  // admitted whole, neither refused anything, nobody waiting — an
  // announcement with no decision in it, in the room where people watch for
  // the ones that do have a decision in them. And when both tasks belonged to
  // one agent it came out "@Hades and @Hades", which is the coordinator
  // reporting a collision between somebody and themselves.
  //
  // So no disposition and no evidence is narrated here any more. What is left
  // is the collision an admission actually acts on, and that is spoken by
  // `announceArbitration`, off the event that knows who was held.
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

  // Every shape the detector can record: a pair with nothing between them,
  // a real file overlap scored inside the notify band, and the intent-only
  // overlap the advisory line was written for.
  for (const detected of [
    { disposition: "concurrent", evidence: [] },
    {
      disposition: "concurrent_with_notification",
      evidence: [
        {
          kind: "file_overlap",
          resources: ["apps/web/public/app.js"],
          score: 40,
        },
      ],
    },
    {
      disposition: "concurrent_with_notification",
      evidence: [
        {
          kind: "intent_conflict",
          resources: ["mobile sizing"],
          score: 30,
          advisory: true,
        },
      ],
    },
  ]) {
    await runtime.store.appendAudit(undefined, {
      type: "conflict_detected",
      taskId: tasks.claude,
      data: {
        projectId: DEFAULT_PROJECT_ID,
        repositoryId: repo,
        taskIds: [tasks.claude, tasks.codex],
        ...detected,
      },
    });
  }

  // A collision that *is* acted on, appended last, as the proof the room was
  // reachable all along. Waiting on a line that must not appear proves
  // nothing; waiting on the next one that must, and then finding it alone,
  // proves both halves.
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
    "the arbitration was never announced",
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
    `a collision nobody was held by was still narrated: ${JSON.stringify(lines)}`,
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

test("a blocked admission says who waits for whom, not that a plan is shrinking", async (t) => {
  // In the words of the person who hit it: "narrowing its plan makes it sound
  // like some of your specifications may be changed, which will off-put the
  // user if that actually isn't happening". What narrows on this path is the
  // claim on the repository, not the ask — but the room cannot tell those
  // apart, so the line has to report the one thing it knows: the order.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "blockedroom");
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
      status: "blocked",
      blockedBy: [tasks.codex],
      explanation:
        "Plan collides with executing work beyond the sequencing threshold",
    },
  });

  await waitFor(
    async () => {
      const messages = await runtime.store.listChannelMessages(repo, ownerId);
      return messages.some((message) => message.authorId === "coordinator");
    },
    "the block was never announced in the room",
    8_000,
  );

  const messages = await runtime.store.listChannelMessages(repo, ownerId);
  const line = String(
    messages.find((message) => message.authorId === "coordinator")?.content,
  );
  assert.equal(
    line,
    `⚖️ @Claude (${firstName}) and @Codex (${firstName}) have conflicting ` +
      `files — @Claude (${firstName}) will wait for @Codex (${firstName}) ` +
      `to go first.`,
    `the block did not read as two names and an order: ${line}`,
  );
  assert.doesNotMatch(
    line,
    /narrow/iu,
    "the block still described the held task's plan as shrinking",
  );
  // A hold, not an advisory: it retires when either end of the collision does,
  // which is only true while the line does not end the way the together line
  // ends.
  assert.equal(
    line.endsWith("can run together."),
    false,
    "a block was classified as a line about work that can run together",
  );
});

test("one agent holding two conflicting tasks is named once, with the order", async (t) => {
  // In the words of the person who hit it: "don't go like, at Hades and at
  // Hades are working on related things". One agent handed two tasks that
  // collide is arbitrated exactly like two agents that do, and both sides of
  // the line resolve to the same name — so the room was told "@Hades and
  // @Hades have conflicting files — @Hades will wait for @Hades to go first",
  // which names the only thing the reader already knew and none of what they
  // wanted. What they wanted is the order, and which task is which.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "oneagentroom");
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
  // The second half of the collision is the same agent's other task — the
  // vendor-resolved id the dispatched one carries, not the other vendor's.
  const alsoClaude = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "swap the retry timeout",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: ownerId,
  });
  const held = (
    await runtime.store.listSubmittedTasks({ repositoryId: repo })
  ).find((task) => task.id === tasks.claude);
  assert.ok(held !== undefined, "the dispatched task went missing");
  const heldObjective = held.objective.split("\n")[0] ?? "";
  assert.ok(
    heldObjective.length <= 40,
    `the fixture objective is long enough to be truncated: ${heldObjective}`,
  );

  await runtime.store.appendAudit(undefined, {
    type: "plan_admitted",
    taskId: tasks.claude,
    data: {
      status: "blocked",
      blockedBy: [alsoClaude.id],
      explanation:
        "Plan collides with executing work beyond the sequencing threshold",
    },
  });

  await waitFor(
    async () => {
      const messages = await runtime.store.listChannelMessages(repo, ownerId);
      return messages.some((message) => message.authorId === "coordinator");
    },
    "the one-agent collision was never announced in the room",
    8_000,
  );

  const messages = await runtime.store.listChannelMessages(repo, ownerId);
  const line = String(
    messages.find((message) => message.authorId === "coordinator")?.content,
  );
  assert.equal(
    line,
    `⚖️ @Claude (${firstName}) is working on multiple tasks that conflict — ` +
      `it will do "swap the retry timeout" first, then "${heldObjective}".`,
    `the one-agent collision did not read as one agent and an order: ${line}`,
  );
  // The shape of the complaint, named so a rewrite cannot bring it back: the
  // agent is mentioned once, and never set against itself.
  assert.equal(
    line.split(`@Claude (${firstName})`).length - 1,
    1,
    `the line named the same agent twice: ${line}`,
  );
  assert.doesNotMatch(
    line,
    /have conflicting files/u,
    "the line still described one agent's own two tasks as a collision between agents",
  );
});

test("a hold is taken back when the held task stops instead of starting", async (t) => {
  // An approved re-admission was the only thing that ever withdrew one of
  // these. Every other way out of a hold — the run failed, somebody cancelled
  // it, it never started — dropped the watcher and left "starts once the other
  // one is done" standing in the room as a promise about a run that no longer
  // exists. It is the commonest ending of the two: a held task is one that was
  // already in trouble.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "failedholdroom");
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
      explanation: "Sequenced behind executing work on the same resources",
    },
  });
  await waitFor(
    async () =>
      (await runtime.store.listChannelMessages(repo, ownerId)).some(
        (message) => message.authorId === "coordinator",
      ),
    "the hold was never announced in the room",
    8_000,
  );

  await runtime.store.appendAudit(undefined, {
    type: "task_failed",
    taskId: tasks.claude,
    data: { error: "npm test exited 1" },
  });
  await waitFor(
    async () =>
      (await runtime.store.listChannelMessages(repo, ownerId)).every(
        (message) => message.authorId !== "coordinator",
      ),
    "the hold outlived the run it was about",
    8_000,
  );

  // The ending itself is untouched: what goes is the standing claim about when
  // this was going to start, not the account of what happened to it.
  const messages = await runtime.store.listChannelMessages(repo, ownerId);
  assert.equal(
    messages.some(
      (message) =>
        message.kind === "outcome" ||
        (message.replies ?? []).some((reply) => reply.kind === "outcome"),
    ),
    true,
    `withdrawing the hold took the ending with it: ${JSON.stringify(
      messages.map((message) => message.content),
    )}`,
  );
});

test("notices left standing by a restart are swept once their collision is over", async (t) => {
  // The map that remembers which message to delete dies with the process, and
  // a hold is precisely the state that waits — across a deploy, routinely. So
  // the sweep decides from the store instead: the notice carries its task, and
  // a task that has stopped cannot still be waiting its turn.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "sweptroom");
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
      explanation: "Sequenced behind executing work on the same resources",
    },
  });
  await waitFor(
    async () =>
      (await runtime.store.listChannelMessages(repo, ownerId)).some(
        (message) => message.authorId === "coordinator",
      ),
    "the hold was never announced in the room",
    8_000,
  );

  const sweep = async (): Promise<void> => {
    await (
      runtime.gateway as unknown as {
        reconcileArbitrationNotices(): Promise<void>;
      }
    ).reconcileArbitrationNotices();
  };
  const coordinatorLines = async (): Promise<string[]> =>
    (await runtime.store.listChannelMessages(repo, ownerId))
      .filter((message) => message.authorId === "coordinator")
      .map((message) => String(message.content));

  // Both ends still running: the line is current, and a sweep that took it now
  // would be deleting the room's only account of why one agent is idle.
  await sweep();
  assert.equal(
    (await coordinatorLines()).length,
    1,
    "the sweep took a hold that was still true",
  );

  // The blocker lands. Nothing re-admits the held task — the case no live path
  // reaches — and the sentence "starts once that one is done" is now about
  // something that already happened.
  await runtime.store.cancelSubmittedTask(tasks.codex);
  await sweep();
  assert.deepEqual(
    await coordinatorLines(),
    [],
    "the hold survived the work it was waiting on",
  );
});

test("an advisory line an older deployment left behind is still swept", async (t) => {
  // Nothing writes "they can run together" any more, but the deployments that
  // did are the same rooms people are still reading, and those lines are
  // present tense about two runs that are running. Left alone one becomes the
  // room's permanent last word on a collision that stopped mattering hours
  // ago — so the sweep still has to recognise it and take it back.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "advisorysweep");
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

  // Written straight into the room, which is the only way one can arrive now:
  // the process that posted it is gone, and all this one has is the message.
  await runtime.store.appendChannelMessage({
    repositoryId: repo,
    projectId: DEFAULT_PROJECT_ID,
    kind: "system",
    authorId: "coordinator",
    content:
      `⚖️ @Claude (${firstName}) and @Codex (${firstName}) are working on ` +
      `related things but can run together.`,
    taskId: tasks.claude,
  });

  const sweep = async (): Promise<void> => {
    await (
      runtime.gateway as unknown as {
        reconcileArbitrationNotices(): Promise<void>;
      }
    ).reconcileArbitrationNotices();
  };
  const coordinatorLines = async (): Promise<string[]> =>
    (await runtime.store.listChannelMessages(repo, ownerId))
      .filter((message) => message.authorId === "coordinator")
      .map((message) => String(message.content));

  // Still running: the line is out of date in its wording, not in its claim.
  await sweep();
  assert.equal(
    (await coordinatorLines()).length,
    1,
    "the sweep took an advisory line about a run that was still going",
  );

  await runtime.store.cancelSubmittedTask(tasks.claude);
  await sweep();
  assert.deepEqual(
    await coordinatorLines(),
    [],
    "the advisory line outlived the run it described",
  );
});

test("deleting a coordinator notice does not stop the task it names", async (t) => {
  // The notice carries a task id so a fresh process can find it again — and
  // the delete route stops the task behind any message it removes. A reader
  // tidying a stale hold out of their channel would otherwise have cancelled
  // somebody else's running agent, from a line that is not even that run's
  // thread.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "deleteroom");
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
      explanation: "Sequenced behind executing work on the same resources",
    },
  });
  await waitFor(
    async () =>
      (await runtime.store.listChannelMessages(repo, ownerId)).some(
        (message) => message.authorId === "coordinator",
      ),
    "the hold was never announced in the room",
    8_000,
  );

  const notice = (await runtime.store.listChannelMessages(repo, ownerId)).find(
    (message) => message.authorId === "coordinator",
  );
  assert.ok(notice !== undefined, "the hold notice was not found");
  assert.equal(
    notice.taskId,
    tasks.claude,
    "the notice did not record the task it is about",
  );

  const removed = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages/${notice.id}`,
    { method: "DELETE" },
  );
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(
    (removed.data as { cancelledTask?: boolean }).cancelledTask,
    false,
    "deleting the notice cancelled the run it named",
  );
  assert.deepEqual(runtime.cancelCalls, [], "the notice stopped a live run");
  const held = (await runtime.store.listSubmittedTasks({ repositoryId: repo }))
    .find((task) => task.id === tasks.claude);
  assert.notEqual(
    held?.status,
    "cancelled",
    "the task behind the notice was cancelled by a channel tidy-up",
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
  const quietRoot = swept.find((message) => message.taskId === task.id);
  // Only what the handoff put there remains under the root: the
  // acknowledgement — carrying the agent's own opening, which replaces the
  // canned sentence in place once it arrives — and the thread's name. The
  // sweep must not paste a canned ending beneath work whose ending is already
  // in the room, and comparing the whole list is what proves it did not.
  assert.deepEqual(
    (quietRoot?.replies ?? []).map((reply) => reply.content),
    ["On it.", "Task: fix the typo in the README"],
    "the sweep added narration to a quick task that had already ended flat",
  );
  assert.equal(
    swept.filter((message) => message.kind === "outcome").length,
    1,
    "the ending was said twice",
  );

  // And the other half: a user-rooted thread left mid-sentence across a
  // restart, on a turn that landed conversationally and so sits `open`.
  const stranded = await runtime.store.appendChannelMessage({
    repositoryId: repo,
    projectId: DEFAULT_PROJECT_ID,
    kind: "user",
    authorId: ownerId,
    content: "@Claude refactor the auth module",
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
    content: "On it.",
    kind: "agent",
  });
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

test("a legacy vendor-wide channel name no longer shadows an account-wide rename", async (t) => {
  // The half of the report that survived the account-wide rename. A row keyed
  // by the bare provider names a *vendor*, not an agent, and clearing one on a
  // rename would rename every other person's agent on that vendor in that
  // room — so it is never cleared. Rooms carrying one from before agent-keyed
  // rows existed therefore kept answering to the old name after a rename made
  // anywhere. The call sign outranks it now.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const first = await invitableRepository(owner, "legacy-one");
  const second = await invitableRepository(owner, "legacy-two");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "personal", callSign: "Athena" },
  ]);
  await joinAllConnectedAgents(runtime, first);
  await joinAllConnectedAgents(runtime, second);
  // Written by a deployment that only had the vendor to key on.
  await runtime.store.setChannelAgentOverride(second, "anthropic", {
    name: "Hera",
    role: "Backend Engineer",
  });

  const renamed = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${first}/channel/agents/${ownerId}:anthropic`,
    { method: "POST", body: { name: "Scout" } },
  );
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.scope, "account");

  for (const repositoryId of [first, second]) {
    const roster = await owner.request(
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/agents`,
    );
    assert.equal(roster.status, 200, JSON.stringify(roster.data));
    assert.equal(roster.data.agents[0].name, "Scout");
  }
  // The room's own decision about the role is not a name and still stands.
  const rosterSecond = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${second}/channel/agents`,
  );
  assert.equal(rosterSecond.data.agents[0].role, "Backend Engineer");

  // And the new name is the one a mention resolves against there.
  const posted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${second}/channel/messages`,
    { method: "POST", body: { content: "@Scout please look at this" } },
  );
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 1);
});

test("a room's rename of one agent still wins, and an unnamed agent keeps the vendor-wide name", async (t) => {
  // The two things the rule above must not break: a deliberate per-agent
  // rename in one room is that room's to keep, and a legacy vendor-wide row
  // still names the agents that have no call sign of their own.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "legacy-kept");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "personal", callSign: "Athena" },
    // Never named — the pre-call-sign connection the legacy row is for.
    { provider: "openai", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  await runtime.store.setChannelAgentOverride(repo, "openai", { name: "Hera" });
  await runtime.store.setChannelAgentOverride(repo, `${ownerId}:anthropic`, {
    name: "Vesta",
  });

  const roster = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`,
  );
  assert.equal(roster.status, 200, JSON.stringify(roster.data));
  const agents = roster.data.agents as Array<{ provider: string; name: string }>;
  assert.equal(
    agents.find((agent) => agent.provider === "anthropic")?.name,
    "Vesta",
  );
  assert.equal(agents.find((agent) => agent.provider === "openai")?.name, "Hera");
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
      await colleague.client.request(`${base}/agents/${colleague.id}:anthropic`, {
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

  // The request message is the thread the question will be asked in.
  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) => message.taskId === task?.id);
  }, "the dispatch never attached the task to its request");
  const root = (
    await runtime.store.listChannelMessages(repo, ownerId)
  ).find((message) => message.taskId === task?.id);
  assert.notEqual(root, undefined);

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
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages/${root?.id}/replies`,
    { method: "POST", body: { content: "1" } },
  );
  assert.equal(replied.status, 201, JSON.stringify(replied.data));

  // The set comes back one answer per question, and `chosen` still mirrors the
  // first of them for an adapter that only ever asks one thing.
  assert.deepEqual(await waiting, { chosen: 0, answers: [{ chosen: 0 }] });
});

test("a set of questions is answered from the prompt, not from the thread", async (t) => {
  // The prompt above the composer is where a question is answered now. It is
  // put to the person who submitted the task and to nobody else, it carries
  // every question at once, and the options never appear in the transcript —
  // a numbered list in a message cannot page, cannot mark a recommendation,
  // and cannot take an answer the agent did not think of.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "asked-in-prompt");
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
  }, "the dispatch never attached the task to its request");

  const waiting = runtime.gateway.awaitAgentAnswer({
    requestId: "q-set",
    taskId: task?.id ?? "",
    repositoryId: repo,
    projectId: DEFAULT_PROJECT_ID,
    question: "Which approach?",
    options: ["Both modules", "One and a shim"],
    questions: [
      {
        question: "Which approach?",
        options: ["Both modules", "One and a shim"],
        recommended: 1,
      },
      { question: "Keep the old name?", options: ["Keep", "Rename"] },
      { question: "Add a test?", options: ["Yes", "No"] },
    ],
    deadlineMs: 4_000,
  });

  const questionsPath = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/questions`;
  await waitFor(async () => {
    const answer = await owner.request(questionsPath);
    return (answer.data?.questions ?? []).length > 0;
  }, "the question never reached the person who asked for the work");
  const listed = (await owner.request(questionsPath)).data;
  assert.equal(listed.questions[0].requestId, "q-set");
  assert.equal(listed.questions[0].questions.length, 3);
  assert.equal(listed.questions[0].questions[0].recommended, 1);

  // The thread records that a question was asked without repeating its
  // choices: the same decision open in two places could be taken twice.
  const messages = await runtime.store.listChannelMessages(repo, ownerId);
  const posted = messages
    .flatMap((message) => message.replies)
    .map((reply) => reply.content)
    .filter((content) => content.includes("Which approach?"));
  assert.equal(posted.length, 1);
  assert.equal(
    posted.filter((content) => content.includes("1. Both modules")).length,
    0,
  );

  const answered = await owner.request(
    `${questionsPath}/q-set/answer`,
    {
      method: "POST",
      body: {
        answers: [{ chosen: 1 }, { text: "call it loader2" }, {}],
      },
    },
  );
  assert.equal(answered.status, 200, JSON.stringify(answered.data));

  // One answer per question, in order, and an empty one is a deliberate pass
  // rather than a gap the agent has to interpret.
  assert.deepEqual(await waiting, {
    chosen: 1,
    answers: [{ chosen: 1 }, { text: "call it loader2" }, { skipped: true }],
  });

  // And once settled it is gone: a question is a live wait, so there is
  // nothing left to answer twice.
  const after = await owner.request(questionsPath);
  assert.deepEqual(after.data.questions, []);
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
  }, "the dispatch never attached the task to its request");
  const root = (
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
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages/${root?.id}/replies`,
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
  // And it never fell through to the chat model as a question about "1".
  assert.equal(
    runtime.chatPrompts.filter((entry) => entry.prompt.includes("The question: 1"))
      .length,
    0,
  );
});

test("the task root and acknowledgement exist immediately", async (t) => {
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
  // The opening thoughts still use a completion, but dispatch does not.
  runtime.chatAnswer.delayMs = 1_500;
  runtime.chatAnswer.text = "Picking this up — reading the retry loop first.";

  // Measured across the POST, because the route awaits the whole dispatch —
  // so anything the dispatch waits for is time the browser spends blocked
  // before it can render anything at all.
  const startedAt = Date.now();
  const request = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: `@${name} rework the retry loop` },
  });
  const posted = Date.now() - startedAt;

  const listed = await owner.request(`${base}/messages`);
  assert.ok(
    (listed.data.messages as { id: string; kind: string; taskId?: string }[]).some(
      (message) =>
        message.id === request.data.message.id &&
        message.kind === "user" &&
        message.taskId !== undefined,
    ),
    "the posted request was not made the task root",
  );
  // No completion's worth of waiting: opening thoughts run behind the response.
  assert.ok(
    posted < 1_000,
    `posting waited ${String(posted)}ms — it is still blocked on a model call`,
  );

  const root = (listed.data.messages as any[]).find(
    (message) => message.id === request.data.message.id,
  );
  const acknowledgement = (root?.replies ?? []).find(
    (reply: any) => reply.kind === "agent",
  );
  assert.equal(
    acknowledgement?.content,
    "I've taken this task and I'm working on it.",
  );
  assert.ok(
    runtime.chatPrompts.every(
      (entry) => !/only the acknowledgement|picking it up/iu.test(entry.prompt),
    ),
    JSON.stringify(runtime.chatPrompts),
  );
});

test("the work is queued without waiting for opening thoughts or its local title", async (t) => {
  // The second half of the same complaint. `planOpening` is a model call
  // allowed two minutes, and the run used to start only after it returned —
  // so a thread could say it had picked something up while nothing ran.
  let releaseTitle!: (title: string) => void;
  let titleStarted = false;
  const pendingTitle = new Promise<string>((resolve) => {
    releaseTitle = resolve;
  });
  const runtime = await startRuntime(t, {
    threadTitleSummariser: async () => {
      titleStarted = true;
      return await pendingTitle;
    },
  });
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
  assert.equal(titleStarted, true);
  const beforeTitle = await owner.request(`${base}/messages`);
  assert.equal(
    (beforeTitle.data.messages as any[]).some((message) =>
      (message.replies ?? []).some((reply: any) => /^Task: /u.test(reply.content)),
    ),
    false,
  );

  releaseTitle("Retry loop reliability");
  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    return (listed.data.messages as any[]).some((message) =>
      (message.replies ?? []).some(
        (reply: any) => reply.content === "Task: Retry loop reliability",
      ),
    );
  }, "the completed local title was not attached asynchronously");
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
    "how are the pullout icons animated?",
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
    "when toggling this pullout the icons should be animated from the arrow",
    // Plain instruction verbs. Every one of these was missed, which is how a
    // request could name exactly what it wanted and still not read as work:
    // the sender was answered rather than obeyed, and had to write "make that
    // implementation" — one recognised word — to get it done.
    'For the signin page instead of it saying kumi just put the logo and get rid of the punchline "one live codebase.."',
    "put the logo on the sign in page",
    "get rid of the punchline",
    "hide the punchline",
    "drop the subtitle from the header",
    "take out the old banner",
    "turn off the animation",
    "shrink the sidebar",
  ]) {
    assert.equal(looksLikeTaskRequest(request), true, request);
  }

  // The other direction, kept beside it: widening the verb list must not turn
  // chatter or a question about finished work into a task. "show" and "use"
  // are deliberately still absent — "show me a summary of the codebase" is an
  // answer request, and a task verb wins over that test, so adding them would
  // trade this bug for its mirror image.
  for (const notWork of [
    "show me a summary of the codebase",
    "give me an overview of the auth module",
    "what did you get rid of?",
    "which files were dropped?",
  ]) {
    assert.equal(looksLikeTaskRequest(notWork), false, notWork);
  }
});

/**
 * Work handed to the room without naming anybody.
 *
 * "any takers for the flaky auth ticket?" is a real ask, and a task-verb
 * list missed every one of these because "own", "takers" and "a hand"
 * describe delegation rather than the repository operation. Nothing decides
 * this by phrasing any more — the agent reads the sentence — so what has to
 * hold is that these reach it at all, which is asserted against the real
 * model in `packages/local-triage`, and that the agent's answer is what
 * dispatches. This pins the second half.
 */
test("an open-room request is picked up without anybody being named", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "open-room");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  runtime.setTaskClassification("ACT");
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "any takers for the flaky auth ticket?" },
    })).status,
    201,
  );

  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
  assert.match(
    String(runtime.submittedTasks[0]?.objective),
    /flaky auth ticket/u,
  );
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

test("a message the agent reads as chatter is answered with silence", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "not-a-request");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Every one of these is about work and asks for none. They are read — that
  // is the point of reading rather than matching — and the agent's answer is
  // to say nothing, which has to mean nothing: no offer, no task, no line in
  // the room.
  runtime.setTaskClassification("IGNORE");
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
  assert.deepEqual(agentSpeech(after.data.messages), []);
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

test("the agent reads the message before auto-dispatching, and no means no task", async (t) => {
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
  assert.match(
    String(asked[0]?.prompt),
    /Reply with exactly one of these three lines/u,
  );
  assert.match(String(asked[0]?.prompt), /settings page layout/u);

  // And nothing was said or started.
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

test("every unaddressed message is read, whatever words it uses", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "free-checks-first");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // A word list used to answer for these without asking anybody, and it had
  // to: "Changes look good" opens with a word from the verb list and is a
  // person saying the changes look good. But the same list also answered for
  // "the gray background looks rough" — silence — and for "the update went
  // out" — a request. It cannot do better, because the difference is not in
  // the words. So every message is read now, and the agent decides.
  const remarks = [
    "Changes have been made and look good",
    "Changes look good",
    "Yo what's up",
    "the update went out this morning",
    "the build is fixed now",
  ];
  runtime.setTaskClassification("IGNORE");
  const before = runtime.chatPrompts.length;
  for (const remark of remarks) {
    const posted = await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: remark },
    });
    assert.equal(posted.status, 201, remark);
  }

  const asked = runtime.chatPrompts.slice(before);
  assert.equal(
    asked.length,
    remarks.length,
    `each message reaches the agent: ${JSON.stringify(asked.map((entry) => entry.prompt.slice(-60)))}`,
  );
  for (const remark of remarks) {
    assert.ok(
      asked.some((entry) => entry.prompt.endsWith(remark)),
      `"${remark}" was read`,
    );
  }
  // And read is not the same as acted on. Every one of them was answered
  // with silence.
  assert.equal(runtime.submittedTasks.length, 0);
  const after = await owner.request(`${base}/messages`);
  assert.deepEqual(agentSpeech(after.data.messages), []);
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

  // The handoff reply exists before any task-specific narration.
  const beforeNarration = await owner.request(`${base}/messages`);
  const quiet = (beforeNarration.data.messages as any[]).find(
    (message) => message.taskId === task!.id,
  );
  assert.equal(quiet?.kind, "user");
  assert.equal(quiet?.content, asked);
  const quietSpeech = (quiet?.replies ?? []).filter(
    (reply: any) => reply.kind === "agent",
  );
  assert.equal(quietSpeech.length, 1);
  assert.equal(
    quietSpeech[0]?.content,
    "I've taken this task and I'm working on it.",
  );

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
  // The root itself is the person's exact request; its replies begin with the
  // handoff and continue with narration.
  assert.equal(thread?.kind, "user");
  assert.equal(thread?.content, asked);
  assert.equal(thread?.authorId, ownerId);
  assert.ok(replies.length > 0, JSON.stringify(replies));
  assert.equal(
    replies.filter((reply) => reply.kind === "agent").length,
    1,
    JSON.stringify(replies),
  );
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

test("channel messages and replies can be corrected only before anyone acts on them", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "message-edit");
  const guest = await joinRepository(
    runtime,
    owner,
    "edit-guest@example.com",
    repositoryId,
  );
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages`;

  const posted = await owner.request(base, {
    method: "POST",
    body: { content: "Meet at tree o'clock." },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const messageId = posted.data.message.id;

  const notAuthors = await guest.request(`${base}/${messageId}`, {
    method: "PATCH",
    body: { content: "I should not be able to rewrite this." },
  });
  assert.equal(notAuthors.status, 403, JSON.stringify(notAuthors.data));

  const corrected = await owner.request(`${base}/${messageId}`, {
    method: "PATCH",
    body: { content: "Meet at three o'clock." },
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.data));
  assert.equal(corrected.data.message.content, "Meet at three o'clock.");
  assert.equal(
    (
      await runtime.store.getChannelMessage(
        repositoryId,
        messageId,
        session.user.id,
      )
    )?.content,
    "Meet at three o'clock.",
  );

  await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: "agent:test",
    content: "That time works.",
    referencedMessageId: messageId,
  });
  const alreadyAnswered = await owner.request(`${base}/${messageId}`, {
    method: "PATCH",
    body: { content: "Meet at four o'clock." },
  });
  assert.equal(alreadyAnswered.status, 409, JSON.stringify(alreadyAnswered.data));

  const reply = await runtime.store.addChannelReply({
    repositoryId,
    messageId,
    kind: "user",
    authorId: session.user.id,
    content: "A first reply.",
  });
  const replyCorrected = await owner.request(
    `${base}/${messageId}/replies/${reply.id}`,
    { method: "PATCH", body: { content: "A corrected reply." } },
  );
  assert.equal(replyCorrected.status, 200, JSON.stringify(replyCorrected.data));
  assert.equal(replyCorrected.data.reply.content, "A corrected reply.");

  await runtime.store.addChannelReply({
    repositoryId,
    messageId,
    kind: "user",
    authorId: session.user.id,
    content: "This answers the corrected reply.",
    referencedMessageId: reply.id,
  });
  const replyAnswered = await owner.request(
    `${base}/${messageId}/replies/${reply.id}`,
    { method: "PATCH", body: { content: "Too late to rewrite this reply." } },
  );
  assert.equal(replyAnswered.status, 409, JSON.stringify(replyAnswered.data));

  // Once the root has a reply, changing the visible request would rewrite
  // history underneath somebody who has already acted on it.
  const answered = await owner.request(`${base}/${messageId}`, {
    method: "PATCH",
    body: { content: "A different request entirely." },
  });
  assert.equal(answered.status, 409, JSON.stringify(answered.data));

  const task = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId,
    objective: "act on the reply",
    agentId: "test-agent",
    validationCommands: [],
    submittedBy: session.user.id,
  });
  await runtime.store.setChannelMessageTask(repositoryId, messageId, task.id);
  const agentStarted = await owner.request(
    `${base}/${messageId}/replies/${reply.id}`,
    { method: "PATCH", body: { content: "Too late to change the prompt." } },
  );
  assert.equal(agentStarted.status, 409, JSON.stringify(agentStarted.data));
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

test("a direct message can be edited by its sender and nobody else", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "dm-edit");
  const guest = await joinRepository(
    runtime,
    owner,
    "dm-edit-guest@example.com",
    repositoryId,
  );
  const guestId = (await guest.request("/api/v1/auth/me")).data.user.id;

  const sent = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${guestId}`,
    { method: "POST", body: { content: "Meet at tree." } },
  );
  const messageId = sent.data.message.id;
  const refused = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${session.user.id}/messages/${messageId}`,
    { method: "PATCH", body: { content: "Not my words." } },
  );
  assert.equal(refused.status, 404, JSON.stringify(refused.data));

  const corrected = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${guestId}/messages/${messageId}`,
    { method: "PATCH", body: { content: "Meet at three." } },
  );
  assert.equal(corrected.status, 200, JSON.stringify(corrected.data));
  assert.equal(corrected.data.message.content, "Meet at three.");
  assert.equal(
    (
      await runtime.store.listDirectMessages(
        DEFAULT_PROJECT_ID,
        guestId,
        session.user.id,
      )
    )[0]?.content,
    "Meet at three.",
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

test("Codex usage falls back to the live account quota snapshot", async (t) => {
  let liveReads = 0;
  const runtime = await startRuntime(t, {
    codexUsageReader: async () => {
      liveReads += 1;
      return {
        limitId: "codex",
        primary: {
          usedPercent: 11,
          windowDurationMins: 300,
          resetsAt: 1_787_000_000,
        },
        secondary: {
          usedPercent: 37,
          windowDurationMins: 10_080,
          resetsAt: 1_787_400_000,
        },
        planType: "plus",
      };
    },
  });
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const response = await client.request(
    "/api/v1/chat/providers/openai/usage",
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(liveReads, 1);
  assert.deepEqual(runtime.usageCalls, ["openai"]);
  assert.equal(response.data.usage.source, "Codex account rate limits (plus)");
  const resetText = (at: number): string =>
    new Date(at * 1_000).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  assert.deepEqual(
    response.data.usage.windows,
    [
      {
        label: "5 hours",
        percentUsed: 11,
        resetsAt: resetText(1_787_000_000),
        // The raw figures travel beside the formatted ones: the string is in
        // the server's zone and locale, which the browser cannot undo.
        resetsAtEpoch: 1_787_000_000,
        windowDurationMins: 300,
      },
      {
        label: "7 days",
        percentUsed: 37,
        resetsAt: resetText(1_787_400_000),
        resetsAtEpoch: 1_787_400_000,
        windowDurationMins: 10_080,
      },
    ],
  );
  // The plan is a field of its own now, not only a phrase inside `source`.
  assert.equal(response.data.usage.planType, "plus");
  assert.equal(response.data.usage.creditBalance, undefined);
});

test("a Codex credit balance reaches the usage route", async (t) => {
  const runtime = await startRuntime(t, {
    codexUsageReader: async () => ({
      primary: { usedPercent: 4, windowDurationMins: 300 },
      secondary: { usedPercent: 19, windowDurationMins: 10_080 },
      planType: "pro",
      credits: { hasCredits: true, balance: 12.5 },
    }),
  });
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const response = await client.request(
    "/api/v1/chat/providers/openai/usage",
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.usage.planType, "pro");
  assert.equal(response.data.usage.creditBalance, 12.5);
  // A window with no reset time still reports its length, and invents no
  // reset moment for itself.
  assert.deepEqual(response.data.usage.windows[0], {
    label: "5 hours",
    percentUsed: 4,
    windowDurationMins: 300,
  });
});

test("recorded Codex usage wins without an unnecessary live lookup", async (t) => {
  let liveReads = 0;
  const runtime = await startRuntime(t, {
    codexUsageReader: async () => {
      liveReads += 1;
      return undefined;
    },
  });
  const client = new TestClient(runtime.origin);
  await bootstrap(client);
  const recorded = {
    source: "Codex CLI session records (~/.codex/sessions)",
    windows: [{ label: "5 hours", percentUsed: 23 }],
  };
  runtime.providerUsage.set("openai", recorded);

  const response = await client.request(
    "/api/v1/chat/providers/openai/usage",
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.deepEqual(response.data.usage, recorded);
  assert.equal(liveReads, 0);
});

test("unavailable live Codex usage and Claude usage retain their existing shape", async (t) => {
  let liveReads = 0;
  const runtime = await startRuntime(t, {
    codexUsageReader: async () => {
      liveReads += 1;
      return undefined;
    },
  });
  const client = new TestClient(runtime.origin);
  await bootstrap(client);
  const unavailable = {
    source: "Codex CLI session records (~/.codex/sessions)",
    windows: [],
    unavailableReason:
      "No Codex session has recorded rate limits on this machine yet.",
  };
  const claude = {
    source: "claude /usage, as reported by the signed-in account",
    windows: [{ label: "session", percentUsed: 8 }],
  };
  runtime.providerUsage.set("openai", unavailable);
  runtime.providerUsage.set("anthropic", claude);

  const codexResponse = await client.request(
    "/api/v1/chat/providers/openai/usage",
  );
  const claudeResponse = await client.request(
    "/api/v1/chat/providers/anthropic/usage",
  );
  assert.equal(codexResponse.status, 200, JSON.stringify(codexResponse.data));
  assert.equal(claudeResponse.status, 200, JSON.stringify(claudeResponse.data));
  assert.deepEqual(codexResponse.data.usage, unavailable);
  assert.deepEqual(claudeResponse.data.usage, claude);
  assert.equal(liveReads, 1);
});

/**
 * Withdraws one environment variable for the duration of a test.
 *
 * The gateway reads the registration and proxy settings the way the rest of
 * this process does — from the environment — so a test that wants a different
 * default has to swap it and put it back.
 */
function withEnvironment(
  t: TestContext,
  values: Record<string, string | undefined>,
): void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
}

test("registration is open by default", async (t) => {
  // No invitation and no registration setting: sharing the deployment link is
  // enough for a newcomer to create their own isolated account and team.
  withEnvironment(t, {
    COORD_ALLOW_REGISTRATION: undefined,
    COORD_DISABLE_REGISTRATION: undefined,
  });
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  const created = await registerAccount(runtime.store, client, {
    email: "stranger@example.com",
    displayName: "Stranger",
    password: PASSWORD,
  });

  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.user.email, "stranger@example.com");
  assert.equal(created.data.memberships.length, 1);
  assert.equal(created.data.memberships[0].role, "owner");
});

test("a TLS request behind a trusted proxy gets Secure cookies and HSTS", async (t) => {
  // The control plane speaks plain HTTP and TLS terminates at the router, so
  // the forwarded protocol is the only evidence there is — and it is only
  // evidence when a proxy is actually trusted, which is why the hop count has
  // to be stated rather than inferred.
  withEnvironment(t, { COORD_TRUSTED_PROXY_HOPS: "1" });
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);

  const overTls = await client.request("/api/v1/health", {
    headers: { "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.7" },
  });
  assert.match(
    overTls.headers.get("strict-transport-security") ?? "",
    /max-age=\d+/u,
  );

  // The same deployment reached over plain HTTP is not pinned to HTTPS: the
  // browser would remember that for the domain and nothing in the app could
  // take it back.
  const plain = await client.request("/api/v1/health");
  assert.equal(plain.headers.get("strict-transport-security"), null);
});

test("without a trusted proxy the forwarded headers are ignored entirely", async (t) => {
  // Trusting `X-Forwarded-*` unconditionally is worse than not reading it:
  // every client would choose its own rate-limit bucket and could claim to
  // have arrived over TLS.
  withEnvironment(t, { COORD_TRUSTED_PROXY_HOPS: undefined });
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);

  const claimed = await client.request("/api/v1/health", {
    headers: { "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.7" },
  });
  assert.equal(claimed.headers.get("strict-transport-security"), null);
});

test("/ask asks first and then works — the command says both halves", async (t) => {
  // The reported case: "I want to add an orchestrate command, use /ask for
  // clarifications" got an answer describing what such a command would do,
  // with nothing asked and nothing built. `/ask` is not `/dnc`: it opens the
  // question round and the same task carries on into the work afterwards.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "ask-then-builds");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: "@Claude (Owner) add an orchestrate command /ask",
    },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  // Coordinated work, not the read-only answer path.
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  assert.match(
    runtime.submittedTasks[0]?.objective ?? "",
    /add an orchestrate command/u,
  );
  assert.match(
    runtime.submittedTasks[0]?.objective ?? "",
    /force a question round before implementation/u,
  );

  // And the picker promises the second half too, so nobody reads `/ask` as a
  // command that only ever talks.
  const listed = await owner.request(`${base}/messages`);
  const ask = (listed.data.slashCommands as any[]).find(
    (entry) => entry.name === "ask",
  );
  assert.match(String(ask?.summary), /questions first/iu);
  assert.match(String(ask?.summary), /do the work/iu);
});

/* ------------------------------------------------- account confirmations ---- */

/** A mailer that keeps what it was asked to send, and a link reader for it. */
function recordingMailer(): { sent: MailMessage[]; mailer: Mailer } {
  const sent: MailMessage[] = [];
  return {
    sent,
    mailer: async (message) => {
      sent.push(message);
    },
  };
}

function resetLink(message: MailMessage | undefined): string {
  const match = /#reset\/(\S+)/u.exec(message?.text ?? "");
  return match?.[1] ?? "";
}

test("the free registration routes are retired, and say so", async (t) => {
  // They made an account without a card. Sign-up takes one now, so leaving
  // these reachable would leave the paywall with a door beside it.
  //
  // 410 rather than 404, and rather than silence: they existed, they are gone
  // deliberately, and a client still calling one should be told which of
  // those it is. The tests that used to cover mailed confirmation codes and
  // retyped-address mismatches went with the routes — what replaces them is
  // the paid sign-up's own tests, where account creation now lives.
  const { client, store } = await startBareGateway(t, {});
  await bootstrap(client);
  const before = await store.countUsers();
  const stranger = new TestClient(client.origin);

  for (const route of ["/api/v1/auth/register", "/api/v1/auth/register/confirm"]) {
    const refused = await stranger.request(route, {
      method: "POST",
      body: {
        email: "newcomer@example.com",
        confirmEmail: "newcomer@example.com",
        displayName: "Newcomer",
        password: PASSWORD,
        confirmPassword: PASSWORD,
      },
    });
    assert.equal(refused.status, 410, `${route}: ${JSON.stringify(refused.data)}`);
    assert.equal(refused.data.error.code, "registration_retired");
    // The way in is named, so a stale client is not left guessing.
    assert.match(refused.data.error.message, /\/auth\/signup/u);
    assert.equal(refused.headers.get("set-cookie"), null);
  }

  // And nothing was created on the way past.
  assert.equal(await store.countUsers(), before);
});


test("a forgotten password is recovered through a mailed link", async (t) => {
  const { sent, mailer } = recordingMailer();
  const { client } = await startBareGateway(t, { mailer });
  await bootstrap(client);

  const asked = new TestClient(client.origin);
  const requested = await asked.request("/api/v1/auth/password-reset", {
    method: "POST",
    body: { email: "owner@example.com" },
  });
  assert.equal(requested.status, 202);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, "owner@example.com");

  const token = resetLink(sent[0]);
  assert.notEqual(token, "", sent[0]?.text);

  // The form checks the link before asking for a password, and is told whose
  // account it belongs to.
  const preview = await asked.request(
    `/api/v1/auth/password-reset/${encodeURIComponent(token)}`,
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.data.reset.email, "owner@example.com");

  const changed = await asked.request("/api/v1/auth/password-reset/confirm", {
    method: "POST",
    body: {
      token,
      password: "BrandNewRelay123!",
      confirmPassword: "BrandNewRelay123!",
    },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal(changed.data.user.email, "owner@example.com");

  // The link is single use, and the old password no longer works.
  const replayed = await asked.request("/api/v1/auth/password-reset/confirm", {
    method: "POST",
    body: {
      token,
      password: "BrandNewRelay123!",
      confirmPassword: "BrandNewRelay123!",
    },
  });
  assert.equal(replayed.status, 400);
  assert.equal(replayed.data.error.code, "reset_invalid");

  const stale = new TestClient(client.origin);
  const oldPassword = await stale.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "owner@example.com", password: PASSWORD },
  });
  assert.equal(oldPassword.status, 401);

  const newPassword = await stale.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "owner@example.com", password: "BrandNewRelay123!" },
  });
  assert.equal(newPassword.status, 200, JSON.stringify(newPassword.data));
});

test("asking to reset an unknown address says nothing about it", async (t) => {
  const { sent, mailer } = recordingMailer();
  const { client } = await startBareGateway(t, { mailer });
  await bootstrap(client);

  const stranger = new TestClient(client.origin);
  const answer = await stranger.request("/api/v1/auth/password-reset", {
    method: "POST",
    body: { email: "nobody@example.com" },
  });
  // Same status and same wording as for an address that does exist, or this
  // endpoint would answer "does this person have an account here".
  assert.equal(answer.status, 202);
  assert.equal(sent.length, 0);

  const known = await stranger.request("/api/v1/auth/password-reset", {
    method: "POST",
    body: { email: "owner@example.com" },
  });
  assert.equal(known.status, 202);
  assert.equal(known.data.message, answer.data.message);
});

test("a reset link that was superseded or mistyped is refused", async (t) => {
  const { sent, mailer } = recordingMailer();
  const { client } = await startBareGateway(t, { mailer });
  await bootstrap(client);

  const asked = new TestClient(client.origin);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const answer = await asked.request("/api/v1/auth/password-reset", {
      method: "POST",
      body: { email: "owner@example.com" },
    });
    assert.equal(answer.status, 202);
  }
  assert.equal(sent.length, 2);

  // Asking twice invalidates the first link rather than leaving two working
  // keys in the mailbox.
  const first = await asked.request(
    `/api/v1/auth/password-reset/${encodeURIComponent(resetLink(sent[0]))}`,
  );
  assert.equal(first.status, 404);
  assert.equal(first.data.error.code, "reset_invalid");

  const mistyped = await asked.request(
    `/api/v1/auth/password-reset/${encodeURIComponent(`${resetLink(sent[1])}x`)}`,
  );
  assert.equal(mistyped.status, 404);

  const latest = await asked.request(
    `/api/v1/auth/password-reset/${encodeURIComponent(resetLink(sent[1]))}`,
  );
  assert.equal(latest.status, 200);
});

test("a reset refuses a new password that was retyped differently", async (t) => {
  const { sent, mailer } = recordingMailer();
  const { client } = await startBareGateway(t, { mailer });
  await bootstrap(client);

  const asked = new TestClient(client.origin);
  await asked.request("/api/v1/auth/password-reset", {
    method: "POST",
    body: { email: "owner@example.com" },
  });
  const token = resetLink(sent[0]);
  const refused = await asked.request("/api/v1/auth/password-reset/confirm", {
    method: "POST",
    body: {
      token,
      password: "BrandNewRelay123!",
      confirmPassword: "BrandNewRelay124!",
    },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.data.error.code, "confirmation_mismatch");

  // The link survives a typo: burning it would leave the person with no way
  // back in but to ask for another.
  const retried = await asked.request("/api/v1/auth/password-reset/confirm", {
    method: "POST",
    body: {
      token,
      password: "BrandNewRelay123!",
      confirmPassword: "BrandNewRelay123!",
    },
  });
  assert.equal(retried.status, 200, JSON.stringify(retried.data));
});

/**
 * Reported as data loss, and it was not: the records were untouched. A second
 * account had been created on the deployment, and signing back in as the
 * first showed an empty workspace — because the owner administers every
 * organization on the deployment and the list came back ordered by name, so
 * the newcomer's took the head of it.
 */
test("a newer account's workspace never displaces the owner's own", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  // Registration hands a self-signed-up account its own organization, named
  // after them — and "Aria's team" sorts ahead of the owner's "Relay Test".
  const newcomer = new TestClient(runtime.origin);
  const registered = await registerAccount(runtime.store, newcomer, {
    email: "aria@example.com",
    displayName: "Aria",
    password: PASSWORD,
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.data));

  const listed = await owner.request("/api/v1/organizations");
  assert.equal(listed.status, 200);
  const organizations = listed.data.organizations as {
    id: string;
    name: string;
  }[];

  // A system administrator really can reach it, and it stays listed: hiding
  // it would break the administration the role exists for.
  assert.ok(
    organizations.some((entry) => entry.name === "Aria's team"),
    "the administrator can still reach every organization",
  );
  // But it is not what they are shown. The control room opens whatever comes
  // first, so ordering by name alone handed the owner somebody else's empty
  // workspace and read as having lost their own.
  assert.equal(
    organizations[0]?.name,
    "Relay Test",
    "the owner's own organization leads their list",
  );

  // And the boundary still holds in the other direction: the newcomer sees
  // one organization, theirs.
  const theirs = await newcomer.request("/api/v1/organizations");
  assert.deepEqual(
    (theirs.data.organizations as { name: string }[]).map(
      (entry) => entry.name,
    ),
    ["Aria's team"],
  );
});

/* ------------------------------------------- unaddressed message verdict --- */

test("missing, malformed, or no-task answer directives fail closed without exposing control markers", () => {
  assert.deepEqual(parseAnswerTaskDirective("The route is in server.ts."), {
    answer: "The route is in server.ts.",
    taskObjective: undefined,
  });
  assert.deepEqual(
    parseAnswerTaskDirective(
      "The retry loop is bounded.\nANSWER_TASK: NONE",
    ),
    {
      answer: "The retry loop is bounded.",
      taskObjective: undefined,
    },
  );
  assert.equal(
    parseAnswerTaskDirective(
      "The retry loop is bounded.\nANSWER_TASK: NO_TASK.",
    ).taskObjective,
    undefined,
  );

  for (const malformed of [
    "The retry loop is bounded.\nANSWER_TASK add tests",
    "The retry loop is bounded.\nANSWER_TASK:",
    "The retry loop is bounded.\nANSWER_TASK:: Add tests",
    "The retry loop is bounded.\nANSWER_TASK: Add tests\nMore detail follows.",
    "The retry loop is bounded.\nANSWER_TASK: Add tests\nANSWER_TASK: Add more tests",
    "The retry loop is bounded.\nANSWER_TASK: Add tests ANSWER_TASK: Add more tests",
    "The retry loop is bounded. ANSWER_TASK: Add tests",
  ]) {
    const parsed = parseAnswerTaskDirective(malformed);
    assert.equal(parsed.taskObjective, undefined, malformed);
    assert.doesNotMatch(parsed.answer ?? "", /ANSWER_TASK/u, malformed);
  }

  // A directive without an answer is not enough to spend an account either.
  assert.deepEqual(parseAnswerTaskDirective("ANSWER_TASK: Add tests"), {
    answer: undefined,
    taskObjective: undefined,
  });
});

/**
 * What an agent decides about a message nobody addressed to it.
 *
 * The reply is a line of text from a model, so the parser is the boundary
 * between "a model said something" and "somebody's account is about to be
 * spent". Everything it cannot read is silence.
 */
test("a decision is read out of the agent's reply, and only a clear one", () => {
  assert.deepEqual(parseAutoClaimVerdict("ACT"), { verdict: "act" });
  assert.deepEqual(parseAutoClaimVerdict("act\n"), { verdict: "act" });
  assert.deepEqual(parseAutoClaimVerdict("OFFER: Shall I change the background colour?"), {
    verdict: "offer",
    proposal: "Shall I change the background colour?",
  });
  // Models reach for quotes and bullets when asked for a sentence; none of
  // that belongs in the room.
  assert.deepEqual(parseAutoClaimVerdict('OFFER "Shall I retire the old flag?"'), {
    verdict: "offer",
    proposal: "Shall I retire the old flag?",
  });
  assert.deepEqual(parseAutoClaimVerdict("IGNORE"), { verdict: "ignore" });

  // Everything unreadable lands on silence, which is the direction that costs
  // nothing: a paragraph where a word was asked for, a refusal, an empty
  // answer, a timeout that produced nothing at all.
  for (const unreadable of [
    undefined,
    "",
    "   ",
    "I'm not sure what you mean.",
    "MAYBE",
    "OFFER:",
    "OFFER:    ",
  ]) {
    assert.deepEqual(
      parseAutoClaimVerdict(unreadable),
      { verdict: "ignore" },
      JSON.stringify(unreadable),
    );
  }
});

test("an offer is recognised by its tail, and gives up its proposal", () => {
  const posted =
    'Shall I change the background colour?\n\nSay "yes" and I\'ll ask you ' +
    "what I need before I start — or @mention someone else.";
  assert.equal(
    autoClaimProposal(posted),
    "Shall I change the background colour?",
  );
  // Anything else in the transcript is not an offer, and acceptance must not
  // find one where none was made.
  assert.equal(autoClaimProposal("Shall I change the background colour?"), undefined);
  assert.equal(autoClaimProposal("yes"), undefined);
});

/**
 * The clear half of the three-way decision: a message that says what it wants
 * is taken, and nothing is asked.
 *
 * The offer exists to resolve doubt. Where there is none it is a round trip
 * that buys nothing, and a person who wrote "change the background to blue"
 * and was answered "would you like me to change the background?" has been
 * asked to say the same thing twice.
 */
test("a message that plainly asks for work is taken without an offer", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "acts-at-once");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  runtime.setTaskClassification("ACT");
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "change the background on the settings page to blue" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
  assert.match(
    String(runtime.submittedTasks[0]?.objective),
    /background on the settings page to blue/u,
  );
  // Not asked first, and not asked afterwards either: there was nothing
  // unclear, so the question round is not forced.
  assert.doesNotMatch(
    String(runtime.submittedTasks[0]?.objective),
    /force a question round/u,
  );
  const after = await owner.request(`${base}/messages`);
  assert.deepEqual(
    (after.data.messages as any[]).filter((message) =>
      /Say "yes" and I'll ask you what I need/u.test(String(message.content)),
    ),
    [],
    "nothing was offered — it was simply taken",
  );
});

/**
 * The unsure half: work is implied but not asked for, so the agent names the
 * specific thing it would do and waits. Saying yes starts it *asking*.
 */
test("an implied request is proposed on, and yes starts it in its question round", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "proposes-first");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  runtime.setTaskClassification(
    "OFFER: Shall I change the background colour on the settings page?",
  );
  const remark = "it looks like the background doesn't look great with gray";
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: remark },
    })).status,
    201,
  );

  // Offered in the agent's own words, about this message. A fixed sentence
  // could only have said "want me to take this?", which is not a question
  // about anything and cannot be answered without re-reading the room.
  const offered = await owner.request(`${base}/messages`);
  const offer = (offered.data.messages as any[]).find(
    (message) => message.kind === "agent",
  );
  assert.match(
    String(offer?.content),
    /Shall I change the background colour on the settings page\?/u,
  );
  assert.equal(runtime.submittedTasks.length, 0, "an offer is not a start");

  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "yes" },
    })).status,
    201,
  );

  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
  const objective = String(runtime.submittedTasks[0]?.objective);
  // Both halves travel. The remark is the words a person chose; the proposal
  // is what they said yes to, and neither alone is the job.
  assert.match(objective, /doesn't look great with gray/u);
  assert.match(objective, /Shall I change the background colour/u);
  // And it goes in asking — which colour was never said, and guessing at it
  // is the whole reason an offer was made instead of an edit.
  assert.match(objective, /force a question round/u);
});

/**
 * Who an unaddressed request goes to, when nothing about it points anywhere.
 *
 * Fit decides first and is worth queueing behind — the right agent to ask is
 * still the right one when it is busy. Below that there is no "right", only
 * "whose account", and the answer is the person who asked. Below *that* the
 * only remaining question is who can start now.
 */
test("an unmatched request goes to the sender's own agent, then to whoever is free", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "fallback-order");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const teammate = await runtime.store.createUser({
    email: "fallback-colleague@example.com",
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

  // One agent each, both org-wide so either could take anything.
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org", callSign: "Willow" },
  ]);
  runtime.chatConnections.set(teammate.id, [
    { provider: "openai", visibility: "org", callSign: "Cedar" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Named so that nothing in the request can match either of them, and no
  // role set on either: this is the case where fit has no answer at all.

  runtime.setTaskClassification("ACT");
  assert.equal(
    (await colleague.request(`${base}/messages`, {
      method: "POST",
      body: { content: "rewrite the shipping calculator" },
    })).status,
    201,
  );

  // Tier two: nothing matched, so the person who asked spends their own
  // account rather than a colleague's.
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  assert.equal(
    runtime.submittedTasks[0]?.actorId,
    teammate.id,
    "the sender's own agent takes an unmatched request",
  );

  // That task is now in flight — nothing has finished it — so the same
  // sender asking again finds their own agent busy.
  assert.equal(
    (await colleague.request(`${base}/messages`, {
      method: "POST",
      body: { content: "rewrite the invoice totals page" },
    })).status,
    201,
  );

  // Tier three: anybody who can start now, rather than a queue behind an
  // agent that was only ever the fallback pick.
  assert.equal(runtime.submittedTasks.length, 2, JSON.stringify(runtime.submittedTasks));
  assert.equal(
    runtime.submittedTasks[1]?.actorId,
    ownerId,
    "a busy fallback hands over to whoever is free",
  );
});

/**
 * An invitation with no address on it: a link, not a letter.
 *
 * The addressed form named one mailbox and was spent the first time it was
 * opened, which is not how an invitation gets used. It gets pasted into the
 * chat the team is already in, and the second person to click it was told it
 * had already been used.
 */
test("an invite link with no address admits more than one person", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "open-link");

  const invited = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    {
      method: "POST",
      body: {
        role: "developer",
        repositoryId: repo,
        projectId: DEFAULT_PROJECT_ID,
      },
    },
  );
  assert.equal(invited.status, 201, JSON.stringify(invited.data));
  const token = invited.data.token as string;
  assert.match(token, /^inv_[\w-]+\.[\w-]+$/u);

  // Nobody is named, and the screen the recipient lands on has to know that
  // so it asks who they are rather than showing a blank disabled field.
  const preview = await new TestClient(runtime.origin).request(
    `/api/v1/invitations/${token}`,
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.data.invitation.open, true);
  assert.equal(preview.data.invitation.email, "");
  assert.equal(preview.data.invitation.role, "developer");

  // Two people, one link, neither of them named on it.
  for (const [email, name] of [
    ["first@example.com", "First Joiner"],
    ["second@example.com", "Second Joiner"],
  ] as const) {
    const joiner = new TestClient(runtime.origin);
    const accepted = await joiner.request(
      `/api/v1/invitations/${token}/accept`,
      { method: "POST", body: { email, displayName: name, password: PASSWORD } },
    );
    assert.equal(accepted.status, 200, `${email}: ${JSON.stringify(accepted.data)}`);
    assert.equal(accepted.data.user.email, email);
    // The same grant the addressed form makes, and no more: one repository,
    // no organization membership, because any organization role would reach
    // every repository and undo the scoping.
    assert.deepEqual(accepted.data.memberships, []);
  }

  const grants = await runtime.store.listRepositoryGrants(repo);
  assert.deepEqual(
    grants.map((grant) => grant.role),
    ["developer", "developer"],
  );

  // An address that already has an account is refused rather than signed in:
  // holding the link proves nothing about who is holding it.
  const impostor = new TestClient(runtime.origin);
  const taken = await impostor.request(`/api/v1/invitations/${token}/accept`, {
    method: "POST",
    body: {
      email: "first@example.com",
      displayName: "Not First",
      password: PASSWORD,
    },
  });
  assert.equal(taken.status, 409);
  assert.equal(taken.data.error?.code ?? taken.data.code, "account_exists");

  // And it still ends when somebody ends it.
  const listed = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
  );
  const open = (listed.data.invitations as any[]).find(
    (entry) => entry.email === "",
  );
  assert.equal(open?.status, "pending", "an open link is not spent by use");
  assert.equal(
    (
      await owner.request(
        `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations/${open.id}`,
        { method: "DELETE" },
      )
    ).status,
    200,
  );
  const late = new TestClient(runtime.origin);
  const refused = await late.request(`/api/v1/invitations/${token}/accept`, {
    method: "POST",
    body: {
      email: "third@example.com",
      displayName: "Too Late",
      password: PASSWORD,
    },
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.data));
});

/**
 * The offer as a prompt, not only as a sentence to answer in words.
 *
 * It is the same prompt an agent's own questions use — one list, one set of
 * keyboard shortcuts, one rule about who may answer — because an offer is the
 * same kind of thing: one person's decision, with work waiting on it.
 */
test("an offer puts up the choice prompt, and tapping yes starts the work", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "offer-prompt");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  runtime.setTaskClassification("OFFER: Shall I retire the old feature flag?");
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "that old flag is still hanging around everywhere" },
    })).status,
    201,
  );

  const open = await owner.request(`${base}/questions`);
  assert.equal(open.status, 200);
  const prompt = (open.data.questions as any[])[0];
  assert.notEqual(prompt, undefined, JSON.stringify(open.data));
  assert.equal(
    prompt.questions[0].question,
    "Shall I retire the old feature flag?",
  );
  assert.deepEqual(prompt.questions[0].options, ["Yes, go ahead", "No thanks"]);
  assert.equal(runtime.submittedTasks.length, 0, "a prompt is not a start");

  // Somebody else's prompt is nobody else's decision — the same rule the
  // agent's own questions follow.
  const stranger = new TestClient(runtime.origin);
  const other = await runtime.store.createUser({
    email: "offer-prompt-other@example.com",
    displayName: "Other Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: other.id,
    role: "developer",
  });
  await stranger.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: other.email, password: PASSWORD },
  });
  assert.deepEqual(
    (await stranger.request(`${base}/questions`)).data.questions,
    [],
  );

  const answered = await owner.request(
    `${base}/questions/${encodeURIComponent(prompt.requestId)}/answer`,
    { method: "POST", body: { answers: [{ chosen: 0 }] } },
  );
  assert.equal(answered.status, 200);

  // The tap dispatches exactly what a typed "yes" dispatches: the words the
  // person used, the proposal they agreed to, and the question round.
  await waitFor(
    async () => runtime.submittedTasks.length === 1,
    "tapping yes never dispatched the work",
  );
  const objective = String(runtime.submittedTasks[0]?.objective);
  assert.match(objective, /old flag is still hanging around/u);
  assert.match(objective, /Shall I retire the old feature flag/u);
  assert.match(objective, /force a question round/u);

  // And the prompt is gone, so the work cannot be started a second time by
  // somebody typing "yes" underneath it.
  assert.deepEqual((await owner.request(`${base}/questions`)).data.questions, []);
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "yes" },
    })).status,
    201,
  );
  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
});

test("declining the prompt starts nothing, and says nothing about it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "offer-declined");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  runtime.setTaskClassification("OFFER: Shall I tidy the imports?");
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "the imports in that module are a mess" },
  });
  const prompt = (await owner.request(`${base}/questions`)).data.questions[0];
  const before = (await owner.request(`${base}/messages`)).data.messages.length;

  assert.equal(
    (
      await owner.request(
        `${base}/questions/${encodeURIComponent(prompt.requestId)}/answer`,
        { method: "POST", body: { answers: [{ chosen: 1 }] } },
      )
    ).status,
    200,
  );

  assert.equal(runtime.submittedTasks.length, 0);
  // Declining a suggestion is not an event the room needs narrating to it.
  assert.equal(
    (await owner.request(`${base}/messages`)).data.messages.length,
    before,
  );
  assert.deepEqual((await owner.request(`${base}/questions`)).data.questions, []);
});

/**
 * The local pass, and the one thing it is allowed to do.
 *
 * Reading every unaddressed message is what replaced the word list, and it
 * is right — but it runs on somebody's subscription, and most of a working
 * channel is people talking to each other. This keeps that half off the
 * agents entirely, and is allowed to answer only when it is sure.
 */
test("conversation the local pass is sure about never reaches an agent", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "local-triage");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  runtime.setLocalChatter((text) => text.startsWith("hi "));
  runtime.setTaskClassification("ACT");
  const before = runtime.chatPrompts.length;

  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "hi Ethan, how was the weekend" },
    })).status,
    201,
  );
  assert.deepEqual(
    runtime.chatPrompts.slice(before),
    [],
    "no agent was asked, and nobody's usage was spent",
  );
  assert.equal(runtime.submittedTasks.length, 0);

  // And the filter decides nothing else. A message it is not sure about goes
  // on to the agent exactly as before — that is what makes it safe to put in
  // front of the decision rather than in place of it.
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "change the background on settings to blue" },
    })).status,
    201,
  );
  // Counted by the decision prompt itself: dispatching also asks the agent
  // to compose what it says when it picks work up, and that is not this.
  const decisions = runtime.chatPrompts
    .slice(before)
    .filter((entry) =>
      /Reply with exactly one of these three lines/u.test(entry.prompt),
    );
  assert.equal(decisions.length, 1, JSON.stringify(decisions.map((d) => d.prompt.slice(-40))));
  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
});

/**
 * A message posts immediately, whatever the agent's decision costs to reach.
 *
 * The classify call used to sit inside the request that posted the sender's
 * own message — nothing was shown until it answered, and it had up to
 * twenty seconds to. On a slow attempt that read as the feature not firing
 * at all, because the one place that would have said otherwise was the
 * response the sender was waiting on. It is a real model call on the
 * account whose CLI may, at that exact moment, be busy running a coding
 * task on this same host — contention that can genuinely slow a process
 * spin-up — so "sometimes slow" was never a corner case here.
 */
test("the sender's message posts before the agent has decided anything", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "does-not-block");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const gate = runtime.setClassifyGate();
  runtime.setTaskClassification("ACT");
  try {
    // The gate is held shut for the whole request — a stand-in for the
    // worst case, a classify call that never comes back at all.
    const posted = await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "there's a lot of lag when loading in from mobile, find a fix" },
    });
    assert.equal(posted.status, 201, JSON.stringify(posted.data));
    assert.equal(
      posted.data.message.content,
      "there's a lot of lag when loading in from mobile, find a fix",
      "the sender's own words are in the response — nothing waited on the agent",
    );
    // And nothing happened yet, because nothing has been decided yet.
    assert.equal(runtime.submittedTasks.length, 0);
  } finally {
    gate.release();
  }

  // Once the agent's decision actually lands, the work it describes still
  // happens — the same outcome as an instant classification, only later.
  await waitFor(
    async () => runtime.submittedTasks.length === 1,
    "the decision never arrived after the gate was released",
  );
  assert.match(
    String(runtime.submittedTasks[0]?.objective),
    /lag when loading in from mobile/u,
  );
});

/**
 * A classify call that errors is retried once, and the retry can still
 * answer — a single slow or dropped attempt is not the difference between a
 * request being read and a request going quiet.
 */
test("a failed classify attempt gets a second try before the message goes quiet", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "retries-once");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // The first attempt is the one contention would hit: it answers with
  // nothing, exactly what a timed-out or unreachable CLI looks like from
  // here. The second is a clean host and a clean answer — the immediate
  // retry `readAutoClaimVerdict` makes before giving up.
  runtime.setClassifyFailures(1);
  runtime.setTaskClassification("ACT");
  const before = runtime.chatPrompts.length;

  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "change the background on settings to blue" },
    })).status,
    201,
  );

  await waitFor(
    async () => runtime.submittedTasks.length === 1,
    "the retry never dispatched the work",
  );
  const attempts = runtime.chatPrompts
    .slice(before)
    .filter((entry) =>
      /Reply with exactly one of these three lines/u.test(entry.prompt),
    );
  assert.equal(attempts.length, 2, "exactly one retry, not an unbounded loop");
});

/**
 * The instruction actually says what the product wants: act on its own
 * judgment by default, and reserve asking for a real fork in the work.
 *
 * A prompt is not code a type checker holds still — nothing stops a later
 * edit from quietly softening "lean toward acting" back into "when in
 * doubt, ask," and the softened version would still pass every dispatch
 * test in this file, because those all set the verdict directly rather than
 * reading it from a real model. This is the one guard that actually reads
 * the words the model is given.
 */
test("the classify prompt is biased toward acting on its own judgment", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "leans-toward-acting");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  runtime.setTaskClassification("ACT");
  const before = runtime.chatPrompts.length;
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "it looks like the token usage is wrong" },
  });
  await waitFor(
    async () => runtime.chatPrompts.length > before,
    "the classify call never ran",
  );
  const asked =
    runtime.chatPrompts
      .slice(before)
      .map((entry) => entry.prompt)
      .find((prompt) =>
        /Reply with exactly one of these three lines/u.test(prompt),
      ) ?? "";

  // The framing that sets the default.
  assert.match(asked, /Lean toward acting/u);
  assert.match(
    asked,
    /fill(?:ing)? in whatever was not spelled out with their own reasonable judgment/u,
  );
  // ACT no longer requires the message to spell out what it wants — an
  // observation is enough, and unspecified detail is not by itself a reason
  // to offer instead.
  assert.match(asked, /whether it is phrased as a direct request[\s\S]{0,40}or as an observation/u);
  assert.match(
    asked,
    /not merely when something was left unspecified/u,
  );
  // What still offers: real ambiguity between different pieces of work, or
  // stakes high enough that guessing is the wrong instinct even with a
  // guess in hand — not "some detail is missing."
  assert.match(
    asked,
    /could mean two or more substantially different pieces of work/u,
  );
  assert.match(asked, /costly or hard to undo/u);
  // The guardrails this replaced nothing about are still here.
  assert.match(asked, /do not interrupt their conversation/u);
});

/**
 * The reported case, end to end: the sender's own agent is mid-task, the
 * free agent in the room is somebody else's — and that agent's credential
 * is broken. Reading the message runs on the chosen agent's own sign-in, a
 * per-user thing that fails independently of anything about the message, so
 * before this the whole decision died with it: the free agent errored
 * silently and the busy one, perfectly able to queue the work, was never
 * asked. An unreachable pick now hands the decision to the runner-up; a
 * real verdict — IGNORE included — still ends the line, so two agents never
 * rule on one message.
 */
test("an unreachable pick hands the decision to the runner-up, not to silence", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "understudy");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const cofounder = await addColleague(runtime, "understudy-cofounder@example.com");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org", callSign: "Willow" },
  ]);
  runtime.chatConnections.set(cofounder.id, [
    { provider: "openai", visibility: "org", callSign: "Cedar" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  // Names that share no token with the request, so no fit tier: this is the
  // pure fallback path.
  // The owner's own agent is mid-task — an unfinished row under the same
  // (owner, agent) key the busy signal reads.
  await runtime.store.submitTask({
    repositoryId,
    objective: "long refactor still running",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: ownerId,
  });

  // Tier 2 skips the busy own agent; tier 3 picks the cofounder's free
  // Codex. Its first two classify attempts — the retry — produce nothing,
  // which is what an expired sign-in looks like from here. The third call is
  // the understudy: the owner's busy Claude, whose credential works fine.
  runtime.setClassifyFailures(2);
  runtime.setTaskClassification("ACT");
  const before = runtime.chatPrompts.length;
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "please rework the shipping calculator" },
    })).status,
    201,
  );

  await waitFor(
    async () => runtime.submittedTasks.length === 1,
    "the understudy never dispatched the work",
  );
  // Landed on the busy-but-reachable agent, spending its owner's account —
  // the sender's own, here — and queued behind its current task rather than
  // vanishing.
  assert.equal(runtime.submittedTasks[0]?.actorId, ownerId);
  assert.equal(runtime.submittedTasks[0]?.vendor, "claude");
  const classifies = runtime.chatPrompts
    .slice(before)
    .filter((entry) =>
      /Reply with exactly one of these three lines/u.test(entry.prompt),
    );
  assert.equal(
    classifies.length,
    3,
    "two attempts on the pick, one on the understudy — and no more",
  );
});

/**
 * The reported case: sender's own agent is genuinely free, no roles are set —
 * and the work went to the cofounder's agent anyway. The busy signal counted
 * every unfinished task row, and a conversational turn that has landed parks
 * at `open` BY DESIGN — the row stays so the conversation can continue, but
 * nothing is running. One chat with your own agent marked it busy for the
 * rest of time, and tier two skipped it forever after.
 */
test("a parked conversation does not make the sender's own agent busy", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "parked-conversation");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const cofounder = await addColleague(runtime, "parked-cofounder@example.com");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org", callSign: "Willow" },
  ]);
  runtime.chatConnections.set(cofounder.id, [
    { provider: "openai", visibility: "org", callSign: "Cedar" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  // No shared tokens with the request, so the fit tier stays out of it.

  // One earlier conversation with the owner's agent, landed and parked open.
  const turn = await runtime.store.submitTask({
    repositoryId,
    objective: "earlier conversational turn, long since answered",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: ownerId,
    conversationId: "conv_parked",
  });
  await runtime.store.claimSubmittedTasks(repositoryId);
  await runtime.store.openSubmittedTask(turn.id);

  runtime.setTaskClassification("ACT");
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "please rework the shipping calculator" },
    })).status,
    201,
  );

  await waitFor(
    async () => runtime.submittedTasks.length === 1,
    "the unaddressed request was never dispatched",
  );
  // Tier two: the sender's own, free agent — not a colleague's, and not the
  // colleague's because of a chat that ended hours ago.
  assert.equal(runtime.submittedTasks[0]?.actorId, ownerId);
  assert.equal(runtime.submittedTasks[0]?.vendor, "claude");
});

/**
 * The other way the busy signal lied: nothing reaps a task whose run
 * crashed, so a `claimed` row from a run that died days ago counted as "this
 * agent is busy" forever. A corpse past the age bound stops being evidence.
 */
test("a stranded task from a dead run ages out of the busy signal", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "stale-corpse");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const cofounder = await addColleague(runtime, "stale-cofounder@example.com");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org", callSign: "Willow" },
  ]);
  runtime.chatConnections.set(cofounder.id, [
    { provider: "openai", visibility: "org", callSign: "Cedar" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // A run that died three hours ago: the row stranded `claimed`, and nothing
  // will ever finish it. Backdated through the store's own map — the public
  // API stamps submission time itself, which is exactly why a corpse cannot
  // be made through it.
  const corpse = await runtime.store.submitTask({
    repositoryId,
    objective: "run that crashed and never reported",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: ownerId,
  });
  await runtime.store.claimSubmittedTasks(repositoryId);
  const rows = (
    runtime.store as unknown as {
      submitted: Map<string, { submittedAt: string }>;
    }
  ).submitted;
  const row = rows.get(corpse.id);
  assert.notEqual(row, undefined);
  row!.submittedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

  runtime.setTaskClassification("ACT");
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "please rework the shipping calculator" },
    })).status,
    201,
  );

  await waitFor(
    async () => runtime.submittedTasks.length === 1,
    "the unaddressed request was never dispatched",
  );
  assert.equal(runtime.submittedTasks[0]?.actorId, ownerId);
  assert.equal(runtime.submittedTasks[0]?.vendor, "claude");
});

/**
 * Accepting one offer twice across a restart starts the work once.
 *
 * The settled-offers set is in-memory and this deployment restarts on every
 * merge. A tap posts no user message, so after a restart a typed "yes" under
 * the still-visible offer passed every guard: the settled set was empty, the
 * offer sat inside its window, and nobody had spoken in between. The durable
 * evidence of acceptance is the dispatched task itself — its objective
 * quotes the proposal — and that is what the acceptance path now checks.
 */
test("a yes after a restart does not start already-accepted work twice", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "restart-yes");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  runtime.setTaskClassification("OFFER: Shall I speed up the mobile boot?");
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "loading in from mobile feels slow" },
  });
  const prompt = (await owner.request(`${base}/questions`)).data.questions[0];
  assert.notEqual(prompt, undefined);
  assert.equal(
    (
      await owner.request(
        `${base}/questions/${encodeURIComponent(prompt.requestId)}/answer`,
        { method: "POST", body: { answers: [{ chosen: 0 }] } },
      )
    ).status,
    200,
  );
  await waitFor(
    async () => runtime.submittedTasks.length === 1,
    "the tapped acceptance never dispatched",
  );

  // The restart: in-memory settlements are gone, the offer message is not.
  (
    runtime.gateway as unknown as { settledAutoClaimOffers: Set<string> }
  ).settledAutoClaimOffers.clear();

  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "yes" },
    })).status,
    201,
  );

  // Once. The durable task, not the forgotten set, is what says so — and the
  // sender is told the work is already underway rather than met with either
  // silence or a duplicate.
  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
  const messages = (await owner.request(`${base}/messages`)).data.messages as any[];
  assert.ok(
    messages.some(
      (message) =>
        message.kind === "system" &&
        /already accepted/u.test(String(message.content)),
    ),
    JSON.stringify(messages.map((m) => [m.kind, String(m.content).slice(0, 50)])),
  );
});

test("estimateTokens approximates length in tokens", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("   "), 0);
  // Four characters to the token, rounded up.
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  const long = "word ".repeat(100);
  assert.ok(estimateTokens(long) > estimateTokens("word"));
});

test("truncateToTokens cuts an over-long entry at a word boundary", () => {
  const short = "already short enough";
  assert.equal(truncateToTokens(short, 50), short);

  const long = "alpha bravo charlie delta echo foxtrot golf hotel india";
  const cut = truncateToTokens(long, 6);
  assert.notEqual(cut, long);
  assert.ok(cut.endsWith("…"), cut);
  assert.ok(estimateTokens(cut) <= 7, cut);
  // Every word it kept is a whole word from the original.
  const words = cut.replace(" …", "").split(" ");
  for (const word of words) {
    assert.ok(long.split(" ").includes(word), `partial word: ${word}`);
  }
  assert.equal(truncateToTokens(long, 0), "");
});

test("selectThreadContext keeps the thread root and the newest entries within budget", () => {
  const filler = "padding ".repeat(40).trim();
  const lines = [
    "root: please make the sidebar collapsible",
    `first ${filler}`,
    `second ${filler}`,
    `third ${filler}`,
    "the newest thing anybody said",
  ];
  const selected = selectThreadContext({ lines, budgetTokens: 60 });
  assert.equal(selected.lines[0], lines[0]);
  assert.equal(selected.lines.at(-1), lines.at(-1));
  assert.ok(selected.lines.length < lines.length);
  const spent = selected.lines.reduce(
    (sum, line) => sum + estimateTokens(line),
    0,
  );
  assert.ok(spent <= 60, `spent ${String(spent)}`);
  // A thread that fits is sent whole.
  const whole = selectThreadContext({ lines: ["one", "two"] });
  assert.deepEqual(whole.lines, ["one", "two"]);
  assert.equal(whole.elided, 0);
});

test("selectThreadContext retains an older entry that is relevant to the request", () => {
  const filler = "padding ".repeat(30).trim();
  const lines = [
    "root: we are reworking the deployment pipeline",
    "we decided the migration runner must stay idempotent",
    `noise one ${filler}`,
    `noise two ${filler}`,
    "quick note",
  ];
  const focus = "is the migration runner still idempotent?";
  const selected = selectThreadContext({ lines, focus, budgetTokens: 60 });
  assert.ok(
    selected.lines.includes(
      "we decided the migration runner must stay idempotent",
    ),
    JSON.stringify(selected.lines),
  );
  // Without the request there is nothing to score it against, so recency
  // alone decides and the older decision drops off.
  const blind = selectThreadContext({ lines, budgetTokens: 60 });
  assert.ok(
    !blind.lines.includes(
      "we decided the migration runner must stay idempotent",
    ),
    JSON.stringify(blind.lines),
  );
});

test("selectThreadContext reports elided history instead of silently dropping it", () => {
  const filler = "padding ".repeat(40).trim();
  const lines = [
    "root",
    `one ${filler}`,
    `two ${filler}`,
    `three ${filler}`,
    "newest",
  ];
  const selected = selectThreadContext({ lines, budgetTokens: 40 });
  assert.equal(selected.elided, lines.length - selected.lines.length);
  assert.ok(selected.elided > 0);
  const notice = elidedHistoryNotice(selected.elided);
  assert.ok(notice.includes(String(selected.elided)), notice);
  assert.ok(elidedHistoryNotice(1).includes("1 earlier message "), "singular");
  assert.ok(elidedHistoryNotice(3).includes("3 earlier messages"), "plural");
});

test("summariseChannelThread speaks for a conversation only when it settled something", () => {
  const settled = summariseChannelThread({
    id: "one",
    kind: "user",
    content: "how should the retry loop back off?",
    replies: [
      { kind: "progress", content: "reading services/worker/src" },
      {
        kind: "outcome",
        content: "Switched retries to exponential backoff capped at a minute.",
      },
      { kind: "user", content: "nice" },
    ],
  });
  assert.ok(settled !== undefined);
  assert.ok(settled.startsWith("how should the retry loop back off?"), settled);
  assert.ok(settled.includes("exponential backoff"), settled);
  // A conversation that only chatted leaves nothing behind: carrying its
  // opening line alone is the dilution this layer exists to avoid.
  assert.equal(
    summariseChannelThread({
      id: "two",
      kind: "user",
      content: "morning all",
      replies: [{ kind: "agent", content: "looking now" }],
    }),
    undefined,
  );
  // People settling it between themselves counts, with no agent ending.
  const spoken = summariseChannelThread({
    id: "three",
    kind: "user",
    content: "which store backs the channel?",
    replies: [
      {
        kind: "user",
        content: "we decided the memory store stays the contract",
      },
    ],
  });
  assert.ok(spoken?.includes("we decided the memory store"), String(spoken));
  // An opening that decides on its own, with nobody needing to reply.
  assert.ok(
    summariseChannelThread({
      id: "four",
      kind: "user",
      content: "we are going with the queue instead of a cron",
    }) !== undefined,
  );
  // Deleted threads and the room's own machinery never speak for it.
  assert.equal(
    summariseChannelThread({
      id: "five",
      kind: "user",
      content: "we decided to drop the cache",
      deletedAt: new Date().toISOString(),
    }),
    undefined,
  );
  assert.equal(
    summariseChannelThread({
      id: "six",
      kind: "progress",
      content: "we decided to drop the cache",
    }),
    undefined,
  );
});

test("summariseChannelThread prefers the thread's ending over later chatter", () => {
  const line = summariseChannelThread({
    id: "one",
    kind: "user",
    content: "the export format",
    replies: [
      {
        kind: "outcome",
        content: "Shipped CSV export behind the same button.",
      },
      { kind: "user", content: "we will look at parquet another time" },
    ],
  });
  assert.ok(line?.includes("Shipped CSV export"), String(line));
  assert.ok(!line?.includes("parquet"), String(line));
});

test("selectChannelMemo carries the newest threads and older ones the request is about", () => {
  const thread = (
    id: string,
    content: string,
    decision: string,
  ): ChannelMemoThread => ({
    id,
    kind: "user",
    content,
    replies: [{ kind: "outcome", content: decision }],
  });
  const threads = [
    thread(
      "migration",
      "the deployment pipeline rewrite",
      "We decided the migration runner must stay idempotent.",
    ),
    thread("icons", "the icon set", "We chose the outline icons."),
    thread("copy", "the onboarding copy", "We went with the shorter blurb."),
    thread("colours", "the banner colour", "We settled on the muted teal."),
    thread("spacing", "the card spacing", "We chose eight point spacing."),
    thread("newest", "the sidebar width", "We decided on a fixed sidebar."),
  ];
  const lines = selectChannelMemo({
    threads,
    focus: "make the migration runner idempotent for the new backfill",
  });
  const joined = lines.join("\n");
  // Recency: the last thing the room settled is standing context.
  assert.ok(joined.includes("fixed sidebar"), joined);
  assert.ok(joined.includes("eight point spacing"), joined);
  // Relevance: the decision the request is actually about, from further back.
  assert.ok(joined.includes("migration runner must stay idempotent"), joined);
  // Everything unrelated in between stays out.
  assert.ok(!joined.includes("outline icons"), joined);
  assert.ok(!joined.includes("shorter blurb"), joined);
  // Read in the order the room happened.
  assert.ok(
    joined.indexOf("migration runner") < joined.indexOf("fixed sidebar"),
    joined,
  );
  // With nothing to score against, recency alone decides.
  const blind = selectChannelMemo({ threads });
  assert.ok(!blind.join("\n").includes("migration runner"), blind.join("\n"));
});

test("selectChannelMemo stays inside its budget and thread cap", () => {
  const filler = "padding ".repeat(30).trim();
  const threads = Array.from({ length: 10 }, (_, index) => ({
    id: `thread-${String(index)}`,
    kind: "user",
    content: `topic number ${String(index)} ${filler}`,
    replies: [
      {
        kind: "outcome",
        content: `We decided on option ${String(index)} ${filler}`,
      },
    ],
  }));
  const capped = selectChannelMemo({ threads, maxThreads: 1 });
  assert.equal(capped.length, 1);
  assert.ok(capped[0]?.includes("option 9"), String(capped[0]));
  const budgeted = selectChannelMemo({ threads, budgetTokens: 40 });
  const spent = budgeted.reduce((sum, line) => sum + estimateTokens(line), 0);
  assert.ok(spent <= 40, `spent ${String(spent)}`);
  assert.deepEqual(selectChannelMemo({ threads, budgetTokens: 0 }), []);
});

test("summariseAuditData keeps priority keys first and falls back to other scalar fields", () => {
  const summary = summariseAuditData({
    exitCode: 2,
    gate: "typecheck",
    status: "validation_failed",
    explanation: "the   typecheck   gate failed",
    retried: true,
    files: ["a.ts", "b.ts"],
  });
  const order = summary.split(" ").filter((part) => part.includes("="));
  assert.ok(summary.startsWith("status=validation_failed"), summary);
  assert.ok(summary.includes("explanation=the typecheck gate failed"), summary);
  assert.ok(summary.includes("files=2"), summary);
  // The fields outside the old allowlist now reach the model too.
  assert.ok(summary.includes("exitCode=2"), summary);
  assert.ok(summary.includes("gate=typecheck"), summary);
  assert.ok(summary.includes("retried=true"), summary);
  assert.ok(order.indexOf("status=validation_failed") === 0, summary);
});

test("summariseAuditData skips bulk payload fields and respects the per-event cap", () => {
  const summary = summariseAuditData({
    status: "completed",
    patch: "diff --git a/x b/x\n".repeat(200),
    stdout: "noise".repeat(500),
    taskId: "task_123",
    prompt: "the whole prompt",
    changedFiles: [{ path: "a.ts" }, { path: "b.ts" }],
  });
  assert.ok(summary.includes("status=completed"), summary);
  assert.ok(!summary.includes("patch="), summary);
  assert.ok(!summary.includes("stdout="), summary);
  assert.ok(!summary.includes("task_123"), summary);
  assert.ok(!summary.includes("prompt="), summary);
  assert.ok(summary.includes("changedFiles=2"), summary);
  assert.ok(summary.length <= 400, String(summary.length));

  const sprawling = summariseAuditData(
    Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `field${String(index)}`,
        "a value that is not especially short",
      ]),
    ),
  );
  assert.ok(sprawling.length <= 400, String(sprawling.length));
  assert.equal(summariseAuditData({}), "");
});

/** Opens an upgrade the way a shell does, and reports what came back. */
async function upgradeEvents(
  origin: string,
  query: string,
  cookie: string,
): Promise<{ upgraded: boolean; status?: number }> {
  const port = Number(new URL(origin).port);
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      port,
      host: "127.0.0.1",
      path: `/api/v1/events?${query}`,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        ...(cookie.length === 0 ? {} : { Cookie: cookie }),
      },
    });
    const timer = setTimeout(() => {
      request.destroy();
      reject(new Error("timed out negotiating the event socket"));
    }, 5_000);
    request.on("upgrade", (_response, socket) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ upgraded: true });
    });
    request.on("response", (response) => {
      clearTimeout(timer);
      response.resume();
      resolve({ upgraded: false, status: response.statusCode ?? 0 });
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

test("a socket ticket is minted by any credential and spent exactly once", async (t) => {
  // A browser proves itself to an upgrade with its session cookie, which it
  // attaches on its own. `new WebSocket(url)` takes no headers, so a client
  // holding a bearer token — a desktop shell — has no way to present it. The
  // ticket is what goes in the URL instead of the token.
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const created = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "desktop", scopes: ["view"] },
  });
  assert.equal(created.status, 201);
  const token = created.data.token as string;

  // Minted by the credential that cannot be presented to an upgrade, which is
  // the entire reason this route exists.
  const byToken = await bearer(runtime.origin, "/api/v1/auth/ws-ticket", token, {
    method: "POST",
  });
  assert.equal(byToken.status, 201);
  assert.equal(typeof byToken.data.ticket, "string");
  assert.ok(byToken.data.expiresInMs > 0);

  // And by a session, so the browser is not a special case in the other
  // direction either.
  const bySession = await client.request("/api/v1/auth/ws-ticket", {
    method: "POST",
  });
  assert.equal(bySession.status, 201);
  assert.notEqual(bySession.data.ticket, byToken.data.ticket);

  // Spent. Whatever the upgrade then makes of the project, the ticket is gone.
  const ticket = String(byToken.data.ticket);
  const query = `projectId=absent&ticket=${encodeURIComponent(ticket)}`;
  await upgradeEvents(runtime.origin, query, "");
  const replayed = await upgradeEvents(runtime.origin, query, "");
  assert.equal(replayed.upgraded, false);
});

test("a bad ticket is refused rather than quietly falling back to the cookie", async (t) => {
  // The failure this shape invites: a client presents a ticket, the ticket is
  // expired or already spent, and the server tries the cookie next. On a
  // desktop shell there is no cookie and nothing happens — but in a browser,
  // where a stale session is usually lying around, a dead ticket would look
  // like a working one and the bug would only ever appear somewhere else.
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const refused = await upgradeEvents(
    runtime.origin,
    "projectId=absent&ticket=not-a-real-ticket",
    // A cookie that authenticates perfectly well on its own.
    client.cookieHeader,
  );
  assert.equal(refused.upgraded, false);
});

test("a token can be created, seen in the list, and revoked from a session", async (t) => {
  // The three calls the settings card makes, in the order it makes them. The
  // routes predate any UI reaching them, so this is the first thing to hold
  // them to the shape a screen actually reads: a secret exactly once, an
  // `active` flag to hide what has been revoked, and the fields the rows show.
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const empty = await client.request("/api/v1/auth/tokens");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.tokens, []);

  const created = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "My laptop", scopes: ["view", "run_task"] },
  });
  assert.equal(created.status, 201);
  assert.match(created.data.token as string, /^coord_pat_/u);

  const listed = await client.request("/api/v1/auth/tokens");
  assert.equal(listed.data.tokens.length, 1);
  const [row] = listed.data.tokens as Array<Record<string, unknown>>;
  assert.equal(row?.name, "My laptop");
  assert.equal(row?.active, true);
  assert.equal(typeof row?.createdAt, "string");
  // Never again. The store keeps a digest, so the list cannot show a secret
  // even to the person who made it — which is why the card has to.
  assert.equal(row?.token, undefined);
  assert.equal(row?.secret, undefined);

  const revoked = await client.request(
    `/api/v1/auth/tokens/${encodeURIComponent(String(row?.id))}`,
    { method: "DELETE" },
  );
  assert.ok(revoked.status === 200 || revoked.status === 204, String(revoked.status));

  const after = await client.request("/api/v1/auth/tokens");
  assert.equal(
    (after.data.tokens as Array<{ active?: boolean }>).filter(
      (entry) => entry.active !== false,
    ).length,
    0,
  );
});

test("an app callback is only ever an address on this machine", () => {
  // The one check this flow cannot get wrong. The browser is about to be sent
  // to this address carrying a code that buys a token, so anything that is not
  // loopback is not an open redirect — it is a way to have somebody sign in
  // and hand the result to whoever asked.
  for (const allowed of [
    "http://127.0.0.1:53127/callback",
    "http://localhost:8123/cb",
    "http://[::1]:9000/cb",
    // Any port, because the app takes whatever was free at startup.
    "http://127.0.0.1:1/cb",
  ]) {
    assert.equal(isLoopbackCallback(allowed), true, allowed);
  }

  for (const refused of [
    // The obvious one, and the whole reason for the check.
    "http://evil.example.com/cb",
    "https://evil.example.com/cb",
    // Hostnames that merely start or end like loopback.
    "http://127.0.0.1.evil.example.com/cb",
    "http://localhost.evil.example.com/cb",
    "http://notlocalhost/cb",
    // Credentials in the URL, which some parsers read as the host.
    "http://127.0.0.1@evil.example.com/cb",
    "http://user:pass@127.0.0.1/cb",
    // Schemes that are not a loopback listener at all.
    "file:///tmp/cb",
    "javascript:alert(1)",
    "data:text/html,<script>",
    "app://kumi/cb",
    // Not a URL.
    "",
    "not a url",
    "//127.0.0.1/cb",
  ]) {
    assert.equal(isLoopbackCallback(refused), false, refused);
  }
});

test("approving an app hands the browser a code, and the code buys one token", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const approved = await client.request(
    "/api/v1/auth/app-authorization/approve",
    {
      method: "POST",
      body: {
        name: "Kumi on my laptop",
        redirectUri: "http://127.0.0.1:53127/callback",
        state: "abc123",
      },
    },
  );
  assert.equal(approved.status, 201);

  // The redirect carries a code, never the token: a token in a redirect is a
  // token in the browser's history and in whatever the loopback server logs.
  const target = new URL(approved.data.redirectTo as string);
  assert.equal(target.origin, "http://127.0.0.1:53127");
  assert.equal(target.searchParams.get("state"), "abc123");
  const code = target.searchParams.get("code") ?? "";
  assert.ok(code.length > 20, code);
  assert.equal(target.searchParams.get("token"), null);

  // Exchanged with no credential at all, which is the point: the app has none
  // yet, and acquiring one is what the call is for.
  const exchanged = await bareRequest(
    runtime.origin,
    "/api/v1/auth/app-authorization/exchange",
    { code },
  );
  assert.equal(exchanged.status, 201);
  assert.match(exchanged.data.token as string, /^coord_pat_/u);
  assert.equal(exchanged.data.name, "Kumi on my laptop");

  // Spent. A second attempt with the same code is refused.
  const replayed = await bareRequest(
    runtime.origin,
    "/api/v1/auth/app-authorization/exchange",
    { code },
  );
  assert.equal(replayed.status, 400);

  // And the token it handed over actually works.
  const me = await bearer(
    runtime.origin,
    "/api/v1/auth/me",
    exchanged.data.token as string,
  );
  assert.equal(me.status, 200);
  assert.equal(me.data.credential, "api_token");

  // What the token may do, asked of the gateway rather than of a constant.
  //
  // The first version of this grant was `view` and `run_task`, and nothing
  // here noticed, because the only thing asserted was that the token worked
  // *somewhere*. It did — and then answered "This token does not carry the
  // import_repository scope" the first time somebody pushed to GitHub, which
  // is the ordinary way work leaves Kumi.
  //
  // Both directions are checked, and against a project that exists: the scope
  // check runs *after* the lookup, so aiming this at a made-up id would 404
  // before reaching the gate and pass no matter what the token carried.
  const imported = await bearer(
    runtime.origin,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
    exchanged.data.token as string,
    { method: "POST", body: {} },
  );
  assert.notEqual(
    imported.data?.error?.code,
    "token_scope_missing",
    "the app cannot import, sync, or push without import_repository",
  );

  // And a scope it must not have has to be refused by the scope check itself,
  // not merely by whatever role the approver happened to hold — the approver
  // here is the owner, so a role check alone would let this through.
  const organizations = await bearer(
    runtime.origin,
    "/api/v1/organizations",
    exchanged.data.token as string,
  );
  assert.equal(organizations.status, 200);
  const organizationId = (organizations.data.organizations ?? organizations.data)[0]
    ?.id as string;
  assert.ok(organizationId, "the bootstrap made no organization to rename");

  const renamed = await bearer(
    runtime.origin,
    `/api/v1/organizations/${organizationId}`,
    exchanged.data.token as string,
    { method: "PATCH", body: { name: "Somewhere else" } },
  );
  assert.equal(renamed.status, 403);
  assert.equal(renamed.data.error.code, "token_scope_missing");
});

test("an app cannot be approved for somewhere else, or by another app", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const offsite = await client.request(
    "/api/v1/auth/app-authorization/approve",
    {
      method: "POST",
      body: {
        name: "Definitely fine",
        redirectUri: "https://evil.example.com/cb",
        state: "x",
      },
    },
  );
  assert.equal(offsite.status, 400);
  assert.equal(offsite.data.error.code, "callback_rejected");

  // A token approving the next app would make revoking this one pointless —
  // the same rule minting a token by hand already follows.
  const created = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "existing", scopes: ["view"] },
  });
  const byToken = await bearer(
    runtime.origin,
    "/api/v1/auth/app-authorization/approve",
    created.data.token as string,
    {
      method: "POST",
      body: { name: "chained", redirectUri: "http://127.0.0.1:1/cb", state: "" },
    },
  );
  assert.equal(byToken.status, 403);
});
