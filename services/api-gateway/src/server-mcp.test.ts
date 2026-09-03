/** The gateway over HTTP: tickets, app tokens, credentials and MCP. */

import assert from "node:assert/strict";
import {
  randomBytes,
} from "node:crypto";
import test from "node:test";
import {
  hashPassword,
} from "./auth.js";
import {
  isLoopbackCallback,
} from "./server.js";
import {
  type StripeClient,
} from "./stripe.js";
import {
  MCP_TEST_SECRET,
  PASSWORD,
  TestClient,
  agentSpeech,
  bareRequest,
  bearer,
  bootstrap,
  invitableRepository,
  inviteBody,
  joinAllConnectedAgents,
  listedTools,
  mcpHttpServerBody,
  mcpRuntime,
  proxyRuntime,
  registerAccount,
  rpc,
  seedTaskFor,
  startRuntime,
  upgradeEvents,
  waitFor,
  withEnvironment,
  withLocalAgentsOnly,
  withMcpServersEnabled,
  work,
} from "./test-harness.js";
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
} from "@coord/persistence";
import {
  createSecretSealer,
} from "@coord/workspace-manager";

test("a socket ticket is minted by any credential and spent exactly once", async (t) => {
  // A browser proves itself to an upgrade with its session cookie, which it
  // attaches on its own. `new WebSocket(url)` takes no headers, so a client
  // holding a bearer token — a desktop shell — has no way to present it. The
  // ticket is what goes in the URL instead of the token.
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const created = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "desktop", scopes: ["view"] },
  });
  assert.equal(created.status, 201);
  const token = created.data.token as string;

  // Minted by the credential that cannot be presented to an upgrade, which is
  // the entire reason this route exists.
  const byToken = await bearer(runtime.origin, "/api/v1/auth/ws-ticket", token, {
    method: "POST",
  });
  assert.equal(byToken.status, 201);
  assert.equal(typeof byToken.data.ticket, "string");
  assert.ok(byToken.data.expiresInMs > 0);

  // And by a session, so the browser is not a special case in the other
  // direction either.
  const bySession = await client.request("/api/v1/auth/ws-ticket", {
    method: "POST",
  });
  assert.equal(bySession.status, 201);
  assert.notEqual(bySession.data.ticket, byToken.data.ticket);

  // Spent. Whatever the upgrade then makes of the project, the ticket is gone.
  const ticket = String(byToken.data.ticket);
  const query = `projectId=absent&ticket=${encodeURIComponent(ticket)}`;
  await upgradeEvents(runtime.origin, query, "");
  const replayed = await upgradeEvents(runtime.origin, query, "");
  assert.equal(replayed.upgraded, false);
});

test("a bad ticket is refused rather than quietly falling back to the cookie", async (t) => {
  // The failure this shape invites: a client presents a ticket, the ticket is
  // expired or already spent, and the server tries the cookie next. On a
  // desktop shell there is no cookie and nothing happens — but in a browser,
  // where a stale session is usually lying around, a dead ticket would look
  // like a working one and the bug would only ever appear somewhere else.
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const refused = await upgradeEvents(
    runtime.origin,
    "projectId=absent&ticket=not-a-real-ticket",
    // A cookie that authenticates perfectly well on its own.
    client.cookieHeader,
  );
  assert.equal(refused.upgraded, false);
});

test("a token can be created, seen in the list, and revoked from a session", async (t) => {
  // The three calls the settings card makes, in the order it makes them. The
  // routes predate any UI reaching them, so this is the first thing to hold
  // them to the shape a screen actually reads: a secret exactly once, an
  // `active` flag to hide what has been revoked, and the fields the rows show.
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const empty = await client.request("/api/v1/auth/tokens");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.tokens, []);

  const created = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "My laptop", scopes: ["view", "run_task"] },
  });
  assert.equal(created.status, 201);
  assert.match(created.data.token as string, /^coord_pat_/u);

  const listed = await client.request("/api/v1/auth/tokens");
  assert.equal(listed.data.tokens.length, 1);
  const [row] = listed.data.tokens as Array<Record<string, unknown>>;
  assert.equal(row?.name, "My laptop");
  assert.equal(row?.active, true);
  assert.equal(typeof row?.createdAt, "string");
  // Never again. The store keeps a digest, so the list cannot show a secret
  // even to the person who made it — which is why the card has to.
  assert.equal(row?.token, undefined);
  assert.equal(row?.secret, undefined);

  const revoked = await client.request(
    `/api/v1/auth/tokens/${encodeURIComponent(String(row?.id))}`,
    { method: "DELETE" },
  );
  assert.ok(revoked.status === 200 || revoked.status === 204, String(revoked.status));

  const after = await client.request("/api/v1/auth/tokens");
  assert.equal(
    (after.data.tokens as Array<{ active?: boolean }>).filter(
      (entry) => entry.active !== false,
    ).length,
    0,
  );
});

test("an app callback is only ever an address on this machine", () => {
  // The one check this flow cannot get wrong. The browser is about to be sent
  // to this address carrying a code that buys a token, so anything that is not
  // loopback is not an open redirect — it is a way to have somebody sign in
  // and hand the result to whoever asked.
  for (const allowed of [
    "http://127.0.0.1:53127/callback",
    "http://localhost:8123/cb",
    "http://[::1]:9000/cb",
    // Any port, because the app takes whatever was free at startup.
    "http://127.0.0.1:1/cb",
  ]) {
    assert.equal(isLoopbackCallback(allowed), true, allowed);
  }

  for (const refused of [
    // The obvious one, and the whole reason for the check.
    "http://evil.example.com/cb",
    "https://evil.example.com/cb",
    // Hostnames that merely start or end like loopback.
    "http://127.0.0.1.evil.example.com/cb",
    "http://localhost.evil.example.com/cb",
    "http://notlocalhost/cb",
    // Credentials in the URL, which some parsers read as the host.
    "http://127.0.0.1@evil.example.com/cb",
    "http://user:pass@127.0.0.1/cb",
    // Schemes that are not a loopback listener at all.
    "file:///tmp/cb",
    "javascript:alert(1)",
    "data:text/html,<script>",
    "app://kumi/cb",
    // Not a URL.
    "",
    "not a url",
    "//127.0.0.1/cb",
  ]) {
    assert.equal(isLoopbackCallback(refused), false, refused);
  }
});

test("approving an app hands the browser a code, and the code buys one token", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const approved = await client.request(
    "/api/v1/auth/app-authorization/approve",
    {
      method: "POST",
      body: {
        name: "Kumi on my laptop",
        redirectUri: "http://127.0.0.1:53127/callback",
        state: "abc123",
      },
    },
  );
  assert.equal(approved.status, 201);

  // The redirect carries a code, never the token: a token in a redirect is a
  // token in the browser's history and in whatever the loopback server logs.
  const target = new URL(approved.data.redirectTo as string);
  assert.equal(target.origin, "http://127.0.0.1:53127");
  assert.equal(target.searchParams.get("state"), "abc123");
  const code = target.searchParams.get("code") ?? "";
  assert.ok(code.length > 20, code);
  assert.equal(target.searchParams.get("token"), null);

  // Exchanged with no credential at all, which is the point: the app has none
  // yet, and acquiring one is what the call is for.
  const exchanged = await bareRequest(
    runtime.origin,
    "/api/v1/auth/app-authorization/exchange",
    { code },
  );
  assert.equal(exchanged.status, 201);
  assert.match(exchanged.data.token as string, /^coord_pat_/u);
  assert.equal(exchanged.data.name, "Kumi on my laptop");

  // Spent. A second attempt with the same code is refused.
  const replayed = await bareRequest(
    runtime.origin,
    "/api/v1/auth/app-authorization/exchange",
    { code },
  );
  assert.equal(replayed.status, 400);

  // And the token it handed over actually works.
  const me = await bearer(
    runtime.origin,
    "/api/v1/auth/me",
    exchanged.data.token as string,
  );
  assert.equal(me.status, 200);
  assert.equal(me.data.credential, "api_token");

  // What the token may do, asked of the gateway rather than of a constant.
  //
  // The first version of this grant was `view` and `run_task`, and nothing
  // here noticed, because the only thing asserted was that the token worked
  // *somewhere*. It did — and then answered "This token does not carry the
  // import_repository scope" the first time somebody pushed to GitHub, which
  // is the ordinary way work leaves Kumi.
  //
  // Both directions are checked, and against a project that exists: the scope
  // check runs *after* the lookup, so aiming this at a made-up id would 404
  // before reaching the gate and pass no matter what the token carried.
  const imported = await bearer(
    runtime.origin,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
    exchanged.data.token as string,
    { method: "POST", body: {} },
  );
  assert.notEqual(
    imported.data?.error?.code,
    "token_scope_missing",
    "the app cannot import, sync, or push without import_repository",
  );

  // And a scope it must not have has to be refused by the scope check itself,
  // not merely by whatever role the approver happened to hold — the approver
  // here is the owner, so a role check alone would let this through.
  const organizations = await bearer(
    runtime.origin,
    "/api/v1/organizations",
    exchanged.data.token as string,
  );
  assert.equal(organizations.status, 200);
  const organizationId = (organizations.data.organizations ?? organizations.data)[0]
    ?.id as string;
  assert.ok(organizationId, "the bootstrap made no organization to rename");

  const renamed = await bearer(
    runtime.origin,
    `/api/v1/organizations/${organizationId}`,
    exchanged.data.token as string,
    { method: "PATCH", body: { name: "Somewhere else" } },
  );
  assert.equal(renamed.status, 403);
  assert.equal(renamed.data.error.code, "token_scope_missing");
});

test("an app cannot be approved for somewhere else, or by another app", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const offsite = await client.request(
    "/api/v1/auth/app-authorization/approve",
    {
      method: "POST",
      body: {
        name: "Definitely fine",
        redirectUri: "https://evil.example.com/cb",
        state: "x",
      },
    },
  );
  assert.equal(offsite.status, 400);
  assert.equal(offsite.data.error.code, "callback_rejected");

  // A token approving the next app would make revoking this one pointless —
  // the same rule minting a token by hand already follows.
  const created = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "existing", scopes: ["view"] },
  });
  const byToken = await bearer(
    runtime.origin,
    "/api/v1/auth/app-authorization/approve",
    created.data.token as string,
    {
      method: "POST",
      body: { name: "chained", redirectUri: "http://127.0.0.1:1/cb", state: "" },
    },
  );
  assert.equal(byToken.status, 403);
});

/* ------------------------------------------- payments switched off ------ */

