/** The gateway over HTTP: usage, registration, password reset and the auto-claim offer. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  hashPassword,
} from "./auth.js";
import {
  autoClaimProposal,
  parseAnswerTaskDirective,
  parseAutoClaimVerdict,
} from "./server.js";
import {
  PASSWORD,
  TestClient,
  addColleague,
  bootstrap,
  invitableRepository,
  joinAllConnectedAgents,
  recordingMailer,
  registerAccount,
  resetLink,
  startBareGateway,
  startRuntime,
  waitFor,
  withEnvironment,
  work,
} from "./test-harness.js";
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
} from "@coord/persistence";

test("Codex usage falls back to the live account quota snapshot", async (t) => {
  let liveReads = 0;
  const runtime = await startRuntime(t, {
    codexUsageReader: async () => {
      liveReads += 1;
      return {
        limitId: "codex",
        primary: {
          usedPercent: 11,
          windowDurationMins: 300,
          resetsAt: 1_787_000_000,
        },
        secondary: {
          usedPercent: 37,
          windowDurationMins: 10_080,
          resetsAt: 1_787_400_000,
        },
        planType: "plus",
      };
    },
  });
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const response = await client.request(
    "/api/v1/chat/providers/openai/usage",
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(liveReads, 1);
  assert.deepEqual(runtime.usageCalls, ["openai"]);
  assert.equal(response.data.usage.source, "Codex account rate limits (plus)");
  const resetText = (at: number): string =>
    new Date(at * 1_000).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  assert.deepEqual(
    response.data.usage.windows,
    [
      {
        label: "5 hours",
        percentUsed: 11,
        resetsAt: resetText(1_787_000_000),
        // The raw figures travel beside the formatted ones: the string is in
        // the server's zone and locale, which the browser cannot undo.
        resetsAtEpoch: 1_787_000_000,
        windowDurationMins: 300,
      },
      {
        label: "7 days",
        percentUsed: 37,
        resetsAt: resetText(1_787_400_000),
        resetsAtEpoch: 1_787_400_000,
        windowDurationMins: 10_080,
      },
    ],
  );
  // The plan is a field of its own now, not only a phrase inside `source`.
  assert.equal(response.data.usage.planType, "plus");
  assert.equal(response.data.usage.creditBalance, undefined);
});

test("a Codex credit balance reaches the usage route", async (t) => {
  const runtime = await startRuntime(t, {
    codexUsageReader: async () => ({
      primary: { usedPercent: 4, windowDurationMins: 300 },
      secondary: { usedPercent: 19, windowDurationMins: 10_080 },
      planType: "pro",
      credits: { hasCredits: true, balance: 12.5 },
    }),
  });
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const response = await client.request(
    "/api/v1/chat/providers/openai/usage",
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.usage.planType, "pro");
  assert.equal(response.data.usage.creditBalance, 12.5);
  // A window with no reset time still reports its length, and invents no
  // reset moment for itself.
  assert.deepEqual(response.data.usage.windows[0], {
    label: "5 hours",
    percentUsed: 4,
    windowDurationMins: 300,
  });
});

test("recorded Codex usage wins without an unnecessary live lookup", async (t) => {
  let liveReads = 0;
  const runtime = await startRuntime(t, {
    codexUsageReader: async () => {
      liveReads += 1;
      return undefined;
    },
  });
  const client = new TestClient(runtime.origin);
  await bootstrap(client);
  const recorded = {
    source: "Codex CLI session records (~/.codex/sessions)",
    windows: [{ label: "5 hours", percentUsed: 23 }],
  };
  runtime.providerUsage.set("openai", recorded);

  const response = await client.request(
    "/api/v1/chat/providers/openai/usage",
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.deepEqual(response.data.usage, recorded);
  assert.equal(liveReads, 0);
});

test("unavailable live Codex usage and Claude usage retain their existing shape", async (t) => {
  let liveReads = 0;
  const runtime = await startRuntime(t, {
    codexUsageReader: async () => {
      liveReads += 1;
      return undefined;
    },
  });
  const client = new TestClient(runtime.origin);
  await bootstrap(client);
  const unavailable = {
    source: "Codex CLI session records (~/.codex/sessions)",
    windows: [],
    unavailableReason:
      "No Codex session has recorded rate limits on this machine yet.",
  };
  const claude = {
    source: "claude /usage, as reported by the signed-in account",
    windows: [{ label: "session", percentUsed: 8 }],
  };
  runtime.providerUsage.set("openai", unavailable);
  runtime.providerUsage.set("anthropic", claude);

  const codexResponse = await client.request(
    "/api/v1/chat/providers/openai/usage",
  );
  const claudeResponse = await client.request(
    "/api/v1/chat/providers/anthropic/usage",
  );
  assert.equal(codexResponse.status, 200, JSON.stringify(codexResponse.data));
  assert.equal(claudeResponse.status, 200, JSON.stringify(claudeResponse.data));
  assert.deepEqual(codexResponse.data.usage, unavailable);
  assert.deepEqual(claudeResponse.data.usage, claude);
  assert.equal(liveReads, 1);
});

/**
 * Withdraws one environment variable for the duration of a test.
 *
 * The gateway reads the registration and proxy settings the way the rest of
 * this process does — from the environment — so a test that wants a different
 * default has to swap it and put it back.
 */
test("registration is open by default", async (t) => {
  // No invitation and no registration setting: sharing the deployment link is
  // enough for a newcomer to create their own isolated account and team.
  withEnvironment(t, {
    COORD_ALLOW_REGISTRATION: undefined,
    COORD_DISABLE_REGISTRATION: undefined,
  });
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  const created = await registerAccount(runtime.store, client, {
    email: "stranger@example.com",
    displayName: "Stranger",
    password: PASSWORD,
  });

  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.user.email, "stranger@example.com");
  assert.equal(created.data.memberships.length, 1);
  assert.equal(created.data.memberships[0].role, "owner");
});

