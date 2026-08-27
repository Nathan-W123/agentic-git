import {
  createHash,
  randomBytes,
  randomInt,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";

import type {
  CoordinationStore,
  OrganizationMembership,
  OrganizationRole,
  PasswordResetRecord,
  SignupIntentRecord,
  UserAccount,
} from "@coord/persistence";
import { createId } from "@coord/shared-types";

import { mailDeliveryMode, type Mailer } from "./mailer.js";
import { paymentsEnabled, trialEndsAtFrom } from "./billing.js";

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
  /**
   * Marks session cookies `Secure` on every deployment.
   *
   * Left off, cookies are still marked `Secure` on any request that actually
   * arrived over TLS — see the `secure` argument on {@link
   * AuthService.issueSession}. Turning it on forces the flag on regardless,
   * which is right for a deployment that is only ever reached over HTTPS and
   * wrong for a plain-HTTP one, where the browser would refuse to send the
   * cookie back at all and sign-in would appear to fail silently.
   */
  secureCookies?: boolean;
  /** Failed sign-ins for one account before it is locked. */
  loginFailureLimit?: number;
  /** How long an account stays locked, and how long failures accumulate. */
  loginLockoutMs?: number;
  /**
   * How long a password reset link works for. One hour by default: long
   * enough to survive a slow mail relay, short enough that a link sitting in
   * an old mailbox is not a standing key to the account.
   */
  passwordResetTtlMs?: number;
  /** Delivers the one-time code required to finish self-service sign-up. */
  mailer?: Mailer;
  /** How long a registration code remains usable. Ten minutes by default. */
  registrationTtlMs?: number;
  /** Wrong codes allowed before a registration challenge is closed. */
  registrationAttemptLimit?: number;
  now?: () => Date;
}

/** Account details held only until the mailbox has been proved. */
export interface PendingRegistration {
  id: string;
  email: string;
  displayName: string;
  organizationName?: string;
  passwordDigest: string;
  codeHash: string;
  expiresAt: string;
  failedAttempts: number;
}

/** The opaque challenge returned after the confirmation mail is accepted. */
export interface RegistrationStartResult {
  registrationId: string;
  expiresAt: string;
  /**
   * Where the code went. `mailbox` means a relay accepted it; `log` means this
   * deployment has none configured and the code was written to the control
   * plane's log instead, which the person waiting for an email has to be told
   * rather than left to wonder about.
   */
  delivery: "mailbox" | "log";
}

type ClosedRegistrationReason = "used" | "expired" | "exhausted";

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

/** One account's recent failed sign-ins. */
interface LoginFailures {
  count: number;
  firstAt: number;
  lockedUntil: number;
}

/** Beyond this many tracked accounts, expired entries are swept. */
const LOGIN_FAILURE_TABLE_LIMIT = 4096;

export class AuthService {
  private readonly sessionTtlMs: number;
  private readonly defaultTokenDays: number;
  private readonly secureCookies: boolean;
  private readonly loginFailureLimit: number;
  private readonly loginLockoutMs: number;
  /**
   * Failed sign-ins, keyed by the address that was typed.
   *
   * Keyed by what was submitted rather than by an account id, for two
   * reasons. The obvious one is that a guess at an address with no account
   * must be counted the same way, or the lockout itself would answer "does
   * this account exist". The other is that the rate limiter in front of this
   * keys on a network address, which behind a reverse proxy is one address for
   * the whole deployment — so it throttles everybody together and throttles
   * password guessing against one account not at all.
   *
   * In memory rather than in the store: a lockout is a few minutes long, a
   * restart clears it, and that is the right trade for something whose failure
   * mode is locking out a legitimate person. It is per control plane, which
   * matches how the rate limiter already works.
   */
  private readonly loginFailures = new Map<string, LoginFailures>();
  private readonly passwordResetTtlMs: number;
  private readonly registrationMailer: Mailer | undefined;
  private readonly registrationTtlMs: number;
  private readonly registrationAttemptLimit: number;
  private readonly pendingRegistrations = new Map<string, PendingRegistration>();
  private readonly closedRegistrations = new Map<
    string,
    { reason: ClosedRegistrationReason; forgetAt: number }
  >();
  private readonly now: () => Date;