test("with payments off the card path is closed and the waitlist is open", async (t) => {
  withEnvironment(t, { KUMI_PAYMENTS_ENABLED: undefined });
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);

  // Health says so first, because it is the one place an operator can look
  // when the answer surprises them.
  const health = await client.request("/api/v1/health");
  assert.equal(health.data.billing.payments, false);

  // The card path answers 501 and names the door that is open. It is not a
  // 404: the address is on links people already hold.
  const card = await client.request("/api/v1/auth/signup", {
    method: "POST",
    body: { email: "buyer@example.com" },
  });
  assert.equal(card.status, 501, JSON.stringify(card.data));
  assert.equal(card.data.error.code, "payments_disabled");
  assert.match(card.data.error.message, /waitlist/u);

  // Anybody may ask for a place, without an account and without a card.
  const joined = await client.request("/api/v1/waitlist", {
    method: "POST",
    body: {
      email: "Ada@Example.com",
      displayName: "Ada",
      note: "Two agents on one repo",
    },
  });
  assert.equal(joined.status, 202, JSON.stringify(joined.data));
  assert.equal(joined.data.waitlisted, true);
  assert.equal(joined.data.email, "ada@example.com");

  // Nothing was created that anybody can sign in to.
  assert.equal(await runtime.store.getUserByEmail("ada@example.com"), undefined);

  // And asking twice is one place, not two, with the same answer either way.
  const again = await client.request("/api/v1/waitlist", {
    method: "POST",
    body: { email: "ada@example.com", note: "Still interested" },
  });
  assert.equal(again.status, 202);
  assert.equal((await runtime.store.listWaitlistEntries()).length, 1);
});

test("registration admits the address an operator approved, and nobody else", async (t) => {
  withEnvironment(t, {
    KUMI_PAYMENTS_ENABLED: undefined,
    COORD_REQUIRE_EMAIL_CONFIRMATION: undefined,
  });
  const runtime = await startRuntime(t);
  const admin = new TestClient(runtime.origin);
  await bootstrap(admin);

  const stranger = new TestClient(runtime.origin);
  await stranger.request("/api/v1/waitlist", {
    method: "POST",
    body: { email: "ada@example.com", displayName: "Ada" },
  });

  // Still waiting: registration refuses, and says the same thing it would say
  // to an address that never asked at all.
  const early = await stranger.request("/api/v1/auth/register", {
    method: "POST",
    body: {
      email: "ada@example.com",
      displayName: "Ada",
      password: PASSWORD,
    },
  });
  assert.equal(early.status, 403, JSON.stringify(early.data));
  assert.equal(early.data.error.code, "waitlist_pending");
  const never = await stranger.request("/api/v1/auth/register", {
    method: "POST",
    body: {
      email: "nobody@example.com",
      displayName: "Nobody",
      password: PASSWORD,
    },
  });
  assert.equal(never.status, 403);
  assert.equal(never.data.error.code, "waitlist_pending");

  // The list is the operator's, and only the operator's.
  const refusedList = await stranger.request("/api/v1/admin/waitlist");
  assert.equal(refusedList.status, 401);
  const list = await admin.request("/api/v1/admin/waitlist");
  assert.equal(list.status, 200, JSON.stringify(list.data));
  assert.equal(list.data.waitlist.length, 1);
  const entryId = list.data.waitlist[0].id;

  const approved = await admin.request(
    `/api/v1/admin/waitlist/${entryId}/approve`,
    { method: "POST", body: {} },
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.approved, true);
  assert.notEqual(approved.data.entry.invitedAt, undefined);
  // Approving twice sends one welcome between them.
  const twice = await admin.request(
    `/api/v1/admin/waitlist/${entryId}/approve`,
    { method: "POST", body: {} },
  );
  assert.equal(twice.data.approved, false);

  // Now the address is through, and the account it builds is free.
  const created = await stranger.request("/api/v1/auth/register", {
    method: "POST",
    body: {
      email: "ada@example.com",
      displayName: "Ada",
      password: PASSWORD,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.user.email, "ada@example.com");
  assert.equal(created.data.memberships.length, 1);
  assert.equal(created.data.memberships[0].role, "owner");
  const subscription = await runtime.store.getSubscription(
    created.data.memberships[0].organizationId,
  );
  assert.equal(subscription?.status, "comped");
  assert.equal(subscription?.trialEndsAt, undefined);

  // And an address nobody approved is still refused after all that.
  const stillOut = await new TestClient(runtime.origin).request(
    "/api/v1/auth/register",
    {
      method: "POST",
      body: {
        email: "nobody@example.com",
        displayName: "Nobody",
        password: PASSWORD,
      },
    },
  );
  assert.equal(stillOut.status, 403);
});

test("with payments off nothing is billed, gated, or reachable at Stripe", async (t) => {
  withEnvironment(t, { KUMI_PAYMENTS_ENABLED: undefined });
  const stripeCalls: string[] = [];
  const runtime = await startRuntime(t, {
    // A perfectly good client, injected: the refusal below is a decision this
    // deployment made, not a key it is missing, and the two must not be
    // confused for each other.
    stripe: {
      async createCheckoutSession() {
        stripeCalls.push("checkout");
        return { id: "cs_1", url: "https://stripe.example/checkout" };
      },
      async createPortalSession() {
        stripeCalls.push("portal");
        return { url: "https://stripe.example/portal" };
      },
      async getSubscription() {
        stripeCalls.push("get");
        throw new Error("unused");
      },
      async getSubscriptionItemId() {
        stripeCalls.push("item");
        throw new Error("unused");
      },
      async updateSubscriptionQuantity() {
        stripeCalls.push("quantity");
      },
    } as unknown as StripeClient,
  });
  const client = new TestClient(runtime.origin);
  const owner = await bootstrap(client);
  const organizationId = owner.memberships[0].organizationId;

  // A subscription that would lock this team out if anybody were charging.
  await runtime.store.saveSubscription({ organizationId, status: "canceled" });

  const billing = await client.request(
    `/api/v1/organizations/${organizationId}/billing`,
  );
  assert.equal(billing.status, 200, JSON.stringify(billing.data));
  assert.equal(billing.data.billing.payments, false);
  assert.equal(billing.data.billing.configured, false);

  for (const path of ["billing/checkout", "billing/portal"]) {
    const refused = await client.request(
      `/api/v1/organizations/${organizationId}/${path}`,
      { method: "POST", body: {} },
    );
    assert.equal(refused.status, 501, `${path}: ${JSON.stringify(refused.data)}`);
    assert.equal(refused.data.error.code, "payments_disabled");
  }
  const webhook = await new TestClient(runtime.origin).request(
    "/api/v1/stripe/webhook",
    { method: "POST", raw: Buffer.from("{}"), rawType: "application/json" },
  );
  assert.equal(webhook.status, 501);
  assert.equal(webhook.data.error.code, "payments_disabled");
  assert.deepEqual(stripeCalls, [], "Stripe must not be called at all");

  // And a cancelled subscription gates nothing.
  //
  // Asked of somebody who is not a system administrator, because those are
  // exempt from the gate anyway and would prove nothing about it. This owner
  // is an ordinary one, their organization's subscription is cancelled, and
  // `manage_members` is a permission a folded `viewer` does not hold — so a
  // 403 here would be the gate closing, and anything else is it staying open.
  // (That it *does* close with payments on is pinned in billing.test.ts and
  // authorization.test.ts, which is where that rule lives.)
  const member = new TestClient(runtime.origin);
  const registered = await registerAccount(runtime.store, member, {
    email: "ordinary@example.com",
    displayName: "Ordinary",
    password: PASSWORD,
  });
  const ownOrganization = registered.data.memberships[0].organizationId;
  await runtime.store.saveSubscription({
    organizationId: ownOrganization,
    status: "canceled",
  });
  const invited = await member.request(
    `/api/v1/organizations/${ownOrganization}/invitations`,
    { method: "GET" },
  );
  assert.equal(
    invited.status,
    200,
    `a cancelled subscription must not gate anything: ${JSON.stringify(invited.data)}`,
  );
});

test("a repository's rooms are listed, gated and addressed one at a time", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "rooms");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}`;

  // A repository nobody has divided has exactly one room, and it is the one
  // every message written without a destination lands in — so the interface
  // in front of it is unchanged.
  const listed = await owner.request(`${base}/channels`);
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  assert.deepEqual(
    listed.data.channels.map((channel: { slug: string }) => channel.slug),
    ["general"],
  );
  assert.equal(listed.data.canManage, true);
  const general = listed.data.channels[0].id as string;

  const said = await owner.request(`${base}/channel/messages`, {
    method: "POST",
    body: { content: "Said before there was a second room." },
  });
  assert.equal(said.status, 201, JSON.stringify(said.data));
  assert.equal(said.data.message.channelId, general);

  // A typed name becomes a #handle: no spaces, no punctuation, because the
  // name is addressed inside running text.
  const created = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "Design Review", visibility: "private" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.channel.slug, "design-review");
  const design = created.data.channel.id as string;

  // Whoever made it is in it, so a private room is never created into a state
  // where nobody at all can read or post in it.
  const members = await owner.request(`${base}/channels/${design}/members`);
  assert.equal(members.status, 200);
  assert.equal(members.data.members.length, 1);

  const inDesign = await owner.request(`${base}/channel/messages`, {
    method: "POST",
    body: { channelId: design, content: "Only for the people in here." },
  });
  assert.equal(inDesign.status, 201, JSON.stringify(inDesign.data));

  // Each room reads only its own lines.
  const generalRead = await owner.request(
    `${base}/channel/messages?channelId=${encodeURIComponent(general)}`,
  );
  assert.deepEqual(
    generalRead.data.messages.map((message: { content: string }) => message.content),
    ["Said before there was a second room."],
  );
  const designRead = await owner.request(
    `${base}/channel/messages?channelId=${encodeURIComponent(design)}`,
  );
  assert.deepEqual(
    designRead.data.messages.map((message: { content: string }) => message.content),
    ["Only for the people in here."],
  );
  // No channelId at all still means #general, so a client that predates
  // sub-channels reads exactly what it always did.
  const unqualified = await owner.request(`${base}/channel/messages`);
  assert.deepEqual(
    unqualified.data.messages.map((message: { content: string }) => message.content),
    ["Said before there was a second room."],
  );

  // Somebody with a repository grant and no membership of the private room.
  const invited = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    { method: "POST", body: inviteBody("roomless@example.com", "developer", repo) },
  );
  assert.equal(invited.status, 201);
  const outsider = new TestClient(runtime.origin);
  const accepted = await outsider.request(
    `/api/v1/invitations/${invited.data.token as string}/accept`,
    { method: "POST", body: { displayName: "Roomless", password: PASSWORD } },
  );
  assert.equal(accepted.status, 200);
  const outsiderId = accepted.data.user.id as string;

  // Private means invisible, not forbidden: it is absent from the list, and
  // reading it answers 404 rather than a 403 that would confirm it exists and
  // name it.
  const outsiderList = await outsider.request(`${base}/channels`);
  assert.equal(outsiderList.status, 200);
  assert.deepEqual(
    outsiderList.data.channels.map((channel: { slug: string }) => channel.slug),
    ["general"],
  );
  assert.equal(outsiderList.data.canManage, false);
  const peeked = await outsider.request(
    `${base}/channel/messages?channelId=${encodeURIComponent(design)}`,
  );
  assert.equal(peeked.status, 404);
  assert.equal(peeked.data.error?.code ?? peeked.data.code, "not_found");
  const posted = await outsider.request(`${base}/channel/messages`, {
    method: "POST",
    body: { channelId: design, content: "Can I get in?" },
  });
  assert.equal(posted.status, 404);

  // Opened to the project, the same room becomes readable by everybody and
  // postable only by its members.
  // `open` is the old name for `read_only` and is still accepted, so a browser
  // holding a cached bundle keeps working across the deploy that renamed it.
  const opened = await owner.request(`${base}/channels/${design}`, {
    method: "PATCH",
    body: { visibility: "open" },
  });
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  const nowListed = await outsider.request(`${base}/channels`);
  assert.deepEqual(
    nowListed.data.channels.map((channel: { slug: string; canPost: boolean }) => [
      channel.slug,
      channel.canPost,
    ]),
    [
      ["general", true],
      ["design-review", false],
    ],
  );
  const nowRead = await outsider.request(
    `${base}/channel/messages?channelId=${encodeURIComponent(design)}`,
  );
  assert.equal(nowRead.status, 200);
  assert.equal(nowRead.data.channel.canPost, false);
  const stillRefused = await outsider.request(`${base}/channel/messages`, {
    method: "POST",
    body: { channelId: design, content: "Can I get in?" },
  });
  assert.equal(stillRefused.status, 403);
  assert.equal(
    stillRefused.data.error?.code ?? stillRefused.data.code,
    "not_a_member",
  );

  // Added, they can post — and only an administrator could have added them.
  const refusedAdd = await outsider.request(`${base}/channels/${design}/members`, {
    method: "POST",
    body: { userId: outsiderId },
  });
  assert.ok(
    refusedAdd.status === 403 || refusedAdd.status === 404,
    `only an administrator may edit a room's membership: ${refusedAdd.status}`,
  );
  const added = await owner.request(`${base}/channels/${design}/members`, {
    method: "POST",
    body: { userId: outsiderId },
  });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  const nowPosted = await outsider.request(`${base}/channel/messages`, {
    method: "POST",
    body: { channelId: design, content: "Thanks." },
  });
  assert.equal(nowPosted.status, 201, JSON.stringify(nowPosted.data));

  // #general is the fallback for every unaddressed message, so it can be
  // neither hidden nor removed.
  const hideGeneral = await owner.request(`${base}/channels/${general}`, {
    method: "PATCH",
    body: { visibility: "private" },
  });
  assert.equal(hideGeneral.status, 409);
  const dropGeneral = await owner.request(`${base}/channels/${general}`, {
    method: "DELETE",
  });
  assert.equal(dropGeneral.status, 409);

  // Deleting a room takes its transcript with it and leaves the rest alone.
  const dropped = await owner.request(`${base}/channels/${design}`, {
    method: "DELETE",
  });
  assert.equal(dropped.status, 200);
  const after = await owner.request(`${base}/channels`);
  assert.deepEqual(
    after.data.channels.map((channel: { slug: string }) => channel.slug),
    ["general"],
  );
  const survivors = await owner.request(`${base}/channel/messages`);
  assert.deepEqual(
    survivors.data.messages.map((message: { content: string }) => message.content),
    ["Said before there was a second room."],
  );
});

