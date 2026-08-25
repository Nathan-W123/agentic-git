import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  HttpStripeClient,
  StripeError,
  WEBHOOK_TOLERANCE_SECONDS,
  WebhookSignatureError,
  isoFromUnixSeconds,
  readSubscription,
  subscriptionStatusFrom,
  verifyWebhookSignature,
} from "./stripe.js";

const SECRET = "whsec_test_secret";
const NOW = new Date("2026-06-01T12:00:00.000Z");

function signedHeader(
  body: string,
  at: Date = NOW,
  secret = SECRET,
  scheme = "v1",
): string {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
  return `t=${timestamp},${scheme}=${signature}`;
}

/* -------------------------------------------------- webhook signatures --- */

test("a correctly signed webhook is accepted", () => {
  const body = '{"id":"evt_1","type":"invoice.paid"}';
  verifyWebhookSignature({
    rawBody: Buffer.from(body),
    signatureHeader: signedHeader(body),
    secret: SECRET,
    now: NOW,
  });
});

test("a body altered after signing is refused", () => {
  // The whole point of the raw body: re-serialising JSON changes the bytes,
  // and the signature is over bytes. This is what catches that mistake.
  const body = '{"id":"evt_1","type":"invoice.paid"}';
  const header = signedHeader(body);
  assert.throws(
    () =>
      verifyWebhookSignature({
        rawBody: Buffer.from('{"type":"invoice.paid","id":"evt_1"}'),
        signatureHeader: header,
        secret: SECRET,
        now: NOW,
      }),
    WebhookSignatureError,
  );
});

test("a signature from the wrong secret is refused", () => {
  const body = '{"id":"evt_1"}';
  assert.throws(
    () =>
      verifyWebhookSignature({
        rawBody: Buffer.from(body),
        signatureHeader: signedHeader(body, NOW, "whsec_someone_elses"),
        secret: SECRET,
        now: NOW,
      }),
    WebhookSignatureError,
  );
});

test("a captured request cannot be replayed later", () => {
  // Without the timestamp window a signature is valid forever, and a replayed
  // `customer.subscription.deleted` is somebody's access disappearing.
  const body = '{"id":"evt_1"}';
  const header = signedHeader(body, NOW);
  const muchLater = new Date(
    NOW.getTime() + (WEBHOOK_TOLERANCE_SECONDS + 60) * 1000,
  );
  assert.throws(
    () =>
      verifyWebhookSignature({
        rawBody: Buffer.from(body),
        signatureHeader: header,
        secret: SECRET,
        now: muchLater,
      }),
    WebhookSignatureError,
  );
  // Just inside the window still works, so the bound is a window and not an
  // accident of clock skew.
  verifyWebhookSignature({
    rawBody: Buffer.from(body),
    signatureHeader: header,
    secret: SECRET,
    now: new Date(NOW.getTime() + (WEBHOOK_TOLERANCE_SECONDS - 10) * 1000),
  });
});

test("a clock ahead of Stripe's is tolerated within the window", () => {
  // Skew runs both ways; only the magnitude is bounded.
  const body = '{"id":"evt_1"}';
  const header = signedHeader(body, new Date(NOW.getTime() + 60_000));
  verifyWebhookSignature({
    rawBody: Buffer.from(body),
    signatureHeader: header,
    secret: SECRET,
    now: NOW,
  });
});

test("a missing or malformed signature header is refused", () => {
  const body = '{"id":"evt_1"}';
  for (const header of [
    undefined,
    "",
    "nonsense",
    "t=,v1=abc",
    `t=${String(Math.floor(NOW.getTime() / 1000))}`,
    "v1=abc",
  ]) {
    assert.throws(
      () =>
        verifyWebhookSignature({
          rawBody: Buffer.from(body),
          signatureHeader: header,
          secret: SECRET,
          now: NOW,
        }),
      WebhookSignatureError,
      `header: ${String(header)}`,
    );
  }
});

test("a secret rotation sending two signatures is accepted on either", () => {
  // Stripe sends every valid signature while a secret is being rotated.
  // Reading only the first turns a rotation into an outage.
  const body = '{"id":"evt_1"}';
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const wrong = createHmac("sha256", "whsec_old")
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
  const right = createHmac("sha256", SECRET)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
  verifyWebhookSignature({
    rawBody: Buffer.from(body),
    signatureHeader: `t=${timestamp},v1=${wrong},v1=${right}`,
    secret: SECRET,
    now: NOW,
  });
});

