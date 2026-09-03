/** The gateway over HTTP: invitations, grants and who can see what. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  hashPassword,
} from "./auth.js";
import {
  type StripeClient,
} from "./stripe.js";
import {
  PASSWORD,
  TestClient,
  bearer,
  bootstrap,
  invitableRepository,
  inviteBody,
  joinRepository,
  registerAccount,
  startRuntime,
  work,
} from "./test-harness.js";
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
} from "@coord/persistence";

test("an invitation brings in somebody who has no account yet", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner);

  const invited = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("newcomer@example.com", "developer", repo) },
  );
  assert.equal(invited.status, 201);
  const token = invited.data.token as string;
  assert.match(token, /^inv_[\w-]+\.[\w-]+$/u);
  // The secret is returned exactly once and is not stored recoverably.
  assert.equal(invited.data.invitation.status, "pending");
  assert.equal("secretHash" in invited.data.invitation, false);

  // The recipient can read the invitation before having any account at all.
  const anonymous = new TestClient(runtime.origin);
  const preview = await anonymous.request(`/api/v1/invitations/${token}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.invitation.email, "newcomer@example.com");
  assert.equal(preview.data.invitation.role, "developer");

  const accepted = await anonymous.request(`/api/v1/invitations/${token}/accept`, {
    method: "POST",
    body: { displayName: "Newcomer", password: PASSWORD },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.user.email, "newcomer@example.com");
  // No organization membership: an invitation grants its one repository and
  // nothing else, and any organization role would reach every repository.
  assert.deepEqual(accepted.data.memberships, []);
  // The grant they did get is the repository they were invited to.
  const reachable = await anonymous.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
  );
  assert.equal(reachable.status, 200);
  assert.deepEqual(
    reachable.data.repositories.map((entry: { id: string }) => entry.id),
    [repo],
  );

  // And they are signed in, so accepting lands them inside rather than at a
  // login screen with a fresh password they just chose.
  const me = await anonymous.request("/api/v1/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, "newcomer@example.com");
  // Nobody could have had an account for that address before this test made
  // one, which is what the preview said.
  assert.equal(preview.data.invitation.accountExists, false);
});

test("an accepted repository invitation moves the seat count at Stripe", async (t) => {
  // The bug this pins: every invitation a customer can create is
  // repository-scoped — the route requires one — and that branch was the one
  // branch that never called `syncSeatQuantity`. So a team could invite its
  // whole staff, each of them able to work, and the subscription stayed at
  // the quantity checkout happened to capture. Nobody would notice from
  // inside the product; it shows up only as an invoice that is too small.
  const writes: number[] = [];
  // What Stripe currently holds, so the "already correct, do not write"
  // shortcut is exercised by the same stub rather than assumed.
  let held = 2;
  const stripe = {
    getSubscription: async (id: string) => ({
      id,
      status: "active",
      customerId: "cus_seats",
      currentPeriodEnd: undefined,
      trialEnd: undefined,
      quantity: held,
      metadata: {},
    }),
    getSubscriptionItemId: async () => "si_seats",
    updateSubscriptionQuantity: async (input: {
      subscriptionId: string;
      subscriptionItemId: string;
      quantity: number;
    }) => {
      assert.equal(input.subscriptionId, "sub_seats");
      assert.equal(input.subscriptionItemId, "si_seats");
      writes.push(input.quantity);
      held = input.quantity;
    },
  } as unknown as StripeClient;
  const runtime = await startRuntime(t, { stripe });
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "seat-repo");

  // The invitation has to come from somebody who is not the operator: an
  // operator's repository invitation is deliberately comped, and a comped
  // grant is exactly the one that must not move the count.
  const founder = await runtime.store.createUser({
    email: "founder@example.com",
    displayName: "Founder",
    passwordDigest: await hashPassword(PASSWORD),
    systemAdmin: false,
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: founder.id,
    role: "owner",
  });
  // A real paying organization, which bootstrap's comped row is not.
  await runtime.store.saveSubscription({
    organizationId: DEFAULT_ORGANIZATION_ID,
    status: "active",
    stripeCustomerId: "cus_seats",
    stripeSubscriptionId: "sub_seats",
  });
  const founderClient = new TestClient(runtime.origin);
  const signedIn = await founderClient.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "founder@example.com", password: PASSWORD },
  });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.data));

  const invited = await founderClient.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    {
      method: "POST",
      body: inviteBody("hired@example.com", "developer", repo),
    },
  );
  assert.equal(invited.status, 201, JSON.stringify(invited.data));
  // Issuing the invitation is not a seat. Nobody holds it yet, and billing
  // for an unopened email is how a team ends up paying for a typo.
  assert.deepEqual(writes, []);

  const joiner = new TestClient(runtime.origin);
  const accepted = await joiner.request(
    `/api/v1/invitations/${String(invited.data.token)}/accept`,
    { method: "POST", body: { displayName: "Hired", password: PASSWORD } },
  );
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  // Two members and one ordinary grant, by person: three seats.
  assert.deepEqual(
    writes,
    [3],
    "the grant branch has to reach Stripe, not only the membership one",
  );

  // And an operator's invitation to the same repository is free, so the
  // quantity does not move again — the comp is the point of that path.
  const comped = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("guest@example.com", "developer", repo) },
  );
  assert.equal(comped.status, 201, JSON.stringify(comped.data));
  const guest = new TestClient(runtime.origin);
  const joinedFree = await guest.request(
    `/api/v1/invitations/${String(comped.data.token)}/accept`,
    { method: "POST", body: { displayName: "Guest", password: PASSWORD } },
  );
  assert.equal(joinedFree.status, 200, JSON.stringify(joinedFree.data));
  assert.deepEqual(
    writes,
    [3],
    "a comped grant is free, and writing the same quantity would prorate",
  );
});

test("syncing checks the repository, not only the project it was named under", async (t) => {
  // `/sync` authorized the project and then handed the path's repository id
  // to the operation, which resolves it globally. So an owner of any project
  // anywhere could name somebody else's repository under their own project
  // and move that mirror — a write, on a repository they cannot even read.
  // The sibling `/push` has always checked both halves.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const theirs = await invitableRepository(owner, "sync-target");

  const outsider = await runtime.store.createUser({
    email: "sync-outsider@example.com",
    displayName: "Sync Outsider",
    passwordDigest: await hashPassword(PASSWORD),
    systemAdmin: false,
  });
  const other = await runtime.store.createOrganization({
    slug: "sync-tenant",
    name: "Sync Tenant",
  });
  await runtime.store.saveMembership({
    organizationId: other.id,
    userId: outsider.id,
    role: "owner",
  });
  await runtime.store.saveSubscription({
    organizationId: other.id,
    status: "active",
  });
  const mine = await runtime.store.createProject({
    organizationId: other.id,
    slug: "sync-project",
    name: "Sync Project",
  });
  const client = new TestClient(runtime.origin);
  const signedIn = await client.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "sync-outsider@example.com", password: PASSWORD },
  });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.data));

  // Their own project, somebody else's repository.
  const crossed = await client.request(
    `/api/v1/projects/${mine.id}/repositories/${theirs}/sync`,
    { method: "POST", body: {} },
  );
  assert.equal(
    crossed.status,
    404,
    JSON.stringify(crossed.data),
  );

  // The project it really belongs to, which they cannot reach at all.
  const direct = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${theirs}/sync`,
    { method: "POST", body: {} },
  );
  assert.equal(direct.status, 403, JSON.stringify(direct.data));

  // Neither refusal reached the operation, which is the only place the
  // damage would have happened.
  assert.equal(runtime.syncCalls.length, 0);

  // And the owner can still sync their own, or the guard would be a
  // regression rather than a fix.
  const allowed = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${theirs}/sync`,
    { method: "POST", body: {} },
  );
  assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
  assert.deepEqual(
    runtime.syncCalls.map((call) => call.repositoryId),
    [theirs],
  );
});

test("an invitation cannot name a repository the sender does not own", async (t) => {
  // Two holes, one route. The repository was looked up with
  // `listProjectRepositories(body.projectId)` — keyed on the project alone —
  // so the only question asked was whether the repository existed under the
  // project id in the body. Nothing asked whether the sender could reach it,
  // and nothing asked whether it belonged to the organization in the path.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const theirs = await invitableRepository(owner, "tenant-a-repo");

  // Somebody who runs a different organization entirely, with no reach into
  // the first one.
  const outsider = await runtime.store.createUser({
    email: "outsider@example.com",
    displayName: "Outsider",
    passwordDigest: await hashPassword(PASSWORD),
    systemAdmin: false,
  });
  const other = await runtime.store.createOrganization({
    slug: "other-tenant",
    name: "Other Tenant",
  });
  await runtime.store.saveMembership({
    organizationId: other.id,
    userId: outsider.id,
    role: "owner",
  });
  // Paid up, so nothing below is refused for the wrong reason: an
  // organization with no subscription row folds every role to `viewer`, and
  // this test is about tenancy, not entitlement.
  await runtime.store.saveSubscription({
    organizationId: other.id,
    status: "active",
  });
  const client = new TestClient(runtime.origin);
  const signedIn = await client.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "outsider@example.com", password: PASSWORD },
  });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.data));

  // 1. No access to that repository at all. The route used to answer 201 for
  //    a repository that existed and 404 for one that did not, which also
  //    made it an existence oracle for someone else's code.
  const stranger = await client.request(
    `/api/v1/organizations/${other.id}/invitations`,
    {
      method: "POST",
      body: inviteBody("friend@example.com", "developer", theirs),
    },
  );
  assert.equal(
    stranger.status,
    403,
    JSON.stringify(stranger.data),
  );

  // 2. Now they can reach it — an ordinary owner grant, the access a
  //    repository invitation itself hands out. Sharing it under their *own*
  //    organization would be laundering: the invitation, the audit line and
  //    the seat all land on the wrong organization, while the repository
  //    stays on the other one.
  await runtime.store.saveRepositoryGrant({
    repositoryId: theirs,
    userId: outsider.id,
    role: "owner",
    grantedBy: outsider.id,
    comped: false,
    createdAt: new Date().toISOString(),
  });
  const launder = await client.request(
    `/api/v1/organizations/${other.id}/invitations`,
    {
      method: "POST",
      body: inviteBody("friend@example.com", "developer", theirs),
    },
  );
  assert.equal(launder.status, 404, JSON.stringify(launder.data));

  // And nothing was written on the way to either refusal.
  assert.deepEqual(
    (await runtime.store.listInvitations(other.id)).map(
      (invitation) => invitation.id,
    ),
    [],
  );

  // A repository is still required: an invitation with no repository would be
  // an organization-wide one, which is the thing this route no longer offers.
  const wide = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    {
      method: "POST",
      body: {
        email: "friend@example.com",
        role: "developer",
        projectId: DEFAULT_PROJECT_ID,
      },
    },
  );
  assert.equal(wide.status, 400, JSON.stringify(wide.data));
});

test("a recipient name makes a readable invitation link", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "readable-invite");

  const invited = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    {
      method: "POST",
      body: {
        ...inviteBody("", "developer", repo),
        recipientName: "Nathan",
      },
    },
  );
  assert.equal(invited.status, 201, JSON.stringify(invited.data));
  assert.equal(invited.data.token, "NATHAN");

  // The readable token remains a bearer credential, and only its hash is
  // kept. The deterministic internal id is what makes the code resolvable
  // without adding a second persisted field.
  const stored = await runtime.store.getInvitation(
    invited.data.invitation.id as string,
  );
  assert.ok(stored);
  assert.notEqual(stored.secretHash, "NATHAN");
  assert.notEqual(stored.id, "NATHAN");

  const joiner = new TestClient(runtime.origin);
  const preview = await joiner.request("/api/v1/invitations/NATHAN");
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.invitation.repositoryId, repo);
  assert.equal(preview.data.invitation.open, true);

  const accepted = await joiner.request("/api/v1/invitations/NATHAN/accept", {
    method: "POST",
    body: {
      email: "nathan@example.com",
      displayName: "Nathan",
      password: PASSWORD,
    },
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.user.email, "nathan@example.com");
  assert.equal(
    (await runtime.store.listRepositoryGrants(repo)).some(
      (grant) => grant.userId === accepted.data.user.id,
    ),
    true,
  );
});

test("invalid and reserved readable invitation names are refused", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "readable-invite-collisions");
  const endpoint =
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`;

  const invalid = await owner.request(endpoint, {
    method: "POST",
    body: {
      ...inviteBody("", "viewer", repo),
      recipientName: "Amy!",
    },
  });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.data));
  assert.equal(
    invalid.data.error?.code ?? invalid.data.code,
    "invalid_invitation_code",
  );

  const first = await owner.request(endpoint, {
    method: "POST",
    body: {
      ...inviteBody("", "viewer", repo),
      recipientName: "Nathan",
    },
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.token, "NATHAN");

  const reserved = await owner.request(endpoint, {
    method: "POST",
    body: {
      ...inviteBody("", "viewer", repo),
      recipientName: "  nathan  ",
    },
  });
  assert.equal(reserved.status, 409, JSON.stringify(reserved.data));
  assert.equal(
    reserved.data.error?.code ?? reserved.data.code,
    "invitation_code_unavailable",
  );
});

/**
 * Somebody already on Lattice, invited to a second repository.
 *
 * The account exists, so the invitation is not proof of who is holding the
 * link and a password in the body would only be a second way to be wrong
 * about that. Signing in is the proof, and the preview says which of the two
 * forms the recipient should be shown before they type anything into either.
 */
