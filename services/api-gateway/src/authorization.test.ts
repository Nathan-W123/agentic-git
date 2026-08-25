import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryCoordinationStore } from "@coord/persistence";
import type { CoordinationStore } from "@coord/persistence";

import type { AuthenticatedPrincipal } from "./auth.js";
import { authorizeOrganization } from "./authorization.js";

/**
 * The gate must not close on the only door out of itself.
 *
 * `effectiveRole` folds every role to `viewer` once a subscription stops
 * allowing work, and `authorizeOrganization` applies that before it checks the
 * permission. `manage_organization` is owner-only. The checkout route asks for
 * `manage_organization`. Composed, that means the endpoint whose entire
 * purpose is to take a lapsed customer's money refuses them for having
 * lapsed — with no in-product recovery except starting a second organization,
 * which farms a fresh trial and orphans the first.
 */

interface LapsedFixture {
  store: CoordinationStore;
  principal: AuthenticatedPrincipal;
  organizationId: string;
}

async function lapsedOrganization(): Promise<LapsedFixture> {
  const store = new InMemoryCoordinationStore();
  const organization = await store.createOrganization({
    slug: "lapsed",
    name: "Lapsed Team",
  });
  const user = await store.createUser({
    email: "owner@example.com",
    displayName: "Owner",
    passwordDigest: "digest",
  });
  await store.saveMembership({
    organizationId: organization.id,
    userId: user.id,
    role: "owner",
  });
  // A trial that ended yesterday: the exact state of every customer on day
  // fifteen of a fourteen-day trial.
  await store.saveSubscription({
    organizationId: organization.id,
    status: "trialing",
    trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  });
  const principal: AuthenticatedPrincipal = {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      systemAdmin: false,
    } as AuthenticatedPrincipal["user"],
    credential: "session",
    memberships: [
      {
        organizationId: organization.id,
        userId: user.id,
        role: "owner",
      } as AuthenticatedPrincipal["memberships"][number],
    ],
  };
  return { store, principal, organizationId: organization.id };
}

test("a lapsed owner is still refused everything else", async () => {
  const { store, principal, organizationId } = await lapsedOrganization();
  try {
    // The gate itself is not being weakened: folding is still what happens on
    // every ordinary route, which is the whole reason it exists.
    await assert.rejects(
      async () =>
        await authorizeOrganization(
          store,
          principal,
          organizationId,
          "run_task",
        ),
      /forbidden|permission/iu,
      "a lapsed owner must not be able to start work",
    );
  } finally {
    await store.close();
  }
});

test("a lapsed owner may still reach checkout, because paying ends the lapse", async () => {
  const { store, principal, organizationId } = await lapsedOrganization();
  try {
    const authorized = await authorizeOrganization(
      store,
      principal,
      organizationId,
      "manage_organization",
      { ignoreEntitlement: true },
    );
    assert.equal(
      authorized.role,
      "owner",
      "the stored role is what billing authorizes against",
    );
  } finally {
    await store.close();
  }
});