test("an @mention only reaches agents assigned to the room it was said in", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id as string;
  const repo = await invitableRepository(owner, "roomed-mentions");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}`;
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";
  const mention = `Codex (${String(session.user.displayName).split(" ")[0]})`;

  const created = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "backlog" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const backlog = created.data.channel.id as string;

  // The agent was added to #general, so the new room's roster is empty. An
  // agent is assigned per room, not per repository.
  const backlogRoster = await owner.request(
    `${base}/channel/agents?channelId=${encodeURIComponent(backlog)}`,
  );
  assert.equal(backlogRoster.status, 200, JSON.stringify(backlogRoster.data));
  assert.deepEqual(backlogRoster.data.agents, []);
  const generalRoster = await owner.request(`${base}/channel/agents`);
  assert.equal(generalRoster.data.agents.length, 1);

  // So the same words that would start work in #general start none here.
  const inBacklog = await owner.request(`${base}/channel/messages`, {
    method: "POST",
    body: { channelId: backlog, content: `@${mention} can you audit the codebase` },
  });
  assert.equal(inBacklog.status, 201, JSON.stringify(inBacklog.data));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(runtime.submittedTasks, []);

  // Assigned to this room, the same message is work.
  const joined = await owner.request(
    `${base}/channel/agents/openai/membership?channelId=${encodeURIComponent(backlog)}`,
    { method: "POST" },
  );
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
  const again = await owner.request(`${base}/channel/messages`, {
    method: "POST",
    body: { channelId: backlog, content: `@${mention} can you audit the codebase` },
  });
  assert.equal(again.status, 201, JSON.stringify(again.data));
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "asking an agent that is in this room never became work",
  );
});

/**
 * An agent exists because somebody asked for it, not because a secret is
 * stored.
 *
 * The roster used to be built by walking the credential store, so having an
 * agent required a vendor sign-in whose credential local execution then never
 * reads — the CLI runs under the machine's own login. Two sign-ins, one of
 * them for nothing, and a vendor secret this deployment was responsible for
 * and never used. Worse, it made "reconnect from Settings → Agents" the
 * offered remedy for a CLI that was not signed in, which it could not fix.
 */
test("an agent created without a credential is in the roster", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const account = await bootstrap(owner);
  const repo = await invitableRepository(owner, "credentialless");
  const roster = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`;

  // Nothing connected: the credential store is empty and so is the roster.
  const before = await owner.request(roster);
  assert.equal(before.status, 200, JSON.stringify(before.data));
  assert.equal(
    (before.data.agents ?? []).some(
      (agent: { provider: string }) => agent.provider === "anthropic",
    ),
    false,
  );

  const created = await owner.request("/api/v1/chat/providers/anthropic/agent", {
    method: "POST",
    body: {},
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  // Dealt a name rather than handed the vendor label. Storing
  // "Claude (Nathan)" would freeze the placeholder as the agent's permanent
  // name, which is the complaint the durable table exists to answer.
  const dealt = String(created.data.agent.callSign);
  assert.ok(dealt.length > 0);
  assert.doesNotMatch(dealt, /\(/u);
  assert.equal(created.data.agent.visibility, "personal");

  // Membership is a separate opt-in, exactly as it is on the credential path —
  // `addAgentToAllRepositories` is what the connect flow calls next. Being
  // reachable makes an agent eligible for a room; it does not put it in one.
  const joined = await owner.request(`${roster}/anthropic/membership`, {
    method: "POST",
  });
  assert.equal(joined.status, 200, JSON.stringify(joined.data));

  const after = await owner.request(roster);
  assert.equal(after.status, 200, JSON.stringify(after.data));
  const listed = (after.data.agents ?? []).filter(
    (agent: { provider: string }) => agent.provider === "anthropic",
  );
  assert.equal(listed.length, 1, "exactly one, never doubled");
  assert.equal(listed[0].name, dealt);
  assert.equal(listed[0].userId, account.user.id);
});

/**
 * The Settings screen asks a different question than the roster, and until
 * this it got the old answer.
 *
 * A row there drew "Not connected" with a Connect button next to an agent
 * somebody had just finished connecting — because both the status line and
 * the button branched on whether a *credential* was stored, which stopped
 * being what having an agent means. The browser cannot work the difference
 * out on its own: the provider list it reads is built from the credential
 * store, so an agent with no credential is simply absent from it. The two
 * fields asserted here are what let it ask the right question.
 */
test("the provider list says an agent exists without a credential", async (t) => {
  withLocalAgentsOnly(t);
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const before = await owner.request("/api/v1/chat/providers");
  assert.equal(before.status, 200, JSON.stringify(before.data));
  // Deployment-wide, and carried here because Settings can be opened without
  // ever visiting a channel — the roster response that also carries it may
  // never have been fetched.
  assert.equal(before.data.localAgentsOnly, true);
  const listedBefore = (before.data.providers as Array<{ id: string; exists: boolean }>);
  assert.equal(listedBefore.find((entry) => entry.id === "openai")?.exists, false);

  const created = await owner.request("/api/v1/chat/providers/openai/agent", {
    method: "POST",
    body: {},
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));

  const after = await owner.request("/api/v1/chat/providers");
  const listed = after.data.providers as Array<{
    id: string;
    exists: boolean;
    ownCredential?: unknown;
  }>;
  const openai = listed.find((entry) => entry.id === "openai");
  assert.equal(openai?.exists, true, JSON.stringify(listed));
  // And no credential was invented to say so — that is the whole point.
  assert.equal(openai?.ownCredential, undefined);
  // Untouched vendors stay untouched.
  assert.equal(listed.find((entry) => entry.id === "cursor")?.exists, false);
});

/**
 * A stored credential is still an agent. The field says so directly rather
 * than leaving the browser to infer it, so a connection made before agents
 * had their own record does not read as "connect this".
 */
test("a stored credential alone makes an agent exist", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const account = await bootstrap(owner);
  runtime.chatConnections.set(account.user.id, [{ provider: "anthropic" }]);

  const listed = (await owner.request("/api/v1/chat/providers")).data
    .providers as Array<{ id: string; exists: boolean }>;
  assert.equal(listed.find((entry) => entry.id === "anthropic")?.exists, true);
  assert.equal(listed.find((entry) => entry.id === "openai")?.exists, false);
});

/**
 * The audit log is the one table that only grew.
 *
 * Every other cost went flat when execution moved to the machines that do the
 * work; this one is written here whatever runs where — measured, about
 * twenty-one rows a task — and nothing had ever removed one. The archive,
 * checkpoint and prune machinery existed from the start and had no caller
 * outside a command an operator had to remember.
 */
test("the audit log is compacted on a retention window", async (t) => {
  const runtime = await startRuntime(t, {
    // Everything already written is older than "zero days ago", so the first
    // sweep has something to find without the test faking a clock.
    auditRetentionDays: 0.000_001,
    auditRetentionSweepIntervalMs: 50,
  });
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  await invitableRepository(owner, "compacted");

  const before = (await runtime.store.listAuditEvents()).length;
  assert.ok(before > 0, "bootstrapping writes events worth compacting");

  await waitFor(
    async () => (await runtime.store.listAuditCheckpoints()).length > 0,
    "the retention sweep never archived anything",
  );
  // Archived and then dropped: the rows are gone from the live log, and gone
  // from the archive too, which is what actually reclaims the space.
  await waitFor(
    async () => (await runtime.store.listArchivedAuditEvents()).length === 0,
    "archived events were never pruned, so nothing was reclaimed",
  );
  assert.ok(
    (await runtime.store.listAuditEvents()).length < before,
    "the live log must actually shrink",
  );
  // The attestation survives the contents. That is the whole bargain.
  const checkpoints = await runtime.store.listAuditCheckpoints();
  assert.ok(
    (checkpoints[0]?.throughSequence ?? 0) >= 1,
    JSON.stringify(checkpoints),
  );
});

/**
 * Zero is a real answer, not a missing one. A deployment under a legal hold
 * keeps every event and pays for the disk.
 */
test("a retention of zero keeps everything", async (t) => {
  const runtime = await startRuntime(t, {
    auditRetentionDays: 0,
    auditRetentionSweepIntervalMs: 50,
  });
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const before = (await runtime.store.listAuditEvents()).length;
  assert.ok(before > 0);

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await runtime.store.listAuditCheckpoints()).length, 0);
  assert.ok((await runtime.store.listAuditEvents()).length >= before);
});

