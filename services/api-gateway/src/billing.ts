import type {
  OrganizationMembership,
  RepositoryGrant,
  OrganizationRole,
  Subscription,
} from "@coord/persistence";

/**
 * What a subscription entitles an organization to, and what a seat costs.
 *
 * Deliberately pure and free of the store: every rule here is a decision about
 * money, and a decision about money should be readable in one place and
 * testable without a database behind it. The gateway asks these questions; it
 * does not answer them itself.
 */

/** How long a new organization may work before it has to decide. */
export const TRIAL_DAYS = 14;

/**
 * Whether this deployment takes money at all.
 *
 * Off unless `KUMI_PAYMENTS_ENABLED` says otherwise, which is the switch the
 * whole payment pathway hangs from: with it off there is no checkout, no
 * billing portal, no seat reconciliation against Stripe, no trial, and — the
 * part that matters most here — no entitlement gate, so nobody is folded to
 * `viewer` for not having paid something nobody was asked to pay.
 *
 * Default-off rather than default-on because the failure modes point opposite
 * ways. A deployment that has switched payments off and is wrongly read as
 * having them on locks its own users out of their repositories over an
 * invoice that does not exist; one read the other way simply does not charge.
 * Only the second is recoverable by the person it happens to.
 *
 * Read at the call rather than captured at import so a test can set it around
 * one case, and so the gateway and this module can never disagree about it.
 */
export function paymentsEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = (environment["KUMI_PAYMENTS_ENABLED"] ?? "")
    .trim()
    .toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * Roles that cost money.
 *
 * The line falls exactly where `submit_task` and `run_task` do, which is not a
 * coincidence: a seat is billable when it can spend, and free when it can only
 * read. That makes the free tier explicable in one sentence — people who watch
 * the work are free, people who create it are not — and it means the billing
 * boundary can never drift away from the permission boundary, because they are
 * the same boundary.
 */
const BILLABLE_ROLES: ReadonlySet<OrganizationRole> = new Set([
  "developer",
  "admin",
  "owner",
]);

export function roleIsBillable(role: OrganizationRole): boolean {
  return BILLABLE_ROLES.has(role);
}

/**
 * Seats an organization is charged for.
 *
 * A comped membership is excluded however senior it is: the whole point of a
 * comped seat is that it does not appear on the invoice.
 */
export function billableSeats(
  memberships: readonly OrganizationMembership[],
  /**
   * Repository grants held by people in this organization's repositories.
   *
   * Counted because a grant is a way to work without being a member. Somebody
   * invited to a single repository holds no organization role at all, so a
   * seat count that read only memberships billed nothing for them however
   * much work they did — and a team could put its whole staff on grants and
   * pay for one owner.
   *
   * A comped grant is still free: that is what the operators hand out
   * deliberately, one person and one repository at a time, and it is the
   * whole point of the mechanism. What is counted is the ordinary grant
   * nobody comped.
   */
  grants: readonly RepositoryGrant[] = [],
): number {
  // By person, not by row. One human with a billable membership and three
  // grants is one seat, and three grants on three repositories is one seat
  // too — they are one person, and a seat is a person.
  const billable = new Set<string>();
  for (const membership of memberships) {
    if (roleIsBillable(membership.role) && !membership.comped) {
      billable.add(membership.userId);
    }
  }
  for (const grant of grants) {
    if (roleIsBillable(grant.role) && grant.comped !== true) {
      billable.add(grant.userId);
    }
  }
  return billable.size;
}

/**
 * Whether an organization may do work right now.
 *
 * A missing row is no entitlement. It used to be read as the organization's
 * initial trial, measured from `createdAt`, on the reasoning that this was
 * self-healing and "cannot be farmed, because the only way to get a new
 * organization is to sign up, which writes a real row anyway".
 *
 * That reasoning stopped being true. `POST /organizations` creates an
 * organization and writes no subscription row, so anybody signed in could
 * mint themselves another fourteen days as often as they liked — and once a
 * webhook creates organizations too, a fallback that hands out a fortnight to
 * any row it has never seen is a vending machine rather than a safety net.
 *
 * Migration 47 backfilled a real row for every organization that lacked one,
 * computing exactly the entitlement this fallback was granting it, so
 * inverting it changes no existing organization's answer. It does mean every
 * path that creates an organization is now load-bearing for billing — which
 * is the point: writing the row is the thing that must not be forgotten, and
 * an organization that appears without one should stop rather than quietly
 * become free.
 *
 * A trial is judged against its own end date rather than against its status,
 * so an expired trial nobody has swept stops working on time instead of when
 * a background job next runs. `past_due` still works: a failed payment is a
 * card problem, and locking a team out of their repository over one is a
 * worse answer than letting Stripe retry.
 */
export function subscriptionAllowsWork(
  subscription: Subscription | undefined,
  organizationCreatedAt: string | undefined,
  now: Date = new Date(),
  payments: boolean = paymentsEnabled(),
): boolean {
  // Nothing is gated where nothing is sold. A deployment with payments off
  // has no way for anybody to buy an entitlement, so reading a missing or
  // lapsed row as "no" would make the read-only state permanent and the door
  // out of it unreachable — the exact trap `ignoreEntitlement` exists to keep
  // the checkout route out of, applied to every route at once.
  if (!payments) {
    return true;
  }
  if (subscription === undefined) {
    return false;
  }
  switch (subscription.status) {
    case "comped":
    case "active":
    case "past_due":
      return true;
    case "trialing":
      // Whose trial it is decides who is believed about it.
      //
      // A subscription Stripe is running says `trialing` for exactly as long
      // as Stripe honours it, and its status is more current than our mirror
      // of the end date: at conversion Stripe moves the subscription to
      // `active` and tells us afterwards, so between the trial's last second
      // and that webhook landing, a date-based answer locks out a team that
      // has just paid. `past_due` already resolves the same tension the same
      // way — Stripe's retries are a better answer than a locked repository.
      //
      // A trial this deployment runs itself has no such authority behind it,
      // and is judged against its own end date so an expired one stops on
      // time rather than when some sweep next runs.
      return subscription.stripeSubscriptionId !== undefined
        ? true
        : trialRemainsOn(subscription, now);
    case "canceled":
      return false;
  }
}

/** Whether a trial still has time on it, with a malformed date read as spent. */
export function trialRemainsOn(
  subscription: Subscription,
  now: Date = new Date(),
): boolean {
  if (subscription.trialEndsAt === undefined) {
    return false;
  }
  const endsAt = Date.parse(subscription.trialEndsAt);
  return Number.isFinite(endsAt) && endsAt > now.getTime();
}

/** The end of a trial starting now, as an ISO timestamp. */
export function trialEndsAtFrom(start: Date = new Date()): string {
  return new Date(
    start.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

/**
 * The role an organization's members may actually exercise.
 *
 * An unpaid organization is read-only rather than locked shut. Their
 * repositories, threads and history are theirs and stay legible; what stops is
 * the ability to spend — which is the thing the subscription was buying. It is
 * also the difference between a product somebody comes back to and one they
 * cannot get their own work out of.
 */
export function effectiveRole(
  role: OrganizationRole,
  subscription: Subscription | undefined,
  organizationCreatedAt: string | undefined,
  now: Date = new Date(),
  payments: boolean = paymentsEnabled(),
): OrganizationRole {
  return subscriptionAllowsWork(subscription, organizationCreatedAt, now, payments)
    ? role
    : "viewer";
}
