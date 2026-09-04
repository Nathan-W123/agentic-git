/**
 * The gateway suite's fixtures: a runtime on a real socket, a client that
 * keeps its cookies, and the shorthand for the accounts, repositories and
 * agents almost every test needs before it can assert anything.
 *
 * It lives apart from the tests because there is one of it and there were
 * 388 of those in a single 23,152-line file - long past the point where an
 * agent could load the tests for the thing it was changing.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
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

import { AGENT_ACCOUNT_PREFIX, mcpServersForLease } from "@coord/shared-types";
import { createSecretSealer, type SecretSealer } from "@coord/workspace-manager";
import type { ProxyDial } from "./mcp-proxy.js";

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
  previewBaseHref,
  previewProxyHeaders,
  readsAsEchoOfRequest,
  readsAsQuestion,
  reportedFreshTokens,
  requestFromObjective,
  rewritePreviewHtml,
  selectChannelMemo,
  selectThreadContext,
  summariseAuditData,
  summariseChannelThread,
  summariseObjective,
  summariseThreadTitle,
  textOverlap,
  truncateToTokens,
  type ApiOperations,
  type ChannelMemoThread,
  type StaticAsset,
  withRoleContext,
} from "./server.js";
import { hashPassword, hashSecret } from "./auth.js";
import { createMailer, type MailMessage, type Mailer } from "./mailer.js";
import type { CodexUsageReader } from "./codex-subscription-usage.js";
import type { CatchUpSummariser } from "./catch-up.js";


export const BOOTSTRAP_TOKEN = "bootstrap-token-with-at-least-24-characters";
export const PASSWORD = "RelayPassword123!";

// Keep registration explicit for fixtures so a caller's environment cannot
// change their result. The test that pins the product default clears it for
// its own runtime.
process.env["COORD_ALLOW_REGISTRATION"] = "1";
// The mailed-code step is off by default in the product. The fixtures below
// exercise it, so they ask for it explicitly; the test that pins the default
// clears it for its own runtime.
process.env["COORD_REQUIRE_EMAIL_CONFIRMATION"] = "1";
// Payments are off in the product now. Almost every test in this file is
// about a deployment that takes them — the trial, the seat count, the
// entitlement gate — so the switch is on for the fixtures, and the tests that
// are about it being off clear it for their own runtime with
// `withEnvironment`.
process.env["KUMI_PAYMENTS_ENABLED"] = "1";

export interface TestRuntime {
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
   * What the fake preview operations report, so a test can point the proxy at
   * a server it controls. `url` absent is a deployment with nothing running,
   * which is what every test that is not about the preview sees.
   */
  preview: { url?: string; exited?: unknown };
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
  setLocalWork: (reads: (text: string) => boolean) => void;
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
  /** Every pause and every resume, so the thread control can be watched. */
  pauseCalls: Array<{ taskIds: string[]; reason: string; actorId: string }>;
  resumeCalls: Array<{ taskId: string; actorId: string }>;
}

/**
 * Stands in for the dashboard's JavaScript: text, and large enough that
 * compressing it is worth the header it costs.
 */
export const SCRIPT_ASSET = `export const screens = ${JSON.stringify(
  Array.from({ length: 400 }, (_, index) => `screen-${index}`),
)};\n`.repeat(4);

/** The digest a build would put in that module's name. */
export const SCRIPT_DIGEST = "0123456789ab";

/**
 * One static request, made with `http` rather than `fetch` so the test decides
 * what it accepts and reads what comes back byte for byte. `fetch` rewrites
 * `Accept-Encoding` and silently decompresses, which hides the two things
 * these tests are about.
 */