test("a TLS request behind a trusted proxy gets Secure cookies and HSTS", async (t) => {
  // The control plane speaks plain HTTP and TLS terminates at the router, so
  // the forwarded protocol is the only evidence there is — and it is only
  // evidence when a proxy is actually trusted, which is why the hop count has
  // to be stated rather than inferred.
  withEnvironment(t, { COORD_TRUSTED_PROXY_HOPS: "1" });
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);

  const overTls = await client.request("/api/v1/health", {
    headers: { "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.7" },
  });
  assert.match(
    overTls.headers.get("strict-transport-security") ?? "",
    /max-age=\d+/u,
  );

  // The same deployment reached over plain HTTP is not pinned to HTTPS: the
  // browser would remember that for the domain and nothing in the app could
  // take it back.
  const plain = await client.request("/api/v1/health");
  assert.equal(plain.headers.get("strict-transport-security"), null);
});

test("without a trusted proxy the forwarded headers are ignored entirely", async (t) => {
  // Trusting `X-Forwarded-*` unconditionally is worse than not reading it:
  // every client would choose its own rate-limit bucket and could claim to
  // have arrived over TLS.
  withEnvironment(t, { COORD_TRUSTED_PROXY_HOPS: undefined });
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);

  const claimed = await client.request("/api/v1/health", {
    headers: { "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.7" },
  });
  assert.equal(claimed.headers.get("strict-transport-security"), null);
});

test("/ask asks first and then works — the command says both halves", async (t) => {
  // The reported case: "I want to add an orchestrate command, use /ask for
  // clarifications" got an answer describing what such a command would do,
  // with nothing asked and nothing built. `/ask` is not `/dnc`: it opens the
  // question round and the same task carries on into the work afterwards.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "ask-then-builds");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: "@Claude (Owner) add an orchestrate command /ask",
    },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  // Coordinated work, not the read-only answer path.
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  assert.match(
    runtime.submittedTasks[0]?.objective ?? "",
    /add an orchestrate command/u,
  );
  assert.match(
    runtime.submittedTasks[0]?.objective ?? "",
    /force a question round before implementation/u,
  );

  // And the picker promises the second half too, so nobody reads `/ask` as a
  // command that only ever talks.
  const listed = await owner.request(`${base}/messages`);
  const ask = (listed.data.slashCommands as any[]).find(
    (entry) => entry.name === "ask",
  );
  assert.match(String(ask?.summary), /questions first/iu);
  assert.match(String(ask?.summary), /do the work/iu);
});

/* ------------------------------------------------- account confirmations ---- */

/** A mailer that keeps what it was asked to send, and a link reader for it. */
test("the free registration routes are retired while payments are on", async (t) => {
  // They made an account without a card. Sign-up takes one when payments are
  // on, so leaving these reachable then would leave the paywall with a door
  // beside it. With payments off they are the door — gated on the waitlist,
  // which has its own tests at the foot of this file.
  //
  // 410 rather than 404, and rather than silence: they existed, they are gone
  // deliberately, and a client still calling one should be told which of
  // those it is. The tests that used to cover mailed confirmation codes and
  // retyped-address mismatches went with the routes — what replaces them is
  // the paid sign-up's own tests, where account creation now lives.
  const { client, store } = await startBareGateway(t, {});
  await bootstrap(client);
  const before = await store.countUsers();
  const stranger = new TestClient(client.origin);

  for (const route of ["/api/v1/auth/register", "/api/v1/auth/register/confirm"]) {
    const refused = await stranger.request(route, {
      method: "POST",
      body: {
        email: "newcomer@example.com",
        confirmEmail: "newcomer@example.com",
        displayName: "Newcomer",
        password: PASSWORD,
        confirmPassword: PASSWORD,
      },
    });
    assert.equal(refused.status, 410, `${route}: ${JSON.stringify(refused.data)}`);
    assert.equal(refused.data.error.code, "registration_retired");
    // The way in is named, so a stale client is not left guessing.
    assert.match(refused.data.error.message, /\/auth\/signup/u);
    assert.equal(refused.headers.get("set-cookie"), null);
  }

  // And nothing was created on the way past.
  assert.equal(await store.countUsers(), before);
});


test("a forgotten password is recovered through a mailed link", async (t) => {
  const { sent, mailer } = recordingMailer();
  const { client } = await startBareGateway(t, { mailer });
  await bootstrap(client);

  const asked = new TestClient(client.origin);
  const requested = await asked.request("/api/v1/auth/password-reset", {
    method: "POST",
    body: { email: "owner@example.com" },
  });
  assert.equal(requested.status, 202);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, "owner@example.com");

  const token = resetLink(sent[0]);
  assert.notEqual(token, "", sent[0]?.text);

  // The form checks the link before asking for a password, and is told whose
  // account it belongs to.
  const preview = await asked.request(
    `/api/v1/auth/password-reset/${encodeURIComponent(token)}`,
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.data.reset.email, "owner@example.com");

  const changed = await asked.request("/api/v1/auth/password-reset/confirm", {
    method: "POST",
    body: {
      token,
      password: "BrandNewRelay123!",
      confirmPassword: "BrandNewRelay123!",
    },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal(changed.data.user.email, "owner@example.com");

  // The link is single use, and the old password no longer works.
  const replayed = await asked.request("/api/v1/auth/password-reset/confirm", {
    method: "POST",
    body: {
      token,
      password: "BrandNewRelay123!",
      confirmPassword: "BrandNewRelay123!",
    },
  });
  assert.equal(replayed.status, 400);
  assert.equal(replayed.data.error.code, "reset_invalid");

  const stale = new TestClient(client.origin);
  const oldPassword = await stale.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "owner@example.com", password: PASSWORD },
  });
  assert.equal(oldPassword.status, 401);

  const newPassword = await stale.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "owner@example.com", password: "BrandNewRelay123!" },
  });
  assert.equal(newPassword.status, 200, JSON.stringify(newPassword.data));
});

