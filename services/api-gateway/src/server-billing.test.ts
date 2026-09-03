/** The gateway over HTTP: static assets, sign-up, Stripe and health. */

import assert from "node:assert/strict";
import {
  createHmac,
} from "node:crypto";
import test from "node:test";
import {
  hashSecret,
} from "./auth.js";
import {
  effectiveRole,
  subscriptionAllowsWork,
} from "./billing.js";
import {
  ApiGateway,
  type ApiOperations,
  type StaticAsset,
  previewBaseHref,
  previewProxyHeaders,
  rewritePreviewHtml,
} from "./server.js";
import {
  type StripeClient,
} from "./stripe.js";
import {
  BOOTSTRAP_TOKEN,
  PASSWORD,
  TestClient,
  bootstrap,
  fakePreview,
  startBareGateway,
  startRuntime,
  waitFor,
  work,
} from "./test-harness.js";
import {
  DEFAULT_PROJECT_ID,
  InMemoryCoordinationStore,
} from "@coord/persistence";

test("the marketing front page owns \"/\" exactly, and its absence falls back to the dashboard", async (t) => {
  // One lookup change carries the whole marketing site: `serveStatic` reads
  // `url.pathname` as it arrived instead of rewriting "/" to "/index.html".
  // Both sides of that change matter. A deployment carrying the site holds a
  // literal "/" key and must serve the marketing page there while /app and
  // every other dotless path still falls back to the dashboard document — a
  // mailed /app#welcome link routes on the fragment, so the document is all
  // /app needs. And a deployment without the site (every one that predates
  // it, and every other fixture in this file) has no "/" key, so "/" must
  // ride the same fallback it always has instead of turning into a 404.
  const serve = async (
    staticAssets: ReadonlyMap<string, StaticAsset>,
  ): Promise<TestClient> => {
    const store = new InMemoryCoordinationStore();
    const gateway = new ApiGateway({
      store,
      operations: {} as unknown as ApiOperations,
      staticAssets,
    });
    t.after(async () => {
      await gateway.close();
      await store.close();
    });
    await new Promise<void>((resolve, reject) => {
      gateway.server.once("error", reject);
      gateway.server.listen(0, "127.0.0.1", resolve);
    });
    const address = gateway.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test gateway did not bind a TCP port");
    }
    return new TestClient(`http://127.0.0.1:${address.port}`);
  };

  const dashboard = {
    body: "<!doctype html><title>App</title>",
    contentType: "text/html",
  };
  const withSite = await serve(
    new Map([
      ["/", { body: "<!doctype html><title>Site</title>", contentType: "text/html" }],
      ["/pricing", { body: "<!doctype html><title>Pricing</title>", contentType: "text/html" }],
      ["/index.html", dashboard],
    ]),
  );

  const front = await withSite.request("/");
  assert.equal(front.status, 200);
  assert.equal(front.data, "<!doctype html><title>Site</title>");
  // Editable pages revalidate; only digested names may promise immutability.
  assert.equal(front.headers.get("cache-control"), "no-cache");

  const pricing = await withSite.request("/pricing");
  assert.equal(pricing.status, 200);
  assert.equal(pricing.data, "<!doctype html><title>Pricing</title>");

  // The dashboard moved to /app without gaining a key: it is the fallback,
  // and the fallback is what every dotless client route resolves to.
  for (const path of ["/app", "/some/client/route", "/index.html"]) {
    const page = await withSite.request(path);
    assert.equal(page.status, 200, path);
    assert.equal(page.data, dashboard.body, path);
  }
  // A dotted path that names nothing stays an honest 404 — the fallback is
  // for client routes, not for typoed asset names.
  assert.equal((await withSite.request("/app.jss")).status, 404);

  const withoutSite = await serve(new Map([["/index.html", dashboard]]));
  const legacyFront = await withoutSite.request("/");
  assert.equal(legacyFront.status, 200);
  assert.equal(legacyFront.data, dashboard.body);
});

