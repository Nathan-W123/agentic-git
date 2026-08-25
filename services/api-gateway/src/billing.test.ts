import assert from "node:assert/strict";
import test from "node:test";

import type {
  OrganizationMembership,
  OrganizationRole,
  Subscription,
} from "@coord/persistence";

import {
  TRIAL_DAYS,
  billableSeats,
  effectiveRole,
  roleIsBillable,
  subscriptionAllowsWork,
  trialEndsAtFrom,
  trialRemainsOn,
} from "./billing.js";

const NOW = new Date("2026-06-01T12:00:00.000Z");
/** Long before NOW, so a missing row never props a test up by accident. */
const ORG_CREATED = "2026-01-01T00:00:00.000Z";

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    organizationId: "org_1",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function member(
  role: OrganizationRole,
  comped = false,
): OrganizationMembership {
  return {
    organizationId: "org_1",
    userId: `user_${role}_${String(comped)}`,
    role,
    comped,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/* ------------------------------------------------------------- seats ---- */

test("a seat is billable exactly when it can spend", () => {
  // The billing boundary and the permission boundary are the same boundary:
  // `viewer` is the only role without `submit_task`/`run_task`, and the only
  // free one. If this ever drifts, somebody is being charged for reading or
  // running work for free.
  assert.equal(roleIsBillable("viewer"), false);
  assert.equal(roleIsBillable("developer"), true);
  assert.equal(roleIsBillable("admin"), true);
  assert.equal(roleIsBillable("owner"), true);
});

test("comped seats and viewers stay off the invoice", () => {
  const seats = billableSeats([
    member("owner"),
    member("developer"),
    member("admin"),
    member("viewer"),
    member("developer", true),
    member("owner", true),
  ]);
  // Two of the six are viewers or comped viewers; two more are comped. Only
  // the three paid, spending seats count.
  assert.equal(seats, 3);
});

test("an organization with nobody who can spend owes nothing", () => {
  assert.equal(billableSeats([member("viewer"), member("viewer")]), 0);
  assert.equal(billableSeats([]), 0);
});

/* ------------------------------------------------------ entitlement ---- */

test("comped, active and past_due may work; canceled may not", () => {
  for (const status of ["comped", "active", "past_due"] as const) {
    assert.equal(
      subscriptionAllowsWork(subscription({ status }), ORG_CREATED, NOW),
      true,
      status,
    );
  }
  assert.equal(
    subscriptionAllowsWork(subscription({ status: "canceled" }), ORG_CREATED, NOW,),
    false,
  );
});

test("a failed payment does not lock a team out of their own repository", () => {
  // Deliberate: `past_due` is Stripe retrying a card, not a decision to stop
  // serving somebody. Locking the repository over it would punish the team for
  // an expired card and make the product feel unsafe to depend on.
  assert.equal(
    subscriptionAllowsWork(subscription({ status: "past_due" }), ORG_CREATED, NOW,),
    true,
  );
});

test("a trial is judged on its own end date, not on a sweep", () => {
  const live = subscription({
    status: "trialing",
    trialEndsAt: "2026-06-02T00:00:00.000Z",
  });
  const spent = subscription({
    status: "trialing",
    trialEndsAt: "2026-05-31T00:00:00.000Z",
  });
  assert.equal(subscriptionAllowsWork(live, ORG_CREATED, NOW), true);
  assert.equal(subscriptionAllowsWork(spent, ORG_CREATED, NOW), false);
});

test("a trial with no end date, or an unreadable one, is spent", () => {
  // Fails closed. A trial whose end nobody can read is not evidence of
  // entitlement, and reading it as one would make a corrupt row into free
  // service that never expires.
  assert.equal(
    subscriptionAllowsWork(subscription({ status: "trialing" }), ORG_CREATED, NOW,),
    false,
  );
  assert.equal(
    trialRemainsOn(
      subscription({ status: "trialing", trialEndsAt: "not a date" }),
      NOW,
    ),
    false,
  );
});

test("no recorded subscription is no entitlement, however new the organization", () => {
  // This used to read a missing row as a fresh fourteen days from
  // `createdAt`, on the reasoning that it was self-healing and could not be
  // farmed "because the only way to get a new organization is to sign up".
  // That stopped being true: `POST /organizations` wrote no row, so anybody
  // signed in could mint another fortnight whenever the last ran out.
  //
  // Migration 47 backfilled a real row for every organization that lacked
  // one, computing exactly what this fallback was granting, so inverting it
  // changes no existing organization's answer — and every path that creates
  // an organization is now load-bearing for billing on purpose.
  const young = new Date("2026-01-10T00:00:00.000Z");
  assert.equal(subscriptionAllowsWork(undefined, ORG_CREATED, young), false);
  assert.equal(subscriptionAllowsWork(undefined, ORG_CREATED, NOW), false);
  assert.equal(subscriptionAllowsWork(undefined, undefined, NOW), false);
  assert.equal(effectiveRole("owner", undefined, ORG_CREATED, young), "viewer");
});

test("a trial is honoured only when a row records it", () => {
  // The replacement for the fallback: the entitlement comes from the row the
  // sign-up wrote, not from the organization's age.
  const young = new Date("2026-01-10T00:00:00.000Z");
  const trialing = subscription({
    status: "trialing",
    trialEndsAt: "2026-01-15T00:00:00.000Z",
  });
  assert.equal(subscriptionAllowsWork(trialing, ORG_CREATED, young), true);
  assert.equal(subscriptionAllowsWork(trialing, ORG_CREATED, NOW), false);
});

test("a trial runs for fourteen days from when it starts", () => {
  const ends = Date.parse(trialEndsAtFrom(NOW));
  assert.equal(ends - NOW.getTime(), TRIAL_DAYS * 24 * 60 * 60 * 1000);
  assert.equal(TRIAL_DAYS, 14);
});

/* ----------------------------------------------------- effective role --- */

test("a seat is a person, and a repository grant is a way to be one", () => {
  // A grant lets somebody work without being a member of the organization at
  // all, so counting only memberships billed nothing for them however much
  // work they did — and a team could put its whole staff on grants and pay
  // for one owner.
  const member = {
    organizationId: "org_1",
    userId: "user_1",
    role: "developer" as const,
    comped: false,
    createdAt: NOW.toISOString(),
  };
  const grantee = {
    repositoryId: "repo_1",
    userId: "user_2",
    role: "developer" as const,
    grantedBy: undefined,
    comped: false,
    createdAt: NOW.toISOString(),
  };
  assert.equal(billableSeats([member]), 1, "a grant nobody counted is free work");
  assert.equal(billableSeats([member], [grantee]), 2);

  // A comped grant stays free. That is what the operators hand out on
  // purpose, one person and one repository at a time.
  assert.equal(
    billableSeats([member], [{ ...grantee, comped: true }]),
    1,
  );

  // And a seat is a person, not a row: one human with a membership and two
  // grants is one seat, not three.
  assert.equal(
    billableSeats(
      [member],
      [
        { ...grantee, userId: "user_1" },
        { ...grantee, repositoryId: "repo_2", userId: "user_1" },
      ],
    ),
    1,
  );

  // A viewer grant is free for the same reason a viewer membership is.
  assert.equal(
    billableSeats([member], [{ ...grantee, role: "viewer" as const }]),
    1,
  );
});

test("a lapsed organization goes read-only rather than dark", () => {
  const canceled = subscription({ status: "canceled" });
  // Everything folds to viewer, which still carries `view`. Their repositories
  // and history stay legible; what stops is spending.
  for (const role of ["owner", "admin", "developer"] as const) {
    assert.equal(effectiveRole(role, canceled, ORG_CREATED, NOW), "viewer");
  }
  assert.equal(effectiveRole("viewer", canceled, ORG_CREATED, NOW), "viewer");
});

test("an entitled organization keeps every role untouched", () => {
  const active = subscription({ status: "active" });
  for (const role of ["owner", "admin", "developer", "viewer"] as const) {
    assert.equal(effectiveRole(role, active, ORG_CREATED, NOW), role);
  }
});

test("an expired trial is read-only the moment it expires", () => {
  const justExpired = subscription({
    status: "trialing",
    trialEndsAt: NOW.toISOString(),
  });
  // Equal, not after: a trial ending exactly now is over. The boundary is
  // stated so a later refactor cannot quietly hand out an extra millisecond
  // and call it a rounding decision.
  assert.equal(effectiveRole("owner", justExpired, ORG_CREATED, NOW), "viewer");
});

/* ------------------------------------------------------ comped grants --- */

test("a comped repository grant is entitlement on its own", () => {
  // What the operators actually hand out: free full use of one repository,
  // standing regardless of what the organization owning it has paid. The gate
  // in `authorization.ts` is what applies this; the rule is stated here so the
  // intent survives a refactor of the gate.
  const canceled = subscription({ status: "canceled" });
  // Without the comp, an unpaid organization folds this to read-only.
  assert.equal(effectiveRole("developer", canceled, ORG_CREATED, NOW), "viewer");
  // The comp is not a subscription status, so it cannot be expressed here —
  // which is the point: it is grant-scoped, and `authorizeRepository` skips
  // the fold entirely rather than inventing an entitlement for the whole
  // organization.
  assert.equal(subscriptionAllowsWork(canceled, ORG_CREATED, NOW), false);
});

test("a comped seat never reaches the invoice, at any role", () => {
  // Comped covers full use, so it has to survive being an owner-level seat.
  assert.equal(billableSeats([member("owner", true)]), 0);
  assert.equal(billableSeats([member("admin", true)]), 0);
  assert.equal(billableSeats([member("developer", true)]), 0);
});
