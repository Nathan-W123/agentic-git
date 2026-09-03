/**
 * Everything answerable before anybody has been identified.
 *
 * The Stripe webhook, health, first-run bootstrap, sign-up, the waitlist,
 * sign-in, password reset, an invitation link, and the one-shot bundle
 * ticket an editor fetches its base revision with.
 *
 * This group runs first and is the reason the split has two chains rather
 * than one: `requirePrincipal` throws, so a route that belongs here and is
 * filed anywhere else stops working for the people it exists to serve.
 *
 * Returns `true` when it answered the request. Order is behaviour: the first
 * branch that matches wins, exactly as it did when all of this was one
 * `if`-chain, and `server.ts` calls the groups in the order they were
 * written in.
 */

import {
  randomBytes,
} from "node:crypto";
import {
  createId,
  describeError,
} from "@coord/shared-types";
import {
  hashPassword,
  hashSecret,
  secretMatches,
} from "../auth.js";
import {
  TRIAL_DAYS,
} from "../billing.js";
import {
  HttpError,
  emailField,
  objectBody,
  stringField,
} from "../field-validation.js";
import {
  assertConfirmed,
  emailConfirmationRequired,
  matchPath,
  publicInvitation,
  registrationOpen,
  safeEqual,
  invitationIdForCode,
} from "../gateway-util.js";
import {
  API_PREFIX,
} from "../http-util.js";
import {
  WebhookSignatureError,
  verifyWebhookSignature,
} from "../stripe.js";
import {
  normalizeInvitationCode,
} from "../gateway-util.js";
import type { ApiGateway } from "../server.js";
import type { RouteRequest } from "./context.js";

