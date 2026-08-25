import type {
  OrganizationMembership,
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
): number {
  return memberships.filter(
    (membership) => roleIsBillable(membership.role) && !membership.comped,
  ).length;
}

/**
 * Whether an organization may do work right now.
 *
 * A missing row is read as the organization's initial trial, measured from
 * when the organization itself was created. Refusing outright was the first
 * instinct and it is the wrong one: it makes every future path that creates an
 * organization silently load-bearing for billing, so the one that forgets to
 * write the row takes that whole organization offline rather than costing a
 * little money. Reading it as a trial from `createdAt` is self-healing, is
 * still bounded — the same fourteen days, and expired for anything older —
 * and cannot be farmed, because the only way to get a new organization is to
 * sign up, which writes a real row anyway.
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
): boolean {
  if (subscription === undefined) {
    return (
      organizationCreatedAt !== undefined &&
      Date.parse(trialEndsAtFrom(new Date(organizationCreatedAt))) >
        now.getTime()
    );
  }
  switch (subscription.status) {
    case "comped":
    case "active":
    case "past_due":
      return true;
    case "trialing":
      return trialRemainsOn(subscription, now);
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
): OrganizationRole {
  return subscriptionAllowsWork(subscription, organizationCreatedAt, now)
    ? role
    : "viewer";
}