test("an invitation is claimed by an existing account by signing in", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner);

  const member = new TestClient(runtime.origin);
  const registered = await registerAccount(runtime.store, member, {
    email: "returning@example.com",
    displayName: "Returning",
    password: PASSWORD,
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.data));

  const invited = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("returning@example.com", "developer", repo) },
  );
  assert.equal(invited.status, 201, JSON.stringify(invited.data));
  const token = invited.data.token as string;

  // The preview tells the screen to offer sign-in rather than "choose a
  // password", which for a taken address can only ever fail.
  const anonymous = new TestClient(runtime.origin);
  const preview = await anonymous.request(`/api/v1/invitations/${token}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.invitation.accountExists, true);
  assert.equal(preview.data.invitation.signedIn, false);

  // Holding the link is still not enough on its own.
  const unauthenticated = await anonymous.request(
    `/api/v1/invitations/${token}/accept`,
    { method: "POST", body: { displayName: "Impostor", password: "NotTheirs123!" } },
  );
  assert.equal(unauthenticated.status, 409);
  assert.equal(unauthenticated.data.error.code, "account_exists");

  // Signing in as the invited address is, and the accept needs nothing in the
  // body: the session says who this is.
  const joiner = new TestClient(runtime.origin);
  const signedIn = await joiner.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "returning@example.com", password: PASSWORD },
  });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.data));
  const signedInPreview = await joiner.request(`/api/v1/invitations/${token}`);
  assert.equal(signedInPreview.status, 200);
  assert.equal(signedInPreview.data.invitation.signedIn, true);
  const accepted = await joiner.request(`/api/v1/invitations/${token}/accept`, {
    method: "POST",
    body: {},
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.user.email, "returning@example.com");
  assert.equal(accepted.data.user.id, registered.data.user.id);

  // The repository they were invited to is now reachable, and no second
  // account was made for the address.
  const reachable = await joiner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
  );
  assert.equal(reachable.status, 200);
  assert.equal(
    reachable.data.repositories.some((entry: { id: string }) => entry.id === repo),
    true,
  );
  const me = await joiner.request("/api/v1/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.user.id, registered.data.user.id);
});

test("a removed member can use a new invite link to regain project access", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "returning-member-repo");

  const returning = new TestClient(runtime.origin);
  const registered = await registerAccount(runtime.store, returning, {
    email: "removed@example.com",
    displayName: "Removed Member",
    password: PASSWORD,
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.data));
  const added = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/members`,
    {
      method: "POST",
      body: { userId: registered.data.user.id, role: "developer" },
    },
  );
  assert.equal(added.status, 201, JSON.stringify(added.data));

  // Refresh the member's session while the organization role exists, then
  // remove it. This is the real returning-member shape: the browser may still
  // hold the old session when the owner sends the replacement invitation.
  assert.equal(
    (
      await returning.request("/api/v1/auth/login", {
        method: "POST",
        body: { email: "removed@example.com", password: PASSWORD },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await owner.request(
        `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/members/${registered.data.user.id}`,
        { method: "DELETE" },
      )
    ).status,
    200,
  );

  const invited = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    {
      method: "POST",
      body: {
        role: "developer",
        repositoryId: repo,
        projectId: DEFAULT_PROJECT_ID,
      },
    },
  );
  assert.equal(invited.status, 201, JSON.stringify(invited.data));
  const token = invited.data.token as string;
  const preview = await returning.request(`/api/v1/invitations/${token}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.invitation.signedIn, true);

  const accepted = await returning.request(`/api/v1/invitations/${token}/accept`, {
    method: "POST",
    body: {},
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  const organizations = await returning.request("/api/v1/organizations");
  assert.equal(organizations.status, 200);
  assert.equal(
    organizations.data.organizations.some(
      (entry: { id: string }) => entry.id === DEFAULT_ORGANIZATION_ID,
    ),
    true,
  );
  const projects = await returning.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/projects`,
  );
  assert.equal(projects.status, 200, JSON.stringify(projects.data));
  assert.equal(
    projects.data.projects.some(
      (entry: { id: string }) => entry.id === DEFAULT_PROJECT_ID,
    ),
    true,
  );
});