/**
 * The deployment does not answer on its own account.
 *
 * A question whose agent has no live machine used to be answered here, and
 * with no credential of the owner's the vendor CLI ran on the container's
 * ambient login — the operator's account, for a full agent run, posted under
 * the agent's own name and indistinguishable from the real thing. Rare while a
 * vendor sign-in was the price of an agent; the default once it was not.
 */
test("with local agents only, a question is refused rather than billed here", async (t) => {
  withLocalAgentsOnly(t);
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const account = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "no-house-account");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  // An agent with a name and no credential — the ordinary local agent — and
  // no worker anywhere, so nothing of its owner's can answer.
  await owner.request("/api/v1/chat/providers/anthropic/agent", {
    method: "POST",
    body: {},
  });
  await owner.request(`${base}/agents/anthropic/membership`, { method: "POST" });
  const roster = (await owner.request(`${base}/agents`)).data.agents as Array<{
    provider: string;
    name: string;
  }>;
  const mention = roster.find((agent) => agent.provider === "anthropic")?.name;
  assert.ok(mention !== undefined, JSON.stringify(roster));

  const before = runtime.chatPrompts.length;
  const asked = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: `@${mention} what does the coordinator do?` },
  });
  assert.equal(asked.status, 201, JSON.stringify(asked.data));

  // The load-bearing assertion: no model was run here at all.
  assert.equal(
    runtime.chatPrompts.length,
    before,
    "answering with no credential of the owner's spends the deployment's own",
  );

  // And the person who asked is told why, with the two things that fix it.
  const messages = (await owner.request(`${base}/messages`)).data
    .messages as Array<{ kind: string; content: string }>;
  const reply = messages.filter((message) => message.kind === "agent").at(-1);
  assert.ok(reply !== undefined, JSON.stringify(messages));
  assert.match(String(reply.content), /machine/u);
  assert.match(String(reply.content), /Settings → Agents/u);
});

/**
 * The other side of the same gate: an owner who *has* linked an account is
 * spending their own, so answering here is exactly what they asked for.
 */
test("with local agents only, a linked account is still answered here", async (t) => {
  withLocalAgentsOnly(t);
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const account = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "linked-account");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(account.user.id, [
    { provider: "anthropic", visibility: "personal", callSign: "Athena" },
  ]);
  await owner.request(`${base}/agents/anthropic/membership`, { method: "POST" });

  const before = runtime.chatPrompts.length;
  const asked = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Athena what does the coordinator do?" },
  });
  assert.equal(asked.status, 201, JSON.stringify(asked.data));
  assert.equal(
    runtime.chatPrompts.length > before,
    true,
    "a credential of one's own is the thing that makes answering here fine",
  );
});

/**
 * An agent can be removed, including the kind that has no credential to
 * remove.
 *
 * Disconnecting used to mean destroying a stored secret, which was the whole
 * of it while the secret was the identity. Once an agent became a record of
 * its own, that left two holes at once: an agent with a credential stayed in
 * every channel after being "disconnected", and an agent without one could be
 * created and never removed.
 */
test("disconnecting an agent with no credential removes it everywhere", async (t) => {
  withLocalAgentsOnly(t);
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "removable");
  const roster = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`;

  const created = await owner.request("/api/v1/chat/providers/openai/agent", {
    method: "POST",
    body: {},
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  await owner.request(`${roster}/openai/membership`, { method: "POST" });

  const listed = (await owner.request(roster)).data.agents as Array<{
    provider: string;
  }>;
  assert.equal(listed.some((agent) => agent.provider === "openai"), true);

  const removed = await owner.request("/api/v1/chat/providers/openai", {
    method: "DELETE",
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));

  // Gone from the roster, so nothing can @mention it into work any more.
  const after = (await owner.request(roster)).data.agents as Array<{
    provider: string;
  }>;
  assert.equal(
    after.some((agent) => agent.provider === "openai"),
    false,
    "a membership row must not keep a removed agent in the room",
  );
  // And gone from the Settings screen's own question.
  const providers = (await owner.request("/api/v1/chat/providers")).data
    .providers as Array<{ id: string; exists: boolean }>;
  assert.equal(providers.find((entry) => entry.id === "openai")?.exists, false);
});

/**
 * The same button, on the shape it was written for. Destroying the credential
 * was never enough on its own: the record outlived it and went on naming an
 * agent in every channel.
 */
test("disconnecting an agent with a credential removes its record too", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const account = await bootstrap(owner);
  const repo = await invitableRepository(owner, "credentialed-removal");
  const roster = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`;
  runtime.chatConnections.set(account.user.id, [
    { provider: "anthropic", visibility: "personal", callSign: "Athena" },
  ]);
  await runtime.store.setAgentCallSign(account.user.id, "anthropic", "Athena");
  await owner.request(`${roster}/anthropic/membership`, { method: "POST" });
  assert.equal(
    ((await owner.request(roster)).data.agents as Array<{ provider: string }>)
      .some((agent) => agent.provider === "anthropic"),
    true,
  );

  await owner.request("/api/v1/chat/providers/anthropic", { method: "DELETE" });

  assert.equal(
    ((await owner.request(roster)).data.agents as Array<{ provider: string }>)
      .some((agent) => agent.provider === "anthropic"),
    false,
    "the record outliving the credential is what kept it listed",
  );
});

/**
 * A removed agent must not leave its name behind in a room.
 *
 * A per-channel override outranks the call sign there, and it is keyed
 * `${userId}:${provider}` — which the next agent dealt for that account and
 * vendor also is. Left standing, a brand-new agent inherits the removed one's
 * name in every room the removed one had been named in. The rename path
 * already clears these for the weaker version of the same reason.
 */
test("disconnecting clears the names an agent was given in rooms", async (t) => {
  withLocalAgentsOnly(t);
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const account = await bootstrap(owner);
  const repo = await invitableRepository(owner, "named-in-a-room");
  const roster = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`;

  await owner.request("/api/v1/chat/providers/openai/agent", {
    method: "POST",
    body: {},
  });
  await owner.request(`${roster}/openai/membership`, { method: "POST" });
  // Named in this one room, and given a role, which is a different kind of
  // fact and must survive.
  await runtime.store.setChannelAgentOverride(repo, `${account.user.id}:openai`, {
    name: "Eris",
    role: "Lead Developer",
  });

  await owner.request("/api/v1/chat/providers/openai", { method: "DELETE" });

  const overrides = await runtime.store.listChannelAgentOverrides(repo);
  const mine = overrides[`${account.user.id}:openai`];
  assert.equal(mine?.name, undefined, "the name must not outlive the agent");
  assert.equal(mine?.role, "Lead Developer", "the seat's own decision stays");
});

/**
 * Both halves describe the same agent, so the roster must not list it twice.
 *
 * This is the load-bearing risk of the union: the same set feeds @mention
 * dispatch, and a duplicate there means two agents answering one mention while
 * a miss means an agent nobody can reach.
 */
test("a credential and a record for one agent are one row", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const account = await bootstrap(owner);
  const repo = await invitableRepository(owner, "both-halves");
  const roster = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`;

  // A credential exists, as it would for anyone who connected before this.
  runtime.chatConnections.set(account.user.id, [
    { provider: "anthropic", visibility: "org", callSign: "Athena" },
  ]);
  await owner.request("/api/v1/chat/providers/anthropic/agent", {
    method: "POST",
    body: {},
  });
  await owner.request(`${roster}/anthropic/membership`, { method: "POST" });

  const after = await owner.request(roster);
  const listed = (after.data.agents ?? []).filter(
    (agent: { provider: string }) => agent.provider === "anthropic",
  );
  assert.equal(listed.length, 1, "the union deduplicates by (user, provider)");
  // The credential's answer wins: it is the record being edited when somebody
  // changes their settings, and both halves describe the same agent.
  assert.equal(listed[0].name, "Athena");
  assert.equal(listed[0].visibility, "org");
});

/**
 * The call-sign table is account-wide and knows nothing about organizations.
 * Reading it into a roster unscoped would list agents belonging to strangers.
 */
