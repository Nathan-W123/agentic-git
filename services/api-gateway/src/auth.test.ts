import assert from "node:assert/strict";
import test from "node:test";

import { hashPassword, verifyPassword } from "./auth.js";

test("password digests verify only the original password", async () => {
  const password = "RelayPassword123!";
  const digest = await hashPassword(password);

  assert.equal(await verifyPassword(password, digest), true);
  assert.equal(await verifyPassword("WrongPassword123!", digest), false);
});

test("malformed or hostile password digests fail closed", async () => {
  const candidates = [
    "",
    "bcrypt$hash",
    "scrypt$not-a-number$8$1$salt$digest",
    "scrypt$999999999$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAA",
    "scrypt$16384$8$1$short$short",
  ];

  for (const digest of candidates) {
    assert.equal(await verifyPassword("RelayPassword123!", digest), false);
  }
});

import { InMemoryCoordinationStore } from "@coord/persistence";

import {
  API_TOKEN_PREFIX,
  AuthService,
  AuthenticationError,
  parseApiToken,
  parseBearer,
} from "./auth.js";
import type { MailMessage } from "./mailer.js";

function confirmationCode(message: MailMessage | undefined): string {
  return /\b([0-9]{6})\b/u.exec(message?.text ?? "")?.[1] ?? "";
}

test("registration retains digests and creates the account only after the mailed code", async () => {
  const store = new InMemoryCoordinationStore();
  const sent: MailMessage[] = [];
  const auth = new AuthService(store, {
    mailer: async (message) => {
      sent.push(message);
    },
  });

  const started = await auth.startRegistration({
    email: "New.Person@Example.com",
    displayName: "New Person",
    password: "MailConfirm123!",
    organizationName: "Confirmed team",
  });
  assert.match(started.registrationId, /^reg_/u);
  assert.equal(await store.countUsers(), 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, "new.person@example.com");
  const code = confirmationCode(sent[0]);
  assert.match(code, /^[0-9]{6}$/u);

  const pending = (
    auth as unknown as {
      pendingRegistrations: Map<
        string,
        { passwordDigest: string; codeHash: string }
      >;
    }
  ).pendingRegistrations.get(started.registrationId);
  assert.notEqual(pending, undefined);
  assert.notEqual(pending?.passwordDigest, "MailConfirm123!");
  assert.notEqual(pending?.codeHash, code);
  assert.equal(JSON.stringify(pending).includes("MailConfirm123!"), false);
  assert.equal(JSON.stringify(pending).includes(`\"${code}\"`), false);
  assert.equal(
    await verifyPassword("MailConfirm123!", pending?.passwordDigest ?? ""),
    true,
  );

  const user = await auth.confirmRegistration({
    registrationId: started.registrationId,
    code,
  });
  assert.equal(await store.countUsers(), 1);
  assert.equal(user.email, "new.person@example.com");
  const organizations = await store.listOrganizations(user.id);
  assert.equal(organizations.length, 1);
  assert.equal(organizations[0]?.name, "Confirmed team");
  assert.equal(
    (await store.getMembership(organizations[0]?.id ?? "", user.id))?.role,
    "owner",
  );
  assert.deepEqual(
    (await store.listProjects(organizations[0]?.id ?? "")).map(
      (project) => project.slug,
    ),
    ["default"],
  );
});