test("an invitation works once and stops working when revoked", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner);

  const first = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("once@example.com", "viewer", repo) },
  );
  const token = first.data.token as string;
  const joiner = new TestClient(runtime.origin);
  assert.equal(
    (
      await joiner.request(`/api/v1/invitations/${token}/accept`, {
        method: "POST",
        body: { displayName: "Once", password: PASSWORD },
      })
    ).status,
    200,
  );
  // A used link is spent, not a standing grant.
  const replay = new TestClient(runtime.origin);
  assert.equal(
    (
      await replay.request(`/api/v1/invitations/${token}/accept`, {
        method: "POST",
        body: { displayName: "Impostor", password: PASSWORD },
      })
    ).status,
    409,
  );

  const second = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("revoked@example.com", "viewer", repo) },
  );
  await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations/${second.data.invitation.id}`,
    { method: "DELETE" },
  );
  const late = new TestClient(runtime.origin);
  assert.equal(
    (
      await late.request(`/api/v1/invitations/${second.data.token}/accept`, {
        method: "POST",
        body: { displayName: "Late", password: PASSWORD },
      })
    ).status,
    409,
  );
});

test("a wrong or forged invitation link is indistinguishable from a missing one", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner);
  const made = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("probe@example.com", "viewer", repo) },
  );
  const id = made.data.invitation.id as string;
  const anonymous = new TestClient(runtime.origin);
  // A real id with the wrong secret must answer exactly as a made-up id does,
  // or the endpoint confirms which invitations exist.
  for (const token of [`${id}.wrong-secret`, "inv_nope.whatever", "garbage"]) {
    assert.equal(
      (await anonymous.request(`/api/v1/invitations/${token}`)).status,
      404,
      token,
    );
  }
});

test("an invitation cannot hand out a role its sender could not assign", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner);

  // Bring in a developer, who may not manage members at all.
  const invite = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("dev@example.com", "developer", repo) },
  );
  const developer = new TestClient(runtime.origin);
  await developer.request(`/api/v1/invitations/${invite.data.token}/accept`, {
    method: "POST",
    body: { displayName: "Dev", password: PASSWORD },
  });
  const refused = await developer.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("escalate@example.com", "owner", repo) },
  );
  assert.equal(refused.status, 403);
});

test("an existing member can still be invited to a repository", async (t) => {
  // The organization-wide invitation refused this with `already_a_member`,
  // and it was right to: a second one added nothing. A repository grant is a
  // different offer — being in the organization does not mean being able to
  // reach a particular repository — so it is worth making to someone who is
  // already here.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const setup = await bootstrap(owner);
  const repo = await invitableRepository(owner);
  const again = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody(setup.user.email, "developer", repo) },
  );
  assert.equal(again.status, 201, JSON.stringify(again.data));
});

test("an invitation must name a repository", async (t) => {
  // The whole point of the change: there is no way to ask for the whole
  // organization. Omitting the repository is a bad request, not a wider grant.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const refused = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: { email: "everywhere@example.com", role: "developer" } },
  );
  assert.equal(refused.status, 400, JSON.stringify(refused.data));
});

/** Invites somebody to one repository and returns a client signed in as them. */
test("a repository invitation grants that repository and no other", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  for (const id of ["shared", "private"]) {
    assert.equal(
      (
        await owner.request(
          `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
          { method: "POST", body: { id, branch: "main" } },
        )
      ).status,
      201,
    );
  }

  const guest = await joinRepository(
    runtime,
    owner,
    "guest@example.com",
    "shared",
  );

  // The list is how the interface learns what exists, so it must not mention
  // the repository they were not given.
  const listed = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
  );
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.data.repositories.map((entry: { id: string }) => entry.id),
    ["shared"],
  );

  // And the routes enforce it independently of the list, answering exactly as
  // they would for a repository that does not exist.
  const refused = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/private/versions`,
  );
  assert.equal(refused.status, 404);
  const submitted = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks`,
    {
      method: "POST",
      body: { repositoryId: "private", objective: "Sneak a change in" },
    },
  );
  assert.equal(submitted.status, 404);

  // The one they were given genuinely works.
  const allowed = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks`,
    {
      method: "POST",
      body: { repositoryId: "shared", objective: "Do the work I was asked to" },
    },
  );
  assert.equal(allowed.status, 201, JSON.stringify(allowed.data));
});

test("a guest's task list shows only their own repository's work", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  for (const id of ["shared", "private"]) {
    await owner.request(`/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`, {
      method: "POST",
      body: { id, branch: "main" },
    });
    await owner.request(`/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks`, {
      method: "POST",
      body: { repositoryId: id, objective: `work on ${id}` },
    });
  }
  const guest = await joinRepository(
    runtime,
    owner,
    "reader@example.com",
    "shared",
  );
  const tasks = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks`,
  );
  assert.equal(tasks.status, 200);
  // Objectives are free text and often say more than a repository name does,
  // so a leak here would be a real disclosure rather than a cosmetic one.
  assert.deepEqual(
    tasks.data.tasks.map((task: { repositoryId: string }) => task.repositoryId),
    ["shared"],
  );

  const owned = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks`,
  );
  // The owner still sees everything: scoping an organization role down to
  // explicit grants would let owners lock themselves out of their own work.
  assert.equal(owned.data.tasks.length, 2);
});

test("an invitation reaches its own repository and no other", async (t) => {
  // This replaces a test asserting that an invitation reached *every*
  // repository the organization held. That was the upstream behaviour when an
  // invitation could omit its repository; it cannot any more, and the
  // guarantee is now the opposite one.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  for (const id of ["alpha", "beta"]) {
    await owner.request(`/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`, {
      method: "POST",
      body: { id, branch: "main" },
    });
  }
  const invited = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("staff@example.com", "developer", "alpha") },
  );
  assert.equal(invited.status, 201, JSON.stringify(invited.data));
  const member = new TestClient(runtime.origin);
  await member.request(`/api/v1/invitations/${invited.data.token}/accept`, {
    method: "POST",
    body: { displayName: "Staff", password: PASSWORD },
  });
  const listed = await member.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
  );
  assert.deepEqual(
    listed.data.repositories.map((entry: { id: string }) => entry.id).sort(),
    ["alpha"],
  );
});

test("a repository guest can find the project their repository is in", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  await owner.request(`/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`, {
    method: "POST",
    body: { id: "shared", branch: "main" },
  });
  const guest = await joinRepository(
    runtime,
    owner,
    "finder@example.com",
    "shared",
  );

  // A grant carries no organization membership, so listing organizations and
  // projects by membership alone would sign this person in successfully and
  // then show them nothing at all.
  const organizations = await guest.request("/api/v1/organizations");
  assert.equal(organizations.status, 200);
  assert.deepEqual(
    organizations.data.organizations.map((entry: { id: string }) => entry.id),
    [DEFAULT_ORGANIZATION_ID],
  );
  const projects = await guest.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/projects`,
  );
  assert.equal(projects.status, 200);
  assert.deepEqual(
    projects.data.projects.map((entry: { id: string }) => entry.id),
    [DEFAULT_PROJECT_ID],
  );
});