test("asking to reset an unknown address says nothing about it", async (t) => {
  const { sent, mailer } = recordingMailer();
  const { client } = await startBareGateway(t, { mailer });
  await bootstrap(client);

  const stranger = new TestClient(client.origin);
  const answer = await stranger.request("/api/v1/auth/password-reset", {
    method: "POST",
    body: { email: "nobody@example.com" },
  });
  // Same status and same wording as for an address that does exist, or this
  // endpoint would answer "does this person have an account here".
  assert.equal(answer.status, 202);
  assert.equal(sent.length, 0);

  const known = await stranger.request("/api/v1/auth/password-reset", {
    method: "POST",
    body: { email: "owner@example.com" },
  });
  assert.equal(known.status, 202);
  assert.equal(known.data.message, answer.data.message);
});

test("a reset link that was superseded or mistyped is refused", async (t) => {
  const { sent, mailer } = recordingMailer();
  const { client } = await startBareGateway(t, { mailer });
  await bootstrap(client);

  const asked = new TestClient(client.origin);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const answer = await asked.request("/api/v1/auth/password-reset", {
      method: "POST",
      body: { email: "owner@example.com" },
    });
    assert.equal(answer.status, 202);
  }
  assert.equal(sent.length, 2);

  // Asking twice invalidates the first link rather than leaving two working
  // keys in the mailbox.
  const first = await asked.request(
    `/api/v1/auth/password-reset/${encodeURIComponent(resetLink(sent[0]))}`,
  );
  assert.equal(first.status, 404);
  assert.equal(first.data.error.code, "reset_invalid");

  const mistyped = await asked.request(
    `/api/v1/auth/password-reset/${encodeURIComponent(`${resetLink(sent[1])}x`)}`,
  );
  assert.equal(mistyped.status, 404);

  const latest = await asked.request(
    `/api/v1/auth/password-reset/${encodeURIComponent(resetLink(sent[1]))}`,
  );
  assert.equal(latest.status, 200);
});

test("a reset refuses a new password that was retyped differently", async (t) => {
  const { sent, mailer } = recordingMailer();
  const { client } = await startBareGateway(t, { mailer });
  await bootstrap(client);

  const asked = new TestClient(client.origin);
  await asked.request("/api/v1/auth/password-reset", {
    method: "POST",
    body: { email: "owner@example.com" },
  });
  const token = resetLink(sent[0]);
  const refused = await asked.request("/api/v1/auth/password-reset/confirm", {
    method: "POST",
    body: {
      token,
      password: "BrandNewRelay123!",
      confirmPassword: "BrandNewRelay124!",
    },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.data.error.code, "confirmation_mismatch");

  // The link survives a typo: burning it would leave the person with no way
  // back in but to ask for another.
  const retried = await asked.request("/api/v1/auth/password-reset/confirm", {
    method: "POST",
    body: {
      token,
      password: "BrandNewRelay123!",
      confirmPassword: "BrandNewRelay123!",
    },
  });
  assert.equal(retried.status, 200, JSON.stringify(retried.data));
});

/**
 * Reported as data loss, and it was not: the records were untouched. A second
 * account had been created on the deployment, and signing back in as the
 * first showed an empty workspace — because the owner administers every
 * organization on the deployment and the list came back ordered by name, so
 * the newcomer's took the head of it.
 */
test("a newer account's workspace never displaces the owner's own", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  // Registration hands a self-signed-up account its own organization, named
  // after them — and "Aria's team" sorts ahead of the owner's "Relay Test".
  const newcomer = new TestClient(runtime.origin);
  const registered = await registerAccount(runtime.store, newcomer, {
    email: "aria@example.com",
    displayName: "Aria",
    password: PASSWORD,
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.data));

  const listed = await owner.request("/api/v1/organizations");
  assert.equal(listed.status, 200);
  const organizations = listed.data.organizations as {
    id: string;
    name: string;
  }[];

  // A system administrator really can reach it, and it stays listed: hiding
  // it would break the administration the role exists for.
  assert.ok(
    organizations.some((entry) => entry.name === "Aria's team"),
    "the administrator can still reach every organization",
  );
  // But it is not what they are shown. The control room opens whatever comes
  // first, so ordering by name alone handed the owner somebody else's empty
  // workspace and read as having lost their own.
  assert.equal(
    organizations[0]?.name,
    "Relay Test",
    "the owner's own organization leads their list",
  );

  // And the boundary still holds in the other direction: the newcomer sees
  // one organization, theirs.
  const theirs = await newcomer.request("/api/v1/organizations");
  assert.deepEqual(
    (theirs.data.organizations as { name: string }[]).map(
      (entry) => entry.name,
    ),
    ["Aria's team"],
  );
});

/* ------------------------------------------- unaddressed message verdict --- */

test("missing, malformed, or no-task answer directives fail closed without exposing control markers", () => {
  assert.deepEqual(parseAnswerTaskDirective("The route is in server.ts."), {
    answer: "The route is in server.ts.",
    taskObjective: undefined,
  });
  assert.deepEqual(
    parseAnswerTaskDirective(
      "The retry loop is bounded.\nANSWER_TASK: NONE",
    ),
    {
      answer: "The retry loop is bounded.",
      taskObjective: undefined,
    },
  );
  assert.equal(
    parseAnswerTaskDirective(
      "The retry loop is bounded.\nANSWER_TASK: NO_TASK.",
    ).taskObjective,
    undefined,
  );

  for (const malformed of [
    "The retry loop is bounded.\nANSWER_TASK add tests",
    "The retry loop is bounded.\nANSWER_TASK:",
    "The retry loop is bounded.\nANSWER_TASK:: Add tests",
    "The retry loop is bounded.\nANSWER_TASK: Add tests\nMore detail follows.",
    "The retry loop is bounded.\nANSWER_TASK: Add tests\nANSWER_TASK: Add more tests",
    "The retry loop is bounded.\nANSWER_TASK: Add tests ANSWER_TASK: Add more tests",
    "The retry loop is bounded. ANSWER_TASK: Add tests",
  ]) {
    const parsed = parseAnswerTaskDirective(malformed);
    assert.equal(parsed.taskObjective, undefined, malformed);
    assert.doesNotMatch(parsed.answer ?? "", /ANSWER_TASK/u, malformed);
  }

  // A directive without an answer is not enough to spend an account either.
  assert.deepEqual(parseAnswerTaskDirective("ANSWER_TASK: Add tests"), {
    answer: undefined,
    taskObjective: undefined,
  });
});