test("registration rejects wrong, expired, exhausted, reused, and unknown challenges", async () => {
  let clock = new Date("2026-01-01T00:00:00.000Z");
  const store = new InMemoryCoordinationStore();
  const sent: MailMessage[] = [];
  const auth = new AuthService(store, {
    now: () => clock,
    registrationTtlMs: 60_000,
    registrationAttemptLimit: 2,
    mailer: async (message) => {
      sent.push(message);
    },
  });
  const begin = async (email: string) =>
    await auth.startRegistration({
      email,
      displayName: "New Person",
      password: "MailConfirm123!",
    });
  const errorCode = (code: string) => (error: unknown) =>
    error instanceof AuthenticationError && error.code === code;

  const exhausted = await begin("attempts@example.com");
  await assert.rejects(
    auth.confirmRegistration({
      registrationId: exhausted.registrationId,
      code: "not-code",
    }),
    errorCode("registration_code_invalid"),
  );
  await assert.rejects(
    auth.confirmRegistration({
      registrationId: exhausted.registrationId,
      code: "still-wrong",
    }),
    errorCode("registration_attempts_exhausted"),
  );
  await assert.rejects(
    auth.confirmRegistration({
      registrationId: exhausted.registrationId,
      code: confirmationCode(sent[0]),
    }),
    errorCode("registration_attempts_exhausted"),
  );

  const expired = await begin("expired@example.com");
  clock = new Date("2026-01-01T00:01:00.000Z");
  await assert.rejects(
    auth.confirmRegistration({
      registrationId: expired.registrationId,
      code: confirmationCode(sent[1]),
    }),
    errorCode("registration_expired"),
  );

  const usable = await begin("used@example.com");
  const usableCode = confirmationCode(sent[2]);
  await auth.confirmRegistration({
    registrationId: usable.registrationId,
    code: usableCode,
  });
  await assert.rejects(
    auth.confirmRegistration({
      registrationId: usable.registrationId,
      code: usableCode,
    }),
    errorCode("registration_already_used"),
  );
  await assert.rejects(
    auth.confirmRegistration({ registrationId: "reg_unknown", code: "000000" }),
    errorCode("registration_invalid"),
  );
  assert.equal(await store.countUsers(), 1);
});

test("mail delivery failure leaves no account or pending registration", async () => {
  const store = new InMemoryCoordinationStore();
  const auth = new AuthService(store, {
    mailer: async () => {
      throw new Error("relay unavailable");
    },
  });
  await assert.rejects(
    auth.startRegistration({
      email: "undelivered@example.com",
      displayName: "Undelivered",
      password: "MailConfirm123!",
    }),
    (error: unknown) =>
      error instanceof AuthenticationError &&
      error.code === "registration_mail_delivery_failed",
  );
  assert.equal(await store.countUsers(), 0);
  assert.equal(
    (
      auth as unknown as {
        pendingRegistrations: Map<string, unknown>;
      }
    ).pendingRegistrations.size,
    0,
  );
});

async function serviceWithUser(now?: () => Date) {
  const store = new InMemoryCoordinationStore();
  const user = await store.createUser({
    email: "worker@example.com",
    displayName: "Worker",
    passwordDigest: await hashPassword("RelayPassword123!"),
  });
  const auth = new AuthService(store, ...(now === undefined ? [] : [{ now }]));
  return { store, user, auth };
}

test("bearer headers are parsed case-insensitively and safely", () => {
  assert.equal(parseBearer("Bearer abc"), "abc");
  assert.equal(parseBearer("bearer abc"), "abc");
  assert.equal(parseBearer("  BEARER   abc  "), "abc");
  for (const invalid of [undefined, "", "Basic abc", "Bearer", "Bearer a b"]) {
    assert.equal(parseBearer(invalid), undefined);
  }
});

test("token parsing rejects anything not in the wire format", () => {
  assert.deepEqual(parseApiToken(`${API_TOKEN_PREFIX}abc.secret`), {
    id: "abc",
    secret: "secret",
  });
  for (const invalid of [
    "secret",
    "coord_pat_",
    `${API_TOKEN_PREFIX}.secret`,
    `${API_TOKEN_PREFIX}abc.`,
    `${API_TOKEN_PREFIX}abcsecret`,
  ]) {
    assert.equal(parseApiToken(invalid), undefined, invalid);
  }
});

/**
 * Both halves are base64url, so `-` and `_` occur naturally. An underscore
 * separator used to split inside the id, making about one token in six fail to
 * authenticate at random.
 */