test("a v0 signature alone does not authenticate anything", () => {
  // v0 exists and is not the scheme we verify. Accepting it because it is
  // present would be accepting an unverified body.
  const body = '{"id":"evt_1"}';
  assert.throws(
    () =>
      verifyWebhookSignature({
        rawBody: Buffer.from(body),
        signatureHeader: signedHeader(body, NOW, SECRET, "v0"),
        secret: SECRET,
        now: NOW,
      }),
    WebhookSignatureError,
  );
});

/* ------------------------------------------------------ status mapping --- */

test("Stripe's statuses narrow to this deployment's three", () => {
  assert.equal(subscriptionStatusFrom("active"), "active");
  assert.equal(subscriptionStatusFrom("trialing"), "active");
  assert.equal(subscriptionStatusFrom("past_due"), "past_due");
  assert.equal(subscriptionStatusFrom("unpaid"), "past_due");
  assert.equal(subscriptionStatusFrom("canceled"), "canceled");
  assert.equal(subscriptionStatusFrom("paused"), "canceled");
});

test("an abandoned checkout never becomes entitlement", () => {
  // `incomplete` is a subscription whose first payment never went through.
  // Nothing was paid, so it must not read as access.
  assert.equal(subscriptionStatusFrom("incomplete"), "canceled");
  assert.equal(subscriptionStatusFrom("incomplete_expired"), "canceled");
});

test("an unrecognised Stripe status is refused rather than assumed", () => {
  assert.equal(subscriptionStatusFrom("something_new_in_2027"), "canceled");
});

/* --------------------------------------------------- subscription read --- */

test("a customer reads the same expanded or not", () => {
  // Stripe sends a bare id most of the time and an object when something
  // upstream asked for expansion. Reading one shape is how a customer id
  // silently becomes "[object Object]".
  assert.equal(
    readSubscription({ id: "sub_1", status: "active", customer: "cus_1" })
      .customerId,
    "cus_1",
  );
  assert.equal(
    readSubscription({
      id: "sub_1",
      status: "active",
      customer: { id: "cus_1" },
    }).customerId,
    "cus_1",
  );
});

test("quantity and period end are read off the first item", () => {
  const subscription = readSubscription({
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    current_period_end: 1_800_000_000,
    items: { data: [{ id: "si_1", quantity: 7 }] },
  });
  assert.equal(subscription.quantity, 7);
  assert.equal(subscription.currentPeriodEnd, 1_800_000_000);
  assert.equal(
    isoFromUnixSeconds(subscription.currentPeriodEnd),
    new Date(1_800_000_000 * 1000).toISOString(),
  );
});

test("a Stripe-run trial's end date is read and survives the round trip", () => {
  // Once the card is captured at sign-up, the fourteen days belong to Stripe
  // rather than to our own arithmetic — and the store's copy is what every
  // entitlement check reads, so it has to be told what Stripe decided.
  const trialing = readSubscription({
    id: "sub_1",
    status: "trialing",
    customer: "cus_1",
    trial_end: 1_800_000_000,
    current_period_end: 1_800_000_000,
  });
  assert.equal(trialing.trialEnd, 1_800_000_000);
  assert.equal(
    isoFromUnixSeconds(trialing.trialEnd),
    new Date(1_800_000_000 * 1000).toISOString(),
  );

  // A subscription that never had a trial says so by omission, not by zero:
  // Stripe leaves the field out, and a 0 would be read as 1970.
  assert.equal(
    readSubscription({ id: "sub_1", status: "active", customer: "cus_1" })
      .trialEnd,
    undefined,
  );
});

