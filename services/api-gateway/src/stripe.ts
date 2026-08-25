import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The slice of Stripe this control plane actually uses.
 *
 * Deliberately not the Stripe SDK. Four calls and one signature check is less
 * code than the dependency would be, it keeps the wire format visible at the
 * point of use — which is what one debugs when a webhook misbehaves — and it
 * leaves the whole billing path testable against a plain object rather than
 * against a library's own test doubles.
 *
 * Every request is form-encoded, because that is what Stripe's REST API takes;
 * nested keys use the `a[b]` convention rather than JSON.
 */

export interface StripeCheckoutSession {
  id: string;
  url: string;
}

export interface StripePortalSession {
  url: string;
}

/**
 * The subset of a Stripe subscription this deployment reads.
 *
 * `status` is Stripe's own vocabulary, which is wider than ours —
 * `incomplete`, `unpaid` and `paused` all exist — so it stays a string here
 * and is narrowed deliberately in one place rather than assumed to line up.
 */
export interface StripeSubscription {
  id: string;
  status: string;
  customerId: string;
  /** Unix seconds; Stripe's own field name is `current_period_end`. */
  currentPeriodEnd: number | undefined;
  quantity: number | undefined;
  /**
   * Whatever was attached at checkout — this deployment puts `organizationId`
   * here, because the subscription is the object every later event is about.
   */
  metadata: Record<string, string>;
}

export interface StripeClient {
  createCheckoutSession(input: {
    organizationId: string;
    priceId: string;
    quantity: number;
    successUrl: string;
    cancelUrl: string;
    customerId?: string;
    customerEmail?: string;
  }): Promise<StripeCheckoutSession>;
  createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<StripePortalSession>;
  getSubscription(subscriptionId: string): Promise<StripeSubscription>;
  updateSubscriptionQuantity(input: {
    subscriptionId: string;
    subscriptionItemId: string;
    quantity: number;
  }): Promise<void>;
  /** The item id a subscription's quantity actually lives on. */
  getSubscriptionItemId(subscriptionId: string): Promise<string | undefined>;
}

export class StripeError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

/** Flattens to Stripe's `a[b][c]` form encoding, skipping absent values. */
function formEncode(values: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) {
      continue;
    }
    const name = prefix === "" ? key : `${prefix}[${key}]`;
    if (typeof value === "object") {
      const nested = formEncode(value as Record<string, unknown>, name);
      if (nested.length > 0) {
        parts.push(nested);
      }
      continue;
    }
    parts.push(
      `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`,
    );
  }
  return parts.join("&");
}

const STRIPE_API = "https://api.stripe.com/v1";

export class HttpStripeClient implements StripeClient {
  public constructor(
    private readonly secretKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${STRIPE_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        ...(body === undefined
          ? {}
          : { "Content-Type": "application/x-www-form-urlencoded" }),
      },
      ...(body === undefined ? {} : { body: formEncode(body) }),
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const error = payload["error"] as { message?: string } | undefined;
      // Stripe's own message is the useful one — it names the parameter it
      // rejected — so it is carried rather than replaced with a generic line.
      throw new StripeError(
        error?.message ?? `Stripe request failed (${String(response.status)})`,
        response.status,
      );
    }
    return payload;
  }

  public async createCheckoutSession(input: {
    organizationId: string;
    priceId: string;
    quantity: number;
    successUrl: string;
    cancelUrl: string;
    customerId?: string;
    customerEmail?: string;
  }): Promise<StripeCheckoutSession> {
    const payload = await this.call("POST", "/checkout/sessions", {
      mode: "subscription",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      "line_items[0][price]": input.priceId,
      "line_items[0][quantity]": input.quantity,
      // Which organization is buying, carried on both the session and the
      // subscription it creates. The webhook reads it off the subscription,
      // because that is the object every later event is about — an event
      // arriving months from now must still be attributable without a lookup
      // table nobody has been maintaining.
      "metadata[organizationId]": input.organizationId,
      "subscription_data[metadata][organizationId]": input.organizationId,
      ...(input.customerId === undefined ? {} : { customer: input.customerId }),
      ...(input.customerEmail === undefined || input.customerId !== undefined
        ? {}
        : { customer_email: input.customerEmail }),
    });
    const url = payload["url"];
    const id = payload["id"];
    if (typeof url !== "string" || typeof id !== "string") {
      throw new StripeError("Stripe returned no checkout URL", 502);
    }
    return { id, url };
  }

  public async createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<StripePortalSession> {
    const payload = await this.call("POST", "/billing_portal/sessions", {
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    const url = payload["url"];
    if (typeof url !== "string") {
      throw new StripeError("Stripe returned no portal URL", 502);
    }
    return { url };
  }

  public async getSubscription(
    subscriptionId: string,
  ): Promise<StripeSubscription> {
    return readSubscription(
      await this.call(
        "GET",
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      ),
    );
  }

  public async getSubscriptionItemId(
    subscriptionId: string,
  ): Promise<string | undefined> {
    const payload = await this.call(
      "GET",
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    );
    return firstSubscriptionItemId(payload);
  }

  public async updateSubscriptionQuantity(input: {
    subscriptionId: string;
    subscriptionItemId: string;
    quantity: number;
  }): Promise<void> {
    await this.call(
      "POST",
      `/subscription_items/${encodeURIComponent(input.subscriptionItemId)}`,
      {
        quantity: input.quantity,
        // Bill the difference now rather than at the next cycle. A seat added
        // mid-month is a seat being used mid-month, and the alternative is a
        // month of free seats for anyone who times their invites well.
        proration_behavior: "create_prorations",
      },
    );
  }
}

/** Reads the fields we use off a Stripe subscription object. */
export function readSubscription(
  payload: Record<string, unknown>,
): StripeSubscription {
  const customer = payload["customer"];
  const periodEnd = payload["current_period_end"];
  return {
    id: String(payload["id"] ?? ""),
    status: String(payload["status"] ?? ""),
    // Expanded or not: Stripe sends a bare id most of the time and an object
    // when something upstream asked for expansion, and reading only one shape
    // is how a customer id silently becomes "[object Object]".
    customerId:
      typeof customer === "string"
        ? customer
        : String(
            (customer as { id?: unknown } | null)?.id ?? "",
          ),
    currentPeriodEnd: typeof periodEnd === "number" ? periodEnd : undefined,
    quantity: firstSubscriptionQuantity(payload),
    metadata: readMetadata(payload["metadata"]),
  };
}

/** Stripe metadata is always string-to-string; anything else is ignored. */
function readMetadata(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      metadata[key] = entry;
    }
  }
  return metadata;
}

