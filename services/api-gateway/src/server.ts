import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

import type {
  CoordinationStore,
  Organization,
  OrganizationRole,
  ProjectRecord,
  WorkLease,
  WorkerRecord,
  StoredRepository,
  SubmittedTask,
  SubmittedTaskStatus,
} from "@coord/persistence";
import {
  assertProjectPolicy,
  createId,
  projectBudgets,
  type ApprovalStatus,
} from "@coord/shared-types";

import {
  AuthService,
  AuthenticationError,
  hashPassword,
  hashSecret,
  parseBearer,
  secretMatches,
  type AuthenticatedPrincipal,
} from "./auth.js";
import {
  authorizeOrganization,
  authorizeProject,
  authorizeRepository,
  canAssignRole,
  ALL_PERMISSIONS,
  assertTokenScope,
  isPermission,
  permissionsForRole,
} from "./authorization.js";
import { RateLimiter } from "./rate-limiter.js";
import { CollabWebSocketHub } from "./collab-websocket.js";
import { AuditWebSocketHub, type WebSocketAuthorization } from "./websocket.js";

const API_PREFIX = "/api/v1";
const MAX_JSON_BYTES = 1024 * 1024;
/** How long a worker holds a task before it must heartbeat again. */
const WORK_LEASE_TTL_MS = 5 * 60 * 1000;
/** A week: long enough to be useful, short enough to be a poor thing to leak. */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ROLES: readonly OrganizationRole[] = [
  "owner",
  "admin",
  "developer",
  "reviewer",
  "viewer",
];
const TASK_STATUSES: readonly SubmittedTaskStatus[] = [
  "submitted",
  "claimed",
  "integrated",
  "failed",
  "cancelled",
];
const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
];

export interface StaticAsset {
  body: Buffer | string;
  contentType: string;
  etag?: string;
}

/** Identifies one user's overlay workspace of one repository. */
export interface WorkspaceScopeInput {
  projectId: string;
  repositoryId: string;
  /** Always the authenticated principal's id, never caller-supplied. */
  userId: string;
}

/**
 * Human overlay workspaces: the dashboard's file editor and sandboxed
 * terminal. The implementations live with the web application; the gateway
 * only routes, authorizes, and validates shapes. Every operation receives
 * the authenticated user id, so an implementation can scope state per user
 * without trusting anything from the request body.
 */
export interface WorkspaceOperations {
  status(input: WorkspaceScopeInput): Promise<unknown>;
  open(input: WorkspaceScopeInput): Promise<unknown>;
  reset(input: WorkspaceScopeInput): Promise<unknown>;
  discard(input: WorkspaceScopeInput): Promise<void>;
  listFiles(input: WorkspaceScopeInput): Promise<unknown>;
  readFile(input: WorkspaceScopeInput & { path: string }): Promise<unknown>;
  writeFile(
    input: WorkspaceScopeInput & { path: string; content: string },
  ): Promise<unknown>;
  exec(input: WorkspaceScopeInput & { command: string }): Promise<unknown>;
  submit(input: WorkspaceScopeInput & { objective: string }): Promise<unknown>;
}

export interface ApiOperations {
  listAgents?(): Promise<
    Array<{
      id: string;
      adapter: "codex" | "claude" | "gemini" | "generic-cli";
      default: boolean;
    }>
  >;
  createRepository(input: {
    projectId: string;
    id: string;
    branch?: string;
    actorId: string;
  }): Promise<StoredRepository>;
  importGitHub(input: {
    projectId: string;
    repository: string;
    id?: string;
    branch?: string;
    token?: string;
    actorId: string;
  }): Promise<StoredRepository>;
  submitTask(input: {
    projectId: string;
    repositoryId: string;
    objective: string;
    agentId?: string;
    actorId: string;
  }): Promise<SubmittedTask>;
  runRepository(input: {
    projectId: string;
    repositoryId: string;
    actorId: string;
  }): Promise<void>;
  /** Canonical branch history, newest first. */
  repositoryVersions?(input: {
    projectId: string;
    repositoryId: string;
    limit?: number;
  }): Promise<unknown>;
  /**
   * Reverts canonical to an earlier revision through the ordinary pipeline.
   * Never a raw reset: it is planned, conflict-checked, validated, and
   * promoted by compare-and-swap like any other change.
   */
  rollbackRepository?(input: {
    projectId: string;
    repositoryId: string;
    targetRevision: string;
    actorId: string;
    reason?: string;
  }): Promise<{ status: string; explanation: string }>;
  dockerStatus?(): Promise<{
    available: boolean;
    version?: string;
    explanation: string;
  }>;
  /**
   * Remote execution hooks. A deployment without workers omits these and the
   * worker endpoints report that they are unsupported.
   */
  /** Coordination metrics derived from the audit chain, project-scoped. */
  projectMetrics?(input: { projectId: string }): Promise<unknown>;
  leaseWork?(input: {
    workerId: string;
    projectId: string;
    actorId: string;
    repositoryId?: string;
  }): Promise<WorkAssignment | undefined>;
  leaseBundle?(leaseId: string): Promise<Buffer | undefined>;
  /**
   * Arbitrates a worker's plan before it executes. A deployment that omits
   * this cannot run plan-first workers, and the endpoint says so.
   */
  admitWorkPlan?(input: {
    leaseId: string;
    actorId: string;
    plan: unknown;
  }): Promise<
    | { outcome: "admitted"; admission: unknown }
    | { outcome: "rejected"; reason: string }
    | { outcome: "lease_lost"; reason: string }
  >;
  /**
   * Arbitrates a scope expansion an agent asked for mid-execution. A
   * deployment that omits this refuses the request rather than pretending to
   * decide it, which is what the worker did unconditionally before.
   */
  arbitrateScopeChange?(input: {
    leaseId: string;
    actorId: string;
    request: unknown;
  }): Promise<
    | { outcome: "decided"; decision: unknown }
    | { outcome: "rejected"; reason: string }
    | { outcome: "lease_lost"; reason: string }
  >;
  acceptWorkResult?(input: {
    leaseId: string;
    status: "completed" | "failed";
    actorId: string;
    plan: unknown;
    changeSet: unknown;
    detail?: string;
  }): Promise<unknown>;
  /** Dashboard overlay workspaces; absent on deployments without them. */
  workspace?: WorkspaceOperations;
  /** Direct provider chat (Anthropic/OpenAI/Google); absent when unsupported. */
  chatProviders?: ChatProviderOperations;
}

/**
 * Direct provider chat for the dashboard panel. The gateway only routes,
 * authenticates, and validates shapes; connections are stored per user by
 * the implementation and every operation receives the authenticated user id
 * plus whether they are a system administrator (the local-CLI connection is
 * restricted to administrators because it spends the host owner's account).
 */
export interface ChatProviderOperations {
  list(input: { userId: string; systemAdmin: boolean }): Promise<unknown>;
  /** Launches the provider's own browser sign-in flow on the host. */
  signIn(input: {
    systemAdmin: boolean;
    provider: string;
  }): Promise<unknown>;
  connect(input: {
    userId: string;
    systemAdmin: boolean;
    provider: string;
  }): Promise<unknown>;
  disconnect(input: { userId: string; provider: string }): Promise<void>;
  /** Model/effort choices the connected account actually reports. */
  options(input: { provider: string }): Promise<unknown>;
  /** Consumption the provider's own CLI publishes, when it publishes any. */
  usage(input: { provider: string }): Promise<unknown>;
  setSettings(input: {
    userId: string;
    provider: string;
    model?: string;
    effort?: string;
  }): Promise<unknown>;
  complete(input: {
    userId: string;
    systemAdmin: boolean;
    provider: string;
    messages: unknown;
    cliSessionId?: string;
  }): Promise<unknown>;
  /**
   * Same as {@link complete} but reports progress as the CLI produces it.
   * Each event is relayed to the browser the moment it arrives.
   */
  completeStream?(
    input: {
      userId: string;
      systemAdmin: boolean;
      provider: string;
      messages: unknown;
      cliSessionId?: string;
    },
    onEvent: (event: unknown) => void,
  ): Promise<unknown>;
}

/** Everything a worker needs to execute one task without further lookups. */
export interface WorkAssignment {
  lease: WorkLease;
  task: SubmittedTask;
  repository: { id: string; branch: string };
  canonicalVersion: {
    sequence: number;
    revision: string;
    branch: string;
    createdAt: string;
  };
  /** Fetch the workspace contents from here, then clone it. */
  bundleUrl: string;
  /** Branch to check out from the bundle. */
  bundleRef: string;
  heartbeatIntervalMs: number;
  /** Remote worker protocol version this control plane speaks. */
  protocolVersion: number;
  /** Submit the agent's plan here for admission before executing. */
  planUrl: string;
}

export interface ApiGatewayOptions {
  store: CoordinationStore;
  operations: ApiOperations;
  bootstrapToken: string;
  allowedOrigins?: readonly string[];
  secureCookies?: boolean;
  staticAssets?: ReadonlyMap<string, StaticAsset>;
  requestBodyLimit?: number;
  rateLimitPerMinute?: number;
  authRateLimitPerMinute?: number;
  /** Event poll cadence; exposed for deterministic embedded runtimes/tests. */
  webSocketPollIntervalMs?: number;
  /** How often open event channels re-check account and membership state. */
  webSocketReauthorizeIntervalMs?: number;
  /**
   * Cadence of the collaboration hub's sweep: reauthorization, in-flight agent
   * activity, and flushing idle rooms. Exposed for tests.
   */
  collabTickIntervalMs?: number;
}

interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  requestId: string;
  principal?: AuthenticatedPrincipal;
}

class HttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * A colour, accepted only as `#rrggbb`.
 *
 * The value is written into a `style` attribute by the dashboard, so anything
 * looser than an exact hex triple is an injection point: `red;background:url()`
 * is a perfectly good CSS colour prefix. Validating at the edge means the
 * browser never has to sanitise it.
 */
function hexColorField(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/iu.test(value.trim())) {
    throw new HttpError(
      400,
      "invalid_request",
      `${field} must be a #rrggbb colour`,
    );
  }
  return value.trim().toLowerCase();
}

function stringField(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; optional?: boolean } = {},
): string | undefined {
  if (value === undefined && options.optional === true) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_request", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (
    trimmed.length < (options.min ?? 1) ||
    trimmed.length > (options.max ?? 10_000)
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      `${field} has an invalid length`,
    );
  }
  return trimmed;
}

function emailField(
  value: unknown,
  options: { optional?: boolean } = {},
): string | undefined {
  const email = stringField(value, "email", {
    max: 320,
    ...(options.optional === undefined
      ? {}
      : { optional: options.optional }),
  });
  if (
    email !== undefined &&
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)
  ) {
    throw new HttpError(400, "invalid_email", "email is not valid");
  }
  return email?.toLowerCase();
}

function slugField(
  value: unknown,
  options: { optional?: boolean } = {},
): string | undefined {
  const slug = stringField(value, "slug", {
    max: 80,
    ...(options.optional === undefined
      ? {}
      : { optional: options.optional }),
  });
  if (
    slug !== undefined &&
    !/^[a-z0-9][a-z0-9._-]*$/iu.test(slug)
  ) {
    throw new HttpError(
      400,
      "invalid_slug",
      "slug must start alphanumeric and contain only letters, digits, dot, dash, or underscore",
    );
  }
  return slug?.toLowerCase();
}

function booleanField(
  value: unknown,
  field: string,
  optional = true,
): boolean | undefined {
  if (value === undefined && optional) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_request", `${field} must be a boolean`);
  }
  return value;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "JSON body must be an object");
  }
  return value as Record<string, unknown>;
}

function matchPath(pathname: string, pattern: RegExp): string[] | undefined {
  const match = pattern.exec(pathname);
  if (match === null) {
    return undefined;
  }
  try {
    return match.slice(1).map((value) => decodeURIComponent(value));
  } catch {
    throw new HttpError(
      400,
      "invalid_path",
      "Request path contains invalid percent encoding",
    );
  }
}

/**
 * Drops rows for repositories the caller cannot reach.
 *
 * Per-repository access is only real if the lists respect it. Tasks, runs and
 * approvals all carry the repository they belong to, so one helper narrows
 * them; `undefined` means an organization role, which reaches everything.
 */
function narrowToRepositories<T extends { repositoryId?: string }>(
  rows: readonly T[],
  repositories: ReadonlySet<string> | undefined,
): T[] {
  if (repositories === undefined) {
    return [...rows];
  }
  return rows.filter(
    (row) => row.repositoryId !== undefined && repositories.has(row.repositoryId),
  );
}

/** An invitation without its secret, which is never stored recoverably. */
function publicInvitation(invitation: {
  id: string;
  organizationId: string;
  repositoryId?: string | undefined;
  email: string;
  role: OrganizationRole;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | undefined;
  acceptedBy: string | undefined;
  revokedAt: string | undefined;
}) {
  const status =
    invitation.revokedAt !== undefined
      ? "revoked"
      : invitation.acceptedAt !== undefined
        ? "accepted"
        : Date.parse(invitation.expiresAt) < Date.now()
          ? "expired"
          : "pending";
  return {
    id: invitation.id,
    organizationId: invitation.organizationId,
    repositoryId: invitation.repositoryId,
    email: invitation.email,
    role: invitation.role,
    invitedBy: invitation.invitedBy,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    status,
  };
}

function publicUser(user: {
  id: string;
  email: string;
  displayName: string;
  systemAdmin: boolean;
  disabled: boolean;
  createdAt: string;
  appearance?: { accent?: string; agentColor?: string };
}): Omit<typeof user, "passwordDigest"> {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    systemAdmin: user.systemAdmin,
    disabled: user.disabled,
    createdAt: user.createdAt,
    // Deliberately public within the organization: an agent colour only
    // identifies its owner if the people working alongside them can read it.
    ...(user.appearance === undefined ? {} : { appearance: user.appearance }),
  };
}