test("a record for somebody outside the repository is not listed", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "scoped");

  await runtime.store.setAgentCallSign("user_stranger", "openai", "Vesta");

  const after = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`,
  );
  assert.equal(
    (after.data.agents ?? []).some(
      (agent: { name: string }) => agent.name === "Vesta",
    ),
    false,
  );
});

/** Re-running connect must not rename an agent people have learned. */
test("creating an agent twice keeps the name it was dealt", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const first = await owner.request("/api/v1/chat/providers/openai/agent", {
    method: "POST",
    body: {},
  });
  const again = await owner.request("/api/v1/chat/providers/openai/agent", {
    method: "POST",
    body: {},
  });
  assert.equal(again.data.agent.callSign, first.data.agent.callSign);
});

/**
 * Kumi over MCP: the endpoint a co-founder adds to Claude Code or Cursor.
 *
 * These go through real HTTP with a real bearer token, because the three
 * things most likely to break are not in the protocol layer: the token path,
 * the absence of an `Origin` header, and whether a tool's answer is a sentence
 * a model can act on.
 */
test("an MCP client can hand-shake and see the tools", async (t) => {
  const { runtime, token } = await mcpRuntime(t);

  const hello = await rpc(runtime.origin, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {} },
  });
  assert.equal(hello.status, 200);
  assert.deepEqual(hello.data.result.capabilities, { tools: {} });
  assert.equal(hello.data.result.serverInfo.name, "kumi");

  // No Origin header is sent, which is what every non-browser client does.
  // The gateway's origin check must let that through or nothing works.
  const listed = await rpc(runtime.origin, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(
    (listed.data.result.tools as Array<{ name: string }>).map((tool) => tool.name),
    [
      "list_repositories",
      "submit_task",
      "task_status",
      "cancel_task",
      "answer_question",
      "take_task",
      "report_task",
      "extend_task",
      "task_progress",
    ],
  );
});

/**
 * The other direction: the editor does the work itself.
 *
 * Everything about admission, integration and canonical is tested against a
 * real repository in `apps/cli/src/editor-work.test.ts`. What is only
 * testable here is the part that is about the wire: which scope these ask
 * for, whose lease a caller may touch, and whether the bundle a `git fetch`
 * needs can be reached without handing an editor a worker's permissions.
 */
test("an editor takes a task, is told the revision, and reports it done", async (t) => {
  const { runtime, token, user, repositoryId } = await mcpRuntime(t);
  const task = await seedTaskFor(runtime, repositoryId, user.id);

  const taken = await work(runtime.origin, token, "take_task", {
    editor: "claude",
  });
  assert.equal(taken.isError, undefined, taken.text);
  assert.match(taken.text, /raise the retry ceiling/u);
  assert.match(taken.text, new RegExp(task.id, "u"));
  assert.match(taken.text, /a{40}/u);
  // Off the queue while the editor has it, which is the whole reason a lease
  // is taken at all: a desktop worker must not run the same objective.
  assert.equal(
    (await runtime.store.getSubmittedTask(task.id))?.status,
    "claimed",
  );

  const filed = await work(
    runtime.origin,
    token,
    "report_task",
    { task_id: task.id, summary: "Raised it." },
    2,
  );
  assert.equal(filed.isError, undefined, filed.text);
  const leases = await runtime.store.listWorkLeases({});
  assert.equal(leases.at(-1)?.status, "completed");
});

test("an editor cannot report on a hold that is somebody else's", async (t) => {
  const { runtime, owner, token, user, repositoryId } = await mcpRuntime(t);
  const task = await seedTaskFor(runtime, repositoryId, user.id);
  await work(runtime.origin, token, "take_task", { editor: "claude" });

  // A second developer in the same organization, with a token of their own.
  // Not an outsider: the point is that being able to *see* a task is not
  // being able to touch the hold somebody else has on it.
  const colleague = await runtime.store.createUser({
    email: "colleague@example.com",
    displayName: "Colleague",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: colleague.id,
    role: "developer",
  });
  const intruder = new TestClient(runtime.origin);
  await intruder.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "colleague@example.com", password: PASSWORD },
  });
  const theirToken = await intruder.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "editor", scopes: ["view", "submit_task"] },
  });
  assert.equal(theirToken.status, 201, JSON.stringify(theirToken.data));
  const stolen = await work(
    runtime.origin,
    theirToken.data.token as string,
    "report_task",
    { task_id: task.id, summary: "mine now" },
    3,
  );
  assert.equal(stolen.isError, true);
  assert.match(stolen.text, /somebody else/u);
  // The hold is untouched, which is the half that matters: the refusal must
  // not have settled the lease on its way out.
  assert.equal((await runtime.store.listWorkLeases({})).at(-1)?.status, "active");
  void owner;
});

test("the work tools refuse a token without submit_task", async (t) => {
  const { runtime, token, user, repositoryId } = await mcpRuntime(t, ["view"]);
  await seedTaskFor(runtime, repositoryId, user.id);
  const refused = await work(runtime.origin, token, "take_task", {
    editor: "claude",
  });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /submit_task/u);
  // Nothing was leased on the way to the refusal.
  assert.deepEqual(await runtime.store.listWorkLeases({}), []);
});

test("the bundle link works once, and only for the person it was issued to", async (t) => {
  const { runtime, owner, token, user, repositoryId } = await mcpRuntime(t);
  const first = await seedTaskFor(runtime, repositoryId, user.id);
  const taken = await work(runtime.origin, token, "take_task", {
    editor: "claude",
  });
  const link = /(\/api\/v1\/mcp\/bundle\/[A-Za-z0-9-]+)/u.exec(taken.text)?.[1];
  assert.ok(link, taken.text);

  // No Authorization header at all: the caller is a `curl` on somebody's
  // laptop, and the ticket in the path is what stands in for one.
  const fetched = await fetch(`${runtime.origin}${link}`);
  assert.equal(fetched.status, 200);
  assert.equal(
    fetched.headers.get("content-type"),
    "application/octet-stream",
  );
  assert.ok((await fetched.arrayBuffer()).byteLength > 0);

  // Spent. The URL travels through a model transcript and a shell history, so
  // a second use has to be worth nothing.
  assert.equal((await fetch(`${runtime.origin}${link}`)).status, 404);
  // And an invented one is worth nothing either.
  assert.equal(
    (await fetch(`${runtime.origin}/api/v1/mcp/bundle/not-a-real-ticket`)).status,
    404,
  );

  // A ticket for a hold that has since been settled is refused rather than
  // served: the bundle is a snapshot of a lease, and a lease that is over is
  // not a thing to hand anybody the repository for.
  // Given back and taken again, so there is a fresh ticket to let go stale.
  // A repository runs one lease at a time, so the first hold has to end
  // before a second can begin.
  await work(
    runtime.origin,
    token,
    "report_task",
    { task_id: first.id, status: "released" },
    8,
  );
  const again = await work(
    runtime.origin,
    token,
    "take_task",
    { editor: "claude" },
    9,
  );
  const stale = /(\/api\/v1\/mcp\/bundle\/[A-Za-z0-9-]+)/u.exec(again.text)?.[1];
  assert.ok(stale, again.text);
  const gave = await work(
    runtime.origin,
    token,
    "report_task",
    { task_id: first.id, status: "released" },
    10,
  );
  assert.equal(gave.isError, undefined, gave.text);
  assert.equal((await fetch(`${runtime.origin}${stale}`)).status, 409);
  void owner;
});

test("an editor that took work reads as online to the room", async (t) => {
  // Liveness is only a question this deployment asks: everywhere else the
  // control plane can run an agent itself, so whether its owner is at a
  // keyboard is not a fact worth acting on.
  withLocalAgentsOnly(t);
  const { runtime, owner, token, user, repositoryId } = await mcpRuntime(t);
  // Nobody has a machine listening: the agent is offline, and the room says
  // so before anything is taken.
  const before = await work(runtime.origin, token, "list_repositories", {}, 4);
  assert.match(before.text, /@.+ — offline/u);

  await seedTaskFor(runtime, repositoryId, user.id);
  const taken = await work(runtime.origin, token, "take_task", {
    editor: "claude",
  });
  assert.equal(taken.isError, undefined, taken.text);

  // Taking work is the one act that proves an editor is at a keyboard and
  // will come back, and liveness has to be answered in one place: the roster
  // and dispatch read the same map, or an agent reads available here and
  // "nothing is running it yet" there.
  const after = await work(runtime.origin, token, "list_repositories", {}, 5);
  assert.match(after.text, /@.+ — online/u);

  // And it stays online past the point a worker would have gone quiet. This
  // is the whole reason presence is declared rather than inferred from a
  // heartbeat: an editor cannot be woken, so nothing beats on its behalf, and
  // a window that lapsed after three minutes would make an agent read as
  // offline while it was demonstrably running something.
  for (const worker of await runtime.store.listWorkers({
    organizationId: DEFAULT_ORGANIZATION_ID,
  })) {
    await runtime.store.touchWorker(
      worker.id,
      new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    );
  }
  const later = await work(runtime.origin, token, "list_repositories", {}, 6);
  assert.match(later.text, /@.+ — online/u);
  void owner;
});

test("extending a hold nobody holds is refused rather than invented", async (t) => {
  const { runtime, token, user, repositoryId } = await mcpRuntime(t);
  const task = await seedTaskFor(runtime, repositoryId, user.id);
  const missed = await work(
    runtime.origin,
    token,
    "extend_task",
    { task_id: task.id },
    6,
  );
  assert.equal(missed.isError, true);
  assert.match(missed.text, /take_task/u);

  await work(runtime.origin, token, "take_task", { editor: "claude" }, 7);
  const held = (await runtime.store.listWorkLeases({})).at(-1);
  const pushed = await work(
    runtime.origin,
    token,
    "extend_task",
    { task_id: task.id, minutes: 45 },
    8,
  );
  assert.equal(pushed.isError, undefined, pushed.text);
  const now = (await runtime.store.getWorkLease(held?.id ?? ""))?.expiresAt;
  assert.ok(
    new Date(now ?? 0).getTime() > new Date(held?.expiresAt ?? 0).getTime(),
  );
});

test("an agent that is only in an editor is not said to be working on it", async (t) => {
  // The gap the presence merge opened. An editor is live in the sense the
  // roster cares about, so folding it in was right; but it cannot be woken,
  // and the acknowledgement used to read the two the same way. Somebody
  // whose desktop was closed and whose editor had taken work an hour ago was
  // told "I've taken this task and I'm working on it" while nothing was.
  withLocalAgentsOnly(t);
  const { runtime, owner, token, user, repositoryId } = await mcpRuntime(t);

  // Presence, declared the only way it can be: by taking work.
  const first = await seedTaskFor(runtime, repositoryId, user.id, "the first one");
  const taken = await work(runtime.origin, token, "take_task", {
    editor: "claude",
  });
  assert.equal(taken.isError, undefined, taken.text);
  await work(
    runtime.origin,
    token,
    "report_task",
    { task_id: first.id, status: "released" },
    2,
  );

  // Now a mention typed in Kumi, with no desktop worker anywhere.
  const roster = await work(runtime.origin, token, "list_repositories", {}, 3);
  const agent = /@(.+?) — /u.exec(roster.text)?.[1];
  assert.ok(agent, roster.text);
  assert.match(roster.text, /— online/u, "presence did not hold");
  const posted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages`,
    { method: "POST", body: { content: `@${agent} raise the retry ceiling` } },
  );
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  const after = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages`,
  );
  const said = agentSpeech(after.data.messages)
    .map((message: { content: string }) => message.content)
    .join("\n");
  assert.match(said, /pick it up the next time I'm asked/u);
  // The two sentences that would each be untrue: nothing has begun, and it is
  // not true either that no machine of theirs is online.
  assert.doesNotMatch(said, /I'm working on it/u);
  assert.doesNotMatch(said, /isn't online/u);
});

test("a run done in an editor narrates itself into the thread", async (t) => {
  // The gap this closes: a desktop worker posts progress as it goes and an
  // editor posted nothing, so a task done from Cursor showed "taken" and then
  // silence until it was over. Twenty minutes of that is indistinguishable
  // from a hang, which is the exact failure the worker's progress route was
  // written to remove.
  const { runtime, token, user, repositoryId } = await mcpRuntime(t);
  const task = await seedTaskFor(runtime, repositoryId, user.id);
  const taken = await work(runtime.origin, token, "take_task", {
    editor: "claude",
  });
  assert.equal(taken.isError, undefined, taken.text);

  // Shortened first, so the renewal below is something that can be seen. A
  // hold taken seconds ago already runs for half an hour, and asserting
  // against that would pass whether or not anything renewed it.
  await work(
    runtime.origin,
    token,
    "extend_task",
    { task_id: task.id, minutes: 1 },
    2,
  );
  const shortened = (await runtime.store.listWorkLeases({ status: "active" })).at(-1);
  assert.ok(shortened);
  assert.ok(
    new Date(shortened.expiresAt).getTime() < Date.now() + 5 * 60 * 1000,
  );

  const posted = await work(
    runtime.origin,
    token,
    "task_progress",
    { task_id: task.id, message: "reading the redirect handler" },
    3,
  );
  assert.equal(posted.isError, undefined, posted.text);

  // The same event a worker writes, so the watcher narrates it into the
  // thread without knowing which end produced it.
  const events = await runtime.store.listAuditEvents({
    taskId: task.id,
    types: ["agent_progress"],
  });
  assert.equal(events.length, 1);
  assert.equal(
    events[0]?.event.data["message"],
    "reading the redirect handler",
  );
  assert.equal(events[0]?.event.data["repositoryId"], repositoryId);

  // And it renews the hold, because a line of progress is evidence of life.
  // An editor narrating its work for thirty-five minutes must not lose the
  // task at the half hour for want of a separate call.
  const held = (await runtime.store.listWorkLeases({ status: "active" })).at(-1);
  assert.ok(held, "the hold was not kept");
  assert.ok(
    new Date(held.expiresAt).getTime() > Date.now() + 25 * 60 * 1000,
  );
});

test("progress on a task somebody else holds is refused", async (t) => {
  const { runtime, token, user, repositoryId } = await mcpRuntime(t);
  const task = await seedTaskFor(runtime, repositoryId, user.id);
  // Nobody has taken it, so there is no run for a line to belong to.
  const refused = await work(
    runtime.origin,
    token,
    "task_progress",
    { task_id: task.id, message: "pretending to work on this" },
    3,
  );
  assert.equal(refused.isError, true);
  assert.match(refused.text, /not holding/u);
  assert.deepEqual(
    await runtime.store.listAuditEvents({
      taskId: task.id,
      types: ["agent_progress"],
    }),
    [],
  );
});

test("a misconfigured Authorization header says which way it is wrong", async (t) => {
  // Both of these were answered "Sign in is required" — a sentence about a
  // browser, sent to a CLI that has no cookies and was never going to get
  // any. Between them they are most of what goes wrong setting this up, and
  // neither is a fact about anybody's account, so both can be said plainly.
  const { runtime, token } = await mcpRuntime(t);
  const send = async (authorization: string) => {
    const response = await fetch(`${runtime.origin}/api/v1/mcp`, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    return {
      status: response.status,
      challenge: response.headers.get("www-authenticate"),
      message: String(
        ((await response.json()) as { error?: { message?: string } }).error
          ?.message ?? "",
      ),
    };
  };

  // The scheme left off entirely.
  const bare = await send(token);
  assert.equal(bare.status, 401);
  assert.match(bare.message, /must read "Bearer <token>"/u);

  // The placeholder pasted with its brackets still on.
  const wrapped = await send(`Bearer <${token}>`);
  assert.equal(wrapped.status, 401);
  assert.match(wrapped.message, /angle brackets/u);

  // A well-formed header carrying a token that is simply wrong stays
  // uniform: "invalid" and nothing more, or the answer becomes an oracle.
  const wrong = await send("Bearer coord_pat_aaaaaaaa.bbbbbbbb");
  assert.equal(wrong.status, 401);
  assert.match(wrong.message, /API token is invalid/u);

  // Every 401 on this route carries the challenge, which is how an MCP
  // client tells "wants a token" from "server is broken".
  for (const answer of [bare, wrapped, wrong]) {
    assert.match(answer.challenge ?? "", /^Bearer\b/u, "no WWW-Authenticate");
  }

  // And the working case is untouched.
  const ok = await rpc(runtime.origin, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "ping",
  });
  assert.equal(ok.status, 200);
});

test("a GET is refused in a shape an MCP client can read", async (t) => {
  const { runtime, token } = await mcpRuntime(t);
  const probed = await bearer(runtime.origin, "/api/v1/mcp", token);
  assert.equal(probed.status, 405);
  // Not the gateway's own error envelope: a client probing for a stream has to
  // read "does not stream", not "transport failed".
  assert.equal(probed.data.jsonrpc, "2.0");
  assert.equal(probed.data.error.code, -32600);
});

test("list_repositories names the room's agents and whether they are live", async (t) => {
  const { runtime, token } = await mcpRuntime(t);
  const listed = await rpc(runtime.origin, token, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list_repositories", arguments: {} },
  });
  const text = listed.data.result.content[0].text as string;
  assert.match(text, /payments/u);
  // The roster travels with the repository because there is no `list_agents`,
  // and without it a model cannot answer the question submit_task asks it.
  assert.match(text, /@.+ — (online|offline)/u);
});

test("a token without the scope is told which scope, not that the server broke", async (t) => {
  const { runtime, token } = await mcpRuntime(t, ["view"]);
  const refused = await rpc(runtime.origin, token, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "submit_task",
      arguments: { repository: "payments", agent: "x", objective: "do it" },
    },
  });
  assert.equal(refused.status, 200);
  assert.equal(refused.data.error, undefined, "sent as a protocol error");
  assert.equal(refused.data.result.isError, true);
  assert.match(refused.data.result.content[0].text, /submit_task/u);
});

test("submit_task names the repositories it can reach when given a wrong one", async (t) => {
  const { runtime, token } = await mcpRuntime(t);
  const missed = await rpc(runtime.origin, token, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "submit_task",
      arguments: { repository: "nonesuch", agent: "x", objective: "do it" },
    },
  });
  assert.equal(missed.data.result.isError, true);
  assert.match(missed.data.result.content[0].text, /No repository called/u);
  assert.match(missed.data.result.content[0].text, /payments/u);
});

test("submit_task refuses a channel command and the everyone broadcast", async (t) => {
  const { runtime, token } = await mcpRuntime(t);
  // Both would post a message and start nothing, and the route would answer
  // 201 — success for work that will never run.
  const command = await rpc(runtime.origin, token, {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "submit_task",
      arguments: { repository: "payments", agent: "x", objective: "/push" },
    },
  });
  assert.equal(command.data.result.isError, true);
  assert.match(command.data.result.content[0].text, /channel command/u);

  const broadcast = await rpc(runtime.origin, token, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "submit_task",
      arguments: { repository: "payments", agent: "agents", objective: "do it" },
    },
  });
  assert.equal(broadcast.data.result.isError, true);
  assert.match(broadcast.data.result.content[0].text, /does not start work/u);
});

test("task_status says where a task got to", async (t) => {
  const { runtime, token, user, repositoryId } = await mcpRuntime(t);
  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "raise the retry ceiling",
    agentId: "anthropic",
    validationCommands: [],
    submittedBy: user.id,
  });

  const queued = await rpc(runtime.origin, token, {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "task_status", arguments: { task_id: task.id } },
  });
  assert.match(queued.data.result.content[0].text, /raise the retry ceiling/u);
  assert.match(queued.data.result.content[0].text, /queued/iu);

  await runtime.store.cancelSubmittedTask(task.id);
  const stopped = await rpc(runtime.origin, token, {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "task_status", arguments: { task_id: task.id } },
  });
  // It follows the row rather than snapshotting it.
  assert.doesNotMatch(
    stopped.data.result.content[0].text as string,
    /Status: queued/iu,
  );

  const missing = await rpc(runtime.origin, token, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "task_status", arguments: { task_id: "task_nope" } },
  });
  assert.equal(missing.data.result.isError, true);
});

test("submit_task posts into the channel and hands back a task id", async (t) => {
  const { runtime, token, repositoryId } = await mcpRuntime(t);
  const roster = await rpc(runtime.origin, token, {
    jsonrpc: "2.0",
    id: 20,
    method: "tools/call",
    params: { name: "list_repositories", arguments: {} },
  });
  // Address whoever the roster actually named, so the test does not encode a
  // display-name format that is allowed to change.
  const agent = /@(.+?) — /u.exec(
    roster.data.result.content[0].text as string,
  )?.[1];
  assert.ok(agent, "no agent in the roster to address");

  const sent = await rpc(runtime.origin, token, {
    jsonrpc: "2.0",
    id: 21,
    method: "tools/call",
    params: {
      name: "submit_task",
      arguments: {
        repository: "payments",
        agent,
        objective: "raise the retry ceiling",
      },
    },
  });
  assert.equal(sent.data.result.isError, undefined, sent.data.result.content[0].text);
  const said = sent.data.result.content[0].text as string;
  assert.match(said, /Task task_/u);

  // The message is really in the room — this is the half that makes a task
  // dispatched from an editor visible to everybody else.
  const messages = await runtime.store.listChannelMessages(repositoryId, "", {});
  assert.ok(
    messages.some((message) => message.content.includes("raise the retry ceiling")),
    "nothing was posted into the channel",
  );

  // And the id it quoted names a real task, which is what task_status needs.
  const quoted = /Task (task_[\w-]+)/u.exec(said)?.[1] ?? "";
  assert.ok(await runtime.store.getSubmittedTask(quoted), "quoted a task id that does not exist");
});

/**
 * The offline exchange, which is the popup translated for a tool.
 *
 * The room asks before it sends — queue, reroute, or cancel — because a task
 * filed against a machine that is not listening will sit there. An editor has
 * no room to ask in, so the tool refuses to write anything, states the three
 * choices, and waits to be called again. The rule it must never break is that
 * the first call leaves *nothing* behind: no message, no task.
 */
test("submit_task asks before filing work against a machine that is off", async (t) => {
  const previous = process.env["COORD_LOCAL_AGENTS_ONLY"];
  process.env["COORD_LOCAL_AGENTS_ONLY"] = "1";
  t.after(() => {
    if (previous === undefined) {
      delete process.env["COORD_LOCAL_AGENTS_ONLY"];
    } else {
      process.env["COORD_LOCAL_AGENTS_ONLY"] = previous;
    }
  });

  const { runtime, token, repositoryId } = await mcpRuntime(t);
  const roster = await rpc(runtime.origin, token, {
    jsonrpc: "2.0",
    id: 30,
    method: "tools/call",
    params: { name: "list_repositories", arguments: {} },
  });
  const agent = /@(.+?) — /u.exec(
    roster.data.result.content[0].text as string,
  )?.[1];
  assert.ok(agent);
  // Nobody has registered a worker, so no machine is listening for anyone.
  assert.match(roster.data.result.content[0].text as string, /— offline/u);

  const asked = await rpc(runtime.origin, token, {
    jsonrpc: "2.0",
    id: 31,
    method: "tools/call",
    params: {
      name: "submit_task",
      arguments: { repository: "payments", agent, objective: "raise the ceiling" },
    },
  });
  const question = asked.data.result.content[0].text as string;
  assert.match(question, /offline/u);
  assert.match(question, /queue/u);
  assert.match(question, /reroute/u);
  assert.match(question, /cancel/u);
  assert.match(question, /when_offline/u);

  // Nothing was written. This is the assertion the whole design turns on.
  assert.deepEqual(await runtime.store.listSubmittedTasks({ repositoryId }), []);
  assert.deepEqual(
    (await runtime.store.listChannelMessages(repositoryId, "", {})).filter(
      (message) => message.content.includes("raise the ceiling"),
    ),
    [],
  );

  // Cancelling is a call that writes nothing either.
  const dropped = await rpc(runtime.origin, token, {
    jsonrpc: "2.0",
    id: 32,
    method: "tools/call",
    params: {
      name: "submit_task",
      arguments: {
        repository: "payments",
        agent,
        objective: "raise the ceiling",
        when_offline: "cancel",
      },
    },
  });
  assert.match(dropped.data.result.content[0].text as string, /Nothing was submitted/u);
  assert.deepEqual(await runtime.store.listSubmittedTasks({ repositoryId }), []);

  // Answering "queue" files it, and says so rather than implying it started.
  const queued = await rpc(runtime.origin, token, {
    jsonrpc: "2.0",
    id: 33,
    method: "tools/call",
    params: {
      name: "submit_task",
      arguments: {
        repository: "payments",
        agent,
        objective: "raise the ceiling",
        when_offline: "queue",
      },
    },
  });
  const filed = queued.data.result.content[0].text as string;
  assert.equal(queued.data.result.isError, undefined, filed);
  assert.match(filed, /Queued/u);
  assert.match(filed, /machine comes back/u);
  assert.equal(
    (await runtime.store.listSubmittedTasks({ repositoryId })).length,
    1,
  );
});


/**
 * Turns the MCP switch on for one test and puts it back afterwards, so a
 * test that proves the switch holds and a test that needs it open cannot
 * leave the environment set for whichever runs next.
 */
test("approving a server for agents does not put it in an editor's hands", async (t) => {
  const { runtime, owner, token, serverId, dialled } = await proxyRuntime(t);

  // Approved to run beside agents on teammates' machines. That is one
  // decision; having the control plane dial it for whoever is typing in
  // Cursor is another, and this is the state between them.
  const approved = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${serverId}/approval`,
    { method: "POST", body: { enabled: true } },
  );
  assert.equal(approved.status, 200);
  assert.equal(approved.data.server.editorEnabled, false);
  assert.equal(
    (await listedTools(runtime.origin, token)).includes("linear__list_issues"),
    false,
    "an approval alone put the server in the tool list",
  );
  assert.deepEqual(dialled, [], "dialled a server nobody opted in");

  const opened = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${serverId}/editor-access`,
    { method: "POST", body: { enabled: true } },
  );
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  assert.equal(opened.data.server.editorEnabled, true);
  assert.ok(
    (await listedTools(runtime.origin, token, 91)).includes("linear__list_issues"),
  );
});

test("a proxied call carries the project's secret and the editor never sees it", async (t) => {
  const { runtime, owner, token, serverId, dialled } = await proxyRuntime(t);
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${serverId}/approval`,
    { method: "POST", body: { enabled: true } },
  );
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${serverId}/editor-access`,
    { method: "POST", body: { enabled: true } },
  );

  const called = await rpc(runtime.origin, token, {
    jsonrpc: "2.0",
    id: 92,
    method: "tools/call",
    params: {
      name: "linear__list_issues",
      arguments: { state: "open" },
    },
  });
  assert.equal(called.status, 200);
  assert.equal(called.data.result.isError, undefined, JSON.stringify(called.data));
  assert.equal(called.data.result.content[0].text, "two issues");

  const call = dialled.at(-1);
  // The public header and the opened secret both travel, and the far end is
  // asked for the name it knows rather than the namespaced one.
  assert.equal(call?.headers["X-Team"], "platform");
  assert.equal(call?.headers["Authorization"], MCP_TEST_SECRET);
  assert.deepEqual((call?.body as { params?: unknown }).params, {
    name: "list_issues",
    arguments: { state: "open" },
  });

  // And none of it came back down the wire. This is the whole point of
  // proxying rather than handing an editor the server's address and key.
  const answered = JSON.stringify(called.data);
  assert.equal(answered.includes(MCP_TEST_SECRET), false, "secret leaked");
  assert.equal(
    (await listedTools(runtime.origin, token, 93)).length > 0 &&
      JSON.stringify(await listedTools(runtime.origin, token, 94)).includes(
        MCP_TEST_SECRET,
      ),
    false,
  );

  // The call is on the record: "was Linear reachable during that afternoon"
  // has to be answerable afterwards.
  const audited = await runtime.store.listAuditEvents({
    types: ["project_changed"],
  });
  assert.ok(
    audited.some((entry) => entry.event.data["action"] === "mcp_tool_called"),
    "a proxied call left no trace",
  );
});

test("withdrawing the approval takes the tools away at once", async (t) => {
  const { runtime, owner, token, serverId } = await proxyRuntime(t);
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${serverId}/approval`,
    { method: "POST", body: { enabled: true } },
  );
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${serverId}/editor-access`,
    { method: "POST", body: { enabled: true } },
  );
  assert.ok(
    (await listedTools(runtime.origin, token, 95)).includes("linear__list_issues"),
  );

  const withdrawn = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${serverId}/approval`,
    { method: "POST", body: { enabled: false } },
  );
  assert.equal(withdrawn.data.server.editorEnabled, false);
  // On the next request, not in five minutes when a cache lapses. Somebody
  // switching a server off expects it to be off.
  assert.equal(
    (await listedTools(runtime.origin, token, 96)).includes("linear__list_issues"),
    false,
  );
  // And it cannot be handed back to editors while the approval is off.
  const reopened = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${serverId}/editor-access`,
    { method: "POST", body: { enabled: true } },
  );
  assert.equal(reopened.status, 409);
});

test("a command cannot be offered to an editor, and says why", async (t) => {
  withMcpServersEnabled(t);
  const runtime = await startRuntime(t, {
    secretSealer: createSecretSealer(randomBytes(32)),
  });
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const created = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
    {
      method: "POST",
      body: {
        name: "files",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem@1.0.0"],
      },
    },
  );
  assert.equal(created.status, 201, JSON.stringify(created.data));
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${created.data.server.id}/approval`,
    { method: "POST", body: { enabled: true } },
  );
  const refused = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${created.data.server.id}/editor-access`,
    { method: "POST", body: { enabled: true } },
  );
  // Refused up front rather than stored and quietly ignored. A stdio server
  // is a process, and the control plane starting one chosen by a project
  // admin is what this architecture keeps out.
  assert.equal(refused.status, 400);
  assert.match(String(refused.data.error.message), /over a URL/u);
});

test("with the switch off no server reaches an editor, whatever is stored", async (t) => {
  const { runtime, owner, token, serverId, dialled } = await proxyRuntime(t);
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${serverId}/approval`,
    { method: "POST", body: { enabled: true } },
  );
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${serverId}/editor-access`,
    { method: "POST", body: { enabled: true } },
  );
  assert.ok(
    (await listedTools(runtime.origin, token, 97)).includes("linear__list_issues"),
  );

  // The switch is a fence rather than a suggestion: turning it off has to
  // stop the control plane dialling anything, not merely stop new rows.
  withMcpServersEnabled(t, false);
  const before = dialled.length;
  assert.equal(
    (await listedTools(runtime.origin, token, 98)).includes("linear__list_issues"),
    false,
  );
  assert.equal(dialled.length, before);
});

test("an MCP server is stored sealed, listed by secret name only, and scoped to its project", async (t) => {
  withMcpServersEnabled(t);
  const sealer = createSecretSealer(randomBytes(32));
  const runtime = await startRuntime(t, { secretSealer: sealer });
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const created = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
    { method: "POST", body: mcpHttpServerBody() },
  );
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const server = created.data.server;
  assert.equal(server.name, "linear");
  assert.equal(server.enabled, false);
  assert.deepEqual(server.secretNames, ["Authorization"]);
  assert.equal(server.values["X-Team"], "platform");
  assert.equal("secrets" in server, false);

  // The ciphertext is in the store and only there. Every JSON the routes
  // answer with is searched for it — and for the plaintext — because the
  // record type keeping secrets out is the design, and this is the proof.
  const sealed = await runtime.store.getMcpServerSecrets(server.id);
  const ciphertext = sealed?.["Authorization"]?.ciphertext ?? "";
  assert.ok(ciphertext.length > 0);
  assert.equal(sealer.open(sealed!["Authorization"]!), MCP_TEST_SECRET);
  const listed = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.data.enabled, true);
  assert.deepEqual(listed.data.servers.map((entry: any) => entry.name), ["linear"]);
  assert.deepEqual(listed.data.servers[0].secretNames, ["Authorization"]);
  const fetched = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${server.id}`,
  );
  assert.equal(fetched.status, 200);
  for (const body of [created.data, listed.data, fetched.data]) {
    const raw = JSON.stringify(body);
    assert.equal(raw.includes(ciphertext), false, "ciphertext leaked");
    assert.equal(raw.includes(MCP_TEST_SECRET), false, "plaintext leaked");
  }

  // The same name again is a collision, not a second row.
  const again = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
    { method: "POST", body: mcpHttpServerBody() },
  );
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, "name_taken");

  // A server id is only addressable under the project it belongs to.
  const other = await client.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/projects`,
    { method: "POST", body: { slug: "other", name: "Other" } },
  );
  assert.equal(other.status, 201, JSON.stringify(other.data));
  const otherId = other.data.project.id as string;
  const crossed = await client.request(
    `/api/v1/projects/${otherId}/mcp-servers/${server.id}`,
  );
  assert.equal(crossed.status, 404);
  const crossedApproval = await client.request(
    `/api/v1/projects/${otherId}/mcp-servers/${server.id}/approval`,
    { method: "POST", body: { enabled: true } },
  );
  assert.equal(crossedApproval.status, 404);
  const otherList = await client.request(`/api/v1/projects/${otherId}/mcp-servers`);
  assert.deepEqual(otherList.data.servers, []);

  // A repository-scoped server has to name repositories of this project.
  const foreign = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
    {
      method: "POST",
      body: mcpHttpServerBody("scoped", {
        scope: "repository",
        repositoryIds: ["not-a-repo"],
      }),
    },
  );
  assert.equal(foreign.status, 400);
  assert.equal(foreign.data.error.code, "unknown_repository");

  // A stdio command is an executable name or an absolute path, never a shell.
  const shell = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
    {
      method: "POST",
      body: { name: "shelly", transport: "stdio", command: "npx foo; rm -rf /" },
    },
  );
  assert.equal(shell.status, 400);
  assert.equal(shell.data.error.code, "invalid_command");

  const removed = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${server.id}`,
    { method: "DELETE" },
  );
  assert.equal(removed.status, 204);
  assert.equal(await runtime.store.getMcpServer(server.id), undefined);
});