  public constructor(
    private readonly store: CoordinationStore,
    options: AuthServiceOptions = {},
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
    this.defaultTokenDays = options.defaultTokenDays ?? 90;
    this.secureCookies = options.secureCookies ?? false;
    this.loginFailureLimit = options.loginFailureLimit ?? 10;
    this.loginLockoutMs = options.loginLockoutMs ?? 15 * 60 * 1000;
    this.passwordResetTtlMs = options.passwordResetTtlMs ?? 60 * 60 * 1000;
    this.registrationMailer = options.mailer;
    this.registrationTtlMs = options.registrationTtlMs ?? 10 * 60 * 1000;
    this.registrationAttemptLimit = options.registrationAttemptLimit ?? 5;
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs < 60_000) {
      throw new RangeError("Session lifetime must be at least one minute");
    }
    if (
      !Number.isSafeInteger(this.registrationTtlMs) ||
      this.registrationTtlMs < 60_000
    ) {
      throw new RangeError("Registration lifetime must be at least one minute");
    }
    if (
      !Number.isSafeInteger(this.registrationAttemptLimit) ||
      this.registrationAttemptLimit < 1
    ) {
      throw new RangeError("Registration attempt limit must be positive");
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
      // Said outright rather than inherited from a migration. A missing
      // subscription row is no entitlement now, and this organization's row
      // only ever existed because a backfill happened to reach it — which is
      // true of a store that runs migrations and false of one that does not.
      // The deployment's own organization is not something anybody invoices,
      // so it is comped, and now it says so.
      if ((await this.store.getSubscription(local.id)) === undefined) {
        await this.store.saveSubscription({
          organizationId: local.id,
          status: "comped",
        });
      }
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
   * The early email lookup gives an explicit registration error, while the
   * store's unique constraint remains the final authority under concurrency.
   */
  private async register(input: {
    email: string;
    displayName: string;
    passwordDigest: string;
    organizationName?: string;
  }): Promise<UserAccount> {
    // One transaction, so the five writes below land together or not at all.
    //
    // The ordering underneath it is kept rather than reverted: it is what
    // makes the failure survivable on a backend where the transaction is a
    // snapshot rather than a write-ahead log, and it costs nothing to keep.
    return await this.store.runInTransaction(async (store) => {
    // The account is built back to front, and that is the second half of the
    // safety property here.
    //
    // These are five separate writes and the store has no transaction to put
    // them in, so any one can fail with the earlier ones already durable.
    // Done in the obvious order — user first — a failure left a user row with
    // a working password and nothing else: able to sign in forever, belonging
    // to nothing, unable to create a repository, and holding the only claim
    // on that email address, so signing up again was refused too. No path in
    // the product finished the job and none undid it. That is not
    // hypothetical; it happened, and the account it happened to could still
    // log in.
    //
    // So everything that does not need a user is written first, and the user
    // second to last. A failure before the account exists leaves an
    // organization nobody belongs to — invisible, unreachable, costing
    // nothing — while the person sees an error and can try again with the
    // same address, which is the outcome they can actually act on. Only the
    // final membership write can still strand somebody, and it is the
    // smallest of the five: an upsert into a two-column table whose foreign
    // keys were both satisfied by the writes immediately before it.
    //
    // The slug is random rather than derived from the user id, because the
    // user id does not exist yet. It is not shown anywhere a person reads.
    const slug = `team-${randomBytes(8).toString("hex")}`;
    const organization = await store.createOrganization({
      slug,
      name:
        input.organizationName !== undefined && input.organizationName !== ""
          ? input.organizationName
          : `${input.displayName}'s team`,
    });
    // A repository has to live in a project, so a brand new account with no
    // project could not do the first thing it came to do.
    await store.createProject({
      organizationId: organization.id,
      slug: "default",
      name: "My Project",
      description: "Repositories you create live here.",
    });
    // The entitlement is written here either way, because a missing row is no
    // entitlement at all.
    //
    // With payments off it is `comped`: nobody is being invoiced, so there is
    // nothing for a trial to run out into and a countdown would only be a
    // clock ticking toward a paywall that does not exist. With payments on the
    // trial starts here rather than at first use — starting it on the first
    // dispatch would mean an account that signed up, looked around, and came
    // back a month later still had its whole trial, which sounds generous and
    // is really just an unbounded free tier wearing a trial's name.
    await store.saveSubscription(
      paymentsEnabled()
        ? {
            organizationId: organization.id,
            status: "trialing",
            trialEndsAt: trialEndsAtFrom(),
          }
        : { organizationId: organization.id, status: "comped" },
    );
    const user = await store.createUser({
      email: input.email,
      displayName: input.displayName,
      passwordDigest: input.passwordDigest,
      systemAdmin: false,
    });
    await store.saveMembership({
      organizationId: organization.id,
      userId: user.id,
      role: "owner",
    });
    return user;
    });
  }

  /**
   * Creates the account in one step, with no mailbox challenge at all.
   *
   * This is what sign-up does while email confirmation is switched off: the
   * address is taken on trust, the account exists as soon as the form is
   * submitted, and the caller can issue a session immediately. The two-step
   * path below is untouched and comes back the moment a deployment asks for
   * it, so nothing here has to be rebuilt to turn confirmation on.
   */
  /**
   * Builds the account a cleared payment has already paid for.
   *
   * The organization, its project and its subscription were created by the
   * webhook when the money confirmed; what is missing is the person. So this
   * is the ordinary provisioning sequence with its expensive half already
   * done, and it runs in the same order for the same reason: the user is
   * written before the membership because the membership points at it, and
   * nothing before that point can strand anybody.
   *
   * Claiming twice builds one account. `attachSignupIntentUser` is
   * conditional, so of two requests racing the same link exactly one may
   * proceed — the loser is handed the account the winner made rather than an
   * error, because both of them are the same person pressing the same button.
   */
  public async completePaidSignup(input: {
    intent: SignupIntentRecord;
    displayName: string;
    password: string;
  }): Promise<UserAccount> {
    const existing = input.intent.userId;
    if (existing !== undefined) {
      const already = await this.store.getUser(existing);
      if (already !== undefined) {
        return already;
      }
    }
    assertPassword(input.password);
    const displayName = input.displayName.trim();
    if (displayName === "") {
      throw new AuthenticationError(
        "A name is required",
        400,
        "invalid_request",
      );
    }
    // Between paying and arriving here somebody could have registered this
    // address by another route. Refusing is right — the money is not lost,
    // it bought a subscription that the existing account can be moved onto —
    // but it must not be silently attached to a stranger's account.
    if ((await this.store.getUserByEmail(input.intent.email)) !== undefined) {
      throw new AuthenticationError(
        "An account already uses that email address",
        409,
        "account_exists",
      );
    }
    const passwordDigest = await hashPassword(input.password);
    // Hashing first, outside the transaction: scrypt is deliberately slow and
    // holding a write lock across it would serialise every other writer
    // behind somebody's password.
    return await this.store.runInTransaction(async (store) => {
    const user = await store.createUser({
      email: input.intent.email,
      displayName,
      passwordDigest,
      systemAdmin: false,
    });
    if (!(await store.attachSignupIntentUser(input.intent.id, user.id))) {
      // Somebody else won the race between the two reads above. Their account
      // is the real one; hand it back rather than leaving this caller with a
      // second.
      const winner = (await store.getSignupIntent(input.intent.id))?.userId;
      const account = winner === undefined ? undefined : await store.getUser(winner);
      if (account !== undefined) {
        return account;
      }
    }
    await store.saveMembership({
      organizationId: input.intent.organizationId,
      userId: user.id,
      role: "owner",
    });
    return user;
    });
  }

  public async registerUnconfirmed(input: {
    email: string;
    displayName: string;
    password: string;
    organizationName?: string;
  }): Promise<UserAccount> {
    const email = input.email.trim().toLowerCase();
    if ((await this.store.getUserByEmail(email)) !== undefined) {
      throw new AuthenticationError(
        "An account already uses that email address",
        409,
        "account_exists",
      );
    }
    // Hashed before the account is created, so a password the policy refuses
    // leaves nothing behind.
    const passwordDigest = await hashPassword(input.password);
    return await this.register({
      email,
      displayName: input.displayName.trim(),
      passwordDigest,
      ...(input.organizationName === undefined
        ? {}
        : { organizationName: input.organizationName.trim() }),
    });
  }

  /**
   * Starts self-service registration without creating any durable account.
   *
   * The password is digested before it is retained and the confirmation code
   * is retained only as a hash. The pending record is installed only after
   * mail delivery succeeds, so a relay failure leaves no credential-shaped
   * state that can later be confirmed.
   *
   * The result says which of the two things happened: a relay took the code,
   * or this deployment has none and wrote it to the log. Both leave a usable
   * challenge, and only one of them puts an email in somebody's inbox.
   */
  public async startRegistration(input: {
    email: string;
    displayName: string;
    password: string;
    organizationName?: string;
  }): Promise<RegistrationStartResult> {
    const email = input.email.trim().toLowerCase();
    if ((await this.store.getUserByEmail(email)) !== undefined) {
      throw new AuthenticationError(
        "An account already uses that email address",
        409,
        "account_exists",
      );
    }
    const passwordDigest = await hashPassword(input.password);
    const now = this.now();
    this.sweepRegistrationState(now.getTime());
    // A newer code supersedes any older code for the same address. Removing
    // it before delivery also means a failed replacement does not leave a
    // different, still-usable challenge behind.
    for (const [id, pending] of this.pendingRegistrations) {
      if (pending.email === email) {
        this.pendingRegistrations.delete(id);
      }
    }

    const id = `reg_${randomBytes(18).toString("base64url")}`;
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const expiresAt = new Date(
      now.getTime() + this.registrationTtlMs,
    ).toISOString();
    const pending: PendingRegistration = {
      id,
      email,
      displayName: input.displayName.trim(),
      ...(input.organizationName === undefined
        ? {}
        : { organizationName: input.organizationName.trim() }),
      passwordDigest,
      codeHash: digest(`${id}:${code}`),
      expiresAt,
      failedAttempts: 0,
    };
    if (this.registrationMailer === undefined) {
      throw new AuthenticationError(
        "The confirmation email could not be delivered",
        503,
        "registration_mail_delivery_failed",
      );
    }
    try {
      await this.registrationMailer({
        to: email,
        subject: "Confirm your Kumi account",
        text: [
          `Your Kumi confirmation code is ${code}.`,
          "",
          `It expires at ${expiresAt}.`,
          "If you did not request this account, you can ignore this message.",
        ].join("\n"),
      });
    } catch {
      throw new AuthenticationError(
        "The confirmation email could not be delivered",
        503,
        "registration_mail_delivery_failed",
      );
    }
    this.pendingRegistrations.set(id, pending);
    return {
      registrationId: id,
      expiresAt,
      delivery:
        mailDeliveryMode(this.registrationMailer) === "log"
          ? "log"
          : "mailbox",
    };
  }

  /** Creates the account only after the one-time mailbox code is accepted. */
  public async confirmRegistration(input: {
    registrationId: string;
    code: string;
  }): Promise<UserAccount> {
    const now = this.now().getTime();
    this.sweepRegistrationState(now);
    const pending = this.pendingRegistrations.get(input.registrationId);
    if (pending === undefined) {
      this.throwClosedRegistration(input.registrationId);
    }
    if (Date.parse(pending.expiresAt) <= now) {
      this.closeRegistration(pending.id, "expired", now);
      throw new AuthenticationError(
        "This confirmation code has expired",
        400,
        "registration_expired",
      );
    }
    if (pending.failedAttempts >= this.registrationAttemptLimit) {
      this.closeRegistration(pending.id, "exhausted", now);
      throw new AuthenticationError(
        "Too many incorrect confirmation codes were entered",
        429,
        "registration_attempts_exhausted",
      );
    }
    if (!equalDigest(`${pending.id}:${input.code.trim()}`, pending.codeHash)) {
      pending.failedAttempts += 1;
      if (pending.failedAttempts >= this.registrationAttemptLimit) {
        this.closeRegistration(pending.id, "exhausted", now);
        throw new AuthenticationError(
          "Too many incorrect confirmation codes were entered",
          429,
          "registration_attempts_exhausted",
        );
      }
      throw new AuthenticationError(
        "The confirmation code is incorrect",
        400,
        "registration_code_invalid",
      );
    }

    // Consumed before the first await below. Two confirmations racing in one
    // process therefore cannot both reach account creation.
    this.closeRegistration(pending.id, "used", now);
    if ((await this.store.getUserByEmail(pending.email)) !== undefined) {
      throw new AuthenticationError(
        "An account already uses that email address",
        409,
        "account_exists",
      );
    }
    return await this.register({
      email: pending.email,
      displayName: pending.displayName,
      passwordDigest: pending.passwordDigest,
      ...(pending.organizationName === undefined
        ? {}
        : { organizationName: pending.organizationName }),
    });
  }

  private closeRegistration(
    id: string,
    reason: ClosedRegistrationReason,
    now: number,
  ): void {
    this.pendingRegistrations.delete(id);
    this.closedRegistrations.set(id, {
      reason,
      forgetAt: now + this.registrationTtlMs,
    });
  }

  private throwClosedRegistration(id: string): never {
    const closed = this.closedRegistrations.get(id)?.reason;
    if (closed === "used") {
      throw new AuthenticationError(
        "This registration challenge has already been used",
        409,
        "registration_already_used",
      );
    }
    if (closed === "expired") {
      throw new AuthenticationError(
        "This confirmation code has expired",
        400,
        "registration_expired",
      );
    }
    if (closed === "exhausted") {
      throw new AuthenticationError(
        "Too many incorrect confirmation codes were entered",
        429,
        "registration_attempts_exhausted",
      );
    }
    throw new AuthenticationError(
      "This registration challenge is not valid",
      400,
      "registration_invalid",
    );
  }

  private sweepRegistrationState(now: number): void {
    for (const [id, pending] of this.pendingRegistrations) {
      if (Date.parse(pending.expiresAt) <= now) {
        this.closeRegistration(id, "expired", now);
      }
    }
    for (const [id, closed] of this.closedRegistrations) {
      if (closed.forgetAt <= now) {
        this.closedRegistrations.delete(id);
      }
    }
  }

  public async login(input: {
    email: string;
    password: string;
    ipAddress: string;
    userAgent: string;
    /** Whether the request arrived over TLS. See {@link issueSession}. */
    secure?: boolean;
  }): Promise<SessionIssueResult> {
    const attempted = input.email.trim().toLowerCase();
    const startedAt = this.now().getTime();
    const locked = this.loginFailures.get(attempted);
    if (locked !== undefined && locked.lockedUntil > startedAt) {
      throw new AuthenticationError(
        "Too many failed sign-in attempts for this account. Try again shortly.",
        429,
        "login_locked",
      );
    }
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
      this.recordLoginFailure(attempted, startedAt);
      throw new AuthenticationError("Email or password is incorrect");
    }
    this.loginFailures.delete(attempted);
    return await this.issueSession(
      user,
      input.ipAddress,
      input.userAgent,
      input.secure,
    );
  }