function safeEqual(left: string, right: string): boolean {
  const first = createHash("sha256").update(left).digest();
  const second = createHash("sha256").update(right).digest();
  return timingSafeEqual(first, second);
}

export class ApiGateway {
  public readonly server: Server;
  public readonly webSockets: AuditWebSocketHub;
  public readonly collaboration: CollabWebSocketHub;
  private readonly auth: AuthService;
  private readonly limiter: RateLimiter;
  private readonly authLimiter: RateLimiter;
  private readonly activeRuns = new Set<string>();
  private readonly bodyLimit: number;
  private readonly allowedOrigins: ReadonlySet<string>;
  private bootstrapInProgress = false;

  public constructor(private readonly options: ApiGatewayOptions) {
    if (options.bootstrapToken.trim().length < 24) {
      throw new Error("Bootstrap token must contain at least 24 characters");
    }
    this.bodyLimit = options.requestBodyLimit ?? MAX_JSON_BYTES;
    if (!Number.isSafeInteger(this.bodyLimit) || this.bodyLimit < 1) {
      throw new RangeError("Request body limit must be a positive integer");
    }
    this.allowedOrigins = new Set(
      (options.allowedOrigins ?? []).map((value) => {
        const parsed = new URL(value);
        if (
          !["http:", "https:"].includes(parsed.protocol) ||
          parsed.username.length > 0 ||
          parsed.password.length > 0 ||
          parsed.pathname !== "/" ||
          parsed.search.length > 0 ||
          parsed.hash.length > 0
        ) {
          throw new Error(`Allowed origin must be a credential-free HTTP origin: ${value}`);
        }
        return parsed.origin;
      }),
    );
    this.auth = new AuthService(options.store, {
      secureCookies: options.secureCookies ?? false,
    });
    this.limiter = new RateLimiter({
      capacity: options.rateLimitPerMinute ?? 240,
    });
    this.authLimiter = new RateLimiter({
      capacity: options.authRateLimitPerMinute ?? 10,
    });
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    const authorizeSocket = async (
      request: IncomingMessage,
      projectId: string,
      permission: "view" | "submit_task",
    ): Promise<WebSocketAuthorization> => {
      this.assertOrigin(request);
      const principal = await this.auth.authenticate(request.headers.cookie);
      const { project } = await authorizeProject(
        this.options.store,
        principal,
        projectId,
        permission,
      );
      return { principal, project };
    };
    const reauthorizeSocket = async (
      authorization: WebSocketAuthorization,
      permission: "view" | "submit_task",
    ): Promise<WebSocketAuthorization> => {
      const principal = await this.auth.refresh(authorization.principal);
      const { project } = await authorizeProject(
        this.options.store,
        principal,
        authorization.project.id,
        permission,
      );
      return { principal, project };
    };
    this.webSockets = new AuditWebSocketHub(options.store, {
      ...(options.webSocketPollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: options.webSocketPollIntervalMs }),
      ...(options.webSocketReauthorizeIntervalMs === undefined
        ? {}
        : {
            reauthorizeIntervalMs:
              options.webSocketReauthorizeIntervalMs,
          }),
      authorize: async (request, projectId) =>
        await authorizeSocket(request, projectId, "view"),
      reauthorize: async (authorization) =>
        await reauthorizeSocket(authorization, "view"),
    });
    // Live collaborative editing. Editing over the socket demands exactly the
    // permission the HTTP editor routes demand, `submit_task`, so opening a
    // second transport cannot widen what a principal may do.
    this.collaboration = new CollabWebSocketHub(options.store, {
      ...(options.collabTickIntervalMs === undefined
        ? {}
        : { tickIntervalMs: options.collabTickIntervalMs }),
      ...(options.webSocketReauthorizeIntervalMs === undefined
        ? {}
        : { reauthorizeIntervalMs: options.webSocketReauthorizeIntervalMs }),
      workspace: options.operations.workspace,
      authorize: async (request, projectId) =>
        await authorizeSocket(request, projectId, "submit_task"),
      reauthorize: async (authorization) =>
        await reauthorizeSocket(authorization, "submit_task"),
    });
    // One `upgrade` listener routes to both hubs: Node delivers every upgrade
    // to every listener, so a hub that rejected unknown paths on its own would
    // tear down the other hub's freshly negotiated socket.
    this.server.on("upgrade", (request, socket, head) => {
      void this.routeUpgrade(request, socket, head).catch(() => {
        if (!socket.destroyed) {
          socket.destroy();
        }
      });
    });
    this.webSockets.startPolling();
    this.collaboration.start();
  }

  private async routeUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    try {
      if (await this.collaboration.tryUpgrade(request, socket, head)) {
        return;
      }
      if (await this.webSockets.tryUpgrade(request, socket, head)) {
        return;
      }
      if (!socket.destroyed) {
        socket.end(
          "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
      }
    } catch {
      if (!socket.destroyed) {
        socket.end(
          "HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
      }
    }
  }

  public async close(): Promise<void> {
    this.webSockets.close();
    this.collaboration.close();
    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestId =
      typeof request.headers["x-request-id"] === "string" &&
      /^[A-Za-z0-9._-]{1,128}$/u.test(request.headers["x-request-id"])
        ? request.headers["x-request-id"]
        : randomUUID();
    this.securityHeaders(response, requestId);
    let url: URL;
    try {
      // Routing needs only the origin-form path. Never parse an untrusted Host
      // header as a URL base: malformed authority syntax must not escape the
      // request error boundary or trigger an unhandled rejection.
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      this.sendError(
        response,
        requestId,
        new HttpError(400, "invalid_url", "Request URL is invalid"),
      );
      return;
    }
    const context: RequestContext = {
      request,
      response,
      url,
      requestId,
    };

    try {
      const ip = this.remoteAddress(request);
      const authRoute = [
        `${API_PREFIX}/auth/login`,
        `${API_PREFIX}/auth/bootstrap`,
      ].includes(url.pathname);
      const rate = (authRoute ? this.authLimiter : this.limiter).consume(
        `${ip}:${authRoute ? "auth" : "api"}`,
      );
      response.setHeader("RateLimit-Limit", String(rate.limit));
      response.setHeader("RateLimit-Remaining", String(rate.remaining));
      response.setHeader(
        "RateLimit-Reset",
        String(Math.ceil(rate.resetAt / 1000)),
      );
      if (!rate.allowed) {
        throw new HttpError(429, "rate_limited", "Too many requests");
      }

      if (!url.pathname.startsWith(API_PREFIX)) {
        await this.serveStatic(context);
        return;
      }
      this.assertOrigin(request);
      this.applyCors(request, response);
      if (request.method === "OPTIONS") {
        response.setHeader(
          "Access-Control-Allow-Methods",
          "GET, HEAD, POST, PATCH, DELETE, OPTIONS",
        );
        response.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, X-CSRF-Token, X-Request-Id",
        );
        response.setHeader("Access-Control-Max-Age", "600");
        response.writeHead(204).end();
        return;
      }
      // Looking at an invitation, and accepting one, must work before the
      // recipient has an account — that is the entire point of an invitation.
      // Both carry their own secret, so neither is unauthenticated in the
      // sense that matters.
      const invitationPath = /^\/api\/v1\/invitations\/[^/]+(\/accept)?$/u.test(
        url.pathname,
      );
      const isPublic =
        (request.method === "GET" && url.pathname === `${API_PREFIX}/health`) ||
        (request.method === "GET" && invitationPath) ||
        (request.method === "POST" &&
          [
            `${API_PREFIX}/auth/login`,
            `${API_PREFIX}/auth/bootstrap`,
          ].includes(url.pathname)) ||
        (request.method === "POST" &&
          url.pathname.endsWith("/accept") &&
          invitationPath);
      if (!isPublic) {
        const bearer = parseBearer(
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
        );
        if (bearer !== undefined) {
          // Headless client. No CSRF check: a browser never attaches a bearer
          // token on its own, so there is no cross-site request to forge.
          context.principal = await this.auth.authenticateToken(
            bearer,
            this.remoteAddress(request),
          );
        } else {
          context.principal = await this.auth.authenticate(
            request.headers.cookie,
          );
          if (!["GET", "HEAD", "OPTIONS"].includes(request.method ?? "")) {
            await this.auth.verifyCsrf(
              context.principal,
              request.headers.cookie,
              typeof request.headers["x-csrf-token"] === "string"
                ? request.headers["x-csrf-token"]
                : undefined,
            );
          }
        }
      }
      await this.route(context);
    } catch (error) {
      this.sendError(response, requestId, error);
    }
  }

  private async route(context: RequestContext): Promise<void> {
    const { request, response, url } = context;
    const method = request.method ?? "GET";
    const path = url.pathname;

    if (method === "GET" && path === `${API_PREFIX}/health`) {
      let docker:
        | { available: boolean; version?: string; explanation: string }
        | undefined;
      try {
        docker = await this.options.operations.dockerStatus?.();
      } catch (error) {
        docker = {
          available: false,
          explanation: error instanceof Error ? error.message : String(error),
        };
      }
      this.sendJson(response, 200, {
        status: "ok",
        database: "ready",
        setupRequired: (await this.options.store.countUsers()) === 0,
        webSocketConnections: this.webSockets.connections,
        ...(docker === undefined ? {} : { docker }),
        time: new Date().toISOString(),
      });
      return;
    }

    if (method === "POST" && path === `${API_PREFIX}/auth/bootstrap`) {
      const token =
        typeof request.headers["x-bootstrap-token"] === "string"
          ? request.headers["x-bootstrap-token"]
          : "";
      if (!safeEqual(token, this.options.bootstrapToken)) {
        throw new HttpError(403, "invalid_bootstrap_token", "Bootstrap token is invalid");
      }
      const body = objectBody(await this.readJson(request));
      if (this.bootstrapInProgress) {
        throw new HttpError(
          409,
          "bootstrap_in_progress",
          "First-run setup is already in progress",
        );
      }
      this.bootstrapInProgress = true;
      let user;
      try {
        user = await this.auth.bootstrap({
          email: emailField(body["email"]) ?? "",
          displayName:
            stringField(body["displayName"], "displayName", { max: 120 }) ?? "",
          password:
            stringField(body["password"], "password", { max: 256 }) ?? "",
          ...(body["organizationName"] === undefined
            ? {}
            : {
                organizationName:
                  stringField(body["organizationName"], "organizationName", {
                    max: 120,
                  }) ?? "",
              }),
        });
      } finally {
        this.bootstrapInProgress = false;
      }
      const issued = await this.auth.issueSession(
        user,
        this.remoteAddress(request),
        request.headers["user-agent"] ?? "",
      );
      response.setHeader("Set-Cookie", issued.cookies);
      await this.options.store.appendAudit(undefined, {
        type: "user_authenticated",
        data: { userId: user.id, bootstrap: true },
      });
      this.sendJson(response, 201, {
        user: issued.principal.user,
        memberships: issued.principal.memberships,
        csrfToken: issued.csrfToken,
      });
      return;
    }

    if (method === "POST" && path === `${API_PREFIX}/auth/login`) {
      const body = objectBody(await this.readJson(request));
      const issued = await this.auth.login({
        email: emailField(body["email"]) ?? "",
        password: stringField(body["password"], "password", { max: 256 }) ?? "",
        ipAddress: this.remoteAddress(request),
        userAgent: request.headers["user-agent"] ?? "",
      });
      response.setHeader("Set-Cookie", issued.cookies);
      await this.options.store.appendAudit(undefined, {
        type: "user_authenticated",
        data: { userId: issued.principal.user.id, bootstrap: false },
      });
      this.sendJson(response, 200, {
        user: issued.principal.user,
        memberships: issued.principal.memberships,
        csrfToken: issued.csrfToken,
      });
      return;
    }

    // ---- Accepting an invitation ------------------------------------------
    // Reachable without a session: the recipient may have no account yet. The
    // link's own secret is the credential, so this is not an open endpoint.
    // Two patterns rather than one with an optional group: matchPath decodes
    // every group, so an absent group comes back as the string "undefined"
    // rather than as undefined.
    const inviteReadMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/invitations/([^/]+)$`, "u"),
    );
    const inviteAcceptMatch =
      inviteReadMatch === undefined
        ? matchPath(
            path,
            new RegExp(`^${API_PREFIX}/invitations/([^/]+)/accept$`, "u"),
          )
        : undefined;
    const inviteTokenMatch = inviteReadMatch ?? inviteAcceptMatch;
    if (inviteTokenMatch !== undefined) {
      const token = inviteTokenMatch[0] ?? "";
      const action = inviteAcceptMatch === undefined ? undefined : "accept";
      const separator = token.indexOf(".");
      const invitation =
        separator < 1
          ? undefined
          : await this.options.store.getInvitation(token.slice(0, separator));
      const secret = separator < 1 ? "" : token.slice(separator + 1);
      // One answer for every way a link can be wrong, so a probe cannot tell
      // "no such invitation" from "wrong secret".
      if (
        invitation === undefined ||
        !secretMatches(secret, invitation.secretHash)
      ) {
        throw new HttpError(404, "not_found", "This invitation is not valid");
      }
      const organization = await this.options.store.getOrganization(
        invitation.organizationId,
      );
      const state = publicInvitation(invitation).status;

      if (method === "GET" && action === undefined) {
        this.sendJson(response, 200, {
          invitation: {
            email: invitation.email,
            role: invitation.role,
            status: state,
            organizationName: organization?.name ?? "this organization",
            ...(invitation.repositoryId === undefined
              ? {}
              : { repositoryId: invitation.repositoryId }),
            expiresAt: invitation.expiresAt,
          },
        });
        return;
      }

      if (method === "POST" && action === "accept") {
        if (state !== "pending") {
          throw new HttpError(
            409,
            `invitation_${state}`,
            `This invitation has already been ${state}`,
          );
        }
        const body = objectBody(await this.readJson(request));
        let user = await this.options.store.getUserByEmail(invitation.email);
        if (user === undefined) {
          user = await this.options.store.createUser({
            email: invitation.email,
            displayName:
              stringField(body["displayName"], "displayName", { max: 120 }) ??
              "",
            passwordDigest: await hashPassword(
              stringField(body["password"], "password", { max: 256 }) ?? "",
            ),
          });
        } else {
          // The account already exists, so the invitation is not proof of who
          // is holding the link. Signing in is.
          const signedIn = await this.auth
            .authenticate(request.headers.cookie)
            .catch(() => undefined);
          if (signedIn?.user.id !== user.id) {
            throw new HttpError(
              409,
              "account_exists",
              "An account already uses that address. Sign in as " +
                `${invitation.email} and open this link again.`,
            );
          }
        }
        const claimed = await this.options.store.acceptInvitation(
          invitation.id,
          user.id,
          new Date().toISOString(),
        );
        if (!claimed) {
          throw new HttpError(
            409,
            "invitation_used",
            "This invitation has already been used",
          );
        }
        // A repository-scoped invitation grants that repository and nothing
        // else — deliberately no organization membership, because any
        // organization role reaches every repository and would undo the point
        // of scoping the invitation in the first place.
        if (invitation.repositoryId === undefined) {
          await this.options.store.saveMembership({
            organizationId: invitation.organizationId,
            userId: user.id,
            role: invitation.role,
          });
        } else {
          await this.options.store.saveRepositoryGrant({
            repositoryId: invitation.repositoryId,
            userId: user.id,
            role: invitation.role,
            grantedBy: invitation.invitedBy,
            createdAt: new Date().toISOString(),
          });
        }
        await this.options.store.appendAudit(undefined, {
          type: "membership_changed",
          data: {
            organizationId: invitation.organizationId,
            ...(invitation.repositoryId === undefined
              ? {}
              : { repositoryId: invitation.repositoryId }),
            userId: user.id,
            role: invitation.role,
            action: "accepted_invitation",
            actorId: user.id,
          },
        });
        const issued = await this.auth.issueSession(
          user,
          this.remoteAddress(request),
          request.headers["user-agent"] ?? "",
        );
        response.setHeader("Set-Cookie", issued.cookies);
        this.sendJson(response, 200, {
          user: issued.principal.user,
          memberships: issued.principal.memberships,
          csrfToken: issued.csrfToken,
        });
        return;
      }
      throw new HttpError(405, "method_not_allowed", "Unsupported method");
    }

    const principal = this.requirePrincipal(context);
    if (method === "POST" && path === `${API_PREFIX}/auth/logout`) {
      // A bearer token has no session to end; revoking it is a separate,
      // explicit action so a stray logout cannot disable a running worker.
      if (principal.sessionId === undefined) {
        throw new HttpError(
          400,
          "not_a_session",
          "Bearer tokens are revoked through /auth/tokens, not sign-out",
        );
      }
      response.setHeader(
        "Set-Cookie",
        await this.auth.logout(principal.sessionId),
      );
      await this.options.store.appendAudit(undefined, {
        type: "user_signed_out",
        data: { userId: principal.user.id },
      });
      this.sendJson(response, 200, { signedOut: true });
      return;
    }
    if (method === "GET" && path === `${API_PREFIX}/auth/me`) {
      this.sendJson(response, 200, principal);
      return;
    }

    // A person's own interface colours. Scoped to the authenticated principal
    // with no user id in the path, so there is no request shape that edits
    // somebody else's appearance.
    if (method === "PATCH" && path === `${API_PREFIX}/auth/me/appearance`) {
      const body = objectBody(await this.readJson(request));
      // A PATCH names only what it changes. The stored value is one object, so
      // an unnamed field has to be carried over: sending just `agentColor`
      // must not silently clear the accent the user picked a moment earlier.
      const current = await this.options.store.getUser(principal.user.id);
      const appearance = {
        ...current?.appearance,
        ...(body["accent"] === undefined
          ? {}
          : { accent: hexColorField(body["accent"], "accent") }),
        ...(body["agentColor"] === undefined
          ? {}
          : { agentColor: hexColorField(body["agentColor"], "agentColor") }),
      };
      const updated = await this.options.store.updateUser(principal.user.id, {
        appearance,
      });
      this.sendJson(response, 200, { user: publicUser(updated) });
      return;
    }


    // ---- Remote worker protocol -------------------------------------------
    // Everything that pulls work or returns changesets requires the run_task
    // scope, so a leaked read-only token cannot execute. The two fleet reads
    // are deliberately not in that set: seeing the organization's workers is a
    // `view`, and holding it to `run_task` would mean a reviewer could not see
    // the machines running the work they review.
    if (path === `${API_PREFIX}/workers/register` && method === "POST") {
      const body = objectBody(await this.readJson(request));
      const organizationId =
        stringField(body["organizationId"], "organizationId", { max: 120 }) ??
        "";
      // The tenant is decided here, once, and every later read of this worker
      // is filtered by it. `authorizeOrganization` is what enforces it: it
      // rejects a token bound elsewhere before consulting the caller's role,
      // so a credential confined to one organization cannot enrol a worker
      // into another even if its owner is a member of both.
      await authorizeOrganization(
        this.options.store,
        principal,
        organizationId,
        "run_task",
      );
      const adapters = body["adapters"];
      if (
        !Array.isArray(adapters) ||
        !adapters.every((entry): entry is string => typeof entry === "string")
      ) {
        throw new HttpError(
          400,
          "invalid_request",
          "adapters must be an array of strings",
        );
      }
      const worker = await this.options.store.registerWorker({
        userId: principal.user.id,
        organizationId,
        name: stringField(body["name"], "name", { max: 120 }) ?? "",
        adapters,
        version: stringField(body["version"], "version", { max: 40 }) ?? "0",
      });
      this.sendJson(response, 201, worker);
      return;
    }

    if (path === `${API_PREFIX}/agents/running` && method === "GET") {
      // Organization-wide, not project-scoped: an active lease is one agent
      // executing on some worker right now, and a fleet spans the projects it
      // serves. Counted from leases rather than from worker registrations,
      // because a registered worker is idle until it holds one.
      //
      // The organization is required rather than defaulted. These are counts,
      // but a platform-wide count still reports how busy other tenants are,
      // which is not this caller's to know.
      const { organizationId } = await this.authorizeFleet(principal, url);
      const { workers, active } = await this.organizationFleet(organizationId);
      const byWorker = new Map<string, number>();
      for (const lease of active) {
        byWorker.set(lease.workerId, (byWorker.get(lease.workerId) ?? 0) + 1);
      }
      this.sendJson(response, 200, {
        running: active.length,
        workers: workers.length,
        busyWorkers: byWorker.size,
      });
      return;
    }

    if (path === `${API_PREFIX}/workers` && method === "GET") {
      // The whole fleet the organization operates, not just the caller's own
      // workers. A team cannot run shared infrastructure it cannot see, and
      // the tenant boundary — not the registering user — is what makes that
      // safe: `authorizeFleet` requires membership of the organization being
      // asked about, and the store filters on the same id.
      const { organizationId } = await this.authorizeFleet(principal, url);
      const { workers, active } = await this.organizationFleet(organizationId);
      const leasesByWorker = new Map<string, typeof active>();
      for (const lease of active) {
        const bucket = leasesByWorker.get(lease.workerId) ?? [];
        bucket.push(lease);
        leasesByWorker.set(lease.workerId, bucket);
      }
      this.sendJson(response, 200, {
        workers: workers.map((worker) => ({
          ...worker,
          /** True for the caller's own workers, which only they may drive. */
          own: worker.userId === principal.user.id,
          activeLeases: (leasesByWorker.get(worker.id) ?? []).map((lease) => ({
            id: lease.id,
            taskId: lease.taskId,
            repositoryId: lease.repositoryId,
            projectId: lease.projectId,
            issuedAt: lease.issuedAt,
            expiresAt: lease.expiresAt,
          })),
        })),
      });
      return;
    }

    if (path === `${API_PREFIX}/workers/leases` && method === "POST") {
      assertTokenScope(principal, "run_task");
      const body = objectBody(await this.readJson(request));
      const workerId = stringField(body["workerId"], "workerId", { max: 120 }) ?? "";
      const worker = await this.options.store.getWorker(workerId);
      if (worker === undefined || worker.userId !== principal.user.id) {
        throw new HttpError(404, "not_found", "Worker was not found");
      }
      const projectId =
        stringField(body["projectId"], "projectId", { max: 120 }) ?? "";
      const { project } = await authorizeProject(
        this.options.store,
        principal,
        projectId,
        "run_task",
      );
      // Visibility widened to the organization; execution did not follow it
      // across one. A user who belongs to two organizations could otherwise
      // point a worker registered in one at work belonging to the other, and
      // the resulting workspace, bundle, and changeset would carry another
      // tenant's code on a machine that tenant never admitted to its fleet.
      if (worker.organizationId !== project.organizationId) {
        throw new HttpError(
          403,
          "worker_organization_mismatch",
          "This worker is registered to a different organization",
        );
      }

      const nowIso = new Date().toISOString();
      // Reclaim anything a dead worker was holding before handing out new work.
      await this.options.store.expireWorkLeases(nowIso);
      await this.options.store.touchWorker(workerId, nowIso);

      const repositoryId = stringField(body["repositoryId"], "repositoryId", {
        max: 200,
        optional: true,
      });
      const leaseOperation = this.options.operations.leaseWork;
      if (leaseOperation === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment does not support remote workers",
        );
      }
      const assignment = await leaseOperation({
        workerId,
        projectId,
        actorId: principal.user.id,
        ...(repositoryId === undefined ? {} : { repositoryId }),
      });
      if (assignment === undefined) {
        // 204 rather than an empty 200 so a polling worker can branch on the
        // status code without parsing a body.
        response.writeHead(204).end();
        return;
      }
      if (
        assignment.task.projectId !== projectId ||
        assignment.lease.projectId !== projectId
      ) {
        await this.options.store.finishWorkLease(
          assignment.lease.id,
          "released",
          new Date().toISOString(),
          "control-plane project mismatch",
        );
        throw new HttpError(
          500,
          "invalid_assignment",
          "Worker assignment escaped its authorized project",
        );
      }
      this.sendJson(response, 200, assignment);
      return;
    }

    const leaseMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/workers/leases/([^/]+)/(heartbeat|bundle|plan|scope|result|release)$`,
        "u",
      ),
    );
    if (leaseMatch !== undefined) {
      assertTokenScope(principal, "run_task");
      const leaseId = leaseMatch[0] ?? "";
      const action = leaseMatch[1] ?? "";
      const lease = await this.options.store.getWorkLease(leaseId);
      if (lease === undefined) {
        throw new HttpError(404, "not_found", "Lease was not found");
      }
      const owner = await this.options.store.getWorker(lease.workerId);
      if (owner === undefined || owner.userId !== principal.user.id) {
        throw new HttpError(404, "not_found", "Lease was not found");
      }
      if (lease.projectId === undefined) {
        throw new HttpError(
          409,
          "invalid_lease",
          "Lease has no project boundary and cannot be used remotely",
        );
      }
      await authorizeProject(
        this.options.store,
        principal,
        lease.projectId,
        "run_task",
      );

      if (action === "heartbeat" && method === "POST") {
        const now = new Date();
        // A heartbeat may carry the agent's running token total. Recording it
        // here rather than only at the end is what makes a token budget a cap
        // instead of a post-mortem: an overspending task is stopped while it
        // is still spending.
        const reported = await this.recordLeaseTokenUsage(
          request,
          lease,
          now.toISOString(),
        );

        // Cost control: a lease past the project's per-task runtime budget
        // is failed rather than extended. Failing (not releasing) is
        // deliberate — requeueing would re-run the same runaway task and
        // burn the budget again.
        if (lease.projectId !== undefined) {
          const project = await this.options.store.getProject(lease.projectId);
          const leaseBudgets = projectBudgets(project?.policy);
          const maxTaskRuntimeMs = leaseBudgets.maxTaskRuntimeMs;
          const runtimeMs =
            now.getTime() - new Date(lease.issuedAt).getTime();
          const maxTaskTokens = leaseBudgets.maxTaskTokens;
          if (maxTaskTokens !== undefined && reported > maxTaskTokens) {
            await this.failLeaseOnBudget(lease, now, {
              detail:
                `Task exceeded the project token budget of ${maxTaskTokens} tokens`,
              data: { tokensSpent: reported, maxTaskTokens },
            });
            throw new HttpError(
              409,
              "budget_exceeded",
              "This task exceeded the project's token budget; stop work",
            );
          }
          if (maxTaskRuntimeMs !== undefined && runtimeMs > maxTaskRuntimeMs) {
            const failed = await this.options.store.finishWorkLease(
              leaseId,
              "failed",
              now.toISOString(),
              `Task exceeded the project runtime budget of ${maxTaskRuntimeMs} ms`,
            );
            if (failed) {
              const task = (
                await this.options.store.listSubmittedTasks({
                  repositoryId: lease.repositoryId,
                })
              ).find((entry) => entry.id === lease.taskId);
              if (task?.status === "claimed") {
                await this.options.store.completeSubmittedTask(
                  task.id,
                  "failed",
                );
              }
              await this.options.store.appendAudit(undefined, {
                type: "task_failed",
                taskId: lease.taskId,
                data: {
                  projectId: lease.projectId,
                  repositoryId: lease.repositoryId,
                  workerId: lease.workerId,
                  leaseId,
                  stage: "budget_enforcement",
                  runtimeMs,
                  maxTaskRuntimeMs,
                },
              });
            }
            throw new HttpError(
              409,
              "budget_exceeded",
              "This task exceeded the project's runtime budget; stop work",
            );
          }
        }

        const extended = await this.options.store.heartbeatWorkLease(
          leaseId,
          now.toISOString(),
          new Date(now.getTime() + WORK_LEASE_TTL_MS).toISOString(),
        );
        if (extended === undefined) {
          await this.options.store.expireWorkLeases(now.toISOString());
          throw new HttpError(
            409,
            "lease_lost",
            "This lease is no longer active; stop work and re-lease",
          );
        }
        await this.options.store.touchWorker(lease.workerId, now.toISOString());
        this.sendJson(response, 200, extended);
        return;
      }

      if (action === "bundle" && method === "GET") {
        const bundleOperation = this.options.operations.leaseBundle;
        if (bundleOperation === undefined) {
          throw new HttpError(
            501,
            "not_supported",
            "This deployment cannot serve repository bundles",
          );
        }
        const bundle = await bundleOperation(leaseId);
        if (bundle === undefined) {
          throw new HttpError(
            409,
            "lease_lost",
            "This lease is no longer active; stop work and re-lease",
          );
        }
        response
          .writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": bundle.byteLength,
          })
          .end(bundle);
        return;
      }

      if (action === "plan" && method === "POST") {
        const planOperation = this.options.operations.admitWorkPlan;
        if (planOperation === undefined) {
          throw new HttpError(
            501,
            "not_supported",
            "This deployment cannot admit remote worker plans",
          );
        }
        const body = objectBody(await this.readJson(request));
        const outcome = await planOperation({
          leaseId,
          actorId: principal.user.id,
          plan: body["plan"],
        });
        if (outcome.outcome === "lease_lost") {
          throw new HttpError(409, "lease_lost", outcome.reason);
        }
        if (outcome.outcome === "rejected") {
          // The lease is already failed by now, so this is terminal for the
          // worker rather than something to retry with a corrected plan.
          throw new HttpError(400, "invalid_plan", outcome.reason);
        }
        this.sendJson(response, 200, { admission: outcome.admission });
        return;
      }

      if (action === "scope" && method === "POST") {
        const scopeOperation = this.options.operations.arbitrateScopeChange;
        if (scopeOperation === undefined) {
          throw new HttpError(
            501,
            "not_supported",
            "This deployment cannot arbitrate remote scope changes",
          );
        }
        const body = objectBody(await this.readJson(request));
        const outcome = await scopeOperation({
          leaseId,
          actorId: principal.user.id,
          request: body["request"],
        });
        if (outcome.outcome === "lease_lost") {
          throw new HttpError(409, "lease_lost", outcome.reason);
        }
        if (outcome.outcome === "rejected") {
          throw new HttpError(400, "invalid_scope_change", outcome.reason);
        }
        this.sendJson(response, 200, { decision: outcome.decision });
        return;
      }

      if (action === "release" && method === "POST") {
        const released = await this.options.store.finishWorkLease(
          leaseId,
          "released",
          new Date().toISOString(),
          "released by worker",
        );
        if (!released) {
          await this.options.store.expireWorkLeases(new Date().toISOString());
          throw new HttpError(
            409,
            "lease_lost",
            "This lease is no longer active; stop work and re-lease",
          );
        }
        this.sendJson(response, 200, { released: true });
        return;
      }

      if (action === "result" && method === "POST") {
        const body = objectBody(await this.readJson(request));
        // Final spend, recorded but not enforced: the tokens are already gone
        // by the time a result exists, and failing finished work over its bill
        // would waste the very thing the budget exists to protect. The cap is
        // enforced at heartbeat, while the spending is still happening.
        if (Array.isArray(body["tokenUsage"])) {
          await this.recordReportedTokenUsage(
            lease,
            body["tokenUsage"],
            new Date().toISOString(),
          );
        }
        const status = body["status"];
        if (status !== "completed" && status !== "failed") {
          throw new HttpError(
            400,
            "invalid_request",
            'status must be "completed" or "failed"',
          );
        }
        const detail = stringField(body["detail"], "detail", {
          max: 2000,
          optional: true,
        });
        const resultOperation = this.options.operations.acceptWorkResult;
        if (resultOperation === undefined) {
          throw new HttpError(
            501,
            "not_supported",
            "This deployment cannot accept remote worker results",
          );
        }
        const accepted = await resultOperation({
          leaseId,
          status,
          actorId: principal.user.id,
          plan: body["plan"],
          changeSet: body["changeSet"],
          ...(detail === undefined ? {} : { detail }),
        });
        this.sendJson(response, 200, accepted);
        return;
      }

      throw new HttpError(405, "method_not_allowed", "Unsupported lease action");
    }

    if (path === `${API_PREFIX}/auth/tokens` && method === "GET") {
      this.sendJson(response, 200, {
        tokens: await this.auth.listApiTokens(principal.user.id),
      });
      return;
    }

    if (path === `${API_PREFIX}/auth/tokens` && method === "POST") {
      // A token may only be minted from an interactive session. Allowing a
      // token to mint another would make revocation meaningless: a leaked
      // credential could silently refresh itself forever.
      if (principal.credential !== "session") {
        throw new HttpError(
          403,
          "session_required",
          "API tokens can only be created from a signed-in session",
        );
      }
      const body = objectBody(await this.readJson(request));
      const requested = body["scopes"];
      if (
        !Array.isArray(requested) ||
        !requested.every((entry): entry is string => typeof entry === "string")
      ) {
        throw new HttpError(400, "invalid_scopes", "scopes must be an array of strings");
      }
      for (const scope of requested) {
        if (!isPermission(scope)) {
          throw new HttpError(400, "invalid_scopes", `Unknown scope: ${scope}`);
        }
      }

      const organizationId = stringField(body["organizationId"], "organizationId", {
        max: 120,
        optional: true,
      });
      // Bound the grant by what the user can actually do, so a token can never
      // be a privilege escalation.
      const allowed = new Set<string>();
      if (principal.user.systemAdmin && organizationId === undefined) {
        for (const permission of ALL_PERMISSIONS) {
          allowed.add(permission);
        }
      } else if (organizationId !== undefined) {
        const { role } = await authorizeOrganization(
          this.options.store,
          principal,
          organizationId,
          "view",
        );
        for (const permission of permissionsForRole(role)) {
          allowed.add(permission);
        }
      } else {
        for (const membership of principal.memberships) {
          for (const permission of permissionsForRole(membership.role)) {
            allowed.add(permission);
          }
        }
      }
      const exceeded = requested.filter((scope) => !allowed.has(scope));
      if (exceeded.length > 0) {
        throw new HttpError(
          403,
          "scope_exceeds_role",
          `Your role does not grant: ${exceeded.join(", ")}`,
        );
      }

      const expiresInDays = body["expiresInDays"];
      if (
        expiresInDays !== undefined &&
        (typeof expiresInDays !== "number" || !Number.isSafeInteger(expiresInDays))
      ) {
        throw new HttpError(
          400,
          "invalid_expiry",
          "expiresInDays must be an integer",
        );
      }

      const user = await this.options.store.getUser(principal.user.id);
      if (user === undefined) {
        throw new HttpError(404, "not_found", "User was not found");
      }
      const issued = await this.auth.issueApiToken({
        user,
        name: stringField(body["name"], "name", { max: 120 }) ?? "",
        scopes: requested,
        ...(organizationId === undefined ? {} : { organizationId }),
        ...(expiresInDays === undefined ? {} : { expiresInDays }),
        ...(principal.sessionId === undefined
          ? {}
          : { createdBySession: principal.sessionId }),
      });
      await this.options.store.appendAudit(undefined, {
        type: "api_token_issued",
        data: {
          userId: principal.user.id,
          tokenId: issued.record.id,
          name: issued.record.name,
          scopes: issued.record.scopes,
          organizationId: issued.record.organizationId ?? null,
          expiresAt: issued.record.expiresAt ?? null,
        },
      });
      // The plaintext appears here and nowhere else, ever.
      this.sendJson(response, 201, { ...issued.record, token: issued.token });
      return;
    }

    if (method === "DELETE" && path.startsWith(`${API_PREFIX}/auth/tokens/`)) {
      const tokenId = decodeURIComponent(
        path.slice(`${API_PREFIX}/auth/tokens/`.length),
      );
      await this.auth.revokeApiToken(principal, tokenId, "revoked by owner");
      await this.options.store.appendAudit(undefined, {
        type: "api_token_revoked",
        data: { userId: principal.user.id, tokenId },
      });
      this.sendJson(response, 200, { revoked: true, tokenId });
      return;
    }

    if (method === "GET" && path === `${API_PREFIX}/organizations`) {
      this.sendJson(response, 200, {
        organizations: await this.reachableOrganizations(principal),
      });
      return;
    }
    if (method === "POST" && path === `${API_PREFIX}/organizations`) {
      assertTokenScope(principal, "manage_organization");
      const body = objectBody(await this.readJson(request));
      const slug = slugField(body["slug"]) ?? "";
      if (
        (await this.options.store.listOrganizations()).some(
          (organization) => organization.slug === slug,
        )
      ) {
        throw new HttpError(
          409,
          "slug_in_use",
          "Organization slug is already in use",
        );
      }
      const organization = await this.options.store.createOrganization({
        slug,
        name: stringField(body["name"], "name", { max: 120 }) ?? "",
      });
      await this.options.store.saveMembership({
        organizationId: organization.id,
        userId: principal.user.id,
        role: "owner",
      });
      await this.options.store.appendAudit(undefined, {
        type: "organization_changed",
        data: {
          organizationId: organization.id,
          action: "created",
          actorId: principal.user.id,
        },
      });
      this.sendJson(response, 201, { organization });
      return;
    }

    const organizationMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/organizations/([^/]+)$`, "u"),
    );
    if (organizationMatch !== undefined) {
      const organizationId = organizationMatch[0] ?? "";
      const permission = method === "GET" ? "view" : "manage_organization";
      const authorized = await authorizeOrganization(
        this.options.store,
        principal,
        organizationId,
        permission,
      );
      if (method === "GET") {
        this.sendJson(response, 200, authorized);
        return;
      }
      if (method === "PATCH") {
        const body = objectBody(await this.readJson(request));
        const name = stringField(body["name"], "name", {
          max: 120,
          optional: true,
        });
        const slug = slugField(body["slug"], { optional: true });
        if (
          slug !== undefined &&
          (await this.options.store.listOrganizations()).some(
            (organization) =>
              organization.id !== organizationId &&
              organization.slug === slug,
          )
        ) {
          throw new HttpError(
            409,
            "slug_in_use",
            "Organization slug is already in use",
          );
        }
        const organization = await this.options.store.updateOrganization(
          organizationId,
          {
            ...(name === undefined ? {} : { name }),
            ...(slug === undefined ? {} : { slug }),
          },
        );
        await this.options.store.appendAudit(undefined, {
          type: "organization_changed",
          data: {
            organizationId,
            action: "updated",
            actorId: principal.user.id,
          },
        });
        this.sendJson(response, 200, { organization });
        return;
      }
    }


    // ---- Invitations ------------------------------------------------------
    // Membership already required an account, and creating an account required
    // a system administrator, so an organization owner had no way to bring in
    // a colleague. An invitation closes that loop: it names an email and a
    // role, and creates the account at the moment it is accepted.
    const invitationsMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/organizations/([^/]+)/invitations$`, "u"),
    );
    if (invitationsMatch !== undefined) {
      const organizationId = invitationsMatch[0] ?? "";
      const authorized = await authorizeOrganization(
        this.options.store,
        principal,
        organizationId,
        "manage_members",
      );
      if (method === "GET") {
        this.sendJson(response, 200, {
          invitations: (
            await this.options.store.listInvitations(organizationId)
          ).map(publicInvitation),
        });
        return;
      }
      if (method === "POST") {
        const body = objectBody(await this.readJson(request));
        const email = emailField(body["email"]) ?? "";
        const role = stringField(body["role"], "role", { max: 20 }) as
          | OrganizationRole
          | undefined;
        if (role === undefined || !ROLES.includes(role)) {
          throw new HttpError(400, "invalid_role", "Role is invalid");
        }
        // The same ceiling as adding a member directly: an invitation must not
        // be a way to hand out a role you could not assign yourself.
        if (!canAssignRole(authorized.role, role)) {
          throw new HttpError(403, "forbidden", "You cannot assign that role");
        }
        // An invitation may name one repository, which is what it then
        // grants; without one it admits the person to the whole organization.
        const repositoryId = stringField(
          body["repositoryId"],
          "repositoryId",
          { max: 128, optional: true },
        );
        if (repositoryId !== undefined) {
          const owned = await this.options.store.listProjectRepositories(
            stringField(body["projectId"], "projectId", { max: 128 }) ?? "",
          );
          if (!owned.some((entry) => entry.id === repositoryId)) {
            throw new HttpError(
              404,
              "not_found",
              "Repository was not found in that project",
            );
          }
        }
        const existing = await this.options.store.getUserByEmail(email);
        if (existing !== undefined && repositoryId === undefined) {
          const memberships = await this.options.store.listMemberships(
            organizationId,
          );
          if (memberships.some((entry) => entry.userId === existing.id)) {
            throw new HttpError(
              409,
              "already_a_member",
              "That person is already in this organization",
            );
          }
        }
        const id = `inv_${randomBytes(9).toString("base64url")}`;
        const secret = randomBytes(32).toString("base64url");
        const now = new Date();
        const invitation = {
          id,
          organizationId,
          repositoryId,
          email,
          role,
          secretHash: hashSecret(secret),
          invitedBy: principal.user.id,
          createdAt: now.toISOString(),
          expiresAt: new Date(
            now.getTime() + INVITATION_TTL_MS,
          ).toISOString(),
          acceptedAt: undefined,
          acceptedBy: undefined,
          revokedAt: undefined,
        };
        await this.options.store.createInvitation(invitation);
        await this.options.store.appendAudit(undefined, {
          type: "membership_changed",
          data: {
            organizationId,
            email,
            role,
            action: "invited",
            actorId: principal.user.id,
          },
        });
        // The only time the secret exists in a response. It is not stored in
        // recoverable form, so a lost link is reissued rather than looked up.
        this.sendJson(response, 201, {
          invitation: publicInvitation(invitation),
          token: `${id}.${secret}`,
        });
        return;
      }
    }

    const invitationMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/organizations/([^/]+)/invitations/([^/]+)$`,
        "u",
      ),
    );
    if (invitationMatch !== undefined && method === "DELETE") {
      const [organizationId = "", invitationId = ""] = invitationMatch;
      await authorizeOrganization(
        this.options.store,
        principal,
        organizationId,
        "manage_members",
      );
      const found = await this.options.store.getInvitation(invitationId);
      if (found === undefined || found.organizationId !== organizationId) {
        throw new HttpError(404, "not_found", "Invitation was not found");
      }
      await this.options.store.revokeInvitation(
        invitationId,
        new Date().toISOString(),
      );
      this.sendJson(response, 200, { revoked: true });
      return;
    }

    const membersMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/organizations/([^/]+)/members$`, "u"),
    );
    if (membersMatch !== undefined) {
      const organizationId = membersMatch[0] ?? "";
      const authorized = await authorizeOrganization(
        this.options.store,
        principal,
        organizationId,
        method === "GET" ? "view" : "manage_members",
      );
      if (method === "GET") {
        const memberships = await this.options.store.listMemberships(
          organizationId,
        );
        const users = await Promise.all(
          memberships.map(
            async (membership) =>
              await this.options.store.getUser(membership.userId),
          ),
        );
        this.sendJson(response, 200, {
          members: memberships.map((membership, index) => ({
            ...membership,
            user:
              users[index] === undefined
                ? undefined
                : publicUser(users[index]),
          })),
        });
        return;
      }
      if (method === "POST") {
        const body = objectBody(await this.readJson(request));
        const role = stringField(body["role"], "role", { max: 20 }) as
          | OrganizationRole
          | undefined;
        if (role === undefined || !ROLES.includes(role)) {
          throw new HttpError(400, "invalid_role", "Role is invalid");
        }
        if (!canAssignRole(authorized.role, role)) {
          throw new HttpError(403, "forbidden", "You cannot assign that role");
        }
        const userId = stringField(body["userId"], "userId", {
          max: 128,
          optional: true,
        });
        const email = emailField(body["email"], { optional: true });
        const user =
          userId === undefined
            ? email === undefined
              ? undefined
              : await this.options.store.getUserByEmail(email)
            : await this.options.store.getUser(userId);
        if (user === undefined) {
          throw new HttpError(404, "user_not_found", "User was not found");
        }
        const membership = await this.options.store.saveMembership({
          organizationId,
          userId: user.id,
          role,
        });
        await this.options.store.appendAudit(undefined, {
          type: "membership_changed",
          data: {
            organizationId,
            userId: user.id,
            role,
            action: "saved",
            actorId: principal.user.id,
          },
        });
        this.sendJson(response, 201, { membership, user: publicUser(user) });
        return;
      }
    }

    const memberMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/organizations/([^/]+)/members/([^/]+)$`,
        "u",
      ),
    );
    if (memberMatch !== undefined) {
      const [organizationId = "", userId = ""] = memberMatch;
      const authorized = await authorizeOrganization(
        this.options.store,
        principal,
        organizationId,
        "manage_members",
      );
      const current = await this.options.store.getMembership(
        organizationId,
        userId,
      );
      if (current === undefined) {
        throw new HttpError(404, "not_found", "Membership was not found");
      }
      if (method === "PATCH") {
        const body = objectBody(await this.readJson(request));
        const role = stringField(body["role"], "role", { max: 20 }) as
          | OrganizationRole
          | undefined;
        if (role === undefined || !ROLES.includes(role)) {
          throw new HttpError(400, "invalid_role", "Role is invalid");
        }
        if (!canAssignRole(authorized.role, role)) {
          throw new HttpError(403, "forbidden", "You cannot assign that role");
        }
        if (current.role === "owner" && role !== "owner") {
          const owners = (
            await this.options.store.listMemberships(organizationId)
          ).filter((membership) => membership.role === "owner");
          if (owners.length <= 1) {
            throw new HttpError(
              409,
              "last_owner",
              "The last organization owner cannot be demoted",
            );
          }
        }
        const membership = await this.options.store.saveMembership({
          organizationId,
          userId,
          role,
        });
        await this.options.store.appendAudit(undefined, {
          type: "membership_changed",
          data: {
            organizationId,
            userId,
            role,
            action: "updated",
            actorId: principal.user.id,
          },
        });
        this.sendJson(response, 200, { membership });
        return;
      }
      if (method === "DELETE") {
        const owners = (
          await this.options.store.listMemberships(organizationId)
        ).filter((membership) => membership.role === "owner");
        if (current.role === "owner" && owners.length <= 1) {
          throw new HttpError(
            409,
            "last_owner",
            "The last organization owner cannot be removed",
          );
        }
        await this.options.store.removeMembership(organizationId, userId);
        await this.options.store.appendAudit(undefined, {
          type: "membership_changed",
          data: {
            organizationId,
            userId,
            action: "removed",
            actorId: principal.user.id,
          },
        });
        this.sendJson(response, 200, { removed: true });
        return;
      }
    }

    const projectsMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/organizations/([^/]+)/projects$`, "u"),
    );
    if (projectsMatch !== undefined) {
      const organizationId = projectsMatch[0] ?? "";
      // Reading the project list is the one place a grant alone has to be
      // enough: somebody invited to a single repository has no organization
      // role, and without this they sign in successfully and can see nothing.
      // Everything beyond reading still requires a real organization role.
      let hasOrganizationRole = true;
      if (method === "GET") {
        try {
          await authorizeOrganization(
            this.options.store,
            principal,
            organizationId,
            "view",
          );
        } catch (error) {
          hasOrganizationRole = false;
          const grants = await this.options.store.listGrantsForUser(
            principal.user.id,
          );
          if (grants.length === 0) {
            throw error;
          }
        }
      } else {
        await authorizeOrganization(
          this.options.store,
          principal,
          organizationId,
          "manage_project",
        );
      }
      if (method === "GET") {
        const projects = await this.reachableProjects(
          principal,
          organizationId,
          hasOrganizationRole,
        );
        if (!hasOrganizationRole && projects.length === 0) {
          throw new AuthenticationError(
            "You do not have permission to perform this action",
            403,
            "forbidden",
          );
        }
        this.sendJson(response, 200, { projects });
        return;
      }
      if (method === "POST") {
        const body = objectBody(await this.readJson(request));
        const slug = slugField(body["slug"]) ?? "";
        if (
          (await this.options.store.listProjects(organizationId)).some(
            (project) => project.slug === slug,
          )
        ) {
          throw new HttpError(
            409,
            "slug_in_use",
            "Project slug is already in use",
          );
        }
        const description = stringField(body["description"], "description", {
          max: 2_000,
          optional: true,
        });
        const project = await this.options.store.createProject({
          organizationId,
          slug,
          name: stringField(body["name"], "name", { max: 120 }) ?? "",
          ...(description === undefined ? {} : { description }),
        });
        await this.options.store.appendAudit(undefined, {
          type: "project_changed",
          data: {
            organizationId,
            projectId: project.id,
            action: "created",
            actorId: principal.user.id,
          },
        });
        this.sendJson(response, 201, { project });
        return;
      }
    }

    const projectMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/projects/([^/]+)$`, "u"),
    );
    if (projectMatch !== undefined) {
      const projectId = projectMatch[0] ?? "";
      const authorized = await authorizeProject(
        this.options.store,
        principal,
        projectId,
        method === "GET" ? "view" : "manage_project",
      );
      if (method === "GET") {
        this.sendJson(response, 200, authorized);
        return;
      }
      if (method === "PATCH") {
        const body = objectBody(await this.readJson(request));
        const slug = slugField(body["slug"], { optional: true });
        if (
          slug !== undefined &&
          (
            await this.options.store.listProjects(
              authorized.project.organizationId,
            )
          ).some(
            (project) => project.id !== projectId && project.slug === slug,
          )
        ) {
          throw new HttpError(
            409,
            "slug_in_use",
            "Project slug is already in use",
          );
        }
        const name = stringField(body["name"], "name", {
          max: 120,
          optional: true,
        });
        const description = stringField(body["description"], "description", {
          max: 2_000,
          optional: true,
        });
        const archived = booleanField(body["archived"], "archived");
        let policy: Record<string, unknown> | null | undefined;
        if ("policy" in body) {
          const value = body["policy"];
          if (value === null) {
            policy = null;
          } else {
            try {
              assertProjectPolicy(value);
            } catch (error) {
              throw new HttpError(
                400,
                "invalid_policy",
                error instanceof Error
                  ? error.message
                  : "Project policy is invalid",
              );
            }
            policy = value as unknown as Record<string, unknown>;
          }
        }
        const project = await this.options.store.updateProject(projectId, {
          ...(slug === undefined ? {} : { slug }),
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
          ...(archived === undefined ? {} : { archived }),
          ...(policy === undefined ? {} : { policy }),
        });
        await this.options.store.appendAudit(undefined, {
          type: "project_changed",
          data: {
            organizationId: project.organizationId,
            projectId,
            action: "updated",
            actorId: principal.user.id,
          },
        });
        this.sendJson(response, 200, { project });
        return;
      }
    }

    const agentsMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/projects/([^/]+)/agents$`, "u"),
    );
    if (agentsMatch !== undefined && method === "GET") {
      await authorizeProject(
        this.options.store,
        principal,
        agentsMatch[0] ?? "",
        "view",
      );
      this.sendJson(response, 200, {
        agents: (await this.options.operations.listAgents?.()) ?? [],
      });
      return;
    }

    const repositoriesMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/projects/([^/]+)/repositories$`, "u"),
    );
    if (repositoriesMatch !== undefined && method === "GET") {
      const projectId = repositoriesMatch[0] ?? "";
      const { repositories } = await authorizeProject(
        this.options.store,
        principal,
        projectId,
        "view",
      );
      const all = await this.options.store.listProjectRepositories(projectId);
      this.sendJson(response, 200, {
        // Somebody holding a grant sees the repositories they were granted and
        // no others: this list is how the interface learns what exists, so
        // returning everything here would defeat the grant regardless of what
        // the per-repository routes enforce.
        repositories:
          repositories === undefined
            ? all
            : all.filter((entry) => repositories.has(entry.id)),
      });
      return;
    }
    if (repositoriesMatch !== undefined && method === "POST") {
      const projectId = repositoriesMatch[0] ?? "";
      const { project } = await authorizeProject(
        this.options.store,
        principal,
        projectId,
        "import_repository",
      );
      const body = objectBody(await this.readJson(request));
      const branch = stringField(body["branch"], "branch", {
        max: 240,
        optional: true,
      });
      const repository = await this.performOperation(
        "repository_creation_failed",
        async () =>
          await this.options.operations.createRepository({
            projectId,
            id: stringField(body["id"], "id", { max: 80 }) ?? "",
            ...(branch === undefined ? {} : { branch }),
            actorId: principal.user.id,
          }),
      );
      await this.options.store.appendAudit(undefined, {
        type: "repository_created",
        data: {
          organizationId: project.organizationId,
          projectId,
          repositoryId: repository.id,
          branch: repository.branch,
          actorId: principal.user.id,
        },
      });
      this.sendJson(response, 201, { repository });
      return;
    }

    const githubMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/github$`,
        "u",
      ),
    );
    if (githubMatch !== undefined && method === "POST") {
      const projectId = githubMatch[0] ?? "";
      const { project } = await authorizeProject(
        this.options.store,
        principal,
        projectId,
        "import_repository",
      );
      const body = objectBody(await this.readJson(request));
      const id = stringField(body["id"], "id", {
        max: 80,
        optional: true,
      });
      const branch = stringField(body["branch"], "branch", {
        max: 240,
        optional: true,
      });
      const token = stringField(body["token"], "token", {
        max: 1_024,
        optional: true,
      });
      const repository = await this.performOperation(
        "repository_import_failed",
        async () =>
          await this.options.operations.importGitHub({
            projectId,
            repository:
              stringField(body["repository"], "repository", { max: 500 }) ?? "",
            ...(id === undefined ? {} : { id }),
            ...(branch === undefined ? {} : { branch }),
            ...(token === undefined ? {} : { token }),
            actorId: principal.user.id,
          }),
      );
      await this.options.store.appendAudit(undefined, {
        type: "repository_imported",
        data: {
          organizationId: project.organizationId,
          projectId,
          repositoryId: repository.id,
          provider: "github",
          actorId: principal.user.id,
        },
      });
      this.sendJson(response, 201, { repository });
      return;
    }

    const tasksMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/projects/([^/]+)/tasks$`, "u"),
    );
    if (tasksMatch !== undefined) {
      const projectId = tasksMatch[0] ?? "";
      const authorized = await authorizeProject(
        this.options.store,
        principal,
        projectId,
        method === "GET" ? "view" : "submit_task",
      );
      if (method === "GET") {
        const statusValue = url.searchParams.get("status") ?? undefined;
        const status =
          statusValue === undefined
            ? undefined
            : TASK_STATUSES.find((entry) => entry === statusValue);
        if (statusValue !== undefined && status === undefined) {
          throw new HttpError(
            400,
            "invalid_status",
            `Task status must be one of ${TASK_STATUSES.join(", ")}`,
          );
        }
        const tasks = await this.options.store.listSubmittedTasks({
          projectId,
          ...(status === undefined ? {} : { status }),
        });
        this.sendJson(response, 200, {
          tasks: narrowToRepositories(tasks, authorized.repositories),
        });
        return;
      }
      if (method === "POST") {
        const body = objectBody(await this.readJson(request));
        const repositoryId =
          stringField(body["repositoryId"], "repositoryId", { max: 128 }) ?? "";
        if (
          !(await this.options.store.projectHasRepository(
            projectId,
            repositoryId,
          )) ||
          // Reaching the project is not permission to put work into a
          // repository inside it. Same answer either way, so a probe cannot
          // tell "not linked" from "not yours".
          (authorized.repositories !== undefined &&
            !authorized.repositories.has(repositoryId))
        ) {
          throw new HttpError(
            404,
            "repository_not_found",
            "Repository is not linked to this project",
          );
        }
        const agentId = stringField(body["agentId"], "agentId", {
          max: 128,
          optional: true,
        });
        const task = await this.performOperation(
          "task_submission_failed",
          async () =>
            await this.options.operations.submitTask({
              projectId,
              repositoryId,
              objective:
                stringField(body["objective"], "objective", { max: 10_000 }) ??
                "",
              ...(agentId === undefined ? {} : { agentId }),
              actorId: principal.user.id,
            }),
        );
        await this.options.store.appendAudit(undefined, {
          type: "task_submitted",
          taskId: task.id,
          data: {
            projectId,
            repositoryId,
            actorId: principal.user.id,
            objective: task.objective,
          },
        });
        this.sendJson(response, 201, { task });
        return;
      }
    }

    const taskActionMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/tasks/([^/]+)/(retry|cancel)$`, "u"),
    );
    if (taskActionMatch !== undefined && method === "POST") {
      const [taskId = "", action = ""] = taskActionMatch;
      const task = (
        await this.options.store.listSubmittedTasks()
      ).find((entry) => entry.id === taskId);
      if (task === undefined || task.projectId === undefined) {
        throw new HttpError(404, "not_found", "Task was not found");
      }
      await authorizeProject(
        this.options.store,
        principal,
        task.projectId,
        "run_task",
      );
      const runKey = `${task.projectId}\0${task.repositoryId}`;
      if (this.activeRuns.has(runKey)) {
        throw new HttpError(
          409,
          "run_in_progress",
          `Task ${action} is unavailable while its repository run is active`,
        );
      }
      const updated =
        action === "retry"
          ? await this.options.store.retrySubmittedTask(taskId)
          : await this.options.store.cancelSubmittedTask(taskId);
      if (action === "cancel") {
        await this.options.store.appendAudit(undefined, {
          type: "task_cancelled",
          taskId,
          data: {
            projectId: task.projectId,
            actorId: principal.user.id,
          },
        });
      }
      this.sendJson(response, 200, { task: updated });
      return;
    }

    const runMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/run$`,
        "u",
      ),
    );
    if (runMatch !== undefined && method === "POST") {
      const [projectId = "", repositoryId = ""] = runMatch;
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        "run_task",
      );
      if (
        !(await this.options.store.projectHasRepository(projectId, repositoryId))
      ) {
        throw new HttpError(404, "not_found", "Repository was not found");
      }
      const key = `${projectId}\0${repositoryId}`;
      if (this.activeRuns.has(key)) {
        throw new HttpError(
          409,
          "run_in_progress",
          "A run is already active for this repository",
        );
      }
      this.activeRuns.add(key);
      const operationId = createId("operation");
      void this.options.operations
        .runRepository({
          projectId,
          repositoryId,
          actorId: principal.user.id,
        })
        .catch(async (error: unknown) => {
          await this.options.store.appendAudit(undefined, {
            type: "task_failed",
            data: {
              projectId,
              repositoryId,
              operationId,
              stage: "run_start",
              error: error instanceof Error ? error.message : String(error),
            },
          });
        })
        .finally(() => {
          this.activeRuns.delete(key);
        });
      this.sendJson(response, 202, { operationId, status: "accepted" });
      return;
    }

    const runCommentsMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/runs/([^/]+)/comments$`, "u"),
    );
    if (runCommentsMatch !== undefined) {
      const runId = runCommentsMatch[0] ?? "";
      const detail = await this.options.store.getRun(runId);
      if (detail === undefined || detail.run.projectId === undefined) {
        throw new HttpError(404, "not_found", "Run was not found");
      }
      if (method === "GET") {
        await authorizeProject(
          this.options.store,
          principal,
          detail.run.projectId,
          "view",
        );
        this.sendJson(response, 200, {
          comments: await this.options.store.listChangesetComments({ runId }),
        });
        return;
      }
      if (method === "POST") {
        // Reviewing is its own permission: a viewer reads the diff, a
        // reviewer writes on it.
        await authorizeProject(
          this.options.store,
          principal,
          detail.run.projectId,
          "review",
        );
        const body = objectBody(await this.readJson(request));
        const changeSetId = stringField(body["changeSetId"], "changeSetId", {
          max: 200,
        });
        const text = stringField(body["body"], "body", { max: 10_000 });
        if (changeSetId === undefined || text === undefined || text.length === 0) {
          throw new HttpError(
            400,
            "invalid_request",
            "changeSetId and body are required",
          );
        }
        const changeSet = detail.changeSets.find(
          (entry) => entry.id === changeSetId,
        );
        if (changeSet === undefined) {
          throw new HttpError(404, "not_found", "Changeset was not found");
        }
        const filePath = stringField(body["filePath"], "filePath", {
          max: 1_000,
          optional: true,
        });
        if (
          filePath !== undefined &&
          !changeSet.patches.some((patch) => patch.path === filePath)
        ) {
          throw new HttpError(
            400,
            "invalid_request",
            "filePath is not part of this changeset",
          );
        }
        const comment = await this.options.store.addChangesetComment({
          runId,
          changeSetId,
          taskId: changeSet.taskId,
          authorId: principal.user.id,
          body: text,
          ...(filePath === undefined ? {} : { filePath }),
        });
        this.sendJson(response, 201, { comment });
        return;
      }
      throw new HttpError(405, "method_not_allowed", "Unsupported method");
    }

    const resolveCommentMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/comments/([^/]+)/resolve$`, "u"),
    );
    if (resolveCommentMatch !== undefined && method === "POST") {
      const commentId = resolveCommentMatch[0] ?? "";
      const comment = await this.options.store.getChangesetComment(commentId);
      if (comment === undefined) {
        throw new HttpError(404, "not_found", "Comment was not found");
      }
      const detail = await this.options.store.getRun(comment.runId);
      if (detail?.run.projectId === undefined) {
        throw new HttpError(404, "not_found", "Comment was not found");
      }
      await authorizeProject(
        this.options.store,
        principal,
        detail.run.projectId,
        "review",
      );
      this.sendJson(response, 200, {
        comment: await this.options.store.resolveChangesetComment(
          commentId,
          principal.user.id,
          new Date().toISOString(),
        ),
      });
      return;
    }

    const versionsMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/versions$`,
        "u",
      ),
    );
    if (versionsMatch !== undefined && method === "GET") {
      const [projectId = "", repositoryId = ""] = versionsMatch;
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        "view",
      );
      if (
        !(await this.options.store.projectHasRepository(projectId, repositoryId))
      ) {
        throw new HttpError(404, "not_found", "Repository was not found");
      }
      const operation = this.options.operations.repositoryVersions;
      if (operation === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment does not expose canonical history",
        );
      }
      const limit = Math.min(
        200,
        Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10)),
      );
      this.sendJson(response, 200, {
        versions: await operation({ projectId, repositoryId, limit }),
      });
      return;
    }

    const rollbackMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/rollback$`,
        "u",
      ),
    );
    if (rollbackMatch !== undefined && method === "POST") {
      const [projectId = "", repositoryId = ""] = rollbackMatch;
      // Reverting canonical wholesale is a project-management act, not
      // ordinary task work, so it needs more than the run_task a developer
      // carries.
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        "manage_project",
      );
      if (
        !(await this.options.store.projectHasRepository(projectId, repositoryId))
      ) {
        throw new HttpError(404, "not_found", "Repository was not found");
      }
      const operation = this.options.operations.rollbackRepository;
      if (operation === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment does not support rollback",
        );
      }
      const body = objectBody(await this.readJson(request));
      const targetRevision = stringField(
        body["targetRevision"],
        "targetRevision",
        { max: 200 },
      );
      if (targetRevision === undefined || targetRevision.length === 0) {
        throw new HttpError(
          400,
          "invalid_request",
          "targetRevision is required",
        );
      }
      const reason = stringField(body["reason"], "reason", {
        max: 2_000,
        optional: true,
      });
      const result = await operation({
        projectId,
        repositoryId,
        targetRevision,
        actorId: principal.user.id,
        ...(reason === undefined ? {} : { reason }),
      });
      // A rollback that was refused is a legitimate answer, not a transport
      // error, so the outcome travels in the body with a 200.
      this.sendJson(response, 200, { rollback: result });
      return;
    }

    // ---- Overlay workspaces (dashboard editor + sandboxed terminal) -------
    // One user's isolated worktree of one repository. The user id in scope
    // is always the authenticated principal's, so no request can address
    // another user's overlay. Editing requires submit_task (the same right
    // needed to put work into the queue); running terminal commands requires
    // run_task. Canonical is untouched by everything here except `submit`,
    // which goes through the ordinary integration pipeline.
    // Matched in two steps because matchPath decodes every group and an
    // absent optional group must stay absent rather than become "undefined".
    const workspaceBaseMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/workspace$`,
        "u",
      ),
    );
    const workspaceActionMatch =
      workspaceBaseMatch === undefined
        ? matchPath(
            path,
            new RegExp(
              `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/workspace` +
                `/(files|file|reset|exec|submit)$`,
              "u",
            ),
          )
        : undefined;
    const workspaceMatch = workspaceBaseMatch ?? workspaceActionMatch;
    if (workspaceMatch !== undefined) {
      const [projectId = "", repositoryId = ""] = workspaceMatch;
      const action = workspaceActionMatch?.[2];
      const workspaceOperations = this.options.operations.workspace;
      if (workspaceOperations === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment does not support overlay workspaces",
        );
      }
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        action === "exec" ? "run_task" : "submit_task",
      );
      const scope = {
        projectId,
        repositoryId,
        userId: principal.user.id,
      };
      // Overlay implementations throw errors carrying an HTTP status and
      // code; anything else stays an internal error.
      const perform = async <T>(operation: () => Promise<T>): Promise<T> => {
        try {
          return await operation();
        } catch (error) {
          const status = (error as { status?: unknown }).status;
          const code = (error as { code?: unknown }).code;
          if (
            error instanceof Error &&
            typeof status === "number" &&
            typeof code === "string"
          ) {
            throw new HttpError(status, code, error.message);
          }
          throw error;
        }
      };

      if (action === undefined) {
        if (method === "GET") {
          this.sendJson(response, 200, {
            workspace: await perform(() => workspaceOperations.status(scope)),
          });
          return;
        }
        if (method === "POST") {
          this.sendJson(response, 200, {
            workspace: await perform(() => workspaceOperations.open(scope)),
          });
          return;
        }
        if (method === "DELETE") {
          await perform(() => workspaceOperations.discard(scope));
          this.sendJson(response, 200, { discarded: true });
          return;
        }
      }
      if (action === "reset" && method === "POST") {
        this.sendJson(response, 200, {
          workspace: await perform(() => workspaceOperations.reset(scope)),
        });
        return;
      }
      if (action === "files" && method === "GET") {
        this.sendJson(response, 200, {
          files: await perform(() => workspaceOperations.listFiles(scope)),
        });
        return;
      }
      if (action === "file" && method === "GET") {
        const filePath = stringField(
          url.searchParams.get("path") ?? undefined,
          "path",
          { max: 1_000 },
        );
        this.sendJson(response, 200, {
          file: await perform(() =>
            workspaceOperations.readFile({ ...scope, path: filePath ?? "" }),
          ),
        });
        return;
      }
      if (action === "file" && method === "POST") {
        const body = objectBody(await this.readJson(request));
        const filePath = stringField(body["path"], "path", { max: 1_000 });
        const content = body["content"];
        if (typeof content !== "string") {
          throw new HttpError(
            400,
            "invalid_request",
            "content must be a string",
          );
        }
        await perform(() =>
          workspaceOperations.writeFile({
            ...scope,
            path: filePath ?? "",
            content,
          }),
        );
        this.sendJson(response, 200, { saved: true });
        return;
      }
      if (action === "exec" && method === "POST") {
        const body = objectBody(await this.readJson(request));
        const command =
          stringField(body["command"], "command", { max: 4_000 }) ?? "";
        this.sendJson(response, 200, {
          result: await perform(() =>
            workspaceOperations.exec({ ...scope, command }),
          ),
        });
        return;
      }
      if (action === "submit" && method === "POST") {
        const body = objectBody(await this.readJson(request));
        const objective =
          stringField(body["objective"], "objective", {
            max: 2_000,
            optional: true,
          }) ?? "";
        this.sendJson(response, 200, {
          result: await perform(() =>
            workspaceOperations.submit({ ...scope, objective }),
          ),
        });
        return;
      }
      throw new HttpError(405, "method_not_allowed", "Unsupported method");
    }

    // ---- Direct provider chat (dashboard panel) ---------------------------
    // Connections are per authenticated user; a user can only ever spend
    // their own key. No organization permission is involved because nothing
    // here touches projects, repositories, or canonical state.
    if (path.startsWith(`${API_PREFIX}/chat/`)) {
      const chatOperations = this.options.operations.chatProviders;
      if (chatOperations === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment does not support provider chat",
        );
      }
      const performChat = async <T>(operation: () => Promise<T>): Promise<T> => {
        try {
          return await operation();
        } catch (error) {
          const status = (error as { status?: unknown }).status;
          const code = (error as { code?: unknown }).code;
          if (
            error instanceof Error &&
            typeof status === "number" &&
            typeof code === "string"
          ) {
            throw new HttpError(status, code, error.message);
          }
          throw error;
        }
      };
      const identity = {
        userId: principal.user.id,
        systemAdmin: principal.user.systemAdmin,
      };

      if (path === `${API_PREFIX}/chat/providers` && method === "GET") {
        this.sendJson(response, 200, {
          providers: await performChat(() => chatOperations.list(identity)),
        });
        return;
      }
      const chatProviderMatch = matchPath(
        path,
        new RegExp(
          `^${API_PREFIX}/chat/providers/(anthropic|openai|google)$`,
          "u",
        ),
      );
      const chatProviderActionMatch = matchPath(
        path,
        new RegExp(
          `^${API_PREFIX}/chat/providers/(anthropic|openai|google)` +
            `/(signin|options|settings|usage)$`,
          "u",
        ),
      );
      if (chatProviderActionMatch !== undefined) {
        const [provider = "", action = ""] = chatProviderActionMatch;
        if (action === "signin" && method === "POST") {
          this.sendJson(response, 200, {
            signIn: await performChat(() =>
              chatOperations.signIn({
                systemAdmin: identity.systemAdmin,
                provider,
              }),
            ),
          });
          return;
        }
        if (action === "options" && method === "GET") {
          this.sendJson(response, 200, {
            options: await performChat(() =>
              chatOperations.options({ provider }),
            ),
          });
          return;
        }
        if (action === "usage" && method === "GET") {
          this.sendJson(response, 200, {
            usage: await performChat(() => chatOperations.usage({ provider })),
          });
          return;
        }
        if (action === "settings" && method === "POST") {
          const body = objectBody(await this.readJson(request));
          const model = stringField(body["model"], "model", {
            max: 120,
            optional: true,
          });
          const effort = stringField(body["effort"], "effort", {
            max: 20,
            optional: true,
          });
          this.sendJson(response, 200, {
            providers: await performChat(() =>
              chatOperations.setSettings({
                userId: identity.userId,
                provider,
                ...(model === undefined ? {} : { model }),
                ...(effort === undefined ? {} : { effort }),
              }),
            ),
          });
          return;
        }
        throw new HttpError(405, "method_not_allowed", "Unsupported method");
      }
      if (chatProviderMatch !== undefined) {
        const provider = chatProviderMatch[0] ?? "";
        if (method === "POST") {
          // Sign-in based connection: the body carries nothing sensitive.
          await this.readJson(request).catch(() => undefined);
          this.sendJson(response, 200, {
            providers: await performChat(() =>
              chatOperations.connect({ ...identity, provider }),
            ),
          });
          return;
        }
        if (method === "DELETE") {
          await performChat(() =>
            chatOperations.disconnect({ userId: identity.userId, provider }),
          );
          this.sendJson(response, 200, { disconnected: true });
          return;
        }
      }
      if (path === `${API_PREFIX}/chat/complete` && method === "POST") {
        const body = objectBody(await this.readJson(request));
        const provider = stringField(body["provider"], "provider", { max: 20 }) ?? "";
        if (!["anthropic", "openai", "google"].includes(provider)) {
          throw new HttpError(400, "invalid_request", "provider is unknown");
        }
        const cliSessionId = stringField(body["cliSessionId"], "cliSessionId", {
          max: 64,
          optional: true,
        });
        this.sendJson(response, 200, {
          reply: await performChat(() =>
            chatOperations.complete({
              ...identity,
              provider,
              messages: body["messages"],
              ...(cliSessionId === undefined ? {} : { cliSessionId }),
            }),
          ),
        });
        return;
      }
      if (path === `${API_PREFIX}/chat/stream` && method === "POST") {
        const streamOperation = chatOperations.completeStream;
        if (streamOperation === undefined) {
          throw new HttpError(
            501,
            "not_supported",
            "Streaming chat is not configured on this deployment",
          );
        }
        const body = objectBody(await this.readJson(request));
        const provider =
          stringField(body["provider"], "provider", { max: 20 }) ?? "";
        if (!["anthropic", "openai", "google"].includes(provider)) {
          throw new HttpError(400, "invalid_request", "provider is unknown");
        }
        const cliSessionId = stringField(
          body["cliSessionId"],
          "cliSessionId",
          { max: 64, optional: true },
        );
        // Newline-delimited JSON: one event per line, flushed immediately so
        // the browser sees progress rather than a buffered reply.
        response.setHeader("Content-Type", "application/x-ndjson");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Accel-Buffering", "no");
        response.writeHead(200);
        const write = (event: unknown) => {
          if (!response.writableEnded) {
            response.write(`${JSON.stringify(event)}\n`);
          }
        };
        try {
          const reply = await performChat(() =>
            streamOperation(
              {
                ...identity,
                provider,
                messages: body["messages"],
                ...(cliSessionId === undefined ? {} : { cliSessionId }),
              },
              write,
            ),
          );
          write({ type: "done", reply });
        } catch (error) {
          const failure =
            error instanceof HttpError
              ? { code: error.code, message: error.message }
              : {
                  code: "chat_failed",
                  message:
                    error instanceof Error ? error.message : String(error),
                };
          write({ type: "error", ...failure });
        }
        response.end();
        return;
      }
      throw new HttpError(404, "not_found", "Route was not found");
    }

    const runsMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/projects/([^/]+)/runs$`, "u"),
    );
    if (runsMatch !== undefined && method === "GET") {
      const projectId = runsMatch[0] ?? "";
      const authorized = await authorizeProject(
        this.options.store,
        principal,
        projectId,
        "view",
      );
      const limit = Math.min(
        500,
        Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "100", 10)),
      );
      this.sendJson(response, 200, {
        runs: narrowToRepositories(
          await this.options.store.listRuns(limit * 5),
          authorized.repositories,
        )
          .filter((run) => run.projectId === projectId)
          .slice(0, limit),
      });
      return;
    }

    const runDetailMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/runs/([^/]+)$`, "u"),
    );
    if (runDetailMatch !== undefined && method === "GET") {
      const runId = runDetailMatch[0] ?? "";
      const detail = await this.options.store.getRun(runId);
      if (detail === undefined || detail.run.projectId === undefined) {
        throw new HttpError(404, "not_found", "Run was not found");
      }
      await authorizeProject(
        this.options.store,
        principal,
        detail.run.projectId,
        "view",
      );
      this.sendJson(response, 200, { run: detail });
      return;
    }

    const approvalsMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/projects/([^/]+)/approvals$`, "u"),
    );
    if (approvalsMatch !== undefined && method === "GET") {
      const projectId = approvalsMatch[0] ?? "";
      const authorized = await authorizeProject(
        this.options.store,
        principal,
        projectId,
        "view",
      );
      const statusValue = url.searchParams.get("status") ?? undefined;
      const status =
        statusValue === undefined
          ? undefined
          : APPROVAL_STATUSES.find((entry) => entry === statusValue);
      if (statusValue !== undefined && status === undefined) {
        throw new HttpError(
          400,
          "invalid_status",
          `Approval status must be one of ${APPROVAL_STATUSES.join(", ")}`,
        );
      }
      this.sendJson(response, 200, {
        approvals: narrowToRepositories(
          await this.options.store.listApprovals({
            projectId,
            ...(status === undefined ? {} : { status }),
          }),
          authorized.repositories,
        ),
      });
      return;
    }

    const metricsMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/projects/([^/]+)/metrics$`, "u"),
    );
    if (metricsMatch !== undefined && method === "GET") {
      const projectId = metricsMatch[0] ?? "";
      await authorizeProject(this.options.store, principal, projectId, "view");
      const operation = this.options.operations.projectMetrics;
      if (operation === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment does not expose coordination metrics",
        );
      }
      this.sendJson(response, 200, {
        metrics: await operation({ projectId }),
      });
      return;
    }

    const approvalMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/approvals/([^/]+)$`, "u"),
    );
    if (approvalMatch !== undefined) {
      const approvalId = approvalMatch[0] ?? "";
      const approval = await this.options.store.getApproval(approvalId);
      if (approval === undefined || approval.projectId === undefined) {
        throw new HttpError(404, "not_found", "Approval was not found");
      }
      await authorizeProject(
        this.options.store,
        principal,
        approval.projectId,
        method === "GET" ? "view" : "review",
      );
      if (method === "GET") {
        const detail = await this.options.store.getRun(approval.runId);
        const changeSet = detail?.changeSets.find(
          (entry) => entry.id === approval.changeSetId,
        );
        this.sendJson(response, 200, { approval, changeSet });
        return;
      }
      if (method === "POST") {
        const body = objectBody(await this.readJson(request));
        const status = stringField(body["status"], "status", { max: 20 });
        if (status !== "approved" && status !== "rejected") {
          throw new HttpError(
            400,
            "invalid_decision",
            "status must be approved or rejected",
          );
        }
        const comment =
          stringField(body["comment"], "comment", {
            max: 2_000,
            optional: true,
          }) ?? "";
        const decided = await this.options.store.decideApproval({
          approvalId,
          status,
          decidedBy: principal.user.id,
          comment,
          decidedAt: new Date().toISOString(),
        });
        await this.options.store.appendAudit(approval.runId, {
          type: "approval_decided",
          taskId: approval.taskId,
          data: {
            projectId: approval.projectId,
            approvalId,
            status,
            actorId: principal.user.id,
            comment,
          },
        });
        this.sendJson(response, 200, { approval: decided });
        return;
      }
    }

    const auditMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/projects/([^/]+)/audit$`, "u"),
    );
    if (auditMatch !== undefined && method === "GET") {
      const projectId = auditMatch[0] ?? "";
      await authorizeProject(
        this.options.store,
        principal,
        projectId,
        "view",
      );
      const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
      const runIds = new Set(
        (await this.options.store.listRuns(5_000))
          .filter((run) => run.projectId === projectId)
          .map((run) => run.id),
      );
      const events = (
        await this.options.store.listAuditEvents({
          afterSequence: Number.isSafeInteger(after) && after >= 0 ? after : 0,
          limit: 5_000,
        })
      ).filter(
        (record) =>
          (record.runId !== undefined && runIds.has(record.runId)) ||
          record.event.data["projectId"] === projectId,
      );
      this.sendJson(response, 200, { events });
      return;
    }

    if (path.startsWith(`${API_PREFIX}/admin/`)) {
      assertTokenScope(principal, "manage_organization");
    }
    if (path === `${API_PREFIX}/admin/users`) {
      if (!principal.user.systemAdmin) {
        throw new HttpError(403, "forbidden", "System administrator required");
      }
      if (method === "GET") {
        this.sendJson(response, 200, {
          users: (await this.options.store.listUsers()).map(publicUser),
        });
        return;
      }
      if (method === "POST") {
        const body = objectBody(await this.readJson(request));
        const email = emailField(body["email"]) ?? "";
        if ((await this.options.store.getUserByEmail(email)) !== undefined) {
          throw new HttpError(
            409,
            "email_in_use",
            "User email is already in use",
          );
        }
        const user = await this.options.store.createUser({
          email,
          displayName:
            stringField(body["displayName"], "displayName", { max: 120 }) ?? "",
          passwordDigest: await hashPassword(
            stringField(body["password"], "password", { max: 256 }) ?? "",
          ),
          systemAdmin: booleanField(body["systemAdmin"], "systemAdmin") ?? false,
        });
        await this.options.store.appendAudit(undefined, {
          type: "user_changed",
          data: {
            userId: user.id,
            actorId: principal.user.id,
            action: "created",
          },
        });
        this.sendJson(response, 201, { user: publicUser(user) });
        return;
      }
    }

    const adminUserMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/admin/users/([^/]+)$`, "u"),
    );
    if (adminUserMatch !== undefined && method === "PATCH") {
      if (!principal.user.systemAdmin) {
        throw new HttpError(403, "forbidden", "System administrator required");
      }
      const body = objectBody(await this.readJson(request));
      const displayName = stringField(body["displayName"], "displayName", {
        max: 120,
        optional: true,
      });
      const password =
        stringField(body["password"], "password", {
          max: 256,
          optional: true,
        });
      const disabled = booleanField(body["disabled"], "disabled");
      const systemAdmin = booleanField(body["systemAdmin"], "systemAdmin");
      const userId = adminUserMatch[0] ?? "";
      if (userId === principal.user.id && disabled === true) {
        throw new HttpError(
          409,
          "self_lockout",
          "You cannot disable your own account",
        );
      }
      const current = await this.options.store.getUser(userId);
      if (current === undefined) {
        throw new HttpError(404, "not_found", "User was not found");
      }
      if (
        current.systemAdmin &&
        (systemAdmin === false || disabled === true) &&
        (await this.options.store.listUsers()).filter(
          (entry) => entry.systemAdmin && !entry.disabled,
        ).length <= 1
      ) {
        throw new HttpError(
          409,
          "last_system_admin",
          "The last active system administrator cannot be removed",
        );
      }
      const user = await this.options.store.updateUser(
        userId,
        {
          ...(displayName === undefined ? {} : { displayName }),
          ...(password === undefined
            ? {}
            : { passwordDigest: await hashPassword(password) }),
          ...(disabled === undefined ? {} : { disabled }),
          ...(systemAdmin === undefined ? {} : { systemAdmin }),
        },
      );
      if (disabled === true || password !== undefined) {
        await this.options.store.revokeUserSessions(user.id);
      }
      await this.options.store.appendAudit(undefined, {
        type: "user_changed",
        data: {
          userId: user.id,
          actorId: principal.user.id,
          action: "updated",
        },
      });
      this.sendJson(response, 200, { user: publicUser(user) });
      return;
    }

    if (method === "GET" && path === `${API_PREFIX}/admin/overview`) {
      if (!principal.user.systemAdmin) {
        throw new HttpError(403, "forbidden", "System administrator required");
      }
      const organizations = await this.options.store.listOrganizations();
      const projects = (
        await Promise.all(
          organizations.map(
            async (organization) =>
              await this.options.store.listProjects(organization.id),
          ),
        )
      ).flat();
      const tasks = await this.options.store.listSubmittedTasks();
      const approvals = await this.options.store.listApprovals();
      this.sendJson(response, 200, {
        counts: {
          users: await this.options.store.countUsers(),
          organizations: organizations.length,
          projects: projects.length,
          repositories: (await this.options.store.listRepositories()).length,
          tasks: tasks.length,
          pendingTasks: tasks.filter((task) => task.status === "submitted").length,
          pendingApprovals: approvals.filter(
            (approval) => approval.status === "pending",
          ).length,
          activeRuns: this.activeRuns.size,
          webSocketConnections: this.webSockets.connections,
        },
        recentRuns: await this.options.store.listRuns(20),
      });
      return;
    }

    throw new HttpError(404, "not_found", "Route was not found");
  }

  /**
   * Organizations the caller can reach at all.
   *
   * Membership is no longer the only route in: somebody invited to a single
   * repository holds a grant and no organization role, and listing only their
   * memberships would leave them signed in and staring at nothing. The
   * organizations behind their grants are added so the interface can find the
   * project the repository lives in.
   */
  private async reachableOrganizations(
    principal: AuthenticatedPrincipal,
  ): Promise<Organization[]> {
    const byMembership = await this.options.store.listOrganizations(
      principal.user.systemAdmin ? undefined : principal.user.id,
    );
    if (principal.user.systemAdmin) {
      return byMembership;
    }
    const grants = await this.options.store.listGrantsForUser(
      principal.user.id,
    );
    if (grants.length === 0) {
      return byMembership;
    }
    const granted = new Set(grants.map((grant) => grant.repositoryId));
    const seen = new Set(byMembership.map((entry) => entry.id));
    const found = [...byMembership];
    for (const organization of await this.options.store.listOrganizations()) {
      if (seen.has(organization.id)) {
        continue;
      }
      for (const project of await this.options.store.listProjects(
        organization.id,
      )) {
        const repositories = await this.options.store.listProjectRepositories(
          project.id,
        );
        if (repositories.some((entry) => granted.has(entry.id))) {
          found.push(organization);
          seen.add(organization.id);
          break;
        }
      }
    }
    return found;
  }

  /** Projects the caller can reach, by membership or by a repository grant. */
  private async reachableProjects(
    principal: AuthenticatedPrincipal,
    organizationId: string,
    hasOrganizationRole: boolean,
  ): Promise<ProjectRecord[]> {
    const projects = await this.options.store.listProjects(organizationId);
    if (hasOrganizationRole || principal.user.systemAdmin) {
      return projects;
    }
    const granted = new Set(
      (await this.options.store.listGrantsForUser(principal.user.id)).map(
        (grant) => grant.repositoryId,
      ),
    );
    const reachable: ProjectRecord[] = [];
    for (const project of projects) {
      const repositories = await this.options.store.listProjectRepositories(
        project.id,
      );
      if (repositories.some((entry) => granted.has(entry.id))) {
        reachable.push(project);
      }
    }
    return reachable;
  }

  private requirePrincipal(context: RequestContext): AuthenticatedPrincipal {
    if (context.principal === undefined) {
      throw new AuthenticationError("Sign in is required");
    }
    return context.principal;
  }

  /**
   * Resolves the organization whose fleet is being read, and proves the caller
   * may read it.
   *
   * The id is taken from the request and authorized, never inferred from the
   * caller's memberships. Inferring it would mean a request that named no
   * tenant still got answered with one, and the endpoint would have no single
   * value to filter the query by — which is exactly how a fleet listing ends
   * up merging tenants. Requiring it makes the boundary one explicit
   * `authorizeOrganization` call, which checks the token's organization
   * binding first, then membership, then scope.
   *
   * `view` is the permission because this is a read: every role in the
   * organization, down to `viewer`, can see the fleet it belongs to. Driving a
   * worker is a separate, stricter check at the lease endpoints.
   */
  private async authorizeFleet(
    principal: AuthenticatedPrincipal,
    url: URL,
  ): Promise<{ organizationId: string }> {
    const organizationId = url.searchParams.get("organizationId")?.trim() ?? "";
    if (organizationId.length === 0) {
      throw new HttpError(
        400,
        "invalid_request",
        "organizationId is required",
      );
    }
    await authorizeOrganization(
      this.options.store,
      principal,
      organizationId,
      "view",
    );
    return { organizationId };
  }

  /**
   * One organization's workers and the leases they are currently holding.
   *
   * Shared by the fleet listing and the running-agents count so the two cannot
   * disagree about what belongs to a tenant — a count computed one way and a
   * list computed another is how a boundary quietly develops a hole.
   *
   * Leases are filtered by their project as well as by their worker. Leasing
   * already refuses a worker whose organization does not match the project's,
   * so this is redundant for anything issued since; it is here for leases
   * predating that rule, which would otherwise surface another tenant's task
   * and repository ids. A lease with no project cannot be attributed to one
   * and is dropped rather than assumed to be local.
   *
   * Callers must have authorized `organizationId` first — this method filters,
   * it does not decide who may ask.
   */
  private async organizationFleet(organizationId: string): Promise<{
    workers: WorkerRecord[];
    active: WorkLease[];
  }> {
    const workers = await this.options.store.listWorkers({ organizationId });
    const owned = new Set(workers.map((worker) => worker.id));
    const visibleProjects = new Set(
      (await this.options.store.listProjects(organizationId)).map(
        (project) => project.id,
      ),
    );
    const active = (
      await this.options.store.listWorkLeases({ status: "active" })
    ).filter(
      (lease) =>
        owned.has(lease.workerId) &&
        lease.projectId !== undefined &&
        visibleProjects.has(lease.projectId),
    );
    return { workers, active };
  }

  private async performOperation<T>(
    code: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new HttpError(
        422,
        code,
        error instanceof Error ? error.message : "Operation could not be completed",
      );
    }
  }

  /**
   * Records the token totals a worker attached to a lease request.
   *
   * Returns everything reported for the lease so far, which is what a
   * per-task cap is measured against. A request that carries no usage — an
   * agent that does not report, or a bodyless heartbeat from an older worker
   * — writes nothing and simply reads the existing total back, so adding
   * accounting cannot break a worker that knows nothing about it.
   *
   * Malformed figures are dropped rather than rejected. The alternative is
   * failing a running task over a miscounted bill, and a gap in the data is
   * the honest record of an agent that could not say what it spent.
   */
  private async recordLeaseTokenUsage(
    request: IncomingMessage,
    lease: WorkLease,
    at: string,
  ): Promise<number> {
    const declared = Number.parseInt(
      request.headers["content-length"] ?? "0",
      10,
    );
    if (Number.isFinite(declared) && declared > 0) {
      const body = await this.readJson(request).catch(() => undefined);
      const entries = (body as { tokenUsage?: unknown } | undefined)
        ?.tokenUsage;
      if (Array.isArray(entries)) {
        await this.recordReportedTokenUsage(lease, entries, at);
      }
    }
    return (
      await this.options.store.listTokenUsage({ leaseId: lease.id })
    ).reduce((sum, entry) => sum + entry.totalTokens, 0);
  }

  /** Writes one batch of reported phase totals against a lease. */
  private async recordReportedTokenUsage(
    lease: WorkLease,
    entries: readonly unknown[],
    at: string,
  ): Promise<void> {
    const task = (
      await this.options.store.listSubmittedTasks({
        repositoryId: lease.repositoryId,
      })
    ).find((entry) => entry.id === lease.taskId);
    for (const raw of entries) {
      const entry = raw as Record<string, unknown>;
      const phase = entry["phase"];
      const total = entry["totalTokens"];
      if (
        (phase !== "planning" && phase !== "execution") ||
        typeof total !== "number" ||
        !Number.isSafeInteger(total) ||
        total < 0
      ) {
        continue;
      }
      const count = (key: string): number | undefined => {
        const value = entry[key];
        return typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0
          ? value
          : undefined;
      };
      await this.options.store.recordTokenUsage({
        // One row per lease and phase, carrying the running total: the worker
        // re-reports a larger figure as it goes, and summing those snapshots
        // would multiply the bill by the heartbeat rate.
        usageKey: `${lease.id}:${phase}`,
        ...(lease.projectId === undefined
          ? {}
          : { projectId: lease.projectId }),
        repositoryId: lease.repositoryId,
        taskId: lease.taskId,
        leaseId: lease.id,
        agentId: task?.agentId ?? lease.workerId,
        phase,
        ...(count("inputTokens") === undefined
          ? {}
          : { inputTokens: count("inputTokens")! }),
        ...(count("outputTokens") === undefined
          ? {}
          : { outputTokens: count("outputTokens")! }),
        totalTokens: total,
        recordedAt: at,
      });
    }
  }

  /** Settles a lease and its task after a budget was exceeded. */
  private async failLeaseOnBudget(
    lease: WorkLease,
    now: Date,
    input: { detail: string; data: Readonly<Record<string, unknown>> },
  ): Promise<void> {
    const failed = await this.options.store.finishWorkLease(
      lease.id,
      "failed",
      now.toISOString(),
      input.detail,
    );
    if (!failed) {
      return;
    }
    const task = (
      await this.options.store.listSubmittedTasks({
        repositoryId: lease.repositoryId,
      })
    ).find((entry) => entry.id === lease.taskId);
    if (task?.status === "claimed") {
      await this.options.store.completeSubmittedTask(task.id, "failed");
    }
    await this.options.store.appendAudit(undefined, {
      type: "task_failed",
      taskId: lease.taskId,
      data: {
        projectId: lease.projectId,
        repositoryId: lease.repositoryId,
        workerId: lease.workerId,
        leaseId: lease.id,
        stage: "budget_enforcement",
        ...input.data,
      },
    });
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const contentType = request.headers["content-type"]?.split(";")[0]?.trim();
    if (contentType !== "application/json") {
      throw new HttpError(
        415,
        "unsupported_media_type",
        "Content-Type must be application/json",
      );
    }
    const declared = Number.parseInt(request.headers["content-length"] ?? "0", 10);
    if (Number.isFinite(declared) && declared > this.bodyLimit) {
      throw new HttpError(413, "body_too_large", "Request body is too large");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > this.bodyLimit) {
        throw new HttpError(413, "body_too_large", "Request body is too large");
      }
      chunks.push(buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
    }
  }

  private async serveStatic(context: RequestContext): Promise<void> {
    const { request, response, url } = context;
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new HttpError(404, "not_found", "Route was not found");
    }
    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const asset =
      this.options.staticAssets?.get(requested) ??
      (requested.includes(".")
        ? undefined
        : this.options.staticAssets?.get("/index.html"));
    if (asset === undefined) {
      throw new HttpError(404, "not_found", "Asset was not found");
    }
    const body = Buffer.isBuffer(asset.body)
      ? asset.body
      : Buffer.from(asset.body, "utf8");
    const etag =
      asset.etag ??
      `"${createHash("sha256").update(body).digest("base64url")}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304);
      response.end();
      return;
    }
    response.setHeader("Content-Type", asset.contentType);
    response.setHeader("Content-Length", String(body.length));
    response.setHeader("ETag", etag);
    // Asset names are stable rather than content-hashed, so every navigation
    // must revalidate the ETag to avoid mixing an old client with a new API.
    response.setHeader("Cache-Control", "no-cache");
    response.writeHead(200);
    response.end(request.method === "HEAD" ? undefined : body);
  }

  private assertOrigin(request: IncomingMessage): void {
    const origin = request.headers.origin;
    if (origin === undefined) {
      return;
    }
    const host = request.headers.host;
    const sameOrigin =
      host !== undefined &&
      (origin === `http://${host}` || origin === `https://${host}`);
    if (!sameOrigin && !this.allowedOrigins.has(origin)) {
      throw new HttpError(403, "origin_rejected", "Request origin is not allowed");
    }
  }

  private applyCors(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const origin = request.headers.origin;
    if (origin === undefined) {
      return;
    }
    const host = request.headers.host;
    const sameOrigin =
      host !== undefined &&
      (origin === `http://${host}` || origin === `https://${host}`);
    if (!sameOrigin && this.allowedOrigins.has(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Credentials", "true");
      response.setHeader("Vary", "Origin");
    }
  }

  private remoteAddress(request: IncomingMessage): string {
    return request.socket.remoteAddress ?? "unknown";
  }

  private securityHeaders(response: ServerResponse, requestId: string): void {
    response.setHeader("X-Request-Id", requestId);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    // style-src allows 'unsafe-inline' because the vendored Monaco editor
    // injects its theming through runtime <style> elements; script-src stays
    // 'self' (no CDN, no inline scripts) and workers are same-origin scripts.
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self' ws: wss:; " +
        "font-src 'self'; worker-src 'self'; object-src 'none'; " +
        "base-uri 'none'; frame-ancestors 'none'",
    );
  }

  private sendJson(
    response: ServerResponse,
    status: number,
    value: unknown,
  ): void {
    if (response.headersSent) {
      return;
    }
    const body = Buffer.from(JSON.stringify(value), "utf8");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Length", String(body.length));
    response.setHeader("Cache-Control", "no-store");
    response.writeHead(status);
    response.end(body);
  }

  private sendError(
    response: ServerResponse,
    requestId: string,
    error: unknown,
  ): void {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    const normalized =
      error instanceof AuthenticationError
        ? {
            status: error.statusCode,
            code: error.code,
            message: error.message,
          }
        : error instanceof HttpError
          ? {
              status: error.status,
              code: error.code,
              message: error.message,
            }
          : {
              status: 500,
              code: "internal_error",
              message: "The request could not be completed",
            };
    this.sendJson(response, normalized.status, {
      error: {
        code: normalized.code,
        message: normalized.message,
        requestId,
      },
    });
  }
}