test("ids and secrets containing base64url punctuation still parse", () => {
  assert.deepEqual(parseApiToken(`${API_TOKEN_PREFIX}a_b-c.s_e-cret`), {
    id: "a_b-c",
    secret: "s_e-cret",
  });
});

test("every issued token authenticates, whatever its random bytes", async () => {
  const { auth, user } = await serviceWithUser();
  // Enough draws that an underscore in the id is near-certain to appear.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const issued = await auth.issueApiToken({
      user,
      name: `t${attempt}`,
      scopes: ["view"],
    });
    const principal = await auth.authenticateToken(issued.token, "10.0.0.1");
    assert.equal(principal.user.id, user.id, issued.token);
  }
});

test("an issued token authenticates and carries its scopes", async () => {
  const { auth, user } = await serviceWithUser();
  const issued = await auth.issueApiToken({
    user,
    name: "ci-worker",
    scopes: ["view", "run_task"],
  });

  assert.ok(issued.token.startsWith(API_TOKEN_PREFIX));
  const principal = await auth.authenticateToken(issued.token, "10.0.0.1");
  assert.equal(principal.credential, "api_token");
  assert.equal(principal.user.id, user.id);
  assert.equal(principal.sessionId, undefined);
  assert.deepEqual(principal.token?.scopes, ["view", "run_task"]);
});

test("the plaintext token is never recoverable from storage", async () => {
  const { auth, store, user } = await serviceWithUser();
  const issued = await auth.issueApiToken({ user, name: "t", scopes: ["view"] });
  const stored = await store.getApiToken(issued.record.id);

  assert.notEqual(stored, undefined);
  assert.ok(!JSON.stringify(stored).includes(issued.token));
  assert.ok(!issued.token.includes(stored?.secretHash ?? "never"));
});

test("a tampered secret is rejected even with a valid token id", async () => {
  const { auth, user } = await serviceWithUser();
  const issued = await auth.issueApiToken({ user, name: "t", scopes: ["view"] });
  const parsed = parseApiToken(issued.token);

  await assert.rejects(
    auth.authenticateToken(
      `${API_TOKEN_PREFIX}${parsed?.id}_wrongsecret`,
      "10.0.0.1",
    ),
    AuthenticationError,
  );
});

test("revoked and expired tokens stop authenticating", async () => {
  let clock = new Date("2026-01-01T00:00:00.000Z");
  const { auth, user } = await serviceWithUser(() => clock);

  const revoked = await auth.issueApiToken({ user, name: "r", scopes: ["view"] });
  const expiring = await auth.issueApiToken({
    user,
    name: "e",
    scopes: ["view"],
    expiresInDays: 1,
  });
  const principal = await auth.authenticateToken(revoked.token, "10.0.0.1");

  await auth.revokeApiToken(principal, revoked.record.id, "test");
  await assert.rejects(
    auth.authenticateToken(revoked.token, "10.0.0.1"),
    AuthenticationError,
  );

  // The second token is still inside its window, then falls outside it.
  await auth.authenticateToken(expiring.token, "10.0.0.1");
  clock = new Date("2026-01-03T00:00:00.000Z");
  await assert.rejects(
    auth.authenticateToken(expiring.token, "10.0.0.1"),
    AuthenticationError,
  );
});

test("a disabled account's tokens stop working immediately", async () => {
  const { auth, store, user } = await serviceWithUser();
  const issued = await auth.issueApiToken({ user, name: "t", scopes: ["view"] });
  await auth.authenticateToken(issued.token, "10.0.0.1");

  await store.updateUser(user.id, { disabled: true });
  await assert.rejects(
    auth.authenticateToken(issued.token, "10.0.0.1"),
    AuthenticationError,
  );
});