/** A gateway with whatever bootstrap configuration a test wants. */
test("a proxied preview is served as its own app, not under this one's policy", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);
  await client.request(`/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`, {
    method: "POST",
    body: { id: "greenfield", branch: "main" },
  });

  runtime.preview.url = await fakePreview(t, (request, response) => {
    if (request.url === "/assets/main.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end("export const ok = 1;\n");
      return;
    }
    if (request.url === "/login") {
      response.writeHead(302, { Location: "/signed-in" });
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css">' +
        '</head><body><div id="root"></div>' +
        '<script type="module" src="/assets/main.js"></script>' +
        "</body></html>",
    );
  });

  const base = previewBaseHref(DEFAULT_PROJECT_ID, "greenfield");
  const page = await client.request(base);
  assert.equal(page.status, 200);

  // The document's own addresses now point at the app rather than at the
  // dashboard. This is the whole of the white page: `/assets/main.js` asked
  // this deployment for the app's bundle and got a 404 with a content type a
  // browser will not execute.
  assert.match(page.data, new RegExp(`src="${base}assets/main\\.js"`, "u"));
  assert.match(page.data, new RegExp(`href="${base}assets/app\\.css"`, "u"));
  // And a `<base>`, ahead of anything that could already have been fetched,
  // so relative URLs and client-side routes resolve under the app too.
  assert.match(page.data, new RegExp(`<head><base href="${base}">`, "u"));

  // The dashboard's policy is about the dashboard. Applied here it blocks the
  // inline bootstrap every bundler emits and the `<base>` above — `base-uri
  // 'none'` — and the page renders empty with the reason in a console nobody
  // in this product ever opens.
  const policy = page.headers.get("content-security-policy") ?? "";
  assert.doesNotMatch(policy, /base-uri 'none'/u);
  assert.doesNotMatch(policy, /frame-ancestors 'none'/u);
  assert.match(policy, /'unsafe-inline'/u);
  // Framed by this deployment and by nobody else — `DENY` would refuse the
  // dashboard's own preview pane as readily as a stranger's.
  assert.equal(page.headers.get("x-frame-options"), "SAMEORIGIN");

  // The bundle itself reaches the app and comes back executable.
  const bundle = await client.request(`${base}assets/main.js`);
  assert.equal(bundle.status, 200);
  assert.equal(bundle.data, "export const ok = 1;\n");
  assert.match(bundle.headers.get("content-type") ?? "", /javascript/u);

  // A redirect the app issues stays inside the app. `/signed-in` on this
  // origin is the dashboard, which is a different application entirely.
  const redirected = await fetch(`${runtime.origin}${base}login`, {
    headers: { Cookie: client.cookieHeader },
    redirect: "manual",
  });
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.get("location"), `${base}signed-in`);

  // Everything this deployment answers for itself is unchanged: the strict
  // policy is lifted for the previewed app and for nothing else.
  const dashboard = await client.request("/some/client/route");
  assert.match(
    dashboard.headers.get("content-security-policy") ?? "",
    /base-uri 'none'/u,
  );
  assert.equal(dashboard.headers.get("x-frame-options"), "DENY");
});