  /**
   * Mints a reset link for an account, if that address has one.
   *
   * Returns nothing when the address is unknown, and the caller answers the
   * same way either way: a form that says "no account for that address" is an
   * address oracle, and this one can be posted to without any credential at
   * all.
   *
   * Outstanding resets for the account are dropped first, so requesting a
   * second link invalidates the first. Otherwise every request would leave
   * another working key behind, and a person who requests three because the
   * first was slow to arrive would be leaving two of them lying in a mailbox.
   */
  public async requestPasswordReset(email: string): Promise<
    | {
        user: UserAccount;
        token: string;
        expiresAt: string;
      }
    | undefined
  > {
    const user = await this.store.getUserByEmail(email);
    if (user === undefined || user.disabled) {
      return undefined;
    }
    await this.store.deletePasswordResetsForUser(user.id);
    const id = `pwr_${randomBytes(9).toString("base64url")}`;
    const secret = randomBytes(32).toString("base64url");
    const now = this.now();
    const expiresAt = new Date(
      now.getTime() + this.passwordResetTtlMs,
    ).toISOString();
    await this.store.createPasswordReset({
      id,
      userId: user.id,
      email: user.email,
      secretHash: hashSecret(secret),
      createdAt: now.toISOString(),
      expiresAt,
      consumedAt: undefined,
    });
    // The only time the secret exists. It is stored hashed, so a lost link is
    // reissued rather than looked up.
    return { user, token: `${id}.${secret}`, expiresAt };
  }