test("an MCP server pointing at Kumi's own MCP endpoint is refused as a loop", async (t) => {
  withMcpServersEnabled(t);
  const runtime = await startRuntime(t, {
    secretSealer: createSecretSealer(randomBytes(32)),
  });
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  for (const url of [
    "https://kumi.example.com/api/v1/mcp",
    "https://kumi.example.com/api/v1/mcp/",
    "http://localhost:3000/api/v1/mcp",
  ]) {
    const refused = await client.request(
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
      { method: "POST", body: mcpHttpServerBody("self", { url }) },
    );
    assert.equal(refused.status, 400, url);
    assert.equal(refused.data.error.code, "mcp_loop", url);
  }
  // Plain http anywhere but loopback would put the secret header on the wire.
  const plain = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
    { method: "POST", body: mcpHttpServerBody("plain", { url: "http://mcp.example.com/" }) },
  );
  assert.equal(plain.status, 400);
  assert.equal(plain.data.error.code, "invalid_url");
  // Somebody else's server, over https, is exactly what this is for.
  const fine = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
    { method: "POST", body: mcpHttpServerBody("fine") },
  );
  assert.equal(fine.status, 201);
});

test("with the MCP switch off nothing can be stored or armed, and the listing says so", async (t) => {
  withMcpServersEnabled(t, false);
  const runtime = await startRuntime(t, {
    secretSealer: createSecretSealer(randomBytes(32)),
  });
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const created = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
    { method: "POST", body: mcpHttpServerBody() },
  );
  assert.equal(created.status, 501);
  assert.equal(created.data.error.code, "mcp_disabled");
  assert.match(created.data.error.message, /COORD_MCP_ENABLED/u);

  // A row that got in while the switch was on cannot be approved once it is
  // off, and the listing still reads.
  const seeded = await runtime.store.createMcpServer({
    id: "mcp_seeded",
    projectId: DEFAULT_PROJECT_ID,
    scope: "project",
    name: "seeded",
    transport: "http",
    url: "https://mcp.example.com/",
    createdBy: "owner",
    createdAt: new Date().toISOString(),
  });
  const approval = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${seeded.id}/approval`,
    { method: "POST", body: { enabled: true } },
  );
  assert.equal(approval.status, 501);
  assert.equal(approval.data.error.code, "mcp_disabled");
  const listed = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.data.enabled, false);
  assert.equal(listed.data.servers.length, 1);
  assert.equal(listed.data.servers[0].enabled, false);
});

test("with the switch on but no credential store the MCP routes name what is missing", async (t) => {
  withMcpServersEnabled(t);
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);
  const created = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
    { method: "POST", body: mcpHttpServerBody() },
  );
  assert.equal(created.status, 501);
  assert.equal(created.data.error.code, "mcp_disabled");
  assert.match(created.data.error.message, /COORD_CREDENTIAL_KEY/u);
  const listed = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
  );
  assert.equal(listed.data.enabled, false);
});

test("approving an MCP server records who, is audited, and an edit takes it back", async (t) => {
  withMcpServersEnabled(t);
  const runtime = await startRuntime(t, {
    secretSealer: createSecretSealer(randomBytes(32)),
  });
  const client = new TestClient(runtime.origin);
  const setup = await bootstrap(client);
  const ownerId = setup.user.id as string;

  const created = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
    { method: "POST", body: mcpHttpServerBody() },
  );
  assert.equal(created.status, 201);
  const serverId = created.data.server.id as string;

  const approved = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${serverId}/approval`,
    { method: "POST", body: { enabled: true } },
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.server.enabled, true);
  assert.equal(approved.data.server.approvedBy, ownerId);
  assert.ok(approved.data.server.approvedAt);
  const enabledEvents = (
    await runtime.store.listAuditEvents({ types: ["project_changed"] })
  ).filter((entry) => entry.event.data["action"] === "mcp_server_enabled");
  assert.equal(enabledEvents.length, 1);
  assert.equal(enabledEvents[0]?.event.data["serverId"], serverId);
  assert.equal(enabledEvents[0]?.event.data["actorId"], ownerId);
  assert.equal(enabledEvents[0]?.event.data["name"], "linear");

  // What was approved is a specific URL with specific secrets. Changing
  // either is a new thing that nobody has approved yet.
  const edited = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${serverId}`,
    { method: "PATCH", body: { values: { "X-Team": "infra" } } },
  );
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.reapprovalRequired, true);
  assert.equal(edited.data.server.enabled, false);
  assert.equal(edited.data.server.approvedBy, undefined);
  assert.equal(edited.data.server.values["X-Team"], "infra");
  // The secret survived an edit that did not mention it.
  assert.deepEqual(edited.data.server.secretNames, ["Authorization"]);

  // An edit to a disabled server is just an edit; null removes a secret.
  const trimmed = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${serverId}`,
    { method: "PATCH", body: { secrets: { Authorization: null, "X-Other": "s3cret" } } },
  );
  assert.equal(trimmed.status, 200);
  assert.equal(trimmed.data.reapprovalRequired, false);
  assert.deepEqual(trimmed.data.server.secretNames, ["X-Other"]);

  // The transport is fixed at creation: the stores never change it, and a
  // 200 that left the row as it was would be a lie — worse, the secrets
  // sealed for a header would start travelling as a child's environment.
  // Saying the same transport back is not a change.
  const switched = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${serverId}`,
    { method: "PATCH", body: { transport: "stdio", command: "npx" } },
  );
  assert.equal(switched.status, 400, JSON.stringify(switched.data));
  assert.equal(switched.data.error.code, "transport_fixed");
  const same = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${serverId}`,
    { method: "PATCH", body: { transport: "http" } },
  );
  assert.equal(same.status, 200, JSON.stringify(same.data));
  assert.equal(same.data.server.transport, "http");

  const disabled = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${serverId}/approval`,
    { method: "POST", body: { enabled: false } },
  );
  assert.equal(disabled.status, 200);
  assert.equal(disabled.data.server.enabled, false);
});

test("a view-only token can list MCP servers but neither create nor approve one", async (t) => {
  withMcpServersEnabled(t);
  const runtime = await startRuntime(t, {
    secretSealer: createSecretSealer(randomBytes(32)),
  });
  const client = new TestClient(runtime.origin);
  await bootstrap(client);
  const created = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
    { method: "POST", body: mcpHttpServerBody() },
  );
  assert.equal(created.status, 201);
  const serverId = created.data.server.id as string;

  const readOnly = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "read-only", scopes: ["view"] },
  });
  const token = readOnly.data.token as string;
  const listed = await bearer(
    runtime.origin,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
    token,
  );
  assert.equal(listed.status, 200);
  const denied = await bearer(
    runtime.origin,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
    token,
    { method: "POST", body: mcpHttpServerBody("second") },
  );
  assert.equal(denied.status, 403);
  const deniedApproval = await bearer(
    runtime.origin,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${serverId}/approval`,
    token,
    { method: "POST", body: { enabled: true } },
  );
  assert.equal(deniedApproval.status, 403);
  assert.equal(
    (await runtime.store.getMcpServer(serverId))?.enabled,
    false,
  );
});