test("every rejection reports the same message so tokens cannot be probed", async () => {
  const { auth, user } = await serviceWithUser();
  const issued = await auth.issueApiToken({ user, name: "t", scopes: ["view"] });
  const parsed = parseApiToken(issued.token);

  const messages = new Set<string>();
  for (const candidate of [
    `${API_TOKEN_PREFIX}unknownid_secret`,
    `${API_TOKEN_PREFIX}${parsed?.id}_wrong`,
    "not-a-token",
  ]) {
    try {
      await auth.authenticateToken(candidate, "10.0.0.1");
      throw new Error(`expected ${candidate} to be rejected`);
    } catch (error) {
      assert.ok(error instanceof AuthenticationError);
      messages.add(error.message);
    }
  }
  assert.equal(messages.size, 1, [...messages].join(" | "));
});

test("token issuance validates its inputs", async () => {
  const { auth, user } = await serviceWithUser();
  await assert.rejects(
    auth.issueApiToken({ user, name: "", scopes: ["view"] }),
    /between 1 and 120/u,
  );
  await assert.rejects(
    auth.issueApiToken({ user, name: "t", scopes: [] }),
    /at least one scope/u,
  );
  await assert.rejects(
    auth.issueApiToken({ user, name: "t", scopes: ["view"], expiresInDays: 900 }),
    /between 1 and 365 days/u,
  );
  // Zero means "never expires" and is explicitly allowed.
  const forever = await auth.issueApiToken({
    user,
    name: "t",
    scopes: ["view"],
    expiresInDays: 0,
  });
  assert.equal(forever.record.expiresAt, undefined);
});

test("a token cannot be revoked by another user", async () => {
  const { auth, store, user } = await serviceWithUser();
  const issued = await auth.issueApiToken({ user, name: "t", scopes: ["view"] });
  const other = await store.createUser({
    email: "other@example.com",
    displayName: "Other",
    passwordDigest: "digest",
  });

  await assert.rejects(
    auth.revokeApiToken(
      {
        user: {
          id: other.id,
          email: other.email,
          displayName: other.displayName,
          systemAdmin: false,
        },
        credential: "session",
        memberships: [],
      },
      issued.record.id,
      "theft",
    ),
    /not found/iu,
  );
  // Still usable by its owner.
  await auth.authenticateToken(issued.token, "10.0.0.1");
});

test("CSRF verification does not apply to bearer principals", async () => {
  const { auth, user } = await serviceWithUser();
  const issued = await auth.issueApiToken({ user, name: "t", scopes: ["view"] });
  const principal = await auth.authenticateToken(issued.token, "10.0.0.1");

  // No cookies, no CSRF header, and it must still pass.
  await auth.verifyCsrf(principal, undefined, undefined);
});

test("repeated wrong passwords lock that one account", async () => {
  // The rate limiter in front of this keys on a network address, which behind
  // a reverse proxy is one address for the whole deployment: it throttles
  // everybody together and throttles guessing at one account not at all.
  const { auth } = await serviceWithUser();
  const attempt = (password: string, email = "worker@example.com") =>
    auth.login({
      email,
      password,
      ipAddress: "203.0.113.7",
      userAgent: "test",
    });

  for (let index = 0; index < 10; index += 1) {
    await assert.rejects(attempt("WrongPassword123!"), /incorrect/u);
  }

  // Past the limit the right password is refused too, and says why.
  await assert.rejects(
    attempt("RelayPassword123!"),
    (error: unknown) =>
      error instanceof AuthenticationError &&
      error.statusCode === 429 &&
      error.code === "login_locked",
  );

  // And nobody else is locked out by it — which is the whole point of counting
  // per account rather than per deployment.
  await assert.rejects(
    attempt("WrongPassword123!", "somebody-else@example.com"),
    (error: unknown) =>
      error instanceof AuthenticationError && error.code !== "login_locked",
  );
});

