/**
 * Small decisions the gateway makes everywhere: what a caller may see of a
 * record, how an environment variable reads, whether two secrets match.
 *
 * `publicUser` and `publicInvitation` are the load-bearing ones - they are
 * the boundary between a stored row and what leaves the process, and a field
 * added to a record but not to them is a field that never leaks by accident.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type {
  OrganizationRole,
  SubChannelVisibility,
  SubmittedTaskStatus,
} from "@coord/persistence";
import type { ApprovalStatus } from "@coord/shared-types";

import { hashSecret } from "./auth.js";
import { HttpError, stringField } from "./field-validation.js";
import { CHANNEL_ARBITRATION_PREFIX } from "./task-narration.js";

/** Mirrors the attachment store's own cap; see `AttachmentStore` in apps/web. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/**
 * Far shorter than an audit's, because somebody is watching a button.
 *
 * Rewriting text that is already on the screen is a small ask of a model, and
 * a reader who has waited half a minute for a shorter version of something
 * they can already read has been failed whether it arrives or not.
 */
export const SIMPLIFY_TIMEOUT_MS = 30_000;
/**
 * How long a socket ticket is worth anything.
 *
 * Long enough for the round trip that mints it and the upgrade that spends
 * it, and short enough that one written to a log is stale before anybody
 * reads the log.
 */
export const SOCKET_TICKET_TTL_MS = 30_000;

/**
 * How long an approved app has to collect its token.
 *
 * Longer than a socket ticket because a person is in the loop — the browser
 * has to redirect and the waiting app has to notice — and still short enough
 * that an abandoned approval is not a credential lying around.
 */
export const APP_AUTHORIZATION_TTL_MS = 120_000;

/**
 * How long a workspace picture's `data:` URL may be.
 *
 * The client sends a 128x128 JPEG at quality 0.82, which lands around seven
 * kilobytes of base64; a quarter of a megabyte leaves room for a detailed
 * image at that size while refusing an original photograph pasted in by a
 * caller that skipped the resize. It is well inside `MAX_JSON_BYTES`, so an
 * oversized picture is refused as a picture rather than as a large body.
 */
export const REPOSITORY_PICTURE_MAX_CHARS = 256 * 1024;
/** How long a worker holds a task before it must heartbeat again. */
export const WORK_LEASE_TTL_MS = 5 * 60 * 1000;
/** A week: long enough to be useful, short enough to be a poor thing to leak. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Turns the recipient label into the credential used in a readable link.
 *
 * Six characters keeps the shortest codes out of the especially easy-to-
 * guess range. Spaces become dashes, while everything else must already be a
 * URL-safe letter, digit or separator so the link says exactly what its
 * creator intended.
 */
export function normalizeInvitationCode(value: string): string | undefined {
  const code = value.trim().toUpperCase().replace(/\s+/gu, "-");
  if (
    code.length < 6 ||
    code.length > 48 ||
    !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/u.test(code)
  ) {
    return undefined;
  }
  return code;
}

/** A stable lookup key that does not put the readable bearer code in storage. */
export function invitationIdForCode(code: string): string {
  return `inv_code_${hashSecret(code)}`;
}

export const ROLES: readonly OrganizationRole[] = [
  "owner",
  "admin",
  "developer",
  "viewer",
];
export const TASK_STATUSES: readonly SubmittedTaskStatus[] = [
  "submitted",
  "claimed",
  "planned",
  "open",
  "integrated",
  "failed",
  "cancelled",
];
export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
];

/**
 * How long the live audit log keeps an event before it is compacted away.
 *
 * The log is the one table that grows with every task forever: measured, a
 * task writes about twenty-one events, so a deployment doing ten thousand
 * tasks a day writes six million rows a month and has never deleted one. The
 * machinery to bound it — archive, checkpoint, prune — has existed since the
 * log did and had no caller outside a command an operator had to remember to
 * run.
 *
 * Thirty days because that is this deployment's stated retention, and because
 * the checkpoint survives the prune: what is lost is the ability to re-derive
 * a segment's contents, never the attestation that it was there.
 */
export const AUDIT_RETENTION_DAYS = 30;

/**
 * How long a `/plan` hold waits for somebody to start it.
 *
 * A held plan costs nothing to keep — no lease, no workspace, no clock — but
 * it is a decision standing over somebody, and until now nothing ever ended
 * one. A plan nobody answered sat `planned` for the life of the deployment:
 * the thread kept saying "waiting on you", the room kept its go-ahead badge,
 * and the panel kept offering to start work that had long since stopped being
 * what anybody wanted. That is the "it just stalled forever" this bounds.
 *
 * Fifteen minutes, the same deadline an agent's own question already waits
 * out in the coordinator, and overridable with `COORD_PLAN_HOLD_TTL_MINUTES`
 * for a deployment whose reviewers are slower than that.
 *
 * Lapsing cancels rather than starts. Silence is not consent, and a plan is
 * the one review that happens before the work is paid for.
 */