export async function routePublic(
  gw: ApiGateway,
  req: RouteRequest,
): Promise<boolean> {
  const { context, request, response, url, method, path } = req;


  if (method === "POST" && path === `${API_PREFIX}/stripe/webhook`) {
    if (!gw.payments) {
      // Answered before the signature is even looked at. With payments off
      // no checkout was ever started here, so any event arriving is for a
      // subscription this deployment did not sell — and applying one would
      // move an entitlement nobody is being charged for.
      throw new HttpError(
        501,
        "payments_disabled",
        "This deployment is not taking payments",
      );
    }
    if (gw.stripeWebhookSecret === undefined) {
      // Refused rather than ignored. A deployment with no secret cannot tell
      // a real event from a forged one, and answering 200 to both would let
      // anyone who found this URL cancel somebody's subscription.
      throw new HttpError(
        501,
        "billing_not_configured",
        "This deployment accepts no Stripe webhooks",
      );
    }
    const rawBody = await gw.readRawBody(request);
    try {
      verifyWebhookSignature({
        rawBody,
        signatureHeader:
          typeof request.headers["stripe-signature"] === "string"
            ? request.headers["stripe-signature"]
            : undefined,
        secret: gw.stripeWebhookSecret,
      });
    } catch (error) {
      if (error instanceof WebhookSignatureError) {
        throw new HttpError(400, "invalid_signature", error.message);
      }
      throw error;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "invalid_json", "Webhook body was not JSON");
    }
    await gw.applyStripeEvent(event);
    // 200 on anything that verified, including an event type nothing here
    // handles. Stripe retries a non-2xx for days, and retrying an event we
    // have deliberately ignored is noise that hides the ones that matter.
    gw.sendJson(response, 200, { received: true });
    return true;
  }

  if (method === "GET" && path === `${API_PREFIX}/health`) {
    let docker:
      | { available: boolean; version?: string; explanation: string }
      | undefined;
    try {
      docker = await gw.options.operations.dockerStatus?.();
    } catch (error) {
      docker = {
        available: false,
        explanation: error instanceof Error ? error.message : String(error),
      };
    }
    gw.sendJson(response, 200, {
      status: "ok",
      database: "ready",
      setupRequired: (await gw.options.store.countUsers()) === 0,
      // So the setup form knows whether to ask for a token at all, rather
      // than showing a required field that this deployment does not want
      // and cannot be filled in correctly. Says whether a secret is needed,
      // never anything about what it is.
      bootstrapTokenRequired: gw.bootstrapToken !== undefined,
      // Which billing variables actually reached this process, as three
      // booleans and never a character of any of them.
      //
      // Setting these is a four-step job spread across two dashboards, and
      // every way of getting it wrong — a name typo, the wrong service, a
      // save that never redeployed — produces one indistinguishable
      // symptom: Stripe posts an event and the deployment answers 501. From
      // outside there is no way to tell "not set" from "set on the wrong
      // service" from "set but this container predates it", and the person
      // configuring it is the one person who cannot see inside the process.
      // `build.startedAt` above already says which container is answering;
      // this says what it was handed.
      billing: {
        // The switch itself, first: with this false none of the three
        // below matter, and reading them without it is how somebody
        // concludes billing is broken when it is simply off.
        payments: gw.payments,
        secretKey: gw.stripe !== undefined,
        webhookSecret: gw.stripeWebhookSecret !== undefined,
        priceId: gw.stripePriceId !== undefined,
        // Where Stripe is told to send a browser back to. Not a secret —
        // it is the address people type — and it is the one billing
        // setting whose absence fails somewhere else entirely: an empty
        // value makes a relative `success_url`, which Stripe refuses, so
        // the symptom is a 500 on sign-up rather than anything naming gw.
        appUrl: gw.appBaseUrl === "" ? null : gw.appBaseUrl,
      },
      webSocketConnections: gw.webSockets.connections,
      ...(docker === undefined ? {} : { docker }),
      // Which code is answering, so a deploy can be confirmed from outside
      // rather than assumed. There was no marker of any kind here, and the
      // only way to tell whether a push had landed was to find a behaviour
      // that changed and try it — which cannot distinguish "not deployed
      // yet" from "deployed and broken", the two cases most worth telling
      // apart.
      //
      // `startedAt` earns its place even where the commit is unknown: it is
      // the process start, so a redeploy moves it whether or not anything
      // told the container what it was built from. A restart is visible on
      // its own.
      build: {
        commit:
          process.env["COORD_BUILD_SHA"] ??
          process.env["RAILWAY_GIT_COMMIT_SHA"] ??
          "unknown",
        startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000))
          .toISOString(),
      },
      time: new Date().toISOString(),
    });
    return true;
  }

  if (method === "POST" && path === `${API_PREFIX}/auth/bootstrap`) {
    // Trimmed on arrival for the same reason the configured value is:
    // this token is copied out of one box and pasted into another, and a
    // stray newline either side is a property of the clipboard, never of
    // what the operator meant. A bootstrap token with meaningful leading or
    // trailing whitespace does not exist.
    const token =
      typeof request.headers["x-bootstrap-token"] === "string"
        ? request.headers["x-bootstrap-token"].trim()
        : "";
    // No token configured means first-run setup is open. Still not a way in
    // to an already-claimed deployment: `AuthService.bootstrap` refuses with
    // `bootstrap_complete` the moment a user exists, so this is a door that
    // locks itself behind the first person through it.
    if (
      gw.bootstrapToken !== undefined &&
      !safeEqual(token, gw.bootstrapToken)
    ) {
      throw new HttpError(403, "invalid_bootstrap_token", "Bootstrap token is invalid");
    }
    const body = objectBody(await gw.readJson(request));
    gw.assertAccountConfirmations(body);
    if (gw.bootstrapInProgress) {
      throw new HttpError(
        409,
        "bootstrap_in_progress",
        "First-run setup is already in progress",
      );
    }
    gw.bootstrapInProgress = true;
    let user;
    try {
      user = await gw.auth.bootstrap({
        email: emailField(body["email"]) ?? "",
        displayName:
          stringField(body["displayName"], "displayName", { max: 120 }) ?? "",
        password:
          stringField(body["password"], "password", { max: 256 }) ?? "",
        ...(body["organizationName"] === undefined
          ? {}
          : {
              organizationName:
                stringField(body["organizationName"], "organizationName", {
                  max: 120,
                }) ?? "",
            }),
      });
    } finally {
      gw.bootstrapInProgress = false;
    }
    const issued = await gw.auth.issueSession(
      user,
      gw.remoteAddress(request),
      request.headers["user-agent"] ?? "",
      context.secure,
    );
    response.setHeader("Set-Cookie", issued.cookies);
    await gw.options.store.appendAudit(undefined, {
      type: "user_authenticated",
      data: { userId: user.id, bootstrap: true },
    });
    gw.sendJson(response, 201, {
      user: issued.principal.user,
      memberships: issued.principal.memberships,
      csrfToken: issued.csrfToken,
    });
    return true;
  }

  if (method === "POST" && path === `${API_PREFIX}/auth/signup`) {
    // Step one of a paid sign-up: an address, and a card.
    //
    // Nothing durable that anybody can sign in to is created here. The
    // address is checked for a duplicate before any money moves — telling
    // somebody they already have an account is kinder and cheaper than
    // charging them for a second one — and the organization id is minted
    // now so it can be stamped into Stripe's metadata, which is what makes
    // an invoice three months from now attributable with no lookup table.
    if (!gw.payments) {
      // The card path is closed, not broken. Said as 501 with the address
      // of the door that is open, because the caller here is a browser that
      // followed a link somebody still has — an older bookmark, a page in a
      // cache — and "this moved" is the only useful thing to tell it.
      throw new HttpError(
        501,
        "payments_disabled",
        "This deployment is not taking payments. Join the waitlist at /api/v1/waitlist.",
      );
    }
    if (!registrationOpen(process.env)) {
      throw new HttpError(
        403,
        "registration_closed",
        "This control plane does not accept new accounts",
      );
    }
    const stripe = gw.requireStripe();
    const priceId = gw.stripePriceId;
    if (priceId === undefined) {
      throw new HttpError(
        501,
        "billing_not_configured",
        "No price is configured for this deployment",
      );
    }
    if (gw.appBaseUrl === "") {
      // Stripe needs somewhere absolute to send them back to. Without this
      // the return address would be `/app#welcome/...`, which Stripe refuses —
      // and it refuses it as a parameter error, so the deployment answers
      // 500 to somebody trying to buy something and nothing anywhere names
      // the missing variable.
      throw new HttpError(
        501,
        "billing_not_configured",
        "This deployment has no public address configured (KUMI_APP_URL)",
      );
    }
    const body = objectBody(await gw.readJson(request));
    const email = (emailField(body["email"]) ?? "").trim().toLowerCase();
    if (email === "") {
      throw new HttpError(400, "invalid_request", "An email is required");
    }
    if ((await gw.options.store.getUserByEmail(email)) !== undefined) {
      // Said plainly, matching what `/auth/register` already answers for
      // the same case. This route is no more of an address oracle than the
      // sign-in form beside it, and quietly taking the money instead would
      // be worse than the disclosure.
      throw new HttpError(
        409,
        "account_exists",
        "An account already uses that email address. Sign in instead.",
      );
    }
    const organizationName =
      stringField(body["organizationName"], "organizationName", {
        max: 120,
        optional: true,
      }) ?? "";
    const intentId = `signup_${randomBytes(9).toString("base64url")}`;
    const secret = randomBytes(32).toString("base64url");
    const organizationId = createId("org");
    const now = new Date();
    const session = await stripe.createCheckoutSession({
      organizationId,
      priceId,
      // One seat: the person standing at the checkout is the only member
      // this organization has, and Stripe refuses a quantity of zero.
      quantity: 1,
      customerEmail: email,
      trialPeriodDays: TRIAL_DAYS,
      successUrl: `${gw.appBaseUrl}/app#welcome/${intentId}.${secret}`,
      cancelUrl: `${gw.appBaseUrl}/app#signup`,
    });
    await gw.options.store.createSignupIntent({
      id: intentId,
      organizationId,
      email,
      organizationName: organizationName === "" ? undefined : organizationName,
      secretHash: hashSecret(secret),
      stripeSessionId: session.id,
      userId: undefined,
      createdAt: now.toISOString(),
      // A day is generous for a card form and short enough that an
      // abandoned intent does not sit around naming an unused id.
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      completedAt: undefined,
    });
    // Mailed now rather than when the payment lands, because the link is
    // built from a secret this deployment deliberately does not keep — only
    // its hash is stored, exactly as a password reset's is. Sending it here
    // is what stops the browser tab being the only copy: somebody who pays
    // and then closes the tab has otherwise paid for an organization they
    // can never reach.
    //
    // Safe to send before the money clears, because the link cannot build
    // an account until it has: the completion route refuses while the
    // sign-up is unpaid, and says so.
    const link = `${gw.appBaseUrl}/app#welcome/${intentId}.${secret}`;
    try {
      await gw.mailer({
        to: email,
        subject: "Finish setting up Kumi",
        text:
          `Your Kumi trial is starting.\n\n` +
          `Open this link to choose a name and a password, and your team ` +
          `is ready:\n\n${link}\n\n` +
          `Fourteen days are free. Your card is billed after that unless ` +
          `you cancel first.\n\n` +
          `If you did not start this, ignore this message — no account has ` +
          `been created and nothing has been charged.\n`,
      });
    } catch (error) {
      // A relay that is down must not fail the sign-up: the checkout is
      // already made, the person is about to be sent to it, and the tab
      // they are holding carries the same link. The operator sees this;
      // they see their card form.
      console.error(
        `[mail] Could not send the sign-up link for ${intentId}: ` +
          describeError(error),
      );
    }
    gw.sendJson(response, 200, { url: session.url });
    return true;
  }

  const signupCompleteMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/auth/signup/([^/]+)/complete$`, "u"),
  );
  if (signupCompleteMatch !== undefined && method === "POST") {
    // Step three: the payment has cleared and the organization exists, so
    // now — and only now — a name and a password build the account.
    const intent = await gw.signupIntentFor(signupCompleteMatch[0] ?? "");
    if (intent.completedAt === undefined) {
      // The webhook has not arrived yet. Telling them to wait is the honest
      // answer; building the account here would mean building it before the
      // money is confirmed.
      throw new HttpError(
        409,
        "payment_not_confirmed",
        "The payment has not been confirmed yet. Try again in a moment.",
      );
    }
    // The latch says the payment cleared; whether the organization it
    // bought exists is a separate question, and for any sign-up that went
    // through the old latch-first provisioning the answer can be no. This
    // is a no-op for every ordinary sign-up and the repair for the rest —
    // pressing the link is the one thing a person in that state will
    // certainly do, so it is where the recovery belongs.
    await gw.provisionPaidSignup(intent.organizationId);
    const body = objectBody(await gw.readJson(request));
    const user = await gw.auth.completePaidSignup({
      intent,
      displayName:
        stringField(body["displayName"], "displayName", { max: 120 }) ?? "",
      password: stringField(body["password"], "password", { max: 256 }) ?? "",
    });
    const issued = await gw.auth.issueSession(
      user,
      gw.remoteAddress(request),
      request.headers["user-agent"] ?? "",
      context.secure,
    );
    response.setHeader("Set-Cookie", issued.cookies);
    gw.sendJson(response, 201, {
      user: issued.principal.user,
      memberships: issued.principal.memberships,
      csrfToken: issued.csrfToken,
    });
    return true;
  }

  const signupMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/auth/signup/([^/]+)$`, "u"),
  );
  if (signupMatch !== undefined && method === "GET") {
    // What the welcome screen asks while it waits: has the payment landed,
    // and is there still an account to build? Nothing here is a secret the
    // holder of the link does not already have.
    const intent = await gw.signupIntentFor(signupMatch[0] ?? "");
    gw.sendJson(response, 200, {
      email: intent.email,
      paid: intent.completedAt !== undefined,
      claimed: intent.userId !== undefined,
    });
    return true;
  }

  if (method === "POST" && path === `${API_PREFIX}/waitlist`) {
    // Where everybody goes while nobody is being let in automatically.
    //
    // Deliberately the least this can be: an address, optionally a name and
    // a sentence about what they want it for. No password, no organization,
    // no token — nothing here becomes a credential, which is what makes it
    // safe to leave open to anybody who finds the page.
    const body = objectBody(await gw.readJson(request));
    const email = (emailField(body["email"]) ?? "").trim().toLowerCase();
    if (email === "") {
      throw new HttpError(400, "invalid_request", "An email is required");
    }
    const entry = await gw.options.store.createWaitlistEntry({
      id: `wait_${randomBytes(9).toString("base64url")}`,
      email,
      // `min: 0`, then empty read as absent: these are three optional boxes
      // on a form, and a browser that posts an untouched one as "" is not
      // making a mistake worth a 400.
      displayName:
        stringField(body["displayName"], "displayName", {
          min: 0,
          max: 120,
          optional: true,
        }) || undefined,
      note:
        stringField(body["note"], "note", {
          min: 0,
          max: 2000,
          optional: true,
        }) || undefined,
      source:
        stringField(body["source"], "source", {
          min: 0,
          max: 120,
          optional: true,
        }) || undefined,
      createdAt: new Date().toISOString(),
      invitedAt: undefined,
    });
    // No audit event. The row is the record — when they asked, and when
    // somebody let them in — and the audit chain's vocabulary is a closed
    // union describing work on a repository, which this is not.
    //
    // The same answer whether this address was already on the list, already
    // approved, or already has an account. The form is open to anybody, so
    // any difference between those replies is a way to ask it which
    // addresses this deployment knows about.
    gw.sendJson(response, 202, {
      waitlisted: true,
      email: entry.email,
    });
    return true;
  }

  if (
    method === "POST" &&
    (path === `${API_PREFIX}/auth/register` ||
      path === `${API_PREFIX}/auth/register/confirm`)
  ) {
    if (gw.payments) {
      // Retired while payments are on. Sign-up takes a card then, and this
      // route made an account without one — so leaving it reachable would
      // leave the paywall with a door beside it.
      //
      // 410 rather than 404: it existed, it is gone deliberately, and a
      // client still calling it should be told that rather than left to
      // wonder whether it moved. `POST /auth/signup` is the way in.
      throw new HttpError(
        410,
        "registration_retired",
        "Accounts are created by starting a trial at /auth/signup.",
      );
    }
    // With payments off this is the door again — but it opens for one
    // address at a time, and only for an address somebody who runs the
    // deployment has approved off the waitlist. That is what "waitlisting
    // everyone and giving select people free accounts" means as a rule a
    // route can enforce: joining the list is open to anybody, and being let
    // through it is a decision a person made.
    if (!registrationOpen(process.env)) {
      throw new HttpError(
        403,
        "registration_closed",
        "This control plane does not accept new accounts",
      );
    }
    if (path.endsWith("/confirm")) {
      const body = objectBody(await gw.readJson(request));
      const user = await gw.auth.confirmRegistration({
        registrationId:
          stringField(body["registrationId"], "registrationId", {
            max: 200,
          }) ?? "",
        code: stringField(body["code"], "code", { max: 32 }) ?? "",
      });
      const issued = await gw.auth.issueSession(
        user,
        gw.remoteAddress(request),
        request.headers["user-agent"] ?? "",
        context.secure,
      );
      response.setHeader("Set-Cookie", issued.cookies);
      gw.sendJson(response, 201, {
        user: issued.principal.user,
        memberships: issued.principal.memberships,
        csrfToken: issued.csrfToken,
      });
      return true;
    }
    const body = objectBody(await gw.readJson(request));
    const email = (emailField(body["email"]) ?? "").trim().toLowerCase();
    if (email === "") {
      throw new HttpError(400, "invalid_request", "An email is required");
    }
    const waiting = await gw.options.store.getWaitlistEntryByEmail(email);
    if (waiting?.invitedAt === undefined) {
      // One refusal for "never asked", "still waiting" and "we said no", so
      // this cannot be used to read the list back out one address at a
      // time. It still says the useful thing: there is a list, and this
      // address is not through it.
      throw new HttpError(
        403,
        "waitlist_pending",
        "Kumi is invitation-only right now. Join the waitlist and we will be in touch.",
      );
    }
    const organizationName = stringField(
      body["organizationName"],
      "organizationName",
      { max: 120, optional: true },
    );
    const registration = {
      email,
      displayName:
        stringField(body["displayName"], "displayName", { max: 120 }) ?? "",
      password: stringField(body["password"], "password", { max: 256 }) ?? "",
      // Omitted rather than passed as undefined: `exactOptionalPropertyTypes`
      // draws the distinction, and "absent" is what naming no team means.
      ...(organizationName === undefined ? {} : { organizationName }),
    };
    if (emailConfirmationRequired(process.env)) {
      const started = await gw.auth.startRegistration(registration);
      gw.sendJson(response, 202, {
        registrationId: started.registrationId,
        expiresAt: started.expiresAt,
        delivery: started.delivery,
      });
      return true;
    }
    const user = await gw.auth.registerUnconfirmed(registration);
    const issued = await gw.auth.issueSession(
      user,
      gw.remoteAddress(request),
      request.headers["user-agent"] ?? "",
      context.secure,
    );
    response.setHeader("Set-Cookie", issued.cookies);
    await gw.options.store.appendAudit(undefined, {
      type: "user_authenticated",
      data: { userId: user.id, bootstrap: false },
    });
    gw.sendJson(response, 201, {
      user: issued.principal.user,
      memberships: issued.principal.memberships,
      csrfToken: issued.csrfToken,
    });
    return true;
  }



  if (method === "POST" && path === `${API_PREFIX}/auth/login`) {
    const body = objectBody(await gw.readJson(request));
    const issued = await gw.auth.login({
      email: emailField(body["email"]) ?? "",
      password: stringField(body["password"], "password", { max: 256 }) ?? "",
      ipAddress: gw.remoteAddress(request),
      userAgent: request.headers["user-agent"] ?? "",
      secure: context.secure,
    });
    response.setHeader("Set-Cookie", issued.cookies);
    await gw.options.store.appendAudit(undefined, {
      type: "user_authenticated",
      data: { userId: issued.principal.user.id, bootstrap: false },
    });
    gw.sendJson(response, 200, {
      user: issued.principal.user,
      memberships: issued.principal.memberships,
      csrfToken: issued.csrfToken,
    });
    return true;
  }

  // ---- Forgotten passwords ----------------------------------------------
  // Both halves are reachable without a session: somebody who cannot sign in
  // is exactly who these are for. The link carries its own secret.
  if (method === "POST" && path === `${API_PREFIX}/auth/password-reset`) {
    const body = objectBody(await gw.readJson(request));
    const email = emailField(body["email"]) ?? "";
    const issued = await gw.auth.requestPasswordReset(email);
    if (issued !== undefined) {
      const link = `${gw.originFor(request, context.secure)}/app#reset/${issued.token}`;
      try {
        await gw.mailer({
          to: issued.user.email,
          subject: "Reset your Kumi password",
          text:
            `Hello ${issued.user.displayName},\n\n` +
            `Somebody asked to reset the password for this account. ` +
            `Open this link to choose a new one:\n\n${link}\n\n` +
            `The link works once and stops working at ${issued.expiresAt}.\n\n` +
            `If this was not you, ignore this message. Your password has ` +
            `not changed and the link can only be used from your mailbox.\n`,
        });
      } catch (error) {
        // A relay that is down must not turn into a 500 that tells the
        // caller the address exists. The operator sees the failure; the
        // person asking sees the same answer either way and can ask again.
        console.error(
          `[mail] Could not send the password reset for ${issued.user.id}: ` +
            describeError(error),
        );
      }
    }
    // Always the same answer, whether or not that address has an account:
    // this endpoint takes no credential, so anything else is a way to test
    // which addresses are registered here.
    gw.sendJson(response, 202, {
      status: "accepted",
      message:
        "If that address has an account, a reset link is on its way to it.",
    });
    return true;
  }

  const resetTokenMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/auth/password-reset/([^/]+)$`, "u"),
  );
  if (resetTokenMatch !== undefined && method === "GET") {
    const found = await gw.auth.findPasswordReset(resetTokenMatch[0] ?? "");
    if (found === undefined) {
      throw new HttpError(
        404,
        "reset_invalid",
        "This password reset link is no longer valid. Request a new one.",
      );
    }
    // The address is echoed so the form can say whose password is being
    // set. Reaching this at all takes the secret from the mailbox it was
    // sent to, so this discloses nothing that mailbox does not already hold.
    gw.sendJson(response, 200, {
      reset: { email: found.user.email, expiresAt: found.reset.expiresAt },
    });
    return true;
  }

  if (
    method === "POST" &&
    path === `${API_PREFIX}/auth/password-reset/confirm`
  ) {
    const body = objectBody(await gw.readJson(request));
    const password =
      stringField(body["password"], "password", { max: 256 }) ?? "";
    assertConfirmed(
      body["confirmPassword"],
      password,
      "confirmPassword",
      "Passwords do not match",
    );
    const issued = await gw.auth.completePasswordReset({
      token: stringField(body["token"], "token", { max: 512 }) ?? "",
      password,
      ipAddress: gw.remoteAddress(request),
      userAgent: request.headers["user-agent"] ?? "",
      secure: context.secure,
    });
    response.setHeader("Set-Cookie", issued.cookies);
    await gw.options.store.appendAudit(undefined, {
      type: "user_authenticated",
      data: { userId: issued.principal.user.id, passwordReset: true },
    });
    gw.sendJson(response, 200, {
      user: issued.principal.user,
      memberships: issued.principal.memberships,
      csrfToken: issued.csrfToken,
    });
    return true;
  }

  // ---- Accepting an invitation ------------------------------------------
  // Reachable without a session: the recipient may have no account yet. The
  // link's own secret is the credential, so this is not an open endpoint.
  // Two patterns rather than one with an optional group: matchPath decodes
  // every group, so an absent group comes back as the string "undefined"
  // rather than as undefined.
  const inviteReadMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/invitations/([^/]+)$`, "u"),
  );
  const inviteAcceptMatch =
    inviteReadMatch === undefined
      ? matchPath(
          path,
          new RegExp(`^${API_PREFIX}/invitations/([^/]+)/accept$`, "u"),
        )
      : undefined;
  const inviteTokenMatch = inviteReadMatch ?? inviteAcceptMatch;
  if (inviteTokenMatch !== undefined) {
    const token = inviteTokenMatch[0] ?? "";
    const action = inviteAcceptMatch === undefined ? undefined : "accept";
    const separator = token.indexOf(".");
    const invitationCode =
      separator === -1 ? normalizeInvitationCode(token) : undefined;
    const invitationId =
      invitationCode !== undefined
        ? invitationIdForCode(invitationCode)
        : separator > 0
          ? token.slice(0, separator)
          : undefined;
    const invitation =
      invitationId === undefined
        ? undefined
        : await gw.options.store.getInvitation(invitationId);
    const secret =
      invitationCode ?? (separator > 0 ? token.slice(separator + 1) : "");
    // One answer for every way a link can be wrong, so a probe cannot tell
    // "no such invitation" from "wrong secret".
    if (
      invitation === undefined ||
      !secretMatches(secret, invitation.secretHash)
    ) {
      throw new HttpError(404, "not_found", "This invitation is not valid");
    }
    const organization = await gw.options.store.getOrganization(
      invitation.organizationId,
    );
    const state = publicInvitation(invitation).status;
    const signedIn = await gw.auth
      .authenticate(request.headers.cookie)
      .catch(() => undefined);

    if (method === "GET" && action === undefined) {
      // Whether the address already has an account decides which form the
      // recipient is shown — "choose a password" or "sign in" — and getting
      // that wrong strands exactly the people an invitation is meant to
      // bring in. Saying so here discloses nothing the same response does
      // not already: it names the address, and it takes the link's secret
      // to reach at all, so this cannot be used to test addresses.
      //
      // An open link names nobody, so there is nothing to look up and
      // nothing to prefill: whoever opens it says who they are.
      const open = invitation.email === "";
      const existing = open
        ? undefined
        : await gw.options.store.getUserByEmail(invitation.email);
      // A returning member commonly still has a live session when an owner
      // removes and re-invites them. The link can be accepted by that
      // session directly: asking them to sign in again adds a second,
      // failure-prone handoff before the repository grant is restored.
      // For an addressed invitation this is only true when the session is
      // already the named account; an unrelated signed-in account must
      // still prove it owns the invited address.
      const canAcceptAsSignedIn =
        signedIn !== undefined && (open || existing?.id === signedIn.user.id);
      gw.sendJson(response, 200, {
        invitation: {
          email: invitation.email,
          open,
          role: invitation.role,
          status: state,
          accountExists: existing !== undefined,
          signedIn: canAcceptAsSignedIn,
          organizationName: organization?.name ?? "this organization",
          ...(invitation.repositoryId === undefined
            ? {}
            : { repositoryId: invitation.repositoryId }),
          expiresAt: invitation.expiresAt,
        },
      });
      return true;
    }

    if (method === "POST" && action === "accept") {
      if (state !== "pending") {
        throw new HttpError(
          409,
          `invitation_${state}`,
          `This invitation has already been ${state}`,
        );
      }
      const body = objectBody(await gw.readJson(request));
      const open = invitation.email === "";
      let user;
      if (open) {
        // Nobody is named, so whoever opened the link says who they are.
        // Somebody already signed in simply takes the grant — the common
        // case for a link pasted into a chat a team is already in, where
        // most readers have accounts and one or two do not.
        if (signedIn !== undefined) {
          // The full account, not the session's public view: a fresh
          // session is issued below and that needs the record, not the
          // shape the browser is allowed to see.
          user = await gw.options.store.getUser(signedIn.user.id);
          if (user === undefined) {
            throw new HttpError(401, "unauthorized", "Sign in is required");
          }
        } else {
          const email = emailField(body["email"]);
          if (email === undefined) {
            throw new HttpError(
              400,
              "invalid_request",
              "An email address is required to join",
            );
          }
          // Refused rather than signed in: holding the link proves nothing
          // about who is holding it, so an existing account is claimed by
          // signing in, exactly as the addressed form requires.
          if (
            (await gw.options.store.getUserByEmail(email)) !== undefined
          ) {
            throw new HttpError(
              409,
              "account_exists",
              `An account already uses ${email}. ` +
                "Sign in as that account to join.",
            );
          }
          gw.assertAccountConfirmations(body);
          user = await gw.options.store.createUser({
            email,
            displayName:
              stringField(body["displayName"], "displayName", { max: 120 }) ??
              "",
            passwordDigest: await hashPassword(
              stringField(body["password"], "password", { max: 256 }) ?? "",
            ),
          });
        }
      } else {
        user = await gw.options.store.getUserByEmail(invitation.email);
        if (user === undefined) {
          // The address is the invitation's, not something typed here, so
          // only the password is retyped on this form.
          gw.assertAccountConfirmations(body);
          user = await gw.options.store.createUser({
            email: invitation.email,
            displayName:
              stringField(body["displayName"], "displayName", { max: 120 }) ??
              "",
            passwordDigest: await hashPassword(
              stringField(body["password"], "password", { max: 256 }) ?? "",
            ),
          });
        } else if (signedIn?.user.id !== user.id) {
          // The account already exists, so the invitation is not proof of
          // who is holding the link. Signing in is.
          throw new HttpError(
            409,
            "account_exists",
            `An account already uses ${invitation.email}. ` +
              "Sign in as that account to accept this invitation.",
          );
        }
      }
      // An addressed invitation is spent here. An open one is not: it was
      // made to be used by however many people it reaches, and marking it
      // accepted would turn "shared with the team" into "the first person
      // to click it". It still ends — on its expiry, or when somebody
      // revokes it — and those are the two ways it is meant to.
      if (!open) {
        const claimed = await gw.options.store.acceptInvitation(
          invitation.id,
          user.id,
          new Date().toISOString(),
        );
        if (!claimed) {
          throw new HttpError(
            409,
            "invitation_used",
            "This invitation has already been used",
          );
        }
      }
      // A repository-scoped invitation grants that repository and nothing
      // else — deliberately no organization membership, because any
      // organization role reaches every repository and would undo the point
      // of scoping the invitation in the first place.
      if (invitation.repositoryId === undefined) {
        await gw.options.store.saveMembership({
          organizationId: invitation.organizationId,
          userId: user.id,
          role: invitation.role,
        });
        // Somebody joining is the commonest way a seat count changes, and
        // the one most likely to be noticed on an invoice.
        await gw.syncSeatQuantity(invitation.organizationId);
      } else {
        await gw.options.store.saveRepositoryGrant({
          repositoryId: invitation.repositoryId,
          userId: user.id,
          role: invitation.role,
          grantedBy: invitation.invitedBy,
          // Free use of this one repository, if an operator's link is what
          // brought them here. Carried from the invitation rather than
          // re-derived, so it reflects who actually gave the access away.
          comped: invitation.comped,
          createdAt: new Date().toISOString(),
        });
        // A grant is a seat too. The membership branch above has always
        // synced; this one never did, and every invitation a customer can
        // create today lands here — the route requires a repository — so in
        // practice no invitation reached Stripe at all.
        await gw.syncSeatQuantity(invitation.organizationId);
      }
      await gw.options.store.appendAudit(undefined, {
        type: "membership_changed",
        data: {
          organizationId: invitation.organizationId,
          ...(invitation.repositoryId === undefined
            ? {}
            : { repositoryId: invitation.repositoryId }),
          userId: user.id,
          role: invitation.role,
          action: "accepted_invitation",
          actorId: user.id,
        },
      });
      const issued = await gw.auth.issueSession(
        user,
        gw.remoteAddress(request),
        request.headers["user-agent"] ?? "",
        context.secure,
      );
      response.setHeader("Set-Cookie", issued.cookies);
      gw.sendJson(response, 200, {
        user: issued.principal.user,
        memberships: issued.principal.memberships,
        csrfToken: issued.csrfToken,
      });
      return true;
    }
    throw new HttpError(405, "method_not_allowed", "Unsupported method");
  }

  if (
    path === `${API_PREFIX}/auth/app-authorization/exchange` &&
    method === "POST"
  ) {
    const body = objectBody(await gw.readJson(request));
    const code = String(body["code"] ?? "");
    const approved = gw.appAuthorizations.get(code);
    // Deleted whether or not it was still good: a code is spent by being
    // presented, so a replay fails even inside the window.
    gw.appAuthorizations.delete(code);
    if (approved === undefined || approved.expiresAt <= Date.now()) {
      throw new HttpError(
        400,
        "authorization_expired",
        "That approval is no longer valid — start the sign-in again",
      );
    }
    gw.sendJson(response, 201, {
      token: approved.token,
      name: approved.name,
    });
    return true;
  }

  // The bundle an editor was told to fetch, against the one-shot ticket
  // `take_task` issued. Its own route rather than the worker's, because the
  // worker's asks for `run_task` — the scope that also admits registering
  // as a worker — and an editor holding one task must never be able to take
  // everybody else's. The ticket is checked here, and then the lease is
  // checked again behind it: a ticket is a name for one lease, never a
  // permission that outlives it.
  const bundleTicket = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/mcp/bundle/([A-Za-z0-9-]{1,80})$`, "u"),
  );
  if (bundleTicket !== undefined && method === "GET") {
    const spent = gw.bundleTickets.redeem(bundleTicket[0] ?? "");
    if (spent === undefined) {
      throw new HttpError(
        404,
        "not_found",
        "That download link has been used already or has expired. Call " +
          "extend_task to get another one.",
      );
    }
    const bundleOperation = gw.options.operations.leaseBundle;
    if (bundleOperation === undefined) {
      throw new HttpError(
        501,
        "not_supported",
        "This deployment cannot serve repository bundles",
      );
    }
    // The lease, not the ticket holder. A ticket is minted by the take that
    // created the lease, so it can only ever name that person's own hold —
    // re-checking the owner here would be a branch nothing can reach. What
    // *can* change between minting and spending is the hold itself.
    const lease = await gw.options.store.getWorkLease(spent.leaseId);
    if (lease === undefined || lease.status !== "active") {
      throw new HttpError(
        409,
        "lease_lost",
        "That hold is no longer active; take the task again",
      );
    }
    const bundle = await bundleOperation(spent.leaseId);
    if (bundle === undefined) {
      throw new HttpError(
        409,
        "lease_lost",
        "That hold is no longer active; take the task again",
      );
    }
    response
      .writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": bundle.byteLength,
      })
      .end(bundle);
    return true;
  }

  return false;
}
