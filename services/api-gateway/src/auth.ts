import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";

import type {
  CoordinationStore,
  OrganizationMembership,
  OrganizationRole,
  UserAccount,
} from "@coord/persistence";
import { createId } from "@coord/shared-types";

const SESSION_COOKIE = "coord_session";
const CSRF_COOKIE = "coord_csrf";
const PASSWORD_N = 16_384;
const PASSWORD_R = 8;
const PASSWORD_P = 1;
const PASSWORD_BYTES = 64;
const DUMMY_PASSWORD_DIGEST =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function derivePassword(
  password: string,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, derived) => {
      if (error !== null) {
        reject(error);
      } else {
        resolve(derived);
      }
    });
  });
}

export class AuthenticationError extends Error {
  public constructor(
    message: string,
    public readonly statusCode = 401,
    public readonly code = "authentication_required",
  ) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  systemAdmin: boolean;
  /** Interface colours; the agent colour identifies this user to colleagues. */
  appearance?: { accent?: string; agentColor?: string };
}

/**
 * How the caller proved who they are.
 *
 * A cookie session is a browser and needs CSRF protection; a bearer token is a
 * headless client and does not, because a browser never attaches it
 * automatically. Downstream code branches on this rather than guessing.
 */
export type CredentialKind = "session" | "api_token";

export interface ApiTokenPrincipal {
  id: string;
  name: string;
  /**
   * Opaque permission names. The gateway's authorization layer interprets
   * them; auth deliberately does not know the permission vocabulary.
   */
  scopes: readonly string[];
  /** When set, the token may only act inside this organization. */
  organizationId: string | undefined;
}

export interface AuthenticatedPrincipal {
  user: PublicUser;
  credential: CredentialKind;
  /** Present only for cookie sessions. */
  sessionId?: string;
  /** Present only for bearer tokens. */
  token?: ApiTokenPrincipal;
  memberships: OrganizationMembership[];
}

export interface SessionIssueResult {
  principal: AuthenticatedPrincipal;
  csrfToken: string;
  cookies: string[];
}