export const PLAN_HOLD_TTL_MS = 15 * 60_000;

/**
 * The configured retention window, or the default when nothing sensible is
 * set. Zero is honoured — it means keep everything — but a negative or
 * unreadable value is not a request for anything, so it falls back rather
 * than being treated as "off". Getting that backwards would silently disable
 * the sweep on a typo, which is exactly the failure this exists to end.
 */
export function auditRetentionDays(configured: string | undefined): number {
  const parsed = Number.parseInt(configured ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : AUDIT_RETENTION_DAYS;
}

/**
 * Whether `viewerId` is behind this channel author.
 *
 * A channel has two kinds of author id: a user id, and an agent's
 * `owner:vendor`. Both are the viewer's own words for the purpose of deleting
 * them — an agent posts on its owner's credential, under a name that owner
 * chose, and the person who dispatched it is the person the room holds
 * responsible for the line. The prefix test is anchored on the separator so
 * one user id cannot be the prefix of another's agent id.
 */
export function isOwnChannelEntry(authorId: string, viewerId: string): boolean {
  return authorId === viewerId || authorId.startsWith(`${viewerId}:`);
}

/**
 * Whether this line is one of the coordinator's own temporary notices.
 *
 * Three things ask, and each needs the same answer: the sweep that withdraws
 * a notice whose collision is over, the replacement path that must find its
 * predecessor's line after a restart, and the delete route — which cancels the
 * task behind a message it removes, and must not do that here. A notice
 * carries the task it is *about*, not a run it narrates, so a reader tidying
 * one out of their room would otherwise stop the work it names.
 */
/**
 * The `#handle` a typed channel name becomes.
 *
 * Slack's rules, and for Slack's reason: the name is addressed as `#name` in
 * running text, so it cannot contain the spaces or punctuation that would
 * make where it ends ambiguous. Empty after squeezing means the caller typed
 * something with no letters or digits in it at all, which the route rejects
 * rather than silently naming a room "-".
 */
export function subChannelSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 60);
}

/** `private` only when it says so; anything else is an open room. */
export function subChannelVisibility(raw: unknown): SubChannelVisibility {
  // `read_only` is the default for anything unrecognised, which is what an
  // older client sending nothing gets: readable by the project, posted in by
  // its members. Widening the default to `public` would quietly hand posting
  // rights to everybody on a request that never asked for them.
  //
  // `open` is that same state under its old name, and is still accepted so a
  // browser holding a cached bundle keeps working across the deploy that
  // renames it. It was never the permissive value, whatever it sounded like.
  if (raw === "private" || raw === "public") {
    return raw;
  }
  return "read_only";
}

export function isCoordinatorNotice(message: {
  kind: string;
  authorId: string;
  content: string;
}): boolean {
  return (
    message.kind === "system" &&
    message.authorId === "coordinator" &&
    message.content.startsWith(CHANNEL_ARBITRATION_PREFIX)
  );
}