/**
 * What an agent decides about a message nobody addressed to it.
 *
 * The reply is a line of text from a model, so the parser is the boundary
 * between "a model said something" and "somebody's account is about to be
 * spent". Everything it cannot read is silence.
 */
test("a decision is read out of the agent's reply, and only a clear one", () => {
  assert.deepEqual(parseAutoClaimVerdict("ACT"), { verdict: "act" });
  assert.deepEqual(parseAutoClaimVerdict("act\n"), { verdict: "act" });
  assert.deepEqual(parseAutoClaimVerdict("OFFER: Shall I change the background colour?"), {
    verdict: "offer",
    proposal: "Shall I change the background colour?",
  });
  // Models reach for quotes and bullets when asked for a sentence; none of
  // that belongs in the room.
  assert.deepEqual(parseAutoClaimVerdict('OFFER "Shall I retire the old flag?"'), {
    verdict: "offer",
    proposal: "Shall I retire the old flag?",
  });
  assert.deepEqual(parseAutoClaimVerdict("IGNORE"), { verdict: "ignore" });

  // Everything unreadable lands on silence, which is the direction that costs
  // nothing: a paragraph where a word was asked for, a refusal, an empty
  // answer, a timeout that produced nothing at all.
  for (const unreadable of [
    undefined,
    "",
    "   ",
    "I'm not sure what you mean.",
    "MAYBE",
    "OFFER:",
    "OFFER:    ",
  ]) {
    assert.deepEqual(
      parseAutoClaimVerdict(unreadable),
      { verdict: "ignore" },
      JSON.stringify(unreadable),
    );
  }
});

test("an offer is recognised by its tail, and gives up its proposal", () => {
  const posted =
    'Shall I change the background colour?\n\nSay "yes" and I\'ll ask you ' +
    "what I need before I start — or @mention someone else.";
  assert.equal(
    autoClaimProposal(posted),
    "Shall I change the background colour?",
  );
  // Anything else in the transcript is not an offer, and acceptance must not
  // find one where none was made.
  assert.equal(autoClaimProposal("Shall I change the background colour?"), undefined);
  assert.equal(autoClaimProposal("yes"), undefined);
});

/**
 * The clear half of the three-way decision: a message that says what it wants
 * is taken, and nothing is asked.
 *
 * The offer exists to resolve doubt. Where there is none it is a round trip
 * that buys nothing, and a person who wrote "change the background to blue"
 * and was answered "would you like me to change the background?" has been
 * asked to say the same thing twice.
 */
test("a message that plainly asks for work is taken without an offer", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "acts-at-once");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  runtime.setTaskClassification("ACT");
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "change the background on the settings page to blue" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
  assert.match(
    String(runtime.submittedTasks[0]?.objective),
    /background on the settings page to blue/u,
  );
  // Not asked first, and not asked afterwards either: there was nothing
  // unclear, so the question round is not forced.
  assert.doesNotMatch(
    String(runtime.submittedTasks[0]?.objective),
    /force a question round/u,
  );
  const after = await owner.request(`${base}/messages`);
  assert.deepEqual(
    (after.data.messages as any[]).filter((message) =>
      /Say "yes" and I'll ask you what I need/u.test(String(message.content)),
    ),
    [],
    "nothing was offered — it was simply taken",
  );
});

/**
 * The unsure half: work is implied but not asked for, so the agent names the
 * specific thing it would do and waits. Saying yes starts it *asking*.
 */
test("an implied request is proposed on, and yes starts it in its question round", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "proposes-first");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  runtime.setTaskClassification(
    "OFFER: Shall I change the background colour on the settings page?",
  );
  const remark = "it looks like the background doesn't look great with gray";
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: remark },
    })).status,
    201,
  );

  // Offered in the agent's own words, about this message. A fixed sentence
  // could only have said "want me to take this?", which is not a question
  // about anything and cannot be answered without re-reading the room.
  const offered = await owner.request(`${base}/messages`);
  const offer = (offered.data.messages as any[]).find(
    (message) => message.kind === "agent",
  );
  assert.match(
    String(offer?.content),
    /Shall I change the background colour on the settings page\?/u,
  );
  assert.equal(runtime.submittedTasks.length, 0, "an offer is not a start");

  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "yes" },
    })).status,
    201,
  );

  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
  const objective = String(runtime.submittedTasks[0]?.objective);
  // Both halves travel. The remark is the words a person chose; the proposal
  // is what they said yes to, and neither alone is the job.
  assert.match(objective, /doesn't look great with gray/u);
  assert.match(objective, /Shall I change the background colour/u);
  // And it goes in asking — which colour was never said, and guessing at it
  // is the whole reason an offer was made instead of an edit.
  assert.match(objective, /force a question round/u);
});

/**
 * Who an unaddressed request goes to, when nothing about it points anywhere.
 *
 * Fit decides first and is worth queueing behind — the right agent to ask is
 * still the right one when it is busy. Below that there is no "right", only
 * "whose account", and the answer is the person who asked. Below *that* the
 * only remaining question is who can start now.
 */