export async function fetchAsset(
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

export class TestClient {
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
export async function waitFor(
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

export async function rawHttp(port: number, request: string): Promise<string> {
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

export async function startRuntime(
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
    /** How long a task waits unclaimed before the room is told nothing took it. */
    stalledTaskMs?: number;
    /** How long the audit log keeps an event. Zero keeps everything. */
    auditRetentionDays?: number;
    /** How often the retention sweep runs, so a test need not wait hours. */
    auditRetentionSweepIntervalMs?: number;
    codexUsageReader?: CodexUsageReader;
    /**
     * Stands in for Stripe, so a test can watch what the seat count does to
     * a live subscription. Absent for every other test, which is also what a
     * deployment without billing configured looks like.
     */
    stripe?: StripeClient;
    /**
     * Seals MCP secrets, standing in for the credential store. Absent for
     * every test that is not about tools, which is also what a deployment
     * with no credential store looks like to the routes that need one.
     */
    secretSealer?: SecretSealer;
    /**
     * Stands in for the socket when an approved MCP server is dialled, so a
     * test can assert what travelled rather than what a hostname resolved to.
     */
    mcpDial?: ProxyDial;
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
    /** The dashboard's per-minute budget, for the bucket-isolation test. */
    rateLimitPerMinute?: number;
    /** The MCP endpoint's own per-minute budget, which must be separate. */
    mcpRateLimitPerMinute?: number;
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
  const preview: TestRuntime["preview"] = {};
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
  // The mirror the local-agents auto-claim path reads. Undefined means
  // "whatever is not conversation is work", which is the shape an
  // embedding model with a margin actually has minus its uncertain middle.
  let localWork: ((text: string) => boolean) | undefined;
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
  const pauseCalls: TestRuntime["pauseCalls"] = [];
  const resumeCalls: TestRuntime["resumeCalls"] = [];
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
  /**
   * The provider list, shared by `list` and `setSettings`.
   *
   * Both return it in the real service, and a settings response is what the
   * browser replaces its whole provider list with — so a fixture where only
   * one of them answers faithfully cannot show whether a write empties the
   * Agents tab, which is exactly the bug this shape exists to catch.
   */
  const listProviderStatuses = (userId: string): unknown[] => {
    const connections = chatConnections.get(userId) ?? [];
    return ["anthropic", "openai", "cursor"].map((id) => {
      const connection = connections.find((entry) => entry.provider === id);
      return {
        id,
        name: id,
        connected: connection !== undefined,
        ...(connection === undefined
          ? {}
          : {
              ownCredential: {
                kind: "oauth_token",
                visibility: connection.visibility ?? "personal",
              },
            }),
      };
    });
  };

  const operations: ApiOperations = {
    chatProviders: {
      // Faithful in the one respect the gateway acts on: the route decides,
      // per provider, whether an agent exists at all, and it reads
      // `ownCredential` to do it. A stub that answered `[]` meant that
      // decision was made over an empty list and never exercised.
      async list(input) {
        return listProviderStatuses(input.userId);
      },
      async signIn() {
        return {};
      },
      async connect() {
        return {};
      },
      // Faithful to the two things the real service tears down, because a
      // stub that did nothing meant every test of disconnecting was really a
      // test that the route returned 200. It removes the connection *and* the
      // durable record — the roster is a union of both, so forgetting either
      // one leaves the agent listed.
      async disconnect(input: { userId: string; provider: string }) {
        const connections = chatConnections.get(input.userId) ?? [];
        chatConnections.set(
          input.userId,
          connections.filter((entry) => entry.provider !== input.provider),
        );
        await store.clearAgentCallSign(input.userId, input.provider);
      },
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
          // An agent that exists as a durable record and has no credential is
          // configurable, which is the ordinary shape since local execution.
          // The fixture has to behave like the real service here or it tests
          // a rule the service no longer has.
          //
          // And it must *not* invent a connection to represent that: this map
          // stands for credentials, so pushing one makes a credential-less
          // agent look credential-backed, and the visibility the gateway wrote
          // to its record is then correctly ignored on the way back out. The
          // real service writes a settings row, which is a different thing.
          const record = (await store.listAgentCallSigns()).find(
            (sign) =>
              sign.userId === input.userId && sign.provider === input.provider,
          );
          if (record === undefined) {
            throw Object.assign(
              new Error(`Connect ${input.provider} before changing its settings`),
              { status: 409, code: "not_connected" },
            );
          }
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
            if (connection !== undefined) {
              delete connection.callSign;
            }
            await store.clearAgentCallSign(input.userId, input.provider);
          } else {
            if (connection !== undefined) {
              connection.callSign = trimmed;
            }
            await store.setAgentCallSign(input.userId, input.provider, trimmed);
          }
        }
        // The provider list, as the real service returns — this response is
        // what the browser replaces its whole list with, so a fixture that
        // answers `{}` cannot show that the tab survives a write.
        return listProviderStatuses(input.userId);
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
      // `paused` is in the set for the same reason apps/cli has it: changing
      // your mind about parked work is cancelling it. Sweeps still skip it
      // below, beside `open`.
      const cancellable = new Set([
        "submitted",
        "claimed",
        "planned",
        "open",
        "paused",
      ]);
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
              task.status === "paused" ||
              (agentId !== undefined && task.agentId !== agentId) ||
              (input.ownerId !== undefined &&
                task.submittedBy !== input.ownerId)
        ) {
          continue;
        }
        const was =
          task.status === "claimed"
            ? ("running" as const)
            : task.status === "planned" || task.status === "paused"
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
    // The store half of apps/cli's `pauseTasks` / `resumeTasks`, which is
    // everything the gateway's own behaviour depends on: the row moves to a
    // status nothing can lease, and moves back.
    async pauseTasks(input) {
      pauseCalls.push({
        taskIds: [...input.taskIds],
        reason: input.reason,
        actorId: input.actorId,
      });
      const wanted = new Set(input.taskIds);
      const paused: Array<{
        id: string;
        agentId: string;
        objective: string;
        was: "running" | "queued";
      }> = [];
      for (const task of await store.listSubmittedTasks({
        repositoryId: input.repositoryId,
      })) {
        if (!wanted.has(task.id)) {
          continue;
        }
        const was = task.status === "claimed" ? "running" : "queued";
        if ((await store.pauseSubmittedTask(task.id)) === undefined) {
          continue;
        }
        await store.appendAudit(undefined, {
          type: "task_paused",
          taskId: task.id,
          data: { actorId: input.actorId, reason: input.reason },
        });
        paused.push({
          id: task.id,
          agentId: task.agentId,
          objective: task.objective,
          was,
        });
      }
      return { paused };
    },
    async resumeTask(input) {
      resumeCalls.push({ taskId: input.taskId, actorId: input.actorId });
      const resumed = await store.resumePausedTask(input.taskId);
      if (resumed === undefined) {
        return { resumed: false };
      }
      await store.appendAudit(undefined, {
        type: "task_resumed",
        taskId: input.taskId,
        data: { actorId: input.actorId },
      });
      return { resumed: true };
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
      // The real `leaseWork` narrows its candidate list by `repositories`
      // before it leases anything, so a fake that leased first and answered
      // afterwards would test the gateway's backstop instead of the rule.
      // Asking per allowed repository is the same narrowing the store's own
      // clause can express.
      const allowed =
        input.repositories === undefined
          ? [input.repositoryId]
          : input.repositoryId === undefined
            ? [...input.repositories]
            : input.repositories.has(input.repositoryId)
              ? [input.repositoryId]
              : [];
      let leased: Awaited<ReturnType<typeof store.leaseNextTask>>;
      for (const repositoryId of allowed) {
        leased = await store.leaseNextTask({
          workerId: input.workerId,
          projectId: input.projectId,
          baseRevision: "a".repeat(40),
          ttlMs: 5 * 60 * 1000,
          ...(repositoryId === undefined ? {} : { repositoryId }),
        });
        if (leased !== undefined) {
          break;
        }
      }
      if (leased === undefined) {
        return undefined;
      }
      // The same gate the real `leaseWork` runs, on the same store, with
      // the sealer this runtime was given: what the gateway sends a worker
      // is decided there, and a fake that skipped it would prove nothing
      // about the wire.
      const worker = await store.getWorker(input.workerId);
      const mcpServers = await mcpServersForLease(store, {
        opener: options.secretSealer,
        projectId: input.projectId,
        repositoryId: leased.task.repositoryId,
        taskId: leased.task.id,
        taskSubmittedBy: leased.task.submittedBy,
        workerId: input.workerId,
        workerUserId: worker?.userId ?? "",
        workerProtocolVersion: input.protocolVersion,
        leaseId: leased.lease.id,
      });
      return {
        ...(mcpServers === undefined ? {} : { mcpServers }),
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
    async previewStart() {
      return preview.url === undefined ? undefined : { ...preview };
    },
    async previewStatus() {
      return preview.url === undefined ? undefined : { ...preview };
    },
    async previewStop() {
      delete preview.url;
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
    // Faithful in the three respects the gateway acts on: a real worker row
    // (the lease's foreign key, and what ownership is checked against), one
    // row per person per editor, and `claimableBy` so a take cannot reach
    // another person's queue. Everything past that — admission, integration,
    // canonical — is `apps/cli/src/editor-work.test.ts`, against real Git.
    editorWork: {
      async take(input) {
        const existing = (
          await store.listWorkers({ organizationId: input.organizationId })
        ).find(
          (worker) =>
            worker.userId === input.actorId && worker.name === input.label,
        );
        const worker =
          existing ??
          (await store.registerWorker({
            userId: input.actorId,
            organizationId: input.organizationId,
            name: input.label,
            adapters: [input.vendor],
            version: "editor",
          }));
        for (const repositoryId of input.repositoryIds) {
          const leased = await store.leaseNextTask({
            workerId: worker.id,
            projectId: input.projectId,
            repositoryId,
            baseRevision: "a".repeat(40),
            ttlMs: 30 * 60 * 1000,
            claimableBy: input.actorId,
            kinds: ["task"],
          });
          if (leased === undefined) {
            continue;
          }
          return {
            leaseId: leased.lease.id,
            taskId: leased.task.id,
            objective: leased.task.objective,
            repositoryId: leased.task.repositoryId,
            branch: "main",
            baseRevision: leased.lease.baseRevision,
            baseVersion: 1,
            expiresAt: leased.lease.expiresAt,
            validationCommands: [],
          };
        }
        return undefined;
      },
      async report(input) {
        const settled = await store.finishWorkLease(
          input.leaseId,
          input.status === "completed"
            ? "completed"
            : input.status === "failed"
              ? "failed"
              : "released",
          new Date().toISOString(),
          input.detail,
        );
        return settled
          ? { outcome: "accepted" }
          : { outcome: "lease_lost", reason: "the hold had already gone" };
      },
      async extend(input) {
        const lease = await store.getWorkLease(input.leaseId);
        if (lease === undefined || lease.status !== "active") {
          return undefined;
        }
        const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
        await store.heartbeatWorkLease(
          input.leaseId,
          new Date().toISOString(),
          expiresAt,
        );
        return expiresAt;
      },
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
    ...(options.mcpDial === undefined ? {} : { mcpDial: options.mcpDial }),
    bootstrapToken: BOOTSTRAP_TOKEN,
    ...(options.rateLimitPerMinute === undefined
      ? {}
      : { rateLimitPerMinute: options.rateLimitPerMinute }),
    ...(options.mcpRateLimitPerMinute === undefined
      ? {}
      : { mcpRateLimitPerMinute: options.mcpRateLimitPerMinute }),
    chatterFilter: {
      readsAsChatter: async (text: string) => localChatter(text),
      // The mirror the local-agents path reads. Anything the stub does not
      // call conversation is work here, which is what makes the free verdict
      // testable without standing up an embedding model.
      readsAsWork: async (text: string) =>
        localWork === undefined ? !localChatter(text) : localWork(text),
      classify: async (text: string) => ({
        chatter: localChatter(text),
        work: localWork === undefined ? !localChatter(text) : localWork(text),
        lean: 0.5,
      }),
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
    ...(options.stalledTaskMs === undefined
      ? {}
      : { stalledTaskMs: options.stalledTaskMs }),
    ...(options.auditRetentionDays === undefined
      ? {}
      : { auditRetentionDays: options.auditRetentionDays }),
    ...(options.auditRetentionSweepIntervalMs === undefined
      ? {}
      : {
          auditRetentionSweepIntervalMs:
            options.auditRetentionSweepIntervalMs,
        }),
    ...(options.planHoldTtlMs === undefined
      ? {}
      : { planHoldTtlMs: options.planHoldTtlMs }),
    ...(options.secretSealer === undefined
      ? {}
      : { secretSealer: options.secretSealer }),
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
    preview,
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
    setLocalWork: (reads: (text: string) => boolean) => {
      localWork = reads;
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
    pauseCalls,
    resumeCalls,
    canonicalDiff,
    canonicalState,
    runFailure,
  };
}

export async function bootstrap(client: TestClient): Promise<any> {
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

export function registrationCode(message: MailMessage | undefined): string {
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
export async function registerAccount(
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
export async function invitableRepository(
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
export async function joinAllConnectedAgents(
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
export function inviteBody(
  email: string,
  role: string,
  repositoryId: string,
): Record<string, unknown> {
  return { email, role, repositoryId, projectId: DEFAULT_PROJECT_ID };
}

export function decodeTextFrames(buffer: Buffer): string[] {
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

export function decodeCloseCode(buffer: Buffer): number | undefined {
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

export async function bareRequest(
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
export async function bearer(
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

export async function workerRuntime(t: TestContext) {
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

export async function joinRepository(
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

export async function addColleague(
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

export function agentSpeech(messages: unknown[]): any[] {
  return (messages as any[])
    .flatMap((message) => [message, ...(message.replies ?? [])])
    .filter((message) => message.kind === "agent");
}

/**
 * Posts an unaddressed request and lets the no-mention route dispatch it.
 */
export async function autoClaim(
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

export function withLocalAgentsOnly(t: { after: (fn: () => void) => void }): void {
  const previous = process.env["COORD_LOCAL_AGENTS_ONLY"];
  process.env["COORD_LOCAL_AGENTS_ONLY"] = "1";
  t.after(() => {
    if (previous === undefined) {
      delete process.env["COORD_LOCAL_AGENTS_ONLY"];
    } else {
      process.env["COORD_LOCAL_AGENTS_ONLY"] = previous;
    }
  });
}

/**
 * The half of the flag that must keep working.
 *
 * Refusing questions was tried and reverted, and this test is why it should
 * stay reverted. Answering happens on the control plane and the worker
 * protocol has no verb for it — `register`, `leases`, and the lease's own
 * sub-routes, and nothing else — so refusing a question does not move it to
 * a desktop, it deletes the feature. The flag exists to relocate spend, not
 * to remove the product.
 */
export async function loginAs(
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

export async function startBareGateway(
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

/**
 * A preview that renders, rather than a preview that merely answers.
 *
 * Reported from a real press of play: the app started, the link appeared, and
 * opening it produced a white rectangle. Nothing was broken in the app — the
 * proxy was handing back the dashboard's own security policy and the app's
 * own root-absolute asset paths, so every `/assets/*.js` the document asked
 * for went to the control plane instead of to the app, and the inline
 * bootstrap script that would have reported it was blocked by a CSP written
 * about a different application.
 */

/** A stand-in dev server, answering the way a bundled app's really does. */
export async function fakePreview(
  t: TestContext,
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void,
): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Unreferenced so a socket the proxy's keep-alive agent is still holding
  // cannot keep this test file's process alive after the assertions are done.
  server.unref();
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The fake preview did not bind a port");
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

export async function roomWithTwoAgents(
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

export async function repositoryWithAuditor(
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

export function withEnvironment(
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

export function recordingMailer(): { sent: MailMessage[]; mailer: Mailer } {
  const sent: MailMessage[] = [];
  return {
    sent,
    mailer: async (message) => {
      sent.push(message);
    },
  };
}

export function resetLink(message: MailMessage | undefined): string {
  const match = /\/app#reset\/(\S+)/u.exec(message?.text ?? "");
  return match?.[1] ?? "";
}

export async function upgradeEvents(
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

export async function mcpRuntime(t: TestContext, scopes: string[] = ["view", "submit_task"]) {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "payments");
  runtime.chatConnections.set(bootstrapped.user.id, [{ provider: "anthropic" }]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const created = await owner.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "editor", scopes },
  });
  assert.equal(created.status, 201);
  return {
    runtime,
    owner,
    user: bootstrapped.user,
    repositoryId,
    token: created.data.token as string,
  };
}

/** One JSON-RPC message over the MCP route, cookie-less like a real client. */
export async function rpc(
  origin: string,
  token: string,
  message: Record<string, unknown>,
) {
  return await bearer(origin, "/api/v1/mcp", token, {
    method: "POST",
    body: message,
  });
}

export async function seedTaskFor(
  runtime: Awaited<ReturnType<typeof startRuntime>>,
  repositoryId: string,
  userId: string,
  objective = "raise the retry ceiling",
) {
  return await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective,
    agentId: "anthropic",
    validationCommands: [],
    submittedBy: userId,
  });
}

export async function work(
  origin: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
  id = 1,
) {
  const answer = await rpc(origin, token, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return {
    status: answer.status,
    isError: answer.data.result?.isError as true | undefined,
    text: String(answer.data.result?.content?.[0]?.text ?? ""),
    raw: answer,
  };
}

export function withMcpServersEnabled(
  t: { after: (fn: () => void) => void },
  enabled = true,
): void {
  const previous = process.env["COORD_MCP_ENABLED"];
  if (enabled) {
    process.env["COORD_MCP_ENABLED"] = "1";
  } else {
    delete process.env["COORD_MCP_ENABLED"];
  }
  t.after(() => {
    if (previous === undefined) {
      delete process.env["COORD_MCP_ENABLED"];
    } else {
      process.env["COORD_MCP_ENABLED"] = previous;
    }
  });
}

export const MCP_TEST_SECRET = "Bearer lin_api_the_plaintext_nobody_should_see";

/** An HTTP server with one secret header, the way a settings screen posts it. */
export function mcpHttpServerBody(
  name = "linear",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    values: { "X-Team": "platform" },
    secrets: { Authorization: MCP_TEST_SECRET },
    ...overrides,
  };
}

/**
 * The project's approved servers, re-offered to an editor as Kumi's own tools.
 *
 * The module's own behaviour — namespacing, the cache, what a broken reply
 * costs — is in `mcp-proxy.test.ts`. What only this file can show is the
 * wiring: which servers qualify, whose secrets travel with the call, and
 * whether the key ever reaches the editor.
 */
export async function proxyRuntime(t: TestContext) {
  withMcpServersEnabled(t);
  const dialled: Array<{ url: string; headers: Record<string, string>; body: unknown }> =
    [];
  const runtime = await startRuntime(t, {
    secretSealer: createSecretSealer(randomBytes(32)),
    mcpDial: async (input) => {
      dialled.push({
        url: input.url,
        headers: { ...input.headers },
        body: input.body,
      });
      const method = (input.body as { method?: string }).method;
      return method === "tools/list"
        ? {
            jsonrpc: "2.0",
            id: 1,
            result: {
              tools: [
                {
                  name: "list_issues",
                  description: "Lists open issues",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          }
        : {
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: "two issues" }] },
          };
    },
  });
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "payments");
  const created = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
    { method: "POST", body: mcpHttpServerBody() },
  );
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const token = await owner.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "editor", scopes: ["view", "submit_task"] },
  });
  return {
    runtime,
    owner,
    repositoryId,
    dialled,
    serverId: created.data.server.id as string,
    token: token.data.token as string,
  };
}

export async function listedTools(origin: string, token: string, id = 90) {
  const listed = await rpc(origin, token, {
    jsonrpc: "2.0",
    id,
    method: "tools/list",
  });
  return (listed.data.result.tools as Array<{ name: string }>).map(
    (tool) => tool.name,
  );
}