test("the preview proxy moves a page's addresses without touching anything else", () => {
  const base = previewBaseHref("proj_1", "greenfield");
  assert.equal(base, "/api/v1/projects/proj_1/repositories/greenfield/preview/app/");

  const rewritten = rewritePreviewHtml(
    '<!doctype html><html><head><meta charset="utf-8">' +
      '<script src="/main.js"></script>' +
      '<script src="https://cdn.example.com/x.js"></script>' +
      '<script src="//cdn.example.com/y.js"></script>' +
      '<img src="./logo.png"><a href="/about">About</a>' +
      "</head></html>",
    base,
  );
  assert.match(rewritten, new RegExp(`<head><base href="${base}">`, "u"));
  assert.ok(rewritten.includes(`src="${base}main.js"`));
  assert.ok(rewritten.includes(`href="${base}about"`));
  // Another origin is another origin. Moving these under this path would
  // break a page that is correctly asking somewhere else.
  assert.ok(rewritten.includes('src="https://cdn.example.com/x.js"'));
  assert.ok(rewritten.includes('src="//cdn.example.com/y.js"'));
  // Relative URLs are already handled by the <base>, so they are left alone.
  assert.ok(rewritten.includes('src="./logo.png"'));

  // A document with no head still gets one address it can resolve against.
  assert.match(rewritePreviewHtml("<p>hi</p>", base), /^<base href="/u);
});

test("preview headers keep the app's own claims and drop this deployment's", () => {
  const base = previewBaseHref("proj_1", "greenfield");
  const origin = "http://127.0.0.1:4310";

  const stated = previewProxyHeaders(
    {
      "content-type": "text/html",
      "content-security-policy": "default-src 'self'",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
    },
    base,
    origin,
  );
  // The app said something about itself, so that is what is sent.
  assert.equal(stated["content-security-policy"], "default-src 'self'");
  // Hop-by-hop headers describe this connection and not the next one.
  assert.equal(stated["connection"], undefined);
  assert.equal(stated["transfer-encoding"], undefined);

  const silent = previewProxyHeaders({ "content-type": "text/html" }, base, origin);
  // It said nothing, so a policy loose enough to run a dev server is written
  // — inline scripts, eval, blob workers, a socket back to itself.
  assert.match(String(silent["content-security-policy"]), /'unsafe-inline'/u);
  assert.match(String(silent["content-security-policy"]), /'unsafe-eval'/u);

  // A redirect stated either way lands inside the app.
  assert.equal(
    previewProxyHeaders({ location: "/next" }, base, origin)["location"],
    `${base}next`,
  );
  assert.equal(
    previewProxyHeaders({ location: `${origin}/next` }, base, origin)["location"],
    `${base}next`,
  );
  // Somewhere else is left where it was pointed.
  assert.equal(
    previewProxyHeaders({ location: "https://example.com/x" }, base, origin)[
      "location"
    ],
    "https://example.com/x",
  );

  // A previewed app cannot sign the reader out of the deployment they are
  // watching it from: its cookies stay in its own path.
  assert.deepEqual(
    previewProxyHeaders(
      { "set-cookie": ["coord_session=theirs; Path=/; HttpOnly", "a=b"] },
      base,
      origin,
    )["set-cookie"],
    [`coord_session=theirs; Path=${base}; HttpOnly`, `a=b; Path=${base}`],
  );
});

test("with no token configured, first-run setup is open", async (t) => {
  const { client } = await startBareGateway(t, {});

  // The form is told not to ask for one, rather than asking for a value that
  // cannot be supplied.
  const health = await client.request("/api/v1/health");
  assert.equal(health.data.setupRequired, true);
  assert.equal(health.data.bootstrapTokenRequired, false);

  const created = await client.request("/api/v1/auth/bootstrap", {
    method: "POST",
    body: {
      email: "owner@example.com",
      displayName: "Owner",
      password: PASSWORD,
      organizationName: "Relay Test",
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  // And the door locks behind the first person through it: open setup is a
  // window that closes, not a permanently unauthenticated route.
  const second = await new TestClient(client.origin).request(
    "/api/v1/auth/bootstrap",
    {
      method: "POST",
      body: {
        email: "intruder@example.com",
        displayName: "Intruder",
        password: PASSWORD,
        organizationName: "Theirs",
      },
    },
  );
  assert.equal(second.status === 201, false, "setup must not run twice");
  const afterwards = await client.request("/api/v1/health");
  assert.equal(afterwards.data.setupRequired, false);
});

test("an empty token is the same as none, not a token nobody can send", async (t) => {
  // `COORD_BOOTSTRAP_TOKEN=` in a hosting provider's variable editor is the
  // ordinary way to clear one, and it arrives as an empty string.
  const { client } = await startBareGateway(t, { bootstrapToken: "   " });
  const health = await client.request("/api/v1/health");
  assert.equal(health.data.bootstrapTokenRequired, false);
  const created = await client.request("/api/v1/auth/bootstrap", {
    method: "POST",
    body: {
      email: "owner@example.com",
      displayName: "Owner",
      password: PASSWORD,
      organizationName: "Relay Test",
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
});

test("a paid sign-up takes the card first and builds the account last", async (t) => {
  // The whole flow, in the order a person meets it: an address, a card, then
  // a name and a password. Nothing anybody can sign in to exists until the
  // money has cleared, which is what makes the public route safe to expose
  // and what stops a failed payment leaving an account behind.
  const secret = "whsec_example";
  let checkout: Record<string, unknown> | undefined;
  const stripe = {
    createCheckoutSession: async (input: Record<string, unknown>) => {
      checkout = input;
      return { id: "cs_paid", url: "https://checkout.example/cs_paid" };
    },
  } as unknown as StripeClient;
  const { client, store, sent } = await startBareGateway(t, {
    stripe,
    stripeWebhookSecret: secret,
    stripePriceId: "price_example",
  });

  // 1. An address. No account, no organization — only an intent naming an id
  //    that does not exist yet.
  const started = await client.request("/api/v1/auth/signup", {
    method: "POST",
    body: { email: "Buyer@Example.com", organizationName: "Buyer's team" },
  });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.equal(started.data.url, "https://checkout.example/cs_paid");
  assert.equal(await store.countUsers(), 0, "paying comes before the account");
  // The card is taken today and the trial is Stripe's to run.
  assert.equal(checkout?.["trialPeriodDays"], 14);
  assert.equal(checkout?.["customerEmail"], "buyer@example.com");
  const organizationId = String(checkout?.["organizationId"] ?? "");
  assert.match(organizationId, /^org_/u);
  assert.equal(await store.getOrganization(organizationId), undefined);

  // The claim link is the checkout's return address — and it is also mailed,
  // so the browser tab is not the only copy. Somebody who pays and closes the
  // tab has otherwise bought an organization they can never reach.
  const token = String(checkout?.["successUrl"] ?? "").split("/app#welcome/")[1] ?? "";
  assert.notEqual(token, "");
  assert.equal(sent.length, 1, "the link is mailed as well as redirected to");
  assert.equal(sent[0]?.to, "buyer@example.com");
  assert.match(sent[0]?.text ?? "", /\/app#welcome\//u);
  assert.match(
    sent[0]?.text ?? "",
    new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    "the mailed link is the same claim link",
  );

  // 2. Stripe confirms. The organization it paid for is built now — and
  //    still no account, because they have not chosen a password yet.
  const body = JSON.stringify({
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_paid",
        status: "trialing",
        customer: "cus_paid",
        trial_end: 1_800_000_000,
        metadata: { organizationId },
      },
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const delivered = await client.request("/api/v1/stripe/webhook", {
    method: "POST",
    raw: Buffer.from(body, "utf8"),
    rawType: "application/json",
    headers: {
      "Stripe-Signature": `t=${String(timestamp)},v1=${createHmac("sha256", secret)
        .update(`${String(timestamp)}.${body}`, "utf8")
        .digest("hex")}`,
    },
  });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.data));
  assert.notEqual(await store.getOrganization(organizationId), undefined);
  assert.equal(await store.countUsers(), 0, "still nobody to sign in as");
  const subscription = await store.getSubscription(organizationId);
  assert.equal(subscription?.status, "trialing");
  assert.notEqual(subscription?.trialEndsAt, undefined, "the trial date is kept");

  // Stripe redelivers. Provisioning is one transaction that re-reads the
  // intent inside it and sets the latch last, so a second delivery of the
  // same payment finds the work done and builds nothing on top of it.
  const redelivered = await client.request("/api/v1/stripe/webhook", {
    method: "POST",
    raw: Buffer.from(body, "utf8"),
    rawType: "application/json",
    headers: {
      "Stripe-Signature": `t=${String(timestamp)},v1=${createHmac("sha256", secret)
        .update(`${String(timestamp)}.${body}`, "utf8")
        .digest("hex")}`,
    },
  });
  assert.equal(redelivered.status, 200, JSON.stringify(redelivered.data));
  assert.deepEqual(
    (await store.listProjects(organizationId)).map((project) => project.slug),
    ["default"],
    "a redelivered payment must not build a second project",
  );

  // The welcome screen can tell them the payment landed.
  const waiting = await client.request(
    `/api/v1/auth/signup/${encodeURIComponent(token)}`,
  );
  assert.equal(waiting.data.paid, true);
  assert.equal(waiting.data.claimed, false);

  // 3. Name and password. Only now does an account exist, and they are signed
  //    straight in to the organization their card already paid for.
  const finished = await client.request(
    `/api/v1/auth/signup/${encodeURIComponent(token)}/complete`,
    {
      method: "POST",
      body: { displayName: "Buyer", password: "PaidSignupPassword123!" },
    },
  );
  assert.equal(finished.status, 201, JSON.stringify(finished.data));
  assert.equal(finished.data.user.email, "buyer@example.com");
  assert.equal(finished.data.memberships.length, 1);
  assert.equal(finished.data.memberships[0]?.organizationId, organizationId);
  assert.equal(finished.data.memberships[0]?.role, "owner");
  assert.deepEqual(
    (await store.listProjects(organizationId)).map((project) => project.slug),
    ["default"],
  );

  // Pressing the link twice is one account, not two.
  const again = await client.request(
    `/api/v1/auth/signup/${encodeURIComponent(token)}/complete`,
    {
      method: "POST",
      body: { displayName: "Buyer", password: "PaidSignupPassword123!" },
    },
  );
  assert.equal(again.status, 201);
  assert.equal(again.data.user.id, finished.data.user.id);
  assert.equal(await store.countUsers(), 1);
});

test("a sign-up latched before its organization existed repairs itself", async (t) => {
  // The state the old latch-first provisioning could leave behind, and which
  // nothing in the product could undo: `completed_at` set, no organization,
  // a payment that had bought nothing and a claim link that could never
  // work. `completeSignupIntent` has no inverse, so reading the latch as the
  // answer made it permanent.
  const { client, store } = await startBareGateway(t, {
    stripe: {} as unknown as StripeClient,
    stripeWebhookSecret: "whsec_example",
    stripePriceId: "price_example",
  });
  const organizationId = "org_burned";
  const secret = "burned-secret";
  const created = new Date();
  await store.createSignupIntent({
    id: "signup_burned",
    organizationId,
    email: "burned@example.com",
    organizationName: "Burned Team",
    secretHash: hashSecret(secret),
    stripeSessionId: undefined,
    userId: undefined,
    createdAt: created.toISOString(),
    expiresAt: new Date(created.getTime() + 86_400_000).toISOString(),
    // Latched, with nothing behind it.
    completedAt: created.toISOString(),
  });
  assert.equal(await store.getOrganization(organizationId), undefined);

  const finished = await client.request(
    `/api/v1/auth/signup/${encodeURIComponent(`signup_burned.${secret}`)}/complete`,
    {
      method: "POST",
      body: { displayName: "Burned", password: "BurnedSignupPassword123!" },
    },
  );
  assert.equal(finished.status, 201, JSON.stringify(finished.data));
  assert.equal(finished.data.user.email, "burned@example.com");
  // The organization the payment bought, built on the id the subscription
  // already points at rather than a new one.
  assert.equal(finished.data.memberships[0]?.organizationId, organizationId);
  assert.equal(finished.data.memberships[0]?.role, "owner");
  assert.deepEqual(
    (await store.listProjects(organizationId)).map((project) => project.slug),
    ["default"],
  );
});

test("day fifteen bills the trial and the team keeps working", async (t) => {
  // The half of the money nobody has watched happen. Everything up to here
  // has been proved by a real checkout; what follows it is a fortnight away
  // and arrives entirely as webhooks, so it is proved here instead.
  const secret = "whsec_example";
  const stripe = {
    createCheckoutSession: async () => ({ id: "cs_1", url: "https://x/1" }),
    getSubscription: async () => ({
      id: "sub_trial",
      status: "active",
      customerId: "cus_trial",
      currentPeriodEnd: 1_800_000_000,
      // Stripe keeps `trial_end` on a subscription after it converts — it
      // records when the trial ended, it is not cleared. The invoice path
      // builds a synthetic subscription object to re-record, and the row is
      // written whole, so a copy that dropped this erased the date.
      trialEnd: 1_700_000_000,
      quantity: 1,
      metadata: {},
    }),
  } as unknown as StripeClient;
  const { client, store } = await startBareGateway(t, {
    stripe,
    stripeWebhookSecret: secret,
    stripePriceId: "price_example",
  });
  const organization = await store.createOrganization({
    slug: "trialing-team",
    name: "Trialing Team",
  });
  const owner = await store.createUser({
    email: "owner@example.com",
    displayName: "Owner",
    passwordDigest: "digest",
    systemAdmin: false,
  });
  await store.saveMembership({
    organizationId: organization.id,
    userId: owner.id,
    role: "owner",
  });

  const deliver = async (body: string) => {
    const timestamp = Math.floor(Date.now() / 1000);
    return await client.request("/api/v1/stripe/webhook", {
      method: "POST",
      raw: Buffer.from(body, "utf8"),
      rawType: "application/json",
      headers: {
        "Stripe-Signature": `t=${String(timestamp)},v1=${createHmac(
          "sha256",
          secret,
        )
          .update(`${String(timestamp)}.${body}`, "utf8")
          .digest("hex")}`,
      },
    });
  };
  const subscriptionEvent = (type: string, status: string, trialEnd?: number) =>
    JSON.stringify({
      type,
      data: {
        object: {
          id: "sub_trial",
          status,
          customer: "cus_trial",
          ...(trialEnd === undefined ? {} : { trial_end: trialEnd }),
          current_period_end: 1_800_000_000,
          metadata: { organizationId: organization.id },
        },
      },
    });

  // Day 0: the card was taken and Stripe is running the trial.
  const trialEnd = Math.floor(Date.now() / 1000) + 14 * 86_400;
  assert.equal(
    (await deliver(subscriptionEvent("customer.subscription.created", "trialing", trialEnd))).status,
    200,
  );
  const trialing = await store.getSubscription(organization.id);
  // Stored as the trial it is. Folded into `active` — which is what this
  // pinned before — the countdown banner never fired for anybody and the
  // settings card told a day-two customer their subscription was running.
  assert.equal(trialing?.status, "trialing");
  assert.notEqual(
    trialing?.trialEndsAt,
    undefined,
    "the trial's end date is kept, not erased by the write",
  );
  assert.equal(
    subscriptionAllowsWork(trialing, organization.createdAt),
    true,
    "working during the trial",
  );

  // Day 15: Stripe charges the card. Both events fire and the order between
  // them is not guaranteed, so each is delivered and each must be harmless.
  assert.equal(
    (await deliver(JSON.stringify({
      type: "invoice.paid",
      data: { object: { subscription: "sub_trial", subscription_details: {} } },
    }))).status,
    200,
  );
  assert.equal(
    (await deliver(subscriptionEvent("customer.subscription.updated", "active"))).status,
    200,
  );

  const paying = await store.getSubscription(organization.id);
  assert.equal(paying?.status, "active");
  assert.notEqual(
    paying?.trialEndsAt,
    undefined,
    "the invoice path must not erase the date on the way through",
  );
  assert.equal(
    subscriptionAllowsWork(paying, organization.createdAt),
    true,
    "still working the day after the trial converts",
  );
  assert.equal(
    effectiveRole("owner", paying, organization.createdAt),
    "owner",
    "and not folded to viewer by the conversion",
  );
});

test("the reconciler finds seat drift nothing else would have", async (t) => {
  // "Every call site syncs" is a claim about code, and for a long time three
  // of the eight did not. An invoice is a claim about money, and until
  // something compares the two a missed call site is invisible from inside
  // the product. The promise that drift "heals at the next purchase or seat
  // change" has nothing behind it: a steady team makes neither for months.
  const writes: number[] = [];
  // What Stripe holds — one seat, as if the second person had joined while a
  // sync was missing.
  let held = 1;
  const stripe = {
    getSubscription: async (id: string) => ({
      id,
      status: "active",
      customerId: "cus_drift",
      currentPeriodEnd: undefined,
      trialEnd: undefined,
      quantity: held,
      metadata: {},
    }),
    getSubscriptionItemId: async () => "si_drift",
    updateSubscriptionQuantity: async (input: { quantity: number }) => {
      writes.push(input.quantity);
      held = input.quantity;
    },
  } as unknown as StripeClient;

  const { store } = await startBareGateway(t, {
    stripe,
    stripeWebhookSecret: "whsec_example",
    stripePriceId: "price_example",
    // The pass runs once at construction as well, which is what this is
    // really testing; a short interval only keeps a stuck one from hiding.
    billingReconcileIntervalMs: 50,
  });
  const organization = await store.createOrganization({
    slug: "drifted",
    name: "Drifted",
  });
  await store.saveSubscription({
    organizationId: organization.id,
    status: "active",
    stripeCustomerId: "cus_drift",
    stripeSubscriptionId: "sub_drift",
  });
  for (const name of ["one", "two", "three"]) {
    const user = await store.createUser({
      email: `${name}@example.com`,
      displayName: name,
      passwordDigest: "digest",
      systemAdmin: false,
    });
    await store.saveMembership({
      organizationId: organization.id,
      userId: user.id,
      role: "developer",
    });
  }

  // A cancelled organization beside it, which must not be touched: it is not
  // being charged, and writing a quantity to it would be a proration on a
  // subscription nobody holds.
  const gone = await store.createOrganization({ slug: "gone", name: "Gone" });
  await store.saveSubscription({
    organizationId: gone.id,
    status: "canceled",
    stripeSubscriptionId: "sub_gone",
  });

  // An abandoned checkout, swept on the way past. `deleteExpiredSignupIntents`
  // had no caller at all, so these accumulated forever — each one holding an
  // email address that then reads as taken when its owner tries again.
  const abandoned = new Date(Date.now() - 86_400_000).toISOString();
  await store.createSignupIntent({
    id: "signup_abandoned",
    organizationId: "org_never",
    email: "abandoned@example.com",
    organizationName: undefined,
    secretHash: "hash",
    stripeSessionId: undefined,
    userId: undefined,
    createdAt: abandoned,
    expiresAt: abandoned,
    completedAt: undefined,
  });

  await waitFor(
    async () => writes.length > 0,
    "the reconciler never corrected the seat count",
  );
  assert.deepEqual(writes, [3], "three people who can work, three seats");
  await waitFor(
    async () => (await store.getSignupIntent("signup_abandoned")) === undefined,
    "the expired sign-up was never swept",
  );

  // And it settles: once Stripe holds the right number the pass writes
  // nothing, because every write prorates.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(writes, [3], "a settled subscription is not rewritten");
});

test("three days out, the people who can cancel are told", async (t) => {
  // The only notice reaching a customer who has not opened the app since
  // signing up. The in-product countdown is real, but it has to be looked at,
  // and the alternative is a first charge with no warning at all.
  const secret = "whsec_example";
  const { client, store, sent } = await startBareGateway(t, {
    stripe: {} as unknown as StripeClient,
    stripeWebhookSecret: secret,
    stripePriceId: "price_example",
  });
  const organization = await store.createOrganization({
    slug: "ending-team",
    name: "Ending Team",
  });
  const roles = ["owner", "admin", "developer", "viewer"] as const;
  for (const role of roles) {
    const user = await store.createUser({
      email: `${role}@example.com`,
      displayName: role,
      passwordDigest: "digest",
      systemAdmin: false,
    });
    await store.saveMembership({
      organizationId: organization.id,
      userId: user.id,
      role,
    });
  }

  const body = JSON.stringify({
    type: "customer.subscription.trial_will_end",
    data: {
      object: {
        id: "sub_ending",
        status: "trialing",
        customer: "cus_ending",
        trial_end: 1_800_000_000,
        metadata: { organizationId: organization.id },
      },
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const delivered = await client.request("/api/v1/stripe/webhook", {
    method: "POST",
    raw: Buffer.from(body, "utf8"),
    rawType: "application/json",
    headers: {
      "Stripe-Signature": `t=${String(timestamp)},v1=${createHmac("sha256", secret)
        .update(`${String(timestamp)}.${body}`, "utf8")
        .digest("hex")}`,
    },
  });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.data));

  // Only the people who can act on it. A developer who cannot reach billing
  // has nothing to do with the message.
  assert.deepEqual(
    sent.map((message) => message.to).sort(),
    ["admin@example.com", "owner@example.com"],
  );
  assert.match(sent[0]?.subject ?? "", /trial ends soon/iu);
  // The date Stripe named, not a guess.
  assert.match(sent[0]?.text ?? "", /2027-01-15/u);

  // And the notice writes nothing: the entitlement is still whatever the
  // subscription events said it was.
  assert.equal(await store.getSubscription(organization.id), undefined);
});

test("a card that fails on day fifteen goes past due, not dark", async (t) => {
  // The other ending. A failed payment is a card problem, and locking a team
  // out of their repository over one is a worse answer than letting Stripe
  // retry — so `past_due` still works, and only a cancellation stops it.
  const secret = "whsec_example";
  // Stamped at checkout and carried by the subscription ever after, which is
  // exactly why it is stamped there: an invoice months later names the
  // organization with no lookup table in between.
  let organizationId = "";
  const stripe = {
    getSubscription: async () => ({
      id: "sub_late",
      status: "past_due",
      customerId: "cus_late",
      currentPeriodEnd: 1_800_000_000,
      trialEnd: undefined,
      quantity: 1,
      metadata: { organizationId },
    }),
  } as unknown as StripeClient;
  const { client, store } = await startBareGateway(t, {
    stripe,
    stripeWebhookSecret: secret,
    stripePriceId: "price_example",
  });
  const organization = await store.createOrganization({
    slug: "late-team",
    name: "Late Team",
  });
  organizationId = organization.id;

  const deliver = async (body: string) => {
    const timestamp = Math.floor(Date.now() / 1000);
    return await client.request("/api/v1/stripe/webhook", {
      method: "POST",
      raw: Buffer.from(body, "utf8"),
      rawType: "application/json",
      headers: {
        "Stripe-Signature": `t=${String(timestamp)},v1=${createHmac("sha256", secret)
          .update(`${String(timestamp)}.${body}`, "utf8")
          .digest("hex")}`,
      },
    });
  };

  await deliver(JSON.stringify({
    type: "invoice.payment_failed",
    data: { object: { subscription: "sub_late", subscription_details: {} } },
  }));
  const late = await store.getSubscription(organization.id);
  assert.equal(late?.status, "past_due");
  assert.equal(subscriptionAllowsWork(late, organization.createdAt), true);

  // Cancelled is where it stops.
  await deliver(JSON.stringify({
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: "sub_late",
        status: "canceled",
        customer: "cus_late",
        metadata: { organizationId: organization.id },
      },
    },
  }));
  const gone = await store.getSubscription(organization.id);
  assert.equal(gone?.status, "canceled");
  assert.equal(subscriptionAllowsWork(gone, organization.createdAt), false);
  assert.equal(
    effectiveRole("owner", gone, organization.createdAt),
    "viewer",
    "read-only rather than dark",
  );
});

test("a paid sign-up refuses an address that already has an account", async (t) => {
  // Checked before any money moves. Telling somebody they already have an
  // account is kinder and cheaper than charging them for a second one, and
  // the sign-in form beside it is no less of an address oracle.
  const stripe = {
    createCheckoutSession: async () => {
      throw new Error("checkout must not be reached");
    },
  } as unknown as StripeClient;
  const { client, store } = await startBareGateway(t, {
    stripe,
    stripeWebhookSecret: "whsec_example",
    stripePriceId: "price_example",
  });
  await store.createUser({
    email: "taken@example.com",
    displayName: "Taken",
    passwordDigest: "digest",
    systemAdmin: false,
  });

  const refused = await client.request("/api/v1/auth/signup", {
    method: "POST",
    body: { email: "Taken@Example.com" },
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error.code, "account_exists");
});

test("a forged webhook buys nothing, through the route rather than the verifier", async (t) => {
  // The verifier has unit tests; the route is where it matters. This URL is
  // public, it is the only thing that provisions a paid organization, and it
  // writes entitlement — so an unsigned body reaching `applyStripeEvent`
  // would be free service for anybody who found the path.
  const secret = "whsec_example";
  const { client, store } = await startBareGateway(t, {
    stripe: {} as unknown as StripeClient,
    stripeWebhookSecret: secret,
    stripePriceId: "price_example",
  });
  const organization = await store.createOrganization({
    slug: "victim",
    name: "Victim",
  });
  await store.saveSubscription({
    organizationId: organization.id,
    status: "active",
    stripeSubscriptionId: "sub_victim",
  });

  const body = JSON.stringify({
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: "sub_victim",
        status: "canceled",
        customer: "cus_victim",
        metadata: { organizationId: organization.id },
      },
    },
  });
  const raw = Buffer.from(body, "utf8");
  const now = Math.floor(Date.now() / 1000);
  const sign = (payload: string, key: string, at: number) =>
    `t=${String(at)},v1=${createHmac("sha256", key)
      .update(`${String(at)}.${payload}`, "utf8")
      .digest("hex")}`;
  const post = async (headers: Record<string, string>) =>
    await client.request("/api/v1/stripe/webhook", {
      method: "POST",
      raw,
      rawType: "application/json",
      headers,
    });

  // No header at all.
  assert.equal((await post({})).status, 400);
  // A header that is not a signature.
  assert.equal((await post({ "Stripe-Signature": "nonsense" })).status, 400);
  // Signed, correctly, with the wrong secret — somebody else's deployment,
  // or a guess.
  assert.equal(
    (await post({ "Stripe-Signature": sign(body, "whsec_wrong", now) })).status,
    400,
  );
  // A real signature over a different body: the tamper case, where a captured
  // header is reused on a payload of the attacker's choosing.
  assert.equal(
    (await post({
      "Stripe-Signature": sign('{"type":"ping"}', secret, now),
    })).status,
    400,
  );
  // A real signature that is too old to still be one — a captured replay.
  assert.equal(
    (await post({ "Stripe-Signature": sign(body, secret, now - 86_400) }))
      .status,
    400,
  );

  // Nothing any of them said was applied.
  assert.equal(
    (await store.getSubscription(organization.id))?.status,
    "active",
    "a refused webhook must not reach the entitlement",
  );

  // And the same body, signed properly, does apply — or the assertions above
  // would pass on a route that refuses everything.
  assert.equal(
    (await post({ "Stripe-Signature": sign(body, secret, now) })).status,
    200,
  );
  assert.equal(
    (await store.getSubscription(organization.id))?.status,
    "canceled",
  );
});

test("a Stripe event never overwrites a comped organization", async (t) => {
  // The destructive path needs no bad luck. Every organization that predates
  // billing was comped by migration; `subscriptionStatusFrom` reads every
  // status it does not recognise as `canceled`, `incomplete` among them; and
  // `incomplete` is exactly what an abandoned checkout leaves behind. The
  // subscription row is written whole, so one stray event would turn a
  // permanently free team into a cancelled one — and nothing in the product
  // grants a comp, so there would be no way back from inside.
  const secret = "whsec_example";
  const { client, store } = await startBareGateway(t, {
    stripe: {} as unknown as StripeClient,
    stripeWebhookSecret: secret,
    stripePriceId: "price_example",
  });
  const organization = await store.createOrganization({
    slug: "grandfathered",
    name: "Grandfathered",
  });
  await store.saveSubscription({
    organizationId: organization.id,
    status: "comped",
  });

  // A real signed event, through the real route: the guard has to hold where
  // Stripe actually reaches it, not where a test can call it directly.
  const body = JSON.stringify({
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_abandoned",
        status: "incomplete",
        customer: "cus_abandoned",
        metadata: { organizationId: organization.id },
      },
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret)
    .update(`${String(timestamp)}.${body}`, "utf8")
    .digest("hex");
  const delivered = await client.request("/api/v1/stripe/webhook", {
    method: "POST",
    raw: Buffer.from(body, "utf8"),
    rawType: "application/json",
    headers: { "Stripe-Signature": `t=${String(timestamp)},v1=${signature}` },
  });

  // Accepted, because refusing would make Stripe retry it for days.
  assert.equal(delivered.status, 200, JSON.stringify(delivered.data));
  assert.equal(
    (await store.getSubscription(organization.id))?.status,
    "comped",
    "a comp is a decision a person made; Stripe has no opinion about it",
  );
});

test("health says which billing variables reached the process", async (t) => {
  // The symptom this exists for: every way of misconfiguring Stripe — a name
  // typo, the variables on the wrong service, a save that never redeployed —
  // looks identical from outside, a 501 on the webhook. Three booleans, and
  // never any part of a value.
  const bare = await startBareGateway(t, {});
  const unset = await bare.client.request("/api/v1/health");
  assert.deepEqual(unset.data.billing, {
    // The switch first, because with it false the other three decide nothing
    // and reading them without it is how somebody concludes billing is broken
    // when it is simply off. On here, because the fixtures run with it on.
    payments: true,
    secretKey: false,
    webhookSecret: false,
    priceId: false,
    appUrl: "https://kumi.test",
  });

  const configured = await startBareGateway(t, {
    // The gateway is handed a constructed client rather than the key, so a
    // stub standing in for one is exactly what "a secret key was configured"
    // means from in here.
    stripe: {} as unknown as StripeClient,
    stripeWebhookSecret: "whsec_example",
    stripePriceId: "price_example",
  });
  const set = await configured.client.request("/api/v1/health");
  assert.deepEqual(set.data.billing, {
    payments: true,
    secretKey: true,
    webhookSecret: true,
    priceId: true,
    appUrl: "https://kumi.test",
  });

  // Never the values themselves, however the payload grows later.
  const body = JSON.stringify(set.data);
  assert.ok(!body.includes("whsec_example"), "the signing secret must not leak");
  assert.ok(!body.includes("price_example"), "no configured value is echoed");
});

test("a configured token is still required, and still says so", async (t) => {
  const { client } = await startBareGateway(t, {
    bootstrapToken: BOOTSTRAP_TOKEN,
  });
  const health = await client.request("/api/v1/health");
  assert.equal(health.data.bootstrapTokenRequired, true);

  const withoutToken = await client.request("/api/v1/auth/bootstrap", {
    method: "POST",
    body: {
      email: "owner@example.com",
      displayName: "Owner",
      password: PASSWORD,
      organizationName: "Relay Test",
    },
  });
  assert.equal(withoutToken.status, 403, JSON.stringify(withoutToken.data));
  assert.equal(withoutToken.data.error.code, "invalid_bootstrap_token");
});

test("a token short enough to guess is refused at startup", async (t) => {
  // Only when one is set. A short token reads as protection and is not.
  const store = new InMemoryCoordinationStore();
  t.after(async () => {
    await store.close();
  });
  assert.throws(
    () =>
      new ApiGateway({
        store,
        operations: {} as unknown as ApiOperations,
        bootstrapToken: "too-short",
      }),
    /at least 24 characters/u,
  );
});
