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
  StoredRepository,
  SubmittedTask,
  SubmittedTaskStatus,
} from "@coord/persistence";
import { createId, type ApprovalStatus } from "@coord/shared-types";

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

export interface ApiOperations {
  listAgents?(): Promise<
    Array<{
      id: string;
      adapter: "codex" | "generic-cli";
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
  dockerStatus?(): Promise<{
    available: boolean;
    version?: string;
    explanation: string;
  }>;
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
  return match === null
    ? undefined
    : match.slice(1).map((value) => decodeURIComponent(value));
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
    this.allowedOrigins = new Set(options.allowedOrigins ?? []);
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
    const host = request.headers.host ?? "localhost";
    const url = new URL(request.url ?? "/", `http://${host}`);
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
        const project = await this.options.store.updateProject(projectId, {
          ...(slug === undefined ? {} : { slug }),
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
          ...(archived === undefined ? {} : { archived }),
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

  private remoteAddress(request: IncomingMessage): string {
    return request.socket.remoteAddress ?? "unknown";
  }

  private securityHeaders(response: ServerResponse, requestId: string): void {
    response.setHeader("X-Request-Id", requestId);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; " +
        "img-src 'self' data:; connect-src 'self' ws: wss:; " +
        "font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
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