function subscriptionItems(
  payload: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const items = payload["items"] as { data?: unknown } | undefined;
  return Array.isArray(items?.data)
    ? (items.data as Array<Record<string, unknown>>)
    : [];
}

function firstSubscriptionItemId(
  payload: Record<string, unknown>,
): string | undefined {
  const id = subscriptionItems(payload)[0]?.["id"];
  return typeof id === "string" ? id : undefined;
}

function firstSubscriptionQuantity(
  payload: Record<string, unknown>,
): number | undefined {
  const quantity = subscriptionItems(payload)[0]?.["quantity"];
  return typeof quantity === "number" ? quantity : undefined;
}

/**
 * How long a signed webhook stays acceptable, in seconds.
 *
 * Stripe's own recommendation. Without it a signature stays valid forever, so
 * anyone who ever captured one request could replay it indefinitely — and a
 * replayed `customer.subscription.deleted` is somebody's access disappearing.
 */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export class WebhookSignatureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

/**
 * Verifies a Stripe webhook signature against the raw request body.
 *
 * The body must be the exact bytes Stripe sent. Parsing to JSON and
 * re-serialising changes key order and whitespace, and the signature is over
 * the bytes — which is why the webhook route reads its body itself instead of
 * going through the gateway's ordinary JSON reader.
 *
 * Throws rather than returning false: every caller of this must refuse, and a
 * boolean is one forgotten `if` away from accepting anything.
 */
export function verifyWebhookSignature(input: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  secret: string;
  now?: Date;
}): void {
  if (input.signatureHeader === undefined) {
    throw new WebhookSignatureError("Missing Stripe-Signature header");
  }
  let timestamp = "";
  const candidates: string[] = [];
  for (const part of input.signatureHeader.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value !== undefined) {
      timestamp = value;
    }
    // Every v1 scheme signature, not just the first: Stripe sends more than
    // one while a signing secret is being rotated, and taking only the first
    // makes a rotation look like an attack.
    if (key === "v1" && value !== undefined) {
      candidates.push(value);
    }
  }
  if (timestamp === "" || candidates.length === 0) {
    throw new WebhookSignatureError("Malformed Stripe-Signature header");
  }
  const signedAt = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(signedAt)) {
    throw new WebhookSignatureError("Malformed Stripe-Signature timestamp");
  }
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - signedAt) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new WebhookSignatureError("Stripe signature is outside its window");
  }
  const expected = createHmac("sha256", input.secret)
    .update(`${timestamp}.${input.rawBody.toString("utf8")}`, "utf8")
    .digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const matched = candidates.some((candidate) => {
    const candidateBuffer = Buffer.from(candidate, "utf8");
    return (
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer)
    );
  });
  if (!matched) {
    throw new WebhookSignatureError("Stripe signature did not match");
  }
}

/** Stripe statuses that mean the subscription is worth honouring. */
const STRIPE_ACTIVE = new Set(["active", "trialing"]);
const STRIPE_PAST_DUE = new Set(["past_due", "unpaid"]);

/**
 * Narrows Stripe's status vocabulary to this deployment's own.
 *
 * Stripe has more statuses than the gate does, and the mapping is a decision
 * rather than a translation: `incomplete` — a subscription whose first payment
 * never completed — becomes `canceled` here, because nothing was ever paid and
 * treating it as entitlement would let an abandoned checkout buy access.
 */
export function subscriptionStatusFrom(
  stripeStatus: string,
): "active" | "past_due" | "canceled" {
  if (STRIPE_ACTIVE.has(stripeStatus)) {
    return "active";
  }
  if (STRIPE_PAST_DUE.has(stripeStatus)) {
    return "past_due";
  }
  return "canceled";
}

/** Unix seconds to the ISO string the store keeps, or undefined. */
export function isoFromUnixSeconds(
  seconds: number | undefined,
): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return undefined;
  }
  return new Date(seconds * 1000).toISOString();
}