test("a session cookie is Secure exactly when the request was", async () => {
  // Marking it Secure unconditionally breaks every plain-HTTP deployment: the
  // browser stops sending the cookie back and sign-in looks like it silently
  // failed. Marking it only when the request arrived over TLS is the same
  // protection without that.
  const { auth, user } = await serviceWithUser();
  const secureFlags = (cookies: readonly string[]) =>
    cookies.map((value) => /;\s*Secure\b/u.test(value));

  const plain = await auth.issueSession(user, "203.0.113.7", "test");
  assert.deepEqual(secureFlags(plain.cookies), [false, false]);

  const overTls = await auth.issueSession(user, "203.0.113.7", "test", true);
  assert.deepEqual(secureFlags(overTls.cookies), [true, true]);

  // The clearing cookie has to match, or the browser keeps the original.
  assert.deepEqual(
    secureFlags(await auth.logout(overTls.principal.sessionId ?? "", true)),
    [true, true],
  );
});

/* ------------------------------------------------------ password resets ---- */

test("a reset link sets the password once and only within its lifetime", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const { auth, store, user } = await serviceWithUser(() => now);

  const issued = await auth.requestPasswordReset("worker@example.com");
  assert.notEqual(issued, undefined);
  const token = issued?.token ?? "";

  // Stored hashed, exactly like an invitation: the database never holds
  // anything that could be presented back as a credential.
  const stored = await store.getPasswordReset(token.split(".")[0] ?? "");
  assert.notEqual(stored, undefined);
  assert.equal(stored?.secretHash.includes(token.split(".")[1] ?? "x"), false);

  const session = await auth.completePasswordReset({
    token,
    password: "BrandNewRelay123!",
    ipAddress: "10.0.0.1",
    userAgent: "test",
  });
  assert.equal(session.principal.user.id, user.id);
  const updated = await store.getUser(user.id);
  assert.equal(
    await verifyPassword("BrandNewRelay123!", updated?.passwordDigest ?? ""),
    true,
  );

  // Single use.
  await assert.rejects(
    auth.completePasswordReset({
      token,
      password: "AnotherRelay1234!",
      ipAddress: "10.0.0.1",
      userAgent: "test",
    }),
    (error: unknown) =>
      error instanceof AuthenticationError && error.code === "reset_invalid",
  );

  // And a fresh link stops working once its hour is up.
  const second = await auth.requestPasswordReset("worker@example.com");
  now = new Date("2026-01-01T02:00:00.000Z");
  assert.equal(await auth.findPasswordReset(second?.token ?? ""), undefined);
});

test("a reset is refused for an unknown address, a disabled account, or a mistyped link", async () => {
  const { auth, store, user } = await serviceWithUser();

  // Nothing is minted for an address with no account — the caller is told the
  // same thing either way, so there is nothing here to leak.
  assert.equal(await auth.requestPasswordReset("nobody@example.com"), undefined);

  const issued = await auth.requestPasswordReset("worker@example.com");
  const token = issued?.token ?? "";
  assert.equal(await auth.findPasswordReset(`${token}x`), undefined);
  assert.equal(await auth.findPasswordReset("no-separator"), undefined);

  // A link outlives its account being disabled, so it is checked again on use.
  await store.updateUser(user.id, { disabled: true });
  assert.equal(await auth.findPasswordReset(token), undefined);
  assert.equal(await auth.requestPasswordReset("worker@example.com"), undefined);
});

test("resetting a password revokes the sessions somebody else may be holding", async () => {
  const { auth, store, user } = await serviceWithUser();
  const stolen = await auth.issueSession(user, "10.0.0.9", "thief");
  assert.notEqual(
    await store.getAuthSession(stolen.principal.sessionId ?? ""),
    undefined,
  );

  const issued = await auth.requestPasswordReset("worker@example.com");
  await auth.completePasswordReset({
    token: issued?.token ?? "",
    password: "BrandNewRelay123!",
    ipAddress: "10.0.0.1",
    userAgent: "test",
  });

  // A reset is the remedy for an account somebody else is in. Leaving their
  // session alive would make it no remedy at all.
  assert.equal(
    await store.getAuthSession(stolen.principal.sessionId ?? ""),
    undefined,
  );
});