  /**
   * The account a reset link belongs to, or nothing if it is not usable.
   *
   * Every way a link can be wrong — unknown, mistyped, already used, expired,
   * or issued to an address the account no longer has — comes back the same,
   * so the form behind it cannot be used to learn anything about who exists.
   */
  public async findPasswordReset(
    token: string,
  ): Promise<{ reset: PasswordResetRecord; user: UserAccount } | undefined> {
    const separator = token.indexOf(".");
    if (separator < 1) {
      return undefined;
    }
    const reset = await this.store.getPasswordReset(token.slice(0, separator));
    if (
      reset === undefined ||
      !secretMatches(token.slice(separator + 1), reset.secretHash) ||
      reset.consumedAt !== undefined ||
      Date.parse(reset.expiresAt) <= this.now().getTime()
    ) {
      return undefined;
    }
    const user = await this.store.getUser(reset.userId);
    if (
      user === undefined ||
      user.disabled ||
      // The address is re-checked because the link's authority comes from the
      // mailbox it was sent to. If the account has since moved to another
      // address, that mailbox is no longer proof of anything.
      user.email.toLowerCase() !== reset.email.toLowerCase()
    ) {
      return undefined;
    }
    return { reset, user };
  }

  /**
   * Sets a new password from a reset link and signs the person in.
   *
   * Consuming the link is a conditional update in the store, so two requests
   * racing the same link cannot both succeed. Every other session the account
   * has is revoked: a reset is the remedy for an account somebody else may be
   * holding, and leaving their session alive would make it no remedy at all.
   */
  public async completePasswordReset(input: {
    token: string;
    password: string;
    ipAddress: string;
    userAgent: string;
    secure?: boolean;
  }): Promise<SessionIssueResult> {
    const found = await this.findPasswordReset(input.token);
    if (found === undefined) {
      throw new AuthenticationError(
        "This password reset link is no longer valid. Request a new one.",
        400,
        "reset_invalid",
      );
    }
    // Hashed before the link is spent, so a password the policy refuses does
    // not burn the one link the person has.
    const passwordDigest = await hashPassword(input.password);
    const consumed = await this.store.consumePasswordReset(
      found.reset.id,
      this.now().toISOString(),
    );
    if (!consumed) {
      throw new AuthenticationError(
        "This password reset link has already been used.",
        400,
        "reset_invalid",
      );
    }
    const user = await this.store.updateUser(found.user.id, {
      passwordDigest,
    });
    await this.store.revokeUserSessions(user.id);
    await this.store.deletePasswordResetsForUser(user.id);
    // A lockout from the guessing that may have prompted the reset would
    // otherwise keep the owner out of the account they have just recovered.
    this.loginFailures.delete(user.email.trim().toLowerCase());
    return await this.issueSession(
      user,
      input.ipAddress,
      input.userAgent,
      input.secure,
    );
  }