test("an unmatched request goes to the sender's own agent, then to whoever is free", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "fallback-order");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const teammate = await runtime.store.createUser({
    email: "fallback-colleague@example.com",
    displayName: "Colleague Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: teammate.id,
    role: "developer",
  });
  const colleague = new TestClient(runtime.origin);
  await colleague.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: teammate.email, password: PASSWORD },
  });

  // One agent each, both org-wide so either could take anything.
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org", callSign: "Willow" },
  ]);
  runtime.chatConnections.set(teammate.id, [
    { provider: "openai", visibility: "org", callSign: "Cedar" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Named so that nothing in the request can match either of them, and no
  // role set on either: this is the case where fit has no answer at all.

  runtime.setTaskClassification("ACT");
  assert.equal(
    (await colleague.request(`${base}/messages`, {
      method: "POST",
      body: { content: "rewrite the shipping calculator" },
    })).status,
    201,
  );

  // Tier two: nothing matched, so the person who asked spends their own
  // account rather than a colleague's.
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  assert.equal(
    runtime.submittedTasks[0]?.actorId,
    teammate.id,
    "the sender's own agent takes an unmatched request",
  );

  // That task is now in flight — nothing has finished it — so the same
  // sender asking again finds their own agent busy.
  assert.equal(
    (await colleague.request(`${base}/messages`, {
      method: "POST",
      body: { content: "rewrite the invoice totals page" },
    })).status,
    201,
  );

  // Tier three: anybody who can start now, rather than a queue behind an
  // agent that was only ever the fallback pick.
  assert.equal(runtime.submittedTasks.length, 2, JSON.stringify(runtime.submittedTasks));
  assert.equal(
    runtime.submittedTasks[1]?.actorId,
    ownerId,
    "a busy fallback hands over to whoever is free",
  );
});

/**
 * An invitation with no address on it: a link, not a letter.
 *
 * The addressed form named one mailbox and was spent the first time it was
 * opened, which is not how an invitation gets used. It gets pasted into the
 * chat the team is already in, and the second person to click it was told it
 * had already been used.
 */
test("somebody invited to one repository can still make a token", async (t) => {
  // A repository-scoped invitation grants that repository and deliberately no
  // organization membership, which is the whole point of scoping it. But a
  // token's scopes were bounded by memberships alone, so every person invited
  // to a deployment — and the invitation route requires a repository, so that
  // is all of them — was bounded by nothing at all. A developer on the only
  // repository they can see was told their role granted not even `view`.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "shared-with-them");

  const invited = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
    {
      method: "POST",
      body: { role: "developer", repositoryId: repo, projectId: DEFAULT_PROJECT_ID },
    },
  );
  assert.equal(invited.status, 201, JSON.stringify(invited.data));

  const joiner = new TestClient(runtime.origin);
  const accepted = await joiner.request(
    `/api/v1/invitations/${invited.data.token as string}/accept`,
    {
      method: "POST",
      body: {
        email: "cofounder@example.com",
        displayName: "Co-founder",
        password: PASSWORD,
      },
    },
  );
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.deepEqual(accepted.data.memberships, [], "the grant is the only access");

  // Developer on that repository grants `submit_task`, so the token an editor
  // connection needs is exactly what this person may have.
  const token = await joiner.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "Codex on their laptop", scopes: ["view", "submit_task"] },
  });
  assert.equal(token.status, 201, JSON.stringify(token.data));

  // And the bound still holds: a developer cannot mint what a developer does
  // not have, however the role reached them.
  const beyond = await joiner.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "greedy", scopes: ["manage_organization"] },
  });
  assert.equal(beyond.status, 403);
  assert.equal(beyond.data.error.code, "scope_exceeds_role");
});