test("a stranger with no grant and no membership still sees nothing", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  // Reached through the admin path so this account has neither a membership
  // nor a grant — the case the projects fallback must not accidentally admit.
  await owner.request("/api/v1/admin/users", {
    method: "POST",
    body: {
      email: "stranger@example.com",
      displayName: "Stranger",
      password: PASSWORD,
    },
  });
  const stranger = new TestClient(runtime.origin);
  await stranger.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "stranger@example.com", password: PASSWORD },
  });
  assert.deepEqual(
    (await stranger.request("/api/v1/organizations")).data.organizations,
    [],
  );
  assert.equal(
    (
      await stranger.request(
        `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/projects`,
      )
    ).status,
    403,
  );
});

test("anybody can create an account, and it comes with somewhere to work", async (t) => {
  // Open registration: no invitation, no bootstrap token. What the new user
  // gets is their *own* organization and project, because an organization
  // role reaches every repository that organization holds — attaching them to
  // an existing one would hand a stranger everybody else's code.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  await invitableRepository(owner, "owners-repo");

  const newcomer = new TestClient(runtime.origin);
  const created = await registerAccount(runtime.store, newcomer, {
    email: "stranger@example.com",
    displayName: "Stranger",
    password: PASSWORD,
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.user.email, "stranger@example.com");
  // Signed in already: registering lands them inside, not back at a form.
  const me = await newcomer.request("/api/v1/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, "stranger@example.com");

  // Their own organization, owned by them, and not the bootstrap one.
  assert.equal(created.data.memberships.length, 1);
  assert.equal(created.data.memberships[0].role, "owner");
  assert.notEqual(created.data.memberships[0].organizationId, DEFAULT_ORGANIZATION_ID);

  // A project to put repositories in, which is the first thing they came for.
  const organizationId = created.data.memberships[0].organizationId;
  const projects = await newcomer.request(
    `/api/v1/organizations/${organizationId}/projects`,
  );
  assert.equal(projects.status, 200);
  assert.equal(projects.data.projects.length, 1);

  // And none of the bootstrap owner's work is visible to them.
  const theirs = await newcomer.request(
    `/api/v1/projects/${projects.data.projects[0].id}/repositories`,
  );
  assert.equal(theirs.status, 200);
  assert.deepEqual(theirs.data.repositories, []);
  const notTheirs = await newcomer.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
  );
  assert.equal(notTheirs.status === 200, false, "another team's project must not be readable");
});