export function matchPath(pathname: string, pattern: RegExp): string[] | undefined {
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
 * A repository as the rest of the world reads it.
 *
 * `id` is the handle: it keys every row, names the mirror directory, and is
 * what a caller addresses a route with, so it cannot become whatever somebody
 * renamed the repository to. `displayName` is that rename, and absent means
 * nobody has made one. Neither is a field a client can just print - every
 * consumer had to know to prefer one and fall back to the other, and any that
 * did not showed the handle to somebody who had renamed it precisely so they
 * would stop seeing it.
 *
 * So the resolution happens once, here, and ships as `name`. Both fields stay
 * exactly as they were for anything already reading them.
 */
export function publicRepository<T extends { id: string; displayName?: string }>(
  repository: T | undefined,
): (T & { name: string }) | undefined {
  if (repository === undefined) {
    return undefined;
  }
  const named = (repository.displayName ?? "").trim();
  return { ...repository, name: named === "" ? repository.id : named };
}

/**
 * Drops rows for repositories the caller cannot reach.
 *
 * Per-repository access is only real if the lists respect it. Tasks, runs and
 * approvals all carry the repository they belong to, so one helper narrows
 * them; `undefined` means an organization role, which reaches everything.
 */
export function narrowToRepositories<T extends { repositoryId?: string }>(
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




export function publicInvitation(invitation: {
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

export function publicUser(user: {
  id: string;
  email: string;
  displayName: string;
  systemAdmin: boolean;
  disabled: boolean;
  createdAt: string;
  appearance?: {
    accent?: string;
    accentSecondary?: string;
    agentColor?: string;
  };
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

export function safeEqual(left: string, right: string): boolean {
  const first = createHash("sha256").update(left).digest();
  const second = createHash("sha256").update(right).digest();
  return timingSafeEqual(first, second);
}

/**
 * How many proxies to trust in `X-Forwarded-For`, from the environment.
 *
 * Defaults to none, and anything that is not a non-negative whole number is
 * none: a typo must not silently let clients choose their own rate-limit
 * bucket. Capped because a chain longer than this is not a deployment
 * topology, it is a forged header.
 */
/**
 * A positive whole number from the environment, or nothing.
 *
 * Nothing rather than a fallback, so the caller's own default stays the one
 * documented default: a typo'd setting should leave the shipped value in
 * place, not silently install a different one.
 */
export function positiveInteger(configured: string | undefined): number | undefined {
  if (configured === undefined || configured.trim() === "") {
    return undefined;
  }
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function trustedProxyHops(configured: string | undefined): number {
  const parsed = Number(configured ?? "");
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return 0;
  }
  return Math.min(parsed, 8);
}

/**
 * `Strict-Transport-Security` lifetime in seconds, from the environment.
 *
 * `COORD_HSTS` unset or `1` means the default of one year; `0` or `off` turns
 * it off; an explicit number is used as given. It is sent only on requests
 * that arrived over TLS either way.
 */
export function hstsMaxAge(configured: string | undefined): number {
  const value = (configured ?? "").trim().toLowerCase();
  if (value === "" || value === "1" || value === "true" || value === "on") {
    return 31_536_000;
  }
  if (value === "0" || value === "false" || value === "off") {
    return 0;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 31_536_000;
}

/**
 * How long a password reset link stays usable, in milliseconds.
 *
 * An hour by default. Anything unparseable falls back to that rather than
 * failing startup: a mistyped number should not stop a control plane booting,
 * and the default is safe.
 */
export function passwordResetTtlMs(configured: string | undefined): number {
  const minutes = Number((configured ?? "").trim());
  return Number.isSafeInteger(minutes) && minutes > 0
    ? minutes * 60_000
    : 60 * 60_000;
}

/**
 * How long a held plan waits, in milliseconds.
 *
 * Same shape as {@link passwordResetTtlMs}, and for the same reason: a
 * mistyped number falls back to the default rather than stopping a control
 * plane from booting.
 */
export function planHoldTtlMs(configured: string | undefined): number {
  const minutes = Number((configured ?? "").trim());
  return Number.isSafeInteger(minutes) && minutes > 0
    ? minutes * 60_000
    : PLAN_HOLD_TTL_MS;
}

/**
 * Refuses a retyped field that does not match what it confirms.
 *
 * Absent means unchecked. The browser always sends both, but an existing
 * script that posts to these endpoints was written before the fields existed,
 * and breaking it would be a cost with no safety in return: retyping guards
 * against a typo the person cannot see, not against an attacker.
 *
 * The comparison is on the trimmed value for the same reason the field itself
 * is stored trimmed — otherwise a trailing space typed into one box and not
 * the other would report a mismatch the person cannot see either.
 */
export function assertConfirmed(
  value: unknown,
  expected: string,
  field: string,
  message: string,
): void {
  if (value === undefined) {
    return;
  }
  const confirmation = stringField(value, field, { max: 320, min: 0 }) ?? "";
  if (confirmation !== expected) {
    throw new HttpError(400, "confirmation_mismatch", message);
  }
}

/**
 * Whether this control plane accepts self-service sign-up.
 *
 * Open by default so somebody who receives the deployment link can create an
 * account without first getting an invitation. Registration creates an
 * isolated organization for that account; it never adds the person to an
 * existing team's repositories.
 *
 * Operators can set `COORD_ALLOW_REGISTRATION=0` to require invitations.
 * `COORD_DISABLE_REGISTRATION=1` is also still honoured for deployments that
 * used the original opt-out setting.
 */
export function registrationOpen(environment: NodeJS.ProcessEnv): boolean {
  if (environment["COORD_DISABLE_REGISTRATION"] === "1") {
    return false;
  }
  const allow = (environment["COORD_ALLOW_REGISTRATION"] ?? "").trim().toLowerCase();
  return (
    allow === "" ||
    allow === "1" ||
    allow === "true" ||
    allow === "yes" ||
    allow === "on"
  );
}

/**
 * Whether sign-up makes somebody prove their mailbox before the account exists.
 *
 * Off by default. Confirmation only works on a deployment with mail actually
 * configured, and until then it stops sign-up dead: the code is written to a
 * log nobody signing up can read, so the account can never be finished. Until
 * mail is wired up here, sign-up creates the account straight away and the
 * person lands in the app.
 *
 * Setting `COORD_REQUIRE_EMAIL_CONFIRMATION=1` turns the mailed-code step back
 * on for a deployment whose relay is configured. Everything it needs is still
 * in place — the challenge, the code, and `/auth/register/confirm`.
 */
export function emailConfirmationRequired(environment: NodeJS.ProcessEnv): boolean {
  const required = (environment["COORD_REQUIRE_EMAIL_CONFIRMATION"] ?? "")
    .trim()
    .toLowerCase();
  return required === "1" || required === "true" || required === "yes" || required === "on";
}
