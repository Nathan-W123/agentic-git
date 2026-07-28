import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type {
  CoordinationStore,
  OrganizationRole,
  WorkLease,
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
  parseBearer,
  type AuthenticatedPrincipal,
} from "./auth.js";
import {
  authorizeOrganization,
  authorizeProject,
  canAssignRole,
  ALL_PERMISSIONS,
  assertTokenScope,
  isPermission,
  permissionsForRole,
} from "./authorization.js";
import { RateLimiter } from "./rate-limiter.js";
import { AuditWebSocketHub } from "./websocket.js";

const API_PREFIX = "/api/v1";
const MAX_JSON_BYTES = 1024 * 1024;
/** How long a worker holds a task before it must heartbeat again. */
const WORK_LEASE_TTL_MS = 5 * 60 * 1000;
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

function publicUser(user: {
  id: string;
  email: string;
  displayName: string;
  systemAdmin: boolean;
  disabled: boolean;
  createdAt: string;
}): Omit<typeof user, "passwordDigest"> {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    systemAdmin: user.systemAdmin,
    disabled: user.disabled,
    createdAt: user.createdAt,
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
    this.webSockets = new AuditWebSocketHub(options.store, {
      authorize: async (request, projectId) => {
        this.assertOrigin(request);
        const principal = await this.auth.authenticate(request.headers.cookie);
        const { project } = await authorizeProject(
          this.options.store,
          principal,
          projectId,
          "view",
        );
        return { principal, project };
      },
    });
    this.webSockets.attach(this.server);
  }

  public async close(): Promise<void> {
    this.webSockets.close();
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
      const isPublic =
        request.method === "GET" && url.pathname === `${API_PREFIX}/health` ||
        request.method === "POST" &&
          [
            `${API_PREFIX}/auth/login`,
            `${API_PREFIX}/auth/bootstrap`,
          ].includes(url.pathname);
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

    // ---- Remote worker protocol -------------------------------------------
    // Every endpoint requires the run_task scope, so a leaked read-only token
    // cannot pull work or return changesets.
    if (path === `${API_PREFIX}/workers/register` && method === "POST") {
      assertTokenScope(principal, "run_task");
      const body = objectBody(await this.readJson(request));
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
        name: stringField(body["name"], "name", { max: 120 }) ?? "",
        adapters,
        version: stringField(body["version"], "version", { max: 40 }) ?? "0",
      });
      this.sendJson(response, 201, worker);
      return;
    }

    if (path === `${API_PREFIX}/workers` && method === "GET") {
      assertTokenScope(principal, "run_task");
      const workers = await this.options.store.listWorkers();
      this.sendJson(response, 200, {
        workers: principal.user.systemAdmin
          ? workers
          : workers.filter((worker) => worker.userId === principal.user.id),
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
      await authorizeProject(
        this.options.store,
        principal,
        projectId,
        "run_task",
      );

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
        `^${API_PREFIX}/workers/leases/([^/]+)/(heartbeat|bundle|plan|result|release)$`,
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

        // Cost control: a lease past the project's per-task runtime budget
        // is failed rather than extended. Failing (not releasing) is
        // deliberate — requeueing would re-run the same runaway task and
        // burn the budget again.
        if (lease.projectId !== undefined) {
          const project = await this.options.store.getProject(lease.projectId);
          const maxTaskRuntimeMs = projectBudgets(
            project?.policy,
          ).maxTaskRuntimeMs;
          const runtimeMs =
            now.getTime() - new Date(lease.issuedAt).getTime();
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
        organizations: await this.options.store.listOrganizations(
          principal.user.systemAdmin ? undefined : principal.user.id,
        ),
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
      await authorizeOrganization(
        this.options.store,
        principal,
        organizationId,
        method === "GET" ? "view" : "manage_project",
      );
      if (method === "GET") {
        this.sendJson(response, 200, {
          projects: await this.options.store.listProjects(organizationId),
        });
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
      await authorizeProject(
        this.options.store,
        principal,
        projectId,
        "view",
      );
      this.sendJson(response, 200, {
        repositories:
          await this.options.store.listProjectRepositories(projectId),
      });
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
      await authorizeProject(
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
        this.sendJson(response, 200, {
          tasks: await this.options.store.listSubmittedTasks({
            projectId,
            ...(status === undefined ? {} : { status }),
          }),
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
          ))
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
      await authorizeProject(
        this.options.store,
        principal,
        projectId,
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
      await authorizeProject(this.options.store, principal, projectId, "view");
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
      await authorizeProject(
        this.options.store,
        principal,
        projectId,
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
      await authorizeProject(
        this.options.store,
        principal,
        projectId,
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

    const runsMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/projects/([^/]+)/runs$`, "u"),
    );
    if (runsMatch !== undefined && method === "GET") {
      const projectId = runsMatch[0] ?? "";
      await authorizeProject(
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
        runs: (await this.options.store.listRuns(limit * 5))
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
      await authorizeProject(
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
        approvals: await this.options.store.listApprovals({
          projectId,
          ...(status === undefined ? {} : { status }),
        }),
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

  private requirePrincipal(context: RequestContext): AuthenticatedPrincipal {
    if (context.principal === undefined) {
      throw new AuthenticationError("Sign in is required");
    }
    return context.principal;
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
