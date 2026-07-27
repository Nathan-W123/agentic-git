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