test("a checkout that asks for a trial takes the card anyway", async () => {
  // The founder's model in one request: fourteen free days, card captured on
  // day zero, billed on day fifteen. Every one of these lives under
  // `subscription_data` — a top-level `trial_period_days` belongs to the
  // Subscriptions API and earns a 400 here.
  const sent: string[] = [];
  const client = new HttpStripeClient("sk_test_x", (async (
    _url: string,
    init: { body?: string },
  ) => {
    sent.push(init.body ?? "");
    return {
      ok: true,
      json: async () => ({ id: "cs_1", url: "https://checkout.example/1" }),
    };
  }) as unknown as typeof fetch);

  await client.createCheckoutSession({
    organizationId: "org_1",
    priceId: "price_1",
    quantity: 1,
    successUrl: "https://kumi.test/#billing-done",
    cancelUrl: "https://kumi.test/#billing",
    trialPeriodDays: 14,
  });
  const body = sent[0] ?? "";
  assert.match(body, /subscription_data%5Btrial_period_days%5D=14/u);
  assert.match(body, /payment_method_collection=always/u);
  // A card removed mid-trial cancels rather than raising an invoice nobody
  // can pay against a subscription that is somehow still alive.
  assert.match(
    body,
    /subscription_data%5Btrial_settings%5D%5Bend_behavior%5D%5Bmissing_payment_method%5D=cancel/u,
  );

  // And a checkout that asks for no trial still charges immediately, which is
  // what an existing team pressing Subscribe should get.
  await client.createCheckoutSession({
    organizationId: "org_1",
    priceId: "price_1",
    quantity: 1,
    successUrl: "https://kumi.test/#billing-done",
    cancelUrl: "https://kumi.test/#billing",
  });
  assert.doesNotMatch(sent[1] ?? "", /trial_period_days/u);
});

test("a subscription missing its items is read without throwing", () => {
  // Stripe omits fields rather than sending nulls, and a webhook payload is
  // not always the fully expanded object.
  const subscription = readSubscription({ id: "sub_1", status: "active" });
  assert.equal(subscription.quantity, undefined);
  assert.equal(subscription.currentPeriodEnd, undefined);
  assert.equal(isoFromUnixSeconds(undefined), undefined);
});

/* --------------------------------------------------------- http client --- */

test("checkout carries the organization onto the subscription", async () => {
  // The webhook reads the organization off the subscription, because that is
  // the object every later event is about. Losing it here means an invoice
  // arriving in March cannot be attributed to anyone.
  let sentBody = "";
  const client = new HttpStripeClient("sk_test_x", (async (
    _url: string,
    init: { body?: string },
  ) => {
    sentBody = init.body ?? "";
    return {
      ok: true,
      json: async () => ({ id: "cs_1", url: "https://checkout.example/1" }),
    };
  }) as unknown as typeof fetch);

  const session = await client.createCheckoutSession({
    organizationId: "org_1",
    priceId: "price_1",
    quantity: 3,
    successUrl: "https://app.example/ok",
    cancelUrl: "https://app.example/no",
  });
  assert.equal(session.url, "https://checkout.example/1");
  assert.match(sentBody, /mode=subscription/u);
  assert.match(sentBody, /line_items%5B0%5D%5Bquantity%5D=3/u);
  assert.match(
    sentBody,
    /subscription_data%5Bmetadata%5D%5BorganizationId%5D=org_1/u,
  );
});

test("Stripe's own error message reaches the caller", async () => {
  // Stripe names the parameter it rejected, which is the whole diagnostic.
  const client = new HttpStripeClient("sk_test_x", (async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { message: "No such price: price_nope" } }),
  })) as unknown as typeof fetch);

  await assert.rejects(
    client.createCheckoutSession({
      organizationId: "org_1",
      priceId: "price_nope",
      quantity: 1,
      successUrl: "https://app.example/ok",
      cancelUrl: "https://app.example/no",
    }),
    (error: unknown) =>
      error instanceof StripeError &&
      /No such price: price_nope/u.test(error.message),
  );
});

test("a seat change bills the difference now", async () => {
  // The alternative is a month of free seats for anyone who times their
  // invites well.
  let sentBody = "";
  const client = new HttpStripeClient("sk_test_x", (async (
    _url: string,
    init: { body?: string },
  ) => {
    sentBody = init.body ?? "";
    return { ok: true, json: async () => ({ id: "si_1" }) };
  }) as unknown as typeof fetch);

  await client.updateSubscriptionQuantity({
    subscriptionId: "sub_1",
    subscriptionItemId: "si_1",
    quantity: 9,
  });
  assert.match(sentBody, /quantity=9/u);
  assert.match(sentBody, /proration_behavior=create_prorations/u);
});