test("an invite link with no address admits more than one person", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "open-link");

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
  assert.match(token, /^inv_[\w-]+\.[\w-]+$/u);

  // Nobody is named, and the screen the recipient lands on has to know that
  // so it asks who they are rather than showing a blank disabled field.
  const preview = await new TestClient(runtime.origin).request(
    `/api/v1/invitations/${token}`,
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.data.invitation.open, true);
  assert.equal(preview.data.invitation.email, "");
  assert.equal(preview.data.invitation.role, "developer");

  // Two people, one link, neither of them named on it.
  for (const [email, name] of [
    ["first@example.com", "First Joiner"],
    ["second@example.com", "Second Joiner"],
  ] as const) {
    const joiner = new TestClient(runtime.origin);
    const accepted = await joiner.request(
      `/api/v1/invitations/${token}/accept`,
      { method: "POST", body: { email, displayName: name, password: PASSWORD } },
    );
    assert.equal(accepted.status, 200, `${email}: ${JSON.stringify(accepted.data)}`);
    assert.equal(accepted.data.user.email, email);
    // The same grant the addressed form makes, and no more: one repository,
    // no organization membership, because any organization role would reach
    // every repository and undo the scoping.
    assert.deepEqual(accepted.data.memberships, []);
  }

  const grants = await runtime.store.listRepositoryGrants(repo);
  assert.deepEqual(
    grants.map((grant) => grant.role),
    ["developer", "developer"],
  );

  // An address that already has an account is refused rather than signed in:
  // holding the link proves nothing about who is holding it.
  const impostor = new TestClient(runtime.origin);
  const taken = await impostor.request(`/api/v1/invitations/${token}/accept`, {
    method: "POST",
    body: {
      email: "first@example.com",
      displayName: "Not First",
      password: PASSWORD,
    },
  });
  assert.equal(taken.status, 409);
  assert.equal(taken.data.error?.code ?? taken.data.code, "account_exists");

  // And it still ends when somebody ends it.
  const listed = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations`,
  );
  const open = (listed.data.invitations as any[]).find(
    (entry) => entry.email === "",
  );
  assert.equal(open?.status, "pending", "an open link is not spent by use");
  assert.equal(
    (
      await owner.request(
        `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/invitations/${open.id}`,
        { method: "DELETE" },
      )
    ).status,
    200,
  );
  const late = new TestClient(runtime.origin);
  const refused = await late.request(`/api/v1/invitations/${token}/accept`, {
    method: "POST",
    body: {
      email: "third@example.com",
      displayName: "Too Late",
      password: PASSWORD,
    },
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.data));
});

/**
 * The offer as a prompt, not only as a sentence to answer in words.
 *
 * It is the same prompt an agent's own questions use — one list, one set of
 * keyboard shortcuts, one rule about who may answer — because an offer is the
 * same kind of thing: one person's decision, with work waiting on it.
 */
test("an offer puts up the choice prompt, and tapping yes starts the work", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "offer-prompt");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  runtime.setTaskClassification("OFFER: Shall I retire the old feature flag?");
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "that old flag is still hanging around everywhere" },
    })).status,
    201,
  );

  const open = await owner.request(`${base}/questions`);
  assert.equal(open.status, 200);
  const prompt = (open.data.questions as any[])[0];
  assert.notEqual(prompt, undefined, JSON.stringify(open.data));
  assert.equal(
    prompt.questions[0].question,
    "Shall I retire the old feature flag?",
  );
  assert.deepEqual(prompt.questions[0].options, ["Yes, go ahead", "No thanks"]);
  assert.equal(runtime.submittedTasks.length, 0, "a prompt is not a start");

  // Somebody else's prompt is nobody else's decision — the same rule the
  // agent's own questions follow.
  const stranger = new TestClient(runtime.origin);
  const other = await runtime.store.createUser({
    email: "offer-prompt-other@example.com",
    displayName: "Other Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: other.id,
    role: "developer",
  });
  await stranger.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: other.email, password: PASSWORD },
  });
  assert.deepEqual(
    (await stranger.request(`${base}/questions`)).data.questions,
    [],
  );

  const answered = await owner.request(
    `${base}/questions/${encodeURIComponent(prompt.requestId)}/answer`,
    { method: "POST", body: { answers: [{ chosen: 0 }] } },
  );
  assert.equal(answered.status, 200);

  // The tap dispatches exactly what a typed "yes" dispatches: the words the
  // person used, the proposal they agreed to, and the question round.
  await waitFor(
    async () => runtime.submittedTasks.length === 1,
    "tapping yes never dispatched the work",
  );
  const objective = String(runtime.submittedTasks[0]?.objective);
  assert.match(objective, /old flag is still hanging around/u);
  assert.match(objective, /Shall I retire the old feature flag/u);
  assert.match(objective, /force a question round/u);

  // And the prompt is gone, so the work cannot be started a second time by
  // somebody typing "yes" underneath it.
  assert.deepEqual((await owner.request(`${base}/questions`)).data.questions, []);
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "yes" },
    })).status,
    201,
  );
  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
});

test("declining the prompt starts nothing, and says nothing about it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "offer-declined");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  runtime.setTaskClassification("OFFER: Shall I tidy the imports?");
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "the imports in that module are a mess" },
  });
  const prompt = (await owner.request(`${base}/questions`)).data.questions[0];
  const before = (await owner.request(`${base}/messages`)).data.messages.length;

  assert.equal(
    (
      await owner.request(
        `${base}/questions/${encodeURIComponent(prompt.requestId)}/answer`,
        { method: "POST", body: { answers: [{ chosen: 1 }] } },
      )
    ).status,
    200,
  );

  assert.equal(runtime.submittedTasks.length, 0);
  // Declining a suggestion is not an event the room needs narrating to it.
  assert.equal(
    (await owner.request(`${base}/messages`)).data.messages.length,
    before,
  );
  assert.deepEqual((await owner.request(`${base}/questions`)).data.questions, []);
});

/**
 * The local pass, and the one thing it is allowed to do.
 *
 * Reading every unaddressed message is what replaced the word list, and it
 * is right — but it runs on somebody's subscription, and most of a working
 * channel is people talking to each other. This keeps that half off the
 * agents entirely, and is allowed to answer only when it is sure.
 */
test("conversation the local pass is sure about never reaches an agent", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "local-triage");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  runtime.setLocalChatter((text) => text.startsWith("hi "));
  runtime.setTaskClassification("ACT");
  const before = runtime.chatPrompts.length;

  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "hi Ethan, how was the weekend" },
    })).status,
    201,
  );
  assert.deepEqual(
    runtime.chatPrompts.slice(before),
    [],
    "no agent was asked, and nobody's usage was spent",
  );
  assert.equal(runtime.submittedTasks.length, 0);

  // And the filter decides nothing else. A message it is not sure about goes
  // on to the agent exactly as before — that is what makes it safe to put in
  // front of the decision rather than in place of it.
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "change the background on settings to blue" },
    })).status,
    201,
  );
  // Counted by the decision prompt itself: dispatching also asks the agent
  // to compose what it says when it picks work up, and that is not this.
  const decisions = runtime.chatPrompts
    .slice(before)
    .filter((entry) =>
      /Reply with exactly one of these three lines/u.test(entry.prompt),
    );
  assert.equal(decisions.length, 1, JSON.stringify(decisions.map((d) => d.prompt.slice(-40))));
  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
});

/**
 * A message posts immediately, whatever the agent's decision costs to reach.
 *
 * The classify call used to sit inside the request that posted the sender's
 * own message — nothing was shown until it answered, and it had up to
 * twenty seconds to. On a slow attempt that read as the feature not firing
 * at all, because the one place that would have said otherwise was the
 * response the sender was waiting on. It is a real model call on the
 * account whose CLI may, at that exact moment, be busy running a coding
 * task on this same host — contention that can genuinely slow a process
 * spin-up — so "sometimes slow" was never a corner case here.
 */
test("the sender's message posts before the agent has decided anything", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "does-not-block");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const gate = runtime.setClassifyGate();
  runtime.setTaskClassification("ACT");
  try {
    // The gate is held shut for the whole request — a stand-in for the
    // worst case, a classify call that never comes back at all.
    const posted = await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "there's a lot of lag when loading in from mobile, find a fix" },
    });
    assert.equal(posted.status, 201, JSON.stringify(posted.data));
    assert.equal(
      posted.data.message.content,
      "there's a lot of lag when loading in from mobile, find a fix",
      "the sender's own words are in the response — nothing waited on the agent",
    );
    // And nothing happened yet, because nothing has been decided yet.
    assert.equal(runtime.submittedTasks.length, 0);
  } finally {
    gate.release();
  }

  // Once the agent's decision actually lands, the work it describes still
  // happens — the same outcome as an instant classification, only later.
  await waitFor(
    async () => runtime.submittedTasks.length === 1,
    "the decision never arrived after the gate was released",
  );
  assert.match(
    String(runtime.submittedTasks[0]?.objective),
    /lag when loading in from mobile/u,
  );
});

/**
 * A classify call that errors is retried once, and the retry can still
 * answer — a single slow or dropped attempt is not the difference between a
 * request being read and a request going quiet.
 */
test("a failed classify attempt gets a second try before the message goes quiet", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "retries-once");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // The first attempt is the one contention would hit: it answers with
  // nothing, exactly what a timed-out or unreachable CLI looks like from
  // here. The second is a clean host and a clean answer — the immediate
  // retry `readAutoClaimVerdict` makes before giving up.
  runtime.setClassifyFailures(1);
  runtime.setTaskClassification("ACT");
  const before = runtime.chatPrompts.length;

  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "change the background on settings to blue" },
    })).status,
    201,
  );

  await waitFor(
    async () => runtime.submittedTasks.length === 1,
    "the retry never dispatched the work",
  );
  const attempts = runtime.chatPrompts
    .slice(before)
    .filter((entry) =>
      /Reply with exactly one of these three lines/u.test(entry.prompt),
    );
  assert.equal(attempts.length, 2, "exactly one retry, not an unbounded loop");
});

/**
 * The instruction actually says what the product wants: act on its own
 * judgment by default, and reserve asking for a real fork in the work.
 *
 * A prompt is not code a type checker holds still — nothing stops a later
 * edit from quietly softening "lean toward acting" back into "when in
 * doubt, ask," and the softened version would still pass every dispatch
 * test in this file, because those all set the verdict directly rather than
 * reading it from a real model. This is the one guard that actually reads
 * the words the model is given.
 */
test("the classify prompt is biased toward acting on its own judgment", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "leans-toward-acting");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  runtime.setTaskClassification("ACT");
  const before = runtime.chatPrompts.length;
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "it looks like the token usage is wrong" },
  });
  await waitFor(
    async () => runtime.chatPrompts.length > before,
    "the classify call never ran",
  );
  const asked =
    runtime.chatPrompts
      .slice(before)
      .map((entry) => entry.prompt)
      .find((prompt) =>
        /Reply with exactly one of these three lines/u.test(prompt),
      ) ?? "";

  // The framing that sets the default.
  assert.match(asked, /Lean toward acting/u);
  assert.match(
    asked,
    /fill(?:ing)? in whatever was not spelled out with their own reasonable judgment/u,
  );
  // ACT no longer requires the message to spell out what it wants — an
  // observation is enough, and unspecified detail is not by itself a reason
  // to offer instead.
  assert.match(asked, /whether it is phrased as a direct request[\s\S]{0,40}or as an observation/u);
  assert.match(
    asked,
    /not merely when something was left unspecified/u,
  );
  // What still offers: real ambiguity between different pieces of work, or
  // stakes high enough that guessing is the wrong instinct even with a
  // guess in hand — not "some detail is missing."
  assert.match(
    asked,
    /could mean two or more substantially different pieces of work/u,
  );
  assert.match(asked, /costly or hard to undo/u);
  // The guardrails this replaced nothing about are still here.
  assert.match(asked, /do not interrupt their conversation/u);
});

/**
 * The reported case, end to end: the sender's own agent is mid-task, the
 * free agent in the room is somebody else's — and that agent's credential
 * is broken. Reading the message runs on the chosen agent's own sign-in, a
 * per-user thing that fails independently of anything about the message, so
 * before this the whole decision died with it: the free agent errored
 * silently and the busy one, perfectly able to queue the work, was never
 * asked. An unreachable pick now hands the decision to the runner-up; a
 * real verdict — IGNORE included — still ends the line, so two agents never
 * rule on one message.
 */
test("an unreachable pick hands the decision to the runner-up, not to silence", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "understudy");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const cofounder = await addColleague(runtime, "understudy-cofounder@example.com");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org", callSign: "Willow" },
  ]);
  runtime.chatConnections.set(cofounder.id, [
    { provider: "openai", visibility: "org", callSign: "Cedar" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  // Names that share no token with the request, so no fit tier: this is the
  // pure fallback path.
  // The owner's own agent is mid-task — an unfinished row under the same
  // (owner, agent) key the busy signal reads.
  await runtime.store.submitTask({
    repositoryId,
    objective: "long refactor still running",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: ownerId,
  });

  // Tier 2 skips the busy own agent; tier 3 picks the cofounder's free
  // Codex. Its first two classify attempts — the retry — produce nothing,
  // which is what an expired sign-in looks like from here. The third call is
  // the understudy: the owner's busy Claude, whose credential works fine.
  runtime.setClassifyFailures(2);
  runtime.setTaskClassification("ACT");
  const before = runtime.chatPrompts.length;
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "please rework the shipping calculator" },
    })).status,
    201,
  );

  await waitFor(
    async () => runtime.submittedTasks.length === 1,
    "the understudy never dispatched the work",
  );
  // Landed on the busy-but-reachable agent, spending its owner's account —
  // the sender's own, here — and queued behind its current task rather than
  // vanishing.
  assert.equal(runtime.submittedTasks[0]?.actorId, ownerId);
  assert.equal(runtime.submittedTasks[0]?.vendor, "claude");
  const classifies = runtime.chatPrompts
    .slice(before)
    .filter((entry) =>
      /Reply with exactly one of these three lines/u.test(entry.prompt),
    );
  assert.equal(
    classifies.length,
    3,
    "two attempts on the pick, one on the understudy — and no more",
  );
});

/**
 * The reported case: sender's own agent is genuinely free, no roles are set —
 * and the work went to the cofounder's agent anyway. The busy signal counted
 * every unfinished task row, and a conversational turn that has landed parks
 * at `open` BY DESIGN — the row stays so the conversation can continue, but
 * nothing is running. One chat with your own agent marked it busy for the
 * rest of time, and tier two skipped it forever after.
 */
test("a parked conversation does not make the sender's own agent busy", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "parked-conversation");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const cofounder = await addColleague(runtime, "parked-cofounder@example.com");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org", callSign: "Willow" },
  ]);
  runtime.chatConnections.set(cofounder.id, [
    { provider: "openai", visibility: "org", callSign: "Cedar" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  // No shared tokens with the request, so the fit tier stays out of it.

  // One earlier conversation with the owner's agent, landed and parked open.
  const turn = await runtime.store.submitTask({
    repositoryId,
    objective: "earlier conversational turn, long since answered",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: ownerId,
    conversationId: "conv_parked",
  });
  await runtime.store.claimSubmittedTasks(repositoryId);
  await runtime.store.openSubmittedTask(turn.id);

  runtime.setTaskClassification("ACT");
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "please rework the shipping calculator" },
    })).status,
    201,
  );

  await waitFor(
    async () => runtime.submittedTasks.length === 1,
    "the unaddressed request was never dispatched",
  );
  // Tier two: the sender's own, free agent — not a colleague's, and not the
  // colleague's because of a chat that ended hours ago.
  assert.equal(runtime.submittedTasks[0]?.actorId, ownerId);
  assert.equal(runtime.submittedTasks[0]?.vendor, "claude");
});

/**
 * The other way the busy signal lied: nothing reaps a task whose run
 * crashed, so a `claimed` row from a run that died days ago counted as "this
 * agent is busy" forever. A corpse past the age bound stops being evidence.
 */
test("a stranded task from a dead run ages out of the busy signal", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "stale-corpse");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const cofounder = await addColleague(runtime, "stale-cofounder@example.com");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org", callSign: "Willow" },
  ]);
  runtime.chatConnections.set(cofounder.id, [
    { provider: "openai", visibility: "org", callSign: "Cedar" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // A run that died three hours ago: the row stranded `claimed`, and nothing
  // will ever finish it. Backdated through the store's own map — the public
  // API stamps submission time itself, which is exactly why a corpse cannot
  // be made through it.
  const corpse = await runtime.store.submitTask({
    repositoryId,
    objective: "run that crashed and never reported",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: ownerId,
  });
  await runtime.store.claimSubmittedTasks(repositoryId);
  const rows = (
    runtime.store as unknown as {
      submitted: Map<string, { submittedAt: string }>;
    }
  ).submitted;
  const row = rows.get(corpse.id);
  assert.notEqual(row, undefined);
  row!.submittedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

  runtime.setTaskClassification("ACT");
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "please rework the shipping calculator" },
    })).status,
    201,
  );

  await waitFor(
    async () => runtime.submittedTasks.length === 1,
    "the unaddressed request was never dispatched",
  );
  assert.equal(runtime.submittedTasks[0]?.actorId, ownerId);
  assert.equal(runtime.submittedTasks[0]?.vendor, "claude");
});

/**
 * Accepting one offer twice across a restart starts the work once.
 *
 * The settled-offers set is in-memory and this deployment restarts on every
 * merge. A tap posts no user message, so after a restart a typed "yes" under
 * the still-visible offer passed every guard: the settled set was empty, the
 * offer sat inside its window, and nobody had spoken in between. The durable
 * evidence of acceptance is the dispatched task itself — its objective
 * quotes the proposal — and that is what the acceptance path now checks.
 */
test("a yes after a restart does not start already-accepted work twice", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "restart-yes");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  runtime.setTaskClassification("OFFER: Shall I speed up the mobile boot?");
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "loading in from mobile feels slow" },
  });
  const prompt = (await owner.request(`${base}/questions`)).data.questions[0];
  assert.notEqual(prompt, undefined);
  assert.equal(
    (
      await owner.request(
        `${base}/questions/${encodeURIComponent(prompt.requestId)}/answer`,
        { method: "POST", body: { answers: [{ chosen: 0 }] } },
      )
    ).status,
    200,
  );
  await waitFor(
    async () => runtime.submittedTasks.length === 1,
    "the tapped acceptance never dispatched",
  );

  // The restart: in-memory settlements are gone, the offer message is not.
  (
    runtime.gateway as unknown as { settledAutoClaimOffers: Set<string> }
  ).settledAutoClaimOffers.clear();

  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "yes" },
    })).status,
    201,
  );

  // Once. The durable task, not the forgotten set, is what says so — and the
  // sender is told the work is already underway rather than met with either
  // silence or a duplicate.
  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
  const messages = (await owner.request(`${base}/messages`)).data.messages as any[];
  assert.ok(
    messages.some(
      (message) =>
        message.kind === "system" &&
        /already accepted/u.test(String(message.content)),
    ),
    JSON.stringify(messages.map((m) => [m.kind, String(m.content).slice(0, 50)])),
  );
});