test("a lease carries approved MCP servers opened, only to a current worker owned by the task's submitter", async (t) => {
  withMcpServersEnabled(t);
  const sealer = createSecretSealer(randomBytes(32));
  const runtime = await startRuntime(t, { secretSealer: sealer });
  const client = new TestClient(runtime.origin);
  const setup = await bootstrap(client);
  const ownerId = setup.user.id as string;
  const created = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "fleet", scopes: ["view", "run_task"] },
  });
  const token = created.data.token as string;
  const registered = await bearer(runtime.origin, "/api/v1/workers/register", token, {
    method: "POST",
    body: {
      organizationId: DEFAULT_ORGANIZATION_ID,
      name: "worker-a",
      adapters: ["codex"],
      version: "1.0.0",
    },
  });
  assert.equal(registered.status, 201);
  const workerId = registered.data.id as string;
  await runtime.store.saveRepository({
    id: "repo_tools",
    path: "/canonical/tools.git",
    branch: "main",
  });

  const server = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers`,
    { method: "POST", body: mcpHttpServerBody() },
  );
  assert.equal(server.status, 201);
  const approved = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/mcp-servers/${server.data.server.id}/approval`,
    { method: "POST", body: { enabled: true } },
  );
  assert.equal(approved.status, 200);

  const submit = async (submittedBy: string) =>
    await runtime.store.submitTask({
      repositoryId: "repo_tools",
      projectId: DEFAULT_PROJECT_ID,
      objective: "file the ticket",
      agentId: "codex",
      validationCommands: [],
      submittedBy,
    });
  // Each lease is completed before the next is asked for: a repository
  // admits one active lease at a time, and every case below is a fresh
  // lease on a fresh task. Completed rather than released, because a
  // released task goes back to the front of the queue.
  const lease = async (body: Record<string, unknown>) => {
    const answer = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
      method: "POST",
      body: { workerId, projectId: DEFAULT_PROJECT_ID, ...body },
    });
    if (answer.status === 200) {
      await runtime.store.finishWorkLease(
        answer.data.lease.id,
        "completed",
        new Date().toISOString(),
      );
    }
    return answer;
  };

  // A current worker, the owner's own task: the secret arrives in the open.
  const own = await submit(ownerId);
  const current = await lease({ protocolVersion: 4 });
  assert.equal(current.status, 200, JSON.stringify(current.data));
  assert.equal(current.data.task.id, own.id);
  assert.equal(current.data.mcpServers.length, 1);
  assert.equal(current.data.mcpServers[0].name, "linear");
  assert.equal(current.data.mcpServers[0].transport, "http");
  assert.equal(current.data.mcpServers[0].url, "https://mcp.linear.app/mcp");
  assert.equal(current.data.mcpServers[0].headers.Authorization, MCP_TEST_SECRET);
  assert.equal(current.data.mcpServers[0].headers["X-Team"], "platform");

  // A version-3 worker never sees the field, and the thread is told why.
  const stale = await submit(ownerId);
  const old = await lease({ protocolVersion: 3 });
  assert.equal(old.status, 200);
  assert.equal(old.data.task.id, stale.id);
  assert.equal("mcpServers" in old.data, false);
  const withheld = await runtime.store.listAuditEvents({
    taskId: stale.id,
    types: ["mcp_servers_withheld"],
  });
  assert.equal(withheld.length, 1);
  assert.equal(withheld[0]?.event.data["reason"], "stale_worker");
  const told = await runtime.store.listAuditEvents({
    taskId: stale.id,
    types: ["agent_progress"],
  });
  assert.equal(told.length, 1);
  assert.match(String(told[0]?.event.data["message"]), /linear/u);
  assert.match(String(told[0]?.event.data["message"]), /version 3/u);
  // Absent is the oldest version, not the newest.
  const unversioned = await submit(ownerId);
  const silent = await lease({});
  assert.equal(silent.data.task.id, unversioned.id);
  assert.equal("mcpServers" in silent.data, false);

  // Somebody else's task on this machine gets nothing, whatever the version.
  // The claim pins ownership so this cannot happen through the real lease;
  // the fake here does not, which is what lets the gate be seen holding.
  const somebodyElse = await runtime.store.createUser({
    email: "else@example.com",
    displayName: "Somebody Else",
    passwordDigest: "digest",
  });
  const foreign = await submit(somebodyElse.id);
  const notOwner = await lease({ protocolVersion: 4 });
  assert.equal(notOwner.status, 200);
  assert.equal(notOwner.data.task.id, foreign.id);
  assert.equal("mcpServers" in notOwner.data, false);
  const refused = await runtime.store.listAuditEvents({
    taskId: foreign.id,
    types: ["mcp_servers_withheld"],
  });
  assert.equal(refused[0]?.event.data["reason"], "not_owner");

  // The switch, off, attaches nothing regardless of what is approved.
  delete process.env["COORD_MCP_ENABLED"];
  const later = await submit(ownerId);
  const off = await lease({ protocolVersion: 4 });
  assert.equal(off.data.task.id, later.id);
  assert.equal("mcpServers" in off.data, false);
  process.env["COORD_MCP_ENABLED"] = "1";

  // A secret sealed under some other key leaves its server out, and says so,
  // without costing the lease.
  const otherKey = createSecretSealer(randomBytes(32));
  await runtime.store.createMcpServer({
    id: "mcp_rekeyed",
    projectId: DEFAULT_PROJECT_ID,
    scope: "project",
    name: "rekeyed",
    transport: "stdio",
    command: "npx",
    args: ["-y", "some-mcp"],
    secrets: { TOKEN: otherKey.seal("unreadable") },
    createdBy: ownerId,
    createdAt: new Date().toISOString(),
  });
  await runtime.store.setMcpServerApproval("mcp_rekeyed", {
    enabled: true,
    approvedBy: ownerId,
    approvedAt: new Date().toISOString(),
  });
  const last = await submit(ownerId);
  const partial = await lease({ protocolVersion: 4 });
  assert.equal(partial.data.task.id, last.id);
  assert.deepEqual(
    partial.data.mcpServers.map((entry: { name: string }) => entry.name),
    ["linear"],
  );
  const unopenable = await runtime.store.listAuditEvents({
    taskId: last.id,
    types: ["mcp_server_unopenable"],
  });
  assert.equal(unopenable[0]?.event.data["name"], "rekeyed");
  assert.equal(unopenable[0]?.event.data["secretName"], "TOKEN");
});