export interface AuthServiceOptions {
  sessionTtlMs?: number;
  /** Default token lifetime in days. 0 means tokens never expire. */
  defaultTokenDays?: number;
  secureCookies?: boolean;
  now?: () => Date;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

/**
 * Hashes a bearer-style secret for storage.
 *
 * Shared with invitations so an invitation link is stored exactly the way a
 * session or API token is — the database never holds anything that could be
 * presented back as a credential.
 */
export function hashSecret(value: string): string {
  return digest(value);
}

export function secretMatches(value: string, expectedHash: string): boolean {
  return equalDigest(value, expectedHash);
}

function equalDigest(value: string, expected: string): boolean {
  const actualBuffer = Buffer.from(digest(value));
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function publicUser(user: UserAccount): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    systemAdmin: user.systemAdmin,
    // The principal is rebuilt from the store on every request, so a colour
    // changed in one tab is live in the next request rather than at next
    // sign-in.
    ...(user.appearance === undefined ? {} : { appearance: user.appearance }),
  };
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name.length > 0) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function cookie(
  name: string,
  value: string,
  options: {
    maxAgeSeconds: number;
    httpOnly: boolean;
    secure: boolean;
  },
): string {
  return [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${options.maxAgeSeconds}`,
    "SameSite=Strict",
    ...(options.httpOnly ? ["HttpOnly"] : []),
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

function assertPassword(password: string): void {
  if (password.length < 12 || password.length > 256) {
    throw new AuthenticationError(
      "Password must contain between 12 and 256 characters",
      400,
      "invalid_password",
    );
  }
  if (
    !/[A-Za-z]/u.test(password) ||
    !/[0-9]/u.test(password) ||
    new Set(password).size < 8
  ) {
    throw new AuthenticationError(
      "Password must include letters, numbers, and at least eight distinct characters",
      400,
      "invalid_password",
    );
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPassword(password);
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt, PASSWORD_BYTES, {
    N: PASSWORD_N,
    r: PASSWORD_R,
    p: PASSWORD_P,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "scrypt",
    String(PASSWORD_N),
    String(PASSWORD_R),
    String(PASSWORD_P),
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [algorithm, n, r, p, saltValue, expectedValue] = encoded.split("$");
  const parsedN = Number.parseInt(n ?? "", 10);
  const parsedR = Number.parseInt(r ?? "", 10);
  const parsedP = Number.parseInt(p ?? "", 10);
  if (
    algorithm !== "scrypt" ||
    parsedN !== PASSWORD_N ||
    parsedR !== PASSWORD_R ||
    parsedP !== PASSWORD_P ||
    saltValue === undefined ||
    expectedValue === undefined
  ) {
    return false;
  }
  const salt = Buffer.from(saltValue, "base64url");
  const expected = Buffer.from(expectedValue, "base64url");
  if (salt.length !== 16 || expected.length !== PASSWORD_BYTES) {
    return false;
  }
  try {
    const actual = await derivePassword(password, salt, expected.length, {
      N: parsedN,
      r: parsedR,
      p: parsedP,
      maxmem: 64 * 1024 * 1024,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Wire format: `coord_pat_<id>.<secret>`.
 *
 * The fixed prefix makes a leaked credential recognisable to secret scanners
 * and greppable in logs. The id is carried in the clear so verification is a
 * single indexed lookup rather than a scan-and-compare over every token.
 *
 * The separator is a dot because both halves are base64url, whose alphabet
 * includes `-` and `_`. Splitting on an underscore would cut inside the id
 * whenever one happened to contain it, so roughly one token in six would fail
 * to authenticate at random.
 */
export const API_TOKEN_PREFIX = "coord_pat_";
const TOKEN_ID_BYTES = 9;
const TOKEN_SECRET_BYTES = 32;

export interface IssuedApiToken {
  record: {
    id: string;
    name: string;
    scopes: string[];
    organizationId: string | undefined;
    createdAt: string;
    expiresAt: string | undefined;
  };
  /** The only time the plaintext exists. It is never stored or recoverable. */
  token: string;
}

export function parseApiToken(
  value: string,
): { id: string; secret: string } | undefined {
  if (!value.startsWith(API_TOKEN_PREFIX)) {
    return undefined;
  }
  const body = value.slice(API_TOKEN_PREFIX.length);
  const separator = body.indexOf(".");
  if (separator < 1 || separator === body.length - 1) {
    return undefined;
  }
  return { id: body.slice(0, separator), secret: body.slice(separator + 1) };
}

/** Extracts a bearer credential, tolerating case variation in the scheme. */
export function parseBearer(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^bearer\s+(\S+)$/iu.exec(header.trim());
  return match?.[1];
}

export class AuthService {
  private readonly sessionTtlMs: number;
  private readonly defaultTokenDays: number;
  private readonly secureCookies: boolean;
  private readonly now: () => Date;

  public constructor(
    private readonly store: CoordinationStore,
    options: AuthServiceOptions = {},
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
    this.defaultTokenDays = options.defaultTokenDays ?? 90;
    this.secureCookies = options.secureCookies ?? false;
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs < 60_000) {
      throw new RangeError("Session lifetime must be at least one minute");
    }
  }

  public async bootstrap(input: {
    email: string;
    displayName: string;
    password: string;
    organizationName?: string;
  }): Promise<UserAccount> {
    if ((await this.store.countUsers()) !== 0) {
      throw new AuthenticationError(
        "Bootstrap is disabled after the first user is created",
        409,
        "bootstrap_complete",
      );
    }
    const user = await this.store.createUser({
      email: input.email,
      displayName: input.displayName,
      passwordDigest: await hashPassword(input.password),
      systemAdmin: true,
    });
    const organizations = await this.store.listOrganizations();
    const local = organizations.find((entry) => entry.id === "org_local");
    if (local !== undefined && input.organizationName !== undefined) {
      await this.store.updateOrganization(local.id, {
        name: input.organizationName,
      });
    }
    if (local !== undefined) {
      await this.store.saveMembership({
        organizationId: local.id,
        userId: user.id,
        role: "owner",
      });
    }
    return user;
  }

  /**
   * Creates an account for somebody nobody invited.
   *
   * Registration hands the new user their *own* organization and a project
   * inside it, rather than attaching them to whichever organization happens
   * to exist. Attaching them would be much worse than it sounds: an
   * organization role reaches every repository the organization holds, so one
   * sign-up form would hand a stranger everybody else's code. Their own
   * organization means the account is real and empty, which is what somebody
   * arriving to start a repository actually wants.
   *
   * They are not a system administrator. That is reserved for the bootstrap
   * owner, who set the control plane up; a self-registered user administers
   * their own organization and nothing beyond it.
   *
   * The email uniqueness check belongs to the store, which enforces it under
   * whatever concurrency the deployment has. A duplicate surfaces as the
   * store's own conflict rather than being pre-checked here, because a check
   * followed by an insert is a race.
   */
  public async register(input: {
    email: string;
    displayName: string;
    password: string;
    organizationName?: string;
  }): Promise<UserAccount> {
    const user = await this.store.createUser({
      email: input.email,
      displayName: input.displayName,
      passwordDigest: await hashPassword(input.password),
      systemAdmin: false,
    });
    // Slugs have to be unique across the deployment, and a display name is
    // neither unique nor URL-safe, so the user's own id is the only thing to
    // hand that is guaranteed both.
    const slug = `team-${user.id.replace(/^user_/u, "").slice(0, 12)}`;
    const organization = await this.store.createOrganization({
      slug,
      name:
        input.organizationName !== undefined && input.organizationName !== ""
          ? input.organizationName
          : `${input.displayName}'s team`,
    });
    await this.store.saveMembership({
      organizationId: organization.id,
      userId: user.id,
      role: "owner",
    });
    // A repository has to live in a project, so a brand new account with no
    // project could not do the first thing it came to do.
    await this.store.createProject({
      organizationId: organization.id,
      slug: "default",
      name: "My Project",
      description: "Repositories you create live here.",
    });
    return user;
  }

  public async login(input: {
    email: string;
    password: string;
    ipAddress: string;
    userAgent: string;
  }): Promise<SessionIssueResult> {
    const user = await this.store.getUserByEmail(input.email);
    // Always perform the same expensive derivation so login timing does not
    // reveal whether an email address exists or an account is disabled.
    const passwordValid = await verifyPassword(
      input.password,
      user?.passwordDigest ?? DUMMY_PASSWORD_DIGEST,
    );
    const valid =
      user !== undefined &&
      !user.disabled &&
      passwordValid;
    if (!valid || user === undefined) {
      throw new AuthenticationError("Email or password is incorrect");
    }
    return await this.issueSession(user, input.ipAddress, input.userAgent);
  }

  public async issueSession(
    user: UserAccount,
    ipAddress: string,
    userAgent: string,
  ): Promise<SessionIssueResult> {
    const id = createId("auth");
    const secret = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    await this.store.createAuthSession({
      id,
      userId: user.id,
      secretHash: digest(secret),
      csrfHash: digest(csrfToken),
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      lastSeenAt: now.toISOString(),
      ipAddress,
      userAgent: userAgent.slice(0, 512),
    });
    const memberships = await this.membershipsFor(user);
    const maxAgeSeconds = Math.floor(this.sessionTtlMs / 1000);
    return {
      principal: {
        user: publicUser(user),
        credential: "session",
        sessionId: id,
        memberships,
      },
      csrfToken,
      cookies: [
        cookie(SESSION_COOKIE, `${id}.${secret}`, {
          maxAgeSeconds,
          httpOnly: true,
          secure: this.secureCookies,
        }),
        cookie(CSRF_COOKIE, csrfToken, {
          maxAgeSeconds,
          httpOnly: false,
          secure: this.secureCookies,
        }),
      ],
    };
  }

  /**
   * Mints a token for `user`.
   *
   * Scopes are validated by the caller against what the user may actually do;
   * this records them verbatim. A token can therefore never be used to widen
   * a role, only to narrow one.
   */
  public async issueApiToken(input: {
    user: UserAccount;
    name: string;
    scopes: readonly string[];
    organizationId?: string;
    expiresInDays?: number;
    createdBySession?: string;
  }): Promise<IssuedApiToken> {
    const name = input.name.trim();
    if (name.length === 0 || name.length > 120) {
      throw new AuthenticationError(
        "Token name must contain between 1 and 120 characters",
        400,
        "invalid_token_name",
      );
    }
    if (input.scopes.length === 0) {
      throw new AuthenticationError(
        "A token must be granted at least one scope",
        400,
        "invalid_token_scopes",
      );
    }

    const days = input.expiresInDays ?? this.defaultTokenDays;
    if (days !== 0 && (!Number.isSafeInteger(days) || days < 1 || days > 365)) {
      throw new AuthenticationError(
        "Token lifetime must be 0 (never expires) or between 1 and 365 days",
        400,
        "invalid_token_expiry",
      );
    }

    const id = randomBytes(TOKEN_ID_BYTES).toString("base64url");
    const secret = randomBytes(TOKEN_SECRET_BYTES).toString("base64url");
    const now = this.now();
    const expiresAt =
      days === 0
        ? undefined
        : new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
    const scopes = [...new Set(input.scopes)];

    await this.store.createApiToken({
      id,
      userId: input.user.id,
      organizationId: input.organizationId,
      name,
      secretHash: digest(secret),
      scopes,
      createdAt: now.toISOString(),
      createdBySession: input.createdBySession,
      expiresAt,
      lastUsedAt: undefined,
      lastUsedIp: undefined,
      revokedAt: undefined,
      revokedReason: undefined,
    });

    return {
      record: {
        id,
        name,
        scopes,
        organizationId: input.organizationId,
        createdAt: now.toISOString(),
        expiresAt,
      },
      token: `${API_TOKEN_PREFIX}${id}.${secret}`,
    };
  }

  /**
   * Resolves a bearer token to a principal.
   *
   * Every rejection path produces the same generic message so a caller cannot
   * distinguish "unknown token" from "revoked" or "expired" by probing.
   */
  public async authenticateToken(
    value: string,
    ipAddress: string,
  ): Promise<AuthenticatedPrincipal> {
    const parsed = parseApiToken(value);
    if (parsed === undefined) {
      throw new AuthenticationError("API token is invalid");
    }
    const token = await this.store.getApiToken(parsed.id);
    const nowIso = this.now().toISOString();
    if (
      token === undefined ||
      token.revokedAt !== undefined ||
      (token.expiresAt !== undefined && token.expiresAt <= nowIso) ||
      !equalDigest(parsed.secret, token.secretHash)
    ) {
      throw new AuthenticationError("API token is invalid");
    }

    const user = await this.store.getUser(token.userId);
    if (user === undefined || user.disabled) {
      throw new AuthenticationError("API token is invalid");
    }

    // Written at most once a minute: last-used is for operators auditing stale
    // credentials, not an access log, and a write per request would be costly.
    const oneMinuteAgo = this.now().getTime() - 60_000;
    if (
      token.lastUsedAt === undefined ||
      Date.parse(token.lastUsedAt) < oneMinuteAgo
    ) {
      await this.store.touchApiToken(token.id, nowIso, ipAddress);
    }

    return {
      user: publicUser(user),
      credential: "api_token",
      token: {
        id: token.id,
        name: token.name,
        scopes: token.scopes,
        organizationId: token.organizationId,
      },
      memberships: await this.membershipsFor(user),
    };
  }

  public async listApiTokens(userId: string): Promise<
    Array<{
      id: string;
      name: string;
      scopes: string[];
      organizationId: string | undefined;
      createdAt: string;
      expiresAt: string | undefined;
      lastUsedAt: string | undefined;
      revokedAt: string | undefined;
      active: boolean;
    }>
  > {
    const nowIso = this.now().toISOString();
    return (await this.store.listApiTokens(userId)).map((token) => ({
      id: token.id,
      name: token.name,
      scopes: token.scopes,
      organizationId: token.organizationId,
      createdAt: token.createdAt,
      expiresAt: token.expiresAt,
      lastUsedAt: token.lastUsedAt,
      revokedAt: token.revokedAt,
      active:
        token.revokedAt === undefined &&
        (token.expiresAt === undefined || token.expiresAt > nowIso),
    }));
  }

  /** Revokes a token the actor owns. Idempotent. */
  public async revokeApiToken(
    actor: AuthenticatedPrincipal,
    tokenId: string,
    reason: string,
  ): Promise<void> {
    const token = await this.store.getApiToken(tokenId);
    if (
      token === undefined ||
      (token.userId !== actor.user.id && !actor.user.systemAdmin)
    ) {
      throw new AuthenticationError("Token was not found", 404, "not_found");
    }
    await this.store.revokeApiToken(tokenId, this.now().toISOString(), reason);
  }

  public async authenticate(
    cookieHeader: string | undefined,
  ): Promise<AuthenticatedPrincipal> {
    const value = parseCookies(cookieHeader).get(SESSION_COOKIE);
    if (value === undefined) {
      throw new AuthenticationError("Sign in is required");
    }
    const separator = value.indexOf(".");
    if (separator < 1) {
      throw new AuthenticationError("Session cookie is invalid");
    }
    const id = value.slice(0, separator);
    const secret = value.slice(separator + 1);
    const session = await this.store.getAuthSession(id);
    if (
      session === undefined ||
      session.expiresAt <= this.now().toISOString() ||
      !equalDigest(secret, session.secretHash)
    ) {
      if (session !== undefined) {
        await this.store.revokeAuthSession(id);
      }
      throw new AuthenticationError("Session has expired");
    }
    const user = await this.store.getUser(session.userId);
    if (user === undefined || user.disabled) {
      await this.store.revokeAuthSession(id);
      throw new AuthenticationError("User account is unavailable");
    }
    const oneMinuteAgo = this.now().getTime() - 60_000;
    if (Date.parse(session.lastSeenAt) < oneMinuteAgo) {
      await this.store.touchAuthSession(id, this.now().toISOString());
    }
    return {
      user: publicUser(user),
      credential: "session",
      sessionId: id,
      memberships: await this.membershipsFor(user),
    };
  }

  /**
   * Revalidates an already authenticated long-lived channel.
   *
   * The original secret is intentionally not retained by WebSocket clients.
   * Identity was proven during the upgrade; refresh checks everything that can
   * change afterwards: session/token lifetime and revocation, account state,
   * token scope, and organization membership.
   */
  public async refresh(
    principal: AuthenticatedPrincipal,
  ): Promise<AuthenticatedPrincipal> {
    const nowIso = this.now().toISOString();
    if (principal.credential === "session") {
      if (principal.sessionId === undefined) {
        throw new AuthenticationError("Session has expired");
      }
      const session = await this.store.getAuthSession(principal.sessionId);
      if (
        session === undefined ||
        session.userId !== principal.user.id ||
        session.expiresAt <= nowIso
      ) {
        throw new AuthenticationError("Session has expired");
      }
      const user = await this.store.getUser(session.userId);
      if (user === undefined || user.disabled) {
        throw new AuthenticationError("User account is unavailable");
      }
      return {
        user: publicUser(user),
        credential: "session",
        sessionId: session.id,
        memberships: await this.membershipsFor(user),
      };
    }

    const identity = principal.token;
    if (identity === undefined) {
      throw new AuthenticationError("API token is invalid");
    }
    const token = await this.store.getApiToken(identity.id);
    if (
      token === undefined ||
      token.userId !== principal.user.id ||
      token.revokedAt !== undefined ||
      (token.expiresAt !== undefined && token.expiresAt <= nowIso)
    ) {
      throw new AuthenticationError("API token is invalid");
    }
    const user = await this.store.getUser(token.userId);
    if (user === undefined || user.disabled) {
      throw new AuthenticationError("API token is invalid");
    }
    return {
      user: publicUser(user),
      credential: "api_token",
      token: {
        id: token.id,
        name: token.name,
        scopes: token.scopes,
        organizationId: token.organizationId,
      },
      memberships: await this.membershipsFor(user),
    };
  }

  public async verifyCsrf(
    principal: AuthenticatedPrincipal,
    cookieHeader: string | undefined,
    headerToken: string | undefined,
  ): Promise<void> {
    if (principal.credential !== "session" || principal.sessionId === undefined) {
      // Bearer tokens are not attached by a browser, so there is no
      // cross-site request to forge and no CSRF token to check.
      return;
    }
    const cookieToken = parseCookies(cookieHeader).get(CSRF_COOKIE);
    const session = await this.store.getAuthSession(principal.sessionId);
    if (
      cookieToken === undefined ||
      headerToken === undefined ||
      cookieToken !== headerToken ||
      session === undefined ||
      !equalDigest(headerToken, session.csrfHash)
    ) {
      throw new AuthenticationError(
        "CSRF token is missing or invalid",
        403,
        "csrf_failed",
      );
    }
  }

  public async logout(sessionId: string): Promise<string[]> {
    await this.store.revokeAuthSession(sessionId);
    return [
      cookie(SESSION_COOKIE, "", {
        maxAgeSeconds: 0,
        httpOnly: true,
        secure: this.secureCookies,
      }),
      cookie(CSRF_COOKIE, "", {
        maxAgeSeconds: 0,
        httpOnly: false,
        secure: this.secureCookies,
      }),
    ];
  }

  public roleFor(
    principal: AuthenticatedPrincipal,
    organizationId: string,
  ): OrganizationRole | undefined {
    return principal.memberships.find(
      (membership) => membership.organizationId === organizationId,
    )?.role;
  }

  private async membershipsFor(
    user: UserAccount,
  ): Promise<OrganizationMembership[]> {
    if (!user.systemAdmin) {
      const organizations = await this.store.listOrganizations(user.id);
      return (
        await Promise.all(
          organizations.map(
            async (organization) =>
              await this.store.getMembership(organization.id, user.id),
          ),
        )
      ).filter(
        (membership): membership is OrganizationMembership =>
          membership !== undefined,
      );
    }
    const organizations = await this.store.listOrganizations();
    const memberships = await Promise.all(
      organizations.map(
        async (organization) =>
          (await this.store.getMembership(organization.id, user.id)) ?? {
            organizationId: organization.id,
            userId: user.id,
            role: "owner" as const,
            createdAt: user.createdAt,
          },
      ),
    );
    return memberships;
  }
}