  /**
   * Counts one failure and locks the account once they pile up.
   *
   * The window and the lockout are the same length, so a run of wrong
   * passwords spread thinly enough never locks anything: the count resets as
   * soon as the oldest failure in the run falls out of the window.
   */
  private recordLoginFailure(attempted: string, now: number): void {
    const existing = this.loginFailures.get(attempted);
    const record: LoginFailures =
      existing === undefined || now - existing.firstAt > this.loginLockoutMs
        ? { count: 0, firstAt: now, lockedUntil: 0 }
        : existing;
    record.count += 1;
    if (record.count >= this.loginFailureLimit) {
      record.lockedUntil = now + this.loginLockoutMs;
      record.count = 0;
      record.firstAt = now;
    }
    this.loginFailures.set(attempted, record);
    if (this.loginFailures.size > LOGIN_FAILURE_TABLE_LIMIT) {
      for (const [key, value] of this.loginFailures) {
        if (value.lockedUntil <= now && now - value.firstAt > this.loginLockoutMs) {
          this.loginFailures.delete(key);
        }
      }
    }
  }

  /**
   * Starts a session and returns the cookies that carry it.
   *
   * `secure` is what the request itself said: true when it arrived over TLS.
   * Marking the cookie `Secure` is only correct when it did — set
   * unconditionally it breaks every plain-HTTP deployment, because the browser
   * then declines to send the cookie back and sign-in looks like it silently
   * failed. `secureCookies` still forces it on for a deployment that knows it
   * is always behind HTTPS.
   */
  public async issueSession(
    user: UserAccount,
    ipAddress: string,
    userAgent: string,
    secure?: boolean,
  ): Promise<SessionIssueResult> {
    const secureCookie = this.secureCookies || secure === true;
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
          secure: secureCookie,
        }),
        cookie(CSRF_COOKIE, csrfToken, {
          maxAgeSeconds,
          httpOnly: false,
          secure: secureCookie,
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

  public async logout(sessionId: string, secure?: boolean): Promise<string[]> {
    await this.store.revokeAuthSession(sessionId);
    // The clearing cookie has to carry the same attributes as the one it is
    // replacing, or the browser keeps the original alongside it.
    const secureCookie = this.secureCookies || secure === true;
    return [
      cookie(SESSION_COOKIE, "", {
        maxAgeSeconds: 0,
        httpOnly: true,
        secure: secureCookie,
      }),
      cookie(CSRF_COOKIE, "", {
        maxAgeSeconds: 0,
        httpOnly: false,
        secure: secureCookie,
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
            // Synthesised for a system administrator, who holds every
            // organization by virtue of running the deployment. Nobody bought
            // this seat, so it must never appear on anyone's invoice.
            comped: true,
            createdAt: user.createdAt,
          },
      ),
    );
    return memberships;
  }
}
